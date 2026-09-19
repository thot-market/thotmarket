#!/usr/bin/env python3
"""Verify and issue narrowly-scoped Robinhood account-control credentials.

Raw Robinhood JSON is deliberately not accepted by the public issue path.  An
account fact must first pass the witness, TLS, HTTP, ticket, and schema checks.
"""
import argparse
import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import zlib
from email.utils import parsedate_to_datetime

import attest
import reveal
from attestation_verify import verify_attested_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from link_ticket import verify_ticket

HOST = "api.robinhood.com"
CAPTURE_SCHEMA = "trace-vault.robinhood-capture/1"
CREDENTIAL_PURPOSE = "trace-vault.credential.robinhood-account-control.v1"
MAX_CIPHERTEXT = 16 * 1024 * 1024
MAX_BODY = 8 * 1024 * 1024


class EvidenceError(ValueError):
    """A stable, non-secret-bearing evidence validation failure."""


def _fail(code):
    raise EvidenceError(code)


def _hex(value, name, maximum=MAX_CIPHERTEXT):
    if not isinstance(value, str):
        _fail("invalid_" + name)
    try:
        out = bytes.fromhex(value)
    except ValueError:
        _fail("invalid_" + name)
    if not out or len(out) > maximum:
        _fail("invalid_" + name)
    return out


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            _fail("duplicate_json_key")
        out[key] = value
    return out


def _chunked(data):
    out = bytearray()
    while True:
        line, sep, data = data.partition(b"\r\n")
        if not sep or b";" in line:
            _fail("invalid_chunk_framing")
        try:
            size = int(line, 16)
        except ValueError:
            _fail("invalid_chunk_framing")
        if size == 0:
            if data != b"\r\n":
                _fail("chunk_trailers_or_extra_data")
            return bytes(out)
        if size > MAX_BODY or len(out) + size > MAX_BODY or len(data) < size + 2:
            _fail("body_too_large_or_truncated")
        out += data[:size]
        if data[size:size + 2] != b"\r\n":
            _fail("invalid_chunk_framing")
        data = data[size + 2:]


def parse_http_json(plaintext):
    """Parse exactly one successful, bounded HTTP/1.1 JSON response."""
    if not plaintext or len(plaintext) > MAX_CIPHERTEXT:
        _fail("empty_or_oversized_plaintext")
    head, sep, rest = plaintext.partition(b"\r\n\r\n")
    if not sep:
        _fail("missing_http_headers")
    lines = head.split(b"\r\n")
    if not lines or not lines[0].startswith(b"HTTP/1.1 200 "):
        _fail("http_status_not_200")
    headers = {}
    for raw in lines[1:]:
        name, colon, value = raw.partition(b":")
        if not colon or not name:
            _fail("invalid_http_header")
        try:
            key = name.decode("ascii").lower()
            val = value.strip().decode("latin1")
        except UnicodeDecodeError:
            _fail("invalid_http_header")
        if key in headers:
            _fail("duplicate_http_header")
        headers[key] = val
    ctype = headers.get("content-type", "").lower()
    if not ctype.startswith("application/json"):
        _fail("content_type_not_json")
    has_len, has_chunk = "content-length" in headers, headers.get("transfer-encoding", "").lower() == "chunked"
    if has_len == has_chunk or ("transfer-encoding" in headers and not has_chunk):
        _fail("ambiguous_http_framing")
    if has_len:
        try:
            length = int(headers["content-length"])
        except ValueError:
            _fail("invalid_content_length")
        if length < 0 or length > MAX_BODY or len(rest) != length:
            _fail("body_length_mismatch")
        body = rest
    else:
        body = _chunked(rest)
    encoding = headers.get("content-encoding", "").lower()
    if encoding:
        if encoding != "gzip":
            _fail("unsupported_content_encoding")
        dec = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            body = dec.decompress(body, MAX_BODY + 1)
        except zlib.error:
            _fail("invalid_gzip")
        if len(body) > MAX_BODY or not dec.eof or dec.unused_data or dec.unconsumed_tail:
            _fail("invalid_or_oversized_gzip")
    try:
        parsed = json.loads(body.decode("utf-8"), object_pairs_hook=_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("invalid_json")
    try:
        observed = parsedate_to_datetime(headers["date"])
    except (KeyError, TypeError, ValueError):
        _fail("invalid_or_missing_date")
    if observed.tzinfo is None:
        _fail("invalid_or_missing_date")
    return parsed, observed.astimezone(dt.timezone.utc)


def _verify_receipt_signature(receipt):
    payload = {k: v for k, v in receipt.items() if k not in ("signature", "attestation")}
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(receipt["witness_pubkey"])).verify(
            bytes.fromhex(receipt["signature"]), attest.canon(payload))
    except Exception:
        _fail("invalid_witness_signature")


