import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {connectCapture} from '../packages/capture/src/connect.ts';
import {connectHistory} from '../packages/capture/src/history-connect.ts';
import {createHistoryState} from '../packages/capture/src/history-sync.ts';
import type {EvidenceVerifier} from '../packages/market/src/robinhood-link.ts';

const actor={id:'demo-user',role:'user' as const};
const otherActor={id:'other-user',role:'user' as const};
async function fixture(t:any,options:{}={}){
  const dir=await mkdtemp(join(tmpdir(),'thot-pairing-'));let now=Date.now();
  const app=await createApplication({dataDir:join(dir,'app'),memory:true,config:{clock:()=>new Date(now)},...options});
  const server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,origin,root:join(dir,'connections'),advance:(ms:number)=>{now+=ms;}};
}
async function sessionToken(origin:string){
  return ((await (await fetch(origin+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'pairing-test-session'},body:'{"role":"user"}'})).json()) as any).token as string;
}
async function call(method:string,url:string,body:unknown,token?:string,key?:string){
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(method==='POST'?{'Idempotency-Key':key??'test-'+Math.random().toString(16).slice(2)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json().catch(()=>({})) as any};
}
async function createSession(origin:string,request:unknown){
  const created=await call('POST',origin+'/v1/device-pairing/sessions',request);
  assert.equal(created.status,200);
  return created.body;
}
const captureRequest={flow:'capture',client:'claude',device_name:'pairing fixture device'};

test('capture device pairing session: RFC 8628 shape, single delivery, working device',async t=>{
  const {app,origin,advance}=await fixture(t);
  const session=await createSession(origin,captureRequest);
  assert.match(session.device_code,/^[A-Za-z0-9_-]{43}$/);assert.match(session.user_code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(session.verification_uri,origin+'/app#thot-pair=');assert.equal(session.verification_uri_complete,origin+'/app#thot-pair='+session.user_code);
  assert.equal(session.interval,5);assert.ok(session.expires_in>0&&session.expires_in<=600);
  const token=await sessionToken(origin);
  assert.equal((await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined)).status,401);
  const info=await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined,token);
  assert.equal(info.status,200);assert.equal(info.body.flow,'capture');assert.equal(info.body.client,'claude');assert.equal(info.body.device_name,'pairing fixture device');
  assert.equal(info.body.status,'pending');assert.ok(info.body.request_ip);
  const pending=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:session.device_code});
  assert.equal(pending.status,200);assert.equal(pending.body.status,'pending');
  const approved=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/approve',{save_privately:true},token);
  assert.equal(approved.status,200);assert.equal(approved.body.status,'approved');assert.ok(approved.body.device_id);assert.equal(approved.body.account_id,actor.id);
  assert.ok(!JSON.stringify(approved.body).includes('device_token'),'approval response carries no credential');
  advance(6_000);
  const delivered=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:session.device_code});
  assert.equal(delivered.status,200);assert.equal(delivered.body.status,'approved');
  assert.match(delivered.body.device_id,/^[a-f0-9-]{36}$/);assert.match(delivered.body.device_token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(delivered.body.client,'claude');assert.equal(delivered.body.account_id,actor.id);assert.equal(delivered.body.automatic_sales,false);
  advance(6_000);
  const reused=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:session.device_code});
  assert.equal(reused.status,409);assert.equal(reused.body.error,'PAIRING_ALREADY_DELIVERED');
  const stored=(await app.db.query('SELECT document FROM auth_access WHERE id=$1',['device-pairing:'+createHash('sha256').update(session.device_code).digest('hex')])).rows[0].document;
  assert.ok(!JSON.stringify(stored).includes(delivered.body.device_token),'delivered credential is not retained');
  const capture=await app.captureDevices.begin(delivered.body.device_id,delivered.body.device_token,{client:'claude',project:'pairing-project'});
  assert.ok(capture.capture_id);assert.equal(capture.account_id,actor.id);
});

