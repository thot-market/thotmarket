import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizationOrigins,authorizeCapture} from '../packages/capture/src/tee/authorization.ts';
test('recorder can authorize separate vaults without client-selected destinations',async()=>{
 const origins=authorizationOrigins('["https://review.example","https://legacy.example"]');
 const capture={capture_id:'capture-test-id-1234',client:'claude',upload_token:'synthetic'};
 const binding={...capture,consent_hash:'a'.repeat(64),status:'AWAITING_UPLOAD',expires_at:new Date(Date.now()+60000).toISOString()};
 const calls:string[]=[];
 const send=(async(url:any,init:any)=>{calls.push(url);assert.equal(init.redirect,'error');return calls.length===1?new Response('{}',{status:401}):Response.json(binding);}) as typeof fetch;
 assert.deepEqual(await authorizeCapture(origins,capture,send),binding);
 assert.deepEqual(calls,origins.map(o=>o+'/v1/agent-captures/'+capture.capture_id+'/authorize'));
 for(const value of ['[]','["http://localhost"]','["https://name:pass@host"]','["https://host/path"]','["https://host/?next=other"]'])assert.throws(()=>authorizationOrigins(value));
});
test('recorder rejects wrong binding, stale approvals and unknown tokens',async()=>{
 const capture={capture_id:'capture-test-id-1234',client:'claude',upload_token:'synthetic'};
 const binding={capture_id:capture.capture_id,client:'claude',consent_hash:'a'.repeat(64),status:'AWAITING_UPLOAD',expires_at:new Date(Date.now()+60000).toISOString()};
 for(const patch of [{client:'codex'},{capture_id:'other'},{status:'SAVED'},{expires_at:'invalid'},{expires_at:'2000-01-01'},{consent_hash:''}])await assert.rejects(authorizeCapture(['https://review.example'],capture,(async()=>Response.json({...binding,...patch})) as typeof fetch),/CAPTURE_AUTHORIZATION_REJECTED/);
 await assert.rejects(authorizeCapture(['https://review.example'],capture,(async()=>new Response('{}',{status:401})) as typeof fetch),/CAPTURE_AUTHORIZATION_REJECTED/);
 await assert.rejects(authorizeCapture(['https://review.example'],capture,(async()=>new Response('{}',{status:500})) as typeof fetch),/CAPTURE_AUTHORIZATION_UNAVAILABLE/);
});
