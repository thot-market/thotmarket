// Protocol v1 field names are intentionally brand-neutral.
// bigint money values are canonical decimal strings when serialized on the wire.

export type ProvenanceReceipt = {
  schema_version: "trace.provenance/1";
  receipt_id: string;
  trace_id: string;
  path: "attested_proxy" | "attested_sandbox" | "browser" | "mobile" | "legacy_import" | "operator_capture";
  confidence_tier: "P0_OPERATOR" | "P1_WITNESSED" | "P2_TEE" | "P3_UPSTREAM";
  upstream?: { host?: string; model_claim?: string; provider_claim?: string };
  temporal: { not_before?: string; observed_start?: string; observed_end?: string; not_after?: string };
  commitments: { raw_trace_hash?: string; session_root?: string; source_bundle_hash: string };
  attestation?: {
    tee_type?: "intel_tdx" | "nitro" | "confidential_space" | "other";
    measurement_set_id?: string;
    quote_hash?: string;
    quote_verification_status?: "valid" | "invalid" | "unknown";
  };
  claims: string[];
  limitations: string[];
  verifier: { implementation: string; version: string; verified_at: string };
};

export type CredentialReceipt = {
  schema_version: "trace.credential/1";
  receipt_id: string;
  owner_user_id: string;
  pseudonymous_subject_id: string;
  provider: string;
  provider_method: string;
  predicate_type: string;
  predicate_value: string; // e.g. cohort:law_firm_eligible_v1
  verified_at: string;
  valid_until?: string;
  revoked_at?: string;
  source_evidence_hash?: string;
  issuer_key_id: string;
  signature: string;
  claims: string[];
  limitations: string[];
};

export type OutcomeReceipt = {
  schema_version: "trace.outcome/1";
  receipt_id: string;
  owner_user_id: string;
  trace_id?: string;
  provider: string;
  pseudonymous_subject_id: string;
  predicate: {
    type: "security_traded" | "security_held" | "security_action" | "delayed_return_bucket" | "custom";
    security_id?: string;
    window_start?: string;
    window_end?: string;
    action?: "buy" | "sell" | "hold";
    return_bucket?: string;
    custom_value?: string;
  };
  evidence_time: string;
  source_evidence_hash: string;
  disclosure_scope_id: string;
  issuer_key_id: string;
  signature: string;
  claims: string[];
  limitations: string[];
};

export type RightsAssessment = {
  schema_version: "trace.rights/1";
  assessment_id: string;
  trace_id: string;
  policy_version: string;
  status: "eligible" | "eligible_with_restrictions" | "manual_review" | "rejected";
  flags: Array<
    "secret" | "pii_dense" | "privileged_legal" | "client_confidential" |
    "employer_confidential" | "third_party_document" | "mnpi_like" |
    "financial_account_sensitive" | "upstream_terms_risk" | "unknown_rights"
  >;
  permitted_components: string[];
  prohibited_components: string[];
  engine_version: string;
  generated_at: string;
};

export type TraceFeatures = {
  schema_version: "trace.features/1";
  trace_id: string;
  topic_labels: string[];
  workflow_type: "coding" | "research" | "investment_research" | "legal_research" | "contract_review" | "chat" | "agent" | "other";
  model_family?: string;
  language?: string;
  counts: { turns: number; human_tokens?: number; model_tokens?: number; tool_calls?: number };
  signals: { correction_density?: number; tool_diversity?: number; outcome_density?: number; duplication_score?: number };
  available_predicates: { credential_types: string[]; outcome_types: string[] };
  rights_status: RightsAssessment["status"];
  provenance_tier: ProvenanceReceipt["confidence_tier"];
  feature_model_version: string;
};

export type UserPolicy = {
  schema_version: "trace.user-policy/1";
  policy_id: string;
  owner_user_id: string;
  version: number;
  mode: "manual_approval" | "standing_authorization";
  allowed_categories: string[];
  prohibited_categories: string[];
  allowed_buyers?: string[];
  prohibited_buyers?: string[];
  allowed_purposes: string[];
  prohibited_purposes: string[];
  evidence_disclosure: {
    trace_body: boolean;
    credential_predicate_types: string[];
    outcome_predicate_types: string[];
    identity_disclosure: boolean;
  };
  license_defaults: {
    exclusive: boolean;
    max_retention_days?: number;
    onward_transfer: boolean;
    model_training: boolean;
  };
  payout_preference: "inference_credit" | "token" | "ask_each_sale";
  effective_at: string;
  expires_at?: string;
};

export type BuyerMandate = {
  schema_version: "trace.mandate/1";
  mandate_id: string;
  buyer_id: string;
  status: "draft" | "pending_funding" | "funded" | "active" | "paused" | "exhausted" | "expired" | "closed";
  criteria: {
    provenance_tiers: string[];
    date_range?: { start: string; end: string };
    workflow_types: string[];
    topic_query?: string;
    credential_predicates?: Array<{ type: string; accepted_values: string[]; freshness_days?: number }>;
    outcome_predicates?: Array<{ type: string; security_ids?: string[]; max_lag_days?: number }>;
    rights_required: string[];
  };
  assay: { assay_id: string; version: string; threshold: number; input_scope: string; output_schema: string };
  economics: {
    currency: "USDC" | "USD";
    unit_price_minor?: bigint;
    max_units: number;
    total_budget_minor: bigint;
    direct_cost_policy_id: string;
  };
  license: {
    purpose: string;
    model_training: boolean;
    onward_transfer: boolean;
    exclusive: boolean;
    retention_days: number;
  };
  funding: { mode: "offchain_escrow" | "onchain_escrow"; funding_reference?: string; funded_minor: bigint };
  expires_at: string;
};

export type AssayReceipt = {
  schema_version: "trace.assay/1";
  assay_receipt_id: string;
  mandate_id: string;
  trace_id: string;
  assay_id: string;
  assay_version: string;
  assay_commitment: string;
  input_hash: string;
  result: "accepted" | "rejected" | "error";
  score?: number;
  bounded_labels?: Record<string, string | number | boolean>;
  output_hash: string;
  executed_at: string;
  environment_measurement?: string;
  signature: string;
};

export type SaleAuthorization = {
  schema_version: "trace.sale-auth/1";
  authorization_id: string;
  owner_user_id: string;
  trace_id: string;
  mandate_id: string;
  release_artifact_hash: string;
  credential_receipt_ids: string[];
  outcome_receipt_ids: string[];
  license_hash: string;
  expected_gross_minor: bigint;
  expected_direct_costs_max_minor: bigint;
  payout_preference: "inference_credit" | "token";
  authorized_at: string;
  expires_at: string;
  auth_method: "account_session" | "passkey" | "wallet_signature";
  auth_evidence: string;
};

export type SaleSettlement = {
  schema_version: "trace.settlement/1";
  settlement_id: string;
  license_id: string;
  gross_minor: bigint;
  direct_costs_minor: bigint;
  eligible_net_minor: bigint;
  contributor_minor: bigint;
  burn_minor: bigint;
  operator_minor: bigint;
  split_policy_id: string;
  contributor_disposition: "pending" | "inference_credit" | "token_purchase";
  created_at: string;
};

export type ProtocolObject = ProvenanceReceipt | CredentialReceipt | OutcomeReceipt | RightsAssessment | TraceFeatures | UserPolicy | BuyerMandate | AssayReceipt | SaleAuthorization | SaleSettlement;
