import assert from 'node:assert/strict';
import {test} from 'node:test';
import {estimateThotValuation, type ThotSaleObservation, type ThotValuationListing} from '../packages/market/src/thot-valuations.ts';

const now = '2026-09-15T12:00:00.000Z';
const address = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const atoms = (n: number) => (BigInt(n) * 10n ** 18n).toString();
const listing = (n: number, patch: Partial<ThotValuationListing> = {}): ThotValuationListing => ({id: 'listing:' + n, owner_id: 'seller:' + n, wallet: address(n), workflow: 'coding', provenance: 'P0_OPERATOR', provenance_status: 'IMPORTED_UNVERIFIED', turn_count: 10, eligible: true, ...patch});
const target = listing(99);
const sale = (n: number, price: number, patch: Partial<ThotSaleObservation> = {}): ThotSaleObservation => ({offer_id: 'offer:' + n, listing: listing(n), buyer: address(100 + n), buyer_owner_id: 'buyer:' + n, gross_atoms: atoms(price), finalized_at: '2026-09-14T00:00:00Z', status: 'finalized', confirmed: true, source: 'independent', independence_reviewed: true, ...patch});

test('three distinct comparable sellers yield integer THOT medians and interquartile range, not cash or earnings', async () => {
  const result = await estimateThotValuation(target, [sale(1, 100), sale(2, 200), sale(3, 900)], {now});
  assert.equal(result.status, 'estimated'); assert.equal(result.currency, 'THOT');
  assert.equal(result.independent.median_gross_atoms, atoms(200));
  assert.equal(result.independent.p25_gross_atoms, atoms(150));
  assert.equal(result.independent.p75_gross_atoms, atoms(550));
  assert.equal(result.independent.sample_count, 3); assert.equal(result.independent.distinct_contributors, 3); assert.equal(result.independent.distinct_buyers, 3);
  assert.equal(result.basis, 'gross_licence_price_conditional_on_sale');
  assert.equal(result.window.lookback_days, 90); assert.equal(result.window.to, now);
  assert.match(result.limitations.join(' '), /not a funded offer/);
  assert.doesNotMatch(JSON.stringify(result), /0x[0-9a-f]{40}|seller:1|buyer:1/);
});

test('small cohorts do not disclose prices even after many sales by one contributor', async () => {
  const rows = [sale(1, 100), sale(2, 200), sale(3, 300, {listing: listing(1)})];
  const result = await estimateThotValuation(target, rows, {now});
  assert.equal(result.status, 'insufficient_data'); assert.equal(result.independent.sample_count, 3);
  assert.equal(result.independent.distinct_contributors, 2);
  assert.equal(result.independent.median_gross_atoms, null); assert.equal(result.independent.p25_gross_atoms, null); assert.equal(result.independent.p75_gross_atoms, null);
});

test('treasury purchases remain a separate sponsored estimate and cannot manufacture independent demand', async () => {
  const result = await estimateThotValuation(target, [sale(1, 100), ...[2, 3, 4].map(n => sale(n, 1000, {source: 'treasury', independence_reviewed: false}))], {now});
  assert.equal(result.status, 'insufficient_data'); assert.equal(result.independent.sample_count, 1);
  assert.equal(result.sponsored.status, 'estimated'); assert.equal(result.sponsored.median_gross_atoms, atoms(1000));
});

test('pending, disputed, refunded, unconfirmed and unreviewed sales are excluded', async () => {
  const result = await estimateThotValuation(target, [sale(1, 100), sale(2, 200, {status: 'pending'}), sale(3, 300, {status: 'disputed'}), sale(4, 400, {status: 'refunded'}), sale(5, 500, {confirmed: false}), sale(6, 600, {independence_reviewed: false})], {now});
  assert.equal(result.independent.sample_count, 1); assert.equal(result.status, 'insufficient_data');
});