test('wrong, expired, denied and reused codes fail with distinct messages on both sides',async t=>{
  const {origin,advance}=await fixture(t);
  const token=await sessionToken(origin);
  const wrongPoll=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:'A'.repeat(43)});
  assert.equal(wrongPoll.status,401);assert.equal(wrongPoll.body.error,'PAIRING_NOT_FOUND');
  const wrongLookup=await call('GET',origin+'/v1/contributor/device-pairing/ZZZZ-ZZZZ',undefined,token);
  assert.equal(wrongLookup.status,404);assert.equal(wrongLookup.body.error,'PAIRING_NOT_FOUND');
  const wrongApprove=await call('POST',origin+'/v1/contributor/device-pairing/zzzzzzzz/approve',{},token);
  assert.equal(wrongApprove.status,404);assert.equal(wrongApprove.body.error,'PAIRING_NOT_FOUND');
  const denied=await createSession(origin,captureRequest);
  assert.equal((await call('POST',origin+'/v1/contributor/device-pairing/'+denied.user_code+'/deny',{},token)).status,200);
  const deniedApprove=await call('POST',origin+'/v1/contributor/device-pairing/'+denied.user_code+'/approve',{},token);
  assert.equal(deniedApprove.status,403);assert.equal(deniedApprove.body.error,'PAIRING_DENIED');
  const deniedPoll=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:denied.device_code});
  assert.equal(deniedPoll.status,403);assert.equal(deniedPoll.body.error,'PAIRING_DENIED');
  const used=await createSession(origin,captureRequest);
  await call('POST',origin+'/v1/contributor/device-pairing/'+used.user_code+'/approve',{save_privately:true},token);
  const reused=await call('POST',origin+'/v1/contributor/device-pairing/'+used.user_code+'/approve',{save_privately:true},token,'second-approve-key');
  assert.equal(reused.status,409);assert.equal(reused.body.error,'PAIRING_ALREADY_USED');
  const expired=await createSession(origin,captureRequest);
  advance(601_000);
  const expiredPoll=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:expired.device_code});
  assert.equal(expiredPoll.status,410);assert.equal(expiredPoll.body.error,'PAIRING_EXPIRED');
  const expiredApprove=await call('POST',origin+'/v1/contributor/device-pairing/'+expired.user_code+'/approve',{},token);
  assert.equal(expiredApprove.status,410);assert.equal(expiredApprove.body.error,'PAIRING_EXPIRED');
  const expiredInfo=await call('GET',origin+'/v1/contributor/device-pairing/'+expired.user_code,undefined,token);
  assert.equal(expiredInfo.status,410);assert.equal(expiredInfo.body.error,'PAIRING_EXPIRED');
  // Expired sessions are cleaned up, so new sessions still work afterwards.
  assert.equal((await createSession(origin,captureRequest)).user_code.length,9);
});

test('approval binds to one account; polling faster than the interval slows down',async t=>{
  const {origin}=await fixture(t);
  const first=await sessionToken(origin);
  const second=((await (await fetch(origin+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'pairing-test-session-2'},body:'{"role":"user"}'})).json()) as any).token as string;
  const session=await createSession(origin,captureRequest);
  const approve=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/approve',{save_privately:true},first);
  assert.equal(approve.status,200);
  const other=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/approve',{save_privately:true},second,'other-account-approve');
  assert.equal(other.status,409);assert.equal(other.body.error,'PAIRING_ALREADY_USED');
  const delivered=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:session.device_code});
  assert.equal(delivered.body.account_id,actor.id,'the credential belongs to the first approver');
  const fresh=await createSession(origin,captureRequest);
  await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:fresh.device_code});
  const rushed=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:fresh.device_code});
  assert.equal(rushed.status,429);assert.equal(rushed.body.error,'PAIRING_SLOW_DOWN');
});

test('history pairing delivers a matching private-only grant',async t=>{
  const {app,origin}=await fixture(t);
  const token=await sessionToken(origin);
  const sourceIds=['a'.repeat(32)];
  const session=await createSession(origin,{flow:'history',client:'codex',device_name:'history box',source_ids:sourceIds,backfill:false,daily_time_utc:'02:15'});
  const info=await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined,token);
  assert.equal(info.body.history.source_count,1);assert.equal(info.body.history.daily_time_utc,'02:15');assert.equal(info.body.history.backfill,false);
  const refused=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/approve',{},token);
  assert.equal(refused.status,400);assert.equal(refused.body.error,'HISTORY_CONSENT_REQUIRED');
  const infoAgain=await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined,token,'retry-info');
  assert.equal(infoAgain.body.status,'pending','a refused approval leaves the code usable');
  const approved=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/approve',{consent:'private-history-upload-v1'},token,'consenting-approve');
  assert.equal(approved.status,200);assert.equal(approved.body.private_only,true);
  const delivered=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:session.device_code});
  assert.equal(delivered.body.private_only,true);assert.deepEqual(delivered.body.source_ids,sourceIds);assert.equal(delivered.body.daily_time_utc,'02:15');
  const status=await app.historyDevices.status(delivered.body.device_id,delivered.body.device_token);
  assert.equal(status.status,'CONNECTED');assert.equal(status.account_id,actor.id);
});

