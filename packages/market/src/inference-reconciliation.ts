import { createPublicKey } from 'node:crypto';
import { canonicalHash, canonicalJson, parseMoney, uuidv7, verifyCanonical } from '../../protocol/src/index.ts';
import { meterResponse, validateRateCard, type InferenceResult } from '../../inference/src/index.ts';
import { postJournal, accountBalance } from '../../ledger/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import { ThotService, type Actor } from './service.ts';

export type BillingEnvironment = 'synthetic' | 'external';
export interface TrustedBillingVerifier {
  publicKeyPem: string; provider: string; environment: BillingEnvironment;
  validFrom: string; validUntil: string; revoked?: boolean; operatorIds?: string[];
}
export interface BillingReconciliationConfig {
  audience: string;
  trustedVerifiers: Record<string, TrustedBillingVerifier>;
  submitterIds: string[]; reviewerIds: string[];
}
interface BillingEnvelope {
  schema_version: 'thot.inference-billing-evidence/1'; kind: 'request_charge' | 'provider_invoice';
  evidence_id: string; verifier_id: string; audience: string; provider: string; environment: BillingEnvironment;
  issued_at: string; expires_at: string; source_commitment: string; final: true; currency: 'USD'; signature: string;
}
export interface RequestChargeEvidence extends BillingEnvelope {
  kind: 'request_charge'; request_id: string; reservation_id: string; rate_card_hash: string;
  client_request_id: string; provider_response_id: string | null; provider_usage_id: string;
  observed_through_at: string; outcome: 'NO_CHARGE' | 'CHARGED'; charged_minor: string;
  usage: InferenceResult['usage'] | null;
}
export interface InvoiceLine {
  request_id: string; reservation_id: string; rate_card_hash: string; provider_response_id: string;
  provider_usage_id: string; usage_commitment: string; amount_minor: string;
}
export interface ProviderInvoiceEvidence extends BillingEnvelope {
  kind: 'provider_invoice'; invoice_id: string; invoice_total_minor: string; lines: InvoiceLine[];
}
export type SignedBillingEvidence = RequestChargeEvidence | ProviderInvoiceEvidence;

const commonFields = ['schema_version', 'kind', 'evidence_id', 'verifier_id', 'audience', 'provider', 'environment',
  'issued_at', 'expires_at', 'source_commitment', 'final', 'currency', 'signature'];
const chargeFields = ['request_id', 'reservation_id', 'rate_card_hash', 'client_request_id', 'provider_response_id',
  'provider_usage_id', 'observed_through_at', 'outcome', 'charged_minor', 'usage'];
const lineFields = ['request_id', 'reservation_id', 'rate_card_hash', 'provider_response_id', 'provider_usage_id', 'usage_commitment', 'amount_minor'];
const usageFields = ['input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens', 'total_tokens'];
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(v);
const digest = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const responseId = (v: unknown) => typeof v === 'string' && /^resp_[A-Za-z0-9_-]{1,200}$/.test(v);
function exact(value: unknown, fields: string[]) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_BILLING_EVIDENCE');
  ensure(Object.keys(value).length === fields.length && Object.keys(value).every(k => fields.includes(k)), 'INVALID_BILLING_EVIDENCE');
}
function timestamp(value: unknown): number {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), 'INVALID_BILLING_TIME');
  const time = Date.parse(value); ensure(Number.isFinite(time) && new Date(time).toISOString() === value, 'INVALID_BILLING_TIME'); return time;
}
function amount(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(0|[1-9][0-9]{0,11})$/.test(value), 'INVALID_BILLING_AMOUNT'); return parseMoney(value);
}
function assertUsage(usage: unknown) {
  exact(usage, usageFields);
  ensure(Object.values(usage as Document).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2_000_000), 'INVALID_BILLING_USAGE');
}

