import {CAPTURE_REQUEST_BYTES,CAPTURE_PART_JSON_BYTES,CAPTURE_MAX_EXCHANGES,CAPTURE_STORAGE_BYTES} from '../../capture/src/limits.ts';
import {verifyRecorder,verifySeal,type RecorderPolicy} from '../../capture/src/tee/attestation.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { canonicalHash, uuidv7, validateProvenanceReceipt } from '../../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import type { Actor, ThotService } from './service.ts';
import { projectCapture } from './capture-projection.ts';

export interface ProxyCaptureBundle {format:'thot.proxy-capture/1';capture_id:string;client:'codex'|'claude';started_at:string;finished_at:string;exchanges:Document[];root:string}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const exact=(value:Document,keys:string[],code:string)=>ensure(Object.keys(value).length===keys.length&&Object.keys(value).every(k=>keys.includes(k)),code);
const fields=(value:Document,required:string[],optional:string[],code:string)=>ensure(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)),code);
const timestamp=(value:unknown,code:string)=>{ensure(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)&&Number.isFinite(Date.parse(value)),code);return value;};
function bytes(value:unknown,code:string){ensure(typeof value==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(value)&&value.length%4===0,code);const decoded=Buffer.from(value,'base64');ensure(decoded.toString('base64')===value,code);return decoded;}
function requestBytes(exchange:Document){const raw=bytes(exchange.request_body_b64,'INVALID_REQUEST_BODY_BASE64'),encoding=exchange.request_encoding??'identity';try{return encoding==='gzip'?gunzipSync(raw,{maxOutputLength:CAPTURE_REQUEST_BYTES}):encoding==='zstd'?zstdDecompressSync(raw,{maxOutputLength:CAPTURE_REQUEST_BYTES}):raw;}catch{throw new Error('INVALID_COMPRESSED_REQUEST_BODY');}}

export class AgentCaptureIngestion {
  readonly service:ThotService;
  readonly recorderPolicy?:RecorderPolicy;
  deviceActive?:(tx:Transaction,id:string)=>Promise<Document>;
  constructor(service:ThotService, recorderPolicy?:RecorderPolicy) {this.service=service;this.recorderPolicy=recorderPolicy;}

  async begin(actor:Actor,input:Document,trusted?:{salePolicyId:string;deviceId:string}) {
    ensure(actor.role==='user','FORBIDDEN',403);
    const privateCapture=Object.hasOwn(input,'save_privately');
    if(privateCapture){exact(input,['client','save_privately'],'INVALID_AGENT_CAPTURE_BEGIN');ensure(input.save_privately===true,'PRIVATE_CAPTURE_CONFIRMATION_REQUIRED');}
    else{exact(input,['client','rights_confirmed','model_output_licensed'],'INVALID_AGENT_CAPTURE_BEGIN');ensure(input.rights_confirmed===true,'CAPTURE_RIGHTS_CONFIRMATION_REQUIRED');ensure(typeof input.model_output_licensed==='boolean','CAPTURE_OUTPUT_CHOICE_REQUIRED');}
    ensure(input.client==='codex'||input.client==='claude','INVALID_AGENT_CAPTURE_CLIENT');
    ensure(!trusted||!privateCapture,'INVALID_CAPTURE_SALE_POLICY');
    const consent=privateCapture?{save_privately:true,rights_confirmed:false,model_output_licensed:false}:{rights_confirmed:true,model_output_licensed:input.model_output_licensed,...(trusted?{sale_policy_id:trusted.salePolicyId,capture_device_id:trusted.deviceId}:{})};
    const token=randomBytes(32).toString('base64url'),captureId=uuidv7(),createdAt=this.service.now(),expiresAt=this.service.future(86400);
    await this.service.db.transaction(async tx=>{await tx.insert('agent_captures',captureId,actor.id,{capture_id:captureId,client:input.client,token_hash:sha(token),created_at:createdAt,expires_at:expiresAt,status:'AWAITING_UPLOAD',requires_tee:!!this.recorderPolicy,consent_hash:canonicalHash(consent),rights_confirmed:consent.rights_confirmed,save_privately:privateCapture,model_output_licensed:consent.model_output_licensed});await tx.audit(actor.id,'AgentCaptureBegun',{capture_id:captureId,client:input.client});});
    return {capture_id:captureId,upload_token:token,expires_at:expiresAt};
  }

