import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalHash } from '../packages/protocol/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { InferenceGateway } from '../packages/market/src/inference-gateway.ts';
import { OpenAIResponsesProvider, maximumReservation, meterResponse, validateRateCard, type InferenceRateCard } from '../packages/inference/src/index.ts';
import { createDemoMandate, demoUser, demoBuyer, demoOperator, demoSettlement, importDemo, policyInput } from '../packages/market/src/fixtures.ts';
import type { Document } from '../packages/storage/src/index.ts';
import { accountId } from '../packages/ledger/src/index.ts';

const now='2026-09-06T00:00:00.000Z';
// Entirely fictional rates/model for intercepted offline transports; not a current provider price.
const card:InferenceRateCard={version:'offline-test/1',model:'offline-test-model',service_tier:'default',currency:'USD',input_micro_usd_per_million:'4000000',cached_micro_usd_per_million:'2000000',cache_write_micro_usd_per_million:'8000000',output_micro_usd_per_million:'20000000',max_input_tokens:1000,max_output_tokens:250,verified_at:now,expires_at:'2026-09-07T00:00:00.000Z',verified:true,example_only:false};
function response(patch:Document={}){return {id:'resp_offline_123',model:card.model,service_tier:'default',status:'completed',usage:{input_tokens:1000,output_tokens:200,total_tokens:1200,input_tokens_details:{cached_tokens:400,cache_write_tokens:500}},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Offline metered response.'}]}],...patch};}
function provider(options:{reply?:Document;count?:number;failCount?:boolean;failGenerate?:boolean;delay?:()=>Promise<void>;clock?:()=>Date}={}){
  const calls:Array<{url:string;body:Document;options:RequestInit}>=[];
  const transport=async(url:any,init:any)=>{
    calls.push({url:String(url),body:JSON.parse(init.body),options:init});
    if(String(url).endsWith('input_tokens')){
      if(options.failCount)throw new Error('RAW PRIVATE TRANSPORT FAILURE');
      return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:options.count??1000}),{headers:{'content-type':'application/json'}});
    }
    await options.delay?.();if(options.failGenerate)throw new Error('RAW PRIVATE TRANSPORT FAILURE');
    return new Response(JSON.stringify(options.reply??response()),{headers:{'content-type':'application/json'}});
  };
  return {provider:new OpenAIResponsesProvider({apiKey:'offline-test-secret',rateCard:card,clock:options.clock??(()=>new Date(now))},transport as typeof fetch),calls};
}
async function setup(t:any,options:Parameters<typeof provider>[0]={}){
  const p=provider(options),a=await createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-inference-')),config:{clock:options.clock??(()=>new Date(now))},inference:{provider:p.provider,dailyBudgetMinor:'100'}});t.after(a.close);
  await a.service.createPolicy(demoUser,'inference-policy',policyInput(a.service));await importDemo(a.service,demoUser,'coding','inference-import');await createDemoMandate(a.service,'general','inference-mandate');await a.service.runWorker();
  const preview=await a.service.preview(demoUser,(await a.service.candidates(demoUser))[0]!.candidate_id),{release,...fields}=preview;
  await a.service.authorize(demoUser,'inference-authorize',{...fields,payout_preference:'inference_credit'});await a.service.runWorker();
  const e=(await a.service.earnings(demoUser)).entitlements[0]!;
  const input={entitlement_id:e.entitlement_id,prompt:'Private test prompt: do not log this text.',max_cost_minor:maximumReservation(card),provider:'openai',rate_card_hash:canonicalHash(card),consent_external_processing:true};
  return {...a,...p,e,input};
}

