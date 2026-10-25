import {isResearch,validateResearchPackage,selectResearchFiles} from '../../content/src/research.ts';
import {canonicalHash,canonicalJson} from '../../protocol/src/index.ts';
import {ensure,type Document,type Transaction} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';
import {traceSaleEligibility} from './trace-library.ts';
import {enqueueTraceQc} from './trace-qc-state.ts';

export const RELEASE_PREVIEW_LIMITS=Object.freeze({max_bytes:2_000_000,max_turns:1000,max_revisions:32});
const digest=(value:unknown)=>'0x'+canonicalHash(value);
const state=(trace:Document)=>canonicalHash({scrub_ref:trace.scrub_ref,normalized_hash:trace.normalized_hash,rights_id:trace.rights_id,
  provenance_id:trace.provenance_id,save_privately:trace.save_privately??false,revision:trace.release_revision??0});
const bounded=(content:Document)=>{
  if(isResearch(content)){validateResearchPackage(content);return;}
  ensure(content&&Array.isArray(content.turns)&&content.turns.length>0&&content.turns.length<=RELEASE_PREVIEW_LIMITS.max_turns,'RELEASE_PREVIEW_LIMIT',413);
  ensure(Buffer.byteLength(canonicalJson(content))<=RELEASE_PREVIEW_LIMITS.max_bytes,'RELEASE_PREVIEW_LIMIT',413);
};

/** The owner reviews the same encrypted scrubbed content used by listTrace.
 * Source history and previously licensed artifacts are never rewritten here. */
