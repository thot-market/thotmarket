import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalHash } from '../packages/protocol/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { normalizeProxyExchange } from '../packages/market/src/proxy-normalization.ts';
import {appendConversationTurns} from '../packages/market/src/capture-session.ts';

const now='2026-09-09T12:00:00.000Z';
const b64=(value:string)=>Buffer.from(value).toString('base64');
function bundle(capture_id:string,complete=true) {
  const request={model:'claude-test',messages:[{role:'user',content:'Please inspect the TypeScript function.'}],stream:true};
  const response=['event: message_start','data: {"type":"message_start","message":{"id":"msg_test"}}','','event: content_block_delta','data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The function is correct."}}','','event: message_stop','data: {"type":"message_stop"}',''].join('\n');
  const exchange:any={sequence:1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:b64(JSON.stringify(request)),response_body_b64:b64(response),status:200,content_type:'text/event-stream',started_at:now,finished_at:now,complete,commitment:''};
  const copy={...exchange};delete copy.commitment;exchange.commitment=canonicalHash(copy);
  const value:any={format:'thot.proxy-capture/1',capture_id,client:'claude',started_at:now,finished_at:now,exchanges:[exchange],root:''};
  value.root=canonicalHash({format:value.format,capture_id,client:value.client,started_at:value.started_at,finished_at:value.finished_at,commitments:[exchange.commitment]});return value;
}
async function setup(t:any){const app=await createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-agent-capture-')),config:{clock:()=>new Date(now)}});const server=createHttpServer(app,{clock:()=>Date.parse(now)});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();});const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;const response=await fetch(base+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'session-key'},body:JSON.stringify({role:'user'})});const session=(await response.json() as any).token;return {app,base,session};}
async function post(base:string,path:string,token:string,body:any,key='capture-test-key'){return fetch(base+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});}

test('private capture saves content without inventing a rights declaration or licensing output',async t=>{
 const {app,base,session}=await setup(t);
 const response=await post(base,'/v1/contributor/agent-captures/begin',session,{client:'claude',save_privately:true},'private-begin');assert.equal(response.status,200);
 const begun=await response.json() as any;
 const row=(await app.db.query('SELECT document FROM agent_captures WHERE id=$1',[begun.capture_id])).rows[0]!.document;
 assert.equal(row.rights_confirmed,false);assert.equal(row.model_output_licensed,false);
 assert.equal(row.consent_hash,canonicalHash({save_privately:true,rights_confirmed:false,model_output_licensed:false}));
 const saved=await app.agentCapture.complete(begun.capture_id,begun.upload_token,'private-complete',{bundle:bundle(begun.capture_id)});
 assert.equal(saved.status,'SAVED');assert.equal(saved.trace_status,'PRIVATE');
 const trace=(await app.db.query('SELECT document FROM traces WHERE id=$1',[saved.trace_id])).rows[0]!.document;
 assert.ok(!['eligible','eligible_with_restrictions'].includes(trace.rights_status));assert.ok(trace.raw_ref);
 assert.equal((await post(base,'/v1/contributor/agent-captures/begin',session,{client:'claude',save_privately:false},'no-consent')).status,400);
 assert.equal((await post(base,'/v1/contributor/agent-captures/begin',session,{client:'claude',save_privately:true,rights_confirmed:true},'mixed-consent')).status,400);
});

