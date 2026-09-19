import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {OPENROUTER_RECORDING_NOTICE_VERSION,type OpenRouterRelayOptions} from '../packages/market/src/openrouter-relay.ts';

const owner={id:'demo-user',role:'user' as const},other={id:'other-user',role:'user' as const};
const providerKey='sk-or-v1-SYNTHETIC-KEY-ONLY-1234567890';
const consent=(api_key=providerKey)=>({api_key,recording_consent:true,notice_version:OPENROUTER_RECORDING_NOTICE_VERSION});
const prompt={model:'anthropic/claude-sonnet-4:exacto',messages:[{role:'user',content:'PRIVATE QUESTION about a race condition.'}]};
const completion=(content='PRIVATE ANSWER: use a bounded mutex.')=>({id:'gen-synthetic',object:'chat.completion',model:prompt.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18,cost:0.001}});
async function fixture(t:any,options:OpenRouterRelayOptions={}){const dir=await mkdtemp(join(tmpdir(),'thot-openrouter-'));const app=await createApplication({dataDir:dir,memory:true,openrouter:{enabled:true,transport:async()=>Response.json(completion()),...options}});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return app;}
async function state(app:Awaited<ReturnType<typeof fixture>>,id:string){return app.db.transaction(tx=>tx.get('thot_records',id));}

test('setup requires one explicit recording consent, only returns relay token once, and defaults disabled',async t=>{
  const app=await fixture(t,{enabled:false});assert.equal(app.openrouter.capabilities().enabled,false);
  await assert.rejects(app.openrouter.connect(owner,consent()),/DISABLED/);
  const on=await fixture(t);
  await assert.rejects(on.openrouter.connect(owner,{api_key:providerKey}),/CONSENT_REQUIRED/);
  await assert.rejects(on.openrouter.connect({id:'operator',role:'operator_security'},consent()),/FORBIDDEN/);
  const key=await on.openrouter.connect(owner,consent());assert.match(key.token,/^thot_or_/);
  const status=await on.openrouter.status(owner);assert.equal(status.connected,true);assert.equal(status.automatic_rewards,false);assert.equal(status.provenance,'P0_OPERATOR');
  assert.doesNotMatch(JSON.stringify(status),new RegExp(key.token+'|'+providerKey));
});

test('fixed-origin BYOK keeps credentials and full content encrypted, saves private traces, and replays without charging again',async t=>{
  let calls=0;const app=await fixture(t,{transport:async(url,init)=>{
    calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.redirect,'error');
    assert.deepEqual(Object.keys(init!.headers!).sort(),['Accept','Authorization','Content-Type']);assert.equal((init!.headers as any).Authorization,'Bearer '+providerKey);
    assert.equal(JSON.parse(init!.body as string).model,prompt.model);return Response.json(completion());
  }}),key=await app.openrouter.connect(owner,consent());
  const response=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'stable-request-001'});assert.equal(response.status,200);assert.deepEqual(await response.json(),completion());
  const id=response.headers.get('x-thot-request-id')!,traceId=response.headers.get('x-thot-trace-id')!;
  const r=await state(app,id);assert.equal(r.status,'COMPLETED');
  const trace=await app.db.transaction(tx=>tx.get('traces',traceId));assert.equal(trace.display_status,'PRIVATE');assert.equal(trace.save_privately,true);
  const view=await app.library.item(owner,traceId);assert.match(view.content.turns[0].content,/PRIVATE QUESTION/);assert.match(view.content.turns[1].content,/PRIVATE ANSWER/);
  assert.equal((await app.db.query('SELECT count(*)::int n FROM sale_authorizations')).rows[0].n,0);
  const persisted=JSON.stringify((await app.db.query("SELECT document FROM thot_records UNION ALL SELECT document FROM traces UNION ALL SELECT document FROM trace_bundles UNION ALL SELECT payload FROM audit_events")).rows);
  for(const secret of [providerKey,key.token,'PRIVATE QUESTION','PRIVATE ANSWER'])assert.ok(!persisted.includes(secret),secret+' leaked into plaintext persistence');
  const again=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'stable-request-001'});assert.equal(again.headers.get('x-thot-replayed'),'true');assert.deepEqual(await again.json(),completion());assert.equal(calls,1);
  await assert.rejects(app.openrouter.relay(key.token,{...prompt,temperature:0.4},{idempotencyKey:'stable-request-001'}),/IDEMPOTENCY_CONFLICT/);assert.equal(calls,1);
});

