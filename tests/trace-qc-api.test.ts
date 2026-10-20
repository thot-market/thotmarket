import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {TraceQc,TRACE_QC_STORAGE_LIMITS} from '../packages/market/src/trace-qc.ts';
import {contentDigest,runTraceQc} from '../packages/qc/index.ts';
import type {Document} from '../packages/storage/src/index.ts';

const owner={id:'demo-user',role:'user' as const},other={id:'other-user',role:'user' as const};
const operator={id:'operator',role:'operator_security' as const};
type App=Awaited<ReturnType<typeof createApplication>>;
async function fixture(t:any){
  const dir=await mkdtemp(join(tmpdir(),'thot-qc-')),app=await createApplication({memory:true,dataDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return app;
}
async function saved(app:App,options:{suffix?:string;private?:boolean;output?:boolean;actor?:typeof owner}={}){
  const actor=options.actor??owner,input={filename:'synthetic.jsonl',text:[
    {type:'user',message:{role:'user',content:'Review the synthetic cache '+(options.suffix??'PRIVATE_SOURCE_SENTINEL')}},
    {type:'assistant',message:{role:'assistant',content:'Bound its capacity and test expiration. ASSISTANT_PRIVATE_SENTINEL'}},
  ].map(row=>JSON.stringify(row)).join('\n')},preview=app.portfolio.preview(actor,input);
  return app.portfolio.import(actor,randomUUID(),{...input,content_commitment:preview.content_commitment,...(options.private?{save_privately:true}:{rights_confirmed:true,model_output_licensed:options.output!==false})});
}
async function replaceSource(app:App,id:string,content:Document){
  const ref=await app.privacy.seal(owner.id,content);
  await app.db.transaction(async tx=>{
    const trace=await tx.get('traces',id,owner.id);trace.projection_refs=[...(trace.projection_refs??[]),trace.raw_ref];trace.raw_ref=ref;
    await tx.update('traces',id,trace);
  });
}
async function rows(app:App,table:string){return (await app.db.query('SELECT * FROM '+table+' ORDER BY '+(table==='idempotency_keys'?'actor_id,key':'id'))).rows;}

test('owner QC HTTP routes reject foreign traces, operators and unbounded inputs without content logs',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true}),foreign=await saved(app,{actor:other,suffix:'foreign'}),logs:Document[]=[];
  const server=createHttpServer(app,{log:entry=>logs.push(entry)});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address();assert(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  const call=async(path:string,token='',body?:Document)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
  };
  const user=(await call('/v1/dev/session','',{role:'user'})).body.token,admin=(await call('/v1/dev/session','',{role:'operator_security'})).body.token;
  const path='/v1/contributor/library/'+trace.trace_id+'/qc';
  assert.equal((await call(path)).status,401);assert.equal((await call(path,admin)).status,403);
  assert.equal((await call(path,admin,{scope:'private'})).status,403);
  assert.equal((await call('/v1/contributor/library/'+foreign.trace_id+'/qc',user)).status,404);
  assert.equal((await call(path+'?scope=private&scope=release',user)).status,400);
  assert.equal((await call(path+'?scope=other',user)).status,400);
  assert.equal((await call(path+'?owner_id=other-user',user)).status,400);
  assert.equal((await call(path,user,{scope:'private',provider:'PRIVATE_PROVIDER_SENTINEL'})).status,400);
  assert.equal((await call(path,user,{scope:'release'})).body.error,'QC_RELEASE_UNAVAILABLE');
  assert.equal((await call(path,user)).body.status,'not_run');
  const result=await call(path,user,{scope:'private'});assert.equal(result.status,200);assert.equal(result.cache,'no-store');
  assert.equal(result.body.status,'complete');assert.equal(result.body.selected_source.trace_id,trace.trace_id);
  assert.equal(result.body.report.semantic.status,'not_run');assert.equal(result.body.report_digest,contentDigest(result.body.report));
  const reviewed=await call(path+'/review',user,{scope:'private',report_digest:result.body.report_digest,source_version:result.body.selected_source.source_version,decision:'unsure',feedback:['unclear']});
  assert.equal(reviewed.status,200);assert.equal(reviewed.body.review.unverified,true);
  assert.equal((await call(path+'/review',admin,{scope:'private',report_digest:result.body.report_digest,source_version:result.body.selected_source.source_version,decision:'agree',feedback:[]})).status,403);
  assert.equal((await call(path+'/review',user,{scope:'private',report_digest:result.body.report_digest,source_version:result.body.selected_source.source_version,decision:'agree',feedback:['PRIVATE_FEEDBACK_SENTINEL']})).status,400);
  assert.equal((await call(path+'/review',user,{scope:'private',report_digest:result.body.report_digest,source_version:result.body.selected_source.source_version,decision:'agree',feedback:[],notes:'PRIVATE_NOTES_SENTINEL'})).status,400);
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_SOURCE_SENTINEL|ASSISTANT_PRIVATE_SENTINEL|PRIVATE_PROVIDER_SENTINEL|PRIVATE_FEEDBACK_SENTINEL|PRIVATE_NOTES_SENTINEL/);
});

