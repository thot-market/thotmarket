-- Owner-only QC metadata. Reports and reviewer assertions live in the encrypted vault.
CREATE TABLE trace_qc_runs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
 document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trace_qc_runs_owner_trace ON trace_qc_runs(owner_id,(document->>'trace_id'));
CREATE TABLE trace_qc_reviews (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
 document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trace_qc_reviews_owner_trace ON trace_qc_reviews(owner_id,(document->>'trace_id'));
