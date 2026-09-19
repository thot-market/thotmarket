"""Synthetic bridge checks for the bounded traded capture path.

No brokerage, cookie store, or network endpoint is used here.  The transport
functions are replaced with an injectable witness fixture so this test checks
the request shape and path routing only.
"""
import os
import pathlib
import sys
import tempfile
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import browser_capture as bridge
real_capture = bridge.link_capture.capture

with tempfile.NamedTemporaryFile() as pins, tempfile.NamedTemporaryFile() as qvl:
    os.chmod(qvl.name, 0o700)
    request = {"link_ticket": "ticket", "witness_url": "https://w.example",
               "appraiser_url": "https://a.example", "thot_public_key_pem": "pem",
               "measurements": pins.name, "dcap_qvl": qvl.name, "token": "A" * 16,
               "purpose": "traded", "request": {"symbol": "NVDA", "window_days": 7,
               "trace_ts": "2026-09-07T16:00:00Z"}}
    bridge.verify_ticket = lambda *_args, **_kw: {"expires_at": "2099-01-01T00:00:00Z"}
    bridge._preflight = lambda *_args: None
    seen = []
    def capture(*_args, **kwargs):
        seen.append(kwargs["request_path"])
        return {"schema_version": "trace-vault.robinhood-capture/1", "cipher_down": "00",
                "secrets": {"SERVER_TRAFFIC_SECRET_0": "00"}, "cipher_suite": "TLS_AES_128_GCM_SHA256"}
    bridge.link_capture.capture = capture
    bridge.reveal.decrypt_dir = lambda *_args: b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 77\r\nDate: Mon, 07 Sep 2026 16:00:00 GMT\r\n\r\n{\"results\":[{\"instrument_id\":\"abc-1\"}],\"next\":null,\"previous\":null}"
    bridge.robinhood_link.parse_http_json = lambda _raw: ({"results": [{"instrument_id": "12345678-1234-1234-1234-123456789abc"}], "next": None, "previous": None}, None)
    bridge.link_capture.appraise_traded = lambda *_args, **_kw: {"credential": {"value": True}, "witness_receipts": []}
    result = bridge.execute(request, "capture-traded")
    assert seen == ["/orders/", "/instruments/12345678-1234-1234-1234-123456789abc/"]
    assert result["credential"]["value"] is True

    bad = dict(request); bad["request"] = {"symbol": "NVDA", "window_days": 366, "trace_ts": request["request"]["trace_ts"]}
    try:
        bridge.execute(bad, "capture-traded")
    except bridge.BridgeError as exc:
        assert str(exc) == "INVALID_OUTCOME_REQUEST"
    else:
        raise AssertionError("out-of-range window accepted")

    def reject(code, value=request):
        try: bridge.execute(value, "capture-traded")
        except bridge.BridgeError as exc: assert str(exc) == code, str(exc)
        else: raise AssertionError("unexpected accepted capture")

    for bad_predicate in [{"symbol":"aapl"},{"trace_ts":"2026-09-07T16:00:00"},{"window_days":True}]:
        bad={**request,"request":{**request["request"],**bad_predicate}}
        reject("INVALID_OUTCOME_REQUEST",bad)
    reject("INVALID_REQUEST",{**request,"purpose":"unknown"})
    for data in [{"results":[],"next":"https://api.robinhood.com/orders/?cursor=more"},
                 {"results":[{"instrument_id":"../other"}]}, {"results":[{}]}]:
        seen.clear(); bridge.robinhood_link.parse_http_json=lambda _raw,d=data:(d,None)
        reject("INVALID_ORDERS_SCHEMA" if data.get("next") else "INVALID_INSTRUMENT_ID")
        assert seen == ["/orders/"]
    bridge.robinhood_link.parse_http_json=lambda _raw:({"results":[{"instrument_id":"12345678-1234-1234-1234-123456789abc"}]},None)
    checks=[0]
    def expires_mid_capture(*args,**kwargs):
        checks[0]+=1
        if checks[0]>=3: raise ValueError("expired")
        return {"expires_at":"2099-01-01T00:00:00Z"}
    bridge.verify_ticket=expires_mid_capture;seen.clear();reject("INVALID_LINK_TICKET");assert seen==["/orders/"]

# Invalid paths must fail before any network connection or browser token use.
bridge.link_capture._connect_proxy=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError("network attempted"))
for path in ["/orders/\r\nX-Evil: yes","/orders/?cursor=x","/instruments/../", "https://evil.example/"]:
    try: real_capture("ticket",token="synthetic-token",request_path=path)
    except ValueError as exc: assert str(exc)=="invalid_request_path"
    else: raise AssertionError("unsafe path accepted")
print("test_browser_trade_capture: PASS")
