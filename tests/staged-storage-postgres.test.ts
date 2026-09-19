import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database} from '../packages/storage/src/index.ts';
import {StagedStorage} from '../packages/market/src/staged-storage.ts';
import type {PrivacyFacade} from '../packages/market/src/service.ts';

const url=process.env.THOT_STORAGE_TEST_DATABASE_URL;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
test('separate native PostgreSQL adapters fence stale preparation without clearing a replacement claim',{skip:!url},async t=>{
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(url!).hostname),'Use a disposable loopback PostgreSQL test database');
  const [a,b]=await Promise.all([Database.open({url}),Database.open({url})]);t.after(async()=>{await a.close();await b.close();});
  // No ciphertext operation is needed here: this specifically exercises native
  // row locks, lease expiry, replacement claims and stale-worker commit fencing.
  const privacy={} as PrivacyFacade,first=new StagedStorage(a,privacy),second=new StagedStorage(b,privacy);
  const owner='synthetic-'+randomUUID(),key='native-fence-key',request={action:'nativeFence'},enteredA=deferred(),releaseA=deferred(),enteredB=deferred(),releaseB=deferred();
  t.after(()=>{releaseA.resolve();releaseB.resolve();});
  await a.transaction(tx=>tx.insert('trace_features',owner,owner,{count:0}));
  const increment=async(tx:any)=>{const row=await tx.get('trace_features',owner,owner);row.count++;await tx.update('trace_features',owner,row);return {count:row.count};};
  const old=first.run(owner,key,request,'part',async()=>{enteredA.resolve();await releaseA.promise;return increment;});await enteredA.promise;
  await assert.rejects(second.run(owner,key,request,'part',async()=>increment),/STORAGE_OPERATION_IN_PROGRESS/);
  await assert.rejects(second.run(owner,key,{action:'different'},'part',async()=>increment),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(b.command(owner,key,request,increment),/STORAGE_OPERATION_IN_PROGRESS/);
  await a.transaction(async tx=>{await tx.sql.query("UPDATE storage_write_attempts SET expires_at=now()-interval '1 second' WHERE owner_id=$1",[owner]);});
  const replacement=second.run(owner,key,request,'part',async()=>{enteredB.resolve();await releaseB.promise;return increment;});await enteredB.promise;
  const liveBefore=(await b.query('SELECT attempt_id FROM storage_command_claims WHERE actor_id=$1 AND key=$2',[owner,key])).rows[0]!.attempt_id;
  releaseA.resolve();await assert.rejects(old,/STORAGE_OPERATION_EXPIRED/);
  assert.equal((await b.query('SELECT attempt_id FROM storage_command_claims WHERE actor_id=$1 AND key=$2',[owner,key])).rows[0]!.attempt_id,liveBefore,'stale catch must not clear replacement claim');
  releaseB.resolve();assert.deepEqual(await replacement,{count:1});
  assert.deepEqual(await first.run(owner,key,request,'part',async()=>increment),{count:1});
  await Promise.all(Array.from({length:8},(_,i)=>(i%2?first:second).run(owner,'parallel-native-'+i,{i},'part',async()=>increment)));
  assert.equal((await a.transaction(tx=>tx.get('trace_features',owner,owner))).count,9);
});