def verify_witness_production(receipt):
    """Verify against the Appraiser's configured, measured Witness trust set."""
    if receipt.get("attestation", {}).get("mode") != "tdx":
        _fail("witness_attestation_not_tdx")
    try:
        verify_attested_key(receipt["attestation"], receipt["witness_pubkey"], "witness",
                            qvl=os.environ.get("TV_DCAP_QVL", "/usr/local/bin/dcap-qvl"))
    except Exception:
        _fail("witness_attestation_invalid")
    return True


def verify_account_bundle(bundle, thot_public_key_pem, witness_verifier=None, now=None):
    """Return only validated facts plus private account URL for in-enclave issuance."""
    if not isinstance(bundle, dict) or bundle.get("schema_version") != CAPTURE_SCHEMA:
        _fail("invalid_capture_schema")
    receipt = bundle.get("receipt")
    if not isinstance(receipt, dict):
        _fail("missing_witness_receipt")
    _verify_receipt_signature(receipt)
    (witness_verifier or verify_witness_production)(receipt)
    if receipt.get("upstream_host") != HOST or receipt.get("sni") != HOST or receipt.get("upstream_port", 443) != 443:
        _fail("wrong_upstream")
    ticket = bundle.get("link_ticket")
    try:
        capture_start = dt.datetime.fromisoformat(receipt["t_start"].replace("Z", "+00:00"))
        capture_end = dt.datetime.fromisoformat(receipt["t_end"].replace("Z", "+00:00"))
        ticket_payload = verify_ticket(ticket, thot_public_key_pem, now=capture_start)
    except Exception:
        _fail("invalid_link_ticket")
    ticket_hash = hashlib.sha256(ticket.encode()).hexdigest()
    if not hmac.compare_digest(str(receipt.get("link_ticket_hash", "")), ticket_hash):
        _fail("link_ticket_receipt_mismatch")
    down = _hex(bundle.get("cipher_down"), "cipher_down")
    hello = _hex(bundle.get("client_hello"), "client_hello", 65536)
    if not hmac.compare_digest(hashlib.sha256(down).hexdigest(), str(receipt.get("h_cipher_down", ""))):
        _fail("ciphertext_hash_mismatch")
    if not hmac.compare_digest(hashlib.sha256(hello).hexdigest(), str(receipt.get("h_client_hello", ""))):
        _fail("client_hello_hash_mismatch")
    secrets = bundle.get("secrets") or {}
    if not isinstance(secrets, dict) or set(secrets) != {"SERVER_TRAFFIC_SECRET_0", "SERVER_HANDSHAKE_TRAFFIC_SECRET"}:
        _fail("invalid_server_secrets")
    app_secret = _hex(secrets.get("SERVER_TRAFFIC_SECRET_0"), "server_traffic_secret", 128)
    hs_secret = _hex(secrets.get("SERVER_HANDSHAKE_TRAFFIC_SECRET"), "server_handshake_secret", 128)
    suite = bundle.get("cipher_suite")
    if suite not in reveal.SUITES:
        _fail("unsupported_cipher_suite")
    try:
        reveal.verify_cert_chain(down, hello, hs_secret, suite, HOST)
        plaintext = reveal.decrypt_dir(down, app_secret, suite)
    except Exception:
        _fail("tls_reveal_invalid")
    data, observed = parse_http_json(plaintext)
    if capture_start.tzinfo is None or capture_end.tzinfo is None or capture_end < capture_start:
        _fail("invalid_witness_time")
    expiry = dt.datetime.fromisoformat(ticket_payload["expires_at"].replace("Z", "+00:00"))
    if capture_end >= expiry: _fail("capture_outside_ticket_window")
    if not capture_start - dt.timedelta(seconds=30) <= observed <= capture_end + dt.timedelta(seconds=30):
        _fail("response_time_outside_capture")
    if not isinstance(data, dict) or set(data) - {"results", "next", "previous"} or not isinstance(data.get("results"), list):
        _fail("invalid_accounts_schema")
    account_urls = []
    for account in data["results"]:
        if not isinstance(account, dict):
            _fail("invalid_accounts_schema")
        url = account.get("url")
        if not isinstance(url, str) or not url.startswith("https://api.robinhood.com/accounts/"):
            _fail("invalid_account_url")
        account_urls.append(url)
    if not account_urls:
        _fail("no_brokerage_account")
    return {"ticket": ticket_payload, "ticket_hash": ticket_hash, "observed_at": observed,
            "account_url": sorted(account_urls)[0], "receipt": receipt}


