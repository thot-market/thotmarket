import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalHash, signCanonical } from '../packages/protocol/src/index.ts';
import { postJournal, accountBalance, reconcile } from '../packages/ledger/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { InferenceReconciliation, type BillingReconciliationConfig, type SignedBillingEvidence, type RequestChargeEvidence, type ProviderInvoiceEvidence } from '../packages/market/src/inference-reconciliation.ts';
import { InferenceGateway } from '../packages/market/src/inference-gateway.ts';
import { maximumReservation, validateRateCard, type InferenceProvider, type InferenceRateCard } from '../packages/inference/src/index.ts';
import { demoUser } from '../packages/market/src/fixtures.ts';
import type { Actor } from '../packages/market/src/service.ts';
import type { Document } from '../packages/storage/src/index.ts';

const start = '2026-09-06T00:00:00.000Z';
const submitter: Actor = { id: 'billing-submitter', role: 'operator_security' };
const reviewer: Actor = { id: 'billing-reviewer', role: 'operator_security' };
const signerOperator: Actor = { id: 'billing-verifier-operator', role: 'operator_security' };
// Fictional prices and synthetic signatures, generated independently per test. No provider/network/payment calls.
const card: InferenceRateCard = { version: 'synthetic-billing/1', model: 'synthetic-billing-model', service_tier: 'default', currency: 'USD',
  input_micro_usd_per_million: '4000000', cached_micro_usd_per_million: '2000000', cache_write_micro_usd_per_million: '8000000',
  output_micro_usd_per_million: '20000000', max_input_tokens: 1000, max_output_tokens: 250,
  verified_at: start, expires_at: '2026-09-07T00:00:00.000Z', verified: true, example_only: false };