test('subscription proxy capture uses a scoped hashed token, validates commitments, and saves private P0 evidence idempotently',async t=>{
  const {app,base,session}=await setup(t);const begunResponse=await post(base,'/v1/contributor/agent-captures/begin',session,{client:'claude',rights_confirmed:true,model_output_licensed:true},'begin-capture');assert.equal(begunResponse.status,200);const begun=await begunResponse.json() as any;
  const storedBefore=(await app.db.query('SELECT document FROM agent_captures WHERE id=$1',[begun.capture_id])).rows[0]!.document;assert.notEqual(storedBefore.token_hash,begun.upload_token);assert.ok(!JSON.stringify(storedBefore).includes(begun.upload_token));
  assert.equal((await post(base,`/v1/agent-captures/${begun.capture_id}/complete`,'wrong-token',{bundle:bundle(begun.capture_id)})).status,401);
  const changed=bundle(begun.capture_id);changed.exchanges[0].response_body_b64=b64('changed');assert.equal((await post(base,`/v1/agent-captures/${begun.capture_id}/complete`,begun.upload_token,{bundle:changed})).status,400);
  const partialConnection=await app.agentCapture.begin({id:'demo-user',role:'user'},{client:'claude',save_privately:true});const partial=bundle(partialConnection.capture_id,false);const partialResponse=await post(base,`/v1/agent-captures/${partialConnection.capture_id}/complete`,partialConnection.upload_token,{bundle:partial},'partial-capture');assert.equal(partialResponse.status,200);const partialSaved=await partialResponse.json() as any;assert.equal(partialSaved.status,'SAVED');assert.equal(partialSaved.capture_summary.interrupted,1);assert.equal(partialSaved.projection.status,'UNREADABLE');
  const value=bundle(begun.capture_id);const completedResponse=await post(base,`/v1/agent-captures/${begun.capture_id}/complete`,begun.upload_token,{bundle:value},'complete-capture');assert.equal(completedResponse.status,200);const completed=await completedResponse.json() as any;assert.equal(completed.status,'SAVED');assert.equal(completed.capture_receipt.confidence_tier,'P0_OPERATOR');assert.match(completed.capture_receipt.limitations.join(' '),/No independent witness.*TEE provenance/);
  const retry=await post(base,`/v1/agent-captures/${begun.capture_id}/complete`,begun.upload_token,{bundle:value},'complete-retry');assert.deepEqual(await retry.json(),completed);
  const status=await fetch(base+`/v1/contributor/agent-captures/${begun.capture_id}/status`,{headers:{Authorization:`Bearer ${session}`}});assert.equal((await status.json() as any).status,'SAVED');
  const proofResponse=await fetch(base+`/v1/contributor/agent-captures/${begun.capture_id}/proof`,{headers:{Authorization:`Bearer ${session}`}});assert.equal(proofResponse.status,200);assert.deepEqual((await proofResponse.json() as any).bundle,value);
  assert.equal((await fetch(base+`/v1/contributor/agent-captures/${begun.capture_id}/proof`,{headers:{Authorization:`Bearer ${begun.upload_token}`}})).status,401);
  const trace=(await app.db.query('SELECT document FROM traces WHERE id=$1',[completed.trace_id])).rows[0]!.document;assert.equal(trace.provenance_status,'OPERATOR_CAPTURED');assert.ok(trace.raw_ref&&trace.scrub_ref);assert.ok(!JSON.stringify(trace).includes('Please inspect'));assert.equal((await app.db.query('SELECT count(*)::text AS n FROM contributor_entitlements')).rows[0]!.n,'0');
});

test('gzip request bytes remain committed in the source bundle and are decompressed only for normalization',async t=>{
  const {app}=await setup(t),begun=await app.agentCapture.begin({id:'demo-user',role:'user'},{client:'claude',rights_confirmed:true,model_output_licensed:true}),value=bundle(begun.capture_id),exchange=value.exchanges[0];
  const clear=Buffer.from(exchange.request_body_b64,'base64'),compressed=gzipSync(clear);exchange.request_body_b64=compressed.toString('base64');exchange.request_encoding='gzip';exchange.request_method='POST';const copy={...exchange};delete copy.commitment;exchange.commitment=canonicalHash(copy);value.root=canonicalHash({format:value.format,capture_id:value.capture_id,client:value.client,started_at:value.started_at,finished_at:value.finished_at,commitments:[exchange.commitment]});
  const saved=await app.agentCapture.complete(begun.capture_id,begun.upload_token,'gzip-complete',{bundle:value});const proof=await app.agentCapture.proof({id:'demo-user',role:'user'},begun.capture_id);assert.deepEqual(gunzipSync(Buffer.from(proof.bundle.exchanges[0].request_body_b64,'base64')),clear);assert.equal(saved.status,'SAVED');
});

test('Codex SSE normalization prefers completed output items over deltas and rejects unknown items',()=>{
  const request=Buffer.from(JSON.stringify({input:[{type:'message',role:'user',content:[{type:'input_text',text:'Review this.'}]}]}));
  const events=[
    {type:'response.output_text.delta',delta:'One copy.'},
    {type:'response.output_item.done',item:{type:'message',role:'assistant',content:[{type:'output_text',text:'One copy.'}]}},
    {type:'response.completed',response:{status:'completed'}},
  ].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('');
  const normalized=normalizeProxyExchange('codex',request,Buffer.from(events));
  assert.equal(normalized.turns[1]!.content,'One copy.');
  assert.throws(()=>normalizeProxyExchange('codex',Buffer.from(JSON.stringify({input:[{type:'computer_call'}]})),Buffer.from(events)),/UNSUPPORTED_CODEX_REQUEST/);
});

