import test from 'node:test';
import assert from 'node:assert/strict';
import {createThotUI} from '../apps/dashboard/thot-ui.js';

const owner='0x0000000000000000000000000000000000000001';
const seller='0x0000000000000000000000000000000000000002';
const atoms=n=>(BigInt(n)*10n**18n).toString();
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(id='')=>({dataset:{id},disabled:false});
function campaign(id,overrides={}){
 return {id:String(id),policy_hash:'0x'+'ab'.repeat(32),budget_atoms:atoms(50000000),committed_atoms:atoms(100),available_atoms:atoms(5000),upfront_atoms:atoms(555555),start_at:1,end_at:7776001,status:'active',paused:false,closed:false,...overrides};
}
function fixture(t,{concurrent=true,role='buyer_admin',isOwner=true,reserveBuyer=true,respond}={}){
 const capabilities={mode:'thot-anvil',chain_id:31337,market:seller,reserve:owner,manual_reserve:true,reserve_campaigns:concurrent};
 const state={actor:{id:'actor'},generation:1,role,thot:{wallet:owner,reserve_buyer:reserveBuyer,capabilities},thotSampling:{capabilities,campaign_mode:concurrent?'concurrent':'legacy',wallet:owner,reserve_buyer:reserveBuyer,market_bound:true,paused:false,inventory_atoms:atoms(500000000),unallocated_atoms:atoms(400000000),total_allocated_atoms:atoms(100000000),total_gross_committed_atoms:atoms(100),campaigns:[campaign(1),campaign(2,{status:'paused',paused:true}),campaign(3,{status:'scheduled',start_at:9999999999}),campaign(4,{status:'ended',available_atoms:'0'}),campaign(5,{status:'cancelled',closed:true})],reserve:{balance:atoms(500000000),allowance:atoms(1000),committed:atoms(100),start_at:0,block:{timestamp:100}},governance:{owner:isOwner,address:owner,owners:[owner,seller,'0x0000000000000000000000000000000000000003'],threshold:1,delay_seconds:0,market_delay_seconds:0,block:{timestamp:100},operations:[],campaign_start_at:0},samples:[{id:'listed-trace',seller,title:'Useful debugging trace',price_atoms:atoms(10),workflow:'coding',turn_count:20}],jobs:[]}};
 const inputs={
  '#thot-campaign-budget':{value:'50000000'},'#thot-campaign-days':{value:'90'},'#thot-campaign-upfront':{value:'555555.555555555555555555'},'#thot-campaign-purpose':{value:'Useful debugging traces'},'#thot-new-campaign-start':{value:''},'#thot-buy-campaign':{value:''},
 };
 const previous=globalThis.document;globalThis.document={querySelector:id=>inputs[id]};t.after(()=>{globalThis.document=previous;});
 const calls=[],dialogs=[];
 const ui=createThotUI({state,escape,json:value=>escape(JSON.stringify(value)),api:async(path,options)=>{calls.push({path,options});return respond?respond(path,options):{transactions:[],buyer_total:atoms(10),economics:{service_fee:atoms(1),seller_amount:atoms(9)}};},openDialog:(...args)=>dialogs.push(args),dialog:{close(){}},refresh:async()=>{},toast:()=>{},getProvider:()=>null});
 return {state,ui,inputs,calls,dialogs};
}

test('concurrent Treasury exposes separate budgets and lifecycle controls without legacy campaign controls',t=>{
 const f=fixture(t),html=f.ui.samplingHTML();
 assert.match(html,/Create an acquisition campaign/);assert.match(html,/value="50000000"/);assert.match(html,/value="90"/);
 assert.match(html,/Several campaigns can run at once/);assert.match(html,/Unspent allowance carries forward/);assert.match(html,/no independent-demand match/);
 assert.match(html,/thot-gov-pause_campaign" data-id="1"/);assert.match(html,/thot-gov-resume_campaign" data-id="2"/);
 assert.match(html,/thot-gov-expire_campaign" data-id="4"/);assert.doesNotMatch(html,/thot-gov-(?:pause|resume|cancel)_campaign" data-id="5"/);
 assert.doesNotMatch(html,/thot-gov-start_campaign|thot-gov-queue_campaign|Successor reserve|5000.*Total budget/);
});