def issue_controls_brokerage(bundle, thot_public_key_pem, subject_key, witness_verifier=None, now=None):
    if os.environ.get("TV_ATTEST") != "tdx":
        _fail("appraiser_attestation_not_tdx")
    checked = verify_account_bundle(bundle, thot_public_key_pem, witness_verifier, now)
    subject = hmac.new(subject_key, checked["account_url"].encode(), hashlib.sha256).hexdigest()
    r, t = checked["receipt"], checked["ticket"]
    statement = {"purpose": CREDENTIAL_PURPOSE, "claim": "controls_brokerage", "value": True,
                 "observed_at": checked["observed_at"].isoformat().replace("+00:00", "Z"),
                 "owner_user_id": t["owner_user_id"], "job_id": t["job_id"],
                 "link_ticket_hash": checked["ticket_hash"], "subject": subject,
                 "vault_pubkey": attest.vault_pubkey(), "binding": {"host": HOST, "sessions": [{
                     "role": "accounts", "h_cipher_down": r["h_cipher_down"],
                     "h_client_hello": r["h_client_hello"], "witness_pubkey": r["witness_pubkey"],
                     "t_start": r["t_start"]}]}}
    return {**statement, "attestation": attest.attestation(), "signature": attest.sign(attest.canon(statement))}


def bounded_summary(credential):
    return {k: credential[k] for k in ("purpose", "claim", "value", "observed_at", "owner_user_id", "job_id",
                                        "link_ticket_hash", "subject", "vault_pubkey", "binding", "attestation", "signature")}


# --- Track B: witnessed traded-outcome credential (traded:<SYMBOL>:within_<N>d) ---------------
# The accounts path proves control; this proves a fill. It binds TWO witnessed sessions - the
# /orders/ list and the /instruments/{id}/ fetch that resolves the ticker - so the symbol mapping
# is itself witnessed, never asserted. The signed statement reveals only symbol + boolean + window;
# quantities, prices and the account never leave the enclave.
ORDERS_SCHEMA = "trace-vault.robinhood-orders-capture/1"
TRADED_PURPOSE = "trace-vault.credential.robinhood-traded-outcome.v1"


