import {holderRewardsWorkspace,prepareHolderReward,prepareHolderPolicy} from '../../chain/thot-holder-rewards.ts';
import {stakingWorkspace,prepareStaking} from '../../chain/thot-staking.ts';
import {campaignId,campaignReserveState} from '../../chain/thot-campaigns.ts';
import {THOT_DISPUTE_REVIEW_POLICY,THOT_DISPUTE_REVIEW_AUTHORIZATION} from './thot-dispute-policy.ts';
import {ThotGovernance} from './thot-governance.ts';
import {ThotStreams,THOT_STREAM_LICENSE} from './thot-streams.ts';
import {assertCaptureSaleAuthority} from './capture-sale-policy.ts';
import type {ThotTradeEvidence} from './thot-trade-evidence.ts';
import {verifySaleSignature} from '../../chain/thot-authorizations.ts';
import {randomBytes,createHmac} from 'node:crypto';
import {getAddress, verifyMessage, verifyTypedData, TypedDataEncoder, parseUnits, ZeroAddress} from 'ethers';
import {canonicalHash, uuidv7} from '../../protocol/src/index.ts';
import {ensure, type Document, type Transaction} from '../../storage/src/index.ts';
import {ThotChain,THOT_AUTHORIZATION_TYPES,type ThotOperatorJournalEntry} from '../../chain/thot.ts';
import {type Actor, type ThotService} from './service.ts';
import {assertOperationEnabled} from './operational-controls.ts';
import {estimateThotValuation,type ThotSaleObservation} from './thot-valuations.ts';
import {THOT_TREASURY_SAMPLING_GROUP_SIZE,THOT_TREASURY_SAMPLING_POLICY,THOT_TREASURY_SAMPLING_TERMS} from './thot-sampling.ts';

