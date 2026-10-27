-- Keep login maintenance and marketplace reads bounded by the relevant records.
-- Additive indexes only: no authorization, balances, records or limits change.
CREATE INDEX auth_access_kind_idx ON auth_access ((document->>'kind'));
CREATE INDEX auth_access_expiry_idx ON auth_access (((document->>'expires_at')::numeric))
 WHERE document->>'kind' IN ('wallet_challenge','wallet_session','qc_session','jwt_revocation');
CREATE INDEX auth_access_rate_expiry_idx ON auth_access (((document->>'window_end')::numeric))
 WHERE document->>'kind'='wallet_challenge_rate';
CREATE INDEX auth_access_wallet_subject_idx ON auth_access
 ((document->>'issuer'),(document->>'subject'),((document->>'issued_at')::numeric),id)
 WHERE document->>'kind'='wallet_session';
CREATE INDEX thot_records_kind_owner_idx ON thot_records ((document->>'kind'),owner_id);
CREATE INDEX thot_records_wallet_address_idx ON thot_records (lower(document->>'address'))
 WHERE document->>'kind'='wallet';
