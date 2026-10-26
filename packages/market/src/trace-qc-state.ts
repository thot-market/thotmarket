import {canonicalHash,canonicalJson} from '../../protocol/src/index.ts';
import {QC_POLICY_VERSION} from '../../qc/index.ts';
import {ensure,type Document,type Transaction} from '../../storage/src/index.ts';

export type QcScope='private'|'release';
export type SourceCoverage={status:'incomplete'|'not_established'|'no_known_gaps';capture_state:string;projection_status:string;reason_codes:string[];warning:string|null};
export const QC_EVENT='CheckTraceQuality';
export const QC_ATTEMPT_LIMIT=3;
export const QC_DISCOVERY_LIMIT=40;
export const QC_LEASE_SECONDS=180;
export const QC_NONRETRYABLE=new Set(['QC_SOURCE_LIMIT','QC_STORAGE_LIMIT','QC_REPORT_UNAVAILABLE']);
// These are acquisition/projection signals, independent of what the content
// checker can infer from a final assistant turn. Never copy unknown metadata.
export function sourceCoverage(trace:Document):SourceCoverage{
  const captured=!!(trace.agent_capture_id||trace.openrouter_request_id||trace.capture_state);
  const capture_state=['RECORDING','INFLIGHT','INTERRUPTED','COMPLETED'].includes(trace.capture_state)?trace.capture_state:captured?'UNKNOWN':'NOT_CAPTURED';
  const projection_status=['READY','PENDING','PARTIAL','UNREADABLE','ERROR'].includes(trace.projection?.status)?trace.projection.status:!trace.projection&&!captured?'NOT_APPLICABLE':'UNKNOWN';
  const reason_codes:string[]=[];
  if(capture_state==='RECORDING')reason_codes.push('CAPTURE_RECORDING');
  if(capture_state==='INFLIGHT')reason_codes.push('CAPTURE_INFLIGHT');
  if(capture_state==='INTERRUPTED'||Number(trace.capture_summary?.interrupted??0)>0)reason_codes.push('CAPTURE_INTERRUPTED');
  const captureIncomplete=reason_codes.length>0;
  if(['PENDING','PARTIAL','UNREADABLE','ERROR'].includes(projection_status))reason_codes.push('PROJECTION_'+projection_status);
  const incomplete=reason_codes.length>0;
  if(capture_state==='UNKNOWN')reason_codes.push('CAPTURE_STATE_UNKNOWN');
  if(projection_status==='UNKNOWN')reason_codes.push('PROJECTION_STATE_UNKNOWN');
  const status=incomplete?'incomplete':capture_state==='COMPLETED'&&projection_status==='READY'?'no_known_gaps':'not_established';
  if(status==='not_established'&&!reason_codes.length)reason_codes.push('SOURCE_COMPLETENESS_NOT_ESTABLISHED');
  return {status,capture_state,projection_status,reason_codes,warning:status==='incomplete'?(captureIncomplete?'This recording is incomplete. Checks cover only the saved content.':'Readable content may be incomplete. Checks cover the available content.'):status==='not_established'?'Source completeness is not established. Checks cover only the saved content.':null};
}


