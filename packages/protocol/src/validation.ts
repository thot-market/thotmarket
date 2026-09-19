import { canonicalJson } from './canonical.ts';
import { parseMoney } from './money.ts';
import type { ProvenanceReceipt, CredentialReceipt, OutcomeReceipt, RightsAssessment, TraceFeatures, UserPolicy, BuyerMandate, AssayReceipt, SaleAuthorization, SaleSettlement, ProtocolObject } from './types.ts';

type Check = (value: unknown, path: string) => void;
export class ProtocolValidationError extends TypeError {
  constructor(path: string, reason: string) { super(`${path}: ${reason}`); this.name = 'ProtocolValidationError'; }
}
const fail = (path: string, reason: string): never => { throw new ProtocolValidationError(path, reason); };
const text: Check = (v, p) => { if (typeof v !== 'string' || !v.length || v.length > 4096) fail(p, 'expected nonempty string of at most 4096 characters'); };
const bool: Check = (v, p) => { if (typeof v !== 'boolean') fail(p, 'expected boolean'); };
const finite: Check = (v, p) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, 'expected finite number'); };
const count: Check = (v, p) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(p, 'expected nonnegative safe integer'); };
const positiveCount: Check = (v, p) => { count(v, p); if (v === 0) fail(p, 'expected positive integer'); };
const money: Check = (v, p) => { if (typeof v !== 'bigint' || v < 0n) fail(p, 'expected nonnegative bigint; decode wire decimal strings first'); };
const hash: Check = (v, p) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(p, 'expected lowercase SHA-256 hex hash'); };
const date: Check = (v, p) => {
  if (typeof v !== 'string') fail(p, 'expected RFC3339 UTC timestamp');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(v as string);
  if (!match || !Number.isFinite(Date.parse(v as string))) fail(p, 'expected RFC3339 UTC timestamp');
  const parsed = new Date(v as string);
  if ([parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds()].some((part, index) => part !== Number(match![index + 1]))) fail(p, 'invalid calendar timestamp');
};
const enumeration = (...values: string[]): Check => (v, p) => { if (typeof v !== 'string' || !values.includes(v)) fail(p, `expected one of ${values.join(', ')}`); };
const array = (check: Check): Check => (v, p) => { if (!Array.isArray(v) || v.length > 10000) fail(p, 'expected bounded array'); (v as unknown[]).forEach((item, index) => check(item, `${p}[${index}]`)); };
const strings = array(text);
const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v, p) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(p, 'expected plain object');
  const fields = v as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const descriptor = Object.getOwnPropertyDescriptor(fields, key)!;
    if (!('value' in descriptor)) fail(`${p}.${key}`, 'accessors are not allowed');
    if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) fail(`${p}.${key}`, 'unknown field');
  }
  for (const [key, check] of Object.entries(required)) { if (!Object.hasOwn(fields, key)) fail(`${p}.${key}`, 'required field missing'); check(fields[key], `${p}.${key}`); }
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(fields, key)) check(fields[key], `${p}.${key}`);
};
const tiers = enumeration('P0_OPERATOR', 'P1_WITNESSED', 'P2_TEE', 'P3_UPSTREAM');
const rights = enumeration('eligible', 'eligible_with_restrictions', 'manual_review', 'rejected');
const workflows = enumeration('coding', 'research', 'investment_research', 'legal_research', 'contract_review', 'chat', 'agent', 'other');
const signatureFields = { issuer_key_id: text, signature: text, claims: strings, limitations: strings };

