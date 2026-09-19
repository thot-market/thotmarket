import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startStandaloneWorker, startWorkerLoop } from '../apps/worker/main.ts';
import { loadThotChainConfig } from '../packages/chain/thot-config.ts';
import { startServer } from '../apps/api/server.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('analytics backfill does not block purchases, but shutdown drains its pending read',async()=>{
  const entered=deferred(),release=deferred(),sale=deferred();let closed=false,reads=0;
  const loop=startWorkerLoop({inference:{sweep:async()=>{}},service:{sweepRetention:async()=>{},runWorker:async()=>{}},thot:{sweepRetention:async()=>{},processSales:async()=>{sale.resolve();}},thotAnalytics:{refresh:async()=>{reads++;entered.resolve();await release.promise;return {complete:false};}}},{intervalMs:10});
  try{
    await Promise.all([entered.promise,sale.promise]);
    const done=loop.close().then(()=>{closed=true;});await wait(20);
    assert.equal(closed,false);assert.equal(reads,1);
    release.resolve();await done;assert.equal(closed,true);
    await wait(20);assert.equal(reads,1);
  }finally{release.resolve();await loop.close();}
});
const config = {
  rpcUrl: 'http://127.0.0.1:8545', chainId: 31337, confirmations: 1, deploymentBlock: 7,
  token: '0x' + '1'.repeat(40), market: '0x' + '2'.repeat(40), locks: '0x' + '3'.repeat(40), reserve: '0x' + '4'.repeat(40),
  codeHashes: { token: '0x' + 'a'.repeat(64), market: '0x' + 'b'.repeat(64), locks: '0x' + 'c'.repeat(64), reserve: '0x' + 'd'.repeat(64) },
};

test('standalone worker forwards the public THOT config and drains a running THOT retention check before closing its app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thot-worker-'));
  const entered = deferred(), released = deferred(), events: string[] = [];
  let running: Awaited<ReturnType<typeof startStandaloneWorker>> | undefined;
  try {
    const path = join(root, 'chain.json'); await writeFile(path, JSON.stringify(config));
    const application = {
      inference: { sweep: async () => { events.push('inference'); } },
      service: { sweepRetention: async () => { events.push('source-retention'); }, runWorker: async () => { events.push('queued-jobs'); } },
      thot: { sweepRetention: async () => { events.push('thot-retention'); entered.resolve(); await released.promise; } },
      close: async () => { events.push('app-close'); },
    };
    running = await startStandaloneWorker({ env: { DATABASE_URL: 'postgres://local-fixture', THOT_CHAIN_CONFIG_FILE: path }, createApp: async options => {
      assert.equal(options.databaseUrl, 'postgres://local-fixture');
      assert.deepEqual(options.thot, config);
      return application as any;
    } });
    await entered.promise;
    let closed = false;
    const closing = running.close().then(() => { closed = true; });
    await wait(10);
    assert.equal(closed, false);
    assert(!events.includes('app-close'));
    released.resolve(); await closing; await running.close();
    assert.equal(events.filter(event => event === 'app-close').length, 1);
    assert(events.indexOf('queued-jobs') < events.indexOf('app-close'));
  } finally { released.resolve(); await running?.close(); await rm(root, { recursive: true, force: true }); }
});

