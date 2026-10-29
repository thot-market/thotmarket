import test from 'node:test';
import assert from 'node:assert/strict';
import {ThotMarketplace} from '../packages/market/src/thot-market.ts';
import {ThotChain} from '../packages/chain/thot.ts';
import {holderRewardsWorkspace} from '../packages/chain/thot-holder-rewards.ts';
import {Interface} from 'ethers';
import {Database} from '../packages/storage/src/index.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test('all chain modes refuse paused offer preparation before writing an intent',async()=>{
 for(const mode of ['anvil','testnet','production']){
  let writes=0;
  const market={enabled:()=>({config:{mode},marketPaused:async()=>true}),service:{db:{command:async()=>{writes++;}}}};
  await assert.rejects(ThotMarketplace.prototype.prepareOffer.call(market as any,{id:'buyer',role:'buyer_member'},'key',{listing_id:'listing'}),/THOT_MARKET_PAUSED/);
  assert.equal(writes,0);
 }
});

test('unavailable pause read never creates a purchase intent',async()=>{
 let writes=0;
 const market={enabled:()=>({marketPaused:async()=>{throw Error('RPC_UNAVAILABLE');}}),service:{db:{command:async()=>{writes++;}}}};
 await assert.rejects(ThotMarketplace.prototype.prepareOffer.call(market as any,{id:'buyer',role:'buyer_member'},'key',{}),/RPC_UNAVAILABLE/);assert.equal(writes,0);
});

test('workspace pause uses the same confirmed block as account and offers in every mode',async()=>{
 for(const mode of ['anvil','testnet','production']){
  const block={number:42};let checked=0;
  const chain={config:{mode},snapshot:async()=>block,market:{paused:async({blockTag}:any)=>{assert.equal(blockTag,42);return true;}},assertSnapshot:async(b:any)=>{assert.equal(b,block);checked++;}};
  const view=await ThotChain.prototype.readWorkspace.call(chain as any,undefined,[]);
  assert.equal(view.market_paused,true);assert.equal(checked,1);
 }
});

test('unfunded cart reviews read only the authoritative offer struct',async()=>{
 const id='0x'+'3'.repeat(64),zero='0x'+'0'.repeat(40),block={number:42,hash:'0x'+'4'.repeat(64),timestamp:1234};
 let reads=0;
 const chain={config:{percentageFees:true},disputeWindowSeconds:43200,market:{offers:async(_id:string,at:any)=>{assert.equal(at.blockTag,42);reads++;return {status:0,buyer:zero,seller:zero,licenseHash:id,evidenceHash:id,reviewHash:id,deliveryHash:id};},quoteDigest:async()=>{throw Error('UNNECESSARY_RPC');},paymentFor:async()=>{throw Error('UNNECESSARY_RPC');},disputeCases:async()=>{throw Error('UNNECESSARY_RPC');},tariffAtFunding:async()=>{throw Error('UNNECESSARY_RPC');}}};
 const receipt=await (ThotChain.prototype as any).offerAt.call(chain,id,block);
 assert.equal(receipt.status,0);assert.equal(receipt.block,block);assert.equal(reads,1);
});

