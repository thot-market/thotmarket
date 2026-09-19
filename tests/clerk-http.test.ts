import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { AuthAccessStore, type AuthProvider } from '../packages/auth/src/index.ts';
import { demoUser } from '../packages/market/src/fixtures.ts';

test('Clerk HTTP mode exposes only public bootstrap, disables dev authority and routes signout to provider',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-clerk-http-'));
  const app=await createApplication({memory:true,dataDir:dir});
  let revoked=false;
  const auth:AuthProvider={
    access:new AuthAccessStore(app.db,'https://auth.example.invalid'),
    capabilities:{mode:'clerk',development_session_available:false,external_login_available:true,clerk:{publishable_key:'pk_test_public',frontend_api_url:'https://auth.example.invalid'}},
    async authenticate(token){assert.equal(token,'fixture-session');return {actor:demoUser,identity:{issuer:'https://auth.example.invalid',subject:'fixture-subject',jti:'fixture-session-id',issuedAt:1,expiresAt:4_000_000_000},expires_at:'2096-10-02T07:06:40.000Z'};},
    async revoke(){revoked=true;return {revoked:true};},
  };
  const server=createHttpServer(app,{externalAuth:auth});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();await rm(dir,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const capability=await fetch(base+'/v1/auth/capabilities');const body=await capability.json();
  assert.equal(body.mode,'clerk');assert.equal(body.development_session_available,false);assert.equal(body.external_login_available,true);
  assert.deepEqual(body.clerk,auth.capabilities.clerk);assert.equal(JSON.stringify(body).includes('secret_key'),false);
  const page=await fetch(base+'/');assert.equal(page.status,200);
  const csp=page.headers.get('content-security-policy')!;
  assert.ok(csp.includes("script-src 'self' https://auth.example.invalid"));assert.ok(!csp.includes("'unsafe-eval'"));
  assert.equal((await fetch(base+'/clerk-auth-ui.js')).status,200);
  assert.equal((await fetch(base+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"role":"operator_security"}'})).status,403);
  assert.equal((await fetch(base+'/v1/contributor/portfolio')).status,401);
  const headers={'Content-Type':'application/json',Authorization:'Bearer fixture-session','Idempotency-Key':'clerk-signout-test'};
  assert.equal((await fetch(base+'/v1/auth/session/revoke',{method:'POST',headers,body:'{}'})).status,200);assert.equal(revoked,true);
  assert.equal((await fetch(base+'/v1/auth/session',{headers:{...headers,Origin:'https://hostile.example'}})).status,403);
});
