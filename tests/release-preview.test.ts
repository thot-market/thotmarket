import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {ThotMarketplace} from '../packages/market/src/thot-market.ts';
import {RELEASE_PREVIEW_LIMITS} from '../packages/market/src/release-preview.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';

const owner={id:'demo-user',role:'user' as const},other={id:'other-user',role:'user' as const};
async function fixture(t:any){
  const dir=await mkdtemp(join(tmpdir(),'thot-release-preview-')),app=await createApplication({dataDir:dir,memory:true});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return app;
}
const text=(suffix='')=>[
  {type:'user',message:{role:'user',content:'Explain the synthetic queue '+suffix}},
  {type:'assistant',message:{role:'assistant',content:'Use a bounded queue and test cancellation.'}},
  {type:'user',message:{role:'user',content:'Omit this private context from the release.'}},
  {type:'assistant',message:{role:'assistant',content:'Retain the useful final answer.'}},
].map(row=>JSON.stringify(row)).join('\n');
async function imported(app:Awaited<ReturnType<typeof createApplication>>,options:any={}){
  const input={text:text(options.suffix),filename:'synthetic.jsonl'},preview=app.portfolio.preview(owner,input);
  return app.portfolio.import(owner,randomUUID(),{...input,content_commitment:preview.content_commitment,
    ...(options.private?{save_privately:true}:{rights_confirmed:true,model_output_licensed:options.output!==false})});
}
const exclusion=(preview:any,indices=[2])=>({trace_id:preview.trace_id,content_hash:preview.content_hash,excluded_turns:indices,rights_confirmed:true,model_output_licensed:true});

test('release preview is owner-only, exact scrubbed content with the listing commitment',async t=>{
  const app=await fixture(t),saved=await imported(app),preview=await app.releasePreview.preview(owner,{trace_id:saved.trace_id});
  assert.equal(preview.content_hash,'0x'+canonicalHash(preview.content));
  assert.equal(preview.content_hash,(await app.thot.listingMetadata(owner,saved.trace_id)).content_hash);
  assert.equal(preview.provenance_status,'IMPORTED_UNVERIFIED');assert.equal(preview.sale_eligibility.can_list,true);
  assert.equal(preview.exclusion.supported,true);assert.equal(preview.metrics.turns,4);
  await assert.rejects(app.releasePreview.preview(other,{trace_id:saved.trace_id}),/NOT_FOUND/);
  await assert.rejects(app.releasePreview.preview({id:owner.id,role:'operator_security'},{trace_id:saved.trace_id}),/FORBIDDEN/);
  await assert.rejects(app.releasePreview.exclude(other,randomUUID(),exclusion(preview)),/NOT_FOUND/);
  await assert.rejects(app.releasePreview.preview(owner,{trace_id:saved.trace_id,raw:true}),/INVALID_RELEASE_PREVIEW/);
});