def _reveal_session(session, witness_verifier):
    receipt = session.get("receipt") if isinstance(session, dict) else None
    if not isinstance(receipt, dict):
        _fail("missing_witness_receipt")
    _verify_receipt_signature(receipt)
    (witness_verifier or verify_witness_production)(receipt)
    if receipt.get("upstream_host") != HOST or receipt.get("sni") != HOST or receipt.get("upstream_port", 443) != 443:
        _fail("wrong_upstream")
    down = _hex(session.get("cipher_down"), "cipher_down")
    hello = _hex(session.get("client_hello"), "client_hello", 65536)
    if not hmac.compare_digest(hashlib.sha256(down).hexdigest(), str(receipt.get("h_cipher_down", ""))):
        _fail("ciphertext_hash_mismatch")
    if not hmac.compare_digest(hashlib.sha256(hello).hexdigest(), str(receipt.get("h_client_hello", ""))):
        _fail("client_hello_hash_mismatch")
    secrets = session.get("secrets") or {}
    if not isinstance(secrets, dict) or set(secrets) != {"SERVER_TRAFFIC_SECRET_0", "SERVER_HANDSHAKE_TRAFFIC_SECRET"}:
        _fail("invalid_server_secrets")
    app_secret = _hex(secrets.get("SERVER_TRAFFIC_SECRET_0"), "server_traffic_secret", 128)
    hs_secret = _hex(secrets.get("SERVER_HANDSHAKE_TRAFFIC_SECRET"), "server_handshake_secret", 128)
    suite = session.get("cipher_suite")
    if suite not in reveal.SUITES:
        _fail("unsupported_cipher_suite")
    try:
        reveal.verify_cert_chain(down, hello, hs_secret, suite, HOST)
        plaintext = reveal.decrypt_dir(down, app_secret, suite)
    except Exception:
        _fail("tls_reveal_invalid")
    return parse_http_json(plaintext) + (receipt,)


def verify_orders_bundle(bundle, thot_public_key_pem, witness_verifier=None, now=None):
    if not isinstance(bundle, dict) or bundle.get("schema_version") != ORDERS_SCHEMA:
        _fail("invalid_capture_schema")
    ticket = bundle.get("link_ticket")
    orders_session, instrument_sessions = bundle.get("orders"), bundle.get("instruments")
    if not isinstance(orders_session, dict) or not isinstance(instrument_sessions, list) or not instrument_sessions:
        _fail("invalid_orders_bundle")
    if not isinstance(ticket, str):
        _fail("invalid_link_ticket")
    ticket_hash = hashlib.sha256(ticket.encode()).hexdigest()

    def _checked(session):
        data, observed, receipt = _reveal_session(session, witness_verifier)
        try:
            capture_start = dt.datetime.fromisoformat(receipt["t_start"].replace("Z", "+00:00"))
            capture_end = dt.datetime.fromisoformat(receipt["t_end"].replace("Z", "+00:00"))
            payload = verify_ticket(ticket, thot_public_key_pem, now=capture_start)
        except Exception:
            _fail("invalid_link_ticket")
        if not hmac.compare_digest(str(receipt.get("link_ticket_hash", "")), ticket_hash):
            _fail("link_ticket_receipt_mismatch")
        if capture_start.tzinfo is None or capture_end.tzinfo is None or capture_end < capture_start:
            _fail("invalid_witness_time")
        expiry = dt.datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
        if capture_end >= expiry:
            _fail("capture_outside_ticket_window")
        if not capture_start - dt.timedelta(seconds=30) <= observed <= capture_end + dt.timedelta(seconds=30):
            _fail("response_time_outside_capture")
        return data, observed, receipt, payload

    o_data, o_observed, o_receipt, o_ticket = _checked(orders_session)
    if (not isinstance(o_data, dict) or set(o_data) - {"results", "next", "previous"} or
            not isinstance(o_data.get("results"), list) or o_data.get("next") is not None or
            o_data.get("previous") is not None):
        _fail("invalid_orders_schema")
    instruments, instrument_receipts = {}, []
    for session in instrument_sessions:
        i_data, _, i_receipt, i_ticket = _checked(session)
        if not isinstance(i_data, dict) or not isinstance(i_data.get("id"), str) or not isinstance(i_data.get("symbol"), str):
            _fail("invalid_instrument_schema")
        if i_ticket["owner_user_id"] != o_ticket["owner_user_id"] or i_ticket["job_id"] != o_ticket["job_id"]:
            _fail("session_ticket_mismatch")
        if i_data["id"] in instruments and instruments[i_data["id"]]["symbol"] != i_data["symbol"]:
            _fail("conflicting_instrument_schema")
        instruments[i_data["id"]] = {"symbol": i_data["symbol"]}
        instrument_receipts.append(i_receipt)
    return {"ticket": o_ticket, "ticket_hash": ticket_hash, "observed_at": o_observed, "orders": o_data,
            "instruments": instruments, "orders_receipt": o_receipt, "instrument_receipts": instrument_receipts}


