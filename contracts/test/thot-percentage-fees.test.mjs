import test, {before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {parseEther as u,id,MaxUint256,keccak256} from 'ethers';
import {deployThotFixture} from '../scripts/thot-local-fixture.mjs';
const DAY=86400, tx=async p=>(await p).wait();
let f,a,token,gov,treasury,pool,policy,market,snapshot;
const govern=async(c,fn,args=[])=>tx(gov.submitAndExecute(await c.getAddress(),c.interface.encodeFunctionData(fn,args)));
before(async()=>{
 f=await deployThotFixture({activate:false}); a=await Promise.all(f.signers.map(s=>s.getAddress()));
 token=await f.deploy('ThotTestToken',[a[0],u('1000000000')]);
 gov=await f.deploy('ThotGovernor',[a.slice(0,3)]);
 treasury=await f.deploy('ThotTreasury',[await token.getAddress(),await gov.getAddress(),a[0]]);
 pool=await f.deploy('ThotStakingPool',[await token.getAddress(),await treasury.getAddress()]);
 await govern(treasury,'bindStakingPool',[await pool.getAddress()]);
 policy=await f.deploy('ThotFeeDiscounts',[await token.getAddress(),await pool.getAddress(),await gov.getAddress()]);
 await govern(policy,'setPolicy',[u('10000'),u('100000'),2000,3000]);
 await govern(policy,'setLockPolicy',[u('100000'),90*DAY,3500]);
 const locks=await f.deploy('ThotLockVault',[await token.getAddress()]);
 const args=[await token.getAddress(),await locks.getAddress(),await treasury.getAddress(),await gov.getAddress(),a[0],a[4]];
 await assert.rejects(f.deploy('ThotLaunchMarket',[...args,1]));
 market=await f.deploy('ThotLaunchMarket',[...args,31337]);
 await govern(treasury,'bindMarket',[await market.getAddress()]);
 await govern(market,'bindFeeDiscounts',[await policy.getAddress()]);
 await govern(market,'queueUnpause');await govern(market,'unpause');
 await tx(token.transfer(await treasury.getAddress(),u('500000000')));
 await tx(token.connect(f.buyer).approve(await market.getAddress(),MaxUint256));
 await tx(market.connect(f.seller).registerReferrer(a[3]));
 assert.ok(f.artifacts.ThotLaunchMarket.evm.deployedBytecode.object.length/2<=24576,'EIP170');
});
after(async()=>f?.close());beforeEach(async()=>snapshot=await f.provider.send('evm_snapshot',[]));afterEach(async()=>f.provider.send('evm_revert',[snapshot]));
async function fund(buyer,seller){await tx(token.transfer(a[1],u(buyer)));await tx(token.transfer(a[2],u(seller)));}
async function buy(label,gross=u('1000')){
 const nonce=id(label),offer={id:await market.offerId(a[1],nonce),nonce,seller:a[2],gross,licenseHash:id('license'),evidenceHash:id('data')};
 await tx(market.reviewOffer(a[1],offer,id('review'),true));
 const q=await market.buyerQuote(a[1],gross),before=await token.balanceOf(a[1]);
 await tx(market.connect(f.buyer).createOffer(offer,q.total));
 assert.equal(before-await token.balanceOf(a[1]),q.total);return offer;
}
for(const [buyer,seller,bd,sd] of [['1000','0','0','0'],['10000','0','2','0'],['1000','100000','0','3'],['100000','100000','3','3']])test(`percentage settlement ${buyer}/${seller}`,async()=>{
 await fund(buyer,seller);const i=await buy(buyer+seller),o=await market.offers(i.id);
 assert.equal((await market.paymentFor(i.id)).total,u('1000')-u(bd));
 assert.equal(o.sellerAmount,u('990')+u(sd));assert.equal(o.referralAmount,u('2'));
 await tx(market.connect(f.seller).acceptOffer(i.id,await market.quoteDigest(i.id)));await tx(market.markDelivered(i.id,i.evidenceHash));
 await f.advance(43201);await tx(market.finalize(i.id));
 assert.equal(await market.claimable(a[4]),u('8')-u(bd)-u(sd));
 for(const who of [a[2],a[3],a[4]])if(await market.claimable(who))await tx(market.claimFor(who));
 assert.equal(await token.balanceOf(await market.getAddress()),0n);
});
test('lock tier requires enough live principal and expires at maturity without changing funded receipts',async()=>{
 const start=await f.now()+10;await govern(treasury,'createStakingCampaign',[start,start+DAY,u('1000000'),u('300000'),[[30*DAY,500],[90*DAY,3000]]]);
 await fund('101000','100000');await f.warp(start);
 for(const signer of [f.buyer,f.seller]){await tx(token.connect(signer).approve(await pool.getAddress(),MaxUint256));await tx(pool.connect(signer).stake(1,1,u('100000')));}
 assert.equal(await policy.rateBps(a[1]),3500n);assert.equal(await policy.rateBps(a[2]),3500n);
 const i=await buy('both locked'),digest=await market.quoteDigest(i.id);
 assert.equal((await market.paymentFor(i.id)).total,u('996.5'));assert.equal((await market.offers(i.id)).sellerAmount,u('993.5'));
 await f.warp((await pool.positions(2)).unlockAt);
 assert.equal(await policy.rateBps(a[1]),3000n);assert.equal(await market.quoteDigest(i.id),digest);
 await tx(pool.connect(f.buyer).claim(1));assert.equal(await policy.rateBps(a[1]),3000n);
});
test('short locks and split subthreshold long locks do not acquire the top tier',async()=>{
 const start=await f.now()+10;await govern(treasury,'createStakingCampaign',[start,start+DAY,u('1000000'),u('300000'),[[30*DAY,500],[90*DAY,3000]]]);
 await fund('200000','0');await tx(token.connect(f.buyer).approve(await pool.getAddress(),MaxUint256));await f.warp(start);
 await tx(pool.connect(f.buyer).stake(1,0,u('100000')));await tx(pool.connect(f.buyer).stake(1,1,u('99999')));
 assert.equal(await policy.rateBps(a[1]),3000n);await tx(pool.connect(f.buyer).stake(1,1,u('1')));assert.equal(await policy.rateBps(a[1]),3500n);
});
test('percentage rounding and prospective changes preserve funding commitments and actual refund',async()=>{
 for(const gross of [1n,99n,100n,101n,u('1000000000')])assert.equal((await market.costQuote(gross)).serviceFee,(gross+99n)/100n);
 await assert.rejects(market.costQuote(0));await assert.rejects(market.connect(f.buyer).setServiceFeeBps.staticCall(100));
 await assert.rejects(govern(market,'setServiceFeeBps',[1001]));await assert.rejects(govern(market,'executeTariff',[1,1,id('invalid')]));
 await fund('100000','100000');const i=await buy('prospective'),digest=await market.quoteDigest(i.id);
 await govern(market,'setServiceFeeBps',[200]);await govern(policy,'setPolicy',[u('10000'),u('100000'),0,0]);
 assert.equal((await market.costQuote(u('1000'))).serviceFee,u('20'));assert.equal(await market.quoteDigest(i.id),digest);
 await tx(market.connect(f.buyer).cancelOffer(i.id));assert.equal(await market.claimable(a[1]),u('997'));
 await tx(market.claimFor(a[1]));assert.equal(await token.balanceOf(await market.getAddress()),0n);
});