test('token rotation/revocation and owner boundaries prevent reading or spending another account',async t=>{
  let calls=0;const app=await fixture(t,{transport:async()=>{calls++;return Response.json(completion());}}),a=await app.openrouter.connect(owner,consent()),b=await app.openrouter.connect(other,consent('sk-or-v1-SECOND-SYNTHETIC-KEY'));
  const first=await app.openrouter.relay(a.token,prompt,{idempotencyKey:'shared-key-001'}),trace=first.headers.get('x-thot-trace-id')!;
  await assert.rejects(app.library.item(other,trace),/NOT_FOUND/);
  const second=await app.openrouter.relay(b.token,prompt,{idempotencyKey:'shared-key-001'});assert.notEqual(second.headers.get('x-thot-trace-id'),trace);assert.equal(calls,2);
  assert.equal((await app.openrouter.status(other)).requests.length,1);
  const rotated=await app.openrouter.connect(owner,consent());await assert.rejects(app.openrouter.relay(a.token,prompt),/UNAUTHENTICATED/);
  await app.openrouter.disconnect(owner);await assert.rejects(app.openrouter.relay(rotated.token,prompt),/UNAUTHENTICATED/);
  const records=await app.db.transaction(tx=>tx.list('thot_records',owner.id));assert.ok(records.find(r=>r.kind==='openrouter-config')&&!records.find(r=>r.kind==='openrouter-config')!.key_ref);
  assert.equal((await app.library.item(owner,trace)).trace_id,trace,'Disconnect must not erase earlier owner recordings');
});

