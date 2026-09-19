import {constants} from 'node:fs';
import {open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DataDirectoryLease,readStorageFormat,STORAGE_FORMAT_FILE,type StorageFormat} from '../../operations/src/lease.ts';
/** Copy/readback must have succeeded under this same exclusive lease. Source is retained. */
export async function commitRemotePlacement(lease:DataDirectoryLease,identity:string){
  if(lease.mode!=='maintenance'||! /^[a-f0-9]{64}$/.test(identity))throw Error('MIGRATION_CUTOVER_INVALID');
  await lease.assertHeld();const prior=await readStorageFormat(lease);
  if(prior.objectStorage||prior.objectKeyCustody)throw Error('LOCAL_SOURCE_OBJECTS_REQUIRED');
  const next:StorageFormat={...prior,objectStorage:'external',objectStorageIdentity:identity};
  const temporary=join(lease.dataDir,'.migration-format-'+randomUUID());let renamed=false;
  try{
    const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await file.writeFile(JSON.stringify(next));await file.sync();}finally{await file.close();}
    await lease.assertHeld();await rename(temporary,join(lease.dataDir,STORAGE_FORMAT_FILE));renamed=true;
    const directory=await open(lease.dataDir,constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}
  }finally{if(!renamed)await unlink(temporary).catch(()=>{});}
}