  async authenticate(captureId:string,token:string) {
    ensure(typeof captureId==='string'&&captureId.length>0&&typeof token==='string'&&token.length>=40&&token.length<=80,'INVALID_CAPTURE_TOKEN',401);
    return this.service.db.transaction(async tx=>{const capture=await tx.maybe('agent_captures',captureId);ensure(capture,'INVALID_CAPTURE_TOKEN',401);const actual=Buffer.from(sha(token),'hex'),expected=Buffer.from(capture.token_hash,'hex');ensure(actual.length===expected.length&&timingSafeEqual(actual,expected),'INVALID_CAPTURE_TOKEN',401);ensure(capture.expires_at>this.service.now(),'CAPTURE_TOKEN_EXPIRED',401);return capture;});
  }

  async authorize(captureId:string,token:string){const c=await this.authenticate(captureId,token);if(c.device_id){ensure(this.deviceActive,'CAPTURE_DEVICE_CHECK_UNAVAILABLE',503);await this.service.db.transaction(tx=>this.deviceActive!(tx,c.device_id));}ensure(c.requires_tee,'TEE_CAPTURE_NOT_CONFIGURED',409);return {capture_id:c.capture_id,client:c.client,consent_hash:c.consent_hash,status:c.status,expires_at:c.expires_at};}

  async part(captureId:string,token:string,key:string,input:Document) {
    exact(input,['part'],'INVALID_CAPTURE_PART');const capture=await this.authenticate(captureId,token),part=input.part;
    ensure(part&&Number.isSafeInteger(part.sequence)&&part.sequence>=1&&part.sequence<=CAPTURE_MAX_EXCHANGES,'INVALID_EXCHANGE_SEQUENCE');
    const base={format:'thot.proxy-capture/1' as const,capture_id:captureId,client:capture.client,started_at:capture.created_at,finished_at:this.service.now(),exchanges:[part]};
    validateBundle({...base,root:''} as any,capture,this.service.now(),part.sequence-1,true);
    const size=Buffer.byteLength(JSON.stringify(part));
    const inspect=async(tx:Transaction)=>{
      const current=await this.current(tx,captureId,capture.owner_id),previous=current.parts?.[String(part.sequence)];
      if(current.result?.trace_id){
        const trace=await tx.get('traces',current.result.trace_id,current.owner_id);
        ensure(!trace.deleted&&!trace.source_private_objects_deleted&&trace.retention_expires_at>this.service.now(),'CAPTURE_CONTENT_UNAVAILABLE',410);
      }
      if(previous){ensure(previous.commitment===part.commitment,'CAPTURE_PART_CONFLICT',409);return {current,duplicate:true};}
      ensure(current.status==='AWAITING_UPLOAD','AGENT_CAPTURE_ALREADY_COMPLETED',409);
      ensure((current.part_bytes??0)+size<=CAPTURE_STORAGE_BYTES,'THOT_CAPTURE_STORAGE_FULL',409);
      return {current,duplicate:false};
    };
    return this.service.staged.run(capture.owner_id,key,{action:'capturePart',capture_id:captureId,sequence:part.sequence,commitment:part.commitment},'part',async stage=>{
      if((await this.service.db.transaction(inspect)).duplicate)return async tx=>{ensure((await inspect(tx)).duplicate,'STAGED_STATE_CHANGED',409);return {sequence:part.sequence,commitment:part.commitment,stored:true};};
      const ref=await stage.seal(part);
      return async tx=>{
        const {current,duplicate}=await inspect(tx);
        if(duplicate){stage.discard();return {sequence:part.sequence,commitment:part.commitment,stored:true};}
        current.parts??={};current.parts[String(part.sequence)]={object_ref:ref,commitment:part.commitment,size};current.part_bytes=(current.part_bytes??0)+size;current.last_part_at=this.service.now();
        await tx.update('agent_captures',captureId,current);return {sequence:part.sequence,commitment:part.commitment,stored:true};
      };
    });
  }