test('private and release reports are exact scoped cached results with encrypted separate human review and no money effects',async t=>{
  const app=await fixture(t),trace=await saved(app,{output:false});
  const before=await app.db.transaction(tx=>tx.get('traces',trace.trace_id,owner.id)),moneyTables=['thot_records','licenses','sale_authorizations','contributor_entitlements','ledger_transactions'];
  const moneyBefore=await Promise.all(moneyTables.map(table=>rows(app,table)));
  let evaluations=0;const qc=new TraceQc(app.service,{evaluate:(...args)=>{evaluations++;return runTraceQc(...args);}});
  const key=randomUUID(),privateReport=await qc.run(owner,key,trace.trace_id,{scope:'private'});
  assert.equal(privateReport.cached,false);assert.equal(privateReport.report!.coverage.total_turns,2);
  assert.equal(privateReport.selected_source.content_hash,contentDigest(await app.privacy.open(owner.id,before.raw_ref)));
  assert.equal((await qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'})).cached,true);
  assert.equal((await qc.run(owner,key,trace.trace_id,{scope:'private'})).report_digest,privateReport.report_digest);
  assert.equal(evaluations,1);assert.equal((await rows(app,'trace_qc_runs')).length,1);
  const released=await qc.run(owner,randomUUID(),trace.trace_id,{scope:'release'});
  assert.equal(released.report!.coverage.total_turns,1);assert.notEqual(released.report_digest,privateReport.report_digest);
  assert.equal(released.selected_source.content_hash,before.normalized_hash);
  assert.notEqual(released.selected_source.content_hash,privateReport.selected_source.content_hash);
  const review={scope:'private',report_digest:privateReport.report_digest,source_version:privateReport.selected_source.source_version,decision:'disagree',feedback:['false_positive']},reviewKey=randomUUID();
  const reviewed=await qc.review(owner,reviewKey,trace.trace_id,review);
  assert.equal(reviewed.review.decision,'disagree');assert.equal(reviewed.review.unverified,true);assert.deepEqual(reviewed.report,privateReport.report);
  await qc.review(owner,reviewKey,trace.trace_id,review);assert.equal((await rows(app,'trace_qc_reviews')).length,1);
  assert.equal((await qc.get(owner,trace.trace_id,{scope:'release'})).review,null);
  assert.deepEqual(await Promise.all(moneyTables.map(table=>rows(app,table))),moneyBefore);
  const after=await app.db.transaction(tx=>tx.get('traces',trace.trace_id,owner.id));delete before.quality_checks;delete after.quality_checks;assert.deepEqual(after,before);
  assert((await rows(app,'outbox_events')).filter(row=>row.event_type==='CheckTraceQuality').every(row=>row.status==='done'));
  const metadata=JSON.stringify(await Promise.all(['traces','trace_qc_runs','trace_qc_reviews','audit_events','idempotency_keys'].map(table=>rows(app,table))));
  assert.doesNotMatch(metadata,/PRIVATE_SOURCE_SENTINEL|ASSISTANT_PRIVATE_SENTINEL|false_positive|disagree|"findings"/);
  await assert.rejects(qc.get(other,trace.trace_id),/NOT_FOUND/);await assert.rejects(qc.run(other,randomUUID(),trace.trace_id,{scope:'private'}),/NOT_FOUND/);
  await assert.rejects(qc.review(other,randomUUID(),trace.trace_id,review),/NOT_FOUND/);await assert.rejects(qc.get(operator,trace.trace_id),/FORBIDDEN/);
});

test('source replacement invalidates binding and feedback while same content reuses the immutable report',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true});let evaluations=0;
  const qc=new TraceQc(app.service,{evaluate:(...args)=>{evaluations++;return runTraceQc(...args);}});
  const initial=await qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),source=await app.db.transaction(tx=>tx.get('traces',trace.trace_id,owner.id));
  await replaceSource(app,trace.trace_id,await app.privacy.open(owner.id,source.raw_ref));
  assert.equal((await qc.get(owner,trace.trace_id)).status,'not_run');
  await assert.rejects(qc.review(owner,randomUUID(),trace.trace_id,{scope:'private',report_digest:initial.report_digest,source_version:initial.selected_source.source_version,decision:'agree',feedback:[]}),/QC_REVIEW_STALE/);
  const reused=await qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
  assert.equal(reused.cached,true);assert.equal(reused.report_digest,initial.report_digest);assert.notEqual(reused.selected_source.source_version,initial.selected_source.source_version);assert.equal(evaluations,1);
  await assert.rejects(qc.review(owner,randomUUID(),trace.trace_id,{scope:'private',report_digest:initial.report_digest,source_version:initial.selected_source.source_version,decision:'agree',feedback:[]}),/QC_REVIEW_STALE/);
  await replaceSource(app,trace.trace_id,{turns:[{role:'user',content:'A changed synthetic source.'}]});
  const changed=await qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});assert.notEqual(changed.report_digest,initial.report_digest);assert.equal(changed.review,null);assert.equal(evaluations,2);
});

