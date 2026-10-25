import {createHash,randomBytes} from 'node:crypto';
import {DomainError,ensure,type Document,type Transaction} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';
import type {CaptureDevices} from './capture-devices.ts';
import type {HistoryDevices} from './history-devices.ts';
import type {RobinhoodLinks} from './robinhood-link.ts';
import type {ThotMarketplace} from './thot-market.ts';
import type {ThotTradeEvidence} from './thot-trade-evidence.ts';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const record=(code:string)=>'device-pairing:'+hash(code);
const CLIENTS=['codex','claude','zai'],HISTORY_CLIENTS=['claude','codex'];
// RFC 8628 shape: the helper holds a long device_code and a person reads a
// short user_code. Eight characters from a thirty-symbol unambiguous alphabet
// (~39.5 bits), single-use, short-lived, and guarded by per-account approve
// limits on top of the poll interval.
const CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_SECONDS=600,POLL_INTERVAL_SECONDS=5;
const helperStages=new Set(['checking_services','awaiting_extension','awaiting_account_request','capturing','verifying','proof_ready']);
const fail=(code:string,status:number)=>{throw new DomainError(code,status);};

function newUserCode(){let value='';const bytes=randomBytes(8);for(let i=0;i<8;i++)value+=CODE_ALPHABET[bytes[i]!%CODE_ALPHABET.length];return value.slice(0,4)+'-'+value.slice(4);}
/** Accepts a typed code with or without the dash and stray separators. */
export function normalizeUserCode(input:unknown):string|null{
  if(typeof input!=='string'||input.length>32)return null;
  const value=input.toUpperCase().replaceAll(/[^A-Z0-9]/g,'');
  return value.length===8&&[...value].every(c=>CODE_ALPHABET.includes(c))?value.slice(0,4)+'-'+value.slice(4):null;
}
const validUserCode=(code:string|null):code is string=>code!==null&&/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);

/** Cross-machine pairing for helpers whose loopback callback the browser
 * cannot reach. The approved issuance is exactly the body the loopback
 * callback would have posted — a capture or history device credential, or a
 * Robinhood link input. It is created at approval, held once, and delivered
 * once to the helper presenting the matching device_code. */
