import { createHash } from 'node:crypto';

export const SPLIT_POLICY_ID = 'thot.split/1:65-contributor,20-burn,15-operator';
export type DirectCost = { code: string; amountMinor: bigint };
export type SettlementPlan = {
  settlementId: string; licenseId: string; mandateId: string; buyerId: string; userId: string;
  grossMinor: bigint; directCostsMinor: bigint; eligibleNetMinor: bigint;
  contributorMinor: bigint; burnMinor: bigint; operatorMinor: bigint; splitPolicyId: string;
};

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function amount(value: bigint, name: string, zero = false) {
  requireThat(typeof value === 'bigint' && (zero ? value >= 0n : value > 0n), `Invalid ${name}`);
  requireThat(value <= (1n << 256n) - 1n, `${name} exceeds uint256`);
}
function id(value: string) { requireThat(typeof value === 'string' && value.trim().length > 0, 'Empty identifier'); }
function digest(value: unknown) {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return { $thotBigInt: item.toString() };
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    }
    return item;
  });
  return '0x' + createHash('sha256').update(encoded).digest('hex');
}
function clone<T>(value: T): T { return structuredClone(value); }

/** Exact integer allocation. Only transaction-specific, explicitly permitted costs are deductible. */
export function createSettlementPlan(input: {
  settlementId: string; licenseId: string; mandateId: string; buyerId: string; userId: string;
  grossMinor: bigint; directCosts?: DirectCost[]; allowedCostCodes?: readonly string[];
}): SettlementPlan {
  for (const field of [input.settlementId, input.licenseId, input.mandateId, input.buyerId, input.userId]) id(field);
  amount(input.grossMinor, 'gross');
  let directCostsMinor = 0n;
  for (const cost of input.directCosts ?? []) {
    amount(cost.amountMinor, 'direct cost', true);
    requireThat((input.allowedCostCodes ?? []).includes(cost.code), 'Unapproved direct cost');
    directCostsMinor += cost.amountMinor;
  }
  requireThat(directCostsMinor <= input.grossMinor, 'Costs exceed gross');
  const eligibleNetMinor = input.grossMinor - directCostsMinor;
  const contributorMinor = eligibleNetMinor * 65n / 100n;
  const burnMinor = eligibleNetMinor * 20n / 100n;
  return {
    settlementId: input.settlementId, licenseId: input.licenseId, mandateId: input.mandateId,
    buyerId: input.buyerId, userId: input.userId, grossMinor: input.grossMinor,
    directCostsMinor, eligibleNetMinor, contributorMinor, burnMinor,
    operatorMinor: eligibleNetMinor - contributorMinor - burnMinor, splitPolicyId: SPLIT_POLICY_ID,
  };
}

export type ChainConfig = {
  mode: 'mock' | 'production'; chainId?: number; rpcUrl?: string; confirmations?: number;
  addresses?: { thotToken: string; paymentToken: string; mandateEscrow: string; settlementRegistry: string; burnExecutor: string };
  router?: { address: string; maxSlippageBps: number };
};

export function validateProductionConfig(config: ChainConfig): void {
  requireThat(config.mode === 'production', 'Production mode required');
  requireThat(Number.isSafeInteger(config.chainId) && config.chainId! > 0, 'Configure chain ID');
  requireThat(config.rpcUrl && new URL(config.rpcUrl).protocol === 'https:', 'Configure HTTPS RPC');
  requireThat(Number.isSafeInteger(config.confirmations) && config.confirmations! > 0, 'Configure finality');
  const validAddress = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v);
  requireThat(config.addresses && ['thotToken', 'paymentToken', 'mandateEscrow', 'settlementRegistry', 'burnExecutor']
    .every(k => validAddress(config.addresses![k as keyof NonNullable<ChainConfig['addresses']>])), 'Configure contract addresses');
  requireThat(config.router && validAddress(config.router.address), 'Configure approved liquidity router');
  requireThat(Number.isInteger(config.router.maxSlippageBps) && config.router.maxSlippageBps >= 0
    && config.router.maxSlippageBps <= 1000, 'Configure bounded slippage');
}

type Transaction = { hash: string; submittedAt: number; blockNumber?: number; blockHash?: string; finalized: boolean };
export type SettlementState = { plan: SettlementPlan; state: 'SUBMITTED' | 'FINALIZED'; transaction: Transaction;
  contributorAvailableMinor: bigint; burnAvailableMinor: bigint };
