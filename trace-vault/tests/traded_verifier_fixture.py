#!/usr/bin/env python3
"""TEST ONLY subprocess fixture for the traded-proof verifier.

``--make`` emits the same request envelope consumed by the production CLI.  The
default path invokes the verifier with explicit, deterministic fixture-key
trust callbacks; production code has no equivalent fake-trust switch.
"""
import argparse
import base64
import datetime as dt
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

APPRAISER_SEED = hashlib.sha256(b"thot-test-only-traded-appraiser-v1").digest()
WITNESS_SEED = hashlib.sha256(b"thot-test-only-traded-witness-v1").digest()
ISSUER_SEED = hashlib.sha256(b"thot-test-only-traded-ticket-issuer-v1").digest()
APPRAISER = Ed25519PrivateKey.from_private_bytes(APPRAISER_SEED)
WITNESS = Ed25519PrivateKey.from_private_bytes(WITNESS_SEED)
ISSUER = Ed25519PrivateKey.from_private_bytes(ISSUER_SEED)


def pub(sk):
    return sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()


def pem(sk):
    return sk.public_key().public_bytes(serialization.Encoding.PEM,
                                       serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def make_request(template):
    if not isinstance(template, dict) or not isinstance(template.get("link_ticket"), str) or not isinstance(template.get("thot_public_key_pem"), str):
        raise ValueError("make_requires_ticket_and_key")
    ticket = template["link_ticket"]
    ticket_body = rl.verify_ticket(ticket, template["thot_public_key_pem"], now=dt.datetime.now(dt.timezone.utc))
    symbol, days, trace_ts = template.get("symbol"), template.get("window_days"), template.get("trace_ts")
    if not isinstance(symbol, str) or not isinstance(days, int) or isinstance(days, bool) or not isinstance(trace_ts, str):
        raise ValueError("make_requires_predicate")
    issued = dt.datetime.fromisoformat(ticket_body["issued_at"].replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    ticket_hash = hashlib.sha256(ticket.encode()).hexdigest()
    iso = lambda x: x.isoformat().replace("+00:00", "Z")
    def receipt(role, tag):
        start = end = issued
        hello = hashlib.sha256(("hello-" + tag).encode()).hexdigest()
        down = hashlib.sha256(("down-" + tag).encode()).hexdigest()
        r = {"purpose": "trace-vault.provenance.v1", "upstream_host": rl.HOST, "sni": rl.HOST,
             "upstream_port": 443, "h_client_hello": hello, "h_cipher_up": "33" * 32, "h_cipher_down": down,
             "t_start": iso(start), "t_end": iso(end), "bytes_up": 1, "bytes_down": 1, "link_ticket_hash": ticket_hash,
             "witness_pubkey": pub(WITNESS), "attestation": {"mode": "tdx", "fixture": "TEST ONLY"}}
        r["signature"] = WITNESS.sign(attest.canon({k: v for k, v in r.items()
                                                     if k not in ("signature", "attestation")})).hex()
        return r

    sessions = [{"role": "orders", "h_cipher_down": hashlib.sha256(b"down-orders").hexdigest(),
                 "h_client_hello": hashlib.sha256(b"hello-orders").hexdigest(),
                 "witness_pubkey": pub(WITNESS), "t_start": iso(issued)},
                {"role": "instrument", "h_cipher_down": hashlib.sha256(b"down-instrument").hexdigest(),
                 "h_client_hello": hashlib.sha256(b"hello-instrument").hexdigest(),
                 "witness_pubkey": pub(WITNESS), "t_start": iso(issued)}]
    receipts = [receipt("orders", "orders"), receipt("instrument", "instrument")]
    statement = {"purpose": rl.TRADED_PURPOSE, "claim": f"traded:{symbol}:within_{days}d", "symbol": symbol,
                 "window_days": days, "value": True, "trace_ts": trace_ts,
                 "observed_at": iso(issued), "owner_user_id": ticket_body["owner_user_id"],
                 "job_id": ticket_body["job_id"], "link_ticket_hash": ticket_hash, "vault_pubkey": pub(APPRAISER),
                 "binding": {"host": rl.HOST, "sessions": sessions}}
    credential = {**statement, "attestation": {"mode": "tdx", "fixture": "TEST ONLY"},
                  "signature": APPRAISER.sign(attest.canon(statement)).hex()}
    return {"evidence": {"credential": credential, "witness_receipts": receipts},
            "link_ticket": ticket, "thot_public_key_pem": template["thot_public_key_pem"]}


def trusted_attestation(attestation, public_key, role):
    expected = pub(APPRAISER) if role == "appraiser" else pub(WITNESS) if role == "witness" else None
    if expected is None or public_key != expected or not isinstance(attestation, dict) or attestation.get("mode") != "tdx":
        raise ValueError("fixture_attestation_trust_failure")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--make", action="store_true", help="emit TEST ONLY signed verifier input")
    args = parser.parse_args()
    if args.make:
        print(json.dumps(make_request(json.load(sys.stdin)), separators=(",", ":")))
        return
    try:
        request = json.load(sys.stdin)
        result = rl.verify_traded_credential(request["evidence"], request["link_ticket"],
            request["thot_public_key_pem"], attestation_verifier=trusted_attestation,
            witness_attestation_verifier=trusted_attestation)
        print(json.dumps(result, separators=(",", ":")))
    except Exception as exc:
        print(json.dumps({"verified": False, "error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
