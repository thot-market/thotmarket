import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../packages/storage/src/index.ts';
import { ThotService, type PrivacyFacade } from '../packages/market/src/service.ts';
import { accountBalance, postJournal, reconcile } from '../packages/ledger/src/index.ts';
import { MockChainAdapter } from '../packages/chain/index.ts';
import { completeDevelopmentAllocations, DEVELOPMENT_ATOMS_PER_MINOR, DEVELOPMENT_CHAIN_STATE_ID } from '../packages/market/src/chain-worker.ts';

const wallet = '0x' + '1'.repeat(40);
async function seed(options: { disposition?: 'token' | 'inference_credit' | 'pending'; gross?: bigint; dataDir?: string } = {}) {
  const db = await Database.open({ dataDir: options.dataDir });
  const service = new ThotService(db, {} as PrivacyFacade, { development: true, tokenEnabled: true, standingAuthorization: false,
    exclusivity: false, approvedLicenseTemplates: {}, approvedCostCodes: [], maxDirectCostsMinor: '0' });
  await service.seedDevelopment(); const gross = options.gross ?? 10_000n;
  await db.transaction(async tx => {
    const mandate = await tx.insert('mandates', 'mandate-1', 'demo-buyer', { mandate_id: 'mandate-1', buyer_id: 'demo-buyer',
      economics: { currency: 'USD', total_budget_minor: gross.toString(), unit_price_minor: gross.toString() },
      funding: { funded_minor: '0' }, spent_minor: gross.toString(), status: 'draft' });
    await service.recordFunding(tx, mandate, 'development-funding-1', gross);
    await tx.insert('sale_authorizations', 'authorization-1', 'demo-user', { expected_direct_costs_max_minor: '0',
      payout_preference: options.disposition === 'inference_credit' ? 'inference_credit' : 'token' });
    await tx.insert('licenses', 'license-1', 'demo-user', { license_id: 'license-1', owner_user_id: 'demo-user',
      buyer_id: 'demo-buyer', mandate_id: 'mandate-1', authorization_id: 'authorization-1', currency: 'USD', price_minor: gross.toString() });
    await service.settleLicense(tx, 'license-1');
  });
  const e = (await service.earnings({ id: 'demo-user', role: 'user' })).entitlements[0];
  if (options.disposition === undefined || options.disposition === 'token') await service.choose({ id: 'demo-user', role: 'user' },
    'choose-development-token', e.entitlement_id, { disposition: 'token', wallet_address: wallet });
  return { db, service, entitlementId: e.entitlement_id as string, settlementId: e.settlement_id as string };
}

test('development worker executes separate contributor payout and burn with exact fiat and THOT journals', async () => {
  const f = await seed();
  try {
    const result = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    assert.equal(result.simulated, true); assert.equal(result.token_payouts_completed, 1); assert.equal(result.burns_completed, 1);
    assert.equal(result.burned_thot_atoms, (2000n * DEVELOPMENT_ATOMS_PER_MINOR).toString());
    await f.db.transaction(async tx => {
      assert.equal(await accountBalance(tx, 'USD', 'network', 'ASSET:cash'), 1500n);
      assert.equal(await accountBalance(tx, 'USD', f.entitlementId, 'LIABILITY:contributor_token_pending'), 0n);
      assert.equal(await accountBalance(tx, 'USD', f.settlementId, 'LIABILITY:burn_pending'), 0n);
      const entitlement = await tx.get('contributor_entitlements', f.entitlementId);
      const burn = await tx.get('burn_allocations', f.settlementId);
      assert.equal(entitlement.status, 'TOKEN_WITHDRAWN'); assert.equal(entitlement.available_minor, '0');
      assert.equal(burn.status, 'BURN_FINAL'); assert.equal(entitlement.simulated, true); assert.equal(burn.simulated, true);
      const chain = MockChainAdapter.fromSnapshot((await tx.get('chain_event_cursor', DEVELOPMENT_CHAIN_STATE_ID)).snapshot);
      assert.equal(chain.userThotAtoms('demo-user'), 6500n * DEVELOPMENT_ATOMS_PER_MINOR);
      assert.equal(chain.burnedThotAtoms, 2000n * DEVELOPMENT_ATOMS_PER_MINOR);
      assert.equal((await tx.list('token_transfers')).length, 1);
      assert.equal((await tx.list('market_purchase_orders')).length, 2);
      const transactions = await tx.list('chain_transactions');
      assert.equal(transactions.length, 5); assert.ok(transactions.every(t => t.simulated === true && t.status === 'FINALIZED'));
      for (const order of await tx.list('market_purchase_orders')) {
        const inventory = order.kind === 'burn' ? 'ASSET:token_inventory_for_burn' : 'ASSET:token_inventory_for_user';
        assert.equal(await accountBalance(tx, 'USD', order.order_id, inventory), 0n);
        assert.equal(await accountBalance(tx, 'THOT', order.order_id, inventory), 0n);
      }
      assert.equal((await reconcile(tx)).balanced, true);
    });
  } finally { await f.db.close(); }
});

