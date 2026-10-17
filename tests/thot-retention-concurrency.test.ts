import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {demoUser} from '../packages/market/src/fixtures.ts';
import type {ThotChain} from '../packages/chain/thot.ts';
import type {Document,Transaction} from '../packages/storage/src/index.ts';

const traceId='synthetic-retention-trace',listingId='synthetic-retention-listing';
const now=Date.parse('2026-10-01T12:00:00.000Z'),timestamp=now/1000;
const authorization=()=>({uses:0,revoked:true,block:{number:100,hash:'0x'+'a'.repeat(64),timestamp}});
const offer=(status=0)=>({status,issued_at:timestamp,accepted_at:timestamp,block:{number:100,hash:'0x'+'a'.repeat(64),timestamp}});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function within<T>(promise:Promise<T>){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Unrelated transaction waited for retention RPC')),1500);})]);}
 finally{clearTimeout(timer);}
}
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),'thot-retention-concurrency-')),app=await createApplication({memory:true,dataDir:dir});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 app.service.now=()=>new Date(now).toISOString();
 app.thot.chain={authorizationState:async()=>authorization(),offer:async()=>offer(),assertSnapshot:async()=>{}} as unknown as ThotChain;
 const release={content:{turns:[{role:'user',content:'Synthetic retention test only.'}]}};
 const ref=await app.privacy.seal(demoUser.id,release);
 await app.db.transaction(async tx=>{
  await tx.insert('traces',traceId,demoUser.id,{trace_id:traceId,created_at:new Date(now-86400000).toISOString(),retention_expires_at:new Date(now+86400000).toISOString(),deleted:false});
  await tx.insert('thot_records',listingId,demoUser.id,{kind:'listing',trace_id:traceId,active:true,wallet:'0x'+'1'.repeat(40),signature:'synthetic-signature',authorization:{nonce:'1',maxUses:1,validUntil:timestamp+86400},created_at:new Date(now-3600000).toISOString(),release_ref:ref,evidence_hash:'synthetic-release-hash',retention_days:30});
 });
 return {app,ref,release};
}
async function assertRetained(app:Awaited<ReturnType<typeof createApplication>>,ref:Document){
 const row=await app.db.transaction(tx=>tx.get('thot_records',listingId));
 assert.equal(row.release_deleted_at,undefined);assert.deepEqual(row.release_ref,ref);
 assert.ok((await app.privacy.open(demoUser.id,ref)).content.turns.length);
}

test('retention authorization RPC does not block unrelated account transactions',async t=>{
 const {app}=await fixture(t),entered=deferred(),release=deferred();
 app.thot.chain!.authorizationState=async()=>{entered.resolve();await release.promise;return authorization();};
 const sweep=app.thot.sweepRetention();
 try{
  await within(entered.promise);
  assert.equal(await within(app.db.transaction(async tx=>{await tx.insert('thot_records','unrelated-wallet','other-owner',{kind:'wallet',address:'0x'+'2'.repeat(40)});return 'account-ready';})),'account-ready');
 }finally{release.resolve();await sweep;}
 const listing=await app.db.transaction(tx=>tx.get('thot_records',listingId));
 assert.ok(listing.release_deleted_at,'Unrelated rows do not invalidate this trace decision');
 assert.equal(listing.release_ref,undefined);
});

test('retention offer RPC releases the lock while preserving a paid copy',async t=>{
 const {app,ref}=await fixture(t),entered=deferred(),release=deferred();
 await app.db.transaction(tx=>tx.insert('thot_records','paid-intent','synthetic-buyer',{kind:'intent',listing_id:listingId,offer_id:'synthetic-paid-offer'}));
 app.thot.chain!.offer=async()=>{entered.resolve();await release.promise;return offer(3) as Awaited<ReturnType<ThotChain['offer']>>;};
 const sweep=app.thot.sweepRetention();
 try{await within(entered.promise);assert.equal(await within(app.db.transaction(async tx=>(await tx.get('traces',traceId)).owner_id)),demoUser.id);}
 finally{release.resolve();await sweep;}
 await assertRetained(app,ref);
});