test('vault reads, result encryption and deterministic execution never hold the global database lock',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true});let inTransaction=false,evaluations=0;
  const transaction=app.db.transaction.bind(app.db);app.db.transaction=async(work,label)=>transaction(async tx=>{inTransaction=true;try{return await work(tx);}finally{inTransaction=false;}},label);
  const open=app.privacy.open.bind(app.privacy),seal=app.privacy.seal.bind(app.privacy);
  app.privacy.open=async(...args)=>{assert.equal(inTransaction,false,'vault read under global lock');return open(...args);};
  app.privacy.seal=async(...args)=>{assert.equal(inTransaction,false,'vault write under global lock');return seal(...args);};
  const qc=new TraceQc(app.service,{evaluate:(...args)=>{assert.equal(inTransaction,false,'checks under global lock');evaluations++;return runTraceQc(...args);}});
  const result=await qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
  await qc.get(owner,trace.trace_id);await qc.review(owner,randomUUID(),trace.trace_id,{scope:'private',report_digest:result.report_digest,source_version:result.selected_source.source_version,decision:'agree',feedback:['useful']});
  assert.equal(evaluations,1);
});

test('source changes during vault reads cannot publish a report for replaced content',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true}),original=app.privacy.open.bind(app.privacy);let changed=false;
  app.privacy.open=async(...args)=>{const result=await original(...args);if(!changed){changed=true;await replaceSource(app,trace.trace_id,{turns:[{role:'user',content:'Replacement source'}]});}return result;};
  await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_SOURCE_CHANGED/);
  assert.equal((await rows(app,'trace_qc_runs')).length,0);
});

