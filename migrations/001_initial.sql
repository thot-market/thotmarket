-- THOT schema v1. Monetary wire values are strings; journals use exact NUMERIC.
CREATE TABLE schema_versions (version TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE service_lock (id INTEGER PRIMARY KEY);
INSERT INTO service_lock VALUES (1);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_owner_idx ON users(owner_id);
CREATE TABLE user_wallets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_wallets_owner_idx ON user_wallets(owner_id);
CREATE TABLE buyers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX buyers_owner_idx ON buyers(owner_id);
CREATE TABLE buyer_members (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX buyer_members_owner_idx ON buyer_members(owner_id);
CREATE TABLE trace_bundles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trace_bundles_owner_idx ON trace_bundles(owner_id);
CREATE TABLE traces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX traces_owner_idx ON traces(owner_id);
CREATE TABLE trace_objects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trace_objects_owner_idx ON trace_objects(owner_id);
CREATE TABLE provenance_receipts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provenance_receipts_owner_idx ON provenance_receipts(owner_id);
CREATE TABLE credential_receipts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credential_receipts_owner_idx ON credential_receipts(owner_id);
CREATE TABLE outcome_receipts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outcome_receipts_owner_idx ON outcome_receipts(owner_id);
CREATE TABLE rights_assessments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rights_assessments_owner_idx ON rights_assessments(owner_id);
CREATE TABLE scrub_receipts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scrub_receipts_owner_idx ON scrub_receipts(owner_id);
CREATE TABLE trace_features (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trace_features_owner_idx ON trace_features(owner_id);
CREATE TABLE user_policies (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_policies_owner_idx ON user_policies(owner_id);
CREATE TABLE sale_authorizations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sale_authorizations_owner_idx ON sale_authorizations(owner_id);
CREATE TABLE mandates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mandates_owner_idx ON mandates(owner_id);
CREATE TABLE mandate_funding (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mandate_funding_owner_idx ON mandate_funding(owner_id);
CREATE TABLE mandate_candidates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mandate_candidates_owner_idx ON mandate_candidates(owner_id);
CREATE TABLE assay_receipts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assay_receipts_owner_idx ON assay_receipts(owner_id);
CREATE TABLE release_artifacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX release_artifacts_owner_idx ON release_artifacts(owner_id);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX licenses_owner_idx ON licenses(owner_id);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_owner_idx ON deliveries(owner_id);
CREATE TABLE contributor_entitlements (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contributor_entitlements_owner_idx ON contributor_entitlements(owner_id);
CREATE TABLE inference_credit_reservations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inference_credit_reservations_owner_idx ON inference_credit_reservations(owner_id);
CREATE TABLE market_purchase_orders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX market_purchase_orders_owner_idx ON market_purchase_orders(owner_id);
CREATE TABLE token_transfers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX token_transfers_owner_idx ON token_transfers(owner_id);
CREATE TABLE burn_allocations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX burn_allocations_owner_idx ON burn_allocations(owner_id);
CREATE TABLE chain_transactions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chain_transactions_owner_idx ON chain_transactions(owner_id);
CREATE TABLE chain_event_cursor (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chain_event_cursor_owner_idx ON chain_event_cursor(owner_id);

CREATE UNIQUE INDEX trace_source_owner ON trace_bundles(owner_id,(document->>'source_bundle_hash'));
CREATE UNIQUE INDEX license_candidate ON licenses((document->>'candidate_id'));
CREATE UNIQUE INDEX funding_reference ON mandate_funding((document->>'funding_reference'));
CREATE UNIQUE INDEX candidate_pair ON mandate_candidates((document->>'mandate_id'),(document->>'trace_id')) WHERE document->>'status' NOT IN ('SUPERSEDED','DELETED');
CREATE UNIQUE INDEX entitlement_settlement ON contributor_entitlements((document->>'settlement_id'));
CREATE UNIQUE INDEX burn_settlement ON burn_allocations((document->>'settlement_id'));
CREATE TABLE sale_settlements (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, license_id TEXT UNIQUE NOT NULL REFERENCES licenses(id),
  gross NUMERIC(78,0) NOT NULL CHECK (gross >= 0),
  direct_costs NUMERIC(78,0) NOT NULL CHECK (direct_costs >= 0 AND direct_costs <= gross),
  contributor NUMERIC(78,0) NOT NULL CHECK (contributor >= 0),
  burn NUMERIC(78,0) NOT NULL CHECK (burn >= 0),
  operator NUMERIC(78,0) NOT NULL CHECK (operator >= 0),
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(gross - direct_costs = contributor + burn + operator)
);
CREATE TABLE ledger_accounts (
  id TEXT PRIMARY KEY, currency TEXT NOT NULL CHECK(currency IN ('USD','USDC','THOT')),
  kind TEXT NOT NULL CHECK(kind IN ('ASSET','LIABILITY','REVENUE','EXPENSE')), owner_id TEXT NOT NULL
);
CREATE TABLE ledger_transactions (
  id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, currency TEXT NOT NULL,
  fingerprint TEXT NOT NULL, creation_transaction_id BIGINT NOT NULL DEFAULT txid_current(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id), amount NUMERIC(78,0) NOT NULL
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id);
CREATE FUNCTION prevent_late_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM ledger_transactions WHERE id=NEW.transaction_id AND creation_transaction_id=txid_current()) THEN
   RAISE EXCEPTION 'cannot append entries to a committed journal';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_entries_same_transaction BEFORE INSERT ON ledger_entries
 FOR EACH ROW EXECUTE FUNCTION prevent_late_journal_entry();
CREATE FUNCTION check_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total NUMERIC; count_entries INTEGER; mixed INTEGER;
BEGIN
 SELECT COALESCE(SUM(e.amount),0),COUNT(*),COUNT(*) FILTER (WHERE a.currency <> NEW.currency)
 INTO total,count_entries,mixed FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE transaction_id=NEW.id;
 IF total <> 0 OR count_entries < 2 OR mixed <> 0 THEN
   RAISE EXCEPTION 'journal must balance, have two entries, and use one currency';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER balanced_journal AFTER INSERT ON ledger_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced_journal();
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE idempotency_keys (
  actor_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,key)
);
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable append-only record'; END $$;
CREATE TRIGGER trace_bundles_immutable BEFORE UPDATE OR DELETE ON trace_bundles FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER provenance_receipts_immutable BEFORE UPDATE OR DELETE ON provenance_receipts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER credential_receipts_immutable BEFORE UPDATE OR DELETE ON credential_receipts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER outcome_receipts_immutable BEFORE UPDATE OR DELETE ON outcome_receipts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER rights_assessments_immutable BEFORE UPDATE OR DELETE ON rights_assessments FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER scrub_receipts_immutable BEFORE UPDATE OR DELETE ON scrub_receipts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER user_policies_immutable BEFORE UPDATE OR DELETE ON user_policies FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER sale_authorizations_immutable BEFORE UPDATE OR DELETE ON sale_authorizations FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER mandate_funding_immutable BEFORE UPDATE OR DELETE ON mandate_funding FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER assay_receipts_immutable BEFORE UPDATE OR DELETE ON assay_receipts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER release_artifacts_immutable BEFORE UPDATE OR DELETE ON release_artifacts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER licenses_immutable BEFORE UPDATE OR DELETE ON licenses FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER sale_settlements_immutable BEFORE UPDATE OR DELETE ON sale_settlements FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_accounts_immutable BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
