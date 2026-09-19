#!/usr/bin/env python3
"""Module A - the Witness. A blind CONNECT relay: it tunnels the client's OWN TLS to the
upstream, so it sees only ciphertext, and signs a provenance receipt over
(h_cipher_up, h_cipher_down, upstream_host, t_start, t_end, bytes). It never sees
plaintext - the client reveals session keys later, and only to the Appraiser (Module B),
never here. Rooted in a minimal attested key (attest.py): the honest form of a zkTLS
notary - a small measured binary instead of a notary quorum.

  WITNESS_DIR=./receipts TV_ATTEST=mock python3 witness.py    # then: curl -x http://127.0.0.1:8790 https://example.com
"""
import os, socket, threading, hashlib, time, json
from urllib.parse import urlsplit, parse_qs
from link_ticket import verify_ticket, ticket_hash
import attest

PORT = int(os.environ.get("WITNESS_PORT", "8790"))
# Only witness (and relay) the model hosts - not an open relay. Client telemetry
# (Datadog, etc.) is refused so it is neither relayed nor signed.
ALLOW = set(h for h in os.environ.get("WITNESS_ALLOW", "api.anthropic.com,chatgpt.com,api.openai.com").split(",") if h)
RECEIPTS = []   # in-memory; a blind witness keeps no persistent store, the client fetches
RECEIPTS_LOCK = threading.Lock()
LINK_ISSUER = os.environ.get("THOT_LINK_PUBLIC_KEY_PEM", "")
_iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))

def _http(cl, body):
    cl.sendall(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: "
               + str(len(body)).encode() + b"\r\nconnection: close\r\n\r\n" + body)
    cl.close()

def _read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        d = sock.recv(n - len(buf))
        if not d: break
        buf += d
    return buf

def _read_record(sock):
    """Read one whole TLS record (5-byte header + body). The ClientHello is the client's
    first record and is plaintext even in TLS 1.3 (no ECH here)."""
    hdr = _read_exact(sock, 5)
    if len(hdr) < 5: return hdr
    return hdr + _read_exact(sock, int.from_bytes(hdr[3:5], "big"))

def _parse_sni(rec):
    """Pull the SNI host_name out of a ClientHello record, or None."""
    try:
        if rec[0] != 0x16 or rec[5] != 0x01: return None
        hs = rec[5:]
        p = 4 + 2 + 32                      # hs header(4) + client_version(2) + random(32)
        p += 1 + hs[p]                      # session_id
        p += 2 + int.from_bytes(hs[p:p+2], "big")   # cipher_suites
        p += 1 + hs[p]                      # compression_methods
        end = p + 2 + int.from_bytes(hs[p:p+2], "big"); p += 2   # extensions
        while p < end:
            et = int.from_bytes(hs[p:p+2], "big"); el = int.from_bytes(hs[p+2:p+4], "big"); p += 4
            if et == 0x0000 and hs[p+2] == 0x00:      # server_name -> host_name entry
                nl = int.from_bytes(hs[p+3:p+5], "big")
                return hs[p+5:p+5+nl].decode()
            p += el
    except Exception:
        return None
    return None

def _offered_alpn(rec):
    """Bounded ClientHello parser for the account capture's HTTP/1.1-only policy."""
    if len(rec) < 44 or rec[0] != 0x16 or rec[5] != 1 or int.from_bytes(rec[3:5], 'big') != len(rec)-5:
        raise ValueError('invalid client hello')
    hs=rec[5:]
    if int.from_bytes(hs[1:4], 'big') != len(hs)-4: raise ValueError('fragmented client hello')
    p=38; p+=1+hs[p]
    p+=2+int.from_bytes(hs[p:p+2], 'big'); p+=1+hs[p]
    end=p+2+int.from_bytes(hs[p:p+2], 'big'); p+=2
    if end != len(hs): raise ValueError('invalid extensions')
    protocols=[]; seen=set()
    while p < end:
        if p+4>end: raise ValueError('truncated extension')
        kind=int.from_bytes(hs[p:p+2],'big'); size=int.from_bytes(hs[p+2:p+4],'big'); p+=4
        if kind in seen or p+size>end: raise ValueError('invalid extension')
        seen.add(kind)
        if kind==16:
            data=hs[p:p+size]
            if len(data)<2 or int.from_bytes(data[:2],'big')!=len(data)-2: raise ValueError('invalid alpn')
            i=2
            while i<len(data):
                n=data[i];i+=1
                if not n or i+n>len(data): raise ValueError('invalid alpn')
                protocols.append(data[i:i+n].decode('ascii'));i+=n
        p+=size
    return protocols