const schemas: Record<string, Check> = {
  'trace.provenance/1': object({
    schema_version: enumeration('trace.provenance/1'), receipt_id: text, trace_id: text,
    path: enumeration('attested_proxy', 'attested_sandbox', 'browser', 'mobile', 'legacy_import', 'operator_capture'), confidence_tier: tiers,
    temporal: object({}, { not_before: date, observed_start: date, observed_end: date, not_after: date }),
    commitments: object({ source_bundle_hash: hash }, { raw_trace_hash: hash, session_root: hash }),
    claims: strings, limitations: strings,
    verifier: object({ implementation: text, version: text, verified_at: date }),
  }, { upstream: object({}, { host: text, model_claim: text, provider_claim: text }), attestation: object({}, {
    tee_type: enumeration('intel_tdx', 'nitro', 'confidential_space', 'other'), measurement_set_id: text,
    quote_hash: hash, quote_verification_status: enumeration('valid', 'invalid', 'unknown'),
  }) }),
  'trace.credential/1': object({
    schema_version: enumeration('trace.credential/1'), receipt_id: text, owner_user_id: text,
    pseudonymous_subject_id: text, provider: text, provider_method: text, predicate_type: text,
    predicate_value: text, verified_at: date, ...signatureFields,
  }, { valid_until: date, revoked_at: date, source_evidence_hash: hash }),
  'trace.outcome/1': object({
    schema_version: enumeration('trace.outcome/1'), receipt_id: text, owner_user_id: text, provider: text,
    pseudonymous_subject_id: text,
    predicate: object({ type: enumeration('security_traded', 'security_held', 'security_action', 'delayed_return_bucket', 'custom') }, {
      security_id: text, window_start: date, window_end: date, action: enumeration('buy', 'sell', 'hold'), return_bucket: text, custom_value: text,
    }), evidence_time: date, source_evidence_hash: hash, disclosure_scope_id: text, ...signatureFields,
  }, { trace_id: text }),
  'trace.rights/1': object({
    schema_version: enumeration('trace.rights/1'), assessment_id: text, trace_id: text, policy_version: text, status: rights,
    flags: array(enumeration('secret', 'pii_dense', 'privileged_legal', 'client_confidential', 'employer_confidential', 'third_party_document', 'mnpi_like', 'financial_account_sensitive', 'upstream_terms_risk', 'unknown_rights')),
    permitted_components: strings, prohibited_components: strings, engine_version: text, generated_at: date,
  }),
  'trace.features/1': object({
    schema_version: enumeration('trace.features/1'), trace_id: text, topic_labels: strings, workflow_type: workflows,
    counts: object({ turns: count }, { human_tokens: count, model_tokens: count, tool_calls: count }),
    signals: object({}, { correction_density: finite, tool_diversity: finite, outcome_density: finite, duplication_score: finite }),
    available_predicates: object({ credential_types: strings, outcome_types: strings }), rights_status: rights,
    provenance_tier: tiers, feature_model_version: text,
  }, { model_family: text, language: text }),
  'trace.user-policy/1': object({
    schema_version: enumeration('trace.user-policy/1'), policy_id: text, owner_user_id: text, version: positiveCount,
    mode: enumeration('manual_approval', 'standing_authorization'), allowed_categories: strings, prohibited_categories: strings,
    allowed_purposes: strings, prohibited_purposes: strings,
    evidence_disclosure: object({ trace_body: bool, credential_predicate_types: strings, outcome_predicate_types: strings, identity_disclosure: bool }),
    license_defaults: object({ exclusive: bool, onward_transfer: bool, model_training: bool }, { max_retention_days: count }),
    payout_preference: enumeration('inference_credit', 'token', 'ask_each_sale'), effective_at: date,
  }, { allowed_buyers: strings, prohibited_buyers: strings, expires_at: date }),
  'trace.mandate/1': object({
    schema_version: enumeration('trace.mandate/1'), mandate_id: text, buyer_id: text,
    status: enumeration('draft', 'pending_funding', 'funded', 'active', 'paused', 'exhausted', 'expired', 'closed'),
    criteria: object({ provenance_tiers: array(tiers), workflow_types: array(workflows), rights_required: strings }, {
      date_range: object({ start: date, end: date }), topic_query: text,
      credential_predicates: array(object({ type: text, accepted_values: strings }, { freshness_days: count })),
      outcome_predicates: array(object({ type: text }, { security_ids: strings, max_lag_days: count })),
    }),
    assay: object({ assay_id: text, version: text, threshold: finite, input_scope: text, output_schema: text }),
    economics: object({ currency: enumeration('USDC', 'USD'), max_units: positiveCount, total_budget_minor: money, direct_cost_policy_id: text }, { unit_price_minor: money }),
    license: object({ purpose: text, model_training: bool, onward_transfer: bool, exclusive: bool, retention_days: count }),
    funding: object({ mode: enumeration('offchain_escrow', 'onchain_escrow'), funded_minor: money }, { funding_reference: text }), expires_at: date,
  }),
  'trace.assay/1': object({
    schema_version: enumeration('trace.assay/1'), assay_receipt_id: text, mandate_id: text, trace_id: text,
    assay_id: text, assay_version: text, assay_commitment: hash, input_hash: hash,
    result: enumeration('accepted', 'rejected', 'error'), output_hash: hash, executed_at: date, signature: text,
  }, { score: finite, environment_measurement: text, bounded_labels: (v, p) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 32) fail(p, 'expected at most 32 bounded labels');
    for (const [key, value] of Object.entries(v!)) {
      if (key.length > 64) fail(p, 'label key too long');
      if (typeof value === 'string') { if (value.length > 128) fail(p, 'label value too long'); }
      else if (typeof value === 'number') finite(value, p);
      else bool(value, p);
    }
  } }),
  'trace.sale-auth/1': object({
    schema_version: enumeration('trace.sale-auth/1'), authorization_id: text, owner_user_id: text, trace_id: text, mandate_id: text,
    release_artifact_hash: hash, credential_receipt_ids: strings, outcome_receipt_ids: strings, license_hash: hash,
    expected_gross_minor: money, expected_direct_costs_max_minor: money, payout_preference: enumeration('inference_credit', 'token'),
    authorized_at: date, expires_at: date, auth_method: enumeration('account_session', 'passkey', 'wallet_signature'), auth_evidence: text,
  }),
  'trace.settlement/1': object({
    schema_version: enumeration('trace.settlement/1'), settlement_id: text, license_id: text,
    gross_minor: money, direct_costs_minor: money, eligible_net_minor: money, contributor_minor: money, burn_minor: money, operator_minor: money,
    split_policy_id: text, contributor_disposition: enumeration('pending', 'inference_credit', 'token_purchase'), created_at: date,
  }),
};

