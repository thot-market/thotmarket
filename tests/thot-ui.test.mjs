import test from 'node:test';
import assert from 'node:assert/strict';
import {createThotUI,purchaseApprovalReady} from '../apps/dashboard/thot-ui.js';

const owner='0x0000000000000000000000000000000000000001';
const other='0x0000000000000000000000000000000000000002';
const hash=index=>'0x'+String(index).padStart(64,'0');
const transactions=[{to:owner,data:'0xaaaa',value:'0x0',chainId:'0x7a69'},{to:owner,data:'0xbbbb',value:'0x0',chainId:'0x7a69'}];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const button=()=>({dataset:{},disabled:false});
function fixture(t,request,respond,options={}){
 const previousWindow=globalThis.window,previousDocument=globalThis.document;
 const state={actor:{id:'seller'},generation:1,role:'user',thot:{market_paused:false,wallet:owner,capabilities:{chain_id:31337,dispute_seconds:3600}}};
 const requests=[],dialogs=[],calls=[],notices=[],previewResponse=options.previewResponse;let refreshes=0;
 globalThis.window={ethereum:{request:async p=>{requests.push(p);if(p.method==='eth_requestAccounts')return [state.thot.wallet];if(p.method==='eth_chainId')return '0x7a69';if(p.method==='eth_blockNumber')return '0x20';if(p.method==='eth_getBlockByNumber')return {hash:hash(999)};const result=await request(p,state);return p.method==='eth_getTransactionReceipt'&&result?{transactionHash:p.params[0],blockNumber:'0x10',blockHash:hash(999),...result}:result;}}};
 globalThis.document={querySelector:()=>({value:'10000'})};
 const ui=createThotUI({state,api:async(path,options)=>{calls.push({path,options});if(path.endsWith('/preview')){if(previewResponse)return previewResponse(path,options);const metadata=respond?await respond('/v1/thot/listings/metadata',options):{};return {...metadata,trace_id:options.body.trace_id,content:{turns:[{role:'user',content:'Synthetic reviewed release'}]},sale_eligibility:{can_list:true},exclusion:{supported:false}};}return respond?respond(path,options):{transactions,notice:'Review the lock.'};},openDialog:(...args)=>dialogs.push(args),dialog:{close(){}},refresh:async()=>{refreshes++;},escape:String,json:JSON.stringify,toast:m=>notices.push(m),...options});
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
 assert.match(f.dialogs.at(-1)[2],/wallet action is saved/);await f.send();assert.equal(sends,2);
});

const atoms=n=>(BigInt(n)*10n**18n).toString();
function viewFixture(){
 const state={role:'user',traces:[{trace_id:'private-1',title:'My research'}],thot:{market_paused:false,
  capabilities:{mode:'thot-anvil',chain_id:31337,market:other,dispute_seconds:3600,subjective_dispute_min_qualifying_spend:atoms(10000000),seller_response_seconds:86400,dispute_vote_seconds:604800,dispute_review_threshold:2},wallet:owner,
  account:{balance:atoms(900000),qualified:atoms(10000),seller_bps:5000,claimable:atoms(17),finalized_independent_spend:atoms(10000000),lots:[]},
  listings:[{id:'listing-1',seller:other,title:'Listed research',workflow:'research',turn_count:4,provenance:'IMPORTED_UNVERIFIED',price_atoms:atoms(100),license:'Evaluation only'}],orders:[],
 }};
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const ui=createThotUI({state,escape,json:JSON.stringify});
 return {state,ui};
}

test('listing choices use the private library title without changing their item identifier',()=>{
 const {state,ui}=viewFixture();state.traces=[{trace_id:'private-1'}];
 state.traceLibrary={items:[{trace_id:'private-1',title:'My <coding> session'}]};
 assert.match(ui.offersHTML(),/<option value="private-1">My &lt;coding&gt; session<\/option>/);
});

test('Offers, Earnings and THOT have distinct content and keep actions in their intended view',()=>{
 const {ui}=viewFixture(),offers=ui.offersHTML(),earnings=ui.earningsHTML(),token=ui.tokenHTML();
 assert.match(offers,/<h1>Buy an item\. Put it to work\.<\/h1>/);
 assert.match(offers,/data-action="thot-list-configure"/);assert.match(offers,/data-action="thot-buy"/);
 assert.doesNotMatch(offers,/id="thot-lock"|id="thot-referrer"|data-action="thot-claim"/);
 assert.match(earnings,/<h1>What your work has earned\.<\/h1>/);assert.match(earnings,/data-action="thot-claim"/);
 assert.doesNotMatch(earnings,/id="thot-lock"|id="thot-referrer"|id="thot-workflow"|data-action="thot-buy"/);
 assert.match(token,/<h1>Wallet & THOT<\/h1>/);
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
 assert.match(html,/PENDING SALE PROCEEDS<\/small><strong>120 THOT/);
 assert.match(html,/FINALIZED SALES · RECENT RECORDS<\/small><strong>60 THOT/);
 assert.match(html,/AVAILABLE TO CLAIM<\/small><strong>17 THOT/);
 assert.match(html,/20 THOT offered as your share/);
 assert.match(html,/Refunded · no sale proceeds/);assert.match(html,/buyer refunds/);
 assert.match(html,/Treasury-sponsored purchase/);assert.match(html,/External buyer purchase/);
 assert.doesNotMatch(html,/My purchase|Sale 0|99,999|70 THOT/);
 assert.match(html,/Not a lifetime total/);
});

test('all three pages remain distinct before linking a wallet and provide a link action',()=>{
 const {state,ui}=viewFixture();state.thot.wallet=null;state.thot.account=null;
 const pages=[ui.offersHTML(),ui.earningsHTML(),ui.tokenHTML()];
 assert.equal(new Set(pages).size,3);
 for(const html of pages){assert.match(html,/data-action="thot-link"/);assert.doesNotMatch(html,/NaN|undefined/);}
 assert.match(pages[0],/For sale/);assert.doesNotMatch(pages[1],/For sale/);assert.match(pages[2],/A price you can check/);
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
  assert.match(html,/Available to claim/);assert.match(html,/17 THOT/);assert.match(html,/data-action="thot-claim"/);
  assert.doesNotMatch(html,/data-view="earnings"|data-action="thot-list-configure"/);
  assert.doesNotMatch(ui.tokenHTML(),/data-view="earnings"/);
 }
});

