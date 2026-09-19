import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,cp,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createExample} from '../packages/provenance/examples/generate-receipt-format.ts';
import {canonicalJson,canonicalHash} from '../packages/protocol/src/canonical.ts';
import {exportCapture,exportLocalCapture} from '../packages/capture/src/export.ts';
import {captureSync} from '../packages/capture/src/sync.ts';
import {storePrivate,loadPrivate} from '../packages/capture/src/local-state.ts';
// @ts-expect-error Standalone JavaScript verifier, intentionally no repo dependencies.
import {verifyDirectory,verifyEvidence} from '../packages/provenance/portable/verify.mjs';
// @ts-expect-error Standalone JavaScript policy verifier.
import {checkRecorderBindings} from '../packages/provenance/portable/hardware.mjs';
const fixture=()=>{const f=createExample();return {...f,value:{format:'thot.capture-export/1',bundle:f.example.bundle,evidence:f.example.evidence}};};
async function temp(t:any){const p=await mkdtemp(join(tmpdir(),'thot-portable-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
async function exported(t:any){const root=await temp(t),f=fixture(),destination=join(root,'export');await exportCapture({destination,pending:{...f.value,upload_token:'MUST_NOT_EXPORT',origin:'https://private.invalid'},readPart:async n=>f.parts[n-1]});return {root,destination,f};}

test('owner export moves to a detached directory and verifies with no package or service access',async t=>{
 const {root,destination,f}=await exported(t),moved=join(root,'moved');await cp(destination,moved,{recursive:true});await rm(destination,{recursive:true});
 const run=spawnSync(process.execPath,[join(moved,'verify.mjs')],{cwd:tmpdir(),encoding:'utf8',env:{PATH:'',HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'}});
 assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.integrity,'VALID');assert.equal(result.hardware,'ABSENT_UNVERIFIED');assert.equal(result.session_root,f.value.bundle.root);assert.equal(result.coverage,'SIGNED_PREFIX_ONLY');
 assert.equal((await lstat(moved)).mode&0o077,0);const metadata=await readFile(join(moved,'export.json'),'utf8');assert.doesNotMatch(metadata,/MUST_NOT_EXPORT|upload_token|private.invalid/);
 await assert.rejects(exportCapture({destination:moved,pending:f.value,readPart:async n=>f.parts[n-1]}),{code:'EEXIST'});
});
test('missing, altered, reordered, unknown-version and duplicate-key archives fail',async t=>{
 for(const change of ['missing','bytes','version','duplicate','order']){
  const {destination,f}=await exported(t);
  if(change==='missing')await rm(join(destination,'parts/1.json'));
  if(change==='bytes'){f.parts[0].response_body_b64=Buffer.from('modified').toString('base64');await writeFile(join(destination,'parts/1.json'),canonicalJson(f.parts[0])+'\n');}
  if(change==='version'){f.value.format='thot.capture-export/999';await writeFile(join(destination,'export.json'),canonicalJson(f.value)+'\n');}
  if(change==='duplicate'){const s=await readFile(join(destination,'export.json'),'utf8');await writeFile(join(destination,'export.json'),'{"format":"ignored",'+s.slice(1));}
  if(change==='order'){f.value.bundle.parts.reverse();await writeFile(join(destination,'export.json'),canonicalJson(f.value)+'\n');}
  await assert.rejects(verifyDirectory(destination));
 }
});
test('recomputed hashes cannot repair a forged seal, and a fake quote cannot upgrade assurance',async()=>{
 const f=fixture();f.parts[0].response_body_b64=Buffer.from('modified').toString('base64');const {commitment,...record}=f.parts[0];f.parts[0].commitment=canonicalHash(record);f.value.bundle.parts[0].commitment=f.parts[0].commitment;const {root,...manifest}=f.value.bundle;f.value.bundle.root=canonicalHash(manifest);f.value.evidence.statement.session_root=f.value.bundle.root;f.value.evidence.statement.bundle_hash=canonicalHash(f.value.bundle);
 await assert.rejects(verifyEvidence(f.value,async(d:any)=>f.parts[d.sequence-1]),/SEAL_SIGNATURE_INVALID/);
 const fake=fixture();(fake.value.evidence.attestation as any).quote='00';assert.equal((await verifyEvidence(fake.value,async(d:any)=>fake.parts[d.sequence-1])).hardware,'PRESENT_UNVERIFIED');
});
test('export rejects escaping part symlinks and removes incomplete output after source loss',async t=>{
 const {destination,root,f}=await exported(t);await rm(join(destination,'parts/1.json'));await writeFile(join(root,'outside.json'),canonicalJson(f.parts[0])+'\n');await symlink(join(root,'outside.json'),join(destination,'parts/1.json'));await assert.rejects(verifyDirectory(destination),/EXPORT_PATH_ESCAPE/);
 const incomplete=join(root,'incomplete');await assert.rejects(exportCapture({destination:incomplete,pending:f.value,readPart:async()=>{throw Error('SOURCE_LOST');}}),/SOURCE_LOST/);await assert.rejects(lstat(incomplete),{code:'ENOENT'});
});
test('saved local evidence stays exportable; explicit until-saved policy reclaims only after successful acknowledgment',async t=>{
 const root=await temp(t),f=fixture(),connection={origin:'https://vault.invalid',capture_id:f.value.bundle.capture_id,upload_token:'LOCAL_ONLY'};
 const transport:typeof fetch=async(url,init)=>{const b=JSON.parse(String(init?.body));return Response.json(String(url).endsWith('/parts')?{sequence:b.part.sequence,commitment:b.part.commitment,stored:true}:{capture_id:connection.capture_id,status:'SAVED',trace_id:'trace',capture_receipt:{confidence_tier:'P2_TEE',commitments:{session_root:b.bundle.root}}});};
 for(const retention of ['keep','until-saved'] as const){const dir=join(root,retention);await storePrivate(dir,{...connection,...f.value});await storePrivate(join(dir,'client-verification'),{hardware:'unavailable',references:'missing',policy_source:'explicit-recorder-url'});const sync=await captureSync({...connection,local_retention:retention},dir,()=>{},transport);for(const p of f.parts)await sync.part(p);await sync.finish(f.value);sync.close();if(retention==='keep'){const result=await exportLocalCapture(dir,join(root,'kept-export'));assert.equal(result.verification.verified_parts,2);assert.deepEqual(JSON.parse(await readFile(join(result.directory,'client-verification.json'),'utf8')),{hardware:'unavailable',references:'missing',policy_source:'explicit-recorder-url'});}else await assert.rejects(exportLocalCapture(dir,join(root,'deleted-export')),/LOCAL_PARTS_UNAVAILABLE/);}
});
test('interrupted helper checkpoint exports without finalization, login, vault or inference',async t=>{
 const root=await temp(t),dir=join(root,'state'),f=fixture();await storePrivate(join(dir,'checkpoint'),{...f.value,upload_token:'DO_NOT_EXPORT'});for(const p of f.parts)await storePrivate(join(dir,'parts',String(p.sequence)),{part:p});const result=await exportLocalCapture(dir,join(root,'checkpoint-export'));assert.equal(result.verification.coverage,'SIGNED_PREFIX_ONLY');assert.equal(result.verification.verified_parts,2);
});
test('hardware checking requires explicit external trust inputs; integrity result survives a hardware failure',async t=>{
 const {destination,root}=await exported(t);await writeFile(join(root,'policy.json'),'{}');await writeFile(join(root,'collateral.json'),'{}');
 const run=spawnSync(process.execPath,[join(destination,'verify.mjs'),destination,'--python','/usr/bin/python3','--policy',join(root,'policy.json'),'--collateral',join(root,'collateral.json')],{encoding:'utf8'});assert.equal(run.status,2);const result=JSON.parse(run.stderr);assert.equal(result.integrity,'VALID');assert.equal(result.hardware,'FAILED');assert.equal(result.error,'HARDWARE_EVIDENCE_MISSING');
});
test('measurement replay binds independently authenticated hardware claims to key and external policy',()=>{
 const statement=fixture().value.evidence.attestation.statement,ids={'app-id':'ab','compose-hash':'cd','os-image-hash':'ef'},log=Object.entries(ids).map(([event,event_payload])=>({imr:3,event_type:0x08000001,event,event_payload}));
 let r=Buffer.alloc(48);for(const e of log){const type=Buffer.alloc(4);type.writeUInt32LE(e.event_type);const d=createHash('sha384').update(Buffer.concat([type,Buffer.from(':'+e.event+':'),Buffer.from(e.event_payload,'hex')])).digest();r=createHash('sha384').update(Buffer.concat([r,d])).digest();}
 const measurements={mrtd:'a'.repeat(96),rtmr0:'0'.repeat(96),rtmr1:'0'.repeat(96),rtmr2:'0'.repeat(96),rtmr3:r.toString('hex')};
 const attestation={statement,quote:'00',event_log:log},claims={verified:true,status:'UpToDate',debug:false,quote_hash:createHash('sha256').update(Buffer.from('00','hex')).digest('hex'),report_data:canonicalHash(statement)+'0'.repeat(64),measurements,verification_time_seconds:1,earliest_expiration_seconds:2};
 const policy={instances:{ab:{role:'model-recorder',compose_hash:'cd',os_image_hash:'ef',mrtd:measurements.mrtd,rtmr0:measurements.rtmr0,rtmr1:measurements.rtmr1,rtmr2:measurements.rtmr2}}};
 assert.equal(checkRecorderBindings(attestation,claims,policy).recorder_policy,'APPROVED');
 assert.throws(()=>checkRecorderBindings(attestation,claims,{instances:{}}),/POLICY_REJECTED/);assert.throws(()=>checkRecorderBindings(attestation,{...claims,report_data:'0'.repeat(128)},policy),/KEY_BINDING/);assert.throws(()=>checkRecorderBindings(attestation,{...claims,debug:true},policy),/PLATFORM_REJECTED/);assert.throws(()=>checkRecorderBindings({...attestation,event_log:[]},claims,policy),/EVENT_LOG_INVALID/);
});
