import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalHash, uuidv7, validateProvenanceReceipt } from '../../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import type { Actor, ThotService } from './service.ts';

export const OPENROUTER_RECORDING_NOTICE_VERSION='thot.openrouter-recording/2';
export const OPENROUTER_RECORDING_NOTICE='Requests sent through this relay use your OpenRouter key and are billed to your OpenRouter account. THOT stores their request and response content privately, including submitted conversation history and tool calls. Recording is automatic after this consent. When you also sign a connection-level sale policy, subsequent completed traces are automatically offered under that policy after content filtering. Without that separate signed policy they remain private. Recording alone does not grant rewards or prove human authorship. Disconnect revokes this relay token and removes the saved provider key. Existing recordings follow your vault retention and deletion settings. Cancellation may still incur provider charges. Disable automatic client retries or send an Idempotency-Key to avoid duplicate billing.';
const ENDPOINT='https://openrouter.ai/api/v1/chat/completions';
const REQUEST_MAX=4*1024*1024,RESPONSE_MAX=8*1024*1024,OWNER_MAX=128*1024*1024;
const configId=(owner:string)=>'openrouter-config:'+canonicalHash(owner);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const keyPattern=/^thot_or_[A-Za-z0-9_-]{43}$/;
const encoder=new TextEncoder();
const fields=new Set(['model','messages','stream','stream_options','max_tokens','max_completion_tokens','temperature','top_p','top_k','min_p','top_a','frequency_penalty','presence_penalty','repetition_penalty','seed','stop','response_format','tools','tool_choice','parallel_tool_calls','logprobs','top_logprobs','logit_bias','user','provider','models','route','reasoning','reasoning_effort','transforms','prediction','verbosity','service_tier','modalities','audio','cache_control','plugins','session_id','metadata','n']);
export type OpenRouterRelayOptions={enabled?:boolean;fingerprintSecret?:Buffer;transport?:typeof fetch;timeoutMs?:number;maxRequestBytes?:number;maxResponseBytes?:number;maxOwnerBytes?:number;maxOwnerConcurrency?:number;maxGlobalConcurrency?:number};
type Active={owner:string;controller:AbortController;done:Promise<void>};

function bodyError(code:string,requestId?:string){return {error:{message:code,type:'thot_relay_error',code},...(requestId?{thot_request_id:requestId}:{})};}
function publicError(code:string,status=409,id?:string){return new Response(JSON.stringify(bodyError(code,id)),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-should-retry':'false',...(id?{'x-thot-request-id':id}:{})}});}
function safeValue<T>(value:T,secrets:string[]):T {
  let text=JSON.stringify(value);for(const secret of secrets)if(secret)text=text.split(secret).join('[REDACTED_CREDENTIAL]');return JSON.parse(text);
}
// Keep requested routing aliases separate from the model named by OpenRouter's
// response. Missing response metadata is unknown, never filled from the request.
function metadataText(value:unknown,max=200):string|null{return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;}
function captureModel(request:Document,response:Document|undefined,status:string){return {source:'openrouter',requested_model:request.model,returned_model:metadataText(response?.model),provider_name:metadataText(response?.provider,100),capture_status:status};}
function validateRequest(input:Document,max:number):{body:Document;bytes:number} {
  ensure(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>fields.has(k)),'INVALID_OPENROUTER_REQUEST');
  const body=JSON.parse(JSON.stringify(input)),bytes=Buffer.byteLength(JSON.stringify(body));ensure(bytes<=max,'OPENROUTER_REQUEST_TOO_LARGE',413);
  ensure(typeof body.model==='string'&&/^~?[A-Za-z0-9][A-Za-z0-9._:/~-]{0,199}$/.test(body.model),'OPENROUTER_MODEL_REQUIRED');
  ensure(Array.isArray(body.messages)&&body.messages.length>0&&body.messages.length<=4096,'OPENROUTER_MESSAGES_REQUIRED');
  for(const m of body.messages)ensure(m&&typeof m==='object'&&!Array.isArray(m)&&['system','developer','user','assistant','tool','function'].includes(m.role)&&(typeof m.content==='string'||Array.isArray(m.content)||m.content===null||Array.isArray(m.tool_calls)),'INVALID_OPENROUTER_MESSAGE');
  ensure(body.stream===undefined||typeof body.stream==='boolean','INVALID_OPENROUTER_STREAM');
  ensure(body.n===undefined||body.n===1,'OPENROUTER_SINGLE_COMPLETION_REQUIRED');
  if(body.tools!==undefined)ensure(Array.isArray(body.tools)&&body.tools.length<=128,'INVALID_OPENROUTER_TOOLS');
  for(const name of ['max_tokens','max_completion_tokens'])if(body[name]!==undefined)ensure(Number.isSafeInteger(body[name])&&body[name]>0&&body[name]<=131072,'INVALID_OPENROUTER_TOKEN_LIMIT');
  if(body.stream){ensure(body.stream_options===undefined||(body.stream_options&&typeof body.stream_options==='object'&&!Array.isArray(body.stream_options)),'INVALID_OPENROUTER_STREAM_OPTIONS');body.stream_options={...body.stream_options,include_usage:true};}
  const finalBytes=Buffer.byteLength(JSON.stringify(body));ensure(finalBytes<=max,'OPENROUTER_REQUEST_TOO_LARGE',413);return {body,bytes:finalBytes};
}
export function openRouterMessageText(m:Document):string {
  let content=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map((part:Document)=>typeof part.text==='string'?part.text:'[Non-text content retained in private source]').join('\n'):'';
  const details=Object.fromEntries(['name','tool_call_id','tool_calls','function_call','reasoning','reasoning_details','refusal','annotations'].filter(key=>m[key]!==undefined&&(key!=='tool_calls'||m[key].length)).map(key=>[key,m[key]]));
  if(Object.keys(details).length)content+=(content?'\n':'')+'[Message metadata]\n'+JSON.stringify(details);
  return content||'[Empty message]';
}
function projection(request:Document,response:Document|undefined) {
  const turns=request.messages.map((m:Document)=>({role:m.role,content:openRouterMessageText(m)}));
  if(request.tools?.length)turns.unshift({role:'system',content:'[Available tool definitions]\n'+JSON.stringify(request.tools)});
  if(response?.choices?.[0]?.message)turns.push({role:'assistant',content:openRouterMessageText(response.choices[0].message)});
  if(!turns.length)turns.push({role:'user',content:'[Request has no user-visible text. Original request is retained privately.]'});
  return {turns};
}
function streamProjection():Document {return {choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[]},finish_reason:null}]};}
function collectStreamEvent(response:Document,event:Document){
  ensure(!event.error&&Array.isArray(event.choices),'OPENROUTER_STREAM_INVALID');
  for(const choice of event.choices){ensure(choice.index===0,'OPENROUTER_SINGLE_COMPLETION_REQUIRED');const delta=choice.delta??{},message=response.choices[0].message;
    if(typeof delta.content==='string')message.content+=delta.content;
    for(const field of ['reasoning','refusal'])if(typeof delta[field]==='string')message[field]=(message[field]??'')+delta[field];
    for(const field of ['reasoning_details','annotations'])if(Array.isArray(delta[field])){message[field]??=[];message[field].push(...delta[field]);}
    if(Array.isArray(delta.tool_calls))for(const tool of delta.tool_calls){ensure(Number.isSafeInteger(tool.index)&&tool.index>=0&&tool.index<128,'OPENROUTER_TOOL_INDEX');const prior=message.tool_calls[tool.index]??={id:'',type:'function',function:{name:'',arguments:''}};if(tool.id)prior.id+=tool.id;if(tool.type)prior.type=tool.type;if(tool.function?.name)prior.function.name+=tool.function.name;if(tool.function?.arguments)prior.function.arguments+=tool.function.arguments;}
    if(choice.finish_reason!==null&&choice.finish_reason!==undefined)response.choices[0].finish_reason=choice.finish_reason;
  }
  for(const field of ['id','model','provider','created','usage'])if(event[field]!==undefined)response[field]=event[field];
}
const sseData=(frame:string)=>frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');

