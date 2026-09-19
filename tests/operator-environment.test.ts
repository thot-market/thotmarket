import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { operatorEnvironment } from '../apps/api/operator-environment.ts';

async function setup(t: any) {
  const dataDir = await mkdtemp(join(tmpdir(), 'thot-operator-environment-'));
  const app = await createApplication({ memory: true, dataDir });
  const server = createHttpServer(app, { environmentName: 'private-dev' });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await app.close(); await rm(dataDir, {recursive:true,force:true}); });
  const call = async (path: string, token = '') => {
    const response = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const session = async (role: string) => {
    const response = await fetch(base + '/v1/dev/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
    return (await response.json() as any).token;
  };
  return { app, base, call, session };
}

test('environment dashboard module is served as JavaScript', async t => {
  const { base } = await setup(t); const response = await fetch(base + '/environment-ui.js');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /^text\/javascript/);
  assert.match(await response.text(), /createEnvironmentUI/);
});

test('operator environment reports current local observations without sensitive configuration', async t => {
  const { app, call, session } = await setup(t);
  const secret = 'https://private.example/token=DO_NOT_DISCLOSE';
  await app.privacy.seal('demo-user', { secret });
  const operator = await session('operator_security');
  const response = await call('/v1/operator/environment', operator);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = response.body;
  assert.equal(value.schema_version, 'thot.operator-environment/1'); assert.equal(value.environment.name, 'private-dev');
  assert.equal(value.environment.auth_mode, 'development'); assert.equal(value.environment.chain_mode, 'unconfigured');
  assert.ok(Number.isFinite(Date.parse(value.observed_at)));
  assert.ok(value.runtime.process.uptime_seconds >= 0); assert.ok(value.runtime.process.rss_bytes > 0); assert.ok(value.runtime.process.heap_used_bytes >= 0);
  assert.ok(value.runtime.process.cpu_user_microseconds >= 0); assert.ok(value.runtime.process.cpu_system_microseconds >= 0);
  assert.equal(value.runtime.host.source, 'os-visible-system'); assert.ok(value.runtime.host.total_memory_bytes > 0); assert.ok(value.runtime.host.free_memory_bytes >= 0 && value.runtime.host.free_memory_bytes <= value.runtime.host.total_memory_bytes); assert.ok(value.runtime.host.cpu_count >= 1);
  assert.deepEqual(value.storage.format, { backend: 'memory', key_custody: 'local-file', object_storage: 'local-file', object_key_custody: 'local-file' });
  assert.ok(value.storage.filesystem.available_bytes >= 0); assert.ok(value.storage.vault.user_objects >= 1);
  assert.deepEqual(value.services.map((row: any) => row.id), ['database', 'chain', 'inference', 'openrouter_relay', 'plaid', 'robinhood', 'model-recorder']);
  assert.equal(value.services.at(-1).status, 'unconfigured');
  assert.ok(!JSON.stringify(value).includes(secret)); assert.ok(!JSON.stringify(value).includes(app.dataDir));
});

test('operator environment requires the operator_security role', async t => {
  const { call, session } = await setup(t); const user = await session('user'), buyer = await session('buyer_admin');
  assert.equal((await call('/v1/operator/environment')).status, 401);
  assert.equal((await call('/v1/operator/environment', user)).status, 403);
  assert.equal((await call('/v1/operator/environment', buyer)).status, 403);
});

test('unavailable storage observations are explicit and never represented as healthy zeroes', async () => {
  const value = await operatorEnvironment({
    dataDir: '/path-that-does-not-exist/thot', privacy: { vault: { usage: async () => { throw Error('unavailable'); } } },
    service: { config: { development: false } }, thot: { capabilities: () => ({ mode: 'unconfigured' }) },
    inference: { capabilities: () => ({ enabled: false }) }, openrouter: { capabilities: () => ({ enabled: false }) },
    plaid: { capabilities: () => ({ plaid_linking: false }) }, robinhood: { capabilities: () => ({ robinhood_linking: false }) }, agentCapture: {},
  }, { authMode: 'external_jwt' });
  assert.equal(value.environment.name, 'unlabelled');
  assert.equal(value.storage.format, null); assert.equal(value.storage.format_reason, 'STORAGE_FORMAT_UNAVAILABLE');
  assert.equal(value.storage.filesystem.available_bytes, null); assert.equal(value.storage.filesystem.reason, 'FILESYSTEM_CAPACITY_UNAVAILABLE');
  assert.equal(value.storage.vault.user_bytes, null); assert.equal(value.storage.vault.reason, 'VAULT_USAGE_UNAVAILABLE');
});
