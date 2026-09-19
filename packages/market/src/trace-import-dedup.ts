import { canonicalHash } from '../../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';

/** Consent is independent of the file name, timestamp and signed source wrapper. */
export function traceImportConsentHash(input:Document):string {
  const privateSave=input.save_privately===true;
  return canonicalHash({category:input.category??'general',...(privateSave?{save_privately:true}:{}),
    rights_confirmed:privateSave?false:input.rights_confirmed===true,
    model_output_licensed:privateSave?false:input.model_output_licensed===true,
    rights_flags:input.rights_flags??[],entity_spans:input.entity_spans??{},exclusion_terms:input.exclusion_terms??[]});
}

/**
 * Only inspect this owner's generic verified imports. A content match must never
 * become a cross-user existence oracle or silently replace stronger provenance.
 * Live captures retain separate request evidence and use reserve-level dedup.
 */
export async function ownedVerifiedImportDuplicate(tx:Transaction,owner:string,contentHash:string):Promise<Document|undefined> {
  const traces=await tx.list('traces',owner);
  for(const trace of traces){
    if(trace.import_content_hash||trace.import_preview||trace.agent_capture_id||trace.openrouter_request_id||trace.inference_request_id)continue;
    if(trace.import_verified_content_hash===contentHash)return trace;
    // Older imports already committed their exact normalized raw content in a
    // verified receipt. Reading that commitment avoids decrypting every trace.
    if(!trace.import_verified_content_hash&&trace.provenance_id){
      const provenance=await tx.get('provenance_receipts',trace.provenance_id,owner);
      if(provenance.receipt?.commitments?.raw_trace_hash===contentHash)return trace;
    }
  }
  return undefined;
}

export function duplicateImportResult(trace:Document,consentHash:string):{trace_id:string;status:string;duplicate:true} {
  ensure(!trace.deleted,'TRACE_DELETED',409);
  // Legacy rows do not have a consent commitment. Returning the existing row
  // never changes its rights, scrubbing, provenance or eligibility.
  if(trace.import_consent_hash)ensure(trace.import_consent_hash===consentHash,'IMPORT_CONSENT_CONFLICT',409);
  return {trace_id:trace.trace_id,status:trace.display_status,duplicate:true};
}
