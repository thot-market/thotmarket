import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VaultStore,LocalMasterKeyProvider,FileCiphertextStore,CiphertextNotFoundError,type CiphertextStore} from '../packages/vault/src/index.ts';
import {canonicalHash,canonicalJson} from '../packages/protocol/src/index.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {DataDirectoryLease,ensureStorageFormat,readStorageFormat} from '../packages/operations/src/lease.ts';
import {requireLocalLayout} from '../packages/operations/src/backup.ts';
import {PrivacyIntegrations} from '../packages/market/src/integrations.ts';

/** Remote-object protocol fixture only, not a production cloud implementation. */
class FixtureObjects implements CiphertextStore {
  objects=new Map<string,Buffer>();
  async put(id:string,bytes:Buffer){if(this.objects.has(id))throw Error('OBJECT_EXISTS');this.objects.set(id,Buffer.from(bytes));}
  async get(id:string,maxBytes:number){const bytes=this.objects.get(id);if(!bytes)throw new CiphertextNotFoundError();if(bytes.length>maxBytes)throw Error('INVALID_VAULT_OBJECT');return Buffer.from(bytes);}
  async delete(id:string){this.objects.delete(id);}
}

test('ciphertext placement can move without changing the evidence or involving recorder/market state',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-placement-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=Buffer.alloc(32,37),local=new VaultStore(directory,new LocalMasterKeyProvider(key));
  const record={sequence:1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from('PRIVATE SYNTHETIC INPUT').toString('base64'),response_body_b64:Buffer.from('PRIVATE SYNTHETIC OUTPUT').toString('base64'),complete:true};
  const part={...record,commitment:canonicalHash(record)},manifest={parts:[{sequence:1,commitment:part.commitment}]};
  const beforeRoot=canonicalHash(manifest),ref=await local.put({ownerUserId:'alice',content:canonicalJson(part)});
  const encrypted=await readFile(join(directory,ref.objectId+'.sealed'));
  assert.ok(!encrypted.includes(Buffer.from('PRIVATE SYNTHETIC')));assert.ok(!encrypted.includes(Buffer.from(part.request_body_b64)));
  const replacementDirectory=await mkdtemp(join(tmpdir(),'thot-placement-replacement-'));t.after(()=>rm(replacementDirectory,{recursive:true,force:true}));
  await writeFile(join(replacementDirectory,ref.objectId+'.sealed'),encrypted,{mode:0o600});
  // Delete the old placement. The second reader has no old directory or service.
  await rm(join(directory,ref.objectId+'.sealed'));
  const replacement=new VaultStore(new FileCiphertextStore(replacementDirectory),new LocalMasterKeyProvider(key));
  const recovered=JSON.parse((await replacement.get(ref)).toString());
  assert.deepEqual(recovered,part);const {commitment,...recoveredRecord}=recovered;
  assert.equal(canonicalHash(recoveredRecord),commitment);assert.equal(canonicalHash(manifest),beforeRoot);
  await assert.rejects(replacement.get({...ref,ownerUserId:'bob'}),/VAULT_ACCESS_DENIED/);
  await assert.rejects(new VaultStore(new FileCiphertextStore(replacementDirectory),new LocalMasterKeyProvider(Buffer.alloc(32,38))).get(ref),/VAULT_INTEGRITY_FAILURE/);
  await assert.rejects(replacement.put({ownerUserId:'alice',objectId:ref.objectId,content:'replacement'}),/EEXIST/);
  assert.deepEqual(JSON.parse((await replacement.get(ref)).toString()),part);
});

test('untrusted storage cannot bypass vault accounting',async()=>{
  const objects=new FixtureObjects();
  assert.throws(()=>new VaultStore(objects,new LocalMasterKeyProvider(Buffer.alloc(32,21))),/VAULT_ACCOUNTING_UNSUPPORTED/);
});