test('response model identity survives aliases, streaming, and missing metadata without relabeling submitted history',async t=>{
  for(const stream of [false,true])for(const reported of [true,false]){
    const actual='openai/gpt-4.1-mini-2025-04-14',metadata=reported?{model:actual,provider:'OpenAI'}:{};
    const app=await fixture(t,{transport:async()=>stream?new Response('data: '+JSON.stringify({id:'gen-model-test',...metadata,choices:[{index:0,delta:{content:'Captured answer'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}):Response.json({id:'gen-model-test',...metadata,choices:[{index:0,message:{role:'assistant',content:'Captured answer'},finish_reason:'stop'}]})}),key=await app.openrouter.connect(owner,consent());
    const response=await app.openrouter.relay(key.token,{...prompt,model:'openrouter/auto',models:['openai/gpt-4.1-mini'],stream});await response.text();
    const row=await state(app,response.headers.get('x-thot-request-id')!),view=await app.library.item(owner,row.trace_id);
    assert.equal(row.requested_model,'openrouter/auto');assert.equal(row.returned_model,reported?actual:null);assert.equal(row.provider_name,reported?'OpenAI':null);
    assert.deepEqual(view.capture_model,{source:'openrouter',requested_model:'openrouter/auto',returned_model:reported?actual:null,provider_name:reported?'OpenAI':null,capture_status:'COMPLETED'});
    assert.equal(view.origin,'relay');assert.equal(view.state,'COMPLETED');assert.equal(view.exchanges,1);assert.equal(view.model_history.length,reported?1:0);
    if(reported)assert.equal(view.model_history[0].model,actual);
    const status=(await app.openrouter.status(owner)).requests[0];assert.equal(status.returned_model,reported?actual:null);
    const privateRequest=await app.privacy.open(owner.id,row.request_ref);assert.deepEqual(privateRequest.request.models,['openai/gpt-4.1-mini']);
  }
});

test('the encrypted source retains all accepted request fields and response bytes, beyond the text sale projection',async t=>{
  const output={...completion(),provider:'OpenAI',choices:[{index:0,message:{role:'assistant',content:'Readable answer',reasoning:'Provider exposed reasoning',annotations:[{type:'citation',url:'https://example.test/result'}]},finish_reason:'stop'}]};
  const input={...prompt,messages:[{role:'system',content:'Private system context'},{role:'user',content:[{type:'text',text:'Describe this image'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]}],temperature:0.2};
  const app=await fixture(t,{transport:async()=>Response.json(output)}),key=await app.openrouter.connect(owner,consent());
  const response=await app.openrouter.relay(key.token,input);await response.text();const row=await state(app,response.headers.get('x-thot-request-id')!);
  assert.deepEqual((await app.privacy.open(owner.id,row.request_ref)).request,input);
  const bytes=[];for(const part of row.parts)bytes.push(Buffer.from((await app.privacy.open(owner.id,part.ref)).bytes_b64,'base64'));
  assert.deepEqual(JSON.parse(Buffer.concat(bytes).toString()),output);
  const privateView=await app.library.item(owner,row.trace_id);assert.equal(privateView.content.turns[0].role,'system');assert.equal(privateView.content.turns[0].content,'Private system context');assert.match(privateView.content.turns[1].content,/Non-text content retained in private source/);assert.match(privateView.content.turns[2].content,/Provider exposed reasoning/);
  assert.equal(privateView.private,true);assert.equal(privateView.private_import.can_prepare_sale,true);
  const source=await app.openrouter.source(owner,row.request_id);assert.equal(source.private,true);assert.deepEqual(source.request,input);assert.deepEqual(JSON.parse(Buffer.from(source.response.body_b64,'base64').toString()),output);assert.equal(source.response.complete,true);assert.equal(source.capture_model.returned_model,output.model);
  assert.equal(Object.hasOwn(source.request,'Authorization'),false);assert.equal(Object.hasOwn(source.response,'Authorization'),false);assert.ok(!JSON.stringify(source).includes(providerKey));
  await assert.rejects(app.openrouter.source(other,row.request_id),/NOT_FOUND/);
  await assert.rejects(app.openrouter.source({id:'operator',role:'operator_security'},row.request_id),/FORBIDDEN/);
  await app.service.deleteTrace(owner,'delete-export-source',row.trace_id);await assert.rejects(app.openrouter.source(owner,row.request_id),/DELETED/);
});

test('legacy capture model metadata is recovered from encrypted replay without another provider request or a new sale',async t=>{
  let calls=0;const app=await fixture(t,{transport:async()=>{calls++;return Response.json({...completion(),model:'openai/gpt-4.1-mini'});}}),key=await app.openrouter.connect(owner,consent());
  const response=await app.openrouter.relay(key.token,prompt);await response.text();const requestId=response.headers.get('x-thot-request-id')!;
  await app.db.transaction(async tx=>{const r=await tx.get('thot_records',requestId),trace=await tx.get('traces',r.trace_id);delete r.model_metadata_version;delete r.requested_model;delete r.returned_model;delete trace.capture_model;delete trace.model_history;await tx.update('thot_records',r.id,r);await tx.update('traces',trace.trace_id,trace);});
  await app.openrouter.recover();const r=await state(app,requestId),view=await app.library.item(owner,r.trace_id);
  assert.equal(r.model_metadata_version,1);assert.equal(view.capture_model.requested_model,prompt.model);assert.equal(view.capture_model.returned_model,'openai/gpt-4.1-mini');assert.equal(view.model_history[0].model,'openai/gpt-4.1-mini');assert.equal(calls,1);
  assert.equal((await app.db.query('SELECT count(*)::int n FROM sale_authorizations')).rows[0].n,0);
});

test('provider errors, redirects, and echoed credentials never escape as provider diagnostics or trigger a retry',async t=>{
  for(const mode of ['json-error','http-error','throw','echo']){
    let calls=0;const app=await fixture(t,{transport:async()=>{calls++;if(mode==='throw')throw Error('network '+providerKey);if(mode==='http-error')return new Response(providerKey,{status:500});if(mode==='json-error')return Response.json({error:{message:providerKey}});return Response.json(completion(providerKey));}}),key=await app.openrouter.connect(owner,consent());
    const response=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'failure-'+mode});const text=await response.text();assert.ok(!text.includes(providerKey));assert.equal(calls,1);
    const again=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'failure-'+mode});await again.text();assert.equal(calls,1);if(mode!=='echo')assert.equal(again.status,409);
    assert.ok(!JSON.stringify(await app.openrouter.status(owner)).includes(providerKey));
  }
});

test('streaming parses byte-fragmented UTF-8, comments, multi-line SSE, tool deltas and usage; DONE waits for durable capture',async t=>{
  const event=(delta:any,finish_reason:any=null,extra:any={})=>({id:'stream-1',choices:[{index:0,delta,finish_reason}],...extra});
  const events=[event({role:'assistant',content:'你好 '}),event({tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'lookup',arguments:'{"q":'}}]}),event({tool_calls:[{index:0,function:{arguments:'"test"}'}}]}),event({},'tool_calls'),event({},'tool_calls',{usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,cost:0.02}})];
  const wire=': OPENROUTER PROCESSING\r\n\r\n'+events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('')+'data: [DONE]\n\n';const bytes=Buffer.from(wire);
  let calls=0;const app=await fixture(t,{transport:async()=>{calls++;return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});}}),key=await app.openrouter.connect(owner,consent());
  const input={...prompt,stream:true,tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}]};
  const response=await app.openrouter.relay(key.token,input,{idempotencyKey:'stream-complete-001'}),text=await response.text();assert.ok(text.endsWith('data: [DONE]\n\n'));assert.match(text,/你好/);assert.doesNotMatch(text,/thot_relay_error/);
  const r=await state(app,response.headers.get('x-thot-request-id')!);assert.equal(r.status,'COMPLETED');assert.equal(r.usage.total_tokens,30);
  const view=await app.library.item(owner,r.trace_id);assert.match(view.content.turns.at(-1).content,/lookup/);assert.match(view.content.turns.at(-1).content,/test/);
  const replay=await app.openrouter.relay(key.token,input,{idempotencyKey:'stream-complete-001'});assert.equal(await replay.text(),text);assert.equal(calls,1);
});