test('deletion, expiry and owner changes after encrypted report reads never disclose cached findings',async t=>{
  for(const mode of ['deleted','expired','owner']){
    const app=await fixture(t),trace=await saved(app,{private:true}),result=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
    const original=app.privacy.open.bind(app.privacy);let changed=false;
    app.privacy.open=async(...args)=>{
      const value=await original(...args);
      if(!changed){changed=true;await app.db.transaction(async tx=>{
        if(mode==='owner')await tx.sql.query('UPDATE traces SET owner_id=$2 WHERE id=$1',[trace.trace_id,other.id]);
        else{const row=await tx.get('traces',trace.trace_id,owner.id);if(mode==='deleted')row.deleted=true;else row.retention_expires_at='2000-01-01T00:00:00.000Z';await tx.update('traces',trace.trace_id,row);}
      });}
      return value;
    };
    await assert.rejects(app.qc.get(owner,trace.trace_id),mode==='owner'?/NOT_FOUND/:/TRACE_CONTENT_UNAVAILABLE/);
    await assert.rejects(app.qc.review(owner,randomUUID(),trace.trace_id,{scope:'private',report_digest:result.report_digest,source_version:result.selected_source.source_version,decision:'agree',feedback:[]}),mode==='owner'?/NOT_FOUND/:/TRACE_CONTENT_UNAVAILABLE/);
  }
});

test('deletion racing result encryption fences publication and staged cleanup removes orphan reports',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true}),seal=app.privacy.seal.bind(app.privacy);let orphan:Document|undefined;
  app.privacy.seal=async(...args)=>{
    const ref=await seal(...args);orphan=ref;await app.service.deleteTrace(owner,randomUUID(),trace.trace_id);return ref;
  };
  await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/TRACE_CONTENT_UNAVAILABLE/);
  assert.equal((await rows(app,'trace_qc_runs')).length,0);assert(orphan);
  await app.service.staged.cleanup();await assert.rejects(app.privacy.open(owner.id,orphan!));
});

test('completed QC and reviewer artifacts are removed with private trace deletion and expiry',async t=>{
  for(const expires of [false,true]){
    const app=await fixture(t),trace=await saved(app,{private:true}),result=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
    await app.qc.review(owner,randomUUID(),trace.trace_id,{scope:'private',report_digest:result.report_digest,source_version:result.selected_source.source_version,decision:'agree',feedback:['useful']});
    const refs=[...(await rows(app,'trace_qc_runs')),...(await rows(app,'trace_qc_reviews'))].map(row=>row.document.object_ref);
    if(expires){await app.db.transaction(async tx=>{const row=await tx.get('traces',trace.trace_id,owner.id);row.retention_expires_at='2000-01-01T00:00:00.000Z';await tx.update('traces',trace.trace_id,row);});await app.service.sweepRetention();}
    else await app.service.deleteTrace(owner,randomUUID(),trace.trace_id);
    assert.equal((await app.service.runWorker()).failed,0);
    assert.equal((await rows(app,'trace_qc_runs')).length,0);assert.equal((await rows(app,'trace_qc_reviews')).length,0);
    for(const ref of refs)await assert.rejects(app.privacy.open(owner.id,ref));
    await assert.rejects(app.qc.get(owner,trace.trace_id),/TRACE_CONTENT_UNAVAILABLE/);
  }
});

test('engine exceptions stay operational errors, malformed source is not a pass, and over-limit content is refused',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true});
  const qc=new TraceQc(app.service,{evaluate:()=>{throw new Error('PRIVATE_ENGINE_EXCEPTION_SENTINEL');}});
  await assert.rejects(qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_EXECUTION_FAILED/);
  assert.equal((await rows(app,'trace_qc_runs')).length,0);
  await replaceSource(app,trace.trace_id,{turns:[{role:'invented',content:'Malformed source'}]});
  const invalid=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});assert.notEqual(invalid.report!.status,'pass');
  await replaceSource(app,trace.trace_id,{turns:[{role:'user',content:'x'.repeat(2_100_000)}]});
  await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_SOURCE_LIMIT/);
  const metadata=JSON.stringify(await rows(app,'idempotency_keys'));assert.doesNotMatch(metadata,/PRIVATE_ENGINE_EXCEPTION_SENTINEL/);
});

