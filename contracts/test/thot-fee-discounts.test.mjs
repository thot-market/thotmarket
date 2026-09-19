import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {parseEther as u,id,MaxUint256,keccak256} from 'ethers';
import {deployThotFixture} from '../scripts/thot-local-fixture.mjs';
let f,gov,pool,policy,a,market,reserve;
const tx=async p=>(await p).wait();
before(async()=>{
 f=await deployThotFixture({activate:false});a=await Promise.all(f.signers.map(s=>s.getAddress()));
 gov=await f.deploy('ThotGovernor',[a.slice(0,3)]);
 pool=await f.deploy('ThotStakingPool',[await f.token.getAddress(),await gov.getAddress()]);
 policy=await f.deploy('ThotFeeDiscounts',[await f.token.getAddress(),await pool.getAddress(),await gov.getAddress()]);
 await tx(gov.submitAndExecute(await policy.getAddress(),policy.interface.encodeFunctionData('setPolicy',[u('10000'),u('100000'),1000,2500])));
 reserve=await f.deploy('ThotReserveVault',[await f.token.getAddress(),await gov.getAddress(),a[0]]);
 market=await f.deploy('ThotMarket',[await f.token.getAddress(),await f.locks.getAddress(),await reserve.getAddress(),await gov.getAddress(),a[0],a[4]]);
 await tx(gov.submitAndExecute(await market.getAddress(),market.interface.encodeFunctionData('bindFeeDiscounts',[await policy.getAddress()])));
 await tx(f.token.connect(f.buyer).approve(await market.getAddress(),MaxUint256));
 await tx(market.connect(f.seller).registerReferrer(a[3]));
});
after(async()=>f?.close());
async function balance(s,target){let owner=await s.getAddress(),v=await f.token.balanceOf(owner);if(v>target)await tx(f.token.connect(s).transfer(a[0],v-target));else if(v<target)await tx(f.token.transfer(owner,target-v));}
for(const [buyer,seller] of [[false,false],[true,false],[false,true],[true,true]])test(`fee policy arithmetic buyer=${buyer} seller=${seller}`,async()=>{
 await balance(f.buyer,u(buyer?'100000':'100'));await balance(f.seller,u(seller?'100000':'100'));
 const bd=await policy.discount(a[1],u('.04'),u('.03')),sd=await policy.discount(a[2],u('.04'),u('.03'));
 assert.equal(bd,u(buyer?'.01':'0'));assert.equal(sd,u(seller?'.01':'0'));
 const buyerPays=u('1')-bd,sellerReceives=u('.96')+sd,referral=u('.006'),protocol=u('.034')-bd-sd;
 assert.equal(buyerPays,sellerReceives+referral+protocol);assert.ok(protocol>=u('.01'));
});
test('threshold boundaries and high-cost floor preserve both independent benefits',async()=>{
 for(const [holding,discount] of [['9999.999999999999999999','0'],['10000','.004'],['99999.999999999999999999','.004'],['100000','.01']]){
  await balance(f.buyer,u(holding));assert.equal(await policy.discount(a[1],u('.04'),u('.03')),u(discount));
 }
 assert.equal(await policy.discount(a[1],u('.903'),u('.003')),u('.0012'));
 for(let n=0n;n<51n;n++){
  const d=await policy.discount(a[1],1000n+n,n);assert.ok(2n*d+n/5n<=n);
 }
});
test('policy has no funding dependency and rejects unauthorized changes',async()=>{
 assert.equal(await f.token.balanceOf(await policy.getAddress()),0n);
 await assert.rejects(policy.connect(f.buyer).setPolicy.staticCall(1,2,1000,2500),/GOVERNOR/);
 await assert.rejects(gov.submitAndExecute.staticCall(await policy.getAddress(),policy.interface.encodeFunctionData('setPolicy',[1,2,1000,3501])));
});