test('stream truncation and midstream errors retain partial history and never report a completed trace',async t=>{
  for(const ending of ['', 'data: '+JSON.stringify({error:{message:providerKey}})+'\n\n']){
    const wire='data: '+JSON.stringify({choices:[{index:0,delta:{content:'Partial useful answer'},finish_reason:null}]})+'\n\n'+ending;
    let calls=0;const app=await fixture(t,{transport:async()=>{calls++;return new Response(wire,{headers:{'content-type':'text/event-stream'}});}}),key=await app.openrouter.connect(owner,consent());
    const response=await app.openrouter.relay(key.token,{...prompt,stream:true},{idempotencyKey:'partial-request-001'}),text=await response.text();assert.match(text,/OPENROUTER_OUTCOME_UNCERTAIN/);assert.ok(!text.includes(providerKey));
    const r=await state(app,response.headers.get('x-thot-request-id')!);assert.equal(r.status,'INTERRUPTED');assert.match((await app.library.item(owner,r.trace_id)).content.turns.at(-1).content,/Partial useful answer/);
    assert.equal((await app.openrouter.relay(key.token,{...prompt,stream:true},{idempotencyKey:'partial-request-001'})).status,409);assert.equal(calls,1);
  }
});

test('input, provider response, retained storage and concurrency limits fail without extra upstream calls',async t=>{
  let calls=0;const app=await fixture(t,{maxRequestBytes:1024,maxResponseBytes:512,maxOwnerConcurrency:1,transport:async()=>{calls++;return Response.json(completion('x'.repeat(600)));}}),key=await app.openrouter.connect(owner,consent());
  await assert.rejects(app.openrouter.relay(key.token,{...prompt,base_url:'https://attacker.test'}),/INVALID_OPENROUTER_REQUEST/);
  await assert.rejects(app.openrouter.relay(key.token,{...prompt,messages:[{role:'user',content:'x'.repeat(1024)}]}),/TOO_LARGE/);assert.equal(calls,0);
  const over=await app.openrouter.relay(key.token,prompt);assert.equal(over.status,409);assert.equal(calls,1);
  const limited=await fixture(t,{maxOwnerBytes:64});const limitedKey=await limited.openrouter.connect(owner,consent());await assert.rejects(limited.openrouter.relay(limitedKey.token,prompt),/STORAGE_LIMIT/);
});