test('enrollment requires explicit consent then one signature and activation, without a seller payment transaction',async t=>{
 const signature='0x'+'ab'.repeat(65),typed={domain:{name:'thot market',chainId:31337,verifyingContract:'0x0000000000000000000000000000000000000009'},types:{SaleAuthorization:[]},message:{gross:atoms(100),evidenceHash:'0x'+'1'.repeat(64),licenseHash:'0x'+'2'.repeat(64),seller:'0x0000000000000000000000000000000000000001'}};
 const f=fixture(t,async p=>{assert.equal(p.method,'eth_signTypedData_v4');assert.deepEqual(JSON.parse(p.params[1]),typed);return signature;},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1)}:path.endsWith('/activate')?{id:'listing',public_path:'/l/listing',content_kind:'trace'}:{id:'listing',typed_data:typed});
 const inputs={'#thot-trace':{value:'trace'},'#thot-title':{value:'Useful research'},'#thot-price':{value:'100'},'#thot-license':{value:'Exact non-exclusive research licence'},'#thot-list-consent':{checked:false},'#thot-treasury-consent':{checked:true}};
 document.querySelector=id=>inputs[id];
 await f.ui.action('thot-list-configure',button());
 await assert.rejects(f.ui.action('thot-list-confirm',button()),/Authorize the content rights/);
 assert.equal(f.calls.length,2);inputs['#thot-list-consent'].checked=true;
 await f.ui.action('thot-list-confirm',button());
 // Preparing the listing now ends at an exact-commitment review; the wallet
 // signature itself is only requested by the separate signing step.
 assert.equal(f.requests.filter(p=>p.method==='eth_signTypedData_v4').length,0,'no signature request before the signing step');
 assert.equal(f.dialogs.at(-1)[0],'Review the exact commitments');
 assert.equal(f.calls[2].options.body.automatic_sales,true);assert.equal(f.calls[2].options.body.treasury_opt_in,true);assert.equal(f.calls[2].options.body.treasury_sampling_consent,'thot.treasury-sampling/1');assert.equal(f.calls[2].options.body.free_preview,undefined);
 await f.ui.action('thot-list-sign',button());
 assert.deepEqual(f.calls[3],{path:'/v1/thot/listings/activate',options:{method:'POST',body:{id:'listing',signature}}});
 assert.equal(f.requests.filter(p=>p.method==='eth_signTypedData_v4').length,1);
 assert.equal(f.requests.filter(p=>p.method==='eth_sendTransaction').length,0);
 // The finished listing surfaces its public share URL (#97).
 assert.equal(f.dialogs.at(-1)[0],'Your item is listed');assert.match(f.dialogs.at(-1)[2],/\/l\/listing/);assert.match(f.dialogs.at(-1)[2],/data-action="thot-copy-listing-url"/);
 const copied=[];const ui=createThotUI({state:f.state,api:async()=>({}),openDialog:()=>{},dialog:{close(){}},refresh:async()=>{},escape:String,json:JSON.stringify,toast:m=>copied.push(m),copyText:async text=>{if(!/^https:\/\//.test(text))throw Error('reject');}});
 await ui.action('thot-copy-listing-url',{dataset:{id:'https://share.example/l/listing'}});
 await assert.rejects(ui.action('thot-copy-listing-url',{dataset:{id:'javascript:alert(1)'}}),/unavailable/);
 assert.deepEqual(copied,['Public listing link copied.']);
});

test('the signature review names the exact commitments, the gas-free signature and the dispute window',async t=>{
 const typed={domain:{chainId:31337,verifyingContract:'0x0000000000000000000000000000000000000009'},types:{SaleAuthorization:[]},message:{gross:atoms(100),evidenceHash:'0x'+'aa'.repeat(64),licenseHash:'0x'+'bb'.repeat(64),seller:'0x0000000000000000000000000000000000000001'}};
 const f=fixture(t,async()=>{throw Error('No wallet request in this review test');},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1)}:{id:'listing',typed_data:typed,public_path:'/l/listing'});
 document.querySelector=()=>({value:'100',checked:true});
 await f.ui.action('thot-list-configure',button());
 await f.ui.action('thot-list-confirm',button());
 const review=f.dialogs.at(-1);
 assert.equal(review[0],'Review the exact commitments');
 assert.ok(review[2].includes('evidenceHash being signed'));
 assert.ok(review[2].includes('0x'+'aa'.repeat(64)));
 assert.ok(review[2].includes('licenseHash being signed'));
 assert.ok(review[2].includes('0x'+'bb'.repeat(64)));
 assert.match(review[2],/complete release envelope/);
 assert.match(review[2],/off-chain signature: no blockchain transaction is sent and no gas is charged/);
 assert.match(review[2],/1-hour dispute window/);
 assert.match(review[3],/Open wallet to sign/);
 // The earlier sale-review dialog itself states both facts before any prepare.
 await f.ui.action('thot-list-cancel',button());
 assert.equal(f.dialogs.at(-1)[0],'Review & sell');
 assert.match(f.dialogs.at(-1)[2],/off-chain wallet signature: it is not a blockchain transaction and costs no gas/);
 assert.match(f.dialogs.at(-1)[2],/1-hour dispute window/);
});

test('the wallet prompt is never covered by an application dialog, and a cancelled signature returns to the review',async t=>{
 const rejectable=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
 const signing=rejectable(),started=deferred();
 const closes=[];const dialog={close(){closes.push('close');}};
 const typed={domain:{chainId:31337,verifyingContract:'0x0000000000000000000000000000000000000009'},types:{SaleAuthorization:[]},message:{gross:atoms(100),evidenceHash:'0x'+'1'.repeat(64),licenseHash:'0x'+'2'.repeat(64)}};
 const f=fixture(t,async p=>{started.resolve();return signing.promise;},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1)}:{id:'listing',typed_data:typed},{dialog});
 document.querySelector=()=>({value:'100',checked:true});
 await f.ui.action('thot-list-configure',button());
 await f.ui.action('thot-list-confirm',button());
 const attempt=f.ui.action('thot-list-sign',button());
 await started.promise;
 // #78: the review dialog is closed for the whole wallet request.
 assert.deepEqual(closes,['close']);
 signing.reject(Object.assign(Error('User rejected'),{code:4001}));
 await assert.rejects(attempt,/User rejected/);
 assert.equal(f.dialogs.at(-1)[0],'Review the exact commitments','the exact-commitment review returns after a cancelled signature');
 assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);
});

test('listing setup renders only the explicit owner preview and reserve sampling remains optional',async t=>{
 const secret='TRACE_TEXT_MUST_STAY_PRIVATE_IN_LISTING_SETUP';
 const f=fixture(t,async()=>{},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1),content:{turns:[{role:'user',content:secret}]}}:{id:'listing',typed_data:{}});
 const inputs={'#thot-trace':{value:'trace'},'#thot-title':{value:'Useful research'},'#thot-price':{value:'100'},'#thot-license':{value:'Exact non-exclusive research licence'},'#thot-list-consent':{checked:true},'#thot-treasury-consent':{checked:false}};document.querySelector=id=>inputs[id];
 await f.ui.action('thot-list-configure',button());assert.doesNotMatch(f.dialogs.at(-1)[2],new RegExp(secret));assert.match(f.dialogs.at(-1)[2],/Synthetic reviewed release/);assert.match(f.dialogs.at(-1)[2],/no ordinary pre-purchase item preview/i);
 await f.ui.action('thot-list-confirm',button());const body=f.calls.find(call=>call.path==='/v1/thot/listings').options.body;assert.equal(body.treasury_opt_in,false);assert.equal(body.treasury_sampling_consent,undefined);assert.equal(body.free_preview,undefined);
});

