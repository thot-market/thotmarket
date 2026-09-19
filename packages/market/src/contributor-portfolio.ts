import { canonicalHash } from '../../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import { scanSecrets } from '../../scrubber/src/index.ts';
import type { Actor, ThotService } from './service.ts';
import { parseCodingSessionJsonl } from './history-import.ts';
import { appraisePortfolio, buildPortfolioCard, type VerifiedCredentialReference } from './portfolio.ts';
import type { RobinhoodLinks } from './robinhood-link.ts';
import type { PlaidLinks } from './plaid-link.ts';
import { demoBuyer, mandateInput, policyInput } from './fixtures.ts';

export class ContributorPortfolio {
  readonly service:ThotService; readonly robinhood:RobinhoodLinks; readonly plaid:PlaidLinks;
  constructor(service:ThotService,robinhood:RobinhoodLinks,plaid:PlaidLinks){this.service=service;this.robinhood=robinhood;this.plaid=plaid;}
  preview(actor:Actor,input:Document){
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(typeof input.text==='string'&&typeof input.filename==='string'&&input.filename.length<=200,'INVALID_IMPORT_REQUEST');
    const parsed=parseCodingSessionJsonl(input.text);
    return {...parsed.preview,warnings:parsed.limitations,privacy_flags:[...new Set([...parsed.preview.privacy_flags,...(scanSecrets(parsed.trace).rejected?['secret']:[])])],metadata_records_skipped:parsed.summary.metadata_records_skipped};
  }
  async import(actor:Actor,key:string,input:Document){
    const preview=this.preview(actor,input);
    ensure(input.content_commitment===preview.content_commitment,'IMPORT_PREVIEW_CHANGED',409);
    ensure(input.save_privately===undefined||typeof input.save_privately==='boolean','INVALID_PRIVATE_IMPORT');
    const privateSave=input.save_privately===true;
    if(privateSave)ensure((input.rights_confirmed===undefined||input.rights_confirmed===false)&&(input.model_output_licensed===undefined||input.model_output_licensed===false),'PRIVATE_IMPORT_RELEASE_CONFLICT');
    else{ensure(input.rights_confirmed===true,'IMPORT_RIGHTS_CONFIRMATION_REQUIRED');ensure(typeof input.model_output_licensed==='boolean','IMPORT_OUTPUT_CHOICE_REQUIRED');}
    const imported=await this.service.importTrace(actor,key,{bundle:{format:'thot.coding-session-jsonl/1',text:input.text},content_commitment:preview.content_commitment,category:input.category??(privateSave?'general':'research_flow'),...(privateSave?{save_privately:true}:{rights_confirmed:true,model_output_licensed:input.model_output_licensed})});
    // Retry recovers this metadata step after an interrupted import, without duplicate inventory.
    const saved=await this.service.db.transaction(async tx=>{
      const trace=await tx.get('traces',imported.trace_id,actor.id);
      if(!trace.import_preview){trace.import_preview=preview;trace.provenance_status='IMPORTED_UNVERIFIED';await tx.update('traces',trace.trace_id,trace);}
      const credentials=await this.verifiedCredentials(tx,actor);
      trace.credential_ids=[...new Set([...trace.credential_ids,...credentials.map(c=>c.receipt_id)])];await tx.update('traces',trace.trace_id,trace);
      const item=await this.appraise(tx,actor,trace,credentials);await this.service.enqueueMatching(tx);
      return !trace.deleted&&trace.retention_expires_at>this.service.now()?{item,ref:trace.private_metadata_ref}:undefined;
    });
    return {...imported,item:saved?await this.decorateCard(actor,saved.item,saved.ref):undefined};
  }
  async prepareSale(actor:Actor,key:string,traceId:string,input:Document){
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(Object.keys(input).every(k=>['content_commitment','rights_confirmed','model_output_licensed'].includes(k)),'INVALID_RELEASE_PREPARATION');
    ensure(input.rights_confirmed===true,'IMPORT_RIGHTS_CONFIRMATION_REQUIRED');
    ensure(typeof input.model_output_licensed==='boolean','IMPORT_OUTPUT_CHOICE_REQUIRED');
    return this.service.db.command(actor.id,key,{action:'preparePrivateImportSale',traceId,input},async tx=>{
      const trace=await tx.get('traces',traceId,actor.id);
      ensure(!trace.deleted&&trace.retention_expires_at>this.service.now(),'TRACE_CONTENT_UNAVAILABLE',410);
      ensure(trace.save_privately===true&&trace.import_preview&&trace.import_content_hash&&!trace.agent_capture_id,'PRIVATE_IMPORT_REQUIRED',409);
      ensure(input.content_commitment===trace.import_content_hash,'IMPORT_PREVIEW_CHANGED',409);
      const content=await this.service.privacy.open(actor.id,trace.raw_ref);
      ensure(canonicalHash(content)===trace.import_content_hash,'IMPORT_PREVIEW_CHANGED',409);
      const assessment=await this.service.privacy.assess(traceId,content,trace.category,input);
      const provenance=(await tx.get('provenance_receipts',trace.provenance_id,actor.id)).receipt;
      assessment.features.provenance_tier=provenance.confidence_tier;
      await tx.insert('rights_assessments',assessment.rights.assessment_id,actor.id,{trace_id:traceId,receipt:assessment.rights});
      await tx.insert('scrub_receipts',assessment.scrub.scrub_id,actor.id,{trace_id:traceId,receipt:assessment.scrub});
      await tx.update('trace_features',traceId,assessment.features);
      trace.projection_refs??=[];trace.projection_refs.push(trace.scrub_ref);
      trace.scrub_ref=await this.service.privacy.seal(actor.id,assessment.content);
      trace.rights_id=assessment.rights.assessment_id;trace.scrub_id=assessment.scrub.scrub_id;
      trace.rights_status=assessment.rights.status;
      trace.display_status=['eligible','eligible_with_restrictions'].includes(assessment.rights.status)?'AVAILABLE':'REJECTED';
      trace.normalized_hash=canonicalHash(assessment.content);trace.save_privately=false;
      // Preparing rights must not enroll a private deposit in an older standing policy.
      // Only a subsequent, separately signed THOT listing may authorize its sale.
      trace.thot_listing_only=true;trace.updated_at=this.service.now();
      await tx.update('traces',traceId,trace);
      await tx.audit(actor.id,'PrivateImportReleasePrepared',{trace_id:traceId,rights_status:trace.rights_status,model_output_licensed:input.model_output_licensed});
      return {trace_id:traceId,status:trace.display_status,rights_status:trace.rights_status,listed:false};
    });
  }
  private async verifiedCredentials(tx:Transaction,actor:Actor):Promise<VerifiedCredentialReference[]>{
    const owner=await tx.get('users',actor.id,actor.id),revoked=owner.revoked_receipts??[];
    const refs:VerifiedCredentialReference[]=[];
    for(const row of await tx.list('credential_receipts',actor.id)){
      const c=row.receipt;
      if(c.predicate_type!=='brokerage_control'||revoked.includes(c.receipt_id)||!row.original_evidence||canonicalHash(row.original_evidence)!==c.source_evidence_hash)continue;
      try{this.service.privacy.verifyCredential(c,actor.id);}catch{continue;}
      refs.push({receipt_id:c.receipt_id,predicate_type:c.predicate_type,evidence_commitment:c.source_evidence_hash,verification_status:'ORIGINAL_EVIDENCE_VERIFIED',observed_at:c.verified_at,valid_until:c.valid_until});
    }return refs;
  }
  private async appraise(tx:Transaction,actor:Actor,trace:Document,credentials:VerifiedCredentialReference[]){
    const preview={...(trace.import_preview??trace.capture_preview)};
    if(!trace.rights_id||!await tx.maybe('trace_features',trace.trace_id))return {...preview,trace_id:trace.trace_id,agent_capture_id:trace.agent_capture_id,status:trace.display_status,rights_status:'pending',evidence:{status:trace.provenance_status,confidence_tier:(await tx.get('provenance_receipts',trace.provenance_id,actor.id)).receipt.confidence_tier},projection:trace.projection,capture_state:trace.capture_state,imported_at:trace.created_at,appraisal_history:[]};
    const features=await tx.get('trace_features',trace.trace_id,actor.id),rights=(await tx.get('rights_assessments',trace.rights_id,actor.id)).receipt;
    const history=trace.appraisal_history??[];
    const appraisal=appraisePortfolio({trace_id:trace.trace_id,content_commitment:preview.content_commitment,features,rights_status:rights.status,provenance_status:trace.provenance_status,credentials,appraised_at:this.service.now()},history);
    if(!history.some((a:Document)=>a.appraisal_id===appraisal.appraisal_id)){
      trace.appraisal_history=[...history,appraisal];await tx.update('traces',trace.trace_id,trace);
      await tx.audit(actor.id,'PortfolioAppraised',{trace_id:trace.trace_id,appraisal_id:appraisal.appraisal_id,version:appraisal.version});
    }
    return buildPortfolioCard({trace,features,rights,provenance:(await tx.get('provenance_receipts',trace.provenance_id,actor.id)).receipt,preview,appraisals:trace.appraisal_history,credentials});
  }
  private async decorateCard(actor:Actor,item:Document,ref:Document|undefined):Promise<Document>{
    const metadata=ref?await this.service.privacy.open(actor.id,ref):{};
    return {...item,...(typeof metadata.title==='string'?{title:metadata.title}:{}),...(typeof metadata.answer_preview==='string'?{answer_preview:metadata.answer_preview}:{})};
  }
  async list(actor:Actor){
    ensure(actor.role==='user','FORBIDDEN',403);
    const items=await this.service.db.transaction(async tx=>{
      const credentials=await this.verifiedCredentials(tx,actor),items:Document[]=[];
      for(const trace of await tx.list('traces',actor.id))if((trace.import_preview||trace.capture_preview)&&!trace.deleted&&trace.retention_expires_at>this.service.now())items.push({item:await this.appraise(tx,actor,trace,credentials),ref:trace.private_metadata_ref});
      return items;
    });
    const cards:Document[]=new Array(items.length);let next=0;
    // Bounded remote reads happen after the database transaction releases its lock.
    await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{for(;;){const i=next++;if(i>=items.length)return;cards[i]=await this.decorateCard(actor,items[i]!.item,items[i]!.ref);}}));
    return {items:cards,robinhood:await this.robinhood.status(actor),capabilities:{...this.robinhood.capabilities(),...this.plaid.capabilities()}};
  }
  async demoOffer(actor:Actor,key:string,traceId:string){
    ensure(actor.role==='user','FORBIDDEN',403);ensure(this.service.config.development,'DEVELOPMENT_DISABLED',403);
    const portfolio=await this.list(actor),item=portfolio.items.find(i=>i.trace_id===traceId);
    ensure(item&&item.appraisal?.eligible_for_brokerage_research,'VERIFIED_BROKERAGE_REQUIRED',409);
    const policy=await this.service.db.command(actor.id,key+':policy-input',{action:'portfolio.demo-policy',traceId},async()=>({...policyInput(this.service),evidence_disclosure:{trace_body:true,credential_predicate_types:['brokerage_control'],outcome_predicate_types:[],identity_disclosure:false}}));
    await this.service.createPolicy(actor,key+':policy',policy);
    const input=await this.service.db.command(actor.id,key+':offer-input',{action:'portfolio.demo-offer',traceId},async()=>{
      const draft=mandateInput(this.service,'research_flow');
      draft.criteria={provenance_tiers:['P0_OPERATOR','P2_TEE'],workflow_types:['investment_research'],rights_required:['eligible','eligible_with_restrictions'],credential_predicates:[{type:'brokerage_control',accepted_values:['controls_brokerage:true'],freshness_days:1}]};
      draft.license_template_id='local-portfolio-demo-v1';draft.license.retention_days=1;
      return draft;
    });
    const mandate=await this.service.createMandate(demoBuyer,key+':create',input);
    await this.service.fundMandate(demoBuyer,key+':fund',mandate.mandate_id,{});
    await this.service.activateMandate(demoBuyer,key+':activate',mandate.mandate_id);
    await this.service.runWorker(20);
    return {mandate_id:mandate.mandate_id,simulated:true,candidates:(await this.service.candidates(actor)).filter((c:Document)=>c.trace_id===traceId&&c.mandate_id===mandate.mandate_id)};
  }
}