const verifier: EvidenceVerifier=async(_evidence,ticket)=>{
  const payload=JSON.parse(Buffer.from(ticket.split('.')[0]!,'base64url').toString());
  return {verified:true,owner_user_id:payload.owner_user_id,job_id:payload.job_id,link_ticket_hash:payload.link_ticket_hash,subject:'a'.repeat(64),observed_at:payload.issued_at};
};
test('robinhood pairing delivers the link input and relays progress both ways',async t=>{
  const {origin,advance}=await fixture(t,{robinhood:{witnessUrl:'https://witness.example/test',appraiserUrl:'https://appraiser.example/test'},brokerageVerifier:verifier});
  const token=await sessionToken(origin);
  const session=await createSession(origin,{flow:'robinhood',device_name:'rh machine',extension_dir:'/tmp/extension'});
  const approved=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/approve',{},token);
  assert.equal(approved.status,200);assert.ok(approved.body.job_id);
  const delivered=await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:session.device_code});
  assert.equal(delivered.body.job_id,approved.body.job_id);assert.equal(typeof delivered.body.link_ticket,'string');
  assert.equal(delivered.body.witness_url,'https://witness.example/test');assert.equal(delivered.body.appraiser_url,'https://appraiser.example/test');
  assert.equal(typeof delivered.body.thot_public_key_pem,'string');
  const noProof=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/saved',{},token);
  assert.equal(noProof.status,409);assert.equal(noProof.body.error,'NO_PROOF');
  const early=await call('POST',origin+'/v1/device-pairing/sessions/events',{device_code:session.device_code,stage:'capturing',error:'X'});
  assert.equal(early.status,400);assert.equal(early.body.error,'INVALID_PAIRING_EVENT');
  const stage=await call('POST',origin+'/v1/device-pairing/sessions/events',{device_code:session.device_code,stage:'awaiting_extension'});
  assert.equal(stage.status,200);assert.equal(stage.body.saved,false);assert.equal(stage.body.cancelled,false);
  const info=await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined,token,'relay-info');
  assert.equal(info.body.robinhood.stage,'awaiting_extension');assert.equal(info.body.robinhood.extension_dir,'/tmp/extension');
  const evidence={credential:{fixture:'TEST ONLY'},witness_receipts:[]};
  advance(1_000);
  assert.equal((await call('POST',origin+'/v1/device-pairing/sessions/events',{device_code:session.device_code,evidence})).status,200);
  const ready=await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined,token,'ready-info');
  assert.equal(ready.body.robinhood.stage,'proof_ready');assert.deepEqual(ready.body.robinhood.evidence,evidence);
  assert.equal((await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/saved',{},token,'saved-key')).status,200);
  advance(1_000);
  const signal=await call('POST',origin+'/v1/device-pairing/sessions/events',{device_code:session.device_code,stage:'proof_ready'});
  assert.equal(signal.body.saved,true,'the helper learns the browser saved the proof');
  const captureSession=await createSession(origin,captureRequest);
  await call('POST',origin+'/v1/contributor/device-pairing/'+captureSession.user_code+'/approve',{save_privately:true},token,'cross-flow-approve');
  await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:captureSession.device_code});
  const unsupported=await call('POST',origin+'/v1/device-pairing/sessions/events',{device_code:captureSession.device_code,stage:'capturing'});
  assert.equal(unsupported.status,409);assert.equal(unsupported.body.error,'PAIRING_FLOW_UNSUPPORTED');
  const cancelled=await createSession(origin,{flow:'robinhood',device_name:'rh machine'});
  await call('POST',origin+'/v1/contributor/device-pairing/'+cancelled.user_code+'/approve',{},token,'cancel-approve');
  await call('POST',origin+'/v1/device-pairing/sessions/token',{device_code:cancelled.device_code});
  assert.equal((await call('POST',origin+'/v1/contributor/device-pairing/'+cancelled.user_code+'/cancel',{},token,'cancel-key')).status,200);
  const cancelledSignal=await call('POST',origin+'/v1/device-pairing/sessions/events',{device_code:cancelled.device_code,stage:'capturing'});
  assert.equal(cancelledSignal.body.cancelled,true,'the helper learns the browser cancelled');
});

