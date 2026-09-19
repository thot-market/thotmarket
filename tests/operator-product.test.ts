import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorProduct } from '../apps/api/operator-product.ts';

const offerId = (n: number) => '0x' + n.toString(16).padStart(64, '0');

function fixture(rows: Record<string, any[]> = {}) {
  const tables = new Map(Object.entries(rows));
  return {
    db: { transaction: async (work: any) => work({ list: async (table: string) => tables.get(table) ?? [] }) },
    service: { now: () => '2026-09-16T12:00:00.000Z' },
    thot: { capabilities: () => ({ mode: 'unconfigured' }) },
  } as any;
}

test('operator product report joins bounded local THOT records to one coherent chain workspace', async () => {
  const app = fixture({
    thot_records: [
      { kind: 'listing', active: true, wallet: '0x1111111111111111111111111111111111111111', release_ref: { private: 'do-not-report' } }, { kind: 'listing', active: false },
      ...Array.from({ length: 52 }, (_, n) => ({ kind: 'intent', offer_id: offerId(n) })),
      { kind: 'intent', offer_id: 'not-an-offer-id' },
    ],
    licenses: [{ license_id: 'legacy-license' }],
    deliveries: [{ license_id: 'legacy-license', status: 'DELIVERED' }],
    traces: [
      { trace_id: 'ready', deleted: false, retention_expires_at: '2999-01-01T00:00:00.000Z', projection: { status: 'READY' } },
      { trace_id: 'pending', deleted: false, retention_expires_at: '2999-01-01T00:00:00.000Z', projection: { status: 'PENDING' } },
    ],
    trace_objects: [{ kind: 'release_deletion' }],
  });
  let requested: string[] = [];
  const offers = [
    { status: 3, seller_amount: '11', buyer_total: '13' },
    { status: 4, seller_amount: '17', buyer_total: '19' },
    { status: 5, seller_amount: '900719925474099312345', buyer_total: '900719925474099312999' },
    { status: 5, seller_amount: '7', buyer_total: '9' },
    { status: 6, seller_amount: '23', buyer_total: '29' },
  ];
  (app.thot as any).chain = {
    async readWorkspace(owner: undefined, ids: string[]) {
      assert.equal(owner, undefined); requested = ids;
      return { offers: [...offers, ...ids.slice(offers.length).map(() => ({ status: 1, seller_amount: '0', buyer_total: '0' }))], block: { number: 912, timestamp: 123456 } };
    },
  };
  (app.thot as any).capabilities = () => ({ mode: 'thot-anvil', test_assets: true });
  const report = await operatorProduct(app);

  assert.equal(report.schema_version, 'thot.operator-product/1');
  assert.deepEqual(requested, Array.from({ length: 50 }, (_, n) => offerId(n + 2)));
  assert.deepEqual(report.listings, { recorded: 2, active: 1, inactive: 1 });
  assert.deepEqual(report.orders.chain_window, { cap: 50, selected: 50, excluded_older: 2, invalid_offer_ids: 1, truncated: true });
  assert.deepEqual(report.orders.state, { offered: 45, accepted: 0, delivered: 1, disputed: 1, finalized: 2, refunded: 1, missing: 0 });
  assert.equal(report.chain.asset_classification, 'test_assets'); assert.equal(report.chain.observation.block_number, 912);
  assert.equal(report.deliveries.thot_delivered_current, 1); assert.equal(report.deliveries.legacy_delivered, 1);
  assert.equal(report.settlements.seller_payout_atoms, '900719925474099312352');
  assert.equal(report.settlements.buyer_payment_atoms, '900719925474099313008');
  assert.deepEqual(report.legacy_licenses, { recorded: 1, note: 'Legacy licenses are not THOT chain settlement evidence.' });
  assert.deepEqual(report.traces, { retained: 2, readable: 1, retained_not_readable: 1, storage_object_records: 1 });
  assert.ok(!JSON.stringify(report).includes(offerId(2)));
  assert.ok(!JSON.stringify(report).includes('0x1111111111111111111111111111111111111111'));
  assert.ok(!JSON.stringify(report).includes('do-not-report'));
});

test('operator product never represents unavailable chain settlement as zero', async () => {
  const app = fixture({ thot_records: [{ kind: 'intent', offer_id: offerId(1) }] });
  const report = await operatorProduct(app);
  assert.equal(report.chain.observation.status, 'unavailable');
  assert.equal(report.chain.observation.reason, 'THOT_CHAIN_NOT_CONFIGURED');
  assert.deepEqual(report.orders.state, { offered: null, accepted: null, delivered: null, disputed: null, finalized: null, refunded: null, missing: null });
  assert.equal(report.deliveries.thot_delivered_current, null);
  assert.equal(report.settlements.seller_payout_atoms, null);
  assert.equal(report.settlements.buyer_payment_atoms, null);
});
