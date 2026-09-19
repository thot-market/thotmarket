import {governanceCall} from './thot-governance-call.ts';
import {Contract,getAddress,keccak256} from 'ethers';
import {ensure} from '../storage/src/index.ts';
import type {ThotChain} from './thot.ts';
export const HOLDER_REWARDS_ABI=[
 'function token() view returns(address)','function market() view returns(address)','function staking() view returns(address)','function governor() view returns(address)',
 'function policyCount() view returns(uint256)','function policies(uint256) view returns((uint64 startsAt,uint256 firstThreshold,uint256 secondThreshold,uint16 firstBps,uint16 secondBps))',
 'function policyFor(uint64) view returns(uint256)','function qualifyingBalance(address) view returns(uint256)','function rateFor(uint256,uint256) view returns(uint16)',
 'function paid(bytes32,address) view returns(uint256)','function totalPaid() view returns(uint256)',
 'function quote(bytes32,address) view returns(uint256 amount,uint256 policyId,uint16 rateBps,uint256 balance,bool claimable)',
 'function setLockPolicy(uint256,uint64,uint16)','function claim(bytes32,uint256)','function setPolicy(uint256,uint256,uint16,uint16)','function fund(uint256)',
];
export async function holderRewardsWorkspace(chain:ThotChain,wallet?:string,ids:string[]=[]){
 if(chain.config.feeDiscounts)return directDiscountWorkspace(chain,wallet);
 if(!chain.config.holderRewards)return null;
 const block=await chain.snapshot(),at={blockTag:block.number},c=chain.config,address=getAddress(c.holderRewards!);
 ensure(/^0x[\da-f]{64}$/i.test(c.codeHashes.holderRewards??''),'HOLDER_CODE_PIN');
 ensure(keccak256(await chain.provider.getCode(address,block.number))===c.codeHashes.holderRewards,'HOLDER_CODE_MISMATCH');
 const pool=new Contract(address,HOLDER_REWARDS_ABI,chain.provider);
 const [token,market,staking,governor,count,inventory,totalPaid]=await Promise.all([pool.token(at),pool.market(at),pool.staking(at),pool.governor(at),pool.policyCount(at),chain.token.balanceOf(address,at),pool.totalPaid(at)]);
 ensure(getAddress(token)===c.token&&getAddress(market)===c.market&&getAddress(staking)===getAddress(c.staking!)&&getAddress(governor)===getAddress(c.governor!),'HOLDER_BINDING');
 ensure(count<=128n,'HOLDER_POLICY_BOUND');
 const policyId=Number(await pool.policyFor(block.timestamp,at)),p=policyId?await pool.policies(policyId,at):null;
 const balance=wallet?BigInt(await pool.qualifyingBalance(wallet,at)):0n,rate=p?Number(await pool.rateFor(policyId,balance,at)):0;
 const controller=new Contract(c.governor!,['function isOwner(address) view returns(bool)','function getThreshold() view returns(uint256)'],chain.provider);
 const isOwner=wallet?Boolean(await controller.isOwner(wallet,at)):false;
 const orders=[];ensure(ids.length<=50,'HOLDER_ORDER_BOUND');
 if(wallet)for(let offset=0;offset<ids.length;offset+=4)orders.push(...await Promise.all(ids.slice(offset,offset+4).map(async id=>{ensure(/^0x[\da-f]{64}$/i.test(id),'INVALID_OFFER_ID');const [q,paid]=await Promise.all([pool.quote(id,wallet,at),pool.paid(id,wallet,at)]);return {offer_id:id,amount_atoms:String(q.amount),policy_id:Number(q.policyId),rate_bps:Number(q.rateBps),claimable:Boolean(q.claimable),paid_atoms:String(paid)};})));
 await chain.assertSnapshot(block);
 return {address,is_owner:isOwner,inventory_atoms:String(inventory),total_paid_atoms:String(totalPaid),qualifying_balance_atoms:String(balance),rate_bps:rate,policy:p?{id:policyId,starts_at:Number(p.startsAt),tiers:[{minimum_atoms:String(p.firstThreshold),rebate_bps:Number(p.firstBps)},{minimum_atoms:String(p.secondThreshold),rebate_bps:Number(p.secondBps)}]}:null,orders,block};
}
export async function prepareHolderReward(chain:ThotChain,wallet:string,input:{offer_id?:unknown}){
 ensure(typeof input.offer_id==='string'&&/^0x[\da-f]{64}$/i.test(input.offer_id),'INVALID_OFFER_ID');
 await chain.guard();const state=await holderRewardsWorkspace(chain,wallet,[input.offer_id]),q=state?.orders[0];
 ensure(state&&!chain.config.feeDiscounts&&q?.claimable,'HOLDER_REBATE_NOT_CLAIMABLE',409);
 const pool=new Contract(state.address,HOLDER_REWARDS_ABI,chain.provider);
 return {wallet,transactions:[{chainId:'0x'+chain.config.chainId.toString(16),to:state.address,data:pool.interface.encodeFunctionData('claim',[input.offer_id,q.amount_atoms]),value:'0x0'}],quote:q,notice:'Claim the displayed service-fee cashback into your wallet. The contract checks your current wallet plus unclaimed staking principal, finalized independent purchase, and available rebate funding. Existing sale proceeds and referral payouts are unchanged.'};
}