test('development burn preserves inference entitlement and never queues contributor tokens implicitly', async () => {
  const f = await seed({ disposition: 'inference_credit' });
  try {
    const result = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    assert.equal(result.token_payouts_completed, 0); assert.equal(result.burns_completed, 1);
    await f.db.transaction(async tx => {
      const e = await tx.get('contributor_entitlements', f.entitlementId);
      assert.equal(e.disposition, 'inference_credit'); assert.equal(e.status, 'AVAILABLE'); assert.equal(e.available_minor, '6500');
      assert.equal(await accountBalance(tx, 'USD', f.entitlementId, 'LIABILITY:contributor_inference_credit'), -6500n);
      assert.equal(await accountBalance(tx, 'USD', 'network', 'ASSET:cash'), 8000n);
      assert.equal((await tx.list('token_transfers')).length, 0);
    });
    const reservation = await f.service.reserveInference({ id: 'demo-user', role: 'user' }, 'reserve-after-burn', f.entitlementId, { amount_minor: '6500' });
    assert.equal(reservation.status, 'RESERVED');
  } finally { await f.db.close(); }
});

test('burn can finalize before later explicit contributor token choice without repeating either allocation', async () => {
  const f = await seed({ disposition: 'pending' });
  try {
    const first = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    assert.equal(first.token_payouts_completed, 0); assert.equal(first.burns_completed, 1);
    await f.service.choose({ id: 'demo-user', role: 'user' }, 'later-explicit-token-choice', f.entitlementId,
      { disposition: 'token', wallet_address: wallet });
    const second = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    assert.equal(second.token_payouts_completed, 1); assert.equal(second.burns_completed, 0);
    assert.equal(second.burned_thot_atoms, first.burned_thot_atoms);
    assert.equal(await f.db.transaction(tx => accountBalance(tx, 'USD', 'network', 'ASSET:cash')), 1500n);
  } finally { await f.db.close(); }
});

test('replayed development execution leaves journals, transfers, snapshot, and reconciliation unchanged', async () => {
  const f = await seed();
  try {
    const first = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    const before = await f.db.transaction(async tx => ({ count: (await reconcile(tx)).journal_count,
      snapshot: (await tx.get('chain_event_cursor', DEVELOPMENT_CHAIN_STATE_ID)).snapshot }));
    const replay = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'different-settlement-service'));
    assert.equal(replay.token_payouts_completed, 0); assert.equal(replay.burns_completed, 0);
    assert.equal(replay.reconciliation_commitment, first.reconciliation_commitment);
    await f.db.transaction(async tx => {
      assert.equal((await reconcile(tx)).journal_count, before.count);
      assert.equal((await tx.get('chain_event_cursor', DEVELOPMENT_CHAIN_STATE_ID)).snapshot, before.snapshot);
      assert.equal((await tx.list('token_transfers')).length, 1);
    });
  } finally { await f.db.close(); }
});

