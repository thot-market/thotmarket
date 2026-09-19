import test from 'node:test';
import assert from 'node:assert/strict';
import {ZeroAddress,parseEther,id} from 'ethers';
import {deployThotFixture} from '../scripts/thot-local-fixture.mjs';

test('any one of three owners governs immediately while shared caps, custody, sunset and replay guards remain on Anvil',async()=>{
 const f=await deployThotFixture({activate:false});
 try{
  const a=await Promise.all(f.signers.map(s=>s.getAddress())),tx=async p=>(await p).wait();
  const owners=[f.admin,f.buyer,f.other],ownerAddresses=[a[0],a[1],a[6]];
  assert.equal(await f.provider.send('eth_chainId',[]),'0x7a69','policy is not limited to chain 46630');
  await assert.rejects(f.deploy('ThotGovernor',[[a[0],a[0],a[1]]]));
  await assert.rejects(f.deploy('ThotGovernor',[[a[0],ZeroAddress,a[1]]]));
  const gov=await f.deploy('ThotGovernor',[ownerAddresses]);
  const token=await f.deploy('ThotTestToken',[a[0],parseEther('1000000000')]);
  const locks=await f.deploy('ThotLockVault',[await token.getAddress()]);
  const reserve=await f.deploy('ThotReserveVault',[await token.getAddress(),await gov.getAddress(),a[5]]);
  const market=await f.deploy('ThotMarket',[await token.getAddress(),await locks.getAddress(),await reserve.getAddress(),await gov.getAddress(),a[0],a[4]]);
  await tx(token.transfer(await reserve.getAddress(),parseEther('500000000')));
  assert.equal(await gov.getThreshold(),1n);assert.equal(await gov.THRESHOLD(),1n);
  assert.deepEqual(Array.from(await gov.getOwners()),ownerAddresses);
  assert.equal(await reserve.GOVERNANCE_DELAY(),0n);assert.equal(await market.GOVERNANCE_DELAY(),0n);
  assert.equal(await market.DISPUTE_WINDOW(),43200n);
  assert.equal(await market.SELLER_RESPONSE_WINDOW(),86400n);
  assert.equal(await market.DISPUTE_VOTE_WINDOW(),604800n);
  for(const owner of ownerAddresses)assert.equal(await reserve.authorizedBuyers(owner),true);
  assert.equal(await reserve.authorizedBuyers(a[5]),false,'maintenance operator is not a buyer');
  const call=async(owner,target,method,args=[])=>tx(gov.connect(owner).submitAndExecute(await target.getAddress(),target.interface.encodeFunctionData(method,args)));
  const propose=async(owner,target,method,args=[])=>{
   const nonce=await gov.nextNonce(),address=await target.getAddress(),data=target.interface.encodeFunctionData(method,args);
   const op=await gov.operationId(nonce,address,data);await tx(gov.connect(owner).submit(address,data));return op;
  };
  const campaignArgs=[await market.getAddress(),0];
  await assert.rejects(reserve.queueCampaign.staticCall(...campaignArgs));
  await assert.rejects(market.queueTariff.staticCall(1n,1n,id('outsider tariff')));
  await assert.rejects(call(f.attacker,reserve,'queueCampaign',campaignArgs));
  await assert.rejects(call(f.buyer,reserve,'executeCampaign',campaignArgs),'zero delay still requires a queued authorization');
  assert.equal(await gov.nextNonce(),0n,'failed atomic target call does not consume a nonce');
  const queued=await propose(f.admin,reserve,'queueCampaign',campaignArgs);
  assert.equal(await gov.operationCount(),1n);assert.equal(await gov.operationIdAt(0),queued);
  await assert.rejects(gov.operationIdAt(1));
  await assert.rejects(gov.connect(f.attacker).confirm.staticCall(queued));
  await assert.rejects(gov.confirm.staticCall(queued));
  await tx(gov.revoke(queued));await assert.rejects(gov.execute.staticCall(queued));
  await tx(gov.connect(f.buyer).confirm(queued));
  await tx(gov.connect(f.attacker).execute(queued));
  assert.equal((await gov.operation(queued)).confirmations,1n,'one approval is sufficient even when a non-owner relays');
  assert.equal((await gov.operation(queued)).executed,true);
  await assert.rejects(gov.execute.staticCall(queued));
  await assert.rejects(gov.connect(f.buyer).revoke.staticCall(queued));
  const activation=await call(f.other,reserve,'executeCampaign',campaignArgs);
  assert.equal(await reserve.startAt(),BigInt((await f.provider.getBlock(activation.blockNumber)).timestamp));
  assert.equal(await reserve.currentDay(),0n);
  await assert.rejects(call(f.admin,reserve,'executeCampaign',campaignArgs));

  for(const [index,owner] of owners.entries()){
   await call(owner,reserve,'pause');assert.equal(await reserve.paused(),true);
   await call(owner,reserve,'queueUnpause');await call(owner,reserve,'unpause');assert.equal(await reserve.paused(),false);
   const tariff=[BigInt(index+1),BigInt(index+2),id('single-owner tariff '+index)];
   await assert.rejects(call(owner,market,'executeTariff',tariff));
   await call(owner,market,'queueTariff',tariff);await call(owner,market,'executeTariff',tariff);
   assert.equal((await market.tariff()).policyHash,tariff[2]);
   await assert.rejects(call(owner,market,'executeTariff',tariff),'consumed authorization cannot be reused');
  }

  const cap=await reserve.remainingAllowance(),third=cap/3n;
  const offer=async(label,gross)=>{const nonce=id(label);return {nonce,id:await market.offerId(await reserve.getAddress(),nonce),seller:a[2],gross,licenseHash:id('licence'),evidenceHash:id(label)};};
  const offers=await Promise.all([offer('first buyer',third),offer('second buyer',third),offer('third buyer',cap-2n*third)]);
  await assert.rejects(reserve.connect(f.attacker).purchase.staticCall(offers[0],id('review')));
  for(const [index,owner] of owners.entries())await tx(reserve.connect(owner).purchase(offers[index],id('review '+index)));
  assert.equal(await reserve.grossCommitted(),cap);assert.equal(await reserve.remainingAllowance(),0n);
  await assert.rejects(reserve.connect(f.other).purchase.staticCall(await offer('exceeds shared cap',1n),id('review')));
  await assert.rejects(reserve.connect(f.other).cancelOffer.staticCall(offers[1].id));
  for(const [index,owner] of owners.entries())await tx(reserve.connect(owner).cancelOffer(offers[index].id));
  await tx(reserve.collectReturns());assert.equal(await reserve.remainingAllowance(),0n);
  assert.equal(await token.balanceOf(await reserve.getAddress()),parseEther('500000000'),'all refunded funds remain in reserve');
  assert.equal(await reserve.grossCommitted(),cap,'refund never recycles campaign authority');
  await call(f.buyer,reserve,'queueBuyer',[a[0],false]);await call(f.buyer,reserve,'executeBuyer',[a[0],false]);
  assert.equal(await reserve.authorizedBuyers(a[0]),false);
  await assert.rejects(reserve.purchase.staticCall(await offer('revoked buyer',1n),id('review')));
  await assert.rejects(gov.submit.staticCall(await gov.getAddress(),gov.interface.encodeFunctionData('confirm',[queued])));

  const successor=await f.deploy('ThotReserveVault',[await token.getAddress(),await gov.getAddress(),a[5]]);
  const successorArgs=[await successor.getAddress(),parseEther('500000000'),id('published next campaign')];
  await call(f.other,reserve,'queueSuccessor',successorArgs);
  const migration=await propose(f.buyer,reserve,'executeSuccessor',successorArgs);
  await assert.rejects(gov.execute.staticCall(migration),'immediate governance cannot bypass 360-day sunset');
  assert.equal((await gov.operation(migration)).executed,false,'failed target remains retryable');
  await f.warp(Number(await reserve.startAt())+360*86400);
  assert.equal(await reserve.remainingAllowance(),0n);
  await tx(gov.connect(f.attacker).execute(migration));
  assert.equal(await token.balanceOf(await successor.getAddress()),parseEther('500000000'));
  assert.equal(await token.balanceOf(await reserve.getAddress()),0n);
  await assert.rejects(gov.execute.staticCall(migration));
  await assert.rejects(call(f.admin,reserve,'queueSuccessor',successorArgs));
  await assert.rejects(call(f.admin,reserve,'executeSuccessor',successorArgs));
 }finally{await f.close();}
});
