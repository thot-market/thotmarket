import test from 'node:test';
import assert from 'node:assert/strict';
import {createThotUI} from '../apps/dashboard/thot-ui.js';

const owner='0x0000000000000000000000000000000000000001';
const other='0x0000000000000000000000000000000000000002';
const hash=index=>'0x'+String(index).padStart(64,'0');
const transactions=[{to:owner,data:'0xaaaa',value:'0x0',chainId:'0x7a69'},{to:owner,data:'0xbbbb',value:'0x0',chainId:'0x7a69'}];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const button=()=>({dataset:{},disabled:false});
function fixture(t,request,respond,options={}){
 const previousWindow=globalThis.window,previousDocument=globalThis.document;
 const state={actor:{id:'seller'},generation:1,role:'user',thot:{wallet:owner,capabilities:{chain_id:31337,dispute_seconds:3600}}};
 const requests=[],dialogs=[],calls=[],notices=[];let refreshes=0;
 globalThis.window={ethereum:{request:async p=>{requests.push(p);if(p.method==='eth_requestAccounts')return [state.thot.wallet];if(p.method==='eth_chainId')return '0x7a69';return request(p,state);}}};
 globalThis.document={querySelector:()=>({value:'10000'})};
 const ui=createThotUI({state,api:async(path,options)=>{calls.push({path,options});return respond?respond(path,options):{transactions,notice:'Review the lock.'};},openDialog:(...args)=>dialogs.push(args),dialog:{close(){}},refresh:async()=>{refreshes++;},escape:String,json:JSON.stringify,toast:m=>notices.push(m),...options});
 t.after(()=>{globalThis.window=previousWindow;globalThis.document=previousDocument;});
 return {ui,state,requests,dialogs,calls,notices,get refreshes(){return refreshes;},prepare:()=>ui.action('thot-lock',button()),send:()=>ui.action('thot-send',button())};
}

test('two confirmation clicks during wallet connection send only one approval and one lock',async t=>{
 const pause=deferred(),started=deferred();let sends=0,connections=0;
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x1'});
 const original=window.ethereum.request;
 window.ethereum.request=async p=>{if(p.method==='eth_requestAccounts'&&++connections===1){started.resolve();await pause.promise;}return original(p);};
 await f.prepare();const first=f.send();await started.promise;await f.send();pause.resolve();await first;
 assert.equal(sends,2);assert.equal(f.refreshes,1);assert.equal(f.notices.length,1);
});

test('timeout retries check the same hash and never repeat a confirmed approval',async t=>{
 t.mock.method(globalThis,'setTimeout',fn=>{queueMicrotask(fn);return 0;});
 let sends=0,settled=false;
 const f=fixture(t,async p=>{
  if(p.method==='eth_sendTransaction')return hash(++sends);
  return p.params[0]===hash(1)||settled?{status:'0x1',transactionHash:p.params[0]}:null;
 });
 await f.prepare();await assert.rejects(f.send(),/Confirmation is pending.*will not be submitted again/);
 assert.equal(sends,2);assert.equal(f.refreshes,0);
 settled=true;await f.send();assert.equal(sends,2);assert.equal(f.refreshes,1);
});

test('a receipt RPC failure preserves both the known hash and confirmed earlier steps',async t=>{
 let sends=0,fail=true;
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction')return hash(++sends);if(p.params[0]===hash(2)&&fail)throw Error('RPC disconnected');return {status:'0x1'};});
 await f.prepare();await assert.rejects(f.send(),/RPC disconnected/);fail=false;await f.send();assert.equal(sends,2);
});

test('ambiguous submission without a hash is not automatically resent',async t=>{
 let sends=0;
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction'){sends++;throw Error('Wallet transport closed');}throw Error('Unexpected receipt request');});
 await f.prepare();await assert.rejects(f.send(),/Wallet transport closed/);
 await assert.rejects(f.send(),/may already have submitted/);assert.equal(sends,1);
});

test('explicit wallet rejection permits retry, but no later transaction is sent beforehand',async t=>{
 let sends=0,reject=true;
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction'){sends++;if(reject){reject=false;throw Object.assign(Error('User rejected'),{code:4001});}return hash(sends);}return {status:'0x1'};});
 await f.prepare();await assert.rejects(f.send(),/User rejected/);assert.equal(sends,1);await f.send();assert.equal(sends,3);
});

test('a reverted step is never resent by confirmation and blocks later transactions',async t=>{
 let sends=0;
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x0'});
 await f.prepare();await assert.rejects(f.send(),/reverted/);await assert.rejects(f.send(),/reverted/);assert.equal(sends,1);
});

test('account change while submission is returning prevents remaining steps under the replacement identity',async t=>{
 const pending=deferred(),started=deferred();let sends=0;
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction'){sends++;if(sends===1){started.resolve();return pending.promise;}return hash(sends);}return {status:'0x1'};});
 await f.prepare();const sending=f.send();await started.promise;
 f.state.actor={id:'replacement'};f.state.thot.wallet=other;f.state.generation++;pending.resolve(hash(1));
 await assert.rejects(sending,{name:'StaleWorkspaceError'});await assert.rejects(f.send(),{name:'StaleWorkspaceError'});assert.equal(sends,1);
 f.state.actor={id:'seller'};f.state.thot.wallet=owner;f.state.generation++;await f.prepare();
 assert.equal(f.dialogs.at(-1)[0],'Resume your previous wallet action');await f.send();assert.equal(sends,2);
});

test('a refresh requires new review and resumes known hashes instead of duplicating a lock',async t=>{
 let sends=0,fail=true;
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction')return hash(++sends);if(p.params[0]===hash(2)&&fail)throw Error('temporary RPC failure');return {status:'0x1'};});
 await f.prepare();await assert.rejects(f.send(),/temporary RPC failure/);f.state.generation++;
 await assert.rejects(f.send(),{name:'StaleWorkspaceError'});fail=false;await f.prepare();
 assert.match(f.dialogs.at(-1)[2],/previously submitted action is still unresolved/);await f.send();assert.equal(sends,2);
});

