import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {captureSync} from '../packages/capture/src/sync.ts';
import {loadPrivate} from '../packages/capture/src/local-state.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {openBrowser} from '../packages/capture/src/browser.ts';
import {createTeeRecorder} from '../packages/capture/src/tee/server.ts';
import {startTeeCapture} from '../packages/capture/src/tee/client.ts';

async function directory(t:any){const dir=await mkdtemp(join(tmpdir(),'thot-sync-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const connection={origin:'https://vault.unit',capture_id:'unit-capture-123456',upload_token:'synthetic-authorization'};
function record(sequence:number){const p={sequence,request_body_b64:Buffer.from('synthetic private prompt').toString('base64'),response_body_b64:Buffer.from('synthetic reply').toString('base64')};return {...p,commitment:canonicalHash(p)};}
function checkpoint(parts:any[]){const body={format:'thot.proxy-capture/2',capture_id:connection.capture_id,client:'claude',parts:parts.map(({sequence,commitment})=>({sequence,commitment}))};return {bundle:{...body,root:canonicalHash(body)}};}
function ack(p:any,final=false){return {capture_id:connection.capture_id,status:final?'SAVED':'CHECKPOINT_SAVED',trace_id:'trace-unit',capture_receipt:{confidence_tier:p.evidence?'P2_TEE':'P0_OPERATOR',commitments:{session_root:p.bundle.root}},projection:{status:'READY'}};}

test('local persistence and response handling do not wait for a blocked vault upload; only accepted checkpoints advance saved status',async t=>{
  const dir=await directory(t);let unblock!:()=>void,blocked!:()=>void;
  const gate=new Promise<void>(resolve=>{unblock=resolve;}),started=new Promise<void>(resolve=>{blocked=resolve;});
  const sync=await captureSync(connection,dir,()=>{},async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).endsWith('/parts')){blocked();await gate;return Response.json({sequence:body.part.sequence,commitment:body.part.commitment,stored:true});}
    return Response.json(ack(body,String(url).endsWith('/complete')));
  });t.after(()=>sync.close());
  const p1=record(1),p2=record(2);await sync.part(p1);await sync.checkpoint(checkpoint([p1]));
  const flushing=sync.flush();await started;
  await sync.part(p2);await sync.checkpoint(checkpoint([p1,p2]));
  assert.equal(sync.progress.saved,0);assert.equal(sync.progress.pending,2);
  assert.deepEqual((await loadPrivate(join(dir,'parts','2'))).part,p2);
  unblock();await flushing;await sync.flush();assert.equal(sync.progress.saved,2);
  // A staging/saved acknowledgement never discards the only local body.
  assert.deepEqual((await loadPrivate(join(dir,'parts','1'))).part,p1);
  const ciphertext=await readFile(join(dir,'parts','1','pending.enc'));assert.equal(ciphertext.includes(Buffer.from('synthetic private prompt')),false);
  assert.equal((await lstat(join(dir,'parts','1','local.key'))).mode&0o077,0);
  const final=await sync.finish(checkpoint([p1,p2]));assert.equal(final.status,'SAVED');
  assert.equal(JSON.parse(await readFile(join(dir,'saved.json'),'utf8')).trace_id,'trace-unit');
  assert.deepEqual((await loadPrivate(join(dir,'parts','1'))).part,p1); // owner copy survives final save
});

test('failed finalize survives a helper restart with every body, and saving retries without model calls',async t=>{
  const dir=await directory(t),p=record(1);let fail=true,parts=0,completes=0;
  const transport:typeof fetch=async(url,init)=>{const body=JSON.parse(String(init?.body));if(String(url).endsWith('/parts')){parts++;return Response.json({sequence:body.part.sequence,commitment:body.part.commitment,stored:true});}if(String(url).endsWith('/complete')){completes++;if(fail)return Response.json({error:'PROJECTION_UNAVAILABLE'},{status:400});return Response.json(ack(body,true));}return Response.json(ack(body));};
  const first=await captureSync(connection,dir,()=>{},transport);await first.part(p);
  await assert.rejects(first.finish(checkpoint([p])),/PROJECTION_UNAVAILABLE/);first.close();
  const retained=await loadPrivate(dir);assert.equal(retained.bundle.parts.length,1);assert.deepEqual((await loadPrivate(join(dir,'parts','1'))).part,p);
  fail=false;const restarted=await captureSync(connection,dir,()=>{},transport);t.after(()=>restarted.close());
  assert.equal((await restarted.finish(retained)).trace_id,'trace-unit');assert.equal(parts,2);assert.equal(completes,2);
});

