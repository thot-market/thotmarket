import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {SqlRemoteAccounting} from '../packages/vault/src/remote-accounting.ts';
import {CiphertextNotFoundError,type CiphertextStore} from '../packages/vault/src/index.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {DomainError} from '../packages/storage/src/index.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
class Objects implements CiphertextStore {
  data=new Map<string,Buffer>();nextWrite?:{entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>};nextRead?:{entered:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>};
  ambiguous=false;deleteFails=false;blockedDeletes=new Set<string>();
  async put(id:string,bytes:Buffer){
    const pause=this.nextWrite;this.nextWrite=undefined;if(pause){pause.entered.resolve();await pause.release.promise;}
    assert.ok(!this.data.has(id));this.data.set(id,Buffer.from(bytes));if(this.ambiguous){this.ambiguous=false;throw Error('RESPONSE_LOST_AFTER_PUT');}
  }
  async get(id:string,max:number){const pause=this.nextRead;this.nextRead=undefined;if(pause){pause.entered.resolve();await pause.release.promise;}const value=this.data.get(id);if(!value)throw new CiphertextNotFoundError();assert.ok(value.length<=max);return Buffer.from(value);}
  async delete(id:string){if(this.deleteFails||this.blockedDeletes.has(id))throw Error('DELETE_OUTAGE');this.data.delete(id);}
  pause(kind:'read'|'write'){const gate={entered:deferred(),release:deferred()};if(kind==='read')this.nextRead=gate;else this.nextWrite=gate;return gate;}
}
const owner={id:'demo-user',role:'user' as const};
async function fixture(t:any){
  const root=await mkdtemp(join(tmpdir(),'thot-staged-')),sql=await PGlite.create(),objects=new Objects();
  const accounting=await new SqlRemoteAccounting({transaction:work=>sql.transaction(q=>work(q))},'synthetic').initialize();
  const options={dataDir:root,masterKey:Buffer.alloc(32,91),storage:{ciphertext:objects,accounting,identity:'a'.repeat(64)}};
  let app=await createApplication(options);
  t.after(async()=>{objects.nextRead?.release.resolve();objects.nextWrite?.release.resolve();await app.close();await sql.close();await rm(root,{recursive:true,force:true});});
  return {get app(){return app;},objects,accounting,sql,reopen:async()=>{await app.close();app=await createApplication(options);return app;}};
}
function imported(app:any,text='Synthetic standalone conversation'){
  return {bundle:app.privacy.createDemoBundle({turns:[{role:'user',content:text},{role:'assistant',content:'Synthetic answer.'}]},owner.id),rights_confirmed:true,model_output_licensed:true};
}
function part(sequence:number,text='Synthetic question'){
  const now=new Date().toISOString(),record={sequence,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from(JSON.stringify({model:'synthetic',messages:[{role:'user',content:text}]})).toString('base64'),response_body_b64:Buffer.from(JSON.stringify({type:'message',content:[{type:'text',text:'Synthetic answer.'}],stop_reason:'end_turn'})).toString('base64'),status:200,content_type:'application/json',started_at:now,finished_at:now,complete:true};
  return {...record,commitment:canonicalHash(record)};
}
function manifest(id:string,parts:any[]){const body={format:'thot.proxy-capture/2',capture_id:id,client:'claude',started_at:parts[0].started_at,finished_at:parts.at(-1).finished_at,parts:parts.map(({sequence,commitment})=>({sequence,commitment}))};return {...body,root:canonicalHash(body)};}
async function promptMetadata(app:any){return app.db.transaction((tx:any)=>tx.get('users',owner.id));}
async function promptly(work:Promise<any>,release:()=>void){let timeout:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise((_,reject)=>{timeout=setTimeout(()=>{release();reject(Error('External I/O held the application transaction'));},1000);})]);}finally{clearTimeout(timeout);}}

