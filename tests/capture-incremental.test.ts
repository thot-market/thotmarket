import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCaptureProxy} from '../packages/capture/src/index.ts';
import {canonicalHash} from '../packages/protocol/src/canonical.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {captureLabel} from '../packages/capture/src/terminal.ts';
// @ts-expect-error Browser-native module.
import {verifyProxyCapture} from '../apps/dashboard/agent-capture-ui.js';

const actor={id:'user_demo',role:'user' as const};
const answer='data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The PDF marker is THOT_PDF_OK."}}\n\ndata: {"type":"message_stop"}\n\n';
async function appFor(t:any){const dir=await mkdtemp(join(tmpdir(),'thot-incremental-test-'));const app=await createApplication({memory:true,dataDir:dir});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return app;}
function manifest(id:string,records:any[]){const v={format:'thot.proxy-capture/2',capture_id:id,client:'claude',started_at:records[0].started_at,finished_at:records.at(-1).finished_at,parts:records.map(({sequence,commitment})=>({sequence,commitment}))};return {...v,root:canonicalHash(v)};}

test('ordinary repeated requests exceed the old cumulative budget, survive clear, and save as one incrementally verified vault session',async t=>{
  const app=await appFor(t),connection=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});
  const records:any[]=[];let calls=0;
  const proxy=await startCaptureProxy({client:'claude',captureId:connection.capture_id,incremental:true,onExchange:e=>records.push(e),transport:async()=>{calls++;return new Response(answer,{headers:{'content-type':'text/event-stream'}});}});
  let rawBytes=0;
  for(let i=0;i<32;i++){
    // A small document and tool context are resent on successive turns. Clear
    // resets the prompt halfway through, not the lifetime of the recording.
    const messages=[{role:'user',content:[{type:'text',text:(i===17?'After /clear: ':'Read this PDF: ')+String(i)},{type:'document',source:{type:'base64',media_type:'application/pdf',data:Buffer.alloc(220000,65).toString('base64')}}]}];
    const body=JSON.stringify({model:'claude-test',messages,stream:true});rawBytes+=Buffer.byteLength(body);
    const response=await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body});assert.equal(response.status,200);assert.match(await response.text(),/THOT_PDF_OK/);
    const part=records.at(-1);assert.equal(part.sequence,i+1);
    await app.agentCapture.part(connection.capture_id,connection.upload_token,'part-test-'+i,{part});
  }
  const bundle=await proxy.finishManifest();assert.equal(calls,32);assert.ok(rawBytes>6*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(bundle))<8000);
  const saved=await app.agentCapture.complete(connection.capture_id,connection.upload_token,'incremental-complete',{bundle});assert.equal(saved.status,'SAVED');assert.equal(saved.capture_summary.exchanges,32);assert.equal(saved.capture_summary.interrupted,0);
  const proof=await app.agentCapture.proof(actor,connection.capture_id);const verified=await verifyProxyCapture(proof.bundle,async(n:number)=>(await app.agentCapture.proofPart(actor,connection.capture_id,n)).part);assert.equal(verified.exchanges,32);
  await assert.rejects(app.agentCapture.proofPart({id:'other-user',role:'user'},connection.capture_id,1));
  const replay=await app.agentCapture.complete(connection.capture_id,connection.upload_token,'incremental-retry',{bundle});assert.equal(replay.trace_id,saved.trace_id);
  await app.service.deleteTrace(actor,'delete-incremental-trace',saved.trace_id);
  await app.db.transaction(tx=>app.service.deleteTraceObjects(tx,saved.trace_id));
  await assert.rejects(app.agentCapture.proofPart(actor,connection.capture_id,1),/CAPTURE_CONTENT_UNAVAILABLE/);
});

test('missing, conflicting, tampered, and reordered parts cannot become a saved capture',async t=>{
  const app=await appFor(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});
  const now=new Date().toISOString();const make=(sequence:number)=>{const r={sequence,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from('{"messages":[{"role":"user","content":"hello"}]}').toString('base64'),response_body_b64:Buffer.from(answer).toString('base64'),status:200,content_type:'text/event-stream',started_at:now,finished_at:now,complete:true};return {...r,commitment:canonicalHash(r)};};
  const records=[make(1),make(2)];
  await assert.rejects(app.agentCapture.part(c.capture_id,'x'.repeat(43),'wrong-token',{part:records[0]}),/INVALID_CAPTURE_TOKEN/);
  await assert.rejects(app.agentCapture.part(c.capture_id,c.upload_token,'tampered-part',{part:{...records[0],response_body_b64:'e30='}}),/EXCHANGE_COMMITMENT_MISMATCH/);
  await app.agentCapture.part(c.capture_id,c.upload_token,'first-part',{part:records[0]});
  await assert.rejects(app.agentCapture.complete(c.capture_id,c.upload_token,'missing-part',{bundle:manifest(c.capture_id,records)}),/CAPTURE_PART_MISSING_OR_CHANGED/);
  const r={...records[0],status:201};const {commitment,...body}=r;r.commitment=canonicalHash(body);
  await assert.rejects(app.agentCapture.part(c.capture_id,c.upload_token,'conflicting-part',{part:r}),/CAPTURE_PART_CONFLICT/);
  await app.agentCapture.part(c.capture_id,c.upload_token,'second-part',{part:records[1]});
  await assert.rejects(app.agentCapture.complete(c.capture_id,c.upload_token,'reordered-parts',{bundle:manifest(c.capture_id,[records[1],records[0]])}),/INVALID_EXCHANGE_SEQUENCE/);
});