test('configured missing, malformed, null, incomplete or oversized THOT files stop startup before opening a database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thot-worker-config-'));
  try {
    assert.equal(await loadThotChainConfig(undefined), undefined);
    let creates = 0;
    for (const [name, raw] of [['missing', undefined], ['syntax', '{secret-not-logged'], ['null', 'null'], ['array', '[]'], ['incomplete', '{}'], ['bad-pin', JSON.stringify({ ...config, codeHashes: {} })], ['embedded-key', JSON.stringify({ ...config, privateKey: 'fixture-rejected-not-a-real-key' })], ['unknown-mode', JSON.stringify({ ...config, mode: 'mainnet' })], ['oversized', ' '.repeat(32_001)]]) {
      const path = join(root, name!);
      if (raw !== undefined) await writeFile(path, raw);
      await assert.rejects(startStandaloneWorker({ env: { DATABASE_URL: 'postgres://unused', THOT_CHAIN_CONFIG_FILE: path }, createApp: async () => { creates++; throw new Error('DATABASE_MUST_NOT_OPEN'); } }), /^Error: INVALID_THOT_CHAIN_CONFIG$/);
    }
    assert.equal(creates, 0);
    await assert.rejects(startStandaloneWorker({ env: {}, createApp: async () => { creates++; throw new Error('DATABASE_MUST_NOT_OPEN'); } }), /STANDALONE_WORKER_REQUIRES_POSTGRES/);
    assert.equal(creates, 0);
    const valid = join(root, 'valid.json'); await writeFile(valid, JSON.stringify(config));
    await assert.rejects(startStandaloneWorker({ env: { DATABASE_URL: 'postgres://unused', THOT_CHAIN_CONFIG_FILE: valid }, createApp: async () => { throw new Error('THOT_CODE_PIN_MISMATCH'); } }), /THOT_CODE_PIN_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker cycles never overlap; a failed THOT check stops downstream jobs and can retry', async () => {
  const entered = deferred(), released = deferred(), retried = deferred();
  let checks = 0, active = 0, maximum = 0, jobs = 0, errors = 0;
  const app = {
    inference: { sweep: async () => undefined },
    service: { sweepRetention: async () => undefined, runWorker: async () => { jobs++; retried.resolve(); } },
    thot: { sweepRetention: async () => {
      checks++; active++; maximum = Math.max(maximum, active);
      try { if (checks === 1) { entered.resolve(); await released.promise; throw new Error('RPC_UNAVAILABLE'); } }
      finally { active--; }
    } },
  };
  const loop = startWorkerLoop(app, { intervalMs: 1, onError: () => { errors++; } });
  try {
    await entered.promise; await wait(15);
    assert.equal(checks, 1); assert.equal(jobs, 0);
    released.resolve(); await retried.promise; await loop.close();
    assert.equal(maximum, 1); assert.equal(errors, 1); assert(checks >= 2); assert(jobs >= 1);
    const stoppedAt = checks; await wait(10); assert.equal(checks, stoppedAt);
  } finally { released.resolve(); await loop.close(); }
});

test('standalone CLI exits nonzero for invalid THOT config without echoing file content or database credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thot-worker-cli-'));
  try {
    const path = join(root, 'invalid.json'); await writeFile(path, '{do-not-log-this-marker');
    const child = spawn(process.execPath, ['apps/worker/main.ts'], { cwd: new URL('../', import.meta.url), env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://private-user:private-password@127.0.0.1/unused', THOT_CHAIN_CONFIG_FILE: path }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 1); assert.match(output, /worker startup failed/);
    assert(!/do-not-log-this-marker|private-password|private-user/.test(output));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('API startup also rejects a configured null THOT file instead of opening a legacy-only app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thot-api-config-'));
  const prior = process.env.THOT_CHAIN_CONFIG_FILE;
  try {
    const path = join(root, 'null.json'); await writeFile(path, 'null');
    process.env.THOT_CHAIN_CONFIG_FILE = path;
    await assert.rejects(startServer({ port: 0, dataDir: join(root, 'must-not-open') }), /^Error: INVALID_THOT_CHAIN_CONFIG$/);
    const { lstat } = await import('node:fs/promises');
    await assert.rejects(lstat(join(root, 'must-not-open')), /ENOENT/);
  } finally {
    if (prior === undefined) delete process.env.THOT_CHAIN_CONFIG_FILE; else process.env.THOT_CHAIN_CONFIG_FILE = prior;
    await rm(root, { recursive: true, force: true });
  }
});
