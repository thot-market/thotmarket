import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {TraceQc} from '../packages/market/src/trace-qc.ts';
import {enqueueTraceQc,QC_EVENT,QC_DISCOVERY_LIMIT,qcVersion} from '../packages/market/src/trace-qc-state.ts';
import {runTraceQc} from '../packages/qc/index.ts';
import {startWorkerLoop} from '../apps/worker/main.ts';

const owner={id:'demo-user',role:'user' as const},other={id:'other-user',role:'user' as const};
type App=Awaited<ReturnType<typeof createApplication>>;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t:any,persist=false){
  const dir=await mkdtemp(join(tmpdir(),'thot-auto-qc-'));let app=await createApplication({memory:!persist,dataDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {get app(){return app;},restart:async()=>{await app.close();app=await createApplication({memory:!persist,dataDir:dir});return app;}};
}
async function saved(app:App,suffix='automatic'){
  const input={filename:'synthetic.jsonl',text:[{type:'user',message:{role:'user',content:'Synthetic AUTO_PRIVATE_MARKER '+suffix}},{type:'assistant',message:{role:'assistant',content:'Bound the cache and verify expiration.'}}].map(row=>JSON.stringify(row)).join('\n')};
  return app.portfolio.import(owner,randomUUID(),{...input,content_commitment:app.portfolio.preview(owner,input).content_commitment,save_privately:true});
}
const jobs=async(app:App)=>(await app.db.query('SELECT * FROM outbox_events WHERE event_type=$1 ORDER BY id',[QC_EVENT])).rows;
const due=async(app:App)=>app.db.transaction(async tx=>{await tx.sql.query("UPDATE outbox_events SET available_at=now()-interval '1 second' WHERE event_type=$1 AND status='pending'",[QC_EVENT]);});

test('upload queues metadata only, survives application restart, completes without browser and restores cache',async t=>{
  const f=await fixture(t,true);let app=f.app,evaluations=0;
  (app.qc as any).evaluate=()=>{evaluations++;throw new Error('must not run during upload');};
  const trace=await saved(app);assert.equal(evaluations,0);
  assert.equal((await jobs(app)).length,1);assert.deepEqual(Object.keys((await jobs(app))[0]!.payload).sort(),['policy_version','scope','source_version','trace_id']);
  assert.doesNotMatch(JSON.stringify(await jobs(app)),/AUTO_PRIVATE_MARKER|objectId|content|turns/);
  assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,'queued');
  assert.equal((await app.library.list(owner)).items[0]!.quality_check.state,'queued');
  await assert.rejects(app.qc.get(other,trace.trace_id),/NOT_FOUND/);
  app=await f.restart();assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,'queued');
  (app.qc as any).evaluate=(...args:Parameters<typeof runTraceQc>)=>{evaluations++;return runTraceQc(...args);};
  assert.equal((await app.qc.processPending()).processed,1);
  const result=await app.qc.get(owner,trace.trace_id);assert.equal(result.status,'complete');assert.equal(result.automation.state,'complete');assert.equal(result.automation.outcome,result.report!.status);
  assert.equal((await app.library.list(owner)).items[0]!.quality_check.recordings_checked,1);
  await app.qc.processPending();assert.equal(evaluations,1);
  await assert.rejects(app.qc.retry(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_RETRY_UNAVAILABLE/);
  // Retained pre-automation reports get their compact status backfilled, with no reevaluation.
  await app.db.transaction(async tx=>{const source=await tx.get('traces',trace.trace_id);delete source.quality_checks;await tx.update('traces',trace.trace_id,source);await tx.sql.query('DELETE FROM outbox_events WHERE event_type=$1',[QC_EVENT]);});
  const fresh=new TraceQc(app.service,{evaluate:()=>{throw new Error('cached report must be reused');}});await fresh.processPending();
  assert.equal((await app.library.list(owner)).items[0]!.quality_check.state,'complete');assert.equal((await fresh.get(owner,trace.trace_id)).report_digest,result.report_digest);
  // A cached-branch race must never enter evaluation for a replacement checkpoint.
  const transaction=app.db.transaction.bind(app.db);let replaced=false;
  app.db.transaction=async(work,label)=>{const value=await transaction(work,label);if(!replaced&&(value as any)?.source?.trace?.trace_id===trace.trace_id&&(value as any)?.existing){replaced=true;await transaction(async tx=>{const current=await tx.get('traces',trace.trace_id);current.capture_state='RECORDING';await tx.update('traces',trace.trace_id,current);});}return value;};
  await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_SOURCE_CHANGED/);app.db.transaction=transaction;assert.equal(evaluations,1);

});

