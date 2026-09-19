import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {SqlRemoteAccounting,DEFAULT_REMOTE_QUOTAS,type QuotaDatabase} from '../packages/vault/src/remote-accounting.ts';
import {VaultStore,LocalMasterKeyProvider,CiphertextNotFoundError,type CiphertextStore} from '../packages/vault/src/index.ts';

class Objects implements CiphertextStore {
  data=new Map<string,Buffer>();ambiguous=false;deleteFails=false;
  async put(id:string,b:Buffer){if(this.data.has(id))throw Error('EEXIST');this.data.set(id,Buffer.from(b));if(this.ambiguous)throw Error('TIMEOUT_AFTER_ACCEPTANCE');}
  async get(id:string,max:number){const b=this.data.get(id);if(!b)throw new CiphertextNotFoundError();if(b.length>max)throw Error('INVALID_VAULT_OBJECT');return Buffer.from(b);}
  async delete(id:string){if(this.deleteFails)throw Error('DELETE_OUTAGE');this.data.delete(id);}
}
async function fixture(t:any,overrides:any={}){
  const sql=await PGlite.create();t.after(()=>sql.close());
  const db:QuotaDatabase={transaction:work=>sql.transaction(q=>work(q as any))};
  const limits={...DEFAULT_REMOTE_QUOTAS,...overrides};
  const accounting=await new SqlRemoteAccounting(db,'fixture',limits).initialize();
  const objects=new Objects(),key=new LocalMasterKeyProvider(Buffer.alloc(32,73));
  const vault=new VaultStore(objects,key,{remoteAccounting:accounting});
  return {sql,db,limits,accounting,objects,key,vault};
}
test('remote objects contain ciphertext only and a fresh reader recovers without local files',async t=>{
  const {objects,key,vault,db,limits,accounting}=await fixture(t);
  const ref=await vault.put({ownerUserId:'alice',content:'private original evidence',objectId:'original'});
  const encrypted=objects.data.get(ref.objectId)!;
  assert.ok(!encrypted.includes(Buffer.from('private original evidence')));
  assert.equal((await accounting.usage('alice')).owner.bytes,encrypted.length);
  const replacement=new VaultStore(objects,key,{remoteAccounting:await new SqlRemoteAccounting(db,'fixture',limits).initialize()});
  assert.equal((await replacement.get(ref)).toString(),'private original evidence');
  await assert.rejects(replacement.get({...ref,ownerUserId:'bob'}),/VAULT_ACCESS_DENIED/);
  await assert.rejects(new VaultStore(objects,new LocalMasterKeyProvider(Buffer.alloc(32,74)),{remoteAccounting:accounting}).get(ref),/VAULT_INTEGRITY_FAILURE/);
  await assert.rejects(vault.put({ownerUserId:'alice',objectId:ref.objectId,content:'overwrite'}),/EEXIST/);
  assert.equal((await vault.get(ref)).toString(),'private original evidence');
});
test('independent writers cannot overshoot global reservations or use a conflicting policy',async t=>{
  const {db,limits,accounting,objects,key}=await fixture(t,{userObjects:2,ownerObjects:2});
  await assert.rejects(new SqlRemoteAccounting(db,'lost-ledger',limits).initialize(false),/REMOTE_QUOTA_NAMESPACE_MISSING/);
  const other=await new SqlRemoteAccounting(db,'fixture',limits).initialize();
  const a=new VaultStore(objects,key,{remoteAccounting:accounting}),b=new VaultStore(objects,key,{remoteAccounting:other});
  const results=await Promise.allSettled(Array.from({length:12},(_,i)=>(i%2?a:b).put({ownerUserId:'owner-'+i,content:'data',objectId:'item-'+i})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((await accounting.usage()).user.objects,2);
  assert.equal(objects.data.size,2);
  await assert.rejects(new SqlRemoteAccounting(db,'fixture',{...limits,userObjects:3}).initialize(),/REMOTE_QUOTA_POLICY_MISMATCH/);
  await assert.rejects(new SqlRemoteAccounting(db,'fixture',limits,'another-bucket').initialize(),/REMOTE_QUOTA_POLICY_MISMATCH/);
});
test('owner rejection rolls back global charge and occurs before key derivation',async t=>{
  const {vault,objects,accounting}=await fixture(t,{ownerObjects:1});
  await vault.put({ownerUserId:'alice',content:'first'});
  let keyReads=0;
  const rejected=new VaultStore(objects,{keyId:'local-master-v1',async getObjectKey(){keyReads++;return Buffer.alloc(32);}}, {remoteAccounting:accounting});
  await assert.rejects(rejected.put({ownerUserId:'alice',content:'second'}),/VAULT_OWNER_QUOTA/);
  assert.equal(keyReads,0);assert.equal((await accounting.usage()).user.objects,1);
  await vault.put({ownerUserId:'bob',content:'allowed'});
});
test('ambiguous write retains quota across restart; it cannot be deleted while pending',async t=>{
  const {vault,objects,db,limits,accounting}=await fixture(t,{ownerObjects:1});objects.ambiguous=true;
  await assert.rejects(vault.put({ownerUserId:'alice',objectId:'uncertain',content:'data'}),/TIMEOUT_AFTER_ACCEPTANCE/);
  const restarted=await new SqlRemoteAccounting(db,'fixture',limits).initialize();
  assert.equal((await restarted.usage('alice')).owner.objects,1);
  await assert.rejects(vault.put({ownerUserId:'alice',content:'more'}),/VAULT_OWNER_QUOTA/);
  await assert.rejects(vault.delete({ownerUserId:'alice',objectId:'uncertain'}),/REMOTE_PENDING_RECONCILIATION_REQUIRED/);
  assert.equal(objects.data.size,1);
  // Operator recovery after verifying accepted bytes, not timeout-based release.
  await accounting.stored('uncertain','alice',objects.data.get('uncertain')!.length);objects.ambiguous=false;
  await vault.delete({ownerUserId:'alice',objectId:'uncertain'});
  assert.equal((await restarted.usage()).user.objects,0);
});
test('delete outages and lost acknowledgments retain quota; retry releases once and cannot reuse ids',async t=>{
  const {vault,objects,accounting}=await fixture(t);
  const ref=await vault.put({ownerUserId:'alice',objectId:'deletion',content:'data'});
  await assert.rejects(vault.delete({...ref,ownerUserId:'bob'}),/VAULT_ACCESS_DENIED/);
  objects.deleteFails=true;await assert.rejects(vault.delete(ref),/DELETE_OUTAGE/);
  assert.equal((await accounting.usage()).user.objects,1);
  objects.deleteFails=false;
  // Simulate durable provider deletion followed by a crash before ledger release.
  await objects.delete(ref.objectId);
  await vault.delete(ref);await vault.delete(ref);
  assert.equal((await accounting.usage()).user.objects,0);
  await assert.rejects(vault.put({...ref,content:'replacement'}),/EEXIST/);
});
test('operator journal quota is separate and unavailable to public owners',async t=>{
  const {vault,accounting}=await fixture(t,{userObjects:1,ownerObjects:1,journalObjects:1});
  await vault.put({ownerUserId:'alice',content:'user'});
  const owner='thot-operator:0x'+'ab'.repeat(32);
  await assert.rejects(vault.put({ownerUserId:owner,content:'bad'}),/VAULT_RESERVED_OWNER/);
  const write=vault.operatorJournalWriter(owner);await write('journal');
  await assert.rejects(write('more'),/VAULT_JOURNAL_CAPACITY/);
  const usage=await accounting.usage();assert.equal(usage.user.objects,1);assert.equal(usage.journal.objects,1);
});

test('private JSONL upload uses remote objects end to end and changing placement fails startup',async t=>{
  const {createApplication}=await import('../packages/market/src/bootstrap.ts');
  const {mkdtemp,rm,readdir}=await import('node:fs/promises');
  const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const {objects,accounting}=await fixture(t);
  const dataDir=await mkdtemp(join(tmpdir(),'thot-remote-app-'));
  const storage={ciphertext:objects,accounting,identity:'a'.repeat(64)};
  let app=await createApplication({dataDir,storage,masterKey:Buffer.alloc(32,73)});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const actor={id:'demo-user',role:'user' as const};
  const text=[{type:'user',message:{role:'user',content:'Explain a synthetic sorting example.'}},{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Synthetic saved answer.'}]}}].map(r=>JSON.stringify(r)).join('\n');
  const preview=app.portfolio.preview(actor,{text,filename:'session.jsonl'});
  const saved=await app.portfolio.import(actor,'remote-import-fixture',{text,filename:'session.jsonl',content_commitment:preview.content_commitment,save_privately:true});
  assert.equal(saved.status,'PRIVATE');assert.equal(objects.data.size,4);
  assert.ok(!(await readdir(dataDir)).includes('objects'));
  assert.match(JSON.stringify((await app.library.item(actor,saved.trace_id)).content),/Synthetic saved answer/);
  await app.close();
  await assert.rejects(createApplication({dataDir,storage:{...storage,identity:'b'.repeat(64)},masterKey:Buffer.alloc(32,73)}),/STORAGE_FORMAT_CHANGED/);
  app=await createApplication({dataDir,storage,masterKey:Buffer.alloc(32,73)});
  assert.match(JSON.stringify((await app.library.item(actor,saved.trace_id)).content),/Synthetic saved answer/);
  await app.service.deleteTrace(actor,'remote-delete-fixture',saved.trace_id);
  await app.service.runWorker(20);
  assert.equal((await accounting.usage(actor.id)).owner.objects,0);
});

test('migration authenticates and preserves original ciphertext, retries without new charges, and rejects tampering',async t=>{
  const {copyCiphertextObjects}=await import('../packages/vault/src/migrate-ciphertext.ts');
  const {mkdtemp,rm,readFile,writeFile}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const {objects,accounting,key,vault}=await fixture(t);
  const root=await mkdtemp(join(tmpdir(),'thot-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=new VaultStore(root,key);
  const ref=await local.put({ownerUserId:'alice',objectId:'original',content:'unchanged original evidence'});
  const original=await readFile(join(root,'original.sealed'));
  const first=await copyCiphertextObjects(root,key,objects,accounting);
  const second=await copyCiphertextObjects(root,key,objects,accounting);
  assert.deepEqual(first,second);assert.ok(objects.data.get('original')!.equals(original));
  assert.equal((await accounting.usage()).user.objects,1);
  assert.equal((await vault.get(ref)).toString(),'unchanged original evidence');
  const changed=JSON.parse(original.toString());changed.tag=Buffer.alloc(16).toString('base64');
  await writeFile(join(root,'original.sealed'),JSON.stringify(changed));
  await assert.rejects(copyCiphertextObjects(root,key,objects,accounting),/VAULT_INTEGRITY_FAILURE/);
  assert.ok(objects.data.get('original')!.equals(original));
});

test('trusted allowance grants expand one contributor immediately across writers and are audited',async t=>{
  const {vault,accounting,db,limits,objects,key,sql}=await fixture(t,{ownerObjects:1});
  const anotherWriter=new VaultStore(objects,key,{remoteAccounting:await new SqlRemoteAccounting(db,'fixture',limits).initialize(false)});
  await vault.put({ownerUserId:'alice',content:'first useful trace'});
  await assert.rejects(anotherWriter.put({ownerUserId:'alice',content:'next useful trace'}),/VAULT_OWNER_QUOTA/);
  await accounting.setOwnerAllowance('alice',limits.ownerBytes,3,'Retain additional research contributions');
  await anotherWriter.put({ownerUserId:'alice',content:'next useful trace'});
  await vault.put({ownerUserId:'alice',content:'third useful trace'});
  await assert.rejects(accounting.setOwnerAllowance('alice',limits.ownerBytes,1,'reduce'),/OWNER_ALLOWANCE_BELOW_USAGE/);
  await assert.rejects(accounting.setOwnerAllowance('alice',limits.userBytes+1,3,'exceed global'),/INVALID_OWNER_ALLOWANCE/);
  await vault.put({ownerUserId:'bob',content:'first'});
  await assert.rejects(vault.put({ownerUserId:'bob',content:'second'}),/VAULT_OWNER_QUOTA/);
  const audit=(await sql.query<{reason:string}>('SELECT reason FROM remote_vault_allowance_audit')).rows;
  assert.equal(audit.length,1);assert.equal(audit[0]!.reason,'Retain additional research contributions');
});

test('confirm reads only its saved item; blocked portfolio metadata cannot hold the shared database lock',async t=>{
  const {createApplication}=await import('../packages/market/src/bootstrap.ts');
  const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const {objects,accounting}=await fixture(t),dataDir=await mkdtemp(join(tmpdir(),'thot-portfolio-remote-'));
  const app=await createApplication({dataDir,storage:{ciphertext:objects,accounting,identity:'c'.repeat(64)},masterKey:Buffer.alloc(32,73)});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const actor={id:'demo-user',role:'user' as const};
  let gets=0;const originalGet=objects.get.bind(objects);objects.get=async(id,max)=>{gets++;return originalGet(id,max);};
  for(let i=0;i<3;i++){
    const text=[{type:'user',message:{role:'user',content:'Synthetic unique prompt '+i}},{type:'assistant',message:{role:'assistant',content:'Synthetic answer '+i}}].map(v=>JSON.stringify(v)).join('\n');
    const preview=app.portfolio.preview(actor,{text,filename:'session.jsonl'});gets=0;
    await app.portfolio.import(actor,'bounded-confirm-'+i,{text,filename:'session.jsonl',content_commitment:preview.content_commitment,save_privately:true});
    assert.equal(gets,1,'confirmation must not download prior inventory metadata');
  }
  let release!:()=>void,notify!:()=>void;
  const started=new Promise<void>(r=>notify=r),blocked=new Promise<void>(r=>release=r);
  objects.get=async(id,max)=>{notify();await blocked;return originalGet(id,max);};
  const listing=app.portfolio.list(actor);await started;
  try{
    const timeout=new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('DB_BLOCKED_BY_REMOTE_READ')),1000);timer.unref();});
    await Promise.race([app.db.transaction(tx=>tx.sql.query('SELECT 1')),timeout]);
  }finally{release();}
  assert.equal((await listing).items.length,3);
});

test('remote upload outage is a sanitized HTTP 503, not invalid input, and retry can save the file',async t=>{
  const {createApplication}=await import('../packages/market/src/bootstrap.ts');const {createHttpServer}=await import('../apps/api/server.ts');
  const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const {objects,accounting}=await fixture(t),dataDir=await mkdtemp(join(tmpdir(),'thot-storage-outage-'));
  const app=await createApplication({dataDir,storage:{ciphertext:objects,accounting,identity:'d'.repeat(64)},masterKey:Buffer.alloc(32,73)});
  const server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await app.close();await rm(dataDir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const session=await (await fetch(base+'/v1/dev/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'user'})})).json() as any;
  const text=[{type:'user',message:{role:'user',content:'Synthetic retry example'}},{type:'assistant',message:{role:'assistant',content:'Original retry answer'}}].map(v=>JSON.stringify(v)).join('\n');
  const preview=app.portfolio.preview({id:'demo-user',role:'user'},{text,filename:'retry.jsonl'});
  const body={text,filename:'retry.jsonl',content_commitment:preview.content_commitment,save_privately:true};
  const post=()=>fetch(base+'/v1/contributor/import/confirm',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+session.token,'idempotency-key':'storage-retry-example'},body:JSON.stringify(body)});
  const put=objects.put.bind(objects);objects.put=async()=>{throw Error('REMOTE_OBJECT_WRITE_FAILED');};
  const failed=await post();assert.equal(failed.status,503);assert.equal((await failed.json() as any).error,'REMOTE_OBJECT_WRITE_FAILED');
  objects.put=put;const retried=await post();assert.equal(retried.status,200);assert.equal((await retried.json() as any).status,'PRIVATE');
});
