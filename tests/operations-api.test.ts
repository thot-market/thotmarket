import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer, startServer } from '../apps/api/server.ts';
import { ExternalAuth, type ExternalAuthConfig } from '../packages/auth/src/index.ts';
import { demoUser, demoOperator, importDemo } from '../packages/market/src/fixtures.ts';
import { canonicalHash, signCanonical } from '../packages/protocol/src/index.ts';
import { postJournal, accountBalance } from '../packages/ledger/src/index.ts';
import { maximumReservation, validateRateCard, type InferenceProvider, type InferenceRateCard, type InferenceResult } from '../packages/inference/src/index.ts';
import { type BillingReconciliationConfig } from '../packages/market/src/inference-reconciliation.ts';
import { LEASE_FILE } from '../packages/operations/src/lease.ts';
import type { Actor } from '../packages/market/src/service.ts';
import type { Document } from '../packages/storage/src/index.ts';

const instant = '2026-09-06T00:00:00.000Z', now = Date.parse(instant);
const clock = () => new Date(instant);
// All inference implementations here are code-local fixtures, not HTTP provider adapters.
const card: InferenceRateCard = { version: 'synthetic-operations/1', model: 'synthetic-operations-model', service_tier: 'default', currency: 'USD',
  input_micro_usd_per_million: '4000000', cached_micro_usd_per_million: '2000000', cache_write_micro_usd_per_million: '8000000',
  output_micro_usd_per_million: '20000000', max_input_tokens: 1000, max_output_tokens: 250,
  verified_at: instant, expires_at: '2026-09-07T00:00:00.000Z', verified: true, example_only: false };
function control(revision: number, paused: Partial<Record<'sales' | 'inference' | 'deliveries', boolean>> = {}) {
  return { expected_revision: revision, paused: { sales: false, inference: false, deliveries: false, ...paused },
    reason_code: 'MAINTENANCE', acknowledge_resume: true };
}
async function setup(t: any, options: { provider?: InferenceProvider; configure?: (app: Awaited<ReturnType<typeof createApplication>>) => Promise<Partial<Parameters<typeof createHttpServer>[1]>> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'thot-operations-api-'));
  const app = await createApplication({ memory: true, dataDir: directory, config: { clock },
    ...(options.provider ? { inference: { provider: options.provider, dailyBudgetMinor: '100' } } : {}) });
  const logs: Document[] = []; let server: ReturnType<typeof createHttpServer> | undefined;
  t.after(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await app.close(); await rm(directory, { recursive: true, force: true });
  });
  const configured = await options.configure?.(app);
  server = createHttpServer(app, { ...configured, clock: () => now, log: event => logs.push(event) });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, token = '', body?: Document, key: string = randomUUID()) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const session = async (role: string) => { const result = await call('/v1/dev/session', '', { role }); assert.equal(result.status, 200); return result.body.token as string; };
  return { app, server, base, call, session, logs };
}
async function credit(app: Awaited<ReturnType<typeof createApplication>>) {
  await app.db.transaction(async tx => {
    await tx.insert('contributor_entitlements', 'operations-credit', demoUser.id, { entitlement_id: 'operations-credit', settlement_id: 'operations-credit-sale',
      currency: 'USD', available_minor: '1000', status: 'AVAILABLE', disposition: 'inference_credit' });
    await postJournal(tx, 'operations-api-credit', 'USD', [{ owner: 'network', account: 'ASSET:cash', amount: 1000n },
      { owner: 'operations-credit', account: 'LIABILITY:contributor_inference_credit', amount: -1000n }]);
  });
}
const inferenceInput = (label: string) => ({ entitlement_id: 'operations-credit', prompt: 'PRIVATE-OPERATIONS-PROMPT-' + label,
  provider: 'openai', rate_card_hash: canonicalHash(card), max_cost_minor: maximumReservation(card), consent_external_processing: true });
async function candidate(a: Awaited<ReturnType<typeof setup>>, user: string, buyer: string) {
  assert.equal((await a.call('/v1/dev/policy', user, {})).status, 200);
  assert.equal((await a.call('/v1/dev/trace', user, { scenario: 'coding' })).status, 200);
  assert.equal((await a.call('/v1/dev/mandate', buyer, { category: 'general' })).status, 200);
  assert.equal((await a.call('/v1/dev/run-worker', user, {})).body.failed, 0);
  const candidates = (await a.call('/v1/candidates', user)).body;
  const preview = (await a.call('/v1/candidates/' + candidates[0].candidate_id + '/preview', user)).body;
  const { release: _release, ...fields } = preview; return { ...fields, payout_preference: 'inference_credit' };
}