const usage = { input_tokens: 100, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 100, total_tokens: 200 };
async function setup(t: any, options: { environment?: 'synthetic' | 'external'; durable?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'thot-billing-review-'));
  const keys = generateKeyPairSync('ed25519'); let clock = start; let calls = 0;
  const provider: InferenceProvider & { billingEnvironment: 'synthetic' | 'external' } = {
    provider: 'openai', billingEnvironment: options.environment ?? 'synthetic', rateCard: card,
    validate() { validateRateCard(card, new Date(clock)); }, async count() { calls++; return 100; },
    async generate() { calls++; throw new Error('PRIVATE-SYNTHETIC-UNKNOWN-RESPONSE'); },
  };
  const config: BillingReconciliationConfig = { audience: 'synthetic-local-billing-tests', submitterIds: [submitter.id],
    reviewerIds: [reviewer.id, submitter.id, signerOperator.id], trustedVerifiers: { 'synthetic-verifier-v1': {
      publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), provider: 'openai', environment: 'synthetic',
      validFrom: '2026-09-05T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z', operatorIds: [signerOperator.id],
    } } };
  let app = await createApplication({ dataDir, memory: !options.durable, config: { clock: () => new Date(clock) }, inference: { provider, dailyBudgetMinor: '100' } });
  let billing = new InferenceReconciliation(app.service, config);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await app.db.transaction(async tx => {
    await tx.insert('contributor_entitlements', 'billing-credit', demoUser.id, { entitlement_id: 'billing-credit', settlement_id: 'billing-sale',
      disposition: 'inference_credit', status: 'AVAILABLE', currency: 'USD', available_minor: '1000' });
    await postJournal(tx, 'billing-test-funding', 'USD', [{ owner: 'network', account: 'ASSET:cash', amount: 1000n },
      { owner: 'billing-credit', account: 'LIABILITY:contributor_inference_credit', amount: -1000n }]);
  });
  function signed<T extends Document>(unsigned: T): T & { signature: string } { return { ...unsigned, signature: signCanonical(unsigned, keys.privateKey) }; }
  function resign(evidence: SignedBillingEvidence, patch: Document): SignedBillingEvidence {
    const { signature: _signature, ...unsigned } = evidence; return signed({ ...unsigned, ...patch }) as SignedBillingEvidence;
  }
  async function held(label = 'first') {
    const r = await app.inference.create(demoUser, 'billing-request-' + label, { entitlement_id: 'billing-credit', prompt: 'PRIVATE-PROMPT-' + label,
      provider: 'openai', rate_card_hash: canonicalHash(card), consent_external_processing: true, max_cost_minor: maximumReservation(card) });
    const result = await app.inference.execute(demoUser, r.request_id); assert.equal(result.status, 'UNCERTAIN'); return result;
  }
  function base(evidenceId: string) {
    return { schema_version: 'thot.inference-billing-evidence/1' as const, evidence_id: evidenceId, verifier_id: 'synthetic-verifier-v1',
      audience: config.audience, provider: 'openai', environment: 'synthetic' as const, issued_at: clock,
      expires_at: new Date(Date.parse(clock) + 86400000).toISOString(), final: true as const, currency: 'USD' as const,
      source_commitment: canonicalHash({ fixture: 'SYNTHETIC BILLING EVIDENCE ONLY', evidenceId }) };
  }
  function charge(r: Document, outcome: 'NO_CHARGE' | 'CHARGED' = 'CHARGED', label = 'first'): RequestChargeEvidence {
    return signed({ ...base('evidence-charge-' + label), kind: 'request_charge' as const, request_id: r.request_id, reservation_id: r.reservation_id,
      rate_card_hash: r.rate_card_hash, client_request_id: canonicalHash({ requestId: r.request_id, path: 'responses' }),
      provider_response_id: outcome === 'CHARGED' ? 'resp_synthetic_' + label : null, provider_usage_id: 'usage-synthetic-' + label,
      observed_through_at: clock, outcome, charged_minor: outcome === 'CHARGED' ? '1' : '0', usage: outcome === 'CHARGED' ? usage : null });
  }
  function invoice(requests: Document[], label = 'first'): ProviderInvoiceEvidence {
    return signed({ ...base('evidence-invoice-' + label), kind: 'provider_invoice' as const, invoice_id: 'invoice-synthetic-' + label,
      invoice_total_minor: requests.reduce((sum, r) => sum + BigInt(r.actual_minor), 0n).toString(),
      lines: requests.map(r => ({ request_id: r.request_id, reservation_id: r.reservation_id, rate_card_hash: r.rate_card_hash,
        provider_response_id: r.provider_response_id, provider_usage_id: r.provider_usage_id, usage_commitment: canonicalHash(r.usage), amount_minor: r.actual_minor })) });
  }
  async function resolve(r: Document, label = 'first') {
    const s = await billing.submit(submitter, 'submit-charge-' + label, charge(r, 'CHARGED', label));
    await billing.approve(reviewer, 'approve-charge-' + label, s.evidence_record_id);
    return app.db.transaction(tx => tx.get('inference_requests', r.request_id));
  }
  return { get app() { return app; }, get billing() { return billing; }, config, keys, signed, resign, held, charge, invoice, resolve,
    setTime(value: string) { clock = value; }, get calls() { return calls; }, async restart() {
      assert.equal(options.durable, true); await app.close();
      app = await createApplication({ dataDir, config: { clock: () => new Date(clock) }, inference: { provider, dailyBudgetMinor: '100' } });
      billing = new InferenceReconciliation(app.service, config);
    } };
}
async function balances(a: Awaited<ReturnType<typeof setup>>) {
  return a.app.db.transaction(async tx => ({ cash: await accountBalance(tx, 'USD', 'network', 'ASSET:cash'),
    credit: await accountBalance(tx, 'USD', 'billing-credit', 'LIABILITY:contributor_inference_credit'),
    unverified: await accountBalance(tx, 'USD', 'network', 'LIABILITY:inference_provider_payable'),
    invoiced: await accountBalance(tx, 'USD', 'network', 'LIABILITY:inference_verified_invoice_payable') }));
}

