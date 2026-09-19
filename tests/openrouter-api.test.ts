import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {ExternalAuth} from '../packages/auth/src/index.ts';
import {OPENROUTER_RECORDING_NOTICE_VERSION} from '../packages/market/src/openrouter-relay.ts';
import type {Actor} from '../packages/market/src/service.ts';

const pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'relay-http-fixture',alg:'RS256',use:'sig'};
const issuer='https://relay-test.invalid',audience='relay-tests';
function token(subject:string){const now=Math.floor(Date.now()/1000),fields={iss:issuer,aud:audience,sub:subject,iat:now-1,exp:now+299,jti:randomUUID()};const unsigned=[{alg:'RS256',typ:'at+jwt',kid:jwk.kid},fields].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');return unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),pair.privateKey).toString('base64url');}
const key='sk-or-v1-SYNTHETIC-HTTP-PROVIDER-SECRET';
const consent={api_key:key,recording_consent:true,notice_version:OPENROUTER_RECORDING_NOTICE_VERSION};
const prompt={model:'anthropic/claude-sonnet-4',messages:[{role:'user',content:'PRIVATE_HTTP_PROMPT'}]};
const completion={id:'http-fixture',choices:[{index:0,message:{role:'assistant',content:'PRIVATE_HTTP_ANSWER'},finish_reason:'stop'}]};
const owner:Actor={id:'demo-user',role:'user'},other:Actor={id:'other-user',role:'user'},buyer:Actor={id:'http-buyer',role:'buyer_admin',buyer_id:'demo-buyer'},operator:Actor={id:'http-operator',role:'operator_security'};

async function setup(t:any,transport:typeof fetch=async()=>Response.json(completion)){
  const dir=await mkdtemp(join(tmpdir(),'thot-relay-http-')),app=await createApplication({dataDir:dir,memory:true,openrouter:{enabled:true,transport}});
  await app.db.transaction(async tx=>{for(const actor of [buyer,operator])await tx.insert('users',actor.id,actor.id,{role:actor.role,...(actor.buyer_id?{buyer_id:actor.buyer_id}:{})});});
  const auth=await ExternalAuth.create(app.db,{schema_version:'thot.external-auth/1',jwt:{issuer,audience,max_token_age_seconds:300,jwks:{keys:[jwk]}},initial_memberships:[owner,other,buyer,operator].map(actor=>({subject:actor.id,actor,enabled:true}))});
  const logs:any[]=[],server=createHttpServer(app,{externalAuth:auth,log:event=>logs.push(event)});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();await rm(dir,{recursive:true,force:true});});
  const request=(path:string,credential?:string,body?:any,headers:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(credential?{Authorization:'Bearer '+credential}:{}),...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const connect=async(actor=owner)=>{const response=await request('/v1/contributor/openrouter/connect',token(actor.id),{...consent,api_key:actor.id===owner.id?key:key+'-OTHER'});assert.equal(response.status,200);return response.json();};
  return {app,logs,base,request,connect};
}

test('HTTP management uses normal member auth, preserves tenant boundaries, and relay credentials cannot access the app',async t=>{
  const {request,connect,logs}=await setup(t);
  assert.equal((await request('/v1/contributor/openrouter')).status,401);
  for(const actor of [buyer,operator]){assert.equal((await request('/v1/contributor/openrouter',token(actor.id))).status,403);assert.equal((await request('/v1/contributor/openrouter/connect',token(actor.id),consent)).status,403);}
  assert.equal((await request('/v1/dev/session',undefined,{role:'user'})).status,403);
  const a=await connect(),b=await connect(other);assert.notEqual(a.token,b.token);
  assert.equal((await request('/v1/contributor/openrouter',a.token)).status,401);
  assert.equal((await request('/v1/openrouter/chat/completions',token(owner.id),prompt)).status,401);
  assert.equal((await request('/v1/openrouter/chat/completions',key,prompt)).status,401);
  const captured=await request('/v1/openrouter/chat/completions',a.token,prompt);assert.equal(captured.status,200);await captured.json();
  assert.equal((await (await request('/v1/contributor/openrouter',token(owner.id))).json()).requests.length,1);
  assert.equal((await (await request('/v1/contributor/openrouter',token(other.id))).json()).requests.length,0);
  assert.equal((await request('/v1/contributor/openrouter/disconnect',token(owner.id),{owner_id:other.id})).status,400);
  assert.equal((await request('/v1/contributor/openrouter/disconnect',token(owner.id),{})).status,200);
  assert.equal((await request('/v1/openrouter/chat/completions',a.token,prompt)).status,401);
  assert.equal((await request('/v1/openrouter/chat/completions',b.token,prompt)).status,200);
  const output=JSON.stringify(logs);for(const secret of [a.token,b.token,key,'PRIVATE_HTTP_PROMPT','PRIVATE_HTTP_ANSWER'])assert.ok(!output.includes(secret));
});

