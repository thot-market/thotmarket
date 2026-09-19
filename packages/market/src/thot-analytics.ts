import {randomUUID} from 'node:crypto';
import {Contract, Interface} from 'ethers';
import {ensure, type Document, type Transaction} from '../../storage/src/index.ts';
import type {ThotChain} from '../../chain/thot.ts';
import type {Actor, ThotService} from './service.ts';

// Analytics never reads trace plaintext and never submits a transaction. The worker
// advances this confirmed-event index; HTTP reads cannot trigger a history scan.
const events=new Interface([
 'event OfferFunded(bytes32 indexed id,address indexed buyer,address indexed seller,uint256 gross,uint256 sellerAmount,address referrer,uint256 referralAmount,bool treasury,bytes32 consentDigest)',
 'event Finalized(bytes32 indexed id,uint256 sellerAmount,uint256 referralAmount,uint256 protocolAmount)',
 'event Refunded(bytes32 indexed id,address indexed buyer,uint256 amount)',
 'event Claimed(address indexed recipient,uint256 amount)',
 'event ReferralAccepted(address indexed seller,address indexed referrer,uint64 acceptedAt)',
 'event ReferralActivated(address indexed seller,uint64 firstExternalOrderAt)',
 'event Accepted(bytes32 indexed id,bytes32 indexed consentDigest)',
 'event Delivered(bytes32 indexed id,bytes32 indexed deliveryHash)',
 'event Disputed(bytes32 indexed id,address indexed by,bytes32 indexed reasonHash)',
 'event Adjudicated(bytes32 indexed id,bool refund,bytes32 indexed decisionHash)',
]);
const topics=['OfferFunded','Finalized','Refunded','Claimed','ReferralAccepted','ReferralActivated','Accepted','Delivered','Disputed','Adjudicated'].map(name=>events.getEvent(name)!.topicHash);
const allowed=(a:Actor)=>ensure(['user','buyer_admin','buyer_member','operator_security'].includes(a.role),'FORBIDDEN',403);
const lower=(v:unknown)=>String(v??'').toLowerCase();
const ZERO='0x'+'0'.repeat(40);
const atoms=(v:unknown)=>{const s=String(v??'0');ensure(/^\d{1,78}$/.test(s),'INVALID_ANALYTICS_AMOUNT');return BigInt(s);};
const mapRows=(rows:Document[])=>rows.map(r=>({...r.document,id:r.id,owner_id:r.owner_id}));
const cursor=(input:unknown)=>{if(!input)return null;ensure(typeof input==='string'&&input.length<=600,'INVALID_ANALYTICS_CURSOR');let d;try{d=JSON.parse(Buffer.from(input,'base64url').toString());}catch{ensure(false,'INVALID_ANALYTICS_CURSOR');}ensure(d&&typeof d.id==='string'&&d.id.length<=180&&typeof d.amount==='string'&&/^\d{1,78}$/.test(d.amount),'INVALID_ANALYTICS_CURSOR');return d;};
const pageLimit=(v:unknown)=>{const n=Number(v??20);ensure(Number.isSafeInteger(n)&&n>=1&&n<=50,'INVALID_ANALYTICS_LIMIT');return n;};
async function boundedMap<T,R>(items:T[],read:(item:T)=>Promise<R>):Promise<R[]>{
 const results=new Array<R>(items.length);let index=0;
 await Promise.all(Array.from({length:Math.min(items.length,4)},async()=>{for(;;){const i=index++;if(i>=items.length)return;results[i]=await read(items[i]!);}}));return results;
}

/** Descriptive cohort earnings include unsold records at zero. They are not a
 * made-up sale probability or a quote for an individual contributor. */
