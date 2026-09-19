import {governanceCall} from '../../chain/thot-governance-call.ts';
import {THOT_CAMPAIGN_RESERVE_ABI} from '../../chain/thot-campaigns.ts';
import {prepareCampaignGovernance} from './thot-campaign-governance.ts';
import {Contract,Interface,getAddress,AbiCoder,keccak256,toUtf8Bytes,ZeroAddress} from 'ethers';
import {ensure,type Document} from '../../storage/src/index.ts';
import type {ThotChain} from '../../chain/thot.ts';
export const THOT_GOVERNOR_ABI=[
 'function getOwners() view returns(address[])','function getThreshold() view returns(uint256)',
 'function operationCount() view returns(uint256)','function operationIdAt(uint256) view returns(bytes32)',
 'function operation(bytes32) view returns(address target,bytes data,uint8 confirmations,bool executed)',
 'function approved(bytes32,address) view returns(bool)',
 'function submit(address,bytes) returns(bytes32)','function submitAndExecute(address,bytes) returns(bytes)','function confirm(bytes32)','function revoke(bytes32)','function execute(bytes32)',
];
const common=['function pause()','function queueUnpause()','function unpause()','function queueOperator(address)','function executeOperator(address)','function cancelGovernance(bytes32)','function queued(bytes32) view returns(uint64)','function GOVERNANCE_DELAY() view returns(uint256)','function paused() view returns(bool)','function operator() view returns(address)'];
const legacyVault=new Interface([...common,'function queueCampaign(address,uint64)','function executeCampaign(address,uint64)','function queueBuyer(address,bool)','function executeBuyer(address,bool)','function authorizedBuyers(address) view returns(bool)','function queueSuccessor(address,uint256,bytes32)','function executeSuccessor(address,uint256,bytes32)','function startAt() view returns(uint64)','function CAMPAIGN_DURATION() view returns(uint256)','function token() view returns(address)']);
const market=new Interface([...common,'function setServiceFeeBps(uint16)','function queueTariff(uint256,uint256,bytes32)','function executeTariff(uint256,uint256,bytes32)','function tariff() view returns(uint256 directCost,uint256 allocatedOverhead,bytes32 policyHash)']);
const executionActions=['executeCampaign','executeBuyer','executeOperator','executeSuccessor','executeTariff','unpause'];
const wire=(value:any):any=>typeof value==='bigint'?value.toString():Array.isArray(value)?Array.from(value,wire):value;
const operationHash=(action:string,args:unknown[])=>{
 if(['queueCampaign','executeCampaign'].includes(action))return keccak256(AbiCoder.defaultAbiCoder().encode(['string','address','uint64'],['campaign',args[0],args[1]]));
 if(['queueBuyer','executeBuyer'].includes(action))return keccak256(AbiCoder.defaultAbiCoder().encode(['string','address','bool'],['buyer',args[0],args[1]]));
 if(['queueOperator','executeOperator'].includes(action))return keccak256(AbiCoder.defaultAbiCoder().encode(['string','address'],['operator',args[0]]));
 if(['queueSuccessor','executeSuccessor'].includes(action))return keccak256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','bytes32'],['successor',...args]));
 if(['queueTariff','executeTariff'].includes(action))return keccak256(AbiCoder.defaultAbiCoder().encode(['string','uint256','uint256','bytes32'],['quoted-cost-tariff',...args]));
 if(['queueUnpause','unpause'].includes(action))return keccak256(toUtf8Bytes('unpause'));
 if(action==='cancelGovernance')return String(args[0]);
 return null;
};
const checkedAddress=(value:unknown,code:string)=>{ensure(typeof value==='string'&&/^0x[\da-f]{40}$/i.test(value),code);let result:string;try{result=getAddress(value);}catch{throw Error(code);}ensure(result!==ZeroAddress,code);return result;};
const checkedHash=(value:unknown)=>{ensure(typeof value==='string'&&/^0x[\da-f]{64}$/i.test(value)&&BigInt(value)!==0n,'INVALID_POLICY_HASH');return value;};
const checkedAmount=(value:unknown,allowZero=false)=>{ensure(typeof value==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(value),'INVALID_GOVERNANCE_AMOUNT');const n=BigInt(value);ensure(n<(1n<<256n)&&(allowZero||n>0n),'INVALID_GOVERNANCE_AMOUNT');return n;};
export class ThotGovernance {
 chain:ThotChain;constructor(chain:ThotChain){this.chain=chain;}
 private async contract(){ensure(this.chain.config.manualReserve,'RESERVE_GOVERNANCE_UNAVAILABLE');const address=await this.chain.reserve.governor();return new Contract(address,THOT_GOVERNOR_ABI,this.chain.provider);}
 async workspace(wallet:string){
  const concurrent=this.chain.config.reserveCampaigns===true,vault=concurrent?new Interface(THOT_CAMPAIGN_RESERVE_ABI):legacyVault;
  const block=await this.chain.snapshot(),governor=await this.contract(),at={blockTag:block.number},reserve=new Contract(this.chain.config.reserve,vault,this.chain.provider),exchange=new Contract(this.chain.config.market,market,this.chain.provider);
  const [owners,threshold,count,delay,paused,operator,marketDelay,marketPaused,marketOperator,start,duration]=await Promise.all([governor.getOwners(at),governor.getThreshold(at),this.chain.config.governanceKind==='safe'?Promise.resolve(0n):governor.operationCount(at),reserve.GOVERNANCE_DELAY(at),reserve.paused(at),reserve.operator(at),exchange.GOVERNANCE_DELAY(at),exchange.paused(at),exchange.operator(at),concurrent?Promise.resolve(0n):reserve.startAt(at),concurrent?Promise.resolve(0n):reserve.CAMPAIGN_DURATION(at)]);
  let tariff:Document|null=null;try{const t=await exchange.tariff(at);tariff={direct_cost_atoms:t[0].toString(),allocated_overhead_atoms:t[1].toString(),policy_hash:t[2]};}catch{/* Older pinned deployments have no cost-tariff interface. */}
  const operations=[],knownBuyers=new Set<string>(Array.from(owners,(v:string)=>getAddress(v)));
  for(let i=Math.max(0,Number(count)-20);i<Number(count);i++){
   const id=await governor.operationIdAt(i,at),o=await governor.operation(id,at),approved=await governor.approved(id,wallet,at);
   const target=getAddress(o.target),targetKind=target===this.chain.config.reserve?'reserve':target===this.chain.config.market?'market':null,iface=targetKind==='reserve'?vault:market,contract=targetKind==='reserve'?reserve:exchange;
   let action='Other governance operation',args:unknown[]=[],campaign=null,timelock=null;
   if(targetKind){
    let parsed;try{parsed=iface.parseTransaction({data:o.data});}catch{parsed=null;}
    if(parsed){action=parsed.name;args=Array.from(parsed.args,wire);
     const hash=operationHash(action,args);
     if(hash&&!(concurrent&&targetKind==='reserve')){const executableAt=Number(await contract.queued(hash,at));timelock={operation_hash:hash,executable_at:executableAt,ready:executableAt>0&&block.timestamp>=executableAt};}
     if(['queueCampaign','executeCampaign'].includes(action))campaign={market:args[0],start_at:Number(args[1]),executable_at:timelock?.executable_at??0};
     if(['queueBuyer','executeBuyer','setBuyer'].includes(action))knownBuyers.add(getAddress(String(args[0])));
    }
   }
   const sunsetReady=action!=='executeSuccessor'||Number(start)>0&&block.timestamp>=Number(start)+Number(duration);
   operations.push({id,target:o.target,target_kind:targetKind,data:o.data,action,args,campaign,timelock,confirmations:Number(o.confirmations),executed:!!o.executed,approved_by_you:!!approved,executable:!o.executed&&Number(o.confirmations)>=Number(threshold)&&(concurrent&&targetKind==='reserve'||!executionActions.includes(action)||timelock?.ready===true)&&sunsetReady});
  }
  const buyers=await Promise.all(Array.from(knownBuyers,async address=>({address,authorized:!!await reserve.authorizedBuyers(address,at)})));
  const marketBound=concurrent?getAddress(await reserve.market(at))===this.chain.config.market:Number(start)>0;
  await this.chain.assertSnapshot(block);
  return {percentage_fees:!!this.chain.config.percentageFees,governance_kind:this.chain.config.governanceKind??'controller',shared_treasury:!!this.chain.config.sharedTreasury,address:await governor.getAddress(),reserve:this.chain.config.reserve,market:this.chain.config.market,owners:Array.from(owners),threshold:Number(threshold),owner:owners.some((v:string)=>getAddress(v)===getAddress(wallet)),operations,operation_count:Number(count),buyers,buyer_list_scope:'Governor owners and wallets in the latest 20 proposals; not an exhaustive address registry.',paused:!!paused,operator,delay_seconds:Number(delay),market_delay_seconds:Number(marketDelay),market_paused:!!marketPaused,market_operator:marketOperator,tariff,market_bound:marketBound,campaign_start_at:Number(start),campaign_sunset_at:Number(start)>0?Number(start)+Number(duration):null,block};
 }
 async prepare(wallet:string,input:Document){
  const vault=this.chain.config.reserveCampaigns?new Interface(THOT_CAMPAIGN_RESERVE_ABI):legacyVault;
  const governor=await this.contract(),view=await this.workspace(wallet);ensure(view.owner,'GOVERNANCE_OWNER_REQUIRED',403);
  if(this.chain.config.reserveCampaigns){const result=await prepareCampaignGovernance(this.chain,governor,view,wallet,input);if(result)return result;}
  if(input.action==='start_campaign'){
   ensure(view.threshold===1&&view.delay_seconds===0,'FAST_CAMPAIGN_UNAVAILABLE');
   ensure(view.campaign_start_at===0,'CAMPAIGN_ALREADY_STARTED',409);
   const changes=['queueCampaign','executeCampaign'].map(action=>({target:view.reserve,action,args:[view.market,0],data:vault.encodeFunctionData(action,[view.market,0])}));
   await this.chain.assertSnapshot(view.block);
   return {wallet,review:{required_approvals:1,delay_seconds:0,start:'Actual activation block timestamp',changes},transactions:changes.map(change=>(governanceCall(this.chain.config,wallet,change.target,change.data))),notice:'This controller permits one owner to record and execute the reserve queue, then activate the campaign in a second transaction. No second owner or governance wait is required. The campaign starts at its activation block; shared budget and demand caps still apply.'};
  }
  if(input.action==='queue_operator'&&input.target==='both'){
   ensure(view.threshold===1&&view.delay_seconds===0&&view.market_delay_seconds===0,'FAST_OPERATOR_REPLACEMENT_UNAVAILABLE');
   const operator=checkedAddress(input.operator,'INVALID_OPERATOR');ensure(!view.owners.some(owner=>getAddress(String(owner))===operator)&&![view.address,view.reserve,view.market].includes(operator),'OPERATOR_MUST_BE_SEPARATE');
   const changes=[view.reserve,view.market].flatMap(target=>(this.chain.config.reserveCampaigns&&target===view.reserve?['setOperator']:['queueOperator','executeOperator']).map(action=>({target,action,args:[operator],data:(target===view.reserve?vault:market).encodeFunctionData(action,[operator])})));
   await this.chain.assertSnapshot(view.block);
   return {wallet,review:{required_approvals:1,delay_seconds:0,new_operator:operator,changes,deployment_requirement:'The hosted worker must be updated to the new signer and matching chain configuration. Settlement remains stopped until both contracts and worker agree.'},transactions:changes.map(change=>(governanceCall(this.chain.config,wallet,change.target,change.data))),notice:'Replace both dedicated testnet operators in the reviewed recorded wallet transactions. Stage the new encrypted worker signer and configuration first. If a transaction is interrupted, this review retains the same transaction hashes and remaining steps.'};
  }
  let data:string,review:Document;
  if(this.chain.config.governanceKind==='safe')ensure(view.threshold===1&&!['confirm','revoke','execute'].includes(input.action),'SAFE_MULTI_OWNER_USE_NATIVE_APPROVALS',409);
  if(['confirm','revoke','execute'].includes(input.action)){
   ensure(typeof input.id==='string'&&/^0x[\da-f]{64}$/i.test(input.id),'INVALID_OPERATION');const op=view.operations.find(o=>o.id===input.id);ensure(op,'OPERATION_NOT_IN_CURRENT_PAGE');
   ensure(!op.executed,'GOVERNANCE_OPERATION_EXECUTED',409);
   if(input.action==='confirm')ensure(!op.approved_by_you,'GOVERNANCE_ALREADY_APPROVED',409);
   if(input.action==='revoke')ensure(op.approved_by_you,'GOVERNANCE_APPROVAL_REQUIRED',409);
   if(input.action==='execute'){
    ensure(op.confirmations>=view.threshold,'GOVERNANCE_APPROVALS_REQUIRED');
    if(!(this.chain.config.reserveCampaigns&&op.target_kind==='reserve')&&executionActions.includes(op.action))ensure(op.timelock?.ready,'GOVERNANCE_TIMELOCK_PENDING',409);
    if(op.action==='executeSuccessor')ensure(view.campaign_sunset_at!==null&&view.block.timestamp>=view.campaign_sunset_at,'CAMPAIGN_SUNSET_PENDING',409);
   }
   review={controller:await governor.getAddress(),owner_action:input.action,operation_id:op.id,target:op.target,contract_action:op.action,arguments:op.args,calldata:op.data,approvals:op.confirmations,required_approvals:view.threshold,timelock:op.timelock};
   data=governor.interface.encodeFunctionData(input.action,[input.id]);
  }else{
   ensure(input.target===undefined||input.target==='reserve'||input.target==='market','INVALID_GOVERNANCE_TARGET');
   const targetKind=input.target??'reserve',target=targetKind==='reserve'?view.reserve:view.market,iface=targetKind==='reserve'?vault:market,contract=new Contract(target,iface,this.chain.provider),delay=targetKind==='reserve'?view.delay_seconds:view.market_delay_seconds;
   let action:string,args:unknown[];
   if(input.action==='queue_campaign'||input.action==='execute_campaign'){
    ensure(targetKind==='reserve','INVALID_GOVERNANCE_TARGET');const start=Number(input.start_at);ensure(Number.isSafeInteger(start)&&start>0,'INVALID_CAMPAIGN_START');
    if(input.action==='queue_campaign')ensure(start>=view.block.timestamp+delay+(delay>0?300:0),'CAMPAIGN_START_TOO_SOON');
    action=input.action==='queue_campaign'?'queueCampaign':'executeCampaign';args=[this.chain.config.market,start];
   }else if(input.action==='queue_buyer'||input.action==='execute_buyer'){
    ensure(targetKind==='reserve','INVALID_GOVERNANCE_TARGET');const buyer=checkedAddress(input.buyer,'INVALID_RESERVE_BUYER');
    ensure(buyer!==this.chain.config.reserve,'INVALID_RESERVE_BUYER');ensure(typeof input.allowed==='boolean','BUYER_PERMISSION_REQUIRED');
    action=input.action==='queue_buyer'?'queueBuyer':'executeBuyer';args=[buyer,input.allowed];
   }else if(input.action==='queue_operator'||input.action==='execute_operator'){
    const operator=checkedAddress(input.operator,'INVALID_OPERATOR');ensure(!view.owners.some(owner=>getAddress(String(owner))===operator)&&![view.address,view.reserve,view.market].includes(operator),'OPERATOR_MUST_BE_SEPARATE');
    action=input.action==='queue_operator'?'queueOperator':'executeOperator';args=[operator];
   }else if(input.action==='queue_successor'||input.action==='execute_successor'){
    ensure(targetKind==='reserve','INVALID_GOVERNANCE_TARGET');const successor=checkedAddress(input.successor,'INVALID_SUCCESSOR');ensure(successor!==view.reserve,'INVALID_SUCCESSOR');
    ensure(view.campaign_start_at>0,'CAMPAIGN_NOT_STARTED');ensure(await this.chain.provider.getCode(successor,view.block.number)!=='0x','SUCCESSOR_NOT_DEPLOYED');
    ensure(getAddress(await new Contract(successor,vault,this.chain.provider).token({blockTag:view.block.number}))===this.chain.config.token,'SUCCESSOR_TOKEN_MISMATCH');
    action=input.action==='queue_successor'?'queueSuccessor':'executeSuccessor';args=[successor,checkedAmount(input.amount_atoms),checkedHash(input.policy_hash)];
   }else if(input.action==='set_service_fee'){
    ensure(this.chain.config.percentageFees&&targetKind==='market','PERCENTAGE_FEE_REQUIRED');
    ensure(Number.isInteger(input.fee_bps)&&input.fee_bps>0&&input.fee_bps<=1000,'INVALID_SERVICE_FEE');
    action='setServiceFeeBps';args=[input.fee_bps];
   }else if(input.action==='queue_tariff'||input.action==='execute_tariff'){
    ensure(!this.chain.config.percentageFees,'PERCENTAGE_FEE_ONLY');
    ensure(targetKind==='market'&&view.tariff!==null,'COST_TARIFF_UNAVAILABLE');action=input.action==='queue_tariff'?'queueTariff':'executeTariff';args=[checkedAmount(input.direct_cost_atoms,true),checkedAmount(input.overhead_atoms,true),checkedHash(input.policy_hash)];
   }else if(input.action==='cancel_queue'){
    action='cancelGovernance';args=[checkedHash(input.operation_hash)];
   }else{ensure(['pause','queueUnpause','unpause'].includes(input.action),'UNSUPPORTED_GOVERNANCE_ACTION');action=input.action;args=[];}
   const hash=operationHash(action,args),queuedAt=hash?Number(await contract.queued(hash,{blockTag:view.block.number})):0;
   if(executionActions.includes(action)||action==='cancelGovernance')ensure(queuedAt>0,'GOVERNANCE_ACTION_NOT_QUEUED',409);
   const targetData=iface.encodeFunctionData(action,args);
   review={controller:await governor.getAddress(),owner_action:view.threshold===1?'submitAndExecute':'submit',target,target_kind:targetKind,contract_action:action,arguments:wire(args),calldata:targetData,required_approvals:view.threshold,delay_seconds:['pause','cancelGovernance'].includes(action)?0:delay,queued_until:queuedAt||null,...(['queueBuyer','executeBuyer'].includes(action)?{buyer:args[0],authorized_now:!!await contract.authorizedBuyers(args[0],{blockTag:view.block.number}),authorize_after_execution:args[1]}:{}),...(['queueOperator','executeOperator'].includes(action)?{deployment_requirement:'Stage the new dedicated signer and matching chain configuration in the encrypted CVM environment. Operator mismatch intentionally pauses settlement until configuration and both contracts agree.'}:{}),...(['queueSuccessor','executeSuccessor'].includes(action)?{campaign_sunset_at:view.campaign_sunset_at,inventory_migration_only:true}:{} )};
   if(view.threshold===1&&executionActions.includes(action))ensure(queuedAt<=view.block.timestamp,'GOVERNANCE_TIMELOCK_PENDING',409);
   if(view.threshold===1&&action==='executeSuccessor')ensure(view.campaign_sunset_at!==null&&view.block.timestamp>=view.campaign_sunset_at,'CAMPAIGN_SUNSET_PENDING',409);
   await this.chain.assertSnapshot(view.block);data=view.threshold===1?governanceCall(this.chain.config,wallet,target,targetData).data:governor.interface.encodeFunctionData('submit',[target,targetData]);
  }
  return {wallet,review,transactions:[{to:await governor.getAddress(),data,value:'0x0',chainId:'0x'+this.chain.config.chainId.toString(16)}],notice:`This prepares one unsigned governor transaction. ${view.threshold===1?'Submission records your approval and executes the change immediately.':'Submission counts as your first approval.'} ${view.threshold} of ${view.owners.length} approvals are required. Execute the queue, then separately propose and execute the matching change after its displayed delay. Reserve delay: ${view.delay_seconds} seconds; market delay: ${view.market_delay_seconds} seconds. Reserve inventory remains in its contract. Operator replacement requires matching worker configuration; successor transfers remain blocked until campaign sunset.`};
 }
}