test('billing is disabled without explicit verifier and two independent authorized operators; typed zero cannot release a hold', async t => {
  const a = await setup(t), r = await a.held(); const disabled = new InferenceReconciliation(a.app.service);
  assert.equal(disabled.capabilities().enabled, false); assert.equal(a.billing.capabilities().payment_execution, false);
  await assert.rejects(disabled.submit(submitter, 'disabled-billing-submit', a.charge(r, 'NO_CHARGE')), /RECONCILIATION_DISABLED/);
  await assert.rejects(a.billing.submit(submitter, 'typed-zero-charge', { request_id: r.request_id, charged_minor: '0' }), /INVALID_BILLING_EVIDENCE/);
  await assert.rejects(a.billing.submit(demoUser, 'unauthorized-submitter', a.charge(r)), /FORBIDDEN/);
  await assert.rejects(a.billing.submit({ id: 'unlisted', role: 'operator_security' }, 'unlisted-submitter', a.charge(r)), /NOT_AUTHORIZED/);
  const selfOnly = new InferenceReconciliation(a.app.service, { ...a.config, reviewerIds: [submitter.id] });
  assert.equal(selfOnly.capabilities().enabled, false);
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).status, 'UNCERTAIN');
  assert.equal((await a.app.service.earnings(demoUser)).entitlements[0]!.available_minor, '998');
});

test('signed final no-charge proof plus independent review refunds exactly once and never submits inference again', async t => {
  const a = await setup(t), r = await a.held(); const evidence = a.charge(r, 'NO_CHARGE');
  const submitted = await a.billing.submit(submitter, 'submit-zero-evidence', evidence);
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).status, 'UNCERTAIN', 'submission is not approval');
  await assert.rejects(a.billing.approve(submitter, 'self-approve-zero', submitted.evidence_record_id), /SELF_APPROVAL_DENIED/);
  await assert.rejects(a.billing.approve(signerOperator, 'verifier-approve-zero', submitted.evidence_record_id), /VERIFIER_SELF_APPROVAL_DENIED/);
  const approved = await a.billing.approve(reviewer, 'approve-zero-evidence', submitted.evidence_record_id);
  assert.equal(approved.submitted_by, submitter.id); assert.equal(approved.reviewed_by, reviewer.id); assert.equal(approved.payment_status, 'NOT_EXECUTED');
  assert.deepEqual(await a.billing.approve(reviewer, 'approve-zero-evidence', submitted.evidence_record_id), approved);
  assert.deepEqual(await a.billing.approve(reviewer, 'approve-zero-another-key', submitted.evidence_record_id), approved);
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).billing_resolution, 'VERIFIED_NO_CHARGE');
  assert.equal((await a.app.service.earnings(demoUser)).entitlements[0]!.available_minor, '1000');
  assert.deepEqual(await balances(a), { cash: 1000n, credit: -1000n, unverified: 0n, invoiced: 0n });
  await a.app.inference.execute(demoUser, r.request_id); assert.equal(a.calls, 2);
  assert.equal((await a.app.db.transaction(tx => reconcile(tx))).balanced, true);
});

test('verified charge consumes actual credit, returns only unused reserve, accrues payable and does not fabricate output or payment', async t => {
  const a = await setup(t), r = await a.held(); const resolved = await a.resolve(r);
  assert.equal(resolved.status, 'FAILED'); assert.equal(resolved.billing_resolution, 'VERIFIED_CHARGE_NO_OUTPUT');
  assert.equal(resolved.actual_minor, '1'); assert.equal(resolved.output_ref, undefined); assert.deepEqual(resolved.usage, usage);
  assert.deepEqual(await balances(a), { cash: 1000n, credit: -999n, unverified: -1n, invoiced: 0n });
  const reservation = await a.app.db.transaction(tx => tx.get('inference_credit_reservations', r.reservation_id));
  assert.equal(reservation.status, 'SPENT'); assert.equal(reservation.actual_minor, '1');
  const next = await a.held('after-reconciliation'); assert.notEqual(next.request_id, r.request_id);
});

