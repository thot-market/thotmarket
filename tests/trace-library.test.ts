import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {appendCapturedExchange} from '../packages/market/src/capture-session.ts';

const actor={id:'demo-user',role:'user' as const},operator={id:'operator',role:'operator_security' as const};
async function fixture(t:any){const dir=await mkdtemp(join(tmpdir(),'thot-library-')),app=await createApplication({dataDir:dir,memory:true});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return app;}

test('revised older context does not multiply a known native conversation or discard a new identical answer',()=>{
  const u=(content:string)=>({role:'user',content}),a=(content:string)=>({role:'assistant',content});
  const prior=[u('original context'),a('old response'),u('recent question'),a('Done.')];
  const view={context_turn_count:5,turns:[u('revised old context'),a('old response'),u('recent question'),a('Done.'),u('recent question'),a('Done.')]};
  const saved=[...prior];appendCapturedExchange(saved,view,'same-native-key','same-native-key');
  assert.deepEqual(saved,[...prior,u('recent question'),a('Done.')]);
  const reset=[...prior];appendCapturedExchange(reset,view,'old-native-key','new-native-key');
  assert.deepEqual(reset,[...prior,...view.turns],'A new native conversation retains its own context even when the text repeats');
  const unknown=[...prior];appendCapturedExchange(unknown,view,null,null);
  assert.deepEqual(unknown,[...prior,...view.turns],'Interior matching requires the known same native identity');
});

test('an ambiguous repeated history anchor keeps the earliest boundary and every new response',()=>{
  const pair=[{role:'user',content:'Again?'},{role:'assistant',content:'Yes.'}],prefix=[{role:'user',content:'initial'},{role:'assistant',content:'first'}];
  const target=[...prefix,...pair],history=[{role:'user',content:'revised'},...pair,...pair],fresh={role:'assistant',content:'Yes.'};
  appendCapturedExchange(target,{context_turn_count:history.length,turns:[...history,fresh]},'native','native');
  assert.deepEqual(target,[...prefix,...pair,...pair,fresh]);
});

test('an auxiliary request cannot cause the main conversation history to be appended again',()=>{
  const main=[{role:'user',content:'Main question'},{role:'assistant',content:'Main answer'}],aux=[{role:'user',content:'Choose a title'},{role:'assistant',content:'A title'}];
  const target=[...main,...aux],next=[...main,{role:'user',content:'Follow up'},{role:'assistant',content:'New answer'}];
  appendCapturedExchange(target,{turns:next,context_turn_count:3},'native','native');
  assert.deepEqual(target,[...main,...aux,...next.slice(2)]);
});
async function save(app:any,text='A useful answer about tests.'){
  const c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true}),now=new Date().toISOString();
  const p={sequence:1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from(JSON.stringify({model:'claude-fixture',messages:[{role:'user',content:'Review the concurrency bug.'}]})).toString('base64'),response_body_b64:Buffer.from(JSON.stringify({type:'message',content:[{type:'text',text}],stop_reason:'end_turn'})).toString('base64'),status:200,content_type:'application/json',started_at:now,finished_at:now,complete:true};
  const part={...p,commitment:canonicalHash(p)};await app.agentCapture.part(c.capture_id,c.upload_token,'library-stage-'+c.capture_id,{part});
  const m={format:'thot.proxy-capture/2',capture_id:c.capture_id,client:'claude',started_at:now,finished_at:now,parts:[{sequence:1,commitment:part.commitment}]};
  return app.agentCapture.checkpoint(c.capture_id,c.upload_token,'library-checkpoint-'+c.capture_id,{bundle:{...m,root:canonicalHash(m)}});
}