test('legacy capability keeps the existing activation and reserve buying interface',t=>{
 const f=fixture(t,{concurrent:false}),html=f.ui.samplingHTML();
 assert.match(html,/thot-gov-start_campaign/);assert.match(html,/thot-gov-queue_campaign/);assert.match(html,/Successor reserve/);
 assert.match(html,/thot-reserve-buy/);assert.doesNotMatch(html,/Create an acquisition campaign|thot-campaign-budget/);
});

test('reserve buyers can inspect and purchase but cannot manage campaign budgets without owner status',async t=>{
 const f=fixture(t,{isOwner:false}),html=f.ui.samplingHTML();
 assert.match(html,/thot-buyer-sample/);assert.match(html,/thot-reserve-buy/);
 assert.doesNotMatch(html,/thot-gov-create_campaign|thot-gov-pause_campaign|Reserve governance/);
 await assert.rejects(f.ui.action('thot-gov-create_campaign',button()),/governance owner/);assert.equal(f.calls.length,0);
 f.state.thotSampling.reserve_buyer=false;f.state.thot.reserve_buyer=false;
 assert.equal(f.ui.samplingHTML(),'');await assert.rejects(f.ui.action('thot-reserve-buy',button('listed-trace')),/authorized reserve buyer/);
});

test('a new campaign reviews exact budget, start and purpose without asking the wallet to send early',async t=>{
 const f=fixture(t);await f.ui.action('thot-gov-create_campaign',button());
 assert.deepEqual(f.calls,[{path:'/v1/thot/governance/prepare',options:{method:'POST',body:{action:'create_campaign',target:'reserve',params:{budget_thot:'50000000',duration_days:90,start_at:0,upfront_thot:'555555.555555555555555555',purpose:'Useful debugging traces'}}}}]);
 assert.equal(f.dialogs.at(-1)[0],'Reserve governance');assert.match(f.dialogs.at(-1)[3],/thot-send/);
});

test('campaign validation rejects overspending, impossible upfront limits and invalid duration before prepare',async t=>{
 const f=fixture(t);
 for(const [selector,value,message] of [['#thot-campaign-budget','400000001',/unallocated reserve/],['#thot-campaign-upfront','50000001',/upfront allowance/],['#thot-campaign-days','0',/1 to 365/],['#thot-campaign-days','365.5',/1 to 365/],['#thot-campaign-purpose','',/Describe/],['#thot-campaign-purpose','Too short',/10 to 240/],['#thot-campaign-purpose','x'.repeat(241),/10 to 240/],['#thot-new-campaign-start','not-a-date',/future campaign start/]]){
  const before=f.inputs[selector].value;f.inputs[selector].value=value;
  await assert.rejects(f.ui.action('thot-gov-create_campaign',button()),message);f.inputs[selector].value=before;
 }
 assert.equal(f.calls.length,0);
});

test('campaign lifecycle review uses the selected campaign id and requires owner capability',async t=>{
 const f=fixture(t);
 for(const [action,id] of [['pause_campaign','1'],['resume_campaign','2'],['cancel_campaign','3'],['expire_campaign','4']]){
  await f.ui.action('thot-gov-'+action,button(id));assert.deepEqual(f.calls.at(-1).options.body,{action,target:'reserve',params:{campaign_id:id}});
 }
 await f.ui.action('thot-gov-bind_market',button());assert.deepEqual(f.calls.at(-1).options.body,{action:'bind_market',target:'reserve',params:{}});
 await assert.rejects(f.ui.action('thot-gov-cancel_campaign',button('5')),/Refresh this campaign/);
});