def _pump(src, dst, h, box, key):
    try:
        while (b := src.recv(65536)):
            h.update(b); box[key] += len(b); dst.sendall(b)
    except OSError:
        pass
    finally:
        try: dst.shutdown(socket.SHUT_WR)
        except OSError: pass

def _handle(cl):
    line = b""
    while b"\r\n\r\n" not in line:
        d = cl.recv(1)
        if not d: cl.close(); return
        line += d
        if len(line) > 8192:
            cl.close(); return
    parts = line.split(b" ")
    headers = {}
    try:
        for header in line.split(b"\r\n")[1:]:
            if not header: continue
            k, v = header.decode("ascii").split(":", 1)
            k = k.strip().lower()
            if k in headers: raise ValueError("duplicate header")
            headers[k] = v.strip()
    except (ValueError, UnicodeError):
        cl.close(); return
    ticket = headers.get("x-thot-link-ticket")
    link_hash = None
    if ticket:
        try:
            verify_ticket(ticket, LINK_ISSUER)
            link_hash = ticket_hash(ticket)
        except Exception:
            cl.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n"); cl.close(); return
    if parts[0] == b"GET":                                   # provenance fetch (blind witness has no return channel in the tunnel)
        path = parts[1].decode() if len(parts) > 1 else "/"
        if urlsplit(path).path == "/receipts":
            hello = parse_qs(urlsplit(path).query).get("h_client_hello", [None])[0]
            with RECEIPTS_LOCK:
                selected = [r for r in RECEIPTS if r["h_client_hello"] == hello
                            and (not r.get("link_ticket_hash") or r["link_ticket_hash"] == link_hash)] if hello else [r for r in RECEIPTS[-100:] if not r.get("link_ticket_hash")]
            return _http(cl, json.dumps({"receipts": selected}).encode())
        return _http(cl, b'{"ok":true,"service":"trace-vault-witness"}')
    if parts[0] != b"CONNECT":
        cl.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n"); cl.close(); return
    host, _, port = parts[1].decode().partition(":")
    if host not in ALLOW or port not in ("", "443") or (host == "api.robinhood.com" and not link_hash):
        cl.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n"); cl.close(); return
    try:
        up = socket.create_connection((host, int(port or 443)), timeout=30)
    except OSError:
        cl.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n"); cl.close(); return
    cl.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")

    # Enforce SNI == CONNECT host BEFORE relaying. On shared anycast (Cloudflare), the CONNECT
    # host alone does not identify the TLS peer — the client's SNI does. Refusing a mismatch
    # defeats SNI-fronting: the client must send SNI=host, and the front then serves only host.
    first = _read_record(cl)
    sni = _parse_sni(first)
    if link_hash:
        try:
            if any(p!='http/1.1' for p in _offered_alpn(first)): raise ValueError('unsupported alpn')
        except Exception:
            cl.close();up.close();return
    if sni != host:
        print(f"[witness] SNI {sni!r} != CONNECT host {host!r} — refused", flush=True)
        for s in (cl, up):
            try: s.close()
            except OSError: pass
        return

    hu, hd, box, t0 = hashlib.sha256(), hashlib.sha256(), {"up": 0, "down": 0}, time.time()
    hu.update(first); box["up"] += len(first); up.sendall(first)   # the witnessed ClientHello
    t = threading.Thread(target=_pump, args=(cl, up, hu, box, "up"), daemon=True); t.start()
    _pump(up, cl, hd, box, "down")
    t.join(timeout=2)
    for s in (cl, up):
        try: s.close()
        except OSError: pass

    receipt = {"purpose": "trace-vault.provenance.v1", "upstream_host": host, "sni": sni,
               "h_client_hello": hashlib.sha256(first).hexdigest(),
               "h_cipher_up": hu.hexdigest(), "h_cipher_down": hd.hexdigest(),
               "t_start": _iso(t0), "t_end": _iso(time.time()),
               "bytes_up": box["up"], "bytes_down": box["down"]}
    if link_hash:
        receipt["link_ticket_hash"] = link_hash
        receipt["upstream_port"] = 443
    receipt["witness_pubkey"] = attest.vault_pubkey()
    receipt["signature"] = attest.sign(attest.canon(receipt))
    receipt["attestation"] = attest.attestation()
    with RECEIPTS_LOCK:
        RECEIPTS.append(receipt)
        del RECEIPTS[:-1000]
    print(f"[witness] {host} up={box['up']} down={box['down']} h_up={hu.hexdigest()[:12]} signed", flush=True)

if __name__ == "__main__":
    bind = os.environ.get("WITNESS_BIND", "0.0.0.0")
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((bind, PORT)); srv.listen(128)
    print(f"[witness] blind CONNECT witness on {bind}:{PORT} attest={os.environ.get('TV_ATTEST','mock')}", flush=True)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=_handle, args=(c,), daemon=True).start()
