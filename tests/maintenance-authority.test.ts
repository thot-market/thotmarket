import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import type {Actor} from '../packages/market/src/service.ts';
import {Wallet} from 'ethers';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {WalletAuth,type WalletAuthConfig} from '../packages/auth/src/index.ts';
import {createHttpServer} from '../apps/api/server.ts';

test('operator roles cannot decrypt owner library, capture proofs, exports or licensed delivery',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-maintenance-authority-'));
  const app=await createApplication({dataDir:dir,memory:true});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const owner:Actor={id:'demo-user',role:'user'},foreign:Actor={id:'foreign-owner',role:'user'};
  const marker='PRIVATE_MAINTENANCE_DENIAL_CONTENT';
  const capture=await app.agentCapture.begin(owner,{client:'claude',save_privately:true});
  const now=new Date().toISOString();
  const exchange={sequence:1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from(JSON.stringify({model:'synthetic',messages:[{role:'user',content:marker}]})).toString('base64'),response_body_b64:Buffer.from(JSON.stringify({type:'message',content:[{type:'text',text:marker}],stop_reason:'end_turn'})).toString('base64'),status:200,content_type:'application/json',started_at:now,finished_at:now,complete:true};
  const part={...exchange,commitment:canonicalHash(exchange)};
  await app.agentCapture.part(capture.capture_id,capture.upload_token,'authority-part',{part});
  const manifest={format:'thot.proxy-capture/2',capture_id:capture.capture_id,client:'claude',started_at:now,finished_at:now,parts:[{sequence:1,commitment:part.commitment}]};
  const saved=await app.agentCapture.checkpoint(capture.capture_id,capture.upload_token,'authority-checkpoint',{bundle:{...manifest,root:canonicalHash(manifest)}});
  await app.library.update(owner,'authority-annotation',saved.trace_id,{title:marker+'_TITLE',note:marker+'_NOTE'});
  assert.match(JSON.stringify(await app.library.item(owner,saved.trace_id)),new RegExp(marker));
  assert.match(JSON.stringify(await app.agentCapture.proofPart(owner,capture.capture_id,1)),/request_body_b64/);
  assert.equal((await app.agentCapture.proof(owner,capture.capture_id)).capture_id,capture.capture_id);

  // Observe decrypt attempts, not just the returned response. A denied operation
  // must not open content and discard it after authorization fails.
  const originalOpen=app.service.privacy.open.bind(app.service.privacy);
  let opens=0;
  app.service.privacy.open=async(...args:Parameters<typeof originalOpen>)=>{opens++;return originalOpen(...args);};
  for(const role of ['operator_security','operator_support','operator_maintenance'] as const){
    // Use the actual owner's ID too: role checks must precede owner matching.
    for(const id of ['operator-fixture',owner.id]){
      const operator:Actor={id,role};
      const denied=[
        ()=>app.library.list(operator,{q:marker}),
        ()=>app.library.item(operator,saved.trace_id),
        ()=>app.library.update(operator,'authority-edit-'+id+'-'+role,saved.trace_id,{note:'overwrite'}),
        ()=>app.library.reprocess(operator,'authority-reprocess-'+id+'-'+role,saved.trace_id),
        ()=>app.agentCapture.status(operator,capture.capture_id),
        ()=>app.agentCapture.proof(operator,capture.capture_id),
        ()=>app.agentCapture.proofPart(operator,capture.capture_id,1),
        ()=>app.service.auditExport(operator),
        ()=>app.service.preview(operator,saved.trace_id),
        ()=>app.service.delivery(operator,'foreign-license'),
      ];
      for(const invoke of denied)await assert.rejects(invoke(),/FORBIDDEN/);
    }
  }
  await assert.rejects(app.library.item(foreign,saved.trace_id),/NOT_FOUND/);
  await assert.rejects(app.agentCapture.proof(foreign,capture.capture_id),/NOT_FOUND/);
  await assert.rejects(app.agentCapture.proofPart(foreign,capture.capture_id,1),/NOT_FOUND/);
  const explorer=await app.library.operator({id:'operator-fixture',role:'operator_security'});
  assert.equal(explorer.summary.saved,1);
  assert.doesNotMatch(JSON.stringify(explorer),new RegExp(marker));
  assert.equal(opens,0,'denied content calls and operational inventory must not decrypt');
});

