import type {RemoteAccounting} from '../../vault/src/remote-accounting.ts';
import {CAPTURE_PART_JSON_BYTES} from '../../capture/src/limits.ts';
import { createPrivateKey, createPublicKey, createHmac, randomBytes } from 'node:crypto';
import { canonicalHash, canonicalJson, signCanonical, uuidv7, validateProvenanceReceipt } from '../../protocol/src/index.ts';
import { assertTraceContent, createDevelopmentBundle, verifyDevelopmentBundle, ExternalProvenanceVerifier, type DevelopmentBundle, type ExternalVerifierConfig } from '../../provenance/src/index.ts';
import { VaultStore, LocalMasterKeyProvider, type VaultQuotaOptions, type CiphertextStore, type KeyProvider } from '../../vault/src/index.ts';
import { evaluateRights, type RightsFlag } from '../../policy/src/index.ts';
import { scanSecrets, redactTraceCredentials, scrubTrace, extractPrivacySafeFeatures, type TraceFeatures } from '../../scrubber/src/index.ts';
import { MockCredentialProvider, SignedCredentialProvider, type CredentialReceipt, type SignedCredentialConfig } from '../../credentials/src/index.ts';
import { MockOutcomeProvider, SignedOutcomeVerifier, type OutcomeReceipt } from '../../outcomes/src/index.ts';
import { IsolatedAssayRunner } from '../../assays/src/index.ts';
import { ensure, type Document } from '../../storage/src/index.ts';
import type { PrivacyFacade } from './service.ts';
import { parseCodingSessionJsonl } from './history-import.ts';

/** A coarse search label, not an assay, valuation or proof of expertise. */
export function inferTraceWorkflow(content:Document,category:string):TraceFeatures['workflow_type']{
  if(category==='research_flow')return 'investment_research';
  if(category==='professional_flow')return 'contract_review';
  const userText=content.turns.filter((turn:Document)=>turn.role==='user').map((turn:Document)=>turn.content).join('\n');
  if(/\b(?:code|coding|typescript|javascript|python|debug(?:ging)?|compiler|compile|programming|sql|unit test|bug|cache|mutex)\b/i.test(userText))return 'coding';
  if(/\b(?:research|hypothesis|literature|scientific|evidence|experiment|journal paper)\b/i.test(userText))return 'research';
  return 'chat';
}

export interface IntegrationOptions {
  /** Legacy configuration accepted for compatibility; never authorizes trace egress. */
  nearPrivacyKey?:string;
  development: boolean; vaultRoot: string; masterKey: Buffer; clock?: () => Date;
  vaultQuotas?:VaultQuotaOptions['quotas'];
  remoteAccounting?:RemoteAccounting;
  ciphertextStore?: CiphertextStore;
  objectKeyProvider?: KeyProvider;
  externalVerifier?: ExternalVerifierConfig;
  credentialIssuers?: SignedCredentialConfig['trustedIssuers'];
  outcomeIssuers?: SignedCredentialConfig['trustedIssuers'];
}

