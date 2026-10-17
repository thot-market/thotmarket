import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';

const actor={id:'demo-user',role:'user' as const},source='a'.repeat(32),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const claude=(content='Synthetic private response')=>JSON.stringify({type:'assistant',sessionId:'synthetic-history',message:{role:'assistant',content}})+'\n';
const input=(client='claude')=>({client,source_ids:[source],backfill:false,consent:'private-history-upload-v1',daily_time_utc:'02:00'});
const upload=(text=claude())=>({source_id:source,file_id:'b'.repeat(64),version_id:sha(text),text});
async function fixture(t:any){const dir=await mkdtemp(join(tmpdir(),'thot-history-device-'));let now=Date.now();const app=await createApplication({dataDir:dir,memory:true,config:{clock:()=>new Date(now)}});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return {app,advance:(ms:number)=>{now+=ms;}};}

test('history grant is explicit, hashed, source scoped, and separate from live capture',async t=>{
  const {app}=await fixture(t);
  for(const extra of [{consent:undefined},{save_privately:false},{sale_policy_id:'x'},{rights_confirmed:true},{source_ids:[]},{daily_time_utc:'25:00'}])await assert.rejects(app.historyDevices.create(actor,{...input(),...extra}));
  const grant=await app.historyDevices.create(actor,input());
  const saved=(await app.db.query('SELECT document FROM auth_access WHERE id=$1',['history-device:'+grant.device_id])).rows[0].document;
  assert.equal(saved.token_hash,sha(grant.device_token));assert.ok(!JSON.stringify(saved).includes(grant.device_token));
  assert.ok(!JSON.stringify(await app.historyDevices.list(actor)).includes(grant.device_token));
  await assert.rejects(app.captureDevices.begin(grant.device_id,grant.device_token,{client:'claude',project:'fixture'}),/INVALID_CAPTURE_DEVICE/);
  await assert.rejects(app.historyDevices.import(grant.device_id,grant.device_token,{...upload(),source_id:'f'.repeat(32)}),/HISTORY_SOURCE_NOT_AUTHORIZED/);
  await assert.rejects(app.historyDevices.import(grant.device_id,grant.device_token,{...upload(),rights_confirmed:true}),/INVALID_HISTORY_UPLOAD/);
  await assert.rejects(app.historyDevices.update({id:'other-user',role:'user'},'not-my-connection',grant.device_id,'disconnect'),/NOT_FOUND/);
});

test('private uploads deduplicate retries and preserve immutable changed versions without listings',async t=>{
  const {app}=await fixture(t),grant=await app.historyDevices.create(actor,input()),first=upload();
  const result=await app.historyDevices.import(grant.device_id,grant.device_token,first);
  assert.equal(result.private_only,true);assert.equal(result.status,'PRIVATE');assert.ok(!JSON.stringify(result).includes('Synthetic'));assert.ok(!('item' in result));
  assert.equal((await app.historyDevices.import(grant.device_id,grant.device_token,first)).trace_id,result.trace_id);
  const next=await app.historyDevices.import(grant.device_id,grant.device_token,{...upload(claude('New immutable version')),previous_version_id:first.version_id});assert.notEqual(next.trace_id,result.trace_id);
  const traces=await app.db.transaction(tx=>tx.list('traces',actor.id));assert.equal(traces.length,2);
  for(const trace of traces){assert.equal(trace.save_privately,true);assert.equal(trace.provenance_status,'IMPORTED_UNVERIFIED');assert.equal(trace.history_sync.source_id,source);assert.equal(trace.display_status,'PRIVATE');}
  assert.equal((await app.db.transaction(tx=>tx.list('thot_records',actor.id))).filter(r=>r.kind==='listing').length,0);
  const status=await app.historyDevices.status(grant.device_id,grant.device_token);assert.equal(status.account_id,actor.id);assert.ok(status.last_saved_at);
});

