import {randomUUID} from 'node:crypto';
import {canonicalHash} from '../../protocol/src/index.ts';
import {ensure,type Document} from '../../storage/src/index.ts';
import type {ThotService} from './service.ts';
import {projectProxyExchange,proxyModelIdentity} from './proxy-normalization.ts';
import {nativeConversationKey,appendCapturedExchange} from './capture-session.ts';

/** Rebuildable readable view. Original bundles, parts and provenance receipts
 * are never rewritten here. Unknown content is a display issue, not data loss. */
export async function projectCapture(service:ThotService,captureId:string,root:string,
  exchange:(capture:Document,descriptor:Document,multipart:boolean,open:(ref:Document)=>Promise<any>)=>Promise<Document>,
  requestBytes:(exchange:Document)=>Buffer,force=false){
  const snapshot=()=>service.db.transaction(async tx=>{
    const capture=await tx.get('agent_captures',captureId);
    if(!capture.result?.trace_id||capture.bundle_root!==root)return;
    const trace=await tx.get('traces',capture.result.trace_id,capture.owner_id);
    if(trace.deleted||trace.retention_expires_at<=service.now())return;
    if(!force&&trace.projection?.version===8&&trace.projection?.source_root===root&&['READY','PARTIAL','UNREADABLE'].includes(trace.projection.status)&&trace.release_preparation?.status!=='ERROR')return;
    const source=await tx.get('trace_bundles',trace.source_bundle_id,capture.owner_id);
    return {capture,trace,source,prior:await tx.list('traces',capture.owner_id)};
  },'projection');
  const initial=await snapshot();if(!initial)return;
  const key='projection:'+canonicalHash({captureId,root,trace:initial.trace,...(force?{nonce:randomUUID()}: {})});
  await service.staged.run(initial.capture.owner_id,key,{action:'projectCapture',captureId,root,force},'projection',async stage=>{
    const state=await snapshot();if(!state)return async()=>{stage.discard();return true;};
    const {capture,trace,source,prior}=state,traceVersion=canonicalHash(trace);
    const originalCapture={root:capture.bundle_root,status:capture.status,consent_hash:capture.consent_hash,result:capture.result};
    const audits:{event:string;payload:Record<string,string|number|boolean>}[]=[];
    let assessment:Document|undefined;
    let inherited:Document|undefined;
    const bundle=await stage.open(source.object_ref),multipart=bundle.format==='thot.proxy-capture/2';
    const reuse=!force&&multipart&&trace.projection?.version===8;
    const through=reuse?(trace.projection.through_sequence??0):0;
    const previous=reuse&&trace.raw_ref?await stage.open(trace.raw_ref):{turns:[]};
    const turns:Document[]=previous.turns,issues:Document[]=reuse?[...(trace.projection.issues??[])]:[],models:Document[]=reuse?[...(trace.model_history??[])]:[];
    const nativeKeys=new Set<string>(reuse?trace.native_session_keys??[]:[]);
    let previousNative:string|null=reuse?(trace.projection.last_native_key??null):null;
    let normalized=reuse?(trace.projection.normalized_exchanges??0):0;
    const descriptors=multipart?bundle.parts:bundle.exchanges;
    for(const descriptor of descriptors.slice(through)){
      const part=await exchange(capture,descriptor,multipart,stage.open);
      if(!part.complete||part.status<200||part.status>=300||new URL(part.upstream+part.path).pathname!==(bundle.client==='claude'?'/v1/messages':'/backend-api/codex/responses'))continue;
      try{
        const request=requestBytes(part),parsed=JSON.parse(request.toString());
        const nativeKey=nativeConversationKey(capture.owner_id,bundle.client,parsed);if(nativeKey)nativeKeys.add(nativeKey);
        const identity=proxyModelIdentity(bundle.client,request,Buffer.from(part.response_body_b64,'base64'));
        if(!models.length||models.at(-1)?.requested_model!==identity.requested_model||models.at(-1)?.returned_model!==identity.returned_model)models.push({sequence:part.sequence,model:identity.returned_model??identity.requested_model??'Unknown',...identity,evidence:identity.returned_model?'response_metadata':'request_only'});
        const parsedView=projectProxyExchange(bundle.client,request,Buffer.from(part.response_body_b64,'base64')),next=parsedView.turns;
        for(const issue of parsedView.issues)issues.push({sequence:part.sequence,error_code:'UNSUPPORTED_PROXY_CONTENT',content_type:issue.type});
        appendCapturedExchange(turns,parsedView,previousNative,nativeKey??null);previousNative=nativeKey??null;normalized++;
      }catch(error){
        const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'UNREADABLE_EXCHANGE';
        issues.push({sequence:part.sequence,error_code:code});
      }
    }
    const at=service.now();
    const projection={status:issues.length?(turns.length?'PARTIAL':'UNREADABLE'):turns.length?'READY':'UNREADABLE',source_root:root,version:8,last_native_key:previousNative,through_sequence:descriptors.length,updated_at:at,issues,normalized_exchanges:normalized};
    if(turns.length){
      const content={turns},contentCommitment=canonicalHash(content);
      // A personal readable view has its own purpose and size envelope. Release
      // assessment limits or outages cannot make this otherwise readable work vanish.
      const rawRef=await stage.seal(content);
      trace.projection_refs??=[];
      for(const ref of [trace.raw_ref,trace.scrub_ref])if(ref)trace.projection_refs.push(ref);
      trace.raw_ref=rawRef;
      delete trace.scrub_ref;delete trace.rights_id;delete trace.scrub_id;delete trace.normalized_hash;
      trace.rights_status='manual_review';trace.display_status=capture.save_privately?'PRIVATE':'REJECTED';
      try{assessment=await service.privacy.assess(trace.trace_id,content,trace.category,{rights_confirmed:capture.rights_confirmed===true,model_output_licensed:capture.model_output_licensed===true});}
      catch(error){
        const limit=error instanceof Error&&error.message==='INVALID_TRACE';
        trace.release_preparation={status:limit?'DEFERRED':'ERROR',source_root:root,error_code:limit?'RELEASE_CONTENT_LIMIT':'RELEASE_PREPARATION_FAILED',updated_at:at};
        audits.push({event:'CaptureReleasePreparationDeferred',payload:{trace_id:trace.trace_id,capture_id:captureId,error_code:trace.release_preparation.error_code}});
      }
      if(assessment){
        assessment.features.provenance_tier=capture.result.capture_receipt.confidence_tier;
        trace.scrub_ref=await stage.seal(assessment.content);
        trace.rights_id=assessment.rights.assessment_id;trace.scrub_id=assessment.scrub.scrub_id;
        trace.rights_status=assessment.rights.status;trace.normalized_hash=canonicalHash(assessment.content);
        trace.release_preparation={status:'READY',source_root:root,updated_at:at};
        const eligible=projection.status==='READY'&&capture.result.capture_summary.interrupted===0&&['eligible','eligible_with_restrictions'].includes(assessment.rights.status);
        trace.display_status=capture.save_privately?'PRIVATE':eligible?'AVAILABLE':'REJECTED';
      }
      const first=turns.find(t=>t.role==='user')?.content;
      const title=typeof first==='string'?first.replace(/\s+/g,' ').trim().slice(0,100):undefined;
      if(title){if(trace.private_metadata_ref)trace.projection_refs.push(trace.private_metadata_ref);trace.private_metadata_ref=await stage.seal({title,answer_preview:String(turns.findLast(t=>t.role==='assistant')?.content??'').replace(/\s+/g,' ').slice(0,220)});}
      trace.capture_preview={...trace.capture_preview,turn_count:turns.length,size_bytes:Buffer.byteLength(JSON.stringify(content)),content_commitment:contentCommitment};
    }
    const lastModel=models.at(-1);trace.capture_model={source:bundle.client,requested_model:lastModel?.requested_model??null,returned_model:lastModel?.returned_model??null,provider_name:null,capture_status:capture.status??capture.state??'UNKNOWN'};
    trace.projection=projection;trace.model_history=models;trace.native_session_keys=[...nativeKeys];trace.updated_at=at;
    // Copy owner annotations into a resumed segment with its own encrypted object.
    // Its bookmark must survive expiry/deletion of the earlier original recording.
    if(!reuse&&!trace.personal_ref&&nativeKeys.size===1){
      const candidates=prior.filter(t=>t.trace_id!==trace.trace_id&&!t.deleted&&t.retention_expires_at>at&&t.agent_capture_id&&t.personal_ref&&t.native_session_keys?.length===1&&t.native_session_keys[0]===trace.native_session_keys[0]).sort((a,b)=>a.created_at.localeCompare(b.created_at));
      if(candidates.length){inherited=candidates[0];trace.personal_ref=await stage.seal(await stage.open(inherited.personal_ref));}
    }
    trace.capture_summary={...trace.capture_summary,normalized,display_issues:issues.length};
    capture.result={...capture.result,capture_summary:trace.capture_summary,projection,...(trace.release_preparation?{release_preparation:trace.release_preparation}:{}),trace_status:trace.display_status};
    return async tx=>{
      const currentCapture=await tx.get('agent_captures',captureId,capture.owner_id);
      const currentTrace=await tx.get('traces',trace.trace_id,capture.owner_id);
      if(currentCapture.bundle_root!==root||currentTrace.deleted||currentTrace.retention_expires_at<=service.now()){stage.discard();return true;}
      ensure(canonicalHash(currentTrace)===traceVersion&&canonicalHash({root:currentCapture.bundle_root,status:currentCapture.status,consent_hash:currentCapture.consent_hash,result:currentCapture.result})===canonicalHash(originalCapture),'STAGED_STATE_CHANGED',409);
      if(inherited){const original=await tx.get('traces',inherited.trace_id,capture.owner_id);ensure(!original.deleted&&original.retention_expires_at>service.now()&&canonicalHash(original.personal_ref)===canonicalHash(inherited.personal_ref),'STAGED_STATE_CHANGED',409);}
      if(assessment){
        await tx.insert('rights_assessments',trace.rights_id,capture.owner_id,{trace_id:trace.trace_id,receipt:assessment.rights});
        await tx.insert('scrub_receipts',trace.scrub_id,capture.owner_id,{trace_id:trace.trace_id,receipt:assessment.scrub});
        if(await tx.maybe('trace_features',trace.trace_id))await tx.update('trace_features',trace.trace_id,assessment.features);
        else await tx.insert('trace_features',trace.trace_id,capture.owner_id,assessment.features);
      }
      // Preserve parts/heartbeats that arrived while the readable view was prepared.
      currentCapture.result=capture.result;
      await tx.update('traces',trace.trace_id,trace);await tx.update('agent_captures',captureId,currentCapture);
      if(trace.projection_refs?.length)await tx.enqueue(capture.owner_id,'DeleteSupersededProjections',{trace_id:trace.trace_id});
      for(const audit of audits)await tx.audit(capture.owner_id,audit.event,audit.payload);
      await tx.audit(capture.owner_id,'CaptureProjectionUpdated',{capture_id:captureId,trace_id:trace.trace_id,source_root:root,status:projection.status,normalized_exchanges:normalized,display_issues:issues.length});
      return true;
    };
  });
}