  private async current(tx:Transaction,id:string,owner:string){
    const capture=await tx.get('agent_captures',id,owner);
    ensure(capture.expires_at>this.service.now(),'CAPTURE_TOKEN_EXPIRED',401);
    if(capture.device_id){ensure(this.deviceActive,'CAPTURE_DEVICE_CHECK_UNAVAILABLE',503);await this.deviceActive(tx,capture.device_id);}
    return capture;
  }

  async complete(captureId:string,token:string,key:string,input:Document) {
    try{return await this.save(captureId,token,key,input,true);}catch(error){await this.failed(captureId,token,error);throw error;}
  }

  async checkpoint(captureId:string,token:string,key:string,input:Document) {
    ensure(input.bundle?.format==='thot.proxy-capture/2','CHECKPOINT_MANIFEST_REQUIRED');
    try{return await this.save(captureId,token,key,input,false);}catch(error){await this.failed(captureId,token,error);throw error;}
  }

  private async failed(captureId:string,token:string,error:unknown){
    try{const authorized=await this.authenticate(captureId,token);await this.service.db.transaction(async tx=>{const capture=await tx.get('agent_captures',captureId,authorized.owner_id);capture.last_error_code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'CAPTURE_SAVE_FAILED';capture.last_error_at=this.service.now();await tx.update('agent_captures',captureId,capture);await tx.audit(authorized.owner_id,'AgentCaptureSaveFailed',{capture_id:captureId,error_code:capture.last_error_code});});}catch{/* Do not expose or alter a capture for an invalid bearer. */}
  }

  async heartbeat(captureId:string,token:string){const c=await this.authenticate(captureId,token);return this.service.db.transaction(async tx=>{if(c.device_id){ensure(this.deviceActive,'CAPTURE_DEVICE_CHECK_UNAVAILABLE',503);await this.deviceActive(tx,c.device_id);}const capture=await tx.get('agent_captures',captureId,c.owner_id);capture.last_heartbeat_at=this.service.now();await tx.update('agent_captures',captureId,capture);return {capture_id:captureId,status:capture.status};});}