const atoms=n=>(BigInt(n)*10n**18n).toString();
function viewFixture(){
 const state={role:'user',traces:[{trace_id:'private-1',title:'My research'}],thot:{
  capabilities:{mode:'thot-anvil',chain_id:31337,market:other,dispute_seconds:3600,subjective_dispute_min_qualifying_spend:atoms(10000000),seller_response_seconds:86400,dispute_vote_seconds:604800,dispute_review_threshold:2},wallet:owner,
  account:{balance:atoms(900000),qualified:atoms(10000),seller_bps:5000,claimable:atoms(17),finalized_independent_spend:atoms(10000000),lots:[]},
  listings:[{id:'listing-1',seller:other,title:'Listed research',workflow:'research',turn_count:4,provenance:'IMPORTED_UNVERIFIED',price_atoms:atoms(100),license:'Evaluation only'}],orders:[],
 }};
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const ui=createThotUI({state,escape,json:JSON.stringify});
 return {state,ui};
}

test('listing choices use the private library title without changing their trace identifier',()=>{
 const {state,ui}=viewFixture();state.traces=[{trace_id:'private-1'}];
 state.traceLibrary={items:[{trace_id:'private-1',title:'My <coding> session'}]};
 assert.match(ui.offersHTML(),/<option value="private-1">My &lt;coding&gt; session<\/option>/);
});

test('Offers, Earnings and THOT have distinct content and keep actions in their intended view',()=>{
 const {ui}=viewFixture(),offers=ui.offersHTML(),earnings=ui.earningsHTML(),token=ui.tokenHTML();
 assert.match(offers,/<h1>A buyer for your work\.<\/h1>/);
 assert.match(offers,/data-action="thot-list-configure"/);assert.match(offers,/data-action="thot-buy"/);
 assert.doesNotMatch(offers,/id="thot-lock"|id="thot-referrer"|data-action="thot-claim"/);
 assert.match(earnings,/<h1>What your work has earned\.<\/h1>/);assert.match(earnings,/data-action="thot-claim"/);
 assert.doesNotMatch(earnings,/id="thot-lock"|id="thot-referrer"|id="thot-workflow"|data-action="thot-buy"/);
 assert.match(token,/<h1>Put time behind your THOT\.<\/h1>/);
 assert.match(token,/data-staking-preview/);assert.match(token,/Enrollment opens after the reward pool is funded/);
 assert.doesNotMatch(token,/id="thot-lock"|Lock tiers/);assert.match(token,/id="thot-referrer"/);
 assert.doesNotMatch(token,/data-action="thot-buy"|Your sale receipts/);assert.match(token,/data-action="thot-claim"/);
});

test('ordinary listings expose metadata actions but reserve release controls only for a persisted selection',()=>{
 const {state,ui}=viewFixture();state.role='buyer_member';state.thot.reserve_buyer=true;state.thot.listings[0].treasury_opt_in=true;
 let html=ui.offersHTML();assert.match(html,/listing metadata.*allowlisted predicate results/i);assert.match(html,/thot-assay/);assert.match(html,/thot-buy/);assert.doesNotMatch(html,/thot-buyer-sample|thot-reserve-buy|free preview/i);
 state.thot.listings[0].treasury_sample_available=true;html=ui.offersHTML();assert.match(html,/thot-buyer-sample/);assert.match(html,/thot-reserve-buy/);
});

test('earnings separates unaccepted offers, pending proceeds, finalized allocations and refunds without counting purchases as income',()=>{
 const {state,ui}=viewFixture();
 state.thot.orders=[0,1,2,3,4,5,6].map(status=>({id:'sale-'+status,title:'Sale '+status,seller:owner,buyer:other,gross:atoms(1000),receipt:{status,seller_amount:atoms(10*(status+1)),seller_bps:3000,referral_amount:'0',treasury:status===2}}));
 state.thot.orders.push({id:'my-purchase',title:'My purchase',seller:other,buyer:owner,gross:atoms(99999),receipt:{status:5,seller_amount:atoms(99999)}});
 const html=ui.earningsHTML();
 assert.match(html,/PENDING SALE PROCEEDS<\/small><strong>120\.0000 THOT/);
 assert.match(html,/FINALIZED SALES · RECENT RECORDS<\/small><strong>60\.0000 THOT/);
 assert.match(html,/AVAILABLE TO CLAIM<\/small><strong>17\.0000 THOT/);
 assert.match(html,/20\.0000 THOT offered as your share/);
 assert.match(html,/Refunded · no sale proceeds/);assert.match(html,/buyer refunds/);
 assert.match(html,/Treasury-sponsored purchase/);assert.match(html,/External buyer purchase/);
 assert.doesNotMatch(html,/My purchase|Sale 0|99,999|70\.0000 THOT/);
 assert.match(html,/Not a lifetime total/);
});

test('all three pages remain distinct before linking a wallet and provide a link action',()=>{
 const {state,ui}=viewFixture();state.thot.wallet=null;state.thot.account=null;
 const pages=[ui.offersHTML(),ui.earningsHTML(),ui.tokenHTML()];
 assert.equal(new Set(pages).size,3);
 for(const html of pages){assert.match(html,/data-action="thot-link"/);assert.doesNotMatch(html,/NaN|undefined/);}
 assert.match(pages[0],/Available traces/);assert.doesNotMatch(pages[1],/Available traces/);assert.match(pages[2],/A price you can check/);
});

test('earnings preserves freshness, truncated-history disclosure and escaped receipt content',()=>{
 const {state,ui}=viewFixture();state.thot.orders_truncated=true;
 state.thot.orders=[{id:'<script>receipt</script>',title:'<img src=x onerror=alert(1)>',seller:owner,buyer:other,gross:atoms(10),receipt:{status:5,seller_amount:atoms(3),seller_bps:3000}}];
 const html=ui.earningsHTML({updatedAt:new Date(0),error:true});
 assert.match(html,/id="earnings-freshness" role="status"/);assert.match(html,/Could not refresh/);
 assert.match(html,/latest 50 purchase records/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script>|<img src=x/);
});

test('buyer roles can claim refunded purchase funds in Offers without accessing contributor Earnings',()=>{
 const {state,ui}=viewFixture();
 for(const role of ['buyer_admin','buyer_member']){
  state.role=role;
  const html=ui.offersHTML();
  assert.match(html,/Available to claim/);assert.match(html,/17\.0000 THOT/);assert.match(html,/data-action="thot-claim"/);
  assert.doesNotMatch(html,/data-view="earnings"|data-action="thot-list-configure"/);
  assert.doesNotMatch(ui.tokenHTML(),/data-view="earnings"/);
 }
});