test('rate cards require explicit fresh verified prices, exact money, and bounded model limits',()=>{
  validateRateCard(card,new Date(now));assert.equal(maximumReservation(card),'2');
  for(const patch of [{verified:false},{example_only:true},{input_micro_usd_per_million:1.5},{service_tier:'priority'},{expires_at:now},{verified_at:'2026-09-07T00:00:00Z'},{max_output_tokens:15},{url:'http://127.0.0.1/'}])assert.throws(()=>validateRateCard({...card,...patch} as any,new Date(now)));
});
test('metering separately counts ordinary/cached/cache-write/output tokens and rounds once',()=>{
  const result=meterResponse(response(),card);assert.equal(result.actual_minor,'1');assert.equal(result.status,'COMPLETED');
  assert.equal(meterResponse(response({status:'incomplete'}),card).status,'INCOMPLETE');
  const noCache={...card,cache_write_micro_usd_per_million:null};assert.throws(()=>meterResponse(response(),noCache),/UNPRICED_CACHE_WRITES/);
  for(const patch of [{model:'unexpected-model'},{service_tier:'priority'},{usage:null},{usage:{...response().usage,total_tokens:999}},{usage:{...response().usage,input_tokens_details:{cached_tokens:2000,cache_write_tokens:0}}},{output:[{type:'function_call',name:'steal'}]}])assert.throws(()=>meterResponse(response(patch),card));
});
test('inference is disabled without configured provider and nonzero global spending cap',async t=>{
  const a=await setup(t),disabled=new InferenceGateway(a.service);
  assert.equal(disabled.capabilities().enabled,false);await assert.rejects(disabled.create(demoUser,'disabled-request',a.input),/INFERENCE_DISABLED/);
  const zero=new InferenceGateway(a.service,a.provider);assert.equal(zero.capabilities().enabled,false);await assert.rejects(zero.create(demoUser,'zero-budget-request',a.input),/DAILY_BUDGET/);assert.equal(a.calls.length,0);
});
test('exact provider/rate consent, owner, currency and budget gates run before transmission',async t=>{
  const a=await setup(t);
  for(const patch of [{consent_external_processing:false},{rate_card_hash:'changed'},{provider:'arbitrary'},{max_cost_minor:'0'},{endpoint:'https://attacker.invalid'}])await assert.rejects(a.inference.create(demoUser,'bad-'+canonicalHash(patch),{...a.input,...patch}));
  await assert.rejects(a.inference.create(demoBuyer,'buyer-inference-request',a.input),/FORBIDDEN/);
  await assert.rejects(a.inference.create({id:'other-user',role:'user'},'wrong-owner-request',a.input),/NOT_FOUND/);
  assert.equal(a.calls.length,0);assert.equal((await a.inference.list(demoUser)).length,0);
});
test('metered success: encrypted prompt/output, atomic reservation and payable, no cash paid or duplicate generation',async t=>{
  const a=await setup(t);const created=await a.inference.create(demoUser,'metered-create',a.input);
  assert.equal((await a.inference.create(demoUser,'metered-create',a.input)).request_id,created.request_id);
  await assert.rejects(a.inference.create(demoUser,'metered-create',{...a.input,prompt:'changed'}),/IDEMPOTENCY_CONFLICT/);
  const first=await a.inference.execute(demoUser,created.request_id);assert.equal(first.status,'COMPLETED');assert.equal(first.output.text,'Offline metered response.');assert.equal(first.actual_minor,'1');
  assert.deepEqual(await a.inference.execute(demoUser,created.request_id),first);assert.equal(a.calls.length,2);
  const [count,generate]=a.calls;assert.equal(count!.url,'https://api.openai.com/v1/responses/input_tokens');assert.equal(generate!.url,'https://api.openai.com/v1/responses');
  assert.equal(count!.body.input,generate!.body.input);assert.equal(generate!.body.store,false);assert.deepEqual(generate!.body.tools,[]);assert.equal(generate!.options.redirect,'error');
  assert.equal((await a.service.earnings(demoUser)).entitlements[0]!.available_minor,'6499');
  const journal=(await a.db.query("SELECT e.account_id,e.amount::text FROM ledger_entries e JOIN ledger_transactions j ON j.id=e.transaction_id WHERE j.reference=$1",['usage:'+first.reservation_id])).rows;
  assert.ok(journal.some(j=>j.account_id===accountId('USD','network','LIABILITY:inference_provider_payable')&&j.amount==='-1'));assert.ok(!journal.some(j=>j.account_id===accountId('USD','network','ASSET:cash')));
  const storage=JSON.stringify((await a.db.query('SELECT document FROM inference_requests')).rows),audit=JSON.stringify((await a.db.query('SELECT payload FROM audit_events')).rows);
  for(const secret of [a.input.prompt,'Offline metered response.','offline-test-secret']){assert.ok(!storage.includes(secret));assert.ok(!audit.includes(secret));}
  await assert.rejects(a.inference.get({id:'other-user',role:'user'},created.request_id),/NOT_FOUND/);
  assert.equal((await a.service.reconciliation(demoOperator)).balanced,true);
});
test('preflight failure releases all reserved credit without sending a generation request',async t=>{
  const a=await setup(t,{failCount:true}),r=await a.inference.create(demoUser,'failed-preflight-create',a.input),result=await a.inference.execute(demoUser,r.request_id);
  assert.equal(result.status,'FAILED');assert.equal(result.actual_minor,'0');assert.equal(a.calls.length,1);assert.equal((await a.service.earnings(demoUser)).entitlements[0]!.available_minor,'6500');
  assert.ok(!JSON.stringify(result).includes('RAW PRIVATE'));await a.inference.execute(demoUser,r.request_id);assert.equal(a.calls.length,1);
});
test('unknown generation charge keeps reservation, prevents retries/new requests and rejects manual demo settlement',async t=>{
  const a=await setup(t,{failGenerate:true}),r=await a.inference.create(demoUser,'uncertain-create',a.input),result=await a.inference.execute(demoUser,r.request_id);
  assert.equal(result.status,'UNCERTAIN');assert.equal(result.actual_minor,undefined);assert.equal((await a.service.earnings(demoUser)).entitlements[0]!.available_minor,'6498');
  await a.inference.execute(demoUser,r.request_id);assert.equal(a.calls.length,2);
  await assert.rejects(a.inference.create(demoUser,'blocked-new-request',a.input),/RECONCILIATION_REQUIRED/);
  await assert.rejects(a.service.settleInference(demoSettlement,'cannot-demo-refund',result.reservation_id,{actual_minor:'0'}),/MANAGED_INFERENCE_RESERVATION/);
  await assert.rejects(a.inference.cancel(demoUser,'cannot-cancel-started',r.request_id),/ALREADY_STARTED/);
});
test('concurrent execution submits once; durable quotas and cancellations preserve accounting',async t=>{
  let release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});const a=await setup(t,{delay:()=>delayed});
  const r=await a.inference.create(demoUser,'concurrent-create',a.input);const first=a.inference.execute(demoUser,r.request_id);
  // SQL claim completes before either generation settles.
  let current;for(let i=0;i<30;i++){current=await a.inference.get(demoUser,r.request_id);if(current.status==='PROCESSING')break;await new Promise(r=>setTimeout(r,2));}
  assert.equal(current?.status,'PROCESSING');assert.equal((await a.inference.execute(demoUser,r.request_id)).status,'PROCESSING');release();await first;assert.equal(a.calls.length,2);
  const cap=new InferenceGateway(a.service,a.provider,'4');const queued=await cap.create(demoUser,'quota-second',a.input);
  await assert.rejects(cap.create(demoUser,'quota-third',a.input),/DAILY_BUDGET/);
  await cap.cancel(demoUser,'cancel-second',queued.request_id);assert.equal((await a.service.reconciliation(demoOperator)).balanced,true);
});
test('expired queued requests refund; interrupted processing remains held across gateway restart and content retention deletes sealed text',async t=>{
  let time=now;const a=await setup(t,{clock:()=>new Date(time)});
  const queued=await a.inference.create(demoUser,'expiring-create',a.input);time='2026-09-06T00:11:00.000Z';await a.inference.sweep();assert.equal((await a.inference.get(demoUser,queued.request_id)).status,'CANCELLED');
  const processing=await a.inference.create(demoUser,'interrupted-create',a.input);
  await a.db.transaction(async tx=>{const r=await tx.get('inference_requests',processing.request_id);r.status='PROCESSING';r.processing_deadline='2026-09-06T00:12:00.000Z';await tx.update('inference_requests',r.request_id,r);});
  time='2026-09-06T00:14:00.000Z';const restarted=new InferenceGateway(a.service,a.provider,'100');await restarted.sweep();assert.equal((await restarted.get(demoUser,processing.request_id)).status,'UNCERTAIN');assert.equal(a.calls.length,0);
  await restarted.deleteContent(demoUser,'delete-interrupted-content',processing.request_id);assert.equal((await restarted.get(demoUser,processing.request_id)).content_deleted,true);
  time='2026-10-08T00:00:00.000Z';await restarted.sweep();assert.equal((await restarted.get(demoUser,queued.request_id)).content_deleted,true);
});
test('incomplete metered output is charged once and invalid usage holds rather than fabricating zero cost',async t=>{
  const a=await setup(t,{reply:response({status:'incomplete'})}),r=await a.inference.create(demoUser,'incomplete-request',a.input);
  const result=await a.inference.execute(demoUser,r.request_id);assert.equal(result.status,'INCOMPLETE');assert.equal(result.actual_minor,'1');
  const faulty=provider({reply:response({usage:null})});const gateway=new InferenceGateway(a.service,faulty.provider,'100');const b=await gateway.create(demoUser,'bad-usage-request',a.input);
  assert.equal((await gateway.execute(demoUser,b.request_id)).status,'UNCERTAIN');
});