test('signature, provider, audience, request/reservation/rate/usage and no-charge finality mismatches fail closed', async t => {
  const a = await setup(t), r = await a.held(), good = a.charge(r);
  const invalid: Document[] = [
    { signature: good.signature.slice(0, -1) + (good.signature.endsWith('A') ? 'B' : 'A') },
    { provider: 'other-provider' }, { audience: 'other-deployment' }, { reservation_id: 'other-reservation' },
    { rate_card_hash: '0'.repeat(64) }, { client_request_id: '0'.repeat(64) }, { charged_minor: '3' },
    { charged_minor: '2' }, { usage: { ...usage, total_tokens: 201 } }, { final: false },
    { source_commitment: 'not-a-commitment' }, { account_number: 'PRIVATE-ACCOUNT-MUST-NOT-BE-STORED' },
    { charged_minor: 1 }, { charged_minor: '01' }, { charged_minor: '0.5' },
    { observed_through_at: '2026-09-05T23:59:59.000Z' },
  ];
  for (const [index, patch] of invalid.entries()) {
    const evidence = index === 0 ? { ...good, ...patch } : a.resign(good, patch);
    await assert.rejects(a.billing.submit(submitter, 'invalid-evidence-' + index, evidence));
  }
  const zero = a.charge(r, 'NO_CHARGE');
  for (const patch of [{ usage }, { provider_response_id: 'resp_not_zero' }, { charged_minor: '1' }])
    await assert.rejects(a.billing.submit(submitter, 'invalid-zero-' + canonicalHash(patch), a.resign(zero, patch)));
  assert.equal((await a.billing.list(reviewer)).length, 0);
  const getter = { ...good, get charged_minor() { throw new Error('PRIVATE-GETTER'); } };
  await assert.rejects(a.billing.submit(submitter, 'reject-billing-getter', getter), /INVALID_BILLING_EVIDENCE/);
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).status, 'UNCERTAIN');
});

test('synthetic billing evidence cannot resolve an external provider request even with the fixture verifier explicitly trusted', async t => {
  const a = await setup(t, { environment: 'external' }), r = await a.held();
  await assert.rejects(a.billing.submit(submitter, 'synthetic-cannot-external', a.charge(r)), /ENVIRONMENT_MISMATCH/);
  const signedExternal = a.resign(a.charge(r), { environment: 'external' });
  await assert.rejects(a.billing.submit(submitter, 'verifier-scope-external', signedExternal), /VERIFIER_SCOPE_MISMATCH/);
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).status, 'UNCERTAIN');
});

test('approval rechecks evidence expiry, configured key revocation and current request/rate bindings', async t => {
  const a = await setup(t), r = await a.held();
  const submitted = await a.billing.submit(submitter, 'fresh-at-submit', a.charge(r));
  a.setTime('2026-09-07T00:00:00.000Z');
  await assert.rejects(a.billing.approve(reviewer, 'stale-at-approval', submitted.evidence_record_id), /EVIDENCE_EXPIRED/);
  a.setTime(start);
  const revoked = new InferenceReconciliation(a.app.service, { ...a.config, trustedVerifiers: { 'synthetic-verifier-v1': { ...a.config.trustedVerifiers['synthetic-verifier-v1']!, revoked: true } } });
  await assert.rejects(revoked.approve(reviewer, 'revoked-before-approval', submitted.evidence_record_id), /RECONCILIATION_DISABLED|VERIFIER_UNTRUSTED/);
  await a.app.db.transaction(async tx => { const req = await tx.get('inference_requests', r.request_id); req.rate_card = { ...req.rate_card, version: 'drifted' }; await tx.update('inference_requests', r.request_id, req); });
  await assert.rejects(a.billing.approve(reviewer, 'drift-before-approval', submitted.evidence_record_id), /RATE_CARD_DRIFT/);
  assert.equal((await a.app.db.transaction(tx => tx.list('inference_billing_reviews'))).length, 0);
});

