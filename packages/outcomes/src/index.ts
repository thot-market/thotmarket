import type { KeyLike } from 'node:crypto';
import { canonicalHash, signCanonical, verifyCanonical, uuidv7 } from '../../protocol/src/index.ts';
import { developmentSigningKeys } from '../../provenance/src/index.ts';
import type { TrustedIssuer } from '../../credentials/src/index.ts';

export interface OutcomeReceipt {
  schema_version: 'trace.outcome/1'; receipt_id: string; owner_user_id: string; trace_id?: string; provider: string; pseudonymous_subject_id: string;
  predicate: { type: 'security_traded' | 'security_held' | 'security_action'; security_id?: string; window_start?: string; window_end?: string; action?: 'buy' | 'sell' | 'hold' };
  evidence_time: string; source_evidence_hash: string; disclosure_scope_id: string; issuer_key_id: string; signature: string; claims: string[]; limitations: string[];
}
export interface OutcomePredicateRequest {
  type: 'security_traded' | 'security_held' | 'security_action'; securityId: string;
  windowStart?: string; windowEnd?: string; action?: 'buy' | 'sell' | 'hold'; discloseWindow?: boolean;
}
export interface MockAccountRecord { ownerUserId: string; securityId: string; kind: 'trade' | 'holding'; occurredAt: string; action: 'buy' | 'sell' | 'hold'; positionSize?: number; accountId?: string; }
export interface OutcomeProvider {
  providerId: string;
  beginLink(input: { userId: string; scopes: string[]; callbackUrl: string }): Promise<unknown>;
  attestPredicate(input: { userId: string; traceId: string; predicateRequest: OutcomePredicateRequest }): Promise<OutcomeReceipt>;
  revoke(receiptId: string): Promise<void>;
}

export class SignedOutcomeVerifier {
  private issuers: Record<string, TrustedIssuer>; private revoked = new Set<string>(); private revokedUsers = new Set<string>();
  private now: () => Date; private maxAgeDays: number;
  constructor(config: { trustedIssuers: Record<string, TrustedIssuer>; now?: () => Date; maxAgeDays?: number }) { this.issuers = { ...config.trustedIssuers }; this.now = config.now ?? (() => new Date()); this.maxAgeDays = config.maxAgeDays ?? 30; }
  verify(receipt: OutcomeReceipt, input: { userId: string; traceId?: string; predicateType?: string; securityIds?: string[]; maxLagDays?: number }): OutcomeReceipt {
    const keys = ['schema_version', 'receipt_id', 'owner_user_id', 'trace_id', 'provider', 'pseudonymous_subject_id', 'predicate', 'evidence_time', 'source_evidence_hash', 'disclosure_scope_id', 'issuer_key_id', 'signature', 'claims', 'limitations'];
    if (!receipt || Object.keys(receipt).some(key => !keys.includes(key)) || receipt.schema_version !== 'trace.outcome/1' || !receipt.receipt_id || !receipt.pseudonymous_subject_id || !receipt.disclosure_scope_id || !Array.isArray(receipt.claims) || !Array.isArray(receipt.limitations)) throw new Error('INVALID_OUTCOME_RECEIPT');
    const issuer = this.issuers[receipt.issuer_key_id];
    const { signature, ...unsigned } = receipt;
    if (!issuer || issuer.provider !== receipt.provider || !verifyCanonical(unsigned, signature, issuer.publicKey)) throw new Error('INVALID_OUTCOME_SIGNATURE');
    if (receipt.owner_user_id !== input.userId || (input.traceId && receipt.trace_id !== input.traceId)) throw new Error('OUTCOME_SUBJECT_MISMATCH');
    if (this.revoked.has(receipt.receipt_id) || this.revokedUsers.has(input.userId)) throw new Error('OUTCOME_REVOKED');
    const predicate = receipt.predicate;
    if (!predicate || !['security_traded', 'security_held', 'security_action'].includes(predicate.type) || Object.keys(predicate).some(key => !['type', 'security_id', 'window_start', 'window_end', 'action'].includes(key)) || typeof predicate.security_id !== 'string' || !/^[a-z0-9_-]+:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(predicate.security_id)) throw new Error('UNSUPPORTED_OUTCOME_PREDICATE');
    if (predicate.type !== 'security_action' && predicate.action !== undefined) throw new Error('UNAUTHORIZED_OUTCOME_DIRECTION');
    if (predicate.type === 'security_action' && !['buy', 'sell', 'hold'].includes(predicate.action!)) throw new Error('INVALID_OUTCOME_ACTION');
    if ((predicate.window_start === undefined) !== (predicate.window_end === undefined) || (predicate.window_start !== undefined && (!Number.isFinite(Date.parse(predicate.window_start)) || !Number.isFinite(Date.parse(predicate.window_end!)) || Date.parse(predicate.window_start) > Date.parse(predicate.window_end!)))) throw new Error('INVALID_OUTCOME_WINDOW');
    if ((input.predicateType && predicate.type !== input.predicateType) || (input.securityIds && !input.securityIds.includes(predicate.security_id))) throw new Error('OUTCOME_FILTER_MISMATCH');
    const time = Date.parse(receipt.evidence_time); const now = this.now().getTime(); const maxLagDays = input.maxLagDays ?? this.maxAgeDays;
    if (!Number.isFinite(time) || !Number.isFinite(maxLagDays) || maxLagDays <= 0 || time > now || now - time > Math.min(maxLagDays, this.maxAgeDays) * 86_400_000) throw new Error('OUTCOME_EXPIRED');
    return structuredClone(receipt);
  }
  async revoke(receiptId: string): Promise<void> { this.revoked.add(receiptId); }
  revokeConsent(userId: string): void { this.revokedUsers.add(userId); }
}

