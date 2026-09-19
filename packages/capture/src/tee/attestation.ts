import {access,constants} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {request} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,verify} from 'node:crypto';
import {canonicalJson,canonicalHash} from '../../../protocol/src/canonical.ts';
import {publicKey} from './channel.ts';
export interface RecorderPolicy {url:string;expires_at?:string;instances:Record<string,{role:string;compose_hash:string;historical_compose_hashes?:string[];os_image_hash:string;image?:string;mrtd?:string;rtmr0?:string;rtmr1?:string;rtmr2?:string}>}
export interface RecorderAssessment {hardware:'verified'|'unavailable';references:'matched'|'missing'|'mismatched'|'stale'|'unchecked';policy_source:string;app_id?:string;compose_hash?:string;quote_hash?:string;expected_compose_hash?:string}
export async function getQuote(statement:unknown,socketPath='/var/run/dstack.sock'):Promise<any>{
 return new Promise((resolve,reject)=>{const req=request({socketPath,path:'/GetQuote',method:'POST',headers:{'Content-Type':'application/json'}},res=>{let raw='';res.on('data',c=>{raw+=c;if(raw.length>2_000_000)req.destroy(Error('QUOTE_TOO_LARGE'));});res.on('end',()=>{try{if(res.statusCode!==200)throw Error('QUOTE_UNAVAILABLE');resolve({...JSON.parse(raw),statement});}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(30_000,()=>req.destroy(Error('QUOTE_TIMEOUT')));req.end(JSON.stringify({report_data:canonicalHash(statement)+'0'.repeat(64)}));});
}
async function qvlPath(){
 if(process.env.TV_DCAP_QVL){if(!isAbsolute(process.env.TV_DCAP_QVL))throw Error('DCAP_PATH_MUST_BE_ABSOLUTE');try{await access(process.env.TV_DCAP_QVL,constants.X_OK);}catch{throw Error('DCAP_VERIFIER_NOT_INSTALLED');}return process.env.TV_DCAP_QVL;}
 for(const dir of (process.env.PATH??'').split(':').filter(isAbsolute)){const path=join(dir,'dcap-qvl');try{await access(path,constants.X_OK);return path;}catch{}}
 throw Error('DCAP_VERIFIER_NOT_INSTALLED');
}
async function inspectRecorder(attestation:any,policy:RecorderPolicy,allowHistorical=false,referenceCheck=true):Promise<any>{
 const statement=attestation?.statement;
 if(statement?.purpose!=='thot.tee-recorder-key/1'||typeof statement.signing_key!=='string'||typeof statement.channel_key!=='string')throw Error('INVALID_RECORDER_IDENTITY');
 const qvl=await qvlPath();
 const script=fileURLToPath(new URL('../../../provenance/scripts/verify_recorder.py',import.meta.url));
 return new Promise((resolve,reject)=>{const p=spawn(process.env.THOT_CAPTURE_PYTHON??'python3',[script],{stdio:['pipe','pipe','pipe']});let out='';const timer=setTimeout(()=>p.kill('SIGKILL'),90_000);p.stdout.on('data',c=>{out+=c;if(out.length>8000)p.kill('SIGKILL');});p.stderr.resume();p.on('error',()=>{clearTimeout(timer);reject(Error('RECORDER_VERIFIER_UNAVAILABLE'));});p.on('close',code=>{clearTimeout(timer);try{const value=JSON.parse(out);if(code||value.verified!==true)throw Error(value.error??'RECORDER_VERIFIER_UNAVAILABLE');resolve(value);}catch(e){reject(e);}});p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify({attestation,instances:policy.instances,qvl,allow_historical:allowHistorical,reference_check:referenceCheck}));});
}
export async function verifyRecorder(attestation:any,policy:RecorderPolicy,allowHistorical=false):Promise<{verified:true;app_id:string;compose_hash:string;quote_hash:string}>{
 return inspectRecorder(attestation,policy,allowHistorical,true);
}
/** Normal mode may trust the HTTPS service when local verification is unavailable.
 * A verifier that actually rejects hardware or key binding is always fatal. */
export async function assessRecorder(attestation:any,policy:RecorderPolicy,options:{strict:boolean;policySource:string},inspect=inspectRecorder):Promise<RecorderAssessment>{
 const pins=policy.instances??{};
 const references=Object.keys(pins).length>0;
 if(options.strict&&!references)throw Error('RECORDER_REFERENCE_POLICY_REQUIRED');
 const expiry=policy.expires_at===undefined?undefined:Date.parse(policy.expires_at);
 if(policy.expires_at!==undefined&&!Number.isFinite(expiry))throw Error('RECORDER_POLICY_EXPIRY_INVALID');
 const stale=expiry!==undefined&&expiry<=Date.now();
 if(options.strict&&stale)throw Error('RECORDER_REFERENCE_POLICY_STALE');
 let identity:any;
 try{identity=await inspect(attestation,policy,false,false);}
 catch(error){
  const code=error instanceof Error?error.message:'';
  if(!['DCAP_VERIFIER_NOT_INSTALLED','RECORDER_VERIFIER_UNAVAILABLE'].includes(code))throw error;
  if(options.strict)throw Error('RECORDER_VERIFIER_REQUIRED');
  return {hardware:'unavailable',references:stale?'stale':references?'unchecked':'missing',policy_source:options.policySource};
 }
 const pin=pins[identity.app_id];
 const matched=pin?.role==='model-recorder'&&pin.compose_hash===identity.compose_hash&&pin.os_image_hash===identity.os_image_hash&&
   pin.mrtd===identity.mrtd&&[0,1,2].every(i=>pin['rtmr'+i as 'rtmr0'|'rtmr1'|'rtmr2']===identity['rtmr'+i]);
 const status=stale?'stale':references?(matched?'matched':'mismatched'):'missing';
 if(options.strict&&!matched)throw Error('RECORDER_REFERENCE_MISMATCH:'+identity.app_id+':'+identity.compose_hash+':expected:'+String(pin?.compose_hash??'unlisted'));
 return {hardware:'verified',references:status,policy_source:options.policySource,app_id:identity.app_id,compose_hash:identity.compose_hash,quote_hash:identity.quote_hash,...(pin?{expected_compose_hash:pin.compose_hash}:{})};
}
export function verifySeal(bundle:any,evidence:any,captureId:string,consentHash?:string){
 const statement=evidence?.statement;
 if(statement?.purpose!=='thot.tee-capture-seal/1'||statement.capture_id!==captureId||statement.bundle_hash!==canonicalHash(bundle)||statement.session_root!==bundle.root||statement.client!==bundle.client||(consentHash!==undefined&&statement.consent_hash!==consentHash))throw Error('TEE_CAPTURE_BINDING_MISMATCH');
 if(!verify(null,Buffer.from(canonicalJson(statement)),publicKey(evidence.attestation.statement.signing_key),Buffer.from(evidence.signature,'base64')))throw Error('TEE_CAPTURE_SIGNATURE_INVALID');
 return createHash('sha256').update(Buffer.from(evidence.attestation.quote,'hex')).digest('hex');
}