export function summarizeSellThrough(input:{eligible:number;sold:number;contributors:number;buyers:number;sellerAtoms:string;complete:boolean}){
 const {eligible,sold,contributors,buyers,complete}=input;
 ensure([eligible,sold,contributors,buyers].every(n=>Number.isSafeInteger(n)&&n>=0)&&sold<=eligible,'INVALID_ANALYTICS_COHORT');
 const amount=atoms(input.sellerAtoms),sufficient=complete&&eligible>=20&&contributors>=3&&buyers>=3;
 return {status:!complete?'indexing':sufficient?'observed':'insufficient_data',eligible_traces:eligible,sold_traces:sold,distinct_contributors:contributors,distinct_buyers:buyers,
  observed_sell_through_bps:sufficient?Math.floor(sold*10000/eligible):null,observed_mean_seller_proceeds_atoms:sufficient?(amount/BigInt(eligible)).toString():null,
  minimum:{traces:20,contributors:3,buyers:3},followup_days:30,
  basis:'Observed first-30-day seller proceeds per registered signed trace, including unsold traces at zero. Reviewed independent sales only; treasury, refunds and self-trades excluded. This market-wide cohort is not a personalized prediction.'};
}

export function referralPaymentBounds(referralEarned:string,otherEarned:string,pooledPaid:string){
 const referral=atoms(referralEarned),other=atoms(otherEarned),paid=atoms(pooledPaid);
 const minimum=paid>other?paid-other:0n,maximum=paid<referral?paid:referral;
 ensure(paid<=referral+other,'ANALYTICS_PAYMENT_EXCEEDS_CREDITS');
 return {paid_min_atoms:minimum.toString(),paid_max_atoms:maximum.toString(),paid_atoms:minimum===maximum?minimum.toString():null,
  unclaimed_min_atoms:(referral-maximum).toString(),unclaimed_max_atoms:(referral-minimum).toString(),
  basis:'Contract claims pool seller, referral, protocol and refund credits. Role-specific payment is exact only when the bounds coincide.'};
}