test('HTTP relay forwards stable request/trace and replay headers, never rebills a repeated idempotent request',async t=>{
  let calls=0;const {request,connect}=await setup(t,async(url,init)=>{calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal((init!.headers as any).Authorization,'Bearer '+key);return Response.json(completion);}),credential=await connect();
  const headers={'Idempotency-Key':'http-repeatable-request'};
  const first=await request('/v1/openrouter/chat/completions',credential.token,prompt,headers);assert.equal(first.status,200);assert.ok(first.headers.get('x-thot-request-id'));assert.ok(first.headers.get('x-thot-trace-id'));assert.equal(first.headers.get('x-accel-buffering'),'no');assert.deepEqual(await first.json(),completion);
  const replay=await request('/v1/openrouter/chat/completions',credential.token,prompt,headers);assert.equal(replay.status,200);assert.equal(replay.headers.get('x-thot-replayed'),'true');assert.equal(replay.headers.get('x-thot-trace-id'),first.headers.get('x-thot-trace-id'));assert.deepEqual(await replay.json(),completion);assert.equal(calls,1);
  const conflict=await request('/v1/openrouter/chat/completions',credential.token,{...prompt,temperature:0.7},headers);assert.equal(conflict.status,409);assert.equal(calls,1);
});

test('HTTP denies hostile origins, arbitrary upstreams/routes, malformed payloads and unsupported model discovery without forwarding',async t=>{
  let calls=0;const {request,connect,base,logs}=await setup(t,async()=>{calls++;return Response.json(completion);}),credential=await connect(),session=token(owner.id);
  assert.equal((await request('/v1/contributor/openrouter/connect',session,consent,{Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await request('/v1/openrouter/chat/completions',credential.token,prompt,{Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await request('/v1/openrouter/chat/completions',credential.token,prompt,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await request('/v1/openrouter/chat/completions',credential.token,{...prompt,url:'http://127.0.0.1/secrets'})).status,400);
  for(const path of ['/v1/openrouter/models','/v1/openrouter/responses','/v1/openrouter/embeddings','/v1/openrouter/chat/completions/'])assert.ok((await request(path,credential.token,path.endsWith('models')?undefined:prompt)).status>=400);
  const invalid=await fetch(base+'/v1/openrouter/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json'},body:'{"secret":"DO_NOT_LOG_INVALID_JSON"'});assert.equal(invalid.status,400);
  assert.equal((await request('/v1/openrouter/chat/completions',credential.token,prompt,{'Content-Type':'text/plain'})).status,415);
  assert.equal(calls,0);assert.ok(!JSON.stringify(logs).includes('DO_NOT_LOG_INVALID_JSON'));
});

test('HTTP streams SSE incrementally and cancellation aborts provider work while preserving delivered partial capture',async t=>{
  let aborted!:()=>void;const providerAborted=new Promise<void>(resolve=>{aborted=resolve;});
  const {request,connect,app,logs}=await setup(t,async(_url,init)=>new Response(new ReadableStream<Uint8Array>({start(c){
    c.enqueue(Buffer.from('data: '+JSON.stringify({choices:[{index:0,delta:{content:'HTTP_INCREMENTAL_DELIVERY'},finish_reason:null}]})+'\n\n'));
    init!.signal!.addEventListener('abort',()=>{aborted();c.error(Error('synthetic '+key));},{once:true});
  }}),{headers:{'content-type':'text/event-stream'}})),credential=await connect();
  const response=await request('/v1/openrouter/chat/completions',credential.token,{...prompt,stream:true});assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/event-stream/);
  const reader=response.body!.getReader();const part=await reader.read();assert.match(Buffer.from(part.value!).toString(),/HTTP_INCREMENTAL_DELIVERY/);await reader.cancel();
  await Promise.race([providerAborted,new Promise((_,reject)=>setTimeout(()=>reject(Error('provider was not cancelled')),3000))]);
  await app.openrouter.close();
  const r=await app.db.transaction(tx=>tx.get('thot_records',response.headers.get('x-thot-request-id')!));assert.equal(r.status,'INTERRUPTED');assert.ok(r.parts.length);
  assert.match((await app.library.item(owner,r.trace_id)).content.turns.at(-1).content,/HTTP_INCREMENTAL_DELIVERY/);
  assert.ok(!JSON.stringify(logs).includes(key));assert.ok(!JSON.stringify(logs).includes('HTTP_INCREMENTAL_DELIVERY'));
});

test('HTTP provider error responses expose only stable safe codes and cannot leak credentials into logs',async t=>{
  const {request,connect,logs}=await setup(t,async()=>new Response(JSON.stringify({error:{message:key,metadata:{raw:'PRIVATE_PROVIDER_ERROR'}}}),{status:500,headers:{'content-type':'application/json'}})),credential=await connect();
  const response=await request('/v1/openrouter/chat/completions',credential.token,prompt),text=await response.text();assert.equal(response.status,409);assert.equal(response.headers.get('x-should-retry'),'false');assert.match(text,/OPENROUTER_PROVIDER_REJECTED/);
  for(const secret of [credential.token,key,'PRIVATE_PROVIDER_ERROR']){assert.ok(!text.includes(secret));assert.ok(!JSON.stringify(logs).includes(secret));}
});

test('stream enrollment requires rights acknowledgement and recording-only connections cannot smuggle rights flags',async t=>{
 const {request}=await setup(t),session=token(owner.id);
 const denied=await request('/v1/contributor/openrouter/connect',session,{...consent,sale_policy_id:'stream:untrusted',sale_policy_signature:'0x'+'a'.repeat(130)});
 assert.equal(denied.status,400);assert.equal((await denied.json()).error,'STREAM_RIGHTS_REQUIRED');
 const escalation=await request('/v1/contributor/openrouter/connect',session,{...consent,rights_confirmed:true,model_output_licensed:true});
 assert.equal(escalation.status,400);
});