test('evidence replay is idempotent, conflicting signatures/claims are rejected and rejection leaves the hold intact', async t => {
  const a = await setup(t), r = await a.held(), e = a.charge(r);
  const original = await a.billing.submit(submitter, 'replay-evidence-key', e);
  assert.deepEqual(await a.billing.submit(submitter, 'replay-evidence-key', e), original);
  assert.deepEqual(await a.billing.submit(submitter, 'replay-evidence-new-key', e), original);
  await assert.rejects(a.billing.submit(submitter, 'replay-evidence-key', a.resign(e, { source_commitment: '0'.repeat(64) })), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(a.billing.submit(submitter, 'replay-conflicting-body', a.resign(e, { source_commitment: '0'.repeat(64) })), /EVIDENCE_REPLAY_CONFLICT/);
  await assert.rejects(a.billing.submit(submitter, 'request-conflicting-proof', a.charge(r, 'NO_CHARGE', 'alternative')), /EVIDENCE_CONFLICT/);
  const rejection = await a.billing.reject(reviewer, 'reject-first-proof', original.evidence_record_id); assert.equal(rejection.decision, 'REJECTED');
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).status, 'UNCERTAIN');
  await assert.rejects(a.billing.approve(reviewer, 'cannot-change-rejection', original.evidence_record_id), /REVIEW_CONFLICT/);
  const replacement = await a.billing.submit(submitter, 'submit-corrected-proof', a.charge(r, 'NO_CHARGE', 'alternative'));
  await a.billing.approve(reviewer, 'approve-corrected-proof', replacement.evidence_record_id);
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).billing_resolution, 'VERIFIED_NO_CHARGE');
});

test('approved invoice reclassifies exact accrued liabilities, never cash, and refuses duplicate invoice or line allocation', async t => {
  const a = await setup(t); const first = await a.resolve(await a.held('one'), 'one');
  const second = await a.resolve(await a.held('two'), 'two'); const e = a.invoice([first, second]);
  const submitted = await a.billing.submit(submitter, 'submit-two-line-invoice', e);
  assert.equal((await balances(a)).unverified, -2n);
  const review = await a.billing.approve(reviewer, 'approve-two-line-invoice', submitted.evidence_record_id);
  assert.equal(review.payment_status, 'NOT_EXECUTED');
  assert.deepEqual(await balances(a), { cash: 1000n, credit: -998n, unverified: 0n, invoiced: -2n });
  assert.deepEqual(await a.billing.approve(reviewer, 'invoice-repeat-approval', submitted.evidence_record_id), review);
  await assert.rejects(a.billing.submit(submitter, 'duplicate-invoice-identity', a.resign(e, { evidence_id: 'different-invoice-evidence' })), /INVOICE_REPLAY_CONFLICT/);
  await assert.rejects(a.billing.submit(submitter, 'duplicate-line-other-invoice', a.invoice([first], 'other-invoice')), /INVOICE_REPLAY_CONFLICT/);
  const journal = (await a.app.db.query('SELECT account_id,amount::text FROM ledger_entries WHERE transaction_id=$1', [review.journal_id])).rows;
  assert.equal(journal.length, 2); assert.equal((await a.app.db.transaction(tx => reconcile(tx))).balanced, true);
});

test('invoice mismatches, unmetered requests, duplicate usage and fabricated payment fields cannot discharge payable', async t => {
  const a = await setup(t), resolved = await a.resolve(await a.held()); const e = a.invoice([resolved]);
  const invalid: Document[] = [
    { invoice_total_minor: '2' }, { paid: true }, { bank_account: 'PRIVATE-ACCOUNT' },
    { lines: [...e.lines, ...e.lines], invoice_total_minor: '2' },
    { lines: [{ ...e.lines[0]!, amount_minor: '2' }], invoice_total_minor: '2' },
    { lines: [{ ...e.lines[0]!, usage_commitment: '0'.repeat(64) }] },
    { lines: [{ ...e.lines[0]!, provider_usage_id: 'wrong-usage' }] },
    { lines: [{ ...e.lines[0]!, provider_response_id: 'resp_wrong' }] },
  ];
  for (const [index, patch] of invalid.entries()) await assert.rejects(a.billing.submit(submitter, 'invalid-invoice-' + index, a.resign(e, patch)));
  const held = await a.held('still-held'); const fake = a.resign(e, { lines: [{ ...e.lines[0]!, request_id: held.request_id, reservation_id: held.reservation_id }] });
  await assert.rejects(a.billing.submit(submitter, 'invoice-before-metering', fake), /UNMETERED_REQUEST/);
  assert.deepEqual(await balances(a), { cash: 1000n, credit: -997n, unverified: -1n, invoiced: 0n });
});

