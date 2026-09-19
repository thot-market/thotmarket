import type { KeyLike } from 'node:crypto';
import { signCanonical, verifyCanonical, uuidv7 } from '../../protocol/src/index.ts';
import { developmentSigningKeys } from '../../provenance/src/index.ts';

export interface CredentialReceipt {
  schema_version: 'trace.credential/1'; receipt_id: string; owner_user_id: string; pseudonymous_subject_id: string;
  provider: string; provider_method: string; predicate_type: string; predicate_value: string;
  verified_at: string; valid_until?: string; revoked_at?: string; source_evidence_hash?: string;
  issuer_key_id: string; signature: string; claims: string[]; limitations: string[];
}
export interface CredentialProvider {
  providerId: string;
  beginLink(input: { userId: string; requestedPredicate: string; callbackUrl: string }): Promise<unknown>;
  completeLink(input: { userId: string; callbackPayload: unknown }): Promise<CredentialReceipt>;
  revoke(receiptId: string): Promise<void>;
}
export interface TrustedIssuer { publicKey: KeyLike; provider: string; }
export interface SignedCredentialConfig { trustedIssuers: Record<string, TrustedIssuer>; supportedPredicates?: string[]; maxAgeDays?: number; now?: () => Date; }

export class SignedCredentialProvider implements CredentialProvider {
  readonly providerId = 'signed-credential';
  protected trustedIssuers: Record<string, TrustedIssuer>; protected supportedPredicates: string[];
  protected maxAgeDays: number; protected now: () => Date; private revoked = new Set<string>();
  constructor(config: SignedCredentialConfig) {
    this.trustedIssuers = { ...config.trustedIssuers }; this.supportedPredicates = config.supportedPredicates ?? ['workplace_cohort', 'professional_cohort'];
    this.maxAgeDays = config.maxAgeDays ?? 30; this.now = config.now ?? (() => new Date());
    if (!Number.isFinite(this.maxAgeDays) || this.maxAgeDays <= 0) throw new Error('INVALID_CREDENTIAL_FRESHNESS');
  }
  async beginLink(input: { userId: string; requestedPredicate: string; callbackUrl: string }): Promise<unknown> {
    if (!input.userId || !this.supportedPredicates.includes(input.requestedPredicate)) throw new Error('UNSUPPORTED_CREDENTIAL_PREDICATE');
    // This adapter receives a signed predicate; it does not authenticate an external workplace account.
    return { provider: this.providerId, method: 'externally_signed_predicate', requested_predicate: input.requestedPredicate };
  }
  verify(receipt: CredentialReceipt, input: { userId: string; predicateType?: string; acceptedValues?: string[]; freshnessDays?: number }): CredentialReceipt {
    const permittedKeys = ['schema_version', 'receipt_id', 'owner_user_id', 'pseudonymous_subject_id', 'provider', 'provider_method', 'predicate_type', 'predicate_value', 'verified_at', 'valid_until', 'revoked_at', 'source_evidence_hash', 'issuer_key_id', 'signature', 'claims', 'limitations'];
    if (!receipt || Object.keys(receipt).some(key => !permittedKeys.includes(key)) || receipt.schema_version !== 'trace.credential/1' || !receipt.receipt_id || !receipt.pseudonymous_subject_id || !Array.isArray(receipt.claims) || !Array.isArray(receipt.limitations)) throw new Error('INVALID_CREDENTIAL_RECEIPT');
    const issuer = this.trustedIssuers[receipt.issuer_key_id];
    if (!issuer || issuer.provider !== receipt.provider) throw new Error('UNTRUSTED_CREDENTIAL_ISSUER');
    const { signature, ...unsigned } = receipt;
    if (!verifyCanonical(unsigned, signature, issuer.publicKey)) throw new Error('INVALID_CREDENTIAL_SIGNATURE');
    if (receipt.owner_user_id !== input.userId) throw new Error('CREDENTIAL_SUBJECT_MISMATCH');
    if (!this.supportedPredicates.includes(receipt.predicate_type) || (input.predicateType && input.predicateType !== receipt.predicate_type)) throw new Error('UNSUPPORTED_CREDENTIAL_PREDICATE');
    if (input.acceptedValues && !input.acceptedValues.includes(receipt.predicate_value)) throw new Error('CREDENTIAL_VALUE_NOT_ACCEPTED');
    if (typeof receipt.predicate_value !== 'string' || !(receipt.predicate_type==='brokerage_control'
      ? ((receipt.provider==='robinhood' && receipt.provider_method==='attested_witness_link') || (receipt.provider==='plaid' && ['plaid_api','plaid_sandbox_api'].includes(receipt.provider_method))) && receipt.predicate_value==='controls_brokerage:true'
      : /^cohort:[a-z0-9_:-]{1,120}$/.test(receipt.predicate_value))) throw new Error('UNSAFE_CREDENTIAL_PREDICATE');
    if (receipt.revoked_at || this.revoked.has(receipt.receipt_id)) throw new Error('CREDENTIAL_REVOKED');
    const now = this.now().getTime(); const verified = Date.parse(receipt.verified_at);
    const freshness = input.freshnessDays ?? this.maxAgeDays;
    if (!Number.isFinite(freshness) || freshness <= 0 || !Number.isFinite(verified) || verified > now || now - verified > Math.min(freshness, this.maxAgeDays) * 86_400_000 || (receipt.valid_until !== undefined && (!Number.isFinite(Date.parse(receipt.valid_until)) || Date.parse(receipt.valid_until) <= now))) throw new Error('CREDENTIAL_EXPIRED');
    return structuredClone(receipt);
  }
  async completeLink(input: { userId: string; callbackPayload: unknown }): Promise<CredentialReceipt> { return this.verify(input.callbackPayload as CredentialReceipt, { userId: input.userId }); }
  async revoke(receiptId: string): Promise<void> { this.revoked.add(receiptId); }
}