test('operational failures have bounded automatic and explicit retries; adverse quality is terminal',async t=>{
  const {app}=await fixture(t),trace=await saved(app);let evaluations=0;
  (app.qc as any).evaluate=()=>{evaluations++;throw new Error('AUTO_PRIVATE_MARKER must not be persisted');};
  for(let cycle=0;cycle<4;cycle++){
    for(let attempt=0;attempt<3;attempt++){await due(app);await app.qc.processPending();assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,attempt===2?'failed':'queued');}
    const status=(await app.qc.get(owner,trace.trace_id)).automation;assert.equal(status.outcome,null);assert.equal(status.retryable,cycle<3);assert.equal(status.reason_code,'QC_EXECUTION_FAILED');
    await app.qc.processPending();assert.equal(evaluations,(cycle+1)*3);
    await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_RETRY_UNAVAILABLE/);assert.equal(evaluations,(cycle+1)*3);
    if(cycle<3){await assert.rejects(app.qc.retry(other,randomUUID(),trace.trace_id,{scope:'private'}),/NOT_FOUND/);const key=randomUUID();assert.equal((await app.qc.retry(owner,key,trace.trace_id,{scope:'private'})).automation.state,'queued');await app.qc.retry(owner,key,trace.trace_id,{scope:'private'});}
  }
  await assert.rejects(app.qc.retry(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_RETRY_UNAVAILABLE/);
  assert.equal((await jobs(app)).length,1);assert.doesNotMatch(JSON.stringify(await jobs(app)),/AUTO_PRIVATE_MARKER/);
  const manual=await saved(app,'manual-budget');await assert.rejects(app.qc.run(owner,randomUUID(),manual.trace_id,{scope:'private'}),/QC_EXECUTION_FAILED/);assert.equal((await app.qc.get(owner,manual.trace_id)).automation.attempts,1);
  await assert.rejects(app.qc.run(owner,randomUUID(),manual.trace_id,{scope:'private'}),/QC_RETRY_UNAVAILABLE/);
  const rejected=await saved(app,'unanswered'),ref=await app.privacy.seal(owner.id,{turns:[{role:'user',content:'Only an unanswered request.'}]});
  await app.db.transaction(async tx=>{const source=await tx.get('traces',rejected.trace_id);source.raw_ref=ref;await tx.update('traces',source.trace_id,source);await enqueueTraceQc(tx,source,app.service.now());});
  (app.qc as any).evaluate=runTraceQc;await app.qc.processPending();const result=await app.qc.get(owner,rejected.trace_id);assert.equal(result.automation.state,'complete');assert.notEqual(result.report!.status,'pass');assert.equal(result.automation.retryable,false);
});