test('enrollment requires explicit consent then one signature and activation, without a seller payment transaction',async t=>{
 const signature='0x'+'ab'.repeat(65),typed={domain:{name:'thot market'},types:{SaleAuthorization:[]},message:{gross:atoms(100)}};
 const f=fixture(t,async p=>{assert.equal(p.method,'eth_signTypedData_v4');assert.deepEqual(JSON.parse(p.params[1]),typed);return signature;},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1)}:path.endsWith('/activate')?{id:'listing'}:{id:'listing',typed_data:typed});
 const inputs={'#thot-trace':{value:'trace'},'#thot-title':{value:'Useful research'},'#thot-price':{value:'100'},'#thot-license':{value:'Exact non-exclusive research licence'},'#thot-list-consent':{checked:false},'#thot-treasury-consent':{checked:true}};
 document.querySelector=id=>inputs[id];
 await f.ui.action('thot-list-configure',button());
 await assert.rejects(f.ui.action('thot-list-confirm',button()),/Authorize the content rights/);
 assert.equal(f.calls.length,1);inputs['#thot-list-consent'].checked=true;
 await f.ui.action('thot-list-confirm',button());
 assert.equal(f.calls[1].options.body.automatic_sales,true);assert.equal(f.calls[1].options.body.treasury_opt_in,true);assert.equal(f.calls[1].options.body.treasury_sampling_consent,'thot.treasury-sampling/1');assert.equal(f.calls[1].options.body.free_preview,undefined);
 assert.deepEqual(f.calls[2],{path:'/v1/thot/listings/activate',options:{method:'POST',body:{id:'listing',signature}}});
 assert.equal(f.requests.filter(p=>p.method==='eth_signTypedData_v4').length,1);
 assert.equal(f.requests.filter(p=>p.method==='eth_sendTransaction').length,0);
});

test('listing setup never renders returned trace text and reserve sampling remains optional',async t=>{
 const secret='TRACE_TEXT_MUST_STAY_PRIVATE_IN_LISTING_SETUP';
 const f=fixture(t,async()=>{},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1),content:{turns:[{role:'user',content:secret}]}}:{id:'listing',typed_data:{}});
 const inputs={'#thot-trace':{value:'trace'},'#thot-title':{value:'Useful research'},'#thot-price':{value:'100'},'#thot-license':{value:'Exact non-exclusive research licence'},'#thot-list-consent':{checked:true},'#thot-treasury-consent':{checked:false}};document.querySelector=id=>inputs[id];
 await f.ui.action('thot-list-configure',button());assert.doesNotMatch(f.dialogs.at(-1)[2],new RegExp(secret));assert.match(f.dialogs.at(-1)[2],/no ordinary pre-purchase trace preview/i);
 await f.ui.action('thot-list-confirm',button());const body=f.calls.find(call=>call.path==='/v1/thot/listings').options.body;assert.equal(body.treasury_opt_in,false);assert.equal(body.treasury_sampling_consent,undefined);assert.equal(body.free_preview,undefined);
});

test('a signature returned after account replacement never activates the former contributor listing',async t=>{
 const signed=deferred(),started=deferred();
 const f=fixture(t,async p=>{if(p.method==='eth_signTypedData_v4'){started.resolve();return signed.promise;}throw Error('Unexpected wallet transaction');},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1)}:{id:'listing',typed_data:{}});
 document.querySelector=()=>({value:'test',checked:true});await f.ui.action('thot-list-configure',button());
 const action=f.ui.action('thot-list-confirm',button());await started.promise;f.state.actor={id:'other'};f.state.generation++;signed.resolve('0x'+'ab'.repeat(65));
 await assert.rejects(action,{name:'StaleWorkspaceError'});assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);
});

test('unlisting prepares onchain revocation instead of pretending a hidden listing invalidates its signature',async t=>{
 const f=fixture(t,async()=>{throw Error('No wallet until review');},async()=>({transactions:[transactions[0]],notice:'Confirm revocation. Already funded sales remain authorized.'}));
 await f.ui.action('thot-unlist',{dataset:{id:'listing'}});
 assert.equal(f.dialogs.at(-1)[0],'Stop future automatic purchases');assert.match(f.dialogs.at(-1)[2],/Already funded sales remain authorized/);assert.equal(f.requests.length,0);
});

test('comparable estimates stay separate from earnings and show missing market data without invented value',()=>{
 const {state,ui}=viewFixture();
 state.thot.valuations=[{trace_id:'private-1',estimate:{status:'insufficient_data',independent:{status:'insufficient_data'},sponsored:{status:'estimated',median_gross_atoms:atoms(100),p25_gross_atoms:atoms(80),p75_gross_atoms:atoms(120),sample_count:3,distinct_contributors:3},basis:'gross_licence_price_conditional_on_sale'}}];
 const html=ui.valuationsHTML();assert.match(html,/Independent buyers: not enough comparable sales/);assert.match(html,/Treasury-sponsored samples: 100\.0000 THOT/);assert.match(html,/ESTIMATED · NOT A BALANCE/);assert.doesNotMatch(html,/\$|expected earnings|per day/i);
 assert.match(ui.earningsHTML(),/AVAILABLE TO CLAIM<\/small><strong>17\.0000 THOT/);
 state.role='buyer_admin';assert.equal(ui.valuationsHTML(),'');
});

test('treasury tools are operator-scoped and expose only paid retrieval actions',()=>{
 const {state,ui}=viewFixture();state.thotSampling={capabilities:{mode:'thot-anvil'},reserve:{balance:atoms(500000000),allowance:atoms(1000),committed:'0'},jobs:[{id:'pending',title:'Unfunded',gross:atoms(100),status:'queued',receipt:{status:0}},{id:'paid',title:'Paid',gross:atoms(100),receipt:{status:3,seller_amount:atoms(30)}}],batches:[]};
 assert.equal(ui.samplingHTML(),'');state.role='operator_security';const html=ui.samplingHTML();
 assert.match(html,/thot-sample-preview/);assert.match(html,/thot-delivery" data-id="paid/);assert.doesNotMatch(html,/thot-delivery" data-id="pending/);
});

test('earnings identifies a confirmed wallet payment batch without calling other finalized receipts paid',()=>{
 const {state,ui}=viewFixture();const receipt={status:5,seller_amount:atoms(30),seller_bps:3000};
 state.thot.orders=[{id:'paid-sale',seller:owner,buyer:other,title:'Delivered research',gross:atoms(100),receipt,payout_transaction:hash(9)},{id:'unclaimed-sale',seller:owner,buyer:other,title:'Other research',gross:atoms(100),receipt}];
 const html=ui.earningsHTML();assert.equal(html.split('Paid to your wallet').length-1,1);assert.match(html,/Wallet payment batch/);assert.match(html,/may include other finalized proceeds/);assert.match(html,/Finalized allocation; it may already have been claimed/);
});