def issue_traded_outcome(bundle, thot_public_key_pem, symbol, window_days, trace_ts, witness_verifier=None, now=None):
    if os.environ.get("TV_ATTEST") != "tdx":
        _fail("appraiser_attestation_not_tdx")
    if not isinstance(symbol, str) or not symbol or not isinstance(window_days, int) or isinstance(window_days, bool) \
            or not 0 < window_days <= 365 or not isinstance(trace_ts, str):
        _fail("invalid_outcome_request")
    from credential_robinhood import compute_traded
    checked = verify_orders_bundle(bundle, thot_public_key_pem, witness_verifier, now)
    if symbol not in {v["symbol"] for v in checked["instruments"].values()}:
        _fail("symbol_not_witnessed")
    try:
        value = compute_traded(checked["orders"], checked["instruments"], symbol, trace_ts, window_days)
    except (KeyError, ValueError):
        _fail("invalid_orders_schema")
    t = checked["ticket"]
    sess = lambda r, role: {"role": role, "h_cipher_down": r["h_cipher_down"], "h_client_hello": r["h_client_hello"],
                            "witness_pubkey": r["witness_pubkey"], "t_start": r["t_start"]}
    statement = {"purpose": TRADED_PURPOSE, "claim": f"traded:{symbol}:within_{window_days}d", "symbol": symbol,
                 "window_days": window_days, "value": value, "trace_ts": trace_ts,
                 "observed_at": checked["observed_at"].isoformat().replace("+00:00", "Z"),
                 "owner_user_id": t["owner_user_id"], "job_id": t["job_id"], "link_ticket_hash": checked["ticket_hash"],
                 "vault_pubkey": attest.vault_pubkey(), "binding": {"host": HOST, "sessions":
                     [sess(checked["orders_receipt"], "orders")] + [sess(r, "instrument") for r in checked["instrument_receipts"]]}}
    return {**statement, "attestation": attest.attestation(), "signature": attest.sign(attest.canon(statement))}


def bounded_summary_traded(credential):
    return {k: credential[k] for k in ("purpose", "claim", "symbol", "window_days", "value", "trace_ts", "observed_at",
                                        "owner_user_id", "job_id", "link_ticket_hash", "vault_pubkey", "binding",
                                        "attestation", "signature")}


