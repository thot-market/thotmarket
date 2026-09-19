import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeeRecorder} from '../packages/capture/src/tee/server.ts';
import {startTeeCapture} from '../packages/capture/src/tee/client.ts';
import {verifySeal} from '../packages/capture/src/tee/attestation.ts';
import {canonicalHash} from '../packages/protocol/src/canonical.ts';

test('encrypted relay streams, stages each exact exchange, and signs a small manifest past the old 6 MB boundary',async t=>{
  let calls=0,verified=0;
  const recorder=await createTeeRecorder({
    // Unit fixture only. Live release checks must verify actual DCAP evidence.
    quote:async statement=>({statement,quote:'00'}),
    authorize:async v=>({capture_id:v.capture_id,client:v.client,status:'AWAITING_UPLOAD',consent_hash:'a'.repeat(64),expires_at:new Date(Date.now()+60000).toISOString()}),
    transport:async()=>{calls++;return new Response('data: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});}
  });
  await new Promise<void>(resolve=>recorder.listen(0,'127.0.0.1',resolve));const port=(recorder.address() as any).port;
  t.after(()=>new Promise<void>(resolve=>recorder.close(()=>resolve())));
  const parts:any[]=[];const states:string[]=[];
  const proxy=await startTeeCapture({client:'claude',captureId:'unit-capture-123456',uploadToken:'test-only',policy:{url:'https://recorder.unit',instances:{}},onPart:async p=>{parts.push(p);},onState:s=>states.push(s)},
    async()=>{verified++;return {verified:true,app_id:'unit',compose_hash:'unit',quote_hash:'unit'};},
    async(url,init)=>fetch('http://127.0.0.1:'+port+new URL(String(url)).pathname,init));
  const auxiliary=await fetch(proxy.baseUrl+'/api/oauth/usage');assert.equal(auxiliary.status,404);await auxiliary.text();
  assert.deepEqual(states,[],'An unsupported background account request must not report a failed model capture');
  for(let i=0;i<24;i++){
    const body=JSON.stringify({messages:[{role:'user',content:'synthetic PDF text '+String(i)+'x'.repeat(300000)}]});
    const response=await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body});assert.equal(response.status,200);assert.match(await response.text(),/message_stop/);
    assert.equal(parts.length,i+1);assert.equal(Buffer.from(parts[i].request_body_b64,'base64').toString(),body);
  }
  const {bundle,evidence}=await proxy.finish();assert.equal(calls,24);assert.equal(verified,1);assert.deepEqual(states,[]);
  assert.equal(bundle.format,'thot.proxy-capture/2');assert.equal(bundle.parts.length,24);assert.ok(JSON.stringify(bundle).length<5000);
  verifySeal(bundle,evidence,'unit-capture-123456','a'.repeat(64));
  for(const p of parts){const {commitment,...record}=p;assert.equal(canonicalHash(record),commitment);assert.equal(bundle.parts[p.sequence-1].commitment,commitment);}
  assert.throws(()=>verifySeal({...bundle,root:'0'.repeat(64)},evidence,'unit-capture-123456'));
});

test('recorder verification rejection prevents session creation and provider calls',async()=>{
  let requests=0;
  await assert.rejects(startTeeCapture({client:'claude',captureId:'unit-capture-123456',uploadToken:'test',policy:{url:'https://recorder.unit',instances:{}},onPart:async()=>{}},
    async()=>{throw Error('RECORDER_MEASUREMENT_REJECTED');},async()=>{requests++;return Response.json({statement:{}});}),/RECORDER_MEASUREMENT_REJECTED/);
  assert.equal(requests,1);
});

test('large relay envelopes require an existing session and handshakes keep a small body budget',async t=>{
  let authorizations=0;
  const recorder=await createTeeRecorder({quote:async statement=>({statement,quote:'00'}),authorize:async()=>{authorizations++;throw Error('unexpected authorization');}});
  await new Promise<void>(r=>recorder.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(recorder.address() as any).port;
  t.after(async()=>{recorder.closeAllConnections();await new Promise<void>(r=>recorder.close(()=>r()));});
  const oversized=await fetch(base+'/sessions',{method:'POST',body:JSON.stringify({padding:'x'.repeat(64*1024)})});assert.equal(oversized.status,400);await oversized.text();assert.equal(authorizations,0);
  // A never-finished body must not be consumed for an unknown session.
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),2000);
  try{
    const body=new ReadableStream({start(controller){controller.enqueue(Buffer.from('{'));}});
    const unknown=await fetch(base+'/sessions/'+'a'.repeat(48)+'/relay',{method:'POST',body,duplex:'half',signal:abort.signal} as any);
    assert.equal(unknown.status,400);await unknown.text();assert.equal(authorizations,0);
  }finally{clearTimeout(timer);abort.abort();}
});
