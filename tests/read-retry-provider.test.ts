import test from 'node:test';
import assert from 'node:assert/strict';
import {JsonRpcProvider, type JsonRpcPayload} from 'ethers';
import {ReadRetryProvider, HEDGE_AFTER_MS} from '../packages/chain/read-retry-provider.ts';

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

  delays = [1500, 10]; let started = Date.now();
  assert.deepEqual(await provider._send(read), [{id: 1, result: 'answer after 10'}]);
  assert.ok(Date.now() - started < 1000, 'the hedged copy answers before the slow backend');
  assert.equal(sent.length, 2);

  sent.length = 0; delays = [20]; started = Date.now();
  await provider._send(read); await new Promise(resolve => setTimeout(resolve, HEDGE_AFTER_MS + 50));
  assert.equal(sent.length, 1, 'a fast answer sends no hedge');

  sent.length = 0; delays = [600];
  await provider._send({...read, method: 'eth_sendRawTransaction', params: ['0x00']});
  assert.deepEqual(sent, ['eth_sendRawTransaction'], 'transactions are never duplicated');
});
