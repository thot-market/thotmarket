import {canonicalHash} from '../../protocol/src/index.ts';
import {ensure,type Document,type Transaction} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';
import {conversationGroups,appendConversationTurns,groupState,groupProjection} from './capture-session.ts';

const sourceName=(t:Document)=>String(t.capture_preview?.source??t.import_preview?.source_label??t.import_preview?.source??'Uploaded trace').replace(/ \(user supplied\)$/,'');
const recent=(value:string|undefined,now:string,seconds:number)=>!!value&&Date.parse(value)>Date.parse(now)-seconds*1000;
const eventNames:Record<string,string>={AgentCaptureCheckpointSaved:'Checkpoint saved',AgentCaptureCompleted:'Capture saved',CaptureProjectionUpdated:'Readable view updated',CaptureProjectionFailed:'Readable view needs attention',TraceReceived:'Conversation added',LibraryBookmarked:'Bookmarked for reuse',LibraryUnbookmarked:'Bookmark removed',LibraryRenamed:'Title updated',LibraryNoteSaved:'Your note saved',TraceDeletionRequested:'Deletion requested'};

export class TraceLibrary {
  readonly service:ThotService;
  constructor(service:ThotService){this.service=service;}
  canExplore(actor:Actor){return actor.role==='operator_security'||(actor.role==='user'&&this.service.config.traceExplorerViewers?.includes(actor.id)===true);}
  private async meta(t:Document){
    const owner=t.owner_id,privateMeta=t.private_metadata_ref?await this.service.privacy.open(owner,t.private_metadata_ref):{};
    const personal=t.personal_ref?await this.service.privacy.open(owner,t.personal_ref):{};
    const context=t.context_ref?await this.service.privacy.open(owner,t.context_ref):{};
    return {title:personal.title??privateMeta.title??t.import_preview?.title??t.capture_preview?.title??'Saved conversation',project:context.project??'',bookmarked:personal.bookmarked===true,note:personal.note??'',answer_preview:privateMeta.answer_preview??''};
  }
  private captureState(trace:Document,capture?:Document){
    if(trace.openrouter_request_id)return trace.capture_state==='INFLIGHT'?'RECORDING':trace.capture_state==='COMPLETED'?'COMPLETED':'INTERRUPTED';
    if(!capture)return 'IMPORTED';
    if(capture.status==='SAVED')return trace.capture_state==='INTERRUPTED'?'INTERRUPTED':'COMPLETED';
    return recent(capture.last_heartbeat_at??capture.last_part_at??capture.created_at,this.service.now(),120)&&capture.status==='AWAITING_UPLOAD'?'RECORDING':'INTERRUPTED';
  }
  private async card(trace:Document,capture?:Document){
    const meta=await this.meta(trace),preview=trace.capture_preview??trace.import_preview??{};
    return {trace_id:trace.trace_id,...meta,source:sourceName(trace),origin:trace.agent_capture_id?'capture':trace.openrouter_request_id?'relay':'upload',capture_id:trace.agent_capture_id??null,
      state:this.captureState(trace,capture),projection:trace.projection?.status??'READY',display_issues:trace.projection?.issues?.length??0,
      turn_count:preview.turn_count??0,exchanges:trace.capture_summary?.exchanges??0,
      created_at:trace.created_at,updated_at:trace.updated_at??trace.created_at,session_at:preview.source_date??(trace.agent_capture_id?trace.observed_at:null),
      last_checkpoint_at:trace.last_checkpoint_at??null,retention_expires_at:trace.retention_expires_at,
      evidence:trace.provenance_status,model_history:trace.model_history??[],capture_model:trace.capture_model??null,private:true,segments:1,native_conversations:trace.native_session_keys?.length??0};
  }
  private async groupCard(group:Document[],captures:Map<string,Document>):Promise<Document>{
    const cards:Document[]=[];for(const trace of group)cards.push(await this.card(trace,captures.get(trace.agent_capture_id)));
    const first=cards[0],last=cards.at(-1)!;
    const projection=groupProjection(cards.map(c=>c.projection));
    return {...first,answer_preview:last.answer_preview,segments:group.length,updated_at:cards.map(c=>c.updated_at).sort().at(-1),
      last_checkpoint_at:cards.map(c=>c.last_checkpoint_at).filter(Boolean).sort().at(-1)??null,
      state:groupState(cards.map(c=>c.state)),
      projection,display_issues:cards.reduce((n,c)=>n+c.display_issues,0),exchanges:cards.reduce((n,c)=>n+c.exchanges,0),
      turn_count:group.length===1?first.turn_count:null,model_history:cards.flatMap(c=>c.model_history.map((m:Document)=>({...m,capture_id:c.capture_id}))),
      retention_expires_at:cards.map(c=>c.retention_expires_at).sort().at(-1)};
  }
  private async groupFor(tx:Transaction,actor:Actor,id:string){
    const selected=await tx.get('traces',id,actor.id);ensure(!selected.deleted&&selected.retention_expires_at>this.service.now(),'TRACE_CONTENT_UNAVAILABLE',410);
    const traces=(await tx.list('traces',actor.id)).filter(t=>!t.deleted&&t.retention_expires_at>this.service.now());
    return conversationGroups(traces).find(group=>group.some(t=>t.trace_id===id))!;
  }
  async list(actor:Actor,query:Document={}){
    ensure(actor.role==='user','FORBIDDEN',403);
    const q=String(query.q??'').trim().toLowerCase();ensure(q.length<=160,'LIBRARY_QUERY_TOO_LONG');
    const limit=Number(query.limit??30);ensure(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'INVALID_LIBRARY_LIMIT');
    let cursor:Document|undefined;if(query.cursor){try{cursor=JSON.parse(Buffer.from(String(query.cursor),'base64url').toString());}catch{ensure(false,'INVALID_LIBRARY_CURSOR');}ensure(typeof cursor?.created_at==='string'&&typeof cursor?.trace_id==='string','INVALID_LIBRARY_CURSOR');}
    return this.service.db.transaction(async tx=>{
      const now=this.service.now(),traces=(await tx.list('traces',actor.id)).filter(t=>!t.deleted&&t.retention_expires_at>now);
      const captures=new Map((await tx.list('agent_captures',actor.id)).map(c=>[c.capture_id,c]));
      const cards:Document[]=[];
      for(const group of conversationGroups(traces))cards.push(await this.groupCard(group,captures));
      cards.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.trace_id.localeCompare(a.trace_id));
      const projects=[...new Set(cards.map(c=>c.project).filter(Boolean))].sort();
      const filtered:Document[]=[];
      for(const card of cards){
        if(query.source&&query.source!=='all'&&!card.source.toLowerCase().includes(String(query.source).toLowerCase()))continue;
        if(query.origin&&query.origin!=='all'&&query.origin!==card.origin)continue;
        if(query.state&&query.state!=='all'&&query.state!==card.state)continue;
        if(query.project&&card.project!==query.project)continue;
        if(query.bookmarked==='true'&&!card.bookmarked)continue;
        if(q&&!`${card.title}\n${card.project}\n${card.note}\n${card.source}`.toLowerCase().includes(q))continue;
        filtered.push(card);
      }
      const page=filtered.filter(c=>!cursor||c.created_at<cursor.created_at||(c.created_at===cursor.created_at&&c.trace_id<cursor.trace_id));
      const items=page.slice(0,limit),last=items.at(-1);
      const attempts=[...captures.values()].filter(c=>!c.result?.trace_id&&c.expires_at>now).map(c=>({capture_id:c.capture_id,client:c.client,created_at:c.created_at,parts:Object.keys(c.parts??{}).length,status:c.last_error_code?'NEEDS_ATTENTION':'CONNECTING',error_code:c.last_error_code??null}));
      return {items,total_matches:filtered.length,raw_trace_count:traces.length,next_cursor:page.length>limit&&last?Buffer.from(JSON.stringify({created_at:last.created_at,trace_id:last.trace_id})).toString('base64url'):null,
        summary:{saved:cards.length,added_week:cards.filter(c=>recent(c.created_at,now,7*86400)).length,recording:cards.filter(c=>c.state==='RECORDING').length,bookmarked:cards.filter(c=>c.bookmarked).length,readable:cards.filter(c=>c.projection==='READY').length,display_issues:cards.filter(c=>['PARTIAL','UNREADABLE','ERROR'].includes(c.projection)).length},projects,attempts,refreshed_at:now,search_scope:'titles, projects, notes and source'};
    });
  }
  async item(actor:Actor,id:string):Promise<Document & {events:Document[]}>{
    ensure(actor.role==='user','FORBIDDEN',403);
    return this.service.db.transaction(async tx=>{
      const group=await this.groupFor(tx,actor,id),trace=group[0],captures=new Map<string,Document>();
      for(const segment of group)if(segment.agent_capture_id)captures.set(segment.agent_capture_id,await tx.get('agent_captures',segment.agent_capture_id,actor.id));
      const card=await this.groupCard(group,captures),content:Document={turns:[]};
      const segments:Document[]=[];
      for(const segment of group){
        const turn_start=content.turns.length;
        if(segment.raw_ref)appendConversationTurns(content.turns,(await this.service.privacy.open(actor.id,segment.raw_ref)).turns);
        if(segment.agent_capture_id)segments.push({trace_id:segment.trace_id,capture_id:segment.agent_capture_id,from:segment.observed_at,through:segment.observed_end,last_checkpoint_at:segment.last_checkpoint_at,retention_expires_at:segment.retention_expires_at,exchanges:segment.capture_summary?.exchanges??0,evidence:segment.provenance_status,portable_export:segment.provenance_status==='VERIFIED'&&segment.capture_summary?.incremental===true,turn_start,turn_end:content.turns.length});
      }
      card.turn_count=content.turns.length;
      const events=(await tx.sql.query("SELECT id,event_type,payload,created_at FROM audit_events WHERE owner_id=$1 AND (payload->>'trace_id'=ANY($2::text[]) OR payload->>'capture_id'=ANY($3::text[])) ORDER BY created_at DESC,id DESC LIMIT 100",[actor.id,group.map(t=>t.trace_id),[...captures.keys()]])).rows;
      return {...card,content,release_preparation:group.filter(t=>t.agent_capture_id&&t.release_preparation).map(t=>({capture_id:t.agent_capture_id,...t.release_preparation})),projection_details:{status:card.projection,issues:group.flatMap(t=>(t.projection?.issues??[]).map((issue:Document)=>({...issue,capture_id:t.agent_capture_id})))},events:events.filter(e=>eventNames[e.event_type]).map(e=>({id:e.id,label:eventNames[e.event_type],at:new Date(e.created_at).toISOString(),...(typeof e.payload.exchange_count==='number'?{exchanges:e.payload.exchange_count}:{}),...(e.payload.status?{status:e.payload.status}:{})})),checkpoint_count:[...captures.values()].reduce((n,c)=>n+(c.checkpoints?.length??0),0),
        receipt:(await tx.get('provenance_receipts',trace.provenance_id,actor.id)).receipt,
        capture_segments:segments,
        private_import:group.length===1&&trace.save_privately===true&&trace.import_preview&&trace.import_content_hash&&!trace.agent_capture_id?{can_prepare_sale:true,content_commitment:trace.import_content_hash}:null};
    });
  }
  async update(actor:Actor,key:string,id:string,input:Document){
    ensure(actor.role==='user','FORBIDDEN',403);
    ensure(Object.keys(input).length>0&&Object.keys(input).every(k=>['title','note','bookmarked'].includes(k)),'INVALID_LIBRARY_EDIT');
    if(input.title!==undefined)ensure(typeof input.title==='string'&&input.title.trim().length>0&&input.title.length<=160,'INVALID_LIBRARY_TITLE');
    if(input.note!==undefined)ensure(typeof input.note==='string'&&input.note.length<=4000,'INVALID_LIBRARY_NOTE');
    if(input.bookmarked!==undefined)ensure(typeof input.bookmarked==='boolean','INVALID_LIBRARY_BOOKMARK');
    // Store only a digest in the idempotency request and never raw note/title in
    // operational audit records. The editable metadata is encrypted for its owner.
    await this.service.db.command(actor.id,key,{action:'libraryEdit',id,input_hash:canonicalHash(input)},async tx=>{
      const group=await this.groupFor(tx,actor,id);
      for(const trace of group){
      const previous=trace.personal_ref?await this.service.privacy.open(actor.id,trace.personal_ref):{};
      trace.projection_refs??=[];if(trace.personal_ref)trace.projection_refs.push(trace.personal_ref);
      trace.personal_ref=await this.service.privacy.seal(actor.id,{...previous,...input});await tx.update('traces',trace.trace_id,trace);
      for(const field of Object.keys(input))await tx.audit(actor.id,field==='title'?'LibraryRenamed':field==='note'?'LibraryNoteSaved':input.bookmarked?'LibraryBookmarked':'LibraryUnbookmarked',{trace_id:trace.trace_id});
      }
      return {trace_id:id,updated:true};
    });
    return this.item(actor,id);
  }
  async reprocess(actor:Actor,key:string,id:string){
    ensure(actor.role==='user','FORBIDDEN',403);
    return this.service.db.command(actor.id,key,{action:'reprocessCapture',id},async tx=>{
      const group=await this.groupFor(tx,actor,id);ensure(group.every(t=>t.agent_capture_id),'CAPTURE_REQUIRED',409);
      for(const trace of group){
        const capture=await tx.get('agent_captures',trace.agent_capture_id,actor.id);
        trace.projection={status:'PENDING',source_root:capture.bundle_root};await tx.update('traces',trace.trace_id,trace);
        await tx.enqueue(actor.id,'ProjectAgentCapture',{capture_id:capture.capture_id,root:capture.bundle_root});
        await tx.audit(actor.id,'CaptureProjectionRequested',{trace_id:trace.trace_id,capture_id:capture.capture_id});
      }
      return {trace_id:id,status:'PENDING'};
    });
  }
  async operator(actor:Actor,query:Document={}){
    ensure(this.canExplore(actor),'FORBIDDEN',403);
    return this.service.db.transaction(async tx=>{
      const now=this.service.now(),traces=(await tx.list('traces')).filter(t=>!t.deleted&&t.retention_expires_at>now),captures=await tx.list('agent_captures');
      const inventory=new Map(traces.map(t=>[t.trace_id,t]));
      const attempts=captures.map(c=>{
        const trace=inventory.get(c.result?.trace_id),state=trace?this.captureState(trace,c):c.last_error_code?'FAILED':c.expires_at<=now?'EXPIRED':'AWAITING_CHECKPOINT';
        return {capture_id:c.capture_id,trace_id:trace?.trace_id??null,owner_ref:canonicalHash(c.owner_id).slice(0,16),client:c.client,state,projection:trace?.projection?.status??null,release_preparation:trace?.release_preparation?.status??null,preparation_error:trace?.release_preparation?.error_code??null,parts:Object.keys(c.parts??{}).length,verified_exchanges:trace?.capture_summary?.exchanges??0,received_bytes:c.part_bytes??0,created_at:c.created_at,last_activity_at:c.last_heartbeat_at??c.last_part_at??c.created_at,last_checkpoint_at:c.last_checkpoint_at??null,error_code:c.last_error_code??trace?.projection?.error_code??trace?.projection?.issues?.[0]?.error_code??null};
      }).sort((a,b)=>b.created_at.localeCompare(a.created_at));
      const view=query.view??(query.state==='FAILED'?'attempts':'inventory');ensure(['inventory','attempts'].includes(view),'INVALID_EXPLORER_VIEW');
      const rawRows=traces.map(t=>{
        const existing=attempts.find(a=>a.trace_id===t.trace_id);
        return existing??{capture_id:null,trace_id:t.trace_id,owner_ref:canonicalHash(t.owner_id).slice(0,16),client:sourceName(t).toLowerCase().includes('codex')?'codex':sourceName(t).toLowerCase().includes('claude')?'claude':'upload',state:'IMPORTED',projection:t.projection?.status??'READY',parts:0,verified_exchanges:0,received_bytes:t.import_preview?.size_bytes??0,created_at:t.created_at,last_activity_at:t.updated_at??t.created_at,last_checkpoint_at:null,error_code:null};
      }).sort((a,b)=>b.created_at.localeCompare(a.created_at));
      const rawById=new Map(rawRows.map(r=>[r.trace_id,r]));
      const groups=conversationGroups(traces);
      const inventoryRows=groups.map(group=>{
        const rows=group.map(t=>rawById.get(t.trace_id)!),first=rows[0];
        return {...first,segments:group.length,state:groupState(rows.map(r=>r.state)),projection:groupProjection(rows.map(r=>r.projection??'READY')),
          parts:rows.reduce((n,r)=>n+r.parts,0),verified_exchanges:rows.reduce((n,r)=>n+r.verified_exchanges,0),received_bytes:rows.reduce((n,r)=>n+r.received_bytes,0),
          last_checkpoint_at:rows.map(r=>r.last_checkpoint_at).filter(Boolean).sort().at(-1)??null,last_activity_at:rows.map(r=>r.last_activity_at).sort().at(-1),
          error_code:rows.find(r=>r.error_code)?.error_code??null};
      }).sort((a,b)=>b.created_at.localeCompare(a.created_at));
      const selected:Document[]=(view==='inventory'?inventoryRows:attempts).filter(a=>(!query.state||query.state==='all'||a.state===query.state)&&(!query.client||query.client==='all'||a.client===query.client)&&(!query.error||a.error_code===query.error)&&(!query.projection||(query.projection==='ISSUE'?['PARTIAL','UNREADABLE','ERROR'].includes(a.projection??''):a.projection===query.projection)));
      const limit=Number(query.limit??50),offset=Number(query.offset??0);ensure(Number.isSafeInteger(limit)&&limit>0&&limit<=100&&Number.isSafeInteger(offset)&&offset>=0,'INVALID_EXPLORER_PAGE');
      const readiness={readable:0,preparing:0,display_issues:0};
      for(const row of inventoryRows){if(row.projection==='READY')readiness.readable++;else if(row.projection==='PENDING')readiness.preparing++;else readiness.display_issues++;}
      return {view,refreshed_at:now,range:'last 24 hours for arrivals; current retained inventory',summary:{saved:inventoryRows.length,raw_traces:traces.length,capture_attempts:attempts.length,added_24h:inventoryRows.filter(t=>recent(t.created_at,now,86400)).length,contributors_24h:new Set(traces.filter(t=>recent(t.updated_at??t.created_at,now,86400)).map(t=>t.owner_id)).size,...readiness,failed_attempts:attempts.filter(a=>a.state==='FAILED').length,recording:inventoryRows.filter(a=>a.state==='RECORDING').length},items:selected.slice(offset,offset+limit),total_matches:selected.length,has_more:offset+limit<selected.length};
    });
  }
}