  private async save(captureId:string,token:string,key:string,input:Document,final:boolean) {
    fields(input,['bundle'],['evidence'],'INVALID_AGENT_CAPTURE_COMPLETE');
    const authenticated=await this.authenticate(captureId,token),bundle=input.bundle as any;
    const multipart=bundle?.format==='thot.proxy-capture/2';
    if(multipart)validateManifest(bundle,authenticated,this.service.now());else validateBundle(bundle,authenticated,this.service.now());
    let verified:Awaited<ReturnType<typeof verifyRecorder>>|undefined;
    if(authenticated.requires_tee||input.evidence){
      ensure(input.evidence&&this.recorderPolicy,'TEE_CAPTURE_EVIDENCE_REQUIRED');
      verifySeal(bundle,input.evidence,captureId,authenticated.consent_hash);
      verified=await verifyRecorder(input.evidence.attestation,this.recorderPolicy!,true);
    }
    const sourceBundle=input.evidence?{...bundle,tee_evidence:input.evidence}:bundle;
    // This transaction only authenticates and preserves evidence. No content
    // parser, rights assessment, feature extraction or appraisal can abort it.
    const existing=async(tx:Transaction)=>{
      const capture=await this.current(tx,captureId,authenticated.owner_id);
      if(capture.status==='SAVED'){ensure(capture.bundle_root===bundle.root,'AGENT_CAPTURE_ALREADY_COMPLETED',409);return capture.result;}
      ensure(capture.status==='AWAITING_UPLOAD','AGENT_CAPTURE_ALREADY_COMPLETED',409);
      const previous=capture.checkpoints?.at(-1);
      if(previous?.root===bundle.root){
        if(final){
          const trace=await tx.get('traces',capture.result.trace_id,capture.owner_id);ensure(!trace.deleted,'TRACE_DELETED',410);
          capture.status='SAVED';capture.completed_at=this.service.now();capture.result={...capture.result,status:'SAVED'};
          trace.capture_state=capture.result.capture_summary.interrupted?'INTERRUPTED':'COMPLETED';previous.final=true;
          await tx.update('traces',trace.trace_id,trace);await tx.update('agent_captures',captureId,capture);
          await tx.audit(capture.owner_id,'AgentCaptureCompleted',{capture_id:captureId,trace_id:trace.trace_id,bundle_root:bundle.root,exchange_count:capture.result.capture_summary.exchanges});
        }
        return capture.result;
      }
      const descriptors=multipart?bundle.parts:bundle.exchanges;
      if(previous){
        ensure(multipart&&descriptors.length>=previous.parts.length,'CHECKPOINT_REGRESSION',409);
        ensure(previous.parts.every((p:Document,i:number)=>p.sequence===descriptors[i].sequence&&p.commitment===descriptors[i].commitment),'CHECKPOINT_PREFIX_CHANGED',409);
        ensure(bundle.started_at===previous.started_at&&bundle.finished_at>=previous.finished_at,'CHECKPOINT_TIME_REGRESSION',409);
      }
      return undefined;
    };
    await this.service.staged.run(authenticated.owner_id,key,{action:final?'completeAgentCapture':'checkpointAgentCapture',capture_id:captureId,bundle_root:bundle.root},'capture',async stage=>{
      const capture=await this.service.db.transaction(tx=>this.current(tx,captureId,authenticated.owner_id));
      const previous=capture.checkpoints?.at(-1),descriptors=multipart?bundle.parts:bundle.exchanges;
      if(capture.status==='SAVED'||previous?.root===bundle.root)return async tx=>{stage.discard();const result=await existing(tx);ensure(result,'STAGED_STATE_CHANGED',409);return result;};
      ensure(capture.status==='AWAITING_UPLOAD','AGENT_CAPTURE_ALREADY_COMPLETED',409);
      if(previous){
        ensure(multipart&&descriptors.length>=previous.parts.length,'CHECKPOINT_REGRESSION',409);
        ensure(previous.parts.every((p:Document,i:number)=>p.sequence===descriptors[i].sequence&&p.commitment===descriptors[i].commitment),'CHECKPOINT_PREFIX_CHANGED',409);
        ensure(bundle.started_at===previous.started_at&&bundle.finished_at>=previous.finished_at,'CHECKPOINT_TIME_REGRESSION',409);
      }
      const priorSummary=previous?capture.result?.capture_summary:undefined;
      const summarized=priorSummary?.exchanges??0;
      let incomplete=priorSummary?.interrupted??0,requestBytesTotal=priorSummary?.request_bytes??0,responseBytesTotal=priorSummary?.response_bytes??0,largestRequest=priorSummary?.largest_request_bytes??0,modelExchanges=priorSummary?.model_exchanges??0;
      // Accepted immutable prefixes need not be decrypted again at each save.
      // Older summary formats are upgraded once by reading their full prefix.
      const canReuse=typeof priorSummary?.model_exchanges==='number';
      if(!canReuse){incomplete=0;requestBytesTotal=0;responseBytesTotal=0;largestRequest=0;modelExchanges=0;}
      for(const descriptor of descriptors.slice(canReuse?summarized:0)){
        const exchange=await this.exchange(capture,descriptor,multipart,stage.open);
        ensure(Date.parse(exchange.started_at)>=Date.parse(bundle.started_at)-60000&&Date.parse(exchange.finished_at)<=Date.parse(bundle.finished_at)+60000,'INVALID_CAPTURE_TIME');
        const requestLength=Buffer.byteLength(exchange.request_body_b64,'base64');
        requestBytesTotal+=requestLength;responseBytesTotal+=Buffer.byteLength(exchange.response_body_b64,'base64');largestRequest=Math.max(largestRequest,requestLength);
        if(!exchange.complete)incomplete++;
        if(new URL(exchange.upstream+exchange.path).pathname===(bundle.client==='claude'?'/v1/messages':'/backend-api/codex/responses'))modelExchanges++;
      }
      ensure(modelExchanges>0,'CAPTURE_HAS_NO_MODEL_EXCHANGE',409);
      const total=descriptors.length,summary={exchanges:total,completed:total-incomplete,interrupted:incomplete,normalized:0,model_exchanges:modelExchanges,incremental:multipart,request_bytes:requestBytesTotal,response_bytes:responseBytesTotal,largest_request_bytes:largestRequest};
      const traceId=capture.result?.trace_id??uuidv7(),receiptId=uuidv7(),at=this.service.now(),sourceHash=canonicalHash(sourceBundle);
      const receipt:Document={schema_version:'trace.provenance/1',receipt_id:receiptId,trace_id:traceId,path:'operator_capture',confidence_tier:'P0_OPERATOR',temporal:{observed_start:bundle.started_at,observed_end:bundle.finished_at},commitments:{raw_trace_hash:sourceHash,source_bundle_hash:sourceHash,session_root:bundle.root},claims:['THOT preserved the original request and response evidence committed by this capture root.','The raw trace commitment covers the original source bundle, independently of any readable projection.'],limitations:['Operator-recorded evidence only; upstream services did not sign this transcript.','No independent witness, hardware attestation, TEE provenance, account identity, billing record or authorship claim is established.','Readable projections may omit instructions, hidden reasoning or unsupported content; original bodies remain encrypted in the owner vault.','Only the exchanges in this checkpoint are covered.'],verifier:{implementation:'thot-agent-capture-ingestion',version:'2',verified_at:at}};
      if(verified)Object.assign(receipt,{path:'attested_proxy',confidence_tier:'P2_TEE',attestation:{tee_type:'intel_tdx',measurement_set_id:verified.compose_hash,quote_hash:verified.quote_hash,quote_verification_status:'valid'},claims:['The approved TEE recorder observed these exchanges over authenticated TLS to the fixed provider host.','Its hardware-bound key signed this exact capture, consent binding and original bundle.','The raw trace commitment covers the original source bundle, independently of any readable projection.'],limitations:['This proves proxy observation, not execution of the model inside the TEE or provider-signed authorship.','Readable projections may be incomplete; original bodies remain encrypted in the owner vault.','Only exchanges through this checkpoint are covered, not later work or activity outside capture.']});
      if(incomplete)receipt.limitations.push(`${incomplete} interrupted exchange(s) are retained in the original evidence and excluded from normalized content. This capture has gaps.`);
      validateProvenanceReceipt(receipt);
      const sourceRef=await stage.seal(sourceBundle),bundleId=uuidv7();
      const baseRoot=capture.bundle_root??null;
      return async tx=>{
        const duplicate=await existing(tx);
        if(duplicate){stage.discard();return duplicate;}
        const capture=await this.current(tx,captureId,authenticated.owner_id);
        ensure((capture.bundle_root??null)===baseRoot,'STAGED_STATE_CHANGED',409);
        await tx.insert('trace_bundles',bundleId,authenticated.owner_id,{trace_id:traceId,source_bundle_hash:sourceHash,source_bundle_format:bundle.format,object_ref:sourceRef});
        await tx.insert('provenance_receipts',receiptId,authenticated.owner_id,{trace_id:traceId,receipt});
        const source=bundle.client==='claude'?'Claude Code':'Codex';
        const old=capture.result?await tx.get('traces',traceId,authenticated.owner_id):undefined;
        ensure(!old?.deleted,'TRACE_DELETED',410);
        ensure(!old||old.retention_expires_at>this.service.now(),'CAPTURE_CONTENT_UNAVAILABLE',410);
        const trace={...(old??{}),trace_id:traceId,category:'general',source_bundle_hash:sourceHash,source_bundle_id:bundleId,provenance_id:receiptId,
          ...(capture.sale_policy_id?{sale_policy_id:capture.sale_policy_id,capture_device_id:capture.device_id}:{}),
          provenance_status:verified?'VERIFIED':'OPERATOR_CAPTURED',rights_status:old?.rights_status??'pending',display_status:'PRIVATE',credential_ids:old?.credential_ids??[],outcome_ids:old?.outcome_ids??[],sale_count:old?.sale_count??0,deleted:false,created_at:old?.created_at??at,updated_at:at,observed_at:bundle.started_at,observed_end:bundle.finished_at,
          retention_expires_at:old?.retention_expires_at??this.service.future((this.service.config.privateRetentionDays??30)*86400),
          capture_preview:old?.capture_preview??{title:`${source} conversation`,source,source_date:bundle.started_at,size_bytes:requestBytesTotal+responseBytesTotal,turn_count:0,content_commitment:sourceHash,privacy_flags:[]},
          ...(capture.context_ref?{context_ref:capture.context_ref}:{}),agent_capture_id:captureId,capture_consent_hash:capture.consent_hash,capture_summary:summary,projection:{...(old?.projection??{}),status:'PENDING',source_root:bundle.root},capture_state:final?(incomplete?'INTERRUPTED':'COMPLETED'):'RECORDING',last_checkpoint_at:at};
        if(old)await tx.update('traces',traceId,trace);else await tx.insert('traces',traceId,authenticated.owner_id,trace);
        const result={capture_id:captureId,status:final?'SAVED':'CHECKPOINT_SAVED',trace_id:traceId,trace_status:'PRIVATE',capture_receipt:receipt,capture_summary:summary,projection:trace.projection,last_checkpoint_at:at};
        capture.status=final?'SAVED':'AWAITING_UPLOAD';if(final)capture.completed_at=at;
        capture.bundle_root=bundle.root;capture.result=result;capture.last_checkpoint_at=at;delete capture.last_error_code;delete capture.last_error_at;
        capture.checkpoints??=[];
        // Historical manifests remain in immutable trace_bundles. Only the latest
        // prefix is needed in the mutable capture document for the next extension.
        for(const checkpoint of capture.checkpoints)delete checkpoint.parts;
        capture.checkpoints.push({root:bundle.root,bundle_id:bundleId,receipt_id:receiptId,parts:descriptors.map(({sequence,commitment}:Document)=>({sequence,commitment})),started_at:bundle.started_at,finished_at:bundle.finished_at,saved_at:at,final});
        await tx.update('agent_captures',captureId,capture);
        await tx.enqueue(authenticated.owner_id,'ProjectAgentCapture',{capture_id:captureId,root:bundle.root});
        await tx.audit(authenticated.owner_id,final?'AgentCaptureCompleted':'AgentCaptureCheckpointSaved',{capture_id:captureId,trace_id:traceId,bundle_root:bundle.root,exchange_count:total,interrupted_count:incomplete});
        return result;
      };
    });
    // The raw transaction has committed. A projection failure is recorded as a
    // display issue and never reported as a failed raw save. The outbox covers a
    // process interruption between the two transactions.
    try{await this.project(captureId,bundle.root);}
    catch(error){await this.service.db.transaction(async tx=>{
      const capture=await tx.get('agent_captures',captureId,authenticated.owner_id);
      if(capture.bundle_root!==bundle.root)return;
      const trace=await tx.get('traces',capture.result.trace_id,authenticated.owner_id);
      trace.projection={status:'ERROR',source_root:bundle.root,error_code:'PROJECTION_FAILED'};capture.result.projection=trace.projection;
      await tx.update('traces',trace.trace_id,trace);await tx.update('agent_captures',captureId,capture);
      await tx.audit(authenticated.owner_id,'CaptureProjectionFailed',{capture_id:captureId,error_code:'PROJECTION_FAILED'});
    });}
    return this.service.db.transaction(async tx=>(await tx.get('agent_captures',captureId,authenticated.owner_id)).result);
  }