def verify_traded_credential(evidence, link_ticket, thot_public_key_pem, now=None, qvl="/usr/local/bin/dcap-qvl",
                             attestation_verifier=None, witness_attestation_verifier=None, measurements_path=None):
    """Verify a bounded traded-outcome credential without revealing order data."""
    expected_credential = {"purpose", "claim", "symbol", "window_days", "value", "trace_ts", "observed_at",
                           "owner_user_id", "job_id", "link_ticket_hash", "vault_pubkey", "binding",
                           "attestation", "signature"}
    if not isinstance(evidence, dict) or set(evidence) != {"credential", "witness_receipts"}:
        _fail("invalid_evidence_envelope")
    credential, receipts = evidence["credential"], evidence["witness_receipts"]
    if not isinstance(credential, dict) or set(credential) != expected_credential or not isinstance(receipts, list):
        _fail("invalid_evidence_envelope")
    symbol, days = credential.get("symbol"), credential.get("window_days")
    if (not isinstance(symbol, str) or not symbol or len(symbol) > 32 or
            not isinstance(days, int) or isinstance(days, bool) or not 0 < days <= 365 or
            credential.get("purpose") != TRADED_PURPOSE or
            credential.get("claim") != f"traded:{symbol}:within_{days}d" or
            not isinstance(credential.get("value"), bool)):
        _fail("invalid_credential_claim")
    if credential.get("value") is not True:
        _fail("outcome_not_established")

    def aware(value, code):
        if not isinstance(value, str): _fail(code)
        try: parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (TypeError, ValueError): _fail(code)
        if parsed.tzinfo is None or parsed.utcoffset() is None: _fail(code)
        return parsed.astimezone(dt.timezone.utc)

    trace_ts = aware(credential.get("trace_ts"), "invalid_trace_time")
    observed = aware(credential.get("observed_at"), "invalid_observation_time")
    current = now or dt.datetime.now(dt.timezone.utc)
    if isinstance(current, (int, float)): current = dt.datetime.fromtimestamp(current, dt.timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None: _fail("invalid_verifier_time")
    current = current.astimezone(dt.timezone.utc)
    if observed > current or current - observed > dt.timedelta(hours=24): _fail("credential_expired")
    if trace_ts > current: _fail("invalid_trace_time")

    statement = {k: v for k, v in credential.items() if k not in ("signature", "attestation")}
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(credential["vault_pubkey"])).verify(
            bytes.fromhex(credential["signature"]), attest.canon(statement))
        check_attestation = attestation_verifier or (lambda a, p, role: verify_attested_key(
            a, p, role, qvl=qvl, measurements_path=measurements_path))
        check_attestation(credential.get("attestation"), credential["vault_pubkey"], "appraiser")
    except Exception: _fail("invalid_appraiser_attestation")

    binding = credential.get("binding")
    sessions = binding.get("sessions") if isinstance(binding, dict) else None
    if (not isinstance(binding, dict) or set(binding) != {"host", "sessions"} or binding.get("host") != HOST or
            not isinstance(sessions, list) or len(sessions) < 2):
        _fail("invalid_credential_binding")
    roles = [s.get("role") if isinstance(s, dict) else None for s in sessions]
    if roles != ["orders"] + ["instrument"] * (len(roles) - 1):
        _fail("invalid_credential_binding")
    session_keys = {"role", "h_cipher_down", "h_client_hello", "witness_pubkey", "t_start"}
    if any(not isinstance(s, dict) or set(s) != session_keys for s in sessions):
        _fail("invalid_credential_binding")
    if len({(s["role"], s["h_cipher_down"], s["h_client_hello"], s["witness_pubkey"], s["t_start"]) for s in sessions}) != len(sessions):
        _fail("invalid_credential_binding")
    if len(receipts) != len(sessions): _fail("witness_receipt_mismatch")

    ticket_hash = hashlib.sha256(link_ticket.encode()).hexdigest()
    try: payload = verify_ticket(link_ticket, thot_public_key_pem, now=observed)
    except Exception: _fail("invalid_time_or_ticket")
    if (credential.get("link_ticket_hash") != ticket_hash or credential.get("owner_user_id") != payload.get("owner_user_id") or
            credential.get("job_id") != payload.get("job_id")):
        _fail("link_ticket_binding_mismatch")
    matched = []
    receipt_keys = {"purpose", "upstream_host", "sni", "upstream_port", "h_cipher_up", "h_cipher_down", "h_client_hello",
                    "t_start", "t_end", "bytes_up", "bytes_down", "link_ticket_hash", "witness_pubkey",
                    "signature", "attestation"}
    used = set()
    for session in sessions:
        found = [r for r in receipts if isinstance(r, dict) and all(r.get(k) == session.get(k) for k in
                 ("h_cipher_down", "h_client_hello", "witness_pubkey", "t_start"))]
        if len(found) != 1: _fail("witness_receipt_mismatch")
        receipt = found[0]
        rid = id(receipt)
        if rid in used: _fail("witness_receipt_mismatch")
        used.add(rid)
        if set(receipt) != receipt_keys or receipt.get("purpose") != "trace-vault.provenance.v1":
            _fail("invalid_witness_receipt")
        for key in ("h_cipher_up", "h_cipher_down", "h_client_hello", "link_ticket_hash"):
            value = receipt.get(key)
            if not isinstance(value, str) or len(value) != 64:
                _fail("invalid_witness_receipt")
            try: bytes.fromhex(value)
            except ValueError: _fail("invalid_witness_receipt")
        pubkey = receipt.get("witness_pubkey")
        if not isinstance(pubkey, str) or len(pubkey) != 64:
            _fail("invalid_witness_receipt")
        try: bytes.fromhex(pubkey)
        except ValueError: _fail("invalid_witness_receipt")
        try:
            _verify_receipt_signature(receipt)
            check_witness = witness_attestation_verifier or (lambda a, p, role: verify_attested_key(
                a, p, role, qvl=qvl, measurements_path=measurements_path))
            check_witness(receipt.get("attestation"), receipt["witness_pubkey"], "witness")
            start = aware(receipt.get("t_start"), "invalid_observation_time")
            end = aware(receipt.get("t_end"), "invalid_observation_time")
        except EvidenceError: raise
        except Exception: _fail("invalid_witness_attestation")
        expiry = dt.datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
        if (receipt.get("upstream_host") != HOST or receipt.get("sni") != HOST or receipt.get("upstream_port") != 443 or
                not isinstance(receipt.get("bytes_up"), int) or not isinstance(receipt.get("bytes_down"), int) or
                isinstance(receipt.get("bytes_up"), bool) or isinstance(receipt.get("bytes_down"), bool) or
                receipt["bytes_up"] < 0 or receipt["bytes_down"] < 0 or end < start or end > current or end >= expiry or
                current - end > dt.timedelta(hours=24)):
            _fail("invalid_observation_time")
        if receipt.get("link_ticket_hash") != ticket_hash: _fail("link_ticket_binding_mismatch")
        try: verify_ticket(link_ticket, thot_public_key_pem, now=start)
        except Exception: _fail("invalid_time_or_ticket")
        matched.append(receipt)
    orders_receipt = matched[0]
    orders_start = aware(orders_receipt["t_start"], "invalid_observation_time")
    orders_end = aware(orders_receipt["t_end"], "invalid_observation_time")
    if not orders_start - dt.timedelta(seconds=30) <= observed <= orders_end + dt.timedelta(seconds=30):
        _fail("invalid_observation_time")
    if observed > current or current - observed > dt.timedelta(hours=24): _fail("credential_expired")
    return {"verified": True, "purpose": TRADED_PURPOSE, "owner_user_id": payload["owner_user_id"],
            "job_id": payload["job_id"], "link_ticket_hash": ticket_hash, "observed_at": credential["observed_at"],
            "symbol": symbol, "window_days": days, "value": credential["value"], "trace_ts": credential["trace_ts"],
            "scope": "observed_records", "valid_until": (observed + dt.timedelta(hours=24)).isoformat().replace("+00:00", "Z")}


