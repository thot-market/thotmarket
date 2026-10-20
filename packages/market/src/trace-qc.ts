import {uuidv7} from '../../protocol/src/index.ts';
import {contentDigest,QC_POLICY_VERSION,runTraceQc,type TraceQcReport} from '../../qc/index.ts';
import {DomainError,ensure,type Document,type Transaction} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';

import {sourceCoverage,qcVersion,qcRunId,qcAutomation,qcAvailability,qcJobId,qcMark,enqueueTraceQc,QC_EVENT,QC_ATTEMPT_LIMIT,QC_DISCOVERY_LIMIT,QC_LEASE_SECONDS,QC_NONRETRYABLE,type QcScope as Scope} from './trace-qc-state.ts';
type Snapshot={trace:Document;scope:Scope;ref:Document;version:string;id:string};
const decisions=['agree','disagree','unsure'];
const feedbackCodes=['false_positive','missed_issue','useful','unclear'];
const scopeOf=(value:unknown):Scope=>{ensure(value==='private'||value==='release','INVALID_QC_SCOPE');return value;};
const owned=(actor:Actor)=>ensure(actor.role==='user','FORBIDDEN',403);
const notice='Quality review covers this selected saved source only. It does not establish provenance, licensing rights, a price or sale permission.';
export const TRACE_QC_STORAGE_LIMITS=Object.freeze({runs_per_trace:128,reviews_per_trace:128});

/** The API uses only the bounded local engine. No evaluator, endpoint or provider key
 * can be supplied by a request. Reports and human assertions remain owner-private. */
export class TraceQc {
  readonly service:ThotService;
  private evaluate:typeof runTraceQc;
  constructor(service:ThotService,options:{evaluate?:typeof runTraceQc}={}){this.service=service;this.evaluate=options.evaluate??runTraceQc;}

