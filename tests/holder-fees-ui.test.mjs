import test from 'node:test';
import assert from 'node:assert/strict';
import {createThotUI} from '../apps/dashboard/thot-ui.js';
const offer='0x'+'12'.repeat(32),wallet='0x'+'11'.repeat(20),u=n=>String(BigInt(n)*10n**18n);
function fixture(){
 const calls=[],dialogs=[],state={actor:{id:'owner'},generation:1,role:'user',thot:{wallet,capabilities:{mode:'thot-testnet',chain_id:46630},account:{balance:u(100000),claimable:'0',lots:[],economics:{}},orders:[],holder_rewards:{is_owner:true,policy:{id:1,tiers:[{minimum_atoms:u(10000),rebate_bps:1000},{minimum_atoms:u(100000),rebate_bps:2500}]},rate_bps:2500,qualifying_balance_atoms:u(100000),inventory_atoms:u(1000),orders:[{offer_id:offer,amount_atoms:'10000000000000000',paid_atoms:'0',claimable:true}]}}};
 const ui=createThotUI({state,api:async(path,options)=>{calls.push({path,options});return {wallet,transactions:[{to:wallet,data:'0xab',value:'0x0',chainId:'0xb626'}],quote:{amount_atoms:'10000000000000000'},notice:'Claim displayed cashback'};},openDialog:(...a)=>dialogs.push(a),dialog:{},refresh:async()=>{},escape:String,json:JSON.stringify,toast:()=>{},getProvider:()=>undefined});
 return {state,ui,calls,dialogs};
}
test('holder screen separates fee cashback from staking, trace price and escrow',()=>{
 const f=fixture(),html=f.ui.tokenHTML();for(const text of ['10% fee cashback','25% fee cashback','No stake required','unclaimed staking principal','service fee, not the trace price','Available pool:','Claim fee cashback','Governance: change future'])assert.ok(html.includes(text),text);
 f.state.thot.holder_rewards.is_owner=false;assert.doesNotMatch(f.ui.tokenHTML(),/id="holder-first"/);
 f.state.thot.holder_rewards.orders[0].claimable=false;assert.doesNotMatch(f.ui.tokenHTML(),/data-action="thot-holder-rebate"/);
});
test('claim button prepares exactly the chosen offer and requires wallet review',async()=>{
 const f=fixture();await f.ui.action('thot-holder-rebate',{dataset:{id:offer}});assert.deepEqual(f.calls[0],{path:'/v1/thot/transaction',options:{method:'POST',body:{action:'holder-rebate',offer_id:offer}}});assert.equal(f.dialogs[0][0],'Claim your fee cashback');assert.match(f.dialogs[0][2],/0\.0100 THOT/);
});
