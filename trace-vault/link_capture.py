#!/usr/bin/env python3
"""Local one-shot Robinhood /accounts/ capture through the blind Witness.

The access token is read with getpass, never accepted as an argv value and never
written to the bundle.  The output contains server-direction TLS secrets and must
be sent only to the attested Appraiser.
"""
import argparse
import re
import getpass
import hashlib
import http.client
import json
import os
import socket
import ssl
import tempfile
import time
import urllib.parse
import urllib.request
import appraisal_transport

HOST = "api.robinhood.com"
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("redirect_refused")
_opener = urllib.request.build_opener(_NoRedirect)

def _fetch_receipt(base, hello_hash, ticket, timeout=15, opener=None, clock=time.monotonic, pause=time.sleep):
    """Poll only the ticket/hash-scoped receipt endpoint while signing catches up."""
    opener = opener or _opener; deadline = clock() + timeout
    query = urllib.parse.urlencode({"h_client_hello": hello_hash})
    fetch = urllib.request.Request(f"{base.rstrip('/')}/receipts?{query}",
                                   headers={"X-Thot-Link-Ticket": ticket})
    while True:
        with opener.open(fetch, timeout=min(5, max(1, deadline-clock()))) as response:
            value = json.load(response)
        receipts = value.get("receipts", []) if isinstance(value, dict) else []
        if len(receipts) == 1: return receipts[0]
        if len(receipts) > 1: raise RuntimeError("ambiguous_witness_receipt")
        if clock() >= deadline: raise RuntimeError("witness_receipt_not_found")
        pause(min(.25, max(0, deadline-clock())))


def _connect_proxy(proxy_host, proxy_port, ticket, outer_tls=False):
    raw = socket.create_connection((proxy_host, proxy_port), timeout=30)
    if outer_tls: raw = ssl.create_default_context().wrap_socket(raw, server_hostname=proxy_host)
    request = (f"CONNECT {HOST}:443 HTTP/1.1\r\nHost: {HOST}:443\r\n"
               f"X-Thot-Link-Ticket: {ticket}\r\nConnection: keep-alive\r\n\r\n").encode("ascii")
    raw.sendall(request)
    response = http.client.HTTPResponse(raw); response.begin()
    if response.status != 200:
        raw.close(); raise RuntimeError("witness_connect_refused")
    return raw


def capture(ticket, proxy_host="127.0.0.1", proxy_port=8790, token=None, witness_base=None,
            request_path="/accounts/"):
    if not ticket or any(c in ticket for c in "\r\n"):
        raise ValueError("invalid_link_ticket")
    valid_path = request_path == "/accounts/" or request_path == "/orders/" or (
        isinstance(request_path, str) and re.fullmatch(r"/instruments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/", request_path) is not None)
    if not valid_path:
        raise ValueError("invalid_request_path")
    token = token or getpass.getpass("Robinhood access token (hidden, never stored): ")
    if not token or any(c in token for c in "\r\n"):
        raise ValueError("invalid_access_token")
    raw = _connect_proxy(proxy_host, proxy_port, ticket,
                         bool(witness_base and urllib.parse.urlsplit(witness_base).scheme == "https"))
    keylog = tempfile.NamedTemporaryFile(prefix="tv-rh-keylog-", delete=False); keylog.close()
    try:
        ctx = ssl.create_default_context(); ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ctx.set_alpn_protocols(["http/1.1"]); ctx.keylog_filename = keylog.name
        incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
        tls = ctx.wrap_bio(incoming, outgoing, server_hostname=HOST)
        up, down = bytearray(), bytearray()

        def push():
            chunk = outgoing.read()
            if chunk: raw.sendall(chunk); up.extend(chunk)

        while True:
            try: tls.do_handshake(); break
            except ssl.SSLWantReadError:
                push(); chunk = raw.recv(65536)
                if not chunk: raise RuntimeError("tls_handshake_eof")
                if len(down)+len(chunk) > 16*1024*1024: raise RuntimeError("capture_too_large")
                incoming.write(chunk); down.extend(chunk)
        push()
        if tls.selected_alpn_protocol() not in (None, "http/1.1"):
            raise RuntimeError("http2_negotiated")
        req = (f"GET {request_path} HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {token}\r\n"
               "Accept: application/json\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n").encode()
        tls.write(req); push()
        while True:
            try:
                if not tls.read(65536): break
            except ssl.SSLWantReadError:
                chunk = raw.recv(65536)
                if not chunk: break
                if len(down)+len(chunk) > 16*1024*1024: raise RuntimeError("capture_too_large")
                incoming.write(chunk); down.extend(chunk)
            except (ssl.SSLEOFError, ssl.SSLError):
                break
        push(); raw.close()
        first_len = 5 + int.from_bytes(up[3:5], "big")
        hello = bytes(up[:first_len])
        client_random = hello[11:43].hex()
        secrets = {}
        with open(keylog.name) as stream:
            for line in stream:
                parts = line.split()
                if len(parts) == 3 and parts[1].lower() == client_random and parts[0] in {
                    "SERVER_TRAFFIC_SECRET_0", "SERVER_HANDSHAKE_TRAFFIC_SECRET"}:
                    secrets[parts[0]] = parts[2]
        if set(secrets) != {"SERVER_TRAFFIC_SECRET_0", "SERVER_HANDSHAKE_TRAFFIC_SECRET"}:
            raise RuntimeError("server_secrets_missing")
        base = (witness_base or f"http://{proxy_host}:{proxy_port}").rstrip("/")
        receipt = _fetch_receipt(base, hashlib.sha256(hello).hexdigest(), ticket)
        return {"schema_version": "trace-vault.robinhood-capture/1", "receipt": receipt,
                "link_ticket": ticket, "client_hello": hello.hex(), "cipher_down": bytes(down).hex(),
                "cipher_suite": tls.cipher()[0], "secrets": secrets}
    finally:
        token = None
        try: os.unlink(keylog.name)
        except OSError: pass

