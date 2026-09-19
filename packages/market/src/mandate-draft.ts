import { canonicalJson, parseMoney, validateBuyerMandate } from '../../protocol/src/index.ts';
import { accountBalance } from '../../ledger/src/index.ts';
import { ensure, wire, type Document, type Transaction } from '../../storage/src/index.ts';
import type { MarketConfig } from './service.ts';

export const draftEditableFields = ['criteria', 'assay', 'economics', 'license', 'funding', 'expires_at', 'license_template_id'] as const;

/** PATCH replaces complete supplied sections; omitted top-level sections are preserved. */
export function validateDraftPatch(input: Document): void {
  canonicalJson(input);
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_MANDATE_EDIT');
  const keys = Object.keys(input);
  ensure(keys.some(key => key !== 'expected_revision'), 'EMPTY_MANDATE_EDIT');
  ensure(keys.every(key => draftEditableFields.includes(key as typeof draftEditableFields[number]) || key === 'expected_revision'), 'MANDATE_FIELD_NOT_EDITABLE');
  if (Object.hasOwn(input, 'expected_revision')) ensure(Number.isSafeInteger(input.expected_revision) && input.expected_revision >= 1, 'INVALID_MANDATE_REVISION');
}

export function currentDraftInput(record: Document): Document {
  const editable: Document = {};
  for (const field of draftEditableFields) if (Object.hasOwn(record, field)) editable[field] = structuredClone(record[field]);
  editable.funding = { mode: record.funding.mode };
  return editable;
}

