import { StagedStorage } from './staged-storage.ts';
import { canonicalHash, canonicalJson, parseMoney, uuidv7, validateUserPolicy, validateBuyerMandate } from '../../protocol/src/index.ts';
import { Database, Transaction, DomainError, ensure, wire, type Document, type TransactionTimingCollector } from '../../storage/src/index.ts';
import { postJournal, accountBalance, splitSale, reconcile, type Currency } from '../../ledger/src/index.ts';
import { buildDraftMandate, validateDraftPatch, currentDraftInput, assertUnfundedDraft } from './mandate-draft.ts';
import { assertOperationEnabled, controlState } from './operational-controls.ts';
import { similaritySketch, similarityBasisPoints } from '../../similarity/src/index.ts';
import { parseCodingSessionJsonl } from './history-import.ts';
import { duplicateImportResult, ownedVerifiedImportDuplicate, traceImportConsentHash } from './trace-import-dedup.ts';
import type { AnvilConfig, AnvilMoneyPath } from '../../chain/anvil.ts';

export interface Actor { id: string; role: 'user' | 'buyer_admin' | 'buyer_member' | 'operator_support' | 'operator_security' | 'operator_maintenance' | 'service_settlement'; buyer_id?: string }
export interface PrivacyFacade {
  verify(bundle: unknown, traceId: string, owner: string): Promise<{receipt: Document; content: Document;capture_model?:Document;model_history?:Document[]}>;
  seal(owner: string, value: unknown, objectId?: string): Promise<Document>;
  /** Internal journal adapter capability; never exposed as a request-selected storage class. */
  operatorJournalWriter?(owner:string):(value:unknown)=>Promise<Document>;
  open(owner: string, ref: Document): Promise<any>;
  remove(owner: string, ref: Document): Promise<void>;
  assess(traceId: string, content: Document, category: string, input: Document): Promise<{rights: Document; scrub: Document; content: Document; features: Document}>;
  verifyCredential(receipt: Document, owner: string): void;
  verifyOutcome(receipt: Document, owner: string, traceId: string): void;
  discloseCredential(receipt: Document): Document;
  discloseOutcome(receipt: Document): Document;
  assay(content: Document, mandate: Document, traceId: string, features: Document): Promise<Document>;
  createDemoBundle(content: Document, owner: string): unknown;
  demoCredential(owner: string): Document;
  demoOutcome(owner: string, traceId: string, security: string): Promise<Document>;
}
export interface MarketConfig {
  development: boolean;
  tokenEnabled: boolean;
  standingAuthorization: boolean;
  exclusivity: boolean;
  approvedLicenseTemplates: Record<string,string>;
  approvedCostCodes: string[];
  maxDirectCostsMinor: string;
  privateRetentionDays?: number;
  traceExplorerViewers?: string[];
  clock?: () => Date;
  anvil?: AnvilConfig;
}
const money = (value: unknown): bigint => { const amount = parseMoney(value); ensure(amount < 10n**78n,'AMOUNT_TOO_LARGE'); return amount; };
const roles = (actor: Actor, allowed: Actor['role'][]) => ensure(allowed.includes(actor.role), 'FORBIDDEN', 403);
const buyerId = (actor: Actor) => { roles(actor,['buyer_admin','buyer_member']); ensure(actor.buyer_id,'BUYER_REQUIRED'); return actor.buyer_id; };
export const releaseHash = (bundle: Document) => {
  const copy = structuredClone(bundle); delete copy.delivery.bundle_hash; return canonicalHash(copy);
};
export class ThotService {
  db: Database; privacy: PrivacyFacade; config: MarketConfig;
  readonly staged: StagedStorage;
  transactionTimings?:TransactionTimingCollector;
  constructor(db: Database, privacy: PrivacyFacade, config: MarketConfig) { this.db=db; this.privacy=privacy; this.config=config; this.staged=new StagedStorage(db,privacy); }
  captureProject?:(captureId:string,root:string)=>Promise<void>;
  moneyPath?:AnvilMoneyPath;
  thotRetention?:(tx:Transaction,traceId:string)=>Promise<number>;
  now() { return (this.config.clock?.() ?? new Date()).toISOString(); }
  future(seconds: number) { return new Date(Date.parse(this.now())+seconds*1000).toISOString(); }
  async seedDevelopment() {
    ensure(this.config.development,'DEVELOPMENT_DISABLED',403);
    await this.db.transaction(async tx => {
      if (!await tx.maybe('users','demo-user')) await tx.insert('users','demo-user','demo-user',{role:'user',revoked_receipts:[]});
      if (!await tx.maybe('users','other-user')) await tx.insert('users','other-user','other-user',{role:'user',revoked_receipts:[]});
      if (!await tx.maybe('buyers','demo-buyer')) await tx.insert('buyers','demo-buyer','demo-buyer',{approved:true,name:'Development research buyer'});
    });
  }
  async importTrace(actor: Actor, key: string, input: Document):Promise<{trace_id:string;status:string;duplicate?:boolean;provenance?:Document;rights?:Document}> {
    roles(actor,['user']);
    return this.staged.run(actor.id,key,{action:'import',input},'import',async stage => {
      const bundle = input.bundle_json ? JSON.parse(input.bundle_json) : input.bundle;
      ensure(bundle && typeof bundle==='object','BUNDLE_REQUIRED');
      const sourceHash = canonicalHash(bundle);
      let historyCommitment:string|undefined;
      const importConsentHash=traceImportConsentHash(input);
      const privateHistory=input.save_privately===true;
      ensure(input.save_privately===undefined||typeof input.save_privately==='boolean','INVALID_PRIVATE_IMPORT');
      if(privateHistory)ensure(['thot.claude-code-jsonl/1','thot.coding-session-jsonl/1'].includes(bundle.format)&&(input.rights_confirmed===undefined||input.rights_confirmed===false)&&(input.model_output_licensed===undefined||input.model_output_licensed===false),'PRIVATE_IMPORT_RELEASE_CONFLICT');
      if(['thot.claude-code-jsonl/1','thot.coding-session-jsonl/1'].includes(bundle.format)){
        historyCommitment=parseCodingSessionJsonl(bundle.text).preview.content_commitment;
        ensure(input.content_commitment===historyCommitment,'IMPORT_PREVIEW_CHANGED',409);
        ensure(privateHistory||(input.rights_confirmed===true&&typeof input.model_output_licensed==='boolean'),'IMPORT_RIGHTS_CONFIRMATION_REQUIRED');
      }
      const duplicate=async(tx:Transaction,verifiedContentHash?:string)=>{
        if(historyCommitment){
          const existing=(await tx.list('traces',actor.id)).find(t=>(t.import_content_hash??t.import_preview?.content_commitment)===historyCommitment);
          if(existing){
            ensure(!existing.deleted,'TRACE_DELETED',409);
            ensure(existing.import_consent_hash===importConsentHash,'IMPORT_CONSENT_CONFLICT',409);
            return {trace_id:existing.trace_id,status:existing.display_status,duplicate:true};
          }
        }
        const source=(await tx.list('trace_bundles',actor.id)).find(r=>r.source_bundle_hash===sourceHash);
        if(source)return duplicateImportResult(await tx.get('traces',source.trace_id,actor.id),importConsentHash);
        if(!historyCommitment&&verifiedContentHash){
          const existing=await ownedVerifiedImportDuplicate(tx,actor.id,verifiedContentHash);
          if(existing)return duplicateImportResult(existing,importConsentHash);
        }
        return undefined;
      };
      if(await this.db.transaction(tx=>duplicate(tx),'import'))return async tx=>{
        const current=await duplicate(tx);ensure(current,'STAGED_STATE_CHANGED',409);return current;
      };
      const traceId=uuidv7();
      const verified = await this.privacy.verify(bundle,traceId,actor.id);
      ensure(verified.receipt.trace_id===traceId,'PROVENANCE_BINDING');
      const verifiedContentHash=canonicalHash(verified.content);
      const category = input.category ?? 'general';
      ensure(['general','research_flow','professional_flow'].includes(category),'INVALID_CATEGORY');
      const assessment=await this.privacy.assess(traceId,verified.content,category,privateHistory?{...input,rights_confirmed:false,model_output_licensed:false}:input);
      assessment.features.provenance_tier=verified.receipt.confidence_tier;
      const sourceRef=await stage.seal(input.bundle_json ?? canonicalJson(bundle));
      const rawRef=await stage.seal(verified.content);
      const scrubRef=await stage.seal(assessment.content);
      const privateMetadataRef=await stage.seal({answer_preview:String(verified.content.turns.findLast((t:Document)=>t.role==='assistant')?.content??'').replace(/\s+/g,' ').slice(0,220)});
      return async tx=>{
        const duplicateResult=await duplicate(tx,verifiedContentHash);
        if(duplicateResult){stage.discard();return duplicateResult;}
        const bundleId=uuidv7(), provenanceId=verified.receipt.receipt_id;
        await tx.insert('trace_bundles',bundleId,actor.id,{trace_id:traceId,source_bundle_hash:sourceHash,source_bundle_format:['thot.development-bundle/1','thot.claude-code-jsonl/1','thot.coding-session-jsonl/1'].includes(bundle.format)?bundle.format:'attest-proxy-external-verifier/1',object_ref:sourceRef});
        await tx.insert('provenance_receipts',provenanceId,actor.id,{trace_id:traceId,receipt:verified.receipt});
        await tx.insert('rights_assessments',assessment.rights.assessment_id,actor.id,{trace_id:traceId,receipt:assessment.rights});
        await tx.insert('scrub_receipts',assessment.scrub.scrub_id,actor.id,{trace_id:traceId,receipt:assessment.scrub});
        await tx.insert('trace_features',traceId,actor.id,assessment.features);
        const eligible=!privateHistory&&['eligible','eligible_with_restrictions'].includes(assessment.rights.status),displayStatus=privateHistory?'PRIVATE':eligible?'AVAILABLE':'REJECTED';
        await tx.insert('traces',traceId,actor.id,{
          trace_id:traceId,category,source_bundle_hash:sourceHash,source_bundle_id:bundleId,...(verified.capture_model?{capture_model:verified.capture_model,model_history:verified.model_history??[]}: {}),
          import_consent_hash:importConsentHash,...(historyCommitment?{import_content_hash:historyCommitment}:{import_verified_content_hash:verifiedContentHash}),
          provenance_id:provenanceId,rights_id:assessment.rights.assessment_id,scrub_id:assessment.scrub.scrub_id,
          raw_ref:rawRef,scrub_ref:scrubRef,private_metadata_ref:privateMetadataRef,provenance_status:historyCommitment?'IMPORTED_UNVERIFIED':'VERIFIED',rights_status:assessment.rights.status,
          display_status:displayStatus,save_privately:privateHistory,credential_ids:[],outcome_ids:[],sale_count:0,
          deleted:false,created_at:this.now(),observed_at:verified.receipt.temporal.observed_start,observed_end:verified.receipt.temporal.observed_end??verified.receipt.temporal.observed_start,retention_expires_at:this.future((this.config.privateRetentionDays??30)*86400), normalized_hash:canonicalHash(assessment.content)
        });
        for (const event of ['TraceReceived','ProvenanceVerified','TraceSealed','RightsAssessmentCompleted','TraceFeatured']) await tx.audit(actor.id,event,{trace_id:traceId,source_hash:sourceHash});
        if(eligible)await this.enqueueMatching(tx);
        return {trace_id:traceId,status:displayStatus,provenance:verified.receipt,rights:assessment.rights};
      };
    });
  }
  async traces(actor: Actor) {
    roles(actor,['user']);
    return this.db.transaction(async tx => (await tx.list('traces',actor.id)).map(t=>this.safeTrace(t)));
  }
  safeTrace(t: Document) { return {trace_id:t.trace_id,category:t.category,status:t.display_status,provenance_status:t.provenance_status,rights_status:t.rights_status,sale_count:t.sale_count,created_at:t.created_at,deleted:t.deleted}; }
  async trace(actor: Actor,id:string) {
    roles(actor,['user']);
    return this.db.transaction(async tx => {
      const t=await tx.get('traces',id,actor.id);
      return {...this.safeTrace(t),provenance:(await tx.get('provenance_receipts',t.provenance_id,actor.id)).receipt,rights:(await tx.get('rights_assessments',t.rights_id,actor.id)).receipt};
    });
  }
  async receipts(actor: Actor,id: string) {
    roles(actor,['user']);
    return this.db.transaction(async tx => {
      const t=await tx.get('traces',id,actor.id);
      return {provenance:(await tx.get('provenance_receipts',t.provenance_id,actor.id)).receipt,
        credentials:await Promise.all(t.credential_ids.map(async (x:string)=>(await tx.get('credential_receipts',x,actor.id)).receipt)),
        outcomes:await Promise.all(t.outcome_ids.map(async (x:string)=>(await tx.get('outcome_receipts',x,actor.id)).receipt)),
        scrub:(await tx.get('scrub_receipts',t.scrub_id,actor.id)).receipt};
    });
  }
  async similarity(actor:Actor,id:string) {
    roles(actor,['user']);
    return this.db.transaction(async tx=>{
      const target=await tx.get('traces',id,actor.id);
      const eligible=(t:Document)=>!t.deleted&&t.retention_expires_at>this.now()&&['eligible','eligible_with_restrictions'].includes(t.rights_status);
      ensure(eligible(target),'TRACE_INELIGIBLE',410);
      const sketch=similaritySketch(await this.privacy.open(actor.id,target.scrub_ref));
      const base={schema_version:'thot.similarity-review/1',trace_id:id,threshold_bps:8000,review_only:true,notice:'Compares only your own currently eligible scrubbed traces. Similarity is an advisory text-overlap signal, not proof of duplicate origin, plagiarism or fraud. It never changes licensing or rewards.'};
      if(!sketch)return {...base,available:false,reason:'TEXT_TOO_SHORT_OR_OVER_REVIEW_LIMIT',matches:[],compared:0,incomplete:true};
      const records=(await tx.list('traces',actor.id)).filter(t=>t.trace_id!==id&&eligible(t)).reverse();
      let compared=0,unavailable=0;const matches:Document[]=[];
      for(const candidate of records.slice(0,100)){
        let other;try{other=similaritySketch(await this.privacy.open(actor.id,candidate.scrub_ref));}catch{unavailable++;continue;}
        if(!other){unavailable++;continue;}compared++;
        const score=similarityBasisPoints(sketch,other);
        if(score>=8000)matches.push({trace_id:candidate.trace_id,similarity_bps:score});
      }
      matches.sort((a,b)=>b.similarity_bps-a.similarity_bps||a.trace_id.localeCompare(b.trace_id));
      return {...base,available:true,matches,compared,unavailable,incomplete:records.length>100||unavailable>0};
    });
  }
  async createPolicy(actor: Actor,key:string,input:Document) {
    roles(actor,['user']);
    return this.db.command(actor.id,key,{action:'policy',input},async tx=>{
      const prior=await tx.list('user_policies',actor.id);
      const p={...input,schema_version:'trace.user-policy/1',policy_id:uuidv7(),owner_user_id:actor.id,version:Math.max(0,...prior.map(p=>p.version))+1};
      validateUserPolicy(p);
      ensure(p.mode!=='standing_authorization'||this.config.standingAuthorization,'STANDING_AUTHORIZATION_DISABLED');
      ensure(!p.license_defaults.exclusive||this.config.exclusivity,'EXCLUSIVITY_DISABLED');
      ensure(!p.evidence_disclosure.identity_disclosure,'IDENTITY_DISCLOSURE_DISABLED');
      await tx.insert('user_policies',p.policy_id,actor.id,p);
      await tx.audit(actor.id,'UserPolicyCreated',{policy_id:p.policy_id,version:p.version});
      await this.enqueueMatching(tx);
      return p;
    });
  }
  async currentPolicy(tx:Transaction,owner:string):Promise<Document|undefined> {
    return (await tx.list('user_policies',owner)).filter(p=>p.effective_at<=this.now()).sort((a,b)=>b.version-a.version)[0];
  }
  async linkEvidence(actor:Actor,key:string,traceId:string,kind:'credential'|'outcome',input:Document) {
    roles(actor,['user']);
    return this.db.command(actor.id,key,{action:'link',traceId,kind,input},async tx=>{
      const trace=await tx.get('traces',traceId,actor.id); ensure(!trace.deleted,'TRACE_DELETED');
      const receipt=input.receipt;
      ensure(receipt && typeof receipt==='object','SIGNED_RECEIPT_REQUIRED');
      if(kind==='credential')this.privacy.verifyCredential(receipt,actor.id);else this.privacy.verifyOutcome(receipt,actor.id,traceId);
      const table=kind==='credential'?'credential_receipts':'outcome_receipts';
      const old=await tx.maybe(table,receipt.receipt_id);
      if(old)ensure(old.owner_id===actor.id&&canonicalHash(old.receipt)===canonicalHash(receipt),'RECEIPT_CONFLICT',409);
      else await tx.insert(table,receipt.receipt_id,actor.id,{receipt});
      const field=kind==='credential'?'credential_ids':'outcome_ids';
      trace[field]=[...new Set([...trace[field],receipt.receipt_id])];
      await tx.update('traces',traceId,trace);
      await tx.audit(actor.id,kind==='credential'?'CredentialReceiptIssued':'OutcomeReceiptIssued',{trace_id:traceId,receipt_id:receipt.receipt_id});
      await this.enqueueMatching(tx);
      return {receipt_id:receipt.receipt_id,linked:true};
    });
  }
  async revokeReceipt(actor:Actor,key:string,receiptId:string) {
    roles(actor,['user']);
    return this.db.command(actor.id,key,{action:'revoke',receiptId},async tx=>{
      const c=await tx.maybe('credential_receipts',receiptId), o=await tx.maybe('outcome_receipts',receiptId);
      ensure((c??o)?.owner_id===actor.id,'NOT_FOUND',404);
      const user=await tx.get('users',actor.id,actor.id);
      user.revoked_receipts=[...new Set([...(user.revoked_receipts??[]),receiptId])];
      await tx.update('users',actor.id,user);await tx.audit(actor.id,'ReceiptRevoked',{receipt_id:receiptId});
      return {receipt_id:receiptId,revoked:true};
    });
  }
  async createMandate(actor:Actor,key:string,input:Document) {
    const buyer=buyerId(actor);roles(actor,['buyer_admin']);
    return this.db.command(actor.id,key,{action:'mandate',input},async tx=>{
      ensure((await tx.get('buyers',buyer,buyer)).approved,'BUYER_NOT_APPROVED',403);
      const id=uuidv7();
      const validated=buildDraftMandate(input,{mandateId:id,buyerId:buyer},this.config,this.now());
      const doc:Document={...validated,spent_minor:'0',units_sold:0,draft_revision:1,created_at:this.now()};
      await tx.insert('mandates',id,buyer,doc);await tx.audit(buyer,'MandateCreated',{mandate_id:id});
      return doc;
    });
  }
  async editMandate(actor:Actor,key:string,id:string,input:Document) {
    const buyer=buyerId(actor); roles(actor,['buyer_admin']);
    return this.db.command(actor.id,key,{action:'editMandate',id,input},async tx=>{
      const m=await tx.get('mandates',id,buyer);
      ensure((await tx.get('buyers',buyer,buyer)).approved,'BUYER_NOT_APPROVED',403);
      await assertUnfundedDraft(tx,m);validateDraftPatch(input);
      const revision=m.draft_revision??1;
      ensure(input.expected_revision===undefined||input.expected_revision===revision,'MANDATE_REVISION_CONFLICT',409);
      const {expected_revision,...patch}=input;
      const before=currentDraftInput(m);
      const validated=buildDraftMandate({...before,...patch},{mandateId:id,buyerId:buyer},this.config,this.now());
      const {id:rowId,owner_id:rowOwner,...stored}=m;
      const edited:Document={...stored,...validated,draft_revision:revision+1,updated_at:this.now()};
      await tx.update('mandates',id,edited);
      await tx.audit(buyer,'MandateEdited',{mandate_id:id,draft_revision:edited.draft_revision,previous_commitment:canonicalHash(before),updated_commitment:canonicalHash(currentDraftInput(edited))});
      return edited;
    });
  }
  async fundMandate(actor:Actor,key:string,id:string,input:Document) {
    if(this.moneyPath)return this.moneyPath.fund(actor,key,id,input);
    const buyer=buyerId(actor);roles(actor,['buyer_admin']);
    return this.db.command(actor.id,key,{action:'fund',id,input},async tx=>{
      const m=await tx.get('mandates',id,buyer);
      ensure((await tx.get('buyers',buyer,buyer)).approved,'BUYER_NOT_APPROVED',403);
      ensure(input.expected_revision===undefined||input.expected_revision===(m.draft_revision??1),'MANDATE_REVISION_CONFLICT',409);
      ensure(['draft','pending_funding','funded'].includes(m.status),'MANDATE_STATE',409);
      if(!this.config.development) {
        m.status='pending_funding';await tx.update('mandates',id,m);
        return {mandate_id:id,status:m.status,required_minor:m.economics.total_budget_minor,currency:m.economics.currency,message:'Funding must be independently confirmed by the settlement service.'};
      }
      await this.recordFunding(tx,m,'development:'+id,money(m.economics.total_budget_minor));
      return {mandate_id:id,status:'funded',simulated:true,funded_minor:m.economics.total_budget_minor};
    });
  }
  async recordFunding(tx:Transaction,m:Document,reference:string,amount:bigint) {
    ensure(reference.length>=8&&reference.length<=200,'INVALID_FUNDING_REFERENCE');
    const prior=(await tx.list('mandate_funding')).find(f=>f.funding_reference===reference);
    if(prior){ensure(prior.mandate_id===m.mandate_id&&money(prior.amount_minor)===amount,'FUNDING_REPLAY_CONFLICT',409);return;}
    ensure(amount>0n&&money(m.funding.funded_minor)+amount<=money(m.economics.total_budget_minor),'FUNDING_LIMIT');
    await tx.insert('mandate_funding',uuidv7(),m.buyer_id,{mandate_id:m.mandate_id,funding_reference:reference,amount_minor:amount.toString(),simulated:this.config.development&&!this.moneyPath,test_assets:!!this.moneyPath});
    await postJournal(tx,'fund:'+reference,m.economics.currency,[{account:'ASSET:cash',owner:'network',amount},{account:'LIABILITY:buyer_escrow',owner:m.mandate_id,amount:-amount}]);
    m.funding.funded_minor=(money(m.funding.funded_minor)+amount).toString();m.status='funded';
    await tx.update('mandates',m.mandate_id,m);await tx.audit(m.buyer_id,'MandateFunded',{mandate_id:m.mandate_id});
  }
  async confirmFunding(actor:Actor,key:string,id:string,input:Document) {
    ensure(!this.moneyPath,'ANVIL_RECEIPT_CONFIRMATION_REQUIRED');
    roles(actor,['service_settlement']);
    return this.db.command(actor.id,key,{action:'confirmFunding',id,input},async tx=>{
      const m=await tx.get('mandates',id);await this.recordFunding(tx,m,input.funding_reference,money(input.amount_minor));return {mandate_id:id,funded_minor:m.funding.funded_minor};
    });
  }
  async activateMandate(actor:Actor,key:string,id:string) {
    const buyer=buyerId(actor);roles(actor,['buyer_admin']);
    return this.db.command(actor.id,key,{action:'activate',id},async tx=>{
      await assertOperationEnabled(tx,'sales');
      const m=await tx.get('mandates',id,buyer);
      ensure(['funded','paused','active'].includes(m.status)&&money(m.funding.funded_minor)>=money(m.economics.unit_price_minor),'MANDATE_UNFUNDED');
      ensure(m.expires_at>this.now(),'MANDATE_EXPIRED');
      ensure((await tx.get('buyers',buyer,buyer)).approved,'BUYER_NOT_APPROVED',403);
      m.status='active';await tx.update('mandates',id,m);await tx.audit(buyer,'MandateActivated',{mandate_id:id});
      await tx.enqueue(buyer,'MatchMandate',{mandate_id:id});return {mandate_id:id,status:'active'};
    });
  }
  policyAllows(policy:Document|undefined,m:Document,t:Document):boolean {
    if(!policy||(policy.expires_at&&policy.expires_at<=this.now())||policy.effective_at>this.now())return false;
    if(!policy.allowed_categories.includes(t.category)||policy.prohibited_categories.includes(t.category))return false;
    if(policy.allowed_buyers!==undefined&&!policy.allowed_buyers.includes(m.buyer_id))return false;
    if(policy.prohibited_buyers?.includes(m.buyer_id))return false;
    if(!policy.allowed_purposes.includes(m.license.purpose)||policy.prohibited_purposes.includes(m.license.purpose))return false;
    if(!policy.evidence_disclosure.trace_body)return false;
    if(m.license.model_training&&!policy.license_defaults.model_training)return false;
    if(m.license.onward_transfer&&!policy.license_defaults.onward_transfer)return false;
    if(m.license.exclusive&&!policy.license_defaults.exclusive)return false;
    if(policy.license_defaults.max_retention_days!==undefined&&m.license.retention_days>policy.license_defaults.max_retention_days)return false;
    return true;
  }
  async eligibleEvidence(tx:Transaction,t:Document,m:Document,p:Document) {
    const user=await tx.get('users',t.owner_id,t.owner_id);
    const revoked=new Set(user.revoked_receipts??[]);
    const credentials:Document[]=[],outcomes:Document[]=[];
    for(const id of t.credential_ids) {
      if(revoked.has(id))continue;
      const c=(await tx.get('credential_receipts',id,t.owner_id)).receipt;
      try{this.privacy.verifyCredential(c,t.owner_id);if(c.valid_until&&c.valid_until<=this.now())continue;}catch{continue;}
      if(p.evidence_disclosure.credential_predicate_types.includes(c.predicate_type))credentials.push(c);
    }
    for(const id of t.outcome_ids) {
      if(revoked.has(id))continue;
      const o=(await tx.get('outcome_receipts',id,t.owner_id)).receipt;
      try{this.privacy.verifyOutcome(o,t.owner_id,t.trace_id);}catch{continue;}
      if(p.evidence_disclosure.outcome_predicate_types.includes(o.predicate.type))outcomes.push(o);
    }
    for(const required of m.criteria.credential_predicates??[])ensure(credentials.some(c=>c.predicate_type===required.type&&required.accepted_values.includes(c.predicate_value)&&
      (required.freshness_days===undefined||Date.parse(c.verified_at)>=Date.parse(this.now())-required.freshness_days*86400000)),'CREDENTIAL_FILTER');
    for(const required of m.criteria.outcome_predicates??[])ensure(outcomes.some(o=>o.predicate.type===required.type&&
      (!required.security_ids?.length||required.security_ids.includes(o.predicate.security_id))&&
      // evidence_time is attestation time, not the private trade timestamp. A temporal mandate
      // needs a separately consented, signed observation window after the trace ends.
      (required.max_lag_days===undefined||(o.predicate.window_start&&o.predicate.window_end&&
        Date.parse(o.predicate.window_start)>=Date.parse(t.observed_end)&&
        Date.parse(o.predicate.window_end)<=Date.parse(t.observed_end)+required.max_lag_days*86400000))),'OUTCOME_FILTER');
    return {credentials,outcomes};
  }
  async matchMandate(tx:Transaction,id:string) {
    if((await controlState(tx)).sales)return;
    const m=await tx.get('mandates',id);
    if(m.status!=='active'||m.expires_at<=this.now())return;
    if(!(await tx.get('buyers',m.buyer_id,m.buyer_id)).approved)return;
    for(const t of await tx.list('traces')) {
      if(t.deleted||t.thot_listing_only||t.retention_expires_at<=this.now()||!['eligible','eligible_with_restrictions'].includes(t.rights_status))continue;
      const policy=await this.currentPolicy(tx,t.owner_id);
      if(!this.policyAllows(policy,m,t))continue;
      const provenance=(await tx.get('provenance_receipts',t.provenance_id,t.owner_id)).receipt;
      const features=await tx.get('trace_features',t.trace_id,t.owner_id);
      if(!m.criteria.provenance_tiers.includes(provenance.confidence_tier)||!m.criteria.rights_required.includes(t.rights_status))continue;
      if(m.criteria.workflow_types.length&&!m.criteria.workflow_types.includes(features.workflow_type))continue;
      if(m.criteria.date_range&&(!t.observed_at||t.observed_at<m.criteria.date_range.start||t.observed_at>m.criteria.date_range.end))continue;
      const existing=(await tx.list('mandate_candidates',t.owner_id)).find(c=>c.mandate_id===id&&c.trace_id===t.trace_id&&!['SUPERSEDED','DELETED'].includes(c.status));
      if(existing) {
        if(existing.status!=='USER_AUTH_PENDING'||existing.policy_id===policy!.policy_id)continue;
        existing.status='SUPERSEDED';await tx.update('mandate_candidates',existing.candidate_id,existing);
        await this.privacy.remove(t.owner_id,existing.release_ref);
        await tx.audit(t.owner_id,'CandidateSuperseded',{candidate_id:existing.candidate_id});
      }
      let evidence;try{evidence=await this.eligibleEvidence(tx,t,m,policy!);}catch{continue;}
      const scrubbed=await this.privacy.open(t.owner_id,t.scrub_ref);
      const assay=await this.privacy.assay(scrubbed,m,t.trace_id,features);
      await tx.insert('assay_receipts',assay.assay_receipt_id,t.owner_id,{receipt:assay});
      await tx.audit(t.owner_id,'AssayCompleted',{trace_id:t.trace_id,mandate_id:id,result:assay.result});
      if(assay.result!=='accepted')continue;
      const cid=uuidv7(),lid=uuidv7();
      const licenseTerms={...m.license,template_id:m.license_template_id,text:this.config.approvedLicenseTemplates[m.license_template_id]};
      const termsHash=canonicalHash(licenseTerms);
      const bundle:Document={schema_version:'trace.release/1',license_id:lid,
        trace:{scrubbed_content:scrubbed,content_hash:canonicalHash(scrubbed)},
        provenance,credentials:evidence.credentials.map(c=>this.privacy.discloseCredential(c)),
        outcomes:evidence.outcomes.map(o=>this.privacy.discloseOutcome(o)),assay,
        license:{terms_hash:termsHash,human_readable_terms:licenseTerms.text,terms:licenseTerms},
        delivery:{generated_at:this.now(),bundle_hash:''}};
      bundle.delivery.bundle_hash=releaseHash(bundle);
      const releaseRef=await this.privacy.seal(t.owner_id,bundle);
      const candidate={candidate_id:cid,license_id:lid,mandate_id:id,trace_id:t.trace_id,buyer_id:m.buyer_id,
        status:'USER_AUTH_PENDING',release_hash:bundle.delivery.bundle_hash,license_hash:termsHash,
        release_ref:releaseRef,policy_id:policy!.policy_id,policy_version:policy!.version,
        credential_receipt_ids:evidence.credentials.map(c=>c.receipt_id),outcome_receipt_ids:evidence.outcomes.map(o=>o.receipt_id),
        currency:m.economics.currency,expected_gross_minor:m.economics.unit_price_minor,expected_direct_costs_max_minor:this.config.maxDirectCostsMinor,
        expires_at:m.expires_at,created_at:this.now()};
      await tx.insert('mandate_candidates',cid,t.owner_id,candidate);
      await tx.audit(t.owner_id,'CandidateDiscovered',{candidate_id:cid,mandate_id:id,trace_id:t.trace_id});
      // Standing policies still create a concrete, version-bound authorization.
      if(policy!.mode==='standing_authorization'&&this.config.standingAuthorization&&policy!.payout_preference!=='ask_each_sale') {
        await this.authorizeIn(tx,{id:t.owner_id,role:'user'},candidate,{
          release_artifact_hash:candidate.release_hash,license_hash:candidate.license_hash,
          expected_gross_minor:candidate.expected_gross_minor,expected_direct_costs_max_minor:candidate.expected_direct_costs_max_minor,
          credential_receipt_ids:candidate.credential_receipt_ids,outcome_receipt_ids:candidate.outcome_receipt_ids,
          payout_preference:policy!.payout_preference
        },true);
      }
    }
  }
  async enqueueMatching(tx:Transaction) {
    for(const m of await tx.list('mandates'))if(m.status==='active'&&m.expires_at>this.now()) {
      const queued=(await tx.sql.query("SELECT id FROM outbox_events WHERE event_type='MatchMandate' AND status='pending' AND payload->>'mandate_id'=$1 LIMIT 1",[m.mandate_id])).rows[0];
      if(!queued)await tx.enqueue(m.buyer_id,'MatchMandate',{mandate_id:m.mandate_id});
    }
  }
  async deleteTrace(actor:Actor,key:string,id:string) {
    roles(actor,['user']);
    return this.db.command(actor.id,key,{action:'deleteTrace',id},async tx=>{
      const t=await tx.get('traces',id,actor.id);
      if(!t.deleted) {
        t.deleted=true;t.display_status='DELETED';await tx.update('traces',id,t);
        await tx.enqueue(actor.id,'DeleteTraceObjects',{trace_id:id});
        await tx.audit(actor.id,'TraceDeletionRequested',{trace_id:id});
      }
      return {trace_id:id,status:'DELETED',private_object_deletion:'queued',existing_licenses:'Unchanged; no buyer unlearning guarantee.'};
    });
  }
  async deleteTraceObjects(tx:Transaction,id:string) {
    const t=await tx.get('traces',id);ensure(t.deleted,'DELETION_NOT_AUTHORIZED');
    for(const ref of [t.raw_ref,t.scrub_ref,t.private_metadata_ref,t.context_ref,t.personal_ref,...(t.projection_refs??[])].filter(Boolean))await this.privacy.remove(t.owner_id,ref);
    for(const bundle of await tx.list('trace_bundles',t.owner_id))if(bundle.trace_id===id)await this.privacy.remove(t.owner_id,bundle.object_ref);
    for(const c of await tx.list('mandate_candidates',t.owner_id))if(c.trace_id===id&&c.status!=='LICENSED') {
      await this.privacy.remove(t.owner_id,c.release_ref);c.status='DELETED';await tx.update('mandate_candidates',c.candidate_id,c);
    }
    if(t.agent_capture_id){const capture=await tx.get('agent_captures',t.agent_capture_id,t.owner_id);for(const part of Object.values(capture.parts??{}) as Document[])await this.privacy.remove(t.owner_id,part.object_ref);capture.parts={};await tx.update('agent_captures',t.agent_capture_id,capture);}
    const retained=await this.thotRetention?.(tx,id)??0;
    t.source_private_objects_deleted=true;t.private_objects_deleted=retained===0;t.thot_release_copies_retained=retained;await tx.update('traces',id,t);
    await tx.audit(t.owner_id,'PrivateObjectsDeleted',{trace_id:id});
  }
  async sweepRetention() {
    return this.db.transaction(async tx=>{
      let queued=0;
      for(const c of await tx.list('agent_captures'))if(c.status==='AWAITING_UPLOAD'&&c.expires_at<=this.now()){c.status='EXPIRED';await tx.update('agent_captures',c.capture_id,c);if(c.result?.trace_id){const t=await tx.get('traces',c.result.trace_id,c.owner_id);if(!t.deleted){t.capture_state='INTERRUPTED';await tx.update('traces',t.trace_id,t);}}else await tx.enqueue(c.owner_id,'DeleteExpiredCapture',{capture_id:c.capture_id});queued++;}
      for(const t of await tx.list('traces'))if(!t.deleted&&t.retention_expires_at<=this.now()) {
        t.deleted=true;t.display_status='EXPIRED';await tx.update('traces',t.trace_id,t);
        await tx.enqueue(t.owner_id,'DeleteTraceObjects',{trace_id:t.trace_id});queued++;
      }
      for(const c of await tx.list('mandate_candidates'))if(c.status==='USER_AUTH_PENDING'&&c.expires_at<=this.now()) {
        c.status='EXPIRED';await tx.update('mandate_candidates',c.candidate_id,c);
        await tx.enqueue(c.owner_id,'DeleteExpiredCandidate',{candidate_id:c.candidate_id});queued++;
      }
      for(const l of await tx.list('licenses'))if(l.retention_expires_at<=this.now()) {
        const d=await tx.get('deliveries',l.license_id,l.buyer_id);
        if(d.status!=='EXPIRED') {
          d.status='EXPIRED';await tx.update('deliveries',l.license_id,d);
          await tx.enqueue(l.owner_user_id,'DeleteExpiredRelease',{license_id:l.license_id});queued++;
        }
      }
      return {queued};
    });
  }
  async deleteExpiredCapture(tx:Transaction,id:string){const c=await tx.get('agent_captures',id);ensure(c.status==='EXPIRED'&&c.expires_at<=this.now(),'CAPTURE_RETENTION_ACTIVE');for(const part of Object.values(c.parts??{}) as Document[])await this.privacy.remove(c.owner_id,part.object_ref);c.parts={};await tx.update('agent_captures',id,c);}
  async deleteExpiredRelease(tx:Transaction,id:string,candidateOnly=false) {
    if(candidateOnly) {
      const c=await tx.get('mandate_candidates',id);ensure(c.expires_at<=this.now()&&c.status!=='LICENSED','RELEASE_RETENTION_ACTIVE');
      await this.privacy.remove(c.owner_id,c.release_ref);
      await tx.audit(c.owner_id,'CandidateReleaseDeleted',{candidate_id:id});
    } else {
      const l=await tx.get('licenses',id);ensure(l.retention_expires_at<=this.now(),'RELEASE_RETENTION_ACTIVE');
      const artifact=await tx.get('release_artifacts',id,l.owner_user_id);await this.privacy.remove(l.owner_user_id,artifact.object_ref);
      if(!await tx.maybe('trace_objects','expired-release:'+id))await tx.insert('trace_objects','expired-release:'+id,l.owner_user_id,{kind:'release_deletion',license_id:id,deleted_at:this.now()});
      await tx.audit(l.owner_user_id,'LicensedReleaseDeleted',{license_id:id});
    }
  }
  async candidates(actor:Actor) {
    roles(actor,['user']);
    return this.db.transaction(async tx=>(await tx.list('mandate_candidates',actor.id)).map(c=>({
      candidate_id:c.id,trace_id:c.trace_id,mandate_id:c.mandate_id,buyer_id:c.buyer_id,status:c.status,license_id:c.license_id,
      currency:c.currency,price_minor:c.expected_gross_minor,release_hash:c.release_hash,expires_at:c.expires_at
    })));
  }
  async preview(actor:Actor,id:string) {
    roles(actor,['user']);
    return this.db.transaction(async tx=>{
      const c=await tx.get('mandate_candidates',id,actor.id);
      const t=await tx.get('traces',c.trace_id,actor.id);
      ensure(!t.deleted&&t.retention_expires_at>this.now(),'TRACE_DELETED_OR_EXPIRED',410);
      ensure(['USER_AUTH_PENDING','LICENSED'].includes(c.status),'CANDIDATE_UNAVAILABLE',409);
      if(c.status==='USER_AUTH_PENDING')ensure((await this.currentPolicy(tx,actor.id))?.policy_id===c.policy_id,'POLICY_CHANGED',409);
      ensure(c.expires_at>this.now(),'CANDIDATE_EXPIRED');
      return {candidate_id:c.id,mandate_id:c.mandate_id,buyer_id:c.buyer_id,
        release_artifact_hash:c.release_hash,license_hash:c.license_hash,
        expected_gross_minor:c.expected_gross_minor,expected_direct_costs_max_minor:c.expected_direct_costs_max_minor,
        credential_receipt_ids:c.credential_receipt_ids,outcome_receipt_ids:c.outcome_receipt_ids,
        release:await this.privacy.open(actor.id,c.release_ref)};
    });
  }
  async authorize(actor:Actor,key:string,input:Document) {
    roles(actor,['user']);
    return this.db.command(actor.id,key,{action:'authorize',input},async tx=>{
      const c=await tx.get('mandate_candidates',input.candidate_id,actor.id);
      return this.authorizeIn(tx,actor,c,input,false);
    });
  }
  async authorizeIn(tx:Transaction,actor:Actor,c:Document,input:Document,standing:boolean) {
    await assertOperationEnabled(tx,'sales');
    ensure(c.status==='USER_AUTH_PENDING','CANDIDATE_ALREADY_AUTHORIZED',409);
    ensure(c.expires_at>this.now(),'AUTHORIZATION_EXPIRED');
    ensure(input.release_artifact_hash===c.release_hash&&input.license_hash===c.license_hash,'AUTHORIZATION_HASH_MISMATCH');
    ensure(input.expected_gross_minor===c.expected_gross_minor&&input.expected_direct_costs_max_minor===c.expected_direct_costs_max_minor,'AUTHORIZATION_PRICE_MISMATCH');
    ensure(canonicalHash(input.credential_receipt_ids)===canonicalHash(c.credential_receipt_ids)&&canonicalHash(input.outcome_receipt_ids)===canonicalHash(c.outcome_receipt_ids),'AUTHORIZATION_SCOPE_MISMATCH');
    ensure(['inference_credit','token'].includes(input.payout_preference),'INVALID_DISPOSITION');
    ensure(input.payout_preference!=='token'||this.config.tokenEnabled,'TOKEN_DISABLED');
    const p=await this.currentPolicy(tx,actor.id);
    ensure(p?.policy_id===c.policy_id&&p?.version===c.policy_version,'POLICY_CHANGED');
    const t=await tx.get('traces',c.trace_id,actor.id),m=await tx.get('mandates',c.mandate_id);
    ensure(this.policyAllows(p,m,t),'POLICY_DENIED');
    const anvilApproval=this.moneyPath?await this.moneyPath.validateApproval(tx,actor,c,input):undefined;
    const auth={schema_version:'trace.sale-auth/1',authorization_id:uuidv7(),owner_user_id:actor.id,trace_id:c.trace_id,mandate_id:c.mandate_id,
      release_artifact_hash:c.release_hash,credential_receipt_ids:c.credential_receipt_ids,outcome_receipt_ids:c.outcome_receipt_ids,
      license_hash:c.license_hash,expected_gross_minor:c.expected_gross_minor,expected_direct_costs_max_minor:c.expected_direct_costs_max_minor,
      payout_preference:input.payout_preference,authorized_at:this.now(),expires_at:c.expires_at,
      auth_method:'account_session',auth_evidence:canonicalHash({actor:actor.id,policy_id:c.policy_id,standing}),
      policy_id:c.policy_id,policy_version:c.policy_version,...(anvilApproval?{anvil_approval:anvilApproval}:{})};
    await tx.insert('sale_authorizations',auth.authorization_id,actor.id,auth);
    c.status='AUTHORIZED';c.authorization_id=auth.authorization_id;await tx.update('mandate_candidates',c.id??c.candidate_id,c);
    await tx.audit(actor.id,'SaleAuthorizationCreated',{authorization_id:auth.authorization_id,release_hash:c.release_hash});
    await this.finalizeCandidate(tx,c);
    return {authorization_id:auth.authorization_id,license_id:c.license_id,status:this.moneyPath?'PAYMENT_PENDING':'LICENSED'};
  }
  async finalizeCandidate(tx:Transaction,c:Document) {
    const t=await tx.get('traces',c.trace_id,c.owner_id??(await tx.get('sale_authorizations',c.authorization_id)).owner_user_id);
    const m=await tx.get('mandates',c.mandate_id),auth=await tx.get('sale_authorizations',c.authorization_id,t.owner_id);
    ensure((await tx.get('buyers',m.buyer_id,m.buyer_id)).approved,'BUYER_NOT_APPROVED',403);
    ensure(!t.deleted&&t.retention_expires_at>this.now()&&['eligible','eligible_with_restrictions'].includes(t.rights_status),'TRACE_INELIGIBLE');
    ensure(m.status==='active'&&m.expires_at>this.now()&&auth.expires_at>this.now(),'SALE_EXPIRED_OR_PAUSED');
    const policy=await this.currentPolicy(tx,t.owner_id);
    ensure(policy?.policy_id===c.policy_id&&this.policyAllows(policy,m,t),'POLICY_CHANGED');
    const evidence=await this.eligibleEvidence(tx,t,m,policy!);
    ensure(c.credential_receipt_ids.every((id:string)=>evidence.credentials.some(r=>r.receipt_id===id))&&c.outcome_receipt_ids.every((id:string)=>evidence.outcomes.some(r=>r.receipt_id===id)),'EVIDENCE_INVALIDATED');
    const previous=(await tx.list('licenses')).filter(l=>l.trace_id===t.trace_id);
    ensure(!previous.some(l=>l.exclusive)&&(!m.license.exclusive||previous.length===0),'EXCLUSIVE_LOCK',409);
    const price=money(m.economics.unit_price_minor);
    ensure(m.units_sold<m.economics.max_units&&money(m.funding.funded_minor)-money(m.spent_minor)>=price,'BUDGET_EXHAUSTED',409);
    ensure(-await accountBalance(tx,m.economics.currency,m.mandate_id,'LIABILITY:buyer_escrow')>=price,'FUNDING_MISMATCH');
    const bundle=await this.privacy.open(t.owner_id,c.release_ref);
    ensure(releaseHash(bundle)===auth.release_artifact_hash&&bundle.license.terms_hash===auth.license_hash,'RELEASE_TAMPERED');
    const license={schema_version:'trace.license/1',license_id:c.license_id,candidate_id:c.id??c.candidate_id,
      owner_user_id:t.owner_id,trace_id:t.trace_id,mandate_id:m.mandate_id,buyer_id:m.buyer_id,release_artifact_hash:c.release_hash,license_terms_hash:c.license_hash,
      credential_receipt_ids:c.credential_receipt_ids,outcome_receipt_ids:c.outcome_receipt_ids,price_minor:price.toString(),currency:m.economics.currency,
      exclusive:m.license.exclusive,authorization_id:auth.authorization_id,finalized_at:this.now(),retention_expires_at:this.future(m.license.retention_days*86400)};
    await tx.insert('licenses',c.license_id,t.owner_id,license);
    await tx.insert('release_artifacts',c.license_id,t.owner_id,{object_ref:c.release_ref,release_hash:c.release_hash});
    await tx.insert('deliveries',c.license_id,m.buyer_id,{license_id:c.license_id,status:this.moneyPath?'PAYMENT_PENDING':'AVAILABLE',retrieval_count:0});
    m.units_sold++;m.spent_minor=(money(m.spent_minor)+price).toString();
    if(m.units_sold>=m.economics.max_units||money(m.funding.funded_minor)-money(m.spent_minor)<price)m.status='exhausted';
    await tx.update('mandates',m.mandate_id,m);
    t.sale_count++;t.display_status='LICENSED';await tx.update('traces',t.trace_id,t);
    c.status='LICENSED';await tx.update('mandate_candidates',c.id??c.candidate_id,c);
    await tx.audit(t.owner_id,'LicenseFinalized',{license_id:c.license_id,release_hash:c.release_hash});
    if(this.moneyPath)await this.moneyPath.enqueue(tx,license,auth);
    else await tx.enqueue(t.owner_id,'SettleLicense',{license_id:c.license_id});
  }
  async delivery(actor:Actor,id:string) {
    const buyer=buyerId(actor);
    if(this.moneyPath)await this.moneyPath.verifyDelivery(actor,id);
    return this.db.transaction(async tx=>{
      await assertOperationEnabled(tx,'deliveries');
      ensure((await tx.get('buyers',buyer,buyer)).approved,'BUYER_NOT_APPROVED',403);
      const d=await tx.get('deliveries',id,buyer),l=await tx.get('licenses',id);
      if(this.moneyPath)await this.moneyPath.assertPaid(tx,id);
      ensure(['AVAILABLE','DELIVERED'].includes(d.status),'DELIVERY_UNAVAILABLE',410);
      ensure(l.buyer_id===buyer,'NOT_FOUND',404);ensure(l.retention_expires_at>this.now(),'DELIVERY_EXPIRED',410);
      const artifact=await tx.get('release_artifacts',id,l.owner_user_id);
      const bundle=await this.privacy.open(l.owner_user_id,artifact.object_ref);
      ensure(releaseHash(bundle)===l.release_artifact_hash,'RELEASE_TAMPERED');
      d.retrieval_count++;d.status='DELIVERED';await tx.update('deliveries',id,d);
      await tx.audit(buyer,'DeliveryCompleted',{license_id:id,release_hash:l.release_artifact_hash});
      return bundle;
    });
  }
  async settleLicense(tx:Transaction,id:string,chainReceipt?:Document) {
    ensure(!this.moneyPath||chainReceipt?.approval_hash,'CHAIN_RECEIPT_REQUIRED');
    if((await tx.list('sale_settlements')).some(s=>s.license_id===id))return;
    const l=await tx.get('licenses',id),auth=await tx.get('sale_authorizations',l.authorization_id,l.owner_user_id);
    const split=splitSale(money(l.price_minor),[],this.config.approvedCostCodes,money(auth.expected_direct_costs_max_minor));
    const sid=uuidv7();
    const settlement={schema_version:'trace.settlement/1',settlement_id:sid,license_id:id,...split,contributor_disposition:chainReceipt?'token':'pending',created_at:this.now(),...(chainReceipt?{chain_receipt:chainReceipt}:{})};
    await tx.sql.query('INSERT INTO sale_settlements(id,owner_id,license_id,gross,direct_costs,contributor,burn,operator,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [sid,l.owner_user_id,id,split.gross_minor.toString(),split.direct_costs_minor.toString(),split.contributor_minor.toString(),split.burn_minor.toString(),split.operator_minor.toString(),canonicalJson(settlement)]);
    await postJournal(tx,'sale:'+id,l.currency,[
      {account:'LIABILITY:buyer_escrow',owner:l.mandate_id,amount:split.gross_minor},
      {account:'LIABILITY:contributor_unallocated',owner:sid,amount:-split.contributor_minor},
      {account:'LIABILITY:burn_pending',owner:sid,amount:-split.burn_minor},
      {account:'REVENUE:operator_allocation',owner:'network',amount:-split.operator_minor}
    ]);
    const eid=uuidv7();
    const entitlement={entitlement_id:eid,settlement_id:sid,license_id:id,currency:l.currency,amount_minor:split.contributor_minor.toString(),available_minor:chainReceipt?'0':split.contributor_minor.toString(),status:chainReceipt?'TOKEN_WITHDRAWN':'AVAILABLE',disposition:chainReceipt?'token':'pending',created_at:this.now(),...(chainReceipt?{wallet_address:chainReceipt.recipient,thot_atoms:chainReceipt.paid_thot_atoms,transaction_hash:chainReceipt.transaction_hash,test_assets:true}:{})};
    await tx.insert('contributor_entitlements',eid,l.owner_user_id,entitlement);
    await tx.insert('burn_allocations',sid,'network',{settlement_id:sid,amount_minor:split.burn_minor.toString(),currency:l.currency,status:chainReceipt?'BURN_FINAL':'CREATED',simulated:this.config.development&&!chainReceipt,...(chainReceipt?{burned_thot_atoms:chainReceipt.burned_thot_atoms,transaction_hash:chainReceipt.transaction_hash,test_assets:true}:{})});
    if(chainReceipt)await postJournal(tx,'anvil-disposition:'+id,l.currency,[
      {account:'LIABILITY:contributor_unallocated',owner:sid,amount:split.contributor_minor},
      {account:'LIABILITY:burn_pending',owner:sid,amount:split.burn_minor},
      {account:'ASSET:cash',owner:'network',amount:-(split.contributor_minor+split.burn_minor)}
    ]);
    if(auth.payout_preference==='inference_credit')await this.chooseIn(tx,l.owner_user_id,entitlement,'inference_credit');
    await tx.audit(l.owner_user_id,'SettlementCreated',{settlement_id:sid,license_id:id});
    await tx.audit(l.owner_user_id,'ContributorEntitlementCreated',{entitlement_id:eid,settlement_id:sid});
    await tx.audit('network','BurnAllocationCreated',{settlement_id:sid});
  }
  async runWorker(limit=100) {
    let processed=0,failed=0;
    await this.db.transaction(async tx=>{await tx.sql.query("UPDATE outbox_events SET status='pending',claim_token=NULL WHERE status='processing' AND event_type IN ('ProjectAgentCapture','DeleteSupersededProjections') AND available_at<=now()");});
    await this.staged.cleanup();
    for(let i=0;i<limit;i++) {
      let jobId:string|undefined,jobToken:string|null=null;
      try {
        const result=await this.db.transaction(async tx=>{
        const job=(await tx.sql.query("SELECT * FROM outbox_events WHERE status='pending' AND available_at<=now() ORDER BY created_at,id LIMIT 1 FOR UPDATE")).rows[0];
        if(!job)return false;
        jobId=job.id;
        if(['ProjectAgentCapture','DeleteSupersededProjections'].includes(job.event_type)){
          if(job.event_type==='DeleteSupersededProjections'){
            const trace=await tx.get('traces',job.payload.trace_id,job.owner_id);
            const current=new Set([trace.raw_ref,trace.scrub_ref,trace.private_metadata_ref,trace.personal_ref,trace.context_ref].filter(Boolean).map(ref=>canonicalHash(ref)));
            job.payload={...job.payload,delete_refs:(job.payload.delete_refs??trace.projection_refs??[]).filter((ref:Document)=>!current.has(canonicalHash(ref)))};
          }
          jobToken=uuidv7();
          await tx.sql.query("UPDATE outbox_events SET status='processing',claim_token=$2,payload=$3::jsonb,available_at=now()+interval '3 minutes' WHERE id=$1",[job.id,jobToken,canonicalJson(job.payload)]);
          return {id:job.id,owner_id:job.owner_id,event_type:job.event_type,payload:job.payload,claim_token:jobToken};
        }
        // Legacy worker stages retain their existing coordinator. Projection I/O is claimed separately above.
        if(job.event_type==='SettleLicense')await this.settleLicense(tx,job.payload.license_id);
        else if(job.event_type==='MatchMandate')await this.matchMandate(tx,job.payload.mandate_id);
        else if(job.event_type==='DeleteTraceObjects')await this.deleteTraceObjects(tx,job.payload.trace_id);
        else if(job.event_type==='DeleteExpiredCapture')await this.deleteExpiredCapture(tx,job.payload.capture_id);
        else if(job.event_type==='DeleteExpiredCandidate')await this.deleteExpiredRelease(tx,job.payload.candidate_id,true);
        else if(job.event_type==='DeleteExpiredRelease')await this.deleteExpiredRelease(tx,job.payload.license_id);
        else throw new DomainError('UNKNOWN_JOB');
        await tx.sql.query("UPDATE outbox_events SET status='done',attempts=attempts+1 WHERE id=$1",[job.id]);
        return true;
      });
      if(!result)break;
      if(typeof result==='object'){
        if(result.event_type==='ProjectAgentCapture'){
          ensure(this.captureProject,'CAPTURE_PROJECTOR_UNAVAILABLE');await this.captureProject(result.payload.capture_id,result.payload.root);
        }else{
          // Replaced projections are immutable and never reactivated. The claim
          // persists their references before I/O, so deletion retries survive crashes.
          for(const ref of result.payload.delete_refs)await this.privacy.remove(result.owner_id,ref);
          await this.db.transaction(async tx=>{
            const trace=await tx.get('traces',result.payload.trace_id,result.owner_id);
            const removed=new Set(result.payload.delete_refs.map((ref:Document)=>canonicalHash(ref)));
            trace.projection_refs=(trace.projection_refs??[]).filter((ref:Document)=>!removed.has(canonicalHash(ref)));
            await tx.update('traces',trace.trace_id,trace);
          });
        }
        await this.db.transaction(async tx=>{await tx.sql.query("UPDATE outbox_events SET status='done',attempts=attempts+1 WHERE id=$1 AND status='processing' AND claim_token=$2",[result.id,result.claim_token]);});
      }
      processed++;
      }catch(error){
        if(!jobId)throw error;
        const code=error instanceof DomainError?error.code:'JOB_EXECUTION_FAILED';
        await this.db.transaction(async tx=>{
          await tx.sql.query("UPDATE outbox_events SET attempts=attempts+1,last_error_code=$2,status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '30 seconds' WHERE id=$1 AND status IN ('pending','processing') AND claim_token IS NOT DISTINCT FROM $3",[jobId,code,jobToken]);
          await tx.audit('network','WorkerAttemptFailed',{job_id:jobId!,error_code:code});
        });failed++;
      }
    }
    const chain=this.moneyPath?await this.moneyPath.run():undefined;
    return {processed:processed+(chain?.processed??0),failed:failed+(chain?.failed??0)};
  }
  async chooseIn(tx:Transaction,owner:string,e:Document,disposition:string,wallet?:string) {
    if(e.disposition===disposition&&e.status==='AVAILABLE')return;
    ensure(e.status==='AVAILABLE'&&e.disposition==='pending','ENTITLEMENT_ALREADY_DISPOSED',409);
    ensure(['inference_credit','token'].includes(disposition),'INVALID_DISPOSITION');
    if(disposition==='token'){ensure(this.config.tokenEnabled,'TOKEN_DISABLED');ensure(typeof wallet==='string'&&/^0x[0-9a-fA-F]{40}$/.test(wallet),'INVALID_WALLET');}
    const amount=money(e.amount_minor);
    await postJournal(tx,'choose:'+e.entitlement_id,e.currency,[
      {account:'LIABILITY:contributor_unallocated',owner:e.settlement_id,amount},
      {account:disposition==='inference_credit'?'LIABILITY:contributor_inference_credit':'LIABILITY:contributor_token_pending',owner:e.entitlement_id,amount:-amount}]);
    e.disposition=disposition;e.status=disposition==='token'?'TOKEN_PURCHASE_PENDING':'AVAILABLE';
    if(wallet)e.wallet_address=wallet;
    await tx.update('contributor_entitlements',e.entitlement_id,e);
    await tx.audit(owner,disposition==='token'?'TokenPurchaseQueued':'InferenceCreditCreated',{entitlement_id:e.entitlement_id});
  }
  async choose(actor:Actor,key:string,id:string,input:Document) {
    roles(actor,['user']);
    return this.db.command(actor.id,key,{action:'choose',id,input},async tx=>{
      const e=await tx.get('contributor_entitlements',id,actor.id);await this.chooseIn(tx,actor.id,e,input.disposition,input.wallet_address);return e;
    });
  }
  async earnings(actor:Actor) {
    roles(actor,['user']);return this.db.transaction(async tx=>{
      const settlements=await tx.list('sale_settlements',actor.id),ids=new Set(settlements.map(s=>s.settlement_id));
      return {entitlements:await tx.list('contributor_entitlements',actor.id),settlements,
        burn_allocations:(await tx.list('burn_allocations','network')).filter(b=>ids.has(b.settlement_id))};
    });
  }
  async reserveInference(actor:Actor,key:string,id:string,input:Document) {
    roles(actor,['user']);
    return this.db.command(actor.id,key,{action:'reserve',id,input},tx=>this.reserveInferenceIn(tx,actor,id,input));
  }
  async reserveInferenceIn(tx:Transaction,actor:Actor,id:string,input:Document,requestId?:string) {
    await assertOperationEnabled(tx,'inference');
      roles(actor,['user']);
      const e=await tx.get('contributor_entitlements',id,actor.id),amount=money(input.amount_minor);
      ensure(e.disposition==='inference_credit'&&e.status==='AVAILABLE','NOT_INFERENCE_CREDIT',409);
      ensure(amount>0n&&amount<=money(e.available_minor),'INSUFFICIENT_CREDIT',409);
      const rid=uuidv7();await postJournal(tx,'reserve:'+rid,e.currency,[
        {account:'LIABILITY:contributor_inference_credit',owner:id,amount},
        {account:'LIABILITY:inference_reserved',owner:rid,amount:-amount}]);
      e.available_minor=(money(e.available_minor)-amount).toString();await tx.update('contributor_entitlements',id,e);
      const r={reservation_id:rid,entitlement_id:id,amount_minor:amount.toString(),currency:e.currency,status:'RESERVED',created_at:this.now(),...(requestId?{request_id:requestId}:{})};
      await tx.insert('inference_credit_reservations',rid,actor.id,r);await tx.audit(actor.id,'InferenceCreditReserved',{reservation_id:rid});return r;
  }
  async settleInference(actor:Actor,key:string,id:string,input:Document) {
    roles(actor,['service_settlement']);
    return this.db.command(actor.id,key,{action:'settleInference',id,input},async tx=>{
      ensure(!(await tx.get('inference_credit_reservations',id)).request_id,'MANAGED_INFERENCE_RESERVATION',409);
      return this.settleInferenceIn(tx,id,input);
    });
  }
  async settleInferenceIn(tx:Transaction,id:string,input:Document) {
      const r=await tx.get('inference_credit_reservations',id),e=await tx.get('contributor_entitlements',r.entitlement_id,r.owner_id);
      ensure(!r.request_id||r.request_id===input.request_id,'MANAGED_INFERENCE_RESERVATION',409);
      ensure(r.status==='RESERVED','RESERVATION_ALREADY_SETTLED',409);
      const reserved=money(r.amount_minor),actual=money(input.actual_minor);ensure(actual<=reserved,'RESERVATION_EXCEEDED');
      await postJournal(tx,'usage:'+id,e.currency,[
        {account:'LIABILITY:inference_reserved',owner:id,amount:reserved},
        {account:'LIABILITY:contributor_inference_credit',owner:e.entitlement_id,amount:-(reserved-actual)},
        {account:input.provider_metered?'LIABILITY:inference_provider_payable':'ASSET:cash',owner:'network',amount:-actual}]);
      e.available_minor=(money(e.available_minor)+reserved-actual).toString();
      e.status=money(e.available_minor)>0n?'AVAILABLE':'INFERENCE_SPENT';
      r.status=actual===0n?'RELEASED':'SPENT';r.actual_minor=actual.toString();
      if(input.provider_metered)r.accounting_basis='configured_rate_card_accrual_not_paid_invoice';
      await tx.update('inference_credit_reservations',id,r);await tx.update('contributor_entitlements',e.entitlement_id,e);
      await tx.audit(r.owner_id,'InferenceCreditSpent',{reservation_id:id});return r;
  }
  async stats(actor:Actor,id:string) {
    const buyer=buyerId(actor);return this.db.transaction(async tx=>{
      const m=await tx.get('mandates',id,buyer);
      const delivered=(await tx.list('licenses')).filter(l=>l.mandate_id===id);
      return {mandate_id:id,status:m.status,delivered:delivered.length,remaining_budget_minor:(money(m.funding.funded_minor)-money(m.spent_minor)).toString(),license_ids:delivered.map(l=>l.license_id)};
    });
  }
  async mandates(actor:Actor) {const buyer=buyerId(actor);return this.db.transaction(tx=>tx.list('mandates',buyer));}
  async auditExport(actor:Actor) {
    roles(actor,['user']);return this.db.transaction(async tx=>{
      const receiptTables=['provenance_receipts','credential_receipts','outcome_receipts','scrub_receipts','user_policies','sale_authorizations','licenses','sale_settlements'];
      const records:Document={};for(const table of receiptTables)records[table]=(await tx.list(table,actor.id)).map(({owner_id,id,...r})=>r);
      const settlements=new Set(records.sale_settlements.map((s:Document)=>s.settlement_id));
      records.burn_allocations=(await tx.list('burn_allocations','network')).filter(b=>settlements.has(b.settlement_id)).map(({owner_id,id,...r})=>r);
      records.inference_usage=(await tx.list('inference_requests',actor.id)).map(r=>({request_id:r.request_id,reservation_id:r.reservation_id,status:r.status,rate_card_hash:r.rate_card_hash,reserved_minor:r.reserved_minor,currency:r.currency,...(r.actual_minor!==undefined?{actual_minor:r.actual_minor}:{}),...(r.usage?{usage:r.usage}:{})}));
      return {schema_version:'trace.audit-export/1',generated_at:this.now(),records,commitment:canonicalHash(records)};
    });
  }
  async reconciliation(actor:Actor):Promise<Document> {
    roles(actor,['service_settlement','operator_security']);
    return this.db.transaction(async tx=>({...await reconcile(tx),burn_allocations:await tx.list('burn_allocations','network'),
      inference_attention:(await tx.list('inference_requests')).filter(r=>r.status==='UNCERTAIN').map(r=>({request_id:r.request_id,reservation_id:r.reservation_id,status:r.status,reserved_minor:r.reserved_minor,currency:r.currency,failure_code:r.failure_code})),
      work_queues:(await tx.sql.query('SELECT event_type,status,count(*)::text AS count FROM outbox_events GROUP BY event_type,status ORDER BY event_type,status')).rows,
      failed_jobs:(await tx.sql.query("SELECT id,event_type,attempts,last_error_code FROM outbox_events WHERE status='failed' ORDER BY created_at,id")).rows}));
  }
  async pauseMandate(actor:Actor,key:string,id:string) {
    const buyer=buyerId(actor);roles(actor,['buyer_admin']);
    return this.db.command(actor.id,key,{action:'pause',id},async tx=>{const m=await tx.get('mandates',id,buyer);ensure(m.status==='active','MANDATE_STATE');m.status='paused';await tx.update('mandates',id,m);return m;});
  }
}
