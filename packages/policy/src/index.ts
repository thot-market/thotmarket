import { canonicalHash, uuidv7 } from '../../protocol/src/index.ts';

export type RightsFlag = 'secret' | 'pii_dense' | 'privileged_legal' | 'client_confidential' | 'employer_confidential' | 'third_party_document' | 'mnpi_like' | 'financial_account_sensitive' | 'upstream_terms_risk' | 'unknown_rights';
export interface RightsAssessment {
  schema_version: 'trace.rights/1'; assessment_id: string; trace_id: string; policy_version: string;
  status: 'eligible' | 'eligible_with_restrictions' | 'manual_review' | 'rejected'; flags: RightsFlag[];
  permitted_components: string[]; prohibited_components: string[]; engine_version: string; generated_at: string;
}
export interface UserPolicy {
  schema_version: 'trace.user-policy/1'; policy_id: string; owner_user_id: string; version: number;
  mode: 'manual_approval' | 'standing_authorization'; allowed_categories: string[]; prohibited_categories: string[];
  allowed_buyers?: string[]; prohibited_buyers?: string[]; allowed_purposes: string[]; prohibited_purposes: string[];
  evidence_disclosure: { trace_body: boolean; credential_predicate_types: string[]; outcome_predicate_types: string[]; identity_disclosure: boolean };
  license_defaults: { exclusive: boolean; max_retention_days?: number; onward_transfer: boolean; model_training: boolean };
  payout_preference: 'inference_credit' | 'token' | 'ask_each_sale'; effective_at: string; expires_at?: string;
}
const ALL_FLAGS: RightsFlag[] = ['secret', 'pii_dense', 'privileged_legal', 'client_confidential', 'employer_confidential', 'third_party_document', 'mnpi_like', 'financial_account_sensitive', 'upstream_terms_risk', 'unknown_rights'];
const HARD_REJECT = new Set<RightsFlag>(['secret', 'privileged_legal', 'client_confidential', 'employer_confidential', 'mnpi_like', 'financial_account_sensitive']);

/** Consumes explicit declarations/classifier flags; does not pretend to infer legal rights. */
export function evaluateRights(input: { traceId: string; flags: RightsFlag[]; professionalFlow?: boolean; rightsConfirmed: boolean; components?: string[]; now?: string }): RightsAssessment {
  if (!Array.isArray(input.flags) || input.flags.some(flag => !ALL_FLAGS.includes(flag))) throw new Error('UNSUPPORTED_RIGHTS_FLAG');
  const flags = [...new Set(input.flags)];
  if (!input.rightsConfirmed && !flags.includes('unknown_rights')) flags.push('unknown_rights');
  const rejected = flags.some(flag => HARD_REJECT.has(flag)) || (input.professionalFlow === true && flags.includes('unknown_rights'));
  const review = flags.some(flag => ['unknown_rights', 'third_party_document', 'upstream_terms_risk', 'pii_dense'].includes(flag));
  const components = input.components ?? ['user', 'tool'];
  const blocked = rejected || review;
  return { schema_version: 'trace.rights/1', assessment_id: uuidv7(), trace_id: input.traceId, policy_version: 'thot-rights-strict-v1', status: rejected ? 'rejected' : review ? 'manual_review' : 'eligible', flags, permitted_components: blocked ? [] : [...components], prohibited_components: blocked ? [...components] : [], engine_version: 'deterministic-declarations-and-secret-rules/1', generated_at: input.now ?? new Date().toISOString() };
}

export interface PolicyRequest {
  ownerUserId: string; buyerId: string; category: string; purpose: string;
  license: { exclusive: boolean; retention_days: number; onward_transfer: boolean; model_training: boolean };
  disclosure: { trace_body: boolean; credential_predicate_types: string[]; outcome_predicate_types: string[]; identity_disclosure: boolean };
  rights: RightsAssessment; now?: string; requireStandingAuthorization?: boolean;
  componentRoles?: Array<'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function'>; modelOutputLicensed?: boolean;
}
export function evaluatePolicy(policy: UserPolicy | undefined | null, request: PolicyRequest): { allowed: boolean; reasons: string[]; policyVersion?: number; policyHash?: string } {
  const reasons: string[] = [];
  if (!policy) return { allowed: false, reasons: ['NO_USER_POLICY'] };
  if (policy.schema_version !== 'trace.user-policy/1' || policy.owner_user_id !== request.ownerUserId || !Number.isSafeInteger(policy.version) || policy.version < 1) reasons.push('INVALID_USER_POLICY');
  const now = Date.parse(request.now ?? new Date().toISOString());
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(policy.effective_at)) || Date.parse(policy.effective_at) > now || (policy.expires_at !== undefined && (!Number.isFinite(Date.parse(policy.expires_at)) || Date.parse(policy.expires_at) <= now))) reasons.push('POLICY_NOT_EFFECTIVE');
  if (!['eligible', 'eligible_with_restrictions'].includes(request.rights.status) || request.rights.flags.some(flag => HARD_REJECT.has(flag))) reasons.push('RIGHTS_DENIED');
  if (request.requireStandingAuthorization && policy.mode !== 'standing_authorization') reasons.push('EXPLICIT_AUTHORIZATION_REQUIRED');
  if (!policy.allowed_categories.includes(request.category) || policy.prohibited_categories.includes(request.category)) reasons.push('CATEGORY_DENIED');
  if ((policy.allowed_buyers && !policy.allowed_buyers.includes(request.buyerId)) || policy.prohibited_buyers?.includes(request.buyerId)) reasons.push('BUYER_DENIED');
  if (!policy.allowed_purposes.includes(request.purpose) || policy.prohibited_purposes.includes(request.purpose)) reasons.push('PURPOSE_DENIED');
  const license = request.license; const defaults = policy.license_defaults;
  if (!Number.isSafeInteger(license.retention_days) || license.retention_days < 1 || (defaults.max_retention_days !== undefined && license.retention_days > defaults.max_retention_days) || (license.exclusive && !defaults.exclusive) || (license.onward_transfer && !defaults.onward_transfer) || (license.model_training && !defaults.model_training)) reasons.push('LICENSE_SCOPE_DENIED');
  const granted = policy.evidence_disclosure; const wanted = request.disclosure;
  if ((wanted.trace_body && !granted.trace_body) || (wanted.identity_disclosure && !granted.identity_disclosure) || wanted.credential_predicate_types.some(type => !granted.credential_predicate_types.includes(type)) || wanted.outcome_predicate_types.some(type => !granted.outcome_predicate_types.includes(type))) reasons.push('EVIDENCE_SCOPE_DENIED');
  if (request.componentRoles?.some(role => request.rights.prohibited_components.includes(role) || !request.rights.permitted_components.includes(role))) reasons.push('COMPONENT_RIGHTS_DENIED');
  if (request.componentRoles?.includes('assistant') && !request.modelOutputLicensed) reasons.push('MODEL_OUTPUT_LICENSE_REQUIRED');
  return { allowed: reasons.length === 0, reasons, policyVersion: policy.version, policyHash: canonicalHash(policy) };
}