test('message exclusion reseals and reassesses the actual listed release, preserves raw source, rejects stale review',async t=>{
  const app=await fixture(t),saved=await imported(app),before=await app.releasePreview.preview(owner,{trace_id:saved.trace_id});
  const original=await app.db.transaction(tx=>tx.get('traces',saved.trace_id,owner.id));
  const qualityJobs=()=>app.db.query("SELECT id,owner_id,payload,status FROM outbox_events WHERE event_type='CheckTraceQuality' AND payload->>'trace_id'=$1 ORDER BY payload->>'scope'",[saved.trace_id]);
  const originalJobs=(await qualityJobs()).rows;assert.deepEqual(originalJobs.map(job=>job.payload.scope),['private','release']);
  const key=randomUUID(),input=exclusion(before),after=await app.releasePreview.exclude(owner,key,input);
  assert.deepEqual(after.content.turns,before.content.turns.filter((_:unknown,i:number)=>i!==2));
  assert.notEqual(after.content_hash,before.content_hash);assert.equal(after.release_revision,1);
  assert.equal(after.sale_eligibility.can_list,true);assert.equal(after.provenance_status,'IMPORTED_UNVERIFIED');
  const current=await app.db.transaction(tx=>tx.get('traces',saved.trace_id,owner.id));
  assert.equal(current.thot_listing_only,true);assert.notEqual(current.rights_id,original.rights_id);assert.notEqual(current.scrub_id,original.scrub_id);
  assert.equal(current.import_content_hash,original.import_content_hash);assert.deepEqual(current.raw_ref,original.raw_ref);
  const editedJobs=(await qualityJobs()).rows;assert.deepEqual(editedJobs.map(job=>job.payload.scope),['private','release']);
  assert.equal(editedJobs[0].id,originalJobs[0].id,'Release edits preserve private-source QC.');
  assert.notEqual(editedJobs[1].id,originalJobs[1].id,'Only the current release revision remains queued.');
  assert.equal(editedJobs[1].owner_id,owner.id);assert.equal(editedJobs[1].status,'pending');
  assert.equal(editedJobs[1].payload.source_version,current.quality_checks.release.source_version);
  assert.match(JSON.stringify(await app.privacy.open(owner.id,current.raw_ref)),/private context/);
  assert.equal(JSON.stringify(after.content).includes('private context'),false);
  assert.equal((await app.releasePreview.exclude(owner,key,input)).release_revision,1,'retry does not remove another indexed message');
  assert.deepEqual((await qualityJobs()).rows,editedJobs,'Idempotent exclusion keeps one job per scope.');
  await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),input),/RELEASE_CHANGED/);
  const stored=JSON.stringify((await app.db.query('SELECT response FROM idempotency_keys WHERE actor_id=$1 AND key=$2',[owner.id,key])).rows);
  assert.equal(stored.includes('bounded queue'),false);assert.equal(stored.includes('private context'),false);
  const audit=JSON.stringify((await app.db.query('SELECT payload FROM audit_events')).rows);assert.equal(audit.includes('private context'),false);

  // Exercise the real listing constructor with a read-only synthetic quote. No
  // chain transaction is sent: its encrypted artifact must use this exact view.
  const address='0x1111111111111111111111111111111111111111';
  const chain:any={publicChain:()=>false,market:{costQuote:async(price:bigint)=>({sellerAmount:price*9n/10n})},
    snapshot:async()=>({timestamp:Math.floor(Date.now()/1000)}),config:{reserve:address},
    authorizationDomain:()=>({name:'ThotMarket',version:'1',chainId:31337,verifyingContract:address})};
  const market=new ThotMarketplace(app.service,chain);
  await app.db.transaction(tx=>tx.insert('thot_records','wallet:'+owner.id,owner.id,{kind:'wallet',address}));
  const listing={trace_id:saved.trace_id,title:'Synthetic edited release',license:'Synthetic research evaluation license with no onward transfer.',price_thot:'10',
    rights_confirmed:true,metadata_public:true,automatic_sales:true,content_hash:before.content_hash};
  await assert.rejects(market.listTrace(owner,randomUUID(),listing),/RELEASE_CHANGED/);
  const listed=await market.listTrace(owner,randomUUID(),{...listing,content_hash:after.content_hash});
  const row=await app.db.transaction(tx=>tx.get('thot_records',listed.id,owner.id)),release=await app.privacy.open(owner.id,row.release_ref);
  assert.deepEqual(release.content,after.content);assert.equal(row.evidence_hash,'0x'+canonicalHash(release));
  assert.equal(row.release_content_hash,after.content_hash);assert.equal(row.turn_count,3);
  const frozen=canonicalHash(release);
  await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),exclusion(after,[0])),/RELEASE_ALREADY_COMMITTED/);
  assert.equal(canonicalHash(await app.privacy.open(owner.id,row.release_ref)),frozen);
  market.chain=undefined;
  assert.equal((await market.workspace(owner)).own_listings[0].trace_id,saved.trace_id);
  assert.equal((await market.workspace(other)).own_listings.length,0);
  await app.db.transaction(async tx=>{row.active=true;await tx.update('thot_records',row.id,row);});
  assert.equal('trace_id' in (await market.catalog(other)).listings[0],false,'private mapping is not public metadata');
});

