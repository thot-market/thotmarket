import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer, dstackMasterKey } from '../apps/api/server.ts';

test('public origin replaces the loopback host and origin policy',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thot-cvm-'));const app=await createApplication({memory:true,dataDir});
  const server=createHttpServer(app,{publicOrigin:'https://demo.example'});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await app.close();await rm(dataDir,{recursive:true,force:true});});
  const get=(headers:Record<string,string>)=>new Promise<{status:number}>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:'/healthz',headers,setHost:false},res=>{res.resume();resolve({status:res.statusCode!});});req.on('error',reject);req.end();});
  assert.equal((await get({Host:'demo.example'})).status,200);
  assert.equal((await get({Host:'demo.example',Origin:'https://demo.example'})).status,200);
  assert.equal((await get({Host:`127.0.0.1:${port}`})).status,403);
  assert.equal((await get({Host:'demo.example',Origin:'http://demo.example'})).status,403);
  assert.equal((await get({Host:'other.example'})).status,403);
});

test('dstack master key is derived from GetKey and is deterministic',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-sock-'));const socketPath=join(dir,'dstack.sock');let status=200;
  const guest=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    assert.equal(req.url,'/GetKey');assert.deepEqual(JSON.parse(raw),{path:'thot/master-key/v1',purpose:'thot-master-key'});
    res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({key:'ab'.repeat(32),signature_chain:[]}));});});
  await new Promise<void>(resolve=>guest.listen(socketPath,resolve));
  t.after(async()=>{await new Promise(resolve=>guest.close(resolve));await rm(dir,{recursive:true,force:true});});
  const first=await dstackMasterKey(socketPath);assert.equal(first.length,32);assert.deepEqual(first,await dstackMasterKey(socketPath));
  status=500;await assert.rejects(dstackMasterKey(socketPath),/DSTACK_GET_KEY_FAILED/);
  await assert.rejects(dstackMasterKey(join(dir,'missing.sock')),/ENOENT/);
});

test('external top-level redirects can load only the public app shell, with API and Host protections intact',async t=>{
  for(const publicOrigin of [undefined,'https://demo.example']){
    const dataDir=await mkdtemp(join(tmpdir(),'thot-navigation-'));
    const app=await createApplication({memory:true,dataDir});const server=createHttpServer(app,{publicOrigin});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
    t.after(async()=>{await new Promise(resolve=>server.close(resolve));await app.close();await rm(dataDir,{recursive:true,force:true});});
    const host=publicOrigin?'demo.example':`127.0.0.1:${port}`;
    const navigation={Host:host,Origin:'https://login.example','Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
    const call=(path:string,method='GET',headers:Record<string,string>=navigation)=>new Promise<number>((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port,path,method,headers,setHost:false},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();
    });
    assert.equal(await call('/?__clerk_handshake=synthetic'),200);
    assert.equal(await call('/index.html'),200);
    assert.equal(await call('/getting-started'),200);
    assert.equal(await call('/v1/auth/session'),403);
    assert.equal(await call('/v1/auth/capabilities'),403);
    assert.equal(await call('/app.js'),403);
    assert.equal(await call('/','POST'),403);
    assert.equal(await call('/','GET',{...navigation,'Sec-Fetch-Mode':'cors'}),403);
    assert.equal(await call('/','GET',{...navigation,'Sec-Fetch-Dest':'iframe'}),403);
    assert.equal(await call('/','GET',{...navigation,Host:'wrong.example'}),403);
  }
});

test('integrated Plaid refresh and OAuth-resume routes reach their handlers',async t=>{
  const app=await createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-plaid-routes-'))});
  const server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await app.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const session=await (await fetch(origin+'/v1/dev/session',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'route-session'},body:JSON.stringify({role:'user'})})).json() as any;
  const headers={Authorization:'Bearer '+session.token,'content-type':'application/json','idempotency-key':'route-refresh'};
  const refresh=await fetch(origin+'/v1/contributor/plaid/refresh',{method:'POST',headers,body:'{}'});
  assert.equal(refresh.status,503);assert.equal((await refresh.json() as any).error,'PLAID_LINKING_UNAVAILABLE');
  const pending=await fetch(origin+'/v1/contributor/plaid/link-token',{headers});
  assert.equal(pending.status,409);assert.equal((await pending.json() as any).error,'LINK_NOT_PENDING');
});
