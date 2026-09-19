import { canonicalHash, parseMoney, uuidv7 } from '../../protocol/src/index.ts';
import { maximumReservation, type InferenceProvider } from '../../inference/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import { type Actor, ThotService } from './service.ts';
import { assertOperationEnabled } from './operational-controls.ts';

const billingEnvironment=(provider:InferenceProvider)=>(provider as InferenceProvider&{billingEnvironment?:'synthetic'|'external'}).billingEnvironment==='synthetic'?'synthetic':'external';

/** Durable at-most-one automatic submission. Unknown outcomes hold credit; they never auto-retry/refund. */
export class InferenceGateway {
  readonly service:ThotService;readonly provider?:InferenceProvider;readonly dailyBudgetMinor:string;
  constructor(service:ThotService,provider?:InferenceProvider,dailyBudgetMinor='0'){
    this.service=service;this.provider=provider;this.dailyBudgetMinor=dailyBudgetMinor;
    ensure(parseMoney(dailyBudgetMinor)<=100_000n,'INFERENCE_DAILY_BUDGET_TOO_LARGE');
  }
  capabilities():Document {
    if(!this.provider||parseMoney(this.dailyBudgetMinor)===0n)return {enabled:false,reason:'NO_APPROVED_INFERENCE_PROVIDER_OR_BUDGET',live:false};
    try{this.provider.validate();}catch{return {enabled:false,reason:'RATE_CARD_EXPIRED_OR_INVALID',live:false};}
    return {enabled:true,live:true,provider:this.provider.provider,rate_card:this.provider.rateCard,rate_card_hash:canonicalHash(this.provider.rateCard),
      reservation_minor:maximumReservation(this.provider.rateCard),daily_budget_minor:this.dailyBudgetMinor,currency:'USD',external_prompt_transfer:true,
      notice:'Opt-in external inference. Sends only your entered prompt. Synthetic sale credit is not real funding; the configured operator pays the provider. Tariff charges accrue a payable, not a paid invoice.'};
  }
  private user(actor:Actor){ensure(actor.role==='user','FORBIDDEN',403);}
  async create(actor:Actor,key:string,input:Document){
    this.user(actor);const provider=this.provider;ensure(provider,'INFERENCE_DISABLED',503);provider.validate();
    ensure(Object.keys(input).every(k=>['entitlement_id','prompt','max_cost_minor','provider','rate_card_hash','consent_external_processing'].includes(k)),'INVALID_INFERENCE_REQUEST');
    ensure(typeof input.prompt==='string'&&input.prompt.trim().length>0&&Buffer.byteLength(input.prompt)<=100_000,'INVALID_INFERENCE_PROMPT');
    ensure(input.consent_external_processing===true&&input.provider===provider.provider&&input.rate_card_hash===canonicalHash(provider.rateCard),'INFERENCE_CONSENT_REQUIRED');
    const amount=maximumReservation(provider.rateCard);ensure(parseMoney(input.max_cost_minor)>=BigInt(amount),'INFERENCE_BUDGET_TOO_SMALL');
    let createdRef:Document|undefined;
    try{return await this.service.db.command(actor.id,key,{action:'inferenceRequest',input},async tx=>{
      await assertOperationEnabled(tx,'inference');
      const ownerRequests=await tx.list('inference_requests',actor.id);
      ensure(!ownerRequests.some(r=>r.status==='UNCERTAIN'),'INFERENCE_RECONCILIATION_REQUIRED',409);
      ensure(ownerRequests.filter(r=>['QUEUED','PROCESSING'].includes(r.status)).length<2,'INFERENCE_CONCURRENCY_LIMIT',429);
      const since=new Date(Date.parse(this.service.now())-86400000).toISOString();
      ensure(ownerRequests.filter(r=>r.created_at>since).length<100,'INFERENCE_DAILY_QUOTA',429);
      const globalRequests=await tx.list('inference_requests');
      const reservedToday=globalRequests.filter(r=>r.created_at>since).reduce((sum,r)=>sum+BigInt(r.reserved_minor),0n);
      ensure(reservedToday+BigInt(amount)<=parseMoney(this.dailyBudgetMinor),'OPERATOR_INFERENCE_DAILY_BUDGET',429);
      const e=await tx.get('contributor_entitlements',input.entitlement_id,actor.id);ensure(e.currency==='USD','INFERENCE_CURRENCY_UNSUPPORTED');
      const id=uuidv7(),reserved=await this.service.reserveInferenceIn(tx,actor,e.entitlement_id,{amount_minor:amount},id);
      const promptRef=await this.service.privacy.seal(actor.id,{prompt:input.prompt});
      createdRef=promptRef;
      const r={request_id:id,entitlement_id:e.entitlement_id,reservation_id:reserved.reservation_id,reserved_minor:amount,
        currency:'USD',status:'QUEUED',provider:provider.provider,rate_card_hash:input.rate_card_hash,rate_card:provider.rateCard,
        billing_environment:billingEnvironment(provider),
        prompt_ref:promptRef,created_at:this.service.now(),expires_at:this.service.future(600),retention_expires_at:this.service.future(30*86400)};
      await tx.insert('inference_requests',id,actor.id,r);
      await tx.audit(actor.id,'InferenceRequestAuthorized',{request_id:id,reservation_id:reserved.reservation_id,rate_card_hash:input.rate_card_hash});
      return {request_id:id};
    });}catch(error){if(createdRef)await this.cleanupUnreferenced(actor.id,createdRef);throw error;}
  }
  private async cleanupUnreferenced(owner:string,ref:Document){
    try{await this.service.db.transaction(async tx=>{
      const referenced=(await tx.list('inference_requests',owner)).some(r=>r.prompt_ref?.objectId===ref.objectId||r.output_ref?.objectId===ref.objectId);
      if(!referenced)await this.service.privacy.remove(owner,ref);
    });}catch{/* If database state cannot be checked after a crash, retain ciphertext for operator orphan review. */}
  }
  private safe(r:Document):Document {
    const fields=['request_id','entitlement_id','reservation_id','reserved_minor','currency','status','provider','rate_card_hash','created_at','expires_at','retention_expires_at','actual_minor','usage','provider_response_id','failure_code','content_deleted','finished_at','billing_environment','billing_resolution','billing_verified_at','billing_evidence_record_id','billing_review_id'];
    return Object.fromEntries(fields.filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
  }
  async list(actor:Actor){this.user(actor);return this.service.db.transaction(async tx=>(await tx.list('inference_requests',actor.id)).map(r=>this.safe(r)));}
  async get(actor:Actor,id:string){
    this.user(actor);return this.service.db.transaction(async tx=>{
      const r=await tx.get('inference_requests',id,actor.id),result=this.safe(r);
      if(r.output_ref&&!r.content_deleted&&r.retention_expires_at>this.service.now())result.output=await this.service.privacy.open(actor.id,r.output_ref);
      return result;
    });
  }
  private async settle(tx:Transaction,r:Document,actual:string){
    await this.service.settleInferenceIn(tx,r.reservation_id,{request_id:r.request_id,actual_minor:actual,provider_metered:true});
    r.actual_minor=actual;r.finished_at=this.service.now();
  }
  async execute(actor:Actor,id:string){
    this.user(actor);const provider=this.provider;ensure(provider,'INFERENCE_DISABLED',503);
    const claimed=await this.service.db.transaction(async tx=>{
      const r=await tx.get('inference_requests',id,actor.id);if(r.status!=='QUEUED')return false;
      await assertOperationEnabled(tx,'inference');
      provider.validate();ensure(r.rate_card_hash===canonicalHash(provider.rateCard),'INFERENCE_RATE_CARD_CHANGED');
      ensure(r.provider===provider.provider,'INFERENCE_PROVIDER_CHANGED');
      ensure((r.billing_environment??'external')===billingEnvironment(provider),'INFERENCE_BILLING_ENVIRONMENT_CHANGED');
      ensure(parseMoney(this.dailyBudgetMinor)>0n,'INFERENCE_DISABLED',503);
      const since=new Date(Date.parse(this.service.now())-86400000).toISOString();
      const committed=(await tx.list('inference_requests')).filter(q=>q.created_at>since).reduce((sum,q)=>sum+BigInt(q.reserved_minor),0n);
      ensure(committed<=parseMoney(this.dailyBudgetMinor),'OPERATOR_INFERENCE_DAILY_BUDGET',429);
      ensure(r.expires_at>this.service.now()&&!r.content_deleted,'INFERENCE_REQUEST_EXPIRED');
      ensure(!(await tx.list('inference_requests',actor.id)).some(q=>q.status==='UNCERTAIN'),'INFERENCE_RECONCILIATION_REQUIRED',409);
      r.status='PROCESSING';r.processing_deadline=this.service.future(120);
      await tx.update('inference_requests',id,r);await tx.audit(actor.id,'InferenceRequestStarted',{request_id:id});return r;
    });
    if(!claimed)return this.get(actor,id);
    let generationSubmitted=false;let createdOutputRef:Document|undefined;
    try {
      const {prompt}=await this.service.privacy.open(actor.id,claimed.prompt_ref);
      await provider.count(prompt,id);provider.validate();
      generationSubmitted=true;
      const result=await provider.generate(prompt,id);
      ensure(BigInt(result.actual_minor)<=BigInt(claimed.reserved_minor),'INFERENCE_RESERVATION_EXCEEDED');
      await this.service.db.transaction(async tx=>{
        const r=await tx.get('inference_requests',id,actor.id);ensure(r.status==='PROCESSING','INFERENCE_STATE_CONFLICT');
        ensure(!(await tx.list('inference_requests')).some(q=>q.provider===r.provider&&q.provider_response_id===result.provider_response_id),'DUPLICATE_PROVIDER_RESPONSE');
        r.output_ref=await this.service.privacy.seal(actor.id,{text:result.text});
        createdOutputRef=r.output_ref;
        await this.settle(tx,r,result.actual_minor);
        Object.assign(r,{status:result.status,usage:result.usage,provider_response_id:result.provider_response_id});
        await tx.update('inference_requests',id,r);await tx.audit(actor.id,'InferenceRequestMetered',{request_id:id,reservation_id:r.reservation_id,status:r.status});
      });
    } catch {
      if(createdOutputRef)await this.cleanupUnreferenced(actor.id,createdOutputRef);
      await this.service.db.transaction(async tx=>{
        const r=await tx.get('inference_requests',id,actor.id);if(r.status!=='PROCESSING')return;
        if(generationSubmitted){r.status='UNCERTAIN';r.failure_code='PROVIDER_CHARGE_REQUIRES_RECONCILIATION';}
        else{r.status='FAILED';r.failure_code='INFERENCE_PREFLIGHT_FAILED';await this.settle(tx,r,'0');}
        await tx.update('inference_requests',id,r);await tx.audit(actor.id,'InferenceRequestStopped',{request_id:id,status:r.status});
      });
    }
    return this.get(actor,id);
  }
  async cancel(actor:Actor,key:string,id:string){
    this.user(actor);return this.service.db.command(actor.id,key,{action:'cancelInference',id},async tx=>{
      const r=await tx.get('inference_requests',id,actor.id);ensure(r.status==='QUEUED','INFERENCE_ALREADY_STARTED',409);
      await this.settle(tx,r,'0');r.status='CANCELLED';await tx.update('inference_requests',id,r);return this.safe(r);
    });
  }
  async deleteContent(actor:Actor,key:string,id:string){
    this.user(actor);return this.service.db.command(actor.id,key,{action:'deleteInferenceContent',id},async tx=>{
      const r=await tx.get('inference_requests',id,actor.id);ensure(!['QUEUED','PROCESSING'].includes(r.status),'INFERENCE_STILL_ACTIVE',409);
      await this.removeContent(tx,r);return this.safe(r);
    });
  }
  private async removeContent(tx:Transaction,r:Document){
    if(r.content_deleted)return;
    for(const field of ['prompt_ref','output_ref'])if(r[field])await this.service.privacy.remove(r.owner_id,r[field]);
    delete r.prompt_ref;delete r.output_ref;r.content_deleted=true;await tx.update('inference_requests',r.request_id,r);
    await tx.audit(r.owner_id,'InferenceContentDeleted',{request_id:r.request_id});
  }
  async sweep(){
    return this.service.db.transaction(async tx=>{
      let changed=0;
      for(const r of await tx.list('inference_requests')){
        if(r.status==='PROCESSING'&&r.processing_deadline<=this.service.now()){
          r.status='UNCERTAIN';r.failure_code='INTERRUPTED_REQUEST_REQUIRES_RECONCILIATION';await tx.update('inference_requests',r.request_id,r);changed++;
        }
        if(r.status==='QUEUED'&&r.expires_at<=this.service.now()){
          await this.settle(tx,r,'0');r.status='CANCELLED';await tx.update('inference_requests',r.request_id,r);changed++;
        }
        if(!['QUEUED','PROCESSING'].includes(r.status)&&r.retention_expires_at<=this.service.now()&&!r.content_deleted){await this.removeContent(tx,r);changed++;}
      }
      return {changed};
    });
  }
}
