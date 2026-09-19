import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../packages/storage/src/index.ts';
import { ThotService, releaseHash, type PrivacyFacade, type MarketConfig } from '../packages/market/src/service.ts';
import { postJournal, accountBalance, accountId, reconcile } from '../packages/ledger/src/index.ts';

const now = '2026-09-05T12:00:00.000Z';
const config: MarketConfig = { development: true, tokenEnabled: false, standingAuthorization: false, exclusivity: false,
  approvedLicenseTemplates: { research: 'Approved research-only license.' }, approvedCostCodes: [], maxDirectCostsMinor: '0',
  clock: () => new Date(now) };
const user = { id: 'demo-user', role: 'user' as const };
const settlementActor = { id: 'settlement-service', role: 'service_settlement' as const };
const buyer = { id: 'buyer-member-1', role: 'buyer_admin' as const, buyer_id: 'demo-buyer' };
const mandateInput = {
  criteria: { provenance_tiers: ['P0_OPERATOR'], workflow_types: ['coding'], rights_required: ['eligible'] },
  assay: { assay_id: 'safe-features', version: '1', threshold: 0.5, input_scope: 'safe-features-v1', output_schema: 'accepted-score-relevance/1' },
  economics: { currency: 'USD', max_units: 2, unit_price_minor: '10000', total_budget_minor: '20000', direct_cost_policy_id: 'direct-costs/v1' },
  license: { purpose: 'research', model_training: false, onward_transfer: false, exclusive: false, retention_days: 30 },
  funding: { mode: 'offchain_escrow' }, expires_at: '2026-10-05T12:00:00.000Z', license_template_id: 'research',
};
async function fixture() {
  const db = await Database.open();
  // These review cases exercise accounting and policy only, so no cryptographic facade is called.
  const service = new ThotService(db, {} as PrivacyFacade, config);
  await service.seedDevelopment();
  return { db, service };
}
async function credit(db: Database, value = 6500n) {
  await db.transaction(async tx => {
    await postJournal(tx, 'review-inference-credit', 'USD', [
      { account: 'ASSET:cash', owner: 'network', amount: value },
      { account: 'LIABILITY:contributor_inference_credit', owner: 'entitlement-1', amount: -value },
    ]);
    await tx.insert('contributor_entitlements', 'entitlement-1', user.id, {
      entitlement_id: 'entitlement-1', settlement_id: 'settlement-1', currency: 'USD', amount_minor: value.toString(),
      available_minor: value.toString(), disposition: 'inference_credit', status: 'AVAILABLE', created_at: now,
    });
  });
}

test('review: approved license template metadata does not violate the canonical mandate schema', async () => {
  const { db, service } = await fixture();
  try {
    const mandate = await service.createMandate(buyer, 'review-create-mandate', mandateInput);
    assert.equal(mandate.license_template_id, 'research'); assert.equal(mandate.status, 'draft');
    assert.equal(mandate.economics.unit_price_minor, '10000');
  } finally { await db.close(); }
});

test('review: refund from a second inference reservation restores spendable state after first spends', async () => {
  const { db, service } = await fixture();
  try {
    await credit(db);
    const a = await service.reserveInference(user, 'review-reserve-first', 'entitlement-1', { amount_minor: '3000' });
    const b = await service.reserveInference(user, 'review-reserve-second', 'entitlement-1', { amount_minor: '3500' });
    await service.settleInference(settlementActor, 'review-settle-first', a.reservation_id, { actual_minor: '3000' });
    await service.settleInference(settlementActor, 'review-release-second', b.reservation_id, { actual_minor: '0' });
    const entitlement = (await service.earnings(user)).entitlements[0];
    assert.equal(entitlement.available_minor, '3500'); assert.equal(entitlement.status, 'AVAILABLE');
    const replacement = await service.reserveInference(user, 'review-reserve-restored', 'entitlement-1', { amount_minor: '3500' });
    assert.equal(replacement.status, 'RESERVED');
    assert.equal((await db.transaction(tx => reconcile(tx))).balanced, true);
  } finally { await db.close(); }
});