test('a signature returned after account replacement never activates the former contributor listing',async t=>{
 const signed=deferred(),started=deferred();
 const f=fixture(t,async p=>{if(p.method==='eth_signTypedData_v4'){started.resolve();return signed.promise;}throw Error('Unexpected wallet transaction');},async path=>path.endsWith('/metadata')?{trace_id:'trace',content_hash:hash(1)}:{id:'listing',typed_data:{}});
 document.querySelector=()=>({value:'test',checked:true});await f.ui.action('thot-list-configure',button());
 await f.ui.action('thot-list-confirm',button());
 const action=f.ui.action('thot-list-sign',button());await started.promise;f.state.actor={id:'other'};f.state.generation++;signed.resolve('0x'+'ab'.repeat(65));
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
 const html=ui.valuationsHTML();assert.match(html,/Independent buyers: not enough comparable sales/);assert.match(html,/Treasury-sponsored samples: 100 THOT/);assert.match(html,/ESTIMATED · NOT A BALANCE/);assert.doesNotMatch(html,/\$|expected earnings|per day/i);
 assert.match(ui.earningsHTML(),/AVAILABLE TO CLAIM<\/small><strong>17 THOT/);
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

test('Robinhood mainnet renders THOT payments without test-asset labels',()=>{
 const {state,ui}=viewFixture();state.thot.capabilities={mode:'thot-production',chain_name:'Robinhood Chain',chain_id:4663,market:other,explorer_url:'https://robinhoodchain.blockscout.com'};
 for(const html of [ui.offersHTML(),ui.earningsHTML(),ui.tokenHTML()]){
  assert.match(html,/Robinhood Chain · THOT payments/);
  assert.doesNotMatch(html,/test THOT|test assets only|not dollars or mainnet earnings/i);
 }
});

test('mainnet signing review and missing-wallet notice identify real THOT',async t=>{
 let available=true;
 const f=fixture(t,async()=>{},async()=>({transactions:[{to:owner,data:'0xaaaa',value:'0x0',chainId:'0x1237'}]}),{getProvider:()=>available?globalThis.window.ethereum:null});
 f.state.thot.capabilities={mode:'thot-production',chain_id:4663};
 await f.prepare();
 assert.equal(f.dialogs.at(-1)[1],'Robinhood Chain · THOT · review before signing');
 available=false;
 await assert.rejects(f.ui.action('thot-link',button()),/Robinhood Chain uses real THOT/);
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
 const f=fixture(t,async()=>{});f.state.thot.account={seller_bps:null,economics:{policy:'quoted-cost/1',service_fee:'40000000000000000',direct_cost:'10000000000000000'}};const target={textContent:''};document.querySelector=()=>target;
 f.ui.onInput({id:'thot-price',value:'1000'});assert.match(target.textContent,/999\.96 THOT/);assert.match(target.textContent,/0\.04 THOT/);assert.match(target.textContent,/funding quote includes any applicable discounts and fixes the exact proceeds/);assert.doesNotMatch(target.textContent,/separate fee cashback|30%|70%|qualified lock/);
 f.ui.onInput({id:'thot-price',value:'0.01'});assert.match(target.textContent,/too low/);
 f.ui.onInput({id:'thot-price',value:'-100'});assert.match(target.textContent,/Enter a gross price/);assert.doesNotMatch(target.textContent,/-70/);
});

test('wrong-chain wallet cannot request a sale signature or activate a listing',async t=>{
 const f=fixture(t,async()=>{throw Error('No signing expected');},async()=>({trace_id:'trace'}));document.querySelector=()=>({value:'test',checked:true});
 await f.ui.action('thot-list-configure',button());window.ethereum.request=async p=>p.method==='eth_chainId'?'0x1':[owner];
 await assert.rejects(f.ui.action('thot-list-confirm',button()),/Switch your wallet/);assert.equal(f.calls.length,2);
});

test('wallet account changed while signing cannot activate a listing for the earlier account',async t=>{
 let selected=owner;const f=fixture(t,async()=>{},async path=>path.endsWith('/metadata')?{trace_id:'trace'}:{id:'listing',typed_data:{}});
 window.ethereum.request=async p=>p.method==='eth_chainId'?'0x7a69':p.method==='eth_requestAccounts'?[selected]:(selected=other,'0x'+'ab'.repeat(65));
 document.querySelector=()=>({value:'test',checked:true});await f.ui.action('thot-list-configure',button());
 await f.ui.action('thot-list-confirm',button());
 await assert.rejects(f.ui.action('thot-list-sign',button()),/wallet linked to this signed-in account/);assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);
});

test('listing activation retry reuses its prepared listing and signature instead of authorizing a duplicate sale',async t=>{
 let activations=0;const f=fixture(t,async p=>{assert.equal(p.method,'eth_signTypedData_v4');return '0x'+'ab'.repeat(65);},async path=>{if(path.endsWith('/metadata'))return {trace_id:'trace'};if(path.endsWith('/activate')){if(++activations===1)throw Error('Network interrupted');return {id:'listing'};}return {id:'listing',typed_data:{}};});
 document.querySelector=()=>({value:'test',checked:true});await f.ui.action('thot-list-configure',button());await f.ui.action('thot-list-confirm',button());await assert.rejects(f.ui.action('thot-list-sign',button()),/Network interrupted/);
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

test('wallet network action adds Robinhood mainnet only for the exact production RPC',async t=>{
 const f=fixture(t,async()=>{});f.state.thot.capabilities={mode:'thot-production',chain_id:4663,rpc_url:'https://rpc.mainnet.chain.robinhood.com'};let added=false;const calls=[];
 window.ethereum.request=async p=>{calls.push(p);if(p.method==='wallet_switchEthereumChain'&&!added)throw Object.assign(Error('Unknown chain'),{code:4902});if(p.method==='wallet_addEthereumChain')added=true;if(p.method==='eth_chainId')return '0x1237';};
 await f.ui.action('thot-network',button());assert.deepEqual(calls.map(c=>c.method),['wallet_switchEthereumChain','wallet_addEthereumChain','wallet_switchEthereumChain','eth_chainId']);
 assert.equal(calls[1].params[0].chainName,'Robinhood Chain');assert.equal(calls[1].params[0].chainId,'0x1237');
 f.state.thot.capabilities.rpc_url='https://rpc.testnet.chain.robinhood.com';added=false;calls.length=0;
 await assert.rejects(f.ui.action('thot-network',button()),/Unknown chain/);assert.equal(calls.some(c=>c.method==='wallet_addEthereumChain'),false);
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
 const selected={request:async p=>{calls.push(p);if(p.method==='eth_requestAccounts')return [owner];if(p.method==='eth_chainId')return '0x7a69';if(p.method==='eth_sendTransaction')return hash(++sends);if(p.method==='eth_blockNumber')return '0x20';if(p.method==='eth_getBlockByNumber')return {hash:hash(999)};return {status:'0x1',transactionHash:p.params[0],blockNumber:'0x10',blockHash:hash(999)};}};
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

test('legacy disputes remain reviewable without requesting newly unauthorized item contents',async t=>{
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

test('governance distinguishes approvals, execution and queued application without claiming unknown readiness',()=>{
 const {ui,state}=viewFixture();
 state.thotSampling={capabilities:{mode:'thot-anvil',manual_reserve:true},wallet:owner,reserve_buyer:true,reserve:{balance:'0',allowance:'0',committed:'0'},samples:[],jobs:[],governance:{owner:true,threshold:2,owners:[owner,other],address:other,block:{timestamp:1000},operations:[
  {id:hash(81),action:'queueBuyer',confirmations:1,executed:false,args:[other,true]},
  {id:hash(82),action:'executeBuyer',confirmations:2,executed:false,executable:false},
  {id:hash(83),action:'pause',confirmations:2,executed:false,executable:true},
  {id:hash(84),action:'queueTariff',confirmations:2,executed:true,timelock:{executable_at:2000,ready:false}},
  {id:hash(85),action:'queueOperator',confirmations:2,executed:true,timelock:{executable_at:900,ready:true}},
  {id:hash(86),action:'<unknown action>',confirmations:2,executed:false},
 ]}};
 const html=ui.samplingHTML();
 for(const label of ['Awaiting approvals','Execution unavailable','Ready to execute','Queue delay pending','Queue delay elapsed','Approval threshold reached'])assert.match(html,new RegExp(label));
 assert.match(html,/Schedule buyer permission/);assert.match(html,/&lt;unknown action&gt;/);assert.doesNotMatch(html,/<unknown action>/);
 assert.match(html,/Market: <strong>Unknown<\/strong>/);
 assert(html.indexOf('Recent governance operations')<html.indexOf('Reserve buyer permissions'));
 assert.match(html,/disabled aria-disabled="true"[^>]*data-action="thot-gov-execute"[^>]*data-id="0x0+82"/);
});

test('buyer navigation counts records while listing layout preserves escaping and paused-market actions',()=>{
 const {ui,state}=viewFixture();state.role='buyer_admin';
 state.thot.listings[0].title='<script>private listing</script>';
 state.thot.market_paused=true;
 const html=ui.offersHTML();
 assert.match(html,/href="#thot-available">Browse data <span>1<\/span>/);
 assert.match(html,/href="#thot-purchases">Your purchases <span>0<\/span>/);
 assert.match(html,/&lt;script&gt;private listing&lt;\/script&gt;/);
 assert.match(html,/data-action="thot-assay"/);assert.doesNotMatch(html,/data-action="thot-buy"|<script>|href="#thot-history"/);
 state.thot.market_paused=false;
 assert.match(ui.offersHTML(),/class="button" data-action="thot-buy" data-id="listing-1"/);
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


test('every supported chain blocks new purchases while paused or unknown but retains delivery and exits',async t=>{
 for(const mode of ['thot-anvil','thot-testnet','thot-production']){
  const {state,ui}=viewFixture();state.thot.capabilities.mode=mode;
  state.thot.orders=[{id:hash(8),title:'Funded item',buyer:owner,seller:other,receipt:{status:3,delivered_at:1,block:{timestamp:2}}}];
  for(const paused of [true,null,undefined]){
   state.thot.market_paused=paused;const html=ui.offersHTML();
   assert.doesNotMatch(html,/data-action="thot-buy"|data-action="thot-reserve-buy"/);
   assert.match(html,/thot-delivery/);assert.match(html,/paused|unknown/);
  }
  state.thot.market_paused=false;assert.match(ui.offersHTML(),/data-action="thot-buy"/);
 }
 const f=fixture(t,()=>{throw Error('Wallet must not be called');},()=>{throw Error('API must not be called');});
 f.state.thot.market_paused=null;await assert.rejects(f.ui.action('thot-buy',{dataset:{id:'listing'}}),/unknown/);
});

test('purchase recovery survives a new UI instance and reconciles existing hashes during pause',async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let sends=0,fail=true,prepares=0;
 const request=async p=>{if(p.method==='eth_sendTransaction')return hash(++sends);if(p.params[0]===hash(2)&&fail)throw Error('Receipt unavailable');return {status:'0x1'};};
 const respond=async path=>{if(path==='/v1/thot/workspace?scope=buyer')return {market_paused:!fail};prepares++;return {id:hash(9),transactions};};
 const first=fixture(t,request,respond,{recoveryStorage:storage});
 await first.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(first.send(),/Receipt unavailable/);assert.equal(sends,2);
 const stored=JSON.parse([...data.values()][0]);assert.equal(stored.id,hash(9));assert.equal(stored.steps[1].hash,hash(2));assert.equal(stored.extra,undefined);
 fail=false;
 const second=fixture(t,request,respond,{recoveryStorage:storage});second.state.thot.market_paused=true;
 await second.ui.action('thot-buy',{dataset:{id:'listing'}});assert.equal(second.dialogs.at(-1)[0],'Continue your purchase');
 await second.send();assert.equal(sends,2);assert.equal(prepares,1);assert.equal(data.size,0);
});

test('a pause after the approval prevents payment without resending approval on recovery',async t=>{
 let sends=0,checks=0,paused=true;
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x1'},async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:++checks>1&&paused}:{id:hash(10),transactions});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/Purchases are paused/);assert.equal(sends,1);
 paused=false;await f.send();assert.equal(sends,2);
});

test('failed availability RPC blocks payment and marks state unknown',async t=>{
 let sends=0;
 const f=fixture(t,async()=>{sends++;},async path=>{if(path==='/v1/thot/workspace?scope=buyer')throw Error('RPC secret diagnostic');return {transactions};});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/availability is unknown/);assert.equal(sends,0);assert.equal(f.state.thot.market_paused,null);
});

test('a reload with unknown submission never resends and another identity cannot adopt it',async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let sends=0;
 const request=async p=>{if(p.method==='eth_call')return '0x';sends++;throw Error('Transport closed');};
 const respond=async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions};
 const first=fixture(t,request,respond,{recoveryStorage:storage});await first.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(first.send(),/Transport closed/);
 const second=fixture(t,request,respond,{recoveryStorage:storage});await second.ui.action('thot-resume-payment',button());await assert.rejects(second.send(),/may already have submitted/);assert.equal(sends,1);
 second.state.actor.id='other-person';await assert.rejects(second.ui.action('thot-resume-payment',button()),/No pending/);
});

test('browser recovery storage failure blocks sending before a wallet is contacted',async t=>{
 let sends=0;
 const storage={getItem:()=>null,setItem:()=>{throw Error('Storage unavailable');}};
 const f=fixture(t,async()=>{sends++;},null,{recoveryStorage:storage});
 await assert.rejects(f.prepare(),/Storage unavailable/);assert.equal(sends,0);
});


test('two confirmations retain recovery until depth and revalidate stored receipts after reload',async t=>{
 t.mock.method(globalThis,'setTimeout',fn=>{queueMicrotask(fn);return 0;});
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let sends=0,head='0x10';
 const request=async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x1'};
 const first=fixture(t,request,undefined,{recoveryStorage:storage});first.state.thot.capabilities.confirmations=2;
 let original=window.ethereum.request;window.ethereum.request=p=>p.method==='eth_blockNumber'?Promise.resolve(head):original(p);
 await first.prepare();await assert.rejects(first.send(),/Confirmation is pending/);assert.equal(sends,1);assert.equal(data.size,1);
 // Even an old stored success marker must not bypass the confirmed-depth check.
 const key=[...data.keys()][0],record=JSON.parse(data.get(key));record.steps[0].confirmed=true;data.set(key,JSON.stringify(record));
 const second=fixture(t,request,undefined,{recoveryStorage:storage});second.state.thot.capabilities.confirmations=2;
 original=window.ethereum.request;window.ethereum.request=p=>p.method==='eth_blockNumber'?Promise.resolve(head):original(p);
 await second.prepare();await assert.rejects(second.send(),/Confirmation is pending/);assert.equal(sends,1);
 head='0x11';await second.send();assert.equal(sends,2);assert.equal(data.size,0);
});

test('a receipt on a replaced block stays recoverable and is never resubmitted',async t=>{
 let sends=0,canonical=false;
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sends):{status:'0x1'});
 const original=window.ethereum.request;window.ethereum.request=p=>p.method==='eth_getBlockByNumber'?Promise.resolve({hash:hash(canonical?999:998)}):original(p);
 await f.prepare();await assert.rejects(f.send(),/confirmation changed/);assert.equal(sends,1);
 canonical=true;await f.send();assert.equal(sends,2);
});

test('unknown purchase submission does not block a separately authorized claim or erase recovery',async t=>{
 let sends=0;
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction'){sends++;if(sends===1)throw Error('Submission unknown');return hash(sends);}return {status:'0x1'};},async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions:[transactions[0]]},{recoveryStorage:storage});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/Submission unknown/);
 await f.ui.action('thot-claim',button());assert.doesNotMatch(f.dialogs.at(-1)[0],/Resume/);await f.send();assert.equal(sends,2);assert.equal(data.size,1);
 await f.ui.action('thot-resume-payment',button());await assert.rejects(f.send(),/may already have submitted/);assert.equal(sends,2);
});


test('unknown purchase preserves deadline-sensitive dispute filing and seller response actions',async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let sends=0,confirmedDispute;
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction'){sends++;if(sends===1)throw Error('Purchase submission unknown');return hash(sends);}return {status:'0x1'};},async(path,options)=>{
  if(path==='/v1/thot/workspace?scope=buyer')return {market_paused:false};
  if(path==='/v1/thot/disputes/confirm'){confirmedDispute=options.body;return {status:'confirmed'};}
  return {wallet:owner,transactions:[transactions[0]]};
 },{recoveryStorage:storage});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/Purchase submission unknown/);
 f.state.thot.market_paused=true;
 for(const action of ['dispute-confirm','dispute-response-preview','dispute-waive-confirm']){
  await f.ui.action('thot-'+action,{dataset:{id:hash(91)}});assert.doesNotMatch(f.dialogs.at(-1)[0],/Resume/);await f.send();assert.equal(data.size,1);
 }
 assert.deepEqual(confirmedDispute,{id:hash(91),transaction_hash:hash(2)});assert.equal(sends,4);
 await f.ui.action('thot-resume-payment',button());await assert.rejects(f.send(),/may already have submitted/);assert.equal(sends,4);
});


