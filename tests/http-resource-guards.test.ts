import test from 'node:test';
import assert from 'node:assert/strict';
import {request, type ClientRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet} from 'ethers';
import {WalletAuth} from '../packages/auth/src/index.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {ApiAdmission} from '../apps/api/admission.ts';
import {createHttpServer} from '../apps/api/server.ts';

const origin='https://http-budget.example.test',host=new URL(origin).host;
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),'thot-http-budget-'));
 const app=await createApplication({memory:true,dataDir:dir,openrouter:{enabled:true,transport:async()=>{throw Error('NO_PROVIDER_CALL_ALLOWED');}}});
 const auth=await WalletAuth.create(app.db,{schema_version:'thot.wallet-auth/1',origin,chain_id:46630,allow_public_signup:true});
 const logs:any[]=[],server=createHttpServer(app,{admission:new ApiAdmission({limits:{body_bytes_in_flight:32*1024*1024,public_requests:600}}),externalAuth:auth,publicOrigin:origin,log:e=>logs.push(e)});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
 const requests=new Set<ClientRequest>();
 t.after(async()=>{for(const req of requests)req.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();await rm(dir,{recursive:true,force:true});});
 const call=(path:string,options:{method?:string;body?:string;headers?:Record<string,string>;hold?:boolean;expect?:boolean}={})=>{
  let continued=false,accept!:(v:any)=>void,fail!:(e:unknown)=>void;
  const response=new Promise<any>((resolve,reject)=>{accept=resolve;fail=reject;});
  let acceptContinue!:()=>void;const admitted=new Promise<void>(resolve=>{acceptContinue=resolve;});
  const req=request({hostname:'127.0.0.1',port,path,method:options.method??(options.body!==undefined||options.hold?'POST':'GET'),headers:{Host:host,Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(options.expect?{Expect:'100-continue'}:{}),...options.headers}},res=>{
   const chunks:Buffer[]=[];res.on('data',c=>chunks.push(Buffer.from(c)));res.on('error',fail);res.on('end',()=>{let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{body=null;}accept({status:res.statusCode,body,continued});});
  });
  requests.add(req);req.on('continue',()=>{continued=true;acceptContinue();});req.on('error',fail);
  if(options.hold)req.flushHeaders();else req.end(options.body);
  return {req,response,admitted};
 };
 const wallet=Wallet.createRandom(),challenge=await auth.challenge({address:wallet.address,chain_id:46630},origin);
 const verified=await auth.verify({id:challenge.body.id,message:challenge.body.message,signature:await wallet.signMessage(challenge.body.message)},origin,challenge.set_cookie.split(';')[0]);
 return {app,auth,logs,call,cookie:verified.set_cookies[0].split(';')[0],actor:verified.body.actor};
}
const quickly=async<T>(p:Promise<T>)=>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Server waited for an unauthorized request body')),1500);})]);}finally{clearTimeout(timer);}};

test('large requests with absent or invalid credentials are rejected before body or 100 Continue',async t=>{
 const {call}=await fixture(t);
 const targets=[
  {path:'/v1/contributor/import/confirm'},
  {path:'/v1/contributor/import/preview',token:'invalid-session'},
  {path:'/v1/openrouter/chat/completions',token:'thot_or_'+ 'a'.repeat(43)},
  {path:'/v1/capture-devices/'+randomUUID()+'/captures',token:'a'.repeat(43)},
  {path:'/v1/agent-captures/'+randomUUID()+'/parts',token:'b'.repeat(43)},
 ];
 for(const target of targets){const attempt=call(target.path,{hold:true,expect:true,headers:{'Content-Length':'16000000',...(target.token?{Authorization:'Bearer '+target.token}:{})}});const result=await quickly(attempt.response);assert.equal(result.status,401);assert.equal(result.continued,false);attempt.req.destroy();}
});

test('cookie origin checks and small public-auth JSON limits happen before 100 Continue',async t=>{
 const {call,cookie}=await fixture(t);
 const originDenied=call('/v1/contributor/import/confirm',{hold:true,expect:true,headers:{Cookie:cookie,Origin:'https://wrong.example.test','Content-Length':'16000000'}});
 assert.equal((await quickly(originDenied.response)).status,403);
 const oversized=call('/v1/auth/wallet/challenge',{hold:true,expect:true,headers:{'Content-Length':'8193'}});const result=await quickly(oversized.response);assert.equal(result.status,413);assert.equal(result.continued,false);
 const valid=await call('/v1/auth/session',{headers:{Cookie:cookie}}).response;assert.equal(valid.status,200);
});

