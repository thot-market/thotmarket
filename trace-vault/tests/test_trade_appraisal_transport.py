"""Transport integration test for the traded-outcome helper (no network)."""
import base64
import copy
import datetime as dt
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives import serialization

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))
import appraisal_transport as transport
import link_capture
import robinhood_link as rl
import traded_verifier_fixture as fixture


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
body = {"schema_version": "thot.robinhood-link-ticket/1", "job_id": "transport-job",
        "owner_user_id": "transport-owner", "nonce": "44" * 32,
        "issued_at": (now - dt.timedelta(seconds=30)).isoformat().replace("+00:00", "Z"),
        "expires_at": (now + dt.timedelta(minutes=4)).isoformat().replace("+00:00", "Z"),
        "audience": "trace-vault-robinhood"}
encoded = b64(json.dumps(body, separators=(",", ":")).encode())
TICKET = encoded + "." + b64(fixture.ISSUER.sign(encoded.encode("ascii")))
THOT_PEM = fixture.pem(fixture.ISSUER)

appraiser_private = X25519PrivateKey.generate()
public = appraiser_private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
issuer_hash = hashlib.sha256(THOT_PEM.encode()).hexdigest()
statement = {"purpose": transport.PURPOSE, "encryption_public_key": public.hex(),
             "vault_pubkey": fixture.pub(fixture.APPRAISER), "thot_issuer_sha256": issuer_hash,
             "expires_at": (now + dt.timedelta(minutes=5)).isoformat().replace("+00:00", "Z")}
identity = {**statement, "attestation": {"mode": "tdx", "fixture": "TEST ONLY"},
            "signature": fixture.APPRAISER.sign(transport.canon(statement)).hex()}

# Capture fields intentionally contain sentinel material. It must be present after decrypting
# inside the fake Appraiser and absent from the outbound sealed request.
sentinel = "RAW_TLS_SECRET_AND_ACCESS_TOKEN_SENTINEL"
bundle = {"schema_version": rl.ORDERS_SCHEMA, "link_ticket": TICKET,
          "orders": {"cipher_down": sentinel, "client_hello": sentinel},
          "instruments": [{"cipher_down": sentinel, "client_hello": sentinel}],
          "secrets": {"SERVER_TRAFFIC_SECRET_0": sentinel}}
request = {"symbol": "F", "window_days": 7, "trace_ts": body["issued_at"]}
fixture_envelope = fixture.make_request({"link_ticket": TICKET, "thot_public_key_pem": THOT_PEM,
                                          "symbol": "F", "window_days": 7,
                                          "trace_ts": body["issued_at"]})
appraiser_response = {"credential": fixture_envelope["evidence"]["credential"],
                      "witness_receipts": fixture_envelope["evidence"]["witness_receipts"]}


class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def read(self, *_): return json.dumps(self.value).encode()
    def __iter__(self): return iter(())


class FakeOpener:
    def __init__(self, response): self.response = response; self.posted = None; self.open_count = 0
    def open(self, req, timeout=None):
        self.open_count += 1
        url = req if isinstance(req, str) else req.full_url
        if url.endswith("/identity"):
            return Response(identity)
        self.posted = req.data
        sealed = json.loads(req.data)
        assert req.full_url.endswith("/issue-traded-outcome")
        assert sentinel not in req.data.decode()
        opened, _ = transport.open_sealed(sealed, identity, appraiser_private)
        assert opened["request"] == request
        assert opened["link_ticket"] == TICKET
        assert opened["orders"]["cipher_down"] == sentinel
        assert opened["instruments"][0]["client_hello"] == sentinel
        return Response(self.response)


old_opener, old_verify = link_capture._opener, transport.verify_identity
try:
    fake = FakeOpener(appraiser_response)
    link_capture._opener = fake

    # Keep real identity signature/expiry/issuer checks while explicitly substituting only
    # the TDX quote verifier. No socket or HTTP implementation is reached.
    def verify(value, thot_hash, **kwargs):
        kwargs["verifier"] = fixture.trusted_attestation
        return old_verify(value, thot_hash, now=now, **kwargs)
    transport.verify_identity = verify

    result = link_capture.appraise_traded(bundle, request, "https://appraiser.invalid", THOT_PEM.encode())
    assert result == appraiser_response
    assert fake.open_count == 2 and fake.posted is not None
    verifier_input = {"evidence": result, "link_ticket": TICKET, "thot_public_key_pem": THOT_PEM}
    assert rl.verify_traded_credential(verifier_input["evidence"], verifier_input["link_ticket"], verifier_input["thot_public_key_pem"],
                                       now=now, attestation_verifier=fixture.trusted_attestation,
                                       witness_attestation_verifier=fixture.trusted_attestation)["verified"]

    # A forged identity is rejected at GET and therefore cannot produce a POST.
    bad_identity = copy.deepcopy(identity); bad_identity["signature"] = "00" * 64
    fake_bad = FakeOpener(appraiser_response); link_capture._opener = fake_bad
    original_identity = identity; identity = bad_identity
    try:
        try: link_capture.appraise_traded(bundle, request, "https://appraiser.invalid", THOT_PEM.encode())
        except ValueError: pass
        else: raise AssertionError("tampered identity accepted")
        assert fake_bad.posted is None
    finally: identity = original_identity

    # Issuer mismatch also fails before the POST.
    bad_issuer = copy.deepcopy(identity); bad_issuer["thot_issuer_sha256"] = "ab" * 32
    fake_issuer = FakeOpener(appraiser_response); link_capture._opener = fake_issuer
    original_identity = identity; identity = bad_issuer
    try:
        try: link_capture.appraise_traded(bundle, request, "https://appraiser.invalid", THOT_PEM.encode())
        except ValueError: pass
        else: raise AssertionError("wrong issuer accepted")
        assert fake_issuer.posted is None
    finally: identity = original_identity

    # The public helper is strict about the bounded response envelope.
    extra = dict(appraiser_response); extra["unexpected"] = True
    fake_extra = FakeOpener(extra); link_capture._opener = fake_extra
    try:
        link_capture.appraise_traded(bundle, request, "https://appraiser.invalid", THOT_PEM.encode())
    except RuntimeError as exc:
        assert str(exc) == "invalid_appraiser_response"
    else: raise AssertionError("extra response field accepted")
finally:
    link_capture._opener, transport.verify_identity = old_opener, old_verify

print("test_trade_appraisal_transport: PASS")