test('Robinhood testnet renders each real THOT journey with test-asset labelling and explorer links',()=>{
 const {state,ui}=viewFixture();state.thot.capabilities={mode:'thot-testnet',chain_name:'Robinhood Chain Testnet',chain_id:46630,market:other,explorer_url:'https://explorer.testnet.chain.robinhood.com'};
 for(const html of [ui.offersHTML(),ui.earningsHTML(),ui.tokenHTML()]){
  assert.match(html,/Robinhood Chain Testnet/);assert.match(html,/not dollars or mainnet earnings/);assert.doesNotMatch(html,/Local demo|Local Anvil/);
  assert.match(html,/https:\/\/explorer.testnet.chain.robinhood.com\/address\//);
 }
 state.role='operator_security';state.thotSampling={capabilities:state.thot.capabilities,reserve:{balance:atoms(500000000),allowance:atoms(1000),committed:'0'},jobs:[]};
 assert.match(ui.samplingHTML(),/Queue|Review sampling budget/);
});

test('delivered purchases expose only time-valid dispute or finalize actions and overdue refunds',()=>{
 const {state,ui}=viewFixture();state.thot.orders=[{id:'delivered',title:'Research',seller:other,buyer:owner,gross:atoms(100),receipt:{status:3,seller_amount:atoms(30),referral_amount:'0',delivered_at:100000,independent:true,treasury:false,block:{timestamp:100001}}}];
 let html=ui.offersHTML();assert.match(html,/Undisputed proceeds become payable/);assert.match(html,/thot-dispute/);assert.doesNotMatch(html,/thot-finalize/);
 state.thot.account.finalized_independent_spend=atoms(9999999);assert.doesNotMatch(ui.offersHTML(),/thot-dispute/);
 state.thot.account.finalized_independent_spend=atoms(10000000);state.thot.orders[0].receipt.treasury=true;assert.doesNotMatch(ui.offersHTML(),/thot-dispute/);
 state.thot.orders[0].receipt.treasury=false;
 state.thot.orders[0].receipt.block.timestamp=103599;html=ui.offersHTML();assert.match(html,/thot-dispute/);assert.doesNotMatch(html,/thot-finalize/);
 state.thot.orders[0].receipt.block.timestamp=103600;html=ui.offersHTML();assert.match(html,/thot-finalize/);assert.doesNotMatch(html,/thot-dispute/);
 state.thot.orders[0].receipt={status:2,seller_amount:atoms(30),accepted_at:100000,block:{timestamp:272800}};assert.doesNotMatch(ui.offersHTML(),/thot-refundUndelivered/);
 state.thot.orders[0].receipt.block.timestamp++;assert.match(ui.offersHTML(),/thot-refundUndelivered/);
});

test('settlement displays the deployed market period and preserves old 24-hour receipts during migration',()=>{
 const {state,ui}=viewFixture();
 assert.match(ui.earningsHTML(),/after 1 hour from recorded delivery/);
 state.thot.orders=[{id:'old-market',title:'Original purchase',seller:other,buyer:owner,gross:atoms(100),receipt:{status:3,seller_amount:atoms(30),delivered_at:100000,dispute_seconds:86400,independent:true,treasury:false,block:{timestamp:103600}}}];
 assert.match(ui.offersHTML(),/thot-dispute/);assert.doesNotMatch(ui.offersHTML(),/thot-finalize/);
 state.thot.orders[0].receipt.block.timestamp=186400;
 assert.match(ui.offersHTML(),/thot-finalize/);assert.doesNotMatch(ui.offersHTML(),/thot-dispute/);
 state.thot.capabilities.dispute_seconds=86400;
 assert.match(ui.earningsHTML(),/after 24 hours from recorded delivery/);
 delete state.thot.orders[0].receipt.dispute_seconds;state.thot.capabilities.dispute_seconds=null;
 assert.match(ui.offersHTML(),/Checking the contract’s dispute period/);
 assert.doesNotMatch(ui.offersHTML(),/thot-finalize|thot-dispute/);
});

test('12-hour markets keep each receipt’s dispute deadline through a deployment change',()=>{
 const {state,ui}=viewFixture();state.thot.capabilities.dispute_seconds=43200;
 assert.match(ui.earningsHTML(),/after 12 hours from recorded delivery/);
 assert.match(ui.earningsHTML(),/12-hour dispute window/);
 for(const seconds of [3600,43200,86400]){
  const receipt={status:2,seller_amount:atoms(30),accepted_at:99900,delivered_at:100000,dispute_seconds:seconds,independent:true,treasury:false,block:{timestamp:100000+seconds-1}};
  state.thot.orders=[{id:'delivered',title:'Research',seller:other,buyer:owner,gross:atoms(100),receipt}];
  assert.match(ui.offersHTML(),new RegExp(`${seconds/3600}-hour dispute window`));
  receipt.status=3;
  assert.match(ui.offersHTML(),/thot-dispute/);assert.doesNotMatch(ui.offersHTML(),/thot-finalize/);
  receipt.block.timestamp++;
  assert.match(ui.offersHTML(),/thot-finalize/);assert.doesNotMatch(ui.offersHTML(),/thot-dispute/);
 }
 // A receipt from the new market remains 12 hours when the workspace still shows the deployed 1-hour market.
 state.thot.capabilities.dispute_seconds=3600;state.thot.orders[0].receipt.dispute_seconds=43200;state.thot.orders[0].receipt.block.timestamp=103600;
 assert.match(ui.offersHTML(),/thot-dispute/);assert.doesNotMatch(ui.offersHTML(),/thot-finalize/);
 assert.match(ui.earningsHTML(),/after 1 hour from recorded delivery/);
});

test('dispute instructions use the selected receipt’s window, then verified market capabilities',async t=>{
 const f=fixture(t,()=>{throw Error('No wallet request before review');});
 f.state.thot.capabilities.dispute_seconds=43200;
 for(const [seconds,duration] of [[3600,'1 hour'],[43200,'12 hours'],[86400,'24 hours']]){
  f.state.thot.orders=[{id:'selected',receipt:{dispute_seconds:seconds}}];
  await f.ui.action('thot-dispute',{dataset:{id:'selected'}});
  assert.match(f.dialogs.at(-1)[2],new RegExp(`Sign within ${duration} of recorded delivery`));
 }
 f.state.thot.orders=[];
 await f.ui.action('thot-dispute',{dataset:{id:'selected'}});
 assert.match(f.dialogs.at(-1)[2],/Sign within 12 hours of recorded delivery/);
 delete f.state.thot.capabilities.dispute_seconds;
 await f.ui.action('thot-dispute',{dataset:{id:'selected'}});
 assert.match(f.dialogs.at(-1)[2],/Sign within the configured dispute period of recorded delivery/);
 assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
});

test('licensed delivery renders escaped conversation turns and licence before technical receipts',async t=>{
 const release={license:'Evaluation only <script>',provenance:{confidence_tier:'IMPORTED_UNVERIFIED'},content:{turns:[{role:'user',content:'How do I debug this?\n<script>alert(1)</script>'},{role:'assistant',content:'Check the tenant-scoped key.'}]}};
 const f=fixture(t,async()=>{},async()=>({release,receipt:{status:3,delivered_at:100000,block:{timestamp:100001}}}));
 // Production callers supply escaped JSON; this test also ensures the human-readable content is escaped.
 let content;
 const escaped=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const renderer=createThotUI({state:f.state,api:async()=>({release,receipt:{status:3,delivered_at:100000,block:{timestamp:100001}}}),escape:escaped,json:value=>escaped(JSON.stringify(value)),openDialog:(_title,_subtitle,html)=>{content=html;}});
 await renderer.action('thot-delivery',{dataset:{id:'paid'}});
 assert.match(content,/aria-label="Licensed conversation"/);assert.match(content,/1 · user/);assert.match(content,/Check the tenant-scoped key/);assert.match(content,/Evaluation only &lt;script&gt;/);assert.doesNotMatch(content,/<script>/);
 assert.ok(content.indexOf('How do I debug')<content.indexOf('Exact release artifact'));
});

test('price preview deducts quoted service costs and labels fixed proceeds without invented earnings',t=>{
 const f=fixture(t,async()=>{});f.state.thot.account={seller_bps:null,economics:{service_fee:'40000000000000000'}};const target={textContent:''};document.querySelector=()=>target;
 f.ui.onInput({id:'thot-price',value:'1000'});assert.match(target.textContent,/999\.9600 THOT/);assert.match(target.textContent,/0\.0400 THOT/);assert.match(target.textContent,/funding quote includes your applicable fee reduction and fixes the exact proceeds/);assert.doesNotMatch(target.textContent,/separate fee cashback|30%|70%|qualified lock/);
 f.ui.onInput({id:'thot-price',value:'0.01'});assert.match(target.textContent,/too low/);
 f.ui.onInput({id:'thot-price',value:'-100'});assert.match(target.textContent,/Enter a gross price/);assert.doesNotMatch(target.textContent,/-70/);
});

test('wrong-chain wallet cannot request a sale signature or activate a listing',async t=>{
 const f=fixture(t,async()=>{throw Error('No signing expected');},async()=>({trace_id:'trace'}));document.querySelector=()=>({value:'test',checked:true});
 await f.ui.action('thot-list-configure',button());window.ethereum.request=async p=>p.method==='eth_chainId'?'0x1':[owner];
 await assert.rejects(f.ui.action('thot-list-confirm',button()),/Switch your wallet/);assert.equal(f.calls.length,1);
});

test('wallet account changed while signing cannot activate a listing for the earlier account',async t=>{
 let selected=owner;const f=fixture(t,async()=>{},async path=>path.endsWith('/metadata')?{trace_id:'trace'}:{id:'listing',typed_data:{}});
 window.ethereum.request=async p=>p.method==='eth_chainId'?'0x7a69':p.method==='eth_requestAccounts'?[selected]:(selected=other,'0x'+'ab'.repeat(65));
 document.querySelector=()=>({value:'test',checked:true});await f.ui.action('thot-list-configure',button());
 await assert.rejects(f.ui.action('thot-list-confirm',button()),/wallet linked to this signed-in account/);assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);
});

