import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {id,parseEther as u,ZeroHash,ZeroAddress} from 'ethers';
import {deployThotFixture} from '../scripts/thot-local-fixture.mjs';
const DAY=86400,DISPUTE_WINDOW=12*3600;let f;
before(async()=>{f=await deployThotFixture();});after(async()=>{await f?.close();});
const tx=async p=>(await p).wait();
async function isolated(fn){const s=await f.provider.send('evm_snapshot',[]);try{await fn();}finally{await f.provider.send('evm_revert',[s]);}}
async function order(label,{gross=u('1'),seller=f.seller,reviewed=true,treasury=false}={}){const buyer=treasury?await f.reserve.getAddress():await f.buyer.getAddress();const input=await f.input(label,{gross,buyerAddress:buyer,sellerAddress:await seller.getAddress()});if(reviewed)await tx(f.market.reviewOffer(buyer,input,id(label+':review'),true));if(treasury)await tx(f.reserve.purchase(input,id(label+':reserve')));else await tx(f.market.connect(f.buyer).createOffer(input,gross));return input;}
async function accepted(input,seller=f.seller){await tx(f.market.connect(seller).acceptOffer(input.id,await f.market.quoteDigest(input.id)));await tx(f.market.markDelivered(input.id,id('delivery:'+input.id)));}
async function completed(input,seller=f.seller){await accepted(input,seller);await f.advance(DISPUTE_WINDOW);await tx(f.market.finalize(input.id));}
async function tariff(c,o,policy=id('test tariff revision')){await tx(f.market.queueTariff(c,o,policy));await f.advance(7*DAY);await tx(f.market.executeTariff(c,o,policy));return policy;}
async function solvent(){assert.equal(await f.token.balanceOf(await f.market.getAddress()),await f.market.escrowLiability()+await f.market.claimLiability());}

test('test-only quoted tariff matches cost formula, no membership levy or idle-lock benefit',()=>isolated(async()=>{
 assert.ok(f.artifacts.ThotMarket.evm.deployedBytecode.object.length/2<=24576);
 const q=await f.market.costQuote(u('1'));assert.deepEqual([...q].slice(0,4),[u('.04'),u('.01'),u('.03'),u('.96')]);
 assert.equal(await f.market.buyerPricingConfigured(),true);assert.deepEqual([...(await f.market.buyerPricingTier(0))],[0n,0n]);
 const a=await f.market.buyerQuote(await f.buyer.getAddress(),u('1'));
 await tx(f.locks.connect(f.buyer).deposit(u('1000000'),await f.now()+100*DAY));await f.advance(7*DAY);
 const b=await f.market.buyerQuote(await f.buyer.getAddress(),u('1'));assert.deepEqual([...a].slice(0,3),[...b].slice(0,3));
 const before=await f.market.claimable(await f.buyer.getAddress());await f.advance(DAY);assert.equal(await f.market.claimable(await f.buyer.getAddress()),before);
 await assert.rejects(f.market.costQuote(1n),/PRICE_BELOW_SERVICE_COST/);
}));

test('fixed tariff supports exact integer rounding and rejects an undisclosed or unauthorized revision',()=>isolated(async()=>{
 await assert.rejects(f.market.connect(f.attacker).queueTariff.staticCall(1n,1n,id('x')),/GOVERNOR/);
 await assert.rejects(f.market.queueTariff.staticCall(1n,1n,ZeroHash),/TARIFF/);
 await tx(f.market.queueTariff(1n,1n,id('round')));await assert.rejects(f.market.executeTariff.staticCall(1n,1n,id('round')),/TIMELOCK/);
 await f.advance(7*DAY);await tx(f.market.executeTariff(1n,1n,id('round')));
 const q=await f.market.costQuote(7n);assert.deepEqual([...q].slice(0,4),[3n,1n,2n,4n]);
 await tx(f.market.connect(f.seller).registerReferrer(await f.referrer.getAddress()));
 const i=await order('atomic rounding',{gross:7n});await completed(i);assert.equal((await f.market.offers(i.id)).referralAmount,0n);await solvent();
}));