/** Per-user BYOK Chat Completions relay. No provider retry; automatic offers require a separately signed connection policy. */
export class OpenRouterRelay {
  readonly service:ThotService;readonly enabled:boolean;
  private readonly send:typeof fetch;private readonly timeout:number;private readonly requestMax:number;private readonly responseMax:number;private readonly ownerMax:number;
  private readonly fingerprintSecret:Buffer;private readonly ownerConcurrency:number;private readonly globalConcurrency:number;private active=new Map<string,Active>();private closed=false;
  constructor(service:ThotService,options:OpenRouterRelayOptions={}){
    ensure(options.fingerprintSecret instanceof Uint8Array&&options.fingerprintSecret.length>=32,'OPENROUTER_FINGERPRINT_SECRET_REQUIRED');this.fingerprintSecret=Buffer.from(options.fingerprintSecret);
    this.service=service;this.enabled=options.enabled===true;this.send=options.transport??fetch;
    this.timeout=options.timeoutMs??180000;this.requestMax=options.maxRequestBytes??REQUEST_MAX;this.responseMax=options.maxResponseBytes??RESPONSE_MAX;this.ownerMax=options.maxOwnerBytes??OWNER_MAX;
    this.ownerConcurrency=options.maxOwnerConcurrency??2;this.globalConcurrency=options.maxGlobalConcurrency??8;
    for(const n of [this.timeout,this.requestMax,this.responseMax,this.ownerMax,this.ownerConcurrency,this.globalConcurrency])ensure(Number.isSafeInteger(n)&&n>0,'INVALID_OPENROUTER_LIMIT');
  }
  capabilities(){return {enabled:this.enabled,provider:'openrouter',notice_version:OPENROUTER_RECORDING_NOTICE_VERSION,notice:OPENROUTER_RECORDING_NOTICE,private_by_default:true,automatic_rewards:false,provenance:'P0_OPERATOR',request_limit_bytes:this.requestMax,response_limit_bytes:this.responseMax,retained_limit_bytes:this.ownerMax,concurrent_requests:this.ownerConcurrency};}
  private user(actor:Actor){ensure(actor.role==='user','FORBIDDEN',403);}
  private available(){ensure(this.enabled&&!this.closed,'OPENROUTER_RELAY_DISABLED',503);}
  /** HTTP preflight only; relay rechecks credentials before storing or spending. */
  async authorize(token:string):Promise<{owner_id:string}>{this.available();return this.service.db.transaction(async tx=>{const config=await this.authenticated(tx,token);return {owner_id:config.owner_id};});}
  async status(actor:Actor){this.user(actor);return this.service.db.transaction(async tx=>{
    const c=await tx.maybe('thot_records',configId(actor.id));const rows=(await tx.list('thot_records',actor.id)).filter(r=>r.kind==='openrouter-request');
    const requests:Document[]=[];for(const r of rows.slice(-50).reverse()){const trace=await tx.maybe('traces',r.trace_id);requests.push({...this.safeRequest(r),content_deleted:!trace||trace.deleted===true});}
    return {...this.capabilities(),connected:c?.active===true,token_id:c?.active?c.token_id:null,connected_at:c?.connected_at??null,sale_policy_id:c?.active?c.sale_policy_id??null:null,requests};
  });}
  async source(actor:Actor,requestId:string){
    this.user(actor);ensure(typeof requestId==='string'&&/^openrouter-request:[A-Za-z0-9-]{1,64}$/.test(requestId),'INVALID_OPENROUTER_REQUEST_ID');
    return this.service.db.transaction(async tx=>{
      const r=await tx.get('thot_records',requestId,actor.id);ensure(r.kind==='openrouter-request','NOT_FOUND',404);
      const trace=await tx.get('traces',r.trace_id,actor.id);ensure(!trace.deleted&&!trace.source_private_objects_deleted&&trace.retention_expires_at>this.service.now(),'OPENROUTER_RECORDING_DELETED',410);
      const request=(await this.service.privacy.open(actor.id,r.request_ref)).request;
      ensure(canonicalHash(request)===r.request_hash,'OPENROUTER_SOURCE_COMMITMENT_MISMATCH');
      const chunks:Buffer[]=[];let bytes=0;
      for(const part of r.parts){const data=await this.service.privacy.open(actor.id,part.ref);ensure(typeof data.bytes_b64==='string'&&hash(data.bytes_b64)===part.hash,'OPENROUTER_SOURCE_COMMITMENT_MISMATCH');const chunk=Buffer.from(data.bytes_b64,'base64');bytes+=chunk.length;ensure(bytes<=this.responseMax,'OPENROUTER_RESPONSE_TOO_LARGE');chunks.push(chunk);}
      const response=Buffer.concat(chunks),receipt=(await tx.get('provenance_receipts',trace.provenance_id,actor.id)).receipt;
      return {schema_version:'thot.openrouter-source/1',request_id:r.request_id,trace_id:r.trace_id,private:true,capture_model:trace.capture_model??null,request,
        response:{encoding:'base64',body_b64:response.toString('base64'),sha256:createHash('sha256').update(response).digest('hex'),content_type:r.stream?'text/event-stream':'application/json',provider_status:r.provider_status??null,complete:r.status==='COMPLETED',stored_bytes:bytes},receipt};
    });
  }
  private safeRequest(r:Document){return Object.fromEntries(['request_id','trace_id','status','model','requested_model','returned_model','provider_name','stream','created_at','finished_at','failure_code','stored_bytes','provider_status','usage'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));}
  async connect(actor:Actor,input:Document,trusted:{salePolicyId?:string}={}){
    this.user(actor);this.available();ensure(input&&Object.keys(input).length===3&&Object.keys(input).every(k=>['api_key','recording_consent','notice_version'].includes(k))&&input.recording_consent===true&&input.notice_version===OPENROUTER_RECORDING_NOTICE_VERSION,'OPENROUTER_RECORDING_CONSENT_REQUIRED');
    ensure(typeof input.api_key==='string'&&/^[A-Za-z0-9._-]{16,512}$/.test(input.api_key),'OPENROUTER_CREDENTIAL_REJECTED',409);
    const fingerprint=createHmac('sha256',this.fingerprintSecret).update(input.api_key).digest('hex'),bindingId='openrouter-key-binding:'+fingerprint;
    const token='thot_or_'+randomBytes(32).toString('base64url'),tokenId=uuidv7();let old:Document|undefined;
    await this.service.db.transaction(async tx=>{
      const user=await tx.get('users',actor.id,actor.id);ensure(user.role==='user'&&user.disabled!==true,'FORBIDDEN',403);const prior=await tx.maybe('thot_records',configId(actor.id));old=prior?.key_ref;
      if(trusted.salePolicyId){const policy=await tx.get('thot_records',trusted.salePolicyId,actor.id);ensure(!policy.capture_device_id,'CAPTURE_POLICY_ALREADY_BOUND',409);}
      // The database transaction holds the service lock across lookup and insert.
      // Bindings survive disconnect: rotating proxy tokens must not reset key ownership.
      const binding=await tx.maybe('thot_records',bindingId);
      ensure(!binding||binding.owner_id===actor.id,'OPENROUTER_CREDENTIAL_REJECTED',409);
      if(!binding)await tx.insert('thot_records',bindingId,actor.id,{kind:'openrouter-key-binding',version:1,created_at:this.service.now()});
      const keyRef=await this.service.privacy.seal(actor.id,{api_key:input.api_key});
      const record={kind:'openrouter-config',active:true,key_binding_version:1,...(trusted.salePolicyId?{sale_policy_id:trusted.salePolicyId}:{}),key_ref:keyRef,token_hash:hash(token),token_id:tokenId,notice_version:input.notice_version,connected_at:this.service.now()};
      if(prior)await tx.update('thot_records',configId(actor.id),record);else await tx.insert('thot_records',configId(actor.id),actor.id,record);
      await tx.audit(actor.id,'OpenRouterRecordingConnected',{token_id:tokenId,notice_version:input.notice_version});
    });
    for(const work of this.active.values())if(work.owner===actor.id)work.controller.abort();
    if(old)await this.service.privacy.remove(actor.id,old);
    return {connected:true,token,token_id:tokenId,shown_once:true,notice_version:OPENROUTER_RECORDING_NOTICE_VERSION};
  }
  async disconnect(actor:Actor){
    this.user(actor);let ref:Document|undefined;
    await this.service.db.transaction(async tx=>{const c=await tx.maybe('thot_records',configId(actor.id));if(c){ref=c.key_ref;c.active=false;delete c.key_ref;delete c.token_hash;c.disconnected_at=this.service.now();await tx.update('thot_records',c.id,c);await tx.audit(actor.id,'OpenRouterRecordingDisconnected',{token_id:c.token_id});}});
    const pending=[];for(const work of this.active.values())if(work.owner===actor.id){work.controller.abort();pending.push(work.done);}await Promise.allSettled(pending);
    if(ref)await this.service.privacy.remove(actor.id,ref);return {connected:false,recordings_deleted:false};
  }
  private async authenticated(tx:Transaction,token:string){
    ensure(typeof token==='string'&&keyPattern.test(token),'OPENROUTER_RELAY_UNAUTHENTICATED',401);
    const digest=hash(token),rows=await tx.sql.query("SELECT id,owner_id,document FROM thot_records WHERE document->>'kind'='openrouter-config' AND document->>'token_hash'=$1",[digest]);
    const row=rows.rows[0],c=row?{...row.document,id:row.id,owner_id:row.owner_id}:undefined;
    ensure(c?.active===true&&c.key_ref&&timingSafeEqual(Buffer.from(c.token_hash,'hex'),Buffer.from(digest,'hex')),'OPENROUTER_RELAY_UNAUTHENTICATED',401);
    const user=await tx.get('users',c.owner_id,c.owner_id);ensure(user.role==='user'&&user.disabled!==true,'OPENROUTER_RELAY_UNAUTHENTICATED',401);return c;
  }
  private receipt(traceId:string,sourceHash:string,started:string,finished:string,status:string){
    const receipt={schema_version:'trace.provenance/1',receipt_id:uuidv7(),trace_id:traceId,path:'operator_capture',confidence_tier:'P0_OPERATOR',temporal:{observed_start:started,observed_end:finished},commitments:{raw_trace_hash:sourceHash,source_bundle_hash:sourceHash},claims:['THOT recorded this owned request and the response bytes received by its fixed OpenRouter HTTPS relay.'],limitations:['Operator evidence only; no hardware attestation or provider-signed transcript is established.','Submitted history, tool results, user identity, human authorship and usefulness are not authenticated.','Recording does not authorize publication, sale, rewards or a refund of inference charges.',...(status==='COMPLETED'?[]:['The exchange is incomplete or failed; it is not a complete successful inference response.'])],verifier:{implementation:'thot-openrouter-relay',version:'1',verified_at:finished}};validateProvenanceReceipt(receipt);return receipt;
  }
  async relay(token:string,input:Document,options:{idempotencyKey?:string;signal?:AbortSignal}={}):Promise<Response>{
    this.available();const parsed=validateRequest(input,this.requestMax),requestHash=canonicalHash(parsed.body);
    if(options.idempotencyKey!==undefined)ensure(/^[A-Za-z0-9_.:-]{8,160}$/.test(options.idempotencyKey),'INVALID_OPENROUTER_IDEMPOTENCY_KEY');
    const controller=new AbortController();let state:Document,credential:string;
    const begun=await this.service.db.transaction(async tx=>{
      const c=await this.authenticated(tx,token),requestId=options.idempotencyKey?'openrouter-request:'+canonicalHash({owner:c.owner_id,key:options.idempotencyKey}):'openrouter-request:'+uuidv7();
      const prior=await tx.maybe('thot_records',requestId);
      if(prior){ensure(prior.request_hash===requestHash,'IDEMPOTENCY_CONFLICT',409);return {record:prior,replay:true};}
      const rows=(await tx.list('thot_records')).filter(r=>r.kind==='openrouter-request');
      const ownerRows=rows.filter(r=>r.owner_id===c.owner_id),running=rows.filter(r=>r.status==='INFLIGHT');
      ensure(running.filter(r=>r.owner_id===c.owner_id).length<this.ownerConcurrency&&running.length<this.globalConcurrency,'OPENROUTER_CONCURRENCY_LIMIT',429);
      ensure(ownerRows.filter(r=>r.created_at>this.service.future(-86400)).length<1000&&ownerRows.length<10000,'OPENROUTER_REQUEST_QUOTA',429);
      let used=0;for(const r of ownerRows){const t=await tx.maybe('traces',r.trace_id);if(t&&!t.source_private_objects_deleted)used+=r.status==='INFLIGHT'?r.reserved_bytes:r.stored_bytes;}
      // Covers the raw base64 response, replay, readable/scrubbed projections and
      // both request projections, not just the provider's wire bytes.
      const reserved=5*(parsed.bytes+this.responseMax);ensure(used+reserved<=this.ownerMax,'OPENROUTER_STORAGE_LIMIT',429);
      const traceId=uuidv7(),at=this.service.now(),requestRef=await this.service.privacy.seal(c.owner_id,{request:parsed.body}),content=projection(parsed.body,undefined),rawRef=await this.service.privacy.seal(c.owner_id,content),sourceHash=canonicalHash({request_id:requestId,request_hash:requestHash,status:'INFLIGHT'}),receipt=this.receipt(traceId,sourceHash,at,at,'INFLIGHT'),bundleId=uuidv7();
      await tx.insert('trace_bundles',bundleId,c.owner_id,{trace_id:traceId,source_bundle_hash:canonicalHash({request_id:requestId,request_hash:requestHash}),source_bundle_format:'thot.openrouter-request/1',object_ref:requestRef});
      await tx.insert('provenance_receipts',receipt.receipt_id,c.owner_id,{trace_id:traceId,receipt});
      await tx.insert('traces',traceId,c.owner_id,{trace_id:traceId,category:'general',source_bundle_hash:sourceHash,source_bundle_id:bundleId,provenance_id:receipt.receipt_id,raw_ref:rawRef,provenance_status:'OPERATOR_CAPTURED',rights_status:'pending',display_status:'PRIVATE',save_privately:true,credential_ids:[],outcome_ids:[],sale_count:0,deleted:false,created_at:at,observed_at:at,observed_end:at,retention_expires_at:this.service.future((this.service.config.privateRetentionDays??30)*86400),capture_preview:{title:'OpenRouter conversation',source:'OpenRouter relay',source_date:at,turn_count:content.turns.length,size_bytes:parsed.bytes},capture_model:captureModel(parsed.body,undefined,'INFLIGHT'),model_history:[],capture_state:'INFLIGHT',projection:{status:'PENDING'},openrouter_request_id:requestId,source_kind:'openrouter',...(c.sale_policy_id?{sale_policy_id:c.sale_policy_id,rights_confirmed:true,model_output_licensed:true}:{} )});
      const record={kind:'openrouter-request',...(c.sale_policy_id?{sale_policy_id:c.sale_policy_id}:{}),request_id:requestId,trace_id:traceId,token_id:c.token_id,request_hash:requestHash,request_ref:requestRef,parts:[],status:'INFLIGHT',stream:parsed.body.stream===true,model:parsed.body.model,requested_model:parsed.body.model,returned_model:null,provider_name:null,model_metadata_version:1,created_at:at,deadline:this.service.future(Math.ceil(this.timeout/1000)),reserved_bytes:reserved,stored_bytes:parsed.bytes+Buffer.byteLength(JSON.stringify(content))};
      await tx.insert('thot_records',requestId,c.owner_id,record);await tx.audit(c.owner_id,'OpenRouterRequestStarted',{request_id:requestId,trace_id:traceId,request_hash:requestHash});
      const secret=await this.service.privacy.open(c.owner_id,c.key_ref);return {record:{...record,owner_id:c.owner_id},replay:false,credential:secret.api_key};
    });
    state=begun.record;credential=begun.credential;
    if(begun.replay){return this.replay(state);}
    let finishActive!:()=>void;const done=new Promise<void>(resolve=>{finishActive=resolve;});this.active.set(state.request_id,{owner:state.owner_id,controller,done});
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeout),...(options.signal?[options.signal]:[])]);
    const finish=async(status:string,code?:string,response?:Document,replay?:string)=>{
      try{await this.finish(state.request_id,status,code,response,replay);return true;}
      catch{
        // Never repeat a billed request because a projection or vault write failed.
        // Preserve whatever encrypted source bytes are durable and fail closed.
        await this.service.db.transaction(async tx=>{const r=await tx.get('thot_records',state.request_id);if(r.status==='INFLIGHT'){r.status='INTERRUPTED';r.failure_code='OPENROUTER_CAPTURE_FINALIZATION_FAILED';r.finished_at=this.service.now();await tx.update('thot_records',r.id,r);const trace=await tx.get('traces',r.trace_id,r.owner_id);if(!trace.deleted){trace.projection={status:'UNREADABLE'};trace.capture_state='INTERRUPTED';await tx.update('traces',r.trace_id,trace);}}}).catch(()=>{});return false;
      }finally{this.active.delete(state.request_id);finishActive();}
    };
    let upstream:Response;
    try{
      this.available();signal.throwIfAborted();
      await this.service.db.transaction(async tx=>{const current=await this.authenticated(tx,token);ensure(current.token_id===state.token_id,'OPENROUTER_CAPTURE_REVOKED',409);});
      // Exactly one submission. Credentials and caller headers never enter trace metadata.
      upstream=await this.send(ENDPOINT,{method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json','Accept':state.stream?'text/event-stream':'application/json'},body:JSON.stringify(parsed.body)});
      await this.service.db.transaction(async tx=>{const r=await tx.get('thot_records',state.request_id);r.provider_status=upstream.status;await tx.update('thot_records',r.id,r);});
      if(!upstream.ok){
        // Keep bounded provider diagnostics encrypted; never forward them. Error
        // bodies can contain a provider's credential or other sensitive metadata.
        if(upstream.body){const reader=upstream.body.getReader();let size=0;try{while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.length;ensure(size<=this.responseMax,'OPENROUTER_RESPONSE_TOO_LARGE');await this.part(state.request_id,next.value);}}finally{await reader.cancel().catch(()=>{});}}
        await finish('FAILED','OPENROUTER_PROVIDER_REJECTED');return publicError('OPENROUTER_PROVIDER_REJECTED',409,state.request_id);
      }
      ensure(upstream.body,'OPENROUTER_EMPTY_RESPONSE',502);
      const type=upstream.headers.get('content-type')??'';ensure(type.startsWith(state.stream?'text/event-stream':'application/json'),'OPENROUTER_RESPONSE_TYPE',502);
    }catch{await finish('INTERRUPTED','OPENROUTER_OUTCOME_UNCERTAIN');return publicError('OPENROUTER_OUTCOME_UNCERTAIN',409,state.request_id);}
    const reader=upstream.body!.getReader(),chunks:Uint8Array[]=[],secrets=[credential,token];let bytes=0;
    const read=async()=>{signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(!next.done){bytes+=next.value.length;ensure(bytes<=this.responseMax,'OPENROUTER_RESPONSE_TOO_LARGE',413);chunks.push(next.value);await this.part(state.request_id,next.value);}return next;};
    if(!state.stream){try{
      while(!(await read()).done){};const value=safeValue(JSON.parse(Buffer.concat(chunks).toString('utf8')),secrets);
      ensure(!value.error&&Array.isArray(value.choices)&&value.choices.length===1&&value.choices[0]?.message?.role==='assistant'&&value.choices[0].finish_reason&&value.choices[0].finish_reason!=='error','OPENROUTER_PROVIDER_FAILED',502);
      const replay=JSON.stringify(value);ensure(await finish('COMPLETED',undefined,value,replay),'OPENROUTER_CAPTURE_FINALIZATION_FAILED');
      return new Response(replay,{headers:{'content-type':'application/json','cache-control':'no-store','x-thot-request-id':state.request_id,'x-thot-trace-id':state.trace_id}});
    }catch{await reader.cancel().catch(()=>{});await finish('INTERRUPTED','OPENROUTER_OUTCOME_UNCERTAIN');return publicError('OPENROUTER_OUTCOME_UNCERTAIN',409,state.request_id);}}
    const body=new ReadableStream<Uint8Array>({start:out=>{void(async()=>{
      let buffer='',complete=false,providerError=false;const decoder=new TextDecoder('utf-8',{fatal:true}),frames:string[]=[],response:Document=streamProjection();
      const frame=async(raw:string)=>{
        const data=sseData(raw);if(!data)return;
        if(data==='[DONE]'){complete=true;return;}
        const event=safeValue(JSON.parse(data),secrets);if(event.error){providerError=true;throw Error('OPENROUTER_PROVIDER_FAILED');}
        ensure(!complete,'OPENROUTER_STREAM_INVALID');collectStreamEvent(response,event);
        const encoded='data: '+JSON.stringify(event)+'\n\n';frames.push(encoded);out.enqueue(encoder.encode(encoded));
      };
      try{
        while(true){const next=await read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});ensure(buffer.length<=this.responseMax,'OPENROUTER_STREAM_INVALID');let at;while((at=buffer.search(/\r?\n\r?\n/))>=0){const match=buffer.slice(at).match(/^\r?\n\r?\n/)![0];await frame(buffer.slice(0,at));buffer=buffer.slice(at+match.length);}}
        buffer+=decoder.decode();if(buffer.trim())await frame(buffer);
        ensure(complete&&!providerError&&response.choices[0].finish_reason&&response.choices[0].finish_reason!=='error','OPENROUTER_STREAM_INTERRUPTED');
        response.choices[0].message.tool_calls=response.choices[0].message.tool_calls.filter(Boolean);
        const ending='data: [DONE]\n\n';ensure(await finish('COMPLETED',undefined,safeValue(response,secrets),frames.join('')+ending),'OPENROUTER_CAPTURE_FINALIZATION_FAILED');out.enqueue(encoder.encode(ending));out.close();
      }catch{
        await reader.cancel().catch(()=>{});await finish('INTERRUPTED','OPENROUTER_OUTCOME_UNCERTAIN',safeValue(response,secrets));
        try{out.enqueue(encoder.encode('data: '+JSON.stringify(bodyError('OPENROUTER_OUTCOME_UNCERTAIN',state.request_id))+'\n\ndata: [DONE]\n\n'));out.close();}catch{}
      }
    })();},cancel:async()=>{controller.abort();await reader.cancel().catch(()=>{});await done;}});
    return new Response(body,{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-thot-request-id':state.request_id,'x-thot-trace-id':state.trace_id}});
  }
  private async part(id:string,bytes:Uint8Array){await this.service.db.transaction(async tx=>{
    const r=await tx.get('thot_records',id),trace=await tx.get('traces',r.trace_id,r.owner_id),c=await tx.maybe('thot_records',configId(r.owner_id));
    ensure(r.status==='INFLIGHT'&&!trace.deleted&&c?.active&&c.token_id===r.token_id,'OPENROUTER_CAPTURE_REVOKED',409);ensure(r.parts.length<8192,'OPENROUTER_PART_LIMIT',429);
    const content={bytes_b64:Buffer.from(bytes).toString('base64')},ref=await this.service.privacy.seal(r.owner_id,content),bundle=uuidv7();
    await tx.insert('trace_bundles',bundle,r.owner_id,{trace_id:r.trace_id,source_bundle_hash:canonicalHash({request_id:id,part:r.parts.length,content_hash:canonicalHash(content)}),source_bundle_format:'thot.openrouter-response-part/1',object_ref:ref});
    r.parts.push({ref,hash:hash(content.bytes_b64)});r.stored_bytes+=Buffer.byteLength(JSON.stringify(content));await tx.update('thot_records',id,r);
  });}
  private async finish(id:string,status:string,code?:string,response?:Document,replay?:string){await this.service.db.transaction(async tx=>{
    const r=await tx.get('thot_records',id);if(r.status!=='INFLIGHT')return;
    const trace=await tx.get('traces',r.trace_id,r.owner_id);r.status=status;r.finished_at=this.service.now();if(code)r.failure_code=code;
    if(!trace.deleted){
      const request=(await this.service.privacy.open(r.owner_id,r.request_ref)).request,content=projection(request,response),sourceHash=canonicalHash({request_id:id,request_hash:r.request_hash,parts:r.parts.map((p:Document)=>p.hash),status}),receipt=this.receipt(trace.trace_id,sourceHash,r.created_at,r.finished_at,status);
      const ref=await this.service.privacy.seal(r.owner_id,content);trace.projection_refs??=[];trace.projection_refs.push(trace.raw_ref);trace.raw_ref=ref;
      trace.observed_end=r.finished_at;trace.updated_at=r.finished_at;trace.source_bundle_hash=sourceHash;trace.provenance_id=receipt.receipt_id;trace.projection={status:status==='COMPLETED'?'READY':'PARTIAL'};
      trace.capture_preview={...trace.capture_preview,turn_count:content.turns.length};trace.capture_state=status;
      trace.capture_model=captureModel(request,response,status);
      trace.model_history=trace.capture_model.returned_model?[{sequence:1,model:trace.capture_model.returned_model,requested_model:request.model,source:'openrouter_response'}]:[];
      trace.capture_summary={exchanges:1,completed:status==='COMPLETED'?1:0,interrupted:status==='COMPLETED'?0:1};
      r.requested_model=request.model;r.returned_model=trace.capture_model.returned_model;r.provider_name=trace.capture_model.provider_name;
      await tx.insert('provenance_receipts',receipt.receipt_id,r.owner_id,{trace_id:r.trace_id,receipt});
      if(status==='COMPLETED'){
        let assessment;
        try{assessment=await this.service.privacy.assess(trace.trace_id,content,'general',{rights_confirmed:!!r.sale_policy_id,model_output_licensed:!!r.sale_policy_id});}
        catch{trace.assessment_status='UNAVAILABLE';}
        if(assessment){
        await tx.insert('rights_assessments',assessment.rights.assessment_id,r.owner_id,{trace_id:r.trace_id,receipt:assessment.rights});
        await tx.insert('scrub_receipts',assessment.scrub.scrub_id,r.owner_id,{trace_id:r.trace_id,receipt:assessment.scrub});
        await tx.insert('trace_features',r.trace_id,r.owner_id,assessment.features);
        trace.scrub_ref=await this.service.privacy.seal(r.owner_id,assessment.content);trace.rights_id=assessment.rights.assessment_id;trace.scrub_id=assessment.scrub.scrub_id;trace.rights_status=assessment.rights.status;
        trace.import_content_hash=canonicalHash(content);trace.import_preview={title:'OpenRouter conversation',source_label:'OpenRouter relay',turn_count:content.turns.length,content_commitment:trace.import_content_hash};
        r.stored_bytes+=Buffer.byteLength(JSON.stringify(assessment.content));
        }
      }
      if(replay!==undefined){const ref=await this.service.privacy.seal(r.owner_id,{body:replay});r.response_ref=ref;await tx.insert('trace_bundles',uuidv7(),r.owner_id,{trace_id:r.trace_id,source_bundle_hash:canonicalHash({request_id:id,replay_hash:hash(replay)}),source_bundle_format:'thot.openrouter-replay/1',object_ref:ref});r.stored_bytes+=Buffer.byteLength(replay);}
      r.stored_bytes+=Buffer.byteLength(JSON.stringify(content));
      if(response?.usage){const usage=response.usage;r.usage=Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','cost'].filter(k=>typeof usage[k]==='number'&&Number.isFinite(usage[k])&&usage[k]>=0).map(k=>[k,usage[k]]));}
      await tx.update('traces',r.trace_id,trace);
    }
    await tx.update('thot_records',id,r);await tx.audit(r.owner_id,'OpenRouterRequestFinished',{request_id:id,trace_id:r.trace_id,status});
  });}
  private async replay(r:Document):Promise<Response>{return this.service.db.transaction(async tx=>{
    const trace=await tx.get('traces',r.trace_id,r.owner_id);ensure(!trace.deleted&&trace.retention_expires_at>this.service.now(),'OPENROUTER_RECORDING_DELETED',410);
    if(r.status!=='COMPLETED'||!r.response_ref)return publicError('OPENROUTER_REQUEST_ALREADY_SUBMITTED',409,r.request_id);
    const content=await this.service.privacy.open(r.owner_id,r.response_ref);
    return new Response(content.body,{headers:{'content-type':r.stream?'text/event-stream':'application/json','cache-control':'no-store','x-thot-request-id':r.request_id,'x-thot-trace-id':r.trace_id,'x-thot-replayed':'true'}});
  });}
  async recover(){
    // Backfill existing encrypted connections before accepting requests. No raw
    // key, stable fingerprint or conflicting wallet is exposed by status/audit.
    await this.service.db.transaction(async tx=>{
      const configs=(await tx.list('thot_records')).filter(row=>row.kind==='openrouter-config'&&row.active&&row.key_ref&&row.key_binding_version!==1);
      for(const config of configs){
        const saved=await this.service.privacy.open(config.owner_id,config.key_ref);
        const fingerprint=createHmac('sha256',this.fingerprintSecret).update(saved.api_key).digest('hex'),bindingId='openrouter-key-binding:'+fingerprint;
        const binding=await tx.maybe('thot_records',bindingId);
        if(binding&&binding.owner_id!==config.owner_id){config.active=false;delete config.token_hash;}
        else if(!binding)await tx.insert('thot_records',bindingId,config.owner_id,{kind:'openrouter-key-binding',version:1,created_at:this.service.now()});
        config.key_binding_version=1;await tx.update('thot_records',config.id,config);
      }
    });
    // Upgrade retained captures from before model metadata was indexed. Read the
    // already encrypted response; no network generation, sale authorization, or
    // signed listing snapshot is created or changed by this migration.
    const legacy=await this.service.db.transaction(async tx=>(await tx.sql.query("SELECT id,owner_id,document FROM thot_records WHERE document->>'kind'='openrouter-request' AND document->>'status'='COMPLETED' AND document ? 'response_ref' AND COALESCE(document->>'model_metadata_version','') <> '1' LIMIT 100")).rows.map(row=>({...row.document,id:row.id,owner_id:row.owner_id})));
    for(const record of legacy){
      try{
        const trace=await this.service.db.transaction(tx=>tx.get('traces',record.trace_id,record.owner_id));
        if(trace.deleted||trace.retention_expires_at<=this.service.now())continue;
        const request=(await this.service.privacy.open(record.owner_id,record.request_ref)).request,stored=await this.service.privacy.open(record.owner_id,record.response_ref);
        ensure(typeof stored.body==='string'&&Buffer.byteLength(stored.body)<=this.responseMax*2,'OPENROUTER_RESPONSE_TOO_LARGE');
        let response:Document;
        if(record.stream){response=streamProjection();for(const frame of stored.body.split(/\r?\n\r?\n/)){const data=sseData(frame);if(data&&data!=='[DONE]')collectStreamEvent(response,JSON.parse(data));}}
        else response=JSON.parse(stored.body);
        const metadata=captureModel(request,response,'COMPLETED');
        await this.service.db.transaction(async tx=>{
          const r=await tx.get('thot_records',record.id),t=await tx.get('traces',record.trace_id,record.owner_id);if(r.model_metadata_version===1||t.deleted)return;
          t.capture_model=metadata;t.model_history=metadata.returned_model?[{sequence:1,model:metadata.returned_model,requested_model:request.model,source:'openrouter_response'}]:[];
          t.capture_summary??={exchanges:1,completed:1,interrupted:0};
          r.requested_model=request.model;r.returned_model=metadata.returned_model;r.provider_name=metadata.provider_name;r.model_metadata_version=1;
          await tx.update('traces',t.trace_id,t);await tx.update('thot_records',r.id,r);
        });
      }catch{/* Missing/deleted private objects remain unknown; never call a provider to reconstruct them. */}
    }
    const rows=await this.service.db.transaction(async tx=>(await tx.list('thot_records')).filter(r=>r.kind==='openrouter-request'&&r.status==='INFLIGHT'));
    for(const record of rows)if(!this.active.has(record.id)){
      let response:Document|undefined;
      try{
        // Only decode bytes already stored before the crash. Never retry billing,
        // even when a complete upstream result may have existed before shutdown.
        const chunks=[];let bytes=0;
        for(const part of record.parts){const data=await this.service.privacy.open(record.owner_id,part.ref),chunk=Buffer.from(data.bytes_b64,'base64');bytes+=chunk.length;ensure(bytes<=this.responseMax,'OPENROUTER_RESPONSE_TOO_LARGE');chunks.push(chunk);}
        const text=Buffer.concat(chunks).toString('utf8');
        if(record.stream){response=streamProjection();for(const frame of text.split(/\r?\n\r?\n/).slice(0,-1)){const data=sseData(frame);if(!data||data==='[DONE]')continue;try{collectStreamEvent(response,JSON.parse(data));}catch{break;}}}
        else{const parsed=JSON.parse(text);if(parsed?.choices?.[0]?.message)response=parsed;}
      }catch{/* Durable partial source remains available even if its projection cannot parse. */}
      await this.finish(record.id,'INTERRUPTED','OPENROUTER_RESTART_OUTCOME_UNCERTAIN',response);
    }
  }
  async close(){if(this.closed)return;this.closed=true;const work=[...this.active.values()];for(const request of work)request.controller.abort();await Promise.allSettled(work.map(r=>r.done));}
}