  async exchange(capture:Document,descriptor:Document,multipart:boolean,open=(ref:Document)=>this.service.privacy.open(capture.owner_id,ref)){
    if(!multipart)return descriptor;
    const part=capture.parts?.[String(descriptor.sequence)];ensure(part&&part.commitment===descriptor.commitment,'CAPTURE_PART_MISSING_OR_CHANGED',409);
    const exchange=await open(part.object_ref),{commitment,...record}=exchange;
    ensure(commitment===descriptor.commitment&&canonicalHash(record)===commitment,'CAPTURE_PART_MISSING_OR_CHANGED',409);return exchange;
  }

  async project(captureId:string,root:string,force=false){
    return projectCapture(this.service,captureId,root,(capture,descriptor,multipart,open)=>this.exchange(capture,descriptor,multipart,open),requestBytes,force);
  }

  async status(actor:Actor,captureId:string){ensure(actor.role==='user','FORBIDDEN',403);return this.service.db.transaction(async tx=>{const capture=await tx.get('agent_captures',captureId,actor.id),status=capture.status==='AWAITING_UPLOAD'&&capture.expires_at<=this.service.now()?'EXPIRED':capture.status;return {capture_id:captureId,client:capture.client,status,created_at:capture.created_at,expires_at:capture.expires_at,...(capture.completed_at?{completed_at:capture.completed_at}:{}),...(capture.result?{result:capture.result}:{})};});}