test('owner reads a live saved conversation, bookmarks and annotates it without changing proof or exposing private metadata',async t=>{
  const app=await fixture(t),saved=await save(app),before=await app.agentCapture.proof(actor,saved.capture_id);
  const library=await app.library.list(actor);assert.equal(library.summary.saved,1);assert.equal(library.summary.recording,1);assert.equal(library.items[0].title,'Review the concurrency bug.');
  const item=await app.library.item(actor,saved.trace_id);assert.equal(item.content.turns[1].content,'A useful answer about tests.');assert.equal(item.state,'RECORDING');assert.ok(item.events.some(e=>e.label==='Checkpoint saved'));
  await app.library.update(actor,'bookmark-test',saved.trace_id,{bookmarked:true,title:'My private lock lesson',note:'Use this explanation for the next locking review.'});
  const found=await app.library.list(actor,{q:'locking review',bookmarked:'true'});assert.equal(found.items[0].trace_id,saved.trace_id);assert.equal(found.summary.bookmarked,1);
  assert.deepEqual((await app.agentCapture.proof(actor,saved.capture_id)).receipt,before.receipt);
  assert.deepEqual((await app.agentCapture.proof(actor,saved.capture_id)).bundle,before.bundle);
  const records=JSON.stringify((await app.db.query('SELECT document FROM traces WHERE id=$1',[saved.trace_id])).rows);
  assert.ok(!records.includes('private lock lesson'));assert.ok(!records.includes('locking review'));
  assert.ok(!JSON.stringify((await app.db.query('SELECT payload FROM audit_events')).rows).includes('locking review'));
  await assert.rejects(app.library.item({id:'other-user',role:'user'},saved.trace_id),/NOT_FOUND/);
  await assert.rejects(app.library.update({id:'other-user',role:'user'},'cross-owner-note',saved.trace_id,{note:'overwrite'}),/NOT_FOUND/);
  await assert.rejects(app.library.item(operator,saved.trace_id),/FORBIDDEN/);
  const explorer=await app.library.operator(operator);assert.equal(explorer.summary.saved,1);assert.equal(explorer.summary.recording,1);
  assert.ok(!JSON.stringify(explorer).includes('Review the concurrency bug'));assert.ok(!JSON.stringify(explorer).includes('locking review'));
});

test('a realistically sized mixed inventory paginates stably, excludes deleted and foreign items, and reconciles operator totals',async t=>{
  const app=await fixture(t),now=new Date().toISOString(),expires=new Date(Date.now()+86400000).toISOString();
  // Synthetic inventory records exercise query/count semantics, not provenance.
  await app.db.transaction(async tx=>{
    for(let i=0;i<1000;i++){const id='synthetic-library-'+String(i).padStart(5,'0');await tx.insert('traces',id,actor.id,{trace_id:id,created_at:now,retention_expires_at:expires,deleted:false,import_preview:{title:'Saved session '+i,source_label:i%2?'Codex (user supplied)':'Claude Code (user supplied)',turn_count:2},projection:{status:i%20===0?'UNREADABLE':'READY'},provenance_status:'IMPORTED_UNVERIFIED'});}
    await tx.insert('traces','foreign-item','other-user',{trace_id:'foreign-item',created_at:now,retention_expires_at:expires,deleted:false,import_preview:{title:'Foreign secret'}});
    await tx.insert('traces','deleted-item',actor.id,{trace_id:'deleted-item',created_at:now,retention_expires_at:expires,deleted:true});
  });
  const first=await app.library.list(actor,{limit:100});assert.equal(first.summary.saved,1000);assert.equal(first.total_matches,1000);assert.equal(first.items.length,100);
  const second=await app.library.list(actor,{limit:100,cursor:first.next_cursor});assert.equal(new Set([...first.items,...second.items].map(i=>i.trace_id)).size,200);
  assert.ok(!JSON.stringify(first).includes('Foreign secret'));
  const codex=await app.library.list(actor,{source:'codex',limit:100});assert.equal(codex.total_matches,500);
  const exact=await app.library.list(actor,{q:'session 999'});assert.equal(exact.total_matches,1);
  const counts=await app.library.operator(operator);assert.equal(counts.summary.saved,1001);assert.equal(counts.summary.readable+counts.summary.preparing+counts.summary.display_issues,counts.summary.saved);
});

test('failed capture attempts remain visible even when no conversation row was created',async t=>{
  const app=await fixture(t),c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true});
  await assert.rejects(app.agentCapture.complete(c.capture_id,c.upload_token,'bad-manifest',{bundle:{}}));
  const explorer=await app.library.operator(operator,{state:'FAILED'});assert.equal(explorer.summary.saved,0);assert.equal(explorer.summary.failed_attempts,1);assert.equal(explorer.items[0].capture_id,c.capture_id);assert.ok(explorer.items[0].error_code);
  await assert.rejects(app.library.operator(actor),/FORBIDDEN/);
});

test('a configured contributor may inspect only the read-only explorer and keeps ordinary vault access',async t=>{
  const app=await fixture(t),saved=await save(app);
  await assert.rejects(app.library.operator(actor),/FORBIDDEN/);
  app.service.config.traceExplorerViewers=[actor.id];
  assert.equal(app.library.canExplore(actor),true);
  assert.equal((await app.library.operator(actor)).summary.saved,1);
  assert.equal((await app.library.item(actor,saved.trace_id)).trace_id,saved.trace_id);
  await assert.rejects(app.library.item({id:'other-user',role:'user'},saved.trace_id),/NOT_FOUND/);
  await assert.rejects(app.service.reconciliation(actor),/FORBIDDEN/,'Read-only explorer access must not grant operational controls');
  delete app.service.config.traceExplorerViewers;
  await assert.rejects(app.library.operator(actor),/FORBIDDEN/);
});

