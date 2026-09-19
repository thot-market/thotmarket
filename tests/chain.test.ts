import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettlementPlan, MockChainAdapter, createChainAdapter, validateProductionConfig } from '../packages/chain/index.ts';

const makePlan = (grossMinor = 10_000n, settlementId = 'sale-1', licenseId = 'license-1') => createSettlementPlan({
  settlementId, licenseId, mandateId: 'mandate-1', buyerId: 'buyer-1', userId: 'user-1', grossMinor,
});
function funded() { const chain = new MockChainAdapter(); chain.deposit('mandate-1', 'buyer-1', 20_000n); return chain; }
function settled() { const chain = funded(); chain.submitSettlement('operator', makePlan()); chain.mineBlock(3); chain.finalizeSettlement('sale-1'); return chain; }
const quote = (chain: MockChainAdapter, actualThotAtoms = 1000n) => ({
  expectedThotAtoms: 1000n, actualThotAtoms, maxSlippageBps: 100, expiresAtBlock: chain.blockNumber + 10,
});

test('split preserves eligible net and source 65 contributor / 20 burn / 15 operator with operator remainder', () => {
  for (let n = 1n; n < 5000n; n++) {
    const plan = makePlan(n);
    assert.equal(plan.contributorMinor, n * 65n / 100n);
    assert.equal(plan.burnMinor, n * 20n / 100n);
    assert.equal(plan.contributorMinor + plan.burnMinor + plan.operatorMinor, n);
  }
  const maximum = makePlan((1n << 256n) - 1n);
  assert.equal(maximum.contributorMinor + maximum.burnMinor + maximum.operatorMinor, maximum.grossMinor);
});
test('permitted direct costs reduce net; negative, overhead, excess, and unsafe amounts are rejected', () => {
  const input = { settlementId: 's', licenseId: 'l', mandateId: 'm', buyerId: 'b', userId: 'u', grossMinor: 101n };
  const plan = createSettlementPlan({ ...input, directCosts: [{ code: 'delivery', amountMinor: 1n }], allowedCostCodes: ['delivery'] });
  assert.deepEqual([plan.eligibleNetMinor, plan.contributorMinor, plan.burnMinor, plan.operatorMinor], [100n, 65n, 20n, 15n]);
  assert.throws(() => createSettlementPlan({ ...input, directCosts: [{ code: 'overhead', amountMinor: 1n }] }), /Unapproved/);
  assert.throws(() => createSettlementPlan({ ...input, directCosts: [{ code: 'delivery', amountMinor: -1n }], allowedCostCodes: ['delivery'] }), /Invalid/);
  assert.throws(() => createSettlementPlan({ ...input, directCosts: [{ code: 'delivery', amountMinor: 102n }], allowedCostCodes: ['delivery'] }), /exceed/);
  assert.throws(() => makePlan(0n), /Invalid/);
  assert.throws(() => makePlan(1n << 256n), /uint256/);
});
test('escrow binds buyers, isolates refunds, and retains refund availability while paused', () => {
  const chain = funded();
  assert.throws(() => chain.deposit('mandate-1', 'attacker', 5n), /another buyer/);
  assert.throws(() => chain.refund('mandate-1', 'attacker', 5n), /Unauthorized/);
  assert.throws(() => chain.setPaused('attacker', true), /Unauthorized/);
  chain.setPaused('operator', true);
  assert.throws(() => chain.deposit('mandate-1', 'buyer-1', 5n), /Paused/);
  assert.equal(chain.refund('mandate-1', 'buyer-1', 5000n), 5000n);
  assert.equal(chain.mandate('mandate-1').availableMinor, 15_000n);
});
test('unauthorized release, overspend, altered allocation and license replay fail before balance changes', () => {
  const chain = funded();
  assert.throws(() => chain.submitSettlement('attacker', makePlan()), /Unauthorized/);
  assert.throws(() => chain.submitSettlement('operator', makePlan(30_000n)), /Insufficient/);
  assert.throws(() => chain.submitSettlement('operator', { ...makePlan(), contributorMinor: 1n }), /Invalid settlement/);
  const first = chain.submitSettlement('operator', makePlan());
  assert.equal(chain.submitSettlement('operator', makePlan()).transaction.hash, first.transaction.hash);
  assert.equal(chain.submitSettlement('operator', Object.fromEntries(Object.entries(makePlan()).reverse()) as ReturnType<typeof makePlan>).transaction.hash, first.transaction.hash);
  assert.throws(() => chain.submitSettlement('operator', makePlan(9_999n)), /idempotency conflict/);
  assert.throws(() => chain.submitSettlement('operator', makePlan(1n, 'different-sale')), /License already/);
  assert.equal(chain.mandate('mandate-1').lockedMinor, 10_000n);
  assert.throws(() => chain.refund('mandate-1', 'buyer-1', 10_001n), /Insufficient/);
});
test('finality and prefinal reorg require canonical remine before allocating money', () => {
  const chain = funded(); chain.submitSettlement('operator', makePlan());
  assert.throws(() => chain.finalizeSettlement('sale-1'), /canonical/);
  chain.mineBlock(2); assert.throws(() => chain.finalizeSettlement('sale-1'), /Finality/);
  chain.simulateReorg(2); assert.throws(() => chain.finalizeSettlement('sale-1'), /canonical/);
  chain.mineBlock(3); const receipt = chain.finalizeSettlement('sale-1');
  assert.equal(receipt.contributorAvailableMinor, 6500n); assert.equal(receipt.burnAvailableMinor, 2000n);
  assert.deepEqual(chain.finalizeSettlement('sale-1'), receipt);
  assert.equal(chain.mandate('mandate-1').lockedMinor, 0n);
});
test('deep finalized reorg halts money movement instead of silently undoing finalized funds', () => {
  const chain = settled();
  assert.throws(() => chain.simulateReorg(3), /Finalized reorg/); assert.equal(chain.halted, true);
  assert.throws(() => chain.refund('mandate-1', 'buyer-1', 1n), /halted/);
  assert.throws(() => chain.finalizeSettlement('sale-1'), /halted/);
  assert.equal(chain.settlement('sale-1').contributorAvailableMinor, 6500n);
});
test('contributor purchase failure creates no tokens and returns allocation only once on cancellation', () => {
  const chain = settled();
  chain.queueOrder('operator', { orderId: 'payout', settlementId: 'sale-1', kind: 'contributor', amountMinor: 6500n });
  assert.throws(() => chain.spendInference('operator', 'sale-1', 1n), /Insufficient/);
  assert.equal(chain.submitPurchase('operator', 'payout', quote(chain), true).state, 'DEFERRED');
  assert.equal(chain.order('payout').thotAtoms, 0n); assert.equal(chain.userThotAtoms('user-1'), 0n);
  chain.cancelDeferredOrder('operator', 'payout'); chain.cancelDeferredOrder('operator', 'payout');
  assert.equal(chain.settlement('sale-1').contributorAvailableMinor, 6500n);
  assert.equal(chain.settlement('sale-1').burnAvailableMinor, 2000n);
  chain.spendInference('operator', 'sale-1', 6500n);
  assert.throws(() => chain.queueOrder('operator', { orderId: 'payout-2', settlementId: 'sale-1', kind: 'contributor', amountMinor: 1n }), /Insufficient/);
});
test('contributor tokens stay circulating and withdrawal cannot also become credits or burn', () => {
  const chain = settled();
  chain.queueOrder('operator', { orderId: 'payout', settlementId: 'sale-1', kind: 'contributor', amountMinor: 6500n });
  chain.submitPurchase('operator', 'payout', quote(chain, 995n)); chain.mineBlock(3); chain.finalizePurchase('payout');
  assert.throws(() => chain.cancelDeferredOrder('operator', 'payout'), /cannot return/);
  assert.equal(chain.submitDisposition('operator', 'payout', true).state, 'TOKENS_ACQUIRED');
  chain.submitDisposition('operator', 'payout'); chain.mineBlock(2);
  assert.throws(() => chain.finalizeDisposition('payout'), /Finality/); assert.equal(chain.userThotAtoms('user-1'), 0n);
  chain.mineBlock(); chain.finalizeDisposition('payout'); chain.finalizeDisposition('payout');
  assert.equal(chain.userThotAtoms('user-1'), 995n); assert.equal(chain.burnedThotAtoms, 0n);
  assert.equal(chain.settlement('sale-1').burnAvailableMinor, 2000n);
});
test('slippage and liquidity defer burn; retry, purchase, burn, and finality remain distinct', () => {
  const chain = settled();
  chain.queueOrder('operator', { orderId: 'burn', settlementId: 'sale-1', kind: 'burn', amountMinor: 2000n });
  assert.equal(chain.submitPurchase('operator', 'burn', quote(chain, 989n)).state, 'DEFERRED');
  assert.equal(chain.burnedThotAtoms, 0n); assert.equal(chain.order('burn').thotAtoms, 0n);
  assert.throws(() => chain.cancelDeferredOrder('operator', 'burn'), /cannot return/);
  chain.submitPurchase('operator', 'burn', quote(chain, 990n)); chain.mineBlock(3); chain.finalizePurchase('burn');
  assert.equal(chain.order('burn').thotAtoms, 990n); assert.equal(chain.burnedThotAtoms, 0n);
  chain.submitDisposition('operator', 'burn'); chain.mineBlock(1); chain.simulateReorg(1);
  assert.throws(() => chain.finalizeDisposition('burn'), /canonical/);
  chain.mineBlock(3); chain.finalizeDisposition('burn'); chain.finalizeDisposition('burn');
  assert.equal(chain.burnedThotAtoms, 990n); assert.equal(chain.settlement('sale-1').contributorAvailableMinor, 6500n);
});
test('quotes expire and order identifiers cannot change allocations', () => {
  const chain = settled(); const input = { orderId: 'burn', settlementId: 'sale-1', kind: 'burn' as const, amountMinor: 2000n };
  chain.queueOrder('operator', input); assert.equal(chain.queueOrder('operator', input).amountMinor, 2000n);
  assert.throws(() => chain.queueOrder('operator', { ...input, amountMinor: 1n }), /conflict/);
  assert.throws(() => chain.submitPurchase('operator', 'burn', { ...quote(chain), expiresAtBlock: chain.blockNumber }), /expired/);
  assert.throws(() => chain.submitPurchase('operator', 'burn', { ...quote(chain), maxSlippageBps: 1001 }), /slippage/);
});
test('chain event replay deduplicates chain/transaction/log identity and removes prefinal orphan observations', () => {
  const chain = new MockChainAdapter(); chain.mineBlock();
  const event = { chainId: 46630, transactionHash: 'tx', logIndex: 0, blockHash: chain.canonicalBlockHash(1), blockNumber: 1, kind: 'fund', reference: 'm' };
  assert.equal(chain.ingestEvent(event), true); assert.equal(chain.ingestEvent(event), false);
  assert.throws(() => chain.ingestEvent({ ...event, reference: 'changed' }), /conflict/);
  assert.equal(chain.ingestEvent({ ...event, logIndex: 1 }), true);
  chain.simulateReorg(1); chain.mineBlock(); assert.throws(() => chain.ingestEvent(event), /Noncanonical/);
  assert.equal(chain.ingestEvent({ ...event, blockHash: chain.canonicalBlockHash(1) }), true);
});
test('snapshots cannot mutate internal balances, transactions, or order states', () => {
  const chain = settled(); const value = chain.settlement('sale-1'); value.contributorAvailableMinor = 999_999n;
  value.transaction.finalized = false;
  assert.equal(chain.settlement('sale-1').contributorAvailableMinor, 6500n);
  assert.equal(chain.settlement('sale-1').transaction.finalized, true);
});
test('production fails closed without chain addresses, router, finality, or reviewed adapter', () => {
  assert.throws(() => createChainAdapter({ mode: 'production' }), /chain ID/);
  const address = '0x' + '1'.repeat(40);
  const config = { mode: 'production' as const, chainId: 46630, rpcUrl: 'https://rpc.invalid', confirmations: 10,
    addresses: { thotToken: address, paymentToken: address, mandateEscrow: address, settlementRegistry: address, burnExecutor: address },
    router: { address, maxSlippageBps: 100 } };
  assert.doesNotThrow(() => validateProductionConfig(config));
  assert.throws(() => createChainAdapter(config), /Production chain execution disabled/);
  assert.throws(() => validateProductionConfig({ ...config, confirmations: 0 }), /finality/);
  assert.throws(() => validateProductionConfig({ ...config, router: undefined }), /router/);
});

