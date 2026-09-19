"""TLS 1.3 reveal (M2 core). Given a direction's raw ciphertext + that direction's traffic
secret (from an SSLKEYLOGFILE) + the negotiated suite, recover the application plaintext AND
verify the session was really with the named host's certificate.

Two properties, both against the Witness's hardware-attested ciphertext (never the tunnel's
word):
  - decrypt_dir: app plaintext, with a sound handshake->app transition (try app secret, advance
    seq only on AEAD success), KeyUpdate ratchet, and fail-CLOSED after the first app record.
  - verify_cert_chain: decrypt the server handshake with the handshake secret, check the leaf
    cert covers `host` and chains to a system root, and verify CertificateVerify over the real
    transcript — so a seller cannot front their own origin on a shared IP (SNI-fronting).
"""
import hashlib, hmac
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, ec, ed25519
from cryptography.x509.verification import PolicyBuilder, Store
import certifi

def _hkdf_expand_label(secret, label, ctx, length, hashmod):
    full = b"tls13 " + label
    info = length.to_bytes(2, "big") + bytes([len(full)]) + full + bytes([len(ctx)]) + ctx
    out, t, i = b"", b"", 1
    while len(out) < length:
        t = hmac.new(secret, t + info + bytes([i]), hashmod).digest(); out += t; i += 1
    return out[:length]

SUITES = {  # negotiated name -> (hash, key length, aead)
    "TLS_AES_128_GCM_SHA256": (hashlib.sha256, 16, "aesgcm"),
    "TLS_AES_256_GCM_SHA384": (hashlib.sha384, 32, "aesgcm"),
    "TLS_CHACHA20_POLY1305_SHA256": (hashlib.sha256, 32, "chacha"),
}

def _traffic_keys(secret, hashmod, klen, aead):
    key = _hkdf_expand_label(secret, b"key", b"", klen, hashmod)
    iv = _hkdf_expand_label(secret, b"iv", b"", 12, hashmod)
    dec = (AESGCM(key) if aead == "aesgcm" else ChaCha20Poly1305(key)).decrypt
    return dec, iv

def _nonce(iv, seq):
    return bytes(a ^ b for a, b in zip(iv, b"\x00\x00\x00\x00" + seq.to_bytes(8, "big")))

def _records(ciphertext):
    """Yield (outer_type, header, body) for each TLS record."""
    i, n = 0, len(ciphertext)
    while i + 5 <= n:
        hdr = ciphertext[i:i + 5]; ln = int.from_bytes(hdr[3:5], "big")
        body = ciphertext[i + 5:i + 5 + ln]; i += 5 + ln
        if len(body) != ln: break
        yield hdr[0], hdr, body

def _unpad(pt):
    j = len(pt) - 1
    while j >= 0 and pt[j] == 0: j -= 1
    if j < 0: raise ValueError("all-zero TLS inner plaintext (illegal)")
    return pt[:j], pt[j]                                     # (content, inner_type)

def decrypt_dir(ciphertext: bytes, app_secret: bytes, suite: str) -> bytes:
    """Recover application data. Skips handshake-secret records (wrong key -> AEAD fail) only
    until the first successful app-secret decrypt; after that any AEAD failure RAISES (a gap,
    corruption, or KeyUpdate we failed to track must not be silently dropped)."""
    hashmod, klen, aead = SUITES[suite]
    secret = app_secret
    dec, iv = _traffic_keys(secret, hashmod, klen, aead)
    out, seq, started = bytearray(), 0, False
    for typ, hdr, body in _records(ciphertext):
        if typ != 0x17 or len(body) < 16:
            if started: raise ValueError("unexpected record after application data began")
            continue
        try:
            pt = dec(_nonce(iv, seq), bytes(body), bytes(hdr))
        except Exception:
            if started: raise ValueError("AEAD tag failed after app data began (gap/corruption)")
            continue                                         # still on handshake secret; skip
        started = True; seq += 1
        content, it = _unpad(pt)
        if it == 0x17:
            out += content
        elif it == 0x16 and content[:1] == b"\x18":          # KeyUpdate -> ratchet, reset seq
            secret = _hkdf_expand_label(secret, b"traffic upd", b"", hashmod().digest_size, hashmod)
            dec, iv = _traffic_keys(secret, hashmod, klen, aead); seq = 0
        # inner 0x16 NewSessionTicket / 0x15 alert: consume, emit nothing
    return bytes(out)