async function saveNative(app:any,client:'claude'|'codex',session:string,previous:any[]=[],owner=actor,secondSession?:string){
  const c=await app.agentCapture.begin(owner,{client,save_privately:true}),now=new Date().toISOString(),parts:any[]=[];
  for(const [index,id] of [session,...(secondSession?[secondSession]:[])].entries()){
    const turns=[...previous,{role:'user',content:previous.length?'Continue the investigation.':'Find the queue bug.'}];
    const request=client==='claude'?{model:previous.length?'new-claude':'first-claude',metadata:{user_id:JSON.stringify({session_id:id})},messages:turns}:{model:previous.length?'new-codex':'first-codex',client_metadata:{thread_id:id},input:turns.map(t=>({type:'message',role:t.role,content:[{type:t.role==='assistant'?'output_text':'input_text',text:t.content}]}))};
    const text=previous.length?'The resumed answer adds a regression test.':'The original answer finds the retry race.';
    const response=client==='claude'?{type:'message',content:[{type:'text',text}],stop_reason:'end_turn'}:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]};
    const p={sequence:index+1,upstream:client==='claude'?'https://api.anthropic.com':'https://chatgpt.com',path:client==='claude'?'/v1/messages':'/backend-api/codex/responses',request_body_b64:Buffer.from(JSON.stringify(request)).toString('base64'),response_body_b64:Buffer.from(JSON.stringify(response)).toString('base64'),status:200,content_type:'application/json',started_at:now,finished_at:now,complete:true};
    const part={...p,commitment:canonicalHash(p)};parts.push({sequence:part.sequence,commitment:part.commitment});await app.agentCapture.part(c.capture_id,c.upload_token,'native-stage-'+c.capture_id+'-'+index,{part});
  }
  const m={format:'thot.proxy-capture/2',capture_id:c.capture_id,client,started_at:now,finished_at:now,parts};
  return app.agentCapture.complete(c.capture_id,c.upload_token,'native-complete-'+c.capture_id,{bundle:{...m,root:canonicalHash(m)}});
}

for(const client of ['claude','codex'] as const)test(client+': native resume keeps one library record, distinct proofs, and reusable metadata',async t=>{
  const app=await fixture(t),id='98464535-5678-4000-8000-123456789abc';
  const first=await saveNative(app,client,id),before=await app.agentCapture.proof(actor,first.capture_id),initial=await app.library.item(actor,first.trace_id);
  await app.library.update(actor,'native-bookmark-first',first.trace_id,{title:'My reusable queue lesson',note:'Remember the retry race.',bookmarked:true});
  const second=await saveNative(app,client,id,initial.content.turns),secondProof=await app.agentCapture.proof(actor,second.capture_id);
  const library=await app.library.list(actor);assert.equal(library.summary.saved,1);assert.equal(library.raw_trace_count,2);assert.equal(library.summary.bookmarked,1);assert.equal(library.items[0].segments,2);
  const resumed=await app.library.item(actor,second.trace_id);assert.equal(resumed.trace_id,first.trace_id);assert.equal(resumed.title,'My reusable queue lesson');assert.equal(resumed.content.turns.length,4);assert.match(resumed.content.turns[3].content,/resumed answer/);
  assert.equal(resumed.capture_segments.length,2);assert.equal(resumed.capture_segments[1].capture_id,second.capture_id);assert.equal(resumed.capture_segments[1].turn_start,2);assert.deepEqual(resumed.model_history.map((m:any)=>m.model),['first-'+client,'new-'+client]);
  const explorer=await app.library.operator(operator);assert.equal(explorer.summary.saved,1);assert.equal(explorer.summary.raw_traces,2);assert.equal(explorer.summary.capture_attempts,2);assert.equal(explorer.items[0].segments,2);assert.equal((await app.library.operator(operator,{view:'attempts'})).items.length,2);
  assert.doesNotMatch(JSON.stringify(explorer),/reusable queue|retry race|resumed answer/);
  // Resume copied annotations before any subsequent group-wide edit.
  const continuationMetadata=await app.db.transaction(async tx=>{const trace=await tx.get('traces',second.trace_id);return app.privacy.open(actor.id,trace.personal_ref);});
  assert.equal(continuationMetadata.title,'My reusable queue lesson');assert.equal(continuationMetadata.bookmarked,true);
  await app.library.update(actor,'native-edit-group',second.trace_id,{note:'Use this regression when reviewing the queue.',bookmarked:true,title:'Queue regression'});
  assert.equal((await app.library.list(actor,{q:'reviewing the queue'})).total_matches,1);
  assert.deepEqual((await app.agentCapture.proof(actor,first.capture_id)).receipt,before.receipt);assert.deepEqual((await app.agentCapture.proof(actor,second.capture_id)).bundle,secondProof.bundle);
  await assert.rejects(app.library.item({id:'foreign-user',role:'user'},second.trace_id),/NOT_FOUND/);
  // Deleting/expiring an older segment must leave the retained continuation and its annotation usable.
  await app.service.deleteTrace(actor,'native-delete-first',first.trace_id);
  await app.db.transaction(tx=>app.service.deleteTraceObjects(tx,first.trace_id));
  const remaining=await app.library.item(actor,second.trace_id);assert.equal(remaining.segments,1);assert.equal(remaining.title,'Queue regression');assert.match(remaining.note,/reviewing the queue/);
});

