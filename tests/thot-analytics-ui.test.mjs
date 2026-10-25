import assert from 'node:assert/strict';
import test from 'node:test';
import {createThotAnalyticsUI} from '../apps/dashboard/thot-analytics-ui.js';

const escape=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const status={network:'Robinhood Chain Testnet',test_assets:true,complete:true,through_block:20,target_block:20,notice:'Confirmed through this block.'};
const money=n=>(BigInt(n)*10n**18n).toString();
function make(state,api=async()=>({})){return createThotAnalyticsUI({state,api,escape,toast:()=>{}});}
test('private referral view uses current contract terms and separates earned, pending and pooled claims',()=>{
 const state={thot:{account:{block:{number:20},qualified:money(100000),seller_bps:null,referral_bps:2000,claimable:money(20),economics:{service_fee:'40000000000000000',direct_cost:'10000000000000000'}}},thotAnalytics:{status,own:{independent_seller_atoms:money(100),treasury_seller_atoms:money(50)},buyer_pricing:{configured:false,block:20},referrals:{attributed_contributors:3,pending_atoms:money(10),earned_atoms:money(20),paid_atoms:null,paid_min_atoms:'0',paid_max_atoms:money(10),pooled_paid_atoms:money(10),basis:'Claims pool all credits.',term_seconds:365*86400,activation_window_seconds:90*86400,my_referrer:null,ledger:[],next_cursor:null}}};
 const html=make(state).referralsHTML();assert.match(html,/0\.04 THOT/);assert.match(html,/0\.01 THOT/);assert.match(html,/20% of net service contribution/);assert.match(html,/no membership surcharge/);assert.match(html,/365 days/);assert.match(html,/within 90 days of attribution/);assert.doesNotMatch(html,/70%|180 days|qualified lock tier/);assert.match(html,/Pending referral allocation/);assert.match(html,/Finalized referral earnings/);assert.match(html,/0 THOT–10 THOT/);assert.doesNotMatch(html,/undefined|NaN|\$20/);
});
test('percentage referral terms use the trace-price rate, never the one-THOT account sample as a fixed fee',()=>{
 const state=salesIndexFixture();
 state.thot.account.economics={policy:'percentage/1',fee_bps:125,service_fee:'12500000000000000',direct_cost:'0'};
 state.thot.holder_rewards={mode:'upfront-discount',policy:{}};
 const html=make(state).referralsHTML();
 assert.match(html,/1\.25% of the listed price/);
 assert.match(html,/independent buyer and seller discounts at funding/);
 assert.match(html,/Discount percentages apply to the service fee, not the price/);
 assert.match(html,/Estimates do not guarantee a sale or payout/);
 assert.doesNotMatch(html,/0\.0125 THOT|Holding or locking THOT does not change|Each purchase deducts/);
 assert.equal(state.thot.account.economics.service_fee,'12500000000000000');
});
test('quoted-cost referrals preserve fixed tariff and distinguish separate cashback from sale proceeds',()=>{
 const state=salesIndexFixture();
 state.thot.account.economics={policy:'quoted-cost/1',fee_bps:null,service_fee:'40000000000000000',direct_cost:'10000000000000000'};
 state.thot.holder_rewards={mode:'cashback',policy:{}};
 const html=make(state).referralsHTML();
 assert.match(html,/0\.04 THOT per purchase, including 0\.01 THOT of direct costs/);
 assert.match(html,/1\.5 times allocated overhead/);
 assert.match(html,/cashback is claimed after settlement and does not change the quoted seller proceeds/);
 assert.doesNotMatch(html,/1% of|discounts at funding/);
});
test('unavailable or unknown account economics never manufacture a zero or fixed fee',()=>{
 for(const economics of [undefined,{policy:'future-policy/1',service_fee:'0',direct_cost:'0'},{policy:'percentage/1',fee_bps:null,service_fee:'10000000000000000'},{policy:'percentage/1',fee_bps:0,service_fee:'0'}]){
  const state=salesIndexFixture();state.thot.account.economics=economics;
  const html=make(state).referralsHTML();assert.match(html,/current service fee is unavailable/);assert.doesNotMatch(html,/0\.01 THOT per purchase|\b0% of|0 THOT per purchase/);
 }
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

function salesIndexFixture(accountBlock=20){
 return {thot:{wallet:'0x'+'a'.repeat(40),orders:[],account:{block:{number:accountBlock},claimable:money(7),economics:{service_fee:money(1),direct_cost:money(1)}}},thotAnalytics:{status:{...status},own:{independent_seller_atoms:money(12),treasury_seller_atoms:money(3)},referrals:{attributed_contributors:1,pending_atoms:money(4),earned_atoms:money(2),paid_atoms:money(1),pooled_paid_atoms:money(13),basis:'Claims pool all credits.',term_seconds:365*86400,my_referrer:null,ledger:[],next_cursor:null}}};
}
const finalizedSale=(id,amount,patch={})=>({id,seller:'0x'+'a'.repeat(40),receipt:{status:5,seller_amount:money(amount),independent:true,treasury:false},...patch});
test('newer account blocks without known missing payments retain valid indexed money',()=>{
 const state=salesIndexFixture(21),html=make(state).referralsHTML();
 assert.match(html,/<small>Independent item sales<\/small><strong>12 THOT<\/strong>/);
 assert.match(html,/<small>Finalized referral earnings<\/small><strong>2 THOT<\/strong>/);
 assert.match(html,/Pooled payments to your wallet: <strong>13 THOT<\/strong>/);
 assert.match(html,/Recent payments may take a moment to appear/);assert.doesNotMatch(html,/Updating…/);
 assert.match(html,/Indexed through block 20 of 20\. Account confirmed through block 21/);
});
test('known finalized seller receipts mark an actual indexed undershoot updating until caught up',()=>{
 const state=salesIndexFixture(21);state.thot.orders=[finalizedSale('old-sale',8),finalizedSale('new-sale',4)];state.thotAnalytics.own.independent_seller_atoms=money(8);
 const ui=make(state),html=ui.referralsHTML();
 for(const label of ['Independent item sales','Treasury item sales','Pending referral allocation','Finalized referral earnings'])assert.ok(html.includes(`<small>${label}</small><strong>Updating…</strong>`));
 assert.match(html,/Paid referral allocation: <strong>Updating…<\/strong>/);assert.match(html,/Pooled payments to your wallet: <strong>Updating…<\/strong>/);
 assert.match(html,/<small>Your pooled claimable balance<\/small><strong>7 THOT<\/strong>/);
 assert.match(html,/Your latest sale is confirmed\. Sales and referral totals are catching up/);
 state.thotAnalytics.status={...status,through_block:21,target_block:21};state.thotAnalytics.own.independent_seller_atoms=money(12);
 const caughtUp=ui.referralsHTML();assert.match(caughtUp,/<small>Independent item sales<\/small><strong>12 THOT<\/strong>/);assert.doesNotMatch(caughtUp,/Updating…|catching up/);
});
test('receipt lower bounds deduplicate sales and preserve seller and independence scopes',()=>{
 const state=salesIndexFixture(21),receipt={status:5,seller_amount:money(3),independent:false,treasury:true};
 state.thot.orders=[finalizedSale('sale',12),finalizedSale('SALE',12,{seller:state.thot.wallet.toUpperCase()}),finalizedSale('foreign',100,{seller:'0x'+'b'.repeat(40)}),finalizedSale('pending',100,{receipt:{status:3,seller_amount:money(100),independent:true,treasury:false}}),finalizedSale('unreviewed',100,{receipt:{status:5,seller_amount:money(100),independent:false,treasury:false}}),finalizedSale('treasury',3,{receipt})];
 const ui=make(state);assert.doesNotMatch(ui.referralsHTML(),/Updating…/);
 state.thotAnalytics.own.treasury_seller_atoms='0';assert.match(ui.referralsHTML(),/<small>Treasury item sales<\/small><strong>Updating…<\/strong>/);
});
test('matching confirmed account and index heads show exact indexed totals and no catch-up notice',()=>{
 const html=make(salesIndexFixture()).referralsHTML();
 assert.match(html,/<small>Independent item sales<\/small><strong>12 THOT<\/strong>/);
 assert.match(html,/<small>Finalized referral earnings<\/small><strong>2 THOT<\/strong>/);
 assert.match(html,/Indexed through block 20 of 20/);assert.doesNotMatch(html,/Updating…|catching up|Recent payments/);
});
test('unknown account heads retain complete indexed totals while missing or incomplete indexes stay updating',()=>{
 for(const accountHead of [null,undefined]){
  const state=salesIndexFixture();state.thot.account.block.number=accountHead;
  const html=make(state).referralsHTML();assert.match(html,/<small>Independent item sales<\/small><strong>12 THOT<\/strong>/);assert.match(html,/Indexed through block 20 of 20/);assert.doesNotMatch(html,/Updating…|Account confirmed/);
 }
 for(const patch of [{through_block:null},{complete:false}]){
  const state=salesIndexFixture();Object.assign(state.thotAnalytics.status,patch);
  const html=make(state).referralsHTML();assert.match(html,/totals are still updating/);assert.match(html,/<small>Independent item sales<\/small><strong>Updating…<\/strong>/);
 }
});