test('listing activation retry reuses its prepared listing and signature instead of authorizing a duplicate sale',async t=>{
 let activations=0;const f=fixture(t,async p=>{assert.equal(p.method,'eth_signTypedData_v4');return '0x'+'ab'.repeat(65);},async path=>{if(path.endsWith('/metadata'))return {trace_id:'trace'};if(path.endsWith('/activate')){if(++activations===1)throw Error('Network interrupted');return {id:'listing'};}return {id:'listing',typed_data:{}};});
 document.querySelector=()=>({value:'test',checked:true});await f.ui.action('thot-list-configure',button());await assert.rejects(f.ui.action('thot-list-confirm',button()),/Network interrupted/);
 // The contributor can reopen after a workspace refresh and finish the exact activation.
 f.state.generation++;await f.ui.action('thot-list-configure',button());assert.equal(f.dialogs.at(-1)[0],'Finish enabling your signed listing');await f.ui.action('thot-list-resume',button());
 assert.equal(f.calls.filter(c=>c.path==='/v1/thot/listings').length,1);assert.equal(f.requests.filter(p=>p.method==='eth_signTypedData_v4').length,1);
 assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/activate')).map(c=>c.options.body.id),['listing','listing']);
});

test('wallet network action can add the explicit Robinhood testnet then switch without signing or spending',async t=>{
 const f=fixture(t,async()=>{});f.state.thot.capabilities={mode:'thot-testnet',chain_id:46630,rpc_url:'https://rpc.testnet.chain.robinhood.com'};let added=false;const calls=[];
 window.ethereum.request=async p=>{calls.push(p);if(p.method==='wallet_switchEthereumChain'&&!added)throw Object.assign(Error('Unknown chain'),{code:4902});if(p.method==='wallet_addEthereumChain')added=true;if(p.method==='eth_chainId')return '0xb626';};
 await f.ui.action('thot-network',button());assert.deepEqual(calls.map(c=>c.method),['wallet_switchEthereumChain','wallet_addEthereumChain','wallet_switchEthereumChain','eth_chainId']);assert.equal(calls[1].params[0].nativeCurrency.symbol,'ETH');
});

test('old lock lots expose withdrawal only when principal matures without promising tariff benefits',()=>{
 const {state,ui}=viewFixture();state.thot.account.block={timestamp:1000000};state.thot.account.lots=[{id:1,amount:atoms(10000),deposited_at:999999,unlock_at:1000000+91*86400}];
 let html=ui.tokenHTML();assert.match(html,/does not improve the current purchase or sale tariff/);assert.doesNotMatch(html,/thot-withdraw|thot-extend/);
 state.thot.account.block.timestamp=state.thot.account.lots[0].unlock_at;html=ui.tokenHTML();assert.match(html,/Principal is ready to withdraw/);assert.match(html,/thot-withdraw/);assert.doesNotMatch(html,/thot-extend/);
});