test('actual encrypted relay returns the next model response while its independent vault sync is blocked',async t=>{
  const dir=await directory(t);let release!:()=>void,started!:()=>void,calls=0;
  const gate=new Promise<void>(r=>{release=r;}),waiting=new Promise<void>(r=>{started=r;});
  const recorder=await createTeeRecorder({quote:async statement=>({statement,quote:'00'}),authorize:async v=>({capture_id:v.capture_id,client:v.client,status:'AWAITING_UPLOAD',consent_hash:'a'.repeat(64),expires_at:new Date(Date.now()+60000).toISOString()}),transport:async()=>{calls++;return new Response('data: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});}});
  await new Promise<void>(r=>recorder.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>recorder.close(()=>r())));
  const sync=await captureSync(connection,dir,()=>{},async(url,init)=>{const body=JSON.parse(String(init?.body));if(String(url).endsWith('/parts')){started();await gate;return Response.json({sequence:body.part.sequence,commitment:body.part.commitment,stored:true});}return Response.json(ack(body,String(url).endsWith('/complete')));});t.after(()=>sync.close());
  const proxy=await startTeeCapture({client:'claude',captureId:connection.capture_id,uploadToken:connection.upload_token,policy:{url:'https://recorder.unit',instances:{}},onPart:p=>sync.part(p),onCheckpoint:c=>sync.checkpoint(c)},async()=>({verified:true,app_id:'fixture',compose_hash:'fixture',quote_hash:'fixture'}),async(url,init)=>fetch('http://127.0.0.1:'+(recorder.address() as any).port+new URL(String(url)).pathname,init));
  const first=await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body:'{"messages":[{"role":"user","content":"first"}]}'});await first.text();
  const flushing=sync.flush();await waiting;
  const second=await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body:'{"messages":[{"role":"user","content":"next tool turn"}]}',signal:AbortSignal.timeout(2000)});assert.equal(second.status,200);await second.text();
  assert.equal(calls,2);assert.equal(sync.progress.saved,0);assert.equal(sync.progress.pending,2);
  assert.equal((await loadPrivate(join(dir,'checkpoint'))).bundle.parts.length,2);
  release();await flushing;const result=await proxy.finish();await sync.finish(result);assert.equal(sync.progress.saved,2);
});

test('browser opening uses one native URL-handler invocation and reports opener failure without shell evaluation',async()=>{
  const calls:any[]=[];
  const launch=(command:any,args:any,options:any)=>{calls.push({command,args,options});const child=new EventEmitter() as any;child.unref=()=>{};queueMicrotask(()=>child.emit('exit',0));return child;};
  const url='https://vault.example/#thot=abc';assert.equal(await openBrowser(url,launch as any,'linux'),true);
  assert.deepEqual(calls[0].args,[url]);assert.equal(calls[0].command,'xdg-open');assert.equal(calls[0].options.shell,false);assert.equal(calls.length,1);
  assert.equal(await openBrowser(url,((..._args:any[])=>{const child=new EventEmitter() as any;queueMicrotask(()=>child.emit('error',Error('not installed')));return child;}) as any,'linux'),false);
});

test('metrics advance only on verified saves and pending age follows the oldest unsaved part',async t=>{
  const dir=await directory(t);let clock=1000,invalid=false;
  t.mock.method(Date,'now',()=>clock);
  const updates:any[]=[];
  const sync=await captureSync(connection,dir,state=>updates.push(state),async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).endsWith('/parts'))return Response.json({sequence:body.part.sequence,commitment:body.part.commitment,stored:true});
    return Response.json(invalid?{...ack(body),capture_id:'wrong-capture'}:ack(body,String(url).endsWith('/complete')));
  });t.after(()=>sync.close());
  const p1=record(1),p2=record(2);await sync.part(p1);clock=2000;await sync.part(p2);
  assert.equal(sync.progress.oldestPendingAt,1000);
  await sync.checkpoint(checkpoint([p1]));await sync.flush();
  assert.equal(sync.progress.saved,1);assert.equal(sync.progress.pending,1);
  assert.equal(sync.progress.oldestPendingAt,2000);
  assert.ok(Number.isFinite(sync.progress.saveMsLast));assert.ok(Number.isFinite(sync.progress.uploadBps));
  assert.equal(sync.progress.saveMsP50,sync.progress.saveMsLast);
  const last=sync.progress.saveMsLast;invalid=true;
  await sync.checkpoint(checkpoint([p1,p2]));await assert.rejects(sync.flush(),/INVALID_CAPTURE_SAVE_RESPONSE/);
  assert.equal(sync.progress.saved,1);assert.equal(sync.progress.oldestPendingAt,2000);
  assert.equal(sync.progress.saveMsLast,last);assert.equal(sync.progress.error,'INVALID_CAPTURE_SAVE_RESPONSE');
  invalid=false;await sync.finish(checkpoint([p1,p2]));
  assert.equal(sync.progress.saved,2);assert.equal(sync.progress.pending,0);assert.equal(sync.progress.oldestPendingAt,undefined);
  assert.equal(sync.progress.error,undefined);assert.deepEqual(updates.at(-1),sync.progress);
});

test('restarted synchronization retains pending age from the encrypted file until a valid receipt',async t=>{
  const dir=await directory(t),p=record(1);
  const first=await captureSync(connection,dir);await first.part(p);first.close();
  const encrypted=join(dir,'parts','1','pending.enc');
  const {utimes}=await import('node:fs/promises');await utimes(encrypted,new Date(1000),new Date(1000));
  const restarted=await captureSync(connection,dir,()=>{},async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).endsWith('/parts'))return Response.json({sequence:body.part.sequence,commitment:body.part.commitment,stored:true});
    return Response.json(ack(body,true));
  });t.after(()=>restarted.close());
  assert.equal(restarted.progress.oldestPendingAt,1000);assert.equal(restarted.progress.pending,1);
  await restarted.finish(checkpoint([p]));assert.equal(restarted.progress.oldestPendingAt,undefined);
});
