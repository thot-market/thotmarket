import {getAddress, ZeroAddress} from 'ethers';
import {ensure, type Document} from '../storage/src/index.ts';
import type {ThotChain} from './thot.ts';

const offer='(bytes32 id,bytes32 nonce,address seller,uint256 gross,bytes32 licenseHash,bytes32 evidenceHash)';
const authorization='(address seller,address buyer,bytes32 evidenceHash,bytes32 licenseHash,uint256 gross,uint16 minSellerBps,uint64 validUntil,bytes32 nonce,uint32 maxUses)';
export const THOT_CAMPAIGN_RESERVE_ABI=[
 'function stakingPool() view returns(address)',
 'function createStakingCampaign(uint64,uint64,uint256,uint256,(uint64 duration,uint16 rewardBps)[]) returns(uint256)',
 'function setStakingAdmissionsPaused(uint256,bool)', 'function closeStakingCampaign(uint256)', 'function collectFreeStakingBudget()',
 'function reserveVersion() pure returns(uint256)', 'function token() view returns(address)',
 'function governor() view returns(address)', 'function operator() view returns(address)',
 'function market() view returns(address)', 'function paused() view returns(bool)',
 'function authorizedBuyers(address) view returns(bool)', 'function GOVERNANCE_DELAY() view returns(uint256)',
 'function campaignCount() view returns(uint256)', 'function totalAllocated() view returns(uint256)',
 'function totalGrossCommitted() view returns(uint256)', 'function unallocatedBalance() view returns(uint256)',
 'function campaign(uint256) view returns(bytes32 policyHash,uint256 budget,uint256 committed,uint64 startAt,uint64 endAt,uint256 upfront,bool paused,bool closed)',
 'function remainingAllowance(uint256) view returns(uint256)',
 'function bindMarket(address)', 'function createCampaign(bytes32,uint256,uint64,uint64,uint256) returns(uint256)',
 'function setCampaignPaused(uint256,bool)', 'function cancelCampaign(uint256)', 'function expireCampaign(uint256)',
 'function setBuyer(address,bool)', 'function setOperator(address)', 'function pause()', 'function unpause()',
 `function purchaseAuthorized(uint256,${offer},${authorization},bytes,bytes32)`,
 'function cancelOffer(bytes32)', 'function collectReturns()', 'function dispute(bytes32,bytes32)',
 'function acquisitionCampaign(bytes32) view returns(uint256)', 'function acquisitionBuyer(bytes32) view returns(address)',
];

export function campaignId(value:unknown):bigint {
 ensure(typeof value==='string'&&/^[1-9][0-9]{0,77}$/.test(value),'CAMPAIGN_ID_REQUIRED');
 const id=BigInt(value);ensure(id<(1n<<256n),'INVALID_CAMPAIGN_ID');return id;
}

/** Page reads use one confirmed block; a caller cannot mix allowances across heads. */
export async function campaignReserveState(chain:ThotChain,options:{campaignId?:string;cursor?:string}={}):Promise<Document>{
 ensure(chain.config.reserveCampaigns,'CAMPAIGNS_UNAVAILABLE');
 const block=await chain.snapshot(),at={blockTag:block.number},reserve=chain.reserve;
 const [balance,allocated,committed,unallocated,count,bound,paused]=await Promise.all([
  chain.token.balanceOf(chain.config.reserve,at),reserve.totalAllocated(at),reserve.totalGrossCommitted(at),
  reserve.unallocatedBalance(at),reserve.campaignCount(at),reserve.market(at),reserve.paused(at),
 ]);
 const selected=options.campaignId?campaignId(options.campaignId):null;
 if(selected)ensure(selected<=count,'CAMPAIGN_NOT_FOUND',404);
 const cursor=options.cursor?campaignId(options.cursor):count;
 ensure(cursor<=count,'INVALID_CAMPAIGN_CURSOR');
 const ids:bigint[]=selected?[selected]:[];
 if(!selected)for(let id=cursor;id>0n&&ids.length<20;id--)ids.push(id);
 const campaigns:Document[]=[];
 // Three campaigns at a time bounds load on the public RPC.
 for(let offset=0;offset<ids.length;offset+=3){
  campaigns.push(...await Promise.all(ids.slice(offset,offset+3).map(async id=>{
   const [c,available]=await Promise.all([reserve.campaign(id,at),reserve.remainingAllowance(id,at)]);
   const start=Number(c.startAt),end=Number(c.endAt);
   const status=c.closed?(block.timestamp>=end?'ended':'cancelled'):block.timestamp>=end?'ended':c.paused||paused?'paused':block.timestamp<start?'scheduled':'active';
   return {id:id.toString(),policy_hash:c.policyHash,budget_atoms:c.budget.toString(),committed_atoms:c.committed.toString(),
    start_at:start,end_at:end,upfront_atoms:c.upfront.toString(),paused:!!c.paused,closed:!!c.closed,available_atoms:available.toString(),status};
  })));
 }
 const next=!selected&&ids.length&&ids[ids.length-1]!>1n?(ids[ids.length-1]!-1n).toString():null;
 await chain.assertSnapshot(block);
 return {shared_treasury:!!chain.config.sharedTreasury,campaign_mode:'concurrent',inventory_atoms:balance.toString(),unallocated_atoms:unallocated.toString(),
  total_allocated_atoms:allocated.toString(),total_gross_committed_atoms:committed.toString(),campaign_count:count.toString(),
  market_bound:getAddress(bound)!==ZeroAddress&&getAddress(bound)===chain.config.market,paused:!!paused,campaigns,next_campaign_cursor:next,
  balance:balance.toString(),committed:committed.toString(),allowance:selected?campaigns[0]!.available_atoms:'0',demand:'0',start_at:0,block};
}
