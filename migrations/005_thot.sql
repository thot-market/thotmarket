-- Separate v0.7 records; legacy demo ledgers are not THOT settlement evidence.
CREATE TABLE thot_records (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
 document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX thot_records_owner_idx ON thot_records(owner_id);