export class MockCredentialProvider extends SignedCredentialProvider {
  private signingKey: KeyLike;
  constructor(config: { now?: () => Date; maxAgeDays?: number } = {}) {
    const keys = developmentSigningKeys('thot-mock-credential');
    super({ trustedIssuers: { 'thot-mock-credential-v1': { publicKey: keys.publicKey, provider: 'mock-workplace' } }, ...config });
    this.signingKey = keys.privateKey;
  }
  issue(input: { userId: string; pseudonymousSubjectId?: string; predicateType?: string; predicateValue?: string; verifiedAt?: string; validUntil?: string }): CredentialReceipt {
    const unsigned: Omit<CredentialReceipt, 'signature'> = {
      schema_version: 'trace.credential/1', receipt_id: uuidv7(), owner_user_id: input.userId,
      pseudonymous_subject_id: input.pseudonymousSubjectId ?? `mock-subject-${input.userId}`,
      provider: 'mock-workplace', provider_method: 'development_fixture', predicate_type: input.predicateType ?? 'workplace_cohort', predicate_value: input.predicateValue ?? 'cohort:law_firm_eligible_v1',
      verified_at: input.verifiedAt ?? this.now().toISOString(), ...(input.validUntil ? { valid_until: input.validUntil } : {}), issuer_key_id: 'thot-mock-credential-v1',
      claims: ['Development fixture asserts membership in the stated cohort at the stated time.'],
      limitations: ['Public mock signing key; no real workplace authentication.', 'No ranking, expertise, legal rights, provenance tier, or employer authorization is established.'],
    };
    const receipt = { ...unsigned, signature: signCanonical(unsigned, this.signingKey) };
    // Issue permits old fixtures for expiry tests, but validates predicate semantics.
    if (!input.userId || !this.supportedPredicates.includes(receipt.predicate_type) || !/^cohort:[a-z0-9_:-]{1,120}$/.test(receipt.predicate_value)) throw new Error('UNSUPPORTED_CREDENTIAL_PREDICATE');
    return receipt;
  }
}
