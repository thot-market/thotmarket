import {Contract,getAddress,keccak256} from 'ethers';
import {ensure} from '../storage/src/index.ts';
import type {ThotChain} from './thot.ts';

export const STAKING_ABI=[
 'function token() view returns(address)','function governor() view returns(address)',
 'function campaignCount() view returns(uint256)',
 'function campaigns(uint256) view returns(uint64 startsAt,uint64 enrollmentEndsAt,uint256 principalCap,uint256 totalDeposited,uint256 rewardBudget,uint256 unallocatedReward,uint256 outstandingReward,bool admissionsPaused,bool closed)',
 'function terms(uint256) view returns((uint64 duration,uint16 rewardBps)[])',
 'function activePositionIds(address) view returns(uint256[])',
 'function positions(uint256) view returns(address owner,uint256 campaignId,uint256 principal,uint256 reward,uint64 depositedAt,uint64 unlockAt,bool claimed)',
 'function protectedBalance() view returns(uint256)','function freeBalance() view returns(uint256)',
 'function stake(uint256,uint256,uint256) returns(uint256)','function claim(uint256)',
];

export async function stakingWorkspace(chain:ThotChain,owner?:string){
 if(!chain.config.staking)return null;
 const config=chain.config,block=await chain.snapshot(),at={blockTag:block.number};
 ensure(/^0x[\da-f]{64}$/i.test(config.codeHashes.staking??''),'INVALID_STAKING_CODE_PIN');
 const pool=new Contract(getAddress(config.staking!),STAKING_ABI,chain.provider);
 const code=await chain.provider.getCode(config.staking!,block.number);
 ensure(code!=='0x'&&keccak256(code).toLowerCase()===config.codeHashes.staking!.toLowerCase(),'STAKING_CODE_PIN_MISMATCH',503);
 const [token,governor,count,ids,protectedBalance,balance]=await Promise.all([
  pool.token(at),pool.governor(at),pool.campaignCount(at),owner?pool.activePositionIds(owner,at):[],pool.protectedBalance(at),chain.token.balanceOf(config.staking,at)]);
 ensure(getAddress(token)===config.token&&getAddress(governor)===getAddress(config.sharedTreasury?config.reserve:config.governor!),'STAKING_BINDING_MISMATCH',503);
 if(config.sharedTreasury){
  const treasury=new Contract(config.reserve,['function stakingPool() view returns(address)'],chain.provider);
  ensure(getAddress(await treasury.stakingPool(at))===getAddress(config.staking!),'TREASURY_STAKING_BINDING_MISMATCH',503);
 }
 ensure(balance>=protectedBalance,'STAKING_INSOLVENT',503);
 ensure(ids.length<=64,'STAKING_POSITION_LIMIT',503);
 const campaigns=[];
 // Bounded recent campaigns; older positions remain individually claimable.
 for(let id=Math.max(1,Number(count)-19);id<=Number(count);id++){
  const c=await pool.campaigns(id,at),terms=await pool.terms(id,at);
  campaigns.push({id:String(id),starts_at:Number(c.startsAt),enrollment_ends_at:Number(c.enrollmentEndsAt),principal_cap:String(c.principalCap),total_deposited:String(c.totalDeposited),reward_budget:String(c.rewardBudget),unallocated_reward:String(c.unallocatedReward),outstanding_reward:String(c.outstandingReward),paused:c.admissionsPaused,closed:c.closed,terms:terms.map((t:any,index:number)=>({index,duration:Number(t.duration),reward_bps:Number(t.rewardBps)}))});
 }
 const positions=[];
 for(const id of ids){const p=await pool.positions(id,at);ensure(getAddress(p.owner)===getAddress(owner!),'STAKING_OWNER_MISMATCH');positions.push({id:String(id),campaign_id:String(p.campaignId),principal:String(p.principal),reward:String(p.reward),deposited_at:Number(p.depositedAt),unlock_at:Number(p.unlockAt),claimed:p.claimed});}
 await chain.assertSnapshot(block);
 return {address:config.staking!,block,campaigns,positions,protected_balance:String(protectedBalance),pool_balance:String(balance)};
}

export async function prepareStaking(chain:ThotChain,wallet:string,input:Record<string,any>){
 const state=await stakingWorkspace(chain,wallet);ensure(state,'STAKING_NOT_CONFIGURED',503);
 const pool=new Contract(state.address,STAKING_ABI,chain.provider);
 const transaction=(method:string,args:unknown[])=>({to:state.address,data:pool.interface.encodeFunctionData(method,args),value:'0x0',chainId:'0x'+chain.config.chainId.toString(16)});
 if(input.action==='staking-claim'){
  ensure(typeof input.id==='string'&&/^[1-9]\d{0,15}$/.test(input.id),'INVALID_STAKING_POSITION');
  const p=state.positions.find(p=>p.id===input.id);ensure(p&&!p.claimed,'STAKING_POSITION_NOT_OWNED',403);
  ensure(state.block.timestamp>=p.unlock_at,'STAKING_NOT_MATURE',409);
  return {wallet,transactions:[transaction('claim',[p.id])],notice:'Claim your original principal and reserved reward. No renewal or additional lock is created.'};
 }
 ensure(input.action==='stake'&&typeof input.campaign_id==='string'&&Number.isSafeInteger(input.term_index),'INVALID_STAKING_REQUEST');
 const campaign=state.campaigns.find(c=>c.id===input.campaign_id),term=campaign?.terms[input.term_index];
 ensure(campaign&&term,'STAKING_OFFER_NOT_FOUND');
 ensure(!campaign.closed&&!campaign.paused&&state.block.timestamp>=campaign.starts_at&&state.block.timestamp<campaign.enrollment_ends_at,'STAKING_ENROLLMENT_CLOSED',409);
 ensure(typeof input.amount_atoms==='string'&&/^[1-9]\d{0,27}$/.test(input.amount_atoms),'INVALID_STAKING_AMOUNT');
 const principal=BigInt(input.amount_atoms),reward=principal*BigInt(term.reward_bps)/10000n;
 ensure(reward>0n&&BigInt(campaign.total_deposited)+principal<=BigInt(campaign.principal_cap)&&reward<=BigInt(campaign.unallocated_reward),'STAKING_CAPACITY_EXCEEDED',409);
 ensure(state.positions.length<64,'STAKING_POSITION_LIMIT',409);
 const account=await chain.account(wallet);ensure(BigInt(account.balance)>=principal,'INSUFFICIENT_THOT',409);
 return {wallet,transactions:[chain.transaction('token','approve',[state.address,principal]),transaction('stake',[campaign.id,input.term_index,principal])],quote:{principal_atoms:String(principal),reward_atoms:String(reward),payout_atoms:String(principal+reward),duration_seconds:term.duration,reward_bps:term.reward_bps,campaign_id:campaign.id,pool:state.address},notice:`Principal and the prefunded ${term.reward_bps/100}% THOT reward unlock together ${term.duration/86400} days after the deposit confirms. No early withdrawal, trace-sale requirement or automatic renewal. Approval is limited to this deposit. These are testnet tokens.`};
}