export class ReleasePreview {
  readonly service:ThotService;
  constructor(service:ThotService){this.service=service;}
  private async snapshot(tx:Transaction,actor:Actor,id:string){
    const trace=await tx.get('traces',id,actor.id);
    ensure(!trace.deleted&&trace.retention_expires_at>this.service.now(),'TRACE_CONTENT_UNAVAILABLE',410);
    ensure(trace.scrub_ref&&trace.normalized_hash&&trace.rights_id&&trace.provenance_id,'RELEASE_EVIDENCE_UNAVAILABLE',409);
    const rights=(await tx.get('rights_assessments',trace.rights_id,actor.id)).receipt;
    const provenance=(await tx.get('provenance_receipts',trace.provenance_id,actor.id)).receipt;
    // Any prepared commitment is immutable, even if unlisted, expired or not
    // yet signed. In-flight buyers may still possess its authorization.
    const committed=(await tx.sql.query(`SELECT 1 AS present WHERE
      EXISTS (SELECT 1 FROM thot_records WHERE owner_id=$1 AND document->>'trace_id'=$2 AND document->>'kind'='listing') OR
      EXISTS (SELECT 1 FROM mandate_candidates WHERE owner_id=$1 AND document->>'trace_id'=$2) OR
      EXISTS (SELECT 1 FROM sale_authorizations WHERE owner_id=$1 AND document->>'trace_id'=$2) OR
      EXISTS (SELECT 1 FROM licenses WHERE owner_id=$1 AND document->>'trace_id'=$2)`,[actor.id,id])).rows.length>0;
    const eligibility=traceSaleEligibility(trace,this.service.now());
    const reason=committed||Number(trace.sale_count??0)>0?'RELEASE_ALREADY_COMMITTED':
      !(trace.import_content_hash&&trace.provenance_status==='IMPORTED_UNVERIFIED'&&!trace.agent_capture_id&&!trace.openrouter_request_id)?'EXCLUSION_IMPORT_ONLY':
      !eligibility.can_list?'RELEASE_NOT_READY':Number(trace.release_revision??0)>=RELEASE_PREVIEW_LIMITS.max_revisions?'RELEASE_REVISION_LIMIT':null;
    return {trace,rights,provenance,eligibility,exclusion:{supported:reason===null,reason_code:reason}};
  }
  async preview(actor:Actor,input:Document){
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(input&&Object.keys(input).length===1&&typeof input.trace_id==='string'&&input.trace_id.length>0&&input.trace_id.length<=160,'INVALID_RELEASE_PREVIEW');
    const snapshot=await this.service.db.transaction(tx=>this.snapshot(tx,actor,input.trace_id));
    const content=await this.service.privacy.open(actor.id,snapshot.trace.scrub_ref);bounded(content);
    ensure(canonicalHash(content)===snapshot.trace.normalized_hash,'RELEASE_CHANGED',409);
    // Do not return content after its owner deleted/replaced it while storage
    // was being read. No object-store request holds the database lock.
    const current=await this.service.db.transaction(tx=>this.snapshot(tx,actor,input.trace_id));
    ensure(state(current.trace)===state(snapshot.trace),'RELEASE_CHANGED',409);
    return {trace_id:input.trace_id,content_hash:digest(content),content,capture_model:current.trace.capture_model??null,
      rights_status:current.trace.rights_status,provenance:current.provenance.confidence_tier,provenance_status:current.trace.provenance_status,
      sale_eligibility:current.eligibility,exclusion:current.exclusion,release_revision:current.trace.release_revision??0,
      metrics:{...(isResearch(content)?{files:content.files.length,bytes:content.files.reduce((n,f)=>n+f.bytes,0)}:{}),turns:content.turns?.length??0,tool_turns:(content.turns??[]).filter((turn:Document)=>turn.role==='tool'||turn.role==='function').length},
      privacy:{flags:current.rights.flags??[],limitations:['Local baseline filtering cannot reliably detect all personal information or confidential context. Review every included message.']},
      limits:RELEASE_PREVIEW_LIMITS,content_kind:isResearch(content)?'research':'trace',notice:'Exact proposed release content. License terms and any separately selected evidence are added when you prepare the listing. This review does not authorize a sale.'};
  }
  async exclude(actor:Actor,key:string,input:Document){
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(input&&Object.keys(input).every(k=>['trace_id','content_hash','excluded_turns','excluded_files','rights_confirmed','model_output_licensed'].includes(k)),'INVALID_RELEASE_EXCLUSION');
    ensure(typeof input.trace_id==='string'&&input.trace_id.length>0&&input.trace_id.length<=160&&/^0x[a-f0-9]{64}$/.test(input.content_hash??''),'INVALID_RELEASE_EXCLUSION');
    ensure(input.rights_confirmed===true,'IMPORT_RIGHTS_CONFIRMATION_REQUIRED');
    ensure(typeof input.model_output_licensed==='boolean','IMPORT_OUTPUT_CHOICE_REQUIRED');
    const fileMode=Array.isArray(input.excluded_files);
    ensure(fileMode?input.excluded_turns===undefined:input.excluded_files===undefined,'INVALID_RELEASE_EXCLUSION');
    const indices=fileMode?input.excluded_files:input.excluded_turns;
    ensure(Array.isArray(indices)&&indices.length>0&&indices.length<=RELEASE_PREVIEW_LIMITS.max_turns&&indices.every(i=>fileMode?typeof i==='string'&&i.length<=180:Number.isSafeInteger(i)&&i>=0)&&new Set(indices).size===indices.length,'INVALID_RELEASE_EXCLUSION');
    await this.service.staged.run(actor.id,key,{action:'releaseExclude',input},'projection',async stage=>{
      const before=await this.service.db.transaction(tx=>this.snapshot(tx,actor,input.trace_id));
      ensure(before.exclusion.supported,before.exclusion.reason_code??'RELEASE_NOT_READY',409);
      const content=await stage.open(before.trace.scrub_ref);bounded(content);
      ensure(digest(content)===input.content_hash&&canonicalHash(content)===before.trace.normalized_hash,'RELEASE_CHANGED',409);
      ensure(fileMode===isResearch(content),'INVALID_RELEASE_EXCLUSION');
      if(!fileMode)ensure(indices.every(i=>i<content.turns.length)&&indices.length<content.turns.length,'INVALID_RELEASE_EXCLUSION');
      const excluded=new Set(indices),selected=isResearch(content)?selectResearchFiles(content,indices):{turns:content.turns.filter((_:unknown,i:number)=>!excluded.has(i))};
      // Reassess only already permitted content. Previously removed assistant
      // output or sensitive spans cannot be restored by a new checkbox choice.
      const assessment=await this.service.privacy.assess(input.trace_id,selected,before.trace.category,{rights_confirmed:true,
        model_output_licensed:input.model_output_licensed,rights_flags:before.rights.flags??[]});
      bounded(assessment.content);assessment.features.provenance_tier=before.provenance.confidence_tier;
      const ref=await stage.seal(assessment.content),hash=canonicalHash(assessment.content);
      return async tx=>{
        const current=await this.snapshot(tx,actor,input.trace_id);
        ensure(current.exclusion.supported,current.exclusion.reason_code??'RELEASE_NOT_READY',409);
        ensure(state(current.trace)===state(before.trace),'RELEASE_CHANGED',409);
        const trace=current.trace;
        await tx.insert('rights_assessments',assessment.rights.assessment_id,actor.id,{trace_id:trace.trace_id,receipt:assessment.rights});
        await tx.insert('scrub_receipts',assessment.scrub.scrub_id,actor.id,{trace_id:trace.trace_id,receipt:assessment.scrub});
        await tx.update('trace_features',trace.trace_id,assessment.features);
        trace.projection_refs=[...(trace.projection_refs??[]),trace.scrub_ref];
        trace.scrub_ref=ref;trace.normalized_hash=hash;trace.rights_id=assessment.rights.assessment_id;trace.scrub_id=assessment.scrub.scrub_id;
        trace.rights_status=assessment.rights.status;trace.display_status=['eligible','eligible_with_restrictions'].includes(assessment.rights.status)?'AVAILABLE':'REJECTED';
        trace.release_revision=Number(trace.release_revision??0)+1;trace.updated_at=this.service.now();
        // An edited release requires its own listing signature; an older
        // standing mandate must not discover the replacement automatically.
        trace.thot_listing_only=true;
        trace.release_edit={previous_content_hash:input.content_hash,content_hash:'0x'+hash,...(fileMode?{excluded_files:indices.length}:{excluded_turns:indices.length}),revision:trace.release_revision};
        await tx.update('traces',trace.trace_id,trace);
        await enqueueTraceQc(tx,trace,this.service.now(),['release']);
        await tx.audit(actor.id,'ReleaseMessagesExcluded',{trace_id:trace.trace_id,previous_content_hash:input.content_hash,content_hash:'0x'+hash,...(fileMode?{excluded_files:indices.length}:{excluded_turns:indices.length}),revision:trace.release_revision});
        // Idempotency responses live in metadata storage: never persist plaintext
        // preview content there. Re-read the encrypted preview after commit.
        return {trace_id:trace.trace_id,content_hash:'0x'+hash,release_revision:trace.release_revision};
      };
    });
    return this.preview(actor,{trace_id:input.trace_id});
  }
}