export type ExecutionQuote = { expectedThotAtoms: bigint; actualThotAtoms: bigint; maxSlippageBps: number; expiresAtBlock: number };
export type TokenOrder = {
  orderId: string; settlementId: string; kind: 'contributor' | 'burn'; amountMinor: bigint;
  state: 'QUEUED' | 'PURCHASE_SUBMITTED' | 'TOKENS_ACQUIRED' | 'TRANSFER_SUBMITTED' | 'TOKEN_WITHDRAWN'
    | 'BURN_SUBMITTED' | 'BURN_FINAL' | 'DEFERRED' | 'CANCELLED';
  thotAtoms: bigint; quotedThotAtoms: bigint; attempts: number; transaction?: Transaction; reason?: string;
};
export type ChainEvent = { chainId: number; transactionHash: string; logIndex: number; blockHash: string;
  blockNumber: number; kind: string; reference: string };

/** Deterministic local adapter. No RPC requests, signing, or real monetary effects. */
export class MockChainAdapter {
  readonly mode = 'mock';
  readonly confirmations: number;
  readonly operatorId: string;
  #paused = false;
  #halted = false;
  #sequence = 0;
  #fork = 0;
  #blocks: string[] = [digest('genesis')];
  #mandates = new Map<string, { buyerId: string; availableMinor: bigint; lockedMinor: bigint }>();
  #settlements = new Map<string, SettlementState>();
  #licenses = new Map<string, string>();
  #orders = new Map<string, TokenOrder>();
  #transactions: Transaction[] = [];
  #events = new Map<string, ChainEvent>();
  #userTokens = new Map<string, bigint>();
  #burned = 0n;