export class MockOutcomeProvider implements OutcomeProvider {
  readonly providerId = 'mock-brokerage'; readonly verifier: SignedOutcomeVerifier;
  private records: MockAccountRecord[]; private consents = new Map<string, Set<string>>(); private key: KeyLike; private now: () => Date;
  constructor(input: { records: MockAccountRecord[]; now?: () => Date; maxAgeDays?: number }) {
    this.records = structuredClone(input.records); this.now = input.now ?? (() => new Date());
    const keys = developmentSigningKeys('thot-mock-outcome'); this.key = keys.privateKey;
    this.verifier = new SignedOutcomeVerifier({ trustedIssuers: { 'thot-mock-outcome-v1': { publicKey: keys.publicKey, provider: this.providerId } }, now: this.now, maxAgeDays: input.maxAgeDays });
  }
  grantConsent(userId: string, scopes: string[]): void {
    if (!userId || scopes.length === 0 || scopes.some(scope => !['security_traded', 'security_held', 'security_action', 'time_window'].includes(scope))) throw new Error('UNSUPPORTED_OUTCOME_SCOPE');
    this.consents.set(userId, new Set(scopes));
  }
  async beginLink(input: { userId: string; scopes: string[]; callbackUrl: string }): Promise<unknown> {
    // Development only: the caller supplies explicit scope consent. There is no live broker OAuth.
    this.grantConsent(input.userId, input.scopes);
    return { provider: this.providerId, method: 'development_fixture', scopes: [...input.scopes] };
  }
  async attestPredicate(input: { userId: string; traceId: string; predicateRequest: OutcomePredicateRequest }): Promise<OutcomeReceipt> {
    const request = input.predicateRequest; const scopes = this.consents.get(input.userId);
    if (!request || !['security_traded', 'security_held', 'security_action'].includes(request.type) || Object.keys(request).some(key => !['type', 'securityId', 'windowStart', 'windowEnd', 'action', 'discloseWindow'].includes(key))) throw new Error('UNSUPPORTED_OUTCOME_PREDICATE');
    if (!scopes?.has(request.type) || (request.discloseWindow && !scopes.has('time_window'))) throw new Error('OUTCOME_CONSENT_REQUIRED');
    if (!/^[a-z0-9_-]+:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(request.securityId)) throw new Error('SECURITY_MAPPING_REQUIRED');
    if (request.type !== 'security_action' && request.action !== undefined) throw new Error('UNAUTHORIZED_OUTCOME_DIRECTION');
    if (request.type === 'security_action' && !['buy', 'sell', 'hold'].includes(request.action!)) throw new Error('OUTCOME_ACTION_REQUIRED');
    if ((request.windowStart === undefined) !== (request.windowEnd === undefined)) throw new Error('INVALID_OUTCOME_WINDOW');
    const start = request.windowStart === undefined ? -Infinity : Date.parse(request.windowStart);
    const end = request.windowEnd === undefined ? Infinity : Date.parse(request.windowEnd);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || (request.discloseWindow && !request.windowStart)) throw new Error('INVALID_OUTCOME_WINDOW');
    const record = this.records.find(row => row.ownerUserId === input.userId && row.securityId === request.securityId && Date.parse(row.occurredAt) >= start && Date.parse(row.occurredAt) <= end && Date.parse(row.occurredAt) <= this.now().getTime() && (request.type === 'security_traded' ? row.kind === 'trade' : request.type === 'security_held' ? row.kind === 'holding' : row.action === request.action));
    if (!record) throw new Error('OUTCOME_PREDICATE_NOT_SATISFIED');
    const predicate: OutcomeReceipt['predicate'] = { type: request.type, security_id: request.securityId,
      ...(request.type === 'security_action' ? { action: request.action! } : {}),
      ...(request.discloseWindow ? { window_start: request.windowStart!, window_end: request.windowEnd! } : {}) };
    // The commitment covers only the selected source observation; unrelated account records never enter a receipt.
    const minimalEvidence = { security_id: record.securityId, kind: record.kind, evidence_day: record.occurredAt.slice(0, 10), ...(request.type === 'security_action' ? { action: record.action } : {}) };
    const unsigned: Omit<OutcomeReceipt, 'signature'> = {
      schema_version: 'trace.outcome/1', receipt_id: uuidv7(), owner_user_id: input.userId, trace_id: input.traceId, provider: this.providerId,
      pseudonymous_subject_id: `mock-subject-${input.userId}`, predicate, evidence_time: this.now().toISOString(), source_evidence_hash: canonicalHash(minimalEvidence),
      disclosure_scope_id: canonicalHash({ predicate, time_window: request.discloseWindow === true }), issuer_key_id: 'thot-mock-outcome-v1',
      claims: ['Development fixture satisfies only the disclosed predicate.'],
      limitations: ['Public mock signing key; no live brokerage authentication or confidential compute.', 'No position size, portfolio coverage, performance, skill, causation, or provenance claim.'],
    };
    return { ...unsigned, signature: signCanonical(unsigned, this.key) };
  }
  verify(receipt: OutcomeReceipt, input: Parameters<SignedOutcomeVerifier['verify']>[1]): OutcomeReceipt { return this.verifier.verify(receipt, input); }
  async revoke(receiptId: string): Promise<void> { await this.verifier.revoke(receiptId); }
  revokeConsent(userId: string): void { this.consents.delete(userId); this.verifier.revokeConsent(userId); }
}
