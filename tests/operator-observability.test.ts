import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {Wallet} from 'ethers';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {OperatorActivity} from '../apps/api/operator-activity.ts';
import {WalletAuth} from '../packages/auth/src/index.ts';
import {OperatorFleet} from '../apps/api/operator-fleet.ts';
test('operator telemetry is role restricted, fleet reports strip extra fields, and regular app excludes console',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-ops-'));const app=await createApplication({memory:true,dataDir:dir});const activity=await OperatorActivity.create({dataDir:dir,db:app.db});const server=createHttpServer(app,{operatorActivity:activity});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};const base='http://127.0.0.1:'+address.port;
 try{
 const session=async(role:string)=>(await (await fetch(base+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})})).json()).token;
 const user=await session('user'),operator=await session('operator_security');
 for(const path of ['product','activity','fleet']){assert.equal((await fetch(base+'/v1/operator/'+path)).status,401);assert.equal((await fetch(base+'/v1/operator/'+path,{headers:{Authorization:'Bearer '+user}})).status,403);assert.equal((await fetch(base+'/v1/operator/'+path,{headers:{Authorization:'Bearer '+operator}})).status,200);}
 const body={observed_at:new Date().toISOString(),secret:'must-disappear',cvms:[{name:'thot-demo',app_id:'a'.repeat(40),status:'running',compose_hash:'b'.repeat(64),observed_at:new Date().toISOString(),health:{status:'ready',observed_at:new Date().toISOString()},allocations:{vcpu:1,memory_gib:2,disk_gib:20},secret:'must-disappear'}]};
 const response=await fetch(base+'/v1/operator/fleet',{method:'POST',headers:{Authorization:'Bearer '+operator,'Content-Type':'application/json','Idempotency-Key':'fleet-test'},body:JSON.stringify(body)});assert.equal(response.status,200);assert(!(await response.text()).includes('must-disappear'));
 const html=await (await fetch(base+'/app')).text();assert(!html.includes('data-view="operations"'));assert((await (await fetch(base+'/ops')).text()).includes('/operator-app.js'));
 }finally{await new Promise<void>(r=>server.close(()=>r()));await activity.close();await app.close();await rm(dir,{recursive:true,force:true});}
});

test('production SIWE cookies authorize configured operators while public Privy configuration grants no role',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-ops-wallet-')), app=await createApplication({memory:true,dataDir:dir});
 const owner=Wallet.createRandom(),ordinary=Wallet.createRandom(),origin='https://thot.example.test';
 const auth=await WalletAuth.create(app.db,{schema_version:'thot.wallet-auth/1',origin,chain_id:46630,allow_public_signup:true,operator_addresses:[owner.address]});
 const activity=await OperatorActivity.create({dataDir:dir,db:app.db});
 const server=createHttpServer(app,{externalAuth:auth,publicOrigin:origin,operatorActivity:activity,privy:{app_id:'c'+'a'.repeat(24)}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); const port=(server.address() as {port:number}).port;
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await activity.close();await app.close();await rm(dir,{recursive:true,force:true});});
 const login=async(wallet:ReturnType<typeof Wallet.createRandom>)=>{
  const challenge=await auth.challenge({address:wallet.address,chain_id:46630},origin);
  const verified=await auth.verify({id:challenge.body.id,message:challenge.body.message,signature:await wallet.signMessage(challenge.body.message)},origin,challenge.set_cookie.split(';')[0]);
  return {actor:verified.body.actor,cookie:verified.set_cookies[0]!.split(';')[0]!};
 };
 const call=(path:string,cookie?:string,extraHeaders:Record<string,string>={})=>new Promise<{status:number;body:string}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,path,headers:{Host:'thot.example.test',...(cookie?{Cookie:cookie}:{}),...extraHeaders}},res=>{
   const chunks:Buffer[]=[];res.on('data',c=>chunks.push(Buffer.from(c)));res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString()}));res.on('error',reject);
  });req.on('error',reject);req.end();
 });
 const operator=await login(owner),user=await login(ordinary);
 assert.equal(operator.actor.role,'operator_security');assert.equal(user.actor.role,'user');
 for(const endpoint of ['environment','product','activity','fleet']){
  assert.equal((await call('/v1/operator/'+endpoint)).status,401);
  assert.equal((await call('/v1/operator/'+endpoint,user.cookie)).status,403);
  const allowed=await call('/v1/operator/'+endpoint,operator.cookie);assert.equal(allowed.status,200);
  for(const sensitive of [owner.address,ordinary.address,dir,operator.cookie])assert(!allowed.body.includes(sensitive));
 }
 const configuration=JSON.parse((await call('/v1/auth/capabilities')).body);assert.equal(configuration.mode,'wallet_siwe');assert(configuration.privy);
 const html=await call('/ops');assert.equal(html.status,200);assert(html.body.includes('/operator-app.js'));assert(!html.body.includes(owner.address));
 const navigation={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
 assert.equal((await call('/ops',undefined,navigation)).status,200);
 assert.equal((await call('/v1/operator/product',operator.cookie,navigation)).status,403,'public shell exception never permits cross-site access to private observations');
});

test('fleet reports remain sanitized after persisted corruption and malformed entries reject cleanly',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-fleet-'));t.after(()=>rm(dir,{recursive:true,force:true}));const fleet=new OperatorFleet(dir);
 await fleet.update({observed_at:new Date().toISOString(),cvms:[]});
 const file=join(dir,'.operator-fleet.json'),stored=JSON.parse(await readFile(file,'utf8'));
 await writeFile(file,JSON.stringify({...stored,secret:'must-not-be-returned'}));
 assert(!JSON.stringify(await fleet.read()).includes('must-not-be-returned'));
 await assert.rejects(fleet.update({observed_at:new Date().toISOString(),cvms:[null]}),/INVALID_FLEET_REPORT/);
 await writeFile(file,'x'.repeat(256*1024+1));assert.equal((await fleet.read()).status,'unavailable');
});
