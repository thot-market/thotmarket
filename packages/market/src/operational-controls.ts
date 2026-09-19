import { canonicalHash } from '../../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import { reconcile } from '../../ledger/src/index.ts';
import type { Actor, ThotService } from './service.ts';

export type OperationalArea = 'sales' | 'inference' | 'deliveries';
const areas: OperationalArea[] = ['sales','inference','deliveries'];
const reasons = ['SECURITY_INCIDENT','PROVIDER_INCIDENT','ACCOUNTING_REVIEW','MAINTENANCE'] as const;
export async function controlState(tx: Transaction): Promise<Document> {
  return await tx.maybe('operational_controls','network') ?? {schema_version:'thot.operations/1',revision:0,sales:false,inference:false,deliveries:false,reason_code:null};
}
export async function assertOperationEnabled(tx: Transaction, area: OperationalArea) {
  ensure((await controlState(tx))[area] === false, 'OPERATION_PAUSED', 503);
}
/** Circuit breakers stop new side effects, never erase debts or recall prior downloads. */
export class OperationalControls {
  readonly service: ThotService;
  constructor(service: ThotService) { this.service=service; }
  async update(actor: Actor, key: string, input: Document) {
    ensure(actor.role==='operator_security','FORBIDDEN',403);
    ensure(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(k=>['expected_revision','paused','reason_code','acknowledge_resume'].includes(k)),'INVALID_OPERATIONAL_CONTROL');
    ensure(Number.isSafeInteger(input.expected_revision)&&input.expected_revision>=0,'INVALID_OPERATIONAL_REVISION');
    ensure(input.paused && typeof input.paused==='object' && !Array.isArray(input.paused) && Object.keys(input.paused).length===areas.length && areas.every(k=>typeof input.paused[k]==='boolean'),'INVALID_OPERATIONAL_CONTROL');
    ensure(reasons.includes(input.reason_code),'INVALID_OPERATIONAL_REASON');
    return this.service.db.command(actor.id,key,{action:'operationalControl',input},async tx=>{
      const before=await controlState(tx);
      ensure(before.revision===input.expected_revision,'OPERATIONAL_REVISION_CONFLICT',409);
      const resuming=areas.some(k=>before[k]&&!input.paused[k]);
      ensure(!resuming||input.acknowledge_resume===true,'OPERATIONAL_RESUME_REVIEW_REQUIRED');
      const next={schema_version:'thot.operations/1',revision:before.revision+1,...input.paused,reason_code:input.reason_code,updated_at:this.service.now()};
      if(await tx.maybe('operational_controls','network'))await tx.update('operational_controls','network',next);
      else await tx.insert('operational_controls','network','network',next);
      await tx.audit('network','OperationalControlChanged',{actor_id:actor.id,revision:next.revision,reason_code:input.reason_code,previous_commitment:canonicalHash(before),next_commitment:canonicalHash(next)});
      if(before.sales&&!next.sales)await this.service.enqueueMatching(tx);
      return next;
    });
  }
  async status(actor: Actor) {
    ensure(actor.role==='operator_security','FORBIDDEN',403);
    return this.service.db.transaction(async tx=>{
      const control=await controlState(tx),ledger=await reconcile(tx);
      const traces=await tx.list('traces'), licenses=await tx.list('licenses'), requests=await tx.list('inference_requests'), burns=await tx.list('burn_allocations');
      const jobs=(await tx.sql.query('SELECT event_type,status,count(*)::text AS count FROM outbox_events GROUP BY event_type,status')).rows;
      const by=(rows:Document[],field:string,values:string[])=>Object.fromEntries(values.map(value=>[value,rows.filter(r=>r[field]===value).length]));
      const uncertain=requests.filter(r=>r.status==='UNCERTAIN').length;
      const stuck=requests.filter(r=>r.status==='PROCESSING'&&r.processing_deadline<=this.service.now()).length;
      const failed=jobs.filter(r=>r.status==='failed').reduce((n,r)=>n+Number(r.count),0);
      const burnPending=burns.filter(b=>b.status!=='BURN_FINAL');
      const pendingByCurrency=Object.fromEntries(['USD','USDC'].map(currency=>[currency,burnPending.filter(b=>b.currency===currency).reduce((n,b)=>n+BigInt(b.amount_minor),0n).toString()]));
      const safeJobs=jobs.filter(r=>['MatchMandate','SettleLicense','DeleteTraceObjects','DeleteExpiredCandidate','DeleteExpiredRelease','DeleteExpiredCapture'].includes(r.event_type)&&['pending','done','failed','processing'].includes(r.status)).map(r=>({type:r.event_type,status:r.status,count:r.count}));
      const alerts=[...(!ledger.balanced?['LEDGER_IMBALANCE']:[]),...(failed?['FAILED_WORK']:[]),...(uncertain?['INFERENCE_CHARGE_UNCERTAIN']:[]),...(stuck?['INFERENCE_PROCESSING_OVERDUE']:[])];
      return {schema_version:'thot.operations-status/1',at:this.service.now(),control,metrics:{trace_count:traces.length,trace_rights:by(traces,'rights_status',['eligible','eligible_with_restrictions','rejected','manual_review']),license_count:licenses.length,inference:by(requests,'status',['QUEUED','PROCESSING','COMPLETED','INCOMPLETE','FAILED','UNCERTAIN','CANCELLED']),burn_pending_minor:pendingByCurrency,work: safeJobs,ledger_balanced:ledger.balanced},alerts,notice:'Local operational metrics only. No raw content, account identities or evidence bodies. No external notifications or production certification.'};
    });
  }
}