test('a stalled import upload retains a durable reference and does not lock unrelated metadata; same-key retries coalesce',async t=>{
  const f=await fixture(t),input=imported(f.app),gate=f.objects.pause('write');
  f.app.service.staged.onObjectTiming=timing=>{assert.ok(Object.isFrozen(timing));throw Error('OBSERVER_FAILURE');};
  const first=f.app.service.importTrace(owner,'stalled-import-key',input);await gate.entered.promise;
  await promptly(promptMetadata(f.app),gate.release.resolve);
  const pending=(await f.app.db.query("SELECT objects FROM storage_write_attempts WHERE status='active'")).rows[0]!.objects;
  assert.equal(pending.length,1);assert.equal(pending[0].status,'pending');assert.equal(pending[0].ref.ownerUserId,owner.id);
  const second=f.app.service.importTrace(owner,'stalled-import-key',input);
  await assert.rejects(f.app.service.importTrace(owner,'stalled-import-key',{...input,category:'research_flow'}),/IDEMPOTENCY_CONFLICT/);
  gate.release.resolve();const [a,b]=await Promise.all([first,second]);assert.equal(a.trace_id,b.trace_id);assert.equal(f.objects.data.size,4);
  assert.equal((await f.accounting.usage(owner.id)).owner.objects,4);
  const metrics=f.app.service.staged.metrics();assert.equal(metrics.series.reduce((n,s)=>n+s.count,0),4);assert.ok(!JSON.stringify(metrics).includes(owner.id));
});

test('competing import keys publish one logical trace and reclaim only the losing ciphertext',async t=>{
  const f=await fixture(t),input=imported(f.app);
  const [a,b]=await Promise.all([f.app.service.importTrace(owner,'competing-import-a',input),f.app.service.importTrace(owner,'competing-import-b',input)]);
  assert.equal(a.trace_id,b.trace_id);assert.equal((await f.app.db.query('SELECT count(*)::int AS n FROM traces')).rows[0]!.n,1);
  const cleanup=await f.app.service.staged.cleanup();assert.equal(cleanup.failed,0);assert.equal(f.objects.data.size,4);assert.equal((await f.accounting.usage(owner.id)).owner.objects,4);
  const trace=await f.app.db.transaction(tx=>tx.get('traces',a.trace_id,owner.id));assert.equal((await f.app.privacy.open(owner.id,trace.raw_ref)).turns[1].content,'Synthetic answer.');
});

test('ambiguous provider acceptance stays tracked and charged across restart; retry never publishes the ambiguous reference',async t=>{
  const f=await fixture(t),input=imported(f.app);f.objects.ambiguous=true;
  await assert.rejects(f.app.service.importTrace(owner,'ambiguous-import',input),/RESPONSE_LOST_AFTER_PUT/);
  const pending=(await f.app.db.query('SELECT objects FROM storage_write_attempts')).rows[0]!.objects[0];assert.equal(pending.status,'pending');assert.ok(f.objects.data.has(pending.ref.objectId));
  await f.reopen();assert.equal((await f.accounting.usage(owner.id)).owner.objects,1);
  const saved=await f.app.service.importTrace(owner,'ambiguous-import',input);assert.ok(saved.trace_id);
  await f.app.service.staged.cleanup();assert.ok(f.objects.data.has(pending.ref.objectId));assert.equal((await f.accounting.usage(owner.id)).owner.objects,5);
  assert.equal((await f.app.db.query("SELECT count(*)::int AS n FROM storage_write_attempts WHERE status='abandoned' AND objects @> '[{\"status\":\"pending\"}]'::jsonb")).rows[0]!.n,1);
});