test('an interrupted response preserves completed turns and is explicit in the receipt',async t=>{
  const app=await appFor(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});const records:any[]=[];
  const proxy=await startCaptureProxy({client:'claude',captureId:c.capture_id,incremental:true,onExchange:e=>records.push(e),transport:async()=>new Response(answer,{headers:{'content-type':'text/event-stream'}})});
  await (await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body:'{"messages":[{"role":"user","content":"read PDF"}]}'})).text();
  const complete=records[0];const {commitment,...raw}=complete;const partial={...raw,sequence:2,complete:false,response_body_b64:'e30='};records.push({...partial,commitment:canonicalHash(partial)});await proxy.finishManifest();
  for(const part of records)await app.agentCapture.part(c.capture_id,c.upload_token,'partial-part-'+part.sequence,{part});
  const saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'partial-complete',{bundle:manifest(c.capture_id,records)});
  assert.equal(saved.capture_summary.interrupted,1);assert.equal(saved.capture_summary.normalized,1);assert.match(saved.capture_receipt.limitations.join(' '),/1 interrupted.*retained.*excluded/);
  const proof=await app.agentCapture.proof(actor,c.capture_id);const checked=await verifyProxyCapture(proof.bundle,async(n:number)=>(await app.agentCapture.proofPart(actor,c.capture_id,n)).part);assert.equal(checked.interrupted,1);
});

test('capture status distinguishes recording, local pending data, and interruption',()=>{
  assert.match(captureLabel({interrupted:false,saved:0,pending:0}),/WAITING FOR FIRST CAPTURE/);
  assert.match(captureLabel({interrupted:false,saved:0,pending:1}),/RECORDING.*1 pending locally/);
  assert.match(captureLabel({interrupted:false,saved:12,pending:0}),/RECORDING.*PRIVATE VAULT.*12 exchanges verified & saved/);
  assert.match(captureLabel({interrupted:true,saved:12,pending:2}),/CAPTURE INTERRUPTED.*2 pending locally/);
});

test('legacy evidence above 8 MB with interrupted requests is recoverable without changing its original commitments',async t=>{
  const app=await appFor(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});
  const now=new Date().toISOString();
  const body=Buffer.from(JSON.stringify({messages:[{role:'user',content:[{type:'text',text:'Compare the PDF.'},{type:'document',source:{type:'base64',media_type:'application/pdf',data:Buffer.alloc(220000,65).toString('base64')}}]}]})).toString('base64');
  const exchanges=Array.from({length:24},(_,i)=>{const record={sequence:i+1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:body,response_body_b64:Buffer.from(answer).toString('base64'),status:200,content_type:'text/event-stream',started_at:now,finished_at:now,complete:i!==23};return {...record,commitment:canonicalHash(record)};});
  const header={format:'thot.proxy-capture/1',capture_id:c.capture_id,client:'claude',started_at:now,finished_at:now};const bundle={...header,exchanges,root:canonicalHash({...header,commitments:exchanges.map(e=>e.commitment)})};
  assert.ok(Buffer.byteLength(JSON.stringify(bundle))>8_000_000);
  const saved=await app.agentCapture.complete(c.capture_id,c.upload_token,'large-legacy-recovery',{bundle});assert.equal(saved.capture_summary.interrupted,1);
  const proof=await app.agentCapture.proof(actor,c.capture_id);assert.equal(proof.bundle.root,bundle.root);assert.equal(canonicalHash(proof.bundle),canonicalHash(bundle));
});

test('optional metrics keep private-vault and interruption cues without printing incomplete latency',()=>{
  const previous=process.env.THOT_CAPTURE_STATUS;
  try{
    process.env.THOT_CAPTURE_STATUS='metrics';
    const label=captureLabel({interrupted:false,saved:12,pending:2,saveMsP50:10,saveMsLast:15,uploadBps:2048,syncError:true});
    assert.match(label,/PRIVATE VAULT.*12 saved.*2 pending.*save p50\/last 10\/15ms.*2KiB\/s.*sync retrying/);
    assert.doesNotMatch(captureLabel({interrupted:false,saved:1,pending:0,saveMsP50:10}),/NaN|save p50/);
    assert.match(captureLabel({interrupted:true,saved:12,pending:2,saveMsP50:10,saveMsLast:15}),/CAPTURE INTERRUPTED.*PRIVATE VAULT.*12 exchanges verified & saved.*2 pending locally/);
    process.env.THOT_CAPTURE_STATUS='default';
    assert.match(captureLabel({interrupted:false,saved:12,pending:0,saveMsP50:10,saveMsLast:15}),/12 exchanges verified & saved/);
  }finally{if(previous===undefined)delete process.env.THOT_CAPTURE_STATUS;else process.env.THOT_CAPTURE_STATUS=previous;}
});
