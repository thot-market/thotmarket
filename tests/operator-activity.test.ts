import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperatorActivity } from '../apps/api/operator-activity.ts';

test('operator activity keeps only grouped request evidence and searchable sanitized logs', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'thot-operator-activity-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-02T03:04:05.000Z');
  const activity = await OperatorActivity.create({ dataDir, clock: () => now, resourceIntervalMs: 0, persistIntervalMs: 0 });
  activity.record({ method: 'POST', route: '/v1/auth/wallet/verify?wallet=0xabc', status: 200, duration_ms: 42 });
  activity.record({ method: 'POST', route: '/v1/auth/wallet/verify', status: 401, duration_ms: 650 });
  activity.record({ method: 'GET', route: '/v1/orders/order-secret?token=top-secret', status: 500, duration_ms: 5 });
  const all: any = await activity.snapshot();
  assert.equal(all.traffic.cumulative_since_process_start.totals.requests, 3); assert.equal(all.wallet_login_verification.success, 1); assert.equal(all.wallet_login_verification.failed, 1);
  assert.equal(all.traffic.cumulative_since_process_start.by_route_group.wallet_verify.requests, 2); assert.equal(all.traffic.cumulative_since_process_start.by_route_group.api.errors, 1);
  const rendered = JSON.stringify(all); assert.ok(!rendered.includes('order-secret')); assert.ok(!rendered.includes('top-secret')); assert.ok(!rendered.includes('0xabc'));
  const searched: any = await activity.snapshot({ q: 'wallet_verify 401' }); assert.equal(searched.logs.entries.length, 1); assert.equal(searched.logs.entries[0].status, 401);
  await activity.close();
});

test('operator activity persists bounded observed history and reports SQL access aggregates without calling sessions people', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'thot-operator-activity-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-02T03:04:05.000Z'); let calls = 0;
  const db = { query: async () => { calls++; return { rows: [{ registered_accounts: '3', active_sessions: '5', active_session_identities: '2' }] }; } };
  let activity = await OperatorActivity.create({ dataDir, db, clock: () => now, resourceIntervalMs: 0, persistIntervalMs: 0 });
  activity.record({ method: 'GET', route: '/healthz', status: 200, duration_ms: 1 }); await activity.close();
  now += 1000; activity = await OperatorActivity.create({ dataDir, db, clock: () => now, resourceIntervalMs: 0, persistIntervalMs: 0 });
  const value: any = await activity.snapshot(); assert.equal(value.traffic.retained_24h.totals.requests, 1); assert.equal(value.traffic.cumulative_since_process_start.totals.requests, 0); assert.equal(value.auth_access.registered_accounts, 3); assert.equal(value.auth_access.active_sessions, 5); assert.equal(value.auth_access.active_session_identities, 2); assert.equal(value.auth_access.active_sessions_are_credentials_not_people, true); assert.equal(calls, 1);
  await activity.close();
});

test('restored activity rejects arbitrary persisted route and method strings',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'thot-activity-sanitize-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let activity=await OperatorActivity.create({dataDir,resourceIntervalMs:0,persistIntervalMs:0});
 activity.record({method:'GET',route:'/healthz',status:200,duration_ms:1});await activity.close();
 const file=join(dataDir,'operator-activity.v1.json'),stored=JSON.parse(await readFile(file,'utf8'));
 stored.traffic.push({...stored.traffic[0],route_group:'private/path?secret-value'});
 stored.logs.push({...stored.logs[0],method:'secret-value'});
 await writeFile(file,JSON.stringify(stored));
 activity=await OperatorActivity.create({dataDir,resourceIntervalMs:0,persistIntervalMs:0});
 const snapshot=await activity.snapshot();assert(!JSON.stringify(snapshot).includes('secret-value'));
 assert.equal((snapshot.traffic as any).retained_24h.totals.requests,1);await activity.close();
});