test('provider usage IDs cannot be reassigned to another request even after an earlier proof was rejected', async t => {
  const a = await setup(t), first = await a.held('first'); const proof = a.charge(first, 'NO_CHARGE', 'first');
  const submitted = await a.billing.submit(submitter, 'first-usage-submit', proof); await a.billing.reject(reviewer, 'first-usage-reject', submitted.evidence_record_id);
  const alternate = await a.billing.submit(submitter, 'alternate-zero-submit', a.charge(first, 'NO_CHARGE', 'alternate'));
  await a.billing.approve(reviewer, 'alternate-zero-approve', alternate.evidence_record_id);
  const second = await a.held('second'); const replayed = a.resign(a.charge(second, 'NO_CHARGE', 'second'), { provider_usage_id: proof.provider_usage_id });
  await assert.rejects(a.billing.submit(submitter, 'replayed-provider-usage', replayed), /USAGE_REPLAY_CONFLICT/);
});

test('evidence/reviews are append-only, concurrent approvals journal once, and logs never contain private source content', async t => {
  const a = await setup(t), r = await a.held(); const submitted = await a.billing.submit(submitter, 'concurrent-proof', a.charge(r));
  const approvals = await Promise.all([a.billing.approve(reviewer, 'concurrent-review-one', submitted.evidence_record_id),
    a.billing.approve(reviewer, 'concurrent-review-two', submitted.evidence_record_id)]);
  assert.deepEqual(approvals[0], approvals[1]);
  assert.equal((await a.app.db.query('SELECT count(*)::text AS n FROM ledger_transactions WHERE reference=$1', ['usage:' + r.reservation_id])).rows[0]!.n, '1');
  for (const table of ['inference_billing_evidence', 'inference_billing_reviews']) {
    await assert.rejects(a.app.db.query('UPDATE ' + table + " SET document='{}'::jsonb"), /immutable append-only/);
    await assert.rejects(a.app.db.query('DELETE FROM ' + table), /immutable append-only/);
  }
  const exported = JSON.stringify(await a.billing.list(reviewer)); const audit = JSON.stringify((await a.app.db.query('SELECT payload FROM audit_events')).rows);
  for (const secret of ['PRIVATE-PROMPT-', 'PRIVATE-SYNTHETIC-UNKNOWN', 'PRIVATE-ACCOUNT', 'BEGIN PUBLIC KEY', 'signature']) {
    assert.ok(!exported.includes(secret)); assert.ok(!audit.includes(secret));
  }
  await assert.rejects(a.billing.list(demoUser), /FORBIDDEN/);
});

test('durable restart preserves approvals, holds and invoice reconciliation without new provider calls or duplicate journals', async t => {
  const a = await setup(t, { durable: true }); const held = await a.held();
  const submitted = await a.billing.submit(submitter, 'restart-proof-submit', a.charge(held)); await a.restart();
  const approved = await a.billing.approve(reviewer, 'restart-proof-approve', submitted.evidence_record_id); await a.restart();
  assert.deepEqual(await a.billing.approve(reviewer, 'restart-repeat-approval', submitted.evidence_record_id), approved);
  const resolved = await a.app.db.transaction(tx => tx.get('inference_requests', held.request_id));
  const invoice = await a.billing.submit(submitter, 'restart-invoice-submit', a.invoice([resolved])); await a.restart();
  await a.billing.approve(reviewer, 'restart-invoice-approve', invoice.evidence_record_id); await a.restart();
  assert.deepEqual(await balances(a), { cash: 1000n, credit: -999n, unverified: 0n, invoiced: -1n });
  assert.equal(a.calls, 2); assert.equal((await a.billing.list(reviewer)).length, 2);
  assert.equal((await a.app.db.transaction(tx => reconcile(tx))).balanced, true);
});

