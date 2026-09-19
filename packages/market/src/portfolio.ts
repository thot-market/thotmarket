import { canonicalHash } from '../../protocol/src/index.ts';
import { ensure, type Document } from '../../storage/src/index.ts';

export interface VerifiedCredentialReference {
  receipt_id:string; predicate_type:string; evidence_commitment:string;
  verification_status:'ORIGINAL_EVIDENCE_VERIFIED'; observed_at:string; valid_until?:string;
}
export interface PortfolioAppraisalInput {
  trace_id:string; content_commitment:string; features:Document; rights_status:string; provenance_status:string;
  credentials?:VerifiedCredentialReference[]; estimator_version?:'thot-demo-estimator/1'; appraised_at:string;
}
export interface PortfolioAppraisal {
  schema_version:'thot.demo-appraisal/1'; appraisal_id:string; trace_id:string; version:number; estimator_version:'thot-demo-estimator/1';
  appraised_at:string; input_commitment:string; content_commitment:string; estimated_value_minor:string; currency:'USD'; label:'DEMO_ESTIMATE';
  evidence_status:string; eligible_for_brokerage_research:boolean; credential_receipt_ids:string[];
  contributions:Array<{factor:string; amount_minor:string; explanation:string}>; limitations:string[];
}

const cleanCredentials=(value:VerifiedCredentialReference[]|undefined, now:string) => {
  const seen=new Set<string>();
  return [...(value??[])].map(c=>{
    ensure(c && typeof c.receipt_id==='string'&&c.receipt_id.length>0&&typeof c.predicate_type==='string'&&/^[a-f0-9]{64}$/.test(c.evidence_commitment)&&c.verification_status==='ORIGINAL_EVIDENCE_VERIFIED','INVALID_VERIFIED_CREDENTIAL_REFERENCE');
    ensure(Number.isFinite(Date.parse(c.observed_at))&&(!c.valid_until||Number.isFinite(Date.parse(c.valid_until))),'INVALID_VERIFIED_CREDENTIAL_REFERENCE');
    ensure(!seen.has(c.receipt_id),'DUPLICATE_CREDENTIAL_REFERENCE');seen.add(c.receipt_id);return c;
  }).filter(c=>!c.valid_until||c.valid_until>now).sort((a,b)=>a.receipt_id.localeCompare(b.receipt_id));
};

