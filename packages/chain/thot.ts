import {decodeStreamSignature} from './thot-authorizations.ts';
import {ZeroAddress, Contract, FetchRequest, JsonRpcProvider, Transaction, getAddress, keccak256, toUtf8Bytes, verifyTypedData, type Signer, type TransactionReceipt} from 'ethers';
import {ensure} from '../storage/src/index.ts';
import {ReadRetryProvider} from './read-retry-provider.ts';
import {THOT_CAMPAIGN_RESERVE_ABI,campaignReserveState} from './thot-campaigns.ts';

export const THOT_MARKET_ABI = [
 'function token() view returns(address)', 'function locks() view returns(address)',
 'function DISPUTE_WINDOW() view returns(uint256)', 'function SELLER_RESPONSE_WINDOW() view returns(uint256)',
 'function DISPUTE_VOTE_WINDOW() view returns(uint256)', 'function SUBJECTIVE_DISPUTE_MIN_QUALIFYING_SPEND() view returns(uint256)',
 'function DEAD_SINK() view returns(address)', 'function STREAM_AUTHORIZATION_TYPEHASH() view returns(bytes32)',
 'function operator() view returns(address)', 'function governor() view returns(address)', 'function acquisitionVault() view returns(address)', 'function buyerEligible(address) pure returns(bool)',
 'function offerId(address,bytes32) view returns(bytes32)',
 'function inputDigest(address,(bytes32 id,bytes32 nonce,address seller,uint256 gross,bytes32 licenseHash,bytes32 evidenceHash)) view returns(bytes32)',
 'function reviewOffer(address,(bytes32 id,bytes32 nonce,address seller,uint256 gross,bytes32 licenseHash,bytes32 evidenceHash),bytes32,bool)',
 'function createOffer((bytes32 id,bytes32 nonce,address seller,uint256 gross,bytes32 licenseHash,bytes32 evidenceHash),uint256 maxPayment)',
 'function offers(bytes32) view returns(address buyer,address seller,address referrer,uint256 gross,uint256 sellerAmount,uint256 referralAmount,bytes32 licenseHash,bytes32 evidenceHash,bytes32 reviewHash,bytes32 deliveryHash,uint64 issuedAt,uint64 acceptedAt,uint64 deliveredAt,uint64 finalizedAt,uint16 sellerBps,uint16 referralBps,bool treasury,bool independent,uint8 status)',
 'function quoteDigest(bytes32) view returns(bytes32)', 'function paymentFor(bytes32) view returns(uint256 sellerGross,uint256 surcharge,uint256 total,uint16 surchargeBps,bytes32 pricingHash)',
 'function buyerQuote(address,uint256) view returns(uint256 surcharge,uint256 total,uint16 surchargeBps,uint256 retainedAfter)',
 'function feeModelVersion() view returns(uint256)',
 'function ECONOMICS_POLICY() view returns(bytes32)', 'function tariff() view returns(uint256 directCost,uint256 allocatedOverhead,bytes32 policyHash)',
 'function feeDiscounts() view returns(address)',
 'function holderQuote(address,address,uint256) view returns(uint256 buyerDiscount,uint256 sellerDiscount)',
 'function costQuote(uint256) view returns(uint256 serviceFee,uint256 directCost,uint256 netContribution,uint256 sellerAmount,bytes32 policyHash)',
 'function tariffAtFunding(bytes32) view returns(uint256 directCost,uint256 allocatedOverhead,bytes32 policyHash)',
 'function firstExternalOrderAt(address) view returns(uint64)', 'function REFERRAL_ACTIVATION_WINDOW() view returns(uint256)',
 'function tariffOperation(uint256,uint256,bytes32) pure returns(bytes32)', 'function queueTariff(uint256,uint256,bytes32) returns(bytes32)', 'function executeTariff(uint256,uint256,bytes32)',
 'function buyerPricingConfigured() view returns(bool)', 'function buyerPricingHash() view returns(bytes32)',
 'function buyerPricingTierCount() view returns(uint256)', 'function buyerPricingTier(uint256) view returns(uint256 minRetained,uint16 surchargeBps)',
 'function buyerPricingOperation(uint256[],uint16[]) pure returns(bytes32)', 'function queueBuyerPricing(uint256[],uint16[]) returns(bytes32)', 'function executeBuyerPricing(uint256[],uint16[])',
 'function claimable(address) view returns(uint256)', 'function finalizedIndependentSpend(address) view returns(uint256)',
 'function acceptOffer(bytes32,bytes32)', 'function markDelivered(bytes32,bytes32)',
 'function dispute(bytes32,bytes32)', 'function finalize(bytes32)', 'function cancelOffer(bytes32)',
 'function disputeCases(bytes32) view returns(bytes32 reasonHash,bytes32 responseHash,uint64 openedAt,uint64 voteStartsAt,uint64 voteEndsAt,uint8 upholdVotes,uint8 buyerVotes,uint8 outcome)',
 'function disputeVotes(bytes32,address) view returns(uint8)', 'function disputeDecisionHashes(bytes32,address) view returns(bytes32)',
 'function disputeThreshold() view returns(uint256)', 'function isDisputeReviewer(address) view returns(bool)',
 'function waiveDisputeResponseWindow(bytes32)', 'function respondToDispute(bytes32,bytes32)', 'function voteDispute(bytes32,uint8,bytes32)', 'function finalizeExpiredDispute(bytes32)',
 'event Disputed(bytes32 indexed id,address indexed by,bytes32 indexed reasonHash)',
 'event DisputeResponded(bytes32 indexed id,address indexed seller,bytes32 indexed responseHash)',
 'event DisputeVoteCast(bytes32 indexed id,address indexed reviewer,uint8 decision,bytes32 indexed decisionHash)',
 'function refundExpired(bytes32)', 'function refundUndelivered(bytes32)', 'function claim()',
 'function registerReferrer(address)',
 'function createAuthorizedOffer((bytes32 id,bytes32 nonce,address seller,uint256 gross,bytes32 licenseHash,bytes32 evidenceHash),(address seller,address buyer,bytes32 evidenceHash,bytes32 licenseHash,uint256 gross,uint16 minSellerBps,uint64 validUntil,bytes32 nonce,uint32 maxUses),bytes,uint256 maxPayment)',
 'function createReviewedAuthorizedOffer((bytes32 id,bytes32 nonce,address seller,uint256 gross,bytes32 licenseHash,bytes32 evidenceHash),(address seller,address buyer,bytes32 evidenceHash,bytes32 licenseHash,uint256 gross,uint16 minSellerBps,uint64 validUntil,bytes32 nonce,uint32 maxUses),bytes,uint256 maxPayment,(bytes32 inputDigest,bytes32 reviewHash,uint64 validUntil),bytes reviewSignature)',
 'function streamUses(address,bytes32) view returns(uint256)',
 'function authorizationUses(address,bytes32) view returns(uint256)',
 'function authorizationRevoked(address,bytes32) view returns(bool)',
 'function revokeSaleAuthorization(bytes32)', 'function claimFor(address)',
];
export const THOT_AUTHORIZATION_TYPES={SaleAuthorization:[
 {name:'seller',type:'address'},{name:'buyer',type:'address'},{name:'evidenceHash',type:'bytes32'},
 {name:'licenseHash',type:'bytes32'},{name:'gross',type:'uint256'},{name:'minSellerBps',type:'uint16'},
 {name:'validUntil',type:'uint64'},{name:'nonce',type:'bytes32'},{name:'maxUses',type:'uint32'},
]};
export const THOT_REVIEW_TYPES={ReviewAuthorization:[
 {name:'inputDigest',type:'bytes32'},{name:'reviewHash',type:'bytes32'},{name:'validUntil',type:'uint64'},
]};
export const THOT_RESERVE_ABI=[
 'function authorizedBuyers(address) view returns(bool)', 'function governor() view returns(address)', 'function cancelOffer(bytes32)', 'function dispute(bytes32,bytes32)',
 'function operator() view returns(address)', 'function startAt() view returns(uint64)', 'function paused() view returns(bool)',
 'function grossCommitted() view returns(uint256)', 'function independentDemand() view returns(uint256)', 'function remainingAllowance() view returns(uint256)',
 'function purchaseAuthorized((bytes32 id,bytes32 nonce,address seller,uint256 gross,bytes32 licenseHash,bytes32 evidenceHash),(address seller,address buyer,bytes32 evidenceHash,bytes32 licenseHash,uint256 gross,uint16 minSellerBps,uint64 validUntil,bytes32 nonce,uint32 maxUses),bytes,bytes32)',
];
export const THOT_LOCK_ABI=[
 'function token() view returns(address)', 'function qualifiedBalance(address) view returns(uint256)',
 'function sellerBps(address) view returns(uint16)', 'function referralBps(address) view returns(uint16)',
 'function lotCount(address) view returns(uint256)', 'function lot(address,uint256) view returns(uint256 amount,uint64 depositedAt,uint64 unlockAt)',
 'function deposit(uint256,uint64)', 'function extend(uint256,uint64)', 'function withdraw(uint256)',
];
export const THOT_TOKEN_ABI=['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function approve(address,uint256) returns(bool)'];
export const ROBINHOOD_TESTNET_CHAIN_ID=46630;
export const ROBINHOOD_TESTNET_RPC='https://rpc.testnet.chain.robinhood.com';
export const ROBINHOOD_TESTNET_EXPLORER='https://explorer.testnet.chain.robinhood.com';
export interface ThotChainConfig {
 mode?:'local-anvil'|'robinhood-testnet'|'production';
 chainName?:string; explorerUrl?:string;
 streamSales?:boolean;
 manualReserve?:boolean;
 reserveCampaigns?:boolean;
 sharedTreasury?:boolean;
 percentageFees?:boolean;
 governanceKind?:'controller'|'safe';
 safeSingleton?:string;
 safeSingletonCodeHash?:string;
 governor?:string;staking?:string;holderRewards?:string;feeDiscounts?:string;
 reserveOperatorAddress?:string;
 rpcUrl:string; chainId:number; token:string; market:string; locks:string; reserve:string;
 confirmations:number; deploymentBlock:number; deploymentBlockHash:string;
 localDeliverySigner?:string;
 operatorAddress?:string;
 // Runtime bytecode pins include immutable constructor values. Public JSON never contains a key.
 codeHashes:{token:string;market:string;locks:string;reserve:string;staking?:string;governor?:string;holderRewards?:string;feeDiscounts?:string};
}
export interface ThotChainRuntime {operatorSigner?:Signer;}
export interface ThotOperatorJournalEntry {
 operation:string; raw:string; hash:string; nonce:number; status:'pending'|'confirmed'|'reverted';
 block?:{number:number;hash:string};
}
export interface ThotOperatorJournal {
 get(operation:string):Promise<ThotOperatorJournalEntry|undefined>;
 unsettled():Promise<ThotOperatorJournalEntry[]>;
 latest():Promise<ThotOperatorJournalEntry|undefined>;
 history():Promise<ThotOperatorJournalEntry[]>;
 put(entry:ThotOperatorJournalEntry):Promise<void>;
}
interface ThotSnapshot {number:number;hash:string|null;timestamp:number;}
const address=(v:string)=>{ensure(/^0x[\da-fA-F]{40}$/.test(v)&&!/^0x0{40}$/.test(v),'INVALID_THOT_ADDRESS');return getAddress(v);};
async function boundedMap<T,R>(items:T[],concurrency:number,read:(item:T,index:number)=>Promise<R>):Promise<R[]>{
 const results=new Array<R>(items.length);let cursor=0,failed=false;
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
  while(!failed&&cursor<items.length){const index=cursor++;try{results[index]=await read(items[index]!,index);}catch(error){failed=true;throw error;}}
 }));return results;
}
export class ThotChain {
 provider:JsonRpcProvider; market:Contract; locks:Contract; token:Contract; reserve:Contract; config:ThotChainConfig;
 private guardInFlight?:Promise<void>;
 private bindingsVerified=false;
 private disputeWindowSeconds?:number;
 private sellerResponseWindowSeconds?:number;
 private disputeVoteWindowSeconds?:number;
 private subjectiveDisputeMinQualifyingSpend?:string;
 private disputeReviewThreshold?:number;
 private operatorSigner?:Signer;
 private operatorQueue:Promise<unknown>=Promise.resolve();
 private operatorJournal?:ThotOperatorJournal;
 bindOperatorJournal(journal:ThotOperatorJournal){ensure(!this.operatorJournal,'THOT_JOURNAL_ALREADY_BOUND');this.operatorJournal=journal;}
 constructor(config:ThotChainConfig,runtime:ThotChainRuntime={}){
  const testnet=config.mode==='robinhood-testnet',production=config.mode==='production',publicChain=testnet||production;
  ensure(production?Number.isSafeInteger(config.chainId)&&config.chainId===4663&&config.percentageFees&&config.sharedTreasury&&config.governanceKind==='safe':testnet?config.chainId===ROBINHOOD_TESTNET_CHAIN_ID:config.chainId===31337,'THOT_PRODUCTION_ACTIVATION_PENDING',503);
  ensure(config.mode===undefined||config.mode==='local-anvil'||publicChain,'INVALID_THOT_MODE');
  ensure(Number.isSafeInteger(config.confirmations)&&config.confirmations>=(publicChain?2:1)&&config.confirmations<=100,'INVALID_CONFIRMATIONS');
  ensure(Number.isSafeInteger(config.deploymentBlock)&&config.deploymentBlock>=0,'INVALID_DEPLOYMENT_BLOCK');
  ensure(/^0x[\da-f]{64}$/i.test(config.deploymentBlockHash),'INVALID_DEPLOYMENT_BLOCK_HASH');
  const rpc=new URL(config.rpcUrl);
  if(publicChain){
   ensure(!rpc.username&&!rpc.password&&(production?rpc.href==='https://rpc.mainnet.chain.robinhood.com/'&&!!config.chainName:rpc.href===ROBINHOOD_TESTNET_RPC+'/'),'THOT_PUBLIC_RPC_REQUIRED');
   ensure(!config.localDeliverySigner,'THOT_TESTNET_EXTERNAL_SIGNER_REQUIRED');
   ensure(typeof config.operatorAddress==='string','THOT_TESTNET_OPERATOR_REQUIRED');address(config.operatorAddress);
  }else{
   ensure(['http:','https:'].includes(rpc.protocol)&&['localhost','127.0.0.1','[::1]'].includes(rpc.hostname)&&!rpc.username&&!rpc.password,'THOT_LOCAL_RPC_REQUIRED');
   ensure(!runtime.operatorSigner,'THOT_TESTNET_EXTERNAL_SIGNER_REQUIRED');
  }
  for(const name of ['token','market','locks','reserve'] as const)ensure(/^0x[\da-f]{64}$/i.test(config.codeHashes?.[name]),'INVALID_THOT_CODE_PIN');
  if(config.governor||testnet&&config.manualReserve){ensure(typeof config.governor==='string'&&/^0x[\da-f]{64}$/i.test(config.codeHashes?.governor??''),'INVALID_THOT_GOVERNOR_PIN');address(config.governor);}
  this.config=Object.freeze({...config,token:address(config.token),market:address(config.market),locks:address(config.locks),reserve:address(config.reserve),codeHashes:Object.freeze({...config.codeHashes})});
  const request=new FetchRequest(config.rpcUrl);
  if(publicChain){request.timeout=20_000;request.setThrottleParams({maxAttempts:3,slotInterval:1000});}
  this.provider=new (publicChain?ReadRetryProvider:JsonRpcProvider)(request,undefined,{cacheTimeout:-1,...(publicChain?{batchMaxCount:1}:{})});
  if(publicChain)this.provider.pollingInterval=5000;
  this.operatorSigner=runtime.operatorSigner;
  this.market=new Contract(this.config.market,THOT_MARKET_ABI,this.provider);
  this.locks=new Contract(this.config.locks,THOT_LOCK_ABI,this.provider);
  this.token=new Contract(this.config.token,THOT_TOKEN_ABI,this.provider);
  ensure(!config.reserveCampaigns||config.manualReserve&&!!config.governor,'CAMPAIGN_GOVERNOR_REQUIRED');
  ensure(!config.sharedTreasury||config.reserveCampaigns&&!!config.staking&&/^0x[\da-f]{64}$/i.test(config.codeHashes.staking??''),'SHARED_TREASURY_CONFIG_REQUIRED');
  this.reserve=new Contract(this.config.reserve,config.reserveCampaigns?THOT_CAMPAIGN_RESERVE_ABI:THOT_RESERVE_ABI,this.provider);
 }
 async guard(){
  // Coalesce only overlapping checks. Never reuse a successful check by timestamp:
  // local Anvil resets and setCode can change state without increasing block height.
  if(this.guardInFlight)return this.guardInFlight;
  const pending=this.checkDeployment();this.guardInFlight=pending;
  try{await pending;}finally{if(this.guardInFlight===pending)this.guardInFlight=undefined;}
 }
 private async checkDeployment(){
  // Explicit RPC request avoids relying on a cached provider network object.
  ensure(BigInt(await this.provider.send('eth_chainId',[]))===BigInt(this.config.chainId),'THOT_CHAIN_MISMATCH');
  const names=['token','market','locks','reserve'] as const;
  const [anchor,...codes]=await Promise.all([this.provider.getBlock(this.config.deploymentBlock),...names.map(name=>this.provider.getCode(this.config[name]))]);
  ensure(anchor&&typeof anchor!=='string'&&anchor.hash?.toLowerCase()===this.config.deploymentBlockHash.toLowerCase(),'THOT_DEPLOYMENT_ANCHOR_MISMATCH',503);
  for(let i=0;i<names.length;i++){
   const code=codes[i],name=names[i]!;
   ensure(typeof code==='string'&&code!=='0x'&&keccak256(code).toLowerCase()===this.config.codeHashes[name].toLowerCase(),'THOT_CODE_PIN_MISMATCH',503);
  }
  if(this.config.governanceKind==='safe'){
   ensure(this.config.governor&&this.config.safeSingleton&&/^0x[\da-f]{64}$/i.test(this.config.safeSingletonCodeHash??''),'SAFE_CONFIG_REQUIRED');
   const singleton=getAddress('0x'+(await this.provider.getStorage(this.config.governor,0)).slice(-40));
   ensure(singleton===getAddress(this.config.safeSingleton)&&keccak256(await this.provider.getCode(singleton))===this.config.safeSingletonCodeHash,'SAFE_SINGLETON_MISMATCH',503);
   const safe=new Contract(this.config.governor,['function getModulesPaginated(address,uint256) view returns(address[],address)'],this.provider);
   const [modules,next]=await safe.getModulesPaginated('0x0000000000000000000000000000000000000001',1);
   ensure(modules.length===0&&BigInt(next)===1n,'SAFE_MODULES_UNSUPPORTED',503);
   for(const slot of ['fallback_manager.handler.address','guard_manager.guard.address'])ensure(BigInt(await this.provider.getStorage(this.config.governor,keccak256(toUtf8Bytes(slot))))===0n,'SAFE_HANDLER_UNSUPPORTED',503);
  }
  if(this.config.percentageFees)ensure(await this.market.feeModelVersion()===2n,'PERCENTAGE_FEE_MODEL_REQUIRED',503);
  if(this.config.governor){const [reserveGovernor,marketGovernor,code]=await Promise.all([this.reserve.governor(),this.market.governor(),this.provider.getCode(this.config.governor)]);ensure(getAddress(reserveGovernor)===getAddress(this.config.governor)&&getAddress(marketGovernor)===getAddress(this.config.governor)&&code!=='0x'&&keccak256(code).toLowerCase()===this.config.codeHashes.governor?.toLowerCase(),'THOT_GOVERNOR_PIN_MISMATCH',503);}
  if(this.config.feeDiscounts){
   const target=address(this.config.feeDiscounts),policy=new Contract(target,['function token() view returns(address)','function governor() view returns(address)','function staking() view returns(address)'],this.provider);
   const [code,bound,token,governor,staking]=await Promise.all([this.provider.getCode(target),this.market.feeDiscounts(),policy.token(),policy.governor(),policy.staking()]);
   ensure(code!=='0x'&&keccak256(code)===this.config.codeHashes.feeDiscounts&&getAddress(bound)===target&&getAddress(token)===this.config.token&&getAddress(governor)===getAddress(this.config.governor!)&&getAddress(staking)===getAddress(this.config.staking!),'FEE_DISCOUNT_BINDING',503);
   ensure(!this.config.holderRewards,'DUPLICATE_HOLDER_BENEFITS',503);
  }
  if(this.config.sharedTreasury){
   const pool=new Contract(this.config.staking!,['function token() view returns(address)','function governor() view returns(address)'],this.provider);
   const [code,bound,token,governor]=await Promise.all([this.provider.getCode(this.config.staking!),this.reserve.stakingPool(),pool.token(),pool.governor()]);
   ensure(code!=='0x'&&keccak256(code).toLowerCase()===this.config.codeHashes.staking?.toLowerCase()&&getAddress(bound)===getAddress(this.config.staking!)&&getAddress(token)===this.config.token&&getAddress(governor)===this.config.reserve,'TREASURY_STAKING_BINDING_MISMATCH',503);
  }
  // Bindings are immutable in the pinned code. Validate them once after runtime
  // verification; every subsequent check still verifies all four runtime hashes.
  if(!this.bindingsVerified){
   if(this.config.reserveCampaigns)ensure(await this.reserve.reserveVersion()===(this.config.sharedTreasury?3n:2n)&&getAddress(await this.reserve.token())===this.config.token,'CAMPAIGN_RESERVE_REQUIRED');
   if(this.config.streamSales)ensure(/^0x[0-9a-f]{64}$/i.test(await this.market.STREAM_AUTHORIZATION_TYPEHASH()),'STREAM_CONTRACT_REQUIRED');
   const [token,locks,reserve,lockToken,decimals,disputeWindow,responseWindow,voteWindow,minPriorSpend,deadSink,reviewThreshold]=await Promise.all([
    this.market.token(),this.market.locks(),this.market.acquisitionVault(),this.locks.token(),this.token.decimals(),this.market.DISPUTE_WINDOW(),
    this.market.SELLER_RESPONSE_WINDOW(),this.market.DISPUTE_VOTE_WINDOW(),this.market.SUBJECTIVE_DISPUTE_MIN_QUALIFYING_SPEND(),this.market.DEAD_SINK(),this.market.disputeThreshold(),
   ]);
   ensure(getAddress(token)===this.config.token&&getAddress(locks)===this.config.locks&&getAddress(reserve)===this.config.reserve&&getAddress(lockToken)===this.config.token,'THOT_BINDING_MISMATCH');
   ensure(Number(decimals)===18,'THOT_DECIMALS');
   // Existing deployments retain their immutable settlement terms during migration.
   ensure(disputeWindow===3600n||disputeWindow===43200n||disputeWindow===86400n,'THOT_DISPUTE_WINDOW_UNSUPPORTED');
   ensure(responseWindow===86400n&&voteWindow===7n*86400n&&minPriorSpend===10_000_000n*10n**18n&&getAddress(deadSink)===getAddress('0x000000000000000000000000000000000000dEaD'),'THOT_DISPUTE_POLICY_MISMATCH');
   ensure(reviewThreshold===1n||reviewThreshold===2n,'THOT_DISPUTE_GOVERNANCE_MISMATCH');
   this.disputeWindowSeconds=Number(disputeWindow);this.sellerResponseWindowSeconds=Number(responseWindow);
   this.disputeVoteWindowSeconds=Number(voteWindow);this.subjectiveDisputeMinQualifyingSpend=minPriorSpend.toString();
   this.disputeReviewThreshold=Number(reviewThreshold);this.bindingsVerified=true;
  }
  const operator=this.publicChain()?this.config.operatorAddress:this.config.localDeliverySigner;
  if(operator){
   const [marketOperator,reserveOperator]=await Promise.all([this.market.operator(),this.reserve.operator()]);
   ensure(getAddress(operator)===getAddress(marketOperator)&&getAddress(this.config.reserveOperatorAddress??operator)===getAddress(reserveOperator),'THOT_OPERATOR_MISMATCH');
   if(this.operatorSigner)ensure(getAddress(await this.operatorSigner.getAddress())===getAddress(operator),'THOT_SIGNER_MISMATCH');
  }
 }
 capabilities(){const testnet=this.config.mode==='robinhood-testnet',production=this.config.mode==='production';return {mode:production?'thot-production':testnet?'thot-testnet':'thot-anvil',chain_name:production?this.config.chainName:testnet?'Robinhood Chain Testnet':'Local Anvil',rpc_url:this.config.rpcUrl,explorer_url:production?this.config.explorerUrl??null:testnet?ROBINHOOD_TESTNET_EXPLORER:null,version:'0.9',test_assets:!production,production_enabled:production,operator_available:this.operatorAvailable(),operator_address:this.config.operatorAddress??this.config.localDeliverySigner??null,chain_id:this.config.chainId,token:this.config.token,market:this.config.market,locks:this.config.locks,reserve:this.config.reserve,confirmations:this.config.confirmations,holding_income:false,economics_policy:this.config.percentageFees?'percentage/1':'quoted-cost/1',idle_lock_benefits:!!this.config.percentageFees,automatic_sales:true,stream_sales:this.config.streamSales===true,manual_reserve:this.config.manualReserve===true,reserve_campaigns:this.config.reserveCampaigns===true,buyer_surcharge:true,dispute_seconds:this.disputeWindowSeconds??null,seller_response_seconds:this.sellerResponseWindowSeconds??null,dispute_vote_seconds:this.disputeVoteWindowSeconds??null,subjective_dispute_min_qualifying_spend:this.subjectiveDisputeMinQualifyingSpend??null,dispute_review_threshold:this.disputeReviewThreshold??null};}
 publicChain(){return this.config.mode==='robinhood-testnet'||this.config.mode==='production';}
 operatorAvailable(){return this.publicChain()?Boolean(this.operatorSigner):Boolean(this.config.localDeliverySigner);}
 authorizationDomain(){return {name:'thot market',version:'0.9',chainId:this.config.chainId,verifyingContract:this.config.market};}
 async authorizationState(seller:string,nonce:string,signature?:string){const block=await this.snapshot();const [uses,revoked]=await Promise.all([this.market.authorizationUses(seller,nonce,{blockTag:block.number}),this.market.authorizationRevoked(seller,nonce,{blockTag:block.number})]);let streamUnavailable=false;const e=signature?decodeStreamSignature(signature):null;if(e){const [n,r]=await Promise.all([this.market.streamUses(seller,e.stream.nonce,{blockTag:block.number}),this.market.authorizationRevoked(seller,e.stream.nonce,{blockTag:block.number})]);streamUnavailable=!!r||Number(n)>=e.stream.maxSales||block.timestamp>=e.stream.validUntil;}await this.assertSnapshot(block);return {uses:Number(uses),revoked:Boolean(revoked)||streamUnavailable,block};}
 async isReserveBuyer(wallet:string){if(!this.config.manualReserve)return false;const block=await this.snapshot();const allowed=await this.reserve.authorizedBuyers(wallet,{blockTag:block.number});await this.assertSnapshot(block);return !!allowed;}
 async reserveState(campaignId?:string){
  if(this.config.reserveCampaigns)return campaignReserveState(this,{campaignId});
  const block=await this.snapshot(),at={blockTag:block.number};
  const [balance,allowance,committed,demand,start,paused]=await Promise.all([this.token.balanceOf(this.config.reserve,at),this.reserve.remainingAllowance(at),this.reserve.grossCommitted(at),this.reserve.independentDemand(at),this.reserve.startAt(at),this.reserve.paused(at)]);
  await this.assertSnapshot(block);return {balance:balance.toString(),allowance:allowance.toString(),committed:committed.toString(),demand:demand.toString(),start_at:Number(start),paused:Boolean(paused),block};
 }
 async snapshot(){
  await this.guard();
  const latest=await this.provider.getBlockNumber();const number=latest-this.config.confirmations+1;
  ensure(number>=this.config.deploymentBlock,'THOT_WAIT_FOR_CONFIRMATIONS',409);
  const block=await this.recentBlock(number);ensure(block,'THOT_BLOCK_UNAVAILABLE',503);
  return {number,hash:block.hash,timestamp:block.timestamp};
 }
 private async recentBlock(number:number){
  // Public RPC load balancers can route the head read to a newer backend than
  // the subsequent block read. Retry only a null block, always at the original
  // confirmed height; never swallow RPC errors or accept another block/hash.
  const delays=this.publicChain()?[100,250,500,1000]:[];
  for(let attempt=0;;attempt++){
   const block=await this.provider.getBlock(number);
   if(block||attempt===delays.length)return block;
   await new Promise(resolve=>setTimeout(resolve,delays[attempt]));
  }
 }
 async assertSnapshot(block:{number:number;hash:string|null}){
  const current=await this.recentBlock(block.number);
  ensure(current&&block.hash&&current.hash===block.hash,'THOT_SNAPSHOT_CHANGED',409);
 }
 async isCanonicalBlock(anchor:{number:number;hash:string|null},confirmed?:{number:number;hash:string|null}){
  const snapshot=confirmed??await this.snapshot();
  if(!Number.isSafeInteger(anchor?.number)||anchor.number<this.config.deploymentBlock||anchor.number>snapshot.number||typeof anchor.hash!=='string'||!/^0x[\da-f]{64}$/i.test(anchor.hash))return false;
  const current=await this.provider.getBlock(anchor.number);await this.assertSnapshot(snapshot);
  return Boolean(current?.hash&&current.hash.toLowerCase()===anchor.hash.toLowerCase());
 }
 async account(owner:string){
  const block=await this.snapshot(),account=await this.accountAt(owner,block);
  await this.assertSnapshot(block);return account;
 }
 async purchaseQuote(owner:string,gross:string|bigint,seller?:string){
  owner=address(owner);const sellerGross=BigInt(gross);ensure(sellerGross>0n,'INVALID_THOT_GROSS');
  const block=await this.snapshot(),at={blockTag:block.number};
  const [q,balance,cost]=await Promise.all([this.market.buyerQuote(owner,sellerGross,at),this.token.balanceOf(owner,at),this.market.costQuote(sellerGross,at)]);
  const discounts=this.config.feeDiscounts?await this.market.holderQuote(owner,seller?address(seller):ZeroAddress,sellerGross,at):[0n,0n];
  const buyerDiscount=BigInt(discounts[0]),sellerDiscount=BigInt(discounts[1]);
  ensure(BigInt(q.total)===sellerGross+BigInt(q.surcharge)-buyerDiscount,'DISCOUNT_QUOTE_MISMATCH');
  await this.assertSnapshot(block);return {buyer_discount:buyerDiscount.toString(),seller_discount:sellerDiscount.toString(),seller_gross:sellerGross.toString(),surcharge:q.surcharge.toString(),total:q.total.toString(),surcharge_bps:Number(q.surchargeBps),retained_after:q.retainedAfter.toString(),affordable:balance>=q.total,economics:{service_fee:cost.serviceFee.toString(),direct_cost:cost.directCost.toString(),net_contribution:cost.netContribution.toString(),seller_amount:(BigInt(cost.sellerAmount)+sellerDiscount).toString(),buyer_discount:buyerDiscount.toString(),seller_discount:sellerDiscount.toString(),policy_hash:String(cost.policyHash)},block};
 }
 private async accountAt(owner:string,b:ThotSnapshot){
  const at={blockTag:b.number};
  const [balance,qualified,tariff,claimable,finalizedIndependentSpend,disputeReviewer,count]=await Promise.all([this.token.balanceOf(owner,at),this.locks.qualifiedBalance(owner,at),this.market.tariff(at),this.market.claimable(owner,at),this.market.finalizedIndependentSpend(owner,at),this.market.isDisputeReviewer(owner,at),this.locks.lotCount(owner,at)]);
  const percentage=!!this.config.percentageFees,directCost=BigInt(tariff.directCost),overhead=BigInt(tariff.allocatedOverhead),net=percentage?(10n**18n*overhead+9999n)/10000n:overhead+overhead/2n+overhead%2n;
  ensure(count<=64n,'THOT_LOT_LIMIT');
  const lots=await boundedMap(Array.from({length:Number(count)},(_,i)=>i),4,async i=>{const lot=await this.locks.lot(owner,i,at);return {id:i,amount:lot.amount.toString(),deposited_at:Number(lot.depositedAt),unlock_at:Number(lot.unlockAt)};});
  return {wallet:owner,balance:balance.toString(),qualified:qualified.toString(),seller_bps:null,referral_bps:2000,economics:{policy:percentage?'percentage/1':'quoted-cost/1',fee_bps:percentage?Number(overhead):null,policy_hash:String(tariff.policyHash),direct_cost:directCost.toString(),allocated_overhead:percentage?'0':overhead.toString(),net_contribution:net.toString(),service_fee:(directCost+net).toString(),idle_lock_benefits:percentage},claimable:claimable.toString(),finalized_independent_spend:finalizedIndependentSpend.toString(),dispute_reviewer:Boolean(disputeReviewer),lots,block:b};
 }
 async offer(id:string,reviewer?:string){
  ensure(/^0x[\da-f]{64}$/i.test(id),'INVALID_OFFER_ID');
  if(reviewer!==undefined)address(reviewer);
  const block=await this.snapshot(),offer=await this.offerAt(id,block,reviewer);await this.assertSnapshot(block);return offer;
 }
 private async offerAt(id:string,block:ThotSnapshot,reviewer?:string){
  const at={blockTag:block.number};
  const [o,quoteDigest,payment,c,reviewerVote,reviewerDecisionHash,tariff]=await Promise.all([
   this.market.offers(id,at),this.market.quoteDigest(id,at),this.market.paymentFor(id,at),this.market.disputeCases(id,at),
   reviewer?this.market.disputeVotes(id,reviewer,at):0n,reviewer?this.market.disputeDecisionHashes(id,reviewer,at):'0x'+'00'.repeat(32),this.market.tariffAtFunding(id,at),
  ]);
  const dispute=Number(c.openedAt)>0?{reason_hash:String(c.reasonHash),response_hash:String(c.responseHash),opened_at:Number(c.openedAt),vote_starts_at:Number(c.voteStartsAt),vote_ends_at:Number(c.voteEndsAt),uphold_votes:Number(c.upholdVotes),buyer_votes:Number(c.buyerVotes),outcome:Number(c.outcome),reviewer_vote:Number(reviewerVote),reviewer_decision_hash:String(reviewerDecisionHash)}:null;
  return {id,buyer:getAddress(o.buyer),seller:getAddress(o.seller),gross:o.gross.toString(),seller_gross:payment.sellerGross.toString(),buyer_surcharge:payment.surcharge.toString(),buyer_total:payment.total.toString(),buyer_surcharge_bps:Number(payment.surchargeBps),buyer_pricing_hash:String(payment.pricingHash),economics:{policy:this.config.percentageFees?'percentage/1':'quoted-cost/1',fee_bps:this.config.percentageFees?Number(tariff.allocatedOverhead):null,direct_cost:String(tariff.directCost),allocated_overhead:this.config.percentageFees?'0':String(tariff.allocatedOverhead),policy_hash:String(tariff.policyHash),service_fee:(payment.total-o.sellerAmount).toString(),net_contribution:(BigInt(payment.total)-BigInt(o.sellerAmount)-BigInt(tariff.directCost)).toString()},seller_amount:o.sellerAmount.toString(),referral_amount:o.referralAmount.toString(),referrer:o.referrer,license_hash:o.licenseHash,evidence_hash:o.evidenceHash,review_hash:o.reviewHash,delivery_hash:o.deliveryHash,issued_at:Number(o.issuedAt),accepted_at:Number(o.acceptedAt),delivered_at:Number(o.deliveredAt),dispute_seconds:this.disputeWindowSeconds!,finalized_at:Number(o.finalizedAt),seller_bps:Number(o.sellerBps),referral_bps:Number(o.referralBps),treasury:o.treasury,independent:o.independent,status:Number(o.status),quote_digest:quoteDigest,dispute,block};
 }
 async readWorkspace(owner:string|undefined,offerIds:string[]){
  ensure(Array.isArray(offerIds)&&offerIds.length<=50&&offerIds.every(id=>/^0x[\da-f]{64}$/i.test(id)),'INVALID_WORKSPACE_OFFERS');
  if(owner!==undefined)address(owner);
  // Request-local batching only: no time-based reuse across HTTP requests or
  // transaction decisions. Every field is read at the same confirmed height.
  const block=await this.snapshot(),account=owner?await this.accountAt(owner,block):null;
  const offers=await boundedMap(offerIds,4,id=>this.offerAt(id,block,owner));
  await this.assertSnapshot(block);return {account,offers,block};
 }
 async disputeReview(id:string,reviewer:string){
  ensure(/^0x[\da-f]{64}$/i.test(id),'INVALID_OFFER_ID');address(reviewer);
  const block=await this.snapshot(),at={blockTag:block.number};
  const [eligible,vote,decisionHash]=await Promise.all([this.market.isDisputeReviewer(reviewer,at),this.market.disputeVotes(id,reviewer,at),this.market.disputeDecisionHashes(id,reviewer,at)]);
  await this.assertSnapshot(block);return {reviewer:getAddress(reviewer),eligible:Boolean(eligible),vote:Number(vote),decision_hash:String(decisionHash),block};
 }
 transaction(kind:'market'|'locks'|'token'|'reserve',method:string,args:unknown[]){
  const contract=this[kind];return {to:this.config[kind],data:contract.interface.encodeFunctionData(method,args),value:'0x0',chainId:'0x'+this.config.chainId.toString(16)};
 }
 private async settleJournal(entry:ThotOperatorJournalEntry):Promise<TransactionReceipt>{
  const journal=this.operatorJournal!;
  const decoded=Transaction.from(entry.raw),from=getAddress(this.config.operatorAddress!);
  ensure(decoded.hash===entry.hash&&decoded.from===from&&decoded.chainId===BigInt(this.config.chainId)&&decoded.nonce===entry.nonce&&decoded.value===0n,'THOT_JOURNAL_TRANSACTION_MISMATCH');
  const kind=decoded.to===this.config.market?'market':decoded.to===this.config.reserve?'reserve':null;
  ensure(kind,'THOT_JOURNAL_TRANSACTION_MISMATCH');
  const parsed=this[kind].interface.parseTransaction({data:decoded.data});
  ensure(parsed&&(kind==='reserve'?parsed.name==='purchaseAuthorized':['reviewOffer','markDelivered','finalize','finalizeExpiredDispute','refundExpired','refundUndelivered','claimFor'].includes(parsed.name)),'THOT_OPERATOR_METHOD_DENIED');
  ensure(decoded.gasLimit<=2_000_000n&&(decoded.maxFeePerGas??decoded.gasPrice??0n)*decoded.gasLimit<=100_000_000_000_000n,'THOT_JOURNAL_TRANSACTION_MISMATCH');
  let receipt=await this.provider.getTransactionReceipt(entry.hash);
  if(receipt){
   const current=await this.provider.getBlock(receipt.blockNumber);
   if(current?.hash!==receipt.blockHash)receipt=null;
   else receipt=await this.provider.waitForTransaction(entry.hash,this.config.confirmations,120_000);
  }
  if(!receipt){
   // Never replace an uncertain transaction with a fresh nonce. A consumed nonce
   // with no matching canonical receipt needs explicit operator reconciliation.
   ensure(await this.provider.getTransactionCount(from,'latest')<=entry.nonce,'THOT_OPERATOR_NONCE_CONFLICT',409);
   if(entry.status!=='pending'){entry={...entry,status:'pending'};delete entry.block;await journal.put(entry);}
   try{await this.provider.broadcastTransaction(entry.raw);}catch{
    // Already-known and transport-timeout responses are both uncertain. Wait by
    // the locally computed hash; do not infer broadcast failure or sign again.
   }
   receipt=await this.provider.waitForTransaction(entry.hash,this.config.confirmations,120_000);
  }
  ensure(receipt,'THOT_OPERATOR_TRANSACTION_PENDING',409);
  ensure(await this.isCanonicalBlock({number:receipt.blockNumber,hash:receipt.blockHash}),'THOT_TRANSACTION_REORGED',409);
  await journal.put({...entry,status:receipt.status===1?'confirmed':'reverted',block:{number:receipt.blockNumber,hash:receipt.blockHash}});
  ensure(receipt.status===1,'THOT_OPERATOR_TRANSACTION_REVERTED',409);
  return receipt;
 }
 private async reconcileJournal(){
  const journal=this.operatorJournal;ensure(journal,'THOT_OPERATOR_JOURNAL_REQUIRED',503);
  const latest=await journal.latest();
  // Checking the newest recorded block also verifies ancestry of earlier entries.
  if(latest?.block&&!await this.isCanonicalBlock(latest.block)){
   const history=(await journal.history()).sort((a,b)=>a.nonce-b.nonce);
   // Confirmed nonce order is block order. Locate the reorganized suffix with
   // logarithmic RPC reads, then replay that suffix with the original nonces.
   let low=0,high=history.length;
   while(low<high){const mid=(low+high)>>>1,entry=history[mid]!;if(entry.block&&await this.isCanonicalBlock(entry.block))low=mid+1;else high=mid;}
   for(const entry of history.slice(low))try{await this.settleJournal(entry);}catch(error){if(!(error instanceof Error)||error.message!=='THOT_OPERATOR_TRANSACTION_REVERTED')throw error;}
  }
  for(const entry of await journal.unsettled())await this.settleJournal(entry);
 }
 async reconcileOperatorTransactions(){
  if(!this.publicChain()||!this.operatorAvailable())return;
  const run=async()=>{await this.guard();await this.reconcileJournal();};
  const pending=this.operatorQueue.then(run,run);this.operatorQueue=pending.catch(()=>undefined);return pending;
 }
 private async operatorTransaction(kind:'market'|'reserve',method:string,args:unknown[],failure:string,logicalScope=''){
  // The worker has no arbitrary transfer, approval, governance or deployment entry point.
  ensure(kind==='reserve'?method==='purchaseAuthorized':['reviewOffer','markDelivered','finalize','finalizeExpiredDispute','refundExpired','refundUndelivered','claimFor'].includes(method),'THOT_OPERATOR_METHOD_DENIED');
  const run=async()=>{
   await this.guard();ensure(this.operatorAvailable(),'THOT_DELIVERY_OPERATOR_REQUIRED',409);
   const to=this.config[kind],data=this[kind].interface.encodeFunctionData(method,args);
   let receipt:TransactionReceipt|null;
   if(this.publicChain()){
    await this.reconcileJournal();
    const journal=this.operatorJournal!,operation=keccak256(Buffer.from(JSON.stringify([this.config.chainId,this.config.market,this.config.operatorAddress,kind,method,data,logicalScope])));
    const previous=await journal.get(operation);
    if(previous)return this.settleJournal(previous);
    // Obtain nonce/fees from our pinned network, then ask an external signer only
    // for a raw signature. Never use eth_sendTransaction or an unlocked RPC account.
    const signer=this.operatorSigner!,from=getAddress(await signer.getAddress());
    ensure(from===getAddress(this.config.operatorAddress!),'THOT_SIGNER_MISMATCH');
    const [nonce,fee,estimate]=await Promise.all([this.provider.getTransactionCount(from,'pending'),this.provider.getFeeData(),this.provider.estimateGas({from,to,data,value:0n})]);
    const gasLimit=estimate+estimate/5n+10_000n;
    ensure(gasLimit<=2_000_000n,'THOT_OPERATOR_GAS_LIMIT');
    const price=fee.maxFeePerGas??fee.gasPrice;ensure(price!==null&&price<=100_000_000_000n,'THOT_OPERATOR_FEE_LIMIT');
    ensure(gasLimit*price<=100_000_000_000_000n,'THOT_OPERATOR_TRANSACTION_COST_LIMIT'); // 0.0001 test ETH
    const transaction={to,data,value:0n,chainId:this.config.chainId,nonce,gasLimit,...(fee.maxFeePerGas!==null?{type:2,maxFeePerGas:fee.maxFeePerGas,maxPriorityFeePerGas:fee.maxPriorityFeePerGas??0n}:{type:0,gasPrice:fee.gasPrice!})};
    await this.guard();
    const raw=await signer.signTransaction(transaction);
    const decoded=Transaction.from(raw);
    ensure(decoded.type===transaction.type&&(decoded.accessList??[]).length===0&&(decoded.authorizationList??[]).length===0&&decoded.chainId===BigInt(transaction.chainId)&&decoded.from===from&&decoded.to===to&&decoded.data===data&&decoded.value===0n&&decoded.nonce===nonce&&decoded.gasLimit===gasLimit&&decoded.maxFeePerGas===('maxFeePerGas' in transaction?transaction.maxFeePerGas:null)&&decoded.maxPriorityFeePerGas===('maxPriorityFeePerGas' in transaction?transaction.maxPriorityFeePerGas:null)&&decoded.gasPrice===('gasPrice' in transaction?transaction.gasPrice:null),'THOT_SIGNED_TRANSACTION_MISMATCH');
    const entry:ThotOperatorJournalEntry={operation,raw,hash:decoded.hash!,nonce,status:'pending'};
    // Committing the encrypted raw transaction precedes its first network send.
    await journal.put(entry);
    receipt=await this.settleJournal(entry);
   }else{
    const signer=await this.provider.getSigner(this.config.localDeliverySigner);
    receipt=await(await signer.sendTransaction({to,data,value:0n})).wait(this.config.confirmations,120_000);
   }
   ensure(receipt?.status===1,failure,409);await this.guard();
   ensure(await this.isCanonicalBlock({number:receipt.blockNumber,hash:receipt.blockHash}),'THOT_TRANSACTION_REORGED',409);
   return receipt;
  };
  const pending=this.operatorQueue.then(run,run);this.operatorQueue=pending.catch(()=>undefined);return pending;
 }
 async acknowledgeAvailability(id:string,releaseHash:string){
  await this.operatorTransaction('market','markDelivered',[id,releaseHash],'THOT_DELIVERY_ACK_PENDING');
 }
 async reviewInput(buyer:string,offer:unknown,expectedCosts?:{service_fee:string;direct_cost:string;policy_hash:string;buyer_discount?:string;seller_discount?:string}){
  const block=await this.snapshot();
  const inputDigest:string=await this.market.inputDigest(buyer,offer,{blockTag:block.number});
  if(expectedCosts){const q=await this.market.costQuote((offer as {gross:string}).gross,{blockTag:block.number});ensure(String(q.serviceFee)===expectedCosts.service_fee&&String(q.directCost)===expectedCosts.direct_cost&&String(q.policyHash)===expectedCosts.policy_hash,'THOT_TARIFF_CHANGED',409);}
  if(expectedCosts&&this.config.feeDiscounts){const o=offer as {gross:string;seller:string};const d=await this.market.holderQuote(buyer,o.seller,o.gross,{blockTag:block.number});ensure(String(d[0])===expectedCosts.buyer_discount&&String(d[1])===expectedCosts.seller_discount,'THOT_DISCOUNT_CHANGED',409);}
  await this.assertSnapshot(block);
  return {inputDigest:String(inputDigest),validUntil:block.timestamp+900};
 }
 async signIndependentReview(buyer:string,offer:unknown,review:{inputDigest:string;reviewHash:string;validUntil:number}){
  await this.guard();ensure(this.operatorAvailable(),'THOT_REVIEW_OPERATOR_REQUIRED',409);
  const signer=this.publicChain()?this.operatorSigner!:await this.provider.getSigner(this.config.localDeliverySigner);
  const reviewer=getAddress(await signer.getAddress());
  ensure(reviewer===getAddress(this.config.operatorAddress??this.config.localDeliverySigner!),'THOT_SIGNER_MISMATCH');
  const block=await this.snapshot();
  ensure(block.timestamp<review.validUntil&&review.validUntil<=block.timestamp+900&&review.reviewHash!=='0x'+'0'.repeat(64),'THOT_REVIEW_EXPIRED_REPREPARE',409);
  const current:string=await this.market.inputDigest(buyer,offer,{blockTag:block.number});
  await this.assertSnapshot(block);
  ensure(current===review.inputDigest,'THOT_REVIEW_INPUTS_CHANGED',409);
  // This produces no transaction and consumes no operator gas. The buyer funds
  // the exact reviewed offer and pays the signature-verification gas atomically.
  const signature=await signer.signTypedData(this.authorizationDomain(),THOT_REVIEW_TYPES,review);
  ensure(getAddress(verifyTypedData(this.authorizationDomain(),THOT_REVIEW_TYPES,review,signature))===reviewer,'THOT_REVIEW_SIGNATURE_INVALID');
  return signature;
 }
 async upholdExpiredDispute(id:string){
  await this.operatorTransaction('market','finalizeExpiredDispute',[id],'THOT_DISPUTE_DEFAULT_PENDING');
 }
 async purchaseSample(offer:unknown,authorization:unknown,signature:string,reviewHash:string){
  const receipt=await this.operatorTransaction('reserve','purchaseAuthorized',[offer,authorization,signature,reviewHash],'THOT_ACQUISITION_PENDING');return receipt.hash;
 }
 async finalizeAndPay(id:string,seller:string){
  await this.guard();ensure(this.operatorAvailable(),'THOT_DELIVERY_OPERATOR_REQUIRED',409);
  const o=await this.offer(id);
  ensure(getAddress(seller)===o.seller,'THOT_PAYOUT_BENEFICIARY_MISMATCH');
  if(o.status===3&&o.block.timestamp>=o.delivered_at+o.dispute_seconds)await this.operatorTransaction('market','finalize',[id],'THOT_FINALIZATION_PENDING');
  const finalized=await this.offer(id);ensure(finalized.status===5,'THOT_NOT_FINALIZED',409);
  if(BigInt((await this.account(seller)).claimable)>0n){const r=await this.operatorTransaction('market','claimFor',[seller],'THOT_PAYOUT_PENDING',id);return r.hash;}
  if(this.operatorJournal){const data=this.market.interface.encodeFunctionData('claimFor',[seller]),key=keccak256(Buffer.from(JSON.stringify([this.config.chainId,this.config.market,this.config.operatorAddress,'market','claimFor',data,id]))),entry=await this.operatorJournal.get(key);if(entry&&entry.status!=='reverted')return (await this.operatorTransaction('market','claimFor',[seller],'THOT_PAYOUT_PENDING',id)).hash;}
  return null;
 }
 async refundOverdueAndPay(id:string){
  await this.guard();ensure(this.operatorAvailable(),'THOT_DELIVERY_OPERATOR_REQUIRED',409);
  const o=await this.offer(id);
  if(o.status===1&&o.block.timestamp>o.issued_at+86400)await this.operatorTransaction('market','refundExpired',[id],'THOT_REFUND_PENDING');
  if(o.status===2&&o.block.timestamp>o.accepted_at+48*3600)await this.operatorTransaction('market','refundUndelivered',[id],'THOT_REFUND_PENDING');
  const refunded=await this.offer(id);ensure(refunded.status===6,'THOT_NOT_REFUNDED',409);
  if(BigInt((await this.account(refunded.buyer)).claimable)>0n){const r=await this.operatorTransaction('market','claimFor',[refunded.buyer],'THOT_REFUND_PAYOUT_PENDING',id);return r.hash;}
  if(this.operatorJournal){const data=this.market.interface.encodeFunctionData('claimFor',[refunded.buyer]),key=keccak256(Buffer.from(JSON.stringify([this.config.chainId,this.config.market,this.config.operatorAddress,'market','claimFor',data,id]))),entry=await this.operatorJournal.get(key);if(entry&&entry.status!=='reverted')return (await this.operatorTransaction('market','claimFor',[refunded.buyer],'THOT_REFUND_PAYOUT_PENDING',id)).hash;}
  return null;
 }
 async confirmedDispute(hash:string,id:string){
  ensure(/^0x[\da-f]{64}$/i.test(hash),'INVALID_TRANSACTION_HASH');await this.guard();
  const receipt=await this.provider.getTransactionReceipt(hash);
  ensure(receipt?.status===1&&[this.config.market.toLowerCase(),this.config.reserve.toLowerCase()].includes(receipt.to?.toLowerCase()??''),'DISPUTE_TRANSACTION_UNCONFIRMED',409);
  ensure(await this.isCanonicalBlock({number:receipt.blockNumber,hash:receipt.blockHash}),'DISPUTE_TRANSACTION_UNCONFIRMED',409);
  const events=receipt.logs.filter(log=>log.address.toLowerCase()===this.config.market.toLowerCase()).flatMap(log=>{try{const parsed=this.market.interface.parseLog(log);return parsed?.name==='Disputed'&&parsed.args.id===id?[parsed]:[];}catch{return [];}});
  ensure(events.length===1,'DISPUTE_EVENT_MISMATCH');
  return {by:getAddress(events[0]!.args.by),reason_hash:String(events[0]!.args.reasonHash),transaction_hash:hash,block:{number:receipt.blockNumber,hash:receipt.blockHash}};
 }
 close(){this.provider.destroy();}
}
