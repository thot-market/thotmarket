#!/usr/bin/env python3
"""Bounded in-memory Appraiser service. Reveal secrets arrive only through sealed transport."""
import datetime as dt, hashlib, json, os, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives import serialization
import appraisal_transport as transport
import robinhood_link

MAX_REQUEST = 36 * 1024 * 1024
_private = None; _identity = None; _thot_pem = None; _subject_key = None
_seen = {}; _lock = threading.Lock(); _slots=threading.BoundedSemaphore(2)

def _subject_key_tdx():
    from dstack_sdk import DstackClient
    result = DstackClient().get_key("trace-vault/robinhood-subject-hmac/v1", "trace-vault.robinhood-subject-hmac.v1")
    raw = result.decode_key() if hasattr(result, "decode_key") else bytes.fromhex(result.key)
    return raw[:32]

def configure():
    global _private, _identity, _thot_pem, _subject_key
    if os.environ.get("TV_ATTEST") != "tdx": raise RuntimeError("Appraiser requires TV_ATTEST=tdx")
    _thot_pem = os.environ["THOT_LINK_PUBLIC_KEY_PEM"].encode()
    issuer_hash = hashlib.sha256(_thot_pem).hexdigest(); _subject_key = _subject_key_tdx()
    _private = X25519PrivateKey.generate()
    public = _private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    expires = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    _identity = transport.identity(public, issuer_hash, expires)

def _renew():
    global _private, _identity
    now=dt.datetime.now(dt.timezone.utc)
    if _identity and now < dt.datetime.fromisoformat(_identity["expires_at"].replace("Z","+00:00")): return
    _private=X25519PrivateKey.generate(); public=_private.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)
    _identity=transport.identity(public,hashlib.sha256(_thot_pem).hexdigest(),(now+dt.timedelta(minutes=5)).isoformat().replace("+00:00","Z"))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass
    def _json(self, status, value):
        raw=json.dumps(value,separators=(",", ":")).encode(); self.send_response(status)
        self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_GET(self):
        if self.path != "/identity": return self._json(404,{"error":"not_found"})
        with _lock: _renew(); current=_identity
        self._json(200,current)
    def do_POST(self):
        if self.path not in ("/issue-account-control", "/issue-traded-outcome"): return self._json(404,{"error":"not_found"})
        if not _slots.acquire(False): return self._json(503,{"error":"appraiser_busy"})
        self.connection.settimeout(20)
        if len(self.headers.get_all("Content-Length",[])) != 1 or self.headers.get("Transfer-Encoding") is not None or self.headers.get_content_type() != "application/json":
            _slots.release(); return self._json(400,{"error":"invalid_request_headers"})
        try: length=int(self.headers.get("Content-Length","-1"))
        except ValueError: length=-1
        if length < 1 or length > MAX_REQUEST:
            _slots.release(); return self._json(413,{"error":"invalid_request_size"})
        try:
            with _lock: identity_snapshot,private_snapshot=_identity,_private
            identity_expiry=dt.datetime.fromisoformat(identity_snapshot["expires_at"].replace("Z","+00:00"))
            if dt.datetime.now(dt.timezone.utc) >= identity_expiry: raise ValueError("transport_identity_expired")
            sealed=json.loads(self.rfile.read(length)); payload,replay=transport.open_sealed(sealed,identity_snapshot,private_snapshot)
            now=dt.datetime.now(dt.timezone.utc)
            with _lock:
                for key, expiry in list(_seen.items()):
                    if expiry <= now: del _seen[key]
                if len(_seen) >= 1000: raise ValueError("appraiser_busy")
                if replay in _seen: raise ValueError("replayed_request")
                expiry=dt.datetime.fromisoformat(identity_snapshot["expires_at"].replace("Z","+00:00")); _seen[replay]=expiry
            if self.path == "/issue-account-control":
                credential=robinhood_link.issue_controls_brokerage(payload,_thot_pem,_subject_key,now=now)
                self._json(200,{"credential":robinhood_link.bounded_summary(credential),"witness_receipts":[payload["receipt"]]})
            else:
                req=payload.get("request") if isinstance(payload,dict) else None
                if not isinstance(req,dict): raise robinhood_link.EvidenceError("invalid_outcome_request")
                credential=robinhood_link.issue_traded_outcome(payload,_thot_pem,req.get("symbol"),req.get("window_days"),req.get("trace_ts"),now=now)
                receipts=[payload["orders"]["receipt"]]+[s["receipt"] for s in payload["instruments"]]
                self._json(200,{"credential":robinhood_link.bounded_summary_traded(credential),"witness_receipts":receipts})
        except robinhood_link.EvidenceError as exc: self._json(422,{"error":str(exc)})
        except Exception as exc: self._json(400,{"error":str(exc) if str(exc) in {"replayed_request","transport_identity_expired","appraiser_busy"} else "invalid_encrypted_request"})
        finally: _slots.release()

if __name__ == "__main__":
    configure(); ThreadingHTTPServer((os.environ.get("APPRAISER_BIND","127.0.0.1"),int(os.environ.get("APPRAISER_PORT","8791"))),Handler).serve_forever()
