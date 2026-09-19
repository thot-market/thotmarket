import {opendir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileCiphertextStore,type CiphertextStore} from './ciphertext-store.ts';
import {VaultStore,type KeyProvider} from './index.ts';
import type {RemoteAccounting} from './remote-accounting.ts';

/** Caller must hold the source's exclusive maintenance lease for the whole copy.
 * Source files are never changed. Metadata/reference cutover is a separate step.
 */
export async function copyCiphertextObjects(source:string,keys:KeyProvider,destination:CiphertextStore,accounting:RemoteAccounting){
  const files=new FileCiphertextStore(source),vault=new VaultStore(files,keys,{maxBytes:64_000_000});
  const entries:Array<{objectId:string;ownerUserId:string;bytes:number;sha256:string}>=[];
  const directory=await opendir(source);
  for await(const entry of directory){
    if(!/^[A-Za-z0-9_-]{1,128}\.sealed$/.test(entry.name)||!(await lstat(join(source,entry.name))).isFile())throw Error('INVALID_MIGRATION_OBJECT');
    if(entries.length>=100_000)throw Error('MIGRATION_OBJECT_LIMIT');
    const objectId=entry.name.slice(0,-7),bytes=await files.get(objectId,90_000_000),envelope=JSON.parse(bytes.toString());
    const ownerUserId=envelope.owner_user_id;
    // Authenticate the source envelope under original custody before accepting it.
    const plaintext=await vault.get({ownerUserId,objectId});plaintext.fill(0);
    try{
      await accounting.reserve(objectId,ownerUserId,bytes.length,envelope.storage_class==='operator-journal');
      await destination.put(objectId,bytes);
    }catch(e){if((e as any).code!=='EEXIST')throw e;}
    const copied=await destination.get(objectId,bytes.length);
    if(!bytes.equals(copied))throw Error('MIGRATION_OBJECT_MISMATCH');
    await accounting.stored(objectId,ownerUserId,bytes.length);
    entries.push({objectId,ownerUserId,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  return {schema_version:'thot.ciphertext-migration/1',entries:entries.sort((a,b)=>a.objectId.localeCompare(b.objectId))};
}