test('refunded purchase cards show frozen discounted buyer payment and never advertise seller proceeds',()=>{
 const {state,ui}=viewFixture();state.role='buyer_member';state.thot.account.claimable='0';
 const order={id:hash(81),title:'Discounted purchase',seller:other,buyer:owner,gross:atoms(100),buyer_total:'99800000000000000000',receipt:{status:6,buyer_total:'99700000000000000000',seller_amount:'99200000000000000000',referral_amount:atoms(1),economics:{service_fee:atoms(1)}}};
 state.thot.orders=[order];
 let html=ui.offersHTML();assert.match(html,/Refund allocated to the buyer: 99\.7 THOT/);assert.match(html,/Payout is not yet confirmed here/);assert.doesNotMatch(html,/Seller receives|99\.2000|99\.8000|full seller price|Refund paid to buyer wallet/);
 order.refund_transaction=hash(82);html=ui.offersHTML();assert.match(html,/Refund paid to buyer wallet/);assert.match(html,/Refund paid to the buyer wallet: 99\.7 THOT/);assert.doesNotMatch(html,/claimable|Payout is not yet confirmed|Seller receives|99\.2000/);
 order.receipt.dispute={outcome:2};html=ui.offersHTML();assert.match(html,/Refund paid to the buyer wallet: 49\.85 THOT/);assert.match(html,/remaining 49\.85 THOT was sent to the canonical dead sink/);assert.doesNotMatch(html,/Seller receives|claimable/);
 delete order.refund_transaction;html=ui.offersHTML();assert.match(html,/Refund allocated to the buyer: 49\.85 THOT/);assert.match(html,/Payout is not yet confirmed here/);
});