test('configured maintenance wallet receives only fixed statistics and self-session operations',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-maintenance-http-'));
  const app=await createApplication({dataDir:dir,memory:true,openrouter:{enabled:true,transport:async()=>{assert.fail('invalid maintenance token must never reach provider transport');}}});
  const wallet=Wallet.createRandom(),operator=Wallet.createRandom(),origin='https://maintenance.example.test';
  const config:WalletAuthConfig={schema_version:'thot.wallet-auth/1',origin,chain_id:46630,allow_public_signup:false,maintenance_addresses:[wallet.address],operator_addresses:[operator.address]};
  const auth=await WalletAuth.create(app.db,config);
  const server=createHttpServer(app,{externalAuth:auth,publicOrigin:origin});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await app.close();await rm(dir,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address==='object');
  const challenge=await auth.challenge({address:wallet.address,chain_id:46630},origin);
  const signed=await auth.verify({id:challenge.body.id,message:challenge.body.message,signature:await wallet.signMessage(challenge.body.message)},origin,challenge.set_cookie.split(';')[0]);
  const cookies=signed.set_cookies[0]!.split(';')[0]!,token=auth.tokenFromCookie(cookies),session=await auth.authenticate(token);
  assert.equal(session.actor.role,'operator_maintenance');
  assert.equal(app.library.canExplore(session.actor),false);
  const operatorChallenge=await auth.challenge({address:operator.address,chain_id:46630},origin);
  const operatorSigned=await auth.verify({id:operatorChallenge.body.id,message:operatorChallenge.body.message,signature:await operator.signMessage(operatorChallenge.body.message)},origin,operatorChallenge.set_cookie.split(';')[0]);
  const operatorSession=await auth.authenticate(auth.tokenFromCookie(operatorSigned.set_cookies[0]!.split(';')[0]));
  assert.equal(operatorSession.actor.role,'operator_security');
  assert.equal(app.library.canExplore(operatorSession.actor),true,'existing full operator role remains available');
  const call=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const serialized=body===undefined?undefined:JSON.stringify(body);
    const req=request({hostname:'127.0.0.1',port:address.port,path,method,headers:{Host:new URL(origin).host,Origin:origin,Cookie:cookies,...(serialized===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()}),...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(serialized);
  });
  let opens=0;const open=app.service.privacy.open.bind(app.service.privacy);
  app.service.privacy.open=async(...args:Parameters<typeof open>)=>{opens++;return open(...args);};
  const stats=await call('/v1/maintenance/stats');assert.equal(stats.status,200);
  assert.deepEqual(stats.body.counts,{traces:'0',capture_attempts:'0',trace_objects:'0',licenses:'0',deliveries:'0',active_storage_attempts:'0',unresolved_storage_objects:'0'});
  assert.equal(stats.body.timings.scope,'current_process');assert.equal(stats.body.timings.objects.max_in_flight_operations,16);
  assert.ok(Array.isArray(stats.body.timings.transactions.series));
  assert.equal((await call('/v1/auth/session')).body.actor.role,'operator_maintenance');
  const contributor=Wallet.createRandom();
  const signup=await WalletAuth.create(app.db,{...config,allow_public_signup:true});
  const loginWith=async(provider:WalletAuth)=>{
    const challenge=await provider.challenge({address:contributor.address,chain_id:46630},origin);
    return provider.verify({id:challenge.body.id,message:challenge.body.message,signature:await contributor.signMessage(challenge.body.message)},origin,challenge.set_cookie.split(';')[0]);
  };
  const contributorSigned=await loginWith(signup),contributorCookies=contributorSigned.set_cookies[0]!.split(';')[0]!;
  assert.equal((await call('/v1/maintenance/stats','GET',undefined,{Cookie:contributorCookies})).status,403,'ordinary user cannot inspect maintenance aggregates');
  const addedMapping=await WalletAuth.create(app.db,{...config,maintenance_addresses:[wallet.address,contributor.address]});
  assert.equal((await addedMapping.authenticate(addedMapping.tokenFromCookie(contributorCookies))).actor.role,'user','config alone cannot change an existing user session role');
  assert.equal((await loginWith(addedMapping)).body.actor.role,'user','fresh signature cannot promote persisted user membership');
  const contributorActor=contributorSigned.body.actor;
  const delegatedCapture=await app.agentCapture.begin(contributorActor,{client:'claude',save_privately:true});
  const delegatedDevice=await app.captureDevices.create(contributorActor,{client:'claude',save_privately:true,device_name:'Synthetic namespace regression'});
  const bearerHeaders={Cookie:'',Authorization:'Bearer '+token};
  for(const action of ['parts','complete','checkpoint','authorize','heartbeat']){
    const response=await call(`/v1/agent-captures/${delegatedCapture.capture_id}/${action}`,'POST',{},bearerHeaders);
    assert.equal(response.status,401,action);assert.equal(response.body.error,'INVALID_CAPTURE_TOKEN',action);
  }
  for(const action of ['captures','disconnect']){
    const response=await call(`/v1/capture-devices/${delegatedDevice.device_id}/${action}`,'POST',{},bearerHeaders);
    assert.equal(response.status,401,action);assert.equal(response.body.error,'INVALID_CAPTURE_DEVICE_TOKEN',action);
  }
  const proxyResponse=await call('/v1/openrouter/chat/completions','POST',{},bearerHeaders);
  assert.equal(proxyResponse.status,401);assert.equal(proxyResponse.body.error,'OPENROUTER_RELAY_UNAUTHENTICATED');
  assert.equal((await call('/v1/maintenance/stats?sql=SELECT+document')).status,400);
  for(const path of ['/v1/traces','/v1/library','/v1/library/foreign-trace','/v1/agent-captures/foreign/proof','/v1/agent-captures/foreign/proof/parts/1','/v1/audit/export','/v1/buyer/deliveries/foreign/download','/v1/operator/trace-explorer','/v1/operator/read-diagnostics','/v1/operator/environment','/v1/internal/vault','/v1/future-sensitive-route'])assert.equal((await call(path)).status,403,path);
  for(const path of ['/v1/operator/auth/membership','/v1/operator/fleet','/v1/dev/run-worker','/v1/maintenance/stats'])assert.equal((await call(path,'POST',{})).status,403,path);
  await assert.rejects(auth.access.provision(session.actor,'maintenance-provision',{subject:'takeover',actor:{id:'demo-user',role:'user'},enabled:true,expected_version:0}),/FORBIDDEN/);
  assert.equal(opens,0);
  // Configuration removal revokes existing sessions and fresh logins immediately;
  // changing the set must not silently promote a persisted maintenance identity.
  const removed=await WalletAuth.create(app.db,{...config,maintenance_addresses:[]});
  await assert.rejects(removed.authenticate(token),/AUTH_OPERATOR_NOT_CONFIGURED/);
  const promoted=await WalletAuth.create(app.db,{...config,maintenance_addresses:[],operator_addresses:[wallet.address]});
  await assert.rejects(promoted.authenticate(token),/AUTH_OPERATOR_NOT_CONFIGURED/);
  const removedChallenge=await removed.challenge({address:wallet.address,chain_id:46630},origin);
  await assert.rejects(removed.verify({id:removedChallenge.body.id,message:removedChallenge.body.message,signature:await wallet.signMessage(removedChallenge.body.message)},origin,removedChallenge.set_cookie.split(';')[0]),/AUTH_OPERATOR_NOT_CONFIGURED/);
  for(const overrides of [{maintenance_addresses:[wallet.address,wallet.address.toLowerCase()]},{maintenance_addresses:[operator.address]},{maintenance_addresses:['invalid']},{maintenance_addresses:'invalid'}])await assert.rejects(WalletAuth.create(app.db,{...config,...overrides} as WalletAuthConfig),/INVALID_AUTH_CONFIGURATION/);
  assert.equal((await call('/v1/auth/session/revoke','POST',{})).status,200);
  await assert.rejects(auth.authenticate(token),/UNAUTHENTICATED/);
});