test('approval failure after settlement work rolls back money, request status, review, audit and idempotency atomically', async t => {
  const a = await setup(t), r = await a.held(); const evidence = await a.billing.submit(submitter, 'rollback-proof-submit', a.charge(r));
  const before = await balances(a); const auditCount = (await a.app.db.query('SELECT count(*)::text AS n FROM audit_events')).rows[0]!.n;
  const original = a.app.service.settleInferenceIn.bind(a.app.service);
  a.app.service.settleInferenceIn = async (...args) => { await original(...args); throw new Error('SYNTHETIC TRANSACTION FAILURE'); };
  await assert.rejects(a.billing.approve(reviewer, 'rollback-approval-key', evidence.evidence_record_id), /SYNTHETIC TRANSACTION FAILURE/);
  a.app.service.settleInferenceIn = original;
  assert.deepEqual(await balances(a), before); assert.equal((await a.app.inference.get(demoUser, r.request_id)).status, 'UNCERTAIN');
  assert.equal((await a.app.db.query('SELECT count(*)::text AS n FROM inference_billing_reviews')).rows[0]!.n, '0');
  assert.equal((await a.app.db.query('SELECT count(*)::text AS n FROM audit_events')).rows[0]!.n, auditCount);
  assert.equal((await a.app.db.query('SELECT count(*)::text AS n FROM idempotency_keys WHERE key=$1', ['rollback-approval-key'])).rows[0]!.n, '0');
  await a.billing.approve(reviewer, 'rollback-approval-key', evidence.evidence_record_id);
  assert.equal((await a.app.inference.get(demoUser, r.request_id)).billing_resolution, 'VERIFIED_CHARGE_NO_OUTPUT');
});

test('invoice approval rechecks the exact usage and payable after submission; failures never create a review or journal', async t => {
  const a = await setup(t), resolved = await a.resolve(await a.held());
  const evidence = await a.billing.submit(submitter, 'invoice-before-drift', a.invoice([resolved]));
  await a.app.db.transaction(async tx => { const r = await tx.get('inference_requests', resolved.request_id); r.usage = { ...r.usage, cached_tokens: 1 }; await tx.update('inference_requests', r.request_id, r); });
  await assert.rejects(a.billing.approve(reviewer, 'invoice-after-drift', evidence.evidence_record_id), /INVOICE_USAGE_BINDING_MISMATCH/);
  assert.deepEqual(await balances(a), { cash: 1000n, credit: -999n, unverified: -1n, invoiced: 0n });
  assert.equal((await a.billing.list(reviewer)).find(r => r.evidence_record_id === evidence.evidence_record_id)!.status, 'PENDING_REVIEW');
});

test('synthetic queued authorization cannot be silently switched to external billing before execution', async t => {
  const a = await setup(t); const request = await a.app.inference.create(demoUser, 'environment-swap-request', {
    entitlement_id: 'billing-credit', prompt: 'PRIVATE-SYNTHETIC-PROMPT', provider: 'openai', rate_card_hash: canonicalHash(card),
    max_cost_minor: maximumReservation(card), consent_external_processing: true,
  });
  let submitted = false;
  const external: InferenceProvider = { provider: 'openai', rateCard: card, validate() {}, async count() { submitted = true; return 0; },
    async generate() { submitted = true; throw new Error('must not submit'); } };
  await assert.rejects(new InferenceGateway(a.app.service, external, '100').execute(demoUser, request.request_id), /BILLING_ENVIRONMENT_CHANGED/);
  assert.equal(submitted, false); assert.equal((await a.app.inference.get(demoUser, request.request_id)).status, 'QUEUED');
});
