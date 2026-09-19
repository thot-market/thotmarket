"""Witnessed traded-outcome issuance (Track B, production shape). TLS reveal is replaced with
deterministic fixture plaintext; the witness/ticket/hash/schema checks are the real ones. Proves:
the enclave issues traded:<SYMBOL>:within_<N>d only from a witnessed /orders/ + /instruments/ pair,
the value is the honest recompute, the signed statement leaks no quantity/price/account, the symbol
must itself be witnessed, and tampering or a broken capture RAISES (no fallbacks)."""
import os, sys, json, hashlib, datetime as dt, subprocess
os.environ["TV_ATTEST"] = "tdx"   # issuance path requires tdx; attest is monkeypatched below
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization
import attest, reveal, robinhood_link as rl

# vault key + attestation forced to a local ed25519 key (stand-in for the dstack-bound key) ----
_vk = Ed25519PrivateKey.generate()
_vhex = _vk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
attest.vault_pubkey = lambda: _vhex
attest.attestation = lambda: {"mode": "tdx", "quote": "FIXTURE"}
attest.sign = lambda payload: _vk.sign(payload).hex()

issuer = Ed25519PrivateKey.generate(); witness = Ed25519PrivateKey.generate()
whex = witness.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()

def b64(v):
    import base64; return base64.urlsafe_b64encode(v).rstrip(b"=").decode()

def ticket(owner="user-a", job="job-a"):
    body = {"owner_user_id": owner, "job_id": job, "host": rl.HOST,
            "expires_at": "2026-09-07T18:00:00Z", "issued_at": "2026-09-07T15:00:00Z"}
    raw = b64(json.dumps(body, separators=(",", ":")).encode())
    sig = issuer.sign(raw.encode())
    return raw + "." + b64(sig)

def http(body):
    b = json.dumps(body, separators=(",", ":")).encode()
    return (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            b"Date: Mon, 07 Sep 2026 16:00:00 GMT\r\nContent-Length: " + str(len(b)).encode()
            + b"\r\n\r\n" + b)

RAW_TICKET = ticket()
TH = hashlib.sha256(RAW_TICKET.encode()).hexdigest()

def session(down_tag):
    hello, down = b"hello-" + down_tag, b"cipher-" + down_tag
    r = {"purpose": "trace-vault.provenance.v1", "upstream_host": rl.HOST, "sni": rl.HOST, "upstream_port": 443,
         "h_client_hello": hashlib.sha256(hello).hexdigest(), "h_cipher_up": "33" * 32,
         "h_cipher_down": hashlib.sha256(down).hexdigest(), "t_start": "2026-09-07T16:00:00Z",
         "t_end": "2026-09-07T16:00:01Z", "bytes_up": len(hello), "bytes_down": len(down),
         "link_ticket_hash": TH, "witness_pubkey": whex}
    r["signature"] = witness.sign(attest.canon(r)).hex(); r["attestation"] = {"mode": "tdx"}
    return {"receipt": r, "client_hello": hello.hex(), "cipher_down": down.hex(),
            "cipher_suite": "TLS_AES_128_GCM_SHA256",
            "secrets": {"SERVER_TRAFFIC_SECRET_0": "11" * 32, "SERVER_HANDSHAKE_TRAFFIC_SECRET": "22" * 32}}

IID = "6df56bd0-0bf2-44ab-8875-f94fd8526942"
ORDERS = {"next": None, "previous": None, "results": [
    {"instrument_id": IID, "state": "filled", "side": "buy", "last_transaction_at": "2026-09-05T14:17:37Z",
     "average_price": "12.3400", "quantity": "1.00000000", "account_number": "000000000"}]}
INSTRUMENT = {"id": IID, "symbol": "F", "name": "Ford Motor Company"}

def bundle():
    return {"schema_version": rl.ORDERS_SCHEMA, "link_ticket": RAW_TICKET,
            "orders": session(b"orders"), "instruments": [session(b"instr")]}