export function qcVersion(trace:Document,scope:QcScope){
  const ref=scope==='private'?trace.raw_ref:trace.scrub_ref;
  return canonicalHash({scope,ref:ref??null,projection:trace.projection??null,capture_state:trace.capture_state??null,source_coverage:sourceCoverage(trace),
    ...(scope==='release'?{normalized_hash:trace.normalized_hash??null,rights_id:trace.rights_id??null,provenance_id:trace.provenance_id??null,release_revision:trace.release_revision??0,release_preparation:trace.release_preparation??null}:{})});
}
export const qcRunId=(owner:string,traceId:string,scope:QcScope,version:string)=>'qc:'+canonicalHash({owner,trace_id:traceId,scope,version,policy:QC_POLICY_VERSION});
export const qcJobId=(owner:string,traceId:string,scope:QcScope,version:string)=>'auto'+qcRunId(owner,traceId,scope,version);
export function qcAvailability(trace:Document,scope:QcScope,now:string){
  if(trace.deleted||!trace.retention_expires_at||trace.retention_expires_at<=now)return 'unavailable';
  if(['RECORDING','INFLIGHT'].includes(trace.capture_state)||trace.projection?.status==='PENDING')return 'preparing';
  if(!(scope==='private'?trace.raw_ref:trace.scrub_ref))return 'unavailable';
  if(scope==='release'&&(!trace.normalized_hash||!['eligible','eligible_with_restrictions'].includes(trace.rights_status)||trace.save_privately===true))return 'unavailable';
  return 'ready';
}
export function qcAutomation(trace:Document,scope:QcScope,now:string){
  const source_version=qcVersion(trace,scope),availability=qcAvailability(trace,scope,now),stored=trace.quality_checks?.[scope];
  const current=stored?.source_version===source_version&&stored?.policy_version===QC_POLICY_VERSION?stored:null;
  const state=availability==='preparing'?'preparing':availability!=='ready'?'not_scheduled':current?.state??'not_scheduled';
  return {state,retryable:state==='failed'&&current?.retryable===true,reason_code:availability==='preparing'?'QC_SOURCE_PREPARING':availability!=='ready'?'QC_SOURCE_UNAVAILABLE':current?.reason_code??null,
    attempts:current?.attempts??0,source_version,policy_version:QC_POLICY_VERSION,outcome:state==='complete'?current?.outcome??null:null,findings_count:state==='complete'?current?.findings_count??null:null};
}
export async function qcMark(tx:Transaction,trace:Document,scope:QcScope,version:string,patch:Document){
  ensure(qcVersion(trace,scope)===version,'QC_SOURCE_CHANGED',409);
  const old=trace.quality_checks?.[scope];
  trace.quality_checks={...trace.quality_checks,[scope]:{...(old?.source_version===version&&old?.policy_version===QC_POLICY_VERSION?old:{}),source_version:version,policy_version:QC_POLICY_VERSION,...patch}};
  await tx.update('traces',trace.trace_id,trace);
}
/** Metadata only, in the same short transaction as ingestion. No content or references enter the outbox. */
export async function enqueueTraceQc(tx:Transaction,trace:Document,now:string,scopes:QcScope[]=['private','release']){
  for(const scope of scopes){
    if(qcAvailability(trace,scope,now)!=='ready')continue;
    const source_version=qcVersion(trace,scope),id=qcJobId(trace.owner_id,trace.trace_id,scope,source_version),current=qcAutomation(trace,scope,now);
    // Keep at most one current job per trace/scope, fencing any replaced claim.
    await tx.sql.query("DELETE FROM outbox_events WHERE event_type=$1 AND owner_id=$2 AND payload->>'trace_id'=$3 AND payload->>'scope'=$4 AND id<>$5",[QC_EVENT,trace.owner_id,trace.trace_id,scope,id]);
    if(['complete','failed'].includes(current.state))continue;
    const payload={trace_id:trace.trace_id,scope,source_version,policy_version:QC_POLICY_VERSION};
    const inserted=await tx.sql.query("INSERT INTO outbox_events(id,owner_id,event_type,payload,status,available_at) VALUES($1,$2,$3,$4::jsonb,'pending',now()) ON CONFLICT(id) DO NOTHING RETURNING id",[id,trace.owner_id,QC_EVENT,canonicalJson(payload)]);
    if(inserted.rows.length)await qcMark(tx,trace,scope,source_version,{state:'queued',retryable:false,attempts:0,reason_code:null,outcome:null,findings_count:null});
  }
}
export function qcCardSummary(traces:Document[],now:string){
  const values=traces.map(trace=>qcAutomation(trace,'private',now)),complete=values.filter(v=>v.state==='complete');
  const recordings_attention=values.filter((v,i)=>v.state==='failed'||v.state==='complete'&&(v.outcome!=='pass'||sourceCoverage(traces[i]!).status==='incomplete')).length;
  const state=['running','queued','preparing','failed','not_scheduled'].find(s=>values.some(v=>v.state===s))??'complete';
  const outcome=complete.length===values.length?(['error','reject','flag','pass'].find(s=>complete.some(v=>v.outcome===s))??null):null;
  return {state,outcome,findings_count:complete.reduce((n,v)=>n+(v.findings_count??0),0),recordings_total:values.length,recordings_checked:complete.length,recordings_attention,retryable:values.some(v=>v.retryable)};
}
