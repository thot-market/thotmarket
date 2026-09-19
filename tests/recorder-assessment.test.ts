import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRecorder,type RecorderPolicy} from '../packages/capture/src/tee/attestation.ts';

const pin={role:'model-recorder',compose_hash:'compose-a',os_image_hash:'os-a',mrtd:'td-a',rtmr0:'r0',rtmr1:'r1',rtmr2:'r2'};
const identity={verified:true,app_id:'app-a',compose_hash:'compose-a',os_image_hash:'os-a',mrtd:'td-a',rtmr0:'r0',rtmr1:'r1',rtmr2:'r2',quote_hash:'quote-a'};
const policy:RecorderPolicy={url:'https://recorder.example',instances:{'app-a':pin}};
const inspect=async()=>identity;

test('matched references report both hardware and source',async()=>{
 const result=await assessRecorder({},policy,{strict:true,policySource:'/reviewed/policy.json'},inspect);
 assert.deepEqual({hardware:result.hardware,references:result.references,source:result.policy_source},{hardware:'verified',references:'matched',source:'/reviewed/policy.json'});
});

test('normal mode distinguishes missing and mismatched references',async()=>{
 const missing=await assessRecorder({},{url:policy.url,instances:{}},{strict:false,policySource:'packaged'},inspect);
 assert.equal(missing.references,'missing');assert.equal(missing.hardware,'verified');
 const mismatch=await assessRecorder({},policy,{strict:false,policySource:'reviewed'},async()=>({...identity,compose_hash:'compose-b'}));
 assert.equal(mismatch.references,'mismatched');assert.equal(mismatch.compose_hash,'compose-b');assert.equal(mismatch.expected_compose_hash,'compose-a');
 await assert.rejects(assessRecorder({},policy,{strict:true,policySource:'reviewed'},async()=>({...identity,compose_hash:'compose-b'})),/RECORDER_REFERENCE_MISMATCH:app-a:compose-b:expected:compose-a/);
});

test('unavailable verifier permits clearly labelled service trust but strict fails',async()=>{
 const unavailable=async()=>{throw Error('DCAP_VERIFIER_NOT_INSTALLED');};
 const result=await assessRecorder({},policy,{strict:false,policySource:'reviewed'},unavailable);
 assert.equal(result.hardware,'unavailable');assert.equal(result.references,'unchecked');
 await assert.rejects(assessRecorder({},policy,{strict:true,policySource:'reviewed'},unavailable),/RECORDER_VERIFIER_REQUIRED/);
 await assert.rejects(assessRecorder({},{url:policy.url,instances:{}},{strict:true,policySource:'packaged'},inspect),/RECORDER_REFERENCE_POLICY_REQUIRED/);
});

test('expired reference policy is explicit and strict mode rejects it before inspection',async()=>{
 const expired={...policy,expires_at:'2020-01-01T00:00:00Z'};
 assert.equal((await assessRecorder({},expired,{strict:false,policySource:'reviewed'},inspect)).references,'stale');
 await assert.rejects(assessRecorder({},expired,{strict:true,policySource:'reviewed'},async()=>{throw Error('INSPECTION_SHOULD_NOT_RUN');}),/RECORDER_REFERENCE_POLICY_STALE/);
});

test('actual quote or key-binding rejection stays fatal in normal mode',async()=>{
 for(const code of ['RECORDER_KEY_BINDING_INVALID','RECORDER_PLATFORM_REJECTED','RECORDER_DCAP_REJECTED']){
  await assert.rejects(assessRecorder({},policy,{strict:false,policySource:'reviewed'},async()=>{throw Error(code);}),new RegExp(code));
 }
});
