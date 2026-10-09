import assert from 'node:assert/strict';
import test from 'node:test';
import {createThotAnalyticsUI} from '../apps/dashboard/thot-analytics-ui.js';

const escape=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const status={network:'Robinhood Chain Testnet',test_assets:true,complete:true,through_block:20,target_block:20,notice:'Confirmed through this block.'};
const money=n=>(BigInt(n)*10n**18n).toString();
function make(state,api=async()=>({})){return createThotAnalyticsUI({state,api,escape,toast:()=>{}});}
test('private referral view uses current contract terms and separates earned, pending and pooled claims',()=>{
 const state={thot:{account:{qualified:money(100000),seller_bps:null,referral_bps:2000,claimable:money(20),economics:{service_fee:'40000000000000000',direct_cost:'10000000000000000'}}},thotAnalytics:{status,own:{independent_seller_atoms:money(100),treasury_seller_atoms:money(50)},buyer_pricing:{configured:false,block:20},referrals:{attributed_contributors:3,pending_atoms:money(10),earned_atoms:money(20),paid_atoms:null,paid_min_atoms:'0',paid_max_atoms:money(10),pooled_paid_atoms:money(10),basis:'Claims pool all credits.',term_seconds:365*86400,activation_window_seconds:90*86400,my_referrer:null,ledger:[],next_cursor:null}}};
 const html=make(state).referralsHTML();assert.match(html,/0\.0400 THOT/);assert.match(html,/0\.0100 THOT/);assert.match(html,/20% of net service contribution/);assert.match(html,/no membership surcharge/);assert.match(html,/365 days/);assert.match(html,/within 90 days of attribution/);assert.doesNotMatch(html,/70%|180 days|qualified lock tier/);assert.match(html,/Pending referral allocation/);assert.match(html,/Finalized referral earnings/);assert.match(html,/0\.0000 THOT–10\.0000 THOT/);assert.doesNotMatch(html,/undefined|NaN|\$20/);
});
test('leaderboard escapes pseudonyms, defaults to no identity opt-in, and clears private state on reset',()=>{
 const state={thotAnalytics:{profile:{opted_in:false,label:'" onfocus="bad'}},thotLeaderboard:{kind:'earners',items:[{label:'<script>bad</script>',amount:money(1),sales:1}],status,basis:'Finalized.',exclusions:'Treasury excluded.'}};
 const ui=make(state),html=ui.leaderboardHTML();assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|value="" onfocus|type="checkbox" checked/);assert.match(html,/correlated with public blockchain/);
 ui.reset();assert.equal(state.thotAnalytics,null);assert.equal(state.thotLeaderboard,null);
});
test('portfolio distinguishes encrypted storage from producer-dependent preview sizes and does not invent earnings',()=>{
 const state={thotPortfolio:{summary:{traces:1,preview_bytes:'100',encrypted_storage_bytes:900,bytes_basis:'Preview sizes only.',storage_basis:'Encrypted objects.'},items:[{trace_id:'trace',source:'Codex',model:'<model>',model_evidence:'response_reported',preview_bytes:'100',state:'private',sale_count:0}],status},thotCohort:{status:'insufficient_data',minimum:{traces:20,contributors:3,buyers:3},eligible_traces:2,sold_traces:1,distinct_contributors:1,distinct_buyers:1,basis:'Not a personalized prediction.'}};
 const html=make(state).portfolioHTML();assert.match(html,/Recorded preview size/);assert.match(html,/900 bytes/);assert.match(html,/not enough mature market history/);assert.match(html,/&lt;model&gt;/);assert.doesNotMatch(html,/expected daily|free money|\$|undefined|NaN/);
});
test('an account change during load cannot restore the previous owner data and a queued refresh recovers',async t=>{
 const previous=globalThis.document,root={outerHTML:''};globalThis.document={getElementById:id=>id==='thot-market-leaderboards'?root:null};t.after(()=>{globalThis.document=previous;});
 const state={loaded:true,actor:{id:'alice'},generation:1};let resolveOld=[];
 const api=path=>state.actor.id==='alice'?new Promise(resolve=>resolveOld.push(resolve)):Promise.resolve(path.includes('leaderboard')?{kind:'earners',items:[],status,basis:'',exclusions:''}:{wallet:'bob',profile:{opted_in:false,label:''}});
 const ui=make(state,api),pending=ui.ready();assert.equal(resolveOld.length,2);
 state.actor={id:'bob'};state.generation++;ui.reset();await ui.ready();
 resolveOld[0]({wallet:'alice'});resolveOld[1]({kind:'earners',items:[{label:'Alice secret',amount:'1',sales:1}],status});
 await assert.rejects(pending,/account changed/);assert.equal(state.thotAnalytics.wallet,'bob');assert.equal(state.thotLeaderboard.items.length,0);assert.doesNotMatch(root.outerHTML,/Alice secret/);
});

test('an empty later leaderboard page still exposes Previous after a cursor load',async t=>{
 const previous=globalThis.document;globalThis.document={getElementById:()=>null};t.after(()=>{globalThis.document=previous;});
 const state={loaded:true,thotLeaderboard:{kind:'earners',items:[{label:'Example participant',amount:money(1),sales:1}],next_cursor:'next-page',status}};
 const ui=make(state);await ui.handle('analytics-rank-next',{});
 state.thotLeaderboard={kind:'earners',items:[],next_cursor:null,status};
 assert.match(ui.leaderboardHTML(),/analytics-rank-previous/);
});
