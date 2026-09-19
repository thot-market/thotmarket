import test from 'node:test';
import assert from 'node:assert/strict';
import { createChainObserver } from '../apps/api/chain-observation.ts';
const configured = { mode: 'thot-anvil', rpc_url: 'http://anvil:8545/private-token', chain_id: 31337 };
const reply = [{ jsonrpc: '2.0', id: 2, result: '0x2a' }, { jsonrpc: '2.0', id: 1, result: '0x7a69' }];
test('read-only chain observations validate network and match responses by id', async () => {
  let calls = 0;
  const observer = createChainObserver((async (_url, options) => { calls++; assert.deepEqual(JSON.parse(String(options?.body)).map((x: any) => x.method), ['eth_chainId', 'eth_blockNumber']); return Response.json(reply); }) as typeof fetch);
  const [a,b] = await Promise.all([observer(configured), observer(configured)]);
  assert.equal(calls,1); assert.deepEqual(a,b); assert.equal(a.status,'observed'); assert.deepEqual(a.metrics,{chain_id:'31337',block_number:'42'}); assert(!JSON.stringify(a).includes('private-token'));
});
test('wrong network, missing results and errors do not become observed state', async () => {
  for (const body of [[reply[0],{...reply[1],result:'0x1'}], [reply[0],reply[0]], {}, [{...reply[0],error:{code:1}},reply[1]]]) {
    const result=await createChainObserver((async()=>Response.json(body)) as typeof fetch)(configured);
    assert.equal(result.status,'unavailable'); assert.equal(result.metrics,undefined);
  }
  assert.equal((await createChainObserver()({mode:'unconfigured'})).status,'unconfigured');
});