test('storage read budgets apply to adapters and actual file reads',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-store-limit-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const files=new FileCiphertextStore(directory);await writeFile(join(directory,'oversized.sealed'),Buffer.alloc(1025));
  await assert.rejects(files.get('oversized',1024),/INVALID_VAULT_OBJECT/);
  await assert.rejects(files.get('../escape',1024),/INVALID_VAULT_REFERENCE/);
  const malicious:CiphertextStore={put:async()=>{},get:async(_id,max)=>Buffer.alloc(max+1),delete:async()=>{}};
  assert.throws(()=>new VaultStore(malicious,new LocalMasterKeyProvider(Buffer.alloc(32,1)),{maxBytes:100}),/VAULT_ACCOUNTING_UNSUPPORTED/);
  assert.throws(()=>new VaultStore(malicious,new LocalMasterKeyProvider(Buffer.alloc(32,1)),{quotas:{ownerBytes:1}}),/VAULT_ACCOUNTING_UNSUPPORTED/);
});

test('application rejects unsupported unaccounted ciphertext placement',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-app-store-')),objects=new FixtureObjects();
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await assert.rejects(createApplication({dataDir:directory,memory:true,storage:{ciphertext:objects,keys:new LocalMasterKeyProvider(Buffer.alloc(32,4),'fixture-object-keys')}}),/VAULT_ACCOUNTING_UNSUPPORTED/);
});

test('injected file placement retains key custody, quotas and retryable deletion',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-injected-file-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const objects=new FileCiphertextStore(directory),keyProvider=new LocalMasterKeyProvider(Buffer.alloc(32,51),'injected-object-key');
  const privacy=new PrivacyIntegrations({development:true,vaultRoot:'unused-fixture-path',masterKey:Buffer.alloc(32,52),ciphertextStore:objects,objectKeyProvider:keyProvider,vaultQuotas:{ownerObjects:1}});
  const first=await privacy.seal('alice',{part:1});
  assert.equal(JSON.parse(await readFile(join(directory,first.objectId+'.sealed'),'utf8')).key_id,'injected-object-key');
  assert.deepEqual(await privacy.open('alice',first),{part:1});
  await assert.rejects(privacy.open('bob',first),/VAULT_ACCESS_DENIED/);
  await assert.rejects(privacy.seal('alice',{part:2}),/VAULT_OWNER_QUOTA/);
  const reader=new VaultStore(objects,keyProvider);
  assert.equal((await reader.usage('alice')).owner.objects,1);
  await privacy.remove('alice',first);await privacy.remove('alice',first);
  assert.equal((await reader.usage('alice')).owner.objects,0);
  const second=await privacy.seal('alice',{part:2});
  await privacy.remove('alice',second);
});

test('legacy custody defaults are preserved and external object keys cannot pass local recovery gates',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-key-custody-'));
  const lease=await DataDirectoryLease.acquire(directory,{mode:'maintenance'});
  t.after(async()=>{await lease.release();await rm(directory,{recursive:true,force:true});});
  const legacy={version:1 as const,backend:'pglite' as const,keyCustody:'local-file' as const};
  await ensureStorageFormat(lease,legacy);assert.deepEqual(await readStorageFormat(lease),legacy);
  await assert.rejects(ensureStorageFormat(lease,{...legacy,objectKeyCustody:'external'}),/STORAGE_FORMAT_CHANGED/);
  await writeFile(join(directory,'.thot-storage.json'),JSON.stringify({...legacy,objectKeyCustody:'external'}));
  assert.deepEqual(await readStorageFormat(lease),{...legacy,objectKeyCustody:'external'});
  await assert.rejects(requireLocalLayout(lease),/OFFLINE_LOCAL_OBJECT_KEYS_REQUIRED/);
  await assert.rejects(ensureStorageFormat(lease,legacy),/STORAGE_FORMAT_CHANGED/);
});

test('external blob placement cannot be mistaken for a complete local backup',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-external-backup-'));
  const lease=await DataDirectoryLease.acquire(directory,{mode:'maintenance'});
  t.after(async()=>{await lease.release();await rm(directory,{recursive:true,force:true});});
  await ensureStorageFormat(lease,{version:1,backend:'pglite',keyCustody:'local-file',objectStorage:'external'});
  await assert.rejects(requireLocalLayout(lease),/OFFLINE_LOCAL_OBJECT_STORAGE_REQUIRED/);
});