test('declared and chunked JSON admissions share a 32MiB budget, released after disconnect',async t=>{
 const {call,cookie,logs}=await fixture(t),headers={Cookie:cookie};
 const first=call('/v1/contributor/import/preview',{hold:true,expect:true,headers:{...headers,'Content-Length':'16000000'}});await quickly(first.admitted);
 const second=call('/v1/contributor/import/preview',{hold:true,expect:true,headers:{...headers,'Transfer-Encoding':'chunked'}});await quickly(second.admitted);
 const third=call('/v1/contributor/import/preview',{hold:true,expect:true,headers:{...headers,'Content-Length':'16000000'}});const blocked=await quickly(third.response);assert.equal(blocked.status,503);assert.equal(blocked.body.error,'BODY_ADMISSION_BUSY');assert.equal(blocked.continued,false);
 assert.equal((await call('/v1/auth/session',{headers}).response).status,200,'body intake exhaustion must not block an authenticated read');
 const before=logs.length;void first.response.catch(()=>{});first.req.destroy();
 for(let i=0;logs.length===before&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(logs.length>before,'aborted body releases its reservation');
 const next=call('/v1/contributor/import/preview',{hold:true,expect:true,headers:{...headers,'Content-Length':'16000000'}});await quickly(next.admitted);
 void second.response.catch(()=>{});void next.response.catch(()=>{});second.req.destroy();next.req.destroy();
});

test('public-route rate exhaustion does not spend the authenticated API allowance',async t=>{
 const {call,cookie}=await fixture(t);
 for(let i=0;i<600;i++){const result=await call('/v1/auth/capabilities').response;assert.equal(result.status,200);}
 assert.equal((await call('/v1/auth/capabilities').response).status,429);
 assert.equal((await call('/v1/auth/session',{headers:{Cookie:cookie}}).response).status,200);
 assert.equal((await call('/v1/contributor/library',{headers:{Cookie:cookie}}).response).status,200);
});

test('valid delegated capture/device tokens still work and are not web-session credentials',async t=>{
 const {app,call,actor}=await fixture(t),device=await app.captureDevices.create(actor,{client:'codex',device_name:'resource guard fixture',save_privately:true});
 const capture=await call('/v1/capture-devices/'+device.device_id+'/captures',{body:JSON.stringify({client:'codex',project:'fixture'}),headers:{Authorization:'Bearer '+device.device_token}}).response;assert.equal(capture.status,200);
 const heartbeat=await call('/v1/agent-captures/'+capture.body.capture_id+'/heartbeat',{body:'{}',headers:{Authorization:'Bearer '+capture.body.upload_token}}).response;assert.equal(heartbeat.status,200);
 assert.equal((await call('/v1/contributor/library',{headers:{Authorization:'Bearer '+device.device_token}}).response).status,401);
 const tooLarge=call('/v1/agent-captures/'+capture.body.capture_id+'/parts',{hold:true,expect:true,headers:{Authorization:'Bearer '+capture.body.upload_token,'Content-Length':String(32*1024*1024+1)}});const result=await quickly(tooLarge.response);assert.equal(result.status,413);assert.equal(result.continued,false);
 await app.captureDevices.revoke(actor,'resource-test-revoke',device.device_id);
 const revoked=call('/v1/agent-captures/'+capture.body.capture_id+'/parts',{hold:true,expect:true,headers:{Authorization:'Bearer '+capture.body.upload_token,'Content-Length':'16000000'}});const denied=await quickly(revoked.response);assert.equal(denied.status,401);assert.equal(denied.body.error,'CAPTURE_DEVICE_REVOKED');assert.equal(denied.continued,false);
});

test('a parsed body keeps its admission while its authenticated handler is still running',async t=>{
 const {app,call,cookie}=await fixture(t);let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 app.library.update=async()=>{entered();await gate;return {} as any;};
 const handler=call('/v1/contributor/library/example',{method:'PATCH',body:'{}',headers:{Cookie:cookie,'Transfer-Encoding':'chunked'}});
 let held:ReturnType<typeof call>|undefined,next:ReturnType<typeof call>|undefined;
 try{
  await quickly(started);
  held=call('/v1/contributor/import/preview',{hold:true,expect:true,headers:{Cookie:cookie,'Content-Length':'16000000'}});await quickly(held.admitted);
  const exhausted=call('/v1/contributor/import/preview',{hold:true,expect:true,headers:{Cookie:cookie,'Content-Length':'16000000'}});const response=await quickly(exhausted.response);assert.equal(response.status,503);assert.equal(response.body.error,'BODY_ADMISSION_BUSY');
  release();assert.equal((await quickly(handler.response)).status,200);
  next=call('/v1/contributor/import/preview',{hold:true,expect:true,headers:{Cookie:cookie,'Content-Length':'16000000'}});await quickly(next.admitted);
 }finally{release();if(held){void held.response.catch(()=>{});held.req.destroy();}if(next){void next.response.catch(()=>{});next.req.destroy();}}
});