test('replacement adoption persists across reload and never submits during verification',async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let sends=0,receiptReady=false;
 const request=async p=>{
  if(p.method==='eth_sendTransaction')return hash(++sends);
  if(p.method==='eth_getTransactionByHash')return p.params[0]===hash(3)?{hash:hash(3),from:owner,to:owner,input:'0xaaaa',value:'0x0',chainId:'0x7a69',nonce:'0x0'}:p.params[0]===hash(1)?{hash:hash(1),nonce:'0x0'}:null;
  if(p.method==='eth_getTransactionReceipt'){if(!receiptReady)throw Error('RPC unavailable');return {status:'0x1'};}
 };
 const respond=path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions,buyer_total:'100000000000000000000'};
 const first=fixture(t,request,respond,{recoveryStorage:storage});
 await first.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(first.send(),/RPC unavailable/);assert.equal(sends,1);
 receiptReady=true;globalThis.document.querySelector=()=>({value:hash(3)});
 await first.ui.action('thot-replace-transaction',{dataset:{id:'0'},disabled:false});
 assert.equal(sends,1);assert.equal(JSON.parse([...data.values()][0]).steps[0].hash,hash(3));
 const second=fixture(t,request,respond,{recoveryStorage:storage});await second.ui.action('thot-resume-payment',button());
 assert.match(second.dialogs.at(-1)[2],/Available balance/);assert.match(second.dialogs.at(-1)[2],/Transaction progress/);
 await second.send();assert.equal(sends,2);assert.equal(data.size,0);
});

test('header balance is available without visiting THOT and hides when identity is absent',t=>{
 const f=fixture(t,async()=>null);f.state.thot.capabilities.mode='thot-anvil';f.state.thot.account={balance:'10000000000000000000000'};
 assert.match(f.ui.walletSummaryHTML(),/10,000 THOT/);assert.match(f.ui.walletSummaryHTML(),/test tokens/);
 f.state.actor=null;assert.equal(f.ui.walletSummaryHTML(),'');
});

test('failed replacement persistence retains the original pending hash',async t=>{
 const data=new Map();let deny=false,sends=0;
 const storage={getItem:k=>data.get(k),setItem:(k,v)=>{if(deny)throw Error('Storage unavailable');data.set(k,v);},removeItem:k=>data.delete(k)};
 const f=fixture(t,async p=>{
  if(p.method==='eth_sendTransaction')return hash(++sends);
  if(p.method==='eth_getTransactionByHash')return p.params[0]===hash(3)?{hash:hash(3),from:owner,to:owner,input:'0xaaaa',value:'0x0',chainId:'0x7a69',nonce:'0x0'}:{nonce:'0x0'};
  if(p.method==='eth_getTransactionReceipt'){if(!deny)throw Error('Unavailable');return {status:'0x1'};}
 },null,{recoveryStorage:storage});
 await f.prepare();await assert.rejects(f.send(),/Unavailable/);deny=true;document.querySelector=()=>({value:hash(3)});
 await assert.rejects(f.ui.action('thot-replace-transaction',{dataset:{id:'0'}}),/Storage unavailable/);
 assert.equal(JSON.parse([...data.values()][0]).steps[0].hash,hash(1));assert.equal(sends,1);
});


test('wallet request and chain wait have distinct feedback and preserve unknown submission',async t=>{
 const hold=deferred(),started=deferred();let sends=0;
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction'){sends++;started.resolve();return hold.promise;}return null;});
 const progress={innerHTML:''},primary={textContent:'',disabled:false};
 document.querySelector=selector=>selector==='[data-wallet-progress]'?progress:selector==='[data-action="thot-send"]'?primary:{value:'10000'};
 await f.prepare();const sending=f.send();await started.promise;
 assert.equal(primary.textContent,'Confirm in your wallet…');assert.match(progress.innerHTML,/Waiting for you in your wallet/);assert.doesNotMatch(progress.innerHTML,/Submission unknown/);
 hold.resolve(undefined);await assert.rejects(sending,/no valid transaction hash/);
 assert.match(progress.innerHTML,/Submission unknown/);assert.equal(primary.textContent,'Check wallet activity');
 await assert.rejects(f.send(),/may already have submitted/);assert.equal(sends,1);
});

test('slow RPC rounds end polling by elapsed time and retry never resubmits',async t=>{
 t.mock.method(globalThis,'setTimeout',fn=>{queueMicrotask(fn);return 0;});
 let clock=0,sends=0,reads=0,settled=false;
 t.mock.method(performance,'now',()=>clock);
 const f=fixture(t,async p=>{if(p.method==='eth_sendTransaction')return hash(++sends);if(p.method==='eth_getTransactionReceipt'){reads++;clock+=8000;return settled?{status:'0x1'}:null;}return null;});
 const progress={innerHTML:''},primary={textContent:'',disabled:false};
 document.querySelector=selector=>selector==='[data-wallet-progress]'?progress:selector==='[data-action="thot-send"]'?primary:{value:'10000'};
 await f.prepare();await assert.rejects(f.send(),/Confirmation is pending/);
 assert.equal(reads,2);assert.equal(sends,1);assert.equal(primary.textContent,'Check confirmation');assert.equal(primary.disabled,false);
 settled=true;await f.send();assert.equal(sends,2);
});


const purchaseApprovalTx={to:owner,data:'0x095ea7b3'+other.slice(2).padStart(64,'0')+(100n).toString(16).padStart(64,'0'),value:'0x0',chainId:'0x7a69'};
function allowanceFixture(overrides={}){
 const calls=[];let accounts=0,blocks=0;
 const request=async p=>{calls.push(p);switch(p.method){
  case 'eth_accounts':return ++accounts===2&&overrides.changedAccount?[other]:[owner];
  case 'eth_chainId':return overrides.chain??'0x7a69';
  case 'eth_blockNumber':return '0x20';
  case 'eth_getBlockByNumber':return {hash:hash(++blocks===2&&overrides.reorg?998:999)};
  case 'eth_call':return p.params[1]==='latest'?(overrides.latest??'0x64'):(overrides.approved??'0x64');
  default:throw Error('Unexpected wallet write');
 }};
 return {calls,run:()=>purchaseApprovalReady({request,expected:overrides.expected??purchaseApprovalTx,from:owner,token:owner,market:other,chainId:31337,confirmations:2})};
}
test('current exact-marketplace allowance can satisfy approval without a transaction hash',async()=>{
 const f=allowanceFixture();assert.equal(await f.run(),true);assert(!f.calls.some(p=>/send|requestAccounts|Transaction/.test(p.method)));
 assert.equal(f.calls.find(p=>p.method==='eth_call').params[1],'0x1f');
});
for(const [name,options,result] of [
 ['insufficient allowance',{approved:'0x63'},false],['revoked allowance',{latest:'0x0'},false],
 ['wrong spender',{expected:{...purchaseApprovalTx,data:'0x095ea7b3'+owner.slice(2).padStart(64,'0')+'64'.padStart(64,'0')}},null],
 ['payment calldata',{expected:{...purchaseApprovalTx,data:'0xaaaa'}},null],
 ['native value',{expected:{...purchaseApprovalTx,value:'0x1'}},null]
])test('allowance recovery does not accept '+name,async()=>assert.equal(await allowanceFixture(options).run(),result));
for(const [name,options] of [['wrong chain',{chain:'0x1'}],['account switch',{changedAccount:true}],['reorganization',{reorg:true}],['missing token call',{approved:'0x'}]])test('allowance recovery rejects '+name,async()=>assert.rejects(allowanceFixture(options).run()));

