import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import type {TeeRecorderServer} from '../packages/capture/src/tee/server.ts';
import {createTeeRecorder} from '../packages/capture/src/tee/server.ts';
import {channelKey,decrypt,encrypt,publicDer} from '../packages/capture/src/tee/channel.ts';
import {verifySeal} from '../packages/capture/src/tee/attestation.ts';

type TestChannel={key:Buffer;peer:string};
type Opened=TestChannel&{id:string;captureId:string};

const quote=async(statement:any)=>({statement,quote:'00'});
const binding=(capture:any)=>({capture_id:capture.capture_id,client:capture.client,status:'AWAITING_UPLOAD',consent_hash:'a'.repeat(64),expires_at:new Date(Date.now()+60_000).toISOString()});

async function listen(recorder:TeeRecorderServer){
  await new Promise<void>(resolve=>recorder.listen(0,'127.0.0.1',resolve));
  return 'http://127.0.0.1:'+((recorder.address() as any).port as number);
}

async function close(recorder:TeeRecorderServer){
  recorder.closeAllConnections();
  await new Promise<void>(resolve=>recorder.close(()=>resolve()));
}

async function clientChannel(base:string):Promise<TestChannel>{
  const attestation=await (await fetch(base+'/attestation')).json() as any;
  const pair=generateKeyPairSync('x25519');
  return {key:channelKey(pair.privateKey,attestation.statement.channel_key),peer:publicDer(pair.publicKey)};
}

async function open(base:string,captureId:string,channel?:TestChannel){
  const connection=channel??await clientChannel(base),nonce=randomBytes(16).toString('hex');
  const body={peer:connection.peer,nonce,data:encrypt(connection.key,{capture_id:captureId,client:'claude',upload_token:'test-only',incremental:true},'open:'+nonce)};
  const response=await fetch(base+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)return {response,connection};
  const encrypted=await response.json() as any;
  const result=decrypt(connection.key,encrypted.data,'opened:'+nonce);
  return {response,connection,session:{...connection,id:result.id,captureId} as Opened};
}

async function finish(base:string,session:Opened){
  const nonce=randomBytes(16).toString('hex');
  const body={nonce,data:encrypt(session.key,{},'finish:'+session.id+':'+nonce)};
  const response=await fetch(base+'/sessions/'+session.id+'/finish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)return {response};
  const encrypted=await response.json() as any;
  return {response,result:decrypt(session.key,encrypted.data,'finished:'+session.id+':'+nonce)};
}

function relayBody(session:Opened,prompt='test'){
  const nonce=randomBytes(16).toString('hex');
  const payload={path:'/v1/messages',method:'POST',headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({prompt})).toString('base64')};
  return {nonce,body:JSON.stringify({nonce,data:encrypt(session.key,payload,'relay:'+session.id+':'+nonce)})};
}

test('overlapping opens reserve capacity atomically before authorization',async t=>{
  let entered=0,release!:()=>void,allEntered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{allEntered=resolve;});
  const recorder=await createTeeRecorder({quote,capacity:{maxActiveSessions:2},authorize:async capture=>{entered++;if(entered===2)allEntered();await gate;return binding(capture);}});
  const base=await listen(recorder);t.after(()=>close(recorder));
  const channels=await Promise.all(Array.from({length:4},()=>clientChannel(base)));
  const attempts=channels.map((channel,index)=>open(base,'overlap-capture-'+String(index).padStart(3,'0'),channel));
  await waiting;
  const pending=recorder.recorder.readiness();assert.equal(pending.ready,false);assert.equal(pending.active_sessions,0);assert.equal(pending.pending_opens,2);
  release();
  const results=await Promise.all(attempts);
  assert.equal(entered,2);
  assert.deepEqual(results.map(result=>result.response.status).sort(),[200,200,429,429]);
  assert.equal(recorder.recorder.readiness().active_sessions,2);
  assert.equal(recorder.recorder.readiness().pending_opens,0);
});

test('a failed open releases both the slot and capture-id reservation',async t=>{
  let reject=true,calls=0;
  const recorder=await createTeeRecorder({quote,capacity:{maxActiveSessions:2},authorize:async capture=>{calls++;if(reject)throw Error('authorization fixture failure');return binding(capture);}});
  const base=await listen(recorder);t.after(()=>close(recorder));
  const channel=await clientChannel(base),captureId='failed-open-capture-001';
  const first=await open(base,captureId,channel);assert.equal(first.response.status,400);await first.response.text();
  assert.equal(recorder.recorder.readiness().pending_opens,0);assert.equal(recorder.recorder.readiness().active_sessions,0);
  reject=false;
  const retry=await open(base,captureId,channel);assert.equal(retry.response.status,200);assert.ok(retry.session);assert.equal(calls,2);
  const duplicate=await open(base,captureId);assert.equal(duplicate.response.status,400);await duplicate.response.text();assert.equal(calls,2);
  assert.equal((await finish(base,retry.session!)).response.status,200);
});

