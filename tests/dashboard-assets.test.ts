import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {request,type IncomingHttpHeaders} from 'node:http';
import {mkdir,mkdtemp,readFile,rename,rm,symlink,truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {brotliDecompressSync,gunzipSync} from 'node:zlib';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {ApiAdmission} from '../apps/api/admission.ts';
import {createDashboardAssets} from '../apps/api/dashboard-assets.ts';

async function fixture(t:TestContext,admission?:ApiAdmission){
  const dataDir=await mkdtemp(join(tmpdir(),'thot-asset-http-'));
  const app=await createApplication({memory:true,dataDir});
  const server=createHttpServer(app,{admission});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();await rm(dataDir,{recursive:true,force:true});});
  return (path:string,headers:Record<string,string>={},method='GET',body?:string)=>new Promise<{status:number;headers:IncomingHttpHeaders;body:Buffer}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:address.port,path,method,headers},res=>{
      const parts:Buffer[]=[];
      res.on('data',part=>parts.push(part));res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(parts)}));
    });req.on('error',reject);req.end(body);
  });
}

test('dashboard JS/CSS use real negotiated compression with exact wire lengths and unchanged security headers',async t=>{
  const call=await fixture(t);
  for(const route of ['/app.js','/style.css']){
    const source=await readFile(new URL('../apps/dashboard'+route,import.meta.url));
    for(const encoding of ['br','gzip','identity']){
      const response=await call(route,{'Accept-Encoding':encoding});
      assert.equal(response.status,200);
      assert.equal(response.headers['content-encoding'],encoding==='identity'?undefined:encoding);
      assert.equal(Number(response.headers['content-length']),response.body.length);
      const decoded=encoding==='br'?brotliDecompressSync(response.body):encoding==='gzip'?gunzipSync(response.body):response.body;
      assert.deepEqual(decoded,source);
      if(encoding!=='identity')assert.ok(response.body.length<source.length/2,'compress actual dashboard source');
      assert.equal(response.headers.vary,'Accept-Encoding');
      assert.equal(response.headers['cache-control'],'private, no-cache');
      assert.match(response.headers.etag!,/^"[0-9a-f]{64}"$/);
      assert.equal(response.headers['content-type'],route.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
      assert.equal(typeof response.headers['content-security-policy'],'string');
      assert.match(String(response.headers['content-security-policy']),/frame-ancestors 'none'/);
      assert.equal(response.headers['x-content-type-options'],'nosniff');
      assert.equal(response.headers['referrer-policy'],'no-referrer');
    }
  }
});

test('encoding quality, exclusions, wildcard, and identity fallback obey the client negotiation',async t=>{
  const call=await fixture(t);
  const cases:Array<[string|undefined,string|undefined,number]>=[
    [undefined,undefined,200],['',undefined,200],['gzip, br','br',200],
    ['br;q=0.3, gzip;q=0.8','gzip',200],['br;q=0, gzip','gzip',200],
    ['br;q=0, gzip;q=0',undefined,200],['deflate',undefined,200],
    ['gzip;q=0.2, identity;q=1',undefined,200],['*;q=0.5','br',200],
    ['*;q=0, gzip;q=1','gzip',200],['*;q=0',undefined,406],
    ['br;q=0, gzip;q=0, identity;q=0',undefined,406],
    ['br;q=bogus, gzip;q=1.1',undefined,200],['BR;Q=1, gzip;q=0.5','br',200],
  ];
  for(const [accept,encoding,status] of cases){
    const response=await call('/style.css',accept===undefined?{}:{'Accept-Encoding':accept});
    assert.equal(response.status,status,String(accept));assert.equal(response.headers['content-encoding'],encoding,String(accept));
    if(status===406){assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers.etag,undefined);}
  }
});

test('revalidation is representation-specific, supports HEAD and never sends a 304 body',async t=>{
  const call=await fixture(t),first=await call('/app.js',{'Accept-Encoding':'br'}),etag=first.headers.etag!;
  for(const match of [etag,'W/'+etag,'"old-release", W/'+etag,'*']){
    const response=await call('/app.js',{'Accept-Encoding':'br','If-None-Match':match});
    assert.equal(response.status,304);assert.equal(response.body.length,0);
    assert.equal(response.headers.etag,etag);assert.equal(response.headers.vary,'Accept-Encoding');
    assert.equal(response.headers['cache-control'],'private, no-cache');assert.equal(response.headers['content-length'],undefined);
  }
  const stale=await call('/app.js',{'Accept-Encoding':'br','If-None-Match':'"old-release"'});
  assert.equal(stale.status,200);assert.deepEqual(stale.body,first.body);
  const gzip=await call('/app.js',{'Accept-Encoding':'gzip','If-None-Match':etag});
  assert.equal(gzip.status,200);assert.notEqual(gzip.headers.etag,etag);
  const head=await call('/app.js',{'Accept-Encoding':'br'},'HEAD');
  assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers.etag,etag);
  assert.equal(head.headers['content-length'],first.headers['content-length']);assert.equal(head.headers['content-encoding'],'br');
  assert.equal((await call('/app.js',{'Accept-Encoding':'br','If-None-Match':etag},'HEAD')).status,304);
});