test('Codex custom tool calls and outputs normalize explicitly without duplicating streamed input',()=>{
  const request=Buffer.from(JSON.stringify({input:[{type:'message',role:'user',content:[{type:'input_text',text:'Run the check.'}]},{type:'custom_tool_call_output',call_id:'call-1',output:[{type:'input_text',text:'check passed'}]}]}));
  const events=[
    {type:'response.custom_tool_call_input.delta',delta:'duplicated if retained'},
    {type:'response.output_item.done',item:{type:'custom_tool_call',name:'shell',call_id:'call-1',input:'npm test'}},
    {type:'response.completed',response:{status:'completed'}},
  ].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('');
  const normalized=normalizeProxyExchange('codex',request,Buffer.from(events));
  assert.deepEqual(normalized.turns,[{role:'user',content:'Run the check.'},{role:'tool',content:'[Tool result: id=call-1]\ncheck passed'},{role:'assistant',content:'[Tool use: shell; id=call-1]\nnpm test'}]);
  assert.ok(!JSON.stringify(normalized).includes('duplicated if retained'));
});

test('Claude streamed blocks match replayed history with tool arguments and text kept in order',()=>{
  const user={role:'user',content:'Read the synthetic source.'},tool={type:'server_tool_use',id:'tool-1',name:'web_search',input:{a:1,z:2}};
  const result={type:'web_search_tool_result',tool_use_id:'tool-1',content:[{type:'web_search_result',title:'Synthetic result',url:'https://example.test/source'}]};
  const blocks=[{type:'text',text:'First.'},tool,result,{type:'text',text:'Last.'}];
  const events=[{type:'content_block_start',index:0,content_block:blocks[0]},
    {type:'content_block_start',index:1,content_block:{...tool,input:{}}},
    {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"z":2, "a":1}'}},
    {type:'content_block_start',index:2,content_block:result},{type:'content_block_start',index:3,content_block:blocks[3]},
    {type:'message_stop'}].map(v=>'data: '+JSON.stringify(v)+'\n\n').join('');
  const initial=normalizeProxyExchange('claude',Buffer.from(JSON.stringify({messages:[user]})),Buffer.from(events));
  const next=normalizeProxyExchange('claude',Buffer.from(JSON.stringify({messages:[user,{role:'assistant',content:blocks},{role:'user',content:'Continue.'}]})),Buffer.from(JSON.stringify({type:'message',content:[{type:'text',text:'Complete.'}],stop_reason:'end_turn'})));
  assert.deepEqual(initial.turns,next.turns.slice(0,2));appendConversationTurns(initial.turns,next.turns);
  assert.equal(initial.turns.length,4);assert.equal(initial.turns[3].content,'Complete.');
});

