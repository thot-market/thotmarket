import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {id,parseEther as u,MaxUint256,keccak256} from 'ethers';
import {deployThotFixture} from '../scripts/thot-local-fixture.mjs';
let f,gov,pool,rebates,market,reserve,addrs,snap;
const tx=async p=>(await p).wait();
before(async()=>{
 f=await deployThotFixture({activate:false});addrs=await Promise.all(f.signers.map(s=>s.getAddress()));
 gov=await f.deploy('ThotGovernor',[addrs.slice(0,3)]);
 reserve=await f.deploy('ThotReserveVault',[await f.token.getAddress(),await gov.getAddress(),addrs[0]]);
 market=await f.deploy('ThotMarket',[await f.token.getAddress(),await f.locks.getAddress(),await reserve.getAddress(),await gov.getAddress(),addrs[0],addrs[4]]);
 pool=await f.deploy('ThotStakingPool',[await f.token.getAddress(),await gov.getAddress()]);
 rebates=await f.deploy('ThotHolderRewards',[await f.token.getAddress(),await market.getAddress(),await pool.getAddress(),await gov.getAddress(),0]);
 for(const s of [f.admin,f.buyer,f.seller]){await tx(f.token.connect(s).approve(await market.getAddress(),MaxUint256));await tx(f.token.connect(s).approve(await pool.getAddress(),MaxUint256));}
 await tx(f.token.approve(await rebates.getAddress(),MaxUint256));await tx(rebates.fund(u('10')));
 await policy();
});
after(async()=>{await f?.close();});
beforeEach(async()=>{snap=await f.provider.send('evm_snapshot',[]);});
afterEach(async()=>{await f.provider.send('evm_revert',[snap]);});
async function policy(first=u('10000'),second=u('100000'),low=1000,high=2500){await tx(gov.submitAndExecute(await rebates.getAddress(),rebates.interface.encodeFunctionData('setPolicy',[first,second,low,high])));}
async function setBalance(s,amount){const a=await s.getAddress(),b=await f.token.balanceOf(a);if(b>amount)await tx(f.token.connect(s).transfer(addrs[0],b-amount));else if(b<amount)await tx(f.token.transfer(a,amount-b));}
async function purchase(label,{reviewed=true,complete=true}={}){
 const nonce=id(label),input={id:await market.offerId(addrs[1],nonce),nonce,seller:addrs[2],gross:u('1'),evidenceHash:id('e'+label),licenseHash:id('l'+label)};
 if(reviewed)await tx(market.reviewOffer(addrs[1],input,id('review'+label),true));
 await tx(market.connect(f.buyer).createOffer(input,input.gross));
 await tx(market.connect(f.seller).acceptOffer(input.id,await market.quoteDigest(input.id)));
 await tx(market.markDelivered(input.id,input.evidenceHash));
 if(complete){await f.advance(43201);await tx(market.finalize(input.id));}return input;
}
test('real settled escrow pays both eligible parties cashback without altering proceeds or referral balances',async()=>{
 await tx(market.connect(f.seller).registerReferrer(addrs[3]));const i=await purchase('both');
 const escrowBefore=await f.token.balanceOf(await market.getAddress());
 for(const s of [f.buyer,f.seller]){const a=await s.getAddress(),q=await rebates.quote(i.id,a);assert.equal(q.amount,u('.01'));assert.equal(q.claimable,true);const before=await f.token.balanceOf(a);await tx(rebates.connect(s).claim(i.id,q.amount));assert.equal(await f.token.balanceOf(a),before+q.amount);await assert.rejects(rebates.connect(s).claim.staticCall(i.id,0),/NOT_CLAIMABLE/);}
 assert.equal(await market.claimable(addrs[2]),u('.96'));assert.equal(await market.claimable(addrs[3]),u('.006'));assert.equal(await f.token.balanceOf(await market.getAddress()),escrowBefore);assert.equal(await rebates.totalPaid(),u('.02'));
});
test('exact holding thresholds, current balances and minimum-out protect fee quotes',async()=>{
 const i=await purchase('tiers');await setBalance(f.buyer,u('9999'));assert.equal((await rebates.quote(i.id,addrs[1])).amount,0n);
 await setBalance(f.buyer,u('10000'));assert.equal((await rebates.quote(i.id,addrs[1])).amount,u('.004'));
 await setBalance(f.buyer,u('100000'));assert.equal((await rebates.quote(i.id,addrs[1])).amount,u('.01'));
 await setBalance(f.buyer,u('10000'));await assert.rejects(rebates.connect(f.buyer).claim.staticCall(i.id,u('.01')),/NOT_CLAIMABLE/);await tx(rebates.connect(f.buyer).claim(i.id,u('.004')));
});
test('staking principal qualifies without counting promised rewards or requiring staking',async()=>{
 const i=await purchase('stake eligibility');await tx(pool.fund(u('3000')));const start=await f.now()+5;
 await tx(gov.submitAndExecute(await pool.getAddress(),pool.interface.encodeFunctionData('createCampaign',[start,start+86400,u('10000'),u('3000'),[[90*86400,3000]]])));await f.warp(start);
 await setBalance(f.buyer,u('10000'));await tx(pool.connect(f.buyer).stake(1,0,u('10000')));
 assert.equal(await f.token.balanceOf(addrs[1]),0n);assert.equal(await rebates.qualifyingBalance(addrs[1]),u('10000'));assert.equal((await rebates.quote(i.id,addrs[1])).amount,u('.004'));
});
test('pending, refunded, unreviewed and unrelated users receive no claim',async()=>{
 const i=await purchase('pending',{complete:false});assert.equal((await rebates.quote(i.id,addrs[1])).claimable,false);await assert.rejects(rebates.connect(f.buyer).claim.staticCall(i.id,0),/NOT_CLAIMABLE/);
 assert.equal((await rebates.quote(i.id,addrs[5])).amount,0n);await assert.rejects(rebates.connect(f.attacker).claim.staticCall(i.id,0),/NOT_CLAIMABLE/);
 const j=await purchase('unreviewed',{reviewed:false});assert.equal((await rebates.quote(j.id,addrs[1])).amount,0n);
 const nonce=id('refund'),input={id:await market.offerId(addrs[1],nonce),nonce,seller:addrs[2],gross:u('1'),evidenceHash:id('refund-e'),licenseHash:id('refund-l')};
 await tx(market.reviewOffer(addrs[1],input,id('refund-review'),true));await tx(market.connect(f.buyer).createOffer(input,input.gross));await tx(market.connect(f.buyer).cancelOffer(input.id));assert.equal((await rebates.quote(input.id,addrs[1])).claimable,false);
});
test('one-owner prospective policy changes preserve the rates of funded orders',async()=>{
 const old=await purchase('old policy');await policy(u('10000'),u('100000'),500,2000);await f.advance(2);const next=await purchase('new policy');
 assert.equal((await rebates.quote(old.id,addrs[1])).amount,u('.01'));assert.equal((await rebates.quote(next.id,addrs[1])).amount,u('.008'));
 await assert.rejects(rebates.connect(f.attacker).setPolicy(u('1'),u('2'),100,200),/GOVERNOR/);await assert.rejects(policy(u('1'),u('2'),1000,2501),/RATES/);
});
test('pool exhaustion never borrows from escrow, principal or reserve and can recover through funding',async()=>{
 const tiny=await f.deploy('ThotHolderRewards',[await f.token.getAddress(),await market.getAddress(),await pool.getAddress(),await gov.getAddress(),0]);
 await tx(f.token.transfer(await tiny.getAddress(),1));await tx(gov.submitAndExecute(await tiny.getAddress(),tiny.interface.encodeFunctionData('setPolicy',[u('10000'),u('100000'),1000,2500])));
 const i=await purchase('capacity');assert.equal((await tiny.quote(i.id,addrs[1])).claimable,false);await assert.rejects(tiny.connect(f.buyer).claim.staticCall(i.id,0),/NOT_CLAIMABLE/);
 await tx(f.token.transfer(await tiny.getAddress(),u('.01')));await tx(tiny.connect(f.buyer).claim(i.id,u('.01')));assert.equal(await f.token.balanceOf(await tiny.getAddress()),1n);
});
test('wallet adapter pins the real deployed pool and prepares an owner claim that executes',async()=>{
 const {ThotChain}=await import('../../packages/chain/thot.ts');const {holderRewardsWorkspace,prepareHolderReward}=await import('../../packages/chain/thot-holder-rewards.ts');
 const i=await purchase('wallet adapter'),config={...f.config,market:await market.getAddress(),reserve:await reserve.getAddress(),governor:await gov.getAddress(),staking:await pool.getAddress(),holderRewards:await rebates.getAddress(),codeHashes:{...f.config.codeHashes}};
 for(const key of ['market','reserve','governor','staking','holderRewards'])config.codeHashes[key]=keccak256(await f.provider.getCode(config[key]));
 const chain=new ThotChain(config);try{const w=await holderRewardsWorkspace(chain,addrs[1],[i.id]);assert.equal(w.orders[0].claimable,true);const prepared=await prepareHolderReward(chain,addrs[1],{offer_id:i.id});assert.equal(prepared.transactions.length,1);const t=prepared.transactions[0];await tx(f.buyer.sendTransaction({to:t.to,data:t.data,value:0}));assert.equal(await rebates.paid(i.id,addrs[1]),u('.01'));await assert.rejects(prepareHolderReward(chain,addrs[1],{offer_id:i.id}),/HOLDER_REBATE_NOT_CLAIMABLE/);}finally{chain.close();}
});