test('database commit failure leaves reclaimable objects; deletion outage never releases quota',async t=>{
  const f=await fixture(t),input=imported(f.app),transaction=f.app.db.transaction.bind(f.app.db);let fail=true;
  f.app.db.transaction=work=>transaction(async tx=>{const insert=tx.insert.bind(tx);tx.insert=async(...args)=>{if(fail&&args[0]==='trace_bundles'){fail=false;throw Error('INJECTED_COMMIT_FAILURE');}return insert(...args);};return work(tx);});
  await assert.rejects(f.app.service.importTrace(owner,'failed-commit-key',input),/INJECTED_COMMIT_FAILURE/);assert.equal(f.objects.data.size,4);
  assert.equal((await f.app.db.query('SELECT count(*)::int AS n FROM traces')).rows[0]!.n,0);
  f.objects.deleteFails=true;assert.equal((await f.app.service.staged.cleanup()).failed,4);assert.equal((await f.accounting.usage(owner.id)).owner.objects,4);
  f.objects.deleteFails=false;await f.reopen();await f.app.service.importTrace(owner,'failed-commit-key',input);await f.app.service.staged.cleanup();
  assert.equal(f.objects.data.size,8);assert.equal((await f.accounting.usage(owner.id)).owner.objects,8,'Cooldown retains ciphertext and charge');
  await f.app.db.transaction(async tx=>{await tx.sql.query("UPDATE storage_write_attempts SET objects=(SELECT jsonb_agg(CASE WHEN item->>'status'='delete_failed' THEN jsonb_set(item,'{retry_after}',to_jsonb((now()-interval '1 second')::text)) ELSE item END) FROM jsonb_array_elements(objects) item) WHERE status='abandoned'");});
  await f.app.service.staged.cleanup();assert.equal(f.objects.data.size,4);assert.equal((await f.accounting.usage(owner.id)).owner.objects,4);
});

test('a persistent delete failure rotates behind newer reclaimable ciphertext',async t=>{
  const f=await fixture(t),blocked=await f.app.privacy.seal(owner.id,{blocked:true}),sameAttempt=await f.app.privacy.seal(owner.id,{same_attempt:true}),newer=await f.app.privacy.seal(owner.id,{newer:true});
  await f.app.db.transaction(async tx=>{
    await tx.sql.query("INSERT INTO storage_write_attempts(id,owner_id,status,expires_at,objects,created_at) VALUES('blocked-cleanup',$1,'abandoned',now(),$2::jsonb,now()-interval '1 hour'),('newer-cleanup',$1,'abandoned',now(),$3::jsonb,now())",[owner.id,JSON.stringify([{ref:blocked,status:'stored'},{ref:sameAttempt,status:'stored'}]),JSON.stringify([{ref:newer,status:'stored'}])]);
  });
  f.objects.blockedDeletes.add(blocked.objectId);assert.deepEqual(await f.app.service.staged.cleanup(1),{removed:0,failed:1});
  assert.deepEqual(await f.app.service.staged.cleanup(1),{removed:1,failed:0});assert.ok(!f.objects.data.has(sameAttempt.objectId),'stored work in the same attempt must pass a failed retry');
  assert.deepEqual(await f.app.service.staged.cleanup(1),{removed:1,failed:0});assert.ok(f.objects.data.has(blocked.objectId));assert.ok(!f.objects.data.has(newer.objectId),'a cooling failed attempt must not starve a newer attempt');
  const attempts=(await f.app.db.query('SELECT id,objects FROM storage_write_attempts ORDER BY id')).rows;
  const failed=attempts.find(row=>row.id==='blocked-cleanup')!.objects[0];assert.equal(failed.status,'delete_failed');assert.ok(Date.parse(failed.retry_after)>Date.now());assert.equal((await f.accounting.usage(owner.id)).owner.objects,1);
});

test('replay after response loss and restart returns the original result without new writes',async t=>{
  const f=await fixture(t),input=imported(f.app),a=await f.app.service.importTrace(owner,'response-lost-key',input);await f.reopen();
  const b=await f.app.service.importTrace(owner,'response-lost-key',input);assert.deepEqual(a,b);assert.equal(f.objects.data.size,4);
  await assert.rejects(f.app.service.importTrace(owner,'response-lost-key',{...input,category:'research_flow'}),/IDEMPOTENCY_CONFLICT/);
});

test('an expired attempt cannot commit even when an upload eventually succeeds',async t=>{
  const f=await fixture(t),input=imported(f.app),gate=f.objects.pause('write');const saving=f.app.service.importTrace(owner,'expired-attempt-key',input);await gate.entered.promise;
  await f.app.db.transaction(async tx=>{await tx.sql.query("UPDATE storage_write_attempts SET expires_at=now()-interval '1 second' WHERE status='active'");});
  await f.app.service.staged.cleanup();gate.release.resolve();await assert.rejects(saving,/STORAGE_OPERATION_EXPIRED/);
  assert.equal((await f.app.db.query('SELECT count(*)::int AS n FROM traces')).rows[0]!.n,0);await f.app.service.staged.cleanup();assert.equal(f.objects.data.size,0);assert.equal((await f.accounting.usage(owner.id)).owner.objects,0);
});

