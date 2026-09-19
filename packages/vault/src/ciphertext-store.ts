import {constants} from 'node:fs';
import {mkdir,lstat,open,realpath,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';

/** Placement only: adapters receive encrypted envelopes, never plaintext or keys.
 * put must reject an existing key and acknowledge only after durable acceptance.
 * get must enforce maxBytes while reading, not after an unbounded download.
 * get must report absent objects with code ENOENT (CiphertextNotFoundError is
 * provided). Remote adapters must translate their provider's missing-object
 * response, preserving other failures. delete may succeed for absent objects
 * or use the same error contract, so cleanup retries remain idempotent.
 * Authentication, decryption and provenance verification belong to callers.
 */
export interface CiphertextStore {
  put(objectId:string,bytes:Buffer):Promise<void>;
  get(objectId:string,maxBytes:number):Promise<Buffer>;
  delete(objectId:string):Promise<void>;
}

/** ENOENT-compatible absence, distinct from provider outages or access denial. */
export class CiphertextNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(){super('OBJECT_MISSING');this.name='CiphertextNotFoundError';}
}

export class FileCiphertextStore implements CiphertextStore {
  private readonly root:string;
  constructor(root:string){this.root=resolve(root);}
  /** Trusted local placement root used by VaultStore's quota accounting. */
  accountingRoot(){return this.root;}
  private async path(objectId:string){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(objectId))throw Error('INVALID_VAULT_REFERENCE');
    await mkdir(this.root,{recursive:true,mode:0o700});
    if((await lstat(this.root)).isSymbolicLink())throw Error('VAULT_SYMLINK_FORBIDDEN');
    const root=await realpath(this.root);
    return {root,file:join(root,objectId+'.sealed')};
  }
  async put(objectId:string,bytes:Buffer){
    const {root,file}=await this.path(objectId);
    const handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
  }
  async get(objectId:string,maxBytes:number){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('INVALID_VAULT_LIMIT');
    const {file}=await this.path(objectId),handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await handle.stat();if(!stat.isFile()||stat.size>maxBytes)throw Error('INVALID_VAULT_OBJECT');
      // Bound the actual read too, including a file that grows after stat().
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:64*1024})){
        bytes+=chunk.length;if(bytes>maxBytes)throw Error('INVALID_VAULT_OBJECT');chunks.push(chunk);
      }
      return Buffer.concat(chunks,bytes);
    }finally{await handle.close();}
  }
  async delete(objectId:string){
    const {root,file}=await this.path(objectId);await unlink(file);
    const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
  }
}
