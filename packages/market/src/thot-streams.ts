import {THOT_DISPUTE_REVIEW_POLICY,THOT_DISPUTE_REVIEW_TERMS,THOT_DISPUTE_REVIEW_AUTHORIZATION} from './thot-dispute-policy.ts';
import {Wallet,TypedDataEncoder,getAddress,verifyTypedData,parseUnits} from 'ethers';
import {randomBytes} from 'node:crypto';
import {canonicalHash,uuidv7} from '../../protocol/src/index.ts';
import {ensure,type Document} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';
import {ThotChain,THOT_AUTHORIZATION_TYPES} from '../../chain/thot.ts';
import {THOT_STREAM_TYPES,encodeStreamSignature} from '../../chain/thot-authorizations.ts';
import {THOT_TREASURY_SAMPLING_GROUP_SIZE,THOT_TREASURY_SAMPLING_POLICY,THOT_TREASURY_SAMPLING_TERMS} from './thot-sampling.ts';
export const THOT_STREAM_LICENSE='Non-exclusive licence to inspect and evaluate the purchased conversation for AI research for 30 days. No onward transfer, resale, re-identification or access to provider accounts. Public model training and redistribution require a separate licence. '+THOT_DISPUTE_REVIEW_TERMS;
const digest=(v:unknown)=>'0x'+canonicalHash(v).replace(/^sha256:/,'').replace(/^0x/,'');
/** Delegation keys authorize sales of licensed releases only; they never own seller funds. */
export class ThotStreams {
 private service:ThotService;private chain:ThotChain;
 constructor(service:ThotService,chain:ThotChain){this.service=service;this.chain=chain;}
 async prepare(actor:Actor,input:Document){
  ensure(actor.role==='user','FORBIDDEN',403);ensure(this.chain.config.streamSales===true,'STREAM_SALES_UNAVAILABLE',503);
  ensure(Object.keys(input).every(k=>['price_thot','treasury_sampling_opt_in'].includes(k))&&typeof input.treasury_sampling_opt_in==='boolean','INVALID_STREAM_POLICY');
  ensure(typeof input.price_thot==='string'&&/^[1-9]\d{0,8}(\.\d{1,18})?$/.test(input.price_thot),'INVALID_THOT_AMOUNT');
  const price=parseUnits(input.price_thot,18);ensure(price<=parseUnits('1000000',18),'INVALID_THOT_AMOUNT');
  const block=await this.chain.snapshot();
  const costs=await this.chain.market.costQuote(price,{blockTag:block.number});const minSellerBps=Number(BigInt(costs.sellerAmount)*10000n/price);ensure(minSellerBps>=3000,'PRICE_BELOW_SIGNED_RETENTION');
  return this.service.db.transaction(async tx=>{
   const wallet=await tx.get('thot_records','wallet:'+actor.id,actor.id);
   const existing=(await tx.list('thot_records',actor.id)).filter(r=>r.kind==='stream_policy'&&!r.revoked&&r.authorization.validUntil>block.timestamp);
   ensure(existing.length<10,'STREAM_POLICY_LIMIT',429);
   const delegate=Wallet.createRandom(),id='stream:'+uuidv7(),validUntil=block.timestamp+30*86400;
   const authorization={seller:getAddress(wallet.address),delegate:delegate.address,licenseHash:digest(THOT_STREAM_LICENSE),minGross:price.toString(),minSellerBps,validUntil,nonce:'0x'+randomBytes(32).toString('hex'),maxSales:10000};
   const secret=await this.service.privacy.seal(actor.id,{private_key:delegate.privateKey});
   const treasurySamplingConsent=input.treasury_sampling_opt_in?THOT_TREASURY_SAMPLING_POLICY:null;
   await tx.insert('thot_records',id,actor.id,{kind:'stream_policy',dispute_review_consent:THOT_DISPUTE_REVIEW_POLICY,authorization,secret_ref:secret,active:false,price_thot:input.price_thot,license:THOT_STREAM_LICENSE,treasury_sampling_consent:treasurySamplingConsent,created_at:this.service.now()});
   return {id,typed_data:TypedDataEncoder.getPayload(this.chain.authorizationDomain(),THOT_STREAM_TYPES,authorization),terms:{license:THOT_STREAM_LICENSE,dispute_review:THOT_DISPUTE_REVIEW_AUTHORIZATION,valid_until:new Date(validUntil*1000).toISOString(),min_price_thot:input.price_thot,min_seller_percent:minSellerBps/100,service_fee_atoms:String(costs.serviceFee),seller_amount_atoms:String(costs.sellerAmount),cost_policy_hash:String(costs.policyHash),max_sales:10000,treasury_sampling:input.treasury_sampling_opt_in?{policy:THOT_TREASURY_SAMPLING_POLICY,group_size:THOT_TREASURY_SAMPLING_GROUP_SIZE,release_scope:'complete_approved_release',recipients:'reserve_authorized_buyers',terms:THOT_TREASURY_SAMPLING_TERMS}:null,notice:'Automatically offer completed eligible recordings from this connection at this asking price. Ordinary buyers receive content only after purchase. One sale per release; no per-trace approval. Earnings require a funded purchase.'}};
  });
 }
 async activate(actor:Actor,id:string,signature:string){
  ensure(actor.role==='user','FORBIDDEN',403);ensure(typeof signature==='string'&&/^0x[\da-f]{130}$/i.test(signature),'INVALID_SIGNATURE');
  const block=await this.chain.snapshot();
  return this.service.db.transaction(async tx=>{
   const p=await tx.get('thot_records',id,actor.id);ensure(p.kind==='stream_policy'&&!p.revoked&&p.authorization.validUntil>block.timestamp,'STREAM_UNAVAILABLE');
   ensure(p.active||Date.parse(p.created_at)+900000>Date.parse(this.service.now()),'STREAM_PREPARATION_EXPIRED');
   ensure(getAddress(verifyTypedData(this.chain.authorizationDomain(),THOT_STREAM_TYPES,p.authorization,signature))===getAddress(p.authorization.seller),'WALLET_SIGNATURE_MISMATCH');
   ensure(!p.active||p.signature===signature,'STREAM_SIGNATURE_CHANGED');
   p.active=true;p.signature=signature;await tx.update('thot_records',id,p);
   await tx.audit(actor.id,'ThotStreamAuthorized',{stream_id:id,authorization_hash:digest(p.authorization)});
   return {id,active:true};
  });
 }
 async policy(actor:Actor,id:string){return this.service.db.transaction(async tx=>{const p=await tx.get('thot_records',id,actor.id);ensure(p.kind==='stream_policy'&&p.active&&!p.revoked&&p.authorization.validUntil>Math.floor(Date.parse(this.service.now())/1000),'STREAM_UNAVAILABLE');return p;});}
 async list(actor:Actor){
  ensure(actor.role==='user','FORBIDDEN',403);ensure(this.chain.config.streamSales===true,'STREAM_SALES_UNAVAILABLE',503);
  const rows=await this.service.db.transaction(tx=>tx.list('thot_records',actor.id));
  const now=Math.floor(Date.parse(this.service.now())/1000);
  const policies=rows.filter(p=>p.kind==='stream_policy'&&(p.active||p.revoked)&&p.authorization.validUntil>now).sort((a,b)=>b.created_at.localeCompare(a.created_at));
  const safe=policies.map(p=>({id:p.id,price_thot:p.price_thot,created_at:p.created_at,valid_until:p.authorization.validUntil,offchain_revoked:p.revoked===true,onchain_revoked:null as boolean|null}));
  try{
   const block=await this.chain.snapshot();
   for(let i=0;i<policies.length;i+=4){
    const states=await Promise.all(policies.slice(i,i+4).map(p=>this.chain.market.authorizationRevoked(p.authorization.seller,p.authorization.nonce,{blockTag:block.number})));
    states.forEach((revoked,j)=>{safe[i+j]!.onchain_revoked=Boolean(revoked);});
   }
   await this.chain.assertSnapshot(block);
   return {policies:safe,chain_status:'confirmed',block};
  }catch{return {policies:safe.map(p=>({...p,onchain_revoked:null})),chain_status:'unavailable',block:null};}
 }
 async sign(actor:Actor,id:string,authorization:Document){
  const p=await this.policy(actor,id);
  ensure(getAddress(authorization.seller)===getAddress(p.authorization.seller)&&authorization.licenseHash===p.authorization.licenseHash&&BigInt(authorization.gross)>=BigInt(p.authorization.minGross)&&authorization.minSellerBps>=p.authorization.minSellerBps&&authorization.validUntil<=p.authorization.validUntil&&authorization.maxUses===1,'STREAM_TERMS');
  const secret=await this.service.privacy.open(actor.id,p.secret_ref),delegate=new Wallet(secret.private_key);
  return encodeStreamSignature(p.authorization,p.signature,await delegate.signTypedData(this.chain.authorizationDomain(),THOT_AUTHORIZATION_TYPES,authorization));
 }
 async revoke(actor:Actor,id:string){
  const p=await this.service.db.transaction(async tx=>{const p=await tx.get('thot_records',id,actor.id);ensure(p.kind==='stream_policy','NOT_FOUND',404);p.revoked=true;p.active=false;await tx.update('thot_records',id,p);for(const l of (await tx.list('thot_records',actor.id)).filter(r=>r.kind==='listing'&&r.stream_id===id)){l.active=false;await tx.update('thot_records',l.id,l);}return p;});
  return {revoked:true,transactions:[this.chain.transaction('market','revokeSaleAuthorization',[p.authorization.nonce])],notice:'New listing creation is stopped. Confirm revocation in your wallet to also invalidate prepared but unfunded purchases. Funded sales retain their agreed terms.'};
 }
}
