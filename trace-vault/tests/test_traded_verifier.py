#!/usr/bin/env python3
"""Adversarial Track B verifier tests using real ticket and Ed25519 signatures."""
import copy
import datetime as dt
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives import serialization

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))
import attest
import robinhood_link as rl
import traded_verifier_fixture as fixture

NOW = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
issued = NOW - dt.timedelta(seconds=30)
expires = issued + dt.timedelta(minutes=5)
iso = lambda value: value.isoformat().replace("+00:00", "Z")


def b64(raw):
    import base64
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


body = {"schema_version": "thot.robinhood-link-ticket/1", "job_id": "adversarial-job",
        "owner_user_id": "adversarial-owner", "nonce": "22" * 32,
        "issued_at": iso(issued), "expires_at": iso(expires), "audience": "trace-vault-robinhood"}
encoded = b64(json.dumps(body, separators=(",", ":")).encode())
TICKET = encoded + "." + b64(fixture.ISSUER.sign(encoded.encode("ascii")))
REQUEST = fixture.make_request({"link_ticket": TICKET, "thot_public_key_pem": fixture.pem(fixture.ISSUER),
                                "symbol": "F", "window_days": 7, "trace_ts": iso(issued - dt.timedelta(days=1))})
NOW_VERIFY = NOW


def trusted(attestation, public_key, role):
    expected = fixture.pub(fixture.APPRAISER) if role == "appraiser" else fixture.pub(fixture.WITNESS)
    if public_key != expected or attestation.get("mode") != "tdx":
        raise ValueError("unexpected_fixture_key")


def check(envelope, now=NOW_VERIFY):
    return rl.verify_traded_credential(envelope["evidence"], envelope["link_ticket"],
        envelope["thot_public_key_pem"], now=now, attestation_verifier=trusted,
        witness_attestation_verifier=trusted)


def resign_credential(envelope):
    c = envelope["evidence"]["credential"]
    statement = {k: v for k, v in c.items() if k not in ("signature", "attestation")}
    c["signature"] = fixture.APPRAISER.sign(attest.canon(statement)).hex()


def resign_receipt(receipt, key=fixture.WITNESS):
    receipt["witness_pubkey"] = fixture.pub(key)
    statement = {k: v for k, v in receipt.items() if k not in ("signature", "attestation")}
    receipt["signature"] = key.sign(attest.canon(statement)).hex()


assert check(REQUEST)["verified"]


def reject(label, mutate, now=NOW_VERIFY):
    bad = copy.deepcopy(REQUEST)
    mutate(bad)
    try:
        check(bad, now=now)
    except rl.EvidenceError:
        return
    raise AssertionError("accepted " + label)


reject("foreign ticket", lambda e: e.update({"link_ticket": TICKET[:-1] + ("A" if TICKET[-1] != "A" else "B")}))
reject("wrong owner", lambda e: (e["evidence"]["credential"].update({"owner_user_id": "other"}), resign_credential(e)))
reject("wrong job", lambda e: (e["evidence"]["credential"].update({"job_id": "other"}), resign_credential(e)))
reject("wrong purpose", lambda e: (e["evidence"]["credential"].update({"purpose": "wrong"}), resign_credential(e)))
reject("negative result", lambda e: (e["evidence"]["credential"].update({"value": False}), resign_credential(e)))
reject("receipt at expiry", lambda e: (e["evidence"]["witness_receipts"][0].update({"t_end": iso(expires)}), resign_receipt(e["evidence"]["witness_receipts"][0])), now=expires + dt.timedelta(seconds=1))
reject("boolean count", lambda e: (e["evidence"]["witness_receipts"][0].update({"bytes_up": True}), resign_receipt(e["evidence"]["witness_receipts"][0])))
reject("bad hash", lambda e: (e["evidence"]["witness_receipts"][0].update({"h_cipher_up": "x" * 64}), resign_receipt(e["evidence"]["witness_receipts"][0])))
reject("wrong witness signer", lambda e: resign_receipt(e["evidence"]["witness_receipts"][0], fixture.APPRAISER))
reject("missing receipt", lambda e: e["evidence"]["witness_receipts"].pop())
reject("duplicate receipt", lambda e: e["evidence"]["witness_receipts"].append(copy.deepcopy(e["evidence"]["witness_receipts"][0])))
reject("wrong role order", lambda e: (e["evidence"]["credential"]["binding"]["sessions"].reverse(), resign_credential(e)))
reject("future reference", lambda e: (e["evidence"]["credential"].update({"trace_ts": iso(NOW + dt.timedelta(seconds=1))}), resign_credential(e)))
reject("naive reference", lambda e: (e["evidence"]["credential"].update({"trace_ts": "2026-09-01T00:00:00"}), resign_credential(e)))

def unapproved_appraiser(e):
    credential = e["evidence"]["credential"]
    credential["vault_pubkey"] = fixture.pub(fixture.WITNESS)
    statement = {k: v for k, v in credential.items() if k not in ("signature", "attestation")}
    credential["signature"] = fixture.WITNESS.sign(attest.canon(statement)).hex()

reject("valid signature from unapproved appraiser", unapproved_appraiser)
print("test_traded_verifier: PASS")
