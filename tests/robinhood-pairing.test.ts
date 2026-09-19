import test from 'node:test';
import assert from 'node:assert/strict';
import {startRobinhoodPairing} from '../packages/capture/src/robinhood-pairing.ts';
const origin='https://thot.example';
const input={link_ticket:'signed-ticket-fixture',witness_url:'https://witness.example',appraiser_url:'https://appraiser.example',thot_public_key_pem:'PUBLIC PEM'};

test('Robinhood local pairing enforces origin, nonce, single claim and bounded launch fields',async t=>{
  let launches=0,stops=0,update!:(value:unknown)=>void;
  const bridge=await startRobinhoodPairing({origin,launch(body,emit){assert.deepEqual(body,input);launches++;update=emit;return ()=>{stops++;};}});t.after(()=>bridge.close());
  const get=(url=bridge.callback+'/status',source=origin)=>fetch(url,{headers:{Origin:source}});
  const post=(body:unknown,url=bridge.callback)=>fetch(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await get(undefined,'https://evil.example')).status,403);
  assert.equal((await get(bridge.callback.replace(/.$/,'Z')+'/status')).status,404);
  assert.equal((await fetch(bridge.callback+'/status')).status,403);
  assert.equal((await post({...input,token:'FORBIDDEN-FIELD'})).status,400);
  assert.equal((await post({...input,appraiser_url:'http://localhost/'})).status,400);
  assert.equal(launches,0);
  assert.equal((await post(input)).status,200);assert.equal(launches,1);
  assert.equal((await post(input)).status,409);assert.equal(launches,1);
  update({stage:'awaiting_account_request'});assert.equal((await(await get()).json()).stage,'awaiting_account_request');
  assert.equal((await post({},bridge.callback+'/saved')).status,409);
  update({evidence:{credential:{fixture:true},witness_receipts:[]}});
  assert.equal((await(await get()).json()).stage,'proof_ready');
  await bridge.close();assert.equal(stops,1);
});

test('connector failure stays unverified and expiry terminates the child',async t=>{
  let stop=false;
  const bridge=await startRobinhoodPairing({origin,timeoutMs:80,launch(_input,update){update({error:'CONNECTOR_ENDED_WITHOUT_PROOF'});return ()=>{stop=true;};}});t.after(()=>bridge.close());
  await fetch(bridge.callback,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const status=await(await fetch(bridge.callback+'/status',{headers:{Origin:origin}})).json();assert.equal(status.stage,'failed');assert.equal(status.evidence,undefined);
  await new Promise(r=>setTimeout(r,120));assert.equal(stop,true);
});

test('trade pairing commits selected symbol/window and refuses purpose substitution or extra secrets',async t=>{
 const tradeRequest={trace_id:'trace-123',symbol:'AAPL',window_days:7};let launches=0;
 const bridge=await startRobinhoodPairing({origin,tradeRequest,launch(body){assert.equal(body.purpose,'traded');launches++;return ()=>{};}});t.after(()=>bridge.close());
 const fragment=JSON.parse(Buffer.from(bridge.url.split('#thot-robinhood=')[1]!,'base64url').toString());assert.deepEqual(fragment.trade_request,tradeRequest);
 const post=(body:unknown)=>fetch(bridge.callback,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const request={symbol:'AAPL',window_days:7,trace_ts:'2026-09-15T00:00:00Z'};
 for(const body of [input,{...input,purpose:'account-control',request},{...input,purpose:'traded',request:{...request,symbol:'MSFT'}},{...input,purpose:'traded',request,token:'secret'}])assert.equal((await post(body)).status,400);
 assert.equal(launches,0);assert.equal((await post({...input,purpose:'traded',request})).status,200);assert.equal(launches,1);
});
