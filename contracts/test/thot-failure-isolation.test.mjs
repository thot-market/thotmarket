import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {id,parseEther as u,MaxUint256} from 'ethers';
import {deployThotFixture} from '../scripts/thot-local-fixture.mjs';
let f,a,token,gov,locks,reserve,market,pool,actors;
const tx=async p=>(await p).wait();
const execute=async(actor,c,method,args=[])=>tx(actor.execute(await c.getAddress(),c.interface.encodeFunctionData(method,args)));
const govern=async(c,method,args)=>tx(gov.submitAndExecute(await c.getAddress(),c.interface.encodeFunctionData(method,args)));
before(async()=>{
 f=await deployThotFixture({activate:false,auditActors:true});a=await Promise.all(f.signers.map(s=>s.getAddress()));token=await f.deploy('ExitProbeToken',[]);gov=await f.deploy('ThotGovernor',[a.slice(0,3)]);locks=await f.deploy('ThotLockVault',[await token.getAddress()]);reserve=await f.deploy('ThotCampaignReserve',[await token.getAddress(),await gov.getAddress(),a[0]]);market=await f.deploy('ThotMarket',[await token.getAddress(),await locks.getAddress(),await reserve.getAddress(),await gov.getAddress(),a[0],a[4]]);pool=await f.deploy('ThotStakingPool',[await token.getAddress(),await gov.getAddress()]);
 actors=await Promise.all([f.deploy('ExitBeneficiary',[]),f.deploy('ExitBeneficiary',[])]);
 await tx(token.transfer(a[1],u('100')));await tx(token.connect(f.buyer).approve(await market.getAddress(),MaxUint256));
 for(const actor of actors){await tx(token.transfer(await actor.getAddress(),u('100')));for(const c of [locks,pool])await execute(actor,token,'approve',[await c.getAddress(),MaxUint256]);}
});after(async()=>f?.close());
test('failed ERC20 payouts roll back one claim and leave unrelated contract beneficiaries usable',async()=>{
 const orders=[];
 for(let n=0;n<2;n++){const nonce=id('isolation'+n),i={id:await market.offerId(a[1],nonce),nonce,seller:await actors[n].getAddress(),gross:u('1'),licenseHash:id('l'),evidenceHash:id('e')};await tx(market.connect(f.buyer).createOffer(i,u('1')));await execute(actors[n],market,'acceptOffer',[i.id,await market.quoteDigest(i.id)]);await tx(market.markDelivered(i.id,i.evidenceHash));orders.push(i);}
 await f.advance(43201);for(const i of orders)await tx(market.finalize(i.id));
 const blocked=await actors[0].getAddress(),good=await actors[1].getAddress(),claim=await market.claimable(blocked),total=await market.claimLiability();
 for(const mode of [1,2]){await tx(token.setMode(blocked,mode));await assert.rejects(market.claimFor(blocked));assert.equal(await market.claimable(blocked),claim);assert.equal(await market.claimLiability(),total);}
 await tx(market.claimFor(good));assert.equal(await token.balanceOf(good),u('100.96'));
 await tx(token.setMode(blocked,3));await tx(market.claimFor(blocked));assert.equal(await token.balanceOf(blocked),u('100.96'));await tx(market.claimFor(a[4]));assert.equal(await market.claimLiability(),0n);assert.equal(await token.balanceOf(await market.getAddress()),0n);
});
test('matured staking and lock failures isolate recipients and are retryable through contract wallets',async()=>{
 await tx(token.approve(await pool.getAddress(),u('30')));await tx(pool.fund(u('30')));const start=await f.now()+5;
 await govern(pool,'createCampaign',[start,start+86400,u('100'),u('30'),[[90*86400,3000]]]);await f.warp(start);
 for(const actor of actors){await tx(token.setMode(await actor.getAddress(),0));await execute(actor,pool,'stake',[1,0,u('10')]);await execute(actor,locks,'deposit',[u('10'),(await f.now())+91*86400]);}
 await f.advance(92*86400);const blocked=await actors[0].getAddress(),before=await pool.totalPrincipal();
 for(const mode of [1,2]){await tx(token.setMode(blocked,mode));await assert.rejects(execute(actors[0],pool,'claim',[1]));await assert.rejects(execute(actors[0],locks,'withdraw',[0]));assert.equal(await pool.totalPrincipal(),before);assert.equal((await pool.positions(1)).claimed,false);}
 await execute(actors[1],pool,'claim',[2]);await execute(actors[1],locks,'withdraw',[0]);
 await tx(token.setMode(blocked,3));await execute(actors[0],pool,'claim',[1]);await execute(actors[0],locks,'withdraw',[0]);assert.equal(await pool.totalPrincipal(),0n);assert.equal(await pool.totalRewardLiability(),0n);
});