  private async readable(tx:Transaction,owner:string,traceId:string){
    const trace=await tx.get('traces',traceId,owner);
    ensure(!trace.deleted&&!trace.source_private_objects_deleted&&trace.retention_expires_at>this.service.now(),'CAPTURE_CONTENT_UNAVAILABLE',410);
    return trace;
  }

  async proofPart(actor:Actor,captureId:string,sequence:number){
    ensure(actor.role==='user','FORBIDDEN',403);
    const snapshot=await this.service.db.transaction(async tx=>{
      const capture=await tx.get('agent_captures',captureId,actor.id);ensure(capture.result?.trace_id,'AGENT_CAPTURE_NOT_SAVED',409);
      await this.readable(tx,actor.id,capture.result.trace_id);
      const stored=capture.parts?.[String(sequence)];ensure(stored&&sequence<=capture.result.capture_summary.exchanges,'CAPTURE_PART_NOT_FOUND',404);
      return {traceId:capture.result.trace_id,ref:stored.object_ref};
    });
    const part=await this.service.privacy.open(actor.id,snapshot.ref);
    await this.service.db.transaction(tx=>this.readable(tx,actor.id,snapshot.traceId));
    return {capture_id:captureId,part};
  }

  async proof(actor:Actor,captureId:string){
    ensure(actor.role==='user','FORBIDDEN',403);
    const snapshot=await this.service.db.transaction(async tx=>{
      const capture=await tx.get('agent_captures',captureId,actor.id);ensure(capture.result?.trace_id,'AGENT_CAPTURE_NOT_SAVED',409);
      const trace=await this.readable(tx,actor.id,capture.result.trace_id);
      const source=await tx.get('trace_bundles',trace.source_bundle_id,actor.id);
      return {capture,trace,ref:source.object_ref};
    });
    const bundle=await this.service.privacy.open(actor.id,snapshot.ref);
    ensure(['thot.proxy-capture/1','thot.proxy-capture/2'].includes(bundle?.format)&&bundle.capture_id===captureId&&canonicalHash(bundle)===snapshot.trace.source_bundle_hash,'CAPTURE_SOURCE_INVALID');
    await this.service.db.transaction(tx=>this.readable(tx,actor.id,snapshot.trace.trace_id));
    return {capture_id:captureId,bundle,receipt:snapshot.capture.result.capture_receipt,summary:snapshot.capture.result.capture_summary};
  }

}

