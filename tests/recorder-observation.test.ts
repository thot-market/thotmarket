import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorderObserver } from '../apps/api/recorder-observation.ts';
const policy = { url: 'https://recorder.example', instances: {} };
const ready = { mode: 'tee-recorder', ready: true, draining: false, active_sessions: 2, pending_opens: 1, active_requests: 3, buffered_request_bytes: 40, completed_results: 5, completed_result_bytes: 60, limits: { maxActiveSessions: 16, maxCompletedResults: 32, maxActiveRequests: 64, maxBufferedRequestBytes: 1000, maxCompletedResultBytes: 2000, completedResultTtlMs: 10000 } };
test('observations preserve real counters and share a short cached request', async () => {
  let calls = 0;
  const observe = createRecorderObserver((async () => { calls++; return Response.json(ready); }) as typeof fetch);
  const [a, b] = await Promise.all([observe(policy), observe(policy)]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(a.metrics?.active_sessions, 2); assert.equal(a.attestation_verified, false); assert.equal(a.status, 'ready');
});
test('missing, malformed, and inconsistent telemetry never become healthy zeroes', async () => {
  for (const value of [{}, { ...ready, active_sessions: -1 }, { ...ready, ready: false }, { ...ready, limits: {} }]) {
    const observe = createRecorderObserver((async () => Response.json(value)) as typeof fetch);
    const result = await observe(policy); assert.equal(result.status, 'unavailable'); assert.equal(result.metrics, undefined);
  }
  const unused = createRecorderObserver((async () => { throw Error('must not fetch'); }) as typeof fetch);
  assert.equal((await unused(undefined)).status, 'unconfigured');
  assert.equal((await unused({ ...policy, url: 'https://user:secret@recorder.example' })).status, 'unavailable');
});
test('503 draining has usable metrics, while oversized and failed requests expose no remote details', async () => {
  const draining = createRecorderObserver((async () => Response.json({ ...ready, ready: false, draining: true }, { status: 503 })) as typeof fetch);
  assert.equal((await draining(policy)).status, 'draining');
  for (const fetcher of [async () => new Response('x'.repeat(16385)), async () => { throw Error('secret upstream URL'); }]) {
    const result = await createRecorderObserver(fetcher as typeof fetch)(policy);
    assert.equal(result.status, 'unavailable'); assert.equal(result.metrics, undefined); assert(!JSON.stringify(result).includes('secret upstream'));
  }
});