test('cached reports must match their digest, content, scope and policy before retrieval or reuse',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true}),result=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
  const run=(await rows(app,'trace_qc_runs'))[0]!,source=await app.db.transaction(tx=>tx.get('traces',trace.trace_id,owner.id));
  const wrong={...result.report!,content_digest:'f'.repeat(64)},ref=await app.privacy.seal(owner.id,wrong);
  await app.db.transaction(tx=>tx.sql.query('UPDATE trace_qc_runs SET document=$2::jsonb WHERE id=$1',[run.id,JSON.stringify({...run.document,object_ref:ref,report_digest:contentDigest(wrong)})]));
  await assert.rejects(app.qc.get(owner,trace.trace_id),/QC_REPORT_UNAVAILABLE/);
  await replaceSource(app,trace.trace_id,await app.privacy.open(owner.id,source.raw_ref));
  await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_REPORT_UNAVAILABLE/);
  assert.equal((await rows(app,'trace_qc_runs')).length,1);
});

test('per-trace persistence caps bound repeated source runs and human reviews while retaining cached reads',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true}),result=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
  const run=(await rows(app,'trace_qc_runs'))[0]!,review={scope:'private',report_digest:result.report_digest,source_version:result.selected_source.source_version,decision:'agree',feedback:[]},key=randomUUID();
  await app.qc.review(owner,key,trace.trace_id,review);const recorded=(await rows(app,'trace_qc_reviews'))[0]!;
  await app.db.transaction(async tx=>{
    for(let i=1;i<TRACE_QC_STORAGE_LIMITS.runs_per_trace;i++)await tx.insert('trace_qc_runs','synthetic-qc-run-'+i,owner.id,run.document);
    for(let i=1;i<TRACE_QC_STORAGE_LIMITS.reviews_per_trace;i++)await tx.insert('trace_qc_reviews','synthetic-qc-review-'+i,owner.id,recorded.document);
  });
  assert.equal((await app.qc.get(owner,trace.trace_id)).status,'complete');
  await app.qc.review(owner,key,trace.trace_id,review);
  await assert.rejects(app.qc.review(owner,randomUUID(),trace.trace_id,review),/QC_STORAGE_LIMIT/);
  assert.equal((await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'})).cached,true);
  await replaceSource(app,trace.trace_id,{turns:[{role:'user',content:'New source over retained-run capacity'}]});
  await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_STORAGE_LIMIT/);
});

test('source acquisition gaps remain visible beside passing content checks without changing the content report',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true}),initial=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
  assert.equal(initial.report!.status,'pass','The synthetic content ends with an ordinary assistant response.');
  assert.equal(initial.selected_source.coverage.status,'not_established');
  assert.equal(initial.selected_source.coverage.capture_state,'NOT_CAPTURED');
  assert.match(initial.selected_source.coverage.warning!,/Source completeness is not established/);
  const cases=[
    {capture:'RECORDING',projection:'READY',reason:'CAPTURE_RECORDING'},
    {capture:'INFLIGHT',projection:'READY',reason:'CAPTURE_INFLIGHT'},
    {capture:'INTERRUPTED',projection:'READY',reason:'CAPTURE_INTERRUPTED'},
    {capture:'COMPLETED',projection:'PARTIAL',reason:'PROJECTION_PARTIAL'},
    {capture:'COMPLETED',projection:'PENDING',reason:'PROJECTION_PENDING'},
    {capture:'COMPLETED',projection:'UNREADABLE',reason:'PROJECTION_UNREADABLE'},
    {capture:'COMPLETED',projection:'ERROR',reason:'PROJECTION_ERROR'},
  ];
  for(const example of cases){
    await app.db.transaction(async tx=>{const row=await tx.get('traces',trace.trace_id,owner.id);row.capture_state=example.capture;row.projection={status:example.projection};await tx.update('traces',trace.trace_id,row);});
    const pending=await app.qc.get(owner,trace.trace_id);assert.equal(pending.status,'not_run');assert.equal(pending.selected_source.coverage.status,'incomplete');
    assert(pending.selected_source.coverage.reason_codes.includes(example.reason));
    assert.equal(pending.selected_source.coverage.warning,example.reason.startsWith('CAPTURE_')?'This recording is incomplete. Checks cover only the saved content.':'Readable content may be incomplete. Checks cover the available content.');
    if(['RECORDING','INFLIGHT'].includes(example.capture)||example.projection==='PENDING'){assert.equal(pending.automation.state,'preparing');await assert.rejects(app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),/QC_SOURCE_PREPARING/);continue;}
    const checked=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
    assert.equal(checked.selected_source.coverage.status,'incomplete');assert.equal(checked.report_digest,initial.report_digest);assert.equal(checked.cached,true);
    assert.deepEqual(checked.report,initial.report,'Acquisition context is separate from the exact content report.');
    assert.equal(checked.selected_source.content_hash,initial.selected_source.content_hash);
    assert.notEqual(checked.selected_source.source_version,initial.selected_source.source_version);
    assert.deepEqual((await app.qc.get(owner,trace.trace_id)).selected_source,checked.selected_source,'Identical source state preserves its version and contextual warning.');
  }
  await app.db.transaction(async tx=>{const row=await tx.get('traces',trace.trace_id,owner.id);row.capture_state='COMPLETED';row.projection={status:'READY'};row.capture_summary={interrupted:0};await tx.update('traces',trace.trace_id,row);});
  const ready=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
  assert.equal(ready.selected_source.coverage.status,'no_known_gaps');assert.equal(ready.selected_source.coverage.warning,null);
  assert.equal(ready.report_digest,initial.report_digest,'No invented complete-task claim enters the content result.');
});