function assertSchema(value: unknown, expected?: string): void {
  canonicalJson(value); // reject non-JSON structures before reading fields
  if (!value || typeof value !== 'object') fail('receipt', 'expected protocol object');
  const version = (value as Record<string, unknown>).schema_version;
  if (typeof version !== 'string' || !Object.hasOwn(schemas, version)) fail('schema_version', 'unknown protocol schema version');
  if (expected && version !== expected) fail('schema_version', `expected ${expected}`);
  schemas[version as string]!(value, 'receipt');
  const v = value as any;
  function ordered(start: string | undefined, end: string | undefined, label: string): void {
    if (start && end && Date.parse(start) > Date.parse(end)) fail(label, 'start must not be after end');
  }
  if (version === 'trace.provenance/1') {
    const times = [v.temporal.not_before, v.temporal.observed_start, v.temporal.observed_end, v.temporal.not_after].filter(Boolean);
    for (let index = 1; index < times.length; index++) ordered(times[index - 1], times[index], 'temporal');
  }
  if (version === 'trace.credential/1') { ordered(v.verified_at, v.valid_until, 'valid_until'); ordered(v.verified_at, v.revoked_at, 'revoked_at'); }
  if (version === 'trace.outcome/1') ordered(v.predicate.window_start, v.predicate.window_end, 'predicate.window');
  if (version === 'trace.user-policy/1') ordered(v.effective_at, v.expires_at, 'expires_at');
  if (version === 'trace.mandate/1' && v.criteria.date_range) ordered(v.criteria.date_range.start, v.criteria.date_range.end, 'criteria.date_range');
  if (version === 'trace.sale-auth/1') {
    ordered(v.authorized_at, v.expires_at, 'expires_at');
    if (v.expected_direct_costs_max_minor > v.expected_gross_minor) fail('expected_direct_costs_max_minor', 'costs cannot exceed gross');
  }
  if (version === 'trace.settlement/1') {
    if (v.gross_minor - v.direct_costs_minor !== v.eligible_net_minor || v.contributor_minor + v.burn_minor + v.operator_minor !== v.eligible_net_minor) fail('settlement', 'monetary conservation violated');
  }
}

export function validateProtocolObject(value: unknown): asserts value is ProtocolObject { assertSchema(value); }
export function validateProvenanceReceipt(value: unknown): asserts value is ProvenanceReceipt { assertSchema(value, 'trace.provenance/1'); }
export function validateCredentialReceipt(value: unknown): asserts value is CredentialReceipt { assertSchema(value, 'trace.credential/1'); }
export function validateOutcomeReceipt(value: unknown): asserts value is OutcomeReceipt { assertSchema(value, 'trace.outcome/1'); }
export function validateRightsAssessment(value: unknown): asserts value is RightsAssessment { assertSchema(value, 'trace.rights/1'); }
export function validateTraceFeatures(value: unknown): asserts value is TraceFeatures { assertSchema(value, 'trace.features/1'); }
export function validateUserPolicy(value: unknown): asserts value is UserPolicy { assertSchema(value, 'trace.user-policy/1'); }
export function validateBuyerMandate(value: unknown): asserts value is BuyerMandate { assertSchema(value, 'trace.mandate/1'); }
export function validateAssayReceipt(value: unknown): asserts value is AssayReceipt { assertSchema(value, 'trace.assay/1'); }
export function validateSaleAuthorization(value: unknown): asserts value is SaleAuthorization { assertSchema(value, 'trace.sale-auth/1'); }
export function validateSaleSettlement(value: unknown): asserts value is SaleSettlement { assertSchema(value, 'trace.settlement/1'); }

/** Decode canonical wire money strings, without accepting JSON numbers or rounding. */
export function decodeProtocolObject(value: unknown): ProtocolObject {
  const wire = typeof value === 'string' ? JSON.parse(value) : JSON.parse(canonicalJson(value));
  const moneyPaths: Record<string, string[]> = {
    'trace.mandate/1': ['economics.unit_price_minor', 'economics.total_budget_minor', 'funding.funded_minor'],
    'trace.sale-auth/1': ['expected_gross_minor', 'expected_direct_costs_max_minor'],
    'trace.settlement/1': ['gross_minor', 'direct_costs_minor', 'eligible_net_minor', 'contributor_minor', 'burn_minor', 'operator_minor'],
  };
  for (const path of moneyPaths[wire?.schema_version] ?? []) {
    const parts = path.split('.');
    let container = wire;
    for (const part of parts.slice(0, -1)) container = container?.[part];
    const key = parts.at(-1)!;
    if (container && Object.hasOwn(container, key)) container[key] = parseMoney(container[key]);
  }
  validateProtocolObject(wire);
  return wire;
}

export const supportedSchemaVersions = Object.freeze(Object.keys(schemas));
