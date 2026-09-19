import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { AuthAccessStore, type AuthProvider } from '../packages/auth/src/index.ts';
import { demoUser } from '../packages/market/src/fixtures.ts';

test('authenticated demo offers require opt-in and retain owner and brokerage checks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-demo-auth-'));
 const app=await createApplication({memory:true,dataDir:dir});
 const auth:AuthProvider={access:new AuthAccessStore(app.db,'https://test.example'),capabilities:{mode:'clerk',development_session_available:false,external_login_available:true},async authenticate(){return {actor:demoUser,identity:{issuer:'https://test.example',subject:'synthetic',jti:'synthetic',issuedAt:1,expiresAt:4_000_000_000},expires_at:'2096-10-02T07:06:40Z'};}};
 try {
  for(const enabled of [false,true]){
   const server=createHttpServer(app,{externalAuth:auth,...(enabled?{enableDemoOffers:true}:{})});
   await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
   const base=`http://127.0.0.1:${(server.address() as any).port}`;
   try{
    const headers={Authorization:'Bearer synthetic','Content-Type':'application/json','Idempotency-Key':'demo-auth-'+enabled};
    const portfolio=await (await fetch(base+'/v1/contributor/portfolio',{headers})).json();assert.equal(portfolio.capabilities.demo_offers,enabled);
    const path=base+'/v1/contributor/portfolio/not-owned/demo-offer';
    assert.equal((await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    const res=await fetch(path,{method:'POST',headers,body:'{}'});
    assert.equal(res.status,enabled?409:403);
    assert.equal((await res.json()).error,enabled?'VERIFIED_BROKERAGE_REQUIRED':'DEMO_OFFERS_DISABLED');
    assert.equal((await fetch(base+'/v1/dev/session',{method:'POST',headers,body:'{"role":"buyer_admin"}'})).status,403);
   }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