test('completed inference is explicitly captured once as private P0 operator evidence without another provider call',async t=>{
  const a=await setup(t),created=await a.inference.create(demoUser,'capture-create',a.input);
  await a.inference.execute(demoUser,created.request_id);assert.equal(a.calls.length,2);
  const consent={rights_confirmed:true,model_output_licensed:true,category:'research_flow'};
  const captured=await a.inferenceCapture.capture(demoUser,'capture-completed',created.request_id,consent);
  assert.equal(captured.duplicate,false);assert.equal(captured.status,'AVAILABLE');
  assert.equal(captured.capture_receipt.path,'operator_capture');assert.equal(captured.capture_receipt.confidence_tier,'P0_OPERATOR');
  assert.match(captured.capture_receipt.limitations.join(' '),/No independent witness.*TEE provenance/);
  const repeated=await a.inferenceCapture.capture(demoUser,'capture-completed-again',created.request_id,consent);
  assert.equal(repeated.duplicate,true);assert.equal(repeated.trace_id,captured.trace_id);assert.equal(a.calls.length,2);
  const trace=await a.service.trace(demoUser,captured.trace_id);
  assert.equal(trace.provenance_status,'OPERATOR_CAPTURED');assert.equal(trace.provenance.path,'operator_capture');
  const stored=(await a.db.query('SELECT document FROM traces WHERE id=$1',[captured.trace_id])).rows[0]!.document;
  assert.equal(stored.inference_request_id,created.request_id);assert.ok(stored.raw_ref&&stored.scrub_ref);
  assert.ok(!JSON.stringify(stored).includes(a.input.prompt));assert.ok(!JSON.stringify(stored).includes('Offline metered response.'));
  await assert.rejects(a.inferenceCapture.capture(demoUser,'capture-consent-conflict',created.request_id,{...consent,category:'general'}),/CONSENT_CONFLICT/);
});

