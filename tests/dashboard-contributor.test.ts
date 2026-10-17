import test from 'node:test';
import assert from 'node:assert/strict';
// Dashboard modules are intentionally browser-native JavaScript.
// @ts-expect-error There is no separate declaration artifact for this local UI module.
import { createContributorUI } from '../apps/dashboard/contributor-ui.js';

const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
function ui(portfolio:any,apiResult:any={}) {
  const state:any={contributorPortfolio:portfolio};
  const calls:any[]=[],dialogs:any[]=[];
  const instance=createContributorUI({state,api:async(path:string,options:any)=>{calls.push({path,options});return apiResult;},openDialog(...args:any[]){dialogs.push(args);},dialog:{open:false,close(){}},refresh:async()=>{},toast(){},escape,json:(v:any)=>escape(JSON.stringify(v)),badge:(v:any)=>`<span>${escape(v)}</span>`,date:(v:any)=>String(v??''),short:(v:any)=>String(v??'').slice(0,8)});
  return {instance,calls,dialogs,state};
}

test('contributor portfolio keeps evidence, estimate, and linked credential claims distinct',()=>{
  const {instance}=ui({capabilities:{robinhood_linking:true},robinhood:{status:'linked',verified_at:'2026-09-07',expires_at:'2026-09-08'},items:[{trace_id:'trace-1',title:'Session',source:'Claude Code (user supplied)',turn_count:12,content_commitment:'a'.repeat(64),rights_status:'eligible',evidence:{status:'USER_SUPPLIED'},appraisal:{estimated_value_minor:'740',estimator_version:'demo-v1',eligible_for_brokerage_research:true}}]});
  const html=instance.sectionHTML();
  assert.match(html,/Robinhood/);assert.match(html,/Connected/);assert.match(html,/View details/);
  assert.match(html,/USER_SUPPLIED/i);assert.match(html,/Demo estimate/);assert.match(html,/\$7\.40/);assert.match(html,/not offers or earnings/);
  assert.match(html,/See research offer/);
  assert.doesNotMatch(html,/verified provider history/i);
});

test('unconfigured Robinhood linking cannot render a successful or actionable link state',()=>{
  const {instance}=ui({capabilities:{browser_linking:false,reason:'Measured services are absent.'},robinhood:{status:'not_linked'},items:[]});
  const html=instance.sectionHTML();
  assert.match(html,/Connection unavailable/);assert.match(html,/unavailable in this setup/);
  assert.doesNotMatch(html,/data-action="link-robinhood"/);assert.doesNotMatch(html,/Robinhood account linked/);
});

test('terminal Robinhood status overrides a stale progress stage',()=>{
  const {instance}=ui({capabilities:{browser_linking:true},robinhood:{status:'expired',stage:'awaiting_browser_login'},items:[]});
  const html=instance.sectionHTML();assert.match(html,/Connection expired/);assert.doesNotMatch(html,/Finish signing in/);assert.match(html,/BROKERAGE ACCOUNT/);
});

test('Robinhood linking opens the browser companion and shows concise unverified progress',async t=>{
  const {instance,dialogs,calls}=ui({capabilities:{browser_linking:true},robinhood:{status:'not_linked'},items:[]},{job_id:'job-1',status:'pending',stage:'awaiting_browser_login'});
  t.after(()=>instance.reset());
  await instance.handle('link-robinhood',{dataset:{}});
  const rendered=dialogs[0].join(' ');
  assert.deepEqual(calls.map(call=>call.path),['/v1/contributor/robinhood/link-jobs','/v1/contributor/robinhood/link-jobs/job-1/browser']);
  assert.match(rendered,/Sign in to Robinhood/);assert.match(rendered,/finish connecting automatically/);
  assert.doesNotMatch(rendered,/ticket|command|proof|password|token|<code>|type="file"/i);
  instance.reset();
});