test('Codex multiple output items match the next request without duplicating prior work',()=>{
  const user={type:'message',role:'user',content:[{type:'input_text',text:'Run both checks.'}]};
  const output=[{type:'message',role:'assistant',content:[{type:'output_text',text:'Checking.'}]},
    {type:'function_call',name:'shell',call_id:'call-1',arguments:'{"command":"first"}'},
    {type:'custom_tool_call',name:'patch',call_id:'call-2',input:'a synthetic patch'}];
  const initial=normalizeProxyExchange('codex',Buffer.from(JSON.stringify({input:[user]})),Buffer.from(output.map(item=>'data: '+JSON.stringify({type:'response.output_item.done',item})+'\n\n').join('')+'data: {"type":"response.completed"}\n\n'));
  const next=normalizeProxyExchange('codex',Buffer.from(JSON.stringify({input:[user,...output,{type:'function_call_output',call_id:'call-1',output:'first passed'},{type:'custom_tool_call_output',call_id:'call-2',output:'patch applied'}]})),Buffer.from(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Both passed.'}]}]})));
  assert.deepEqual(initial.turns,next.turns.slice(0,4));appendConversationTurns(initial.turns,next.turns);
  assert.equal(initial.turns.length,7);assert.equal(initial.turns[6].content,'Both passed.');
});

test('pending capture status becomes expired and its upload token cannot complete',async t=>{
  const {app,base,session}=await setup(t);const begun=await (await post(base,'/v1/contributor/agent-captures/begin',session,{client:'claude',rights_confirmed:true,model_output_licensed:false},'begin-expiring')).json() as any;
  await app.db.query("UPDATE agent_captures SET document=jsonb_set(document,'{expires_at}',to_jsonb($2::text)) WHERE id=$1",[begun.capture_id,'2026-09-09T11:59:59.000Z']);
  const status=await fetch(base+`/v1/contributor/agent-captures/${begun.capture_id}/status`,{headers:{Authorization:`Bearer ${session}`}});assert.equal((await status.json() as any).status,'EXPIRED');
  assert.equal((await post(base,`/v1/agent-captures/${begun.capture_id}/complete`,begun.upload_token,{bundle:bundle(begun.capture_id)},'expired-complete')).status,401);
});


test('Claude current-client system messages keep their distinct role',()=>{
  const request=Buffer.from(JSON.stringify({messages:[{role:'user',content:'Read the example.'},{role:'system',content:'System instruction.'}]}));
  const response=Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}\n\ndata: {"type":"message_stop"}\n\n');
  const normalized=normalizeProxyExchange('claude',request,response);
  assert.deepEqual(normalized.turns,[{role:'user',content:'Read the example.'},{role:'system',content:'System instruction.'},{role:'assistant',content:'Done.'}]);
});


test('Codex developer context and additional tool definitions do not break a real tool continuation',()=>{
  const request=Buffer.from(JSON.stringify({input:[
    {type:'message',role:'developer',content:[{type:'input_text',text:'Private instruction.'}]},
    {type:'additional_tools',role:'developer',tools:[{type:'function',name:'shell'}]},
    {type:'message',role:'user',content:[{type:'input_text',text:'Read README.'}]},
    {type:'function_call_output',call_id:'call-1',output:'ORCHARD-27'},
  ]}));
  const response=Buffer.from('data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ORCHARD-27"}]}}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  const {turns}=normalizeProxyExchange('codex',request,response);
  assert.deepEqual(turns.map(t=>t.role),['developer','developer','user','tool','assistant']);
  assert.ok(turns[3]!.content.includes('ORCHARD-27'));
  assert.match(turns[0]!.content,/Private instruction/);assert.match(turns[1]!.content,/Additional tool definitions/);
});

test('actual model metadata distinguishes provider completions from request aliases',async()=>{
 const {proxyModelIdentity}=await import('../packages/market/src/proxy-normalization.ts');
 for(const client of ['claude','codex'] as const){
  const request=Buffer.from(JSON.stringify({model:'routing-alias'}));
  const json=proxyModelIdentity(client,request,Buffer.from(JSON.stringify({model:'actual-model-version'})));
  assert.equal(json.requested_model,'routing-alias');assert.equal(json.returned_model,'actual-model-version');
  const event=client==='claude'?{type:'message_start',message:{model:'stream-model-version'}}:{type:'response.completed',response:{model:'stream-model-version'}};
  assert.equal(proxyModelIdentity(client,request,Buffer.from('data: '+JSON.stringify(event)+'\n\n')).returned_model,'stream-model-version');
  assert.equal(proxyModelIdentity(client,request,Buffer.from('{}')).returned_model,null);
 }
});

test('native Codex compaction shows an explicit boundary without exposing opaque state',async()=>{
  const {projectProxyExchange}=await import('../packages/market/src/proxy-normalization.ts');
  const request=Buffer.from(JSON.stringify({input:[{type:'compaction_trigger'},{type:'compaction',id:'cmp_fixture',encrypted_content:'OPAQUE_NOT_READABLE',internal_chat_message_metadata_passthrough:{private:'not-display-text'}},{type:'message',role:'user',content:'Continue the earlier work.'}]}));
  const response=Buffer.from(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'New answer after compaction.'}]}]}));
  const view=projectProxyExchange('codex',request,response);
  assert.deepEqual(view.issues,[]);assert.equal(view.context_turn_count,3);
  assert.match(view.turns[0].content,/compaction requested/);assert.match(view.turns[1].content,/encrypted provider state retained/);
  assert.equal(view.turns.at(-1)!.content,'New answer after compaction.');assert.ok(!JSON.stringify(view).includes('OPAQUE_NOT_READABLE'));assert.ok(!JSON.stringify(view).includes('not-display-text'));
  assert.throws(()=>projectProxyExchange('codex',Buffer.from(JSON.stringify({input:[{type:'compaction',id:'bad',encrypted_content:42}]})),response),/INVALID_CODEX_COMPACTION/);
});
