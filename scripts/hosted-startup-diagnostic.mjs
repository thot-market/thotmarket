#!/usr/bin/env node
// Offline preparation only. Deployment and live predecessor verification are separate.
import assert from 'node:assert/strict';
import {constants,openSync,fstatSync,readSync,closeSync,unlinkSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const sha=value=>createHash('sha256').update(value).digest('hex');
export const legacyDiagnosticProgram="import{createServer}from\"node:http\";import{readFileSync,statSync,unlinkSync}from\"node:fs\";const path=process.env.THOT_STARTUP_ERROR_FILE,stage=[\"lease\",\"prestart\",\"app\"].includes(process.env.THOT_STARTUP_STAGE)?process.env.THOT_STARTUP_STAGE:\"unknown\",allowed=[\"REMOTE_QUOTA_NAMESPACE_MISSING\",\"REMOTE_QUOTA_POLICY_MISMATCH\",\"INVALID_REMOTE_NAMESPACE\",\"REMOTE_STORAGE_CONFIGURATION_REQUIRED\",\"UNSAFE_RECOVERY_LEASE\",\"MAINTENANCE_REVIEW_REQUIRED\",\"CVM_PRESTART_SNAPSHOT_NOT_ENABLED\",\"DSTACK_GET_KEY_FAILED\",\"DATA_DIRECTORY_LEASE_HELD\",\"INSECURE_DATA_DIRECTORY\",\"STORAGE_FORMAT_CHANGED\",\"EMPTY_RECOVERY_SCHEMA_PRESENT\",\"EMPTY_RECOVERY_TABLES_PRESENT\",\"EMPTY_RECOVERY_SNAPSHOT_INVALID\",\"UNSUPPORTED_PRESTART_SCHEMA\",\"PRIVATE_ANVIL_HOST_CONFIGURATION_REQUIRED\",\"INVALID_AUTH_CONFIGURATION\",\"HOSTED_THOT_AUTH_REQUIRED\",\"HOSTED_THOT_DSTACK_REQUIRED\",\"HOSTED_THOT_HTTPS_ORIGIN_REQUIRED\",\"THOT_LOCAL_RPC_REQUIRED\",\"THOT_PRODUCTION_ACTIVATION_PENDING\",\"THOT_DEPLOYMENT_ANCHOR_MISMATCH\",\"THOT_CODE_PIN_MISMATCH\"];let code=\"STARTUP_FAILED\";try{const st=statSync(path);if(st.isFile()&&st.size<=65536){const raw=readFileSync(path,\"utf8\");if(/\\bEACCES\\b/.test(raw))code=\"FILE_ACCESS_DENIED\";else if(/\\bENOENT\\b/.test(raw))code=\"FILE_NOT_FOUND\";else if(/\\bECONNREFUSED\\b/.test(raw))code=\"DEPENDENCY_REFUSED\";else if(/\\bEEXIST\\b/.test(raw))code=\"FILE_ALREADY_EXISTS\";else for(const candidate of allowed)if(raw.includes(candidate)){code=candidate;break}}}catch{}try{unlinkSync(path)}catch{}const body=JSON.stringify({status:\"unavailable\",stage,code});createServer((_request,response)=>{response.writeHead(503,{\"Content-Type\":\"application/json\",\"Cache-Control\":\"no-store\",\"X-Content-Type-Options\":\"nosniff\"});response.end(body)}).listen(4318,\"127.0.0.1\")";
export const legacyDiagnosticSha256='58239073665a98611aed18b795d117dbcc147f6e7f5fe982974c8dab682b7b03';
assert.equal(sha(legacyDiagnosticProgram),legacyDiagnosticSha256);
export function selectPrimaryError(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>65536||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw))return 'UNKNOWN_PRIMARY';
 const native={EACCES:'FILE_ACCESS_DENIED',EPERM:'FILE_ACCESS_DENIED',ENOENT:'FILE_NOT_FOUND',ECONNREFUSED:'DEPENDENCY_REFUSED',EEXIST:'FILE_ALREADY_EXISTS',ENOSPC:'FILE_NO_SPACE',EDQUOT:'FILE_QUOTA_EXCEEDED',EROFS:'FILESYSTEM_READ_ONLY',EIO:'FILESYSTEM_IO_ERROR',EMFILE:'FILE_DESCRIPTOR_LIMIT',ENFILE:'FILE_DESCRIPTOR_LIMIT',ELOOP:'SYMLINK_OR_PATH_LOOP'};
 const codes=new Set(["REMOTE_QUOTA_NAMESPACE_MISSING","REMOTE_QUOTA_POLICY_MISMATCH","INVALID_REMOTE_NAMESPACE","REMOTE_STORAGE_CONFIGURATION_REQUIRED","UNSAFE_RECOVERY_LEASE","MAINTENANCE_REVIEW_REQUIRED","CVM_PRESTART_SNAPSHOT_NOT_ENABLED","DSTACK_GET_KEY_FAILED","DATA_DIRECTORY_LEASE_HELD","INSECURE_DATA_DIRECTORY","STORAGE_FORMAT_CHANGED","EMPTY_RECOVERY_SCHEMA_PRESENT","EMPTY_RECOVERY_TABLES_PRESENT","EMPTY_RECOVERY_SNAPSHOT_INVALID","UNSUPPORTED_PRESTART_SCHEMA","PRIVATE_ANVIL_HOST_CONFIGURATION_REQUIRED","INVALID_AUTH_CONFIGURATION","HOSTED_THOT_AUTH_REQUIRED","HOSTED_THOT_DSTACK_REQUIRED","HOSTED_THOT_HTTPS_ORIGIN_REQUIRED","THOT_LOCAL_RPC_REQUIRED","THOT_PRODUCTION_ACTIVATION_PENDING","THOT_DEPLOYMENT_ANCHOR_MISMATCH","THOT_CODE_PIN_MISMATCH",'INVALID_STORAGE_PATH','BROAD_STORAGE_PATH_FORBIDDEN','STORAGE_SYMLINK_OR_NON_DIRECTORY','INVALID_MANIFEST_PATH','MANIFEST_PATH_ESCAPE','UNSAFE_STORAGE_FILE','STORAGE_FILE_LIMIT','STORAGE_CHANGED_DURING_READ','STORAGE_SYMLINK_FORBIDDEN','STORAGE_ENTRY_LIMIT','STORAGE_TOTAL_LIMIT','INVALID_DIRECTORY_LEASE_MODE','INCOMPATIBLE_STORAGE_NAMESPACE','UNMARKED_STORAGE_REQUIRES_REVIEW','DATA_DIRECTORY_LEASE_RELEASED','DATA_DIRECTORY_LEASE_CHANGED','UNSUPPORTED_STORAGE_FORMAT','CVM_EXTERNAL_PGLITE_REQUIRED','PRESTART_SNAPSHOT_MANIFEST_INVALID','PRESTART_SOURCE_CHANGED','PGLITE_DATABASE_REQUIRED']);
 const lines=raw.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  // An echoed source line followed by a caret is not the exception header.
  if(/^[ \t]*\^[~^ \t]*$/.test(lines[i+1]??''))continue;
  // A finished process without a recognized exception is an unknown primary.
  if(/^Node\.js v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(lines[i])||/^(?:Killed|Aborted|Terminated|Segmentation fault|Bus error|Illegal instruction|Floating point exception)(?: \(core dumped\))?$/.test(lines[i]))return 'UNKNOWN_PRIMARY';
  const match=/^(?:[A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception)|Error|error|Exception|DOMException|UnhandledPromiseRejection)(?: \[([A-Z][A-Z0-9_]{0,63})\])?: (.*)$/.exec(lines[i]);
  if(!match)continue;
  const code=match[1]??/^([A-Z][A-Z0-9_]{0,63})(?=$|:)/.exec(match[2])?.[1];
  // A fallback-only exception cannot identify a silent/truncated primary failure.
  if(!code||code.startsWith('EMPTY_RECOVERY_'))return 'UNKNOWN_PRIMARY';
  if(Object.hasOwn(native,code))return native[code];
  return codes.has(code)?code:'UNKNOWN_PRIMARY';
 }
 return 'UNKNOWN_PRIMARY';
}
export function readDiagnosticCode(path){
 let fd;
 try{
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.size>65536)return 'UNKNOWN_PRIMARY';
  const buffer=Buffer.alloc(65537);let size=0;
  while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
  const after=fstatSync(fd);
  if(size>65536||size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1)return 'UNKNOWN_PRIMARY';
  return selectPrimaryError(buffer.subarray(0,size).toString('utf8'));
 }catch{return 'UNKNOWN_PRIMARY';}
 finally{if(fd!==undefined)closeSync(fd);}
}
const stageDeclaration='const path=process.env.THOT_STARTUP_ERROR_FILE,stage=["lease","prestart","app"].includes(process.env.THOT_STARTUP_STAGE)?process.env.THOT_STARTUP_STAGE:"unknown";';
const healthTail=legacyDiagnosticProgram.slice(legacyDiagnosticProgram.indexOf('try{unlinkSync(path)}catch{}'));
export const diagnosticProgram='import{createServer}from"node:http";import{constants,openSync,fstatSync,readSync,closeSync,unlinkSync}from"node:fs";'+stageDeclaration+selectPrimaryError.toString()+'\n'+readDiagnosticCode.toString()+'\nconst code=readDiagnosticCode(path);process.stdout.write(JSON.stringify({stage,code})+"\\n");'+healthTail;
export const diagnosticSha256=sha(diagnosticProgram);
export const diagnosticCodes=Object.freeze([...new Set([
 'UNKNOWN_PRIMARY','FILE_ACCESS_DENIED','FILE_NOT_FOUND','DEPENDENCY_REFUSED','FILE_ALREADY_EXISTS','FILE_NO_SPACE','FILE_QUOTA_EXCEEDED','FILESYSTEM_READ_ONLY','FILESYSTEM_IO_ERROR','FILE_DESCRIPTOR_LIMIT','SYMLINK_OR_PATH_LOOP',
 ...[...selectPrimaryError.toString().matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)].map(m=>m[1]).filter(v=>!v.startsWith('EMPTY_RECOVERY_'))
])].sort());
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const composeQuote=value=>shellQuote(value.replaceAll('$',()=> '$$'));
export function buildStartupDiagnosticCandidate(input,{expectedCommandSha256,expectedImage}={}){
 assert.match(expectedCommandSha256??'',/^[a-f0-9]{64}$/,'REVIEWED_COMMAND_HASH_REQUIRED');
 assert.match(expectedImage??'',/^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/,'PINNED_IMAGE_REQUIRED');
 const result=structuredClone(input),service=result.services?.['private-anvil-app'];
 assert(service,'PRIVATE_DEV_APP_REQUIRED');assert.equal(service.image,expectedImage,'IMAGE_CHANGED');
 assert(!Object.hasOwn(service,'entrypoint')&&!Object.hasOwn(service,'working_dir'),'STARTUP_OVERRIDE');
 assert.equal(service.environment?.THOT_CVM_PRE_MIGRATION_SNAPSHOT,'true','SNAPSHOT_OPT_IN_REQUIRED');
 assert.equal(service.environment?.THOT_DATA_DIR,'/data','DATA_ROOT_CHANGED');
 const command=service.command;
 assert(Array.isArray(command)&&command.length===7&&command.every(v=>typeof v==='string'),'UNRECOGNIZED_COMMAND');
 assert.deepEqual(command.slice(0,6),['flock','--no-fork','--nonblock','/data/.thot-process-lock','sh','-c'],'UNRECOGNIZED_COMMAND');
 assert.equal(sha(JSON.stringify(command)),expectedCommandSha256,'COMMAND_CHANGED');
 const marker='exec node --input-type=module -e ',oldSuffix=marker+composeQuote(legacyDiagnosticProgram),newSuffix=marker+composeQuote(diagnosticProgram);
 assert(command[6].endsWith(oldSuffix),'UNRECOGNIZED_DIAGNOSTIC_SUFFIX');
 assert.equal(command[6].split(oldSuffix).length,2,'DUPLICATE_DIAGNOSTIC_SUFFIX');
 const prefix=command[6].slice(0,-oldSuffix.length),candidateScript=prefix+newSuffix;
 service.command=[...command.slice(0,6),candidateScript];
 const reversed=structuredClone(result);reversed.services['private-anvil-app'].command[6]=candidateScript.slice(0,-newSuffix.length)+oldSuffix;
 assert.deepEqual(reversed,input,'NON_DIAGNOSTIC_COMPOSE_CHANGE');
 return {compose:result,change:{service:'private-anvil-app',command_index:6,previous_command_sha256:expectedCommandSha256,candidate_command_sha256:sha(JSON.stringify(service.command)),previous_diagnostic_sha256:legacyDiagnosticSha256,candidate_diagnostic_sha256:diagnosticSha256}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [input,output,expectedCommandSha256,expectedImage,...extra]=process.argv.slice(2);
  assert(input&&output&&!extra.length,'USAGE_INPUT_OUTPUT_COMMAND_SHA256_IMAGE');
  const candidate=buildStartupDiagnosticCandidate(JSON.parse(readFileSync(input,'utf8')),{expectedCommandSha256,expectedImage});
  writeFileSync(output,JSON.stringify(candidate.compose,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'PREPARED_NOT_DEPLOYED',...candidate.change}));
 }catch{console.error('DIAGNOSTIC_CANDIDATE_PREPARATION_FAILED');process.exitCode=1;}
}