test('part commit rejects a device revoked during upload',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true});
  await f.app.db.transaction(async tx=>{const capture=await tx.get('agent_captures',c.capture_id,owner.id);capture.device_id='synthetic-device';await tx.update('agent_captures',c.capture_id,capture);});
  let revoked=false;f.app.agentCapture.deviceActive=async()=>{if(revoked)throw new DomainError('CAPTURE_DEVICE_REVOKED',401);return {};};
  const gate=f.objects.pause('write'),saving=f.app.agentCapture.part(c.capture_id,c.upload_token,'revoked-part-key',{part:part(1)});await gate.entered.promise;revoked=true;
  await promptly(promptMetadata(f.app),gate.release.resolve);gate.release.resolve();await assert.rejects(saving,/CAPTURE_DEVICE_REVOKED/);
  const current=await f.app.db.transaction(tx=>tx.get('agent_captures',c.capture_id,owner.id));assert.equal(current.parts,undefined);await f.app.service.staged.cleanup();assert.equal(f.objects.data.size,0);
});

test('part commit cannot publish ciphertext after its checkpointed trace is deleted',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),first=part(1),second=part(2);
  await f.app.agentCapture.part(c.capture_id,c.upload_token,'deletion-fence-part-1',{part:first});
  const saved=await f.app.agentCapture.checkpoint(c.capture_id,c.upload_token,'deletion-fence-checkpoint',{bundle:manifest(c.capture_id,[first])});
  const gate=f.objects.pause('write'),saving=f.app.agentCapture.part(c.capture_id,c.upload_token,'deletion-fence-part-2',{part:second});await gate.entered.promise;
  await promptly(f.app.service.deleteTrace(owner,'deletion-fence-delete',saved.trace_id),gate.release.resolve);
  assert.equal((await f.app.service.runWorker()).failed,0);assert.equal(f.objects.data.size,0);
  gate.release.resolve();await assert.rejects(saving,/CAPTURE_CONTENT_UNAVAILABLE/);
  const capture=await f.app.db.transaction(tx=>tx.get('agent_captures',c.capture_id,owner.id));
  assert.equal(capture.parts?.['2'],undefined);assert.equal((await f.app.db.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='DeleteTraceObjects' AND status!='done'")).rows[0]!.n,0);
  assert.equal(f.objects.data.size,1);const cleanup=await f.app.service.staged.cleanup();assert.equal(cleanup.removed,1);assert.equal(cleanup.failed,0);assert.equal(f.objects.data.size,0);
});

test('checkpoint N cannot overwrite N+1 when its remote read finishes later',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),parts=[part(1),part(2)];
  for(const p of parts)await f.app.agentCapture.part(c.capture_id,c.upload_token,'sequence-part-'+p.sequence,{part:p});
  const gate=f.objects.pause('read'),older=f.app.agentCapture.checkpoint(c.capture_id,c.upload_token,'older-checkpoint',{bundle:manifest(c.capture_id,[parts[0]])});await gate.entered.promise;
  await promptly(promptMetadata(f.app),gate.release.resolve);
  const newer=await f.app.agentCapture.checkpoint(c.capture_id,c.upload_token,'newer-checkpoint',{bundle:manifest(c.capture_id,parts)});gate.release.resolve();await assert.rejects(older,/CHECKPOINT_REGRESSION/);
  const status=await f.app.agentCapture.status(owner,c.capture_id);assert.equal(status.result.trace_id,newer.trace_id);assert.equal(status.result.capture_summary.exchanges,2);
  await f.app.service.staged.cleanup();assert.equal((await f.app.agentCapture.proof(owner,c.capture_id)).bundle.parts.length,2);
});