test('review: concurrent reservations cannot overspend and retries do not reserve twice', async () => {
  const { db, service } = await fixture();
  try {
    await credit(db);
    const reservations = await Promise.allSettled([
      service.reserveInference(user, 'review-race-key-one', 'entitlement-1', { amount_minor: '4000' }),
      service.reserveInference(user, 'review-race-key-two', 'entitlement-1', { amount_minor: '4000' }),
    ]);
    assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(reservations.filter(result => result.status === 'rejected').length, 1);
    const winner = reservations.findIndex(result => result.status === 'fulfilled');
    const key = winner === 0 ? 'review-race-key-one' : 'review-race-key-two';
    await service.reserveInference(user, key, 'entitlement-1', { amount_minor: '4000' });
    const entitlement = (await service.earnings(user)).entitlements[0];
    assert.equal(entitlement.available_minor, '2500');
    assert.equal(await db.transaction(tx => accountBalance(tx, 'USD', 'entitlement-1', 'LIABILITY:contributor_inference_credit')), -2500n);
    await assert.rejects(service.reserveInference(user, key, 'entitlement-1', { amount_minor: '1' }));
  } finally { await db.close(); }
});

test('review: database cannot append an unbalanced entry to an already committed immutable journal', async () => {
  const { db } = await fixture();
  try {
    let transactionId = '';
    await db.transaction(async tx => { transactionId = await postJournal(tx, 'review-append-guard', 'USD', [
      { account: 'ASSET:cash', owner: 'network', amount: 10n },
      { account: 'LIABILITY:buyer_escrow', owner: 'mandate-1', amount: -10n },
    ]); });
    await assert.rejects(db.transaction(async tx => {
      await tx.sql.query('INSERT INTO ledger_entries(id,transaction_id,account_id,amount) VALUES($1,$2,$3,$4)',
        ['review-illegal-append', transactionId, accountId('USD', 'network', 'ASSET:cash'), '1']);
    }));
    assert.equal((await db.transaction(tx => reconcile(tx))).balanced, true);
  } finally { await db.close(); }
});

test('review: failed journal operation rolls back all earlier entries and accounts', async () => {
  const { db } = await fixture();
  try {
    await assert.rejects(db.transaction(tx => postJournal(tx, 'review-invalid-account', 'USD', [
      { account: 'ASSET:cash', owner: 'network', amount: 10n },
      { account: 'NOT_AN_ACCOUNT:fake', owner: 'network', amount: -10n },
    ])));
    assert.equal((await db.query('SELECT count(*)::text AS count FROM ledger_transactions')).rows[0].count, '0');
    assert.equal((await db.query('SELECT count(*)::text AS count FROM ledger_entries')).rows[0].count, '0');
  } finally { await db.close(); }
});

test('review: an explicitly empty buyer allowlist authorizes no buyer', async () => {
  const { db, service } = await fixture();
  try {
    const policy = { effective_at: now, allowed_categories: ['general'], prohibited_categories: [], allowed_buyers: [],
      allowed_purposes: ['research'], prohibited_purposes: [], evidence_disclosure: { trace_body: true },
      license_defaults: { model_training: false, onward_transfer: false, exclusive: false } };
    assert.equal(service.policyAllows(policy, { buyer_id: 'demo-buyer', license: mandateInput.license }, { category: 'general' }), false);
    assert.equal(service.policyAllows({ ...policy, allowed_buyers: ['demo-buyer'] }, { buyer_id: 'demo-buyer', license: mandateInput.license }, { category: 'general' }), true);
  } finally { await db.close(); }
});

