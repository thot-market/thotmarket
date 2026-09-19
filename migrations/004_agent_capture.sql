CREATE TABLE agent_captures (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_captures_owner_idx ON agent_captures(owner_id);

