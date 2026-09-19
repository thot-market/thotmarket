import { canonicalHash, uuidv7, validateProvenanceReceipt } from '../../protocol/src/index.ts';
import { ensure, type Document } from '../../storage/src/index.ts';
import type { Actor, ThotService } from './service.ts';

const INPUT_KEYS=new Set(['rights_confirmed','model_output_licensed','category']);

/**
 * Copies an already completed THOT inference exchange into private trace inventory.
 * This boundary never invokes an inference provider and makes only P0 operator claims.
 */
export class InferencePortfolioCapture {
  readonly service:ThotService;
  constructor(service:ThotService) { this.service=service; }

  async capture(actor:Actor,key:string,requestId:string,input:Document) {
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(typeof requestId==='string'&&requestId.length>0,'INVALID_INFERENCE_REQUEST_ID');
    ensure(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>INPUT_KEYS.has(k)),'INVALID_INFERENCE_CAPTURE');
    ensure(input.rights_confirmed===true,'CAPTURE_RIGHTS_CONFIRMATION_REQUIRED');
    ensure(typeof input.model_output_licensed==='boolean','CAPTURE_OUTPUT_CHOICE_REQUIRED');
    const category=input.category??'general';
    ensure(['general','research_flow','professional_flow'].includes(category),'INVALID_CATEGORY');
    const consentHash=canonicalHash({rights_confirmed:true,model_output_licensed:input.model_output_licensed,category});

    return this.service.db.command(actor.id,key,{action:'captureInferenceOutput',request_id:requestId,consent_hash:consentHash},async tx=>{
      const request=await tx.get('inference_requests',requestId,actor.id);
      ensure(request.status==='COMPLETED','INFERENCE_CAPTURE_REQUIRES_COMPLETED',409);
      ensure(!request.content_deleted&&request.prompt_ref&&request.output_ref,'INFERENCE_CAPTURE_CONTENT_UNAVAILABLE',410);
      if(request.capture_trace_id){
        ensure(request.capture_consent_hash===consentHash,'INFERENCE_CAPTURE_CONSENT_CONFLICT',409);
        return {trace_id:request.capture_trace_id,status:(await tx.get('traces',request.capture_trace_id,actor.id)).display_status,duplicate:true,
          capture_receipt:(await tx.get('provenance_receipts',request.capture_provenance_id,actor.id)).receipt};
      }

      const prompt=await this.service.privacy.open(actor.id,request.prompt_ref);
      const output=await this.service.privacy.open(actor.id,request.output_ref);
      ensure(typeof prompt?.prompt==='string'&&typeof output?.text==='string','INFERENCE_CAPTURE_CONTENT_INVALID');
      const trace={turns:[{role:'user',content:prompt.prompt},{role:'assistant',content:output.text}]};
      const traceId=uuidv7(),receiptId=uuidv7(),capturedAt=this.service.now();
      const source={schema_version:'thot.inference-capture/1',request_id:request.request_id,provider:request.provider,
        provider_response_id:request.provider_response_id,rate_card_hash:request.rate_card_hash,finished_at:request.finished_at,trace};
      const sourceHash=canonicalHash(source),contentCommitment=canonicalHash(trace);
      const receipt={schema_version:'trace.provenance/1',receipt_id:receiptId,trace_id:traceId,path:'operator_capture',confidence_tier:'P0_OPERATOR',
        temporal:{observed_start:request.finished_at,observed_end:request.finished_at},
        commitments:{raw_trace_hash:contentCommitment,source_bundle_hash:sourceHash},
        claims:['THOT copied the prompt and completed output already stored for this owned inference request into private trace inventory.','The capture is bound to the recorded request, provider response identifier and rate-card commitment.'],
        limitations:['Operator-recorded evidence only; the provider did not sign this conversation transcript.','No independent witness, attestation proxy verification, hardware quote or TEE provenance is established.','The provider response identifier and metering record do not prove authorship or execution environment.'],
        verifier:{implementation:'thot-inference-capture',version:'1',verified_at:capturedAt}};
      validateProvenanceReceipt(receipt);
      const assessment=await this.service.privacy.assess(traceId,trace,category,{rights_confirmed:true,model_output_licensed:input.model_output_licensed});
      assessment.features.provenance_tier='P0_OPERATOR';
      const sourceRef=await this.service.privacy.seal(actor.id,source);
      const rawRef=await this.service.privacy.seal(actor.id,trace);
      const scrubRef=await this.service.privacy.seal(actor.id,assessment.content);
      const bundleId=uuidv7();
      await tx.insert('trace_bundles',bundleId,actor.id,{trace_id:traceId,source_bundle_hash:sourceHash,source_bundle_format:'thot.inference-capture/1',object_ref:sourceRef});
      await tx.insert('provenance_receipts',receiptId,actor.id,{trace_id:traceId,receipt});
      await tx.insert('rights_assessments',assessment.rights.assessment_id,actor.id,{trace_id:traceId,receipt:assessment.rights});
      await tx.insert('scrub_receipts',assessment.scrub.scrub_id,actor.id,{trace_id:traceId,receipt:assessment.scrub});
      await tx.insert('trace_features',traceId,actor.id,assessment.features);
      const eligible=['eligible','eligible_with_restrictions'].includes(assessment.rights.status);
      await tx.insert('traces',traceId,actor.id,{trace_id:traceId,category,source_bundle_hash:sourceHash,source_bundle_id:bundleId,
        provenance_id:receiptId,rights_id:assessment.rights.assessment_id,scrub_id:assessment.scrub.scrub_id,raw_ref:rawRef,scrub_ref:scrubRef,
        provenance_status:'OPERATOR_CAPTURED',rights_status:assessment.rights.status,display_status:eligible?'AVAILABLE':'REJECTED',
        credential_ids:[],outcome_ids:[],sale_count:0,deleted:false,created_at:capturedAt,observed_at:request.finished_at,observed_end:request.finished_at,
        retention_expires_at:this.service.future((this.service.config.privateRetentionDays??30)*86400),normalized_hash:canonicalHash(assessment.content),
        capture_preview:{title:'THOT inference conversation',source:'THOT inference',source_date:request.finished_at,size_bytes:Buffer.byteLength(JSON.stringify(trace)),turn_count:2,content_commitment:contentCommitment,privacy_flags:[]},
        inference_request_id:requestId,capture_consent_hash:consentHash});
      request.capture_trace_id=traceId;request.capture_provenance_id=receiptId;request.capture_consent_hash=consentHash;
      await tx.update('inference_requests',requestId,request);
      await tx.audit(actor.id,'InferenceOutputCaptured',{request_id:requestId,trace_id:traceId,provenance_receipt_id:receiptId,content_commitment:contentCommitment});
      return {trace_id:traceId,status:eligible?'AVAILABLE':'REJECTED',duplicate:false,capture_receipt:receipt};
    });
  }
}
