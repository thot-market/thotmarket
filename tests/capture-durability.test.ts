import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
// @ts-expect-error Browser native verifier.
import {verifyProxyCapture} from '../apps/dashboard/agent-capture-ui.js';

const actor={id:'demo-user',role:'user' as const};
const baseTime=Date.parse('2026-09-12T12:00:00Z');
async function setup(t:any){
  const dir=await mkdtemp(join(tmpdir(),'thot-durable-'));let time=baseTime;
  const app=await createApplication({dataDir:dir,memory:true,config:{clock:()=>new Date(time)}});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,advance:(ms:number)=>{time+=ms;}};
}
function part(sequence:number,content:any='Review the code.',response?:any){
  const value={sequence,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from(JSON.stringify({model:'claude-fixture',messages:[{role:'user',content}]})).toString('base64'),response_body_b64:Buffer.from(JSON.stringify(response??{type:'message',content:[{type:'text',text:'The code is reviewed.'}],stop_reason:'end_turn'})).toString('base64'),status:200,content_type:'application/json',started_at:new Date(baseTime).toISOString(),finished_at:new Date(baseTime).toISOString(),complete:true};
  return {...value,commitment:canonicalHash(value)};
}
function manifest(id:string,parts:any[]){
  const value={format:'thot.proxy-capture/2',capture_id:id,client:'claude',started_at:parts[0].started_at,finished_at:parts.at(-1).finished_at,parts:parts.map(({sequence,commitment})=>({sequence,commitment}))};
  return {...value,root:canonicalHash(value)};
}

test('unknown request, response and nested tool content stays recoverable with exact original proof',async t=>{
  const {app}=await setup(t);
  for(const [label,content,response] of [
    ['request',[{type:'future_block',payload:'synthetic unknown request'}],undefined],
    ['response','Read this.',{type:'message',content:[{type:'future_output',value:'synthetic output'}],stop_reason:'end_turn'}],
    ['nested',[{type:'tool_result',tool_use_id:'tool-1',content:[{type:'future_tool_result',value:3}]}],undefined],
  ] as const){
    const c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true}),p=part(1,content,response),bundle=manifest(c.capture_id,[p]);
    await app.agentCapture.part(c.capture_id,c.upload_token,'part-'+label,{part:p});
    const saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'complete-'+label,{bundle});
    assert.equal(saved.status,'SAVED');assert.equal(saved.projection.status,'PARTIAL');
    assert.equal(saved.projection.issues[0].sequence,1);assert.equal(saved.projection.issues[0].error_code,'UNSUPPORTED_PROXY_CONTENT');
    const proof=await app.agentCapture.proof(actor,c.capture_id);
    assert.deepEqual(proof.bundle,bundle);assert.deepEqual((await app.agentCapture.proofPart(actor,c.capture_id,1)).part,p);
    const verified=await verifyProxyCapture(proof.bundle,async(n:number)=>(await app.agentCapture.proofPart(actor,c.capture_id,n)).part);
    assert.equal(verified.exchanges,1);
    const cards=await app.portfolio.list(actor);assert.ok(cards.items.some(i=>i.trace_id===saved.trace_id&&i.projection?.status==='PARTIAL'));
    await assert.rejects(app.agentCapture.proof({id:'other-user',role:'user'},c.capture_id),/NOT_FOUND/);
  }
});

test('assessment failure cannot undo readable private work; retry leaves original receipt unchanged',async t=>{
  const {app}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true}),p=part(1),bundle=manifest(c.capture_id,[p]);
  await app.agentCapture.part(c.capture_id,c.upload_token,'stage-before-assessment',{part:p});
  const assess=app.privacy.assess.bind(app.privacy);app.privacy.assess=async()=>{throw Error('fixture downstream unavailable');};
  const saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'save-despite-assessment',{bundle});
  assert.equal(saved.status,'SAVED');assert.equal(saved.projection.status,'READY');assert.equal(saved.release_preparation.status,'ERROR');
  assert.equal((await app.library.item(actor,saved.trace_id)).content.turns[1].content,'The code is reviewed.');
  const original=await app.agentCapture.proof(actor,c.capture_id);
  app.privacy.assess=assess;
  assert.equal((await app.service.runWorker()).failed,0);
  const after=await app.agentCapture.status(actor,c.capture_id);
  assert.equal(after.result.projection.status,'READY');assert.equal(after.result.release_preparation.status,'READY');assert.equal(after.result.trace_id,saved.trace_id);
  assert.deepEqual((await app.agentCapture.proof(actor,c.capture_id)).receipt,original.receipt);
  assert.deepEqual((await app.agentCapture.proof(actor,c.capture_id)).bundle,original.bundle);
});

