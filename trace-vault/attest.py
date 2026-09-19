"""Attestation seam - key-commitment model (per the ACI / dstack-webhost pattern).

A hardware TDX quote binds an in-enclave Ed25519 **vault key** ONCE at boot: the
pubkey sits in the quote's report_data. That key then signs each Merkle root, so a
disclosure is a cheap software signature, not a fresh quote per call.

  mock : a local ed25519 key + a labeled, untrusted envelope. Establishes no provenance.
  tdx  : the vault key is KMS-derived inside the CVM and its pubkey is bound in a real
         dstack quote. If the guest socket is absent the call fails - never faked.

report_data = sha256(JCS(statement)), statement = {purpose, vault_pubkey, nonce}. The
purpose tag domain-separates this from any other signing context.
"""
import os, json, hashlib, pathlib
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization as _ser

PURPOSE_RD = "trace-vault.report_data.v1"
KEY_PATH = "trace-vault/vault-ed25519/v1"
KEY_PURPOSE = "trace-vault.vault-ed25519.v1"

def _data_dir(): return pathlib.Path(os.environ.get("TV_DATA", "data"))
def canon(o): return json.dumps(o, sort_keys=True, separators=(",", ":")).encode()
def _pub_hex(sk):
    return sk.public_key().public_bytes(_ser.Encoding.Raw, _ser.PublicFormat.Raw).hex()
def _statement(pubhex): return {"purpose": PURPOSE_RD, "vault_pubkey": pubhex, "nonce": None}

def _mock_key():
    p = _data_dir() / ".vault_key"
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(Ed25519PrivateKey.generate().private_bytes(
            _ser.Encoding.Raw, _ser.PrivateFormat.Raw, _ser.NoEncryption()))
    return Ed25519PrivateKey.from_private_bytes(p.read_bytes())

def _build():
    mode = os.environ.get("TV_ATTEST", "mock")
    if mode == "tdx":
        from dstack_sdk import DstackClient
        c = DstackClient()                                   # /var/run/dstack.sock
        kr = c.get_key(KEY_PATH, KEY_PURPOSE)
        scalar = kr.decode_key() if hasattr(kr, "decode_key") else bytes.fromhex(kr.key)
        sk = Ed25519PrivateKey.from_private_bytes(scalar[:32])
        pubhex = _pub_hex(sk)
        stmt = _statement(pubhex)
        rd = hashlib.sha256(canon(stmt)).digest()
        q = c.get_quote(rd)                                  # binds vault_pubkey, ONCE at boot
        att = {"mode": "tdx", "quote": q.quote, "report_data": rd.hex(),
               "statement": stmt, "vault_pubkey": pubhex,
               "key_custody": {"provider": "dstack-kms", "purpose": KEY_PURPOSE,
                               "signature_chain": getattr(kr, "signature_chain", None)},
               "event_log": getattr(q, "event_log", None)}
        return sk, att
    sk = _mock_key()
    pubhex = _pub_hex(sk)
    stmt = _statement(pubhex)
    att = {"mode": "mock", "report_data": hashlib.sha256(canon(stmt)).hexdigest(),
           "statement": stmt, "vault_pubkey": pubhex,
           "note": "MOCK attestation - the vault key is NOT hardware-bound. No provenance."}
    return sk, att

_STATE = None
def _state():
    global _STATE
    if _STATE is None: _STATE = _build()
    return _STATE

def attestation(): return _state()[1]                        # same envelope in every bundle
def vault_pubkey(): return _state()[1]["vault_pubkey"]
def sign(payload: bytes) -> str: return _state()[0].sign(payload).hex()
