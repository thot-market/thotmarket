import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {uuidv7} from '../../protocol/src/index.ts';
import {ensure,type Document,type Transaction} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';
import type {ContributorPortfolio} from './contributor-portfolio.ts';
import {parseCodingSessionJsonl} from './history-import.ts';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const record=(id:string)=>'history-device:'+id;
const idValid=(id:unknown)=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const hex=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Upload-only consent. These grants can never use live capture, browse the
 * vault, prepare rights, or authorize a listing. Paths remain on the computer. */
export class HistoryDevices {
  readonly service:ThotService;readonly portfolio:ContributorPortfolio;
  constructor(service:ThotService,portfolio:ContributorPortfolio){this.service=service;this.portfolio=portfolio;}
  async create(actor:Actor,input:Document){
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(Object.keys(input).every(k=>['client','source_ids','backfill','consent','daily_time_utc'].includes(k)),'INVALID_HISTORY_CONNECTION');
    ensure(['claude','codex'].includes(input.client)&&input.consent==='private-history-upload-v1'&&typeof input.backfill==='boolean','HISTORY_CONSENT_REQUIRED');
    ensure(Array.isArray(input.source_ids)&&input.source_ids.length>0&&input.source_ids.length<=10&&input.source_ids.every((s:unknown)=>typeof s==='string'&&/^[a-f0-9]{32}$/.test(s))&&new Set(input.source_ids).size===input.source_ids.length,'INVALID_HISTORY_SOURCES');
    ensure(typeof input.daily_time_utc==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(input.daily_time_utc),'INVALID_HISTORY_SCHEDULE');
    const id=uuidv7(),token=randomBytes(32).toString('base64url'),at=this.service.now(),expires=this.service.future(30*86400);
    await this.service.db.transaction(async tx=>{
      const owner=await tx.get('users',actor.id,actor.id);ensure(owner.role==='user'&&!owner.disabled,'AUTH_ACTOR_UNAVAILABLE',403);
      const devices=(await tx.list('auth_access',actor.id)).filter(d=>d.kind==='history_device'&&!d.revoked_at&&d.expires_at>at);
      ensure(devices.length<20,'HISTORY_DEVICE_LIMIT',409);
      await tx.insert('auth_access',record(id),actor.id,{kind:'history_device',device_id:id,client:input.client,source_ids:input.source_ids,backfill:input.backfill,daily_time_utc:input.daily_time_utc,consent:input.consent,token_hash:hash(token),created_at:at,last_used_at:at,expires_at:expires,paused:false});
      await tx.audit(actor.id,'HistoryDeviceConnected',{device_id:id,client:input.client});
    });
    return {device_id:id,device_token:token,account_id:actor.id,client:input.client,source_ids:input.source_ids,backfill:input.backfill,daily_time_utc:input.daily_time_utc,expires_at:expires,private_only:true};
  }
  async authenticate(tx:Transaction,id:string,token:string,upload=false){
    ensure(idValid(id)&&typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token),'INVALID_HISTORY_DEVICE',401);
    const device=await tx.maybe('auth_access',record(id));ensure(device?.kind==='history_device','INVALID_HISTORY_DEVICE',401);
    const actual=Buffer.from(hash(token),'hex'),expected=Buffer.from(device.token_hash,'hex');ensure(actual.length===expected.length&&timingSafeEqual(actual,expected),'INVALID_HISTORY_DEVICE',401);
    ensure(!device.revoked_at,'HISTORY_DEVICE_REVOKED',401);ensure(device.expires_at>this.service.now(),'HISTORY_DEVICE_EXPIRED',401);
    const owner=await tx.maybe('users',device.owner_id);ensure(owner?.role==='user'&&!owner.disabled,'AUTH_ACTOR_UNAVAILABLE',403);
    const disabled=(await tx.sql.query("SELECT id FROM auth_access WHERE document->>'kind'='membership' AND document->'actor'->>'id'=$1 AND document->>'enabled'='false' LIMIT 1",[device.owner_id])).rows;
    ensure(!disabled.length,'AUTH_ACTOR_UNAVAILABLE',403);if(upload)ensure(!device.paused,'HISTORY_DEVICE_PAUSED',409);return device;
  }
  private summary(d:Document){return {device_id:d.device_id,client:d.client,source_count:d.source_ids.length,backfill:d.backfill,daily_time_utc:d.daily_time_utc,created_at:d.created_at,last_used_at:d.last_used_at,last_saved_at:d.last_saved_at??null,expires_at:d.expires_at,private_only:true,status:d.revoked_at?'DISCONNECTED':d.expires_at<=this.service.now()?'EXPIRED':d.paused?'PAUSED':'CONNECTED'};}
  async status(id:string,token:string){return this.service.db.transaction(async tx=>{const device=await this.authenticate(tx,id,token);return {...this.summary(device),account_id:device.owner_id};});}
  async list(actor:Actor){ensure(actor.role==='user','FORBIDDEN',403);return this.service.db.transaction(async tx=>({devices:(await tx.list('auth_access',actor.id)).filter(d=>d.kind==='history_device').map(d=>this.summary(d))}));}
  async update(actor:Actor,key:string,id:string,action:'pause'|'resume'|'disconnect'){
    ensure(actor.role==='user','FORBIDDEN',403);ensure(idValid(id),'INVALID_HISTORY_DEVICE');
    return this.service.db.command(actor.id,key,{action:'history-device-'+action,id},async tx=>{
      const d=await tx.get('auth_access',record(id),actor.id);ensure(d.kind==='history_device','NOT_FOUND',404);
      if(action==='disconnect')d.revoked_at??=this.service.now();else{ensure(!d.revoked_at&&d.expires_at>this.service.now(),'HISTORY_DEVICE_UNAVAILABLE',409);d.paused=action==='pause';}
      await tx.update('auth_access',record(id),d);await tx.audit(actor.id,'HistoryDeviceUpdated',{device_id:id,action});return this.summary(d);
    });
  }
  async control(id:string,token:string,key:string,action:'pause'|'resume'|'disconnect'){
    const d=await this.service.db.transaction(tx=>this.authenticate(tx,id,token));return this.update({id:d.owner_id,role:'user'},key,id,action);
  }
  async import(id:string,token:string,input:Document){
    ensure(Object.keys(input).every(k=>['source_id','file_id','version_id','previous_version_id','text'].includes(k)),'INVALID_HISTORY_UPLOAD');
    ensure(typeof input.source_id==='string'&&/^[a-f0-9]{32}$/.test(input.source_id)&&hex(input.file_id)&&hex(input.version_id)&&(input.previous_version_id===undefined||hex(input.previous_version_id))&&typeof input.text==='string','INVALID_HISTORY_UPLOAD');
    ensure(hash(input.text)===input.version_id,'HISTORY_VERSION_MISMATCH',409);
    const device=await this.service.db.transaction(tx=>this.authenticate(tx,id,token,true));
    ensure(device.source_ids.includes(input.source_id),'HISTORY_SOURCE_NOT_AUTHORIZED',403);
    const parsed=parseCodingSessionJsonl(input.text);ensure(device.client==='claude'?parsed.source.format==='claude-code-jsonl':parsed.source.format==='codex-jsonl'||parsed.source.format==='codex-exec-jsonl','HISTORY_CLIENT_MISMATCH',403);
    const authorize=async(tx:Transaction)=>{const current=await this.authenticate(tx,id,token,true);ensure(current.source_ids.includes(input.source_id),'HISTORY_SOURCE_NOT_AUTHORIZED',403);};
    const historySync={device_id:id,source_id:input.source_id,file_id:input.file_id,version_id:input.version_id,...(input.previous_version_id?{previous_version_id:input.previous_version_id}:{})};
    const result=await this.portfolio.import({id:device.owner_id,role:'user'},'history:'+id+':'+input.version_id,{text:input.text,filename:'selected-history.jsonl',content_commitment:parsed.preview.content_commitment,save_privately:true},{authorize,historySync});
    await this.service.db.transaction(async tx=>{const current=await this.authenticate(tx,id,token,true);current.last_used_at=this.service.now();current.last_saved_at=this.service.now();current.expires_at=this.service.future(30*86400);await tx.update('auth_access',record(id),current);});
    // Do not return the portfolio item: a duplicate may refer to an existing
    // private trace whose preview this upload-only bearer cannot read.
    return {trace_id:result.trace_id,status:result.status,duplicate:result.duplicate===true,version_id:input.version_id,private_only:true};
  }
}
