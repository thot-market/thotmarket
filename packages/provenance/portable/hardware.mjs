import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalHash} from './canonical.mjs';
const check=(v,c)=>{if(!v)throw Error(c);};
const sha384=b=>createHash('sha384').update(b).digest();
const fromHex=(v,n)=>{check(typeof v==='string'&&/^(?:[a-f0-9]{2})*$/.test(v)&&(n===undefined||v.length===n*2),'INVALID_ATTESTATION_HEX');return Buffer.from(v,'hex');};

/** Input claims must be the result of independently authenticated DCAP verification.
 * This exported pure function is only the subsequent binding/policy check. */
export function checkRecorderBindings(attestation,claims,policy,{allowHistorical=false}={}){
 check(claims.verified===true&&claims.status==='UpToDate'&&claims.debug===false,'RECORDER_PLATFORM_REJECTED');
 const quoteHash=createHash('sha256').update(fromHex(attestation.quote)).digest('hex');
 check(claims.quote_hash===quoteHash,'QUOTE_HASH_MISMATCH');
 check(claims.report_data===canonicalHash(attestation.statement)+'0'.repeat(64),'RECORDER_KEY_BINDING_INVALID');
 let log=attestation.event_log;if(typeof log==='string')log=JSON.parse(log);
 check(Array.isArray(log)&&log.length<=4096,'RECORDER_EVENT_LOG_INVALID');
 const replay=Array.from({length:4},()=>Buffer.alloc(48)),identities={};
 for(const e of log){
  check(e&&typeof e==='object','RECORDER_EVENT_LOG_INVALID');
  let digest;
  if(e.event_type===0x08000001){check(typeof e.event==='string'&&e.event.length<=4096,'RECORDER_EVENT_LOG_INVALID');const type=Buffer.alloc(4);type.writeUInt32LE(e.event_type);digest=sha384(Buffer.concat([type,Buffer.from(':'+e.event+':'),fromHex(e.event_payload??'')]));}
  else if(e.digest)digest=fromHex(e.digest);
  if(Number.isInteger(e.imr)&&e.imr>=0&&e.imr<4&&digest)replay[e.imr]=sha384(Buffer.concat([replay[e.imr],Buffer.concat([digest,Buffer.alloc(48)]).subarray(0,48)]));
  if(e.imr===3&&e.event_type===0x08000001&&['app-id','compose-hash','os-image-hash'].includes(e.event)){check(!Object.hasOwn(identities,e.event),'RECORDER_DUPLICATE_IDENTITY');identities[e.event]=e.event_payload;}
 }
 for(let i=0;i<4;i++)check(replay[i].toString('hex')===claims.measurements?.['rtmr'+i],'RECORDER_EVENT_LOG_INVALID');
 const pin=policy?.instances?.[identities['app-id']];
 check(pin?.role==='model-recorder'&&pin.os_image_hash===identities['os-image-hash'],'RECORDER_POLICY_REJECTED');
 const approved=[pin.compose_hash,...(allowHistorical?pin.historical_compose_hashes??[]:[])];
 check(approved.includes(identities['compose-hash']),'RECORDER_POLICY_REJECTED');
 check(pin.mrtd===claims.measurements.mrtd&&[0,1,2].every(i=>pin['rtmr'+i]===claims.measurements['rtmr'+i]),'RECORDER_BOOT_MEASUREMENT_REJECTED');
 return {hardware:'INTEL_DCAP_VERIFIED',recorder_policy:'APPROVED',quote_hash:quoteHash,policy_hash:canonicalHash(policy),verification_time_seconds:claims.verification_time_seconds,collateral_expires_at_seconds:claims.earliest_expiration_seconds,historical_policy_allowed:allowHistorical,trusted_recording_time:'NOT_ESTABLISHED'};
}

export async function verifyHardware(attestation,policy,collateral,{python,at=Math.floor(Date.now()/1000),allowHistorical=false}={}){
 check(typeof python==='string'&&isAbsolute(python),'ABSOLUTE_PYTHON_REQUIRED');
 check(Number.isSafeInteger(at)&&at>=0&&at<=Math.floor(Date.now()/1000)+300,'INVALID_VERIFICATION_TIME');
 check(typeof attestation?.quote==='string','HARDWARE_EVIDENCE_MISSING');
 const flags=policy?.platform_policy??{allow_dynamic_platform:false,allow_cached_keys:false,allow_smt:false};
 check(Object.keys(flags).length===3&&['allow_dynamic_platform','allow_cached_keys','allow_smt'].every(k=>typeof flags[k]==='boolean'),'INVALID_PLATFORM_POLICY');
 const input=JSON.stringify({protocol:'thot.dcap-offline/1',quote_hex:attestation.quote,collateral,verification_time_seconds:at,platform_policy:flags});
 check(Buffer.byteLength(input)<=2_000_000,'DCAP_INPUT_LIMIT');
 const claims=await new Promise((resolve,reject)=>{
  const child=spawn(python,['-I','-B',fileURLToPath(new URL('./verify_dcap.py',import.meta.url))],{shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  let output='',done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(Error(error));}else resolve(value);};
  const timer=setTimeout(()=>finish('DCAP_VERIFIER_TIMEOUT'),60000);child.on('error',()=>finish('DCAP_VERIFIER_UNAVAILABLE'));child.stdin.on('error',()=>finish('DCAP_INPUT_FAILED'));child.stderr.resume();
  child.stdout.on('data',b=>{output+=b;if(output.length>16384)finish('DCAP_OUTPUT_LIMIT');});
  child.on('close',code=>{try{const v=JSON.parse(output);if(code||v.verified!==true)return finish(v.error==='DCAP_LIBRARY_UNAVAILABLE'?v.error:'DCAP_VERIFICATION_FAILED');finish(undefined,v);}catch{finish('DCAP_VERIFICATION_FAILED');}});child.stdin.end(input);
 });
 check(claims.protocol==='thot.dcap-offline/1'&&claims.library_version==='0.6.1'&&claims.verification_time_seconds===at&&claims.earliest_expiration_seconds>=at&&Object.entries(flags).every(([k,v])=>claims.platform_policy?.[k]===v),'INVALID_DCAP_RESPONSE');
 return checkRecorderBindings(attestation,claims,policy,{allowHistorical});
}