test('interruption metadata changes invalidate source-bound reviews and are rechecked during cached reads',async t=>{
  const app=await fixture(t),trace=await saved(app,{private:true});
  await app.db.transaction(async tx=>{const row=await tx.get('traces',trace.trace_id,owner.id);row.capture_state='COMPLETED';row.projection={status:'READY'};row.capture_summary={interrupted:0};await tx.update('traces',trace.trace_id,row);});
  const first=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'}),open=app.privacy.open.bind(app.privacy);let changed=false;
  app.privacy.open=async(...args)=>{
    const content=await open(...args);
    if(!changed){changed=true;await app.db.transaction(async tx=>{const row=await tx.get('traces',trace.trace_id,owner.id);row.capture_summary={interrupted:1,private_detail:'PRIVATE_COMPLETENESS_SENTINEL'};await tx.update('traces',trace.trace_id,row);});}
    return content;
  };
  await assert.rejects(app.qc.get(owner,trace.trace_id),/QC_SOURCE_CHANGED/);
  const next=await app.qc.run(owner,randomUUID(),trace.trace_id,{scope:'private'});
  assert.equal(next.report_digest,first.report_digest);assert.equal(next.selected_source.coverage.status,'incomplete');assert.deepEqual(next.selected_source.coverage.reason_codes,['CAPTURE_INTERRUPTED']);
  await assert.rejects(app.qc.review(owner,randomUUID(),trace.trace_id,{scope:'private',report_digest:first.report_digest,source_version:first.selected_source.source_version,decision:'agree',feedback:[]}),/QC_REVIEW_STALE/);
  assert.doesNotMatch(JSON.stringify(next),/PRIVATE_COMPLETENESS_SENTINEL/);
  await app.db.transaction(async tx=>{const row=await tx.get('traces',trace.trace_id,owner.id);row.capture_state='PRIVATE_UNKNOWN_CAPTURE_STATE';row.projection={status:'PRIVATE_UNKNOWN_PROJECTION_STATE'};row.capture_summary={interrupted:0};await tx.update('traces',trace.trace_id,row);});
  const unknown=await app.qc.get(owner,trace.trace_id);
  assert.equal(unknown.selected_source.coverage.status,'not_established');assert.equal(unknown.selected_source.coverage.capture_state,'UNKNOWN');assert.equal(unknown.selected_source.coverage.projection_status,'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE_UNKNOWN/);
});
