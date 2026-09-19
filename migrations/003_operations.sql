-- Additive operational evidence and controls; existing money and protocol records remain unchanged.
CREATE TABLE inference_billing_evidence (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inference_billing_evidence_owner_idx ON inference_billing_evidence(owner_id);
CREATE UNIQUE INDEX inference_billing_evidence_identity_idx ON inference_billing_evidence((document->>'verifier_id'),(document->>'evidence_id'));
CREATE TRIGGER inference_billing_evidence_immutable BEFORE UPDATE OR DELETE ON inference_billing_evidence FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TABLE inference_billing_reviews (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inference_billing_reviews_owner_idx ON inference_billing_reviews(owner_id);
CREATE UNIQUE INDEX inference_billing_reviews_evidence_idx ON inference_billing_reviews((document->>'evidence_record_id'));
CREATE TRIGGER inference_billing_reviews_immutable BEFORE UPDATE OR DELETE ON inference_billing_reviews FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TABLE auth_access (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_access_owner_idx ON auth_access(owner_id);
CREATE TABLE operational_controls (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