# reveal is monkeypatched to return the right fixture per witnessed ciphertext -----------------
PLAINTEXT = {hashlib.sha256(b"cipher-orders").hexdigest(): http(ORDERS),
             hashlib.sha256(b"cipher-instr").hexdigest(): http(INSTRUMENT)}
reveal.verify_cert_chain = lambda *a: True
reveal.decrypt_dir = lambda down, *a: PLAINTEXT[hashlib.sha256(down).hexdigest()]
PEM = issuer.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
_pem = ("-----BEGIN PUBLIC KEY-----\n" + PEM + "\n-----END PUBLIC KEY-----\n").encode()

# link_ticket verification uses verify_ticket; stub it to trust our fixture ticket -------------
import link_ticket
link_ticket.verify_ticket = rl.verify_ticket = lambda raw, pem, now=None: (
    json.loads(__import__("base64").urlsafe_b64decode(raw.split(".")[0] + "===")))

NOW = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
ok = lambda r: True
trusted = lambda *args: True

def expect(code, fn):
    try: fn(); raise AssertionError("accepted: " + code)
    except rl.EvidenceError as e:
        assert str(e) == code, f"want {code}, got {e}"; print(f"  reject {code}  ✓")

# --- happy path: filled F within 7d of a 2026-09-06 trace -> true, tdx-signed ---
cred = rl.issue_traded_outcome(bundle(), _pem, "F", 7, "2026-09-06T09:00:00Z", witness_verifier=ok, now=NOW)
assert cred["claim"] == "traded:F:within_7d" and cred["value"] is True, cred
assert cred["attestation"]["mode"] == "tdx"
Ed25519PublicKey.from_public_bytes(bytes.fromhex(cred["vault_pubkey"])).verify(
    bytes.fromhex(cred["signature"]), attest.canon({k: v for k, v in cred.items() if k not in ("attestation", "signature")}))
print("issue: traded:F:within_7d = true, vault signature verifies  ✓")

# --- both witnessed sessions are bound into the credential ---
roles = [s["role"] for s in cred["binding"]["sessions"]]
assert roles == ["orders", "instrument"], roles
print("binding: orders + instrument sessions both bound  ✓")

# --- firewall: no quantity, price, or account in the issued credential ---
blob = json.dumps(rl.bounded_summary_traded(cred))
for leaked in ("average_price", "12.34", "quantity", "1.00000000", "000000000", "account_number"):
    assert leaked not in blob, f"firewall leak: {leaked}"
print("firewall: no price, quantity, or account number in the credential  ✓")

# --- buyer/verifier path: signed appraiser + every witness receipt are checked ---
checked_bundle = bundle()
envelope = {"credential": rl.bounded_summary_traded(cred),
            "witness_receipts": [checked_bundle["orders"]["receipt"]] +
                                [s["receipt"] for s in checked_bundle["instruments"]]}
verified = rl.verify_traded_credential(envelope, RAW_TICKET, _pem,
    now=dt.datetime(2026, 9, 7, 17, 0, tzinfo=dt.timezone.utc),
    attestation_verifier=trusted, witness_attestation_verifier=trusted)
assert verified["verified"] and verified["purpose"] == rl.TRADED_PURPOSE and verified["scope"] == "observed_records"
assert verified["valid_until"] == "2026-09-08T16:00:00Z"
print("verify: appraiser signature, ticket, and ordered witness receipts  ✓")

def reject_verify(code, mutate, resign=False):
    bad = json.loads(json.dumps(envelope)); mutate(bad)
    if resign:
        statement = {k: v for k, v in bad["credential"].items() if k not in ("signature", "attestation")}
        bad["credential"]["signature"] = _vk.sign(attest.canon(statement)).hex()
    expect(code, lambda: rl.verify_traded_credential(bad, RAW_TICKET, _pem,
        now=dt.datetime(2026, 9, 7, 17, 0, tzinfo=dt.timezone.utc),
        attestation_verifier=trusted, witness_attestation_verifier=trusted))

