import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,lstat,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {selectPrimaryError,readDiagnosticCode,legacyDiagnosticProgram,diagnosticProgram,diagnosticCodes,buildStartupDiagnosticCandidate} from '../scripts/hosted-startup-diagnostic.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const image='example.invalid/app@sha256:'+'a'.repeat(64);
const prefix='stage=prestart; if node scripts/cvm-prestart.ts; then stage=app; node application.mjs; fi; ';
function fixture(){return {services:{'private-anvil-app':{image,environment:{THOT_DATA_DIR:'/data',THOT_CVM_PRE_MIGRATION_SNAPSHOT:'true',SYNTHETIC_CONFIGURATION:'unchanged'},volumes:['data:/data'],command:['flock','--no-fork','--nonblock','/data/.thot-process-lock','sh','-c',prefix+'exec node --input-type=module -e '+quote(legacyDiagnosticProgram)]},other:{image:'example:unchanged',volumes:['chain:/chain']}},volumes:{data:{},chain:{}}};}
const options=value=>({expectedImage:image,expectedCommandSha256:sha(JSON.stringify(value.services['private-anvil-app'].command))});
for(const [name,raw,want] of [
 ['primary before fallback','Error: STORAGE_ENTRY_LIMIT\nError: EMPTY_RECOVERY_SCHEMA_PRESENT','STORAGE_ENTRY_LIMIT'],
 ['chronology before old priority','Error: PRESTART_SOURCE_CHANGED\nError: EACCES: synthetic path','PRESTART_SOURCE_CHANGED'],
 ['native errno','Error: ENOSPC: synthetic private path','FILE_NO_SPACE'],
 ['bracketed errno','Error [EACCES]: synthetic private path','FILE_ACCESS_DENIED'],
 ['unknown first exception','RangeError: synthetic confidential message\nError: STORAGE_TOTAL_LIMIT','UNKNOWN_PRIMARY'],
 ['uncaught non-Error before fallback','node:internal/modules/run_main:123\n triggerUncaughtException(...)\n[Object: null prototype] { synthetic: true }\nNode.js v22.18.0\nError: EACCES: fallback path','UNKNOWN_PRIMARY'],
 ['known exception before process footer','Error: STORAGE_FILE_LIMIT\nNode.js v22.18.0\nError: EACCES','STORAGE_FILE_LIMIT'],
 ...['Killed','Aborted','Terminated','Segmentation fault','Bus error','Illegal instruction','Floating point exception','Aborted (core dumped)'].map(line=>['termination '+line,line+'\nError: EACCES: fallback path','UNKNOWN_PRIMARY']),
 ['lowercase database exception','error: synthetic database contents\nError: EMPTY_RECOVERY_SCHEMA_PRESENT','UNKNOWN_PRIMARY'],
 ['fallback alone','Error: EMPTY_RECOVERY_SCHEMA_PRESENT','UNKNOWN_PRIMARY'],
 ['echoed inline source','file:///app/[eval1]:1\nthrow Error("EMPTY_RECOVERY_SCHEMA_PRESENT");\n      ^\nError: UNSAFE_STORAGE_FILE','UNSAFE_STORAGE_FILE'],
 ['error-shaped echoed source','Error: STORAGE_TOTAL_LIMIT\n       ^\nError: PRESTART_SNAPSHOT_MANIFEST_INVALID','PRESTART_SNAPSHOT_MANIFEST_INVALID'],
 ['stack context','    at Error: DATA_DIRECTORY_LEASE_HELD\nError: STORAGE_FILE_LIMIT','STORAGE_FILE_LIMIT'],
 ['secret-bearing message','Error: synthetic-token=confidential\nError: STORAGE_TOTAL_LIMIT','UNKNOWN_PRIMARY'],
 ['malformed input',null,'UNKNOWN_PRIMARY'],
 ['oversized input','x'.repeat(65537)+'\nError: EACCES','UNKNOWN_PRIMARY'],
 ['terminal controls','\u001b[31mError: STORAGE_FILE_LIMIT\nError: EACCES','UNKNOWN_PRIMARY'],
 ['no exception','source mentions EACCES and UNSAFE_STORAGE_FILE','UNKNOWN_PRIMARY'],
])test(name,()=>{const code=selectPrimaryError(raw);assert.equal(code,want);assert(diagnosticCodes.includes(code));});