test('operations HTTP requires security role; disabled billing cannot accept even signed fixture metadata; metrics and logs are private', async t => {
  const a = await setup(t); const user = await a.session('user'), buyer = await a.session('buyer_admin'), operator = await a.session('operator_security');
  for (const path of ['/v1/operator/operations', '/v1/operator/billing']) {
    assert.equal((await a.call(path)).status, 401);
    assert.equal((await a.call(path, user)).status, 403); assert.equal((await a.call(path, buyer)).status, 403);
    assert.equal((await a.call(path, operator)).status, 200);
  }
  assert.equal((await a.call('/v1/operator/controls', user, control(0, { sales: true }))).status, 403);
  assert.equal((await a.call('/v1/operator/billing', operator)).body.capabilities.enabled, false);
  const key = generateKeyPairSync('ed25519'); const unsigned = { schema_version: 'thot.inference-billing-evidence/1', kind: 'request_charge', charged_minor: '0' };
  const signed = { ...unsigned, signature: signCanonical(unsigned, key.privateKey) };
  const disabled = await a.call('/v1/operator/billing/evidence', operator, signed);
  assert.equal(disabled.status, 503); assert.equal(disabled.body.error, 'BILLING_RECONCILIATION_DISABLED');
  await a.app.db.transaction(tx => tx.insert('inference_requests', 'private-metric-request', demoUser.id,
    { request_id: 'private-metric-request', status: 'UNCERTAIN', reservation_id: 'private-reservation', reserved_minor: '2', currency: 'USD',
      prompt_ref: { objectId: 'PRIVATE-VAULT-OBJECT' }, failure_code: 'PRIVATE-FAILURE-DETAIL' }));
  const report = await a.call('/v1/operator/operations', operator);
  assert.equal(report.body.metrics.inference.UNCERTAIN, 1); assert.ok(report.body.alerts.includes('INFERENCE_CHARGE_UNCERTAIN'));
  const serialized = JSON.stringify(report.body) + JSON.stringify(a.logs);
  for (const secret of [user, buyer, operator, 'demo-user', 'PRIVATE-', 'private-metric-request', 'private-reservation', 'signature']) assert.ok(!serialized.includes(secret));
});

test('operations HTTP enforces mutation keys, optimistic revisions, idempotent controls and explicit resume review', async t => {
  const a = await setup(t), operator = await a.session('operator_security'); const input = control(0, { sales: true });
  const missing = await a.call('/v1/operator/controls', operator, input, ''); assert.equal(missing.body.error, 'IDEMPOTENCY_KEY_REQUIRED');
  const key = randomUUID(); const paused = await a.call('/v1/operator/controls', operator, input, key);
  assert.equal(paused.status, 200); assert.equal(paused.body.revision, 1);
  assert.deepEqual((await a.call('/v1/operator/controls', operator, input, key)).body, paused.body);
  assert.equal((await a.call('/v1/operator/controls', operator, control(1), key)).body.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await a.call('/v1/operator/controls', operator, control(0))).body.error, 'OPERATIONAL_REVISION_CONFLICT');
  assert.equal((await a.call('/v1/operator/controls', operator, { ...control(1), acknowledge_resume: false })).body.error, 'OPERATIONAL_RESUME_REVIEW_REQUIRED');
  assert.equal((await a.call('/v1/operator/controls', operator, { ...control(1), reason_code: 'PRIVATE-RAW-REASON' })).body.error, 'INVALID_OPERATIONAL_REASON');
  const resumed = await a.call('/v1/operator/controls', operator, control(1)); assert.equal(resumed.body.revision, 2);
  assert.equal((await a.call('/v1/operator/operations', operator)).body.control.sales, false);
  const events = (await a.app.db.query("SELECT payload FROM audit_events WHERE event_type='OperationalControlChanged'")).rows;
  assert.equal(events.length, 2); assert.ok(!JSON.stringify(a.logs).includes('PRIVATE-RAW-REASON'));
});

