#!/usr/bin/env node
/** Independent /2 verifier: Node built-ins only; no network, native CLI or vault. */
import {createPublicKey, verify} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {resolve, sep, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyHardware} from './hardware.mjs';
import {canonicalHash, canonicalJson} from './canonical.mjs';

export const limits={metadata:2_000_000,part:60*1024*1024,total:1024*1024*1024,parts:4096};
export const check=(ok,code)=>{if(!ok)throw Error(code);};
const exact=(v,required,optional=[])=>{check(v&&typeof v==='object'&&!Array.isArray(v),'INVALID_OBJECT');check(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)),'INVALID_FIELDS');};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const b64=v=>{check(typeof v==='string'&&v.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(v),'INVALID_BASE64');const b=Buffer.from(v,'base64');check(b.toString('base64')===v,'INVALID_BASE64');return b;};

export async function verifyEvidence(value,readPart){
 exact(value,['format','bundle','evidence'],['consent']);check(value.format==='thot.capture-export/1','UNSUPPORTED_EXPORT_VERSION');
 const {bundle:b,evidence:e}=value;
 exact(b,['format','capture_id','client','started_at','finished_at','parts','root']);
 check(b.format==='thot.proxy-capture/2','UNSUPPORTED_CAPTURE_VERSION');
 check(['claude','codex'].includes(b.client)&&typeof b.capture_id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(b.capture_id),'INVALID_CAPTURE_IDENTITY');
 check(date(b.started_at)&&date(b.finished_at)&&b.started_at<=b.finished_at,'INVALID_CAPTURE_TIME');
 check(Array.isArray(b.parts)&&b.parts.length>0&&b.parts.length<=limits.parts,'INVALID_PART_COUNT');
 const {root,...manifest}=b;check(hex(root)&&canonicalHash(manifest)===root,'MANIFEST_ROOT_MISMATCH');
 let interrupted=0;
 for(const [i,d] of b.parts.entries()){
  exact(d,['sequence','commitment']);check(d.sequence===i+1&&hex(d.commitment),'INVALID_PART_SEQUENCE');
  const p=await readPart(d);check(p,'PART_MISSING');
  exact(p,['sequence','upstream','path','request_body_b64','response_body_b64','status','content_type','started_at','finished_at','complete','commitment'],['request_method','request_encoding']);
  const {commitment,...record}=p;
  check(p.sequence===d.sequence&&commitment===d.commitment&&canonicalHash(record)===commitment,'PART_COMMITMENT_MISMATCH');
  check(p.upstream===(b.client==='claude'?'https://api.anthropic.com':'https://chatgpt.com'),'INVALID_PART_UPSTREAM');
  check(typeof p.path==='string'&&p.path.startsWith('/')&&!p.path.startsWith('//')&&p.path.length<=16384,'INVALID_PART_PATH');
  check(p.request_method===undefined||['GET','POST'].includes(p.request_method),'INVALID_REQUEST_METHOD');
  check(p.request_encoding===undefined||['identity','gzip','zstd'].includes(p.request_encoding),'INVALID_REQUEST_ENCODING');
  check(Number.isInteger(p.status)&&p.status>=0&&p.status<=599&&typeof p.content_type==='string'&&p.content_type.length<=8192&&typeof p.complete==='boolean','INVALID_PART_RESPONSE');
  check(date(p.started_at)&&date(p.finished_at)&&p.started_at<=p.finished_at,'INVALID_PART_TIME');
  b64(p.request_body_b64);b64(p.response_body_b64);if(!p.complete)interrupted++;
 }
 exact(e,['statement','signature','attestation']);
 const s=e.statement;exact(s,['purpose','capture_id','client','consent_hash','bundle_hash','session_root']);
 check(s.purpose==='thot.tee-capture-seal/1'&&s.capture_id===b.capture_id&&s.client===b.client&&s.session_root===root&&s.bundle_hash===canonicalHash(b)&&hex(s.consent_hash),'SEAL_BINDING_MISMATCH');
 if(Object.hasOwn(value,'consent'))check(canonicalHash(value.consent)===s.consent_hash,'CONSENT_BINDING_MISMATCH');
 exact(e.attestation,['statement'],['quote','event_log']);
 const identity=e.attestation.statement;exact(identity,['purpose','signing_key','channel_key']);check(identity.purpose==='thot.tee-recorder-key/1','INVALID_RECORDER_KEY_STATEMENT');
 const key=createPublicKey({key:b64(identity.signing_key),format:'der',type:'spki'}),channel=createPublicKey({key:b64(identity.channel_key),format:'der',type:'spki'});
 check(key.asymmetricKeyType==='ed25519'&&channel.asymmetricKeyType==='x25519','INVALID_RECORDER_KEY_TYPE');
 const signature=b64(e.signature);check(signature.length===64&&verify(null,Buffer.from(canonicalJson(s)),key,signature),'SEAL_SIGNATURE_INVALID');
 return {format:'thot.capture-verification/1',integrity:'VALID',seal_signature:'VALID_UNDER_SUPPLIED_KEY',capture_id:b.capture_id,client:b.client,session_root:root,verified_parts:b.parts.length,interrupted_parts:interrupted,
  hardware:e.attestation.quote?'PRESENT_UNVERIFIED':'ABSENT_UNVERIFIED',recorder_policy:'NOT_EVALUATED',consent:Object.hasOwn(value,'consent')?'OBJECT_MATCHES_COMMITMENT':'COMMITMENT_ONLY',
  coverage:'SIGNED_PREFIX_ONLY',provider_authorship:'NOT_ESTABLISHED',tool_execution:'NOT_ESTABLISHED',storage_availability:'NOT_ESTABLISHED',trusted_recording_time:'NOT_ESTABLISHED',
  limitations:['A supplied signing key does not authenticate the recorder.','A checkpoint does not prove no later or bypassed exchanges exist.','Model input can contain unverified history and tool claims.']};
}

