import test from 'node:test';
import assert from 'node:assert/strict';
import {atomicCartSupported,atomicCartCalls,atomicCartRequestId,atomicCartConfirmation} from '../apps/dashboard/atomic-cart.js';

const buyer='0x0000000000000000000000000000000000000001';
const token='0x0000000000000000000000000000000000000002';
const market='0x0000000000000000000000000000000000000003';
const hash=n=>'0x'+String(n).padStart(64,'0');
const approve=n=>'0x095ea7b3'+market.slice(2).padStart(64,'0')+BigInt(n).toString(16).padStart(64,'0');
const item=(n,id)=>({prepared:{id:hash(id),buyer_total:String(n),transactions:[{to:token,data:approve(n),value:'0x0',chainId:'0x7a69'},{to:market,data:'0xdeadbeef'+String(id).padStart(64,'0'),value:'0x0',chainId:'0x7a69'}]}});

test('atomic wallet capability is enabled only for the selected chain and account',async()=>{
 const calls=[],request=async p=>{calls.push(p);return {'0x7a69':{atomic:{status:'supported'}}};};
 assert.equal(await atomicCartSupported(request,buyer,31337),true);
 assert.deepEqual(calls,[{method:'wallet_getCapabilities',params:[buyer,['0x7a69']]}]);
 assert.equal(await atomicCartSupported(async()=>({'0x1':{atomic:{status:'supported'}}}),buyer,31337),false);
 assert.equal(await atomicCartSupported(async()=>({'0x7a69':{atomic:{status:'unsupported'}}}),buyer,31337),false);
 assert.equal(await atomicCartSupported(async()=>{throw Error('not implemented');},buyer,31337),false);
});

test('atomic checkout sets one exact total allowance, buys all items, then clears approval',()=>{
 const a=item(100n,1),b=item(997n,2);
 const batch=atomicCartCalls([a,b],{token,market,chainId:31337});
 assert.equal(batch.total,1097n);assert.equal(batch.chainId,'0x7a69');assert.equal(batch.calls.length,4);
 assert.deepEqual(batch.calls.map(c=>c.to),[token,market,market,token]);
 assert.equal(batch.calls[0].data,approve(1097n));assert.equal(batch.calls[3].data,approve(0n));
 assert.equal(batch.calls[1].data,a.prepared.transactions[1].data);assert.equal(batch.calls[2].data,b.prepared.transactions[1].data);
 assert(batch.calls.every(c=>c.value==='0x0'));
 const changed=item(100n,1);changed.prepared.transactions[0].data=approve(101n);
 assert.throws(()=>atomicCartCalls([changed],{token,market,chainId:31337}),/does not match/);
 const wrongMarket=item(100n,1);wrongMarket.prepared.transactions[1].to=buyer;
 assert.throws(()=>atomicCartCalls([wrongMarket],{token,market,chainId:31337}),/does not match/);
});

test('batch IDs are valid and distinct',()=>{
 const a=atomicCartRequestId(),b=atomicCartRequestId();assert.match(a,/^0x[0-9a-f]{64}$/);assert.notEqual(a,b);
});

test('confirmation requires one atomic successful receipt and stable chain confirmations',async()=>{
 const record={id:hash(41),wallet:buyer,chainId:31337},txHash=hash(42),blockHash=hash(43);
 const request=async({method})=>({eth_chainId:'0x7a69',wallet_getCallsStatus:{id:record.id,chainId:'0x7a69',status:200,atomic:true,receipts:[{transactionHash:txHash,status:'0x1'}]},eth_getTransactionReceipt:{transactionHash:txHash,status:'0x1',blockNumber:'0x10',blockHash},eth_blockNumber:'0x11',eth_getBlockByNumber:{hash:blockHash}})[method];
 assert.deepEqual(await atomicCartConfirmation(request,record,2),{state:'confirmed',transactionHashes:[txHash]});
 const secondHash=hash(44);
 assert.deepEqual(await atomicCartConfirmation(async p=>p.method==='wallet_getCallsStatus'?{id:record.id,chainId:'0x7a69',status:200,atomic:true,receipts:[{transactionHash:txHash,status:'0x1'},{transactionHash:secondHash,status:'0x1'}]}:p.method==='eth_getTransactionReceipt'?{transactionHash:p.params[0],status:'0x1',blockNumber:'0x10',blockHash}:request(p),record,2),{state:'confirmed',transactionHashes:[txHash,secondHash]});
 assert.deepEqual(await atomicCartConfirmation(async p=>p.method==='wallet_getCallsStatus'?{id:record.id,chainId:'0x7a69',status:100}:request(p),record,1),{state:'pending'});
 assert.deepEqual(await atomicCartConfirmation(async p=>p.method==='wallet_getCallsStatus'?{id:record.id,chainId:'0x7a69',status:400}:request(p),record,1),{state:'failed'});
 await assert.rejects(atomicCartConfirmation(async p=>p.method==='wallet_getCallsStatus'?{id:record.id,chainId:'0x7a69',status:200,atomic:false,receipts:[]}:request(p),record,1),/uncertain/);
});