test('exclude target-owner trades, target buying comparables, self-trades and repeated or conflicting receipt IDs', async () => {
  const first = sale(1, 100);
  const result = await estimateThotValuation(target, [first, {...first, gross_atoms: atoms(9999)}, sale(2, 200, {listing: listing(2, {owner_id: target.owner_id})}), sale(3, 300, {listing: listing(3, {wallet: target.wallet})}), sale(4, 400, {buyer: address(4)}), sale(5, 500, {buyer_owner_id: 'seller:5'}), sale(6, 600, {buyer: target.wallet}), sale(7, 700, {buyer_owner_id: target.owner_id}), sale(8, 800)], {now});
  assert.equal(result.independent.sample_count, 1); assert.equal(result.independent.median_gross_atoms, null);
});

test('matching never mixes import provenance with captured traces, workflows, or turn-count bands', async () => {
  const result = await estimateThotValuation(target, [sale(1, 100), sale(2, 200, {listing: listing(2, {workflow: 'research'})}), sale(3, 300, {listing: listing(3, {turn_count: 20})}), sale(4, 400, {listing: listing(4, {provenance: 'P2_TEE'})}), sale(5, 500, {listing: listing(5, {provenance_status: 'VERIFIED'})}), sale(6, 600, {listing: listing(6, {provenance_status: undefined})})], {now});
  assert.equal(result.independent.sample_count, 1);
  assert.equal(result.cohort?.provenance_status, 'IMPORTED_UNVERIFIED'); assert.equal(result.cohort?.turn_count_band, '5–19');
});

test('window includes its lower bound, rejects future or stale observations, and validates option dates', async () => {
  const start = new Date(Date.parse(now) - 90 * 86400000).toISOString();
  const result = await estimateThotValuation(target, [sale(1, 100, {finalized_at: start}), sale(2, 200, {finalized_at: Date.parse(start) - 1}), sale(3, 300, {finalized_at: Date.parse(now) + 1}), sale(4, 400, {finalized_at: 'bad date'})], {now});
  assert.equal(result.independent.sample_count, 1); assert.equal(result.window.from, start);
  await assert.rejects(estimateThotValuation(target, [], {now: 'bad date'}), /INVALID_THOT_VALUATION_WINDOW/);
  await assert.rejects(estimateThotValuation(target, [], {now, lookbackDays: 0}), /INVALID_THOT_VALUATION_WINDOW/);
});

test('one active contributor cannot dominate the estimate by splitting activity into many purchases', async () => {
  const spam = Array.from({length: 20}, (_, n) => sale(1000 + n, 10000, {listing: listing(3)}));
  const result = await estimateThotValuation(target, [sale(1, 100), sale(2, 200), ...spam], {now});
  assert.equal(result.independent.sample_count, 22); assert.equal(result.independent.distinct_contributors, 3);
  assert.equal(result.independent.median_gross_atoms, atoms(200)); assert.equal(result.independent.weighting, 'equal_weight_per_contributor');
});

test('malformed atoms, zero values, ineligible source listings and missing target metadata fail closed', async () => {
  const bad = ['0', '-1', '1.5', '1e18', '01', (1n << 256n).toString()];
  const result = await estimateThotValuation(target, [...bad.map((value, n) => sale(n + 1, 1, {gross_atoms: value})), sale(10, 100, {listing: listing(10, {eligible: false})})], {now});
  assert.equal(result.independent.sample_count, 0);
  const unavailable = await estimateThotValuation({...target, turn_count: 0}, [sale(1, 100), sale(2, 200), sale(3, 300)], {now});
  assert.equal(unavailable.status, 'ineligible'); assert.equal(unavailable.cohort, null);
});

test('quartile arithmetic keeps precision beyond floating-point integers and floors fractional atoms', async () => {
  const amount = 10n ** 25n;
  const result = await estimateThotValuation(target, [sale(1, 1, {gross_atoms: String(amount + 1n)}), sale(2, 1, {gross_atoms: String(amount + 2n)}), sale(3, 1, {gross_atoms: String(amount + 4n)})], {now});
  assert.equal(result.independent.median_gross_atoms, String(amount + 2n));
  assert.equal(result.independent.p25_gross_atoms, String(amount + 1n));
  assert.equal(result.independent.p75_gross_atoms, String(amount + 3n));
});