test('retrievable checkpoints grow one trace, survive token expiry and reject altered prefixes',async t=>{
  const {app,advance}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true}),p1=part(1),p2=part(2,'Continue with tests.');
  await app.agentCapture.part(c.capture_id,c.upload_token,'checkpoint-part-one',{part:p1});
  const first=await app.agentCapture.checkpoint(c.capture_id,c.upload_token,'checkpoint-one',{bundle:manifest(c.capture_id,[p1])});
  assert.equal(first.status,'CHECKPOINT_SAVED');
  assert.equal((await app.agentCapture.proof(actor,c.capture_id)).bundle.parts.length,1);
  await app.agentCapture.part(c.capture_id,c.upload_token,'checkpoint-part-two',{part:p2});
  await assert.rejects(app.agentCapture.proofPart(actor,c.capture_id,2),/CAPTURE_PART_NOT_FOUND/,'Staged but not checkpointed data is not claimed as verified');
  const second=await app.agentCapture.checkpoint(c.capture_id,c.upload_token,'checkpoint-two',{bundle:manifest(c.capture_id,[p1,p2])});
  assert.equal(second.trace_id,first.trace_id);
  const count=await app.db.query("SELECT count(*)::int AS n FROM traces WHERE owner_id=$1",[actor.id]);assert.equal(count.rows[0].n,1);
  await assert.rejects(app.agentCapture.checkpoint(c.capture_id,c.upload_token,'checkpoint-regression',{bundle:manifest(c.capture_id,[p1])}),/CHECKPOINT_REGRESSION/);
  const changed=part(1,'Altered prefix.');
  await assert.rejects(app.agentCapture.checkpoint(c.capture_id,c.upload_token,'checkpoint-changed-prefix',{bundle:manifest(c.capture_id,[changed,p2])}),/CHECKPOINT_PREFIX_CHANGED/);
  advance(86401*1000);await app.service.sweepRetention();await app.service.runWorker();
  assert.equal((await app.agentCapture.status(actor,c.capture_id)).status,'EXPIRED');
  assert.deepEqual((await app.agentCapture.proofPart(actor,c.capture_id,1)).part,p1);
  assert.equal((await app.agentCapture.proof(actor,c.capture_id)).bundle.parts.length,2);
  await app.service.deleteTrace(actor,'delete-verified-checkpoints',first.trace_id);await app.service.runWorker();
  await assert.rejects(app.agentCapture.proof(actor,c.capture_id),/CAPTURE_CONTENT_UNAVAILABLE/);
});

test('raw checkpoint remains committed after process interruption before projection',async t=>{
  const {app}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true}),p=part(1);
  await app.agentCapture.part(c.capture_id,c.upload_token,'interruption-part',{part:p});
  const project=app.agentCapture.project.bind(app.agentCapture);app.agentCapture.project=async()=>{};
  const saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'interruption-complete',{bundle:manifest(c.capture_id,[p])});
  assert.equal(saved.projection.status,'PENDING');assert.equal((await app.agentCapture.proofPart(actor,c.capture_id,1)).part.commitment,p.commitment);
  app.agentCapture.project=project;await app.service.runWorker();
  assert.equal((await app.agentCapture.status(actor,c.capture_id)).result.projection.status,'READY');
});

