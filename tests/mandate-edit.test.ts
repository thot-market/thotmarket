import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoBuyer, demoUser, demoOperator, mandateInput, policyInput, importDemo, createDemoMandate } from '../packages/market/src/fixtures.ts';
import { canonicalHash, decodeProtocolObject } from '../packages/protocol/src/index.ts';
import { accountBalance, postJournal } from '../packages/ledger/src/index.ts';
import type { Document } from '../packages/storage/src/index.ts';

const fixed = '2026-09-05T12:00:00.000Z';
async function application() { return createApplication({ memory: true, dataDir: await mkdtemp(join(tmpdir(), 'thot-draft-edit-')), config: { clock: () => new Date(fixed) } }); }
const authorization = (preview: Document) => { const { release, ...fields } = preview; return { ...fields, payout_preference: 'inference_credit' }; };

test('spec 48: an unfunded draft accepts complete semantic/economic sections and retains generic canonical schema', async t => {
  const app = await application(); t.after(app.close);
  const input = mandateInput(app.service);
  const created = await app.service.createMandate(demoBuyer, 'editable-create', input);
  const criteria = { ...input.criteria, workflow_types: ['investment_research'], date_range: { start: '2026-09-01T00:00:00.000Z', end: fixed }, outcome_predicates: [{ type: 'security_traded', security_ids: ['broker:AAPL@mapping-v1'], max_lag_days: 7 }] };
  const updated = await app.service.editMandate(demoBuyer, 'editable-complete-sections', created.mandate_id, {
    expected_revision: 1, criteria,
    economics: { ...input.economics, currency: 'USDC', unit_price_minor: '9007199254740993', total_budget_minor: '18014398509481986', max_units: 2 },
    assay: { ...input.assay, threshold: 0.75 }, license: { ...input.license, retention_days: 7 },
    funding: { mode: 'onchain_escrow' }, expires_at: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(updated.mandate_id, created.mandate_id); assert.equal(updated.buyer_id, demoBuyer.buyer_id);
  assert.equal(updated.status, 'draft'); assert.equal(updated.draft_revision, 2); assert.equal(updated.created_at, created.created_at);
  assert.equal(updated.economics.unit_price_minor, '9007199254740993'); assert.equal(updated.economics.currency, 'USDC');
  assert.deepEqual(updated.criteria, criteria); assert.equal(updated.funding.funded_minor, '0');
  const { license_template_id, spent_minor, units_sold, draft_revision, created_at, updated_at, ...protocol } = updated;
  const decoded = decodeProtocolObject(protocol); assert.equal(decoded.schema_version, 'trace.mandate/1');
  assert.equal(input.economics.currency, 'USD', 'caller input must not mutate');
  const cleared = await app.service.editMandate(demoBuyer, 'editable-clear-optional', created.mandate_id, { expected_revision: 2, criteria: input.criteria });
  assert.equal(cleared.criteria.date_range, undefined); assert.equal(cleared.criteria.outcome_predicates, undefined);
  assert.equal(cleared.economics.currency, 'USDC', 'omitted complete sections are preserved');
});

test('draft create/edit reject managed fields, partial sections and invalid economics without changing records', async t => {
  const app = await application(); t.after(app.close); const input = mandateInput(app.service);
  for (const fields of [{ buyer_id: 'other' }, { mandate_id: 'chosen' }, { status: 'active' }, { funding: { mode: 'offchain_escrow', funded_minor: '10000' } }]) {
    await assert.rejects(app.service.createMandate(demoBuyer, 'reject-create-' + canonicalHash(fields).slice(0, 12), { ...input, ...fields }));
  }
  const created = await app.service.createMandate(demoBuyer, 'invalid-edit-create', input);
  const bad: Document[] = [
    {}, { expected_revision: 1 }, { draft_revision: 8 }, { buyer_id: 'other' }, { status: 'funded' }, { units_sold: 1 }, { spent_minor: '1' },
    { economics: { unit_price_minor: '1' } }, { funding: null }, { funding: { mode: 'offchain_escrow', funding_reference: 'fake' } },
    ...[1, 0.5, '1.5', '01', '-1', '0', '1e3'].map(unit_price_minor => ({ economics: { ...input.economics, unit_price_minor } })),
    { economics: { ...input.economics, total_budget_minor: '9999' } }, { economics: { ...input.economics, total_budget_minor: '1' + '0'.repeat(78) } },
    { economics: { ...input.economics, max_units: 0 } }, { economics: { ...input.economics, max_units: 1.5 } },
    { economics: { ...input.economics, direct_cost_policy_id: 'unapproved-overhead' } }, { economics: { ...input.economics, currency: 'ETH' } },
    { expected_revision: 1.5, expires_at: app.service.future(86400) }, { expires_at: '2026-02-30T00:00:00Z' }, { expires_at: '2026-09-05T12:00:00Z' },
  ];
  const before = canonicalHash((await app.service.mandates(demoBuyer))[0]);
  for (const [index, patch] of bad.entries()) {
    await assert.rejects(app.service.editMandate(demoBuyer, 'invalid-draft-edit-' + index, created.mandate_id, patch));
    assert.equal(canonicalHash((await app.service.mandates(demoBuyer))[0]), before);
  }
  assert.equal((await app.db.query("SELECT count(*)::text AS count FROM audit_events WHERE event_type='MandateEdited'")).rows[0].count, '0');
});

test('draft semantic validation enforces supported assays, predicates, rights and template limits', async t => {
  const app = await application(); t.after(app.close); const input = mandateInput(app.service);
  const m = await app.service.createMandate(demoBuyer, 'semantic-edit-create', input);
  const bad = [
    { assay: { ...input.assay, threshold: -0.1 } }, { assay: { ...input.assay, threshold: 1.1 } },
    { assay: { ...input.assay, assay_id: 'buyer-arbitrary-code' } }, { assay: { ...input.assay, input_scope: 'raw-vault' } },
    { criteria: { ...input.criteria, unknown_key: 'ignored?' } }, { criteria: { ...input.criteria, provenance_tiers: [] } },
    { criteria: { ...input.criteria, rights_required: ['rejected'] } }, { criteria: { ...input.criteria, topic_query: 'private semantic search' } },
    { criteria: { ...input.criteria, credential_predicates: [{ type: 'top_lawyer', accepted_values: ['yes'] }] } },
    { criteria: { ...input.criteria, credential_predicates: [{ type: 'workplace_cohort', accepted_values: [] }] } },
    { criteria: { ...input.criteria, outcome_predicates: [{ type: 'delayed_return_bucket' }] } },
    { criteria: { ...input.criteria, outcome_predicates: [{ type: 'security_traded', security_ids: ['AAPL'] }] } },
    { license: { ...input.license, model_training: true } }, { license: { ...input.license, onward_transfer: true } },
    { license: { ...input.license, retention_days: 31 } }, { license: { ...input.license, retention_days: 0 } },
    { license: { ...input.license, purpose: 'advertising' } }, { license_template_id: 'unapproved-template' },
  ];
  for (const [index, patch] of bad.entries()) await assert.rejects(app.service.editMandate(demoBuyer, 'semantic-bad-' + index, m.mandate_id, patch));
  assert.equal((await app.service.mandates(demoBuyer))[0].draft_revision, 1);
});

test('draft editing requires the owning approved buyer administrator', async t => {
  const app = await application(); t.after(app.close);
  const m = await app.service.createMandate(demoBuyer, 'owner-edit-create', mandateInput(app.service));
  const patch = { expires_at: app.service.future(86400) };
  await assert.rejects(app.service.editMandate({ ...demoBuyer, buyer_id: 'other-buyer' }, 'cross-buyer-edit', m.mandate_id, patch), /NOT_FOUND/);
  await assert.rejects(app.service.editMandate({ ...demoBuyer, role: 'buyer_member' }, 'member-cannot-edit', m.mandate_id, patch), /FORBIDDEN/);
  await assert.rejects(app.service.editMandate(demoUser, 'contributor-cannot-edit', m.mandate_id, patch), /FORBIDDEN/);
  await app.db.transaction(async tx => { const buyer = await tx.get('buyers', demoBuyer.buyer_id!, demoBuyer.buyer_id); await tx.update('buyers', buyer.id, { ...buyer, approved: false }); });
  await assert.rejects(app.service.editMandate(demoBuyer, 'unapproved-cannot-edit', m.mandate_id, patch), /BUYER_NOT_APPROVED/);
});

test('draft edits preserve idempotency, reject stale revisions and audit hashes rather than buyer criteria', async t => {
  const app = await application(); t.after(app.close);
  const m = await app.service.createMandate(demoBuyer, 'revision-create', mandateInput(app.service));
  const patch = { expected_revision: 1, expires_at: app.service.future(86400) };
  const first = await app.service.editMandate(demoBuyer, 'same-edit-request', m.mandate_id, patch);
  assert.deepEqual(await app.service.editMandate(demoBuyer, 'same-edit-request', m.mandate_id, patch), first);
  await assert.rejects(app.service.editMandate(demoBuyer, 'same-edit-request', m.mandate_id, { ...patch, expires_at: app.service.future(172800) }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(app.service.editMandate(demoBuyer, 'stale-edit-request', m.mandate_id, patch), /MANDATE_REVISION_CONFLICT/);
  await app.service.editMandate(demoBuyer, 'fresh-edit-request', m.mandate_id, { ...patch, expected_revision: 2 });
  const audits = (await app.db.query("SELECT payload FROM audit_events WHERE event_type='MandateEdited'")).rows;
  assert.equal(audits.length, 2);
  assert.deepEqual(Object.keys(audits[0].payload).sort(), ['draft_revision', 'mandate_id', 'previous_commitment', 'updated_commitment']);
});

test('a funded draft is frozen when any independent funding signal exists, including another currency', async t => {
  const app = await application(); t.after(app.close);
  const make = (key: string) => app.service.createMandate(demoBuyer, key, mandateInput(app.service));
  const projected = await make('funded-projection-create');
  await app.db.transaction(tx => tx.update('mandates', projected.mandate_id, { ...projected, funding: { ...projected.funding, funded_minor: '1' } }));
  await assert.rejects(app.service.editMandate(demoBuyer, 'funded-projection-edit', projected.mandate_id, { expires_at: app.service.future(86400) }), /FUNDED_DRAFT_IMMUTABLE/);
  const recorded = await make('funding-record-create');
  await app.db.transaction(tx => tx.insert('mandate_funding', 'funding-record', demoBuyer.buyer_id!, { mandate_id: recorded.mandate_id, funding_reference: 'actual-funding-reference', amount_minor: '1' }));
  await assert.rejects(app.service.editMandate(demoBuyer, 'funding-record-edit', recorded.mandate_id, { expires_at: app.service.future(86400) }), /FUNDED_DRAFT_IMMUTABLE/);
  for (const currency of ['USD', 'USDC'] as const) {
    const funded = await make('escrow-only-' + currency);
    await app.db.transaction(tx => postJournal(tx, 'escrow-only-' + currency, currency, [{ account: 'ASSET:cash', owner: 'network', amount: 1n }, { account: 'LIABILITY:buyer_escrow', owner: funded.mandate_id, amount: -1n }]));
    await assert.rejects(app.service.editMandate(demoBuyer, 'escrow-edit-' + currency, funded.mandate_id, { expires_at: app.service.future(86400) }), /FUNDED_DRAFT_IMMUTABLE/);
  }
});

test('funding and all non-draft states freeze economics; edited amounts fund and reconcile exactly', async t => {
  const app = await application(); t.after(app.close); const input = mandateInput(app.service);
  const m = await app.service.createMandate(demoBuyer, 'changed-currency-create', input);
  const patch = { economics: { ...input.economics, currency: 'USDC', unit_price_minor: '9007199254740993', total_budget_minor: '18014398509481986', max_units: 2 } };
  await app.service.editMandate(demoBuyer, 'changed-currency-edit', m.mandate_id, patch);
  await app.service.fundMandate(demoBuyer, 'changed-currency-fund', m.mandate_id, {});
  assert.equal(await app.db.transaction(tx => accountBalance(tx, 'USDC', m.mandate_id, 'LIABILITY:buyer_escrow')), -18014398509481986n);
  assert.equal(await app.db.transaction(tx => accountBalance(tx, 'USD', m.mandate_id, 'LIABILITY:buyer_escrow')), 0n);
  for (const status of ['funded', 'pending_funding', 'active', 'paused', 'closed', 'exhausted', 'expired']) {
    await app.db.transaction(async tx => { const current = await tx.get('mandates', m.mandate_id); await tx.update('mandates', m.mandate_id, { ...current, status }); });
    await assert.rejects(app.service.editMandate(demoBuyer, 'state-frozen-' + status, m.mandate_id, { expires_at: app.service.future(86400) }), /MANDATE_IMMUTABLE/);
  }
  assert.equal((await app.service.reconciliation(demoOperator)).balanced, true);
});

test('racing funding and draft edits cannot mix old funding with new economic terms', async t => {
  const app = await application(); t.after(app.close);
  for (const fundFirst of [true, false]) {
    const input = mandateInput(app.service), m = await app.service.createMandate(demoBuyer, 'race-create-' + fundFirst, input);
    const edit = () => app.service.editMandate(demoBuyer, 'race-edit-' + fundFirst, m.mandate_id, { expected_revision: 1, economics: { ...input.economics, unit_price_minor: '20000', total_budget_minor: '200000' } });
    const fund = () => app.service.fundMandate(demoBuyer, 'race-fund-' + fundFirst, m.mandate_id, {});
    const results = await Promise.allSettled(fundFirst ? [fund(), edit()] : [edit(), fund()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length >= 1, true);
    const current = (await app.service.mandates(demoBuyer)).find(record => record.mandate_id === m.mandate_id)!;
    assert.equal(current.status, 'funded'); assert.equal(current.funding.funded_minor, current.economics.total_budget_minor);
    assert.equal(-await app.db.transaction(tx => accountBalance(tx, current.economics.currency, m.mandate_id, 'LIABILITY:buyer_escrow')), BigInt(current.economics.total_budget_minor));
  }
});

test('spec 81: two explicit nonexclusive licenses increment sale history exactly once per buyer mandate', async t => {
  const app = await application(); t.after(app.close);
  await app.service.createPolicy(demoUser, 'nonexclusive-policy', policyInput(app.service));
  const trace = await importDemo(app.service, demoUser, 'coding', 'nonexclusive-trace');
  const mandates = [await createDemoMandate(app.service, 'general', 'nonexclusive-first'), await createDemoMandate(app.service, 'general', 'nonexclusive-second')];
  assert.equal((await app.service.runWorker()).failed, 0);
  const candidates = (await app.service.candidates(demoUser)).filter(candidate => candidate.trace_id === trace.trace_id);
  assert.equal(candidates.length, 2);
  const sales = [];
  for (const [index, candidate] of candidates.entries()) {
    const preview = await app.service.preview(demoUser, candidate.candidate_id);
    assert.equal(preview.release.license.terms.exclusive, false);
    const key = 'nonexclusive-authorization-' + index;
    const sale = await app.service.authorize(demoUser, key, authorization(preview));
    assert.equal((await app.service.authorize(demoUser, key, authorization(preview))).license_id, sale.license_id);
    sales.push(sale);
  }
  assert.notEqual(sales[0].license_id, sales[1].license_id);
  assert.equal((await app.service.trace(demoUser, trace.trace_id)).sale_count, 2);
  await app.service.runWorker(); assert.equal((await app.service.earnings(demoUser)).entitlements.length, 2);
  for (const mandate of mandates) {
    assert.equal((await app.service.stats(demoBuyer, mandate.mandate_id)).delivered, 1);
    await assert.rejects(app.service.editMandate(demoBuyer, 'licensed-mandate-edit-' + mandate.mandate_id, mandate.mandate_id, { expires_at: app.service.future(86400) }), /MANDATE_IMMUTABLE/);
  }
  assert.equal((await app.service.reconciliation(demoOperator)).balanced, true);
});