test('deletion while projection uploads cannot resurrect a trace or publish its staged objects',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),p=part(1);await f.app.agentCapture.part(c.capture_id,c.upload_token,'delete-race-part',{part:p});
  const project=f.app.agentCapture.project.bind(f.app.agentCapture);f.app.agentCapture.project=async()=>{};
  const saved=await f.app.agentCapture.complete(c.capture_id,c.upload_token,'delete-race-complete',{bundle:manifest(c.capture_id,[p])});f.app.agentCapture.project=project;
  const gate=f.objects.pause('write'),projecting=project(c.capture_id,manifest(c.capture_id,[p]).root);await gate.entered.promise;
  await promptly(f.app.service.deleteTrace(owner,'delete-during-projection',saved.trace_id),gate.release.resolve);gate.release.resolve();await projecting;
  const trace=await f.app.db.transaction(tx=>tx.get('traces',saved.trace_id,owner.id));assert.equal(trace.deleted,true);assert.equal(trace.raw_ref,undefined);
  await f.app.service.staged.cleanup();await assert.rejects(f.app.agentCapture.proof(owner,c.capture_id),/CAPTURE_CONTENT_UNAVAILABLE/);
});

test('owner edits during projection are retained after an optimistic retry',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),p=part(1);await f.app.agentCapture.part(c.capture_id,c.upload_token,'edit-race-part',{part:p});
  const project=f.app.agentCapture.project.bind(f.app.agentCapture);f.app.agentCapture.project=async()=>{};
  const saved=await f.app.agentCapture.complete(c.capture_id,c.upload_token,'edit-race-complete',{bundle:manifest(c.capture_id,[p])});f.app.agentCapture.project=project;
  const gate=f.objects.pause('write'),projecting=project(c.capture_id,manifest(c.capture_id,[p]).root);await gate.entered.promise;
  const personal=await f.app.privacy.seal(owner.id,{title:'Owner annotation'});
  await f.app.db.transaction(async tx=>{const trace=await tx.get('traces',saved.trace_id,owner.id);trace.personal_ref=personal;await tx.update('traces',saved.trace_id,trace);});gate.release.resolve();await projecting;
  const trace=await f.app.db.transaction(tx=>tx.get('traces',saved.trace_id,owner.id));assert.deepEqual(trace.personal_ref,personal);assert.equal(trace.projection.status,'READY');await f.app.service.staged.cleanup();assert.deepEqual(await f.app.privacy.open(owner.id,trace.personal_ref),{title:'Owner annotation'});
});

test('newer checkpoint retries after the older prefix commits and retains one trace',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),parts=[part(1),part(2)];
  for(const p of parts)await f.app.agentCapture.part(c.capture_id,c.upload_token,'prefix-part-'+p.sequence,{part:p});
  const gate=f.objects.pause('read'),newer=f.app.agentCapture.checkpoint(c.capture_id,c.upload_token,'blocked-newer-checkpoint',{bundle:manifest(c.capture_id,parts)});await gate.entered.promise;
  const older=await f.app.agentCapture.checkpoint(c.capture_id,c.upload_token,'earlier-prefix-checkpoint',{bundle:manifest(c.capture_id,[parts[0]])});gate.release.resolve();const saved=await newer;
  assert.equal(saved.trace_id,older.trace_id);assert.equal(saved.capture_summary.exchanges,2);assert.equal(saved.capture_summary.normalized,2);assert.equal((await f.app.db.query('SELECT count(*)::int AS n FROM traces')).rows[0]!.n,1);
  await f.app.service.staged.cleanup();assert.equal((await f.app.agentCapture.proof(owner,c.capture_id)).bundle.parts.length,2);
});

test('completion fences a longer checkpoint still preparing its evidence',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),parts=[part(1),part(2)];
  for(const p of parts)await f.app.agentCapture.part(c.capture_id,c.upload_token,'complete-race-part-'+p.sequence,{part:p});
  const gate=f.objects.pause('read'),pending=f.app.agentCapture.checkpoint(c.capture_id,c.upload_token,'complete-race-checkpoint',{bundle:manifest(c.capture_id,parts)});await gate.entered.promise;
  const saved=await f.app.agentCapture.complete(c.capture_id,c.upload_token,'complete-race-final',{bundle:manifest(c.capture_id,[parts[0]])});gate.release.resolve();await assert.rejects(pending,/AGENT_CAPTURE_ALREADY_COMPLETED/);
  const status=await f.app.agentCapture.status(owner,c.capture_id);assert.equal(status.status,'SAVED');assert.equal(status.result.trace_id,saved.trace_id);assert.equal(status.result.capture_summary.exchanges,1);
});