test('longer checkpoint sequences read each new body once per stage, preserve originals and reclaim obsolete readable views',async t=>{
  const {app}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true}),parts:any[]=[];
  const open=app.privacy.open.bind(app.privacy);let bodyReads=0;
  app.privacy.open=async(...args)=>{const value=await open(...args);if(value.sequence)bodyReads++;return value;};
  let firstProof:any,last:any;
  for(let i=1;i<=12;i++){
    const p=part(i,'Question '+i);parts.push(p);await app.agentCapture.part(c.capture_id,c.upload_token,'growth-part-'+i,{part:p});
    last=await app.agentCapture.checkpoint(c.capture_id,c.upload_token,'growth-checkpoint-'+i,{bundle:manifest(c.capture_id,parts)});
    if(i===1)firstProof=await app.agentCapture.proof(actor,c.capture_id);
  }
  assert.equal(bodyReads,24,'Later checkpoints must not reread all earlier raw bodies');
  assert.equal(last.capture_summary.normalized,12);assert.equal(last.capture_summary.exchanges,12);
  const final=await app.agentCapture.complete(c.capture_id,c.upload_token,'same-root-final',{bundle:manifest(c.capture_id,parts)});
  assert.equal(final.trace_id,last.trace_id);assert.equal(final.status,'SAVED');
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM trace_bundles WHERE owner_id=$1',[actor.id])).rows[0].n,12,'Finalizing the current root must reuse its immutable bundle');
  assert.equal((await app.service.runWorker()).failed,0);
  const record=await app.db.transaction(tx=>tx.get('traces',last.trace_id,actor.id));assert.equal(record.projection_refs.length,0);
  assert.ok((await app.library.item(actor,last.trace_id)).content.turns.some((t:any)=>t.content==='Question 12'));
  const original=await app.db.transaction(tx=>tx.get('provenance_receipts',firstProof.receipt.receipt_id,actor.id));assert.deepEqual(original.receipt,firstProof.receipt);
  assert.equal((await app.agentCapture.proof(actor,c.capture_id)).bundle.parts.length,12);
});

test('tool discovery and server web search stay readable, and owner reprocessing preserves the exact proof',async t=>{
  const {app}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});
  // Sanitized reproduction of the three unsupported block kinds in the failed
  // real capture; schemas checked against Anthropic's tool-search/web-search docs.
  const p=part(1,[{type:'tool_result',tool_use_id:'tool-discovery',content:[{type:'tool_reference',tool_name:'Read'}]}],{type:'message',content:[
    {type:'server_tool_use',id:'search-one',name:'web_search',input:{query:'synthetic packet'}},
    {type:'web_search_tool_result',tool_use_id:'search-one',content:[{type:'web_search_result',title:'Synthetic packet',url:'https://example.com/packet',encrypted_content:'opaque-provider-context'}]},
    {type:'text',text:'The packet documents the control condition.'}
  ],stop_reason:'end_turn'}),bundle=manifest(c.capture_id,[p]);
  await app.agentCapture.part(c.capture_id,c.upload_token,'tools-part',{part:p});
  const saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'tools-save',{bundle});assert.equal(saved.projection.status,'READY');
  const content=JSON.stringify((await app.library.item(actor,saved.trace_id)).content);
  assert.match(content,/Discovered tool: Read/);assert.match(content,/Synthetic packet/);assert.match(content,/control condition/);assert.doesNotMatch(content,/opaque-provider-context/);
  const before=await app.agentCapture.proof(actor,c.capture_id);
  await assert.rejects(app.library.reprocess({id:'other-user',role:'user'},'other-rebuild',saved.trace_id),/NOT_FOUND/);
  await app.library.reprocess(actor,'owner-rebuild',saved.trace_id);assert.equal((await app.service.runWorker()).failed,0);
  assert.deepEqual(await app.agentCapture.proof(actor,c.capture_id),before);assert.equal((await app.library.item(actor,saved.trace_id)).projection,'READY');
});