export class ThotAnalytics {
 readonly service:ThotService;readonly chain?:ThotChain;private refreshing?:Promise<Document>;
 private storageUsage?: (owner:string)=>Promise<{bytes:number;objects:number}>;
 constructor(service:ThotService,chain?:ThotChain,options:{storageUsage?:(owner:string)=>Promise<{bytes:number;objects:number}>}={}){this.service=service;this.chain=chain;this.storageUsage=options.storageUsage;}
 private get namespace(){return this.chain?`analytics:${this.chain.config.chainId}:${lower(this.chain.config.market)}:`:'analytics:unconfigured:';}
 private async put(tx:Transaction,id:string,row:Document,owner='thot-analytics'){
  const key=this.namespace+id,old=await tx.maybe('thot_records',key);
  if(old)await tx.update('thot_records',key,row);else await tx.insert('thot_records',key,owner,row);
 }
 private async wallet(actor:Actor){allowed(actor);return this.service.db.transaction(async tx=>{const w=await tx.maybe('thot_records','wallet:'+actor.id);return w?lower(w.address):null;});}
 private statusFrom(c?:Document){return {configured:!!this.chain,complete:!!c?.complete,
  from_block:this.chain?.config.deploymentBlock??null,deployment_at:c?.deployment_at??null,through_block:c?.through??null,partial_block:c?.partial_index!==undefined,target_block:c?.target??null,through_at:c?.through_at??null,updated_at:c?.updated_at??null,
  currency:'THOT',network:this.chain?.config.mode==='production'?this.chain.config.chainName:this.chain?.config.mode==='robinhood-testnet'?'Robinhood Chain Testnet':'Local Anvil',test_assets:this.chain?.config.mode!=='production',
  notice:c?.complete?'Confirmed marketplace events through the displayed block.':'History is still indexing; totals cover only the indexed blocks and are not lifetime totals.'};}
 async status(){return this.service.db.transaction(async tx=>this.statusFrom(await tx.maybe('thot_records',this.namespace+'cursor')));}
 async refresh():Promise<Document>{if(!this.chain)return {configured:false};if(this.refreshing)return this.refreshing;const run=this.refreshBatch();this.refreshing=run;try{return await run;}finally{if(this.refreshing===run)this.refreshing=undefined;}}
 private async refreshBatch(){
  const chain=this.chain!,head=await chain.snapshot(),previous=await this.service.db.transaction(tx=>tx.maybe('thot_records',this.namespace+'cursor'));
  if(previous?.through!==undefined){
   const block=await chain.provider.getBlock(previous.through);
   if(!block||lower(block.hash)!==lower(previous.hash)){
    // Rebuild only this contract's derived index; privacy choices survive reorgs.
    await this.service.db.transaction(async tx=>{await tx.sql.query("DELETE FROM thot_records WHERE id LIKE $1 AND document->>'kind' LIKE 'analytics_%' AND document->>'kind'<>'analytics_profile'",[this.namespace+'%']);});
    return {reset:true,complete:false};
   }
  }
  const from=previous?previous.through+(previous.partial_index===undefined?1:0):chain.config.deploymentBlock;
  if(from>head.number)return this.status();
  let through=Math.min(head.number,from+499),logs;
  for(;;){
   logs=await chain.provider.getLogs({address:chain.config.market,fromBlock:from,toBlock:through,topics:[topics]});
   logs=logs.filter(log=>previous?.partial_index===undefined||log.blockNumber!==previous.through||log.index>previous.partial_index).sort((a,b)=>a.blockNumber-b.blockNumber||a.index-b.index);
   if(logs.length<=32)break;
   if(through===from)break;through=from+Math.floor((through-from)/2);
  }
  // JSON-RPC paginates block ranges, not log offsets. Keep an intra-block
  // checkpoint so one busy block cannot permanently stall this index.
  const partialIndex=logs.length>32?logs[31]!.index:undefined;logs=logs.slice(0,32);
  const end=await chain.provider.getBlock(through);ensure(end?.hash,'ANALYTICS_BLOCK_UNAVAILABLE',503);
  const deploymentBlock=previous?.deployment_at?null:await chain.provider.getBlock(chain.config.deploymentBlock);
  ensure(previous?.deployment_at||deploymentBlock,'ANALYTICS_BLOCK_UNAVAILABLE',503);
  const deployed=previous?.deployment_at??new Date(deploymentBlock!.timestamp*1000).toISOString();
  const metadata=new Contract(chain.config.market,['function protocolRecipient() view returns(address)','function acquisitionVault() view returns(address)','function REFERRAL_TERM() view returns(uint256)'],chain.provider);
  // Public nonarchive RPCs retain logs but cannot execute old state. These
  // contract bindings are immutable; read them at the confirmed current head.
  const terms=previous?.terms??{protocol_recipient:lower(await metadata.protocolRecipient({blockTag:head.number})),reserve:lower(await metadata.acquisitionVault({blockTag:head.number})),referral_term_seconds:Number(await metadata.REFERRAL_TERM({blockTag:head.number}))};
  const pricingConfigured=Boolean(await chain.market.buyerPricingConfigured({blockTag:head.number}));
  const tierCount=pricingConfigured?Number(await chain.market.buyerPricingTierCount({blockTag:head.number})):0;
  ensure(Number.isSafeInteger(tierCount)&&tierCount>=0&&tierCount<=16,'ANALYTICS_PRICING_TIER_LIMIT',503);
  const pricing={configured:pricingConfigured,block:head.number,block_hash:head.hash,tiers:await boundedMap(Array.from({length:tierCount},(_,i)=>i),async i=>{const tier=await chain.market.buyerPricingTier(i,{blockTag:head.number});return {min_retained_atoms:String(tier.minRetained),surcharge_bps:Number(tier.surchargeBps)};})};
  // One offer read per funded event, capped by the same event budget. Other
  // events update the durable funding snapshot and cannot invent counterparties.
  const funding=new Map<string,Document>();
  await boundedMap(logs,async log=>{const e=events.parseLog(log);if(e?.name==='OfferFunded'){
   // The pinned ThotMarket contract assigns economic fields and `independent`
   // only in _createOffer. Compare every overlapping event field before using
   // that current-head snapshot. Never import its current mutable status.
   const o=await chain.market.offers(e.args.id,{blockTag:head.number}),a=e.args;
   ensure(lower(o.buyer)===lower(a.buyer)&&lower(o.seller)===lower(a.seller)&&lower(o.referrer)===lower(a.referrer)
    &&String(o.gross)===String(a.gross)&&String(o.sellerAmount)===String(a.sellerAmount)
    &&String(o.referralAmount)===String(a.referralAmount)&&Boolean(o.treasury)===Boolean(a.treasury),'ANALYTICS_FUNDING_SNAPSHOT_MISMATCH',503);
   funding.set(e.args.id,{buyer:lower(o.buyer),seller:lower(o.seller),referrer:lower(o.referrer),gross:String(o.gross),seller_amount:String(o.sellerAmount),referral_amount:String(o.referralAmount),seller_bps:Number(o.sellerBps),referral_bps:Number(o.referralBps),treasury:Boolean(o.treasury),independent:Boolean(o.independent),issued_at:Number(o.issuedAt)});
  }});
  const blockTimes=new Map<number,number>();
  await boundedMap([...new Set(logs.filter(log=>events.parseLog(log)?.name==='Finalized').map(log=>log.blockNumber))],async number=>{const block=await chain.provider.getBlock(number);ensure(block,'ANALYTICS_BLOCK_UNAVAILABLE',503);blockTimes.set(number,block.timestamp);});
  await chain.assertSnapshot(head);
  const canonicalEnd=await chain.provider.getBlock(through);
  ensure(canonicalEnd?.hash&&lower(canonicalEnd.hash)===lower(end.hash),'ANALYTICS_BATCH_REORG',503);
  await this.service.db.transaction(async tx=>{
   const current=await tx.maybe('thot_records',this.namespace+'cursor');ensure(current?.through===previous?.through&&current?.partial_index===previous?.partial_index,'ANALYTICS_CURSOR_CHANGED',409);
   for(const log of logs.sort((a,b)=>a.blockNumber-b.blockNumber||a.index-b.index)){
    const e=events.parseLog(log);if(!e)continue;const a=e.args,eventId=`${log.blockNumber}:${log.index}`,base={block:log.blockNumber,transaction_hash:log.transactionHash,event_index:log.index};
    if(e.name==='Claimed'){await this.put(tx,'payment:'+eventId,{kind:'analytics_payment',wallet:lower(a.recipient),amount:String(a.amount),...base});continue;}
    if(e.name==='ReferralAccepted'){await this.put(tx,'attribution:'+lower(a.seller),{kind:'analytics_attribution',seller:lower(a.seller),referrer:lower(a.referrer),accepted_at:Number(a.acceptedAt),...base});continue;}
    if(e.name==='ReferralActivated'){const attribution=await tx.maybe('thot_records',this.namespace+'attribution:'+lower(a.seller));ensure(attribution,'ANALYTICS_ATTRIBUTION_MISSING',503);await this.put(tx,'attribution:'+lower(a.seller),{...attribution,first_external_order_at:Number(a.firstExternalOrderAt)});continue;}
    const id=String(a.id),key='offer:'+id;
    if(e.name==='OfferFunded'){await this.put(tx,key,{kind:'analytics_offer',offer_id:id,...funding.get(id),status:1,...base});continue;}
    const row=await tx.maybe('thot_records',this.namespace+key);ensure(row,'ANALYTICS_FUNDING_EVENT_MISSING',503);
    if(e.name==='Finalized'){
     row.status=5;row.finalized_block=log.blockNumber;row.finalized_at=blockTimes.get(log.blockNumber);row.seller_amount=String(a.sellerAmount);row.referral_amount=String(a.referralAmount);
     for(const [role,wallet,amount] of [['seller',row.seller,a.sellerAmount],['referral',row.referrer,a.referralAmount],['protocol',row.treasury?terms.reserve:terms.protocol_recipient,a.protocolAmount]] as const){if(BigInt(amount)>0n&&wallet!==ZERO)await this.put(tx,'credit:'+eventId+':'+role,{kind:'analytics_credit',offer_id:id,role,wallet,amount:String(amount),independent:row.independent,treasury:row.treasury,...base});}
     row.protocol_amount=String(a.protocolAmount);
    }else if(e.name==='Refunded'){row.status=6;row.refund_amount=String(a.amount);await this.put(tx,'credit:'+eventId+':refund',{kind:'analytics_credit',offer_id:id,role:'refund',wallet:lower(a.buyer),amount:String(a.amount),independent:false,treasury:row.treasury,...base});}
    else if(e.name==='Accepted')row.status=2;
    else if(e.name==='Delivered')row.status=3;
    else if(e.name==='Disputed')row.status=4;
    else if(e.name==='Adjudicated'&&!a.refund)row.status=3;
    await this.put(tx,key,row);
   }
   await this.put(tx,'cursor',{kind:'analytics_cursor',through,...(partialIndex===undefined?{}:{partial_index:partialIndex}),through_at:new Date(end.timestamp*1000).toISOString(),hash:end.hash,target:head.number,complete:through===head.number&&partialIndex===undefined,deployment_at:deployed,terms,buyer_pricing:pricing,updated_at:this.service.now()});
  });return this.status();
 }
 async setProfile(actor:Actor,key:string,input:Document){
  allowed(actor);ensure(Object.keys(input).every(k=>['opted_in','label'].includes(k))&&typeof input.opted_in==='boolean','INVALID_LEADERBOARD_PROFILE');
  const label=String(input.label??'').trim();ensure(!input.opted_in||label.length>=2&&label.length<=40&&!/[\x00-\x1f\x7f]/.test(label),'INVALID_PUBLIC_LABEL');
  const wallet=await this.wallet(actor);ensure(wallet,'WALLET_REQUIRED',403);
  return this.service.db.command(actor.id,key,{action:'analyticsProfile',input},async tx=>{
   const old=await tx.maybe('thot_records',this.namespace+'profile:'+actor.id);
   const row={kind:'analytics_profile',wallet,label:input.opted_in?label:'',opted_in:input.opted_in,public_id:old?.public_id??randomUUID(),updated_at:this.service.now()};
   await this.put(tx,'profile:'+actor.id,row,actor.id);return {opted_in:row.opted_in,label:row.label};
  });
 }
 async leaderboard(actor:Actor,query:Document={}){
  allowed(actor);ensure(query.kind==='earners'||query.kind==='buyers','INVALID_LEADERBOARD_KIND');const limit=pageLimit(query.limit),after=cursor(query.cursor),seller=query.kind==='earners';
  const walletField=seller?'seller':'buyer',amountField=seller?'seller_amount':'gross';
  const {rows,index}=await this.service.db.transaction(async tx=>{const result=await tx.sql.query(`WITH totals AS (
   SELECT document->>'${walletField}' AS wallet,SUM((document->>'${amountField}')::numeric) AS amount,COUNT(*) AS sales
   FROM thot_records WHERE id LIKE $1 AND document->>'kind'='analytics_offer' AND document->>'status'='5'
   AND document->>'independent'='true' AND document->>'treasury'='false' AND document->>'seller'<>document->>'buyer' GROUP BY 1
  ) SELECT p.document->>'public_id' AS id,p.document->>'label' AS label,t.amount::text AS amount,t.sales::integer AS sales
  FROM totals t JOIN thot_records p ON p.document->>'kind'='analytics_profile' AND p.id LIKE $1 AND p.document->>'wallet'=t.wallet AND p.document->>'opted_in'='true'
  WHERE ($2::numeric IS NULL OR t.amount<$2::numeric OR (t.amount=$2::numeric AND p.document->>'public_id'>$3))
  ORDER BY t.amount DESC,p.document->>'public_id' LIMIT $4`,[this.namespace+'%',after?.amount??null,after?.id??null,limit+1]);return {rows:result.rows,index:this.statusFrom(await tx.maybe('thot_records',this.namespace+'cursor'))};});
  const items=rows.slice(0,limit),last=items.at(-1);return {kind:query.kind,items,next_cursor:rows.length>limit&&last?Buffer.from(JSON.stringify({id:last.id,amount:last.amount})).toString('base64url'):null,status:index,
   basis:seller?'Finalized seller proceeds from reviewed independent purchases.':'Finalized gross research purchases, excluding buyer surcharge.',
   exclusions:'Treasury purchases, refunds, pending/disputed orders and unreviewed purchases are excluded. Only opted-in pseudonyms appear. This is not proof of distinct beneficial owners.'};
 }
 async workspace(actor:Actor,query:Document={}):Promise<Document>{
  const wallet=await this.wallet(actor),limit=pageLimit(query.limit);ensure(query.after_id===undefined||typeof query.after_id==='string'&&query.after_id.length<=250,'INVALID_ANALYTICS_CURSOR');
  if(!wallet)return {wallet:null,status:await this.status(),profile:{opted_in:false,label:''},referrals:null};
  const result=await this.service.db.transaction(async tx=>{
   const profile=await tx.maybe('thot_records',this.namespace+'profile:'+actor.id);
   const sums=(await tx.sql.query(`SELECT
    COALESCE(SUM(CASE WHEN document->>'role'='referral' THEN (document->>'amount')::numeric ELSE 0 END),0)::text AS referral,
    COALESCE(SUM(CASE WHEN document->>'role'<>'referral' THEN (document->>'amount')::numeric ELSE 0 END),0)::text AS other
    FROM thot_records WHERE id LIKE $1 AND document->>'kind'='analytics_credit' AND document->>'wallet'=$2`,[this.namespace+'%',wallet])).rows[0];
   const paid=(await tx.sql.query("SELECT COALESCE(SUM((document->>'amount')::numeric),0)::text AS amount FROM thot_records WHERE id LIKE $1 AND document->>'kind'='analytics_payment' AND document->>'wallet'=$2",[this.namespace+'%',wallet])).rows[0].amount;
   const pending=(await tx.sql.query("SELECT COALESCE(SUM((document->>'referral_amount')::numeric),0)::text AS amount FROM thot_records WHERE id LIKE $1 AND document->>'kind'='analytics_offer' AND document->>'referrer'=$2 AND document->>'status' IN ('1','2','3','4') AND document->>'independent'='true' AND document->>'treasury'='false'",[this.namespace+'%',wallet])).rows[0].amount;
   const count=(await tx.sql.query("SELECT COUNT(*)::integer AS count FROM thot_records WHERE id LIKE $1 AND document->>'kind'='analytics_attribution' AND document->>'referrer'=$2",[this.namespace+'%',wallet])).rows[0].count;
   const attribution=await tx.maybe('thot_records',this.namespace+'attribution:'+wallet);
   const checkpoint=await tx.maybe('thot_records',this.namespace+'cursor');
   const own=(await tx.sql.query(`SELECT
    COALESCE(SUM(CASE WHEN document->>'seller'=$2 AND document->>'status'='5' AND document->>'independent'='true' AND document->>'treasury'='false' THEN (document->>'seller_amount')::numeric ELSE 0 END),0)::text AS independent_seller_atoms,
    COALESCE(SUM(CASE WHEN document->>'seller'=$2 AND document->>'status'='5' AND document->>'treasury'='true' THEN (document->>'seller_amount')::numeric ELSE 0 END),0)::text AS treasury_seller_atoms,
    COALESCE(SUM(CASE WHEN document->>'seller'=$2 AND document->>'status' IN ('1','2','3','4') THEN (document->>'seller_amount')::numeric ELSE 0 END),0)::text AS pending_seller_atoms,
    COALESCE(SUM(CASE WHEN document->>'buyer'=$2 AND document->>'status'='5' AND document->>'independent'='true' AND document->>'treasury'='false' THEN (document->>'gross')::numeric ELSE 0 END),0)::text AS independent_buyer_gross_atoms,
    COALESCE(SUM(CASE WHEN document->>'buyer'=$2 AND document->>'status'='6' THEN (document->>'refund_amount')::numeric ELSE 0 END),0)::text AS refund_credit_atoms
    FROM thot_records WHERE id LIKE $1 AND document->>'kind'='analytics_offer'`,[this.namespace+'%',wallet])).rows[0];
   const ledger=mapRows((await tx.sql.query("SELECT id,owner_id,document FROM thot_records WHERE id LIKE $1 AND document->>'kind'='analytics_credit' AND document->>'wallet'=$2 AND document->>'role'='referral' AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4",[this.namespace+'%',wallet,query.after_id??null,limit+1])).rows);
   // Protocol recipients may have additional credit roles; never assign pooled
   // claims to referrals when the indexed entitlement composition is incomplete.
   const bounds=atoms(paid)<=atoms(sums.referral)+atoms(sums.other)?referralPaymentBounds(sums.referral,sums.other,paid):{paid_atoms:null,basis:'Pooled payments include other contract credits; referral-specific payment is not independently identifiable.'};
   return {wallet,status:this.statusFrom(checkpoint),profile:{opted_in:profile?.opted_in===true,label:profile?.label??''},buyer_pricing:checkpoint?.buyer_pricing??null,own:{...own,pooled_paid_atoms:paid,indexed_pooled_unclaimed_atoms:atoms(paid)<=atoms(sums.referral)+atoms(sums.other)?String(atoms(sums.referral)+atoms(sums.other)-atoms(paid)):null},referrals:{attributed_contributors:count,my_referrer:attribution?.referrer??null,attributed_at:attribution?.accepted_at??null,first_external_order_at:attribution?.first_external_order_at??null,activation_window_seconds:90*86400,rate_bps:2000,basis_policy:'20% of frozen service fee less quoted direct costs; finalized independent purchases only',term_seconds:checkpoint?.terms?.referral_term_seconds??null,pending_atoms:pending,earned_atoms:sums.referral,pooled_paid_atoms:paid,...bounds,
    ledger:ledger.slice(0,limit).map(r=>({id:r.id,offer_id:r.offer_id,amount_atoms:r.amount,block:r.block,transaction_hash:r.transaction_hash})),next_cursor:ledger.length>limit?ledger[limit-1].id:null}};
  });return {...result,terms_source:'Use the current confirmed THOT account and contract terms; these statistics do not change the deployed rates.'};
 }
 async cohort(actor:Actor){
  allowed(actor);return this.service.db.transaction(async tx=>{const status=this.statusFrom(await tx.maybe('thot_records',this.namespace+'cursor')),now=Math.min(Date.parse(this.service.now()),Date.parse(status.through_at??this.service.now()));
  if(!status.deployment_at)return {...summarizeSellThrough({eligible:0,sold:0,contributors:0,buyers:0,sellerAtoms:'0',complete:false}),index:status};
  const from=new Date(Math.max(now-120*86400000,Date.parse(status.deployment_at))).toISOString(),to=new Date(now-30*86400000).toISOString();
  const result=await tx.sql.query(`WITH first_listings AS (
   SELECT DISTINCT ON (COALESCE(document->>'subsidy_content_fingerprint',document->>'release_content_hash',document->>'trace_id'))
    id,owner_id,COALESCE(document->>'subsidy_content_fingerprint',document->>'release_content_hash',document->>'trace_id') AS content_id,(document->>'created_at')::timestamptz AS registered_at
   FROM thot_records WHERE document->>'kind'='listing' AND document->>'signature' IS NOT NULL AND document->>'signature'<>''
    AND document->>'trace_id' IS NOT NULL AND document->'authorization'->>'buyer'=$4 AND document->>'created_at'>=$5
   ORDER BY COALESCE(document->>'subsidy_content_fingerprint',document->>'release_content_hash',document->>'trace_id'),document->>'created_at',id
  ), cohort AS (SELECT * FROM first_listings WHERE registered_at>=$2::timestamptz AND registered_at<=$3::timestamptz), sales AS (
   SELECT DISTINCT a.document->>'offer_id' AS offer_id,c.id AS listing_id,a.document->>'buyer' AS buyer,(a.document->>'seller_amount')::numeric AS amount
   FROM cohort c JOIN thot_records l ON l.document->>'kind'='listing'
    AND COALESCE(l.document->>'subsidy_content_fingerprint',l.document->>'release_content_hash',l.document->>'trace_id')=c.content_id
    AND l.document->>'created_at'>=$5
   JOIN thot_records i ON i.document->>'kind'='intent' AND i.document->>'listing_id'=l.id
   JOIN thot_records a ON a.id LIKE $1 AND a.document->>'kind'='analytics_offer' AND a.document->>'offer_id'=i.document->>'offer_id'
    AND a.document->>'status'='5' AND a.document->>'independent'='true' AND a.document->>'treasury'='false' AND a.document->>'seller'<>a.document->>'buyer'
   WHERE to_timestamp((a.document->>'finalized_at')::double precision)>=c.registered_at
    AND to_timestamp((a.document->>'finalized_at')::double precision)<=c.registered_at+INTERVAL '30 days'
  ) SELECT (SELECT COUNT(*)::integer FROM cohort) AS eligible,(SELECT COUNT(DISTINCT owner_id)::integer FROM cohort) AS contributors,
   (SELECT COUNT(DISTINCT listing_id)::integer FROM sales) AS sold,(SELECT COUNT(DISTINCT buyer)::integer FROM sales) AS buyers,
   (SELECT COALESCE(SUM(amount),0)::text FROM sales) AS amount`,[this.namespace+'%',from,to,ZERO,status.deployment_at]);
  const r=result.rows[0];return {...summarizeSellThrough({eligible:r.eligible,sold:r.sold,contributors:r.contributors,buyers:r.buyers,sellerAtoms:r.amount,complete:status.complete}),window:{registered_from:from,registered_through:to},index:status};});
 }
 async portfolio(actor:Actor,query:Document={}):Promise<Document>{
  ensure(actor.role==='user','FORBIDDEN',403);const limit=pageLimit(query.limit);ensure(query.after_id===undefined||typeof query.after_id==='string'&&query.after_id.length<=180,'INVALID_ANALYTICS_CURSOR');const after=query.after_id??null;
  const result=await this.service.db.transaction(async tx=>{
   const summary=(await tx.sql.query(`SELECT COUNT(*)::integer AS traces,
    COALESCE(SUM(CASE WHEN COALESCE(document->'capture_preview'->>'size_bytes',document->'import_preview'->>'size_bytes','0') ~ '^\\d+$' THEN COALESCE(document->'capture_preview'->>'size_bytes',document->'import_preview'->>'size_bytes','0')::numeric ELSE 0 END),0)::text AS preview_bytes
    FROM traces WHERE owner_id=$1 AND COALESCE(document->>'deleted','false')<>'true' AND document->>'retention_expires_at'>$2`,[actor.id,this.service.now()])).rows[0];
   const traces=mapRows((await tx.sql.query("SELECT id,owner_id,document FROM traces WHERE owner_id=$1 AND COALESCE(document->>'deleted','false')<>'true' AND document->>'retention_expires_at'>$2 AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4",[actor.id,this.service.now(),after,limit+1])).rows);
   const items=[];
   for(const t of traces.slice(0,limit)){
    const listed=(await tx.sql.query("SELECT EXISTS(SELECT 1 FROM thot_records WHERE owner_id=$1 AND document->>'kind'='listing' AND document->>'trace_id'=$2 AND document->>'active'='true') AS active",[actor.id,t.id])).rows[0].active;
    const sales=(await tx.sql.query("SELECT COUNT(DISTINCT a.id)::integer AS count FROM thot_records a JOIN thot_records i ON i.document->>'kind'='intent' AND i.document->>'offer_id'=a.document->>'offer_id' JOIN thot_records l ON l.id=i.document->>'listing_id' AND l.document->>'kind'='listing' WHERE a.id LIKE $1 AND a.document->>'kind'='analytics_offer' AND a.document->>'status'='5' AND l.owner_id=$2 AND l.document->>'trace_id'=$3",[this.namespace+'%',actor.id,t.id])).rows[0].count;
    const preview=t.capture_preview??t.import_preview??{};
    items.push({trace_id:t.id,source:preview.source??preview.source_label??'Uploaded trace',model:t.capture_model?.returned_model??t.capture_model?.requested_model??t.capture_model?.claimed_model??null,model_evidence:t.capture_model?.evidence??null,preview_bytes:String(preview.size_bytes??0),state:sales?'sold':listed?'listed':'private',sale_count:sales,created_at:t.created_at});
   }
   return {summary:{...summary,bytes_basis:'Recorded preview metadata sizes; may measure normalized text or request-only payloads, not full provider traffic.'},items,next_cursor:traces.length>limit?traces[limit-1].id:null,status:this.statusFrom(await tx.maybe('thot_records',this.namespace+'cursor'))};
  });const storage=this.storageUsage?await this.storageUsage(actor.id):null;
  return {...result,summary:{...result.summary,encrypted_storage_bytes:storage?.bytes??null,encrypted_storage_objects:storage?.objects??null,storage_basis:'All encrypted objects owned by your account, including source recordings and release copies.'}};
 }
}