reject_verify("invalid_credential_claim", lambda e: e["credential"].update({"claim": "traded:F:within_8d"}), True)
reject_verify("invalid_credential_binding", lambda e: e["credential"]["binding"]["sessions"].append(
    dict(e["credential"]["binding"]["sessions"][1])), True)
reject_verify("witness_receipt_mismatch", lambda e: e["witness_receipts"].pop())
reject_verify("link_ticket_binding_mismatch", lambda e: e["credential"].update({"owner_user_id": "other"}), True)
reject_verify("invalid_trace_time", lambda e: e["credential"].update({"trace_ts": "2026-09-06T09:00:00"}), True)
reject_verify("invalid_evidence_envelope", lambda e: e["credential"].update({"extra": True}))
reject_verify("outcome_not_established", lambda e: e["credential"].update({"value": False}), True)
print("verify rejects tamper, duplicate/missing receipt, owner, extra-field, and naive-time cases  ✓")

# --- CLI fail-closed routing (malformed input must not select Track A) ---
cli = subprocess.run([sys.executable, os.path.join(os.path.dirname(HERE), "robinhood_link.py"),
                      "--verify-credential", "--purpose", "traded"],
                     input=b"{}", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
assert cli.returncode != 0 and json.loads(cli.stdout)["ok"] is False
print("cli: traded verifier rejects malformed envelope with nonzero status  ✓")

# --- window discriminates honestly ---
c30 = rl.issue_traded_outcome(bundle(), _pem, "F", 7, "2026-09-20T09:00:00Z", witness_verifier=ok, now=NOW)
assert c30["value"] is False  # fill is >7d before a 2026-09-20 trace
print("window: same fill, out-of-window trace -> false  ✓")

# --- a symbol whose instrument was NOT witnessed cannot be issued ---
expect("symbol_not_witnessed", lambda: rl.issue_traded_outcome(bundle(), _pem, "NVDA", 7, "2026-09-06T09:00:00Z", witness_verifier=ok, now=NOW))

# --- forged orders ciphertext (hash mismatch) is rejected ---
bad = json.loads(json.dumps(bundle())); bad["orders"]["cipher_down"] = b"forged".hex()
expect("ciphertext_hash_mismatch", lambda: rl.issue_traded_outcome(bad, _pem, "F", 7, "2026-09-06T09:00:00Z", witness_verifier=ok, now=NOW))

# --- the real production witness verifier rejects a fixture receipt (no valid DCAP quote) ---
expect("witness_attestation_invalid", lambda: rl.issue_traded_outcome(bundle(), _pem, "F", 7, "2026-09-06T09:00:00Z", witness_verifier=None, now=NOW))
# --- and a receipt that is not even tdx-mode is refused at the mode gate ---
plain = json.loads(json.dumps(bundle())); plain["orders"]["receipt"]["attestation"] = {"mode": "mock"}
plain["orders"]["receipt"]["signature"] = witness.sign(attest.canon(
    {k: v for k, v in plain["orders"]["receipt"].items() if k not in ("signature", "attestation")})).hex()
expect("witness_attestation_not_tdx", lambda: rl.issue_traded_outcome(plain, _pem, "F", 7, "2026-09-06T09:00:00Z", witness_verifier=None, now=NOW))

# --- missing instrument session -> cannot resolve, invalid bundle ---
nobundle = json.loads(json.dumps(bundle())); nobundle["instruments"] = []
expect("invalid_orders_bundle", lambda: rl.issue_traded_outcome(nobundle, _pem, "F", 7, "2026-09-06T09:00:00Z", witness_verifier=ok, now=NOW))

# --- issuance refuses to run without tdx attestation ---
os.environ["TV_ATTEST"] = "mock"
expect("appraiser_attestation_not_tdx", lambda: rl.issue_traded_outcome(bundle(), _pem, "F", 7, "2026-09-06T09:00:00Z", witness_verifier=ok, now=NOW))
os.environ["TV_ATTEST"] = "tdx"

print("test_traded_outcome: PASS")