  private async snapshot(tx:Transaction,actor:Actor,traceId:string,scope:Scope):Promise<Snapshot>{
    ensure(typeof traceId==='string'&&traceId.length>0&&traceId.length<=160,'INVALID_QC_TRACE');
    const trace=await tx.get('traces',traceId,actor.id);
    ensure(!trace.deleted&&trace.retention_expires_at>this.service.now(),'TRACE_CONTENT_UNAVAILABLE',410);
    const ref=scope==='private'?trace.raw_ref:trace.scrub_ref;
    ensure(ref,'QC_SOURCE_UNAVAILABLE',409);
    if(scope==='release')ensure(trace.normalized_hash&&['eligible','eligible_with_restrictions'].includes(trace.rights_status)&&trace.save_privately!==true,'QC_RELEASE_UNAVAILABLE',409);
    const version=qcVersion(trace,scope);
    return {trace,scope,ref,version,id:qcRunId(actor.id,traceId,scope,version)};
  }
  private async current(tx:Transaction,actor:Actor,before:Snapshot){
    const after=await this.snapshot(tx,actor,before.trace.trace_id,before.scope);
    ensure(after.version===before.version,'QC_SOURCE_CHANGED',409);return after;
  }
  private selected(source:Snapshot,hash:string|null){return {trace_id:source.trace.trace_id,scope:source.scope,content_hash:hash,source_version:source.version,release_revision:source.trace.release_revision??0,coverage:sourceCoverage(source.trace)};}
  private verifyReport(report:TraceQcReport,run:Document){
    ensure(contentDigest(report)===run.report_digest&&report.schema_version==='trace-qc/v1'&&report.content_digest===run.content_hash&&report.scope===run.scope&&report.policy_version===run.policy_version,'QC_REPORT_UNAVAILABLE',409);
  }
  private async quota(tx:Transaction,owner:string,traceId:string,table:'trace_qc_runs'|'trace_qc_reviews'){
    const count=Number((await tx.sql.query('SELECT count(*) AS count FROM '+table+" WHERE owner_id=$1 AND document->>'trace_id'=$2",[owner,traceId])).rows[0]!.count);
    ensure(count<(table==='trace_qc_runs'?TRACE_QC_STORAGE_LIMITS.runs_per_trace:TRACE_QC_STORAGE_LIMITS.reviews_per_trace),'QC_STORAGE_LIMIT',429);
  }
  private async readCurrent(actor:Actor,traceId:string,scope:Scope,cached=true,expectedVersion?:string){
    const before=await this.service.db.transaction(async tx=>{
      const source=await this.snapshot(tx,actor,traceId,scope),run=await tx.maybe('trace_qc_runs',source.id);
      ensure(expectedVersion===undefined||source.version===expectedVersion,'QC_SOURCE_CHANGED',409);
      ensure(!run||run.owner_id===actor.id,'NOT_FOUND',404);
      const reviews=run?(await tx.sql.query("SELECT document,id FROM trace_qc_reviews WHERE owner_id=$1 AND document->>'run_id'=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[actor.id,run.id])).rows:[];
      return {source,run,review:reviews[0]?.document};
    });
    if(!before.run)return {trace_id:traceId,scope,selected_source:this.selected(before.source,null),automation:qcAutomation(before.source.trace,scope,this.service.now()),status:'not_run',cached:false,report:null,report_digest:null,summary:'Quality checks have not been run for this saved source.',review:null,notice};
    const report:TraceQcReport=await this.service.privacy.open(actor.id,before.run.object_ref);
    this.verifyReport(report,before.run);
    const review=before.review?await this.service.privacy.open(actor.id,before.review.object_ref):null;
    if(review)ensure(contentDigest(review)===before.review.review_digest,'QC_REVIEW_UNAVAILABLE',409);
    await this.service.db.transaction(tx=>this.current(tx,actor,before.source));
    const automation=qcAutomation(before.source.trace,scope,this.service.now());
    return {trace_id:traceId,scope,selected_source:this.selected(before.source,before.run.content_hash),automation:automation.state==='preparing'?automation:{...automation,state:'complete',retryable:false,outcome:report.status,findings_count:report.findings.filter(f=>f.severity==='flag'||f.severity==='reject').length},status:'complete',cached,report,report_digest:before.run.report_digest,summary:report.summary,review,notice};
  }
  async get(actor:Actor,traceId:string,query:Document={}){
    owned(actor);ensure(Object.keys(query).every(k=>k==='scope'),'INVALID_QC_QUERY');
    const scope=scopeOf(query.scope??'private');
    const preparing=await this.service.db.transaction(async tx=>{
      const trace=await tx.get('traces',traceId,actor.id);
      ensure(!trace.deleted&&trace.retention_expires_at>this.service.now(),'TRACE_CONTENT_UNAVAILABLE',410);
      if(scope==='private'&&!trace.raw_ref&&qcAvailability(trace,scope,this.service.now())==='preparing')return trace;
      return null;
    });
    if(preparing){const source={trace:preparing,scope,ref:{},version:qcVersion(preparing,scope),id:''};return {trace_id:traceId,scope,selected_source:this.selected(source,null),automation:qcAutomation(preparing,scope,this.service.now()),status:'not_run',cached:false,report:null,report_digest:null,summary:'The saved source is still being prepared.',review:null,notice};}
    return this.readCurrent(actor,traceId,scope);
  }
  private async execute(actor:Actor,key:string,traceId:string,input:Document,control?:{version:string;authorize:(tx:Transaction)=>Promise<void>}){
    owned(actor);ensure(input&&Object.keys(input).length===1&&'scope' in input,'INVALID_QC_REQUEST');
    const scope=scopeOf(input.scope),before=await this.service.db.transaction(tx=>this.snapshot(tx,actor,traceId,scope));
    ensure(!control||before.version===control.version,'QC_SOURCE_CHANGED',409);
    if(control)await this.service.db.transaction(control.authorize);
    const publish=async(tx:Transaction,report:TraceQcReport)=>{
      await control?.authorize(tx);const source=await this.current(tx,actor,before);
      await qcMark(tx,source.trace,scope,before.version,{state:'complete',retryable:false,reason_code:null,outcome:report.status,findings_count:report.findings.filter(f=>f.severity==='flag'||f.severity==='reject').length});
      if(!control)await tx.sql.query("UPDATE outbox_events SET status='done',claim_token=NULL WHERE id=$1",[qcJobId(actor.id,traceId,scope,before.version)]);
    };
    const result=await this.service.staged.run(actor.id,key,{action:'traceQc',trace_id:traceId,scope,source_version:before.version,policy_version:QC_POLICY_VERSION},'projection',async stage=>{
      const existing=await this.service.db.transaction(tx=>tx.maybe('trace_qc_runs',before.id));
      if(existing){const report=await stage.open(existing.object_ref);this.verifyReport(report,existing);return async tx=>{await publish(tx,report);return {run_id:existing.id,cached:true};};}
      const content=await stage.open(before.ref);
      let hash:string;
      try{hash=contentDigest(content);}catch{throw new DomainError('QC_SOURCE_LIMIT',413);}
      if(scope==='release')ensure(hash===before.trace.normalized_hash,'QC_SOURCE_CHANGED',409);
      const reusable=await this.service.db.transaction(async tx=>{
        await this.current(tx,actor,before);
        await this.quota(tx,actor.id,traceId,'trace_qc_runs');
        return (await tx.sql.query("SELECT document FROM trace_qc_runs WHERE owner_id=$1 AND document->>'trace_id'=$2 AND document->>'scope'=$3 AND document->>'content_hash'=$4 AND document->>'policy_version'=$5 LIMIT 1",[actor.id,traceId,scope,hash,QC_POLICY_VERSION])).rows[0]?.document;
      });
      let ref:Document,digest:string,report:TraceQcReport;
      if(reusable){report=await stage.open(reusable.object_ref);this.verifyReport(report,reusable);ref=reusable.object_ref;digest=reusable.report_digest;}
      else{
        try{report=this.evaluate(content,{scope});}catch{throw new DomainError('QC_EXECUTION_FAILED',503);}
        digest=contentDigest(report);ref=await stage.seal(report);
      }
      return async tx=>{
        await publish(tx,report);
        if(await tx.maybe('trace_qc_runs',before.id)){if(!reusable)stage.discard();return {run_id:before.id,cached:true};}
        await this.quota(tx,actor.id,traceId,'trace_qc_runs');
        await tx.insert('trace_qc_runs',before.id,actor.id,{trace_id:traceId,scope,source_version:before.version,content_hash:hash,policy_version:QC_POLICY_VERSION,report_digest:digest,object_ref:ref,created_at:this.service.now()});
        await tx.audit(actor.id,'TraceQualityChecked',{trace_id:traceId,scope,report_digest:digest});
        return {run_id:before.id,cached:!!reusable};
      };
    });
    // Even an idempotency replay must check current ownership/retention/version.
    await this.service.db.transaction(tx=>this.current(tx,actor,before));
    if(control)await this.service.db.transaction(control.authorize);
    return {scope,result,version:before.version};
  }
  async run(actor:Actor,key:string,traceId:string,input:Document){
    owned(actor);ensure(input&&Object.keys(input).length===1&&'scope' in input,'INVALID_QC_REQUEST');const scope=scopeOf(input.scope);
    ensure(typeof key==='string'&&key.length>=8&&key.length<=200,'IDEMPOTENCY_KEY_REQUIRED');
    const before=await this.service.db.transaction(async tx=>{
      const source=await this.snapshot(tx,actor,traceId,scope);
      ensure(qcAvailability(source.trace,scope,this.service.now())==='ready','QC_SOURCE_PREPARING',409);
      const existing=await tx.maybe('trace_qc_runs',source.id);
      if(!existing){
        const status=qcAutomation(source.trace,scope,this.service.now());
        ensure(!['failed','running'].includes(status.state)&&status.attempts===0,'QC_RETRY_UNAVAILABLE',409);
        await enqueueTraceQc(tx,source.trace,this.service.now(),[scope]);
      }
      return {source,existing};
    });
    // Legacy manual first runs join the same durable attempt budget. Cached reads
    // remain compatible, while retries use the explicit bounded retry endpoint.
    if(before.existing){
      await this.service.db.command(actor.id,key,{action:'traceQc',trace_id:traceId,scope,source_version:before.source.version,policy_version:QC_POLICY_VERSION},async tx=>{
        await this.current(tx,actor,before.source);return {run_id:before.source.id,cached:true};
      });
      return this.readCurrent(actor,traceId,scope,true,before.source.version);
    }
    const job=await this.claim(qcJobId(actor.id,traceId,scope,before.source.version));ensure(job&&!job.skipped,'QC_RETRY_UNAVAILABLE',409);
    const value=await this.performJob(job,key,true);ensure(value,'QC_EXECUTION_FAILED',503);
    return this.readCurrent(actor,traceId,scope,value.result.cached,value.version);
  }
  private processing:Promise<{processed:number;failed:number}>|undefined;
  /** One bounded lane per process. Claims are durable across processes/restarts. */
  processPending(limit=2){
    ensure(Number.isSafeInteger(limit)&&limit>=1&&limit<=10,'INVALID_QC_WORKER_LIMIT');
    if(this.processing)return this.processing;
    const work=this.processBatch(limit);this.processing=work;
    void work.finally(()=>{if(this.processing===work)this.processing=undefined;}).catch(()=>{});
    return work;
  }
  private async discover(){
    await this.service.db.transaction(async tx=>{
      const id='trace-qc:discovery:v1',prior=await tx.maybe('thot_records',id);
      ensure(!prior||prior.owner_id==='network'&&prior.kind==='trace_qc_discovery','QC_DISCOVERY_STATE_INVALID');
      const rows=(await tx.sql.query('SELECT id,owner_id,document FROM traces WHERE id>$1 ORDER BY id LIMIT $2',[prior?.cursor??'',QC_DISCOVERY_LIMIT])).rows;
      for(const row of rows)await enqueueTraceQc(tx,{...row.document,id:row.id,owner_id:row.owner_id},this.service.now());
      const cursor={kind:'trace_qc_discovery',cursor:rows.length===QC_DISCOVERY_LIMIT?rows.at(-1)!.id:'',policy_version:QC_POLICY_VERSION};
      if(prior)await tx.update('thot_records',id,cursor);else await tx.insert('thot_records',id,'network',cursor);
    });
  }
  private async claim(onlyId?:string):Promise<Document|null>{
    return this.service.db.transaction(async tx=>{
      const expired=(await tx.sql.query("SELECT * FROM outbox_events WHERE event_type=$1 AND status='processing' AND available_at<=clock_timestamp() ORDER BY available_at,id LIMIT $2 FOR UPDATE",[QC_EVENT,QC_DISCOVERY_LIMIT])).rows;
      for(const job of expired){
        const doneTrace=await tx.maybe('traces',job.payload.trace_id);
        if(doneTrace&&doneTrace.owner_id===job.owner_id&&qcAutomation(doneTrace,job.payload.scope,this.service.now()).state==='complete'){
          await tx.sql.query("UPDATE outbox_events SET status='done',claim_token=NULL,last_error_code=NULL WHERE id=$1",[job.id]);continue;
        }
        const failed=job.attempts>=QC_ATTEMPT_LIMIT;
        await tx.sql.query("UPDATE outbox_events SET status=$2,claim_token=NULL,last_error_code='QC_LEASE_EXPIRED' WHERE id=$1",[job.id,failed?'failed':'pending']);
        const trace=await tx.maybe('traces',job.payload.trace_id);
        if(trace&&trace.owner_id===job.owner_id&&qcAvailability(trace,job.payload.scope,this.service.now())==='ready'&&qcVersion(trace,job.payload.scope)===job.payload.source_version)
          await qcMark(tx,trace,job.payload.scope,job.payload.source_version,{state:failed?'failed':'queued',retryable:failed&&(trace.quality_checks?.[job.payload.scope]?.retry_count??0)<3,attempts:job.attempts,reason_code:'QC_LEASE_EXPIRED'});
      }
      const job=(await tx.sql.query("SELECT * FROM outbox_events WHERE event_type=$1 AND status='pending' AND available_at<=clock_timestamp() AND ($2::text IS NULL OR (id=$2 AND attempts=0)) ORDER BY created_at,id LIMIT 1 FOR UPDATE",[QC_EVENT,onlyId??null])).rows[0];
      if(!job)return null;
      const trace=await tx.maybe('traces',job.payload.trace_id),scope=job.payload.scope as Scope;
      if(!trace||trace.owner_id!==job.owner_id||!['private','release'].includes(scope)||job.payload.policy_version!==QC_POLICY_VERSION||qcAvailability(trace,scope,this.service.now())!=='ready'||qcVersion(trace,scope)!==job.payload.source_version){
        await tx.sql.query("UPDATE outbox_events SET status='done',claim_token=NULL,last_error_code='QC_SOURCE_SUPERSEDED' WHERE id=$1",[job.id]);return {skipped:true as const};
      }
      if(qcAutomation(trace,scope,this.service.now()).state==='complete'){await tx.sql.query("UPDATE outbox_events SET status='done',claim_token=NULL,last_error_code=NULL WHERE id=$1",[job.id]);return {skipped:true as const};}
      const token=uuidv7();
      await tx.sql.query("UPDATE outbox_events SET status='processing',claim_token=$2,attempts=attempts+1,available_at=clock_timestamp()+($3 * interval '1 second') WHERE id=$1",[job.id,token,QC_LEASE_SECONDS]);
      await qcMark(tx,trace,scope,job.payload.source_version,{state:'running',retryable:false,attempts:job.attempts+1,reason_code:null});
      return {...job,attempts:job.attempts+1,claim_token:token,skipped:false as const};
    });
  }
  private async processBatch(limit:number){
    await this.discover();
    let processed=0,failed=0;
    for(let i=0;i<limit;i++){
      const job=await this.claim();if(!job)break;if(job.skipped){processed++;continue;}
      if(await this.performJob(job))processed++;else failed++;
    }
    return {processed,failed};
  }
  private async performJob(job:Document,key?:string,propagate=false){
      const authorize=async(tx:Transaction)=>{
        const row=(await tx.sql.query("SELECT id FROM outbox_events WHERE id=$1 AND owner_id=$2 AND event_type=$3 AND status='processing' AND claim_token=$4 AND available_at>clock_timestamp()",[job.id,job.owner_id,QC_EVENT,job.claim_token])).rows[0];
        ensure(row,'QC_CLAIM_EXPIRED',409);
      };
      try{
        const result=await this.execute({id:job.owner_id,role:'user'},key??('autoqc:'+job.id+':'+job.claim_token),job.payload.trace_id,{scope:job.payload.scope},{version:job.payload.source_version,authorize});
        await this.service.db.transaction(async tx=>{await authorize(tx);await tx.sql.query("UPDATE outbox_events SET status='done',claim_token=NULL,last_error_code=NULL WHERE id=$1",[job.id]);});
        return result;
      }catch(error){
        const raw=error instanceof DomainError?error.code:'QC_EXECUTION_FAILED';
        const superseded=['QC_SOURCE_CHANGED','QC_SOURCE_UNAVAILABLE','QC_RELEASE_UNAVAILABLE','TRACE_CONTENT_UNAVAILABLE','NOT_FOUND','QC_CLAIM_EXPIRED'].includes(raw);
        const code=superseded?'QC_SOURCE_SUPERSEDED':new Set(['QC_SOURCE_LIMIT','QC_STORAGE_LIMIT','QC_REPORT_UNAVAILABLE','STORAGE_CAPACITY_EXCEEDED','STORAGE_QUOTA_EXCEEDED','STORAGE_OPERATION_IN_PROGRESS','STORAGE_OPERATION_EXPIRED']).has(raw)?raw:'QC_EXECUTION_FAILED';
        await this.service.db.transaction(async tx=>{
          const live=(await tx.sql.query("SELECT id FROM outbox_events WHERE id=$1 AND status='processing' AND claim_token=$2 AND available_at>clock_timestamp()",[job.id,job.claim_token])).rows[0];
          if(!live)return;
          const trace=await tx.maybe('traces',job.payload.trace_id),current=trace&&trace.owner_id===job.owner_id&&qcAvailability(trace,job.payload.scope,this.service.now())==='ready'&&qcVersion(trace,job.payload.scope)===job.payload.source_version;
          if(superseded||!current){await tx.sql.query("UPDATE outbox_events SET status='done',claim_token=NULL,last_error_code='QC_SOURCE_SUPERSEDED' WHERE id=$1",[job.id]);return;}
          const terminal=job.attempts>=QC_ATTEMPT_LIMIT||QC_NONRETRYABLE.has(code),retryable=terminal&&!QC_NONRETRYABLE.has(code)&&(trace!.quality_checks?.[job.payload.scope]?.retry_count??0)<3;
          await tx.sql.query("UPDATE outbox_events SET status=$2,claim_token=NULL,last_error_code=$3,available_at=clock_timestamp()+interval '30 seconds' WHERE id=$1",[job.id,terminal?'failed':'pending',code]);
          await qcMark(tx,trace!,job.payload.scope,job.payload.source_version,{state:terminal?'failed':'queued',retryable,attempts:job.attempts,reason_code:code,outcome:null,findings_count:null});
        });if(propagate)throw error;return null;
      }
  }
  async retry(actor:Actor,key:string,traceId:string,input:Document){
    owned(actor);ensure(input&&Object.keys(input).length===1&&'scope' in input,'INVALID_QC_REQUEST');const scope=scopeOf(input.scope);
    await this.service.db.command(actor.id,key,{action:'retryTraceQc',trace_id:traceId,scope},async tx=>{
      const source=await this.snapshot(tx,actor,traceId,scope),status=qcAutomation(source.trace,scope,this.service.now());
      ensure(status.state==='failed'&&status.retryable,'QC_RETRY_UNAVAILABLE',409);
      const id=qcJobId(actor.id,traceId,scope,source.version),job=(await tx.sql.query("SELECT id FROM outbox_events WHERE id=$1 AND owner_id=$2 AND event_type=$3 AND status='failed'",[id,actor.id,QC_EVENT])).rows[0];
      ensure(job,'QC_RETRY_UNAVAILABLE',409);
      await tx.sql.query("UPDATE outbox_events SET status='pending',attempts=0,last_error_code=NULL,claim_token=NULL,available_at=clock_timestamp() WHERE id=$1",[id]);
      await qcMark(tx,source.trace,scope,source.version,{state:'queued',retryable:false,attempts:0,reason_code:null,retry_count:(source.trace.quality_checks?.[scope]?.retry_count??0)+1});
      return {queued:true};
    });
    return this.get(actor,traceId,{scope});
  }
  async review(actor:Actor,key:string,traceId:string,input:Document){
    owned(actor);ensure(input&&Object.keys(input).every(k=>['scope','source_version','report_digest','decision','feedback'].includes(k)),'INVALID_QC_REVIEW');
    const scope=scopeOf(input.scope);
    ensure(typeof input.source_version==='string'&&/^[a-f0-9]{64}$/.test(input.source_version)&&typeof input.report_digest==='string'&&/^[a-f0-9]{64}$/.test(input.report_digest)&&decisions.includes(input.decision),'INVALID_QC_REVIEW');
    ensure(Array.isArray(input.feedback)&&input.feedback.length<=feedbackCodes.length&&input.feedback.every((code:unknown)=>typeof code==='string'&&feedbackCodes.includes(code))&&new Set(input.feedback).size===input.feedback.length,'INVALID_QC_REVIEW');
    const before=await this.service.db.transaction(async tx=>{
      const source=await this.snapshot(tx,actor,traceId,scope),run=await tx.maybe('trace_qc_runs',source.id);
      ensure(source.version===input.source_version&&run&&run.owner_id===actor.id&&run.report_digest===input.report_digest,'QC_REVIEW_STALE',409);
      return {source,run};
    });
    const decision={scope,source_version:before.source.version,decision:input.decision,feedback:[...input.feedback].sort(),report_digest:input.report_digest,unverified:true,created_at:this.service.now()};
    await this.service.staged.run(actor.id,key,{action:'traceQcReview',trace_id:traceId,source_version:before.source.version,scope,report_digest:input.report_digest,decision:decision.decision,feedback:decision.feedback},'projection',async stage=>{
      await this.service.db.transaction(tx=>this.quota(tx,actor.id,traceId,'trace_qc_reviews'));
      const ref=await stage.seal(decision),id=uuidv7();
      return async tx=>{
        await this.current(tx,actor,before.source);
        const run=await tx.get('trace_qc_runs',before.run.id,actor.id);ensure(run.report_digest===input.report_digest,'QC_REVIEW_STALE',409);
        await this.quota(tx,actor.id,traceId,'trace_qc_reviews');
        await tx.insert('trace_qc_reviews',id,actor.id,{trace_id:traceId,run_id:run.id,scope,source_version:before.source.version,report_digest:input.report_digest,review_digest:contentDigest(decision),object_ref:ref,created_at:decision.created_at});
        await tx.audit(actor.id,'TraceQualityReviewed',{trace_id:traceId,scope,report_digest:input.report_digest});
        return {review_id:id};
      };
    });
    await this.service.db.transaction(tx=>this.current(tx,actor,before.source));
    return this.readCurrent(actor,traceId,scope,true,before.source.version);
  }
}
