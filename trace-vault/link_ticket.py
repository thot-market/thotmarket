"""THOT-authorized, short-lived capture tickets. Public key is operator-pinned."""
import base64
import datetime as dt
import hashlib
import json
import re
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def _decode(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("INVALID_LINK_TICKET")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _unique(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("INVALID_LINK_TICKET")
        out[key] = value
    return out


def verify_ticket(ticket, public_key_pem, now=None):
    if not isinstance(ticket, str) or len(ticket) > 4096 or ticket.count(".") != 1:
        raise ValueError("INVALID_LINK_TICKET")
    encoded, signature = ticket.split(".")
    key = serialization.load_pem_public_key(public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem)
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("INVALID_LINK_ISSUER")
    key.verify(_decode(signature), encoded.encode("ascii"))
    data = json.loads(_decode(encoded), object_pairs_hook=_unique)
    expected = {"schema_version", "job_id", "owner_user_id", "nonce", "issued_at", "expires_at", "audience"}
    if not isinstance(data, dict) or set(data) != expected:
        raise ValueError("INVALID_LINK_TICKET")
    if data["schema_version"] != "thot.robinhood-link-ticket/1" or data["audience"] != "trace-vault-robinhood":
        raise ValueError("INVALID_LINK_TICKET")
    for field in ("job_id", "owner_user_id"):
        if not isinstance(data[field], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", data[field]):
            raise ValueError("INVALID_LINK_TICKET")
    if not isinstance(data["nonce"], str) or not re.fullmatch(r"[a-f0-9]{64}", data["nonce"]):
        raise ValueError("INVALID_LINK_TICKET")
    issued = dt.datetime.fromisoformat(data["issued_at"].replace("Z", "+00:00"))
    expiry = dt.datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00"))
    current = now if isinstance(now, dt.datetime) else dt.datetime.fromtimestamp(now, dt.timezone.utc) if now is not None else dt.datetime.now(dt.timezone.utc)
    if issued.tzinfo is None or expiry.tzinfo is None or not (0 < (expiry - issued).total_seconds() <= 600):
        raise ValueError("INVALID_LINK_TICKET")
    if not issued <= current < expiry:
        raise ValueError("LINK_TICKET_EXPIRED")
    return data


def ticket_hash(ticket):
    return hashlib.sha256(ticket.encode("ascii")).hexdigest()