test('concurrent idempotency, tenant concurrency and disconnect drain a running stream without retrying or losing durable partial bytes',async t=>{
  let submitted=0;
  const app=await fixture(t,{maxOwnerConcurrency:1,transport:async(_url,init)=>{
    submitted++;return new Response(new ReadableStream<Uint8Array>({start(c){
      c.enqueue(Buffer.from('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Durable partial content'},finish_reason:null}]})+'\n\n'));
      init!.signal!.addEventListener('abort',()=>c.error(Error('synthetic-abort')),{once:true});
    }}),{headers:{'content-type':'text/event-stream'}});
  }}),key=await app.openrouter.connect(owner,consent());
  const response=await app.openrouter.relay(key.token,{...prompt,stream:true},{idempotencyKey:'inflight-request-001'});
  const reader=response.body!.getReader();assert.match(Buffer.from((await reader.read()).value!).toString(),/Durable partial content/);
  assert.equal((await app.openrouter.relay(key.token,{...prompt,stream:true},{idempotencyKey:'inflight-request-001'})).status,409);
  await assert.rejects(app.openrouter.relay(key.token,{...prompt,stream:true},{idempotencyKey:'inflight-request-002'}),/CONCURRENCY_LIMIT/);assert.equal(submitted,1);
  await app.openrouter.disconnect(owner);const r=await state(app,response.headers.get('x-thot-request-id')!);assert.equal(r.status,'INTERRUPTED');assert.ok(r.parts.length>0);
  assert.match((await app.library.item(owner,r.trace_id)).content.turns.at(-1).content,/Durable partial content/);await reader.cancel();assert.equal(submitted,1);
});

test('client stream cancellation aborts provider work and retains prior response parts; app close drains safely',async t=>{
  let aborted=false;
  const app=await fixture(t,{transport:async(_url,init)=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Already received'},finish_reason:null}]})+'\n\n'));init!.signal!.addEventListener('abort',()=>{aborted=true;c.error(Error('aborted'));},{once:true});}}),{headers:{'content-type':'text/event-stream'}})}),key=await app.openrouter.connect(owner,consent());
  const response=await app.openrouter.relay(key.token,{...prompt,stream:true}),reader=response.body!.getReader();await reader.read();await reader.cancel();assert.equal(aborted,true);
  const r=await state(app,response.headers.get('x-thot-request-id')!);assert.equal(r.status,'INTERRUPTED');assert.ok(r.parts.length);await app.close();
});

test('a billed reply survives optional assessment failure; failed final vault writes become non-retryable captures',async t=>{
  let calls=0;const app=await fixture(t,{transport:async()=>{calls++;return Response.json(completion());}}),key=await app.openrouter.connect(owner,consent());
  app.privacy.assess=async()=>{throw Error('synthetic assessment unavailable');};
  const good=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'assessment-can-fail'});assert.equal(good.status,200);await good.text();
  const trace=await app.db.transaction(tx=>tx.get('traces',good.headers.get('x-thot-trace-id')!));assert.equal(trace.assessment_status,'UNAVAILABLE');assert.equal(trace.display_status,'PRIVATE');
  const original=app.privacy.seal.bind(app.privacy);app.privacy.seal=async(owner,value)=>{if((value as any)?.turns?.length===2)throw Error('synthetic storage failure');return original(owner,value);};
  const failed=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'final-vault-failed'});assert.equal(failed.status,409);assert.equal(failed.headers.get('x-should-retry'),'false');
  const r=await state(app,failed.headers.get('x-thot-request-id')!);assert.equal(r.status,'INTERRUPTED');assert.equal(r.failure_code,'OPENROUTER_CAPTURE_FINALIZATION_FAILED');assert.ok(r.parts.length);
  const retained=await app.privacy.open(owner.id,r.parts[0].ref);assert.match(Buffer.from(retained.bytes_b64,'base64').toString(),/PRIVATE ANSWER/);
  assert.equal((await app.openrouter.relay(key.token,prompt,{idempotencyKey:'final-vault-failed'})).status,409);assert.equal(calls,2);
});