test('snapshot restores bigint amounts, shared transaction identity, pending orders, and idempotency across restart', () => {
  let chain = funded(); chain.submitSettlement('operator', makePlan()); chain.mineBlock(2);
  chain = MockChainAdapter.fromSnapshot(chain.snapshot());
  assert.equal(chain.confirmations, 3); assert.equal(chain.operatorId, 'operator');
  assert.throws(() => chain.finalizeSettlement('sale-1'), /Finality/);
  chain.mineBlock(); chain.finalizeSettlement('sale-1');
  chain.queueOrder('operator', { orderId: 'burn', settlementId: 'sale-1', kind: 'burn', amountMinor: 2000n });
  chain.submitPurchase('operator', 'burn', quote(chain)); chain.mineBlock();
  chain = MockChainAdapter.fromSnapshot(chain.snapshot()); chain.simulateReorg(1); chain.mineBlock(3);
  chain.finalizePurchase('burn'); chain.submitDisposition('operator', 'burn'); chain.mineBlock(3);
  chain = MockChainAdapter.fromSnapshot(chain.snapshot()); chain.finalizeDisposition('burn');
  chain = MockChainAdapter.fromSnapshot(chain.snapshot()); chain.finalizeDisposition('burn');
  assert.equal(chain.burnedThotAtoms, 1000n);
  assert.equal(chain.settlement('sale-1').contributorAvailableMinor, 6500n);
  assert.throws(() => chain.simulateReorg(3), /Finalized reorg/);
  assert.equal(MockChainAdapter.fromSnapshot(chain.snapshot()).halted, true);
});
