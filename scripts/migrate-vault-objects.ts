import {open} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {DataDirectoryLease,readStorageFormat} from '../packages/operations/src/lease.ts';
import {openRemoteStorage} from '../packages/vault/src/remote-config.ts';
import {copyCiphertextObjects} from '../packages/vault/src/migrate-ciphertext.ts';
import {LocalMasterKeyProvider} from '../packages/vault/src/index.ts';
import {canonicalJson} from '../packages/protocol/src/index.ts';
import {dstackMasterKey} from '../apps/api/server.ts';
import {commitRemotePlacement} from '../packages/vault/src/migration-cutover.ts';
import {constants} from 'node:fs';
const args=process.argv.slice(2);
const commit=args.at(-1)==='--commit-placement';if(commit)args.pop();
if(args.length!==4||args[0]!=='--source'||args[2]!=='--manifest')throw Error('Usage: node scripts/migrate-vault-objects.ts --source DATA_DIR --manifest PRIVATE_MANIFEST_FILE [--commit-placement]');
const lease=await DataDirectoryLease.acquire(resolve(args[1]!),{mode:'maintenance'});
let remote:Awaited<ReturnType<typeof openRemoteStorage>>,key:Buffer|undefined;
try{
  const format=await readStorageFormat(lease);
  if(format.objectStorage||format.objectKeyCustody)throw Error('LOCAL_SOURCE_OBJECTS_REQUIRED');
  if(format.keyCustody==='external'){
    if(process.env.THOT_MASTER_KEY_SOURCE!=='dstack')throw Error('DSTACK_CUSTODY_REQUIRED');
    key=await dstackMasterKey(process.env.DSTACK_SOCKET??'/var/run/dstack.sock');
  }else{
    const file=await open(join(lease.dataDir,'local-vault.key'),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await file.stat();if(!stat.isFile()||stat.size!==32||(stat.mode&0o077)!==0)throw Error('INSECURE_LOCAL_KEY');key=await file.readFile();}finally{await file.close();}
  }
  remote=await openRemoteStorage(process.env);if(!remote)throw Error('REMOTE_STORAGE_CONFIGURATION_REQUIRED');
  const manifest={...await copyCiphertextObjects(join(lease.dataDir,'objects'),new LocalMasterKeyProvider(key),remote.ciphertext,remote.accounting),destination:remote.identity};
  const text=canonicalJson(manifest);
  const manifestFile=await open(resolve(args[3]!),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await manifestFile.writeFile(text);await manifestFile.sync();}finally{await manifestFile.close();}
  const manifestDirectory=await open(dirname(resolve(args[3]!)),constants.O_RDONLY|constants.O_DIRECTORY);
  try{await manifestDirectory.sync();}finally{await manifestDirectory.close();}
  if(commit)await commitRemotePlacement(lease,remote.identity);
  console.log(JSON.stringify({objects:manifest.entries.length,bytes:manifest.entries.reduce((n,e)=>n+e.bytes,0),manifest_sha256:createHash('sha256').update(text).digest('hex'),source_preserved:true,placement_committed:commit}));
}finally{key?.fill(0);try{await remote?.close();}finally{await lease.release();}}