function validateBundle(bundle:ProxyCaptureBundle,capture:Document,now:string,sequenceStart=0,partOnly=false) {
  ensure(bundle&&typeof bundle==='object'&&!Array.isArray(bundle),'INVALID_PROXY_CAPTURE_BUNDLE');exact(bundle as any,['format','capture_id','client','started_at','finished_at','exchanges','root'],'INVALID_PROXY_CAPTURE_BUNDLE');ensure(Buffer.byteLength(JSON.stringify(bundle))<=CAPTURE_PART_JSON_BYTES,'CAPTURE_BUNDLE_TOO_LARGE',413);ensure(bundle.format==='thot.proxy-capture/1'&&bundle.capture_id===capture.capture_id&&bundle.client===capture.client,'CAPTURE_BINDING_MISMATCH');const started=timestamp(bundle.started_at,'INVALID_CAPTURE_TIME'),finished=timestamp(bundle.finished_at,'INVALID_CAPTURE_TIME');ensure(Date.parse(started)<=Date.parse(finished)&&Date.parse(started)>=Date.parse(capture.created_at)-60_000&&Date.parse(finished)<=Date.parse(now)+60_000,'INVALID_CAPTURE_TIME');ensure(Array.isArray(bundle.exchanges)&&bundle.exchanges.length>0&&bundle.exchanges.length<=100,'INVALID_CAPTURE_EXCHANGES');
  let previous=sequenceStart;for(const exchange of bundle.exchanges){ensure(exchange&&typeof exchange==='object'&&!Array.isArray(exchange),'INVALID_PROXY_EXCHANGE');fields(exchange,['sequence','upstream','path','request_body_b64','response_body_b64','status','content_type','started_at','finished_at','complete','commitment'],['request_encoding','request_method'],'INVALID_PROXY_EXCHANGE');ensure(Number.isSafeInteger(exchange.sequence)&&exchange.sequence===previous+1,'INVALID_EXCHANGE_SEQUENCE');previous=exchange.sequence;ensure((bundle.client==='claude'&&exchange.upstream==='https://api.anthropic.com')||(bundle.client==='codex'&&exchange.upstream==='https://chatgpt.com'),'INVALID_CAPTURE_UPSTREAM');let url:URL;try{url=new URL(exchange.upstream+exchange.path);}catch{throw new Error('INVALID_CAPTURE_PATH');}ensure(url.origin===exchange.upstream&&!url.username&&!url.password&&!url.hash,'INVALID_CAPTURE_PATH');const paths=bundle.client==='claude'?['/v1/messages','/v1/messages/count_tokens']:['/backend-api/codex/responses','/backend-api/codex/responses/compact','/backend-api/codex/models'];ensure(paths.includes(url.pathname),'INVALID_CAPTURE_PATH');ensure(['identity','gzip','zstd'].includes(exchange.request_encoding??'identity')&&['GET','POST'].includes(exchange.request_method??'POST'),'INVALID_PROXY_EXCHANGE');ensure(url.pathname==='/backend-api/codex/models'?(exchange.request_method??'POST')==='GET':(exchange.request_method??'POST')==='POST','INVALID_CAPTURE_METHOD');ensure(typeof exchange.status==='number'&&Number.isSafeInteger(exchange.status)&&((exchange.status>=100&&exchange.status<=599)||(exchange.status===0&&exchange.complete===false))&&typeof exchange.content_type==='string'&&exchange.content_type.length<=200&&typeof exchange.complete==='boolean','INVALID_PROXY_EXCHANGE');const exStart=timestamp(exchange.started_at,'INVALID_CAPTURE_TIME'),exFinish=timestamp(exchange.finished_at,'INVALID_CAPTURE_TIME');ensure(Date.parse(exStart)<=Date.parse(exFinish)&&Date.parse(exStart)>=Date.parse(started)-60_000&&Date.parse(exFinish)<=Date.parse(finished)+60_000,'INVALID_CAPTURE_TIME');bytes(exchange.request_body_b64,'INVALID_REQUEST_BODY_BASE64');bytes(exchange.response_body_b64,'INVALID_RESPONSE_BODY_BASE64');const copy={...exchange};delete copy.commitment;ensure(exchange.commitment===canonicalHash(copy),'EXCHANGE_COMMITMENT_MISMATCH');}
  if(!partOnly)ensure(bundle.root===canonicalHash({format:bundle.format,capture_id:bundle.capture_id,client:bundle.client,started_at:bundle.started_at,finished_at:bundle.finished_at,commitments:bundle.exchanges.map(e=>e.commitment)}),'CAPTURE_ROOT_MISMATCH');
}