test('wrong EIP-712 chain or verifying contract blocks signing even when the wallet chain is correct',async t=>{
 const f=fixture(t,async()=>{throw Error('No signing expected');},async path=>path.endsWith('/metadata')?{trace_id:'trace'}:{id:'listing',typed_data:{domain:{chainId:1,verifyingContract:other}}});f.state.thot.capabilities.market=other;document.querySelector=()=>({value:'test',checked:true});
 await f.ui.action('thot-list-configure',button());await assert.rejects(f.ui.action('thot-list-confirm',button()),/does not match this chain and market/);assert.equal(f.requests.filter(p=>p.method==='eth_signTypedData_v4').length,0);
});

test('a network switch during receipt retrieval cannot confirm the action or send its next transaction',async t=>{
 let chain='0x7a69',sends=0;const f=fixture(t,async()=>{});window.ethereum.request=async p=>{if(p.method==='eth_chainId')return chain;if(p.method==='eth_requestAccounts')return [owner];if(p.method==='eth_sendTransaction')return hash(++sends);if(p.method==='eth_getTransactionReceipt'){chain='0x1';return {status:'0x1',transactionHash:p.params[0]};}};
 await f.prepare();await assert.rejects(f.send(),/Switch your wallet/);assert.equal(sends,1);assert.equal(f.refreshes,0);
});

test('wallet actions use the signed-in provider even when the global Ethereum provider is another wallet',async t=>{
 const calls=[];let sends=0;
 const selected={request:async p=>{calls.push(p);if(p.method==='eth_requestAccounts')return [owner];if(p.method==='eth_chainId')return '0x7a69';if(p.method==='eth_sendTransaction')return hash(++sends);return {status:'0x1'};}};
 const f=fixture(t,async()=>{throw Error('Wrong global wallet used');},undefined,{getProvider:()=>selected});
 await f.prepare();await f.send();assert.equal(sends,2);assert.equal(f.requests.length,0);assert(calls.every(call=>typeof call.method==='string'));
});

test('provider replacement during signing stops the remaining approval flow',async t=>{
 const started=deferred(),submitted=deferred();let sends=0;
 let selected={request:async p=>{if(p.method==='eth_requestAccounts')return [owner];if(p.method==='eth_chainId')return '0x7a69';if(p.method==='eth_sendTransaction'){sends++;started.resolve();return submitted.promise;}return {status:'0x1'};}};
 const f=fixture(t,async()=>{},undefined,{getProvider:()=>selected});await f.prepare();const signing=f.send();await started.promise;
 selected={request:async()=>{throw Error('Replacement wallet must not be asked');}};submitted.resolve(hash(1));
 await assert.rejects(signing,/wallet provider changed/);assert.equal(sends,1);assert.equal(f.refreshes,0);
});

test('a disputed purchase links the wallet hash to the private explanation and retries confirmation without resending',async t=>{
 let sends=0,confirmations=0;
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x1'},async path=>{
  if(path==='/v1/thot/disputes/confirm'){if(++confirmations===1)throw Error('DISPUTE_TRANSACTION_UNCONFIRMED');return {status:'confirmed'};}
  return {wallet:owner,reason_hash:hash(10),transactions:[transactions[0]]};
 });
 document.querySelector=()=>({value:'The licensed output is missing its cited test result.'});
 await f.ui.action('thot-dispute-confirm',{dataset:{id:hash(99)}});
 await assert.rejects(f.send(),/DISPUTE_TRANSACTION_UNCONFIRMED/);assert.equal(sends,1);assert.equal(f.refreshes,0);
 await f.send();assert.equal(sends,1);assert.equal(confirmations,2);
 for(const call of f.calls.filter(call=>call.path==='/v1/thot/disputes/confirm'))assert.deepEqual(call.options.body,{id:hash(99),transaction_hash:hash(1)});
});

test('governance votes use the linked eligible reviewer wallet and encrypted decision endpoint',async t=>{
 let sends=0;
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x1'},async(path,options)=>{
  if(path==='/v1/thot/disputes/evidence')return {offer_id:hash(99),scope:'disputed_purchased_release',receipt:{status:4,gross:atoms(1000),seller_amount:atoms(300),block:{timestamp:200000},dispute:{vote_starts_at:100000,vote_ends_at:300000,buyer_votes:0,uphold_votes:0,reviewer_vote:0}},release:{license:'Licensed research',content:{turns:[{role:'assistant',content:'Purchased research to inspect.'}]}},release_hash:hash(20),delivery_hash:hash(20),licensed_content_hash:hash(21),notice:'Audited case-scoped access.'};
  assert.equal(path,'/v1/thot/disputes/vote');assert.deepEqual(options.body,{id:hash(99),decision:'buyer_wins',reason:'The delivered material did not satisfy the signed licence.'});
  return {wallet:owner,decision_hash:hash(5),transactions:[transactions[0]],notice:'Governance signature required.'};
 });
 f.state.role='operator_security';f.state.thotDisputes={items:[{offer_id:hash(99),title:'A disputed sale',can_vote:true,receipt:{status:4,gross:atoms(1000),seller_amount:atoms(300),block:{timestamp:200000},dispute:{vote_starts_at:100000,vote_ends_at:300000,buyer_votes:0,uphold_votes:0}},explanations:[]}]};
 document.querySelector=id=>({value:id==='#thot-dispute-decision'?'buyer_wins':'The delivered material did not satisfy the signed licence.'});
 await f.ui.action('thot-dispute-vote',{dataset:{id:hash(99)}});
 assert.equal(f.calls[0].path,'/v1/thot/disputes/evidence');assert.match(f.dialogs.at(-1)[2],/Purchased research to inspect/);
 await f.ui.action('thot-dispute-vote-preview',{dataset:{id:hash(99)}});
 await f.send();assert.equal(sends,1);
 assert.equal(f.requests.find(call=>call.method==='eth_sendTransaction').params[0].from,owner);
 assert.equal(f.state.thot.wallet,owner);
});

test('seller response uses encrypted offchain text and a linked-wallet hash transaction',async t=>{
 let sends=0;const response='The delivered release exactly matches the signed licence.';
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x1'},async(path,options)=>{
  assert.equal(path,'/v1/thot/disputes/respond');assert.deepEqual(options.body,{id:hash(98),response});
  return {wallet:owner,response_hash:hash(6),transactions:[transactions[0]]};
 });
 document.querySelector=()=>({value:response});
 await f.ui.action('thot-dispute-respond',{dataset:{id:hash(98)}});await f.ui.action('thot-dispute-response-preview',{dataset:{id:hash(98)}});await f.send();
 assert.equal(sends,1);assert.equal(f.requests.find(call=>call.method==='eth_sendTransaction').params[0].from,owner);
});

