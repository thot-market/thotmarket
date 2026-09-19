import test from 'node:test';
import assert from 'node:assert/strict';
import {createThotUI} from '../apps/dashboard/thot-ui.js';

const owner='0x0000000000000000000000000000000000000001';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const atoms=n=>(BigInt(n)*10n**18n).toString();
function make(state,api=async()=>({})){const dialogs=[];const ui=createThotUI({state,api,openDialog:(...a)=>dialogs.push(a),dialog:{close(){}},refresh:async()=>{},escape:esc,json:JSON.stringify,toast(){}});return {ui,dialogs};}

test('trade proof controls are capability gated and listing consent is explicit',()=>{
 const state={role:'user',actor:{id:'a'},generation:1,traces:[{trace_id:'t',title:'Trace'}],thot:{wallet:owner,capabilities:{mode:'thot-anvil',chain_id:31337,trade_evidence:true},account:{claimable:'0'},orders:[],listings:[]}};
 const {ui}=make(state);const html=ui.offersHTML();assert.match(html,/Add trade proof/);
 state.thot.capabilities.trade_evidence=false;assert.doesNotMatch(ui.offersHTML(),/Add trade proof/);
});

test('public brokerage claim renders bounded observed proof and evaluation action',()=>{
 const state={role:'buyer_member',actor:{id:'b'},generation:1,traces:[],thot:{wallet:owner,capabilities:{mode:'thot-anvil',chain_id:31337},account:{claimable:'0'},orders:[],listings:[{id:'l',seller:'0x0000000000000000000000000000000000000002',title:'Listed',workflow:'research',turn_count:2,provenance:'recorded',price_atoms:atoms(1),license:'evaluation',brokerage_claim:{symbol:'AAPL',window_days:7,claim:'Observed trade, not P&L or account-wide history.'}}]}};
 const {ui}=make(state);const html=ui.offersHTML();assert.match(html,/Observed trade/);assert.match(html,/not P&amp;L|not P&amp;L/);assert.match(html,/data-action="thot-trade-evidence" data-id="l"/);
 state.thot.wallet=state.thot.listings[0].seller;assert.doesNotMatch(ui.offersHTML(),/data-action="thot-trade-evidence"/);
 state.thot.wallet=null;assert.doesNotMatch(ui.offersHTML(),/data-action="thot-trade-evidence"/);
});

function listingFixture(t,fields){
 const previousWindow=globalThis.window,previousDocument=globalThis.document;
 const calls=[],dialogs=[],state={role:'user',actor:{id:'seller'},generation:1,thot:{wallet:owner,capabilities:{mode:'thot-anvil',chain_id:31337,market:owner},account:{seller_bps:5000,claimable:'0'},orders:[]}};
 const inputs={...fields};
 globalThis.window={ethereum:{request:async p=>p.method==='eth_requestAccounts'?[owner]:p.method==='eth_chainId'?'0x7a69':p.method==='eth_signTypedData_v4'?'0x'+'ab'.repeat(65):{status:'0x1'}}};
 globalThis.document={querySelector:id=>inputs[id]??{value:'',checked:false}};
 const ui=createThotUI({state,api:async(path,options)=>{calls.push({path,options});if(path.endsWith('/metadata'))return {trace_id:'t',content_hash:'h',trade_evidence:[{id:'proof-1',evidence_hash:'hash-1',symbol:'AAPL',window_days:7}]};if(path==='/v1/thot/listings')return {id:'listing',typed_data:{domain:{chainId:31337,verifyingContract:owner}}};return {id:'listing'};},openDialog:(...a)=>dialogs.push(a),dialog:{close(){}},refresh:async()=>{},escape:esc,json:JSON.stringify,toast(){}});
 t.after(()=>{globalThis.window=previousWindow;globalThis.document=previousDocument;});
 return {ui,state,calls,dialogs};
}

