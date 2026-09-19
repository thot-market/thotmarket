import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApiAdmission} from '../apps/api/admission.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {DomainError} from '../packages/storage/src/index.ts';

function code(expected:string){return(error:unknown)=>error instanceof DomainError&&error.code===expected;}
function admitted(admission:ApiAdmission,kind:'account'|'capture',token:string,tenant:string){
  const auth=admission.enterAuthentication(token);auth();const verified=admission.enterVerified(kind,tenant);verified();
}

test('admission carries 100 verified users at five-second library polling plus capture progress',()=>{
  const admission=new ApiAdmission({clock:()=>1_000});
  for(let user=0;user<100;user++){
    for(let poll=0;poll<12;poll++)admitted(admission,'account',`session-${user}`,`owner-${user}`);
    for(let progress=0;progress<6;progress++)admitted(admission,'capture',`capture-token-${user}`,`owner-${user}`);
  }
  assert.deepEqual(admission.snapshot(),{credential_keys:200,tenant_keys:200,requests_in_flight:0,auth_in_flight:0,bodies_in_flight:0,body_bytes_in_flight:0});
});

test('a noisy verified actor exhausts only its route-class budget',()=>{
  const admission=new ApiAdmission({clock:()=>2_000,limits:{account_requests:3,credential_requests:20}});
  for(let i=0;i<3;i++)admitted(admission,'account','noisy-session','noisy-owner');
  assert.throws(()=>admitted(admission,'account','noisy-session','noisy-owner'),code('ACCOUNT_ADMISSION_LIMIT'));
  admitted(admission,'account','peer-session','peer-owner');
  admitted(admission,'capture','capture-session','noisy-owner');
});

test('tenant and overflow in-flight caps survive a rate-window boundary',()=>{
  let now=119_999;
  const admission=new ApiAdmission({clock:()=>now,limits:{tenant_keys:1,account_in_flight:1}});
  const heldTenant=admission.enterVerified('account','held-tenant');
  const heldOverflow=admission.enterVerified('account','held-overflow');
  now=120_000;
  assert.throws(()=>admission.enterVerified('account','held-tenant'),code('ACCOUNT_BUSY'));
  assert.throws(()=>admission.enterVerified('account','another-overflow-tenant'),code('ACCOUNT_BUSY'));
  heldTenant();heldOverflow();
  const tenant=admission.enterVerified('account','held-tenant'),overflow=admission.enterVerified('account','another-overflow-tenant');
  tenant();overflow();

  let rateNow=119_999;
  const rateAdmission=new ApiAdmission({clock:()=>rateNow,limits:{tenant_keys:1,account_requests:1}});
  const rateTenant=rateAdmission.enterVerified('account','rate-tenant');
  const rateOverflow=rateAdmission.enterVerified('account','rate-overflow');
  rateNow=120_000;
  assert.throws(()=>rateAdmission.enterVerified('account','rate-tenant'),code('ACCOUNT_ADMISSION_LIMIT'));
  assert.throws(()=>rateAdmission.enterVerified('account','another-rate-overflow'),code('ACCOUNT_ADMISSION_LIMIT'));
  rateTenant();rateOverflow();
});

test('invalid credential churn has bounded state and capacity returns next window',()=>{
  let now=3_000;
  const admission=new ApiAdmission({clock:()=>now,limits:{credential_keys:8,credential_requests:3,preauth_requests:1_000}});
  let rejected=0;
  for(let i=0;i<100;i++)try{const release=admission.enterAuthentication(`invalid-${i}`);release();}catch(error){assert.ok(code('CREDENTIAL_RATE_LIMIT')(error));rejected++;}
  assert.ok(rejected>0);assert.equal(admission.snapshot().credential_keys,8);
  now+=60_000;
  const release=admission.enterAuthentication('new-legitimate-session');release();
  assert.equal(admission.snapshot().credential_keys,1);
});

test('public traffic is separate while request, authentication and body work stay bounded',()=>{
  const admission=new ApiAdmission({clock:()=>4_000,limits:{requests_in_flight:2,auth_in_flight:1,bodies_in_flight:2,body_bytes_in_flight:10}});
  for(let i=0;i<100;i++)admission.public();
  admitted(admission,'account','session','owner');

  const request1=admission.enterRequest(),request2=admission.enterRequest();
  assert.throws(()=>admission.enterRequest(),code('SERVER_BUSY'));request1();request2();
  const auth=admission.enterAuthentication('held');
  assert.throws(()=>admission.enterAuthentication('peer'),code('AUTHENTICATION_BUSY'));auth();

  assert.throws(()=>admission.openBody('11',20),code('BODY_ADMISSION_BUSY'));
  assert.throws(()=>admission.openBody('21',20),code('REQUEST_TOO_LARGE'));
  const body=admission.openBody(undefined,20);body.add(6);
  assert.throws(()=>body.add(5),code('BODY_ADMISSION_BUSY'));body.release();
  assert.equal(admission.snapshot().body_bytes_in_flight,0);
});

test('HTTP admission combines credentials only after provider verification identifies the actor',async t=>{
  const app=await createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-admission-http-'))});
  const admission=new ApiAdmission({limits:{account_requests:3,credential_requests:20}});
  const externalAuth:any={
    access:{limits:{requests_per_minute:180,mutations_per_minute:60},consume:async()=>{}},
    capabilities:{mode:'test',development_session_available:false,external_login_available:true},
    async authenticate(token:string){
      const owner=token==='session-a'||token==='session-b'?'owner-noisy':token==='session-peer'?'owner-peer':token.startsWith('session-user-')?'owner-'+token.slice('session-'.length):undefined;
      if(!owner)throw new DomainError('UNAUTHENTICATED',401);
      return {actor:{id:owner,role:'user'},identity:{issuer:'test',subject:token,jti:token,issuedAt:1,expiresAt:4_000_000_000},expires_at:'2096-10-02T07:06:40.000Z'};
    },
  };
  const server=createHttpServer(app,{externalAuth,admission});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();});
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const call=async(token:string)=>{const response=await fetch(base+'/v1/auth/session',{headers:{Authorization:'Bearer '+token}});await response.arrayBuffer();return response.status;};
  assert.equal(await call('session-a'),200);assert.equal(await call('session-b'),200);assert.equal(await call('session-a'),200);
  assert.equal(await call('session-b'),429);
  assert.equal(await call('session-peer'),200);
  const users=await Promise.all(Array.from({length:100},(_,index)=>call('session-user-'+index)));
  assert.ok(users.every(status=>status===200));
  assert.equal(await call('invalid-session'),401);
  assert.equal(admission.snapshot().tenant_keys,102);
});