test('source coverage replacement and deletion fence in-flight jobs without publishing obsolete results',async t=>{
  const {app}=await fixture(t),trace=await saved(app),entered=deferred(),release=deferred(),open=app.privacy.open.bind(app.privacy);
  const initial=await app.db.transaction(tx=>tx.get('traces',trace.trace_id));
  app.privacy.open=async(owner,ref)=>{if(ref.objectId===initial.raw_ref.objectId){entered.resolve();await release.promise;}return open(owner,ref);};
  const pending=app.qc.processPending(1);await entered.promise;
  const beforeVersion=qcVersion(initial,'private');
  await app.db.transaction(async tx=>{const source=await tx.get('traces',trace.trace_id);source.capture_state='INTERRUPTED';source.projection={status:'PARTIAL'};await tx.update('traces',source.trace_id,source);await enqueueTraceQc(tx,source,app.service.now());});
  assert.equal((await jobs(app)).length,1);release.resolve();await pending;app.privacy.open=open;
  assert.equal((await app.db.query('SELECT id FROM trace_qc_runs')).rows.length,0);
  assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,'queued');await app.qc.processPending();
  const result=await app.qc.get(owner,trace.trace_id);assert.notEqual(result.selected_source.source_version,beforeVersion);assert.equal(result.selected_source.coverage.status,'incomplete');
  assert.equal((await app.library.list(owner)).items[0]!.quality_check.recordings_attention,1);
  const gone=await saved(app,'deleted'),goneSource=await app.db.transaction(tx=>tx.get('traces',gone.trace_id)),enteredDelete=deferred(),releaseDelete=deferred();
  app.privacy.open=async(owner,ref)=>{if(ref.objectId===goneSource.raw_ref.objectId){enteredDelete.resolve();await releaseDelete.promise;}return open(owner,ref);};
  const deleting=app.qc.processPending(1);await enteredDelete.promise;
  await app.db.transaction(async tx=>{const source=await tx.get('traces',gone.trace_id);source.deleted=true;await tx.update('traces',source.trace_id,source);});
  releaseDelete.resolve();await deleting;app.privacy.open=open;
  assert.equal((await app.db.query("SELECT id FROM trace_qc_runs WHERE document->>'trace_id'=$1",[gone.trace_id])).rows.length,0);
  await assert.rejects(app.qc.get(owner,gone.trace_id),/TRACE_CONTENT_UNAVAILABLE/);
});

test('expired claims cannot publish or regress a replacement result, and orphaned report writes are reclaimable',async t=>{
  const {app}=await fixture(t),trace=await saved(app),entered=deferred(),release=deferred(),seal=app.privacy.seal.bind(app.privacy);let writes=0;
  app.privacy.seal=async(owner,value,id)=>{const ref=await seal(owner,value,id);if((value as any)?.schema_version==='trace-qc/v1'&&++writes===1){entered.resolve();await release.promise;}return ref;};
  const first=app.qc.processPending(1);await entered.promise;
  assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,'running');
  await app.db.transaction(async tx=>{await tx.sql.query("UPDATE outbox_events SET available_at=now()-interval '1 second' WHERE event_type=$1 AND status='processing'",[QC_EVENT]);});
  const replacement=new TraceQc(app.service);await replacement.processPending(1);
  const report=await replacement.get(owner,trace.trace_id);assert.equal(report.automation.state,'complete');
  release.resolve();await first;app.privacy.seal=seal;
  assert.equal((await app.qc.get(owner,trace.trace_id)).report_digest,report.report_digest);assert.equal((await jobs(app))[0]!.status,'done');assert.equal((await app.db.query('SELECT id FROM trace_qc_runs')).rows.length,1);
  assert.equal((await app.service.staged.cleanup()).removed,1);
  // A crash between report commit and job acknowledgement must preserve completion.
  await app.db.transaction(async tx=>{await tx.sql.query("UPDATE outbox_events SET status='processing',claim_token='expired-fixture',available_at=now()-interval '1 second' WHERE event_type=$1",[QC_EVENT]);});
  await replacement.processPending();assert.equal((await jobs(app))[0]!.status,'done');assert.equal((await replacement.get(owner,trace.trace_id)).automation.state,'complete');
});

