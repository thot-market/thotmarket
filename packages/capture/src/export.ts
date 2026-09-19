import {mkdir,open,rm,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson} from '../../protocol/src/canonical.ts';
import {loadPrivate} from './local-state.ts';
// @ts-expect-error The verifier deliberately runs outside the TypeScript repository.
import {verifyEvidence,verifyDirectory,limits} from '../../provenance/portable/verify.mjs';

/** Explicit plaintext export into a new private directory. Never copy connection
 * state, upload credentials, helper keys or executable material from a capture. */
export async function exportCapture(options:{destination:string;pending:any;collateral?:unknown;clientVerification?:unknown;readPart:(sequence:number)=>Promise<any>}){
 const {bundle,evidence}=options.pending;
 if(!evidence?.attestation)throw Error('SIGNED_CAPTURE_REQUIRED');
 const a=evidence.attestation;
 const value={format:'thot.capture-export/1',bundle,evidence:{statement:evidence.statement,signature:evidence.signature,attestation:{statement:a.statement,...(a.quote!==undefined?{quote:a.quote}:{}),...(a.event_log!==undefined?{event_log:a.event_log}:{})}}};
 const root=resolve(options.destination);
 await mkdir(root,{mode:0o700}); // exclusive: never replace an existing owner export
 let total=0;
 async function write(path:string,v:unknown,limit:number){const bytes=Buffer.from(canonicalJson(v)+'\n');total+=bytes.length;if(bytes.length>limit||total>limits.total)throw Error('EXPORT_SIZE_LIMIT');const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
 try{
  await mkdir(join(root,'parts'),{mode:0o700});
  await verifyEvidence(value,async(d:{sequence:number})=>{const p=await options.readPart(d.sequence);await write(join(root,'parts',d.sequence+'.json'),p,limits.part);return p;});
  await write(join(root,'export.json'),value,limits.metadata);
  if(options.clientVerification!==undefined)await write(join(root,'client-verification.json'),options.clientVerification,limits.metadata);
  if(options.collateral!==undefined)await write(join(root,'collateral.json'),options.collateral,limits.metadata);
  for(const name of ['verify.mjs','canonical.mjs','hardware.mjs','verify_dcap.py','requirements.txt','README.txt'])await copyFile(fileURLToPath(new URL('../../provenance/portable/'+name,import.meta.url)),join(root,name),constants.COPYFILE_EXCL);
  for(const path of [join(root,'parts'),root]){const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
  return {directory:root,verification:await verifyDirectory(root)};
 }catch(e){await rm(root,{recursive:true,force:true});throw e;}
}
export async function exportLocalCapture(stateDirectory:string,destination:string,collateral?:unknown){
 let pending:any;
 try{pending=await loadPrivate(stateDirectory);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;pending=await loadPrivate(join(stateDirectory,'checkpoint'));}
 let clientVerification:unknown;
 try{clientVerification=await loadPrivate(join(stateDirectory,'client-verification'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 try{return await exportCapture({destination,pending,collateral,clientVerification,readPart:async sequence=>(await loadPrivate(join(stateDirectory,'parts',String(sequence)))).part});}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Error('LOCAL_PARTS_UNAVAILABLE_USE_VAULT_EXPORT');throw e;}
}