test('buyer workspace defers estimates and staking but retains guarded account, receipts and isolation',async t=>{
 const block={number:42,hash:'0x'+'a'.repeat(64),timestamp:1234},wallet='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40);
 const records=[
  {id:'wallet:owner',kind:'wallet',owner_id:'owner',address:wallet},
  {id:'wallet:other',kind:'wallet',owner_id:'other',address:other},
  {id:'mine',kind:'listing',owner_id:'owner',wallet,trace_id:'my-trace',active:false},
  {id:'public',kind:'listing',owner_id:'other',wallet:other,trace_id:'other-private-trace',active:true},
  {kind:'intent',owner_id:'owner',offer_id:'0x'+'3'.repeat(64),listing_id:'public'},
  {kind:'intent',owner_id:'other',offer_id:'0x'+'4'.repeat(64),listing_id:'private'},
 ];
 let snapshots=0,assertions=0,valuations=0,fail=false;
 const chain:any={config:{staking:'must-not-read',feeDiscounts:'must-not-read'},publicChain:()=>true,
  snapshot:async()=>{snapshots++;if(fail)throw Error('THOT_CODE_PIN_MISMATCH');return block;},
  readWorkspace:async(owner:string,ids:string[],b:any)=>{assert.equal(owner,wallet);assert.equal(b,block);assert.deepEqual(ids,['0x'+'3'.repeat(64)]);return {account:{wallet:owner,balance:'17',claimable:'3',block:b},offers:ids.map(id=>({id,status:2,block:b})),market_paused:true};},
  isReserveBuyer:async(owner:string,b:any)=>{assert.equal(owner,wallet);assert.equal(b,block);return false;},assertSnapshot:async(b:any)=>{assertions++;assert.equal(b,block);}};
 const db=await Database.open();t.after(()=>db.close());
 await db.transaction(async tx=>{for(const [index,row] of records.entries())await tx.insert('thot_records',row.id??'intent-'+index,row.owner_id,row);});
 const market=Object.assign(Object.create(ThotMarketplace.prototype),{chain,service:{db},capabilities:()=>({mode:'thot-production'}),valuationRows:async()=>{valuations++;return [{trace_id:'my-trace'}];}});
 const first=await market.workspace({id:'owner',role:'user'},{scope:'buyer'});
 assert.equal(first.workspace_scope,'buyer');assert.equal(first.account.balance,'17');assert.equal(first.market_paused,true);
 assert.equal(first.orders.length,1);assert.equal(first.orders[0].receipt.block,first.account.block);
 assert.equal(first.own_listings[0].trace_id,'my-trace');assert(!JSON.stringify(first).includes('other-private-trace'));
 assert.equal(valuations,0);assert.equal(first.holder_rewards,null);assert.equal(first.staking,null);assert.deepEqual(first.valuations,[]);
 await market.workspace({id:'owner',role:'user'},{scope:'buyer'});assert.equal(snapshots,2);assert.equal(assertions,2,'each request independently verifies its snapshot');
 chain.config={};const full=await market.workspace({id:'owner',role:'user'});assert.equal(full.workspace_scope,'full');assert.equal(valuations,1);assert.equal(full.valuations[0].trace_id,'my-trace');
 fail=true;await assert.rejects(market.workspace({id:'owner',role:'user'},{scope:'buyer'}),/THOT_CODE_PIN_MISMATCH/);
 fail=false;chain.assertSnapshot=async()=>{throw Error('THOT_SNAPSHOT_CHANGED');};await assert.rejects(market.workspace({id:'owner',role:'user'},{scope:'buyer'}),/THOT_SNAPSHOT_CHANGED/);
 await assert.rejects(market.workspace({id:'owner',role:'user'},{scope:'bad'}),/INVALID_WORKSPACE_SCOPE/);
 await assert.rejects(market.workspace({id:'other',role:'service_settlement'},{scope:'buyer'}),/FORBIDDEN/);
});

test('pause and account reads start together, but order fanout waits for both',async()=>{
 const block={number:42},accountGate=deferred(),pauseGate=deferred();
 const started:string[]=[];
 const chain={snapshot:async()=>block,accountAt:async()=>{started.push('account');await accountGate.promise;return {balance:'1',block};},market:{paused:async()=>{started.push('pause');await pauseGate.promise;return false;}},offerAt:async()=>{started.push('order');return {status:2,block};},assertSnapshot:async()=>{started.push('assert');}};
 const view=ThotChain.prototype.readWorkspace.call(chain as any,'0x'+'1'.repeat(40),['0x'+'2'.repeat(64)]);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['account','pause']);
 accountGate.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['account','pause']);
 pauseGate.resolve();assert.equal((await view).market_paused,false);assert.deepEqual(started,['account','pause','order','assert']);
});