for(const ambiguous of [false,true])test(`saved ${ambiguous?'unknown submission':'accelerated approval'} recovers automatically; payment rechecks allowance and never resends approval`,async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let allowance='0x64',sends=0;
 const f=fixture(t,async p=>{
  if(p.method==='eth_accounts')return [owner];
  if(p.method==='eth_call')return allowance;
  if(p.method==='eth_sendTransaction'){sends++;assert.equal(p.params[0].to,other);return hash(2);}
  if(p.method==='eth_getTransactionReceipt')return {status:'0x1'};
 },async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions:[purchaseApprovalTx,{...transactions[1],to:other}],purchase:true},{recoveryStorage:storage});
 Object.assign(f.state.thot.capabilities,{token:owner,market:other});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});
 await new Promise(resolve=>setImmediate(resolve));
 const key=[...data.keys()][0],saved=JSON.parse(data.get(key));saved.steps[0].hash=ambiguous?null:hash(1);saved.steps[0].uncertain=ambiguous;delete saved.buyer_total;data.set(key,JSON.stringify(saved));
 const progress={innerHTML:''},primary={textContent:'',disabled:false};
 document.querySelector=selector=>selector==='[data-wallet-progress]'?progress:selector==='[data-action="thot-send"]'?primary:{value:'10000'};
 // A fresh UI must use the old record, not cached in-memory state.
 const ui=createThotUI({state:f.state,api:async()=>({market_paused:false}),openDialog(){},dialog:{close(){}},refresh:async()=>{},escape:String,json:JSON.stringify,toast(){},recoveryStorage:storage});
 await ui.action('thot-resume-payment',button());
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(progress.innerHTML,/Approval ready/);assert.equal(sends,0);assert.doesNotMatch(progress.innerHTML,/Replacement transaction hash/);
 allowance='0x0';await assert.rejects(ui.action('thot-send',button()),/approval is not sufficient|may already have submitted/);assert.equal(sends,0);assert.equal(data.size,1);
 allowance='0x64';await ui.action('thot-send',button());assert.equal(sends,1);assert.equal(data.size,0);
});

test('purchase preflight failure never opens payment wallet and offers fresh review',async t=>{
 let sends=0,refreshes=0;
 const f=fixture(t,async p=>{if(p.method==='eth_call')throw Error('execution reverted: REVIEW_INPUTS_CHANGED');if(p.method==='eth_sendTransaction')sends++;},async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions:[transactions[0]]});
 const progress={innerHTML:''},primary={textContent:'',disabled:false};document.querySelector=selector=>selector==='[data-wallet-progress]'?progress:selector==='[data-action="thot-send"]'?primary:{value:'10000'};
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/No payment was sent/);
 assert.equal(sends,0);assert.equal(primary.textContent,'Review a new purchase');assert.doesNotMatch(progress.innerHTML,/Your transaction has been submitted/);
 await f.send();assert.equal(sends,0);assert.equal(f.refreshes,1);
});

test('canonical reverted purchase can leave recovery without another payment',async t=>{
 let sends=0,receipts=0;
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const f=fixture(t,async p=>{if(p.method==='eth_call')return '0x';if(p.method==='eth_sendTransaction')return hash(++sends);if(p.method==='eth_getTransactionReceipt'){receipts++;return {status:'0x0'};}},async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions:[transactions[0]]},{recoveryStorage:storage});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/reverted/);assert.equal(data.size,1);assert.equal(receipts,2);
 await f.send();assert.equal(sends,1);assert.equal(receipts,4);assert.equal(data.size,0);assert.equal(f.refreshes,1);
});

test('a failure receipt that changes canonical block cannot authorize fresh purchase',async t=>{
 let sends=0,receipts=0;
 const f=fixture(t,async p=>{if(p.method==='eth_call')return '0x';if(p.method==='eth_sendTransaction')return hash(++sends);if(p.method==='eth_getTransactionReceipt')return {status:'0x0',blockHash:++receipts%2?hash(999):hash(998)};},async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions:[transactions[0]]});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/confirmation changed/);await assert.rejects(f.send(),/confirmation changed/);assert.equal(sends,1);assert.equal(f.refreshes,0);
});

test('legacy saved revert is revalidated after reload before recovery is removed',async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 let sends=0,available=true;
 const request=async p=>{if(p.method==='eth_call')return '0x';if(p.method==='eth_sendTransaction')return hash(++sends);if(p.method==='eth_getTransactionReceipt'){if(!available)throw Error('RPC unavailable');return {status:'0x0'};}};
 const respond=async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions:[transactions[0]]};
 const first=fixture(t,request,respond,{recoveryStorage:storage});await first.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(first.send(),/reverted/);
 const second=fixture(t,request,respond,{recoveryStorage:storage});await second.ui.action('thot-resume-payment',button());assert.match(second.dialogs.at(-1)[3],/Review a new purchase/);
 available=false;await assert.rejects(second.send(),/RPC unavailable/);assert.equal(data.size,1);assert.equal(sends,1);
 available=true;await assert.rejects(second.send(),/reverted/);await second.send();assert.equal(sends,1);assert.equal(data.size,0);
});

test('fresh-review keeps dialog open until listing refresh completes',async t=>{
 const pause=deferred(),started=deferred();let closes=0;
 const f=fixture(t,async p=>{if(p.method==='eth_call')throw Error('expired');},async path=>path==='/v1/thot/workspace?scope=buyer'?{market_paused:false}:{transactions:[transactions[0]]},{dialog:{close(){closes++;}},refresh:async()=>{started.resolve();await pause.promise;}});
 await f.ui.action('thot-buy',{dataset:{id:'listing'}});await assert.rejects(f.send(),/No payment was sent/);
 const resetting=f.send();await started.promise;assert.equal(closes,0);pause.resolve();await resetting;assert.equal(closes,1);
});

test('confirmation sends explicit empty params through a strict hosted-style wallet transport',async t=>{
 let sent=0;
 const f=fixture(t,async p=>p.method==='eth_sendTransaction'?hash(++sent):{status:'0x1'});
 const original=window.ethereum.request;
 window.ethereum.request=async p=>{assert(Array.isArray(p.params), 'RPC parameters must not depend on wallet normalization');return original(p);};
 await f.prepare();await f.send();assert.equal(sent,2);assert.equal(f.refreshes,1);
 assert(f.requests.some(p=>p.method==='eth_blockNumber'&&Array.isArray(p.params)&&p.params.length===0));
});

test('wallet contributors see other sellers in the buying catalogue and their own listings separately',()=>{
 const {state,ui}=viewFixture();state.thot.listings.push({...state.thot.listings[0],id:'my-listing',seller:owner,title:'My listing'});
 const html=ui.offersHTML(),catalogue=html.slice(html.indexOf('aria-label="For sale"'),html.indexOf('id="thot-contribute"'));
 assert.match(html,/Browse data <span>1<\/span>/);assert.match(html,/Your purchases <span>0<\/span>/);assert.match(catalogue,/Listed research/);assert.doesNotMatch(catalogue,/My listing/);
 assert(html.indexOf('aria-label="For sale"')<html.indexOf('data-action="thot-list-configure"'));assert.match(html,/My listing/);assert.match(html,/thot-unlist/);
});
test('purchased reader offers a fresh authorized JSON download including licence and receipt',async t=>{
 const downloads=[],release={content:{turns:[{role:'user',content:'Synthetic purchased item'}]},license:'Evaluation licence'},result={release,receipt:{status:3},delivery_hash:hash(5)};
 const f=fixture(t,()=>{throw Error('Reading must not access wallet');},async()=>result,{download:(value,name)=>downloads.push({value,name})});
 await f.ui.action('thot-delivery',{dataset:{id:hash(1)}});assert.match(f.dialogs.at(-1)[3],/Download/);assert.equal(downloads.length,0);
 await f.ui.action('thot-download-delivery',{dataset:{id:hash(1)}});assert.equal(f.calls.length,2);assert.deepEqual(downloads,[{value:result,name:`thot-licensed-trace-${hash(1)}.json`}]);assert.equal(f.requests.length,0);
});
test('download discards a delivery returned after identity change and never exports unconfirmed content',async t=>{
 const pending=deferred(),downloads=[];let waiting=true;
 const f=fixture(t,()=>{},async()=>waiting?pending.promise:{release:{content:'private'},receipt:{status:2}},{download:value=>downloads.push(value)});
 const action=f.ui.action('thot-download-delivery',{dataset:{id:hash(1)}});f.state.actor={id:'another'};f.state.generation++;pending.resolve({release:{content:'private'},receipt:{status:3}});await assert.rejects(action,{name:'StaleWorkspaceError'});assert.equal(downloads.length,0);
 waiting=false;await assert.rejects(f.ui.action('thot-download-delivery',{dataset:{id:hash(1)}}),/not ready/);assert.equal(downloads.length,0);
});

