import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {connectCapture,disconnectCapture} from '../packages/capture/src/connect.ts';

const actor={id:'demo-user',role:'user' as const};
async function fixture(t:any){
  const dir=await mkdtemp(join(tmpdir(),'thot-devices-'));let now=Date.now();
  const app=await createApplication({dataDir:join(dir,'app'),memory:true,config:{clock:()=>new Date(now)}});
  const server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,origin,root:join(dir,'connections'),advance:(ms:number)=>{now+=ms;}};
}

test('first tool connection uses one browser handoff; returning helper and new project reuse the server grant',async t=>{
  const {app,origin,root}=await fixture(t);let opens=0;
  const open=async(url:string)=>{
    opens++;const value=JSON.parse(Buffer.from(new URL(url).hash.slice('#thot='.length),'base64url').toString());assert.equal(value.version,2);
    const session=await (await fetch(origin+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'test-web-session'},body:'{"role":"user"}'})).json() as any;
    const created=await fetch(origin+'/v1/contributor/capture-devices',{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json','Idempotency-Key':'test-create-device'},body:JSON.stringify({client:value.client,device_name:value.device_name,save_privately:true})});assert.equal(created.status,200);
    const device=await created.json() as any;
    const preflight=await fetch(value.callback,{method:'OPTIONS',headers:{Origin:origin}});assert.equal(preflight.status,204);
    const response=await fetch(value.callback,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(device)});assert.equal(response.status,200);
    const paired=await response.json() as any;assert.ok(paired.capture_id);assert.equal(paired.automatic_sales,false);return true;
  };
  const first=await connectCapture({origin,client:'claude',project:'first-project',root,open,log:()=>{}});
  const second=await connectCapture({origin,client:'claude',project:'another-project',root,open,log:()=>{}});
  const third=await connectCapture({origin,client:'claude',project:'first-project',root,open,log:()=>{}});
  assert.equal(opens,1);assert.equal(first.account_id,second.account_id);assert.notEqual(first.capture_id,second.capture_id);assert.notEqual(second.upload_token,third.upload_token);
  const devices=await app.captureDevices.list(actor);assert.equal(devices.devices.length,1);assert.equal(devices.devices[0].client,'claude');
  assert.ok(!JSON.stringify(devices).includes('token'));
  const capture=await app.agentCapture.authenticate(second.capture_id,second.upload_token);assert.ok(!JSON.stringify(capture).includes('another-project'));
  assert.equal((await app.privacy.open(actor.id,capture.context_ref)).project,'another-project');
  await disconnectCapture(root,origin,'claude');
  const fourth=await connectCapture({origin,client:'claude',project:'third-project',root,open,log:()=>{}});assert.equal(opens,2);assert.notEqual(fourth.capture_id,third.capture_id);
});

test('grant is hashed, client scoped, private-only, owner controlled, and subject to expiry and revocation',async t=>{
  const {app,advance}=await fixture(t);
  const device=await app.captureDevices.create(actor,{client:'codex',device_name:'fixture computer',save_privately:true});
  const stored=(await app.db.query('SELECT document FROM auth_access WHERE id=$1',['capture-device:'+device.device_id])).rows[0].document;
  assert.notEqual(stored.token_hash,device.device_token);assert.ok(!JSON.stringify(stored).includes(device.device_token));
  await assert.rejects(app.captureDevices.begin(device.device_id,'x'.repeat(43),{client:'codex',project:'project'}),/INVALID_CAPTURE_DEVICE_TOKEN/);
  await assert.rejects(app.captureDevices.begin(device.device_id,device.device_token,{client:'claude',project:'project'}),/CAPTURE_DEVICE_CLIENT_MISMATCH/);
  await assert.rejects(app.captureDevices.begin(device.device_id,device.device_token,{client:'codex',project:'project',rights_confirmed:true}),/INVALID_DEVICE_CAPTURE/);
  await assert.rejects(app.captureDevices.revoke({id:'other-user',role:'user'},'wrong-owner-revocation',device.device_id),/NOT_FOUND/);
  const capture=await app.captureDevices.begin(device.device_id,device.device_token,{client:'codex',project:'project'});
  const raw=await app.agentCapture.authenticate(capture.capture_id,capture.upload_token);assert.equal(raw.save_privately,true);assert.equal(raw.rights_confirmed,false);assert.equal(raw.model_output_licensed,false);
  advance(30*86400*1000+1);
  await assert.rejects(app.captureDevices.begin(device.device_id,device.device_token,{client:'codex',project:'project'}),/CAPTURE_DEVICE_EXPIRED/);
  const fresh=await app.captureDevices.create(actor,{client:'codex',device_name:'new grant',save_privately:true});
  await app.captureDevices.revoke(actor,'disconnect-own-device',fresh.device_id);
  await assert.rejects(app.captureDevices.begin(fresh.device_id,fresh.device_token,{client:'codex',project:'project'}),/CAPTURE_DEVICE_REVOKED/);
});

test('device bearer cannot read the private vault or act as a web session',async t=>{
  const {app,origin}=await fixture(t),d=await app.captureDevices.create(actor,{client:'codex',device_name:'fixture computer',save_privately:true});
  for(const path of ['/v1/contributor/portfolio','/v1/auth/session','/v1/contributor/capture-devices'])assert.equal((await fetch(origin+path,{headers:{Authorization:'Bearer '+d.device_token}})).status,401);
});
