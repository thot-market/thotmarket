import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,parseEther,id} from 'ethers';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {THOT_STREAM_TYPES,encodeStreamSignature,verifySaleSignature} from '../packages/chain/thot-authorizations.ts';
import {THOT_AUTHORIZATION_TYPES} from '../packages/chain/thot.ts';
import {ThotStreams} from '../packages/market/src/thot-streams.ts';

test('one stream signature authorizes exact delegated releases, respects floor, revocation and bounded uses',async()=>{
 const f=await deployThotFixture();
 try{
  const delegate=Wallet.createRandom(),seller=await f.seller.getAddress(),domain={name:'thot market',version:'0.9',chainId:f.config.chainId,verifyingContract:f.config.market};
  const stream={seller,delegate:delegate.address,licenseHash:id('evaluation only'),minGross:parseEther('100').toString(),minSellerBps:3000,validUntil:await f.now()+86400,nonce:id('connection one'),maxSales:2};
  const sellerSignature=await f.seller.signTypedData(domain,THOT_STREAM_TYPES,stream);
  const sale=async(label,changes={})=>{
   const input={...await f.input(label,{gross:parseEther('100')}),licenseHash:stream.licenseHash,...changes};
   const authorization={seller,buyer:'0x0000000000000000000000000000000000000000',evidenceHash:input.evidenceHash,licenseHash:input.licenseHash,gross:input.gross.toString(),minSellerBps:3000,validUntil:stream.validUntil,nonce:id(label+':auth'),maxUses:1};
   const signature=encodeStreamSignature(stream,sellerSignature,await delegate.signTypedData(domain,THOT_AUTHORIZATION_TYPES,authorization));
   return {input,authorization,signature};
  };
  const a=await sale('one');assert.equal(verifySaleSignature(domain,THOT_AUTHORIZATION_TYPES,a.authorization,a.signature),seller);
  await (await f.market.reviewOffer(await f.buyer.getAddress(),a.input,id('one reviewed'),true)).wait();
  await (await f.market.connect(f.buyer).createAuthorizedOffer(a.input,a.authorization,a.signature,a.input.gross)).wait();
  assert.equal((await f.market.offers(a.input.id)).status,2n);assert.equal(await f.market.streamUses(seller,stream.nonce),1n);
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer(a.input,a.authorization,a.signature,a.input.gross),/revert|AUTHORIZATION_UNAVAILABLE/);
  const cheap=await sale('cheap',{gross:parseEther('99')});await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer(cheap.input,cheap.authorization,cheap.signature,cheap.input.gross),/revert|STREAM_TERMS/);
  const wrong=await sale('wrong licence',{licenseHash:id('different licence')});await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer(wrong.input,wrong.authorization,wrong.signature,wrong.input.gross),/revert|STREAM_TERMS/);
  const b=await sale('two');await(await f.market.reviewOffer(await f.buyer.getAddress(),b.input,id('two reviewed'),true)).wait();await(await f.market.connect(f.buyer).createAuthorizedOffer(b.input,b.authorization,b.signature,b.input.gross)).wait();
  const c=await sale('three');await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer(c.input,c.authorization,c.signature,c.input.gross),/revert|STREAM_UNAVAILABLE/);
  assert.equal(await f.market.streamUses(seller,stream.nonce),2n);
  stream.nonce=id('connection two');stream.maxSales=100;
  const sig=await f.seller.signTypedData(domain,THOT_STREAM_TYPES,stream),d=await sale('after revocation');
  const wrapped=encodeStreamSignature(stream,sig,await delegate.signTypedData(domain,THOT_AUTHORIZATION_TYPES,d.authorization));
  await(await f.market.connect(f.seller).revokeSaleAuthorization(stream.nonce)).wait();
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer(d.input,d.authorization,wrapped,d.input.gross),/revert|STREAM_UNAVAILABLE/);
 }finally{await f.close();}
});

test('sale-policy status stays owner-scoped and available after offchain revocation or an RPC outage',async()=>{
 const seller='0x'+'1'.repeat(40),now=Math.floor(Date.now()/1000),rows=[
  {id:'stream:active',owner_id:'alice',kind:'stream_policy',active:true,price_thot:'100',created_at:'2026-09-16T00:00:00.000Z',authorization:{seller,nonce:id('active'),validUntil:now+86400},secret_ref:'never-return-this'},
  {id:'stream:stopped',owner_id:'alice',kind:'stream_policy',revoked:true,active:false,price_thot:'50',created_at:'2026-09-15T00:00:00.000Z',authorization:{seller,nonce:id('stopped'),validUntil:now+86400},signature:'never-return-this'},
  {id:'stream:other',owner_id:'bob',kind:'stream_policy',active:true,price_thot:'999',created_at:'2026-09-16T00:00:00.000Z',authorization:{seller,nonce:id('other'),validUntil:now+86400}},
  {id:'stream:unsigned',owner_id:'alice',kind:'stream_policy',active:false,price_thot:'5',created_at:'2026-09-16T00:00:00.000Z',authorization:{seller,nonce:id('unsigned'),validUntil:now+86400}},
 ];
 const service={now:()=>new Date(now*1000).toISOString(),db:{transaction:async fn=>fn({list:async(_table,owner)=>rows.filter(row=>row.owner_id===owner)})}};
 let unavailable=false;const chain={config:{streamSales:true},snapshot:async()=>{if(unavailable)throw Error('RPC offline');return {number:100,hash:id('block'),timestamp:now};},market:{authorizationRevoked:async(_seller,nonce)=>nonce===id('stopped')},assertSnapshot:async()=>{}};
 const streams=new ThotStreams(service,chain),actor={id:'alice',role:'user'};
 const before=await streams.list(actor);assert.deepEqual(before.policies.map(p=>p.id),['stream:active','stream:stopped']);
 assert.equal(before.policies[0].onchain_revoked,false);assert.equal(before.policies[1].onchain_revoked,true);
 assert.equal(before.policies[1].offchain_revoked,true);assert.ok(!JSON.stringify(before).includes('never-return-this'));
 unavailable=true;const offline=await streams.list(actor);assert.equal(offline.chain_status,'unavailable');assert.deepEqual(offline.policies.map(p=>p.id),['stream:active','stream:stopped']);
 assert.equal(offline.policies[1].onchain_revoked,null);
 await assert.rejects(streams.list({id:'buyer',role:'buyer_admin'}),/FORBIDDEN/);
});