test('proof reads release the application lock and recheck deletion before returning plaintext',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),p=part(1);await f.app.agentCapture.part(c.capture_id,c.upload_token,'proof-race-part',{part:p});
  const saved=await f.app.agentCapture.complete(c.capture_id,c.upload_token,'proof-race-final',{bundle:manifest(c.capture_id,[p])});
  const gate=f.objects.pause('read'),reading=f.app.agentCapture.proofPart(owner,c.capture_id,1);await gate.entered.promise;
  await promptly(f.app.service.deleteTrace(owner,'proof-race-delete',saved.trace_id),gate.release.resolve);gate.release.resolve();await assert.rejects(reading,/CAPTURE_CONTENT_UNAVAILABLE/);
});

test('worker projection I/O runs outside its claim transaction and expired claims recover',async t=>{
  const f=await fixture(t),c=await f.app.agentCapture.begin(owner,{client:'claude',save_privately:true}),p=part(1);await f.app.agentCapture.part(c.capture_id,c.upload_token,'worker-staged-part',{part:p});
  const project=f.app.agentCapture.project.bind(f.app.agentCapture);f.app.agentCapture.project=async()=>{};
  const saved=await f.app.agentCapture.complete(c.capture_id,c.upload_token,'worker-staged-final',{bundle:manifest(c.capture_id,[p])});f.app.agentCapture.project=project;
  // Simulate an interrupted worker claim, then recover using another worker run.
  await f.app.db.transaction(async tx=>{await tx.sql.query("UPDATE outbox_events SET status='processing',claim_token='interrupted-worker',available_at=now()-interval '1 second' WHERE event_type='ProjectAgentCapture'");});
  const gate=f.objects.pause('write'),working=f.app.service.runWorker();await gate.entered.promise;
  await promptly(promptMetadata(f.app),gate.release.resolve);
  const processing=(await f.app.db.query("SELECT claim_token FROM outbox_events WHERE status='processing'")).rows;assert.equal(processing.length,1);assert.notEqual(processing[0]!.claim_token,'interrupted-worker');
  gate.release.resolve();assert.equal((await working).failed,0);assert.equal((await f.app.agentCapture.status(owner,c.capture_id)).result.projection.status,'READY');
  const trace=await f.app.db.transaction(tx=>tx.get('traces',saved.trace_id,owner.id));assert.ok(f.objects.data.has(trace.raw_ref.objectId));
});

test('bounded preparation rejects overload and recovers after in-flight work drains',async t=>{
  const f=await fixture(t),gate=deferred(),entered=deferred();let count=0;
  const pending=Array.from({length:16},(_,i)=>f.app.service.staged.run(owner.id,'admission-key-'+i,{i},'part',async()=>{if(++count===16)entered.resolve();await gate.promise;return async()=>({ok:true});}));
  await entered.promise;
  assert.throws(()=>f.app.service.staged.run(owner.id,'overflow-key',{overflow:true},'part',async()=>async()=>({ok:true})),/STORAGE_BUSY/);
  await promptly(promptMetadata(f.app),gate.resolve);gate.resolve();await Promise.all(pending);
  const next=await f.app.service.staged.run(owner.id,'after-overload-key',{after:true},'part',async()=>async()=>({ok:true}));assert.equal(next.ok,true);
});


test('owner disablement during upload rejects commit and reclaims staged ciphertext',async t=>{
  const f=await fixture(t),input=imported(f.app),gate=f.objects.pause('write'),saving=f.app.service.importTrace(owner,'disabled-owner-import',input);await gate.entered.promise;
  await f.app.db.transaction(async tx=>{const actor=await tx.get('users',owner.id);actor.disabled=true;await tx.update('users',owner.id,actor);});gate.release.resolve();await assert.rejects(saving,/AUTH_ACTOR_UNAVAILABLE/);
  assert.equal((await f.app.db.query('SELECT count(*)::int AS n FROM traces')).rows[0]!.n,0);await f.app.service.staged.cleanup();assert.equal(f.objects.data.size,0);
});