test('native identities never join unrelated, mixed, or imported records',async t=>{
  const app=await fixture(t),one='98464535-5678-4000-8000-123456789abc',two='98464535-5678-4000-8000-123456789def';
  const first=await saveNative(app,'claude',one);await saveNative(app,'claude',two);
  const mixed=await saveNative(app,'claude',one,[],actor,two);
  assert.equal((await app.library.list(actor)).summary.saved,3,'Same prompt text does not group different or mixed native conversations');
  const item=await app.library.item(actor,mixed.trace_id);assert.equal(item.native_conversations,2);assert.equal(item.segments,1);
  const {conversationGroups,nativeConversationKey}=await import('../packages/market/src/capture-session.ts');
  const key=nativeConversationKey('one','claude',{metadata:{user_id:JSON.stringify({session_id:one})}});
  assert.notEqual(key,nativeConversationKey('two','claude',{metadata:{user_id:JSON.stringify({session_id:one})}}));
  assert.equal(nativeConversationKey('one','claude',{metadata:{user_id:'not json'}}),undefined);
  assert.equal(nativeConversationKey('one','codex',{prompt_cache_key:one}),undefined,'Cache keys alone do not identify a conversation');
  const base={created_at:'2026-09-12',native_session_keys:[key],agent_capture_id:'capture'};
  assert.equal(conversationGroups([{...base,trace_id:first.trace_id,owner_id:'one'},{...base,trace_id:'foreign',owner_id:'two'},{...base,trace_id:'import',owner_id:'one',agent_capture_id:null}]).length,3);
});

test('the reader opens recent turns, can page back, and cannot redisplay cleared owner state',async()=>{
  // @ts-expect-error Browser-native UI module.
  const {createLibraryUI}=await import('../apps/dashboard/library-ui.js');
  let html='';const el={innerHTML:'',scrollIntoView(){}};
  const item={title:'Long work',source:'Claude Code',content:{turns:Array.from({length:85},(_,i)=>({role:'user',content:'MESSAGE_'+String(i+1).padStart(3,'0')}))},events:[],model_history:[],capture_segments:[],origin:'upload'};
  const ui=createLibraryUI({state:{},api:async()=>item,openDialog(_title:string,_subtitle:string,body:string){html=body;},dialog:{},escape:(s:any)=>String(s??''),toast(){}});
  const original=globalThis.document;Object.assign(globalThis,{document:{querySelector:()=>el}});
  try{
    await ui.handle('library-open',{dataset:{id:'test'}});assert.match(html,/MESSAGE_085/);assert.doesNotMatch(html,/MESSAGE_001/);assert.match(html,/Turns 46–85 of 85/);
    await ui.handle('library-earlier',{});assert.match(el.innerHTML,/MESSAGE_006/);assert.doesNotMatch(el.innerHTML,/MESSAGE_085/);
    await ui.handle('library-earlier',{});assert.match(el.innerHTML,/MESSAGE_001/);assert.match(el.innerHTML,/Turns 1–5 of 85/);
    ui.reset();el.innerHTML='';await ui.handle('library-later',{});assert.equal(el.innerHTML,'');
  }finally{Object.assign(globalThis,{document:original});ui.reset();}
});

test('readable continuation after compaction does not append its entire replayed context again',async()=>{
  const {appendConversationTurns}=await import('../packages/market/src/capture-session.ts');
  const turn=(content:string)=>({role:'user',content});
  const saved=['original','first answer'].map(turn);
  appendConversationTurns(saved,['summary','new task','new answer'].map(turn));
  appendConversationTurns(saved,['summary','new task','new answer','follow-up','follow-up answer'].map(turn));
  assert.deepEqual(saved.map(t=>t.content),['original','first answer','summary','new task','new answer','follow-up','follow-up answer']);
  appendConversationTurns(saved,['summary','new task','new answer','follow-up','follow-up answer'].map(turn));assert.equal(saved.length,7);
});