test('reserve purchase requires an explicit active campaign and sends no buyer price override',async t=>{
 const f=fixture(t);await f.ui.action('thot-reserve-buy',button('listed-trace'));
 assert.equal(f.calls.length,0);assert.equal(f.dialogs.at(-1)[0],'Choose the paying campaign');
 const html=f.dialogs.at(-1)[2];assert.match(html,/<option value="1">/);assert.doesNotMatch(html,/<option value="[2345]">/);
 await assert.rejects(f.ui.action('thot-reserve-buy-confirm',button()),/Choose an active campaign/);
 f.inputs['#thot-buy-campaign'].value='1';await f.ui.action('thot-reserve-buy-confirm',button());
 assert.deepEqual(f.calls.at(-1),{path:'/v1/thot/offers/prepare',options:{method:'POST',body:{listing_id:'listed-trace',funding_source:'reserve',campaign_id:'1'}}});
 assert.match(f.dialogs.at(-1)[2],/Total escrow: 10.0000 THOT/);assert.match(f.dialogs.at(-1)[2],/contributor’s asking price/);
});

test('paused campaign and changed identity cannot submit a selected reserve purchase',async t=>{
 const f=fixture(t);await f.ui.action('thot-reserve-buy',button('listed-trace'));
 f.inputs['#thot-buy-campaign'].value='2';await assert.rejects(f.ui.action('thot-reserve-buy-confirm',button()),/active campaign/);
 f.inputs['#thot-buy-campaign'].value='1';f.state.generation++;
 await assert.rejects(f.ui.action('thot-reserve-buy-confirm',button()),{name:'StaleWorkspaceError'});assert.equal(f.calls.length,0);
});

test('changing the selected trace during preparation cannot open the old purchase for signing',async t=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 const f=fixture(t,{respond:()=>pending});await f.ui.action('thot-reserve-buy',button('first-trace'));
 f.inputs['#thot-buy-campaign'].value='1';const preparing=f.ui.action('thot-reserve-buy-confirm',button());
 await f.ui.action('thot-reserve-buy',button('second-trace'));finish({transactions:[],buyer_total:atoms(10)});
 await assert.rejects(preparing,/selected trace changed/);assert.equal(f.dialogs.at(-1)[0],'Choose the paying campaign');
 assert.doesNotMatch(f.dialogs.at(-1)[3],/thot-send/);
});

test('legacy reserve and ordinary buyer purchase payloads remain unchanged',async t=>{
 const f=fixture(t,{concurrent:false});await f.ui.action('thot-reserve-buy',button('listed-trace'));
 assert.deepEqual(f.calls.at(-1).options.body,{listing_id:'listed-trace',funding_source:'reserve'});
 await f.ui.action('thot-buy',button('listed-trace'));assert.deepEqual(f.calls.at(-1).options.body,{listing_id:'listed-trace'});
});

test('Treasury resumes the exact owned unfunded purchase after reloading',async t=>{
 const f=fixture(t,{respond:()=>({id:'reserved-offer',resumed:true,transactions:[],buyer_total:atoms(10)})});
 f.state.thotSampling.jobs=[{id:'reserved-offer',listing_id:'listed-trace',campaign_id:'1',title:'Useful trace',gross:atoms(10),receipt:{status:0},resume_available:true}];
 assert.match(f.ui.samplingHTML(),/data-action="thot-reserve-resume" data-id="reserved-offer"/);
 await f.ui.action('thot-reserve-resume',button('reserved-offer'));
 assert.deepEqual(f.calls.at(-1).options.body,{listing_id:'listed-trace',funding_source:'reserve',campaign_id:'1'});
 assert.equal(f.dialogs.at(-1)[0],'Resume reserve purchase');assert.match(f.dialogs.at(-1)[2],/original purchase reference and campaign 1/);
 f.state.thotSampling.jobs[0].resume_available=false;
 await assert.rejects(f.ui.action('thot-reserve-resume',button('reserved-offer')),/Refresh the unfunded/);
});