  constructor(options: { confirmations?: number; operatorId?: string } = {}) {
    this.confirmations = options.confirmations ?? 3;
    this.operatorId = options.operatorId ?? 'operator';
    requireThat(Number.isSafeInteger(this.confirmations) && this.confirmations > 0, 'Invalid finality');
    id(this.operatorId);
  }
  get blockNumber() { return this.#blocks.length - 1; }
  get halted() { return this.#halted; }
  get burnedThotAtoms() { return this.#burned; }
  /** Persist only in trusted application storage; a snapshot is not an attestation or signed chain fact. */
  snapshot(): string {
    return JSON.stringify({ version: 'thot.mock-chain/1', confirmations: this.confirmations, operatorId: this.operatorId,
      paused: this.#paused, halted: this.#halted, sequence: this.#sequence, fork: this.#fork,
      blocks: this.#blocks, mandates: [...this.#mandates], settlements: [...this.#settlements],
      licenses: [...this.#licenses], orders: [...this.#orders], transactions: this.#transactions,
      events: [...this.#events], userTokens: [...this.#userTokens], burned: this.#burned },
    (_key, value) => typeof value === 'bigint' ? { $thotBigInt: value.toString() } : value);
  }
  static fromSnapshot(snapshot: string): MockChainAdapter {
    const state = JSON.parse(snapshot, (_key, value) => {
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && '$thotBigInt' in value) {
        requireThat(typeof value.$thotBigInt === 'string' && /^\d+$/.test(value.$thotBigInt), 'Invalid snapshot amount');
        return BigInt(value.$thotBigInt);
      }
      return value;
    });
    requireThat(state?.version === 'thot.mock-chain/1', 'Unsupported mock chain snapshot');
    const chain = new MockChainAdapter({ confirmations: state.confirmations, operatorId: state.operatorId });
    requireThat(Array.isArray(state.blocks) && state.blocks[0] === digest('genesis'), 'Invalid snapshot chain');
    requireThat(Number.isSafeInteger(state.sequence) && state.sequence >= 0 && Number.isSafeInteger(state.fork) && state.fork >= 0, 'Invalid snapshot counter');
    chain.#paused = state.paused === true; chain.#halted = state.halted === true;
    chain.#sequence = state.sequence; chain.#fork = state.fork; chain.#blocks = state.blocks;
    chain.#mandates = new Map(state.mandates); chain.#settlements = new Map(state.settlements);
    chain.#licenses = new Map(state.licenses); chain.#orders = new Map(state.orders);
    chain.#transactions = state.transactions; chain.#events = new Map(state.events);
    chain.#userTokens = new Map(state.userTokens); amount(state.burned, 'snapshot burned', true); chain.#burned = state.burned;
    const byHash = new Map(chain.#transactions.map(transaction => [transaction.hash, transaction]));
    requireThat(byHash.size === chain.#transactions.length, 'Duplicate snapshot transaction');
    for (const settlement of chain.#settlements.values()) {
      const transaction = byHash.get(settlement.transaction.hash); requireThat(transaction, 'Missing snapshot transaction');
      settlement.transaction = transaction;
    }
    for (const order of chain.#orders.values()) if (order.transaction) {
      const transaction = byHash.get(order.transaction.hash); requireThat(transaction, 'Missing snapshot transaction');
      order.transaction = transaction;
    }
    return chain;
  }
  userThotAtoms(userId: string) { return this.#userTokens.get(userId) ?? 0n; }
  #active() { requireThat(!this.#halted, 'Chain halted: finalized reorg requires reconciliation'); }
  #operator(caller: string) { this.#active(); requireThat(caller === this.operatorId, 'Unauthorized operator'); }
  setPaused(caller: string, paused: boolean) { this.#operator(caller); this.#paused = paused; }

  deposit(mandateId: string, buyerId: string, value: bigint) {
    this.#active(); requireThat(!this.#paused, 'Paused'); id(mandateId); id(buyerId); amount(value, 'deposit');
    const entry = this.#mandates.get(mandateId) ?? { buyerId, availableMinor: 0n, lockedMinor: 0n };
    requireThat(entry.buyerId === buyerId, 'Mandate belongs to another buyer');
    amount(entry.availableMinor + entry.lockedMinor + value, 'escrow total');
    entry.availableMinor += value; this.#mandates.set(mandateId, entry);
    return clone(entry);
  }
  mandate(mandateId: string) { const entry = this.#mandates.get(mandateId); requireThat(entry, 'Unknown mandate'); return clone(entry); }
  refund(mandateId: string, buyerId: string, value: bigint) {
    this.#active(); amount(value, 'refund'); const entry = this.#mandates.get(mandateId);
    requireThat(entry?.buyerId === buyerId, 'Unauthorized buyer');
    requireThat(entry.availableMinor >= value, 'Insufficient available escrow');
    entry.availableMinor -= value; return value;
  }
  #transaction(): Transaction {
    const transaction = { hash: digest(['mock-transaction', ++this.#sequence]), submittedAt: this.blockNumber, finalized: false };
    this.#transactions.push(transaction); return transaction;
  }
  #confirm(transaction: Transaction) {
    this.#active();
    requireThat(transaction.blockNumber !== undefined && transaction.blockHash === this.#blocks[transaction.blockNumber], 'Transaction not canonical/mined');
    requireThat(this.blockNumber - transaction.blockNumber + 1 >= this.confirmations, 'Finality not reached');
    transaction.finalized = true;
  }
  mineBlock(count = 1) {
    this.#active(); requireThat(Number.isSafeInteger(count) && count > 0 && count <= 100_000, 'Invalid block count');
    for (let n = 0; n < count; n++) {
      this.#blocks.push(digest([this.#blocks.at(-1), this.#fork, this.blockNumber + 1]));
      for (const transaction of this.#transactions) if (transaction.blockNumber === undefined) {
        transaction.blockNumber = this.blockNumber; transaction.blockHash = this.#blocks.at(-1);
      }
    }
    return this.blockNumber;
  }
  simulateReorg(depth: number) {
    this.#active(); requireThat(Number.isSafeInteger(depth) && depth > 0 && depth <= this.blockNumber, 'Invalid reorg depth');
    const newTip = this.blockNumber - depth;
    if (this.#transactions.some(t => t.finalized && t.blockNumber! > newTip)) {
      this.#halted = true; throw new Error('Finalized reorg: halt and reconcile; no automatic reversal');
    }
    this.#blocks.length = newTip + 1; this.#fork++;
    for (const transaction of this.#transactions) if (transaction.blockNumber !== undefined && transaction.blockNumber > newTip) {
      delete transaction.blockNumber; delete transaction.blockHash;
    }
    for (const [key, event] of this.#events) if (event.blockNumber > newTip) this.#events.delete(key);
  }
  submitSettlement(caller: string, plan: SettlementPlan) {
    this.#operator(caller); requireThat(!this.#paused, 'Paused');
    const old = this.#settlements.get(plan.settlementId);
    if (old) { requireThat(digest(old.plan) === digest(plan), 'Settlement idempotency conflict'); return clone(old); }
    const expected = createSettlementPlan({ ...plan, directCosts: plan.directCostsMinor > 0n
      ? [{ code: 'already-approved', amountMinor: plan.directCostsMinor }] : [], allowedCostCodes: ['already-approved'] });
    requireThat(digest(expected) === digest(plan), 'Invalid settlement allocation');
    requireThat(!this.#licenses.has(plan.licenseId), 'License already settled');
    const entry = this.#mandates.get(plan.mandateId);
    requireThat(entry?.buyerId === plan.buyerId, 'Wrong buyer/mandate');
    requireThat(entry.availableMinor >= plan.grossMinor, 'Insufficient available escrow');
    entry.availableMinor -= plan.grossMinor; entry.lockedMinor += plan.grossMinor;
    const settlement: SettlementState = { plan: clone(plan), state: 'SUBMITTED', transaction: this.#transaction(),
      contributorAvailableMinor: 0n, burnAvailableMinor: 0n };
    this.#settlements.set(plan.settlementId, settlement); this.#licenses.set(plan.licenseId, plan.settlementId);
    return clone(settlement);
  }
  settlement(settlementId: string) {
    const settlement = this.#settlements.get(settlementId); requireThat(settlement, 'Unknown settlement'); return clone(settlement);
  }
  finalizeSettlement(settlementId: string) {
    this.#active(); const settlement = this.#settlements.get(settlementId); requireThat(settlement, 'Unknown settlement');
    if (settlement.state === 'FINALIZED') return clone(settlement);
    this.#confirm(settlement.transaction); settlement.state = 'FINALIZED';
    this.#mandates.get(settlement.plan.mandateId)!.lockedMinor -= settlement.plan.grossMinor;
    settlement.contributorAvailableMinor = settlement.plan.contributorMinor;
    settlement.burnAvailableMinor = settlement.plan.burnMinor;
    return clone(settlement);
  }
  queueOrder(caller: string, input: { orderId: string; settlementId: string; kind: 'contributor' | 'burn'; amountMinor: bigint }) {
    this.#operator(caller); requireThat(!this.#paused, 'Paused'); id(input.orderId); amount(input.amountMinor, 'order');
    requireThat(input.kind === 'contributor' || input.kind === 'burn', 'Invalid order kind');
    const old = this.#orders.get(input.orderId);
    if (old) {
      requireThat(old.settlementId === input.settlementId && old.kind === input.kind && old.amountMinor === input.amountMinor, 'Order idempotency conflict');
      return clone(old);
    }
    const settlement = this.#settlements.get(input.settlementId);
    requireThat(settlement?.state === 'FINALIZED', 'Settlement not finalized');
    const key = input.kind === 'contributor' ? 'contributorAvailableMinor' : 'burnAvailableMinor';
    requireThat(settlement[key] >= input.amountMinor, 'Insufficient allocation'); settlement[key] -= input.amountMinor;
    const order: TokenOrder = { ...input, state: 'QUEUED', thotAtoms: 0n, quotedThotAtoms: 0n, attempts: 0 };
    this.#orders.set(input.orderId, order); return clone(order);
  }
  order(orderId: string) { const order = this.#orders.get(orderId); requireThat(order, 'Unknown order'); return clone(order); }
  submitPurchase(caller: string, orderId: string, quote: ExecutionQuote, simulateFailure = false) {
    this.#operator(caller); requireThat(!this.#paused, 'Paused');
    const order = this.#orders.get(orderId); requireThat(order, 'Unknown order');
    requireThat(order.state === 'QUEUED' || order.state === 'DEFERRED', 'Order cannot purchase');
    amount(quote.expectedThotAtoms, 'expected THOT'); amount(quote.actualThotAtoms, 'actual THOT');
    requireThat(Number.isSafeInteger(quote.expiresAtBlock) && quote.expiresAtBlock > this.blockNumber, 'Quote expired');
    requireThat(Number.isInteger(quote.maxSlippageBps) && quote.maxSlippageBps >= 0 && quote.maxSlippageBps <= 1000, 'Invalid slippage bound');
    order.attempts++;
    if (simulateFailure || quote.actualThotAtoms * 10_000n < quote.expectedThotAtoms * BigInt(10_000 - quote.maxSlippageBps)) {
      order.state = 'DEFERRED'; order.reason = simulateFailure ? 'Mock liquidity failure' : 'Slippage limit'; return clone(order);
    }
    order.state = 'PURCHASE_SUBMITTED'; order.quotedThotAtoms = quote.actualThotAtoms;
    order.transaction = this.#transaction(); delete order.reason; return clone(order);
  }
  finalizePurchase(orderId: string) {
    this.#active(); const order = this.#orders.get(orderId); requireThat(order, 'Unknown order');
    if (order.state === 'TOKENS_ACQUIRED') return clone(order);
    requireThat(order.state === 'PURCHASE_SUBMITTED' && order.transaction, 'Purchase not submitted');
    this.#confirm(order.transaction); order.state = 'TOKENS_ACQUIRED'; order.thotAtoms = order.quotedThotAtoms;
    return clone(order);
  }
  cancelDeferredOrder(caller: string, orderId: string) {
    this.#operator(caller); const order = this.#orders.get(orderId); requireThat(order, 'Unknown order');
    if (order.state === 'CANCELLED') return clone(order);
    requireThat(order.kind === 'contributor' && (order.state === 'QUEUED' || order.state === 'DEFERRED'), 'Order cannot return to credits');
    this.#settlements.get(order.settlementId)!.contributorAvailableMinor += order.amountMinor;
    order.state = 'CANCELLED'; return clone(order);
  }
  submitDisposition(caller: string, orderId: string, simulateFailure = false) {
    this.#operator(caller); requireThat(!this.#paused, 'Paused'); const order = this.#orders.get(orderId); requireThat(order, 'Unknown order');
    requireThat(order.state === 'TOKENS_ACQUIRED', 'Tokens not acquired');
    if (simulateFailure) { order.reason = 'Mock transfer/burn failure; inventory retained'; return clone(order); }
    order.state = order.kind === 'burn' ? 'BURN_SUBMITTED' : 'TRANSFER_SUBMITTED';
    order.transaction = this.#transaction(); delete order.reason; return clone(order);
  }
  finalizeDisposition(orderId: string) {
    this.#active(); const order = this.#orders.get(orderId); requireThat(order, 'Unknown order');
    if (order.state === 'BURN_FINAL' || order.state === 'TOKEN_WITHDRAWN') return clone(order);
    requireThat((order.state === 'BURN_SUBMITTED' || order.state === 'TRANSFER_SUBMITTED') && order.transaction, 'Disposition not submitted');
    this.#confirm(order.transaction);
    if (order.kind === 'burn') { this.#burned += order.thotAtoms; order.state = 'BURN_FINAL'; }
    else {
      const userId = this.#settlements.get(order.settlementId)!.plan.userId;
      this.#userTokens.set(userId, (this.#userTokens.get(userId) ?? 0n) + order.thotAtoms); order.state = 'TOKEN_WITHDRAWN';
    }
    return clone(order);
  }
  spendInference(caller: string, settlementId: string, value: bigint) {
    this.#operator(caller); amount(value, 'inference spend'); const settlement = this.#settlements.get(settlementId);
    requireThat(settlement?.state === 'FINALIZED' && settlement.contributorAvailableMinor >= value, 'Insufficient contributor credit');
    settlement.contributorAvailableMinor -= value; return value;
  }
  ingestEvent(event: ChainEvent): boolean {
    this.#active();
    requireThat(Number.isSafeInteger(event.chainId) && event.chainId > 0 && Number.isSafeInteger(event.logIndex) && event.logIndex >= 0, 'Invalid event identity');
    requireThat(event.blockNumber > 0 && this.#blocks[event.blockNumber] === event.blockHash, 'Noncanonical event');
    const key = `${event.chainId}:${event.transactionHash}:${event.logIndex}`;
    const old = this.#events.get(key);
    if (old) { requireThat(digest(old) === digest(event), 'Event replay conflict'); return false; }
    this.#events.set(key, clone(event)); return true;
  }
  canonicalBlockHash(blockNumber: number) { return this.#blocks[blockNumber]; }
}

/** Production is intentionally unavailable until a reviewed RPC/signing implementation exists. */
export function createChainAdapter(config: ChainConfig): MockChainAdapter {
  if (config.mode === 'mock') return new MockChainAdapter({ confirmations: config.confirmations });
  validateProductionConfig(config);
  throw new Error('Production chain execution disabled: audited RPC/signing adapter and approvals required');
}
