import {governanceCall} from '../../chain/thot-governance-call.ts';
import {Contract,Interface,getAddress,keccak256,parseUnits,toUtf8Bytes,ZeroAddress} from 'ethers';
import {ensure,type Document} from '../../storage/src/index.ts';
import {campaignId,THOT_CAMPAIGN_RESERVE_ABI} from '../../chain/thot-campaigns.ts';
import {STAKING_ABI} from '../../chain/thot-staking.ts';
import type {ThotChain} from '../../chain/thot.ts';

const iface=new Interface(THOT_CAMPAIGN_RESERVE_ABI);
const amount=(value:unknown,zero=false)=>{
 ensure(typeof value==='string'&&/^(0|[1-9]\d{0,9})(\.\d{1,18})?$/.test(value),'INVALID_CAMPAIGN_AMOUNT');
 const n=parseUnits(value,18);ensure(n>=0n&&(zero||n>0n)&&n<=parseUnits('500000000',18),'INVALID_CAMPAIGN_AMOUNT');return n;
};
const address=(value:unknown)=>{
 ensure(typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value),'INVALID_GOVERNANCE_ADDRESS');
 const a=getAddress(value);ensure(a!==ZeroAddress,'INVALID_GOVERNANCE_ADDRESS');return a;
};

/** Returns null for ordinary market/governor actions, handled by the existing adapter. */
export async function prepareCampaignGovernance(chain:ThotChain,governor:Contract,view:Document,wallet:string,input:Document){
 if(input.target&&input.target!=='reserve')return null;
 const p=input.params??input,at={blockTag:view.block.number};
 let action:string,args:unknown[],detail:Document={};
 if(['create_staking_campaign','close_staking_campaign','pause_staking_campaign','resume_staking_campaign','collect_staking_budget'].includes(input.action)){
  ensure(chain.config.sharedTreasury&&chain.config.staking,'SHARED_TREASURY_REQUIRED');
  const pool=new Contract(chain.config.staking,STAKING_ABI,chain.provider);
  ensure(getAddress(await chain.reserve.stakingPool(at))===getAddress(chain.config.staking)&&getAddress(await pool.governor(at))===view.reserve,'TREASURY_STAKING_BINDING_MISMATCH');
  if(input.action==='create_staking_campaign'){
   const budget=amount(p.budget_thot),cap=amount(p.principal_cap_thot),days=Number(p.enrollment_days);
   ensure(Number.isSafeInteger(days)&&days>=1&&days<=365,'INVALID_STAKING_ENROLLMENT');
   ensure(Array.isArray(p.terms)&&p.terms.length>=1&&p.terms.length<=8,'INVALID_STAKING_TERMS');
   let previous=0;
   const terms=p.terms.map((t:Document)=>{
    ensure(Number.isSafeInteger(t.duration_days)&&t.duration_days>previous&&t.duration_days<=730,'INVALID_STAKING_DURATION');
    ensure(Number.isSafeInteger(t.reward_bps)&&t.reward_bps>0&&t.reward_bps<=10000,'INVALID_STAKING_REWARD');
    previous=t.duration_days;return [t.duration_days*86400,t.reward_bps];
   });
   const maximum=Math.max(...terms.map((t:number[])=>t[1]!));
   ensure(budget>=cap*BigInt(maximum)/10000n,'STAKING_BUDGET_BELOW_CAPACITY');
   ensure(budget<=await chain.reserve.unallocatedBalance(at),'CAMPAIGN_BUDGET_EXCEEDS_UNALLOCATED',409);
   // Explicit future enrollment start leaves time to inspect and sign. Expired
   // preparations revert rather than silently changing the accepted schedule.
   const start=Number(p.start_at??view.block.timestamp+900);
   ensure(Number.isSafeInteger(start)&&start>=view.block.timestamp&&start<2**48,'INVALID_STAKING_START');
   action='createStakingCampaign';args=[start,start+days*86400,cap,budget,terms];
   detail={budget_atoms:String(budget),principal_cap_atoms:String(cap),terms:p.terms,existing_positions_unchanged:true};
  }else if(input.action==='collect_staking_budget'){
   action='collectFreeStakingBudget';args=[];
  }else{
   const id=campaignId(p.campaign_id);ensure(id<=await pool.campaignCount(at),'STAKING_CAMPAIGN_NOT_FOUND',404);
   const c=await pool.campaigns(id,at);ensure(!c.closed,'STAKING_CAMPAIGN_CLOSED',409);
   action=input.action==='close_staking_campaign'?'closeStakingCampaign':'setStakingAdmissionsPaused';
   args=action==='closeStakingCampaign'?[id]:[id,input.action==='pause_staking_campaign'];
   detail={campaign_id:String(id),unallocated_reward_atoms:String(c.unallocatedReward),existing_positions_unchanged:true};
  }
 }else if(input.action==='bind_market'){
  ensure(!view.market_bound,'MARKET_ALREADY_BOUND',409);action='bindMarket';args=[chain.config.market];
 }else if(input.action==='create_campaign'){
  ensure(view.market_bound,'CAMPAIGN_MARKET_NOT_BOUND',409);
  ensure(typeof p.purpose==='string'&&p.purpose.trim().length>=10&&p.purpose.length<=240,'CAMPAIGN_PURPOSE_REQUIRED');
  const budget=amount(p.budget_thot),days=Number(p.duration_days),start=Number(p.start_at??0);
  ensure(Number.isSafeInteger(days)&&days>=1&&days<=365,'INVALID_CAMPAIGN_DURATION');
  ensure(Number.isSafeInteger(start)&&start>=0&&start<(2**48)&&(!start||start>=view.block.timestamp),'INVALID_CAMPAIGN_START');
  const duration=days*86400,upfront=p.upfront_thot===undefined?budget/BigInt(days):amount(p.upfront_thot,true);
  ensure(upfront<=budget,'CAMPAIGN_UPFRONT_EXCEEDS_BUDGET');
  ensure(budget<=await chain.reserve.unallocatedBalance(at),'CAMPAIGN_BUDGET_EXCEEDS_UNALLOCATED',409);
  const purpose=p.purpose.trim(),policy={policy:'thot.acquisition-campaign/2',purpose,budget_atoms:budget.toString(),duration_seconds:duration,start_at:start,upfront_atoms:upfront.toString(),release:'upfront-plus-linear',independent_demand_gate:false};
  const policyHash=keccak256(toUtf8Bytes(JSON.stringify(policy)));
  action='createCampaign';args=[policyHash,budget,start,duration,upfront];detail={policy,policy_hash:policyHash};
 }else if(['pause_campaign','resume_campaign','cancel_campaign','expire_campaign'].includes(input.action)){
  const id=campaignId(p.campaign_id);ensure(id<=await chain.reserve.campaignCount(at),'CAMPAIGN_NOT_FOUND',404);
  const c=await chain.reserve.campaign(id,at);ensure(!c.closed,'CAMPAIGN_CLOSED',409);
  if(input.action==='expire_campaign')ensure(view.block.timestamp>=Number(c.endAt),'CAMPAIGN_NOT_ENDED',409);
  action=input.action==='cancel_campaign'?'cancelCampaign':input.action==='expire_campaign'?'expireCampaign':'setCampaignPaused';
  args=action==='setCampaignPaused'?[id,input.action==='pause_campaign']:[id];
  detail={campaign_id:id.toString(),unspent_budget_atoms:(c.budget-c.committed).toString(),clock_continues:true};
 }else if(input.action==='queue_buyer'){
  const buyer=address(p.buyer);ensure(buyer!==view.reserve&&typeof p.allowed==='boolean','INVALID_BUYER_PERMISSION');
  action='setBuyer';args=[buyer,p.allowed];
 }else if(input.action==='queue_operator'){
  const operator=address(p.operator);
  ensure(!view.owners.some((o:string)=>getAddress(o)===operator)&&![view.address,view.reserve,view.market].includes(operator),'OPERATOR_MUST_BE_SEPARATE');
  action='setOperator';args=[operator];detail={deployment_requirement:'Update the dedicated worker signer and both operator bindings together.'};
 }else if(['pause','queueUnpause','unpause'].includes(input.action)){
  action=input.action==='pause'?'pause':'unpause';args=[];
 }else{
  ensure(!['start_campaign','queue_campaign','execute_campaign','execute_buyer','execute_operator','queue_successor','execute_successor','cancel_queue'].includes(input.action),'LEGACY_RESERVE_ACTION_UNAVAILABLE');
  return null;
 }
 ensure(view.threshold===1&&view.delay_seconds===0,'IMMEDIATE_CAMPAIGN_GOVERNANCE_REQUIRED');
 const data=iface.encodeFunctionData(action,args);
 await chain.assertSnapshot(view.block);
 return {wallet,review:{controller:view.address,target:view.reserve,target_kind:'reserve',contract_action:action,
  arguments:args.map(x=>typeof x==='bigint'?x.toString():x),calldata:data,required_approvals:1,delay_seconds:0,...detail},
  transactions:[governanceCall(chain.config,wallet,view.reserve,data)],
  notice:chain.config.sharedTreasury?'One owner authorizes this treasury change. Only uncommitted funds can be reallocated. Closing staking enrollment returns unused rewards; existing principal, rewards and maturities are unchanged.':'One owner authorizes this change. Campaigns may overlap in time. Each budget reserves separate tokens, which stay in the vault until trace purchases. Unspent released allowance carries forward until campaign end. Cancelling releases unspent authority; it does not undo funded purchases.'};
}
