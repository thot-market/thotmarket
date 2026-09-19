import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {uuidv7} from '../../protocol/src/index.ts';
import {ensure,type Document,type Transaction} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';
import type {AgentCaptureIngestion} from './agent-capture.ts';
import {assertCaptureSaleAuthority} from './capture-sale-policy.ts';

const digest=(token:string)=>createHash('sha256').update(token).digest();
const recordId=(id:string)=>'capture-device:'+id;
const validId=(id:unknown)=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
/** Narrow capture delegation. Optional sales require a separate wallet-signed policy;
 * the device bearer cannot create or change its price, licence or seller identity. */
export class CaptureDevices {
  readonly service:ThotService;
  readonly ingestion:AgentCaptureIngestion;
  constructor(service:ThotService,ingestion:AgentCaptureIngestion){this.service=service;this.ingestion=ingestion;}
  async create(actor:Actor,input:Document,trusted:{salePolicyId?:string}={}){
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(Object.keys(input).every(k=>['client','device_name','save_privately'].includes(k))&&typeof input.save_privately==='boolean'&&input.save_privately===!trusted.salePolicyId,'INVALID_DEVICE_CONNECTION');
    ensure(['codex','claude'].includes(input.client),'INVALID_AGENT_CAPTURE_CLIENT');
    ensure(typeof input.device_name==='string'&&input.device_name.length>=1&&input.device_name.length<=80&&!/[\x00-\x1f\x7f]/.test(input.device_name),'INVALID_DEVICE_NAME');
    const id=uuidv7(),token=randomBytes(32).toString('base64url'),at=this.service.now(),expires=this.service.future(30*86400);
    await this.service.db.transaction(async tx=>{
      const owner=await tx.get('users',actor.id,actor.id);ensure(owner.role==='user'&&!owner.disabled,'AUTH_ACTOR_UNAVAILABLE',403);
      const devices=(await tx.list('auth_access',actor.id)).filter(d=>d.kind==='capture_device'&&!d.revoked_at&&d.expires_at>at);
      ensure(devices.length<40,'CAPTURE_DEVICE_LIMIT',409);
      if(trusted.salePolicyId){
        const policy=await tx.get('thot_records',trusted.salePolicyId,actor.id),wallet=await tx.get('thot_records','wallet:'+actor.id,actor.id);
        ensure(policy.kind==='stream_policy'&&policy.active===true&&!policy.revoked&&typeof policy.signature==='string'&&policy.authorization.validUntil>Math.floor(Date.parse(at)/1000)&&policy.authorization.seller.toLowerCase()===wallet.address.toLowerCase(),'CAPTURE_SALES_UNAVAILABLE');
        ensure(!policy.capture_device_id&&Date.parse(policy.created_at)+900000>Date.parse(at),'CAPTURE_POLICY_ALREADY_BOUND');
        const records=await tx.list('thot_records',actor.id),traces=await tx.list('traces',actor.id);
        ensure(!records.some(r=>r.stream_id===policy.id||r.sale_policy_id===policy.id)&&!traces.some(t=>t.sale_policy_id===policy.id),'CAPTURE_POLICY_ALREADY_BOUND');
        policy.capture_device_id=id;policy.capture_client=input.client;await tx.update('thot_records',policy.id,policy);
      }
      await tx.insert('auth_access',recordId(id),actor.id,{kind:'capture_device',device_id:id,client:input.client,device_name:input.device_name,token_hash:digest(token).toString('hex'),...(trusted.salePolicyId?{sale_policy_id:trusted.salePolicyId}:{}),created_at:at,last_used_at:at,expires_at:expires});
      await tx.audit(actor.id,'CaptureDeviceConnected',{device_id:id,client:input.client});
    });
    return {device_id:id,device_token:token,account_id:actor.id,client:input.client,device_name:input.device_name,expires_at:expires,automatic_sales:!!trusted.salePolicyId};
  }
  async active(tx:Transaction,id:string){
    ensure(validId(id),'INVALID_CAPTURE_DEVICE',401);
    const device=await tx.maybe('auth_access',recordId(id));
    ensure(device?.kind==='capture_device','INVALID_CAPTURE_DEVICE',401);
    ensure(!device.revoked_at,'CAPTURE_DEVICE_REVOKED',401);
    ensure(device.expires_at>this.service.now(),'CAPTURE_DEVICE_EXPIRED',401);
    const owner=await tx.maybe('users',device.owner_id);ensure(owner?.role==='user'&&!owner.disabled,'AUTH_ACTOR_UNAVAILABLE',403);
    const disabled=(await tx.sql.query("SELECT id FROM auth_access WHERE document->>'kind'='membership' AND document->'actor'->>'id'=$1 AND document->>'enabled'='false' LIMIT 1",[device.owner_id])).rows;
    ensure(!disabled.length,'AUTH_ACTOR_UNAVAILABLE',403);
    return device;
  }
  async authenticate(tx:Transaction,id:string,token:string){
    ensure(typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token),'INVALID_CAPTURE_DEVICE_TOKEN',401);
    const device=await this.active(tx,id),expected=Buffer.from(device.token_hash,'hex'),actual=digest(token);
    ensure(expected.length===actual.length&&timingSafeEqual(expected,actual),'INVALID_CAPTURE_DEVICE_TOKEN',401);return device;
  }
  async begin(id:string,token:string,input:Document){
    ensure(Object.keys(input).every(k=>['client','project'].includes(k)),'INVALID_DEVICE_CAPTURE');
    ensure(typeof input.project==='string'&&input.project.length>=1&&input.project.length<=120&&!/[\x00-\x1f\x7f]/.test(input.project),'INVALID_CAPTURE_PROJECT');
    const device=await this.service.db.transaction(tx=>this.authenticate(tx,id,token));
    ensure(input.client===device.client,'CAPTURE_DEVICE_CLIENT_MISMATCH',403);
    // An expired/stopped policy must not interrupt the user's coding work. Future
    // sessions fall back to private capture until a fresh connection is authorized.
    let salePolicyId:string|undefined;
    if(device.sale_policy_id)try{await this.service.db.transaction(tx=>assertCaptureSaleAuthority(tx,{owner_id:device.owner_id,capture_device_id:id,sale_policy_id:device.sale_policy_id},this.service.now()));salePolicyId=device.sale_policy_id;}catch(error){if((error as Error).message!=='CAPTURE_SALES_UNAVAILABLE')throw error;}
    const result=await this.ingestion.begin({id:device.owner_id,role:'user'},salePolicyId?{client:device.client,rights_confirmed:true,model_output_licensed:true}:{client:device.client,save_privately:true},salePolicyId?{salePolicyId,deviceId:id}:undefined);
    await this.service.db.transaction(async tx=>{
      const current=await this.authenticate(tx,id,token),capture=await tx.get('agent_captures',result.capture_id,device.owner_id);
      capture.device_id=id;
      if(salePolicyId){await assertCaptureSaleAuthority(tx,{owner_id:device.owner_id,capture_device_id:id,sale_policy_id:salePolicyId},this.service.now());capture.sale_policy_id=salePolicyId;}
      capture.context_ref=await this.service.privacy.seal(device.owner_id,{project:input.project});await tx.update('agent_captures',capture.capture_id,capture);
      current.last_used_at=this.service.now();current.expires_at=this.service.future(30*86400);await tx.update('auth_access',recordId(id),current);
    });
    return {...result,account_id:device.owner_id,device_id:id,client:device.client,project:input.project,automatic_sales:!!salePolicyId};
  }
  async list(actor:Actor){
    ensure(actor.role==='user','FORBIDDEN',403);
    return this.service.db.transaction(async tx=>({devices:(await tx.list('auth_access',actor.id)).filter(d=>d.kind==='capture_device').map(d=>({device_id:d.device_id,client:d.client,device_name:d.device_name,created_at:d.created_at,last_used_at:d.last_used_at,expires_at:d.expires_at,sale_policy_id:d.sale_policy_id??null,status:d.revoked_at?'DISCONNECTED':d.expires_at<=this.service.now()?'EXPIRED':'CONNECTED'}))}));
  }
  async revoke(actor:Actor,key:string,id:string){
    ensure(actor.role==='user','FORBIDDEN',403);ensure(validId(id),'INVALID_CAPTURE_DEVICE');
    return this.service.db.command(actor.id,key,{action:'disconnectCaptureDevice',id},async tx=>{
      const device=await tx.get('auth_access',recordId(id),actor.id);ensure(device.kind==='capture_device','NOT_FOUND',404);
      device.revoked_at??=this.service.now();await tx.update('auth_access',recordId(id),device);
      if(device.sale_policy_id){const p=await tx.get('thot_records',device.sale_policy_id,actor.id);ensure(p.capture_device_id===id,'CAPTURE_POLICY_BINDING_MISMATCH');p.active=false;p.revoked=true;await tx.update('thot_records',p.id,p);for(const listing of(await tx.list('thot_records',actor.id)).filter(r=>r.kind==='listing'&&r.stream_id===p.id)){listing.active=false;await tx.update('thot_records',listing.id,listing);}}
      await tx.audit(actor.id,'CaptureDeviceDisconnected',{device_id:id});return {device_id:id,status:'DISCONNECTED',sale_policy_id:device.sale_policy_id??null,notice:'New captures and new sale listings are stopped. A wallet revocation invalidates already prepared unfunded authorizations on chain; funded purchases keep their terms.'};
    });
  }
  async disconnect(id:string,token:string,key:string){const device=await this.service.db.transaction(tx=>this.authenticate(tx,id,token));return this.revoke({id:device.owner_id,role:'user'},key,id);}
}