test('direct referral receives 20% of contribution after quoted direct cost, regardless of locks',()=>isolated(async()=>{
 const seller=await f.seller.getAddress(),referrer=await f.referrer.getAddress();await tx(f.market.connect(f.seller).registerReferrer(referrer));
 const i=await order('net referral');const o=await f.market.offers(i.id);assert.equal(o.sellerAmount,u('.96'));assert.equal(o.referralAmount,u('.006'));assert.equal(o.referralBps,2000n);
 await completed(i);assert.equal(await f.market.claimable(seller),u('.96'));assert.equal(await f.market.claimable(referrer),u('.006'));assert.equal(await f.market.claimable(await f.protocol.getAddress()),u('.034'));
 await tx(f.market.connect(f.referrer).claim());assert.equal(await f.market.claimable(referrer),0n);await assert.rejects(f.market.connect(f.referrer).claim.staticCall(),/NO_CLAIM/);await solvent();
}));

test('funded tariff and referral allocations survive later tariff changes; preview reviews do not',()=>isolated(async()=>{
 await tx(f.market.connect(f.seller).registerReferrer(await f.referrer.getAddress()));const funded=await order('funded frozen');const digest=await f.market.quoteDigest(funded.id);
 const next=await f.input('review cost revision',{gross:u('1')});await tx(f.market.reviewOffer(await f.buyer.getAddress(),next,id('review'),true));const before=await f.market.inputDigest(await f.buyer.getAddress(),next);
 await tariff(u('.1'),u('.2'));assert.equal(await f.market.quoteDigest(funded.id),digest);assert.notEqual(await f.market.inputDigest(await f.buyer.getAddress(),next),before);
 assert.equal((await f.market.tariffAtFunding(funded.id)).directCost,u('.01'));
 // Keep the already accepted delivery terms frozen while the governance delay passes.
 assert.equal((await f.market.offers(funded.id)).sellerAmount,u('.96'));
 const q=await f.market.costQuote(u('1'));assert.equal(q.sellerAmount,u('.6'));await solvent();
}));

test('referral starts at first independent funded order, within 90 days, then expires at exactly 365 days',()=>isolated(async()=>{
 await tx(f.market.connect(f.seller).registerReferrer(await f.referrer.getAddress()));const r=await f.market.attributions(await f.seller.getAddress());
 await f.warp(Number(r.acceptedAt)+89*DAY);const first=await order('first external');const start=await f.market.firstExternalOrderAt(first.seller);assert.equal(start,(await f.market.offers(first.id)).issuedAt);
 const before=await f.input('last eligible',{gross:u('1')}),at=await f.input('expired',{gross:u('1')});for(const i of [before,at])await tx(f.market.reviewOffer(await f.buyer.getAddress(),i,id('eligible'),true));
 await f.provider.send('evm_setNextBlockTimestamp',[Number(start)+365*DAY-1]);await tx(f.market.connect(f.buyer).createOffer(before,before.gross));assert.equal((await f.market.offers(before.id)).referralAmount,u('.006'));
 await f.provider.send('evm_setNextBlockTimestamp',[Number(start)+365*DAY]);await tx(f.market.connect(f.buyer).createOffer(at,at.gross));assert.equal((await f.market.offers(at.id)).referralAmount,0n);
 assert.equal(await f.market.REFERRAL_TERM(),365n*BigInt(DAY));await solvent();
}));

test('late activation, treasury, unreviewed, self-referral buyer and refunds create no referral payout',()=>isolated(async()=>{
 await tx(f.market.connect(f.seller).registerReferrer(await f.referrer.getAddress()));const treasury=await order('reserve exclusion',{treasury:true});assert.equal((await f.market.offers(treasury.id)).referralAmount,0n);assert.equal(await f.market.firstExternalOrderAt(treasury.seller),0n);
 const unreviewed=await order('unreviewed exclusion',{reviewed:false});assert.equal((await f.market.offers(unreviewed.id)).referralAmount,0n);
 const good=await order('refund exclusion');await tx(f.market.connect(f.buyer).cancelOffer(good.id));assert.equal(await f.market.claimable(await f.referrer.getAddress()),0n);
 await tx(f.market.connect(f.other).registerReferrer(await f.referrer.getAddress()));const r=await f.market.attributions(await f.other.getAddress());await f.warp(Number(r.acceptedAt)+90*DAY);const late=await order('late activation',{seller:f.other});assert.equal((await f.market.offers(late.id)).referralAmount,0n);assert.equal(await f.market.firstExternalOrderAt(late.seller),0n);await solvent();
}));