/** Strict metadata envelope, not a statement parser. Signature trust is explicitly configured out-of-band. */
export class InferenceReconciliation {
  readonly service: ThotService;
  private readonly config: BillingReconciliationConfig;
  constructor(service: ThotService, config?: BillingReconciliationConfig) {
    this.service = service;
    this.config = structuredClone(config ?? { audience: '', trustedVerifiers: {}, submitterIds: [], reviewerIds: [] });
    ensure(Array.isArray(this.config.submitterIds) && Array.isArray(this.config.reviewerIds) &&
      this.config.submitterIds.every(id) && this.config.reviewerIds.every(id), 'INVALID_BILLING_CONFIG');
    if (Object.keys(this.config.trustedVerifiers).length) ensure(id(this.config.audience), 'INVALID_BILLING_CONFIG');
    for (const [verifierId, trusted] of Object.entries(this.config.trustedVerifiers)) {
      ensure(id(verifierId) && id(trusted.provider) && ['synthetic', 'external'].includes(trusted.environment), 'INVALID_BILLING_CONFIG');
      ensure(timestamp(trusted.validFrom) < timestamp(trusted.validUntil), 'INVALID_BILLING_CONFIG');
      ensure(!trusted.operatorIds || (Array.isArray(trusted.operatorIds) && trusted.operatorIds.every(id)), 'INVALID_BILLING_CONFIG');
      try { ensure(createPublicKey(trusted.publicKeyPem).asymmetricKeyType === 'ed25519', 'INVALID_BILLING_KEY'); }
      catch { ensure(false, 'INVALID_BILLING_KEY'); }
    }
  }
  capabilities(): Document {
    const enabled = Object.values(this.config.trustedVerifiers).some(v => !v.revoked && timestamp(v.validFrom) <= Date.parse(this.service.now()) && timestamp(v.validUntil) > Date.parse(this.service.now()) &&
      this.config.submitterIds.some(submitter => this.config.reviewerIds.some(reviewer => reviewer !== submitter && !v.operatorIds?.includes(reviewer))));
    return { enabled, signed_evidence_required: true, independent_review_required: true, payment_execution: false,
      external_invoice_verification_implemented: false, reason: enabled ? 'CONFIGURED_VERIFIER_ASSERTIONS_ONLY' : 'NO_TRUSTED_BILLING_VERIFIER_AND_INDEPENDENT_REVIEWERS' };
  }
  private operator(actor: Actor, purpose?: 'submit' | 'review') {
    ensure(actor.role === 'operator_security', 'FORBIDDEN', 403);
    if (purpose) {
      ensure(this.capabilities().enabled, 'BILLING_RECONCILIATION_DISABLED', 503);
      ensure((purpose === 'submit' ? this.config.submitterIds : this.config.reviewerIds).includes(actor.id), 'BILLING_OPERATOR_NOT_AUTHORIZED', 403);
    }
  }
  private verify(value: unknown): SignedBillingEvidence {
    // Reject accessors and unsupported objects before touching fields. No buyer strings can become executable code.
    let encoded: string; try { encoded = canonicalJson(value); } catch { ensure(false, 'INVALID_BILLING_EVIDENCE'); }
    ensure(Buffer.byteLength(encoded!) <= 100_000, 'BILLING_EVIDENCE_TOO_LARGE');
    const e = JSON.parse(encoded!) as SignedBillingEvidence;
    ensure(e?.kind === 'request_charge' || e?.kind === 'provider_invoice', 'INVALID_BILLING_EVIDENCE');
    exact(e, [...commonFields, ...(e.kind === 'request_charge' ? chargeFields : ['invoice_id', 'invoice_total_minor', 'lines'])]);
    ensure(e.schema_version === 'thot.inference-billing-evidence/1' && e.currency === 'USD' && e.final === true, 'INVALID_BILLING_EVIDENCE');
    ensure([e.evidence_id, e.verifier_id, e.provider, e.audience].every(id) && digest(e.source_commitment), 'INVALID_BILLING_EVIDENCE');
    ensure(e.audience === this.config.audience, 'BILLING_AUDIENCE_MISMATCH');
    const trusted = this.config.trustedVerifiers[e.verifier_id];
    ensure(trusted && !trusted.revoked, 'BILLING_VERIFIER_UNTRUSTED');
    ensure(e.provider === trusted.provider && e.environment === trusted.environment, 'BILLING_VERIFIER_SCOPE_MISMATCH');
    const now = Date.parse(this.service.now()), issued = timestamp(e.issued_at), expiry = timestamp(e.expires_at);
    ensure(issued <= now && now < expiry && expiry > issued && expiry - issued <= 7 * 86400000, 'BILLING_EVIDENCE_EXPIRED');
    ensure(timestamp(trusted.validFrom) <= issued && now < timestamp(trusted.validUntil), 'BILLING_KEY_EXPIRED');
    const { signature, ...unsigned } = e;
    ensure(verifyCanonical(unsigned, signature, trusted.publicKeyPem), 'INVALID_BILLING_SIGNATURE');
    if (e.kind === 'request_charge') {
      ensure([e.request_id, e.reservation_id, e.provider_usage_id].every(id) && [e.rate_card_hash, e.client_request_id].every(digest), 'INVALID_BILLING_EVIDENCE');
      ensure(timestamp(e.observed_through_at) <= issued, 'INVALID_BILLING_TIME');
      ensure(e.outcome === 'NO_CHARGE' || e.outcome === 'CHARGED', 'INVALID_BILLING_EVIDENCE');
      const charged = amount(e.charged_minor);
      if (e.outcome === 'NO_CHARGE') ensure(charged === 0n && e.usage === null && e.provider_response_id === null, 'INVALID_NO_CHARGE_EVIDENCE');
      else { ensure(charged > 0n && responseId(e.provider_response_id), 'INVALID_CHARGE_EVIDENCE'); assertUsage(e.usage); }
    } else {
      ensure(id(e.invoice_id) && Array.isArray(e.lines) && e.lines.length > 0 && e.lines.length <= 100, 'INVALID_BILLING_INVOICE');
      const requests = new Set<string>(), usages = new Set<string>(), responses = new Set<string>(); let total = 0n;
      for (const line of e.lines) {
        exact(line, lineFields);
        ensure([line.request_id, line.reservation_id, line.provider_usage_id].every(id) && [line.rate_card_hash, line.usage_commitment].every(digest) && responseId(line.provider_response_id), 'INVALID_BILLING_INVOICE');
        ensure(!requests.has(line.request_id) && !usages.has(line.provider_usage_id) && !responses.has(line.provider_response_id), 'DUPLICATE_INVOICE_LINE');
        requests.add(line.request_id); usages.add(line.provider_usage_id); responses.add(line.provider_response_id);
        const cost = amount(line.amount_minor); ensure(cost > 0n, 'INVALID_BILLING_AMOUNT'); total += cost;
      }
      ensure(total === amount(e.invoice_total_minor), 'INVOICE_TOTAL_MISMATCH');
    }
    return e;
  }
  private async matchingRequest(tx: Transaction, e: SignedBillingEvidence, requestId: string, reservationId: string, rateHash: string) {
    const r = await tx.get('inference_requests', requestId);
    ensure(r.request_id === requestId && r.reservation_id === reservationId && r.provider === e.provider && r.rate_card_hash === rateHash && r.currency === e.currency, 'BILLING_REQUEST_BINDING_MISMATCH');
    ensure((r.billing_environment ?? 'external') === e.environment, 'BILLING_ENVIRONMENT_MISMATCH');
    ensure(canonicalHash(r.rate_card) === rateHash, 'BILLING_RATE_CARD_DRIFT');
    validateRateCard(r.rate_card, new Date(r.created_at));
    const reservation = await tx.get('inference_credit_reservations', reservationId, r.owner_id);
    ensure(reservation.request_id === requestId && reservation.entitlement_id === r.entitlement_id && reservation.currency === r.currency && reservation.amount_minor === r.reserved_minor, 'BILLING_RESERVATION_BINDING_MISMATCH');
    return { request: r, reservation };
  }
  private async checkCurrent(tx: Transaction, e: SignedBillingEvidence) {
    if (e.kind === 'request_charge') {
      const { request: r, reservation } = await this.matchingRequest(tx, e, e.request_id, e.reservation_id, e.rate_card_hash);
      ensure(r.status === 'UNCERTAIN' && reservation.status === 'RESERVED', 'BILLING_REQUEST_NOT_HELD', 409);
      ensure(e.client_request_id === canonicalHash({ requestId: e.request_id, path: 'responses' }), 'BILLING_CLIENT_REQUEST_MISMATCH');
      ensure(timestamp(e.observed_through_at) >= timestamp(r.created_at), 'BILLING_OBSERVATION_PRECEDES_REQUEST');
      ensure(amount(e.charged_minor) <= amount(r.reserved_minor), 'BILLING_RESERVATION_EXCEEDED');
      if (e.outcome === 'CHARGED') {
        const u = e.usage!;
        const priced = meterResponse({ id: e.provider_response_id, model: r.rate_card.model, service_tier: r.rate_card.service_tier, status: 'completed', output: [],
          usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens,
            input_tokens_details: { cached_tokens: u.cached_tokens, cache_write_tokens: u.cache_write_tokens } } }, r.rate_card);
        ensure(priced.actual_minor === e.charged_minor, 'BILLING_TARIFF_MISMATCH');
        ensure(!(await tx.list('inference_requests')).some(other => other.request_id !== e.request_id && other.provider === e.provider && other.provider_response_id === e.provider_response_id), 'DUPLICATE_PROVIDER_RESPONSE', 409);
      }
    } else {
      for (const line of e.lines) {
        const { request: r, reservation } = await this.matchingRequest(tx, e, line.request_id, line.reservation_id, line.rate_card_hash);
        ensure(['COMPLETED', 'INCOMPLETE', 'FAILED'].includes(r.status) && reservation.status === 'SPENT' && r.actual_minor === line.amount_minor && reservation.actual_minor === line.amount_minor, 'INVOICE_UNMETERED_REQUEST');
        ensure(r.provider_response_id === line.provider_response_id && canonicalHash(r.usage) === line.usage_commitment, 'INVOICE_USAGE_BINDING_MISMATCH');
        ensure(!r.provider_usage_id || r.provider_usage_id === line.provider_usage_id, 'INVOICE_USAGE_BINDING_MISMATCH');
      }
    }
  }
  private requestIds(e: SignedBillingEvidence) { return e.kind === 'request_charge' ? [e.request_id] : e.lines.map(line => line.request_id); }
  private async checkConflicts(tx: Transaction, e: SignedBillingEvidence, except?: string) {
    const prior = await tx.list('inference_billing_evidence'), reviews = await tx.list('inference_billing_reviews');
    for (const row of prior) {
      if (row.evidence_record_id === except) continue;
      const other = row.signed_evidence as SignedBillingEvidence;
      if (other.provider !== e.provider || other.environment !== e.environment) continue;
      const review = reviews.find(r => r.evidence_record_id === row.evidence_record_id);
      // A provider usage identity never maps to another local request, even after evidence is rejected.
      const usages = (x: SignedBillingEvidence) => x.kind === 'request_charge' ? [{ provider_usage_id: x.provider_usage_id, request_id: x.request_id }] : x.lines;
      for (const current of usages(e)) for (const previous of usages(other))
        ensure(current.provider_usage_id !== previous.provider_usage_id || current.request_id === previous.request_id, 'BILLING_USAGE_REPLAY_CONFLICT', 409);
      if (review?.decision === 'REJECTED') continue;
      if (e.kind === 'request_charge' && other.kind === 'request_charge') ensure(e.request_id !== other.request_id, 'BILLING_EVIDENCE_CONFLICT', 409);
      if (e.kind === 'provider_invoice' && other.kind === 'provider_invoice') {
        ensure(e.invoice_id !== other.invoice_id && !this.requestIds(e).some(requestId => this.requestIds(other).includes(requestId)), 'BILLING_INVOICE_REPLAY_CONFLICT', 409);
      }
    }
  }
  async submit(actor: Actor, key: string, value: unknown) {
    this.operator(actor, 'submit');
    // Store only a digest in the idempotency journal; evidence itself has a strict, bounded metadata schema.
    let evidenceHash: string; try { evidenceHash = canonicalHash(value); } catch { ensure(false, 'INVALID_BILLING_EVIDENCE'); }
    return this.service.db.command(actor.id, key, { action: 'submitBillingEvidence', evidence_hash: evidenceHash! }, async tx => {
      const e = this.verify(value);
      const existing = (await tx.list('inference_billing_evidence')).find(row => row.verifier_id === e.verifier_id && row.evidence_id === e.evidence_id);
      if (existing) { ensure(existing.evidence_hash === evidenceHash, 'BILLING_EVIDENCE_REPLAY_CONFLICT', 409); return { evidence_record_id: existing.evidence_record_id, evidence_hash: evidenceHash }; }
      await this.checkCurrent(tx, e); await this.checkConflicts(tx, e);
      const recordId = uuidv7();
      await tx.insert('inference_billing_evidence', recordId, 'network', { evidence_record_id: recordId, evidence_id: e.evidence_id, verifier_id: e.verifier_id,
        kind: e.kind, provider: e.provider, environment: e.environment, evidence_hash: evidenceHash, submitted_by: actor.id, submitted_at: this.service.now(), signed_evidence: e });
      await tx.audit(actor.id, 'InferenceBillingEvidenceSubmitted', { evidence_record_id: recordId, evidence_hash: evidenceHash!, verifier_id: e.verifier_id, synthetic: e.environment === 'synthetic' });
      return { evidence_record_id: recordId, evidence_hash: evidenceHash };
    });
  }
  async approve(actor: Actor, key: string, recordId: string) { return this.review(actor, key, recordId, 'APPROVED'); }
  async reject(actor: Actor, key: string, recordId: string) { return this.review(actor, key, recordId, 'REJECTED'); }
  private async review(actor: Actor, key: string, recordId: string, decision: 'APPROVED' | 'REJECTED') {
    this.operator(actor, 'review');
    return this.service.db.command(actor.id, key, { action: 'reviewBillingEvidence', recordId, decision }, async tx => {
      const record = await tx.get('inference_billing_evidence', recordId);
      ensure(record.submitted_by !== actor.id, 'BILLING_SELF_APPROVAL_DENIED', 403);
      ensure(!this.config.trustedVerifiers[record.verifier_id]?.operatorIds?.includes(actor.id), 'BILLING_VERIFIER_SELF_APPROVAL_DENIED', 403);
      const prior = (await tx.list('inference_billing_reviews')).find(row => row.evidence_record_id === recordId);
      if (prior) { ensure(prior.decision === decision, 'BILLING_REVIEW_CONFLICT', 409); return this.reviewSummary(prior); }
      const reviewId = uuidv7(); let journalId: string | null = null;
      if (decision === 'APPROVED') {
        const e = this.verify(record.signed_evidence);
        ensure(canonicalHash(e) === record.evidence_hash, 'BILLING_EVIDENCE_DRIFT');
        await this.checkCurrent(tx, e); await this.checkConflicts(tx, e, recordId);
        if (e.kind === 'request_charge') {
          const r = await tx.get('inference_requests', e.request_id);
          await this.service.settleInferenceIn(tx, r.reservation_id, { request_id: r.request_id, actual_minor: e.charged_minor, provider_metered: true });
          Object.assign(r, { status: 'FAILED', actual_minor: e.charged_minor, finished_at: this.service.now(), billing_verified_at: this.service.now(),
            billing_evidence_record_id: recordId, billing_review_id: reviewId, billing_resolution: e.outcome === 'NO_CHARGE' ? 'VERIFIED_NO_CHARGE' : 'VERIFIED_CHARGE_NO_OUTPUT' });
          if (e.outcome === 'CHARGED') Object.assign(r, { usage: e.usage, provider_response_id: e.provider_response_id, provider_usage_id: e.provider_usage_id });
          delete r.failure_code;
          await tx.update('inference_requests', r.request_id, r);
          journalId = (await tx.sql.query('SELECT id FROM ledger_transactions WHERE reference=$1', ['usage:' + r.reservation_id])).rows[0]!.id;
          await tx.audit(r.owner_id, 'InferenceBillingHoldResolved', { request_id: r.request_id, reservation_id: r.reservation_id, evidence_record_id: recordId,
            review_id: reviewId, actual_minor: e.charged_minor, resolution: r.billing_resolution, synthetic: e.environment === 'synthetic' });
        } else {
          const total = amount(e.invoice_total_minor);
          const payable = await accountBalance(tx, 'USD', 'network', 'LIABILITY:inference_provider_payable');
          ensure(payable <= -total, 'INVOICE_PAYABLE_SHORTFALL', 409);
          journalId = await postJournal(tx, 'inference-invoice:' + canonicalHash({ provider: e.provider, environment: e.environment, invoice_id: e.invoice_id }), 'USD', [
            { owner: 'network', account: 'LIABILITY:inference_provider_payable', amount: total },
            { owner: 'network', account: 'LIABILITY:inference_verified_invoice_payable', amount: -total },
          ]);
        }
      }
      const review = { review_id: reviewId, evidence_record_id: recordId, evidence_hash: record.evidence_hash, decision,
        submitted_by: record.submitted_by, reviewed_by: actor.id, reviewed_at: this.service.now(), journal_id: journalId,
        provider: record.provider, environment: record.environment, payment_status: 'NOT_EXECUTED' };
      await tx.insert('inference_billing_reviews', reviewId, 'network', review);
      await tx.audit(actor.id, 'InferenceBillingEvidenceReviewed', { evidence_record_id: recordId, review_id: reviewId, evidence_hash: record.evidence_hash,
        submitted_by: record.submitted_by, reviewed_by: actor.id, decision, synthetic: record.environment === 'synthetic' });
      return this.reviewSummary(review);
    });
  }
  private reviewSummary(r: Document) {
    return { review_id: r.review_id, evidence_record_id: r.evidence_record_id, evidence_hash: r.evidence_hash, decision: r.decision,
      submitted_by: r.submitted_by, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, journal_id: r.journal_id,
      environment: r.environment, payment_status: 'NOT_EXECUTED' };
  }
  async list(actor: Actor) {
    this.operator(actor);
    return this.service.db.transaction(async tx => {
      const reviews = await tx.list('inference_billing_reviews');
      return (await tx.list('inference_billing_evidence')).map(record => {
        const e = record.signed_evidence as SignedBillingEvidence, review = reviews.find(r => r.evidence_record_id === record.evidence_record_id);
        return { evidence_record_id: record.evidence_record_id, evidence_hash: record.evidence_hash, kind: e.kind, provider: e.provider,
          environment: e.environment, submitted_by: record.submitted_by, submitted_at: record.submitted_at, verifier_id: e.verifier_id,
          issued_at: e.issued_at, expires_at: e.expires_at, source_commitment: e.source_commitment, request_ids: this.requestIds(e),
          amount_minor: e.kind === 'request_charge' ? e.charged_minor : e.invoice_total_minor,
          status: review?.decision ?? 'PENDING_REVIEW', review: review ? this.reviewSummary(review) : null };
      });
    });
  }
}
