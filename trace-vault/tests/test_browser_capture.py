import os,sys,tempfile
sys.path.insert(0,os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import browser_capture as b
with tempfile.NamedTemporaryFile() as pins,tempfile.NamedTemporaryFile() as qvl:
 os.chmod(qvl.name,0o700); request={"link_ticket":"ticket","witness_url":"https://w.example","appraiser_url":"https://a.example","thot_public_key_pem":"pem","measurements":pins.name,"dcap_qvl":qvl.name}
 old_ticket,old_preflight=b.verify_ticket,b._preflight; b.verify_ticket=lambda *a:{}; b._preflight=lambda r:None
 try:
  assert b.execute(request,"preflight")=={"ready":True}
  bad=dict(request);bad["witness_url"]="https://u:p@w.example"
  try:b.execute(bad,"preflight");raise AssertionError()
  except b.BridgeError as e:assert str(e)=="INVALID_URL"
  capture={**request,"token":"private-token"}; old_capture,old_appraise=b.link_capture.capture,b.link_capture.appraise
  b.link_capture.capture=lambda *a,**k:{"private":"bundle"};b.link_capture.appraise=lambda *a,**k:{"credential":{},"witness_receipts":[]}
  assert set(b.execute(capture,"capture"))=={"credential","witness_receipts"}
  capture["token"]="x\nsecret"
  try:b.execute(capture,"capture");raise AssertionError()
  except b.BridgeError as e:assert str(e)=="INVALID_TOKEN"
  b.link_capture.capture,b.link_capture.appraise=old_capture,old_appraise
 finally:b.verify_ticket,b._preflight=old_ticket,old_preflight
print("test_browser_capture: PASS")