export async function prepareHolderPolicy(chain:ThotChain,wallet:string,input:Record<string,unknown>){
 await chain.guard();const state=await holderRewardsWorkspace(chain,wallet);ensure(state?.is_owner,'GOVERNANCE_OWNER_REQUIRED',403);
 const {first_threshold_atoms:first,second_threshold_atoms:second,first_bps:low,second_bps:high}=input;
 ensure(typeof first==='string'&&/^[1-9]\d{0,27}$/.test(first)&&typeof second==='string'&&/^[1-9]\d{0,27}$/.test(second)&&BigInt(first)<BigInt(second),'INVALID_HOLDER_THRESHOLDS');
 ensure(typeof low==='number'&&Number.isInteger(low)&&typeof high==='number'&&Number.isInteger(high)&&low>=0&&low<=high&&high<=(chain.config.percentageFees?3500:2500),'INVALID_HOLDER_RATES');
 const controller=new Contract(chain.config.governor!,['function getThreshold() view returns(uint256)','function submitAndExecute(address,bytes)'],chain.provider);
 ensure(await controller.getThreshold()===1n,'HOLDER_ONE_OWNER_CONTROLLER_REQUIRED',409);
 const pool=new Contract(state.address,HOLDER_REWARDS_ABI,chain.provider),data=pool.interface.encodeFunctionData('setPolicy',[first,second,low,high]);
 // eth_call under the governor catches exhausted policy slots, unfunded pools and invalid timing.
 await chain.provider.call({from:chain.config.governor,to:state.address,data});
 const transactions=[governanceCall(chain.config,wallet,state.address,data)];
 if(input.lock_threshold_atoms!==undefined){
  ensure(chain.config.percentageFees&&typeof input.lock_threshold_atoms==='string'&&/^[1-9]\d{0,27}$/.test(input.lock_threshold_atoms),'INVALID_LOCK_THRESHOLD');
  ensure(typeof input.lock_days==='number'&&Number.isInteger(input.lock_days)&&input.lock_days>0&&input.lock_days<=730&&typeof input.lock_bps==='number'&&Number.isInteger(input.lock_bps)&&input.lock_bps>=0&&input.lock_bps<=3500,'INVALID_LOCK_FEE_POLICY');
  const lockData=pool.interface.encodeFunctionData('setLockPolicy',[input.lock_threshold_atoms,input.lock_days*86400,input.lock_bps]);
  await chain.provider.call({from:chain.config.governor,to:state.address,data:lockData});
  transactions.push(governanceCall(chain.config,wallet,state.address,lockData));
 }
 return {wallet,transactions,notice:chain.config.feeDiscounts?'Activate independent buyer and seller fee discounts for future funding. Existing invoices and seller proceeds remain fixed. No reward inventory is spent.':'One governance owner activates this fee-cashback policy for newly funded purchases from the next second. Existing funded orders keep their original rate schedule. Holdings are checked at claim time; this changes neither staking terms nor escrow allocations.'};
}

async function directDiscountWorkspace(chain:ThotChain,wallet?:string){
 await chain.guard();const c=chain.config,block=await chain.snapshot(),at={blockTag:block.number},address=getAddress(c.feeDiscounts!);
 const policy=new Contract(address,['function firstThreshold() view returns(uint256)','function secondThreshold() view returns(uint256)','function firstBps() view returns(uint16)','function secondBps() view returns(uint16)','function version() view returns(uint256)','function qualifyingBalance(address) view returns(uint256)','function rateBps(address) view returns(uint256)','function lockThreshold() view returns(uint256)','function lockDuration() view returns(uint64)','function lockBps() view returns(uint16)'],chain.provider);
 const [first,second,low,high,version,balance]=await Promise.all([policy.firstThreshold(at),policy.secondThreshold(at),policy.firstBps(at),policy.secondBps(at),policy.version(at),wallet?policy.qualifyingBalance(wallet,at):0n]);
 const lock=c.percentageFees?{minimum_atoms:String(await policy.lockThreshold(at)),duration_seconds:Number(await policy.lockDuration(at)),rebate_bps:Number(await policy.lockBps(at))}:null;
 const actualRate=c.percentageFees&&wallet?Number(await policy.rateBps(wallet,at)):null;
 const controller=new Contract(c.governor!,['function isOwner(address) view returns(bool)'],chain.provider),isOwner=wallet?Boolean(await controller.isOwner(wallet,at)):false;
 await chain.assertSnapshot(block);
 return {mode:'upfront-discount' as const,address,is_owner:isOwner,inventory_atoms:'0',total_paid_atoms:'0',qualifying_balance_atoms:String(balance),lock_tier:lock,rate_bps:actualRate??Number(version===0n?0:balance>=second?high:balance>=first?low:0),policy:version?{id:Number(version),starts_at:0,tiers:[{minimum_atoms:String(first),rebate_bps:Number(low)},{minimum_atoms:String(second),rebate_bps:Number(high)}]}:null,orders:[] as {offer_id:string;amount_atoms:string;policy_id:number;rate_bps:number;claimable:boolean;paid_atoms:string}[],block};
}