/** Shared create/edit validation. Buyer identity, balances and state are never client fields. */
export function buildDraftMandate(input: Document, identity: { mandateId: string; buyerId: string }, config: MarketConfig, now: string): Document {
  canonicalJson(input);
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_MANDATE_INPUT');
  ensure(Object.keys(input).every(key => draftEditableFields.includes(key as typeof draftEditableFields[number])), 'MANDATE_FIELD_NOT_EDITABLE');
  const funding = Object.hasOwn(input, 'funding') ? input.funding : { mode: 'offchain_escrow' };
  ensure(funding && typeof funding === 'object' && !Array.isArray(funding) && Object.keys(funding).every(key => key === 'mode'), 'FUNDING_FIELDS_MANAGED');
  ensure(input.economics && typeof input.economics === 'object' && !Array.isArray(input.economics) && ['currency', 'unit_price_minor', 'total_budget_minor', 'max_units', 'direct_cost_policy_id'].every(field => Object.hasOwn(input.economics, field)), 'INVALID_MANDATE_ECONOMICS');
  const { license_template_id: templateId, ...body } = input;
  const mandate = {
    ...body, schema_version: 'trace.mandate/1', mandate_id: identity.mandateId, buyer_id: identity.buyerId, status: 'draft',
    economics: { ...input.economics, unit_price_minor: parseMoney(input.economics?.unit_price_minor), total_budget_minor: parseMoney(input.economics?.total_budget_minor) },
    funding: { ...funding, funded_minor: 0n },
  };
  validateBuyerMandate(mandate);
  ensure(Date.parse(mandate.expires_at) > Date.parse(now), 'MANDATE_EXPIRED');
  const economics = mandate.economics;
  ensure(economics.unit_price_minor !== undefined && economics.unit_price_minor > 0n && economics.total_budget_minor >= economics.unit_price_minor, 'INVALID_PRICE');
  ensure(economics.unit_price_minor < 10n ** 78n && economics.total_budget_minor < 10n ** 78n, 'AMOUNT_TOO_LARGE');
  ensure(economics.direct_cost_policy_id === 'direct-costs/v1', 'UNKNOWN_COST_POLICY');
  ensure(!mandate.license.exclusive || config.exclusivity, 'EXCLUSIVITY_DISABLED');
  ensure(typeof templateId === 'string' && Object.hasOwn(config.approvedLicenseTemplates, templateId) && config.approvedLicenseTemplates[templateId], 'LICENSE_TEMPLATE_NOT_APPROVED');
  ensure(mandate.license.retention_days >= 1, 'INVALID_LICENSE_RETENTION');
  if (templateId === 'development-research-v1') {
    ensure(mandate.license.purpose === 'research' && !mandate.license.model_training && !mandate.license.onward_transfer && !mandate.license.exclusive && mandate.license.retention_days <= 30, 'LICENSE_TEMPLATE_MISMATCH');
  }
  ensure(mandate.assay.assay_id === 'safe-features' && mandate.assay.version === '1', 'ASSAY_NOT_APPROVED');
  ensure(mandate.assay.input_scope === 'safe-features-v1' && mandate.assay.output_schema === 'accepted-score-relevance/1', 'ASSAY_CONTRACT_MISMATCH');
  ensure(mandate.assay.threshold >= 0 && mandate.assay.threshold <= 1, 'INVALID_ASSAY_THRESHOLD');
  ensure(!mandate.criteria.topic_query, 'SEMANTIC_TOPIC_SEARCH_NOT_CONFIGURED');
  ensure(mandate.criteria.provenance_tiers.length > 0 && mandate.criteria.provenance_tiers.length <= 4 && new Set(mandate.criteria.provenance_tiers).size === mandate.criteria.provenance_tiers.length, 'INVALID_PROVENANCE_FILTER');
  ensure(mandate.criteria.workflow_types.length <= 8 && new Set(mandate.criteria.workflow_types).size === mandate.criteria.workflow_types.length, 'INVALID_WORKFLOW_FILTER');
  ensure(mandate.criteria.rights_required.length > 0 && mandate.criteria.rights_required.every(value => ['eligible', 'eligible_with_restrictions'].includes(value)), 'INVALID_RIGHTS_FILTER');
  for (const requirement of mandate.criteria.credential_predicates ?? []) {
    ensure(['workplace_cohort', 'professional_cohort', 'brokerage_control'].includes(requirement.type), 'UNSUPPORTED_CREDENTIAL_PREDICATE');
    ensure(requirement.accepted_values.length > 0 && requirement.accepted_values.every(value => requirement.type==='brokerage_control'?value==='controls_brokerage:true':/^cohort:[a-z0-9_:-]{1,120}$/.test(value)), 'INVALID_CREDENTIAL_VALUES');
  }
  for (const requirement of mandate.criteria.outcome_predicates ?? []) {
    ensure(['security_traded', 'security_held', 'security_action'].includes(requirement.type), 'UNSUPPORTED_OUTCOME_PREDICATE');
    ensure(!requirement.security_ids || requirement.security_ids.every(value => /^[a-z0-9_-]+:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(value)), 'SECURITY_MAPPING_REQUIRED');
  }
  return { ...wire(mandate), license_template_id: templateId };
}

/** Every independent funding/sale signal must agree this is an uncommitted draft. */
export async function assertUnfundedDraft(tx: Transaction, mandate: Document): Promise<void> {
  ensure(mandate.status === 'draft' && mandate.units_sold === 0 && parseMoney(mandate.spent_minor) === 0n, 'MANDATE_IMMUTABLE', 409);
  ensure(parseMoney(mandate.funding.funded_minor) === 0n, 'FUNDED_DRAFT_IMMUTABLE', 409);
  const funding = await tx.sql.query("SELECT id FROM mandate_funding WHERE document->>'mandate_id'=$1 LIMIT 1", [mandate.mandate_id]);
  ensure(funding.rows.length === 0, 'FUNDED_DRAFT_IMMUTABLE', 409);
  for (const currency of ['USD', 'USDC', 'THOT'] as const) ensure(await accountBalance(tx, currency, mandate.mandate_id, 'LIABILITY:buyer_escrow') === 0n, 'FUNDED_DRAFT_IMMUTABLE', 409);
  const licenses = await tx.sql.query("SELECT id FROM licenses WHERE document->>'mandate_id'=$1 LIMIT 1", [mandate.mandate_id]);
  const candidates = await tx.sql.query("SELECT id FROM mandate_candidates WHERE document->>'mandate_id'=$1 LIMIT 1", [mandate.mandate_id]);
  ensure(licenses.rows.length === 0 && candidates.rows.length === 0, 'MANDATE_IMMUTABLE', 409);
}