test('sales HTTP pause preserves candidates and prior commitments while delivery pause blocks existing access', async t => {
  const a = await setup(t), user = await a.session('user'), buyer = await a.session('buyer_admin'), operator = await a.session('operator_security');
  const input = await candidate(a, user, buyer); const authorizationKey = randomUUID();
  assert.equal((await a.call('/v1/operator/controls', operator, control(0, { sales: true }))).status, 200);
  assert.equal((await a.call('/v1/sale-authorizations', user, input, authorizationKey)).body.error, 'OPERATION_PAUSED');
  assert.equal((await a.app.db.query('SELECT count(*)::text AS n FROM licenses')).rows[0]!.n, '0');
  assert.equal((await a.call('/v1/candidates', user)).body.length, 1);
  await a.call('/v1/operator/controls', operator, control(1));
  const sale = await a.call('/v1/sale-authorizations', user, input, authorizationKey); assert.equal(sale.status, 200);
  assert.deepEqual((await a.call('/v1/sale-authorizations', user, input, authorizationKey)).body, sale.body);
  const deliveryPath = '/v1/buyer/deliveries/' + sale.body.license_id;
  assert.equal((await a.call(deliveryPath, buyer)).status, 200);
  await a.call('/v1/operator/controls', operator, control(2, { sales: true, inference: true, deliveries: true }));
  assert.equal((await a.call(deliveryPath, buyer)).body.error, 'OPERATION_PAUSED');
  assert.equal((await a.call('/v1/dev/run-worker', user, {})).body.failed, 0);
  assert.equal((await a.call('/v1/earnings', user)).body.entitlements[0].amount_minor, '6500');
  assert.equal((await a.call('/v1/operator/reconciliation', operator)).body.balanced, true);
  await a.call('/v1/operator/controls', operator, control(3));
  assert.equal((await a.call(deliveryPath, buyer)).status, 200);
});

test('inference HTTP pause stops queued submissions and new reservations but permits already-submitted metering and cancellation', async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let providerCalls = 0;
  const provider: InferenceProvider = { provider: 'openai', rateCard: card, validate() { validateRateCard(card, clock()); },
    async count() { providerCalls++; return 100; }, async generate(): Promise<InferenceResult> {
      providerCalls++; entered(); await blocked;
      return { provider_response_id: 'resp_operations_fixture', status: 'COMPLETED', text: 'PRIVATE-OPERATIONS-OUTPUT', actual_minor: '1',
        usage: { input_tokens: 100, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 100, total_tokens: 200 } };
    } };
  const a = await setup(t, { provider }); await credit(a.app);
  const user = await a.session('user'), operator = await a.session('operator_security');
  const first = await a.call('/v1/inference/requests', user, inferenceInput('inflight'));
  const second = await a.call('/v1/inference/requests', user, inferenceInput('queued'));
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const executing = a.call('/v1/inference/requests/' + first.body.request_id + '/execute', user, {}); await started;
  await a.call('/v1/operator/controls', operator, control(0, { inference: true }));
  assert.equal((await a.call('/v1/inference/requests', user, inferenceInput('paused'))).body.error, 'OPERATION_PAUSED');
  assert.equal((await a.call('/v1/inference/requests/' + second.body.request_id + '/execute', user, {})).body.error, 'OPERATION_PAUSED');
  assert.equal((await a.call('/v1/entitlements/operations-credit/inference-reservations', user, { amount_minor: '1' })).body.error, 'OPERATION_PAUSED');
  assert.equal(providerCalls, 2);
  release(); const completed = await executing; assert.equal(completed.status, 200); assert.equal(completed.body.status, 'COMPLETED');
  assert.equal(completed.body.actual_minor, '1');
  assert.equal((await a.call('/v1/inference/requests/' + second.body.request_id + '/cancel', user, {})).body.status, 'CANCELLED');
  assert.equal((await a.call('/v1/earnings', user)).body.entitlements[0].available_minor, '999');
  const payable = await a.app.db.transaction(tx => accountBalance(tx, 'USD', 'network', 'LIABILITY:inference_provider_payable')); assert.equal(payable, -1n);
  assert.ok(!JSON.stringify(a.logs).includes('PRIVATE-OPERATIONS')); assert.equal(providerCalls, 2);
});

