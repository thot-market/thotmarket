import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,stat,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {createCipheriv,randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {VaultStore,LocalMasterKeyProvider,type VaultQuotaOptions} from '../packages/vault/src/index.ts';
import {canonicalJson} from '../packages/protocol/src/index.ts';

const key=new LocalMasterKeyProvider(Buffer.alloc(32,93));
const journalOwner='thot-operator:0x'+'ab'.repeat(32);
async function fixture(t:any,options:VaultQuotaOptions={}){
 const root=await mkdtemp(join(tmpdir(),'thot-vault-quota-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new VaultStore(root,key,{...options,availableBytes:options.availableBytes??(async()=>10*1024**3)});
 return {root,store};
}
test('vault counts serialized encryption overhead and protects owner quota across revisions and deletions',async t=>{
 const {root,store}=await fixture(t,{quotas:{ownerObjects:2}});
 const first=await store.put({ownerUserId:'alice',objectId:'one',content:'one'});
 await store.put({ownerUserId:'alice',objectId:'two',content:'revision'});
 const bytes=(await stat(join(root,'one.sealed'))).size+(await stat(join(root,'two.sealed'))).size;
 assert.equal((await store.usage('alice')).owner.bytes,bytes);
 assert.ok(bytes>Buffer.byteLength('onerevision'));
 await assert.rejects(store.put({ownerUserId:'alice',content:'another revision'}),/VAULT_OWNER_QUOTA/);
 await assert.rejects(store.delete({...first,ownerUserId:'mallory'}),/VAULT_ACCESS_DENIED/);
 assert.equal((await store.usage('alice')).owner.objects,2);
 await store.delete(first);await store.put({ownerUserId:'alice',objectId:'three',content:'replacement'});
 assert.equal((await store.usage('alice')).owner.objects,2);
});
test('vault applies cumulative encrypted byte quota, not just plaintext limit',async t=>{
 const {store}=await fixture(t,{quotas:{ownerBytes:550}});
 await store.put({ownerUserId:'alice',content:'x'.repeat(100)});
 await assert.rejects(store.put({ownerUserId:'alice',content:'x'.repeat(100)}),/VAULT_OWNER_QUOTA/);
});
test('same-root instances serialize competing puts without global-count overshoot or relaxed policy',async t=>{
 const {root,store}=await fixture(t,{quotas:{userObjects:2}});
 const other=new VaultStore(join(root,'..',root.split('/').at(-1)!),key,{availableBytes:async()=>10*1024**3});
 const results=await Promise.allSettled(Array.from({length:15},(_,i)=>(i%2?store:other).put({ownerUserId:'user-'+i,objectId:'item-'+i,content:'data'})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,2);
 assert.equal((await readdir(root)).length,2);
 assert.equal((await other.usage()).user.objects,2);
 for(const r of results)if(r.status==='rejected')assert.match(String(r.reason),/VAULT_GLOBAL_QUOTA/);
});
test('a constructed stricter store constrains another store before its first asynchronous write',async t=>{
 const {root}=await fixture(t,{quotas:{userObjects:2}});
 const other=new VaultStore(root,key,{availableBytes:async()=>10*1024**3});
 await other.put({ownerUserId:'one',content:'one'});
 await other.put({ownerUserId:'two',content:'two'});
 await assert.rejects(other.put({ownerUserId:'three',content:'three'}),/VAULT_GLOBAL_QUOTA/);
 assert.equal((await other.usage()).user.objects,2);
});
test('journal reserve survives full intake and cannot be selected by owner or class fields',async t=>{
 const {store}=await fixture(t,{quotas:{userObjects:1,journalObjects:2}});
 await store.put({ownerUserId:'alice',content:'public intake',storage_class:'operator-journal'} as any);
 await assert.rejects(store.put({ownerUserId:'bob',content:'full'}),/VAULT_GLOBAL_QUOTA/);
 await assert.rejects(store.put({ownerUserId:journalOwner,content:'spoof'}),/VAULT_RESERVED_OWNER/);
 assert.throws(()=>store.operatorJournalWriter('alice'),/INVALID_VAULT_JOURNAL_OWNER/);
 const writeJournal=store.operatorJournalWriter(journalOwner),ref=await writeJournal('signed pending transaction');
 assert.equal((await store.get(ref)).toString(),'signed pending transaction');
 await writeJournal('confirmed transaction');
 await assert.rejects(writeJournal('too much'),/VAULT_JOURNAL_CAPACITY/);
 assert.deepEqual((await store.usage()).journal.objects,2);
 assert.equal((await store.usage()).user.objects,1);
});
test('new process reconstructs quotas from all surviving ciphertext including unreferenced revisions',async t=>{
 const {root,store}=await fixture(t,{quotas:{ownerObjects:2}});
 await store.put({ownerUserId:'alice',objectId:'orphan-revision',content:'no DB row points here'});
 await store.put({ownerUserId:'alice',objectId:'active',content:'current revision'});
 const url=new URL('../packages/vault/src/index.ts',import.meta.url).href;
 const code=`import {VaultStore,LocalMasterKeyProvider} from ${JSON.stringify(url)};
 const vault=new VaultStore(process.argv[1],new LocalMasterKeyProvider(Buffer.alloc(32,93)),{quotas:{ownerObjects:2},availableBytes:async()=>10*1024**3});
 let error;try{await vault.put({ownerUserId:'alice',content:'new'});}catch(e){error=e.message;}
 process.stdout.write(JSON.stringify({error,usage:await vault.usage('alice')}));`;
 const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',code,root],{timeout:15000});
 const output=JSON.parse(result.stdout);assert.equal(output.error,'VAULT_OWNER_QUOTA');assert.equal(output.usage.owner.objects,2);
});
test('partial files and unknown files consume global intake quota and do not break existing reads',async t=>{
 const {root,store}=await fixture(t,{quotas:{userObjects:2}}),ref=await store.put({ownerUserId:'alice',content:'existing'});
 await writeFile(join(root,'failed.sealed'),'{"ciphertext":"unfinished',{mode:0o600});
 assert.equal((await store.usage()).user.objects,2);
 await assert.rejects(store.put({ownerUserId:'bob',content:'new'}),/VAULT_GLOBAL_QUOTA/);
 assert.equal((await store.get(ref)).toString(),'existing');
 const journal=await store.operatorJournalWriter(journalOwner)('preserve payout');
 assert.equal((await store.get(journal)).toString(),'preserve payout');
});
test('failed writes leave counted orphan bytes; quota is not rolled back over surviving data',async t=>{
 const {root,store}=await fixture(t,{quotas:{userObjects:1}});
 const handle=await open(join(root,'probe'),'w'),prototype=Object.getPrototypeOf(handle);await handle.close();await rm(join(root,'probe'));
 const original=prototype.writeFile;
 prototype.writeFile=async function(data:any){await original.call(this,String(data).slice(0,55));throw Error('INJECTED_WRITE_FAILURE');};
 try{await assert.rejects(store.put({ownerUserId:'alice',objectId:'partial',content:'no confirmation'}),/INJECTED_WRITE_FAILURE/);}
 finally{prototype.writeFile=original;}
 const usage=await store.usage();assert.equal(usage.user.objects,1);assert.equal(usage.user.bytes,55);
 await assert.rejects(store.put({ownerUserId:'alice',content:'retry'}),/VAULT_GLOBAL_QUOTA/);
 assert.equal((await readdir(root)).length,1);
});
test('filesystem free-space floor preserves extra journal headroom',async t=>{
 const {store}=await fixture(t,{quotas:{minFreeBytes:4096,journalBytes:2000},availableBytes:async()=>9500});
 await assert.rejects(store.put({ownerUserId:'alice',content:'user data'}),/VAULT_DISK_HEADROOM/);
 const ref=await store.operatorJournalWriter(journalOwner)('settlement');assert.equal((await store.get(ref)).toString(),'settlement');
});
test('statfs failure denies new writes while authenticated reads and deletes still work',async t=>{
 let unavailable=false;
 const {store}=await fixture(t,{availableBytes:async()=>{if(unavailable)throw Error('FS_FAILURE');return 10*1024**3;}});
 const ref=await store.put({ownerUserId:'alice',content:'recover me'});unavailable=true;
 await assert.rejects(store.put({ownerUserId:'bob',content:'new'}),/VAULT_DISK_SPACE_UNAVAILABLE/);
 assert.equal((await store.get(ref)).toString(),'recover me');await store.delete(ref);
 assert.equal((await store.usage()).user.objects,0);
});
test('journal classification is bound into encrypted object authentication',async t=>{
 const {root,store}=await fixture(t),ref=await store.operatorJournalWriter(journalOwner)('private transaction');
 const file=join(root,ref.objectId+'.sealed'),envelope=JSON.parse(await readFile(file,'utf8'));delete envelope.storage_class;
 await writeFile(file,JSON.stringify(envelope));await assert.rejects(store.get(ref),/VAULT_INTEGRITY_FAILURE/);
});
test('pre-quota legacy journal remains readable and counted, while new journal revisions use reserved capacity',async t=>{
 const {root,store}=await fixture(t,{quotas:{userObjects:1}});
 const objectId='legacy-pending-transaction',nonce=randomBytes(12),objectKey=await key.getObjectKey({ownerUserId:journalOwner,objectId});
 const aad={version:1,object_id:objectId,owner_user_id:journalOwner,key_id:key.keyId};
 const cipher=createCipheriv('aes-256-gcm',objectKey,nonce);cipher.setAAD(Buffer.from(canonicalJson(aad)));
 const ciphertext=Buffer.concat([cipher.update('legacy signed pending transaction'),cipher.final()]);objectKey.fill(0);
 await writeFile(join(root,objectId+'.sealed'),canonicalJson({...aad,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}),{mode:0o600});
 assert.equal((await store.get({ownerUserId:journalOwner,objectId})).toString(),'legacy signed pending transaction');
 const before=await store.usage();assert.equal(before.user.objects,1);assert.equal(before.journal.objects,0);
 await assert.rejects(store.put({ownerUserId:'alice',content:'intake'}),/VAULT_GLOBAL_QUOTA/);
 const current=await store.operatorJournalWriter(journalOwner)('confirmed transaction');
 assert.equal((await store.get(current)).toString(),'confirmed transaction');
 assert.equal((await store.get({ownerUserId:journalOwner,objectId})).toString(),'legacy signed pending transaction');
 assert.equal((await store.usage()).journal.objects,1);
});
test('invalid or unbounded configuration rejects before creating any objects',async t=>{
 const {root}=await fixture(t);
 for(const quotas of [{userBytes:Number.MAX_SAFE_INTEGER},{ownerObjects:0},{journalBytes:-1},{unknown:3}])assert.throws(()=>new VaultStore(root,key,{quotas} as any),/INVALID_VAULT_QUOTA/);
 assert.deepEqual(await readdir(root),[]);
});
