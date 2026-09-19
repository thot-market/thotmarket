import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import {DomainError, type Document} from '../packages/storage/src/index.ts';

async function setup(t:any,options:{clock?:()=>number}={}) {
  const app=await createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-http-'))});
  const logs:Document[]=[];const server=createHttpServer(app,{...options,log:event=>logs.push(event)});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await app.close();});
  const call=async(path:string,{token='',body,method=body?'POST':'GET',headers={},key=randomUUID()}:Document={})=>{
    const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':key}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const session=async(role:string)=>(await call('/v1/dev/session',{body:{role}})).body.token;
  return {app,logs,server,base,call,session};
}

test('HTTP end-to-end: browser contract supports local import, manual approval, delivery, earnings and burn',async t=>{
  const{call,session,logs}=await setup(t);const user=await session('user'),buyer=await session('buyer_admin');
  assert.equal((await call('/healthz')).body.mode,'local-development');
  assert.equal((await call('/v1/dev/policy',{token:user,body:{}})).status,200);
  const imported=await call('/v1/dev/trace',{token:user,body:{scenario:'professional'}});assert.equal(imported.status,200);
  assert.equal((await call('/v1/dev/mandate',{token:buyer,body:{category:'professional_flow'}})).status,200);
  assert.equal((await call('/v1/dev/run-worker',{token:user,body:{}})).body.failed,0);
  const candidates=(await call('/v1/candidates',{token:user})).body;assert.equal(candidates.length,1);
  const preview=(await call(`/v1/candidates/${candidates[0].candidate_id}/preview`,{token:user})).body;
  const{release,...fields}=preview;const key=randomUUID();
  const sale=await call('/v1/sale-authorizations',{token:user,key,body:{...fields,payout_preference:'inference_credit'}});assert.equal(sale.status,200);
  assert.deepEqual((await call('/v1/sale-authorizations',{token:user,key,body:{...fields,payout_preference:'inference_credit'}})).body,sale.body);
  const licensed=(await call('/v1/candidates',{token:user})).body[0];
  assert.equal(licensed.status,'LICENSED');assert.equal(licensed.license_id,sale.body.license_id,'local candidates retain the license ID needed to reconcile pending payments');
  assert.equal((await call('/v1/earnings',{token:user})).body.settlements.length,0,'authorization alone is not a settlement');
  await call('/v1/dev/run-worker',{token:user,body:{}});
  const delivery=await call(`/v1/buyer/deliveries/${sale.body.license_id}`,{token:buyer});assert.equal(delivery.status,200);
  assert.equal(delivery.body.delivery.bundle_hash,preview.release_artifact_hash);
  const earnings=(await call('/v1/earnings',{token:user})).body;
  assert.equal(earnings.entitlements[0].amount_minor,'6500');
  assert.equal(earnings.settlements[0].license_id,licensed.license_id);
  assert.equal(earnings.entitlements[0].settlement_id,earnings.settlements[0].settlement_id);
  assert.equal(earnings.entitlements[0].license_id,licensed.license_id);
  const burn=await call('/v1/dev/complete-burns',{token:user,body:{}});assert.equal(burn.body.simulated,true);assert.equal(burn.body.burns_completed,1);
  const output=JSON.stringify(logs);for(const secret of [user,buyer,'sample contract clause','cohort:law_firm_eligible_v1','signature'])assert.ok(!output.includes(secret));
});
test('HTTP security: bearer identity, roles and private endpoint isolation are enforced',async t=>{
  const{call,session}=await setup(t);const user=await session('user'),buyer=await session('buyer_admin'),operator=await session('operator_security');
  assert.equal((await call('/v1/traces')).status,401);
  assert.equal((await call('/v1/traces',{token:'not-a-session'})).status,401);
  assert.equal((await call('/v1/traces',{token:buyer})).status,403);
  assert.equal((await call('/v1/traces',{token:operator})).status,403);
  assert.equal((await call('/v1/operator/reconciliation',{token:user})).status,403);
  assert.equal((await call('/v1/dev/mandate',{token:user,body:{}})).status,403);
  assert.equal((await call('/v1/internal/vault',{token:buyer})).status,404);
  assert.equal((await call('/v1/internal/assay',{token:buyer})).status,404);
  assert.equal((await call('/v1/dev/session',{body:{role:'service_settlement'}})).status,403);
});
test('HTTP security: hostile origins/hosts, malformed JSON, missing keys and arbitrary code are rejected safely',async t=>{
  const{call,session,base,logs}=await setup(t);const user=await session('user');
  assert.equal((await call('/v1/dev/session',{body:{role:'user'},headers:{Origin:'https://attacker.invalid'}})).status,403);
  const hostileHostStatus=await new Promise<number>((resolve,reject)=>{
    const req=request(base+'/healthz',{headers:{Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode!);});req.on('error',reject);req.end();
  });
  assert.equal(hostileHostStatus,403);
  assert.equal((await call('/v1/dev/trace',{token:user,body:{scenario:'coding'},headers:{'Idempotency-Key':''}})).status,400);
  const malformed=await fetch(base+'/v1/traces/import',{method:'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:'{"secret":"DO_NOT_LOG_THIS"'});
  assert.equal(malformed.status,400);assert.equal((await malformed.json()).error,'INVALID_JSON');
  const wrongType=await fetch(base+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{"role":"user"}'});assert.equal(wrongType.status,415);
  const oversized=await new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=request(base+'/v1/traces/import',{method:'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'Content-Length':'4000001'}},response=>{
      let raw='';response.setEncoding('utf8');response.on('data',chunk=>raw+=chunk);response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(raw)}));
    });req.on('error',reject);req.end();
  });
  assert.equal(oversized.status,413);assert.equal(oversized.body.error,'REQUEST_TOO_LARGE');
  assert.ok(!JSON.stringify(logs).includes('DO_NOT_LOG_THIS'));
});
test('HTTP dashboard and disclosure key are local, protected by CSP and contain no third-party assets',async t=>{
  const{base,call}=await setup(t);const page=await fetch(base+'/');const html=await page.text();
  assert.equal(page.status,200);assert.match(html,/thot market/);assert.match(page.headers.get('content-security-policy')!,/connect-src 'self'/);
  assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);assert.ok(!/src="https?:/i.test(html));
  const appPage=await fetch(base+'/app');assert.match(await appPage.text(),/href="\/staking.css"/);
  for(const [path,type] of [['/staking-ui.js','text/javascript'],['/staking.css','text/css']]){const asset=await fetch(base+path);assert.equal(asset.status,200);assert.ok(asset.headers.get('content-type')?.startsWith(type));assert.ok((await asset.text()).length>0);}
  const keys=(await call('/v1/public/keys')).body;assert.match(keys.disclosure.public_key_pem,/BEGIN PUBLIC KEY/);
});