test('similarity HTTP remains owner-only and advisory without exposing raw snippets or changing sale accounting', async t => {
  const a = await setup(t), user = await a.session('user'), buyer = await a.session('buyer_admin'), operator = await a.session('operator_security');
  const own = await a.call('/v1/dev/trace', user, { scenario: 'coding' }); assert.equal(own.status, 200);
  const foreign = await importDemo(a.app.service, { id: 'other-user', role: 'user' }, 'coding', 'operations-foreign-import');
  const path = '/v1/traces/' + own.body.trace_id + '/similarity';
  assert.equal((await a.call(path)).status, 401); assert.equal((await a.call(path, buyer)).status, 403); assert.equal((await a.call(path, operator)).status, 403);
  assert.equal((await a.call('/v1/traces/' + foreign.trace_id + '/similarity', user)).status, 404);
  const report = await a.call(path, user); assert.equal(report.status, 200); assert.equal(report.body.review_only, true);
  assert.ok(!JSON.stringify(report.body).includes(foreign.trace_id)); assert.ok(!JSON.stringify(report.body).includes('alex@example.test'));
  assert.equal((await a.app.db.query('SELECT count(*)::text AS n FROM licenses')).rows[0]!.n, '0');
  assert.equal((await a.app.db.query('SELECT count(*)::text AS n FROM ledger_transactions')).rows[0]!.n, '0');
});

test('configured pinned external identities enforce independent billing review over HTTP without development-role escalation', async t => {
  const submitter: Actor = { id: 'operations-billing-submitter', role: 'operator_security' }, reviewer: Actor = { id: 'operations-billing-reviewer', role: 'operator_security' };
  const authKeys = generateKeyPairSync('rsa', { modulusLength: 2048 }), billingKeys = generateKeyPairSync('ed25519');
  const jwk = { ...authKeys.publicKey.export({ format: 'jwk' }), kid: 'operations-auth-key', alg: 'RS256', use: 'sig' };
  const issuer = 'https://offline-operations-issuer.example.invalid', audience = 'thot-operations-access';
  const credential = (subject: string) => {
    const unsigned = [JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid }),
      JSON.stringify({ iss: issuer, aud: audience, sub: subject, iat: now / 1000 - 1, exp: now / 1000 + 299, jti: randomUUID() })].map(v => Buffer.from(v).toString('base64url')).join('.');
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), authKeys.privateKey).toString('base64url');
  };
  const billing: BillingReconciliationConfig = { audience: 'synthetic-operations-billing', submitterIds: [submitter.id], reviewerIds: [submitter.id, reviewer.id],
    trustedVerifiers: { 'synthetic-billing-key': { publicKeyPem: billingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      provider: 'openai', environment: 'synthetic', validFrom: '2026-09-05T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z' } } };
  const provider: InferenceProvider & { billingEnvironment: 'synthetic' } = { provider: 'openai', billingEnvironment: 'synthetic', rateCard: card,
    validate() {}, async count() { return 100; }, async generate() { throw new Error('PRIVATE-SYNTHETIC-UNKNOWN'); } };
  const a = await setup(t, { provider, configure: async app => {
    await credit(app); await app.db.transaction(async tx => { for (const actor of [submitter, reviewer]) await tx.insert('users', actor.id, actor.id, { role: actor.role }); });
    const config: ExternalAuthConfig = { schema_version: 'thot.external-auth/1', jwt: { issuer, audience, max_token_age_seconds: 300, jwks: { keys: [jwk] } },
      initial_memberships: [{ subject: 'operations-user', actor: demoUser, enabled: true }, { subject: 'operations-submit', actor: submitter, enabled: true }, { subject: 'operations-review', actor: reviewer, enabled: true }] };
    return { externalAuth: await ExternalAuth.create(app.db, config, () => now), billing };
  } });
  const userToken = credential('operations-user'), submitToken = credential('operations-submit'), reviewToken = credential('operations-review');
  assert.equal((await a.call('/v1/dev/session', '', { role: 'operator_security' })).body.error, 'DEVELOPMENT_AUTH_DISABLED');
  const created = await a.call('/v1/inference/requests', userToken, inferenceInput('billing'));
  const held = await a.call('/v1/inference/requests/' + created.body.request_id + '/execute', userToken, {}); assert.equal(held.body.status, 'UNCERTAIN');
  const unsigned = { schema_version: 'thot.inference-billing-evidence/1', kind: 'request_charge', evidence_id: 'synthetic-http-billing-proof',
    verifier_id: 'synthetic-billing-key', audience: billing.audience, provider: 'openai', environment: 'synthetic', issued_at: instant,
    expires_at: '2026-09-07T00:00:00.000Z', source_commitment: canonicalHash({ fixture: 'SYNTHETIC HTTP PROOF' }), final: true, currency: 'USD',
    request_id: held.body.request_id, reservation_id: held.body.reservation_id, rate_card_hash: held.body.rate_card_hash,
    client_request_id: canonicalHash({ requestId: held.body.request_id, path: 'responses' }), provider_response_id: null,
    provider_usage_id: 'synthetic-http-zero-record', observed_through_at: instant, outcome: 'NO_CHARGE', charged_minor: '0', usage: null };
  const evidence = { ...unsigned, signature: signCanonical(unsigned, billingKeys.privateKey) };
  assert.equal((await a.call('/v1/operator/billing/evidence', userToken, evidence)).status, 403);
  const submitted = await a.call('/v1/operator/billing/evidence', submitToken, evidence); assert.equal(submitted.status, 200);
  const path = '/v1/operator/billing/' + submitted.body.evidence_record_id + '/approve';
  assert.equal((await a.call(path, submitToken, {})).body.error, 'BILLING_SELF_APPROVAL_DENIED');
  assert.equal((await a.call(path, reviewToken, { reviewed_by: reviewer.id })).body.error, 'INVALID_BILLING_REVIEW_REQUEST');
  await a.call('/v1/operator/controls', reviewToken, control(0, { inference: true }));
  const key = randomUUID(), reviewed = await a.call(path, reviewToken, {}, key); assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.submitted_by, submitter.id); assert.equal(reviewed.body.reviewed_by, reviewer.id);
  assert.equal(reviewed.body.payment_status, 'NOT_EXECUTED'); assert.deepEqual((await a.call(path, reviewToken, {}, key)).body, reviewed.body);
  const resolved = await a.call('/v1/inference/requests/' + held.body.request_id, userToken); assert.equal(resolved.body.billing_resolution, 'VERIFIED_NO_CHARGE');
  assert.equal((await a.call('/v1/earnings', userToken)).body.entitlements[0].available_minor, '1000');
  assert.equal((await a.call('/v1/operator/billing', reviewToken)).body.records[0].status, 'APPROVED');
  for (const secret of [userToken, submitToken, reviewToken, 'PRIVATE-', evidence.signature, 'BEGIN PUBLIC KEY']) assert.ok(!JSON.stringify(a.logs).includes(secret));
});