test('exclusion rejects invalid indices and cannot restore unlicensed assistant content',async t=>{
  const app=await fixture(t),saved=await imported(app,{output:false}),before=await app.releasePreview.preview(owner,{trace_id:saved.trace_id});
  assert.equal(before.content.turns.length,2);assert(before.content.turns.every((turn:any)=>turn.role!=='assistant'));
  for(const indices of [[],[0,0],[-1],[0.5],[2],[0,1]])await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),exclusion(before,indices)),/INVALID_RELEASE_EXCLUSION/);
  await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),{...exclusion(before,[0]),rights_confirmed:false}),/IMPORT_RIGHTS_CONFIRMATION_REQUIRED/);
  const after=await app.releasePreview.exclude(owner,randomUUID(),exclusion(before,[1]));
  assert.equal(after.content.turns.length,1);assert.equal(after.content.turns[0].role,'user');
  assert.equal(JSON.stringify(after.content).includes('final answer'),false);
});

test('private, captured and already committed imports cannot be edited into a newly authorized release',async t=>{
  const app=await fixture(t),privateSaved=await imported(app,{private:true}),preview=await app.releasePreview.preview(owner,{trace_id:privateSaved.trace_id});
  assert.equal(preview.sale_eligibility.can_list,false);assert.equal(preview.exclusion.reason_code,'RELEASE_NOT_READY');
  await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),exclusion(preview,[0])),/RELEASE_NOT_READY/);
  for(const table of ['mandate_candidates','sale_authorizations','licenses']){
    const saved=await imported(app,{suffix:table}),before=await app.releasePreview.preview(owner,{trace_id:saved.trace_id});
    await app.db.transaction(tx=>tx.insert(table,randomUUID(),owner.id,{trace_id:saved.trace_id}));
    assert.equal((await app.releasePreview.preview(owner,{trace_id:saved.trace_id})).exclusion.reason_code,'RELEASE_ALREADY_COMMITTED');
    await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),exclusion(before)),/RELEASE_ALREADY_COMMITTED/);
  }
  const captured=await imported(app,{suffix:'captured'});
  await app.db.transaction(async tx=>{const trace=await tx.get('traces',captured.trace_id,owner.id);trace.agent_capture_id='synthetic-capture';await tx.update('traces',trace.trace_id,trace);});
  assert.equal((await app.releasePreview.preview(owner,{trace_id:captured.trace_id})).exclusion.reason_code,'EXCLUSION_IMPORT_ONLY');
});

test('a listing committed during exclusion staging fences the edit and preserves the release',async t=>{
  const app=await fixture(t),saved=await imported(app),before=await app.releasePreview.preview(owner,{trace_id:saved.trace_id});
  const assess=app.privacy.assess.bind(app.privacy);
  app.privacy.assess=async(...args:Parameters<typeof assess>)=>{
    const result=await assess(...args);
    await app.db.transaction(tx=>tx.insert('thot_records','synthetic-racing-listing',owner.id,{kind:'listing',trace_id:saved.trace_id,active:false}));
    return result;
  };
  await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),exclusion(before)),/RELEASE_ALREADY_COMMITTED/);
  assert.equal((await app.releasePreview.preview(owner,{trace_id:saved.trace_id})).content_hash,before.content_hash);
  await app.service.staged.cleanup();
});

test('bounded preview refuses oversized data and rechecks deletion after encrypted reads',async t=>{
  const app=await fixture(t),saved=await imported(app);
  const open=app.privacy.open.bind(app.privacy);
  app.privacy.open=async()=>({turns:Array.from({length:RELEASE_PREVIEW_LIMITS.max_turns+1},()=>({role:'user',content:'x'}))});
  await assert.rejects(app.releasePreview.preview(owner,{trace_id:saved.trace_id}),/RELEASE_PREVIEW_LIMIT/);
  app.privacy.open=async()=>({turns:[{role:'user',content:'x'.repeat(RELEASE_PREVIEW_LIMITS.max_bytes)}]});
  await assert.rejects(app.releasePreview.preview(owner,{trace_id:saved.trace_id}),/RELEASE_PREVIEW_LIMIT/);
  app.privacy.open=async(...args:Parameters<typeof open>)=>{
    const content=await open(...args);
    await app.db.transaction(async tx=>{const trace=await tx.get('traces',saved.trace_id,owner.id);trace.deleted=true;await tx.update('traces',trace.trace_id,trace);});
    return content;
  };
  await assert.rejects(app.releasePreview.preview(owner,{trace_id:saved.trace_id}),/TRACE_CONTENT_UNAVAILABLE/);
});