test('concurrent funding, release, source and owner changes invalidate retention reads before deleting',async t=>{
 const cases:Array<[string,(tx:Transaction)=>Promise<unknown>]>=[
  ['new funding intent',tx=>tx.insert('thot_records','new-intent','synthetic-buyer',{kind:'intent',listing_id:listingId,offer_id:'synthetic-new-offer'})],
  ['new listing',async tx=>{const {id:_,...listing}=await tx.get('thot_records',listingId);await tx.insert('thot_records','new-listing',demoUser.id,listing);}],
  ['listing authorization revision',async tx=>{const listing=await tx.get('thot_records',listingId);listing.authorization.nonce='2';await tx.update('thot_records',listingId,listing);}],
  ['source deletion',async tx=>{const source=await tx.get('traces',traceId);source.deleted=true;await tx.update('traces',traceId,source);}],
  ['source owner revision',tx=>tx.sql.query('UPDATE traces SET owner_id=$2 WHERE id=$1',[traceId,'different-owner'])],
  ['new reserve selection',tx=>tx.insert('thot_records','new-selection',demoUser.id,{kind:'treasury_sample_selection',listing_id:listingId,release_hash:'synthetic-release-hash'})],
  ['new trade evidence',tx=>tx.insert('thot_records','new-evidence',demoUser.id,{kind:'trade_evidence',trace_id:traceId,revoked:false})],
 ];
 for(const [name,change] of cases)await t.test(name,async t=>{
  const {app,ref}=await fixture(t),entered=deferred(),release=deferred();
  app.thot.chain!.authorizationState=async()=>{entered.resolve();await release.promise;return authorization();};
  const sweep=app.thot.sweepRetention();
  try{await within(entered.promise);await within(app.db.transaction(change));}
  finally{release.resolve();await sweep;}
  await assertRetained(app,ref);
 });
});

test('RPC failure cannot delete a release or overwrite its retention accounting',async t=>{
 for(const stage of ['authorization','offer'])await t.test(stage,async t=>{
  const {app,ref}=await fixture(t);
  await app.db.transaction(async tx=>{
   const trace=await tx.get('traces',traceId);trace.source_private_objects_deleted=true;trace.thot_release_copies_retained=1;trace.private_objects_deleted=false;await tx.update('traces',traceId,trace);
   await tx.insert('thot_records','paid-intent','synthetic-buyer',{kind:'intent',listing_id:listingId,offer_id:'synthetic-paid-offer'});
  });
  if(stage==='authorization')app.thot.chain!.authorizationState=async()=>{throw Error('THOT_RPC_UNAVAILABLE');};
  else app.thot.chain!.offer=async()=>{throw Error('THOT_SNAPSHOT_CHANGED');};
  await assert.rejects(app.thot.sweepRetention(),/THOT_RPC_UNAVAILABLE|THOT_SNAPSHOT_CHANGED/);
  await assertRetained(app,ref);
  const trace=await app.db.transaction(tx=>tx.get('traces',traceId));assert.equal(trace.thot_release_copies_retained,1);assert.equal(trace.private_objects_deleted,false);
 });
});

test('each sweep rechecks chain state and retains obligations through the licensed window',async t=>{
 const {app,ref}=await fixture(t);let status=1,chainTime=timestamp,calls=0;
 await app.db.transaction(async tx=>{
  const trace=await tx.get('traces',traceId);trace.deleted=true;trace.source_private_objects_deleted=true;trace.thot_release_copies_retained=1;trace.private_objects_deleted=false;await tx.update('traces',traceId,trace);
  await tx.insert('thot_records','paid-intent','synthetic-buyer',{kind:'intent',listing_id:listingId,offer_id:'synthetic-paid-offer'});
 });
 app.thot.chain!.offer=async()=>{calls++;return {...offer(status),block:{...offer().block,timestamp:chainTime}} as Awaited<ReturnType<ThotChain['offer']>>;};
 for(status=1;status<=5;status++){await app.thot.sweepRetention();await assertRetained(app,ref);}
 assert.equal(calls,5,'No financial chain result is cached between sweeps');
 status=5;chainTime=timestamp+30*86400;
 await app.thot.sweepRetention();assert.equal(calls,6);
 const listing=await app.db.transaction(tx=>tx.get('thot_records',listingId));assert.ok(listing.release_deleted_at);assert.equal(listing.release_ref,undefined);
 const trace=await app.db.transaction(tx=>tx.get('traces',traceId));assert.equal(trace.private_objects_deleted,true);assert.equal(trace.thot_release_copies_retained,0);
});

test('a conflicting sweep leaves the current decision for the next fresh pass',async t=>{
 const {app,ref}=await fixture(t),entered=deferred(),release=deferred();let calls=0;
 app.thot.chain!.authorizationState=async()=>{calls++;entered.resolve();await release.promise;return authorization();};
 const sweep=app.thot.sweepRetention();
 try{
  await within(entered.promise);
  await within(app.db.transaction(async tx=>{const trace=await tx.get('traces',traceId);trace.updated_at=new Date(now).toISOString();await tx.update('traces',traceId,trace);}));
 }finally{release.resolve();await sweep;}
 await assertRetained(app,ref);assert.equal(calls,1);
 await app.thot.sweepRetention();assert.equal(calls,2);
 assert.ok((await app.db.transaction(tx=>tx.get('thot_records',listingId))).release_deleted_at);
});

