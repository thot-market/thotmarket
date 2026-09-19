import datetime as dt, hashlib, json, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives import serialization
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import appraisal_transport as t
import attestation_verify as av
import robinhood_appraiser as service

signer=Ed25519PrivateKey.generate(); encryption=X25519PrivateKey.generate(); now=dt.datetime.now(dt.timezone.utc)
statement={"purpose":t.PURPOSE,"encryption_public_key":encryption.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw).hex(),
 "vault_pubkey":signer.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw).hex(),
 "thot_issuer_sha256":"ab"*32,"expires_at":(now+dt.timedelta(minutes=5)).isoformat().replace("+00:00","Z")}
identity={**statement,"attestation":{"mode":"mock"},"signature":signer.sign(t.canon(statement)).hex()}
t.verify_identity(identity,"ab"*32,now=now,verifier=lambda *args:True)
payload={"schema_version":"trace-vault.robinhood-capture/1","secrets":{"SERVER_TRAFFIC_SECRET_0":"secret"}}
sealed=t.seal(payload,identity); opened,replay=t.open_sealed(sealed,identity,encryption)
assert opened==payload and len(replay)==64
bad=json.loads(json.dumps(sealed)); bad["ciphertext"]=("A" if bad["ciphertext"][0]!="A" else "B")+bad["ciphertext"][1:]
try: t.open_sealed(bad,identity,encryption); raise AssertionError("tamper accepted")
except ValueError as exc: assert str(exc)=="sealed_request_authentication_failed"
wrong=json.loads(json.dumps(identity)); wrong["thot_issuer_sha256"]="cd"*32
try: t.verify_identity(wrong,"ab"*32,now=now,verifier=lambda *args:True); raise AssertionError("wrong issuer accepted")
except ValueError: pass
try: t.verify_identity(identity,"ab"*32,now=now); raise AssertionError("mock identity accepted")
except ValueError: pass

# An unmeasured appended identity event must not select an approved pin.
att_stmt={"purpose":"trace-vault.report_data.v1","vault_pubkey":"11"*32,"nonce":None}
events=[{"imr":3,"event_type":0x08000001,"event":"app-id","event_payload":"ee"*20},
        {"imr":99,"event_type":0x08000001,"event":"app-id","event_payload":"aa"*20},
        {"imr":99,"event_type":0x08000001,"event":"compose-hash","event_payload":"bb"*32},
        {"imr":99,"event_type":0x08000001,"event":"os-image-hash","event_payload":"bb"*32}]
replay={i:b"\0"*48 for i in range(4)}
for event in events:
    digest=av._digest(event); index=event["imr"]
    if index in replay: replay[index]=hashlib.sha384(replay[index]+(digest+b"\0"*48)[:48]).digest()
decoded={"report":{"TD10":{"report_data":hashlib.sha256(av._canon(att_stmt)).hexdigest()+"00"*32,
    **{f"rt_mr{i}":replay[i].hex() for i in range(4)}}}}
old_qvl=av._qvl; av._qvl=lambda *args: decoded
try:
    try: av.verify_attested_key({"mode":"tdx","quote":"x","statement":att_stmt,"event_log":events},"11"*32,"appraiser",
        measurements={"instances":{"aa"*20:{"role":"appraiser","compose_hash":"bb"*32,"os_image_hash":"bb"*32}}}); raise AssertionError("unmeasured identity accepted")
    except ValueError as exc: assert str(exc)=="unapproved_attested_role"
finally: av._qvl=old_qvl

# Service rotates an expired transport key/identity instead of remaining dead.
service._thot_pem=b"fixture issuer"; service._identity={"expires_at":"2000-01-01T00:00:00Z"}
service._renew()
assert dt.datetime.fromisoformat(service._identity["expires_at"].replace("Z","+00:00")) > dt.datetime.now(dt.timezone.utc)
print("test_appraisal_transport: PASS")
