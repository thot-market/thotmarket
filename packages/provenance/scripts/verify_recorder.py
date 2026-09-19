"""Current DCAP verification plus quoted key and approved measured recorder identity."""
import hashlib,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[3]/'trace-vault'))
from attestation_verify import _qvl,_td,_digest

def check(value):
 a=value['attestation']; statement=a['statement']
 if statement.get('purpose')!='thot.tee-recorder-key/1': raise ValueError('RECORDER_KEY_DOMAIN_INVALID')
 verified=_qvl(value['qvl'],'verify',a['quote']); td=_td(_qvl(value['qvl'],'decode',a['quote']))
 if verified.get('status')!='UpToDate' or int.from_bytes(bytes.fromhex(td['td_attributes']),'little')&1: raise ValueError('RECORDER_PLATFORM_REJECTED')
 canon=json.dumps(statement,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
 if td.get('report_data') != hashlib.sha256(canon).hexdigest()+'0'*64: raise ValueError('RECORDER_KEY_BINDING_INVALID')
 log=a['event_log'];log=json.loads(log) if isinstance(log,str) else log
 replay={i:bytes(48) for i in range(4)}; identities={}
 for e in log:
  i=e.get('imr');d=_digest(e)
  if i in replay and d is not None: replay[i]=hashlib.sha384(replay[i]+(d+bytes(48))[:48]).digest()
  if i==3 and e.get('event_type')==0x08000001 and e.get('event') in ['app-id','compose-hash','os-image-hash']:
   if e['event'] in identities: raise ValueError('RECORDER_DUPLICATE_IDENTITY')
   identities[e['event']]=e['event_payload']
 if any(replay[i].hex()!=td.get('rt_mr'+str(i)) for i in range(4)): raise ValueError('RECORDER_EVENT_LOG_INVALID')
 if value.get('reference_check') is not False:
  pin=value['instances'].get(identities.get('app-id'))
  if not pin or pin.get('role')!='model-recorder' or pin['os_image_hash']!=identities.get('os-image-hash'): raise ValueError('RECORDER_MEASUREMENT_REJECTED')
  approved=[pin['compose_hash']]+(pin.get('historical_compose_hashes',[]) if value.get('allow_historical') is True else [])
  if identities.get('compose-hash') not in approved: raise ValueError('RECORDER_MEASUREMENT_REJECTED')
  if pin.get('mrtd')!=td.get('mr_td') or any(pin.get('rtmr'+str(i))!=td.get('rt_mr'+str(i)) for i in range(3)): raise ValueError('RECORDER_BOOT_MEASUREMENT_REJECTED')
 return {'verified':True,'app_id':identities['app-id'],'compose_hash':identities['compose-hash'],'os_image_hash':identities['os-image-hash'],'mrtd':td.get('mr_td'),'rtmr0':td.get('rt_mr0'),'rtmr1':td.get('rt_mr1'),'rtmr2':td.get('rt_mr2'),'quote_hash':hashlib.sha256(bytes.fromhex(a['quote'])).hexdigest()}
if __name__=='__main__':
 try:
  raw=sys.stdin.buffer.read(2_000_001)
  if len(raw)>2_000_000: raise ValueError('RECORDER_ATTESTATION_TOO_LARGE')
  print(json.dumps(check(json.loads(raw))))
 except Exception as e:
  message=str(e)
  print(json.dumps({'error':message if message.startswith('RECORDER_') else 'RECORDER_DCAP_REJECTED'}));sys.exit(1)
