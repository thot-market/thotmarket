#!/usr/bin/env node
/** Standalone conversion; key bytes stay in an explicit file outside the archive. */
import {constants} from 'node:fs';
import {mkdir,open,unlink,realpath,rename,copyFile,link} from 'node:fs/promises';
import {resolve,join,sep,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHmac} from 'node:crypto';
import {packChunks,unpackChunks,chunkLimits} from './chunked.mjs';
import {canonicalHash,canonicalJson} from './canonical.mjs';
import {check,readCanonicalFile,limits} from './verify.mjs';
async function read(path,max){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();check(s.isFile()&&s.size<=max,'FILE_SIZE_LIMIT');const b=await f.readFile();check(b.length<=max,'FILE_SIZE_LIMIT');return b;}finally{await f.close();}}
async function write(path,bytes){const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
async function sync(path){const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
const disjoint=(a,b)=>check(a!==b&&!a.startsWith(b+sep)&&!b.startsWith(a+sep),'ARCHIVE_PATH_OVERLAP');
// Canonicalize the parent before creating a destination. On macOS /tmp is an
// alias of /private/tmp, while a symlink at the destination itself remains
// forbidden by the realpath equality check below.
const destinationAt=async path=>{const absolute=resolve(path);return join(await realpath(dirname(absolute)),basename(absolute));};
const encoded=v=>Buffer.from(canonicalJson(v)+'\n');
async function keyAt(path,root){const actual=await realpath(path);check(actual!==root&&!actual.startsWith(root+sep),'KEY_MUST_BE_OUTSIDE_ARCHIVE');const key=await read(actual,32);check(key.length===32,'KEY_FILE_MUST_CONTAIN_32_BYTES');return key;}
const idPath=(root,id)=>{check(/^[a-f0-9]{64}$/.test(id),'INVALID_OBJECT_ID');return join(root,'objects',id);};
async function objectStore(root){const dir=await realpath(join(root,'objects'));check(dir===join(root,'objects'),'ARCHIVE_OBJECT_PATH_ESCAPE');return {get:async id=>{try{return await read(idPath(root,id),chunkLimits.object);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}},put:async(id,bytes)=>{const tmp=join(dir,'.pending-'+randomBytes(12).toString('hex'));await write(tmp,bytes);try{await link(tmp,idPath(root,id));await unlink(tmp);await sync(dir);}catch(e){await unlink(tmp).catch(()=>{});throw e;}}};}
export async function packDirectory(source,destination,keyFile){
 const input=await realpath(source),root=await destinationAt(destination);disjoint(input,root);await mkdir(root,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});check(await realpath(root)===root,'ARCHIVE_PATH_ESCAPE');
 const key=await keyAt(keyFile,root),lock=join(root,'.writer-lock');await write(lock,Buffer.from(String(process.pid)));
 try{
  const {value}=await readCanonicalFile(input,'export.json',limits.metadata);let draft;
  const binding=salt=>createHmac('sha256',key).update('thot.chunk-draft/1:'+salt+':'+canonicalHash(value)).digest('hex');
  try{draft=JSON.parse(await read(join(root,'draft.json'),1024));check(Object.keys(draft).sort().join(',')==='binding,format,salt'&&draft.format==='thot.chunk-draft/1'&&draft.binding===binding(draft.salt),'RESUME_SOURCE_MISMATCH');}
  catch(e){if(e.code!=='ENOENT')throw e;const salt=randomBytes(16).toString('hex');draft={format:'thot.chunk-draft/1',binding:binding(salt),salt};await write(join(root,'draft.json'),encoded(draft));}
  await mkdir(join(root,'objects'),{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const store=await objectStore(root);
  const result=await packChunks({value,key,salt:draft.salt,...store,readPart:async d=>(await readCanonicalFile(input,'parts/'+d.sequence+'.json',limits.part)).value});
  // Verify persisted bytes before publishing the completion marker.
  await unpackChunks({envelope:result.envelope,key,get:store.get});
  const tmp=join(root,'.envelope-'+randomBytes(12).toString('hex'));await write(tmp,encoded(result.envelope));await rename(tmp,join(root,'envelope.json'));await sync(root);
  return {directory:root,verification:result.verification,stats:result.stats};
 }finally{await unlink(lock);}
}
export async function unpackDirectory(source,destination,keyFile){
 const root=await realpath(source),key=await keyAt(keyFile,root),envelope=JSON.parse(await read(join(root,'envelope.json'),24*1024*1024));
 const output=await destinationAt(destination);disjoint(root,output);await mkdir(output,{mode:0o700});check(await realpath(output)===output,'EXPORT_PATH_ESCAPE');await mkdir(join(output,'parts'),{mode:0o700});
 // No export.json completion marker is written if verification fails. Partial
 // plaintext is retained for inspection; caller chooses a new destination to retry.
 const result=await unpackChunks({envelope,key,...await objectStore(root),onPart:async(d,raw)=>write(join(output,'parts',d.sequence+'.json'),raw)});
 for(const name of ['verify.mjs','canonical.mjs','hardware.mjs','verify_dcap.py','requirements.txt','README.txt'])await copyFile(fileURLToPath(new URL('./'+name,import.meta.url)),join(output,name),constants.COPYFILE_EXCL);
 for(const name of ['verify.mjs','canonical.mjs','hardware.mjs','verify_dcap.py','requirements.txt','README.txt'])await sync(join(output,name));
 await sync(join(output,'parts'));await write(join(output,'export.json'),encoded(result.value));await sync(output);
 return {directory:output,verification:result.verification,stats:result.stats};
}
if(process.argv[1]&&await realpath(fileURLToPath(import.meta.url))===await realpath(resolve(process.argv[1]))){
 const [action,source,destination,keyFile]=process.argv.slice(2);
 try{check(['pack','unpack'].includes(action)&&source&&destination&&keyFile,'USAGE_PACK_OR_UNPACK_SOURCE_DESTINATION_KEY_FILE');console.log(JSON.stringify(await(action==='pack'?packDirectory:unpackDirectory)(source,destination,keyFile),null,2));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