test('unexpected workspace failures are private server errors while explicit validation and domain statuses remain intact',async t=>{
  const{app,call,session,logs}=await setup(t);const user=await session('user');
  const privateFailure='upstream unavailable https://rpc.invalid/private-api-key; trace body DO_NOT_DISCLOSE';
  app.thot.workspace=async()=>{throw new Error(privateFailure);};
  const failed=await call('/v1/thot/workspace',{token:user});
  assert.equal(failed.status,500);assert.equal(failed.body.error,'INTERNAL_ERROR');
  assert.deepEqual(Object.keys(failed.body).sort(),['error','request_id']);
  assert.equal(failed.headers.get('cache-control'),'no-store');
  assert.ok(!JSON.stringify(failed.body).includes(privateFailure));
  assert.ok(!JSON.stringify(logs).includes(privateFailure));
  assert.equal(logs.at(-1)?.status,500);
  for(const [error,status,code] of [
    [new DomainError('THOT_WAIT_FOR_CONFIRMATIONS',409),409,'THOT_WAIT_FOR_CONFIRMATIONS'],
    [new DomainError('THOT_BLOCK_UNAVAILABLE',503),503,'THOT_BLOCK_UNAVAILABLE'],
    [new Error('INVALID_SIGNATURE'),400,'INVALID_SIGNATURE'],
  ] as const){
    app.thot.workspace=async()=>{throw error;};
    const result=await call('/v1/thot/workspace',{token:user});assert.equal(result.status,status);assert.equal(result.body.error,code);
  }
});

test('read diagnostics are operator-only and preserve RPC categories without sensitive exception data',async t=>{
  const{app,call,session,logs}=await setup(t),user=await session('user'),buyer=await session('buyer_admin'),operator=await session('operator_security');
  const secret='DO_NOT_STORE_PRIVATE_TRACE_KEY_OR_WALLET';
  const error=Object.assign(new Error('upstream failed: '+secret),{code:'CALL_EXCEPTION',name:secret,stack:secret,
    info:{error:{code:-32000,message:'header not found '+secret,data:secret},payload:{method:'eth_call',params:[secret]},response:{statusCode:503,headers:{Authorization:secret},body:secret}},
    transaction:{from:secret,data:secret},actor:secret});
  app.thot.workspace=async()=>{throw error;};
  const failure=await call('/v1/thot/workspace?private='+secret,{token:user});assert.equal(failure.status,500);
  assert.equal((await call('/v1/operator/read-diagnostics')).status,401);
  for(const token of [user,buyer])assert.equal((await call('/v1/operator/read-diagnostics',{token})).status,403);
  const result=await call('/v1/operator/read-diagnostics',{token:operator});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(result.body.entries.length,1);const entry=result.body.entries[0];
  assert.deepEqual(entry,{request_id:failure.body.request_id,observed_at:entry.observed_at,route:'/v1/thot/workspace',phase:'handling',family:'ethers',code:'CALL_EXCEPTION',exception_type:'Error',transient_reason:'block_unavailable',rpc_code:-32000,rpc_method:'eth_call',http_status:503});
  assert.ok(!JSON.stringify([result.body,logs]).includes(secret));assert.ok(!JSON.stringify(result.body).includes(user));
  entry.code='MODIFIED_CLIENT_COPY';
  const again=await call('/v1/operator/read-diagnostics',{token:operator});assert.equal(again.body.entries[0].code,'CALL_EXCEPTION');
});

