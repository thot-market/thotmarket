import test from 'node:test';
import assert from 'node:assert/strict';
import {JsonRpcProvider, type JsonRpcPayload} from 'ethers';
import {ReadRetryProvider, HEDGE_AFTER_MS, FALLBACK_AFTER_MS} from '../packages/chain/read-retry-provider.ts';

test('slow read batches are hedged once; fast reads and writes are sent once', async t => {
  const original = JsonRpcProvider.prototype._send, sent: string[] = [];
  let delays: number[] = [];
  JsonRpcProvider.prototype._send = async function (payload: JsonRpcPayload | JsonRpcPayload[]) {
    const first = Array.isArray(payload) ? payload[0]! : payload, delay = delays.shift() ?? 0;
    sent.push(first.method);
    await new Promise(resolve => setTimeout(resolve, delay));
    return [{id: first.id, result: 'answer after ' + delay}];
  };
  t.after(() => { JsonRpcProvider.prototype._send = original; });
  const provider = new ReadRetryProvider('http://127.0.0.1:9', 4663, {staticNetwork: true});
  t.after(() => provider.destroy());
  const read = {jsonrpc: '2.0' as const, id: 1, method: 'eth_blockNumber', params: []};

  delays = [HEDGE_AFTER_MS+300, 10]; let started = Date.now();
  assert.deepEqual(await provider._send(read), [{id: 1, result: 'answer after 10'}]);
  assert.ok(Date.now() - started < HEDGE_AFTER_MS+200, 'the hedged copy answers before the slow backend');
  assert.equal(sent.length, 2);

  sent.length = 0; delays = [HEDGE_AFTER_MS+100];
  await provider._send(Array.from({length:5},(_,id)=>({...read,id})));
  assert.equal(sent.length,1,'large read batches are not duplicated');

  sent.length = 0; delays = [20]; started = Date.now();
  await provider._send(read); await new Promise(resolve => setTimeout(resolve, HEDGE_AFTER_MS + 50));
  assert.equal(sent.length, 1, 'a fast answer sends no hedge');

  sent.length = 0; delays = [600];
  await provider._send({...read, method: 'eth_sendRawTransaction', params: ['0x00']});
  assert.deepEqual(sent, ['eth_sendRawTransaction'], 'transactions are never duplicated');
});

test('large state reads hedge to a chain-pinned secondary without sending transactions there',async t=>{
  const original=JsonRpcProvider.prototype._send;let primary=0,secondaryReads=0,secondaryChainChecks=0;
  JsonRpcProvider.prototype._send=async function(payload:JsonRpcPayload|JsonRpcPayload[]){
    primary++;await new Promise(resolve=>setTimeout(resolve,FALLBACK_AFTER_MS+350));
    return (Array.isArray(payload)?payload:[payload]).map(p=>({id:p.id,result:'primary'}));
  };
  t.after(()=>{JsonRpcProvider.prototype._send=original;});
  class Secondary extends JsonRpcProvider {
    override async send(method:string,_params:Array<unknown>){secondaryChainChecks++;assert.equal(method,'eth_chainId');return '0x1237';}
    override async _send(payload:JsonRpcPayload|JsonRpcPayload[]){secondaryReads++;return (Array.isArray(payload)?payload:[payload]).map(p=>({id:p.id,result:'alternate'}));}
  }
  const main=new ReadRetryProvider('http://127.0.0.1:9',4663,{staticNetwork:true});
  const alternate=new Secondary('http://127.0.0.1:9',4663,{staticNetwork:true});
  main.setReadFallback(alternate,4663);t.after(()=>main.destroy());
  const batch=Array.from({length:8},(_,id)=>({jsonrpc:'2.0' as const,id,method:'eth_call',params:[{to:'0x0000000000000000000000000000000000000001'},'0x10']}));
  const started=Date.now(),result=await main._send(batch);
  assert.ok(Date.now()-started<FALLBACK_AFTER_MS+250);
  assert.equal(result.length,8);assert.equal(result[0]?.result,'alternate');
  assert.equal(secondaryReads,1);assert.equal(secondaryChainChecks,1);
  await main._send(batch);assert.equal(secondaryChainChecks,1,'chain pin is cached after validation');
  const before=secondaryReads;
  await main._send({jsonrpc:'2.0',id:9,method:'eth_sendRawTransaction',params:['0x00']});
  assert.equal(secondaryReads,before,'writes never reach the secondary');
  assert.equal(primary,3);
});

test('a secondary on the wrong chain is ignored and primary reads still work',async t=>{
  const original=JsonRpcProvider.prototype._send;
  JsonRpcProvider.prototype._send=async payload=>{await new Promise(resolve=>setTimeout(resolve,FALLBACK_AFTER_MS+100));return (Array.isArray(payload)?payload:[payload]).map(p=>({id:p.id,result:'primary'}));};
  t.after(()=>{JsonRpcProvider.prototype._send=original;});
  let checks=0,reads=0;
  class WrongChain extends JsonRpcProvider {
    override async send(){checks++;return '0x1';}
    override async _send(_payload:JsonRpcPayload|JsonRpcPayload[]):Promise<never>{reads++;throw Error('wrong chain must not serve state');}
  }
  const main=new ReadRetryProvider('http://127.0.0.1:9',4663,{staticNetwork:true});
  main.setReadFallback(new WrongChain('http://127.0.0.1:9',1,{staticNetwork:true}),4663);
  t.after(()=>main.destroy());
  const result=await main._send({jsonrpc:'2.0',id:1,method:'eth_call',params:[]});
  assert.equal(result[0]?.result,'primary');
  assert.equal(checks,1);assert.equal(reads,0);
});