test('bounded discovery persists its cursor past ineligible pages and skips live checkpoints',async t=>{
  const {app}=await fixture(t),trace=await saved(app),source=await app.db.transaction(tx=>tx.get('traces',trace.trace_id));
  await app.db.transaction(async tx=>{
    await tx.sql.query('DELETE FROM outbox_events WHERE event_type=$1',[QC_EVENT]);delete source.quality_checks;source.capture_state='RECORDING';source.projection={status:'READY'};await tx.update('traces',source.trace_id,source);
    for(let i=0;i<QC_DISCOVERY_LIMIT;i++){const id='000-ineligible-'+String(i).padStart(3,'0');await tx.insert('traces',id,owner.id,{...source,trace_id:id,deleted:true});}
    await tx.insert('traces','zzz-terminal',owner.id,{...source,trace_id:'zzz-terminal',capture_state:'COMPLETED'});
  });
  await new TraceQc(app.service).processPending();assert.equal((await jobs(app)).length,0);
  const cursor=await app.db.transaction(tx=>tx.get('thot_records','trace-qc:discovery:v1'));assert.notEqual(cursor.cursor,'');assert.equal(cursor.kind,'trace_qc_discovery');
  await new TraceQc(app.service).processPending();assert.equal((await app.qc.get(owner,'zzz-terminal')).automation.state,'complete');assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,'preparing');await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_SOURCE_PREPARING/);
  // Finalizing identical retained bytes must still schedule this source version.
  await app.db.transaction(async tx=>{const current=await tx.get('traces',trace.trace_id);current.capture_state='COMPLETED';await tx.update('traces',trace.trace_id,current);await enqueueTraceQc(tx,current,app.service.now());await enqueueTraceQc(tx,current,app.service.now());});
  assert.equal((await jobs(app)).filter(job=>job.payload.trace_id===trace.trace_id).length,1);await app.qc.processPending();assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,'complete');
});

test('QC lane runs during unresolved chain retention, while slow QC I/O leaves settlement free and shutdown drains it',async t=>{
  const {app}=await fixture(t),trace=await saved(app),chainEntered=deferred(),releaseChain=deferred(),qcDone=deferred();
  let loop=startWorkerLoop({inference:{sweep:async()=>{}},service:{sweepRetention:async()=>{},runWorker:async()=>{}},thot:{sweepRetention:async()=>{chainEntered.resolve();await releaseChain.promise;}},qc:{processPending:async limit=>{const result=await app.qc.processPending(limit);qcDone.resolve();return result;}}},{intervalMs:5});
  try{await Promise.all([chainEntered.promise,qcDone.promise]);assert.equal((await app.qc.get(owner,trace.trace_id)).automation.state,'complete');}finally{releaseChain.resolve();await loop.close();}
  const slow=await saved(app,'slow'),source=await app.db.transaction(tx=>tx.get('traces',slow.trace_id)),open=app.privacy.open.bind(app.privacy),qcEntered=deferred(),releaseQc=deferred(),sale=deferred();let sales=0,closed=false;
  app.privacy.open=async(owner,ref)=>{if(ref.objectId===source.raw_ref.objectId){qcEntered.resolve();await releaseQc.promise;}return open(owner,ref);};
  loop=startWorkerLoop({inference:{sweep:async()=>{}},service:{sweepRetention:async()=>{},runWorker:async()=>{}},thot:{sweepRetention:async()=>{},processSales:async()=>{await app.db.transaction(async tx=>{await tx.sql.query('SELECT 1');});sales++;if(sales>1)sale.resolve();}},qc:app.qc},{intervalMs:5});
  try{await qcEntered.promise;await sale.promise;assert(sales>1);const closing=loop.close().then(()=>{closed=true;});await wait(15);assert.equal(closed,false);releaseQc.resolve();await closing;assert.equal((await app.qc.get(owner,slow.trace_id)).automation.state,'complete');}finally{releaseQc.resolve();app.privacy.open=open;await loop.close();}
});