test('governance wallet preparation executes prospectively and rejects nonowners',async()=>{
 const {ThotChain}=await import('../../packages/chain/thot.ts');const {prepareHolderPolicy}=await import('../../packages/chain/thot-holder-rewards.ts');
 const config={...f.config,market:await market.getAddress(),reserve:await reserve.getAddress(),governor:await gov.getAddress(),staking:await pool.getAddress(),holderRewards:await rebates.getAddress(),codeHashes:{...f.config.codeHashes}};
 for(const key of ['market','reserve','governor','staking','holderRewards'])config.codeHashes[key]=keccak256(await f.provider.getCode(config[key]));
 const chain=new ThotChain(config),input={first_threshold_atoms:u('10000').toString(),second_threshold_atoms:u('100000').toString(),first_bps:1000,second_bps:2500};
 try{await assert.rejects(prepareHolderPolicy(chain,addrs[5],input),/GOVERNANCE_OWNER_REQUIRED/);const p=await prepareHolderPolicy(chain,addrs[0],input);await tx(f.admin.sendTransaction({...p.transactions[0],value:0}));assert.equal(await rebates.policyCount(),2n);await assert.rejects(prepareHolderPolicy(chain,addrs[0],{...input,second_bps:2501}),/INVALID_HOLDER_RATES/);}finally{chain.close();}
});