def verify_credential(evidence, link_ticket, thot_public_key_pem, now=None, qvl="/usr/local/bin/dcap-qvl",
                      attestation_verifier=None, witness_attestation_verifier=None, measurements_path=None):
    """Verify a bounded credential and its original receipts without reveal material."""
    if not isinstance(evidence, dict) or set(evidence) != {"credential", "witness_receipts"}:
        _fail("invalid_evidence_envelope")
    credential, receipts = evidence["credential"], evidence["witness_receipts"]
    if not isinstance(credential, dict) or not isinstance(receipts, list): _fail("invalid_evidence_envelope")
    if credential.get("purpose") != CREDENTIAL_PURPOSE or credential.get("claim") != "controls_brokerage" or credential.get("value") is not True:
        _fail("invalid_credential_claim")
    statement = {k: v for k, v in credential.items() if k not in ("signature", "attestation")}
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(credential["vault_pubkey"])).verify(
            bytes.fromhex(credential["signature"]), attest.canon(statement))
        (attestation_verifier or (lambda a, p, role: verify_attested_key(a, p, role, qvl=qvl, measurements_path=measurements_path)))(
            credential.get("attestation"), credential["vault_pubkey"], "appraiser")
    except Exception: _fail("invalid_appraiser_attestation")
    sessions = credential.get("binding", {}).get("sessions")
    if credential.get("binding", {}).get("host") != HOST or not isinstance(sessions, list) or len(sessions) != 1:
        _fail("invalid_credential_binding")
    session = sessions[0]
    if session.get("role") != "accounts": _fail("invalid_credential_binding")
    matches = [r for r in receipts if all(r.get(k) == session.get(k) for k in
               ("h_cipher_down", "h_client_hello", "witness_pubkey", "t_start"))]
    if len(matches) != 1 or len(receipts) != 1: _fail("witness_receipt_mismatch")
    receipt = matches[0]; _verify_receipt_signature(receipt)
    try:
        (witness_attestation_verifier or (lambda a, p, role: verify_attested_key(a, p, role, qvl=qvl, measurements_path=measurements_path)))(
            receipt.get("attestation"), receipt["witness_pubkey"], "witness")
    except Exception: _fail("invalid_witness_attestation")
    if receipt.get("upstream_host") != HOST or receipt.get("sni") != HOST or receipt.get("upstream_port") != 443:
        _fail("wrong_upstream")
    try:
        start = dt.datetime.fromisoformat(receipt["t_start"].replace("Z", "+00:00"))
        end = dt.datetime.fromisoformat(receipt["t_end"].replace("Z", "+00:00"))
        payload = verify_ticket(link_ticket, thot_public_key_pem, now=start)
        observed = dt.datetime.fromisoformat(credential["observed_at"].replace("Z", "+00:00"))
    except Exception: _fail("invalid_time_or_ticket")
    ticket_hash = hashlib.sha256(link_ticket.encode()).hexdigest()
    if receipt.get("link_ticket_hash") != ticket_hash or credential.get("link_ticket_hash") != ticket_hash:
        _fail("link_ticket_binding_mismatch")
    if credential.get("owner_user_id") != payload["owner_user_id"] or credential.get("job_id") != payload["job_id"]:
        _fail("contributor_binding_mismatch")
    expiry = dt.datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
    if not start <= end < expiry or not start - dt.timedelta(seconds=30) <= observed <= end + dt.timedelta(seconds=30):
        _fail("invalid_observation_time")
    current = now or dt.datetime.now(dt.timezone.utc)
    if isinstance(current, (int, float)): current = dt.datetime.fromtimestamp(current, dt.timezone.utc)
    if current < observed or current - observed > dt.timedelta(hours=24): _fail("credential_expired")
    return {"verified": True, "owner_user_id": payload["owner_user_id"], "job_id": payload["job_id"],
            "link_ticket_hash": ticket_hash, "subject": credential["subject"], "observed_at": credential["observed_at"]}