test('only confirmed unavailable unfunded attempts are archived without zero settlement amounts',()=>{
 const {state,ui}=viewFixture(),base={seller:other,buyer:owner,gross:atoms(100)};
 state.thot.orders=[
  {...base,id:'expired',title:'Expired <attempt>',job_status:'blocked',last_error:'AUTHORIZATION_UNAVAILABLE',receipt:{status:0,gross:'0'}},
  {...base,id:'closed',title:'Closed attempt',job_status:'complete',last_error:'AUTHORIZATION_UNAVAILABLE',receipt:{status:0,gross:'0'}},
 ];
 const archived=ui.purchasesHTML();assert.match(archived,/<details class="technical-details" data-unpaid-attempts><summary>Unpaid purchase attempts \(2\)/);assert.match(archived,/Expired &lt;attempt&gt;/);assert.match(archived,/No payment was confirmed for this attempt/);assert.doesNotMatch(archived,/purchases-freshness|Payment not yet confirmed|0\.0000|AUTHORIZATION_UNAVAILABLE|thot-buy|thot-send/);
 state.thot.orders.push({...base,id:'unknown',title:'Unknown payment',job_status:'awaiting_reconciliation',last_error:'AUTHORIZATION_UNAVAILABLE',receipt:{status:0}},{...base,id:'funded',title:'Funded purchase',job_status:'blocked',last_error:'AUTHORIZATION_UNAVAILABLE',receipt:{status:2}});
 const mixed=ui.purchasesHTML(),open=mixed.slice(0,mixed.indexOf('data-unpaid-attempts'));
 assert.match(open,/Unknown payment/);assert.match(open,/Funded purchase/);assert.match(open,/purchases-freshness/);assert.doesNotMatch(open,/Expired &lt;attempt&gt;|Closed attempt/);
 assert.match(ui.offersHTML(),/Your purchases <span>2<\/span>/);
});

for(const operation of ['buy','reserve-buy'])test(`${operation} review identifies the prepared seller with a full address before signing`,async t=>{
 const f=fixture(t,()=>{throw Error('Displaying seller must not contact wallet');},()=>({id:hash(91),seller:other,transactions,buyer_total:atoms(1)}));
 await f.ui.action('thot-'+operation,{dataset:{id:'listing-one'}});
 const html=f.dialogs.at(-1)[2];
 assert.match(html,/Seller wallet/);
 assert.match(html,new RegExp('<code[^>]*class="thot-seller-address"[^>]*>'+other+'<\\/code>'));
 assert.match(html,new RegExp('data-action="thot-copy-seller-wallet"[^>]*data-id="'+other+'"'));
 assert.match(html,/aria-label="Copy seller wallet address"/);
 assert.equal(f.requests.length,0);
 assert.deepEqual(f.calls[0].options.body,{listing_id:'listing-one',...(operation==='reserve-buy'?{funding_source:'reserve'}:{})});
});

test('listings and buyer purchase cards expose the seller wallet instead of the buyer or transaction target',()=>{
 const {state,ui}=viewFixture();
 const seller='0x1234567890abcdef1234567890abcdef12345678';
 state.thot.listings[0].seller=seller;
 state.thot.orders=[{id:'my-purchase',title:'Purchased item',seller,buyer:owner,gross:atoms(1),receipt:{status:3,seller,seller_amount:atoms(1),referral_amount:'0'}}];
 const listing=ui.offersHTML().match(/<article class="thot-listing"[^>]*>[\s\S]*?<\/article>/)?.[0];
 assert(listing);
 for(const html of [listing,ui.purchasesHTML()]){
  assert.match(html,new RegExp('<code[^>]*class="thot-seller-address"[^>]*>'+seller+'<\\/code>'));
  assert.match(html,new RegExp('data-action="thot-copy-seller-wallet"[^>]*data-id="'+seller+'"'));
  assert.doesNotMatch(html,new RegExp('data-action="thot-copy-seller-wallet"[^>]*data-id="(?:'+owner+'|'+other+')"'));
 }
});

test('purchase recovery preserves its seller after reload and a click on another listing',async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const first=fixture(t,()=>{throw Error('No wallet request expected');},()=>({id:hash(92),seller:other,transactions,buyer_total:atoms(1)}),{recoveryStorage:storage});
 await first.ui.action('thot-buy',{dataset:{id:'original-listing'}});
 const key=[...data.keys()][0],saved=JSON.parse(data.get(key));
 assert.equal(saved.seller,other);saved.steps[0].hash=hash(93);data.set(key,JSON.stringify(saved));
 const replacementSeller='0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
 const second=fixture(t,()=>{throw Error('No wallet request expected');},()=>{throw Error('Pending purchase must not prepare another listing');},{recoveryStorage:storage});
 second.state.thot.listings=[{id:'new-listing',seller:replacementSeller}];
 await second.ui.action('thot-buy',{dataset:{id:'new-listing'}});
 assert.equal(second.dialogs.at(-1)[0],'Continue your purchase');
 assert.match(second.dialogs.at(-1)[2],new RegExp('data-action="thot-copy-seller-wallet"[^>]*data-id="'+other+'"'));
 assert.doesNotMatch(second.dialogs.at(-1)[2],new RegExp(replacementSeller));
 assert.equal(JSON.parse(data.get(key)).seller,other);
 assert.equal(second.calls.length,0);assert.equal(second.requests.length,0);
 assert.equal(JSON.parse(data.get(key)).steps[0].hash,hash(93));
});

for(const legacyTotal of [true,false])test(`legacy purchase recovery without seller ${legacyTotal?'with':'without'} total shows unavailable and never borrows a new listing`,async t=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const first=fixture(t,()=>{},()=>({id:hash(94),seller:other,transactions,buyer_total:atoms(1)}),{recoveryStorage:storage});
 await first.ui.action('thot-buy',{dataset:{id:'original-listing'}});
 const key=[...data.keys()][0],saved=JSON.parse(data.get(key));
 delete saved.seller;if(!legacyTotal)delete saved.buyer_total;saved.steps[0].hash=hash(95);data.set(key,JSON.stringify(saved));
 const second=fixture(t,()=>{throw Error('No wallet request expected');},()=>{throw Error('No fresh preparation expected');},{recoveryStorage:storage});
 second.state.thot.listings=[{id:'new-listing',seller:other}];
 await second.ui.action('thot-buy',{dataset:{id:'new-listing'}});
 const html=second.dialogs.at(-1)[2];assert.match(html,/Seller wallet unavailable/);assert.doesNotMatch(html,/thot-copy-seller-wallet/);
 assert.equal(second.calls.length,0);assert.equal(second.requests.length,0);
 assert.equal(JSON.parse(data.get(key)).steps[0].hash,hash(95));
});

test('copy seller wallet copies the exact address and reports success without API or wallet requests',async t=>{
 const copied=[],pause=deferred();
 const f=fixture(t,()=>{throw Error('Copy must not access wallet');},()=>{throw Error('Copy must not call API');},{copyText:async text=>{copied.push(text);await pause.promise;}});
 const copying=f.ui.action('thot-copy-seller-wallet',{dataset:{id:other},disabled:false});
 assert.deepEqual(copied,[other]);assert.deepEqual(f.notices,[]);
 pause.resolve();await copying;
 assert.deepEqual(f.notices,['Seller wallet copied.']);assert.equal(f.requests.length,0);assert.equal(f.calls.length,0);
});

test('unavailable clipboard gives manual copy guidance without leaking the clipboard error',async t=>{
 const f=fixture(t,()=>{throw Error('Copy must not access wallet');},()=>{throw Error('Copy must not call API');},{copyText:async()=>{throw Error('PRIVATE_CLIPBOARD_DIAGNOSTIC');}});
 await assert.rejects(f.ui.action('thot-copy-seller-wallet',{dataset:{id:other},disabled:false}),{message:'Could not copy. Select and copy the seller address shown above.'});
 assert.deepEqual(f.notices,[]);assert.equal(f.requests.length,0);assert.equal(f.calls.length,0);
});

for(const invalid of [undefined,'0x1234','0x'+'0'.repeat(40),'<img src=x onerror=alert(1)>',other+'extra'])test(`invalid seller ${invalid===undefined?'missing':invalid==='0x1234'?'short':invalid==='0x'+'0'.repeat(40)?'zero address':invalid.startsWith('<')?'markup':'trailing data'} is unavailable and cannot be copied`,async t=>{
 const copied=[];
 const f=fixture(t,()=>{throw Error('No wallet request expected');},()=>({id:hash(96),seller:invalid,transactions,buyer_total:atoms(1)}),{copyText:async text=>copied.push(text)});
 await f.ui.action('thot-buy',{dataset:{id:'invalid-seller-listing'}});
 const html=f.dialogs.at(-1)[2];assert.match(html,/Seller wallet unavailable/);assert.doesNotMatch(html,/thot-copy-seller-wallet|<img/);
 const callsBefore=f.calls.length;await assert.rejects(f.ui.action('thot-copy-seller-wallet',{dataset:{id:invalid},disabled:false}));
 assert.deepEqual(copied,[]);assert.equal(f.requests.length,0);assert.equal(f.calls.length,callsBefore);
});