test('DAO inbox escapes private explanations, shows response and votes, and distinguishes prepared text',()=>{
 const {state,ui}=viewFixture();state.thotDisputes={threshold:2,items:[{offer_id:hash(1),title:'Disputed <research>',can_vote:true,receipt:{status:4,gross:atoms(100),seller_amount:atoms(30),block:{timestamp:200000},dispute:{vote_starts_at:100000,vote_ends_at:300000,buyer_votes:1,uphold_votes:0}},explanations:[{reason:'<script>private complaint</script>',wallet:owner,status:'prepared'},{reason:'Confirmed complaint',wallet:owner,status:'confirmed',transaction_hash:hash(3)}],responses:[{response:'Seller <response>',wallet:other,status:'confirmed'}],decisions:[{reason:'Reviewer <reason>',wallet:owner,status:'confirmed',decision:2}]}]};
 assert.equal(ui.disputesHTML(),'');state.role='operator_security';const html=ui.disputesHTML();
 assert.match(html,/&lt;script&gt;private complaint/);assert.doesNotMatch(html,/<script>/);
 assert.match(html,/Prepared complaint · not linked/);assert.match(html,/Confirmed onchain complaint/);
 assert.match(html,/Seller &lt;response&gt;/);assert.match(html,/Reviewer &lt;reason&gt;/);assert.match(html,/1 buyer wins · 0 uphold/);
 assert.match(html,/thot-dispute-vote/);
});

test('reserve inventory remains visible while campaign start, pause and allowance block new queue actions',async t=>{
 const f=fixture(t,async()=>{});f.state.role='operator_security';
 f.state.thotSampling={capabilities:{mode:'thot-anvil',chain_id:31337,reserve:other},reserve:{balance:atoms(500000000),allowance:'0',committed:'0',start_at:2000,block:{timestamp:1000}},jobs:[]};
 let html=f.ui.samplingHTML();assert.match(html,/Actual confirmed contract balance/);assert.match(html,new RegExp(other));assert.match(html,/Campaign has not started/);assert.match(html,/disabled aria-disabled="true"[^>]*thot-sample-preview/);
 await assert.rejects(f.ui.action('thot-sample-preview',button()),/Campaign has not started/);assert.equal(f.calls.length,0);
 f.state.thotSampling.reserve.start_at=0;await assert.rejects(f.ui.action('thot-sample-preview',button()),/No spending allowance/);
 f.state.thotSampling.reserve.allowance=atoms(1000);f.state.thotSampling.reserve.paused=true;await assert.rejects(f.ui.action('thot-sample-preview',button()),/Campaign paused/);
});


test('manual reserve mode renders the dispute inbox with a case-scoped evidence action',()=>{
 const {state,ui}=viewFixture();state.role='operator_security';
 state.thotSampling={capabilities:{mode:'thot-anvil',manual_reserve:true,reserve:other},wallet:owner,reserve_buyer:true,reserve:{balance:atoms(500000000),allowance:'0',committed:'0',start_at:0,block:{timestamp:1000}},jobs:[],samples:[]};
 state.thotDisputes={threshold:2,items:[{offer_id:hash(99),title:'Purchased research case',can_inspect:true,can_vote:false,receipt:{status:4,gross:atoms(100),block:{timestamp:1000},dispute:{vote_starts_at:2000,vote_ends_at:3000,buyer_votes:0,uphold_votes:0}},explanations:[],responses:[],decisions:[]}]};
 const html=ui.samplingHTML();assert.match(html,/DAO dispute review/);assert.match(html,/Purchased research case/);assert.match(html,/thot-dispute-evidence/);assert.doesNotMatch(html,/thot-dispute-vote/);
});

test('a failed case-evidence check cannot open a governance vote form',async t=>{
 const f=fixture(t,async()=>{},async()=>{throw Error('GOVERNANCE_REVIEWER_CONFLICT');});
 f.state.role='operator_security';f.state.thotDisputes={items:[{offer_id:hash(99),can_vote:true,receipt:{status:4}}]};
 await assert.rejects(f.ui.action('thot-dispute-vote',{dataset:{id:hash(99)}}),/GOVERNANCE_REVIEWER_CONFLICT/);
 assert.equal(f.dialogs.length,0);assert.equal(f.requests.length,0);
});

test('legacy disputes remain reviewable without requesting newly unauthorized trace contents',async t=>{
 const f=fixture(t,async()=>{},async()=>{throw Error('No evidence request is authorized for this legacy release.');});
 f.state.role='operator_security';f.state.thotDisputes={items:[{offer_id:hash(99),inspection_authorized:false,can_vote:true,receipt:{status:4,gross:atoms(100),block:{timestamp:2000},dispute:{vote_starts_at:1000,vote_ends_at:3000,reviewer_vote:0,buyer_votes:0,uphold_votes:0}},explanations:[],responses:[],decisions:[]}]};
 await f.ui.action('thot-dispute-vote',{dataset:{id:hash(99)}});
 assert.equal(f.calls.length,0);assert.match(f.dialogs.at(-1)[2],/older sale did not authorize/);assert.match(f.dialogs.at(-1)[3],/thot-dispute-vote-preview/);
});

test('owner treasury shows typed buyer permission and pause controls with timed apply proposals',()=>{
 const {ui,state}=viewFixture();state.role='user';state.thotSampling={capabilities:{mode:'thot-anvil',manual_reserve:true},wallet:owner,reserve_buyer:true,reserve:{balance:'0',allowance:'0',committed:'0'},samples:[],jobs:[],governance:{owner:true,threshold:2,owners:[owner,other],address:other,block:{timestamp:1000},paused:false,buyers:[{address:owner,authorized:true}],operations:[{id:hash(31),target:other,action:'queueBuyer',args:[other,false],data:'0x1234',executed:true,confirmations:2,timelock:{executable_at:2000,ready:false}},{id:hash(32),target:other,action:'executeBuyer',args:[other,false],executed:false,confirmations:2,approved_by_you:true,executable:false,timelock:{executable_at:2000,ready:false}}]}};
 const html=ui.samplingHTML();assert.match(html,/Reserve buyer permissions/);assert.match(html,/thot-gov-queue_buyer/);assert.match(html,/thot-gov-pause/);assert.match(html,/thot-gov-buyer-proposal/);assert.match(html,/Waiting for the confirmed chain clock/);assert.match(html,/disabled aria-disabled="true"[^>]*data-action="thot-gov-execute"/);assert.match(html,/does not change the three governor owners or dispute reviewers/);
 state.thotSampling.governance.paused=true;assert.match(ui.samplingHTML(),/thot-gov-queueUnpause/);
 state.thotSampling.reserve_buyer=false;assert.match(ui.samplingHTML(),/Reserve governance/,'owner retains governance UI after buyer revocation');
});