def _hs_messages(down, hs_secret, suite):
    """Return (server_hello_msg, {msg_type: msg_bytes}) by decrypting the server's handshake
    flight from the down stream with the handshake traffic secret."""
    hashmod, klen, aead = SUITES[suite]
    dec, iv = _traffic_keys(hs_secret, hashmod, klen, aead)
    sh, blob, seq = None, bytearray(), 0
    for typ, hdr, body in _records(down):
        if typ == 0x16 and sh is None:                       # plaintext ServerHello
            sh = bytes(body); continue
        if typ == 0x14: continue                             # ChangeCipherSpec (compat)
        if typ != 0x17: continue
        try:
            pt = dec(_nonce(iv, seq), bytes(body), bytes(hdr))
        except Exception:
            break                                            # reached app-secret data; handshake done
        seq += 1
        content, it = _unpad(pt)
        if it == 0x16: blob += content
        else: break
    msgs, p = {}, 0
    while p + 4 <= len(blob):
        t = blob[p]; ln = int.from_bytes(blob[p+1:p+4], "big")
        msgs[t] = bytes(blob[p:p+4+ln]); p += 4 + ln
    return sh, msgs

_HASH = {0x0804: hashes.SHA256, 0x0805: hashes.SHA384, 0x0806: hashes.SHA512,
         0x0403: hashes.SHA256, 0x0503: hashes.SHA384, 0x0603: hashes.SHA512}

def _verify_certverify(leaf, scheme, sig, transcript):
    signed = b"\x20" * 64 + b"TLS 1.3, server CertificateVerify" + b"\x00" + transcript
    pub = leaf.public_key()
    if scheme in (0x0804, 0x0805, 0x0806):                    # rsa_pss_rsae_*
        h = _HASH[scheme]()
        pub.verify(sig, signed, padding.PSS(mgf=padding.MGF1(h), salt_length=h.digest_size), h)
    elif scheme in (0x0403, 0x0503, 0x0603):                  # ecdsa_*
        pub.verify(sig, signed, ec.ECDSA(_HASH[scheme]()))
    elif scheme == 0x0807:                                    # ed25519
        pub.verify(sig, signed)
    else:
        raise ValueError(f"unsupported CertificateVerify scheme 0x{scheme:04x}")

def verify_cert_chain(down: bytes, client_hello_record: bytes, hs_secret: bytes, suite: str, host: str):
    """Prove the down ciphertext is a TLS 1.3 session with a certificate valid for `host`:
    leaf covers host + chains to a system root (PolicyBuilder), and CertificateVerify signs the
    real transcript (ClientHello..Certificate) with the leaf key. Raises on any failure."""
    hashmod = SUITES[suite][0]
    ch = client_hello_record[5:] if client_hello_record[:1] == b"\x16" else client_hello_record
    sh, msgs = _hs_messages(down, hs_secret, suite)
    ee, cert_msg, cv = msgs.get(0x08), msgs.get(0x0b), msgs.get(0x0f)
    if not (sh and ee and cert_msg and cv):
        raise ValueError("incomplete handshake (need ServerHello, EE, Certificate, CertificateVerify)")
    transcript = hashmod(ch + sh + ee + cert_msg).digest()

    p = 4 + 1 + cert_msg[4]                                   # msg header(4) + request_context
    p += 3                                                    # certificate_list length
    ders = []
    while p + 3 <= len(cert_msg):
        clen = int.from_bytes(cert_msg[p:p+3], "big"); p += 3
        ders.append(cert_msg[p:p+clen]); p += clen
        p += 2 + int.from_bytes(cert_msg[p:p+2], "big")      # cert extensions
    leaf = x509.load_der_x509_certificate(ders[0])
    inters = [x509.load_der_x509_certificate(d) for d in ders[1:]]

    scheme = int.from_bytes(cv[4:6], "big"); siglen = int.from_bytes(cv[6:8], "big")
    _verify_certverify(leaf, scheme, cv[8:8+siglen], transcript)   # binds session to the leaf key

    roots = x509.load_pem_x509_certificates(open(certifi.where(), "rb").read())
    PolicyBuilder().store(Store(roots)).build_server_verifier(x509.DNSName(host)).verify(leaf, inters)
    return leaf                                               # valid for host, chained, key-proven

def parse_keylog(text):
    """{label: secret}. Raises if the log holds more than one session (distinct client_random),
    so secrets from different sessions can never silently overwrite each other."""
    sessions = {}
    for line in text.splitlines():
        p = line.split()
        if len(p) == 3:
            sessions.setdefault(p[1], {})[p[0]] = bytes.fromhex(p[2])
    if len(sessions) > 1:
        raise ValueError(f"{len(sessions)} sessions in keylog; disambiguate by client_random")
    return next(iter(sessions.values()), {})
