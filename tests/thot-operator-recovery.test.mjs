import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,Transaction,id} from 'ethers';
import {ThotChain,ROBINHOOD_TESTNET_RPC} from '../packages/chain/thot.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {ThotMarketplace} from '../packages/market/src/thot-market.ts';

// In-memory deterministic RPC faults; no user key, real RPC or deployment.
function scenario(){
 const wallet=Wallet.createRandom(),rows=new Map(),receipts=new Map(),blocks=new Map(),broadcasts=[],signed=[];
 let nonce=0,head=10,failWait=false,failCommit=false;
 const config={mode:'robinhood-testnet',chainId:46630,rpcUrl:ROBINHOOD_TESTNET_RPC,operatorAddress:wallet.address,
  token:'0x'+'1'.repeat(40),market:'0x'+'2'.repeat(40),locks:'0x'+'3'.repeat(40),reserve:'0x'+'4'.repeat(40),
  confirmations:2,deploymentBlock:1,deploymentBlockHash:id('deployment'),codeHashes:Object.fromEntries(['token','market','locks','reserve'].map(key=>[key,id(key)]))};
 const journal={
  get:async key=>structuredClone(rows.get(key)),
  unsettled:async()=>structuredClone([...rows.values()].filter(row=>row.status==='pending')),
  latest:async()=>structuredClone([...rows.values()].filter(row=>row.block).sort((a,b)=>b.nonce-a.nonce)[0]),
  history:async()=>structuredClone([...rows.values()]),
  put:async entry=>{rows.set(entry.operation,structuredClone(entry));if(failCommit){failCommit=false;throw Error('PROCESS_LOST_AFTER_COMMIT');}},
 };
 const provider={
  getTransactionCount:async()=>nonce,
  getFeeData:async()=>({gasPrice:1n,maxFeePerGas:1n,maxPriorityFeePerGas:1n}),
  estimateGas:async()=>21000n,
  getTransactionReceipt:async hash=>receipts.get(hash)??null,
  getBlock:async number=>blocks.get(number)??null,
  assertCommitted:async raw=>assert([...rows.values()].some(row=>row.raw===raw),'exact signed bytes must already be committed'),
  broadcastTransaction:async raw=>{
   const decoded=Transaction.from(raw);
   await provider.assertCommitted(raw);
   broadcasts.push(raw);return {hash:decoded.hash};
  },
  waitForTransaction:async hash=>{
   if(failWait)throw Error('PROCESS_LOST_AFTER_BROADCAST');
   if(receipts.has(hash))return receipts.get(hash);
   const raw=broadcasts.find(raw=>Transaction.from(raw).hash===hash);assert(raw);
   const decoded=Transaction.from(raw);assert.equal(decoded.nonce,nonce,'recovery must replay in nonce order');
   nonce++;head++;const blockHash=id('block:'+head+':'+broadcasts.length);
   blocks.set(head,{hash:blockHash});
   const receipt={hash,status:1,blockNumber:head,blockHash};receipts.set(hash,receipt);return receipt;
  },destroy:()=>{},
 };
 const start=(bindJournal=true)=>{
  const chain=new ThotChain(config,{operatorSigner:{getAddress:async()=>wallet.address,signTransaction:async tx=>{signed.push(tx);return wallet.signTransaction(tx);}}});
  chain.provider.destroy();chain.provider=provider;chain.guard=async()=>{};
  chain.isCanonicalBlock=async anchor=>blocks.get(anchor.number)?.hash===anchor.hash;
  if(bindJournal)chain.bindOperatorJournal(journal);return chain;
 };
 return {start,rows,receipts,blocks,broadcasts,signed,config,provider,
  cutWait:value=>{failWait=value;},cutCommit:()=>{failCommit=true;},consumeNonce:()=>{nonce++;},
  reorg:()=>{receipts.clear();blocks.clear();nonce=0;head+=100;},
 };
}

test('restart after journal commit but before broadcast sends the committed signature once',async()=>{
 const f=scenario();let chain=f.start();f.cutCommit();
 await assert.rejects(chain.acknowledgeAvailability(id('offer'),id('release')),/PROCESS_LOST_AFTER_COMMIT/);
 assert.equal(f.signed.length,1);assert.equal(f.broadcasts.length,0);
 chain.close();chain=f.start();await chain.reconcileOperatorTransactions();
 assert.equal(f.signed.length,1);assert.equal(f.broadcasts.length,1);
 assert.equal([...f.rows.values()][0].status,'confirmed');chain.close();
});