test('coding-session import distinguishes private storage from one later automatic-sale authorization',async t=>{
 const prior=(globalThis as any).document;
 const file={name:'coding-session.jsonl',size:100,text:async()=>'{"type":"user"}\n'};
 const fields:any={'#research-file':{files:[file]},'#research-rights':{checked:true},'#research-license':{checked:false,disabled:true},'#confirm-research':{disabled:false,textContent:''}};
 (globalThis as any).document={querySelector:(selector:string)=>fields[selector]};t.after(()=>{(globalThis as any).document=prior;});
 const {instance,dialogs}=ui({items:[]},{title:'Coding session',content_commitment:'abc',turn_count:2});
 await instance.handle('import-research',{dataset:{}});
 assert.match(dialogs[0].join(' '),/Claude Code or Codex coding-session JSONL, up to 2 MB/);
 await instance.onSubmit({id:'research-preview-form'});
 const html=dialogs.at(-1).join(' ');assert.match(html,/Saving keeps this conversation private/);assert.match(html,/do not list or sell it/);assert.match(html,/sign once to enable an automatic THOT sale/);assert.match(html,/matching purchase then needs no further approval/);assert.doesNotMatch(html,/approve each release/);
 instance.onChange({id:'research-rights'});assert.equal(fields['#confirm-research'].textContent,'Save privately with sale rights');assert.equal(fields['#research-license'].disabled,false);
});

test('library upload entry identifies supported tools and session-file scope',async()=>{
 // @ts-expect-error Browser-native UI module.
 const {createLibraryUI}=await import('../apps/dashboard/library-ui.js');
 const instance=createLibraryUI({state:{traceLibrary:{items:[],summary:{saved:0},attempts:[]}},escape});
 const html=instance.sectionHTML();assert.match(html,/Upload session file/);assert.match(html,/Claude Code or Codex coding-session \.jsonl file, up to 2 MB/);assert.doesNotMatch(html,/>Upload history</);
});

test('private library reader submits explicit release rights without listing or signing',async t=>{
 // @ts-expect-error Browser-native UI module.
 const {createLibraryUI}=await import('../apps/dashboard/library-ui.js');
 const prior=(globalThis as any).FormData;(globalThis as any).FormData=class{get(k:string){return k==='rights_confirmed'?'on':null;}};
 t.after(()=>{(globalThis as any).FormData=prior;});
 const item:any={trace_id:'trace-private',title:'Private session',source:'Claude Code',origin:'upload',content:{turns:[]},events:[],model_history:[],private_import:{can_prepare_sale:true,content_commitment:'a'.repeat(64)}};
 const calls:any[]=[],dialogs:string[]=[],toasts:string[]=[];
 const instance=createLibraryUI({state:{},api:async(path:string,options:any)=>{calls.push({path,options});if(options?.method==='POST'){item.private_import=null;return{status:'AVAILABLE',listed:false};}return item;},openDialog(_t:string,_s:string,body:string){dialogs.push(body);},dialog:{},escape,toast:(message:string)=>toasts.push(message)});
 await instance.handle('library-open',{dataset:{id:item.trace_id}});
 assert.match(dialogs[0],/Prepare release for review/);assert.match(dialogs[0],/Uploaded history remains unverified/);
 await instance.onSubmit({id:'library-prepare-sale',dataset:{id:item.trace_id}});
 const post=calls.find(c=>c.options?.method==='POST');assert.equal(post.path,'/v1/contributor/library/trace-private/prepare-sale');
 assert.deepEqual(post.options.body,{content_commitment:'a'.repeat(64),rights_confirmed:true,model_output_licensed:false});
 assert.doesNotMatch(dialogs.at(-1)!,/id="library-prepare-sale"/);assert.match(toasts.at(-1)!,/Review & sell/);
 assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);
});