test('a connection failure before upstream headers preserves the attempt and does not poison later saves',async t=>{
  const {app}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});
  const {commitment:_old,...attempt}=part(1);Object.assign(attempt,{status:0,complete:false,response_body_b64:'',content_type:''});
  const failed={...attempt,commitment:canonicalHash(attempt)},success=part(2,'Try the next prompt.');
  await app.agentCapture.part(c.capture_id,c.upload_token,'no-headers-attempt',{part:failed});
  const first=await app.agentCapture.checkpoint(c.capture_id,c.upload_token,'no-headers-checkpoint',{bundle:manifest(c.capture_id,[failed])});
  assert.equal(first.capture_summary.interrupted,1);assert.equal(first.projection.status,'UNREADABLE');
  await app.agentCapture.part(c.capture_id,c.upload_token,'after-no-headers',{part:success});
  const final=await app.agentCapture.complete(c.capture_id,c.upload_token,'after-no-headers-final',{bundle:manifest(c.capture_id,[failed,success])});
  assert.equal(final.trace_id,first.trace_id);assert.equal(final.capture_summary.exchanges,2);assert.equal(final.capture_summary.interrupted,1);assert.equal(final.capture_summary.normalized,1);
  assert.equal((await app.library.item(actor,final.trace_id)).state,'INTERRUPTED');
  assert.deepEqual((await app.agentCapture.proofPart(actor,c.capture_id,1)).part,failed);
});

test('a long private text turn remains fully readable beyond release-assessment limits',async t=>{
  const {app}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});
  const text='LONG_TURN_START\n'+'Synthetic document text. '.repeat(13000)+'\nLONG_TURN_END';
  const p=part(1,text),bundle=manifest(c.capture_id,[p]);await app.agentCapture.part(c.capture_id,c.upload_token,'long-owner-part',{part:p});
  const saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'long-owner-complete',{bundle});
  assert.equal(saved.projection.status,'READY');assert.equal(saved.release_preparation.status,'DEFERRED');assert.equal(saved.release_preparation.error_code,'RELEASE_CONTENT_LIMIT');
  assert.equal((await app.library.item(actor,saved.trace_id)).content.turns[0].content,text);
  const trace=await app.db.transaction(tx=>tx.get('traces',saved.trace_id));assert.equal(trace.display_status,'PRIVATE');assert.equal(trace.rights_id,undefined);assert.equal(trace.scrub_ref,undefined);
  assert.equal((await app.agentCapture.proof(actor,c.capture_id)).bundle.root,bundle.root);
  assert.equal((await app.library.operator({id:'operator',role:'operator_security'})).summary.readable,1);
  assert.equal((await app.portfolio.list(actor)).items[0].appraisal,undefined,'A deferred release must not imply an appraisal or eligibility');
});

test('crossing the total release limit preserves the owner view and removes stale release eligibility',async t=>{
  const {app}=await setup(t),c=await app.agentCapture.begin(actor,{client:'claude',rights_confirmed:true,model_output_licensed:true});
  const parts=[];
  for(let i=1;i<=22;i++){
    const p=part(i,'Synthetic paragraph '+i+'\n'+'x'.repeat(95000));parts.push(p);
    await app.agentCapture.part(c.capture_id,c.upload_token,'large-total-part-'+i,{part:p});
    if(i===1){const saved=await app.agentCapture.checkpoint(c.capture_id,c.upload_token,'large-total-first',{bundle:manifest(c.capture_id,parts)});assert.equal(saved.trace_status,'AVAILABLE');}
  }
  const bundle=manifest(c.capture_id,parts),saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'large-total-final',{bundle});
  assert.equal(saved.projection.status,'READY');assert.equal(saved.release_preparation.status,'DEFERRED');assert.equal(saved.trace_status,'REJECTED');
  const item=await app.library.item(actor,saved.trace_id);assert.equal(item.content.turns.length,44);assert.match(item.content.turns[42].content,/Synthetic paragraph 22/);
  const trace=await app.db.transaction(tx=>tx.get('traces',saved.trace_id));assert.equal(trace.rights_id,undefined);assert.equal(trace.scrub_ref,undefined);assert.equal(trace.rights_status,'manual_review');
  const proof=await app.agentCapture.proof(actor,c.capture_id);assert.equal(proof.bundle.root,bundle.root);
  assert.equal((await verifyProxyCapture(proof.bundle,async(n:number)=>(await app.agentCapture.proofPart(actor,c.capture_id,n)).part)).exchanges,22);
});
