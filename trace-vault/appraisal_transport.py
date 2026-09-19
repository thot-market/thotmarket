"""Attestation-authenticated sealed transport for Robinhood reveal bundles."""
import base64, datetime as dt, hashlib, json, os
import attest
from attestation_verify import verify_attested_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PURPOSE = "trace-vault.appraisal-transport/1"
SEALED_PURPOSE = "trace-vault.appraisal-sealed/1"
MAX_PLAINTEXT = 24 * 1024 * 1024
canon = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

def _b64(data): return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
def _unb64(value):
    if not isinstance(value, str) or len(value) > 48 * 1024 * 1024: raise ValueError("invalid_base64")
    try: return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception: raise ValueError("invalid_base64")

def identity(encryption_public_key, thot_issuer_sha256, expires_at):
    statement = {"purpose": PURPOSE, "encryption_public_key": encryption_public_key.hex(),
                 "vault_pubkey": attest.vault_pubkey(), "thot_issuer_sha256": thot_issuer_sha256,
                 "expires_at": expires_at}
    return {**statement, "attestation": attest.attestation(), "signature": attest.sign(canon(statement))}

def verify_identity(value, thot_issuer_sha256, now=None, qvl="/usr/local/bin/dcap-qvl", verifier=None, measurements_path=None):
    expected = {"purpose", "encryption_public_key", "vault_pubkey", "thot_issuer_sha256", "expires_at", "attestation", "signature"}
    if not isinstance(value, dict) or set(value) != expected or value.get("purpose") != PURPOSE: raise ValueError("invalid_transport_identity")
    statement = {k: value[k] for k in expected - {"attestation", "signature"}}
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(value["vault_pubkey"])).verify(bytes.fromhex(value["signature"]), canon(statement))
        (verifier or (lambda a, p, role: verify_attested_key(a, p, role, qvl=qvl, measurements_path=measurements_path)))(value["attestation"], value["vault_pubkey"], "appraiser")
        expires = dt.datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
        current = now or dt.datetime.now(dt.timezone.utc)
        if expires.tzinfo is None or current >= expires or expires-current > dt.timedelta(minutes=10): raise ValueError()
        if value["thot_issuer_sha256"] != thot_issuer_sha256: raise ValueError()
        X25519PublicKey.from_public_bytes(bytes.fromhex(value["encryption_public_key"]))
    except Exception: raise ValueError("invalid_transport_identity")
    return value

def _key(shared, identity_value):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"trace-vault appraisal transport v1\0" + hashlib.sha256(canon(identity_value)).digest()).derive(shared)

def seal(payload, identity_value):
    raw = canon(payload)
    if len(raw) > MAX_PLAINTEXT: raise ValueError("payload_too_large")
    private = X25519PrivateKey.generate(); peer = X25519PublicKey.from_public_bytes(bytes.fromhex(identity_value["encryption_public_key"]))
    nonce = os.urandom(12); aad = hashlib.sha256(canon(identity_value)).digest()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {"purpose": SEALED_PURPOSE, "client_public_key": public.hex(), "nonce": _b64(nonce),
            "ciphertext": _b64(AESGCM(_key(private.exchange(peer), identity_value)).encrypt(nonce, raw, aad))}

def open_sealed(sealed, identity_value, private):
    if not isinstance(sealed, dict) or set(sealed) != {"purpose", "client_public_key", "nonce", "ciphertext"} or sealed.get("purpose") != SEALED_PURPOSE:
        raise ValueError("invalid_sealed_request")
    nonce, ciphertext = _unb64(sealed["nonce"]), _unb64(sealed["ciphertext"])
    if len(nonce) != 12 or len(ciphertext) > MAX_PLAINTEXT + 16: raise ValueError("invalid_sealed_request")
    peer = X25519PublicKey.from_public_bytes(bytes.fromhex(sealed["client_public_key"]))
    aad = hashlib.sha256(canon(identity_value)).digest()
    try: raw = AESGCM(_key(private.exchange(peer), identity_value)).decrypt(nonce, ciphertext, aad)
    except Exception: raise ValueError("sealed_request_authentication_failed")
    try: return json.loads(raw), hashlib.sha256(bytes.fromhex(sealed["client_public_key"]) + nonce).hexdigest()
    except Exception: raise ValueError("invalid_sealed_json")