test('partial catalogue exposes listing metadata and seller copy without buying or false account totals',()=>{
 const {state,ui}=viewFixture(),catalogue={capabilities:state.thot.capabilities,wallet:owner,listings:state.thot.listings};
 const html=ui.catalogueHTML(catalogue);
 assert.match(html,/Listed research/);assert.match(html,new RegExp(other));assert.match(html,/data-action="thot-copy-seller-wallet"/);assert.match(html,/Evaluation only/);
 assert.match(html,/Loading balances and purchase history/);assert.match(html,/Loading your purchase history/);
 assert.doesNotMatch(html,/data-action="thot-(?:buy|reserve-buy|unlist|assay|buyer-sample|send|resume-payment)"/);
 assert.doesNotMatch(html,/No open purchases|Save an item in your private library first|(?<![0-9])0 THOT|Local demo/);
 const failed=ui.catalogueHTML(catalogue,{failed:true});assert.match(failed,/Balances and purchase history could not load/);assert.match(failed,/Purchase history is unavailable/);assert.match(failed,/Retry account details/);
});

test('catalogue loading and failure are distinct from a verified empty listing response',()=>{
 const {ui}=viewFixture();
 assert.match(ui.catalogueHTML(null),/Loading listings/);assert.doesNotMatch(ui.catalogueHTML(null),/No data listed yet/);
 assert.match(ui.catalogueHTML(null,{catalogueError:true}),/Listings could not load/);assert.doesNotMatch(ui.catalogueHTML(null,{catalogueError:true}),/No data listed yet/);
 assert.match(ui.catalogueHTML({listings:[]}),/No data listed yet/);
});


test('owner release review refuses a mismatched commitment before opening sale controls',async t=>{
 const f=fixture(t,async()=>{throw Error('No wallet request expected');},async()=>({trace_id:'trace',content_hash:hash(1)}),{previewResponse:async()=>({trace_id:'trace',content_hash:hash(2),content:{turns:[]},sale_eligibility:{can_list:true}})});
 await assert.rejects(f.ui.action('thot-list-configure',{dataset:{id:'trace'}}),/release changed while loading/);
 assert.equal(f.dialogs.length,0);assert.equal(f.requests.length,0);
 assert.deepEqual(f.calls.map(c=>c.path),['/v1/thot/listings/metadata','/v1/thot/listings/preview']);
});

test('selected privacy changes cannot sign an unchanged release and server removal requires fresh consent',async t=>{
 let contentHash=hash(1);
 const preview=()=>({trace_id:'trace',content_hash:contentHash,content:{turns:[{role:'user',content:contentHash===hash(1)?'First synthetic message':'Remaining synthetic message'}]},sale_eligibility:{can_list:true},exclusion:{supported:true}});
 const f=fixture(t,async()=>{throw Error('No signature expected');},async(path,options)=>{
  if(path.endsWith('/metadata'))return {trace_id:'trace',content_hash:contentHash};
  if(path.endsWith('/exclude')){assert.deepEqual(options.body,{trace_id:'trace',content_hash:hash(1),excluded_turns:[0],rights_confirmed:true,model_output_licensed:false});contentHash=hash(2);return preview();}
  throw Error('Unexpected API write');
 },{previewResponse:async()=>preview()});
 const selected={name:'excluded_turn',value:'0',checked:true},sign={disabled:false,textContent:''};
 document.querySelectorAll=()=>[selected];document.querySelector=id=>({'#release-exclusion-rights':{checked:true},'#release-exclusion-outputs':{checked:false},'#thot-list-consent':{checked:false},'[data-action="thot-list-confirm"]':sign}[id]);
 await f.ui.action('thot-list-configure',{dataset:{id:'trace'}});f.ui.onInput(selected);assert.equal(sign.disabled,true);
 await assert.rejects(f.ui.action('thot-list-confirm',button()),/Apply the selected removals/);
 await f.ui.action('thot-release-exclude',button());
 assert.match(f.dialogs.at(-1)[2],/Remaining synthetic message/);assert.doesNotMatch(f.dialogs.at(-1)[2],/First synthetic message/);
 await assert.rejects(f.ui.action('thot-list-confirm',button()),/Authorize the content rights/);
 assert.equal(f.requests.length,0);assert.equal(f.calls.filter(c=>c.path==='/v1/thot/listings').length,0);
});

test('a changed account discards a delayed private release preview',async t=>{
 const wait=deferred(),f=fixture(t,async()=>{},async()=>({trace_id:'trace',content_hash:hash(1)}),{previewResponse:()=>wait.promise});
 const work=f.ui.action('thot-list-configure',{dataset:{id:'trace'}});f.state.generation++;f.state.actor={id:'another'};
 wait.resolve({trace_id:'trace',content_hash:hash(1),content:{turns:[{role:'user',content:'Former private content'}]},sale_eligibility:{can_list:true}});
 await assert.rejects(work,{name:'StaleWorkspaceError'});assert.equal(f.dialogs.length,0);
});

test('percentage listing estimate uses the listed price and labels its basis without authorizing anything',t=>{
 const f=fixture(t,async()=>{}),target={textContent:''};document.querySelector=()=>target;
 f.state.thot.account={economics:{policy:'percentage/1',fee_bps:100,service_fee:'10000000000000000',direct_cost:'0'}};
 f.ui.onInput({id:'thot-price',value:'100'});
 assert.match(target.textContent,/Base service fee \(1% of the price\): 1 THOT/);
 assert.match(target.textContent,/Estimated seller proceeds: 99 THOT/);
 assert.match(target.textContent,/any applicable discounts/);assert.match(target.textContent,/not guaranteed/);
 assert.doesNotMatch(target.textContent,/0\.01 THOT/);assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
 f.state.thot.account.economics={policy:'future-policy/1',fee_bps:100,service_fee:'10000000000000000',direct_cost:'0'};
 f.ui.onInput({id:'thot-price',value:'100'});assert.match(target.textContent,/Refresh your account/);assert.doesNotMatch(target.textContent,/THOT|%/);
});

test('listing review and THOT page distinguish configured tariff profiles and unknown policy',async t=>{
 for(const economics of [
  {policy:'percentage/1',fee_bps:100,service_fee:'10000000000000000',direct_cost:'0'},
  {policy:'quoted-cost/1',fee_bps:null,service_fee:'40000000000000000',direct_cost:'10000000000000000'},
  {policy:'future-policy/1',fee_bps:100,service_fee:'10000000000000000',direct_cost:'0'},
 ]){
  const f=fixture(t,async()=>{},async()=>({trace_id:'trace',content_hash:hash(1)}));f.state.thot.account={economics};
  await f.ui.action('thot-list-configure',{dataset:{id:'trace'}});const review=f.dialogs.at(-1)[2];
  const view=viewFixture();view.state.thot.account.economics=economics;const token=view.ui.tokenHTML();
  for(const html of [review,token]){
   if(economics.policy==='percentage/1'){assert.match(html,/1% of the listed price/);assert.doesNotMatch(html,/0\.01 THOT per purchase/);}
   else if(economics.policy==='quoted-cost/1'){assert.match(html,/0\.04 THOT per purchase/);assert.doesNotMatch(html,/Eligible holders and stakers receive.*at funding/);}
   else{assert.match(html,/current service fee is unavailable/);assert.doesNotMatch(html,/1% of|0\.01 THOT per purchase/);}
   assert.match(html,/Estimates do not guarantee a sale or payout/);
  }
  if(economics.policy==='future-policy/1')assert.match(token,/<small>SERVICE FEE PER PURCHASE<\/small><strong>Refresh quote<\/strong>/);
  assert.equal(f.calls.some(call=>call.path==='/v1/thot/listings'),false);assert.equal(f.requests.length,0);
 }
});