def main():
    parser = argparse.ArgumentParser(description="Verify witnessed Robinhood account-control evidence")
    parser.add_argument("--bundle"); parser.add_argument("--thot-public-key")
    parser.add_argument("--verify-credential", action="store_true")
    parser.add_argument("--purpose", choices=("account-control", "traded"), default="account-control")
    parser.add_argument("--dcap-qvl", default=os.environ.get("TV_DCAP_QVL", "/usr/local/bin/dcap-qvl"))
    parser.add_argument("--measurements", default=os.environ.get("TV_MEASUREMENTS_FILE"))
    args = parser.parse_args()
    try:
        if args.verify_credential:
            request = json.load(__import__("sys").stdin)
            expected = {"evidence", "link_ticket", "thot_public_key_pem"}
            if not isinstance(request, dict) or set(request) != expected: _fail("invalid_verification_request")
            verifier = verify_traded_credential if args.purpose == "traded" else verify_credential
            print(json.dumps(verifier(request["evidence"], request["link_ticket"],
                                      request["thot_public_key_pem"], qvl=args.dcap_qvl,
                                      measurements_path=args.measurements)))
            return
        if not args.bundle or not args.thot_public_key: parser.error("--bundle and --thot-public-key are required")
        bundle = json.load(open(args.bundle)); public_key = open(args.thot_public_key, "rb").read()
        checked = verify_account_bundle(bundle, public_key)
        print(json.dumps({"ok": True, "claim": "controls_brokerage", "value": True,
                          "owner_user_id": checked["ticket"]["owner_user_id"],
                          "job_id": checked["ticket"]["job_id"], "observed_at": checked["observed_at"].isoformat()}))
    except EvidenceError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