test('listing request omits trade disclosure fields unless a proof is selected and checked',async t=>{
 const f=listingFixture(t,{'#thot-trace':{value:'t'},'#thot-title':{value:'T'},'#thot-price':{value:'1'},'#thot-license':{value:'L'},'#thot-list-consent':{checked:true},'#thot-treasury-consent':{checked:false},'#thot-trade-evidence-id':{value:''},'#thot-trade-evidence-disclosure':{checked:false}});
 await f.ui.action('thot-list-configure',{dataset:{}});await f.ui.action('thot-list-confirm',{dataset:{},disabled:false});
 const body=f.calls.find(c=>c.path==='/v1/thot/listings').options.body;assert.equal('trade_evidence_id' in body,false);assert.equal('trade_evidence_hash' in body,false);assert.equal('trade_evidence_disclosure' in body,false);
});

test('selected and explicitly checked proof posts the exact id and hash',async t=>{
 const f=listingFixture(t,{'#thot-trace':{value:'t'},'#thot-title':{value:'T'},'#thot-price':{value:'1'},'#thot-license':{value:'L'},'#thot-list-consent':{checked:true},'#thot-treasury-consent':{checked:false},'#thot-trade-evidence-id':{value:'proof-1'},'#thot-trade-evidence-disclosure':{checked:true}});
 await f.ui.action('thot-list-configure',{dataset:{}});await f.ui.action('thot-list-confirm',{dataset:{},disabled:false});
 const body=f.calls.find(c=>c.path==='/v1/thot/listings').options.body;assert.equal(body.trade_evidence_id,'proof-1');assert.equal(body.trade_evidence_hash,'hash-1');assert.equal(body.trade_evidence_disclosure,true);
});

test('selected proof without disclosure consent blocks listing submission',async t=>{
 const f=listingFixture(t,{'#thot-trace':{value:'t'},'#thot-title':{value:'T'},'#thot-price':{value:'1'},'#thot-license':{value:'L'},'#thot-list-consent':{checked:true},'#thot-treasury-consent':{checked:false},'#thot-trade-evidence-id':{value:'proof-1'},'#thot-trade-evidence-disclosure':{checked:false}});
 await f.ui.action('thot-list-configure',{dataset:{}});await assert.rejects(f.ui.action('thot-list-confirm',{dataset:{},disabled:false}),/explicit trade-proof disclosure/);assert.equal(f.calls.some(c=>c.path==='/v1/thot/listings'),false);
});

test('stale account during begin or complete never opens a dialog or attaches proof',async t=>{
 const previousWindow=globalThis.window,previousDocument=globalThis.document;const wait=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
 const state={role:'user',actor:{id:'a'},generation:1,thot:{wallet:owner,capabilities:{mode:'thot-anvil',chain_id:31337,trade_evidence:true}}};const begin=wait(),complete=wait();let stage=0;
 globalThis.window={prompt:msg=>msg.startsWith('Symbol')?'AAPL':'7',ethereum:{request:async p=>p.method==='eth_chainId'?'0x7a69':[owner]}};globalThis.document={querySelector:id=>id==='#thot-trace'?{value:'t'}:{value:'{}',checked:false}};const dialogs=[];const calls=[];
 const ui=createThotUI({state,api:async(path)=>{calls.push(path);if(path.endsWith('/begin')){await begin.promise;return {job_id:'j',link_ticket:'k'};}await complete.promise;return {id:'e'};},openDialog:(...a)=>dialogs.push(a),dialog:{close(){}},refresh:async()=>{},escape:esc,json:JSON.stringify,toast(){}});t.after(()=>{globalThis.window=previousWindow;globalThis.document=previousDocument;});
 const b=ui.action('thot-trade-evidence-manual',{dataset:{},disabled:false});await new Promise(r=>setImmediate(r));state.actor.id='replacement';state.generation++;begin.resolve();await assert.rejects(b,{name:'StaleWorkspaceError'});assert.equal(dialogs.length,0);
 state.actor.id='a';state.generation++;stage=1;const c=ui.action('thot-trade-evidence-complete',{dataset:{id:'j'},disabled:false});await new Promise(r=>setImmediate(r));state.actor.id='replacement';state.generation++;complete.resolve();await assert.rejects(c,{name:'StaleWorkspaceError'});assert.equal(calls.filter(p=>p.endsWith('/complete')).length,1);
});

