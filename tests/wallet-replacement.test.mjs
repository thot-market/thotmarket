import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyWalletReplacement} from '../apps/dashboard/thot-ui.js';
const address=n=>'0x'+String(n).padStart(40,'0'),hash=n=>'0x'+String(n).padStart(64,'0');
const from=address(1),token=address(2),spender=address(3);
const expected={to:token,data:'0x095ea7b3'+spender.slice(2).padStart(64,'0')+(100n).toString(16).padStart(64,'0'),value:'0x0',chainId:'0x7a69'};
function fixture(overrides={}){
 const tx={hash:hash(2),from,to:token,input:expected.data,value:'0x0',chainId:'0x7a69',nonce:'0x0',...overrides.tx};
 const receipt={transactionHash:hash(2),status:'0x1',blockNumber:'0x10',blockHash:hash(3),...overrides.receipt};
 const calls=[];let receipts=0;
 const request=async p=>{calls.push(p);switch(p.method){
 case 'eth_chainId':return overrides.chain??'0x7a69';
 case 'eth_getTransactionByHash':return p.params[0]===hash(2)?tx:overrides.original??null;
 case 'eth_call':return overrides.allowance??'0x64';
 case 'eth_getTransactionReceipt':return ++receipts===2&&overrides.again!==undefined?overrides.again:receipt;
 case 'eth_blockNumber':return overrides.head??'0x10';
 case 'eth_getBlockByNumber':return {hash:overrides.blockHash??hash(3)};
 default:throw Error('Unexpected write or RPC '+p.method);
 }};
 return {calls,run:(options={})=>verifyWalletReplacement({request,expected,from,hash:hash(2),originalHash:hash(1),chainId:31337,token,...options})};
}
test('legacy approval recovery verifies exact allowance and canonical receipt without writes',async()=>{
 const f=fixture();assert.deepEqual(await f.run(),{hash:hash(2),nonce:'0x0'});
 const call=f.calls.find(p=>p.method==='eth_call');assert.equal(call.params[0].data,'0xdd62ed3e'+from.slice(2).padStart(64,'0')+spender.slice(2).padStart(64,'0'));
 assert(!f.calls.some(p=>p.method.includes('send')));
});
for(const [name,overrides,options,pattern] of [
 ['wrong wallet',{tx:{from:spender}},{},/does not match/],
 ['wrong destination',{tx:{to:spender}},{},/does not match/],
 ['cancelled transfer',{tx:{to:from,input:'0x'}},{},/does not match/],
 ['wrong calldata',{tx:{input:'0x00'}},{},/does not match/],
 ['wrong value',{tx:{value:'0x1'}},{},/does not match/],
 ['wrong chain',{chain:'0x1'},{},/Switch/],
 ['wrong transaction chain',{tx:{chainId:'0x1'}},{},/does not match/],
 ['missing nonce',{tx:{nonce:undefined}},{},/does not match/],
 ['wrong nonce',{tx:{nonce:'0x1'}},{originalNonce:'0x0'},/nonce/],
 ['insufficient allowance',{allowance:'0x63'},{},/no longer sufficient/],
 ['reverted',{receipt:{status:'0x0'}},{},/not successfully/],
 ['unmined',{receipt:{blockNumber:null}},{},/not successfully/],
 ['wrong receipt',{receipt:{transactionHash:hash(8)}},{},/not successfully/],
 ['insufficient depth',{}, {confirmations:2},/more confirmations/],
 ['noncanonical block',{blockHash:hash(8)},{},/confirmation changed/],
 ['receipt disappears',{again:null},{},/confirmation changed/],
 ['old nonapproval',{}, {expected:{...expected,data:'0xaaaa'}},/does not match/],
 ['same hash',{}, {hash:hash(1)},/new transaction hash/],
])test('rejects '+name,async()=>{await assert.rejects(fixture(overrides).run(options),pattern);});
test('unknown nonce never recovers an arbitrary historical payment',async()=>{
 const payment={...expected,data:'0xabcd'};await assert.rejects(fixture({tx:{input:payment.data}}).run({expected:payment}),/Only a verified token approval/);
});
test('known nonce permits exact payment recovery without allowance inference',async()=>{
 const payment={...expected,data:'0xabcd'};const f=fixture({tx:{input:payment.data}});await f.run({expected:payment,originalNonce:'0x0'});assert(!f.calls.some(p=>p.method==='eth_call'));
});
test('account invalidation during reconciliation stops immediately',async()=>{
 let calls=0;await assert.rejects(fixture().run({current:()=>{if(++calls>6)throw Error('Account changed');}}),/Account changed/);
});