test('library explains release blockers without offering a rights bypass for private captures',async()=>{
 // @ts-expect-error Browser-native UI module.
 const {createLibraryUI}=await import('../apps/dashboard/library-ui.js');
 const item:any={trace_id:'private-capture',title:'Private capture',source:'Codex',origin:'capture',projection:'READY',content:{turns:[]},events:[],model_history:[],private_import:null};
 const dialogs:string[]=[];
 const instance=createLibraryUI({state:{},api:async()=>item,openDialog(_t:string,_s:string,body:string){dialogs.push(body);},dialog:{},escape,toast(){}});
 for(const [reason,explanation] of [
  ['TRACE_RIGHTS_REVIEW_REQUIRED',/P2 capture proof does not grant licensing rights/],
  ['PROJECTION_NOT_READY',/Wait for the complete readable view/],
  ['RELEASE_CHANGED',/earlier content commitment cannot authorize changed content/],
  ['RELEASE_CONTENT_LIMIT',/exceeds the supported release assessment limit/],
  ['RELEASE_EVIDENCE_UNAVAILABLE',/assessed release or its evidence is unavailable/],
  ['EXPLICIT_AUTOMATIC_SALE_CONSENT_REQUIRED',/licence and price, then sign/]
 ] as const){
  item.sale_eligibility={reason_code:reason,can_prepare_sale:false};
  await instance.handle('library-open',{dataset:{id:item.trace_id}});
  const html=dialogs.at(-1)!;assert.match(html,explanation);assert.match(html,/Listing requires explicit seller authorization/);assert.doesNotMatch(html,/id="library-prepare-sale"/);
 }
});

test('My work separates confirmed payouts, pending sales and insufficient comparables from wallet holdings',async()=>{
 // @ts-expect-error Browser-native UI module.
 const {createLibraryUI}=await import('../apps/dashboard/library-ui.js');
 const owner='0x'+'1'.repeat(40),buyer='0x'+'2'.repeat(40),atoms=(n:number)=>(BigInt(n)*10n**18n).toString();
 const item={trace_id:'trace-1',title:'Synthetic coding trace',source:'Codex',origin:'upload',turn_count:3,state:'IMPORTED',sale_eligibility:{can_list:true,reason_code:'EXPLICIT_AUTOMATIC_SALE_CONSENT_REQUIRED'}};
 const state:any={traceLibrary:{items:[item],summary:{saved:1},attempts:[]},thot:{capabilities:{mode:'thot-anvil'},wallet:owner,account:{balance:atoms(9999)},orders:[
  {seller:owner,buyer,receipt:{status:5,seller_amount:atoms(3)},payout_transaction:'0x'+'a'.repeat(64)},
  {seller:owner,buyer,receipt:{status:5,seller_amount:atoms(8)}},
  {seller:owner,buyer,receipt:{status:3,seller_amount:atoms(5)}},
  {seller:buyer,buyer:owner,receipt:{status:5,seller_amount:atoms(17)},payout_transaction:'0x'+'b'.repeat(64)},
 ],valuations:[{trace_id:'trace-1',estimate:{independent:{status:'insufficient_data'},sponsored:{status:'estimated',median_gross_atoms:atoms(400)}}}]}};
 const ui=createLibraryUI({state,escape});const html=ui.sectionHTML();
 assert.match(html,/Paid to your wallet[\s\S]*3\.00 THOT/);assert.match(html,/Pending sale proceeds[\s\S]*5\.00 THOT/);
 assert.doesNotMatch(html,/9,999|17\.00|11\.00|400\.00/);assert.match(html,/Not enough comparable sales yet/);
 assert.match(html,/data-action="thot-list-configure" data-id="trace-1"/);
 state.thot.capabilities.mode='unconfigured';assert.doesNotMatch(ui.sectionHTML(),/data-action="thot-list-configure"/);state.thot.capabilities.mode='thot-anvil';
 state.thot.own_listings=[{id:'owned-listing',trace_id:'trace-1',active:true,price_atoms:atoms(9)}];
 assert.match(ui.sectionHTML(),/>Listed<\/span>/);assert.match(ui.sectionHTML(),/Your asking price/);assert.match(ui.sectionHTML(),/data-action="thot-unlist" data-id="owned-listing"/);
});
