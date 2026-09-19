"""Offline adversarial tests.  TLS primitives are replaced with deterministic fixture plaintext;
production entry points still require a TDX receipt and real reveal/certificate verification."""
import base64
import datetime as dt
import gzip
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import attest
import robinhood_link as rl


def b64(value): return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def ticket(sk, owner="user-a", job="job-a", now=None):
    now = now or dt.datetime(2026, 9, 7, 16, 0, tzinfo=dt.timezone.utc)
    payload = {"schema_version": "thot.robinhood-link-ticket/1", "job_id": job,
               "owner_user_id": owner, "nonce": "12" * 32,
               "issued_at": now.isoformat().replace("+00:00", "Z"),
               "expires_at": (now + dt.timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
               "audience": "trace-vault-robinhood"}
    encoded = b64(json.dumps(payload, separators=(",", ":")).encode())
    return encoded + "." + b64(sk.sign(encoded.encode()))


def pem(sk):
    return sk.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)


def response(body=None, extra=b"", headers=None):
    body = body or json.dumps({"results": [{"url": "https://api.robinhood.com/accounts/a/"}],
                               "next": None, "previous": None}).encode()
    base = [(b"Content-Type", b"application/json"), (b"Date", b"Mon, 07 Sep 2026 16:00:00 GMT"),
            (b"Content-Length", str(len(body)).encode())]
    return b"HTTP/1.1 200 OK\r\n" + b"\r\n".join(k + b": " + v for k, v in (headers or base)) + b"\r\n\r\n" + body + extra


def fixture():
    issuer = Ed25519PrivateKey.generate(); witness = Ed25519PrivateKey.generate()
    raw_ticket = ticket(issuer); hello, down = b"client hello", b"server ciphertext"
    receipt = {"purpose": "trace-vault.provenance.v1", "upstream_host": rl.HOST, "sni": rl.HOST,
               "upstream_port": 443, "h_client_hello": hashlib.sha256(hello).hexdigest(),
               "h_cipher_up": "33" * 32, "h_cipher_down": hashlib.sha256(down).hexdigest(),
               "t_start": "2026-09-07T16:00:00Z", "t_end": "2026-09-07T16:00:01Z",
               "bytes_up": len(hello), "bytes_down": len(down),
               "link_ticket_hash": hashlib.sha256(raw_ticket.encode()).hexdigest(),
               "witness_pubkey": witness.public_key().public_bytes(serialization.Encoding.Raw,
                                                                     serialization.PublicFormat.Raw).hex()}
    receipt["signature"] = witness.sign(attest.canon(receipt)).hex()
    receipt["attestation"] = {"mode": "mock"}
    bundle = {"schema_version": rl.CAPTURE_SCHEMA, "receipt": receipt, "link_ticket": raw_ticket,
              "client_hello": hello.hex(), "cipher_down": down.hex(),
              "cipher_suite": "TLS_AES_128_GCM_SHA256", "secrets": {
                  "SERVER_TRAFFIC_SECRET_0": "11" * 32, "SERVER_HANDSHAKE_TRAFFIC_SECRET": "22" * 32}}
    return bundle, pem(issuer)


def expect(code, fn):
    try: fn(); raise AssertionError("accepted: " + code)
    except rl.EvidenceError as exc: assert str(exc) == code, (code, exc)


body, observed = rl.parse_http_json(response())
assert body["results"] and observed.year == 2026
expect("body_length_mismatch", lambda: rl.parse_http_json(response(extra=b"HTTP/1.1 200 OK\r\n\r\n")))
expect("http_status_not_200", lambda: rl.parse_http_json(response().replace(b"200 OK", b"401 Nope", 1)))
expect("duplicate_json_key", lambda: rl.parse_http_json(response(b'{"results":[],"results":[]}')))
expect("ambiguous_http_framing", lambda: rl.parse_http_json(response(headers=[
    (b"Content-Type", b"application/json"), (b"Date", b"Mon, 07 Sep 2026 16:00:00 GMT"),
    (b"Content-Length", b"2"), (b"Transfer-Encoding", b"chunked")])))
zipped = gzip.compress(b'{"results":[]}')
parsed, _ = rl.parse_http_json(response(zipped, headers=[(b"Content-Type", b"application/json"),
    (b"Date", b"Mon, 07 Sep 2026 16:00:00 GMT"), (b"Content-Length", str(len(zipped)).encode()),
    (b"Content-Encoding", b"gzip")]))
assert parsed == {"results": []}