test('oversized or non-object proof envelopes are rejected before complete API',async t=>{
 const pending={job_id:'job-1'};const calls=[];const state={role:'user',actor:{id:'seller'},generation:1,thot:{wallet:owner,capabilities:{mode:'thot-anvil',chain_id:31337,trade_evidence:true}}};
 globalThis.window={prompt:()=>'',ethereum:{request:async p=>p.method==='eth_chainId'?'0x7a69':[owner]}};
 let value='[]';globalThis.document={querySelector:id=>id==='#thot-trade-evidence-json'?{value}:id==='#thot-trace'?{value:'t'}:{value:'',checked:false}};
 const ui=createThotUI({state,api:async(path,o)=>{calls.push({path,o});return pending;},openDialog(){},dialog:{close(){}},refresh:async()=>{},escape:esc,json:JSON.stringify,toast(){}});
 await assert.rejects(ui.action('thot-trade-evidence-complete',{dataset:{id:'job-1'},disabled:false}),/JSON object/);assert.equal(calls.length,0);
 value='x'.repeat(1024*1024+1);await assert.rejects(ui.action('thot-trade-evidence-complete',{dataset:{id:'job-1'},disabled:false}),/larger than 1 MB/);assert.equal(calls.length,0);
});

test('buyer inspection renders the API bounded claim without claiming private proof disclosure',async t=>{
 const previous=globalThis.window;globalThis.window={ethereum:{}};t.after(()=>{globalThis.window=previous;});
 const state={role:'buyer_member',actor:{id:'buyer'},generation:1,thot:{wallet:owner,capabilities:{mode:'thot-anvil',chain_id:31337}}};
 const {ui,dialogs}=make(state,async()=>({release_hash:'0x123',brokerage_claim:{symbol:'AAPL',window_days:7,claim:'traded:AAPL:within_7d'},brokerage_evidence:{proof:'PRIVATE_PROOF_MUST_NOT_RENDER'}}));
 await ui.action('thot-trade-evidence',{dataset:{id:'listing'}});
 assert.match(dialogs[0][2],/Observed trade<\/strong> · AAPL/);
 assert.match(dialogs[0][2],/does not establish P&amp;L/);
 assert.doesNotMatch(dialogs[0][2],/symbol unavailable|PRIVATE_PROOF_MUST_NOT_RENDER|Exact proof and release binding/);
 assert.match(dialogs[0][2],/The signed proof remains private/);
 assert.match(dialogs[0][2],/0x123/);
});

test('guided trade action gives a scoped local helper command before creating a capture ticket',async t=>{
 const oldWindow=globalThis.window,oldDocument=globalThis.document;t.after(()=>{globalThis.window=oldWindow;globalThis.document=oldDocument;});
 globalThis.window={location:{origin:'https://thot.example'},prompt:label=>label.startsWith('Symbol')?'aapl':'7'};
 globalThis.document={querySelector:()=>({value:'trace-123'})};
 let calls=0;const {ui,dialogs}=make({role:'user',actor:{id:'seller'},generation:1,thot:{wallet:owner,capabilities:{trade_evidence:true}}},async()=>{calls++;return {};});
 await ui.action('thot-trade-evidence-begin',{dataset:{}});
 assert.equal(calls,0);assert.match(dialogs[0][2],/thot-link robinhood --thot-url https:\/\/thot.example --trade-trace trace-123 --symbol AAPL --window-days 7/);
});