test('restart after uncertain broadcast reuses exact raw bytes and blocks subsequent nonces until reconciled',async()=>{
 const f=scenario();let chain=f.start();f.cutWait(true);
 await assert.rejects(chain.acknowledgeAvailability(id('one'),id('release')),/PROCESS_LOST_AFTER_BROADCAST/);
 await assert.rejects(chain.acknowledgeAvailability(id('two'),id('release')),/PROCESS_LOST_AFTER_BROADCAST/);
 assert.equal(f.signed.length,1);assert.equal(new Set(f.broadcasts).size,1);
 chain.close();chain=f.start();f.cutWait(false);await chain.reconcileOperatorTransactions();
 await chain.acknowledgeAvailability(id('one'),id('release'));
 assert.equal(f.signed.length,1);assert.equal(new Set(f.broadcasts).size,1);
 await chain.acknowledgeAvailability(id('two'),id('release'));
 assert.equal(f.signed.length,2);assert.deepEqual(f.signed.map(tx=>tx.nonce),[0,1]);chain.close();
});

test('an unknown transaction consuming a journaled nonce fails closed without signing a replacement',async()=>{
 const f=scenario(),chain=f.start();f.cutWait(true);
 await assert.rejects(chain.acknowledgeAvailability(id('one'),id('release')),/PROCESS_LOST_AFTER_BROADCAST/);
 f.consumeNonce();f.cutWait(false);
 await assert.rejects(chain.acknowledgeAvailability(id('two'),id('release')),/THOT_OPERATOR_NONCE_CONFLICT/);
 assert.equal(f.signed.length,1);assert.equal(f.broadcasts.length,1);chain.close();
});

test('a reorganized confirmed suffix replays original nonce order without signing twice',async()=>{
 const f=scenario();let chain=f.start();
 await chain.acknowledgeAvailability(id('one'),id('release'));
 await chain.acknowledgeAvailability(id('two'),id('release'));
 const originals=[...f.broadcasts];f.reorg();chain.close();chain=f.start();
 await chain.reconcileOperatorTransactions();
 assert.equal(f.signed.length,2);assert.deepEqual(f.broadcasts.slice(2),originals);
 assert([...f.rows.values()].every(row=>row.status==='confirmed'&&row.block.number>100));chain.close();
});

test('an already claimed beneficiary retains its recovered payout hash without another token transfer',async()=>{
 const f=scenario(),chain=f.start(),offer=id('paid offer'),seller='0x'+'5'.repeat(40);
 const original=await chain.operatorTransaction('market','claimFor',[seller],'THOT_PAYOUT_PENDING',offer);
 chain.offer=async()=>({status:5,seller});chain.account=async()=>({claimable:'0'});
 assert.equal(await chain.finalizeAndPay(offer,seller),original.hash);
 assert.equal(f.signed.length,1);assert.equal(f.broadcasts.length,1);chain.close();
});

test('encrypted journal survives a real database/vault close and reopen before resuming a pending signature',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'thot-journal-restart-')),f=scenario();let app,chain;
 try{
  app=await createApplication({dataDir:directory});chain=f.start(false);new ThotMarketplace(app.service,chain);
  f.provider.assertCommitted=async raw=>{
   const rows=(await app.db.transaction(tx=>tx.list('thot_records'))).filter(row=>row.kind==='operator_transaction');
   assert(!JSON.stringify(rows).includes(raw),'signed raw transaction must not appear in plaintext metadata');
   const clear=await Promise.all(rows.map(row=>app.service.privacy.open(row.owner_id,row.object_ref)));
   assert(clear.some(entry=>entry.raw===raw));
  };
  f.cutWait(true);await assert.rejects(chain.acknowledgeAvailability(id('durable'),id('release')),/PROCESS_LOST_AFTER_BROADCAST/);
  await app.close();chain.close();app=await createApplication({dataDir:directory});chain=f.start(false);new ThotMarketplace(app.service,chain);
  f.cutWait(false);await chain.reconcileOperatorTransactions();
  const rows=(await app.db.transaction(tx=>tx.list('thot_records'))).filter(row=>row.kind==='operator_transaction');
  assert.equal(rows.length,1);assert.equal(rows[0].status,'confirmed');assert.equal(f.signed.length,1);assert.equal(new Set(f.broadcasts).size,1);
 }finally{chain?.close();await app?.close();await rm(directory,{recursive:true,force:true});}
});