test('startServer bind failure closes the failed application lease without affecting the running server or preventing a clean retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-bind-failure-')); const firstDir = join(directory, 'first'), secondDir = join(directory, 'second');
  const names = ['THOT_ENABLE_LIVE_INFERENCE', 'THOT_ENABLE_EXTERNAL_AUTH', 'THOT_ENABLE_BILLING_RECONCILIATION'] as const;
  const flags = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'false';
  let first: Awaited<ReturnType<typeof startServer>> | undefined, retry: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    first = await startServer({ port: 0, dataDir: firstDir }); const address = first.server.address(); assert.ok(address && typeof address === 'object');
    await assert.rejects(startServer({ port: address.port, dataDir: secondDir }), (error: any) => error.code === 'EADDRINUSE');
    await assert.rejects(stat(join(secondDir, LEASE_FILE)), (error: any) => error.code === 'ENOENT');
    assert.equal((await fetch(first.url + '/healthz')).status, 200);
    await assert.rejects(createApplication({ dataDir: firstDir }), /DATA_DIRECTORY_LEASE_HELD/);
    const reopened = await createApplication({ dataDir: secondDir }); await reopened.close();
    await first.close(); first = undefined;
    retry = await startServer({ port: address.port, dataDir: secondDir }); assert.equal((await fetch(retry.url + '/healthz')).status, 200);
    await retry.close(); retry = undefined; await assert.rejects(stat(join(secondDir, LEASE_FILE)), (error: any) => error.code === 'ENOENT');
  } finally {
    if (retry) await retry.close(); if (first) await first.close();
    for (const name of names) { if (flags[name] === undefined) delete process.env[name]; else process.env[name] = flags[name]; }
    await rm(directory, { recursive: true, force: true });
  }
});