test('completion frees active capacity while retry results remain separately bounded',async t=>{
  const recorder=await createTeeRecorder({quote,capacity:{maxActiveSessions:1,maxCompletedResults:2},authorize:async capture=>binding(capture)});
  const base=await listen(recorder);t.after(()=>close(recorder));
  const first=(await open(base,'finish-retry-capture-001')).session!;
  const completed=await finish(base,first);assert.equal(completed.response.status,200);verifySeal(completed.result.bundle,completed.result.evidence,first.captureId);
  assert.equal(recorder.recorder.readiness().active_sessions,0);assert.equal(recorder.recorder.readiness().completed_results,1);
  const retry=await finish(base,first);assert.equal(retry.response.status,200);assert.equal(retry.result.bundle.root,completed.result.bundle.root);assert.equal(retry.result.evidence.signature,completed.result.evidence.signature);

  for(const captureId of ['finish-retry-capture-002','finish-retry-capture-003']){
    const session=(await open(base,captureId)).session!;
    assert.equal((await finish(base,session)).response.status,200);
  }
  const state=recorder.recorder.readiness();assert.equal(state.active_sessions,0);assert.equal(state.completed_results,2);assert.ok(state.completed_result_bytes>0);
  const evicted=await finish(base,first);assert.equal(evicted.response.status,400);assert.deepEqual(await evicted.response.json(),{error:'RECORDER_REQUEST_REJECTED'});
});

test('a result larger than the retry byte budget is returned once without occupying active capacity',async t=>{
  const recorder=await createTeeRecorder({quote,capacity:{maxActiveSessions:1,maxCompletedResultBytes:1},authorize:async capture=>binding(capture)});
  const base=await listen(recorder);t.after(()=>close(recorder));
  const session=(await open(base,'result-byte-budget-001')).session!;
  const completed=await finish(base,session);assert.equal(completed.response.status,200);verifySeal(completed.result.bundle,completed.result.evidence,session.captureId);
  const state=recorder.recorder.readiness();assert.equal(state.active_sessions,0);assert.equal(state.completed_results,0);assert.equal(state.completed_result_bytes,0);
  const retry=await finish(base,session);assert.equal(retry.response.status,400);await retry.response.text();
  assert.ok((await open(base,'result-byte-budget-002')).session);
});

test('process-wide request and envelope budgets reject overlap before extra upstream work',async t=>{
  let upstream=0,started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const recorder=await createTeeRecorder({quote,capacity:{maxActiveSessions:2,maxActiveRequests:1,maxBufferedRequestBytes:2048},authorize:async capture=>binding(capture),transport:async()=>{upstream++;started();await gate;return new Response('data: done\n\n',{headers:{'content-type':'text/event-stream'}});}});
  const base=await listen(recorder);t.after(()=>close(recorder));
  const first=(await open(base,'request-budget-capture-001')).session!,second=(await open(base,'request-budget-capture-002')).session!;
  const one=relayBody(first),active=fetch(base+'/sessions/'+first.id+'/relay',{method:'POST',headers:{'content-type':'application/json'},body:one.body});
  await entered;assert.equal(recorder.recorder.readiness().active_requests,1);
  const two=relayBody(second),overlap=await fetch(base+'/sessions/'+second.id+'/relay',{method:'POST',headers:{'content-type':'application/json'},body:two.body});
  assert.equal(overlap.status,429);assert.deepEqual(await overlap.json(),{error:'RECORDER_BUSY'});assert.equal(upstream,1);
  release();const finishedRelay=await active;assert.equal(finishedRelay.status,200);await finishedRelay.text();
  assert.equal(recorder.recorder.readiness().active_requests,0);assert.equal(recorder.recorder.readiness().buffered_request_bytes,0);

  const large=relayBody(second,'x'.repeat(3000));
  const bounded=await fetch(base+'/sessions/'+second.id+'/relay',{method:'POST',headers:{'content-type':'application/json'},body:large.body});
  assert.equal(bounded.status,429);assert.deepEqual(await bounded.json(),{error:'RECORDER_BUSY'});assert.equal(upstream,1);
  assert.equal(recorder.recorder.readiness().buffered_request_bytes,0);
});

test('programmatic drain changes readiness, preserves existing finish, and cannot hang shutdown',async t=>{
  let authorizations=0;
  const recorder=await createTeeRecorder({quote,capacity:{maxActiveSessions:2},authorize:async capture=>{authorizations++;return binding(capture);}});
  const base=await listen(recorder);t.after(()=>{if(recorder.listening)return close(recorder);});
  const existing=(await open(base,'drain-control-capture-001')).session!;
  const state=recorder.recorder.drain();assert.equal(state.ready,false);assert.equal(state.draining,true);
  const health=await fetch(base+'/health');assert.equal(health.status,503);assert.equal((await health.json() as any).draining,true);
  const mutation=await fetch(base+'/drain',{method:'POST',body:'{}'});assert.equal(mutation.status,404);await mutation.text();
  const rejected=await open(base,'drain-control-capture-002');assert.equal(rejected.response.status,429);await rejected.response.text();assert.equal(authorizations,1);
  const drained=recorder.recorder.whenDrained();assert.equal((await finish(base,existing)).response.status,200);await drained;
  assert.equal(recorder.recorder.resume().ready,true);

  const leftOpen=(await open(base,'drain-control-capture-003')).session!;assert.ok(leftOpen);
  recorder.recorder.drain();const shutdownDrain=recorder.recorder.whenDrained();await close(recorder);
  await Promise.race([shutdownDrain,new Promise((_,reject)=>setTimeout(()=>reject(Error('drain waiter hung during shutdown')),1000))]);
});