/** Internal signed receipts stay intact. Buyer views are separately signed operator disclosures. */
export class PrivacyIntegrations implements PrivacyFacade {
  readonly vault: VaultStore; readonly options: IntegrationOptions;
  readonly credentials: SignedCredentialProvider; readonly outcomes: SignedOutcomeVerifier;
  readonly brokerageCredentials: SignedCredentialProvider;
  readonly assays: IsolatedAssayRunner; readonly disclosurePublicKey: string;
  private clock: () => Date; private signingKey; private brokerageSigningKey; private pseudonymKey: Buffer;
  constructor(options: IntegrationOptions) {
    this.options=options; this.clock=options.clock??(()=>new Date());
    this.vault=new VaultStore(options.ciphertextStore??options.vaultRoot,options.objectKeyProvider??new LocalMasterKeyProvider(options.masterKey),{maxBytes:CAPTURE_PART_JSON_BYTES,quotas:options.vaultQuotas,remoteAccounting:options.remoteAccounting});
    this.pseudonymKey=createHmac('sha256',options.masterKey).update('thot-pseudonyms-v1').digest();
    const seed=createHmac('sha256',options.masterKey).update('thot-disclosure-signing-v1').digest();
    this.signingKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
    this.disclosurePublicKey=createPublicKey(this.signingKey).export({type:'spki',format:'pem'}).toString();
    const brokerageSeed=createHmac('sha256',options.masterKey).update('thot-brokerage-normalization-signing-v1').digest();
    this.brokerageSigningKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),brokerageSeed]),format:'der',type:'pkcs8'});
    this.brokerageCredentials=new SignedCredentialProvider({trustedIssuers:{'thot-brokerage-bridge-v1':{publicKey:createPublicKey(this.brokerageSigningKey),provider:'robinhood'},'thot-brokerage-bridge-plaid-v1':{publicKey:createPublicKey(this.brokerageSigningKey),provider:'plaid'}},supportedPredicates:['brokerage_control'],maxAgeDays:1,now:this.clock});
    this.credentials=options.development?new MockCredentialProvider({now:this.clock}):new SignedCredentialProvider({trustedIssuers:options.credentialIssuers??{},now:this.clock});
    this.outcomes=options.development?new MockOutcomeProvider({records:[],now:this.clock}).verifier:new SignedOutcomeVerifier({trustedIssuers:options.outcomeIssuers??{},now:this.clock});
    this.assays=new IsolatedAssayRunner({now:this.clock});
  }
  async verify(bundle:unknown,traceId:string,owner:string) {
    let result, importedModel:Document|undefined, importedModels:Document[]|undefined;
    if(['thot.claude-code-jsonl/1','thot.coding-session-jsonl/1'].includes(String((bundle as Document)?.format))) {
      const source=bundle as Document;
      ensure(Object.keys(source).every(k=>['format','text'].includes(k))&&typeof source.text==='string','INVALID_HISTORY_BUNDLE');
      const parsed=parseCodingSessionJsonl(source.text);
      importedModels=parsed.model_history;importedModel={source:parsed.source.format,requested_model:null,returned_model:null,claimed_model:parsed.model_history.at(-1)?.claimed_model??null,provider_name:null,capture_status:'IMPORTED_UNVERIFIED',evidence:'user_supplied'};
      const now=this.clock().toISOString();
      result={trace:parsed.trace,normalizedReceipt:{schema_version:'trace.provenance/1' as const,receipt_id:uuidv7(),trace_id:traceId,path:'legacy_import' as const,confidence_tier:'P0_OPERATOR' as const,
        temporal:{observed_start:now,observed_end:now},commitments:{raw_trace_hash:canonicalHash(parsed.trace),source_bundle_hash:canonicalHash(bundle)},
        claims:['THOT recorded the supplied history and its content commitment at import time.'],
        limitations:['User-supplied history; original provider, model, authorship and conversation time are not authenticated.','Import time is not conversation time.','No witness or TEE provenance is established.'],
        verifier:{implementation:'thot-coding-session-import',version:'1',verified_at:now}}};
    } else if((bundle as Document)?.format==='thot.development-bundle/1') {
      result=verifyDevelopmentBundle(bundle as DevelopmentBundle,{userId:owner,allowDevelopment:this.options.development,now:this.clock().toISOString()});
      // This is a normalized, unsigned receipt, not a modification of the signed source bundle.
      result.normalizedReceipt.trace_id=traceId;
    } else {
      ensure(this.options.externalVerifier,'EXTERNAL_VERIFIER_NOT_CONFIGURED',503);
      result=await new ExternalProvenanceVerifier(this.options.externalVerifier).verify({bundle,traceId,userId:owner});
    }
    validateProvenanceReceipt(result.normalizedReceipt);
    const observed=result.normalizedReceipt.temporal.observed_start;
    const end=result.normalizedReceipt.temporal.observed_end??observed;
    ensure(observed&&end&&Number.isFinite(Date.parse(observed))&&Number.isFinite(Date.parse(end))&&Date.parse(observed)<=Date.parse(end)&&Date.parse(end)<=this.clock().getTime(),'INVALID_OBSERVATION_TIME');
    return {receipt:result.normalizedReceipt,content:result.trace,...(importedModel?{capture_model:importedModel,model_history:importedModels}: {})};
  }
  async seal(owner:string,value:unknown,objectId?:string) { return {...await this.vault.put({ownerUserId:owner,content:canonicalJson(value),objectId})}; }
  operatorJournalWriter(owner:string){const write=this.vault.operatorJournalWriter(owner);return async(value:unknown)=>({...await write(canonicalJson(value))});}
  async open(owner:string,ref:Document) {
    ensure(ref.ownerUserId===owner,'VAULT_ACCESS_DENIED',403);
    return JSON.parse((await this.vault.get({ownerUserId:owner,objectId:ref.objectId,role:'pipeline'})).toString('utf8'));
  }
  async remove(owner:string,ref:Document) {
    ensure(ref.ownerUserId===owner,'VAULT_ACCESS_DENIED',403);
    try{await this.vault.delete({ownerUserId:owner,objectId:ref.objectId});}catch(error:any){if(error.code!=='ENOENT')throw error;}
  }
  async assess(traceId:string,content:Document,category:string,input:Document) {
    assertTraceContent(content);
    const text=content.turns.map(t=>t.content).join('\n');
    const flags:RightsFlag[]=[...(input.rights_flags??[])];
    if(scanSecrets(redactTraceCredentials(content)).rejected)flags.push('secret');
    for(const [pattern,flag] of [
      [/attorney.client privileged|privileged legal|legal privilege/i,'privileged_legal'],
      [/client confidential/i,'client_confidential'],[/employer confidential/i,'employer_confidential'],
      [/material non.?public|\bMNPI\b|unreleased earnings/i,'mnpi_like'],
      [/brokerage account number|bank account number|routing number/i,'financial_account_sensitive']
    ] as [RegExp,RightsFlag][])if(pattern.test(text))flags.push(flag);
    // No guessed upstream model-output rights. Only the explicitly licensed roles can leave the vault.
    const roles=['system','developer','user','tool','function',...(input.model_output_licensed===true?['assistant']:[])];
    const rights=evaluateRights({traceId,flags,professionalFlow:category==='professional_flow',rightsConfirmed:input.rights_confirmed===true,components:roles,now:this.clock().toISOString()});
    const allowed:{turns:typeof content.turns}={turns:[]};
    const remappedSpans:Document={};
    for(const [index,turn]of content.turns.entries()) {
      if(roles.includes(turn.role)) {
        if(input.entity_spans?.[index])remappedSpans[allowed.turns.length]=input.entity_spans[index];
        allowed.turns.push(turn);
      }
    }
    if(input.entity_spans)ensure(Object.keys(input.entity_spans).every(key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<content.turns.length),'INVALID_SPAN_INDEX');
    let scrubbed;
    if(rights.status==='rejected'||rights.status==='manual_review'||allowed.turns.length===0) {
      if(allowed.turns.length===0){rights.status='rejected';rights.permitted_components=[];}
      const empty={turns:[{role:'user' as const,content:'[REDACTED]'}]};
      scrubbed={trace:empty,receipt:{schema_version:'trace.scrub/1',input_hash:canonicalHash(content),output_hash:canonicalHash(empty),scrubber_version:'thot-denied-content/1',edits_count:0,limitations:['Denied content is not available for assays or delivery.']}};
    } else scrubbed=scrubTrace({trace:allowed,traceId,pseudonymKey:this.pseudonymKey,exclusionTerms:input.exclusion_terms,entitySpans:remappedSpans,redactSecrets:true});
    if(!['rejected','manual_review'].includes(rights.status)&&allowed.turns.length){
      // A sale authorization is not consent to send plaintext to a privacy vendor.
      // Keep release assessment local until a separate consent-bound workflow exists.
      scrubbed={...scrubbed,receipt:{...scrubbed.receipt,privacy_filter:{provider:'local',status:'baseline_only'},limitations:[...(scrubbed.receipt.limitations??[]),'Only local baseline filtering was applied. It cannot reliably detect confidential context or all personal information.']}};
    }
    const scrub={...scrubbed.receipt,scrub_id:uuidv7(),trace_id:traceId,generated_at:this.clock().toISOString(),removed_components:content.turns.length-allowed.turns.length};
    const workflow=inferTraceWorkflow(content,category);
    const features=extractPrivacySafeFeatures({trace:scrubbed.trace,traceId,rights,provenanceTier:'P0_OPERATOR',workflowType:workflow,topicLabels:[category==='research_flow'?'finance':category==='professional_flow'?'contracts':workflow==='coding'?'coding':'other']});
    features.feature_model_version='thot-safe-features-user-keywords/2';
    return {rights,scrub:{...scrub,signature:signCanonical(scrub,this.signingKey)},content:scrubbed.trace,features};
  }
  verifyCredential(receipt:Document,owner:string) { (receipt.predicate_type==='brokerage_control'?this.brokerageCredentials:this.credentials).verify(receipt as CredentialReceipt,{userId:owner}); }
  normalizeBrokerage(owner:string,subject:string,evidenceHash:string,verifiedAt:string,validUntil:string,source:{provider:string;provider_method:string;issuer_key_id:string;claims:string[]}={provider:'robinhood',provider_method:'attested_witness_link',issuer_key_id:'thot-brokerage-bridge-v1',claims:['The configured verifier accepted an attested Robinhood account-control credential bound to this contributor link job.']}):CredentialReceipt {
    const unsigned:Omit<CredentialReceipt,'signature'>={schema_version:'trace.credential/1',receipt_id:uuidv7(),owner_user_id:owner,pseudonymous_subject_id:subject,
      provider:source.provider,provider_method:source.provider_method,predicate_type:'brokerage_control',predicate_value:'controls_brokerage:true',verified_at:verifiedAt,valid_until:validUntil,
      source_evidence_hash:evidenceHash,issuer_key_id:source.issuer_key_id,claims:source.claims,
      limitations:['THOT operator-signed normalization; original attested credential remains separate.','Does not establish legal identity, investment performance, trace authenticity, or research-to-trade causality.']};
    const receipt={...unsigned,signature:signCanonical(unsigned,this.brokerageSigningKey)};
    this.verifyCredential(receipt,owner);return receipt;
  }
  verifyOutcome(receipt:Document,owner:string,traceId:string) { this.outcomes.verify(receipt as OutcomeReceipt,{userId:owner,traceId}); }
  private disclosure(kind:string,receipt:Document,fields:Document):Document {
    const nonce=randomBytes(32).toString('hex');
    const unsigned={schema_version:`trace.${kind}-disclosure/1`,disclosure_id:uuidv7(),
      source_receipt_commitment:canonicalHash({receipt,nonce}),commitment_nonce:nonce,...fields,
      issuer_key_id:'thot-local-disclosure-v1',issued_at:this.clock().toISOString(),
      claims:['THOT Network verified the private source receipt and discloses only the listed predicate.'],
      limitations:['Operator-signed selective disclosure, not a zero-knowledge proof or a provider-signed redacted receipt.',
        ...(this.options.development&&receipt.provider!=='robinhood'?['Development provider evidence uses public mock keys; it is not real account evidence.']:[])]};
    return {...unsigned,signature:signCanonical(unsigned,this.signingKey)};
  }
  discloseCredential(receipt:Document) { return this.disclosure('credential',receipt,{provider:receipt.provider,predicate_type:receipt.predicate_type,predicate_value:receipt.predicate_value,verified_at:receipt.verified_at,...(receipt.valid_until?{valid_until:receipt.valid_until}:{})}); }
  discloseOutcome(receipt:Document) { return this.disclosure('outcome',receipt,{provider:receipt.provider,predicate:receipt.predicate,evidence_time:receipt.evidence_time}); }
  async assay(_content:Document,mandate:Document,traceId:string,features:Document) {
    const {id,owner_id,...safe}=features;
    return this.assays.run({traceId,mandateId:mandate.mandate_id,assayId:mandate.assay.assay_id,version:mandate.assay.version,
      threshold:mandate.assay.threshold,features:safe as TraceFeatures,eligibility:{provenance:true,credentials:true,outcomes:true,rights:true,policy:true},criteria:{workflowTypes:mandate.criteria.workflow_types,...(mandate.criteria.min_turns===undefined?{}:{minTurns:mandate.criteria.min_turns})}});
  }
  createDemoBundle(content:Document,owner:string) {
    ensure(this.options.development,'DEVELOPMENT_DISABLED',403);assertTraceContent(content);
    return createDevelopmentBundle({userId:owner,traceId:uuidv7(),trace:content,observedAt:this.clock().toISOString()});
  }
  demoCredential(owner:string) {
    ensure(this.options.development,'DEVELOPMENT_DISABLED',403);
    return (this.credentials as MockCredentialProvider).issue({userId:owner});
  }
  async demoOutcome(owner:string,traceId:string,security:string) {
    ensure(this.options.development,'DEVELOPMENT_DISABLED',403);
    const provider=new MockOutcomeProvider({now:this.clock,records:[{ownerUserId:owner,securityId:security,kind:'trade',occurredAt:this.clock().toISOString(),action:'buy',positionSize:12345,accountId:'NEVER-DISCLOSE-DEMO-ACCOUNT'}]});
    provider.grantConsent(owner,['security_traded']);
    return provider.attestPredicate({userId:owner,traceId,predicateRequest:{type:'security_traded',securityId:security}});
  }
}
