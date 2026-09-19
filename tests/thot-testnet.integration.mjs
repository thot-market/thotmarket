import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { Contract, HDNodeWallet, JsonRpcProvider, Wallet, id, parseEther } from 'ethers';
import { deployThotFixture } from '../contracts/scripts/thot-local-fixture.mjs';
import { ThotChain, THOT_AUTHORIZATION_TYPES, THOT_MARKET_ABI, THOT_LOCK_ABI, THOT_TOKEN_ABI, THOT_RESERVE_ABI, ROBINHOOD_TESTNET_RPC } from '../packages/chain/thot.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {ThotMarketplace} from '../packages/market/src/thot-market.ts';

// Deterministic PUBLIC Anvil fixture seed. No user credential or public RPC is used.
const fixtureSigner = () => HDNodeWallet.fromPhrase('test test test test test test test test test test test junk');
const fakeConfig = {mode:'robinhood-testnet',chainId:46630,rpcUrl:ROBINHOOD_TESTNET_RPC,confirmations:2,deploymentBlock:1,deploymentBlockHash:id('deployment'),operatorAddress:fixtureSigner().address,
 token:'0x'+'1'.repeat(40),market:'0x'+'2'.repeat(40),locks:'0x'+'3'.repeat(40),reserve:'0x'+'4'.repeat(40),codeHashes:Object.fromEntries(['token','market','locks','reserve'].map(key=>[key,id(key)]))};

test('testnet activation requires an explicit network, operator, exact HTTPS endpoint and confirmations',()=>{
 for(const patch of [
  {mode:undefined}, {mode:'local-anvil'}, {chainId:4663}, {chainId:1}, {confirmations:1},
  {rpcUrl:'https://rpc.mainnet.chain.robinhood.com'}, {rpcUrl:'http://rpc.testnet.chain.robinhood.com'},
  {rpcUrl:ROBINHOOD_TESTNET_RPC+'?override=1'}, {rpcUrl:ROBINHOOD_TESTNET_RPC+'/proxy'},
  {rpcUrl:'https://user:password@rpc.testnet.chain.robinhood.com'}, {rpcUrl:'http://127.0.0.1:8545'},
  {localDeliverySigner:fakeConfig.operatorAddress}, {operatorAddress:undefined}, {deploymentBlockHash:undefined},
 ])assert.throws(()=>new ThotChain({...fakeConfig,...patch}));
 const readOnly=new ThotChain(fakeConfig);
 try{assert.equal(readOnly.operatorAvailable(),false);assert.equal(readOnly.capabilities().production_enabled,false);assert.equal(readOnly.capabilities().mode,'thot-testnet');}
 finally{readOnly.close();}
});

test('a temporarily missing public block retries its original confirmed height and persistent gaps fail closed',async()=>{
 const chain=new ThotChain(fakeConfig);chain.provider.destroy();
 const realGuard=chain.guard.bind(chain);chain.guard=async()=>{};
 const hash=id('confirmed head'),targets=[];let reads=0;
 chain.provider={getBlockNumber:async()=>20,getBlock:async n=>{targets.push(n);return ++reads<3?null:{hash,timestamp:123};},destroy:()=>{}};
 try{
  assert.deepEqual(await chain.snapshot(),{number:19,hash,timestamp:123});assert.deepEqual(targets,[19,19,19]);
  reads=0;chain.provider.getBlock=async n=>{reads++;assert.equal(n,19);return null;};
  await assert.rejects(chain.snapshot(),/THOT_BLOCK_UNAVAILABLE/);assert.equal(reads,5);
  reads=0;chain.provider.getBlock=async()=>{reads++;throw new Error('RPC_TRANSPORT_FAILURE');};
  await assert.rejects(chain.snapshot(),/RPC_TRANSPORT_FAILURE/);assert.equal(reads,1);
  reads=0;chain.provider.getBlock=async()=>{reads++;return {hash:id('changed block')};};
  await assert.rejects(chain.assertSnapshot({number:19,hash}),/THOT_SNAPSHOT_CHANGED/);assert.equal(reads,1);
  chain.guard=async()=>{throw new Error('THOT_DEPLOYMENT_ANCHOR_MISMATCH');};reads=0;
  await assert.rejects(chain.snapshot(),/THOT_DEPLOYMENT_ANCHOR_MISMATCH/);assert.equal(reads,0);
 }finally{chain.guard=realGuard;chain.close();}
});