export async function readCanonicalFile(root,relative,limit){
 const path=await realpath(resolve(root,relative)).catch(e=>{if(e.code==='ENOENT')throw Error('EXPORT_FILE_MISSING');throw e;});
 check(path.startsWith(root+sep),'EXPORT_PATH_ESCAPE');
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();check(s.isFile()&&s.size<=limit,'EXPORT_FILE_LIMIT');const bytes=await f.readFile();check(bytes.length<=limit,'EXPORT_FILE_LIMIT');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const v=JSON.parse(text);check(text===canonicalJson(v)+'\n','NON_CANONICAL_EXPORT_JSON');return {value:v,bytes:bytes.length};}finally{await f.close();}
}
export async function verifyDirectory(directory){
 const root=await realpath(directory);const {value,bytes}=await readCanonicalFile(root,'export.json',limits.metadata);let total=bytes;
 const result=await verifyEvidence(value,async d=>{const part=await readCanonicalFile(root,'parts/'+d.sequence+'.json',limits.part);total+=part.bytes;check(total<=limits.total,'EXPORT_TOTAL_LIMIT');return part.value;});
 return result;
}
// macOS maps /tmp to /private/tmp. Resolve both paths before deciding whether
// this detached copy is being executed directly, rather than imported.
if(process.argv[1]&&await realpath(fileURLToPath(import.meta.url))===await realpath(resolve(process.argv[1]))){
 let result;
 try{
  const args=process.argv.slice(2),directory=args[0]&&!args[0].startsWith('--')?args.shift():dirname(fileURLToPath(import.meta.url)),options={};
  while(args.length){const k=args.shift();check(['--python','--policy','--collateral','--at','--allow-historical'].includes(k)&&!Object.hasOwn(options,k),'INVALID_VERIFIER_ARGUMENT');if(k==='--allow-historical')options[k]=true;else{check(args.length>0,'MISSING_VERIFIER_ARGUMENT');options[k]=args.shift();}}
  result=await verifyDirectory(directory);
  if(Object.keys(options).length){
   check(options['--python']&&options['--policy'],'HARDWARE_REQUIRES_PYTHON_AND_POLICY');
   const root=await realpath(directory),{value}=await readCanonicalFile(root,'export.json',limits.metadata);
   async function external(path,isPolicy=false){const p=await realpath(resolve(path));check(!isPolicy||!p.startsWith(root+sep),'TRUST_POLICY_MUST_BE_OUTSIDE_EXPORT');const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();check(s.isFile()&&s.size<=limits.metadata,'TRUST_INPUT_LIMIT');const b=await f.readFile();check(b.length<=limits.metadata,'TRUST_INPUT_LIMIT');return JSON.parse(b.toString('utf8'));}finally{await f.close();}}
   const verified=await verifyHardware(value.evidence.attestation,await external(options['--policy'],true),await external(options['--collateral']??resolve(root,'collateral.json')),{python:options['--python'],...(options['--at']?{at:Number(options['--at'])}:{}),allowHistorical:options['--allow-historical']===true});Object.assign(result,verified);
  }
  console.log(JSON.stringify(result,null,2));
 }catch(e){console.error(JSON.stringify({...result,integrity:result?.integrity??'FAILED',hardware:result?'FAILED':'UNVERIFIED',error:/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'EXPORT_VERIFICATION_FAILED'}));process.exitCode=result?2:1;}
}