test('capture requires ownership, completed retained content, and explicit output rights',async t=>{
  const a=await setup(t),queued=await a.inference.create(demoUser,'capture-gates-create',a.input);
  const consent={rights_confirmed:true,model_output_licensed:true};
  await assert.rejects(a.inferenceCapture.capture(demoUser,'capture-queued',queued.request_id,consent),/REQUIRES_COMPLETED/);
  await assert.rejects(a.inferenceCapture.capture(demoBuyer,'capture-buyer',queued.request_id,consent),/FORBIDDEN/);
  await assert.rejects(a.inferenceCapture.capture({id:'other-user',role:'user'},'capture-other-owner',queued.request_id,consent),/NOT_FOUND/);
  await assert.rejects(a.inferenceCapture.capture(demoUser,'capture-no-rights',queued.request_id,{...consent,rights_confirmed:false}),/RIGHTS_CONFIRMATION_REQUIRED/);
  await assert.rejects(a.inferenceCapture.capture(demoUser,'capture-no-output-choice',queued.request_id,{rights_confirmed:true}),/OUTPUT_CHOICE_REQUIRED/);
  await a.inference.execute(demoUser,queued.request_id);await a.inference.deleteContent(demoUser,'capture-delete-content',queued.request_id);
  await assert.rejects(a.inferenceCapture.capture(demoUser,'capture-deleted',queued.request_id,consent),/CONTENT_UNAVAILABLE/);
  assert.equal(a.calls.length,2);
});
