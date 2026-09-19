-- Additive only: retain all v1 records and immutable settlement journals.
CREATE TABLE inference_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (document->>'status' IN ('QUEUED','PROCESSING','COMPLETED','INCOMPLETE','FAILED','UNCERTAIN','CANCELLED'))
);
CREATE INDEX inference_requests_owner_idx ON inference_requests(owner_id);
CREATE UNIQUE INDEX inference_requests_reservation_idx ON inference_requests((document->>'reservation_id'));
CREATE UNIQUE INDEX inference_requests_provider_response_idx ON inference_requests((document->>'provider'),(document->>'provider_response_id'))
  WHERE document->>'provider_response_id' IS NOT NULL;