test('diagnostics use fixed enums for unknown fields, bounded reason classification and serialization phase',async t=>{
  const{app,call,session,logs}=await setup(t),user=await session('user'),operator=await session('operator_security');
  const secret='PRIVATE_DETAILS_DO_NOT_RECORD';
  const examples=[
    {error:Object.assign(new TypeError('unexpected value: '+secret),{code:secret,name:secret,payload:{method:secret},error:{code:secret,message:secret},info:{response:{statusCode:secret}}}),expected:{family:'builtin',code:'UNCLASSIFIED',exception_type:'TypeError',transient_reason:'other'}},
    {error:Object.assign(new Error('upstream failed: '+secret),{code:'SERVER_ERROR',error:{code:-32005,message:'too many requests'},payload:{method:'eth_getCode',params:[secret]},response:{statusCode:429,body:secret}}),expected:{family:'ethers',code:'SERVER_ERROR',exception_type:'Error',transient_reason:'rate_limit',rpc_code:-32005,rpc_method:'eth_getCode',http_status:429}},
    {error:Object.assign(new Error('upstream failed: '+secret),{code:'CALL_EXCEPTION',info:{error:{code:3,message:'execution reverted: unknown block'},payload:{method:'eth_call'}}}),expected:{family:'ethers',code:'CALL_EXCEPTION',exception_type:'Error',transient_reason:'contract_revert',rpc_code:3,rpc_method:'eth_call'}},
    {error:Object.assign(new Error('upstream failed: '+secret),{code:'UNKNOWN_ERROR',info:{error:{message:'x'.repeat(512)+'header not found'}}}),expected:{family:'ethers',code:'UNKNOWN_ERROR',exception_type:'Error',transient_reason:'other'}},
    {error:new DomainError('THOT_BLOCK_UNAVAILABLE',503),expected:{family:'domain',code:'THOT_BLOCK_UNAVAILABLE',exception_type:'Other',transient_reason:'other'}},
  ];
  for(const example of examples){app.thot.workspace=async()=>{throw example.error;};await call('/v1/thot/workspace',{token:user});}
  app.service.traces=async()=>({unsupported:undefined}) as any;
  assert.equal((await call('/v1/traces?secret='+secret,{token:user})).status,500);
  const response=await call('/v1/operator/read-diagnostics',{token:operator}),entries=response.body.entries;
  assert.equal(entries.length,examples.length+1);
  for(let index=0;index<examples.length;index++){
    const{request_id,observed_at,route,phase,...fields}=entries[index];assert.equal(route,'/v1/thot/workspace');assert.equal(phase,'handling');assert.deepEqual(fields,examples[index]!.expected);
  }
  assert.equal(entries.at(-1).route,'other');assert.equal(entries.at(-1).phase,'response_serialization');
  assert.ok(!JSON.stringify([response.body,logs]).includes(secret));
  // A failure while producing diagnostics cannot recursively add a diagnostic.
  const transaction=app.db.transaction;app.db.transaction=async()=>{throw new Error('storage unavailable: '+secret);};
  try{assert.equal((await call('/v1/operator/read-diagnostics',{token:operator})).status,500);}
  finally{app.db.transaction=transaction;}
  assert.equal((await call('/v1/operator/read-diagnostics',{token:operator})).body.entries.length,entries.length);
});

test('read diagnostics retain only the latest32 errors and expire after ten minutes',async t=>{
  let now=Date.now();const{app,call,session}=await setup(t,{clock:()=>now}),user=await session('user'),operator=await session('operator_security');
  app.thot.workspace=async()=>{throw new Error('upstream read unavailable');};
  const ids=[];
  for(let index=0;index<36;index++){const failure=await call('/v1/thot/workspace',{token:user});assert.equal(failure.status,500);ids.push(failure.body.request_id);now+=100;}
  const bounded=await call('/v1/operator/read-diagnostics',{token:operator});assert.equal(bounded.body.limit,32);assert.equal(bounded.body.retention_seconds,600);
  assert.deepEqual(bounded.body.entries.map((entry:Document)=>entry.request_id),ids.slice(-32));
  now+=600000;assert.equal((await call('/v1/operator/read-diagnostics',{token:operator})).body.entries.length,0);
  await call('/v1/thot/workspace',{token:user});now+=599999;assert.equal((await call('/v1/operator/read-diagnostics',{token:operator})).body.entries.length,1);
  now+=1;assert.equal((await call('/v1/operator/read-diagnostics',{token:operator})).body.entries.length,0);
});
