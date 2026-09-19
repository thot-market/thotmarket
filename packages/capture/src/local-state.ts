import {constants} from 'node:fs';
import {mkdir,lstat,open,rename} from 'node:fs/promises';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {join} from 'node:path';
import {CAPTURE_PART_JSON_BYTES} from './limits.ts';

export async function privateDirectory(dir:string){
  await mkdir(dir,{recursive:true,mode:0o700});const stat=await lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('CAPTURE_STATE_PERMISSIONS');
}
async function privateFile(path:string){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o077)||stat.size>CAPTURE_PART_JSON_BYTES+4096)throw Error('CAPTURE_STATE_PERMISSIONS');return await file.readFile();}finally{await file.close();}
}
/** Update ciphertext atomically while retaining the existing private key. The
 * previous checkpoint remains recoverable if a process stops during a write. */
export async function storePrivate(dir:string,value:unknown){
  await privateDirectory(dir);let key:Buffer;
  try{key=await privateFile(join(dir,'local.key'));}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    key=randomBytes(32);const file=await open(join(dir,'local.key'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await file.writeFile(key);await file.sync();}finally{await file.close();}
  }
  if(key.length!==32)throw Error('INVALID_CAPTURE_STATE_KEY');
  const clear=Buffer.from(JSON.stringify(value));if(clear.length>CAPTURE_PART_JSON_BYTES)throw Error('CAPTURE_STATE_TOO_LARGE');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(clear),cipher.final()]);
  const temp=join(dir,'.pending-'+randomBytes(12).toString('hex'));
  const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(Buffer.concat([iv,cipher.getAuthTag(),encrypted]));await file.sync();}finally{await file.close();key.fill(0);}
  await rename(temp,join(dir,'pending.enc'));
  const directory=await open(dir,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
}
export async function loadPrivate(dir:string){
  await privateDirectory(dir);const key=await privateFile(join(dir,'local.key')),bytes=await privateFile(join(dir,'pending.enc'));
  try{const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());}finally{key.fill(0);}
}