test('public-testnet adapter uses only scoped raw signatures and confirmed canonical state',async t=>{
 const f=await deployThotFixture({chainId:46630});
 const rawSigner=fixtureSigner();let signed=[];
 const signer={getAddress:()=>rawSigner.getAddress(),signTransaction:async tx=>{signed.push(tx);return rawSigner.signTransaction(tx);}};
 const config={...f.config,mode:'robinhood-testnet',rpcUrl:ROBINHOOD_TESTNET_RPC,confirmations:2,operatorAddress:f.config.operator};
 const chain=new ThotChain(config,{operatorSigner:signer});
 const directory=await mkdtemp(join(tmpdir(),'thot-testnet-journal-')),app=await createApplication({dataDir:directory,memory:true});
 new ThotMarketplace(app.service,chain); // Actual encrypted durable-journal adapter.
 // Replace the transport strictly inside this test. Config and every on-chain
 // guard remain unchanged; the isolated Anvil is deliberately chain 46630.
 chain.provider.destroy();chain.provider=new JsonRpcProvider(f.config.rpcUrl,46630,{cacheTimeout:-1,batchMaxCount:1});chain.provider.pollingInterval=20;
 chain.market=new Contract(config.market,THOT_MARKET_ABI,chain.provider);chain.locks=new Contract(config.locks,THOT_LOCK_ABI,chain.provider);
 chain.token=new Contract(config.token,THOT_TOKEN_ABI,chain.provider);chain.reserve=new Contract(config.reserve,THOT_RESERVE_ABI,chain.provider);
 const transport=chain.provider.send.bind(chain.provider);let rawBroadcasts=0;
 chain.provider.send=async(method,params)=>{
  assert(!['eth_sendTransaction','eth_signTransaction','eth_accounts','personal_unlockAccount'].includes(method),'public adapter attempted unlocked RPC signing');
  if(method==='eth_sendRawTransaction')rawBroadcasts++;
  return transport(method,params);
 };
 let miner;const mined=async()=>{await f.provider.send('evm_mine',[]);};
 try{
  // Model low-cost L2 fee quotes rather than Anvil's default 1-gwei tip.
  await f.provider.send('anvil_setNextBlockBaseFeePerGas',['0x0']);
  chain.provider.getFeeData=async()=>({gasPrice:1_000_000n,maxFeePerGas:2_000_000n,maxPriorityFeePerGas:1_000_000n});
  await mined();await chain.guard();
  const seller=await f.seller.getAddress();
  const offer=await f.input('testnet signed sample',{buyerAddress:config.reserve,gross:parseEther('1000')});
  const authorization={seller,buyer:config.reserve,evidenceHash:offer.evidenceHash,licenseHash:offer.licenseHash,gross:offer.gross,minSellerBps:3000,validUntil:(await f.now())+30*86400,nonce:id('testnet auth'),maxUses:1};
  const signature=await f.seller.signTypedData(chain.authorizationDomain(),THOT_AUTHORIZATION_TYPES,authorization);
  await t.test('wrong signer cannot reach a signing request or broadcast',async()=>{
   const wrong=new ThotChain(config,{operatorSigner:Wallet.createRandom()});wrong.provider.destroy();wrong.provider=chain.provider;wrong.market=chain.market;wrong.reserve=chain.reserve;wrong.token=chain.token;wrong.locks=chain.locks;
   await assert.rejects(wrong.guard(),/THOT_SIGNER_MISMATCH/);assert.equal(signed.length,0);
  });
  await t.test('unapproved methods and oversized fee quotes are rejected before signing',async()=>{
   await assert.rejects(chain.operatorTransaction('market','approve',[config.reserve,parseEther('1')],'unused'),/THOT_OPERATOR_METHOD_DENIED/);
   const feeData=chain.provider.getFeeData;
   chain.provider.getFeeData=async()=>({gasPrice:100_000_000_000n,maxFeePerGas:100_000_000_000n,maxPriorityFeePerGas:1_000_000n});
   try{await assert.rejects(chain.purchaseSample(offer,authorization,signature,id('review')),/THOT_OPERATOR_TRANSACTION_COST_LIMIT/);assert.equal(signed.length,0);}
   finally{chain.provider.getFeeData=feeData;}
  });
  await t.test('a signer cannot substitute its own destination or access list',async()=>{
   const good=signer.signTransaction;
   try{for(const extra of [{to:config.token},{accessList:[{address:config.token,storageKeys:[]}]}]){
    signer.signTransaction=tx=>rawSigner.signTransaction({...tx,...extra});
    await assert.rejects(chain.purchaseSample(offer,authorization,signature,id('review')),/THOT_SIGNED_TRANSACTION_MISMATCH/);assert.equal(rawBroadcasts,0);
   }}
   finally{signer.signTransaction=good;}
  });
  await t.test('reserve funding, delivery and configured-window automatic payout use the external signer',async()=>{
   miner=setInterval(()=>void mined(),100);
   const purchase=await chain.purchaseSample(offer,authorization,signature,id('review'));
   assert.match(purchase,/^0x[\da-f]{64}$/i);assert.equal((await chain.offer(offer.id)).status,2);
   await chain.acknowledgeAvailability(offer.id,offer.evidenceHash);
   const delivered=await chain.offer(offer.id);assert.equal(delivered.status,3);
   await assert.rejects(chain.finalizeAndPay(offer.id,seller),/THOT_NOT_FINALIZED/);
   await assert.rejects(chain.finalizeAndPay(offer.id,await f.other.getAddress()),/THOT_PAYOUT_BENEFICIARY_MISMATCH/);
   await f.advance(Number(await f.market.DISPUTE_WINDOW())+1);await mined();
   const before=await f.token.balanceOf(seller);const payout=await chain.finalizeAndPay(offer.id,seller);
   assert.match(payout,/^0x[\da-f]{64}$/i);assert.equal(await f.token.balanceOf(seller)-before,parseEther('999.96'));
   assert.equal((await chain.offer(offer.id)).status,5);assert.equal(await chain.finalizeAndPay(offer.id,seller),payout);
   assert.equal(rawBroadcasts,4); // reserve purchase, delivery, finalization, beneficiary claim
   const journalRows=(await app.db.transaction(tx=>tx.list('thot_records'))).filter(row=>row.kind==='operator_transaction');
   assert.equal(journalRows.length,4);assert(journalRows.every(row=>row.status==='confirmed'&&row.object_ref&&!row.raw));
   assert(!JSON.stringify(journalRows).includes(signed[0].data));
   const allowed=new Set(['purchaseAuthorized','markDelivered','finalize','claimFor']);
   for(const tx of signed){
    assert.equal(tx.chainId,46630);assert.equal(tx.value,0n);assert(tx.gasLimit<=2000000n);
    const contract=tx.to===config.reserve?chain.reserve:chain.market;assert(allowed.has(contract.interface.parseTransaction(tx).name));
   }
   clearInterval(miner);miner=undefined;
  });
  await t.test('an undelivered purchase refunds the buyer through the same restricted signer',async()=>{
   const buyer=await f.buyer.getAddress(),input=await f.input('testnet undelivered refund',{gross:parseEther('1000')});
   const auth={...authorization,buyer,evidenceHash:input.evidenceHash,licenseHash:input.licenseHash,nonce:id('refund auth'),validUntil:(await f.now())+30*86400};
   const sig=await f.seller.signTypedData(chain.authorizationDomain(),THOT_AUTHORIZATION_TYPES,auth);
   await(await f.market.reviewOffer(buyer,input,id('undelivered refund reviewed'),true)).wait();await mined();
   await(await f.market.connect(f.buyer).createAuthorizedOffer(input,auth,sig,input.gross)).wait();await mined();
   await f.advance(48*3600+1);await mined();
   miner=setInterval(()=>void mined(),100);
   const before=await f.token.balanceOf(buyer),hash=await chain.refundOverdueAndPay(input.id);
   assert.match(hash,/^0x[\da-f]{64}$/i);assert.equal(await f.token.balanceOf(buyer)-before,parseEther('1000'));
   assert.equal((await chain.offer(input.id)).status,6);assert.equal(await chain.refundOverdueAndPay(input.id),hash);
   assert.equal(new Set(signed.map(tx=>tx.nonce)).size,signed.length);
   clearInterval(miner);miner=undefined;
  });
  await t.test('confirmation depth excludes a fresh transfer until another block exists',async()=>{
   const before=BigInt((await chain.account(seller)).balance);
   await(await f.token.transfer(seller,13n)).wait();
   assert.equal(BigInt((await chain.account(seller)).balance),before);
   await mined();assert.equal(BigInt((await chain.account(seller)).balance),before+13n);
  });
  await t.test('a changed deployment or runtime cannot use the external signer',async()=>{
   const before=signed.length;
   await f.provider.send('anvil_setCode',[config.market,'0x60006000fd']);
   await assert.rejects(chain.acknowledgeAvailability(offer.id,offer.evidenceHash),/THOT_CODE_PIN_MISMATCH/);
   assert.equal(signed.length,before);
  });
 }finally{clearInterval(miner);chain.close();await app.close();await rm(directory,{recursive:true,force:true});await f.close();}
});