test('candidate preserves every field and exact script prefix; input and replay are protected',()=>{
 const before=fixture(),snapshot=structuredClone(before),out=buildStartupDiagnosticCandidate(before,options(before));
 assert.deepEqual(before,snapshot);
 assert(out.compose.services['private-anvil-app'].command[6].startsWith(prefix));
 assert.equal(out.change.previous_command_sha256,options(before).expectedCommandSha256);
 const reversed=structuredClone(out.compose);reversed.services['private-anvil-app'].command=before.services['private-anvil-app'].command;
 assert.deepEqual(reversed,before);
 assert.throws(()=>buildStartupDiagnosticCandidate(out.compose,options(out.compose)),/UNRECOGNIZED_DIAGNOSTIC_SUFFIX/);
});
for(const [name,mutate] of [
 ['wrong predecessor pin',(v,p)=>p.expectedCommandSha256='0'.repeat(64)],
 ['wrong image',(v,p)=>p.expectedImage='example.invalid/app@sha256:'+'b'.repeat(64)],
 ['missing dev service',v=>delete v.services['private-anvil-app']],
 ['snapshot disabled',v=>v.services['private-anvil-app'].environment.THOT_CVM_PRE_MIGRATION_SNAPSHOT='false'],
 ['data root changed',v=>v.services['private-anvil-app'].environment.THOT_DATA_DIR='/other'],
 ['entrypoint override',v=>v.services['private-anvil-app'].entrypoint=['sh']],
 ['working directory override',v=>v.services['private-anvil-app'].working_dir='/other'],
 ['lock removed',v=>v.services['private-anvil-app'].command[2]='--wait'],
 ['unknown final diagnostic',v=>v.services['private-anvil-app'].command[6]+='; echo extra'],
])test('refuses '+name,()=>{const value=fixture(),pins=options(value);mutate(value,pins);assert.throws(()=>buildStartupDiagnosticCandidate(value,pins));});

test('metadata reader is bounded and refuses symlinks, hardlinks and directories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'startup-diagnostic-'));
 try{
  const file=join(root,'error');await writeFile(file,'Error: STORAGE_TOTAL_LIMIT',{mode:0o600});assert.equal(readDiagnosticCode(file),'STORAGE_TOTAL_LIMIT');
  const alias=join(root,'alias');await symlink(file,alias);assert.equal(readDiagnosticCode(alias),'UNKNOWN_PRIMARY');await rm(alias);
  await link(file,alias);assert.equal(readDiagnosticCode(file),'UNKNOWN_PRIMARY');await rm(alias);
  await writeFile(file,'x'.repeat(65537));assert.equal(readDiagnosticCode(file),'UNKNOWN_PRIMARY');
  assert.equal(readDiagnosticCode(root),'UNKNOWN_PRIMARY');assert.equal(readDiagnosticCode(join(root,'missing')),'UNKNOWN_PRIMARY');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('actual Compose-decoded shell argument runs the bounded selector and preserves 503 privacy',async()=>{
 const value=fixture(),candidate=buildStartupDiagnosticCandidate(value,options(value)),script=candidate.compose.services['private-anvil-app'].command[6];
 const encoded=script.slice(prefix.length+'exec node --input-type=module -e '.length);
 // Docker Compose resolves $$ before sh parses its single-quoted argument.
 const shellWord=encoded.replaceAll('$$',()=> '$');
 const extracted=spawnSync('sh',['-c','set -- '+shellWord+'; test "$#" = 1 && printf "%s" "$1"'],{encoding:'utf8'});
 assert.equal(extracted.status,0);assert.equal(extracted.stdout,diagnosticProgram);
 assert(script.includes('$$'),'Regex anchors and dollar-containing character classes must be Compose-escaped');
 const root=await mkdtemp(join(tmpdir(),'startup-diagnostic-runtime-'));
 try{
  const preload=join(root,'http-probe.mjs');
  await writeFile(preload,'import http from "node:http";import{syncBuiltinESMExports}from"node:module";http.createServer=handler=>({listen(port,host){let status,headers;handler({}, {writeHead(s,h){status=s;headers=h;},end(body){process.stdout.write(JSON.stringify({probe:true,status,headers,body:JSON.parse(body),port,host})+"\\n");}});}});syncBuiltinESMExports();');
  for(const [raw,expected] of [
   ['throw Error("EMPTY_RECOVERY_SCHEMA_PRESENT");\n^\nError: UNSAFE_STORAGE_FILE\nError: EMPTY_RECOVERY_SCHEMA_PRESENT','UNSAFE_STORAGE_FILE'],
   ['Error: ENOSPC: /synthetic/private/credential-file\nError: EMPTY_RECOVERY_SCHEMA_PRESENT','FILE_NO_SPACE'],
   ['SyntaxError: synthetic-secret-value\nError: STORAGE_TOTAL_LIMIT','UNKNOWN_PRIMARY'],
   ['[Object: null prototype] { synthetic: true }\nNode.js v22.18.0\nError: EACCES: fallback path','UNKNOWN_PRIMARY'],
   ['Killed\nError: ENOSPC: fallback path','UNKNOWN_PRIMARY'],
   ['x'.repeat(65537)+'\nError: EACCES','UNKNOWN_PRIMARY'],
  ]){
   const log=join(root,'error.txt');await writeFile(log,raw,{mode:0o600});
   const run=spawnSync(process.execPath,['--import',preload,'--input-type=module','-e',extracted.stdout],{encoding:'utf8',env:{...process.env,THOT_STARTUP_ERROR_FILE:log,THOT_STARTUP_STAGE:'prestart'}});
   assert.equal(run.status,0,run.stderr);assert.equal(run.stderr,'');
   const [line,response]=run.stdout.trim().split('\n').map(JSON.parse);
   assert.deepEqual(line,{stage:'prestart',code:expected});
   assert.deepEqual(response,{probe:true,status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:{status:'unavailable',stage:'prestart',code:expected},port:4318,host:'127.0.0.1'});
   assert(!run.stdout.includes('synthetic-secret')&&!run.stdout.includes('/synthetic/private'));
   await assert.rejects(lstat(log),{code:'ENOENT'});
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
