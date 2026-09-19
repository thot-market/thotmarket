import { createSettlementPlan, MockChainAdapter, type TokenOrder } from '../../chain/index.ts';
import { canonicalHash, parseMoney } from '../../protocol/src/index.ts';
import { accountBalance, postJournal, reconcile, type Currency } from '../../ledger/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';

export const DEVELOPMENT_CHAIN_STATE_ID = 'thot-development-chain-v1';
export const DEVELOPMENT_RATE_ID = 'thot.mock-rate/1:1000000000000-atoms-per-payment-minor';
export const DEVELOPMENT_ATOMS_PER_MINOR = 1_000_000_000_000n;
const operator = 'thot-development-settlement';
const supportedCurrencies = new Set(['USD', 'USDC']);

/**
 * Local-only execution. Caller must enforce authenticated development mode and wrap this
 * in its database transaction. Funding simulation markers are checked again here. All
 * chain state, journals, orders, and projection changes commit or roll back together.
 */
export async function completeDevelopmentAllocations(tx: Transaction, actorId: string) {
  ensure(typeof actorId === 'string' && actorId.length > 0, 'ACTOR_REQUIRED');
  const saved = await tx.maybe('chain_event_cursor', DEVELOPMENT_CHAIN_STATE_ID);
  if (saved) ensure(saved.simulated === true && saved.rate_id === DEVELOPMENT_RATE_ID, 'DEVELOPMENT_CHAIN_STATE_MISMATCH');
  const chain = saved ? MockChainAdapter.fromSnapshot(saved.snapshot) : new MockChainAdapter({ confirmations: 3, operatorId: operator });
  ensure(chain.operatorId === operator && !chain.halted, 'DEVELOPMENT_CHAIN_RECONCILIATION_REQUIRED');
  const funding = await tx.list('mandate_funding');
  let tokenPayouts = 0, burns = 0, zeroAllocations = 0;

  async function recordTransaction(id: string, owner: string, kind: string, reference: string, transaction: NonNullable<TokenOrder['transaction']>) {
    ensure(transaction.finalized === true && transaction.blockNumber !== undefined && transaction.blockHash, 'CHAIN_FINALITY_REQUIRED');
    const document = { kind, reference, transaction_hash: transaction.hash, block_number: transaction.blockNumber,
      block_hash: transaction.blockHash, confirmations: chain.confirmations, status: 'FINALIZED', simulated: true };
    const old = await tx.maybe('chain_transactions', id);
    if (old) ensure(old.transaction_hash === document.transaction_hash && old.reference === reference && old.kind === kind, 'CHAIN_TRANSACTION_REPLAY_CONFLICT');
    else await tx.insert('chain_transactions', id, owner, document);
  }

  async function ensureSettlement(settlementId: string) {
    const settlement = await tx.get('sale_settlements', settlementId);
    const license = await tx.get('licenses', settlement.license_id, settlement.owner_id);
    const mandate = await tx.get('mandates', license.mandate_id, license.buyer_id);
    ensure(supportedCurrencies.has(license.currency), 'UNSUPPORTED_PAYMENT_CURRENCY');
    const relatedFunding = funding.filter(entry => entry.mandate_id === license.mandate_id);
    ensure(relatedFunding.length > 0 && relatedFunding.every(entry => entry.simulated === true), 'DEVELOPMENT_FUNDING_REQUIRED');
    ensure(relatedFunding.reduce((sum, entry) => sum + parseMoney(entry.amount_minor), 0n) >= parseMoney(mandate.spent_minor), 'DEVELOPMENT_FUNDING_MISMATCH');
    const directCosts = parseMoney(settlement.direct_costs_minor);
    const plan = createSettlementPlan({ settlementId, licenseId: license.license_id, mandateId: license.mandate_id,
      buyerId: license.buyer_id, userId: settlement.owner_id, grossMinor: parseMoney(settlement.gross_minor),
      directCosts: directCosts > 0n ? [{ code: 'already-accounted-direct-cost', amountMinor: directCosts }] : [],
      allowedCostCodes: ['already-accounted-direct-cost'] });
    ensure(plan.contributorMinor === parseMoney(settlement.contributor_minor)
      && plan.burnMinor === parseMoney(settlement.burn_minor)
      && plan.operatorMinor === parseMoney(settlement.operator_minor)
      && plan.eligibleNetMinor === parseMoney(settlement.eligible_net_minor), 'SETTLEMENT_ALLOCATION_MISMATCH');
    const sourceHash = canonicalHash({ settlement_id: settlementId, license_id: license.license_id, mandate_id: license.mandate_id,
      buyer_id: license.buyer_id, user_id: settlement.owner_id, currency: license.currency,
      gross_minor: settlement.gross_minor, direct_costs_minor: settlement.direct_costs_minor,
      contributor_minor: settlement.contributor_minor, burn_minor: settlement.burn_minor, operator_minor: settlement.operator_minor });
    const projectionId = `dev-settlement:${settlementId}`;
    const old = await tx.maybe('chain_transactions', projectionId);
    if (old) {
      ensure(old.source_hash === sourceHash && old.simulated === true, 'SETTLEMENT_CHAIN_REPLAY_CONFLICT');
      const restored = chain.settlement(settlementId);
      ensure(restored.state === 'FINALIZED' && canonicalHash(restored.plan) === canonicalHash(plan), 'SETTLEMENT_CHAIN_STATE_MISMATCH');
    } else {
      // Mirror this already accounted sale into the local mock, not a second SQL deposit.
      chain.deposit(plan.mandateId, plan.buyerId, plan.grossMinor);
      chain.submitSettlement(operator, plan); chain.mineBlock(chain.confirmations);
      const finalized = chain.finalizeSettlement(settlementId);
      await tx.insert('chain_transactions', projectionId, settlement.owner_id, { kind: 'settlement', reference: settlementId,
        source_hash: sourceHash, transaction_hash: finalized.transaction.hash, block_number: finalized.transaction.blockNumber,
        block_hash: finalized.transaction.blockHash, status: 'FINALIZED', confirmations: chain.confirmations, simulated: true });
    }
    return { settlement, license, currency: license.currency as Currency };
  }

  async function execute(input: { kind: 'contributor' | 'burn'; allocation: Document; amount: bigint }) {
    const allocation = input.allocation;
    const { settlement, license, currency } = await ensureSettlement(allocation.settlement_id);
    const isContributor = input.kind === 'contributor';
    const allocationId = isContributor ? allocation.entitlement_id : allocation.settlement_id;
    const orderId = `dev-${input.kind}:${allocationId}`;
    const owner = isContributor ? allocation.owner_id : 'network';
    ensure(allocation.currency === currency && input.amount === parseMoney(isContributor ? settlement.contributor_minor : settlement.burn_minor), 'ALLOCATION_SOURCE_MISMATCH');
    if (isContributor) {
      ensure(allocation.owner_id === settlement.owner_id && allocation.license_id === license.license_id, 'ENTITLEMENT_OWNER_MISMATCH');
      ensure(typeof allocation.wallet_address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(allocation.wallet_address)
        && !/^0x0{40}$/.test(allocation.wallet_address), 'INVALID_WALLET');
      ensure(parseMoney(allocation.available_minor) === input.amount, 'ENTITLEMENT_ALREADY_SPENT');
    } else ensure(allocation.simulated === true, 'DEVELOPMENT_BURN_REQUIRED');

    if (input.amount === 0n) {
      allocation.status = 'NO_ALLOCATION'; allocation.simulated = true;
      if (isContributor) allocation.available_minor = '0';
      await tx.update(isContributor ? 'contributor_entitlements' : 'burn_allocations', allocationId, allocation);
      zeroAllocations++; return;
    }
    const pendingAccount = isContributor ? 'LIABILITY:contributor_token_pending' : 'LIABILITY:burn_pending';
    const pendingOwner = isContributor ? allocationId : allocation.settlement_id;
    ensure(-await accountBalance(tx, currency, pendingOwner, pendingAccount) === input.amount, 'ALLOCATION_LEDGER_MISMATCH');
    ensure(await accountBalance(tx, currency, 'network', 'ASSET:cash') >= input.amount, 'INSUFFICIENT_CASH');
    const atoms = input.amount * DEVELOPMENT_ATOMS_PER_MINOR;
    ensure(atoms < 10n ** 78n, 'DEVELOPMENT_TOKEN_AMOUNT_TOO_LARGE');
    const inventory = isContributor ? 'ASSET:token_inventory_for_user' : 'ASSET:token_inventory_for_burn';
    const tokenLiability = isContributor ? 'LIABILITY:contributor_tokens_acquired' : 'LIABILITY:burn_tokens_pending';
    const existingOrder = await tx.maybe('market_purchase_orders', orderId);
    if (existingOrder) ensure(existingOrder.amount_minor === input.amount.toString() && existingOrder.kind === input.kind
      && existingOrder.settlement_id === allocation.settlement_id && existingOrder.simulated === true, 'ORDER_REPLAY_CONFLICT');
    else await tx.insert('market_purchase_orders', orderId, owner, { order_id: orderId, settlement_id: allocation.settlement_id,
      allocation_id: allocationId, kind: input.kind, currency, amount_minor: input.amount.toString(), status: 'PURCHASE_QUEUED',
      rate_id: DEVELOPMENT_RATE_ID, expected_thot_atoms: atoms.toString(), simulated: true });

    let order = chain.queueOrder(operator, { orderId, settlementId: allocation.settlement_id, kind: input.kind, amountMinor: input.amount });
    if (order.state === 'QUEUED' || order.state === 'DEFERRED') order = chain.submitPurchase(operator, orderId, {
      expectedThotAtoms: atoms, actualThotAtoms: atoms, maxSlippageBps: 0, expiresAtBlock: chain.blockNumber + 100,
    });
    if (order.state === 'PURCHASE_SUBMITTED') { chain.mineBlock(chain.confirmations); order = chain.finalizePurchase(orderId); }
    ensure(order.state === 'TOKENS_ACQUIRED', 'DEVELOPMENT_ORDER_STATE_MISMATCH');
    await recordTransaction(`${orderId}:purchase`, owner, 'token_purchase', orderId, order.transaction!);
    await postJournal(tx, `${orderId}:purchase-cost`, currency, [
      { account: inventory, owner: orderId, amount: input.amount }, { account: 'ASSET:cash', owner: 'network', amount: -input.amount },
    ]);
    await postJournal(tx, `${orderId}:purchase-atoms`, 'THOT', [
      { account: inventory, owner: orderId, amount: atoms }, { account: tokenLiability, owner: orderId, amount: -atoms },
    ]);
    await tx.audit(owner, 'DevelopmentTokensAcquired', { order_id: orderId, settlement_id: allocation.settlement_id, simulated: true });

    order = chain.submitDisposition(operator, orderId); chain.mineBlock(chain.confirmations); order = chain.finalizeDisposition(orderId);
    const finalStatus = isContributor ? 'TOKEN_WITHDRAWN' : 'BURN_FINAL';
    ensure(order.state === finalStatus, 'CHAIN_FINALITY_REQUIRED');
    await recordTransaction(`${orderId}:disposition`, owner, isContributor ? 'user_transfer' : 'burn', orderId, order.transaction!);
    await postJournal(tx, `${orderId}:disposition-cost`, currency, [
      { account: pendingAccount, owner: pendingOwner, amount: input.amount }, { account: inventory, owner: orderId, amount: -input.amount },
    ]);
    await postJournal(tx, `${orderId}:disposition-atoms`, 'THOT', [
      { account: tokenLiability, owner: orderId, amount: atoms }, { account: inventory, owner: orderId, amount: -atoms },
    ]);
    const orderRecord = await tx.get('market_purchase_orders', orderId, owner);
    await tx.update('market_purchase_orders', orderId, { ...orderRecord, status: finalStatus, actual_thot_atoms: atoms.toString(),
      disposition_transaction_hash: order.transaction!.hash, simulated: true });
    if (isContributor) {
      await tx.insert('token_transfers', orderId, owner, { order_id: orderId, entitlement_id: allocationId,
        wallet_address: allocation.wallet_address, thot_atoms: atoms.toString(), transaction_hash: order.transaction!.hash,
        status: 'FINALIZED', simulated: true });
      await tx.update('contributor_entitlements', allocationId, { ...allocation, available_minor: '0', status: finalStatus,
        actual_thot_atoms: atoms.toString(), chain_order_id: orderId, simulated: true });
      tokenPayouts++;
    } else {
      await tx.update('burn_allocations', allocationId, { ...allocation, status: finalStatus, actual_thot_atoms: atoms.toString(),
        chain_order_id: orderId, transaction_hash: order.transaction!.hash, simulated: true });
      burns++;
    }
    await tx.audit(owner, isContributor ? 'DevelopmentTokenPayoutFinalized' : 'DevelopmentBurnFinalized', {
      order_id: orderId, settlement_id: allocation.settlement_id, transaction_hash: order.transaction!.hash, simulated: true,
    });
  }

  // Choosing inference credits never enters the contributor-token execution path.
  for (const entitlement of await tx.list('contributor_entitlements')) {
    if (entitlement.disposition === 'token' && entitlement.status === 'TOKEN_PURCHASE_PENDING') {
      await execute({ kind: 'contributor', allocation: entitlement, amount: parseMoney(entitlement.amount_minor) });
    }
  }
  for (const allocation of await tx.list('burn_allocations', 'network')) {
    if (['CREATED', 'DEFERRED', 'PURCHASE_QUEUED'].includes(allocation.status)) {
      await execute({ kind: 'burn', allocation, amount: parseMoney(allocation.amount_minor) });
    }
  }
  const state = { simulated: true, rate_id: DEVELOPMENT_RATE_ID, snapshot: chain.snapshot(), block_number: chain.blockNumber };
  if (saved) await tx.update('chain_event_cursor', DEVELOPMENT_CHAIN_STATE_ID, state);
  else await tx.insert('chain_event_cursor', DEVELOPMENT_CHAIN_STATE_ID, 'network', state);
  const accounting = await reconcile(tx);
  ensure(accounting.balanced === true, 'RECONCILIATION_FAILED');
  if (tokenPayouts + burns + zeroAllocations > 0) await tx.audit('network', 'DevelopmentChainReconciled', {
    actor_id: actorId, reconciliation_hash: accounting.commitment, token_payouts: tokenPayouts, burns, simulated: true,
  });
  return { simulated: true as const, token_payouts_completed: tokenPayouts, burns_completed: burns,
    zero_allocations_closed: zeroAllocations, burned_thot_atoms: chain.burnedThotAtoms.toString(),
    rate_id: DEVELOPMENT_RATE_ID, reconciliation_commitment: accounting.commitment };
}