test('crash before commit rolls back the complete simulated chain and journal effects, then retries once', async () => {
  const f = await seed();
  try {
    await assert.rejects(f.db.transaction(async tx => { await completeDevelopmentAllocations(tx, 'service-settlement'); throw new Error('simulated process crash'); }), /simulated process crash/);
    await f.db.transaction(async tx => {
      assert.equal(await accountBalance(tx, 'USD', 'network', 'ASSET:cash'), 10_000n);
      assert.equal(await tx.maybe('chain_event_cursor', DEVELOPMENT_CHAIN_STATE_ID), undefined);
      assert.equal((await tx.list('market_purchase_orders')).length, 0);
      assert.equal((await tx.get('contributor_entitlements', f.entitlementId)).status, 'TOKEN_PURCHASE_PENDING');
      assert.equal((await tx.get('burn_allocations', f.settlementId)).status, 'CREATED');
    });
    const retried = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    assert.equal(retried.token_payouts_completed, 1); assert.equal(retried.burns_completed, 1);
  } finally { await f.db.close(); }
});

test('durable SQL snapshot prevents duplicate token execution after database restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-chain-worker-'));
  let db: Database | undefined;
  try {
    const f = await seed({ dataDir: join(directory, 'database') }); db = f.db;
    const first = await db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement')); await db.close(); db = undefined;
    db = await Database.open({ dataDir: join(directory, 'database') });
    const replay = await db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    assert.equal(replay.token_payouts_completed, 0); assert.equal(replay.burns_completed, 0);
    assert.equal(replay.burned_thot_atoms, first.burned_thot_atoms);
    assert.equal(replay.reconciliation_commitment, first.reconciliation_commitment);
  } finally { if (db) await db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('non-simulated funding cannot enter the development chain execution path', async () => {
  const f = await seed();
  try {
    // Funding rows are append-only: add a distinct explicitly real funding reference to model a mixed mandate.
    await f.db.transaction(tx => tx.insert('mandate_funding', 'real-funding-marker', 'demo-buyer', {
      mandate_id: 'mandate-1', funding_reference: 'independent-real-source', amount_minor: '1', simulated: false,
    }));
    await assert.rejects(f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement')), /DEVELOPMENT_FUNDING_REQUIRED/);
    assert.equal(await f.db.transaction(tx => accountBalance(tx, 'USD', 'network', 'ASSET:cash')), 10_000n);
  } finally { await f.db.close(); }
});

test('worker fails closed for changed allocation, spent entitlement, invalid wallet, or missing cash', async () => {
  const f = await seed();
  try {
    const original = await f.db.transaction(tx => tx.get('contributor_entitlements', f.entitlementId));
    for (const changed of [{ amount_minor: '1' }, { available_minor: '1' }, { wallet_address: '0x' + '0'.repeat(40) }]) {
      await f.db.transaction(tx => tx.update('contributor_entitlements', f.entitlementId, { ...original, ...changed }));
      await assert.rejects(f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement')));
    }
    await f.db.transaction(async tx => {
      await tx.update('contributor_entitlements', f.entitlementId, original);
      await postJournal(tx, 'development-cash-shortage', 'USD', [
        { account: 'ASSET:cash', owner: 'network', amount: -10_000n }, { account: 'EXPENSE:test_cash_shortage', owner: 'network', amount: 10_000n },
      ]);
    });
    await assert.rejects(f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement')), /INSUFFICIENT_CASH/);
    assert.equal((await f.db.transaction(tx => tx.list('market_purchase_orders'))).length, 0);
  } finally { await f.db.close(); }
});

test('rounding a tiny sale to zero allocations creates no token purchase or fake burn', async () => {
  const f = await seed({ gross: 1n });
  try {
    const result = await f.db.transaction(tx => completeDevelopmentAllocations(tx, 'service-settlement'));
    assert.equal(result.token_payouts_completed, 0); assert.equal(result.burns_completed, 0);
    assert.equal(result.zero_allocations_closed, 2); assert.equal(result.burned_thot_atoms, '0');
    assert.equal((await f.db.transaction(tx => tx.list('market_purchase_orders'))).length, 0);
    assert.equal(await f.db.transaction(tx => accountBalance(tx, 'USD', 'network', 'ASSET:cash')), 1n);
  } finally { await f.db.close(); }
});