test('buyer permission review sends typed false and displays the exact unsigned change without sending',async t=>{
 const f=fixture(t,()=>{throw Error('must not submit during review');},()=>({transactions,review:{contract_action:'queueBuyer',buyer:other,authorize_after_execution:false},notice:'Two approvals.'}));
 document.querySelector=selector=>({value:selector==='#thot-reserve-buyer'?` ${other} `:'false'});
 await f.ui.action('thot-gov-queue_buyer',button());
 assert.deepEqual(f.calls[0].options.body,{action:'queue_buyer',buyer:other,allowed:false});assert.match(f.dialogs[0][2],/Exact governance change/);assert.match(f.dialogs[0][2],/queueBuyer/);assert.equal(f.requests.length,0);
});

test('applying buyer change reuses the executed queue address and permission',async t=>{
 const f=fixture(t,()=>{throw Error('must not send');});f.state.thotSampling={governance:{operations:[{id:hash(33),action:'queueBuyer',args:[other,true],executed:true,timelock:{executable_at:10}}]}};
 await f.ui.action('thot-gov-buyer-proposal',{dataset:{id:hash(33)}});assert.deepEqual(f.calls[0].options.body,{action:'execute_buyer',buyer:other,allowed:true});
 f.state.thotSampling.governance.operations[0].executed=false;await assert.rejects(f.ui.action('thot-gov-buyer-proposal',{dataset:{id:hash(33)}}),/executed buyer-permission queue/);
});

test('a governance reviewer signed in as a user can paginate the dispute inbox',async t=>{
 const f=fixture(t,()=>{throw Error('no signing');},()=>({items:[],threshold:2,next_cursor:null}));
 f.state.thot.account={dispute_reviewer:true};f.state.thotDisputes={items:[]};
 await f.ui.action('thot-disputes-more',{dataset:{id:'intent:'+hash(44)}});assert.match(f.calls[0].path,/\/v1\/thot\/disputes\?after_id=/);assert.match(f.dialogs[0][2],/DAO dispute review/);
 f.state.thot.account.dispute_reviewer=false;await assert.rejects(f.ui.action('thot-disputes-more',{dataset:{id:'intent:'+hash(44)}}),/Governance reviewer access/);
});

test('testnet governance exposes immediate activation and typed tariff, operator and cancellation controls',()=>{
 const {state,ui}=viewFixture();state.thotSampling={capabilities:{mode:'thot-testnet',manual_reserve:true,chain_id:46630},wallet:owner,reserve_buyer:true,reserve:{balance:atoms(500000000),allowance:'0',committed:'0'},samples:[],jobs:[],governance:{owner:true,threshold:1,owners:[owner,other,'0x0000000000000000000000000000000000000003'],address:other,block:{timestamp:1000},delay_seconds:0,market_delay_seconds:0,paused:false,market_paused:false,buyers:[],operations:[],campaign_start_at:0,tariff:{direct_cost_atoms:'10000000000000000',allocated_overhead_atoms:'20000000000000000',policy_hash:hash(90)}}};
 const html=ui.samplingHTML();assert.match(html,/Reserve governance · 1 of 3/);assert.match(html,/Any one listed owner/);assert.match(html,/thot-gov-start_campaign/);assert.match(html,/thot-gov-queue_tariff/);assert.match(html,/thot-gov-queue_operator/);assert.match(html,/thot-gov-cancel_queue/);assert.match(html,/Both contracts · complete replacement/);assert.doesNotMatch(html,/24-hour wait|two owner approvals|holding.*discount/i);
});

test('tariff preview uses exact atoms and queue application retains its original policy and target',async t=>{
 const f=fixture(t,()=>{throw Error('No wallet request during review');});
 const fields={'#thot-tariff-direct':'0.01','#thot-tariff-overhead':'0.02','#thot-tariff-policy':hash(91)};document.querySelector=s=>({value:fields[s]});
 await f.ui.action('thot-gov-queue_tariff',button());assert.deepEqual(f.calls[0].options.body,{action:'queue_tariff',target:'market',direct_cost_atoms:'10000000000000000',overhead_atoms:'20000000000000000',policy_hash:hash(91)});
 f.state.thotSampling={governance:{operations:[{id:hash(92),target_kind:'market',action:'queueTariff',args:['10000000000000000','20000000000000000',hash(91)],executed:true,timelock:{executable_at:10}}]}};
 await f.ui.action('thot-gov-apply-proposal',{dataset:{id:hash(92)}});assert.deepEqual(f.calls[1].options.body,{action:'execute_tariff',target:'market',direct_cost_atoms:'10000000000000000',overhead_atoms:'20000000000000000',policy_hash:hash(91)});assert.equal(f.requests.length,0);
});

test('seller response waiver is separate, explicit and unavailable before an onchain response',async t=>{
 const f=fixture(t,()=>{throw Error('No wallet request before review');},()=>({wallet:owner,transactions,notice:'Response period ends on confirmation.'}));
 f.state.thot.capabilities.mode='thot-anvil';f.state.thot.account={claimable:'0'};
 const receipt={status:4,gross:atoms(1),seller_amount:'960000000000000000',block:{timestamp:100},dispute:{vote_starts_at:200,vote_ends_at:300,response_hash:hash(0)}};
 f.state.thot.orders=[{id:hash(93),title:'Purchased work',seller:owner,buyer:other,gross:atoms(1),receipt}];
 assert.doesNotMatch(f.ui.offersHTML(),/thot-dispute-waive-response/);receipt.dispute.response_hash=hash(94);assert.match(f.ui.offersHTML(),/thot-dispute-waive-response/);
 await f.ui.action('thot-dispute-waive-response',{dataset:{id:hash(93)}});assert.equal(f.calls.length,0);assert.match(f.dialogs.at(-1)[2],/cannot reopen/);
 await f.ui.action('thot-dispute-waive-confirm',{dataset:{id:hash(93)}});assert.equal(f.calls[0].path,'/v1/thot/disputes/waive-response');assert.deepEqual(f.calls[0].options.body,{id:hash(93),confirm_final_response:true});assert.equal(f.requests.length,0);
});