async function purchase(label,gross=u('1')){
 const nonce=id(label),i={id:await market.offerId(a[1],nonce),nonce,seller:a[2],gross,licenseHash:id('l'+label),evidenceHash:id('e'+label)};
 await tx(market.reviewOffer(a[1],i,id('r'+label),true));const q=await market.buyerQuote(a[1],gross),before=await f.token.balanceOf(a[1]);
 await tx(market.connect(f.buyer).createOffer(i,q.total));assert.equal(before-await f.token.balanceOf(a[1]),q.total);return i;
}
for(const [buyer,seller] of [[false,false],[true,false],[false,true],[true,true]])test(`settlement and wallet adapter buyer=${buyer} seller=${seller}`,async()=>{
 await balance(f.buyer,u(buyer?'100000':'100'));await balance(f.seller,u(seller?'100000':'100'));
 const config={...f.config,market:await market.getAddress(),reserve:await reserve.getAddress(),governor:await gov.getAddress(),staking:await pool.getAddress(),feeDiscounts:await policy.getAddress(),codeHashes:{...f.config.codeHashes}};
 for(const k of ['market','reserve','governor','staking','feeDiscounts'])config.codeHashes[k]=keccak256(await f.provider.getCode(config[k]));
 const {ThotChain}=await import('../../packages/chain/thot.ts'),chain=new ThotChain(config);
 try{const q=await chain.purchaseQuote(a[1],u('1'),a[2]);assert.equal(q.total,u(buyer?'.99':'1').toString());assert.equal(q.economics.seller_amount,u(seller?'.97':'.96').toString());}finally{chain.close();}
 const i=await purchase(`settle-${buyer}-${seller}`),payment=await market.paymentFor(i.id),o=await market.offers(i.id);
 assert.equal(payment.total,u(buyer?'.99':'1'));assert.equal(o.sellerAmount,u(seller?'.97':'.96'));
 await tx(market.connect(f.seller).acceptOffer(i.id,await market.quoteDigest(i.id)));await tx(market.markDelivered(i.id,i.evidenceHash));
 await f.advance(43201);await tx(market.finalize(i.id));
 const fee=payment.total-o.sellerAmount-o.referralAmount;
 assert.equal(await market.claimable(a[2]),o.sellerAmount);assert.equal(await market.claimable(a[3]),o.referralAmount);assert.equal(await market.claimable(a[4]),fee);
 for(const who of [a[2],a[3],a[4]])if(await market.claimable(who))await tx(market.claimFor(who));
 assert.equal(await f.token.balanceOf(await market.getAddress()),0n);assert.equal(await market.escrowLiability(),0n);assert.equal(await market.claimLiability(),0n);
});
test('discounted cancellation, expired delivery and policy changes preserve exact liabilities',async()=>{
 await balance(f.buyer,u('100000'));await balance(f.seller,u('100000'));
 let i=await purchase('cancel');await tx(market.connect(f.buyer).cancelOffer(i.id));assert.equal(await market.claimable(a[1]),u('.99'));await tx(market.claimFor(a[1]));
 await balance(f.buyer,u('100000'));i=await purchase('undelivered');await tx(market.connect(f.seller).acceptOffer(i.id,await market.quoteDigest(i.id)));
 await tx(gov.submitAndExecute(await policy.getAddress(),policy.interface.encodeFunctionData('setPolicy',[u('10000'),u('100000'),0,0])));
 await f.advance(172801);await tx(market.refundUndelivered(i.id));assert.equal(await market.claimable(a[1]),u('.99'));await tx(market.claimFor(a[1]));assert.equal(await f.token.balanceOf(await market.getAddress()),0n);
});
test('discounted buyer-win burns and refunds halves of actual payment, never the nominal price',async()=>{
 await tx(gov.submitAndExecute(await policy.getAddress(),policy.interface.encodeFunctionData('setPolicy',[u('10000'),u('100000'),1000,2500])));
 await balance(f.buyer,u('20000000'));await balance(f.seller,u('100000'));const i=await purchase('disputed discount',u('10000001'));
 await tx(market.connect(f.seller).acceptOffer(i.id,await market.quoteDigest(i.id)));await tx(market.markDelivered(i.id,i.evidenceHash));
 await tx(market.connect(f.buyer).dispute(i.id,id('complaint')));await tx(market.connect(f.seller).respondToDispute(i.id,id('response')));await tx(market.connect(f.seller).waiveDisputeResponseWindow(i.id));
 const payment=(await market.paymentFor(i.id)).total,dead=await market.DEAD_SINK(),burnBefore=await f.token.balanceOf(dead);
 await tx(market.voteDispute(i.id,2,id('decision')));assert.equal(await market.claimable(a[1]),payment/2n);assert.equal(await f.token.balanceOf(dead)-burnBefore,payment-payment/2n);
 await tx(market.claimFor(a[1]));assert.equal(await market.escrowLiability(),0n);assert.equal(await market.claimLiability(),0n);assert.equal(await f.token.balanceOf(await market.getAddress()),0n);
});