test('cached public assets remain behind host, origin and public request admission checks',async t=>{
  const call=await fixture(t),first=await call('/app.js',{'Accept-Encoding':'gzip'});
  const denialHeaders:Record<string,string>[]=[{Host:'attacker.invalid'},{Origin:'https://attacker.invalid'},{'Sec-Fetch-Site':'cross-site'}];
  for(const headers of denialHeaders){
    const denied=await call('/app.js',{...headers,'Accept-Encoding':'gzip','If-None-Match':first.headers.etag!});
    assert.equal(denied.status,403);assert.equal(denied.headers['cache-control'],'no-store');
    assert.equal(denied.headers['content-encoding'],undefined);assert.equal(denied.headers.etag,undefined);
  }
  const limited=await fixture(t,new ApiAdmission({limits:{public_requests:2}}));
  const fresh=await limited('/style.css',{'Accept-Encoding':'br'});
  assert.equal(fresh.status,200);
  assert.equal((await limited('/style.css',{'Accept-Encoding':'br','If-None-Match':fresh.headers.etag!})).status,304);
  const blocked=await limited('/style.css',{'Accept-Encoding':'br','If-None-Match':fresh.headers.etag!});
  assert.equal(blocked.status,429);assert.equal(blocked.headers['cache-control'],'no-store');
  assert.equal(blocked.headers['content-encoding'],undefined);assert.equal(blocked.headers.etag,undefined);
});

test('compression never includes private/API bodies, request secrets or non-allowlisted files',async t=>{
  const call=await fixture(t),secret='synthetic_request_secret_do_not_embed';
  const headers={'Accept-Encoding':'br, gzip','If-None-Match':'*'};
  const session=await call('/v1/dev/session',{'Content-Type':'application/json',...headers},'POST',JSON.stringify({role:'user'}));
  assert.equal(session.status,200);const token=JSON.parse(session.body.toString()).token;
  assert.equal(session.headers['cache-control'],'no-store');assert.equal(session.headers['content-encoding'],undefined);assert.equal(session.headers.etag,undefined);
  for(const path of ['/app','/ops','/getting-started','/healthz','/v1/auth/capabilities','/v1/traces','/v1/auth/session']){
    const response=await call(path,{...headers,Authorization:'Bearer '+token});
    assert.equal(response.status,200,path);assert.equal(response.headers['cache-control'],'no-store',path);
    assert.equal(response.headers['content-encoding'],undefined,path);assert.equal(response.headers.etag,undefined,path);
  }
  for(const path of ['/privy-auth.bundle.js.map','/privy-auth-entry.js','/dashboard-assets.ts','/private.js']){
    const response=await call(path,headers);assert.ok(response.status>=400,path);
    assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['content-encoding'],undefined);
  }
  const clean=await call('/app.js',{'Accept-Encoding':'gzip'});
  const withSecrets=await call('/app.js?private='+secret,{'Accept-Encoding':'gzip',Authorization:'Bearer '+secret,Cookie:'session='+secret});
  assert.equal(withSecrets.status,200);assert.equal(withSecrets.headers.etag,clean.headers.etag);assert.deepEqual(withSecrets.body,clean.body);
  assert.ok(!gunzipSync(withSecrets.body).includes(secret));
});

test('concurrent compression reuses the immutable asset, with a fresh ETag when a new image starts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-asset-cache-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'app.js');await writeFile(file,'const message="first release";'.repeat(100));
  const assets=createDashboardAssets(pathToFileURL(directory+'/'));
  const responses=await Promise.all(Array.from({length:12},()=>assets('/app.js','br')));
  for(const response of responses)assert.strictEqual(response,responses[0],'one compression result per immutable asset and encoding');
  const original=responses[0]!;
  await writeFile(file,'const message="second release";'.repeat(100));
  const next=await createDashboardAssets(pathToFileURL(directory+'/'))('/app.js','br');
  assert.notEqual(next.etag,original.etag);assert.notDeepEqual(next.body,original.body);
  await assert.rejects(assets('/app.js?unbounded-key','br'),{code:'NOT_FOUND'});
});