test('wall-clock expiry during RPC preserves the copy until a fresh funded-state check',async t=>{
 for(const boundary of ['source retention','unsigned preparation'])await t.test(boundary,async t=>{
  const {app,ref}=await fixture(t),entered=deferred(),release=deferred();let currentTime=now,funded=false,calls=0;
  app.service.now=()=>new Date(currentTime).toISOString();
  app.thot.chain!.authorizationState=async()=>({...authorization(),revoked:false});
  await app.db.transaction(async tx=>{
   if(boundary==='source retention'){
    const trace=await tx.get('traces',traceId);trace.retention_expires_at=new Date(now+1000).toISOString();await tx.update('traces',traceId,trace);
   }else{
    const listing=await tx.get('thot_records',listingId);delete listing.signature;delete listing.authorization;listing.active=false;listing.created_at=new Date(now-15*60*1000+1000).toISOString();await tx.update('thot_records',listingId,listing);
   }
   await tx.insert('thot_records','existing-intent','synthetic-buyer',{kind:'intent',listing_id:listingId,offer_id:'synthetic-existing-offer'});
  });
  app.thot.chain!.offer=async()=>{
   calls++;const observed={...offer(funded?2:0),block:{...offer().block,timestamp:currentTime/1000}};
   entered.resolve();await release.promise;return observed as Awaited<ReturnType<ThotChain['offer']>>;
  };
  const sweep=app.thot.sweepRetention();
  try{
   await within(entered.promise);
   // Funding is external: neither the existing intent nor its DB revision changes.
   funded=true;currentTime=now+2000;
  }finally{release.resolve();await sweep;}
  await assertRetained(app,ref);assert.equal(calls,1);
  await app.thot.sweepRetention();await assertRetained(app,ref);assert.equal(calls,2);
 });
});

test('an early chain anchor that reorganizes during later reads cannot authorize cleanup',async t=>{
 const {app,ref}=await fixture(t),entered=deferred(),release=deferred();let calls=0,reorganized=false;
 await app.db.transaction(async tx=>{const {id:_,...listing}=await tx.get('thot_records',listingId);await tx.insert('thot_records','second-listing',demoUser.id,{...listing,authorization:{...listing.authorization,nonce:'2'}});});
 app.thot.chain!.authorizationState=async()=>{
  calls++;if(calls===1)return authorization();
  entered.resolve();await release.promise;return {...authorization(),block:{...authorization().block,number:101,hash:'0x'+'b'.repeat(64)}};
 };
 app.thot.chain!.assertSnapshot=async block=>{if(reorganized&&block.number===100)throw Error('THOT_SNAPSHOT_CHANGED');};
 const sweep=app.thot.sweepRetention(),failure=assert.rejects(sweep,/THOT_SNAPSHOT_CHANGED/);
 try{await within(entered.promise);reorganized=true;}
 finally{release.resolve();await failure;}
 await assertRetained(app,ref);
 assert.equal((await app.db.transaction(tx=>tx.get('thot_records','second-listing'))).release_deleted_at,undefined);
});

test('slow deletion cannot expire a later copy against earlier unfunded chain reads',async t=>{
 const {app,ref}=await fixture(t),entered=deferred(),release=deferred();let currentTime=now,funded=false;
 app.service.now=()=>new Date(currentTime).toISOString();
 const secondRef=await app.privacy.seal(demoUser.id,{content:{turns:[{role:'user',content:'Second synthetic retained release.'}]}});
 await app.db.transaction(async tx=>{
  const trace=await tx.get('traces',traceId);trace.retention_expires_at=new Date(now+1000).toISOString();await tx.update('traces',traceId,trace);
  const {id:_,...listing}=await tx.get('thot_records',listingId);
  await tx.insert('thot_records','second-listing',demoUser.id,{...listing,authorization:{...listing.authorization,nonce:'2'},release_ref:secondRef});
  await tx.insert('thot_records','second-intent','synthetic-buyer',{kind:'intent',listing_id:'second-listing',offer_id:'synthetic-second-offer'});
 });
 app.thot.chain!.authorizationState=async(_wallet,nonce)=>({...authorization(),revoked:nonce==='1'});
 app.thot.chain!.offer=async()=>offer(funded?2:0) as Awaited<ReturnType<ThotChain['offer']>>;
 const remove=app.privacy.remove.bind(app.privacy);
 app.privacy.remove=async(owner,object)=>{if(object.objectId===ref.objectId){entered.resolve();await release.promise;}return remove(owner,object);};
 const sweep=app.thot.sweepRetention();
 try{await within(entered.promise);currentTime=now+2000;funded=true;}
 finally{release.resolve();await sweep;}
 assert.ok((await app.db.transaction(tx=>tx.get('thot_records',listingId))).release_deleted_at);
 const second=await app.db.transaction(tx=>tx.get('thot_records','second-listing'));assert.equal(second.release_deleted_at,undefined);assert.deepEqual(second.release_ref,secondRef);
 assert.ok((await app.privacy.open(demoUser.id,secondRef)).content.turns.length);
 await app.thot.sweepRetention();assert.equal((await app.db.transaction(tx=>tx.get('thot_records','second-listing'))).release_deleted_at,undefined);
});
