import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {demoBuyer,demoUser} from '../packages/market/src/fixtures.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import type {ThotChain} from '../packages/chain/thot.ts';

test('signless old app reads a delivered licence but cannot acknowledge a pending one',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-readonly-delivery-'));
 const app=await createApplication({memory:true,dataDir:dir,readOnly:true});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const offerId='0x'+'a'.repeat(64),wallet='0x'+'1'.repeat(40);
 const release={content:{turns:[{role:'assistant',content:'synthetic licensed content'}]},license:'test licence'};
 const hash='0x'+canonicalHash(release).replace(/^sha256:/,'');
 const releaseRef=await app.privacy.seal(demoUser.id,release);
 let status=3,signingCalls=0;
 app.thot.chain={
  config:{reserve:'0x'+'4'.repeat(40),reserveCampaigns:false},
  offer:async()=>({status,buyer:wallet,seller:'0x'+'2'.repeat(40),gross:'1',seller_gross:'1',buyer_surcharge:'0',buyer_total:'1',license_hash:'0x'+'b'.repeat(64),evidence_hash:hash,delivery_hash:hash,accepted_at:1,dispute_seconds:3600,block:{timestamp:2,number:10}}),
  acknowledgeAvailability:async()=>{signingCalls++;},
 } as unknown as ThotChain;
 await app.db.transaction(async tx=>{
  await tx.insert('thot_records','wallet:'+demoBuyer.id,demoBuyer.id,{kind:'wallet',address:wallet});
  await tx.insert('thot_records','listing',demoUser.id,{kind:'listing',release_ref:releaseRef,retention_days:30});
  await tx.insert('thot_records','intent:'+offerId,demoBuyer.id,{kind:'intent',offer_id:offerId,listing_id:'listing',wallet,seller_wallet:'0x'+'2'.repeat(40),seller_id:demoUser.id,gross:'1',seller_gross:'1',buyer_surcharge:'0',buyer_total:'1',license_hash:'0x'+'b'.repeat(64),evidence_hash:hash});
 });
 const delivered=await app.thot.delivery(demoBuyer,offerId);
 assert.deepEqual(delivered.release,release);
 status=5;assert.deepEqual((await app.thot.delivery(demoBuyer,offerId)).release,release);
 status=2;
 await assert.rejects(app.thot.delivery(demoBuyer,offerId),/THOT_READ_ONLY/);
 assert.equal(signingCalls,0);
 assert.equal(await app.db.transaction(tx=>tx.maybe('thot_records','delivery:'+offerId)),undefined);
});

test('treasury deliveries are shared with current governors only, without expanding purchase or dispute authority',async t=>{
 const {ThotGovernance}=await import('../packages/market/src/thot-governance.ts');
 const dir=await mkdtemp(join(tmpdir(),'thot-shared-library-'));
 const app=await createApplication({memory:true,dataDir:dir,readOnly:true});
 const original=ThotGovernance.prototype.ownsTreasury,originalWorkspace=ThotGovernance.prototype.workspace;
 t.after(async()=>{ThotGovernance.prototype.ownsTreasury=original;ThotGovernance.prototype.workspace=originalWorkspace;await app.close();await rm(dir,{recursive:true,force:true});});
 const id='0x'+'a'.repeat(64),reserve='0x'+'4'.repeat(40),wallet='0x'+'1'.repeat(40);
 const release={content:{turns:[{role:'assistant',content:'synthetic treasury purchase'}]},license:'Treasury evaluation only',brokerage_evidence:{private_proof:'synthetic excluded proof'}};
 const hash='0x'+canonicalHash(release).replace(/^sha256:/,'');
 const ref=await app.privacy.seal(demoUser.id,release);
 let status=3,owner=true,checks=0,timestamp=2;
 ThotGovernance.prototype.ownsTreasury=async function(address){assert.equal(address,wallet);checks++;return owner;};
 ThotGovernance.prototype.workspace=async function(){return {owner} as Awaited<ReturnType<typeof originalWorkspace>>;};
 app.thot.chain={config:{reserve,reserveCampaigns:false,manualReserve:true},capabilities:()=>({}),isReserveBuyer:async()=>false,reserveState:async()=>({}),offer:async()=>({status,buyer:reserve,seller:'0x'+'2'.repeat(40),gross:'1',seller_gross:'1',buyer_surcharge:'0',buyer_total:'1',license_hash:'0x'+'b'.repeat(64),evidence_hash:hash,delivery_hash:hash,accepted_at:1,dispute_seconds:3600,block:{timestamp,number:10}})} as unknown as ThotChain;
 await app.db.transaction(async tx=>{
  await tx.insert('thot_records','wallet:'+demoBuyer.id,demoBuyer.id,{kind:'wallet',address:wallet});
  await tx.insert('thot_records','listing',demoUser.id,{kind:'listing',release_ref:ref,retention_days:30});
  await tx.insert('thot_records','intent:'+id,'another-purchaser',{kind:'intent',treasury:true,offer_id:id,listing_id:'listing',wallet:reserve,seller_wallet:'0x'+'2'.repeat(40),seller_id:demoUser.id,gross:'1',seller_gross:'1',buyer_surcharge:'0',buyer_total:'1',license_hash:'0x'+'b'.repeat(64),evidence_hash:hash});
 });
 const library=await app.thot.samplingWorkspace(demoBuyer);assert.equal(library.jobs.length,1);assert.equal(library.jobs[0].shared,true);assert.equal(library.jobs[0].resume_available,false);
 const result=await app.thot.delivery(demoBuyer,id);
 assert.deepEqual(result.release,{content:release.content,license:release.license});assert.equal(checks,2);
 owner=false;await assert.rejects(app.thot.delivery(demoBuyer,id),/NOT_FOUND/);await assert.rejects(app.thot.samplingWorkspace(demoBuyer),/RESERVE_BUYER_OR_GOVERNANCE_OWNER_REQUIRED/);
 owner=true;status=2;assert.equal((await app.thot.samplingWorkspace(demoBuyer)).jobs.length,0);await assert.rejects(app.thot.delivery(demoBuyer,id),/DELIVERY_NOT_AUTHORIZED/);
 status=3;timestamp=1+30*86400;await assert.rejects(app.thot.delivery(demoBuyer,id),/LICENSE_RETENTION_EXPIRED/);
 timestamp=2;
 await assert.rejects(app.thot.reviewOffer(demoBuyer,id),/NOT_FOUND/);
 await app.db.transaction(async tx=>{const i=await tx.get('thot_records','intent:'+id);i.treasury=false;await tx.update('thot_records',i.id,i);});
 await assert.rejects(app.thot.delivery(demoBuyer,id),/NOT_FOUND/);
});