def appraise(bundle, appraiser_url, thot_public_pem, dcap_qvl="/usr/local/bin/dcap-qvl", measurements=None):
    issuer_hash = hashlib.sha256(thot_public_pem).hexdigest(); base = appraiser_url.rstrip("/")
    with _opener.open(base + "/identity", timeout=20) as response: identity = json.load(response)
    appraisal_transport.verify_identity(identity, issuer_hash, qvl=dcap_qvl, measurements_path=measurements)
    raw = json.dumps(appraisal_transport.seal(bundle, identity), separators=(",", ":")).encode()
    request = urllib.request.Request(base + "/issue-account-control", data=raw,
        headers={"Content-Type":"application/json"}, method="POST")
    with _opener.open(request, timeout=60) as response:
        result=json.load(response)
    if not isinstance(result, dict) or set(result) != {"credential","witness_receipts"}:
        raise RuntimeError("invalid_appraiser_response")
    return result

def appraise_traded(bundle, request, appraiser_url, thot_public_pem, dcap_qvl="/usr/local/bin/dcap-qvl", measurements=None):
    """Send a witnessed orders/instruments bundle to the traded-outcome endpoint.

    The request is sealed with the capture bundle. Raw brokerage responses therefore
    remain inside the witnessed transport and appraiser; callers receive only the
    bounded public envelope.
    """
    issuer_hash = hashlib.sha256(thot_public_pem).hexdigest(); base = appraiser_url.rstrip("/")
    with _opener.open(base + "/identity", timeout=20) as response: identity = json.load(response)
    appraisal_transport.verify_identity(identity, issuer_hash, qvl=dcap_qvl, measurements_path=measurements)
    payload = {**bundle, "request": request}
    raw = json.dumps(appraisal_transport.seal(payload, identity), separators=(",", ":")).encode()
    req = urllib.request.Request(base + "/issue-traded-outcome", data=raw,
        headers={"Content-Type":"application/json"}, method="POST")
    with _opener.open(req, timeout=60) as response: result = json.load(response)
    if not isinstance(result, dict) or set(result) != {"credential", "witness_receipts"}:
        raise RuntimeError("invalid_appraiser_response")
    return result


def main():
    parser = argparse.ArgumentParser(description="Capture a witnessed Robinhood account-control response")
    parser.add_argument("--link-ticket"); parser.add_argument("--ticket-file")
    parser.add_argument("--proxy", default="127.0.0.1:8790"); parser.add_argument("--appraiser")
    parser.add_argument("--public-key-file"); parser.add_argument("--dcap-qvl", default="/usr/local/bin/dcap-qvl")
    parser.add_argument("--measurements")
    parser.add_argument("--capture-only", action="store_true"); parser.add_argument("--output", required=True)
    args = parser.parse_args(); host, port = args.proxy.rsplit(":", 1)
    config={}
    if args.ticket_file:
        config=json.load(open(args.ticket_file))
        if not isinstance(config,dict) or set(config)!={"link_ticket","witness_url","appraiser_url"}: parser.error("invalid ticket file")
    link_ticket=args.link_ticket or config.get("link_ticket")
    if not link_ticket: parser.error("--ticket-file or --link-ticket is required")
    appraiser=args.appraiser or config.get("appraiser_url")
    if not args.capture_only:
        if not appraiser or not args.public_key_file: parser.error("appraisal requires --public-key-file and Appraiser URL")
        public_pem=open(args.public_key_file,"rb").read(); issuer_hash=hashlib.sha256(public_pem).hexdigest()
        with _opener.open(appraiser.rstrip("/")+"/identity",timeout=20) as response: preflight_identity=json.load(response)
        appraisal_transport.verify_identity(preflight_identity,issuer_hash,qvl=args.dcap_qvl,measurements_path=args.measurements)
    witness_url=config.get("witness_url")
    if witness_url:
        parsed=urllib.parse.urlsplit(witness_url)
        if parsed.scheme not in ("https","http") or not parsed.hostname: parser.error("invalid witness URL")
        host,port=parsed.hostname,parsed.port or (443 if parsed.scheme=="https" else 80)
    bundle = capture(link_ticket, host, int(port), witness_base=witness_url)
    if args.capture_only:
        result=bundle
    else:
        result=appraise(bundle,appraiser,public_pem,args.dcap_qvl,args.measurements)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(args.output, flags, 0o600)
    with os.fdopen(fd, "w") as stream: json.dump(result, stream, separators=(",", ":"))
    print(json.dumps({"ok": True, "output": args.output, "claim": "controls_brokerage",
                      "capture_only":args.capture_only}))


if __name__ == "__main__": main()