export class DevicePairing {
  readonly service:ThotService;
  readonly captureDevices:CaptureDevices;readonly historyDevices:HistoryDevices;
  readonly robinhood:RobinhoodLinks;readonly tradeEvidence:ThotTradeEvidence;readonly thot:ThotMarketplace;
  constructor(service:ThotService,captureDevices:CaptureDevices,historyDevices:HistoryDevices,robinhood:RobinhoodLinks,tradeEvidence:ThotTradeEvidence,thot:ThotMarketplace){
    this.service=service;this.captureDevices=captureDevices;this.historyDevices=historyDevices;this.robinhood=robinhood;this.tradeEvidence=tradeEvidence;this.thot=thot;
  }
  private now(){return Date.parse(this.service.now());}
  private async rate(tx:Transaction,scope:string,maximum:number){
    const now=this.now();
    await tx.sql.query("DELETE FROM auth_access WHERE document->>'kind'='device_pairing_rate' AND (document->>'window_end')::numeric<=$1",[now]);
    const id='device-pairing-rate:'+scope,prior=await tx.maybe('auth_access',id);
    ensure(!prior||prior.count<maximum,'PAIRING_RATE_LIMIT',429);
    const value={kind:'device_pairing_rate',count:(prior?.count??0)+1,window_end:prior?.window_end??now+60_000};
    if(prior)await tx.update('auth_access',id,value);else await tx.insert('auth_access',id,'network',value);
  }
  private async findByUserCode(tx:Transaction,code:string):Promise<Document|undefined>{
    // Expiry is checked by the caller so an expired code is reported as
    // expired rather than as an unknown code.
    const found=(await tx.sql.query("SELECT id FROM auth_access WHERE document->>'kind'='device_pairing' AND document->>'user_code'=$1 LIMIT 2",[code])).rows;
    ensure(found.length<2,'PAIRING_CODE_COLLISION');
    return found.length?await tx.maybe('auth_access',String(found[0]!.id)):undefined;
  }
  async create(input:Document,meta:{origin:string;ip:string}){
    ensure(typeof input.flow==='string'&&['capture','history','robinhood'].includes(input.flow),'INVALID_PAIRING_REQUEST');
    const flow=input.flow,device=input.device_name;
    ensure(typeof device==='string'&&device.length>=1&&device.length<=80&&!/[\x00-\x1f\x7f]/.test(device),'INVALID_PAIRING_DEVICE_NAME');
    const request:Document={};
    if(flow==='capture'){
      ensure(Object.keys(input).every(k=>['flow','client','device_name'].includes(k))&&CLIENTS.includes(input.client),'INVALID_PAIRING_REQUEST');
      request.client=input.client;
    }else if(flow==='history'){
      ensure(Object.keys(input).every(k=>['flow','client','device_name','source_ids','backfill','daily_time_utc'].includes(k))&&HISTORY_CLIENTS.includes(input.client),'INVALID_PAIRING_REQUEST');
      ensure(Array.isArray(input.source_ids)&&input.source_ids.length>0&&input.source_ids.length<=10&&new Set(input.source_ids).size===input.source_ids.length&&input.source_ids.every((s:unknown)=>typeof s==='string'&&/^[a-f0-9]{32}$/.test(s))&&typeof input.backfill==='boolean'&&typeof input.daily_time_utc==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(input.daily_time_utc),'INVALID_PAIRING_REQUEST');
      request.client=input.client;request.source_ids=input.source_ids;request.backfill=input.backfill;request.daily_time_utc=input.daily_time_utc;
    }else{
      ensure(Object.keys(input).every(k=>['flow','device_name','trade_request','extension_dir'].includes(k)),'INVALID_PAIRING_REQUEST');
      if(input.extension_dir!==undefined)ensure(typeof input.extension_dir==='string'&&input.extension_dir.length>=1&&input.extension_dir.length<=300&&!/[\x00-\x1f\x7f]/.test(input.extension_dir),'INVALID_PAIRING_REQUEST');
      if(input.trade_request!==undefined){
        const r=input.trade_request;
        ensure(r&&typeof r==='object'&&Object.keys(r).sort().join(',')==='symbol,trace_id,window_days'&&typeof r.trace_id==='string'&&/^[-A-Za-z0-9:_]{1,200}$/.test(r.trace_id)&&/^[A-Z][A-Z0-9.-]{0,14}$/.test(r.symbol)&&Number.isInteger(r.window_days)&&r.window_days>=1&&r.window_days<=365,'INVALID_PAIRING_REQUEST');
        request.trade_request=r;
      }
      if(input.extension_dir!==undefined)request.extension_dir=input.extension_dir;
    }
    ensure(/^https?:\/\/[^/]+$/.test(meta.origin),'INVALID_PAIRING_ORIGIN');
    ensure(meta.ip===''||/^[0-9a-f.:]{1,45}$/i.test(meta.ip),'INVALID_PAIRING_ADDRESS');
    const deviceCode=randomBytes(32).toString('base64url');
    const base=meta.origin.replace(/\/+$/,'')+'/app#thot-pair=';
    return this.service.db.transaction(async tx=>{
      await this.rate(tx,'global',120);
      await tx.sql.query("DELETE FROM auth_access WHERE document->>'kind'='device_pairing' AND (document->>'expires_ms')::numeric<=$1",[this.now()]);
      const active=Number((await tx.sql.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='device_pairing'")).rows[0]!.count);
      ensure(active<2000,'PAIRING_SESSION_LIMIT',429);
      let userCode=newUserCode();
      for(let attempt=0;attempt<5&&await this.findByUserCode(tx,userCode);attempt++)userCode=newUserCode();
      ensure(await tx.maybe('auth_access',record(deviceCode))===undefined,'PAIRING_CODE_COLLISION');
      const at=this.service.now(),expiresAt=this.service.future(PAIRING_SECONDS);
      await tx.insert('auth_access',record(deviceCode),'network',{kind:'device_pairing',flow,...request,device_name:device,user_code:userCode,device_code_hash:hash(deviceCode),origin:meta.origin,request_ip:meta.ip,created_at:at,expires_at:expiresAt,expires_ms:Date.parse(expiresAt),interval:POLL_INTERVAL_SECONDS,status:'pending'});
      return {device_code:deviceCode,user_code:userCode,verification_uri:base,verification_uri_complete:base+userCode,interval:POLL_INTERVAL_SECONDS,expires_in:PAIRING_SECONDS};
    });
  }
  /** Helper poll. The issuance, once approved, is returned exactly once. */
  async token(deviceCode:unknown){
    ensure(typeof deviceCode==='string'&&/^[A-Za-z0-9_-]{43}$/.test(deviceCode),'PAIRING_NOT_FOUND',401);
    const id=record(deviceCode);
    return this.service.db.transaction(async tx=>{
      const current=await tx.maybe('auth_access',id);
      ensure(current?.kind==='device_pairing','PAIRING_NOT_FOUND',401);
      ensure(current.expires_ms>this.now(),'PAIRING_EXPIRED',410);
      const now=this.now();
      if(current.last_poll_ms!==undefined&&now-current.last_poll_ms<POLL_INTERVAL_SECONDS*1000-250)fail('PAIRING_SLOW_DOWN',429);
      current.last_poll_ms=now;
      const expires_in=Math.max(0,Math.ceil((current.expires_ms-now)/1000));
      if(current.status==='denied')fail('PAIRING_DENIED',403);
      if(current.status==='cancelled')fail('PAIRING_CANCELLED',403);
      if(current.status==='approved'){
        const issuance=current.issuance as Document|undefined;
        ensure(issuance&&typeof issuance==='object','PAIRING_APPROVAL_INCOMPLETE',503);
        current.status='delivered';current.delivered_at=this.service.now();
        // Keep only a non-secret trace of what left; the credential never repeats.
        current.issuance={delivered:true,device_id:issuance.device_id??null,job_id:issuance.job_id??null,account_id:issuance.account_id??null};
        await tx.update('auth_access',id,current);
        return {status:'approved',flow:current.flow,expires_in,...issuance};
      }
      if(current.status==='delivered')fail('PAIRING_ALREADY_DELIVERED',409);
      await tx.update('auth_access',id,current);
      return {status:'pending',interval:current.interval,expires_in};
    });
  }
  /** What the approval screen shows. Signed-in callers only; lookups are
   * per-account limited so codes cannot be enumerated at speed. */
  async info(actor:Actor,code:unknown){
    ensure(actor.role==='user','FORBIDDEN',403);
    const userCode=normalizeUserCode(code);
    ensure(validUserCode(userCode),'PAIRING_NOT_FOUND',404);
    return this.service.db.transaction(async tx=>{
      await this.rate(tx,'actor:'+actor.id,90);
      const found=await this.findByUserCode(tx,userCode);
      ensure(found,'PAIRING_NOT_FOUND',404);
      ensure(found.expires_ms>this.now(),'PAIRING_EXPIRED',410);
      const base:Document={status:found.status,flow:found.flow,device_name:found.device_name,request_ip:found.request_ip,created_at:found.created_at,expires_at:found.expires_at};
      if(found.client!==undefined)base.client=found.client;
      if(found.flow==='history')return {...base,history:{source_count:(found.source_ids as string[]).length,backfill:found.backfill,daily_time_utc:found.daily_time_utc}};
      if(found.flow==='robinhood'){
        const state=found.helper_state as Document|undefined;
        return {...base,robinhood:{trade:found.trade_request!==undefined,...(found.trade_request?{trade_request:found.trade_request}:{}),...(found.extension_dir?{extension_dir:found.extension_dir}:{}),stage:state?.stage??'helper_ready',...(state?.error?{error:state.error}:{}),...(state?.evidence?{evidence:state.evidence}:{}),saved:found.browser_saved===true}};
      }
      return base;
    });
  }
  /** Browser approval. Claims the code for one account, then runs the same
   * issuance the loopback approval would have created from the browser. */
  async approve(actor:Actor,key:string,code:unknown,body:Document){
    ensure(actor.role==='user','FORBIDDEN',403);
    const userCode=normalizeUserCode(code);
    ensure(validUserCode(userCode),'PAIRING_NOT_FOUND',404);
    const claimed=await this.service.db.transaction(async tx=>{
      await this.rate(tx,'actor:'+actor.id,90);
      const found=await this.findByUserCode(tx,userCode);
      ensure(found,'PAIRING_NOT_FOUND',404);
      ensure(found.expires_ms>this.now(),'PAIRING_EXPIRED',410);
      if(found.status==='denied')fail('PAIRING_DENIED',403);
      if(found.status!=='pending')fail('PAIRING_ALREADY_USED',409);
      found.status='approving';found.approved_by=actor.id;found.approved_at=this.service.now();
      await tx.update('auth_access',found.id,found);
      return found;
    });
    let issuance:Document;
    try{
      if(claimed.flow==='capture')issuance=await this.captureIssuance(actor,key,claimed,body);
      else if(claimed.flow==='history')issuance=await this.historyIssuance(actor,claimed,body);
      else issuance=await this.robinhoodIssuance(actor,key,claimed);
    }catch(error){
      // Leave the code usable: the failure is reported to the approver, whose
      // next attempt can succeed, and the helper keeps waiting as before.
      await this.service.db.transaction(async tx=>{
        const current=await tx.maybe('auth_access',claimed.id);
        if(current?.status==='approving'&&current.approved_by===actor.id){current.status='pending';delete current.approved_by;delete current.approved_at;await tx.update('auth_access',claimed.id,current);}
      }).catch(()=>{});
      throw error;
    }
    return this.service.db.transaction(async tx=>{
      const current=await tx.maybe('auth_access',claimed.id);
      ensure(current?.status==='approving'&&current.approved_by===actor.id,'PAIRING_ALREADY_USED',409);
      current.status='approved';current.issuance=issuance;
      await tx.update('auth_access',claimed.id,current);
      await tx.audit(actor.id,'DevicePairingApproved',{flow:current.flow});
      if(current.flow==='robinhood')return {status:'approved',job_id:issuance.job_id};
      const summary:Document={device_id:issuance.device_id??null,account_id:issuance.account_id??null,expires_at:issuance.expires_at,automatic_sales:issuance.automatic_sales===true,private_only:issuance.private_only===true};
      if(issuance.client!==undefined)summary.client=issuance.client;
      if(issuance.device_name!==undefined)summary.device_name=issuance.device_name;
      return {status:'approved',...summary};
    });
  }
  private async captureIssuance(actor:Actor,key:string,session:Document,body:Document){
    const {sale_policy_id,sale_policy_signature,rights_confirmed,model_output_licensed}=body;
    ensure(Object.keys(body).every(k=>['save_privately','sale_policy_id','sale_policy_signature','rights_confirmed','model_output_licensed'].includes(k)),'INVALID_DEVICE_CONNECTION');
    let salePolicyId:string|undefined;
    if(sale_policy_id!==undefined||sale_policy_signature!==undefined){
      ensure(typeof sale_policy_id==='string'&&typeof sale_policy_signature==='string','INVALID_STREAM_POLICY');
      ensure(rights_confirmed===true&&model_output_licensed===true,'STREAM_RIGHTS_REQUIRED');
      salePolicyId=(await this.thot.activateStream(actor,sale_policy_id,sale_policy_signature)).id;
    }else ensure(body.save_privately===undefined||body.save_privately===true,'STREAM_RIGHTS_REQUIRED');
    return await this.captureDevices.create(actor,{client:session.client,device_name:session.device_name,save_privately:!salePolicyId},{...(salePolicyId?{salePolicyId}:{})});
  }
  private async historyIssuance(actor:Actor,session:Document,body:Document){
    ensure(Object.keys(body).length===1&&body.consent==='private-history-upload-v1','HISTORY_CONSENT_REQUIRED');
    return await this.historyDevices.create(actor,{client:session.client,source_ids:session.source_ids,backfill:session.backfill,daily_time_utc:session.daily_time_utc,consent:body.consent});
  }
  private async robinhoodIssuance(actor:Actor,key:string,session:Document){
    const trade=session.trade_request!==undefined;
    const job:Document=trade?await this.tradeEvidence.begin(actor,key,session.trade_request as Document):await this.robinhood.begin(actor,key);
    ensure(typeof job.link_ticket==='string'&&typeof job.witness_url==='string'&&typeof job.appraiser_url==='string'&&/^https:\/\//.test(job.witness_url)&&/^https:\/\//.test(job.appraiser_url)&&typeof this.robinhood.publicKey==='string'&&(!trade||job.request&&typeof job.request==='object'),'PAIRING_APPROVAL_INCOMPLETE',503);
    return {job_id:job.job_id,account_id:actor.id,link_ticket:job.link_ticket,witness_url:job.witness_url,appraiser_url:job.appraiser_url,thot_public_key_pem:this.robinhood.publicKey,...(trade?{purpose:'traded' as const,request:job.request}:{})};
  }
  async deny(actor:Actor,code:unknown){
    ensure(actor.role==='user','FORBIDDEN',403);
    const userCode=normalizeUserCode(code);
    ensure(validUserCode(userCode),'PAIRING_NOT_FOUND',404);
    return this.service.db.transaction(async tx=>{
      await this.rate(tx,'actor:'+actor.id,90);
      const found=await this.findByUserCode(tx,userCode);
      ensure(found,'PAIRING_NOT_FOUND',404);
      ensure(found.expires_ms>this.now(),'PAIRING_EXPIRED',410);
      if(found.status==='denied')fail('PAIRING_DENIED',403);
      if(found.status!=='pending')fail('PAIRING_ALREADY_USED',409);
      found.status='denied';await tx.update('auth_access',found.id,found);
      await tx.audit(actor.id,'DevicePairingDenied',{flow:found.flow});
      return {status:'denied'};
    });
  }
  /** Browser-side stop. Before approval it is a refusal; afterwards it ends an
   * in-progress relay and the helper observes the cancellation. */
  async cancel(actor:Actor,key:string,code:unknown){
    ensure(actor.role==='user','FORBIDDEN',403);
    const userCode=normalizeUserCode(code);
    ensure(validUserCode(userCode),'PAIRING_NOT_FOUND',404);
    return this.service.db.command(actor.id,key,{action:'devicePairing.cancel',code:userCode},async tx=>{
      const found=await this.findByUserCode(tx,userCode);
      ensure(found,'PAIRING_NOT_FOUND',404);
      ensure(found.expires_ms>this.now(),'PAIRING_EXPIRED',410);
      ensure(found.status==='pending'||found.status==='approved'||found.status==='delivered','PAIRING_ALREADY_USED',409);
      found.status='cancelled';await tx.update('auth_access',found.id,found);
      return {status:'cancelled'};
    });
  }
  /** Robinhood completion signal: the browser saved the relayed proof. */
  async saved(actor:Actor,key:string,code:unknown){
    ensure(actor.role==='user','FORBIDDEN',403);
    const userCode=normalizeUserCode(code);
    ensure(validUserCode(userCode),'PAIRING_NOT_FOUND',404);
    return this.service.db.command(actor.id,key,{action:'devicePairing.saved',code:userCode},async tx=>{
      const found=await this.findByUserCode(tx,userCode);
      ensure(found,'PAIRING_NOT_FOUND',404);
      ensure(found.expires_ms>this.now(),'PAIRING_EXPIRED',410);
      ensure(found.flow==='robinhood','PAIRING_FLOW_UNSUPPORTED',409);
      ensure(found.browser_saved!==true,'PAIRING_ALREADY_SAVED',409);
      ensure((found.helper_state as Document|undefined)?.evidence!==undefined,'NO_PROOF',409);
      found.browser_saved=true;await tx.update('auth_access',found.id,found);
      return {status:'saved'};
    });
  }
  /** Helper-to-browser relay for the flow whose progress used to be read from
   * the loopback status endpoint. Each post also returns browser signals. */
  async events(deviceCode:unknown,event:Document){
    ensure(typeof deviceCode==='string'&&/^[A-Za-z0-9_-]{43}$/.test(deviceCode),'PAIRING_NOT_FOUND',401);
    const id=record(deviceCode);
    return this.service.db.transaction(async tx=>{
      const current=await tx.maybe('auth_access',id);
      ensure(current?.kind==='device_pairing','PAIRING_NOT_FOUND',401);
      ensure(current.expires_ms>this.now(),'PAIRING_EXPIRED',410);
      const now=this.now();
      if(current.status==='cancelled')return {status:'cancelled',saved:false,cancelled:true,expires_in:Math.max(0,Math.ceil((current.expires_ms-now)/1000))};
      ensure(current.flow==='robinhood','PAIRING_FLOW_UNSUPPORTED',409);
      ensure(current.status==='approved'||current.status==='delivered','PAIRING_NOT_APPROVED',409);
      if(current.last_event_ms!==undefined&&now-current.last_event_ms<750)fail('PAIRING_SLOW_DOWN',429);
      const keys=Object.keys(event).filter(k=>k!=='device_code');
      ensure(keys.length===1,'INVALID_PAIRING_EVENT');
      const state=(current.helper_state??{}) as Document;
      if(event.stage!==undefined){
        // After the proof arrives the helper keeps polling with a cheap
        // proof_ready heartbeat instead of re-sending the evidence envelope.
        ensure(keys[0]==='stage'&&typeof event.stage==='string'&&helperStages.has(event.stage)&&(state.evidence===undefined||event.stage==='proof_ready'),'INVALID_PAIRING_EVENT');
        state.stage=event.stage;
      }else if(event.error!==undefined){
        ensure(keys[0]==='error'&&typeof event.error==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(event.error),'INVALID_PAIRING_EVENT');
        state.error=event.error;
      }else{
        ensure(keys[0]==='evidence'&&event.evidence&&typeof event.evidence==='object'&&!Array.isArray(event.evidence)&&Object.keys(event.evidence).every(k=>['credential','witness_receipts'].includes(k))&&event.evidence.credential&&Array.isArray(event.evidence.witness_receipts),'INVALID_PAIRING_EVENT');
        ensure(JSON.stringify(event.evidence).length<=1_000_000,'CREDENTIAL_EVIDENCE_TOO_LARGE');
        state.evidence=event.evidence;state.stage='proof_ready';
      }
      current.helper_state=state;current.last_event_ms=now;
      await tx.update('auth_access',id,current);
      return {status:current.status,saved:current.browser_saved===true,cancelled:false,expires_in:Math.max(0,Math.ceil((current.expires_ms-now)/1000))};
    });
  }
}