test('a resume response cannot substitute a new purchase reference',async t=>{
 const f=fixture(t,{respond:()=>({id:'replacement-offer',resumed:true,transactions:[],buyer_total:atoms(10)})});
 f.state.thotSampling.jobs=[{id:'reserved-offer',listing_id:'listed-trace',campaign_id:'1',receipt:{status:0},resume_available:true}];
 await assert.rejects(f.ui.action('thot-reserve-resume',button('reserved-offer')),/purchase reference changed/);assert.equal(f.dialogs.length,0);
});

test('campaign pagination retains the selected trace and makes newly loaded active campaigns selectable',async t=>{
 const f=fixture(t,{respond:()=>({campaigns:[campaign(6)],next_campaign_cursor:null,market_bound:true,paused:false})});
 f.state.thotSampling.next_campaign_cursor='6';await f.ui.action('thot-reserve-buy',button('listed-trace'));
 await f.ui.action('thot-reserve-campaigns-more',button('6'));
 assert.equal(f.calls.at(-1).path,'/v1/thot/sampling?campaign_cursor=6');assert.equal(f.state.thotSampling.campaigns.length,6);
 assert.match(f.dialogs.at(-1)[2],/<option value="6">/);
});

test('campaign text and ids are escaped, and unbound reserves expose the configured-market review only',t=>{
 const f=fixture(t);f.state.thotSampling.market_bound=false;f.state.thotSampling.campaigns=[campaign('<img src=x>',{policy_name:'<script>name</script>',policy_hash:'<script>hash</script>'})];
 const html=f.ui.samplingHTML();assert.match(html,/thot-gov-bind_market/);assert.match(html,/&lt;script&gt;name/);assert.match(html,/&lt;img src=x&gt;/);
 assert.doesNotMatch(html,/<script>|<img src=x>/);assert.doesNotMatch(html,/id="thot-market-address"/);
 assert.match(html,/<button disabled aria-disabled="true"[^>]*data-action="thot-gov-create_campaign"/);
});

test('shared treasury exposes prospective staking budgets only to governance and prepares exact terms',async t=>{
 const f=fixture(t);f.state.thotSampling.shared_treasury=true;
 const html=f.ui.samplingHTML();assert.match(html,/Fund a staking offer/);assert.match(html,/Close &amp; return unused rewards|Close & return unused rewards/);
 Object.assign(f.inputs,{'#thot-stake-budget':{value:'30000000'},'#thot-stake-cap':{value:'100000000'},'#thot-stake-enrollment':{value:'90'},'#thot-stake-campaign-id':{value:'7'}});
 for(const [i,[days,rate]] of [[30,5],[60,12],[90,30]].entries()){
  f.inputs['#thot-stake-days-'+i]={value:String(days)};f.inputs['#thot-stake-rate-'+i]={value:String(rate)};
 }
 await f.ui.action('thot-gov-create_staking_campaign',button());
 assert.deepEqual(f.calls.at(-1).options.body,{action:'create_staking_campaign',target:'reserve',params:{budget_thot:'30000000',principal_cap_thot:'100000000',enrollment_days:90,terms:[{duration_days:30,reward_bps:500},{duration_days:60,reward_bps:1200},{duration_days:90,reward_bps:3000}]}});
 await f.ui.action('thot-gov-close_staking_campaign',button());
 assert.deepEqual(f.calls.at(-1).options.body,{action:'close_staking_campaign',target:'reserve',params:{campaign_id:'7'}});
 f.state.thotSampling.governance.owner=false;
 assert.doesNotMatch(f.ui.samplingHTML(),/Fund a staking offer/);
 await assert.rejects(f.ui.action('thot-gov-create_staking_campaign',button()),/governance owner/);
});