bundle, issuer_pem = fixture()
old_cert, old_decrypt = rl.reveal.verify_cert_chain, rl.reveal.decrypt_dir
rl.reveal.verify_cert_chain = lambda *args: True
rl.reveal.decrypt_dir = lambda *args: response()
try:
    checked = rl.verify_account_bundle(bundle, issuer_pem, witness_verifier=lambda receipt: True,
                                       now=dt.datetime(2026, 9, 7, 16, 1, tzinfo=dt.timezone.utc))
    assert checked["ticket"]["owner_user_id"] == "user-a"
    bad = json.loads(json.dumps(bundle)); bad["cipher_down"] = b"forged".hex()
    expect("ciphertext_hash_mismatch", lambda: rl.verify_account_bundle(bad, issuer_pem, lambda r: True,
        dt.datetime(2026, 9, 7, 16, 1, tzinfo=dt.timezone.utc)))
    bad = json.loads(json.dumps(bundle)); bad["receipt"]["link_ticket_hash"] = "00" * 32
    # Re-signing models a valid witness receipt attached to the wrong authorized capture.
    witness = Ed25519PrivateKey.generate()
    bad["receipt"]["witness_pubkey"] = witness.public_key().public_bytes(serialization.Encoding.Raw,
        serialization.PublicFormat.Raw).hex()
    payload = {k: v for k, v in bad["receipt"].items() if k not in ("signature", "attestation")}
    bad["receipt"]["signature"] = witness.sign(attest.canon(payload)).hex()
    expect("link_ticket_receipt_mismatch", lambda: rl.verify_account_bundle(bad, issuer_pem, lambda r: True,
        dt.datetime(2026, 9, 7, 16, 1, tzinfo=dt.timezone.utc)))
    expect("witness_attestation_not_tdx", lambda: rl.verify_account_bundle(bundle, issuer_pem,
        now=dt.datetime(2026, 9, 7, 16, 1, tzinfo=dt.timezone.utc)))
    appraiser = Ed25519PrivateKey.generate(); r = bundle["receipt"]
    statement = {"purpose": rl.CREDENTIAL_PURPOSE, "claim": "controls_brokerage", "value": True,
        "observed_at": "2026-09-07T16:00:00Z", "owner_user_id": "user-a", "job_id": "job-a",
        "link_ticket_hash": r["link_ticket_hash"], "subject": "44" * 32,
        "vault_pubkey": appraiser.public_key().public_bytes(serialization.Encoding.Raw,
            serialization.PublicFormat.Raw).hex(), "binding": {"host": rl.HOST, "sessions": [{
                "role": "accounts", "h_cipher_down": r["h_cipher_down"],
                "h_client_hello": r["h_client_hello"], "witness_pubkey": r["witness_pubkey"],
                "t_start": r["t_start"]}]}}
    credential = {**statement, "attestation": {"mode": "mock"},
                  "signature": appraiser.sign(attest.canon(statement)).hex()}
    evidence = {"credential": credential, "witness_receipts": [r]}
    summary = rl.verify_credential(evidence, bundle["link_ticket"], issuer_pem,
        now=dt.datetime(2026, 9, 7, 17, 0, tzinfo=dt.timezone.utc),
        attestation_verifier=lambda *args: True, witness_attestation_verifier=lambda *args: True)
    assert summary["verified"] and summary["owner_user_id"] == "user-a"
    replay = json.loads(json.dumps(credential)); replay["owner_user_id"] = "user-b"
    replay_statement = {k: v for k, v in replay.items() if k not in ("signature", "attestation")}
    replay["signature"] = appraiser.sign(attest.canon(replay_statement)).hex()
    expect("contributor_binding_mismatch", lambda: rl.verify_credential(
        {"credential": replay, "witness_receipts": [r]}, bundle["link_ticket"], issuer_pem,
        now=dt.datetime(2026, 9, 7, 17, 0, tzinfo=dt.timezone.utc),
        attestation_verifier=lambda *args: True, witness_attestation_verifier=lambda *args: True))
finally:
    rl.reveal.verify_cert_chain, rl.reveal.decrypt_dir = old_cert, old_decrypt

# Production dispatch uses the configured attestation verifier and witness role, not legacy `tv` pins.
called=[]; old_attested=rl.verify_attested_key
rl.verify_attested_key=lambda att,pub,role,qvl: called.append((att,pub,role,qvl)) or True
try:
    production_receipt={"attestation":{"mode":"tdx"},"witness_pubkey":"55"*32}
    os.environ["TV_DCAP_QVL"]="/verified/dcap-qvl"
    assert rl.verify_witness_production(production_receipt)
    assert called==[(production_receipt["attestation"],"55"*32,"witness","/verified/dcap-qvl")]
finally:
    rl.verify_attested_key=old_attested; os.environ.pop("TV_DCAP_QVL",None)

print("test_robinhood_link: PASS")