const atom=(value:unknown)=>{ensure(typeof value==='string'&&/^(0|[1-9]\d{0,14})(\.\d{1,18})?$/.test(value),'INVALID_THOT_AMOUNT');const n=parseUnits(value,18);ensure(n>0n&&n<=parseUnits('1000000000',18),'INVALID_THOT_AMOUNT');return n;};
const addr=(value:unknown)=>{ensure(typeof value==='string'&&/^0x[\da-fA-F]{40}$/.test(value)&&!/^0x0{40}$/.test(value),'INVALID_WALLET');try{return getAddress(value);}catch{throw Error('INVALID_WALLET');}};
const digest=(value:unknown)=>'0x'+canonicalHash(value).replace(/^sha256:/,'').replace(/^0x/,'');
const allowed=(actor:Actor)=>ensure(['user','buyer_admin','buyer_member','operator_security'].includes(actor.role),'FORBIDDEN',403);
const withdrawnSample=(error:unknown)=>error instanceof Error&&['TREASURY_SAMPLE_UNAVAILABLE','AUTHORIZATION_UNAVAILABLE','TRADE_EVIDENCE_UNAVAILABLE','TRACE_CHANGED','TRACE_UNAVAILABLE','TRACE_INELIGIBLE','RESERVE_SOURCE_IDENTITY_UNAVAILABLE','RELEASE_EXPIRED','NOT_FOUND'].includes(error.message);
/** Independent THOT flow. Legacy cash/burn ledgers never become token claims. */
export class ThotMarketplace {
 service:ThotService; chain?:ThotChain;
 readonly readOnly:boolean;
 private processing?:Promise<void>;
 private samplingKey:Buffer;
 private reserveFingerprintKey:Buffer;
 streams?:ThotStreams;
 tradeEvidence?:ThotTradeEvidence;
 private previewActive=new Set<string>();
 private previewAttempts=new Map<string,{start:number,count:number}>();
 constructor(service:ThotService,chain?:ThotChain,previewKey:Buffer=randomBytes(32),tradeEvidence?:ThotTradeEvidence,readOnly=false){
  this.readOnly=readOnly;
  this.tradeEvidence=tradeEvidence;
  this.samplingKey=Buffer.from(previewKey);
  this.reserveFingerprintKey=createHmac('sha256',previewKey).update('thot-reserve-source-fingerprint/1').digest();
  this.service=service;this.chain=chain;if(chain)this.streams=new ThotStreams(service,chain);
  if(chain?.publicChain()){
   const owner='thot-operator:'+digest([chain.config.chainId,chain.config.market,chain.config.operatorAddress]);
   const sealJournal=service.privacy.operatorJournalWriter?.(owner);ensure(sealJournal,'THOT_JOURNAL_STORAGE_REQUIRED');
   const open=async(row:Document|undefined)=>row?await service.privacy.open(owner,row.object_ref) as ThotOperatorJournalEntry:undefined;
   chain.bindOperatorJournal({
    get:async operation=>open(await service.db.transaction(tx=>tx.maybe('thot_records',owner+':'+operation))),
    unsettled:async()=>{const rows=await service.db.transaction(tx=>tx.list('thot_records',owner));return Promise.all(rows.filter(r=>r.status==='pending').sort((a,b)=>a.nonce-b.nonce).map(async r=>(await open(r))!));},
    latest:async()=>{const rows=await service.db.transaction(tx=>tx.list('thot_records',owner));return open(rows.filter(r=>r.block).sort((a,b)=>b.nonce-a.nonce)[0]);},
    history:async()=>{const rows=await service.db.transaction(tx=>tx.list('thot_records',owner));return Promise.all(rows.map(async r=>(await open(r))!));},
    put:async entry=>service.db.transaction(async tx=>{
     const id=owner+':'+entry.operation,previous=await tx.maybe('thot_records',id);
     ensure(!previous||previous.hash===entry.hash&&previous.nonce===entry.nonce,'THOT_JOURNAL_IMMUTABLE_TRANSACTION');
     if(previous&&previous.status===entry.status&&digest(previous.block??null)===digest(entry.block??null))return;
     const rows=await tx.list('thot_records',owner);
     ensure(previous||!rows.some(r=>r.id!==id&&r.status==='pending'),'THOT_OPERATOR_TRANSACTION_PENDING',409);
     ensure(!rows.some(r=>r.id!==id&&r.nonce===entry.nonce),'THOT_OPERATOR_NONCE_CONFLICT',409);
     const row={kind:'operator_transaction',operation:entry.operation,hash:entry.hash,nonce:entry.nonce,status:entry.status,block:entry.block??null,object_ref:await sealJournal(entry)};
     if(previous)await tx.update('thot_records',id,row);else await tx.insert('thot_records',id,owner,row);
    }),
   });
  }
 }
 capabilities(){return {...(this.chain?.capabilities()??{mode:'unconfigured',version:'0.9',production_enabled:false,holding_income:false,reason:'THOT contracts are not configured. No token payments or locks are active.'}),trade_evidence:!!this.chain&&!!this.tradeEvidence?.enabled(),...(process.env.THOT_LEGACY_WORKSPACE_ORIGIN&&/^https:\/\/[a-f0-9]{40}-4318\.dstack-pha-prod5\.phala\.network$/.test(process.env.THOT_LEGACY_WORKSPACE_ORIGIN)?{legacy_workspace_origin:process.env.THOT_LEGACY_WORKSPACE_ORIGIN}:{})};}
 private enabled(){ensure(this.chain,'THOT_NOT_CONFIGURED',503);return this.chain;}
 private now(){return Date.parse(this.service.now());}
 private async wallet(tx:Transaction,actor:Actor){allowed(actor);const row=await tx.get('thot_records','wallet:'+actor.id,actor.id);return String(row.address);}
 async challenge(actor:Actor,key:string,input:Document,origin:string){
  allowed(actor);const chain=this.enabled(),address=addr(input.address);
  return this.service.db.command(actor.id,key,{action:'thotChallenge',address,origin},async tx=>{
   const id=uuidv7(),expires=this.now()+300000;
   const message=`thot market wallet link\nOrigin: ${origin}\nAccount: ${actor.id}\nAddress: ${address}\nChain ID: ${chain.config.chainId}\nMarket: ${chain.config.market}\nNonce: ${randomBytes(32).toString('hex')}\nExpires: ${new Date(expires).toISOString()}\nThis links your wallet to this account. It does not transfer or approve tokens.`;
   await tx.insert('thot_records','challenge:'+id,actor.id,{kind:'challenge',address,message,expires,used:false});
   return {id,message,expires_at:new Date(expires).toISOString()};
  });
 }
 async link(actor:Actor,key:string,input:Document){
  allowed(actor);this.enabled();ensure(typeof input.signature==='string'&&input.signature.length<=2048,'INVALID_SIGNATURE');
  return this.service.db.command(actor.id,key,{action:'thotWallet',input},async tx=>{
   const row=await tx.get('thot_records','challenge:'+input.id,actor.id);
   ensure(!row.used&&row.expires>this.now(),'WALLET_CHALLENGE_EXPIRED');
   let recovered;try{recovered=getAddress(verifyMessage(row.message,input.signature));}catch{throw Error('INVALID_SIGNATURE');}
   ensure(recovered===row.address,'WALLET_SIGNATURE_MISMATCH');
   const existing=await tx.maybe('thot_records','wallet:'+actor.id);
   ensure(!existing||existing.address===recovered,'WALLET_ALREADY_BOUND',409);
   const others=(await tx.list('thot_records')).filter(r=>r.kind==='wallet'&&r.address===recovered&&r.owner_id!==actor.id);
   ensure(!others.length,'WALLET_ALREADY_BOUND',409);
   if(!existing)await tx.insert('thot_records','wallet:'+actor.id,actor.id,{kind:'wallet',address:recovered});
   row.used=true;await tx.update('thot_records',row.id,row);await tx.audit(actor.id,'ThotWalletLinked',{address:recovered});
   return {address:recovered};
  });
 }
 async workspace(actor:Actor){
  allowed(actor);
  const records=await this.service.db.transaction(tx=>tx.list('thot_records'));
  const wallet=records.find(r=>r.id==='wallet:'+actor.id)?.address;
  const listings=records.filter(r=>r.kind==='listing'&&r.active).map(r=>this.publicListing(r));
  const own=records.filter(r=>r.kind==='listing'&&r.owner_id===actor.id).map(r=>({...this.publicListing(r),active:r.active}));
  const intents=records.filter(r=>r.kind==='intent'&&(r.owner_id===actor.id||r.seller_id===actor.id));
  // One coherent account/order snapshot per request, with bounded RPC fanout.
  const visible=intents.slice(-50),view=this.chain?await this.chain.readWorkspace(wallet,visible.map(i=>String(i.offer_id))):null;
  const orders=[];
  if(view)for(let n=0;n<visible.length;n++){const i=visible[n]!,receipt=view.offers[n]!;if(receipt.status!==0||i.owner_id===actor.id)orders.push({...this.publicIntent(i),receipt});}
  const valuations=actor.role==='user'&&this.chain&&view?await this.valuationRows(actor,records,wallet,view.block):[];
  return {holder_rewards:this.chain?await holderRewardsWorkspace(this.chain,wallet,orders.filter(o=>o.receipt.independent&&!o.receipt.treasury).map(o=>o.id)):null,staking:this.chain?await stakingWorkspace(this.chain,wallet):null,capabilities:this.capabilities(),reserve_buyer:wallet&&this.chain?await this.chain.isReserveBuyer(wallet):false,wallet:wallet??null,account:view?.account??null,listings,own_listings:own,orders,orders_truncated:intents.length>50,valuations};
 }
 private publicListing(r:Document){return {...(r.brokerage_claim?{brokerage_claim:r.brokerage_claim}:{}),id:r.id,seller:r.wallet,owner_label:'Contributor',title:r.title,price_atoms:r.price_atoms,license:r.license,license_hash:r.license_hash,evidence_hash:r.evidence_hash,provenance:r.provenance,workflow:r.workflow,turn_count:r.turn_count,capture_model:r.capture_model??null,created_at:r.created_at,automatic_sales:!!r.signature,treasury_opt_in:r.treasury_sampling_consent===THOT_TREASURY_SAMPLING_POLICY};}
 private publicIntent(r:Document){return {...(r.campaign_id?{campaign_id:r.campaign_id}:{}),...(r.selection_id?{selection_id:r.selection_id}:{}),id:r.offer_id,listing_id:r.listing_id,title:r.title,buyer:r.wallet,seller:r.seller_wallet,gross:r.gross,economics:r.economics??null,seller_gross:r.seller_gross??r.gross,buyer_surcharge:r.buyer_surcharge??'0',buyer_total:r.buyer_total??r.gross,buyer_surcharge_bps:r.buyer_surcharge_bps??0,license_hash:r.license_hash,evidence_hash:r.evidence_hash,automatic:r.automatic===true,payout_transaction:r.payout_transaction??null,refund_transaction:r.refund_transaction??null,payout_scope:'beneficiary_claimable_batch'};}
 async listingMetadata(actor:Actor,traceId:string){
  allowed(actor);ensure(actor.role==='user','FORBIDDEN',403);
  return this.service.db.transaction(async tx=>{
   const t=await tx.get('traces',traceId,actor.id);
   ensure(!t.deleted&&t.retention_expires_at>this.service.now(),'TRACE_UNAVAILABLE',410);
   const content=await this.service.privacy.open(actor.id,t.scrub_ref),p=await tx.get('provenance_receipts',t.provenance_id,actor.id);
   return {trade_evidence:await this.tradeEvidence?.list(tx,actor,traceId,digest(content))??[],trace_id:traceId,content_hash:digest(content),capture_model:t.capture_model??null,rights_status:t.rights_status,provenance:p.receipt.confidence_tier};
  });
 }
 async listTrace(actor:Actor,key:string,input:Document,streamPolicy?:Document){
  ensure(actor.role==='user','FORBIDDEN',403);const chain=this.enabled();
  ensure(input.rights_confirmed===true&&input.metadata_public===true&&input.automatic_sales===true,'EXPLICIT_AUTOMATIC_SALE_CONSENT_REQUIRED');
  ensure(input.free_preview!==true,'ORDINARY_PREVIEWS_DISABLED');
  ensure(input.treasury_opt_in!==true||input.treasury_sampling_consent===THOT_TREASURY_SAMPLING_POLICY,'TREASURY_SAMPLING_CONSENT_REQUIRED');
  ensure(typeof input.title==='string'&&input.title.length>=3&&input.title.length<=100,'INVALID_LISTING_TITLE');
  ensure(typeof input.license==='string'&&input.license.length>=30&&input.license.length<=8000,'LICENSE_REQUIRED');
  const price=atom(input.price_thot);
  const costs=await chain.market.costQuote(price);const minSellerBps=Math.max(Number(BigInt(costs.sellerAmount)*10000n/price),Number(streamPolicy?.authorization.minSellerBps??0));ensure(BigInt(costs.sellerAmount)*10000n>=price*BigInt(Math.max(minSellerBps,3000)),'PRICE_BELOW_SIGNED_RETENTION');
  return this.service.db.command(actor.id,key,{action:'thotList',input},async tx=>{
   await assertOperationEnabled(tx,'sales');const wallet=await this.wallet(tx,actor),t=await tx.get('traces',input.trace_id,actor.id);
   if(streamPolicy)await assertCaptureSaleAuthority(tx,t,this.service.now());
   ensure(!t.deleted&&t.retention_expires_at>this.service.now()&&['eligible','eligible_with_restrictions'].includes(t.rights_status),'TRACE_INELIGIBLE');
   const content=await this.service.privacy.open(actor.id,t.scrub_ref);
   ensure(input.content_hash===digest(content),'RELEASE_CHANGED',409);
   const p=(await tx.get('provenance_receipts',t.provenance_id,actor.id)).receipt,f=await tx.get('trace_features',t.trace_id,actor.id);
   // Only explicitly selected, independently verified and consented bounded evidence may be released.
   ensure(!streamPolicy||input.trade_evidence_id===undefined,'TRADE_EVIDENCE_REQUIRES_PER_RELEASE_CONSENT');
   const brokerageEvidence=await this.tradeEvidence?.attachment(tx,actor,input,t,digest(content));
   ensure(input.trade_evidence_id===undefined||brokerageEvidence,'TRADE_EVIDENCE_UNAVAILABLE');
   const retentionDays=30,block=await chain.snapshot();
   const validUntil=Math.min(block.timestamp+30*86400,Math.floor(Date.parse(t.retention_expires_at)/1000),brokerageEvidence?Math.floor(Date.parse(brokerageEvidence.summary.expires_at)/1000):Number.MAX_SAFE_INTEGER,streamPolicy?.authorization.validUntil??Number.MAX_SAFE_INTEGER);
   ensure(validUntil>block.timestamp+3600,'AUTHORIZATION_EXPIRY_TOO_SOON');
   const treasurySampling=input.treasury_opt_in===true?{policy:THOT_TREASURY_SAMPLING_POLICY,group_size:THOT_TREASURY_SAMPLING_GROUP_SIZE,release_scope:'complete_approved_release',recipients:'reserve_authorized_buyers',terms:THOT_TREASURY_SAMPLING_TERMS}:null;
   const inspectionConsented=streamPolicy?streamPolicy.dispute_review_consent===THOT_DISPUTE_REVIEW_POLICY&&streamPolicy.license===THOT_STREAM_LICENSE&&streamPolicy.authorization.licenseHash===digest(THOT_STREAM_LICENSE):input.dispute_review_consent===THOT_DISPUTE_REVIEW_POLICY;
   const disputeReview=inspectionConsented?THOT_DISPUTE_REVIEW_AUTHORIZATION:null;
   const release={...(disputeReview?{dispute_review:disputeReview}:{}),...(brokerageEvidence?{brokerage_evidence:brokerageEvidence}:{}),...(treasurySampling?{treasury_sampling:treasurySampling}:{}),...(t.capture_model?{capture_model:t.capture_model}:{}),schema_version:'thot.release/1',retention_days:retentionDays,content,provenance:{confidence_tier:p.confidence_tier,claim:'Content provenance level only; no brokerage or identity disclosure.'},license:input.license};
   const id='listing:'+uuidv7(),ref=await this.service.privacy.seal(actor.id,release);
   const authorization={seller:wallet,buyer:input.treasury_only===true?chain.config.reserve:ZeroAddress,evidenceHash:digest(release),licenseHash:digest(input.license),gross:price.toString(),minSellerBps,validUntil,nonce:'0x'+randomBytes(32).toString('hex'),maxUses:1};
   const row={kind:'listing',dispute_review_consent:disputeReview?.policy??null,...(brokerageEvidence?{trade_evidence_id:input.trade_evidence_id,brokerage_claim:brokerageEvidence.summary}:{}),...(streamPolicy?{stream_id:streamPolicy.id}:{}),capture_model:t.capture_model??null,trace_id:t.trace_id,wallet,title:input.title,price_atoms:price.toString(),license:input.license,license_hash:digest(input.license),evidence_hash:digest(release),release_content_hash:digest(content),subsidy_content_fingerprint:await this.sourceFingerprint(tx,t),provenance:p.confidence_tier,workflow:String(f.workflow_type??'unknown'),turn_count:Number(f.counts?.turns??f.turn_count??content.turns?.length??0),feature_snapshot:f,release_ref:ref,retention_days:retentionDays,authorization,treasury_sampling_consent:treasurySampling?.policy??null,provenance_status:t.provenance_status??'UNSPECIFIED',active:false,created_at:this.service.now()};
   await tx.insert('thot_records',id,actor.id,row);await tx.audit(actor.id,'ThotTraceListed',{listing_id:id,release_hash:row.evidence_hash});return {...this.publicListing({...row,id}),typed_data:TypedDataEncoder.getPayload(chain.authorizationDomain(),THOT_AUTHORIZATION_TYPES,authorization),notice:'Sign once to authorize one automatic sale at this gross price. The disclosed service tariff determines your proceeds, with at least the signed minimum retention. Holder benefits follow the configured fee policy; your minimum seller proceeds remain protected. No later acceptance is required.'};
  });
 }
 async activateListing(actor:Actor,key:string,input:Document){
  ensure(actor.role==='user','FORBIDDEN',403);const chain=this.enabled();
  ensure(typeof input.signature==='string'&&/^0x[0-9a-fA-F]+$/.test(input.signature)&&input.signature.length<=2050,'INVALID_SIGNATURE');
  return this.service.db.command(actor.id,key,{action:'thotActivate',input},async tx=>{
   const l=await tx.get('thot_records',input.id,actor.id);ensure(l.kind==='listing'&&l.authorization&&!l.signature&&!l.release_deleted_at&&(l.stream_id||Date.parse(l.created_at)+15*60*1000>this.now()),'LISTING_NOT_PREPARED');
   ensure(!l.unlisted_at,'LISTING_UNLISTED');
   await this.tradeEvidence?.assertListingCurrent(tx,l);
   if(l.stream_id){const p=await tx.get('thot_records',l.stream_id,actor.id);ensure(p.kind==='stream_policy'&&p.active&&!p.revoked&&p.authorization.validUntil>Math.floor(this.now()/1000),'STREAM_UNAVAILABLE');}
   const source=await tx.get('traces',l.trace_id,actor.id);ensure(!source.deleted&&source.retention_expires_at>this.service.now(),'TRACE_UNAVAILABLE');
   if(l.stream_id)await assertCaptureSaleAuthority(tx,source,this.service.now());
   let signer;try{signer=verifySaleSignature(chain.authorizationDomain(),THOT_AUTHORIZATION_TYPES,l.authorization,input.signature);}catch{throw Error('INVALID_SIGNATURE');}
   ensure(getAddress(signer)===l.wallet,'WALLET_SIGNATURE_MISMATCH');
   const a=await chain.authorizationState(l.wallet,l.authorization.nonce,input.signature);ensure(!a.revoked&&a.uses===0&&a.block.timestamp<l.authorization.validUntil,'AUTHORIZATION_UNAVAILABLE');
   l.signature=input.signature;l.active=true;await tx.update('thot_records',l.id,l);
   if(l.treasury_sampling_consent===THOT_TREASURY_SAMPLING_POLICY)await this.enrollTreasurySample(tx,l);
   await tx.audit(actor.id,'ThotAutomaticSalesAuthorized',{listing_id:l.id,evidence_hash:l.evidence_hash});
   return this.publicListing(l);
  });
 }
 async unlist(actor:Actor,key:string,id:string){
  const chain=this.enabled();
  return this.service.db.command(actor.id,key,{action:'thotUnlist',id},async tx=>{const r=await tx.get('thot_records',id,actor.id);ensure(r.kind==='listing','NOT_FOUND',404);r.active=false;r.unlisted_at=this.service.now();await tx.update('thot_records',id,r);return {active:false,transactions:r.authorization?[chain.transaction('market','revokeSaleAuthorization',[r.authorization.nonce])]:[],notice:'This listing is hidden. Confirm the wallet revocation to stop previously prepared but unfunded purchases too. Already funded sales remain authorized.'};});
 }
 async buyerEvidence(actor:Actor,input:Document){
  allowed(actor);const chain=this.enabled();
  ensure(Object.keys(input).every(k=>['listing_id','evaluation_only','funding_source'].includes(k))&&input.evaluation_only===true,'PREVIEW_TERMS_REQUIRED');
  ensure(input.funding_source===undefined||input.funding_source==='reserve','INVALID_FUNDING_SOURCE');
  const initial=await this.service.db.transaction(async tx=>{
   await assertOperationEnabled(tx,'sales');
   const wallet=await this.wallet(tx,actor),listing=await tx.get('thot_records',input.listing_id);
   ensure(listing.kind==='listing'&&listing.active&&listing.signature&&listing.trade_evidence_id&&!listing.release_deleted_at,'TRADE_EVIDENCE_UNAVAILABLE');
   ensure(listing.owner_id!==actor.id&&getAddress(listing.wallet)!==getAddress(wallet),'SELLER_PREVIEW_FORBIDDEN',403);
   ensure(listing.authorization&&(listing.authorization.buyer===ZeroAddress||getAddress(listing.authorization.buyer)===wallet||input.funding_source==='reserve'&&getAddress(listing.authorization.buyer)===chain.config.reserve),'BUYER_NOT_AUTHORIZED');
   ensure(getAddress(verifySaleSignature(chain.authorizationDomain(),THOT_AUTHORIZATION_TYPES,listing.authorization,listing.signature))===getAddress(listing.wallet),'WALLET_SIGNATURE_MISMATCH');
   await this.tradeEvidence?.assertListingCurrent(tx,listing);
   return {wallet,listing};
  });
  const reserve=input.funding_source==='reserve'&&await chain.isReserveBuyer(initial.wallet);
  ensure(input.funding_source!=='reserve'||reserve,'RESERVE_BUYER_REQUIRED',403);
  const state=await chain.authorizationState(initial.listing.wallet,initial.listing.authorization.nonce,initial.listing.signature);
  ensure(!state.revoked&&state.uses<initial.listing.authorization.maxUses&&state.block.timestamp<initial.listing.authorization.validUntil,'AUTHORIZATION_UNAVAILABLE');
  return this.service.db.transaction(async tx=>{
   await assertOperationEnabled(tx,'sales');
   ensure(await this.wallet(tx,actor)===initial.wallet,'WALLET_CHANGED',409);
   const listing=await tx.get('thot_records',input.listing_id);
   ensure(digest(listing)===digest(initial.listing),'PREVIEW_CHANGED',409);
   await this.tradeEvidence?.assertListingCurrent(tx,listing);
   // Proof details can contain sensitive account evidence. The selected DAO
   // sample is the sole pre-purchase plaintext path; this metadata endpoint
   // must not bypass a contributor's treasury opt-out or the 1-in-20 draw.
   return {listing_id:listing.id,release_hash:listing.evidence_hash,brokerage_claim:listing.brokerage_claim};
  });
 }
 async buyerSample(actor:Actor,input:Document){
  allowed(actor);const chain=this.enabled();
  ensure(Object.keys(input).every(k=>['listing_id','evaluation_only','funding_source'].includes(k))&&input.evaluation_only===true,'PREVIEW_TERMS_REQUIRED');
  ensure(input.funding_source==='reserve','RESERVE_BUYER_REQUIRED',403);
  // Authorization precedes the per-actor throttle, so unauthorized callers
  // cannot consume review capacity or learn whether another reviewer is active.
  const wallet=await this.service.db.transaction(tx=>this.wallet(tx,actor));
  ensure(await chain.isReserveBuyer(wallet),'RESERVE_BUYER_REQUIRED',403);
  const now=this.now();for(const [id,v] of this.previewAttempts)if(now-v.start>=60000)this.previewAttempts.delete(id);
  const attempts=this.previewAttempts.get(actor.id)??{start:now,count:0};
  ensure(attempts.count<20&&this.previewAttempts.size<2000&&!this.previewActive.has(actor.id)&&this.previewActive.size<4,'PREVIEW_RATE_LIMIT',429);
  attempts.count++;this.previewAttempts.set(actor.id,attempts);this.previewActive.add(actor.id);
  try{
   return await this.service.db.transaction(async tx=>{
    await assertOperationEnabled(tx,'sales');
    ensure(await this.wallet(tx,actor)===wallet,'WALLET_CHANGED',409);
    const l=await tx.get('thot_records',input.listing_id);
    await this.assertTreasuryListingCurrent(tx,l);
    const selection=(await tx.list('thot_records')).find(r=>r.kind==='treasury_sample_selection'&&r.listing_id===l.id);
    ensure(selection&&selection.release_hash===l.evidence_hash&&selection.content_hash===await this.contentHash(tx,l),'TREASURY_SAMPLE_NOT_SELECTED',403);
    const release=await this.service.privacy.open(l.owner_id,l.release_ref);
    ensure(digest(release)===l.evidence_hash&&release.treasury_sampling?.policy===THOT_TREASURY_SAMPLING_POLICY,'RELEASE_TAMPERED');
    await tx.audit(actor.id,'ThotTreasurySampleInspected',{listing_id:l.id,release_hash:l.evidence_hash,selection_id:selection.id});
    return {listing_id:l.id,release,release_hash:l.evidence_hash,selection_id:selection.id,policy:THOT_TREASURY_SAMPLING_POLICY,group_size:THOT_TREASURY_SAMPLING_GROUP_SIZE,asking_price_atoms:l.price_atoms,currency:'THOT',payment_required:false};
   });
  }finally{this.previewActive.delete(actor.id);}
 }
 async assay(actor:Actor,key:string,input:Document){
  allowed(actor);this.enabled();
  ensure(Object.keys(input).every(k=>['listing_id','workflow','min_turns'].includes(k)),'UNSUPPORTED_ASSAY_INPUT');
  ensure(['coding','research','investment_research','legal_research','contract_review','chat','agent','other'].includes(input.workflow),'INVALID_WORKFLOW');
  ensure(Number.isSafeInteger(input.min_turns)&&input.min_turns>=1&&input.min_turns<=1000,'INVALID_MIN_TURNS');
  return this.service.db.command(actor.id,key,{action:'thotAssay',input},async tx=>{
   const l=await tx.get('thot_records',input.listing_id);ensure(l.kind==='listing'&&l.active&&!l.release_deleted_at,'LISTING_UNAVAILABLE');
   const prior=(await tx.list('thot_records',actor.id)).filter(r=>r.kind==='assay'&&r.listing_id===l.id);
   ensure(prior.length<3,'THOT_ASSAY_QUOTA',429);
   const mandate={mandate_id:digest({buyer:actor.id,listing:l.id}),assay:{assay_id:'safe-features',version:'1',threshold:1},criteria:{workflow_types:[input.workflow],min_turns:input.min_turns}};
   const receipt=await this.service.privacy.assay({},mandate,l.trace_id,l.feature_snapshot);
   await tx.insert('thot_records','assay:'+uuidv7(),actor.id,{kind:'assay',listing_id:l.id,receipt,criteria:input});
   return {listing_id:l.id,receipt,asking_price_atoms:l.price_atoms,currency:'THOT',valuation:'Contributor asking price, not an assay-derived market estimate',execution:'Reviewed safe-features/1 isolated worker; development signature, not a TEE execution proof',checks:{workflow_matches:l.workflow===input.workflow,actual_workflow:l.workflow,actual_turns:l.turn_count,minimum_turns:input.min_turns},private_content_disclosed:false};
  });
 }
 async prepareOffer(actor:Actor,key:string,input:Document){
  allowed(actor);const chain=this.enabled();
  const prepared:Document=await this.service.db.command(actor.id,key,{action:'thotOffer',input},async tx=>{
   await assertOperationEnabled(tx,'sales');
   const ownedIntents=(await tx.list('thot_records',actor.id)).filter(r=>r.kind==='intent');
   const recent=ownedIntents.filter(r=>Date.parse(r.created_at)>this.now()-86400000);
   const campaignPurchase=chain.config.reserveCampaigns&&input.funding_source==='reserve';
   const mayResume=input.funding_source==='reserve'&&ownedIntents.some(r=>r.treasury&&r.manual_funding&&!r.unfunded_closed&&r.listing_id===input.listing_id&&(r.campaign_id??undefined)===input.campaign_id);
   const belowPreparationLimit=campaignPurchase?recent.filter(r=>r.treasury).length<1000:recent.filter(r=>!chain.config.reserveCampaigns||!r.treasury).length<10;
   ensure(mayResume||belowPreparationLimit,'THOT_DAILY_PREPARATION_LIMIT',429);
   const wallet=await this.wallet(tx,actor),l=await tx.get('thot_records',input.listing_id);
   ensure(l.kind==='listing'&&l.active&&l.signature&&l.authorization&&l.owner_id!==actor.id&&l.wallet!==wallet,'LISTING_UNAVAILABLE');
   await this.tradeEvidence?.assertListingCurrent(tx,l);
   const treasury=input.funding_source==='reserve';
   ensure(input.funding_source===undefined||treasury,'INVALID_FUNDING_SOURCE');
   if(treasury)ensure(await chain.isReserveBuyer(wallet)&&!await chain.isReserveBuyer(l.wallet),'RESERVE_BUYER_REQUIRED',403);
   const selectedCampaign=treasury&&chain.config.reserveCampaigns?campaignId(input.campaign_id).toString():undefined;
   ensure(selectedCampaign||input.campaign_id===undefined,'UNEXPECTED_CAMPAIGN_ID');
   const payer=treasury?chain.config.reserve:wallet;
   ensure(l.authorization.buyer===ZeroAddress||getAddress(l.authorization.buyer)===payer,'BUYER_NOT_AUTHORIZED');
   const authorizationState=await chain.authorizationState(l.wallet,l.authorization.nonce,l.signature);ensure(!authorizationState.revoked&&authorizationState.uses<l.authorization.maxUses&&authorizationState.block.timestamp<l.authorization.validUntil,'AUTHORIZATION_UNAVAILABLE');
   const source=await tx.get('traces',l.trace_id,l.owner_id);ensure(!source.deleted&&source.retention_expires_at>this.service.now(),'TRACE_UNAVAILABLE',410);
   const gross=BigInt(l.price_atoms),quote=await chain.purchaseQuote(payer,gross,l.wallet);
   if(treasury){
    await this.assertTreasuryListingCurrent(tx,l);
    ensure(gross<=BigInt((await chain.reserveState(selectedCampaign)).allowance),'SAMPLE_BUDGET_EXCEEDS_CURRENT_ALLOWANCE');
    const records=await tx.list('thot_records');
    const selection=records.find(r=>r.kind==='treasury_sample_selection'&&r.listing_id===l.id&&r.release_hash===l.evidence_hash);
    ensure(selection&&selection.content_hash===await this.contentHash(tx,l),'TREASURY_SAMPLE_NOT_SELECTED',403);
    await this.reserveContentHistory(tx,records);const claims=await this.contentReservations(tx,l);
    // A dismissed wallet prompt must not strand a reserved trace. Reuse the
    // original acquisition rather than create a second spendable authorization.
    const existing=records.find(r=>r.kind==='intent'&&r.owner_id===actor.id&&r.treasury&&r.manual_funding&&!r.unfunded_closed&&r.listing_id===l.id&&(r.campaign_id??undefined)===selectedCampaign&&(!selectedCampaign||getAddress(r.reserve_buyer_wallet??ZeroAddress)===getAddress(wallet)));
    if(existing){
     ensure(claims.every(c=>c.row?.status==='queued'&&c.row.offer_id===existing.offer_id),'CONTENT_ALREADY_SUBSIDIZED');
     ensure((await chain.offer(existing.offer_id)).status===0,'RESERVE_OFFER_ALREADY_FUNDED',409);
     ensure(existing.offer&&existing.review_hash&&existing.wallet===payer&&existing.gross===l.price_atoms&&existing.evidence_hash===l.evidence_hash&&existing.license_hash===l.license_hash,'RESERVE_PREPARATION_CHANGED',409);
     const transaction=chain.transaction('reserve','purchaseAuthorized',[...(selectedCampaign?[BigInt(selectedCampaign)]:[]),existing.offer,l.authorization,l.signature,existing.review_hash]);
     ensure(!existing.reserve_transaction||digest(existing.reserve_transaction)===digest(transaction),'RESERVE_PREPARATION_CHANGED',409);
     // The reserve call preserves the posted price. Service costs are quoted
     // afresh for this review and, as with a first preparation, fixed at funding.
     Object.assign(existing,{reserve_transaction:transaction,economics:quote.economics,seller_gross:quote.seller_gross,buyer_surcharge:quote.surcharge,buyer_total:quote.total,buyer_surcharge_bps:quote.surcharge_bps});
     await tx.update('thot_records',existing.id,existing);
     return {...this.publicIntent(existing),resumed:true,transactions:[transaction],notice:'Resume the same reserved purchase, offer ID and wallet transaction. No extra acquisition or content reservation is created. The contributor price and selected campaign are unchanged; service allocations are quoted again and fixed at funding.'};
    }
    ensure(claims.every(c=>!c.row||c.row.status==='released'),'CONTENT_ALREADY_SUBSIDIZED');
   }
   else ensure(quote.affordable,'BUYER_BALANCE_FOR_TOTAL_PAYMENT');
   ensure(belowPreparationLimit,'THOT_DAILY_PREPARATION_LIMIT',429);
   const nonce='0x'+randomBytes(32).toString('hex'),id=await chain.market.offerId(payer,nonce);
   const offer={id,nonce,seller:l.wallet,gross:l.price_atoms,licenseHash:l.license_hash,evidenceHash:l.evidence_hash};
   const reviewHash=digest({listing:l.id,offer,reviewer:wallet,method:'metadata-predicate-selection',...(selectedCampaign?{campaign_id:selectedCampaign}:{})});
   const review=treasury?null:await chain.reviewInput(wallet,offer,quote.economics);
   const intent={kind:'intent',offer,review_hash:reviewHash,...(review?{review_input_digest:review.inputDigest,review_valid_until:review.validUntil}:{}),...(treasury?{treasury:true,manual_funding:true,...(selectedCampaign?{campaign_id:selectedCampaign,reserve_buyer_wallet:wallet}:{}),subsidy_content_fingerprint:l.subsidy_content_fingerprint}:{}),offer_id:id,listing_id:l.id,seller_id:l.owner_id,seller_wallet:l.wallet,wallet:payer,gross:l.price_atoms,economics:quote.economics,seller_gross:quote.seller_gross,buyer_surcharge:quote.surcharge,buyer_total:quote.total,buyer_surcharge_bps:quote.surcharge_bps,title:l.title,license_hash:l.license_hash,evidence_hash:l.evidence_hash,automatic:true,created_at:this.service.now()};
   const reserveTransaction=treasury?chain.transaction('reserve','purchaseAuthorized',[...(selectedCampaign?[BigInt(selectedCampaign)]:[]),offer,l.authorization,l.signature,reviewHash]):null;
   if(reserveTransaction)Object.assign(intent,{reserve_transaction:reserveTransaction});
   await tx.insert('thot_records','intent:'+id,actor.id,intent);
   if(treasury)await this.reserveContent(tx,l,actor.id,id,'queued');
   return {...this.publicIntent(intent),...(selectedCampaign?{campaign_id:selectedCampaign}:{}),...(treasury?{}:{seller_authorization:l.authorization,seller_signature:l.signature}),transactions:treasury?[reserveTransaction!]:[chain.transaction('token','approve',[chain.config.market,BigInt(quote.total)])],notice:`You pay ${quote.total} token atoms after a buyer discount of ${quote.buyer_discount} atoms. The seller receives an independent fee reduction of ${quote.seller_discount} atoms. The base service tariff is ${quote.economics.service_fee} atoms; the seller allocation is ${quote.economics.seller_amount} atoms. Funding freezes these terms; an ordinary purchase rejects a changed reviewed tariff. Recorded delivery starts a ${Number(chain.capabilities().dispute_seconds)/3600}-hour dispute window.`};
  });
  if(input.funding_source==='reserve')return prepared;
  const intent=await this.service.db.transaction(tx=>tx.get('thot_records','intent:'+prepared.id,actor.id));
  ensure(intent.kind==='intent'&&!intent.treasury&&intent.offer&&intent.review_hash&&intent.review_input_digest&&intent.review_valid_until,'THOT_REVIEW_UNAVAILABLE',409);
  const review={inputDigest:String(intent.review_input_digest),reviewHash:String(intent.review_hash),validUntil:Number(intent.review_valid_until)};
  const reviewSignature=await chain.signIndependentReview(intent.wallet,intent.offer,review);
  const {seller_authorization,seller_signature,...publicPrepared}=prepared;
  ensure(seller_authorization&&seller_signature,'THOT_REVIEW_UNAVAILABLE',409);
  return {...publicPrepared,transactions:[...prepared.transactions,chain.transaction('market','createReviewedAuthorizedOffer',[intent.offer,seller_authorization,seller_signature,BigInt(intent.buyer_total),review,reviewSignature])]};
 }
 private async assertCampaignFunding(i:Document,o:Document){
  if(!i.treasury||!this.enabled().config.reserveCampaigns)return;
  const chain=this.enabled(),expected=campaignId(i.campaign_id),at={blockTag:o.block.number};
  const [actual,buyer]=await Promise.all([chain.reserve.acquisitionCampaign(i.offer_id,at),chain.reserve.acquisitionBuyer(i.offer_id,at)]);
  ensure(actual===expected&&typeof i.reserve_buyer_wallet==='string'&&getAddress(buyer)===getAddress(i.reserve_buyer_wallet),'ONCHAIN_CAMPAIGN_MISMATCH',409);
  await chain.assertSnapshot(o.block);
 }
 private async checked(actor:Actor,id:string){
  const chain=this.enabled();
  const data=await this.service.db.transaction(async tx=>{
   const i=await tx.get('thot_records','intent:'+id);
   const wallet=i.treasury&&i.owner_id===actor.id?chain.config.reserve:await this.wallet(tx,actor);
   ensure(i.owner_id===actor.id||i.seller_id===actor.id,'NOT_FOUND',404);
   const l=await tx.get('thot_records',i.listing_id);
   return {wallet,i,l};
  });
  const o=await chain.offer(id);
  ensure(o.status!==0,'OFFER_NOT_CONFIRMED',409);
  ensure(o.buyer===data.i.wallet&&o.seller===data.i.seller_wallet&&o.gross===data.i.gross&&o.seller_gross===(data.i.seller_gross??data.i.gross)&&o.buyer_surcharge===(data.i.buyer_surcharge??'0')&&o.buyer_total===(data.i.buyer_total??data.i.gross)&&o.license_hash===data.i.license_hash&&o.evidence_hash===data.i.evidence_hash,'ONCHAIN_OFFER_MISMATCH',409);
  await this.assertCampaignFunding(data.i,o);
  return {...data,o};
 }
 async reviewOffer(actor:Actor,id:string){
  const {i,l,o}=await this.checked(actor,id);ensure(i.seller_id===actor.id,'FORBIDDEN',403);
  ensure(!l.release_deleted_at,'RELEASE_EXPIRED',410);
  const release=await this.service.privacy.open(actor.id,l.release_ref);ensure(digest(release)===o.evidence_hash,'RELEASE_TAMPERED');
  return {receipt:o,release,license:l.license,transaction:!i.automatic&&o.status===1?this.enabled().transaction('market','acceptOffer',[id,o.quote_digest]):null};
 }
 async delivery(actor:Actor,id:string){
  const checked=await this.checked(actor,id);const {i,l}=checked;let o=checked.o;ensure(i.owner_id===actor.id,'FORBIDDEN',403);
  ensure([2,3,4,5].includes(o.status),'DELIVERY_NOT_AUTHORIZED',409);
  ensure(!this.readOnly||o.status!==2,'THOT_READ_ONLY',403);
  ensure(!l.release_deleted_at&&o.block.timestamp<o.accepted_at+(l.retention_days??30)*86400,'LICENSE_RETENTION_EXPIRED',410);
  ensure(o.status!==2||o.block.timestamp<=o.accepted_at+48*3600,'DELIVERY_OVERDUE',410);
  await this.service.db.transaction(tx=>assertOperationEnabled(tx,'deliveries'));
  const release=await this.service.privacy.open(l.owner_id,l.release_ref);ensure(digest(release)===o.evidence_hash,'RELEASE_TAMPERED');
  if(o.status===2){
   // Persist the exact encrypted artifact job before the external transaction. On retry,
   // confirmed onchain state wins; plaintext is withheld until delivery is recorded.
   await this.service.db.transaction(async tx=>{
    const key='delivery:'+id;if(!await tx.maybe('thot_records',key))await tx.insert('thot_records',key,i.owner_id,{kind:'delivery_job',offer_id:id,release_hash:o.evidence_hash,listing_id:l.id,status:'pending',created_at:this.service.now()});
   });
   await this.enabled().acknowledgeAvailability(id,o.evidence_hash);
   o=(await this.checked(actor,id)).o;
  }
  ensure([3,4,5].includes(o.status)&&o.delivery_hash===digest(release),'THOT_DELIVERY_ACK_PENDING',409);
  await this.service.db.transaction(async tx=>{
   const job=await tx.maybe('thot_records','delivery:'+id);if(job){job.status='confirmed';job.block=o.block.number;await tx.update('thot_records',job.id,job);}
   await tx.audit(actor.id,'ThotDeliveryRetrieved',{offer_id:id,release_hash:o.evidence_hash,block:o.block.number});
  });
  const buyerRelease=i.treasury?release:((({brokerage_evidence:_privateProof,...licensed})=>licensed)(release));
  return {receipt:o,release:buyerRelease,delivery_hash:o.evidence_hash,acknowledgment:null,notice:`The operator attests this committed release is available. This does not prove the buyer read it. The ${o.dispute_seconds/3600}-hour dispute window protects delivery disputes. Undisputed sales finalize and pay automatically when the settlement worker confirms the deadline.`};
 }
 async cleanupTrace(tx:Transaction,traceId:string){
  const records=await tx.list('thot_records'),source=await tx.get('traces',traceId);
  let retained=0;
  if(source.deleted||source.retention_expires_at<=this.service.now())await this.tradeEvidence?.cleanup(tx,traceId);
  for(const l of records.filter(r=>r.kind==='listing'&&r.trace_id===traceId&&!r.release_deleted_at)){
   const sourceLive=!source.deleted&&source.retention_expires_at>this.service.now();
   if(!sourceLive)l.active=false;
   let keep=sourceLive&&l.active;
   if(l.signature&&l.authorization){
    const a=await this.enabled().authorizationState(l.wallet,l.authorization.nonce,l.signature);
    const usable=!a.revoked&&a.uses<l.authorization.maxUses&&a.block.timestamp<l.authorization.validUntil;
    if(!usable)l.active=false;
    keep=sourceLive&&usable;
   }else if(sourceLive&&Date.parse(l.created_at)+15*60*1000>this.now())keep=true;
   for(const i of records.filter(r=>r.kind==='intent'&&r.listing_id===l.id)){
    // If RPC is unavailable cleanup fails closed and retries, rather than deleting paid material.
    const o=await this.enabled().offer(i.offer_id);
    if(o.status===1&&o.block.timestamp<=o.issued_at+86400)keep=true;
    if([2,3,4,5].includes(o.status)&&o.block.timestamp<o.accepted_at+(l.retention_days??30)*86400)keep=true;
   }
   if(records.some(r=>r.kind==='treasury_sample_selection'&&r.listing_id===l.id&&r.release_hash===l.evidence_hash)&&sourceLive)keep=true;
   if(!keep){await this.service.privacy.remove(l.owner_id,l.release_ref);l.release_deleted_at=this.service.now();delete l.release_ref;}
   else retained++;
   await tx.update('thot_records',l.id,l);
  }
  return retained;
 }
 private async valuationRows(actor:Actor,records:Document[],wallet:string|undefined,block:Awaited<ReturnType<ThotChain['snapshot']>>){
  // Reuse this request's guarded account/order snapshot. Each observation still
  // checks its anchor and revalidates that snapshot; nothing survives a request.
  // Old or reorganized observations cannot remain evidence for a visible estimate.
  const observations:ThotSaleObservation[]=[],anchors=new Map<string,boolean>();
  for(const row of records.filter(r=>r.kind==='sale_observation').slice(-500)){
   const anchor=row.confirmation_block;if(!anchor)continue;
   const key=String(anchor.number)+':'+String(anchor.hash);
   if(!anchors.has(key))anchors.set(key,await this.enabled().isCanonicalBlock(anchor,block));
   if(anchors.get(key))observations.push(row.observation as ThotSaleObservation);
  }
  const targets=await this.service.db.transaction(async tx=>{
   const traces=(await tx.list('traces',actor.id)).filter(t=>!t.deleted).slice(-50),rows=[];
   for(const t of traces){
    const f=await tx.maybe('trace_features',t.trace_id),p=t.provenance_id?await tx.maybe('provenance_receipts',t.provenance_id):null;
    rows.push({id:t.trace_id,owner_id:actor.id,wallet:wallet??'',workflow:String(f?.workflow_type??'unknown'),provenance:String(p?.receipt?.confidence_tier??'unknown'),provenance_status:String(t.provenance_status??'UNSPECIFIED'),turn_count:Number(f?.counts?.turns??f?.turn_count??0),eligible:['eligible','eligible_with_restrictions'].includes(t.rights_status)});
   }
   return rows;
  });
  return Promise.all(targets.map(async target=>({trace_id:target.id,estimate:await estimateThotValuation(target,observations,{now:block.timestamp*1000})})));
 }
 async prepareGovernance(actor:Actor,input:Document){
  const wallet=await this.service.db.transaction(tx=>this.wallet(tx,actor));
  const prepared=await new ThotGovernance(this.enabled()).prepare(wallet,input);
  const review:Document=prepared.review;
  const policy=review?.policy,policyHash=review?.policy_hash;
  if(policy&&policyHash)await this.service.db.transaction(async tx=>{
   const id='campaign-policy:'+policyHash;
   if(!await tx.maybe('thot_records',id))await tx.insert('thot_records',id,actor.id,{kind:'campaign_policy',policy_hash:policyHash,policy,created_at:this.service.now()});
  });
  return prepared;
 }
 private async assertTreasuryListingCurrent(tx:Transaction,l:Document){
  ensure(l.kind==='listing'&&l.active&&l.signature&&l.authorization&&!l.unlisted_at&&!l.release_deleted_at&&l.release_ref&&l.treasury_sampling_consent===THOT_TREASURY_SAMPLING_POLICY,'TREASURY_SAMPLE_UNAVAILABLE',410);
  const source=await tx.get('traces',l.trace_id,l.owner_id);
  ensure(!source.deleted&&source.retention_expires_at>this.service.now()&&['eligible','eligible_with_restrictions'].includes(source.rights_status),'TREASURY_SAMPLE_UNAVAILABLE',410);
  ensure(source.scrub_ref&&digest(await this.service.privacy.open(l.owner_id,source.scrub_ref))===await this.contentHash(tx,l),'TREASURY_SAMPLE_UNAVAILABLE',410);
  ensure(await this.reserveFingerprint(tx,l)===await this.sourceFingerprint(tx,source),'TREASURY_SAMPLE_UNAVAILABLE',410);
  if(l.stream_id){
   const policy=await tx.get('thot_records',l.stream_id,l.owner_id);
   ensure(policy.kind==='stream_policy'&&policy.active&&!policy.revoked&&policy.treasury_sampling_consent===THOT_TREASURY_SAMPLING_POLICY&&policy.authorization.validUntil>Math.floor(this.now()/1000),'TREASURY_SAMPLE_UNAVAILABLE',410);
  }
  await this.tradeEvidence?.assertListingCurrent(tx,l);
  ensure(getAddress(verifySaleSignature(this.enabled().authorizationDomain(),THOT_AUTHORIZATION_TYPES,l.authorization,l.signature))===getAddress(l.wallet),'WALLET_SIGNATURE_MISMATCH');
  const state=await this.enabled().authorizationState(l.wallet,l.authorization.nonce,l.signature);
  ensure(!state.revoked&&state.uses<l.authorization.maxUses&&state.block.timestamp<l.authorization.validUntil,'AUTHORIZATION_UNAVAILABLE',410);
 }
 async samplingWorkspace(actor:Actor,cursor?:string){
  allowed(actor);const chain=this.enabled();
  if(!chain.config.manualReserve)ensure(actor.role==='operator_security','FORBIDDEN',403);
  const wallet=await this.service.db.transaction(async tx=>(await tx.maybe('thot_records','wallet:'+actor.id))?.address??(!chain.config.manualReserve?(chain.config.localDeliverySigner??chain.config.operatorAddress):await this.wallet(tx,actor)));
  const reserveBuyer=await chain.isReserveBuyer(wallet),governance=chain.config.manualReserve?await new ThotGovernance(chain).workspace(wallet):null;
  if(chain.config.manualReserve)ensure(reserveBuyer||governance?.owner,'RESERVE_BUYER_OR_GOVERNANCE_OWNER_REQUIRED',403);
  const reserve=chain.config.reserveCampaigns?await campaignReserveState(chain,{cursor}):await chain.reserveState();
  const allRecords=await this.service.db.transaction(tx=>tx.list('thot_records'));
  if(chain.config.reserveCampaigns)for(const campaign of reserve.campaigns){const policy=allRecords.find(r=>r.kind==='campaign_policy'&&r.policy_hash===campaign.policy_hash);if(policy)campaign.policy_name=policy.policy.purpose;}
  const records=allRecords.filter(r=>r.owner_id===actor.id);
  const batches=records.filter(r=>r.kind==='sampling_batch').slice(-20).map(r=>({id:r.id,policy:r.policy,sample_count:r.sample_count,gross:r.gross,created_at:r.created_at,inventory_commitment:r.inventory_commitment,seed:r.seed}));
  const jobs=[];
  for(const i of records.filter(r=>r.kind==='intent'&&r.treasury).slice(-50)){
   const receipt=await this.enabled().offer(i.offer_id);
   jobs.push({...this.publicIntent(i),status:i.job_status??null,error:i.last_error??null,receipt,resume_available:reserveBuyer&&i.manual_funding===true&&!i.unfunded_closed&&receipt.status===0});
  }
  const samples=[];
  for(const selection of reserveBuyer?allRecords.filter(r=>r.kind==='treasury_sample_selection'):[]){
   const listing=allRecords.find(r=>r.id===selection.listing_id&&r.kind==='listing');
   if(!listing||listing.evidence_hash!==selection.release_hash||listing.release_content_hash!==selection.content_hash)continue;
   try{await this.service.db.transaction(tx=>this.assertTreasuryListingCurrent(tx,listing));}
   catch(error){if(withdrawnSample(error))continue;throw error;}
   samples.push({...this.publicListing(listing),selection_id:selection.id,group_index:selection.group_index,policy:selection.policy});
  }
  return {capabilities:this.capabilities(),reserve,...(chain.config.reserveCampaigns?reserve:{}),wallet,governance,reserve_buyer:reserveBuyer,batches,jobs,samples,notice:'The reserve pays for explicitly authorized purchases. Authorized reserve reviewers share each persisted one-in-20 contributor sample; ordinary buyers receive content only after purchase.'};
 }
 private async enrollTreasurySample(tx:Transaction,l:Document){
  await this.assertTreasuryListingCurrent(tx,l);
  const release=await this.service.privacy.open(l.owner_id,l.release_ref);
  ensure(digest(release)===l.evidence_hash&&digest(release.content)===l.release_content_hash&&release.treasury_sampling?.policy===THOT_TREASURY_SAMPLING_POLICY,'RELEASE_TAMPERED');
  const sourceFingerprint=await this.reserveFingerprint(tx,l);
  const eligibilityId='treasury-eligible:'+digest(l.id);
  if(!await tx.maybe('thot_records',eligibilityId))await tx.insert('thot_records',eligibilityId,l.owner_id,{kind:'treasury_sample_eligibility',policy:THOT_TREASURY_SAMPLING_POLICY,contributor_id:l.owner_id,source_fingerprint:sourceFingerprint,trace_id:l.trace_id,listing_id:l.id,release_hash:l.evidence_hash,content_hash:l.release_content_hash,created_at:this.service.now()});
  const records=await tx.list('thot_records');
  const eligibilities=records.filter(r=>r.kind==='treasury_sample_eligibility'&&r.policy===THOT_TREASURY_SAMPLING_POLICY).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id));
  const selections=records.filter(r=>r.kind==='treasury_sample_selection'&&r.policy===THOT_TREASURY_SAMPLING_POLICY);
  const covered=new Set<string>(),usedSources=new Set<string>(),usedReleases=new Set<string>();
  for(const selection of selections){
   const legacyMembers=eligibilities.filter(r=>r.contributor_id===selection.contributor_id&&Number(r.eligible_index)>=Number(selection.group_index)*THOT_TREASURY_SAMPLING_GROUP_SIZE&&Number(r.eligible_index)<(Number(selection.group_index)+1)*THOT_TREASURY_SAMPLING_GROUP_SIZE);
   for(const member of selection.member_listing_ids?.map((id:string)=>eligibilities.find(r=>r.listing_id===id)).filter(Boolean)??legacyMembers){covered.add(member.listing_id);usedSources.add(member.source_fingerprint);usedReleases.add(member.content_hash);}
   covered.add(selection.listing_id);usedReleases.add(selection.content_hash);
  }
  const members:Document[]=[];
  for(const row of eligibilities){
   if(covered.has(row.listing_id)||usedSources.has(row.source_fingerprint)||usedReleases.has(row.content_hash))continue;
   const listing=records.find(r=>r.kind==='listing'&&r.id===row.listing_id);
   if(!listing||listing.evidence_hash!==row.release_hash||listing.release_content_hash!==row.content_hash||listing.subsidy_content_fingerprint!==row.source_fingerprint)continue;
   try{await this.assertTreasuryListingCurrent(tx,listing);}
   catch(error){if(withdrawnSample(error))continue;throw error;}
   usedSources.add(row.source_fingerprint);usedReleases.add(row.content_hash);
   if(row.contributor_id!==l.owner_id)continue;
   members.push(row);
   if(members.length===THOT_TREASURY_SAMPLING_GROUP_SIZE)break;
  }
  if(members.length!==THOT_TREASURY_SAMPLING_GROUP_SIZE)return;
  const groupIndex=selections.filter(r=>r.contributor_id===l.owner_id).reduce((max,r)=>Math.max(max,Number(r.group_index)+1),0);
  const inventory=members.map(r=>({trace_id:r.trace_id,listing_id:r.listing_id,release_hash:r.release_hash,content_hash:r.content_hash}));
  const inventoryCommitment=digest(inventory);
  const random=createHmac('sha256',this.samplingKey).update(THOT_TREASURY_SAMPLING_POLICY+'\0'+l.owner_id+'\0'+groupIndex+'\0'+inventoryCommitment).digest();
  const selected=members[Number(random.readBigUInt64BE(0)%BigInt(THOT_TREASURY_SAMPLING_GROUP_SIZE))]!;
  const selectionId='treasury-selection:'+digest([l.owner_id,groupIndex,inventoryCommitment,THOT_TREASURY_SAMPLING_POLICY]);
  await tx.insert('thot_records',selectionId,selected.contributor_id,{kind:'treasury_sample_selection',policy:THOT_TREASURY_SAMPLING_POLICY,contributor_id:selected.contributor_id,group_index:groupIndex,inventory_commitment:inventoryCommitment,member_listing_ids:members.map(r=>r.listing_id),listing_id:selected.listing_id,trace_id:selected.trace_id,release_hash:selected.release_hash,content_hash:selected.content_hash,selected_at:this.service.now()});
  await tx.audit(l.owner_id,'ThotTreasurySampleSelected',{selection_id:selectionId,group_index:groupIndex,release_hash:selected.release_hash,inventory_commitment:inventoryCommitment});
 }
 private async contentHash(tx:Transaction,l:Document){
  if(typeof l.release_content_hash==='string')return l.release_content_hash;
  ensure(!l.release_deleted_at&&l.release_ref,'RELEASE_EXPIRED');
  const release=await this.service.privacy.open(l.owner_id,l.release_ref);ensure(digest(release)===l.evidence_hash,'RELEASE_TAMPERED');
  l.release_content_hash=digest(release.content);await tx.update('thot_records',l.id,l);return String(l.release_content_hash);
 }
 private async sourceFingerprint(tx:Transaction,t:Document){
  // Raw normalized content remains private. A domain-separated HMAC prevents
  // trace-specific PII aliases, wallet changes, titles or licences resetting subsidy identity.
  ensure(t.raw_ref&&!t.deleted,'RESERVE_SOURCE_IDENTITY_UNAVAILABLE');
  const refHash=digest(t.raw_ref);
  if(t.subsidy_fingerprint_ref===refHash&&/^0x[0-9a-f]{64}$/.test(t.subsidy_content_fingerprint??''))return String(t.subsidy_content_fingerprint);
  const raw=await this.service.privacy.open(t.owner_id,t.raw_ref);
  ensure(Array.isArray(raw.turns)&&raw.turns.length>0,'RESERVE_SOURCE_IDENTITY_UNAVAILABLE');
  const fingerprint='0x'+createHmac('sha256',this.reserveFingerprintKey).update(canonicalHash(raw)).digest('hex');
  t.subsidy_content_fingerprint=fingerprint;t.subsidy_fingerprint_ref=refHash;await tx.update('traces',t.id,t);return fingerprint;
 }
 private async reserveFingerprint(tx:Transaction,l:Document){
  if(/^0x[0-9a-f]{64}$/.test(l.subsidy_content_fingerprint??''))return String(l.subsidy_content_fingerprint);
  // Legacy rows may be backfilled only while their matching source is retained.
  // Never guess a source identity from a newer edit or an already deleted trace.
  const trace=await tx.get('traces',l.trace_id,l.owner_id);
  ensure(!trace.deleted&&trace.scrub_ref,'RESERVE_SOURCE_IDENTITY_UNAVAILABLE');
  const current=await this.service.privacy.open(l.owner_id,trace.scrub_ref);
  ensure(digest(current)===await this.contentHash(tx,l),'RESERVE_SOURCE_IDENTITY_UNAVAILABLE');
  l.subsidy_content_fingerprint=await this.sourceFingerprint(tx,trace);await tx.update('thot_records',l.id,l);return String(l.subsidy_content_fingerprint);
 }
 private async contentReservations(tx:Transaction,l:Document){
  const source=await this.reserveFingerprint(tx,l),released=await this.contentHash(tx,l);
  // Keep both invariants: matching raw sources survive different PII aliases;
  // matching licensed releases survive edits to excluded, unlicensed content.
  const ids=['sampling-content:'+source,'sampling-release:'+released];
  return Promise.all(ids.map(async id=>({id,row:await tx.maybe('thot_records',id)})));
 }
 private async reserveContent(tx:Transaction,l:Document,owner:string,offerId:string,status:'queued'|'committed'){
  for(const c of await this.contentReservations(tx,l)){
   if(status==='queued')ensure(!c.row||c.row.status==='released'||c.row.offer_id===offerId&&c.row.status==='queued','CONTENT_ALREADY_SUBSIDIZED');
   const row={kind:'sampling_content',offer_id:offerId,status};
   if(c.row)await tx.update('thot_records',c.id,row);else await tx.insert('thot_records',c.id,owner,row);
  }
 }
 private async reserveContentHistory(tx:Transaction,records:Document[]){
  // Backfill pre-deduplication local jobs. The reservation is global across listings,
  // contributors, prices and licences; successful funding is never eligible again.
  for(const i of records.filter(r=>r.kind==='intent'&&r.treasury&&!r.unfunded_closed)){
   const l=records.find(r=>r.id===i.listing_id);if(!l)continue;
   // Retained legacy funded history must be migrated before further subsidies.
   // Missing source identity fails closed instead of silently reopening eligibility.
   const claims=await this.contentReservations(tx,l);
   if(!i.subsidy_content_fingerprint){i.subsidy_content_fingerprint=l.subsidy_content_fingerprint;await tx.update('thot_records',i.id,i);}
   for(const c of claims)if(!c.row)await tx.insert('thot_records',c.id,i.owner_id,{kind:'sampling_content',offer_id:i.offer_id,status:i.job_status==='complete'||i.funding_confirmed?'committed':'queued'});
  }
 }
 async queueSamples(actor:Actor,key:string,input:Document){
  ensure(!this.chain?.config.manualReserve,'USE_RESERVE_BUYER_PURCHASES');
  ensure(actor.role==='operator_security','FORBIDDEN',403);const chain=this.enabled();
  ensure(Number.isSafeInteger(input.max_samples)&&input.max_samples>=1&&input.max_samples<=20,'INVALID_SAMPLE_COUNT');
  const budget=atom(input.max_gross_thot),ceiling=atom(input.price_ceiling_thot);
  ensure(budget<=parseUnits('1000000',18),'SAMPLE_BUDGET_TOO_LARGE');
  ensure(input.workflow===undefined||['coding','research','investment_research','legal_research','contract_review','chat','agent','other'].includes(input.workflow),'INVALID_WORKFLOW');
  return this.service.db.command(actor.id,key,{action:'thotSamples',input},async tx=>{
   await assertOperationEnabled(tx,'sales');const reserve=await chain.reserveState();
   ensure(budget<=BigInt(reserve.allowance),'SAMPLE_BUDGET_EXCEEDS_CURRENT_ALLOWANCE');
   const records=await tx.list('thot_records');
   await this.reserveContentHistory(tx,records);
   const reserved=new Set(records.filter(r=>r.kind==='intent'&&r.treasury&&r.automatic&&!['blocked','complete'].includes(r.job_status)).map(r=>r.listing_id));
   const eligible:{listing:Document,selection:Document}[]=[];
   const selections=records.filter(r=>r.kind==='treasury_sample_selection'&&r.policy===THOT_TREASURY_SAMPLING_POLICY).sort((a,b)=>String(a.contributor_id).localeCompare(String(b.contributor_id))||Number(a.group_index)-Number(b.group_index)||a.id.localeCompare(b.id));
   for(const selection of selections){
    const l=records.find(r=>r.kind==='listing'&&r.id===selection.listing_id);
    if(!l||reserved.has(l.id)||l.evidence_hash!==selection.release_hash||l.release_content_hash!==selection.content_hash||BigInt(l.price_atoms)>ceiling||(input.workflow&&l.workflow!==input.workflow))continue;
    if(!l.authorization||l.authorization.buyer!==ZeroAddress&&getAddress(l.authorization.buyer)!==chain.config.reserve)continue;
    try{await this.assertTreasuryListingCurrent(tx,l);}
    catch(error){if(withdrawnSample(error))continue;throw error;}
    const claims=await this.contentReservations(tx,l);
    if(claims.some(c=>c.row&&c.row.status!=='released'))continue;
    eligible.push({listing:l,selection});
   }
   const inventory=eligible.map(({listing:l,selection})=>({selection_id:selection.id,contributor_id:selection.contributor_id,group_index:selection.group_index,listing_id:l.id,evidence_hash:l.evidence_hash,content_hash:selection.content_hash,gross:l.price_atoms}));
   const inventoryCommitment=digest(inventory);
   const selected:{listing:Document,selection:Document}[]=[],sources=new Set(),releases=new Set();let gross=0n;
   for(const candidate of eligible){const l=candidate.listing;if(selected.length>=input.max_samples)break;if(sources.has(l.subsidy_content_fingerprint)||releases.has(l.release_content_hash)||gross+BigInt(l.price_atoms)>budget)continue;selected.push(candidate);sources.add(l.subsidy_content_fingerprint);releases.add(l.release_content_hash);gross+=BigInt(l.price_atoms);}
   ensure(selected.length>0,'NO_ELIGIBLE_SAMPLES',409);
   const batchId='sampling:'+uuidv7(),policy={sampling_policy:THOT_TREASURY_SAMPLING_POLICY,group_size:THOT_TREASURY_SAMPLING_GROUP_SIZE,max_samples:input.max_samples,max_gross_thot:input.max_gross_thot,price_ceiling_thot:input.price_ceiling_thot,workflow:input.workflow??null,purpose:'Optional reserve purchase of persisted one-in-20 review selections under each signed listing licence',selection:'Only persisted per-contributor selections are eligible. Queueing never draws or redraws a release.',deduplication:'At most one funded treasury purchase per private normalized-source fingerprint or licensed release, including refunded purchases; wallet, title, licence, price and trace-specific PII aliases do not reset eligibility.'};
   await tx.insert('thot_records',batchId,actor.id,{kind:'sampling_batch',policy,sample_count:selected.length,gross:gross.toString(),inventory_commitment:inventoryCommitment,inventory,seed:null,created_at:this.service.now()});
   const jobs=[];
   for(const {listing:l,selection} of selected){
    const nonce='0x'+randomBytes(32).toString('hex'),id=await chain.market.offerId(chain.config.reserve,nonce);
    const offer={id,nonce,seller:l.wallet,gross:l.price_atoms,licenseHash:l.license_hash,evidenceHash:l.evidence_hash};
    const intent={kind:'intent',offer_id:id,listing_id:l.id,selection_id:selection.id,seller_id:l.owner_id,seller_wallet:l.wallet,wallet:chain.config.reserve,gross:l.price_atoms,title:l.title,license_hash:l.license_hash,evidence_hash:l.evidence_hash,subsidy_content_fingerprint:l.subsidy_content_fingerprint,automatic:true,treasury:true,job_status:'queued',offer,review_hash:digest({batchId,policy,inventoryCommitment,selection_id:selection.id,listing:l.id,offer}),batch_id:batchId,created_at:this.service.now()};
    await tx.insert('thot_records','intent:'+id,actor.id,intent);jobs.push(this.publicIntent(intent));
    await this.reserveContent(tx,l,actor.id,id,'queued');
   }
   await tx.audit(actor.id,'ThotSamplingQueued',{batch_id:batchId,sample_count:selected.length,gross:gross.toString(),inventory_commitment:inventoryCommitment});
   return {id:batchId,sample_count:selected.length,gross:gross.toString(),jobs,notice:`Queued for reserve funding. A funded sample is automatically accepted under its signed licence; its undisputed payout follows ${Number(chain.capabilities().dispute_seconds)/3600} hour(s) after recorded delivery.`};
  });
 }

 async prepareStream(actor:Actor,input:Document){ensure(this.streams,'THOT_NOT_CONFIGURED',503);return this.streams.prepare(actor,input);}
 async activateStream(actor:Actor,id:string,signature:string){ensure(this.streams,'THOT_NOT_CONFIGURED',503);return this.streams.activate(actor,id,signature);}
 async listStreams(actor:Actor){ensure(this.streams,'THOT_NOT_CONFIGURED',503);return this.streams.list(actor);}
 async revokeStream(actor:Actor,id:string){ensure(this.streams,'THOT_NOT_CONFIGURED',503);return this.streams.revoke(actor,id);}
 private async offerCompletedStreams(){
  if(!this.chain?.config.streamSales||!this.streams)return;
  const traces=await this.service.db.transaction(async tx=>(await tx.sql.query("SELECT id, owner_id, document FROM traces WHERE document ? 'sale_policy_id' AND document->>'capture_state'='COMPLETED' AND document->>'deleted' IS DISTINCT FROM 'true' AND document->>'stream_offer_status' IS NULL AND (NOT(document ? 'capture_device_id') OR (document->'projection'->>'status'='READY' AND document->'release_preparation'->>'status'='READY')) ORDER BY created_at LIMIT 20")).rows.map(r=>({...r.document,id:r.id,owner_id:r.owner_id})));
  for(const t of traces){
   const actor:Actor={id:t.owner_id,role:'user'};
   try{
    await this.service.db.transaction(tx=>assertCaptureSaleAuthority(tx,t,this.service.now()));
    const policy=await this.streams.policy(actor,t.sale_policy_id);
    const prepared=await this.listingMetadata(actor,t.trace_id);
    const source=t.openrouter_request_id?'OpenRouter':t.capture_model?.source??t.capture_preview?.source??'Coding session';
    const listed=await this.listTrace(actor,'stream-list:'+t.trace_id,{trace_id:t.trace_id,content_hash:prepared.content_hash,title:(source+' · '+(t.capture_model?.returned_model??t.capture_model?.requested_model??'conversation')).slice(0,100),price_thot:policy.price_thot,license:policy.license,rights_confirmed:true,metadata_public:true,automatic_sales:true,treasury_opt_in:policy.treasury_sampling_consent===THOT_TREASURY_SAMPLING_POLICY,treasury_sampling_consent:policy.treasury_sampling_consent},policy);
    const row=await this.service.db.transaction(tx=>tx.get('thot_records',listed.id,actor.id));
    if(!row.signature){const signature=await this.streams.sign(actor,policy.id,row.authorization);await this.activateListing(actor,'stream-activate:'+t.trace_id,{id:listed.id,signature});}
    await this.service.db.transaction(async tx=>{const current=await tx.get('traces',t.trace_id,actor.id);current.stream_offer_status='LISTED';current.stream_listing_id=listed.id;await tx.update('traces',t.trace_id,current);});
   }catch(error){
    // Transient chain/database errors retry on the next cycle; rejected rights or
    // revoked connection consent fail closed and never become a paid release.
    const code=error instanceof Error?error.message:'';
    if(['STREAM_UNAVAILABLE','TRACE_INELIGIBLE','TRACE_UNAVAILABLE','CAPTURE_SALES_UNAVAILABLE'].includes(code))await this.service.db.transaction(async tx=>{const current=await tx.get('traces',t.trace_id,actor.id);current.stream_offer_status='INELIGIBLE';current.stream_offer_reason=code;await tx.update('traces',t.trace_id,current);});
   }
  }
 }
 async processSales(){
  if(!this.chain?.operatorAvailable())return;
  if(this.processing)return this.processing;
  const pending=this.processSalesCycle();this.processing=pending;
  try{await pending;}finally{if(this.processing===pending)this.processing=undefined;}
 }
 private async processSalesCycle(){
  const chain=this.enabled();await chain.guard();
  await this.offerCompletedStreams();
  await chain.reconcileOperatorTransactions();
  // Persisted round-robin selection prevents abandoned preparations or disputes
  // from starving funded sales. Restarting the worker does not reset its position.
  const jobs=await this.service.db.transaction(async tx=>{
   const all=(await tx.list('thot_records')).filter(r=>r.kind==='intent'&&r.automatic).sort((a,b)=>a.id.localeCompare(b.id));
   const page=async(rows:Document[],key:string,limit:number)=>{
    const cursor=await tx.maybe('thot_records',key),after=rows.filter(i=>!cursor?.last_id||i.id>cursor.last_id),before=rows.filter(i=>cursor?.last_id&&i.id<=cursor.last_id);
    const selected=[...after,...before].slice(0,limit);
    if(selected.length){const row={kind:'automation_cursor',last_id:selected.at(-1)!.id};if(cursor)await tx.update('thot_records',key,row);else await tx.insert('thot_records',key,'thot-automation',row);}
    return selected;
   };
   return [...await page(all.filter(r=>r.job_status!=='complete'),'automation:sales-cursor',50),...await page(all.filter(r=>r.job_status==='complete'),'automation:completed-sales-cursor',10)];
  });
  for(const i of jobs){
   try{
    if(i.job_status==='complete'){
     if(i.completion_block&&await chain.isCanonicalBlock(i.completion_block))continue;
     // A missing/changed completion anchor must not permanently suppress a job.
     delete i.completion_block;delete i.payout_transaction;delete i.refund_transaction;
     i.job_status='awaiting_reconciliation';delete i.unfunded_closed;
    }
    let o=await chain.offer(i.offer_id);
    let l=await this.service.db.transaction(tx=>tx.get('thot_records',i.listing_id));
    if(o.status===0){
     const state=await chain.authorizationState(l.wallet,l.authorization.nonce,l.signature);
     if(state.revoked||state.uses>=l.authorization.maxUses||state.block.timestamp>=l.authorization.validUntil){
      // Another worker/buyer may have funded between snapshots; onchain funding
      // wins over stale job or listing state, including a concurrent deletion.
      o=await chain.offer(i.offer_id);
      if(o.status===0){
       i.job_status='complete';i.completion_block=state.block;i.unfunded_closed=true;i.last_error='AUTHORIZATION_UNAVAILABLE';
       await this.service.db.transaction(async tx=>{
        await tx.update('thot_records',i.id,i);
        if(i.treasury)for(const c of await this.contentReservations(tx,l)){const claim=c.row;if(claim&&claim.offer_id===i.offer_id&&claim.status==='queued'){claim.status=state.revoked||state.block.timestamp>=l.authorization.validUntil?'released':'committed';await tx.update('thot_records',c.id,claim);}}
       });continue;
      }
     }
     if(o.status===0&&i.treasury&&!i.manual_funding&&i.job_status!=='blocked'){
      await this.service.db.transaction(async tx=>{
       await assertOperationEnabled(tx,'sales');l=await tx.get('thot_records',l.id);
       await this.assertTreasuryListingCurrent(tx,l);
       const claims=await this.contentReservations(tx,l);
       ensure(claims.every(c=>!c.row||c.row.offer_id===i.offer_id&&c.row.status==='queued'),'CONTENT_ALREADY_SUBSIDIZED');
       await this.reserveContent(tx,l,i.owner_id,i.offer_id,'queued');
       i.subsidy_content_fingerprint=l.subsidy_content_fingerprint;
      });
      i.funding_transaction=await chain.purchaseSample(i.offer,l.authorization,l.signature,i.review_hash);o=await chain.offer(i.offer_id);
     }
     if(o.status===0){
      if(i.job_status!=='blocked')i.job_status=i.treasury&&!i.manual_funding?'queued':'awaiting_funding';
      await this.service.db.transaction(tx=>tx.update('thot_records',i.id,i));continue;
     }
    }
    ensure(o.buyer===i.wallet&&o.seller===i.seller_wallet&&o.gross===i.gross&&o.evidence_hash===i.evidence_hash&&o.license_hash===i.license_hash,'ONCHAIN_OFFER_MISMATCH');
    await this.assertCampaignFunding(i,o);
    i.funding_confirmed=true;
    if(i.treasury)await this.service.db.transaction(async tx=>{
     await this.reserveContent(tx,l,i.owner_id,i.offer_id,'committed');
     i.subsidy_content_fingerprint=l.subsidy_content_fingerprint;
    });
    if(o.status>=2){await this.service.db.transaction(async tx=>{l=await tx.get('thot_records',l.id);l.active=false;await tx.update('thot_records',l.id,l);});}
    if(o.status===1&&o.block.timestamp>o.issued_at+86400||o.status===2&&o.block.timestamp>o.accepted_at+48*3600||o.status===6){
     i.refund_transaction=await chain.refundOverdueAndPay(i.offer_id);o=await chain.offer(i.offer_id);
    }
    if(o.status===2){
     await this.service.db.transaction(tx=>assertOperationEnabled(tx,'deliveries'));
     ensure(!l.release_deleted_at,'RELEASE_EXPIRED');const release=await this.service.privacy.open(l.owner_id,l.release_ref);ensure(digest(release)===o.evidence_hash,'RELEASE_TAMPERED');
     await chain.acknowledgeAvailability(i.offer_id,o.evidence_hash);o=await chain.offer(i.offer_id);
    }
    if(o.status===4&&o.dispute&&o.block.timestamp>=o.dispute.vote_ends_at){await chain.upholdExpiredDispute(i.offer_id);o=await chain.offer(i.offer_id);}
    if(o.status===3&&o.block.timestamp>=o.delivered_at+o.dispute_seconds||o.status===5){
     i.payout_transaction=await chain.finalizeAndPay(i.offer_id,i.seller_wallet);o=await chain.offer(i.offer_id);
     const observation={offer_id:i.offer_id,listing:{id:l.id,owner_id:l.owner_id,wallet:l.wallet,workflow:l.workflow,provenance:l.provenance,provenance_status:l.provenance_status??'UNSPECIFIED',turn_count:l.turn_count,eligible:true},buyer:o.buyer,buyer_owner_id:i.owner_id,gross_atoms:o.gross,finalized_at:o.finalized_at*1000,status:'finalized',confirmed:true,source:o.treasury?'treasury':'independent',independence_reviewed:o.independent};
     await this.service.db.transaction(async tx=>{const key='observation:'+i.offer_id,row={kind:'sale_observation',observation,confirmation_block:o.block};if(await tx.maybe('thot_records',key))await tx.update('thot_records',key,row);else await tx.insert('thot_records',key,l.owner_id,row);});
     i.job_status='complete';
    }else i.job_status=o.status===6?'complete':o.status===4?'disputed':'awaiting_settlement';
    if(i.job_status==='complete')i.completion_block=o.block;
    delete i.last_error;
    await this.service.db.transaction(tx=>tx.update('thot_records',i.id,i));
   }catch(error){
    const message=error instanceof Error?error.message:'AUTOMATION_PENDING';
    i.last_error=/^[A-Z0-9_]+$/.test(message)?message:'AUTOMATION_PENDING';
    if(['SAMPLE_NO_LONGER_ELIGIBLE','TREASURY_SAMPLE_UNAVAILABLE','TRADE_EVIDENCE_UNAVAILABLE','AUTHORIZATION_UNAVAILABLE','CONTENT_ALREADY_SUBSIDIZED'].includes(i.last_error)){
     // Never permanently discard a sale that another worker has just funded.
     try{i.job_status=(await chain.offer(i.offer_id)).status===0?'blocked':'awaiting_settlement';}catch{i.job_status='awaiting_reconciliation';}
    }
    await this.service.db.transaction(tx=>tx.update('thot_records',i.id,i));
   }
  }
 }
 async sweepRetention(){
  return this.service.db.transaction(async tx=>{
   const listings=(await tx.list('thot_records')).filter(r=>(r.kind==='listing'&&!r.release_deleted_at)||(r.kind==='trade_evidence'&&!r.revoked));
   for(const traceId of new Set(listings.map(r=>String(r.trace_id)))){
    const count=await this.cleanupTrace(tx,traceId),trace=await tx.get('traces',traceId);
    if(trace.source_private_objects_deleted){trace.private_objects_deleted=count===0;trace.thot_release_copies_retained=count;await tx.update('traces',traceId,trace);}
   }
  });
 }
 private async saveDisputeExplanation(actor:Actor,id:string,wallet:string,reason:string){
  const reasonHash=digest(reason),key='dispute:'+digest([id,wallet,reasonHash]);
  const explanationStored=await this.service.db.transaction(async tx=>{
   const existing=await tx.maybe('thot_records',key);
   if(existing?.object_ref)return true;
   let objectRef:Document|undefined;
   try{objectRef=await this.service.privacy.seal(actor.id,{reason});}
   catch(error){
    // Intake exhaustion must not prevent a funded buyer from opening an onchain dispute.
    // Only a hash is retained; user prose cannot spend the operator journal's capacity.
    if(!(error instanceof Error)||!['VAULT_OWNER_QUOTA','VAULT_GLOBAL_QUOTA','VAULT_DISK_HEADROOM','VAULT_DISK_SPACE_UNAVAILABLE'].includes(error.message))throw error;
   }
   if(existing){if(objectRef){existing.object_ref=objectRef;await tx.update('thot_records',key,existing);}}
   else{
    await tx.insert('thot_records',key,actor.id,{kind:'dispute_explanation',offer_id:id,wallet,reason_hash:reasonHash,object_ref:objectRef??null,created_at:this.service.now(),status:'prepared'});
    await tx.audit(actor.id,'ThotDisputePrepared',{offer_id:id,reason_hash:reasonHash});
   }
   return Boolean(objectRef);
  });return {reasonHash,explanationStored};
 }
 private async saveDisputeResponse(actor:Actor,id:string,wallet:string,response:string){
  const responseHash=digest(response),key='dispute-response:'+digest([id,wallet,responseHash]);
  await this.service.db.transaction(async tx=>{
   if(await tx.maybe('thot_records',key))return;
   await tx.insert('thot_records',key,actor.id,{kind:'dispute_response',offer_id:id,wallet,response_hash:responseHash,object_ref:await this.service.privacy.seal(actor.id,{response}),created_at:this.service.now(),status:'prepared'});
   await tx.audit(actor.id,'ThotDisputeResponsePrepared',{offer_id:id,response_hash:responseHash});
  });return responseHash;
 }
 private async saveDisputeDecision(actor:Actor,id:string,wallet:string,decision:number,reason:string){
  const decisionHash=digest({offer_id:id,reviewer:wallet,decision,reason}),key='dispute-decision:'+decisionHash;
  await this.service.db.transaction(async tx=>{
   if(await tx.maybe('thot_records',key))return;
   await tx.insert('thot_records',key,actor.id,{kind:'dispute_decision',offer_id:id,wallet,decision,decision_hash:decisionHash,object_ref:await this.service.privacy.seal(actor.id,{reason}),created_at:this.service.now(),status:'prepared'});
   await tx.audit(actor.id,'ThotDisputeDecisionPrepared',{offer_id:id,reviewer:wallet,decision,decision_hash:decisionHash});
  });return decisionHash;
 }
 async confirmDispute(actor:Actor,input:Document){
  const {wallet,o}=await this.checked(actor,input.id),event=await this.enabled().confirmedDispute(input.transaction_hash,o.id);
  ensure(event.by===wallet,'DISPUTE_PARTY_MISMATCH',403);
  const key='dispute:'+digest([o.id,wallet,event.reason_hash]);
  await this.service.db.transaction(async tx=>{
   const row=await tx.get('thot_records',key,actor.id);
   row.status='confirmed';row.confirmation=event;await tx.update('thot_records',key,row);
   await tx.audit(actor.id,'ThotDisputeConfirmed',{offer_id:o.id,transaction_hash:event.transaction_hash,reason_hash:event.reason_hash});
  });return {offer_id:o.id,...event,status:'confirmed'};
 }
 /** Case-scoped inspection is independent of treasury sampling. It never opens
  * a source trace, capture object or brokerage credential; only the paid licence. */
 async disputeEvidence(actor:Actor,input:Document){
  allowed(actor);
  ensure(typeof input.id==='string'&&/^0x[\da-f]{64}$/i.test(input.id),'INVALID_OFFER_ID');
  const chain=this.enabled(),wallet=await this.service.db.transaction(tx=>this.wallet(tx,actor));
  // Reviewer membership and the dispute are read at one confirmed chain height.
  const view=await chain.readWorkspace(wallet,[input.id]),receipt=view.offers[0]!;
  ensure(view.account?.dispute_reviewer,'GOVERNANCE_REVIEWER_REQUIRED',403);
  ensure(receipt.status===4&&receipt.dispute&&receipt.dispute.opened_at>0&&receipt.dispute.outcome===0,'DISPUTE_NOT_OPEN',409);
  ensure(receipt.block.timestamp<receipt.dispute.vote_ends_at,'DISPUTE_REVIEW_WINDOW_CLOSED',410);
  ensure(!receipt.treasury&&receipt.independent,'SUBJECTIVE_DISPUTE_UNAVAILABLE',403);
  ensure(![receipt.buyer,receipt.seller,receipt.referrer].some(address=>getAddress(address)===getAddress(wallet)),'GOVERNANCE_REVIEWER_CONFLICT',403);
  return this.service.db.transaction(async tx=>{
   const intent=await tx.get('thot_records','intent:'+input.id),listing=await tx.get('thot_records',intent.listing_id);
   ensure(intent.kind==='intent'&&intent.offer_id===receipt.id&&listing.kind==='listing'&&listing.owner_id===intent.seller_id&&
    receipt.buyer===intent.wallet&&receipt.seller===intent.seller_wallet&&receipt.seller===listing.wallet&&
    receipt.gross===intent.gross&&receipt.evidence_hash===intent.evidence_hash&&receipt.evidence_hash===listing.evidence_hash&&
    receipt.license_hash===intent.license_hash&&receipt.license_hash===listing.license_hash,'ONCHAIN_OFFER_MISMATCH',409);
   ensure(!listing.release_deleted_at&&listing.release_ref&&receipt.block.timestamp<receipt.accepted_at+(listing.retention_days??30)*86400,'LICENSE_RETENTION_EXPIRED',410);
   ensure(listing.dispute_review_consent===THOT_DISPUTE_REVIEW_POLICY,'DISPUTE_INSPECTION_NOT_AUTHORIZED',403);
   const committed=await this.service.privacy.open(listing.owner_id,listing.release_ref);
   ensure(digest(committed)===receipt.evidence_hash&&receipt.delivery_hash===receipt.evidence_hash&&digest(committed.license)===receipt.license_hash,'RELEASE_TAMPERED');
   ensure(digest(committed.dispute_review??null)===digest(THOT_DISPUTE_REVIEW_AUTHORIZATION),'DISPUTE_INSPECTION_NOT_AUTHORIZED',403);
   // Match ordinary buyer delivery: the bounded public claim is separate from
   // the private brokerage proof, which is never a dispute-review entitlement.
   const {brokerage_evidence:_privateProof,...release}=committed;
   await tx.audit(actor.id,'ThotDisputeEvidenceInspected',{offer_id:receipt.id,reviewer:wallet,release_hash:receipt.evidence_hash,reason_hash:receipt.dispute!.reason_hash,block:receipt.block.number,block_hash:receipt.block.hash??'unavailable'});
   return {offer_id:receipt.id,receipt,release,brokerage_claim:committed.brokerage_evidence?.summary??null,license:committed.license,release_hash:receipt.evidence_hash,delivery_hash:receipt.delivery_hash,licensed_content_hash:digest(release),scope:'disputed_purchased_release',notice:'Case-scoped access to the purchased licensed release. Private source bytes and brokerage proofs are excluded. This inspection is audited and does not select a new treasury sample.'};
  });
 }
 async disputes(actor:Actor,input:Document={}){
  allowed(actor);
  ensure(input.after_id===undefined||typeof input.after_id==='string'&&/^intent:0x[\da-f]{64}$/i.test(input.after_id),'INVALID_DISPUTE_CURSOR');
  const chain=this.enabled(),wallet=await this.service.db.transaction(tx=>this.wallet(tx,actor)),account=await chain.account(wallet);
  ensure(account.dispute_reviewer,'GOVERNANCE_REVIEWER_REQUIRED',403);
  const records=await this.service.db.transaction(tx=>tx.list('thot_records'));
  const intents=records.filter(r=>r.kind==='intent'&&(!input.after_id||r.id>input.after_id)).sort((a,b)=>a.id.localeCompare(b.id)),page=intents.slice(0,25),items=[];
  for(const intent of page){
   const receipt=await chain.offer(intent.offer_id,wallet);
   const explanations=records.filter(r=>r.kind==='dispute_explanation'&&r.offer_id===intent.offer_id);
   const responses=records.filter(r=>r.kind==='dispute_response'&&r.offer_id===intent.offer_id);
   const decisions=records.filter(r=>r.kind==='dispute_decision'&&r.offer_id===intent.offer_id);
   if(!receipt.dispute?.opened_at)continue;
   const conflict=[receipt.buyer,receipt.seller,receipt.referrer].some(address=>getAddress(address)===getAddress(wallet));
   // A role flag, abandoned draft or conflicted reviewer grants no private case access.
   if(conflict){items.push({offer_id:intent.offer_id,title:intent.title,receipt,explanations:[],responses:[],decisions:[],can_vote:false,can_inspect:false,reviewer_conflict:true,can_finalize:false,notice:'You are a party or referrer in this case. Private governance review is unavailable to this wallet.'});continue;}
   const details=[];
   for(const row of explanations){
    if(row.reason_hash!==receipt.dispute.reason_hash||getAddress(row.wallet)!==receipt.buyer)continue;
    const content=row.object_ref?await this.service.privacy.open(row.owner_id,row.object_ref):null;
    ensure(!content||digest(content.reason)===row.reason_hash,'DISPUTE_EXPLANATION_TAMPERED');
    const confirmed=receipt.dispute?.reason_hash===row.reason_hash||row.status==='confirmed'&&row.confirmation?.block&&await chain.isCanonicalBlock(row.confirmation.block);
    details.push({reason:content?.reason??'Private explanation unavailable because storage was at capacity. Ask the disputing party for their saved explanation and verify its hash.',explanation_stored:Boolean(row.object_ref),reason_hash:row.reason_hash,wallet:row.wallet,created_at:row.created_at,status:confirmed?'confirmed':'prepared',transaction_hash:confirmed?row.confirmation?.transaction_hash??null:null});
   }
   const responseRows=[];
   for(const row of responses){
    if(row.response_hash!==receipt.dispute.response_hash||getAddress(row.wallet)!==receipt.seller)continue;
    const content=await this.service.privacy.open(row.owner_id,row.object_ref),confirmed=receipt.dispute?.response_hash===row.response_hash;
    ensure(digest(content.response)===row.response_hash,'DISPUTE_RESPONSE_TAMPERED');
    responseRows.push({response:content.response,response_hash:row.response_hash,wallet:row.wallet,created_at:row.created_at,status:confirmed?'confirmed':'prepared'});
   }
   const decisionRows=[];
   for(const row of decisions){
    const review=await chain.disputeReview(intent.offer_id,row.wallet);
    if(!review.eligible||review.vote!==row.decision||review.decision_hash!==row.decision_hash)continue;
    const content=await this.service.privacy.open(row.owner_id,row.object_ref);
    ensure(digest({offer_id:intent.offer_id,reviewer:row.wallet,decision:row.decision,reason:content.reason})===row.decision_hash,'DISPUTE_DECISION_TAMPERED');
    decisionRows.push({reason:content.reason,decision:row.decision,decision_hash:row.decision_hash,wallet:row.wallet,created_at:row.created_at,status:review.vote===row.decision&&review.decision_hash===row.decision_hash?'confirmed':'prepared'});
   }
   const inspectionAuthorized=records.some(r=>r.id===intent.listing_id&&r.kind==='listing'&&r.dispute_review_consent===THOT_DISPUTE_REVIEW_POLICY);
   const canVote=receipt.status===4&&account.dispute_reviewer&&!conflict&&receipt.dispute&&receipt.block.timestamp>=receipt.dispute.vote_starts_at&&receipt.block.timestamp<receipt.dispute.vote_ends_at&&receipt.dispute.reviewer_vote===0;
   items.push({offer_id:intent.offer_id,title:intent.title,receipt,explanations:details,responses:responseRows,decisions:decisionRows,can_vote:Boolean(canVote),inspection_authorized:inspectionAuthorized,can_inspect:inspectionAuthorized&&receipt.status===4&&receipt.dispute?.outcome===0&&receipt.block.timestamp<receipt.dispute.vote_ends_at,reviewer_conflict:conflict,can_finalize:receipt.status===4&&receipt.dispute&&receipt.block.timestamp>=receipt.dispute.vote_ends_at,notice:!inspectionAuthorized?'This older sale did not authorize governance content inspection. Its original sale and dispute terms remain unchanged; parties may submit their own evidence.':receipt.status===4&&!details.some(r=>r.status==='confirmed')?'A dispute is confirmed on chain; no verified explanation has been linked in this app.':null});
  }
  return {items,next_cursor:intents.length>page.length?page.at(-1)!.id:null,reviewer_wallet:wallet,reviewer:account.dispute_reviewer,threshold:chain.capabilities().dispute_review_threshold};
 }
 async respondToDispute(actor:Actor,input:Document){
  ensure(typeof input.response==='string'&&input.response.length>=10&&input.response.length<=2000,'DISPUTE_RESPONSE_REQUIRED');
  const {wallet,o,i}=await this.checked(actor,input.id);
  ensure(i.seller_id===actor.id&&o.seller===wallet,'FORBIDDEN',403);
  ensure(o.status===4&&o.dispute&&o.block.timestamp<o.dispute.vote_starts_at&&/^0x0{64}$/.test(o.dispute.response_hash),'DISPUTE_RESPONSE_WINDOW_CLOSED',409);
  const responseHash=await this.saveDisputeResponse(actor,o.id,wallet,input.response);
  return {wallet,response_hash:responseHash,transactions:[this.enabled().transaction('market','respondToDispute',[o.id,responseHash])],notice:'Your response is stored encrypted and its hash goes onchain. You keep the remaining 24-hour response period unless you separately choose to finish it early.'};
 }
 async waiveDisputeResponseWindow(actor:Actor,input:Document){
  ensure(input.confirm_final_response===true,'FINAL_RESPONSE_CONFIRMATION_REQUIRED');
  const {wallet,o,i}=await this.checked(actor,input.id);
  ensure(i.seller_id===actor.id&&o.seller===wallet,'FORBIDDEN',403);
  ensure(o.status===4&&o.dispute&&o.dispute.outcome===0&&o.block.timestamp<o.dispute.vote_starts_at&&!/^0x0{64}$/.test(o.dispute.response_hash),'DISPUTE_RESPONSE_WINDOW_CLOSED',409);
  return {wallet,transactions:[this.enabled().transaction('market','waiveDisputeResponseWindow',[o.id])],notice:'You voluntarily finish your response period. Governance can review and decide immediately after this transaction confirms; you cannot reopen the response period.'};
 }
 async voteDispute(actor:Actor,input:Document){
  allowed(actor);
  ensure(['uphold','buyer_wins'].includes(input.decision)&&typeof input.reason==='string'&&input.reason.length>=10&&input.reason.length<=2000,'DISPUTE_DECISION_REQUIRED');
  const chain=this.enabled(),{intent,wallet}=await this.service.db.transaction(async tx=>({intent:await tx.get('thot_records','intent:'+input.id),wallet:await this.wallet(tx,actor)}));
  ensure(intent.kind==='intent','NOT_FOUND',404);
  const view=await chain.readWorkspace(wallet,[intent.offer_id]),receipt=view.offers[0]!;
  ensure(view.account?.dispute_reviewer,'GOVERNANCE_REVIEWER_REQUIRED',403);
  ensure(receipt.status===4&&receipt.dispute,'DISPUTE_NOT_OPEN',409);
  ensure(![receipt.buyer,receipt.seller,receipt.referrer].some(address=>getAddress(address)===getAddress(wallet)),'GOVERNANCE_REVIEWER_CONFLICT',403);
  ensure(receipt.block.timestamp>=receipt.dispute.vote_starts_at&&receipt.block.timestamp<receipt.dispute.vote_ends_at,'DISPUTE_VOTE_WINDOW_CLOSED',409);
  ensure(receipt.dispute.reviewer_vote===0,'DISPUTE_ALREADY_VOTED',409);
  const decision=input.decision==='uphold'?1:2,decisionHash=await this.saveDisputeDecision(actor,receipt.id,wallet,decision,input.reason);
  return {wallet,decision_hash:decisionHash,decision,transactions:[chain.transaction('market','voteDispute',[receipt.id,decision,decisionHash])],notice:`Your explanation is stored encrypted and its hash is recorded with your onchain vote. The configured threshold is ${chain.capabilities().dispute_review_threshold} matching vote(s); there is no appeal.`};
 }
 async finalizeExpiredDispute(actor:Actor,input:Document){
  allowed(actor);
  const chain=this.enabled(),{intent,wallet}=await this.service.db.transaction(async tx=>({intent:await tx.get('thot_records','intent:'+input.id),wallet:await this.wallet(tx,actor)}));
  const receipt=await chain.offer(intent.offer_id,wallet);ensure(receipt.status===4&&receipt.dispute&&receipt.block.timestamp>=receipt.dispute.vote_ends_at,'DISPUTE_NOT_EXPIRED',409);
  return {wallet,transactions:[chain.transaction('market','finalizeExpiredDispute',[receipt.id])],notice:'The seven-day vote window ended without the required matching votes. This permissionless transaction applies the onchain default: uphold delivery.'};
 }
 async transaction(actor:Actor,input:Document){
  const chain=this.enabled(),wallet=await this.service.db.transaction(tx=>this.wallet(tx,actor));
  await chain.guard();
  if(input.action==='holder-policy')return prepareHolderPolicy(chain,wallet,input);
  if(input.action==='holder-rebate')return prepareHolderReward(chain,wallet,input);
  if(input.action==='stake'||input.action==='staking-claim')return prepareStaking(chain,wallet,input);
  let transaction;
  if(input.action==='lock'){const amount=atom(input.amount),block=await chain.snapshot();transaction=chain.transaction('locks','deposit',[amount,block.timestamp+91*86400]);return {wallet,transactions:[chain.transaction('token','approve',[chain.config.locks,amount]),transaction],notice:'91-day custody lock including a one-day transaction margin. Deposited principal cannot be withdrawn before expiry. This legacy custody lock does not count as staking principal for holder cashback; existing referral terms are unchanged.'};}
  if(input.action==='withdraw'||input.action==='extend'){
   ensure(Number.isSafeInteger(input.lot_id)&&input.lot_id>=0&&input.lot_id<64,'INVALID_LOT');
   transaction=input.action==='withdraw'?chain.transaction('locks','withdraw',[input.lot_id]):chain.transaction('locks','extend',[input.lot_id,(await chain.snapshot()).timestamp+91*86400]);
  } else if(input.action==='claim')transaction=chain.transaction('market','claim',[]);
  else if(input.action==='refer')transaction=chain.transaction('market','registerReferrer',[addr(input.referrer)]);
  else {
   const {o,i}=await this.checked(actor,input.id);
   ensure(['finalize','cancelOffer','refundExpired','refundUndelivered','dispute'].includes(input.action),'INVALID_ACTION');
   if(input.action==='cancelOffer')ensure(i.owner_id===actor.id,'FORBIDDEN',403);
   if(input.action==='dispute'){
    ensure(typeof input.reason==='string'&&input.reason.length>=10&&input.reason.length<=2000,'DISPUTE_REASON_REQUIRED');
    ensure(o.status===3&&o.block.timestamp<o.delivered_at+o.dispute_seconds,'DISPUTE_WINDOW_CLOSED',409);
    ensure(i.owner_id===actor.id&&o.buyer===wallet&&o.independent&&!o.treasury,'SUBJECTIVE_DISPUTE_UNAVAILABLE',403);
    const account=await chain.account(wallet);ensure(BigInt(account.finalized_independent_spend)+BigInt(o.gross)>=parseUnits('10000000',18),'SUBJECTIVE_DISPUTE_SPEND_REQUIRED',403);
    const {reasonHash,explanationStored}=await this.saveDisputeExplanation(actor,o.id,wallet,input.reason);
    return {wallet,reason_hash:reasonHash,explanation_stored:explanationStored,transactions:[chain.transaction('market','dispute',[o.id,reasonHash])],notice:(explanationStored?'Your complaint is stored privately for governance review.':'Storage is at capacity, so only your complaint hash was saved. Keep a copy for the reviewers. You can still open the dispute.')+` Sign within ${o.dispute_seconds/3600} hour(s) of recorded delivery. The seller then has 24 hours to respond, or may separately close that window after submitting a response. The following seven-day review requires ${chain.capabilities().dispute_review_threshold} matching vote(s) under the configured governance threshold. A decision can resolve the case before the review deadline; seller payout still cannot precede the delivery dispute deadline. Without a decision by the review deadline, the original sale is upheld.`};
   }
   else transaction=chain.transaction(i.treasury&&i.owner_id===actor.id&&input.action==='cancelOffer'?'reserve':'market',input.action,[o.id]);
  }
  return {wallet,transactions:[transaction]};
 }
}
