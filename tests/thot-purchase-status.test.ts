import test from 'node:test';
import assert from 'node:assert/strict';
import {ThotMarketplace} from '../packages/market/src/thot-market.ts';
import {ThotChain} from '../packages/chain/thot.ts';

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