test('referrer buying cannot activate the referral clock or preserve eligibility past day 90',t=>isolated(async()=>{
 const seller=await f.seller.getAddress(),referrer=await f.referrer.getAddress();await tx(f.market.connect(f.seller).registerReferrer(referrer));
 const attribution=await f.market.attributions(seller);await f.warp(Number(attribution.acceptedAt)+89*DAY);
 const selfPurchase=await f.input('referrer activation exclusion',{buyerAddress:referrer,gross:u('1')});
 await tx(f.market.reviewOffer(referrer,selfPurchase,id('referrer purchase review'),true));
 await tx(f.market.connect(f.referrer).createOffer(selfPurchase,selfPurchase.gross));
 const selfOffer=await f.market.offers(selfPurchase.id);assert.equal(selfOffer.referrer,ZeroAddress);assert.equal(selfOffer.referralAmount,0n);
 assert.equal(await f.market.firstExternalOrderAt(seller),0n);
 await tx(f.market.connect(f.referrer).cancelOffer(selfPurchase.id));await tx(f.market.connect(f.referrer).claim());
 await f.warp(Number(attribution.acceptedAt)+100*DAY);const external=await order('external after referrer purchase');
 assert.equal(await f.market.firstExternalOrderAt(seller),0n);assert.equal((await f.market.offers(external.id)).referralAmount,0n);
 await completed(external);assert.equal(await f.market.claimable(referrer),0n);await solvent();
 t.diagnostic(`ThotMarket deployed bytecode: ${f.artifacts.ThotMarket.evm.deployedBytecode.object.length/2} bytes`);
}));

test('seller alone may close response early, only after a confirmed response; vote and costly remedy remain onchain',()=>isolated(async()=>{
 const i=await order('voluntary final response',{gross:u('10000000')});await accepted(i);await tx(f.market.connect(f.buyer).dispute(i.id,id('serious complaint')));
 const initial=await f.market.disputeCases(i.id);assert.equal(initial.voteStartsAt-initial.openedAt,BigInt(DAY));
 await assert.rejects(f.market.connect(f.seller).waiveDisputeResponseWindow.staticCall(i.id),/RESPONSE_WINDOW/);
 await tx(f.market.connect(f.seller).respondToDispute(i.id,id('final seller response')));
 await assert.rejects(f.market.waiveDisputeResponseWindow.staticCall(i.id),/SELLER_OR_STATUS/);
 await tx(f.market.connect(f.seller).waiveDisputeResponseWindow(i.id));const c=await f.market.disputeCases(i.id);assert.equal(c.voteEndsAt-c.voteStartsAt,7n*BigInt(DAY));
 await assert.rejects(f.market.connect(f.seller).waiveDisputeResponseWindow.staticCall(i.id),/RESPONSE_WINDOW/);
 await tx(f.market.voteDispute(i.id,2,id('reasoned decision')));assert.equal((await f.market.offers(i.id)).status,6n);assert.equal(await f.market.claimable(await f.buyer.getAddress()),u('5000000'));assert.equal(await f.token.balanceOf(await f.market.DEAD_SINK()),u('5000000'));await solvent();
}));

test('an early uphold resolves review but seller payout still waits for the twelve-hour delivery deadline',()=>isolated(async()=>{
 const i=await order('early uphold preserves delivery window',{gross:u('10000000')});await accepted(i);
 const delivery=await f.market.offers(i.id);await tx(f.market.connect(f.buyer).dispute(i.id,id('serious complaint')));
 await tx(f.market.connect(f.seller).respondToDispute(i.id,id('final seller response')));
 await tx(f.market.connect(f.seller).waiveDisputeResponseWindow(i.id));
 const c=await f.market.disputeCases(i.id);assert.equal(c.voteEndsAt-c.voteStartsAt,7n*BigInt(DAY));
 await tx(f.market.voteDispute(i.id,1,id('early uphold')));
 assert.equal((await f.market.disputeCases(i.id)).outcome,1n);
 assert.ok(await f.now()<Number(delivery.deliveredAt)+DISPUTE_WINDOW);
 await assert.rejects(f.market.finalize.staticCall(i.id),/NOT_FINALIZABLE/);
 assert.equal(await f.market.claimable(i.seller),0n);
 await f.warp(Number(delivery.deliveredAt)+DISPUTE_WINDOW);await tx(f.market.finalize(i.id));
 assert.equal(await f.market.claimable(i.seller),delivery.sellerAmount);await solvent();
}));