test('asset failures are retryable and the finite source cache has a hard byte budget',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-asset-limits-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const assets=createDashboardAssets(pathToFileURL(directory+'/'));
  await assert.rejects(assets('/app.js','identity'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await writeFile(join(directory,'app.js'),'');await truncate(join(directory,'app.js'),16*1024*1024+1);
  await assert.rejects(assets('/app.js','identity'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await truncate(join(directory,'app.js'),16*1024*1024);
  assert.equal((await assets('/app.js','identity')).body.length,16*1024*1024);
  await writeFile(join(directory,'style.css'),'');await truncate(join(directory,'style.css'),16*1024*1024);
  assert.equal((await assets('/style.css','identity')).body.length,16*1024*1024);
  await writeFile(join(directory,'getting-started.js'),'one more byte budget');
  await assert.rejects(assets('/getting-started.js','identity'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
});

async function generatedFixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'thot-generated-assets-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'privy-auth-chunks'));
  const bodies=new Map([['privy-auth.bundle.js',Buffer.from('import "./privy-auth-chunks/ABCDEFGH.js";export const fixture=true;')],['privy-auth-chunks/ABCDEFGH.js',Buffer.from('export const chunk="synthetic public SDK code";')]]);
  const manifest={format:'thot.privy-assets/1',assets:[...bodies].map(([path,body])=>({path,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')}))};
  for(const [path,body]of bodies)await writeFile(join(directory,path),body);
  const save=()=>writeFile(join(directory,'privy-auth.assets.json'),JSON.stringify(manifest));await save();
  return {directory,bodies,manifest,save,assets:()=>createDashboardAssets(pathToFileURL(directory+'/'))};
}

test('retry namespaces and legacy routes share the exact manifest-bound asset and one canonical cache entry',async t=>{
  const fixture=await generatedFixture(t),assets=fixture.assets();
  for(const [file,body] of fixture.bodies){
    const original=await assets('/'+file,'br');assert.deepEqual(brotliDecompressSync(original.body),body);
    for(const attempt of [0,1,17,9999])assert.strictEqual(await assets(`/privy-auth/v1/${attempt}/${file}`,'br'),original);
  }
  for(const route of ['/privy-auth/v1/10000/privy-auth.bundle.js','/privy-auth/v1/01/privy-auth.bundle.js','/privy-auth/v1/-1/privy-auth.bundle.js','/privy-auth/v1/0/../app.js','/privy-auth/v1/0/%2e%2e/app.js','/privy-auth/v1/0/privy-auth.assets.json','/privy-auth/v1/0/privy-auth-entry.js','/privy-auth/v1/0/privy-auth-chunks/UNKNOWN1.js','/privy-auth/v1/0/privy-auth-chunks/ABCDEFGH.js.map','/privy-auth/v1/0/private.js'])await assert.rejects(assets(route,'br'),{code:'NOT_FOUND'},route);
});

test('manifest membership, digest, sizes, symlinks and finite limits fail closed before caching generated code',async t=>{
  const fixture=await generatedFixture(t),entry=fixture.manifest.assets[0]!;
  await writeFile(join(fixture.directory,'privy-auth.bundle.js'),'x'.repeat(entry.bytes));
  await assert.rejects(fixture.assets()('/privy-auth.bundle.js','br'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await writeFile(join(fixture.directory,'privy-auth.bundle.js'),fixture.bodies.get('privy-auth.bundle.js')!);
  await rm(join(fixture.directory,'privy-auth-chunks/ABCDEFGH.js'));
  await assert.rejects(fixture.assets()('/privy-auth-chunks/ABCDEFGH.js','br'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await symlink(join(fixture.directory,'privy-auth.bundle.js'),join(fixture.directory,'privy-auth-chunks/ABCDEFGH.js'));
  await assert.rejects(fixture.assets()('/privy-auth-chunks/ABCDEFGH.js','br'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await rm(join(fixture.directory,'privy-auth-chunks/ABCDEFGH.js'));
  await writeFile(join(fixture.directory,'privy-auth-chunks/ABCDEFGH.js'),fixture.bodies.get('privy-auth-chunks/ABCDEFGH.js')!);
  await rename(join(fixture.directory,'privy-auth-chunks'),join(fixture.directory,'elsewhere'));
  await symlink(join(fixture.directory,'elsewhere'),join(fixture.directory,'privy-auth-chunks'));
  await assert.rejects(fixture.assets()('/privy-auth-chunks/ABCDEFGH.js','br'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await rm(join(fixture.directory,'privy-auth-chunks'));
  await rename(join(fixture.directory,'elsewhere'),join(fixture.directory,'privy-auth-chunks'));
  const original=structuredClone(fixture.manifest.assets);
  for(const assets of [[{...entry,path:'../private.js'}],[entry,entry],Array.from({length:513},()=>entry),[{...entry,bytes:16*1024*1024+1}],[{...entry,sha256:'invalid'}],[{...entry,bytes:16*1024*1024},{...entry,path:'privy-auth-chunks/ABCDEFGH.js',bytes:16*1024*1024},{...entry,path:'privy-auth-chunks/ABCDEFGI.js',bytes:1}]]){
    fixture.manifest.assets=assets;await fixture.save();await assert.rejects(fixture.assets()('/privy-auth.bundle.js','br'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  }
  fixture.manifest.assets=original;await fixture.save();
  const manifestPath=join(fixture.directory,'privy-auth.assets.json');
  await writeFile(manifestPath,' '.repeat(128*1024+1));
  await assert.rejects(fixture.assets()('/privy-auth.bundle.js','br'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await rm(manifestPath);
  const assets=fixture.assets();await assert.rejects(assets('/privy-auth.bundle.js','br'),{code:'DASHBOARD_ASSET_UNAVAILABLE'});
  await fixture.save();assert.ok((await assets('/privy-auth.bundle.js','br')).body.length,'missing build may recover without a poisoned cache');
});

test('packaged chunks preserve real HTTP compression, namespace revalidation, origin denial and admission',async t=>{
  // A flattened export ships no generated sign-in bundle; build it in place so
  // the packaged-asset contract is testable from a plain checkout too.
  const manifestPath=new URL('../apps/dashboard/privy-auth.assets.json',import.meta.url);
  try{await readFile(manifestPath,'utf8');}
  catch{const {buildPrivyAuth}=await import(String('../scripts/build-privy-auth.mjs')) as {buildPrivyAuth:()=>Promise<unknown>};await buildPrivyAuth();}
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const file=manifest.assets.find((asset:{path:string})=>asset.path.startsWith('privy-auth-chunks/')).path;
  const call=await fixture(t),route='/privy-auth/v1/0/'+file;
  const first=await call(route,{'Accept-Encoding':'br'});assert.equal(first.status,200);
  assert.equal(first.headers['cache-control'],'private, max-age=31536000, immutable');assert.equal(first.headers['content-encoding'],'br');
  assert.deepEqual(brotliDecompressSync(first.body),await readFile(new URL('../apps/dashboard/'+file,import.meta.url)));
  const shell=(await call('/app',{})).body.toString('utf8'),bundle=shell.match(/src="(\/app\.bundle\.js\?v=[0-9a-f]{16})"/)?.[1];
  assert.ok(bundle&&/href="\/style\.css\?v=[0-9a-f]{16}"/.test(shell),'app shell references versioned assets');
  assert.equal((await call(bundle,{'Accept-Encoding':'br'})).headers['cache-control'],'private, max-age=31536000, immutable');
  assert.equal((await call('/style.css',{'Accept-Encoding':'br'})).headers['cache-control'],'private, no-cache');
  const headers={'Accept-Encoding':'br','If-None-Match':first.headers.etag!};
  const next=await call('/privy-auth/v1/9999/'+file,headers);assert.equal(next.status,304);assert.equal(next.body.length,0);
  for(const denial of [{Host:'attacker.invalid'},{Origin:'https://attacker.invalid'},{'Sec-Fetch-Site':'cross-site'}] as Record<string,string>[]){
    const denied=await call(route,{...headers,...denial});assert.equal(denied.status,403);assert.equal(denied.headers['cache-control'],'no-store');assert.equal(denied.headers.etag,undefined);
  }
  const limited=await fixture(t,new ApiAdmission({limits:{public_requests:2}}));
  assert.equal((await limited(route)).status,200);assert.equal((await limited('/privy-auth/v1/1/'+file)).status,200);
  assert.equal((await limited('/privy-auth/v1/2/'+file)).status,429);
  for(const path of ['/privy-auth.assets.json','/privy-auth/v1/0/privy-auth.assets.json','/privy-auth/v1/0/privy-auth-chunks/UNKNOWN1.js','/privy-auth/v1/0/private.js']){
    const denied=await call(path,headers);assert.ok([401,404].includes(denied.status),path);assert.equal(denied.headers['cache-control'],'no-store');assert.equal(denied.headers.etag,undefined);
  }
});