test('direct-discount display reads run concurrently at one block and never cache later values',async()=>{
 const address='0x'+'1'.repeat(40),governor='0x'+'2'.repeat(40),owner='0x'+'3'.repeat(40),block={number:42,hash:'0x'+'4'.repeat(64),timestamp:1234};
 const methods=['firstThreshold','secondThreshold','firstBps','secondBps','version','lockThreshold','lockDuration','lockBps'];
 const abi=new Interface([...methods.map(name=>'function '+name+'() view returns(uint256)'),'function qualifyingBalance(address) view returns(uint256)','function rateBps(address) view returns(uint256)','function isOwner(address) view returns(bool)']);
 let currentBalance=500n,gate=deferred(),started=0,checked=0;
 const provider={call:async(tx:any)=>{assert.equal(tx.blockTag,42);const parsed=abi.parseTransaction(tx)!;started++;await gate.promise;return abi.encodeFunctionResult(parsed.name,[parsed.name==='isOwner'?false:parsed.name==='qualifyingBalance'?currentBalance:100n]);}};
 const chain={config:{feeDiscounts:address,governor,percentageFees:true},provider,snapshot:async()=>block,assertSnapshot:async(b:any)=>{assert.equal(b,block);checked++;}};
 const first=holderRewardsWorkspace(chain as any,owner);await new Promise(resolve=>setImmediate(resolve));assert.equal(started,11,'all fixed-size independent reads start without a serial RPC round trip');
 gate.resolve();assert.equal((await first)!.qualifying_balance_atoms,'500');assert.equal(checked,1);
 currentBalance=700n;gate=deferred();gate.resolve();const second=await holderRewardsWorkspace(chain as any,owner);assert.equal(second!.qualifying_balance_atoms,'700');assert.equal(started,22);assert.equal(checked,2);
 chain.assertSnapshot=async()=>{throw Error('THOT_SNAPSHOT_CHANGED');};await assert.rejects(holderRewardsWorkspace(chain as any,owner),/THOT_SNAPSHOT_CHANGED/);
});

test('ordinary intent status exposes fixed codes and no raw worker exceptions',()=>{
 const view=(ThotMarketplace.prototype as any).publicIntent({offer_id:'offer',job_status:'awaiting_reconciliation',last_error:'sensitive upstream message',signature:'secret',release:{content:'private'}});
 assert.equal(view.job_status,'awaiting_reconciliation');assert.equal(view.last_error,'AUTOMATION_PENDING');
 assert.equal(view.signature,undefined);assert.equal(view.release,undefined);assert(!JSON.stringify(view).includes('sensitive'));
 const known=(ThotMarketplace.prototype as any).publicIntent({job_status:'invented',last_error:'AUTHORIZATION_UNAVAILABLE'});
 assert.equal(known.job_status,null);assert.equal(known.last_error,'AUTHORIZATION_UNAVAILABLE');
});


test('listing preparation refuses private, incomplete and stale releases before opening content',async()=>{
 const now='2026-09-22T12:00:00.000Z',trace={retention_expires_at:'2026-10-22T12:00:00.000Z',rights_status:'eligible',scrub_ref:'scrub',normalized_hash:'normalized',provenance_id:'proof'};
 const input={rights_confirmed:true,metadata_public:true,automatic_sales:true,title:'Synthetic listing',license:'Synthetic evaluation licence for this test.',price_thot:'100',trace_id:'trace'};
 for(const extra of [{save_privately:true},{projection:{status:'PARTIAL'}},{agent_capture_id:'capture',capture_state:'COMPLETED',projection:{status:'READY',source_root:'new'},release_preparation:{status:'READY',source_root:'old'}}]){
  let opens=0;
  const tx={maybe:async()=>null,get:async()=>({...trace,...extra})};
  const market={enabled:()=>({market:{costQuote:async()=>({sellerAmount:99000000000000000000n})}}),wallet:async()=> '0x0000000000000000000000000000000000000001',service:{now:()=>now,db:{command:async(_a:any,_k:any,_b:any,fn:any)=>fn(tx)},privacy:{open:async()=>{opens++;throw Error('CONTENT_MUST_REMAIN_CLOSED');}}}};
  await assert.rejects(ThotMarketplace.prototype.listTrace.call(market as any,{id:'seller',role:'user'},'key',input),/TRACE_INELIGIBLE/);assert.equal(opens,0);
 }
});


test('wallet preparation permits a full cart after ten earlier quotes but retains a daily ceiling',async()=>{
 const now=Date.now();
 for(const count of [10,29,99,100]){
  const tx={maybe:async()=>null,list:async()=>Array.from({length:count},()=>({kind:'intent',created_at:new Date(now).toISOString()}))};
  const market={now:()=>now,enabled:()=>({config:{},marketPaused:async()=>false}),wallet:async()=>{throw Error('PASSED_QUOTA');},service:{db:{command:async(_actor:any,_key:any,_input:any,run:any)=>run(tx)}}};
  await assert.rejects(ThotMarketplace.prototype.prepareOffer.call(market as any,{id:'buyer',role:'buyer_member'},'key',{listing_id:'synthetic'}),count<100?/PASSED_QUOTA/:/THOT_DAILY_PREPARATION_LIMIT/);
 }
});
