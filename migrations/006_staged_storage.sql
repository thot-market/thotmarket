-- Durable fencing and ciphertext references only; never plaintext or model credentials.
CREATE TABLE storage_command_claims (
  actor_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  attempt_id TEXT,
  PRIMARY KEY(actor_id,key)
);
CREATE TABLE storage_write_attempts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','abandoned')),
  expires_at TIMESTAMPTZ NOT NULL,
  objects JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(objects)='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX storage_write_attempts_cleanup ON storage_write_attempts(status,expires_at);

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_status_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_check CHECK(status IN ('pending','processing','done','failed'));
ALTER TABLE outbox_events ADD COLUMN claim_token TEXT;
