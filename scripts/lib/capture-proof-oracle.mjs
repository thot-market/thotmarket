import assert from 'node:assert/strict';
import {gunzipSync,zstdDecompressSync} from 'node:zlib';
import {join} from 'node:path';
import {loadPrivate} from '../../packages/capture/src/local-state.ts';
import {canonicalHash} from '../../packages/protocol/src/canonical.ts';
import {verifySeal} from '../../packages/capture/src/tee/attestation.ts';
export function providerAnswer(part){
 let answer='',model;const raw=Buffer.from(part.response_body_b64,'base64').toString();
 for(const line of raw.split('\n'))if(line.startsWith('data:')){try{const event=JSON.parse(line.slice(5));
  if(event.type==='message_start')model=event.message?.model;
  if(event.type==='content_block_delta'&&event.delta?.type==='text_delta')answer+=event.delta.text;
  if(event.type==='response.output_text.delta')answer+=event.delta;
  if(event.type==='response.completed')model=event.response?.model;
 }catch{}}
 return {answer,model};
}
// Read actual successful provider responses, never terminal echoes or requests.
export function captureProofOracle(test,id,requestMarkers=[],localPartsDir){
 const parts=new Map();let status;
 return {parts,get status(){return status;},
  async refresh(){
   status=await test.get('/v1/contributor/agent-captures/'+id+'/status');
   if(!status.result?.trace_id)return [];
   const root='/v1/contributor/agent-captures/'+id+'/proof',proof=await test.get(root);
   for(const descriptor of proof.bundle.parts??[]){
    if(parts.has(descriptor.sequence))continue;
    let part;
    if(localPartsDir){try{({part}=await loadPrivate(join(localPartsDir,String(descriptor.sequence))));}catch(error){if(error.code!=='ENOENT')throw error;}}
    if(!part)({part}=await test.get(root+'/parts/'+descriptor.sequence));
    const {commitment,...record}=part;
    assert.equal(commitment,descriptor.commitment);assert.equal(canonicalHash(record),commitment,'Actual answer bytes must match the acknowledged checkpoint commitment');
    const {answer,model}=providerAnswer(part);
    const body=Buffer.from(part.request_body_b64,'base64'),decoded=(part.request_encoding==='gzip'?gunzipSync(body,{maxOutputLength:32*1024*1024}):part.request_encoding==='zstd'?zstdDecompressSync(body,{maxOutputLength:32*1024*1024}):body).toString();
    let request;try{request=JSON.parse(decoded);}catch{}
    // Retain the few assertions we need, not every repeated PDF/image history.
    parts.set(part.sequence,{sequence:part.sequence,commitment:part.commitment,ok:part.complete&&part.status>=200&&part.status<300,status:part.status,answer,model,request_model:request?.model,native_session_id:request?.prompt_cache_key,request_markers:requestMarkers.filter(marker=>decoded.includes(marker)),request_bytes:body.length,response_bytes:Buffer.from(part.response_body_b64,'base64').length});
   }
   return [...parts.values()];
  },
  async answered(markers,after=0){const values=await this.refresh();return markers.every(marker=>values.some(p=>p.sequence>after&&p.ok&&p.answer.includes(marker)));},
  async checkpoint(){
   await this.refresh();const proof=await test.get('/v1/contributor/agent-captures/'+id+'/proof');
   const {tee_evidence,...bundle}=proof.bundle;assert.ok(tee_evidence);verifySeal(bundle,tee_evidence,id);
   const {format,capture_id,client,started_at,finished_at,parts:descriptors}=bundle;assert.equal(canonicalHash({format,capture_id,client,started_at,finished_at,parts:descriptors}),bundle.root);
   const item=await test.get('/v1/contributor/library/'+status.result.trace_id);
   return {integrity:{tee:true,exchanges:descriptors.length,root:bundle.root,all_parts_downloaded:false},confidence:proof.receipt.confidence_tier,trace_id:status.result.trace_id,library_id:item.trace_id,segments:item.segments,projection:item.projection,turns:item.content?.turns?.length,model_history:item.model_history,attestation:tee_evidence.attestation};
  },
  async verify({profile=false}={}){
   status=await test.get('/v1/contributor/agent-captures/'+id+'/status');assert.ok(status.result?.trace_id);
   return test.page.evaluate(async ({id,profile})=>{
    const timings=[],begin=performance.now();
    const {verifyProxyCapture}=await import('/agent-capture-ui.js');
    const get=async path=>{const start=performance.now(),token=await window.Clerk.session.getToken(),authorized=performance.now(),r=await fetch(path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)}),headers=performance.now();if(!r.ok)throw Error('VERIFY_HTTP_'+r.status);const text=await r.text(),body=performance.now(),value=JSON.parse(text),parsed=performance.now();if(profile)timings.push({path,auth_ms:authorized-start,headers_ms:headers-authorized,body_ms:body-headers,parse_ms:parsed-body,characters:text.length,total_ms:parsed-start});return value;};
    const root='/v1/contributor/agent-captures/'+id+'/proof',proof=await get(root);
    const verifyStart=performance.now();
    const integrity=await verifyProxyCapture(proof.bundle,async n=>(await get(root+'/parts/'+n)).part);
    const verifyMs=performance.now()-verifyStart;
    const status=await get('/v1/contributor/agent-captures/'+id+'/status'),item=await get('/v1/contributor/library/'+status.result.trace_id);
    return {integrity,confidence:proof.receipt.confidence_tier,trace_id:status.result.trace_id,library_id:item.trace_id,segments:item.segments,projection:item.projection,turns:item.content?.turns?.length,model_history:item.model_history,attestation:proof.bundle.tee_evidence.attestation,...(profile?{timing:{requests:timings,verify_ms:verifyMs,browser_ms:performance.now()-begin}}:{})};
   },{id,profile});
  }
 };
}