test('Codex grants accept Codex histories only; pause, revocation and expiry fence all uploads',async t=>{
  const {app,advance}=await fixture(t),grant=await app.historyDevices.create(actor,input('codex'));
  await assert.rejects(app.historyDevices.import(grant.device_id,grant.device_token,upload()),/HISTORY_CLIENT_MISMATCH/);
  const text=JSON.stringify({type:'session_meta',payload:{id:'synthetic-codex'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic Codex response'}]}})+'\n';
  await app.historyDevices.import(grant.device_id,grant.device_token,upload(text));
  await app.historyDevices.update(actor,'pause-synthetic-history',grant.device_id,'pause');
  await assert.rejects(app.historyDevices.import(grant.device_id,grant.device_token,upload(text)),/HISTORY_DEVICE_PAUSED/);
  await app.historyDevices.update(actor,'resume-synthetic-history',grant.device_id,'resume');
  advance(30*86400000+1);await assert.rejects(app.historyDevices.status(grant.device_id,grant.device_token),/HISTORY_DEVICE_EXPIRED/);
  const fresh=await app.historyDevices.create(actor,input());await app.historyDevices.control(fresh.device_id,fresh.device_token,'disconnect-synthetic-history','disconnect');
  await assert.rejects(app.historyDevices.import(fresh.device_id,fresh.device_token,upload()),/HISTORY_DEVICE_REVOKED/);
});

test('pause or revoke during staged object storage cannot publish a trace',async t=>{
  const {app}=await fixture(t);
  for(const action of ['pause','disconnect'] as const){
    const grant=await app.historyDevices.create(actor,input()),seal=app.privacy.seal.bind(app.privacy);let stopped=false;
    app.privacy.seal=async(...args:Parameters<typeof app.privacy.seal>)=>{const result=await seal(...args);if(!stopped){stopped=true;await app.historyDevices.update(actor,'stop-during-storage-'+action,grant.device_id,action);}return result;};
    await assert.rejects(app.historyDevices.import(grant.device_id,grant.device_token,upload(claude(action))),/HISTORY_DEVICE_(PAUSED|REVOKED)/);app.privacy.seal=seal;
  }
  assert.equal((await app.db.transaction(tx=>tx.list('traces',actor.id))).length,0);
});

test('HTTP routes authenticate narrow grants before body parsing and never accept them as sessions',async t=>{
  const {app}=await fixture(t),server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const origin='http://127.0.0.1:'+(server.address() as any).port,grant=await app.historyDevices.create(actor,input());
  for(const path of ['/v1/contributor/library','/v1/contributor/history-devices','/v1/auth/session'])assert.equal((await fetch(origin+path,{headers:{Authorization:'Bearer '+grant.device_token}})).status,401);
  const route=origin+'/v1/history-devices/'+grant.device_id+'/imports';
  assert.equal((await fetch(route,{method:'POST',headers:{Authorization:'Bearer '+'x'.repeat(43),'Content-Type':'application/json'},body:'not JSON'})).status,401);
  const response=await fetch(route,{method:'POST',headers:{Authorization:'Bearer '+grant.device_token,'Content-Type':'application/json'},body:JSON.stringify(upload(claude('Synthetic large input '+'.'.repeat(20000))))});assert.equal(response.status,200);assert.ok(!JSON.stringify(await response.json()).includes('Synthetic large'));
  const alternate={'X-THOT-History-Token':grant.device_token,Authorization:'Basic '+Buffer.from('synthetic:gate').toString('base64'),'Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/v1/history-devices/'+grant.device_id+'/status',{method:'POST',headers:alternate,body:'{}'})).status,200);
  assert.equal((await fetch(origin+'/v1/contributor/library',{headers:alternate})).status,401);
  for(const path of ['/v1/thot/listings/preview','/v1/thot/listings/prepare'])assert.equal((await fetch(origin+path,{method:'POST',headers:alternate,body:'{}'})).status,401);
  assert.equal((await fetch(route,{method:'POST',headers:{...alternate,Authorization:'Bearer '+grant.device_token},body:JSON.stringify(upload())})).status,401);
  assert.equal((await fetch(origin+'/v1/capture-devices/'+grant.device_id+'/captures',{method:'POST',headers:alternate,body:'{}'})).status,401);
});