function validateManifest(bundle:Document,capture:Document,now:string){
  exact(bundle,['format','capture_id','client','started_at','finished_at','parts','root'],'INVALID_CAPTURE_MANIFEST');
  ensure(bundle.capture_id===capture.capture_id&&bundle.client===capture.client,'CAPTURE_BINDING_MISMATCH');
  const started=timestamp(bundle.started_at,'INVALID_CAPTURE_TIME'),finished=timestamp(bundle.finished_at,'INVALID_CAPTURE_TIME');
  ensure(started<=finished&&Date.parse(started)>=Date.parse(capture.created_at)-60000&&Date.parse(finished)<=Date.parse(now)+60000,'INVALID_CAPTURE_TIME');
  ensure(Array.isArray(bundle.parts)&&bundle.parts.length>0&&bundle.parts.length<=CAPTURE_MAX_EXCHANGES,'INVALID_CAPTURE_EXCHANGES');
  for(const [i,part]of bundle.parts.entries()){exact(part,['sequence','commitment'],'INVALID_CAPTURE_PART');ensure(part.sequence===i+1&&/^[a-f0-9]{64}$/.test(part.commitment),'INVALID_EXCHANGE_SEQUENCE');}
  const {root,...manifest}=bundle;ensure(root===canonicalHash(manifest),'CAPTURE_ROOT_MISMATCH');
}