/** Deterministic, explicitly illustrative appraisal over persisted safe features and verified receipt references. */
export function appraisePortfolio(input:PortfolioAppraisalInput, prior:PortfolioAppraisal[]=[]):PortfolioAppraisal {
  ensure(typeof input.trace_id==='string'&&input.trace_id.length>0&&/^[a-f0-9]{64}$/.test(input.content_commitment),'INVALID_APPRAISAL_INPUT');
  ensure(Number.isFinite(Date.parse(input.appraised_at)),'INVALID_APPRAISAL_TIME');
  ensure(input.estimator_version===undefined||input.estimator_version==='thot-demo-estimator/1','UNSUPPORTED_ESTIMATOR');
  const turns=input.features?.counts?.turns, tools=input.features?.counts?.tool_calls;
  ensure(Number.isSafeInteger(turns)&&turns>=0&&turns<=5000&&Number.isSafeInteger(tools)&&tools>=0&&tools<=5000&&tools<=turns,'INVALID_APPRAISAL_FEATURES');
  ensure(['eligible','eligible_with_restrictions','manual_review','rejected'].includes(input.rights_status),'INVALID_RIGHTS_STATUS');
  const credentials=cleanCredentials(input.credentials,input.appraised_at);
  const credentialIds=credentials.map(c=>c.receipt_id);
  const estimator_version='thot-demo-estimator/1' as const;
  const basis={trace_id:input.trace_id,content_commitment:input.content_commitment,features:{counts:{turns,tool_calls:tools},workflow_type:input.features.workflow_type,topic_labels:input.features.topic_labels},rights_status:input.rights_status,provenance_status:input.provenance_status,credential_refs:credentials.map(c=>({receipt_id:c.receipt_id,predicate_type:c.predicate_type,evidence_commitment:c.evidence_commitment})),estimator_version};
  const input_commitment=canonicalHash(basis);
  const previous=prior.at(-1)?.input_commitment===input_commitment?prior.at(-1):undefined;
  if(previous)return previous;
  ensure(prior.every(a=>a.trace_id===input.trace_id&&a.schema_version==='thot.demo-appraisal/1'),'INVALID_APPRAISAL_HISTORY');
  const allowed=['eligible','eligible_with_restrictions'].includes(input.rights_status);
  const base=allowed?200:0, turnAmount=allowed?Math.min(turns,100)*25:0, toolAmount=allowed?Math.min(tools,100)*10:0;
  const contributions=[
    {factor:'eligible_research_inventory',amount_minor:String(base),explanation:allowed?'Demo baseline for inventory that passed rights review.':'No estimate while rights review is unresolved or rejected.'},
    {factor:'bounded_conversation_depth',amount_minor:String(turnAmount),explanation:`$0.25 per retained turn, capped at 100 turns (${Math.min(turns,100)} counted).`},
    {factor:'bounded_tool_context',amount_minor:String(toolAmount),explanation:`$0.10 per retained tool call, capped at 100 calls (${Math.min(tools,100)} counted).`},
  ];
  const brokerage=allowed&&credentials.some(c=>c.predicate_type==='brokerage_control');
  const version=Math.max(0,...prior.map(a=>a.version))+1;
  const appraisal_id=canonicalHash({schema_version:'thot.demo-appraisal/1',trace_id:input.trace_id,version,input_commitment});
  return {schema_version:'thot.demo-appraisal/1',appraisal_id,trace_id:input.trace_id,version,estimator_version,appraised_at:input.appraised_at,input_commitment,content_commitment:input.content_commitment,
    estimated_value_minor:String(base+turnAmount+toolAmount),currency:'USD',label:'DEMO_ESTIMATE',evidence_status:input.provenance_status,eligible_for_brokerage_research:brokerage,credential_receipt_ids:credentialIds,contributions,
    limitations:['Illustrative demo estimate only; it is not an offer, cash balance, promised return or market price.','A verified brokerage credential affects offer eligibility in this model and does not increase the estimate.','Historical uploads are user supplied and are not authenticated as provider conversations.']};
}

export interface PortfolioCardInput { trace:Document; features:Document; provenance:Document; rights:Document; preview?:Document;import_preview?:Document; appraisals?:PortfolioAppraisal[]; credentials?:VerifiedCredentialReference[]; }
export function buildPortfolioCard(input:PortfolioCardInput):Document {
  const preview=input.preview??input.import_preview;
  ensure(input.trace?.trace_id&&preview?.content_commitment,'INVALID_PORTFOLIO_INPUT');
  const history=[...(input.appraisals??[])].sort((a,b)=>a.version-b.version);
  ensure(history.every((a,i)=>a.trace_id===input.trace.trace_id&&a.version===i+1),'INVALID_APPRAISAL_HISTORY');
  return {schema_version:'thot.portfolio-card/1',trace_id:input.trace.trace_id,title:preview.title,source:preview.source_label??preview.source??'Claude Code (user supplied)',...(preview.source_date?{source_date:preview.source_date}:{}),
    ...(input.trace.agent_capture_id?{agent_capture_id:input.trace.agent_capture_id}:{}),...(input.trace.projection?{projection:input.trace.projection,capture_state:input.trace.capture_state,last_checkpoint_at:input.trace.last_checkpoint_at}:{}),imported_at:input.trace.created_at,size_bytes:preview.size_bytes,turn_count:preview.turn_count,content_commitment:preview.content_commitment,
    privacy_flags:preview.privacy_flags??[],status:input.trace.display_status,rights_status:input.rights.status,evidence:{status:input.trace.provenance_status,confidence_tier:input.provenance.confidence_tier,authenticated_provider_history:false},
    credentials:cleanCredentials(input.credentials,input.trace.created_at??new Date(0).toISOString()).map(c=>({receipt_id:c.receipt_id,predicate_type:c.predicate_type,observed_at:c.observed_at,...(c.valid_until?{valid_until:c.valid_until}:{})})),...(history.length?{appraisal:history.at(-1)}:{}),appraisal_history:history};
}
