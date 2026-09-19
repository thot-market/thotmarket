#!/usr/bin/env python3
"""Bounded stdio bridge for the local Robinhood browser companion."""
import argparse, datetime as dt, hashlib, json, os, re, sys, urllib.parse, urllib.error
import appraisal_transport, link_capture, reveal, robinhood_link
from link_ticket import verify_ticket
MAX_INPUT=65536; MAX_TOKEN=16384
class BridgeError(ValueError):
    def __init__(self,code,detail=None): super().__init__(code); self.detail=detail
def fail(code,detail=None): raise BridgeError(code,detail)
def _url(value):
    try: parsed=urllib.parse.urlsplit(value)
    except Exception: fail("INVALID_URL")
    if not isinstance(value,str) or parsed.scheme!="https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment: fail("INVALID_URL")
    return parsed
def _validate(request,capture, traded=False):
    required={"link_ticket","witness_url","appraiser_url","thot_public_key_pem","measurements","dcap_qvl"}
    expected=required|({"token"} if capture else set())
    if traded: expected |= {"purpose", "request"}
    if not isinstance(request,dict) or set(request)!=expected: fail("INVALID_REQUEST")
    if "purpose" in request and request.get("purpose") != "traded": fail("INVALID_REQUEST")
    if traded and request.get("purpose") != "traded": fail("INVALID_REQUEST")
    witness=_url(request.get("witness_url")); _url(request.get("appraiser_url"))
    for key in ("measurements","dcap_qvl"):
        value=request.get(key)
        if not isinstance(value,str) or not os.path.isabs(value) or not os.path.isfile(value): fail("INVALID_LOCAL_FILE")
    if not os.access(request["dcap_qvl"],os.X_OK): fail("INVALID_LOCAL_FILE")
    try: verify_ticket(request["link_ticket"],request["thot_public_key_pem"])
    except Exception: fail("INVALID_LINK_TICKET")
    if capture and (not isinstance(request.get("token"),str) or not request["token"] or len(request["token"])>MAX_TOKEN or any(c in request["token"] for c in "\r\n\0")): fail("INVALID_TOKEN")
    if traded:
        req = request.get("request")
        if not isinstance(req, dict) or set(req) != {"symbol", "window_days", "trace_ts"}:
            fail("INVALID_OUTCOME_REQUEST")
        if not isinstance(req["symbol"], str) or re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", req["symbol"]) is None: fail("INVALID_OUTCOME_REQUEST")
        if not isinstance(req["window_days"], int) or isinstance(req["window_days"], bool) or not 0 < req["window_days"] <= 365 or not isinstance(req["trace_ts"], str): fail("INVALID_OUTCOME_REQUEST")
        try:
            parsed = dt.datetime.fromisoformat(req["trace_ts"].replace("Z", "+00:00"))
            if parsed.tzinfo is None: raise ValueError
        except (TypeError, ValueError): fail("INVALID_OUTCOME_REQUEST")
    return witness
def _preflight(request):
    issuer=hashlib.sha256(request["thot_public_key_pem"].encode()).hexdigest()
    try:
        with link_capture._opener.open(request["appraiser_url"].rstrip("/")+"/identity",timeout=20) as response: identity=json.load(response)
        appraisal_transport.verify_identity(identity,issuer,qvl=request["dcap_qvl"],measurements_path=request["measurements"])
    except Exception as exc: fail("APPRAISER_IDENTITY_INVALID",f"{type(exc).__name__}: {exc}"[:300])
def _ticket_live(request):
    try:
        payload = verify_ticket(request["link_ticket"], request["thot_public_key_pem"])
        expiry = dt.datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
        if expiry <= dt.datetime.now(dt.timezone.utc): fail("INVALID_LINK_TICKET")
    except BridgeError: raise
    except Exception: fail("INVALID_LINK_TICKET")