test('deleting a captured trace removes request, response and replay objects without removing the separate provider key',async t=>{
  const app=await fixture(t),key=await app.openrouter.connect(owner,consent()),response=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'delete-request-001'});await response.text();
  const r=await state(app,response.headers.get('x-thot-request-id')!);await app.service.deleteTrace(owner,'delete-openrouter-001',r.trace_id);await app.db.transaction(tx=>app.service.deleteTraceObjects(tx,r.trace_id));
  await assert.rejects(app.privacy.open(owner.id,r.request_ref));await assert.rejects(app.privacy.open(owner.id,r.response_ref));await assert.rejects(app.privacy.open(owner.id,r.parts[0].ref));
  await assert.rejects(app.openrouter.relay(key.token,prompt,{idempotencyKey:'delete-request-001'}),/DELETED/);
  assert.equal((await app.openrouter.status(owner)).requests[0].content_deleted,true);
  assert.equal((await app.openrouter.relay(key.token,prompt)).status,200);
});

test('persistent restart recovers interrupted encrypted parts without resubmitting; completed replay and provider key survive',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-openrouter-restart-'));let calls=0;
  const transport:typeof fetch=async()=>{calls++;return Response.json(completion());};
  let app=await createApplication({dataDir:dir,openrouter:{enabled:true,transport}});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});const key=await app.openrouter.connect(owner,consent());
  const good=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'completed-before-restart'});await good.text();
  const interrupted=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'crash-before-finalization'});await interrupted.text();const id=interrupted.headers.get('x-thot-request-id')!;
  // Model the crash boundary after durable source receipt but before final state
  // commits. This preserves real encrypted request/response objects from the relay.
  await app.db.transaction(async tx=>{const r=await tx.get('thot_records',id);r.status='INFLIGHT';delete r.finished_at;delete r.response_ref;await tx.update('thot_records',id,r);});
  await app.close();app=await createApplication({dataDir:dir,openrouter:{enabled:true,transport}});
  assert.equal(calls,2);const r=await state(app,id);assert.equal(r.status,'INTERRUPTED');assert.equal(r.failure_code,'OPENROUTER_RESTART_OUTCOME_UNCERTAIN');
  assert.match((await app.library.item(owner,r.trace_id)).content.turns.at(-1).content,/PRIVATE ANSWER/);
  const replay=await app.openrouter.relay(key.token,prompt,{idempotencyKey:'completed-before-restart'});assert.equal(replay.headers.get('x-thot-replayed'),'true');await replay.text();
  assert.equal((await app.openrouter.relay(key.token,prompt,{idempotencyKey:'crash-before-finalization'})).status,409);assert.equal(calls,2);
});