test('review: buyer approval revocation prevents a pending candidate from finalizing', async () => {
  const { db, service } = await fixture();
  try {
    const bundle = { delivery: { bundle_hash: '' }, license: { terms_hash: 'terms-hash' }, trace: { scrubbed_content: { text: 'Public research fixture' } } };
    bundle.delivery.bundle_hash = releaseHash(bundle);
    service.privacy = { open: async (_owner: string, ref: Record<string, unknown>) => ref.value } as PrivacyFacade;
    const candidate = await db.transaction(async tx => {
      const b = await tx.get('buyers', 'demo-buyer'); b.approved = false; await tx.update('buyers', b.id, b);
      await tx.insert('user_policies', 'review-policy', user.id, {
        policy_id: 'review-policy', version: 1, effective_at: now,
        allowed_categories: ['general'], prohibited_categories: [], allowed_purposes: ['research'], prohibited_purposes: [],
        evidence_disclosure: { trace_body: true, credential_predicate_types: [], outcome_predicate_types: [] }, license_defaults: mandateInput.license,
      });
      await tx.insert('traces', 'review-trace', user.id, { trace_id: 'review-trace', category: 'general', deleted: false,
        retention_expires_at: mandateInput.expires_at, rights_status: 'eligible', credential_ids: [], outcome_ids: [], sale_count: 0 });
      await tx.insert('mandates', 'review-mandate', 'demo-buyer', { ...mandateInput, mandate_id: 'review-mandate', buyer_id: 'demo-buyer',
        status: 'active', funding: { funded_minor: '10000' }, units_sold: 0, spent_minor: '0' });
      await tx.insert('sale_authorizations', 'review-auth', user.id, { authorization_id: 'review-auth', owner_user_id: user.id, expires_at: mandateInput.expires_at,
        release_artifact_hash: bundle.delivery.bundle_hash, license_hash: 'terms-hash' });
      await postJournal(tx, 'review-revoked-buyer-fund', 'USD', [
        { account: 'ASSET:cash', owner: 'network', amount: 10_000n },
        { account: 'LIABILITY:buyer_escrow', owner: 'review-mandate', amount: -10_000n },
      ]);
      return tx.insert('mandate_candidates', 'review-candidate', user.id, {
        candidate_id: 'review-candidate', trace_id: 'review-trace', mandate_id: 'review-mandate', authorization_id: 'review-auth',
        policy_id: 'review-policy', policy_version: 1, license_id: 'review-license', credential_receipt_ids: [], outcome_receipt_ids: [],
        release_ref: { value: bundle }, release_hash: bundle.delivery.bundle_hash, license_hash: 'terms-hash',
      });
    });
    await assert.rejects(db.transaction(tx => service.finalizeCandidate(tx, candidate)), /BUYER_NOT_APPROVED/);
    assert.equal((await db.query('SELECT count(*)::text AS count FROM licenses')).rows[0].count, '0');
  } finally { await db.close(); }
});

test('review: buyer approval revocation also prevents retrieval of a previously available delivery', async () => {
  const { db, service } = await fixture();
  try {
    const bundle = { delivery: { bundle_hash: '' }, trace: { scrubbed_content: { text: 'Public research fixture' } } };
    bundle.delivery.bundle_hash = releaseHash(bundle);
    service.privacy = { open: async (_owner: string, ref: Record<string, unknown>) => ref.value } as PrivacyFacade;
    await db.transaction(async tx => {
      const b = await tx.get('buyers', 'demo-buyer'); b.approved = false; await tx.update('buyers', b.id, b);
      await tx.insert('licenses', 'review-license', user.id, { license_id: 'review-license', buyer_id: 'demo-buyer', owner_user_id: user.id,
        retention_expires_at: mandateInput.expires_at, release_artifact_hash: bundle.delivery.bundle_hash });
      await tx.insert('deliveries', 'review-license', 'demo-buyer', { license_id: 'review-license', retrieval_count: 0, status: 'AVAILABLE' });
      await tx.insert('release_artifacts', 'review-license', user.id, { object_ref: { value: bundle } });
    });
    await assert.rejects(service.delivery(buyer, 'review-license'), /BUYER_NOT_APPROVED/);
  } finally { await db.close(); }
});