def execute(request,mode):
    traded = mode == "capture-traded" or (isinstance(request, dict) and request.get("purpose") == "traded")
    witness=_validate(request,mode in ("capture", "capture-traded"), traded); _preflight(request)
    if mode=="preflight": return {"ready":True}
    try:
        if not traded:
            bundle=link_capture.capture(request["link_ticket"],witness.hostname,witness.port or 443,token=request["token"],witness_base=request["witness_url"])
            result=link_capture.appraise(bundle,request["appraiser_url"],request["thot_public_key_pem"].encode(),request["dcap_qvl"],request["measurements"])
        else:
            _ticket_live(request)
            orders=link_capture.capture(request["link_ticket"],witness.hostname,witness.port or 443,token=request["token"],witness_base=request["witness_url"],request_path="/orders/")
            # Decrypt only long enough to discover the instrument IDs. The raw response is
            # never serialized into the request outside the sealed appraiser transport.
            secrets=orders["secrets"]
            plain=reveal.decrypt_dir(bytes.fromhex(orders["cipher_down"]),bytes.fromhex(secrets["SERVER_TRAFFIC_SECRET_0"]),orders["cipher_suite"])
            data, _observed=robinhood_link.parse_http_json(plain)
            if not isinstance(data, dict) or not isinstance(data.get("results"), list) or data.get("next") is not None or data.get("previous") is not None:
                fail("INVALID_ORDERS_SCHEMA")
            ids=[]
            for order in data["results"]:
                ident=order.get("instrument_id") if isinstance(order,dict) else None
                if not isinstance(ident,str) or re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",ident) is None: fail("INVALID_INSTRUMENT_ID")
                if ident not in ids: ids.append(ident)
            if not ids or len(ids)>32: fail("INVALID_ORDERS_SCHEMA")
            instruments=[]
            bundle={"schema_version":"trace-vault.robinhood-orders-capture/1","link_ticket":request["link_ticket"],"orders":orders,"instruments":instruments}
            def bound_bundle():
                if len(appraisal_transport.canon({**bundle,"request":request["request"]})) > appraisal_transport.MAX_PLAINTEXT - 1024: fail("CAPTURE_TOO_LARGE")
            bound_bundle()
            for ident in ids:
                _ticket_live(request)
                if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", ident) is None: fail("INVALID_INSTRUMENT_ID")
                instruments.append(link_capture.capture(request["link_ticket"],witness.hostname,witness.port or 443,token=request["token"],witness_base=request["witness_url"],request_path="/instruments/"+ident+"/"))
                bound_bundle()
            _ticket_live(request)
            result=link_capture.appraise_traded(bundle,request["request"],request["appraiser_url"],request["thot_public_key_pem"].encode(),request["dcap_qvl"],request["measurements"])
    except BridgeError: raise
    except urllib.error.HTTPError as exc:
        try: code=json.loads(exc.read(16384)).get("error")
        except Exception: code=None
        mapped={"http_status_not_200":"APPRAISAL_HTTP_REJECTED","invalid_accounts_schema":"APPRAISAL_SCHEMA_REJECTED","invalid_account_url":"APPRAISAL_SCHEMA_REJECTED","tls_reveal_invalid":"APPRAISAL_TLS_REJECTED","witness_attestation_invalid":"APPRAISAL_WITNESS_REJECTED","invalid_link_ticket":"INVALID_LINK_TICKET"}
        fail(mapped.get(code,"CAPTURE_OR_APPRAISAL_FAILED"))
    except Exception: fail("CAPTURE_OR_APPRAISAL_FAILED")
    if not isinstance(result,dict) or set(result)!={"credential","witness_receipts"}: fail("INVALID_PUBLIC_EVIDENCE")
    return result
def main():
    p=argparse.ArgumentParser(); p.add_argument("mode",choices=("preflight","capture","capture-traded")); a=p.parse_args()
    try:
        raw=sys.stdin.buffer.read(MAX_INPUT+1)
        if not raw or len(raw)>MAX_INPUT: fail("INVALID_REQUEST_SIZE")
        try: request=json.loads(raw)
        except Exception: fail("INVALID_JSON")
        sys.stdout.write(json.dumps(execute(request,a.mode),separators=(",", ":"))+"\n")
    except BridgeError as exc:
        sys.stderr.write(json.dumps({"error":str(exc),**({"detail":exc.detail} if getattr(exc,"detail",None) else {})},separators=(",", ":"))+"\n"); raise SystemExit(1)
if __name__=="__main__": main()