test('unconfigured Robinhood pairing refuses approval and keeps the code pending',async t=>{
  const {origin}=await fixture(t);
  const token=await sessionToken(origin);
  const session=await createSession(origin,{flow:'robinhood',device_name:'rh machine'});
  const refused=await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/approve',{},token);
  assert.equal(refused.status,503);assert.equal(refused.body.error,'ROBINHOOD_LINKING_UNAVAILABLE');
  const info=await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined,token,'after-refusal');
  assert.equal(info.body.status,'pending');
  assert.equal((await call('POST',origin+'/v1/contributor/device-pairing/'+session.user_code+'/deny',{},token,'deny-after-refusal')).status,200);
});

test('create and code lookups are rate limited',async t=>{
  const {origin}=await fixture(t);
  let limited=false;
  for(let i=0;i<130&&!limited;i++){
    const response=await call('POST',origin+'/v1/device-pairing/sessions',captureRequest);
    if(response.status===429){assert.equal(response.body.error,'PAIRING_RATE_LIMIT');limited=true;}
    else assert.equal(response.status,200);
  }
  assert.ok(limited,'session creation is rate limited');
});
test('per-account code lookups are rate limited',async t=>{
  const {origin}=await fixture(t);
  const token=await sessionToken(origin);
  const session=await createSession(origin,captureRequest);
  let limited=false;
  for(let i=0;i<120&&!limited;i++){
    const response=await call('GET',origin+'/v1/contributor/device-pairing/'+session.user_code,undefined,token,'lookup-'+i);
    if(response.status===429){assert.equal(response.body.error,'PAIRING_RATE_LIMIT');limited=true;}
    else assert.equal(response.status,200);
  }
  assert.ok(limited,'per-account lookups are rate limited');
});

test('helpers pair by code and fall back from an unreachable loopback callback',async t=>{
  const {app,origin,root}=await fixture(t),token=await sessionToken(origin);
  const approveFrom=(url:string)=>call('POST',origin+'/v1/contributor/device-pairing/'+new URL(url).hash.slice('#thot-pair='.length)+'/approve',{save_privately:true},token,'approve-'+Math.random());
  const forced=await connectCapture({origin,client:'claude',project:'forced-code',root,pairing:'code',open:async url=>{assert.equal((await approveFrom(url)).status,200);return true;},log:()=>{}});
  assert.equal(forced.account_id,actor.id);assert.ok(forced.capture_id);
  const reused=await connectCapture({origin,client:'claude',project:'again',root,pairing:'code',open:async()=>true,log:()=>{}});
  assert.ok(reused.upload_token,'a remembered connection survives the code path');
  assert.equal((await app.captureDevices.list(actor)).devices.length,1,'the remembered path opens no second browser pairing');
  const logs:string[]=[];let approve:Promise<unknown>=Promise.resolve();
  const fallen=connectCapture({origin,client:'codex',project:'fallback',root,fallbackMs:150,open:async()=>false,log:message=>{logs.push(message);const code=/^  Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})$/.exec(message)?.[1];if(code&&!logs.includes('approved')){logs.push('approved');approve=call('POST',origin+'/v1/contributor/device-pairing/'+code+'/approve',{save_privately:true},token,'fallback-approve');}}});
  const fallbackConnection=await fallen;assert.equal(await approve.then(r=>(r as any).status),200);
  assert.equal(fallbackConnection.account_id,actor.id);assert.ok(fallbackConnection.capture_id);
  assert.ok(logs.some(l=>l.includes('Pair with a code instead')),'the fallback prints the code');
  const devices=await app.captureDevices.list(actor);
  assert.equal(devices.devices.length,2);assert.ok(!JSON.stringify(devices).includes('token'));
  const sourceDir=join(root,'history-source');await mkdir(sourceDir);
  await writeFile(join(sourceDir,'synthetic.jsonl'),JSON.stringify({type:'user',message:{role:'user',content:'synthetic pairing fixture'}})+'\n');
  const historyState=await createHistoryState({origin,client:'claude',paths:[sourceDir],backfill:true,time:'03:00'});
  const historyDir=join(root,'history-'+historyState.id);
  const historyPaired=connectHistory(historyState,historyDir,{pairing:'code',open:async url=>{
    const code=new URL(url).hash.slice('#thot-pair='.length);
    const result=await call('POST',origin+'/v1/contributor/device-pairing/'+code+'/approve',{consent:'private-history-upload-v1'},token,'history-approve');
    assert.equal(result.status,200);return true;
  },log:()=>{}});
  await historyPaired;
  const grant=(await (await import('../packages/capture/src/local-state.ts')).loadPrivate(historyDir)).grant;
  assert.deepEqual(grant.source_ids,historyState.sources.map(s=>s.id));assert.equal(grant.private_only,true);
});