test('one exact provider key cannot attach to another wallet, including races, disconnect and restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-key-binding-'));let app=await createApplication({dataDir:dir,openrouter:{enabled:true}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const attempts=await Promise.allSettled([app.openrouter.connect(owner,consent()),app.openrouter.connect(other,consent())]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  const loser=attempts.find(r=>r.status==='rejected') as PromiseRejectedResult;
  assert.equal(loser.reason.message,'OPENROUTER_CREDENTIAL_REJECTED');
  const winner=attempts[0].status==='fulfilled'?owner:other,denied=winner===owner?other:owner;
  await app.openrouter.disconnect(winner);await app.close();app=await createApplication({dataDir:dir,openrouter:{enabled:true}});
  await assert.rejects(app.openrouter.connect(denied,consent()),/^Error: OPENROUTER_CREDENTIAL_REJECTED$/);
  await app.openrouter.connect(winner,consent());
  // Distinct provider keys cannot establish whether these are one or two upstream accounts.
  await app.openrouter.connect(denied,consent('sk-or-v1-DIFFERENT-KEY-SAME-ACCOUNT-IS-UNKNOWN'));
  const binding=(await app.db.transaction(tx=>tx.list('thot_records'))).filter(r=>r.kind==='openrouter-key-binding');
  assert.equal(binding.length,2);assert.ok(!JSON.stringify(binding).includes(providerKey));
  const exposed=JSON.stringify(await app.openrouter.status(winner));assert.ok(!exposed.includes('binding'));assert.ok(!exposed.includes(denied.id));
});

test('connection sale policy applies to subsequent completions and preserves licensed context with targeted filtering',async t=>{
  const output={...completion('The update is correct.'),choices:[{index:0,message:{role:'assistant',content:'The update is correct.',tool_calls:[{id:'call1',type:'function',function:{name:'check',arguments:'{"password":"hunter22","result":"pass"}'}}]},finish_reason:'tool_calls'}]};
  const app=await fixture(t,{transport:async()=>Response.json(output)});
  const privateKey=await app.openrouter.connect(owner,consent()),before=await app.openrouter.relay(privateKey.token,prompt);await before.text();
  // The HTTP route verifies and activates the signed policy before calling the
  // relay. This scoped fixture represents that trusted, unbound policy record.
  await app.db.transaction(tx=>tx.insert('thot_records','stream:validated-fixture',owner.id,{kind:'stream_policy',active:true}));
  const key=await app.openrouter.connect(owner,consent(),{salePolicyId:'stream:validated-fixture'});
  const input={model:prompt.model,tools:[{type:'function',function:{name:'check',description:'Check cache isolation',parameters:{type:'object'}}}],messages:[{role:'system',content:'Explain every tradeoff.'},{role:'developer',content:'Preserve the locking invariant.'},{role:'user',content:'Debug the cache for alice@example.test; password=hunter22'},{role:'tool',tool_call_id:'call0',name:'read_file',content:'Useful previous result'}]};
  const result=await app.openrouter.relay(key.token,input);await result.text();
  const trace=await app.db.transaction(tx=>tx.get('traces',result.headers.get('x-thot-trace-id')!)),prior=await app.db.transaction(tx=>tx.get('traces',before.headers.get('x-thot-trace-id')!));
  assert.equal(trace.sale_policy_id,'stream:validated-fixture');assert.equal(prior.sale_policy_id,undefined);assert.equal(prior.display_status,'PRIVATE');
  assert.equal(trace.rights_status,'eligible');assert.equal(trace.rights_confirmed,true);
  const content=await app.privacy.open(owner.id,trace.scrub_ref),text=JSON.stringify(content);
  assert.deepEqual(content.turns.map((m:any)=>m.role),['system','system','developer','user','tool','assistant']);
  for(const retained of ['Available tool definitions','Explain every tradeoff','locking invariant','call0','read_file','Useful previous result','call1','result','pass'])assert.ok(text.includes(retained),retained);
  for(const removed of ['hunter22','alice@example.test'])assert.ok(!text.includes(removed));
  assert.match(text,/REDACTED/);assert.match(text,/EMAIL_/);
  const original=await app.openrouter.source(owner,result.headers.get('x-thot-request-id')!);assert.match(JSON.stringify(original.request),/hunter22/);
});

test('workflow labels follow contributor text, not the presence of a function tool',async()=>{
 const {inferTraceWorkflow}=await import('../packages/market/src/integrations.ts');
 assert.equal(inferTraceWorkflow({turns:[{role:'system',content:'function test code'},{role:'user',content:'Research the scientific evidence for this hypothesis.'},{role:'tool',content:'function output'}]},'general'),'research');
 assert.equal(inferTraceWorkflow({turns:[{role:'user',content:'Write a birthday greeting.'}]},'general'),'chat');
 assert.equal(inferTraceWorkflow({turns:[{role:'user',content:'Debug the Python cache.'}]},'general'),'coding');
});
