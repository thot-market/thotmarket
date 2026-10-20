import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, open, rm, lstat, symlink, link, utimes, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {diagnosticProgram as previousProgram} from '../scripts/hosted-startup-diagnostic.mjs';
import {collectStorageMetadata, validStorageMetadata, runStorageMetadata, metadataProgram, metadataSha256, diagnosticProgram, buildStorageMetadataCandidate} from '../scripts/hosted-storage-metadata.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const composeQuote = value => quote(value.replaceAll('$', () => '$$'));
const image = 'example.invalid/app@sha256:' + 'a'.repeat(64);
const prefix = 'stage=prestart; if node scripts/cvm-prestart.ts; then stage=app; node application.mjs; fi; ';
const fixture = () => ({services: {'private-anvil-app': {image, environment: {THOT_DATA_DIR: '/data', THOT_CVM_PRE_MIGRATION_SNAPSHOT: 'true', SYNTHETIC: 'preserved'}, volumes: ['data:/data'], command: ['flock','--no-fork','--nonblock','/data/.thot-process-lock','sh','-c',prefix + 'exec node --input-type=module -e ' + composeQuote(previousProgram)]}, other: {image: 'unchanged', volumes: ['other:/other']}}, volumes: {data: {}, other: {}}});
const pins = value => ({expectedImage: image, expectedCommandSha256: sha(JSON.stringify(value.services['private-anvil-app'].command))});
async function tree(fn) {
  const root = await mkdtemp(join(tmpdir(), 'storage-metadata-'));
  try {for (const name of ['postgres','objects','quarantine']) await mkdir(join(root, name)); return await fn(root);}
  finally {await rm(root, {recursive: true, force: true});}
}

test('metadata counts logical and allocated bytes separately without reading contents', () => tree(async root => {
  await mkdir(join(root, 'postgres', 'nested'));
  const small = join(root, 'postgres', 'nested', 'secret-file'); await writeFile(small, 'synthetic-private-content');
  await utimes(small, new Date(0), new Date(1000));
  const sparse = join(root, 'postgres', 'sparse'); const handle = await open(sparse, 'w');
  try {await handle.truncate(8 * 1024 * 1024);} finally {await handle.close();}
  await writeFile(join(root, '.thot-storage.json'), 'synthetic-key-value');
  await writeFile(join(root, '.thot-directory-lease'), 'synthetic-lease-value');
  const before = await lstat(small, {bigint: true}), sparseStat = await lstat(sparse, {bigint: true});
  const result = await collectStorageMetadata(root);
  assert(validStorageMetadata(result)); assert.equal(result.complete, true);
  const pg = result.roots.postgres;
  assert.equal(pg.files, 2); assert.equal(pg.directories, 1); assert.equal(pg.entries, 3);
  assert.equal(pg.logical_bytes, String(before.size + sparseStat.size));
  assert.equal(pg.allocated_bytes, String((before.blocks + sparseStat.blocks) * 512n));
  assert(BigInt(pg.logical_bytes) > BigInt(pg.allocated_bytes));
  assert.equal(pg.largest_file_bytes, String(sparseStat.size));
  assert.equal((await lstat(small, {bigint: true})).atimeNs, before.atimeNs);
  const encoded = JSON.stringify(result);
  for (const secret of [root,'secret-file','synthetic-private-content','synthetic-key-value','synthetic-lease-value']) assert(!encoded.includes(secret));
  assert.deepEqual({database_opened: result.database_opened, file_contents_read: result.file_contents_read, writes: result.writes}, {database_opened: false, file_contents_read: false, writes: 0});
}));

test('unsafe children are not followed and hardlink entry bytes are separate', () => tree(async root => {
  const objects = join(root, 'objects');
  await writeFile(join(objects, 'first'), 'sensitive'); await link(join(objects, 'first'), join(objects, 'second'));
  await symlink('../postgres', join(objects, 'linked-directory'));
  await writeFile(join(root, 'postgres', 'outside'), 'not-followed-through-link');
  await writeFile(join(objects, 'invalid name'), 'excluded');
  assert.equal(spawnSync('mkfifo', [join(objects, 'pipe')]).status, 0);
  const result = await collectStorageMetadata(root), record = result.roots.objects;
  assert(validStorageMetadata(result)); assert.equal(result.complete, false); assert.equal(record.complete, false);
  assert.equal(record.hardlink_files, 2); assert.equal(record.hardlink_entry_logical_bytes, String(2 * Buffer.byteLength('sensitive')));
  assert.equal(record.files, 0); assert.equal(record.logical_bytes, '0');
  assert.equal(record.symlinks, 1); assert.equal(record.special_files, 1); assert.equal(record.invalid_paths, 1);
  assert.equal(record.entries, 5);
}));

test('fixed-root and ancestor symlinks are refused, absent optional roots are explicit', () => tree(async root => {
  await rm(join(root, 'quarantine'), {recursive: true}); let result = await collectStorageMetadata(root);
  assert.equal(result.roots.quarantine.state, 'ABSENT'); assert.equal(result.roots.quarantine.complete, true);
  await symlink('postgres', join(root, 'quarantine')); result = await collectStorageMetadata(root);
  assert.equal(result.roots.quarantine.state, 'UNSAFE'); assert.equal(result.roots.quarantine.complete, false);
  const alias = root + '-alias'; await symlink(root, alias);
  try {result = await collectStorageMetadata(alias); assert.equal(result.complete, false); assert.equal(result.filesystem, null); assert(Object.values(result.roots).every(r => r.entries === 0));}
  finally {await rm(alias);}
}));

test('entry and depth bounds return incomplete records and close directory descriptors', () => tree(async root => {
  for (const name of ['postgres','objects','quarantine']) for (let i = 0; i < 5; i++) await writeFile(join(root, name, String(i)), 'x');
  const before = (await readdir('/proc/self/fd')).length;
  const limited = await collectStorageMetadata(root, {entryLimit: 3});
  assert.equal(limited.complete, false);
  for (const record of Object.values(limited.roots)) {assert.equal(record.entries, 3); assert.equal(record.entry_limit_reached, true); assert.equal(record.complete, false);}
  await mkdir(join(root, 'postgres', 'a', 'b', 'c'), {recursive: true});
  const deep = await collectStorageMetadata(root, {depthLimit: 2});
  assert.equal(deep.roots.postgres.depth_limit_reached, true); assert.equal(deep.roots.postgres.complete, false);
  assert.equal((await readdir('/proc/self/fd')).length, before);
}));

test('internal deadline returns partial metadata before the child hard timeout', () => tree(async root => {
  for (let i = 0; i < 200; i++) await writeFile(join(root, 'postgres', String(i)), 'x');
  const result = await collectStorageMetadata(root, {durationMs: 1});
  assert.equal(result.complete, false); assert(Object.values(result.roots).some(r => r.time_limit_reached));
  assert(result.roots.postgres.entries < 200);
}));

test('a directory changed during enumeration makes the metadata incomplete', () => tree(async root => {
  await writeFile(join(root, 'postgres', 'first'), 'x');
  const preload = join(root, 'race.mjs');
  await writeFile(preload, 'import fs from "node:fs/promises";import{syncBuiltinESMExports}from"node:module";const original=fs.opendir;let injected=false;fs.opendir=async(...args)=>{const dir=await original(...args),read=dir.read.bind(dir);dir.read=async()=>{const entry=await read();if(entry&&!injected){injected=true;await fs.writeFile(' + JSON.stringify(join(root, 'postgres', 'created-during-scan')) + ',"x");}return entry;};return dir;};syncBuiltinESMExports();');
  const program = metadataProgram.replace('collectStorageMetadata("/data")', 'collectStorageMetadata(' + JSON.stringify(root) + ')');
  const run = spawnSync(process.execPath, ['--import',preload,'--input-type=module','-e',program], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
  const result = JSON.parse(run.stdout); assert(validStorageMetadata(result));
  assert.equal(result.complete, false); assert.equal(result.roots.postgres.complete, false);
  assert(result.roots.postgres.changed_directories > 0);
}));

test('fixed schema rejects arbitrary child fields, unsafe completion and unbounded numbers', () => tree(async root => {
  const good = await collectStorageMetadata(root); assert(validStorageMetadata(good));
  for (const mutate of [v => v.secret = 'private', v => v.roots.postgres.path = '/private', v => v.writes = 1,
    v => v.roots.postgres.entries = Infinity, v => v.roots.postgres.symlinks = 1,
    v => v.roots.postgres.logical_bytes = '-1', v => v.roots.postgres.changed_directories = 1,
    v => v.roots.postgres.time_limit_reached = true, v => v.bounds.deadline_ms = 60000]) {
    const bad = structuredClone(good); mutate(bad); assert.equal(validStorageMetadata(bad), false);
  }
}));

for (const [stage, code] of [['lease','STORAGE_TOTAL_LIMIT'], ['app','STORAGE_TOTAL_LIMIT'], ['unknown','STORAGE_TOTAL_LIMIT'], ['prestart','UNKNOWN_PRIMARY'], ['prestart','STORAGE_ENTRY_LIMIT']]) {
  test('skips metadata for ' + stage + '/' + code, () => assert.equal(runStorageMetadata(stage, code, () => {throw Error('MUST_NOT_RUN');}), null));
}

test('real child timeout and output cap produce fixed safe failure records', () => {
  for (const [program, timeout, expected] of [['setInterval(()=>{},1000)', 60, 'TIMEOUT'], ['process.stdout.write("x".repeat(1e6))', 30000, 'OUTPUT_LIMIT']]) {
    const result = runStorageMetadata('prestart', 'STORAGE_TOTAL_LIMIT', (exe, args, options) => {
      assert.equal(args[2], metadataProgram); assert.equal(options.timeout, 30000); assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.maxBuffer, 16384); assert.deepEqual(options.stdio, ['ignore','pipe','ignore']); assert.deepEqual(options.env, {});
      return spawnSync(exe, ['-e', program], {...options, timeout});
    });
    assert.deepEqual(result, {schema: 'thot.startup-storage-metadata/1', probe_sha256: metadataSha256, status: expected, metadata: null});
  }
});

test('child failures and untrusted JSON never enter logs', () => {
  for (const child of [{status: 1, stdout: 'private-data'}, {status: 0, stdout: '{"private":"secret"}'}, {status: 0, stdout: 'not-json'}, {error: Error('secret'), stdout: 'secret'}]) {
    const result = runStorageMetadata('prestart', 'STORAGE_TOTAL_LIMIT', () => child);
    assert(['FAILED','INVALID_RESULT'].includes(result.status)); assert.equal(result.metadata, null);
    assert(!JSON.stringify(result).includes('secret') && !JSON.stringify(result).includes('private-data'));
  }
});

test('candidate preserves input and full Compose except the recognized terminal diagnostic', () => {
  const value = fixture(), before = structuredClone(value), result = buildStorageMetadataCandidate(value, pins(value));
  assert.deepEqual(value, before); assert(result.compose.services['private-anvil-app'].command[6].startsWith(prefix));
  const reversed = structuredClone(result.compose); reversed.services['private-anvil-app'].command = before.services['private-anvil-app'].command;
  assert.deepEqual(reversed, before);
  assert.throws(() => buildStorageMetadataCandidate(result.compose, pins(result.compose)), /UNRECOGNIZED_DIAGNOSTIC_SUFFIX/);
});

for (const [name, mutate] of [
  ['pin', (v, p) => p.expectedCommandSha256 = '0'.repeat(64)],
  ['image', (v, p) => p.expectedImage = 'example.invalid/app@sha256:' + 'b'.repeat(64)],
  ['missing app', v => delete v.services['private-anvil-app']],
  ['snapshot opt-in', v => v.services['private-anvil-app'].environment.THOT_CVM_PRE_MIGRATION_SNAPSHOT = false],
  ['data root', v => v.services['private-anvil-app'].environment.THOT_DATA_DIR = '/other'],
  ['entrypoint', v => v.services['private-anvil-app'].entrypoint = ['sh']],
  ['workdir', v => v.services['private-anvil-app'].working_dir = '/other'],
  ['lock', v => v.services['private-anvil-app'].command[2] = '--wait'],
  ['suffix', v => v.services['private-anvil-app'].command[6] += '; echo extra'],
]) test('builder rejects altered ' + name, () => {const value = fixture(), options = pins(value); mutate(value, options); assert.throws(() => buildStorageMetadataCandidate(value, options));});

test('actual Compose/shell-decoded program runs metadata once only on the selected failure and preserves 503', () => tree(async root => {
  await writeFile(join(root, 'objects', 'synthetic-secret-name'), 'synthetic-secret-body');
  const before = fixture(), result = buildStorageMetadataCandidate(before, pins(before));
  const encoded = result.compose.services['private-anvil-app'].command[6].slice(prefix.length + 'exec node --input-type=module -e '.length);
  const parsed = spawnSync('sh', ['-c', 'set -- ' + encoded.replaceAll('$$', () => '$') + '; test "$#" = 1 && printf "%s" "$1"'], {encoding: 'utf8'});
  assert.equal(parsed.status, 0); assert.equal(parsed.stdout, diagnosticProgram);
  const preload = join(root, 'preload.mjs');
  await writeFile(preload, 'import http from "node:http";import cp from "node:child_process";import{syncBuiltinESMExports}from"node:module";const original=cp.spawnSync;let calls=0;cp.spawnSync=(exe,args,options)=>{calls++;if(options.env&&Object.keys(options.env).length)throw Error("INHERITED_ENV");const program=args[2].replace(\'collectStorageMetadata("/data")\',' + JSON.stringify('collectStorageMetadata(' + JSON.stringify(root) + ')') + ');return original(exe,[args[0],args[1],program],options);};http.createServer=handler=>({listen(port,host){let status,headers;handler({}, {writeHead(s,h){status=s;headers=h;},end(body){process.stdout.write(JSON.stringify({probe:true,calls,status,headers,body:JSON.parse(body),port,host})+"\\n");}});}});syncBuiltinESMExports();');
  for (const [stage, code, calls] of [['prestart','STORAGE_TOTAL_LIMIT',1], ['prestart','STORAGE_ENTRY_LIMIT',0], ['app','STORAGE_TOTAL_LIMIT',0]]) {
    const log = join(root, 'error.txt'); await writeFile(log, 'Error: ' + code);
    const run = spawnSync(process.execPath, ['--import',preload,'--input-type=module','-e',parsed.stdout], {encoding: 'utf8', env: {...process.env, THOT_STARTUP_STAGE: stage, THOT_STARTUP_ERROR_FILE: log}});
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
    const lines = run.stdout.trim().split('\n').map(JSON.parse); assert.equal(lines.length, calls ? 3 : 2);
    assert.deepEqual(lines[0], {stage, code});
    if (calls) {assert.equal(lines[1].status, 'COMPLETE'); assert.equal(lines[1].probe_sha256, metadataSha256); assert(validStorageMetadata(lines[1].metadata)); assert.equal(lines[1].metadata.roots.objects.files, 1);}
    assert.deepEqual(lines.at(-1), {probe: true, calls, status: 503, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}, body: {status: 'unavailable', stage, code}, port: 4318, host: '127.0.0.1'});
    assert(!run.stdout.includes('synthetic-secret') && !run.stdout.includes(root)); await assert.rejects(lstat(log), {code: 'ENOENT'});
  }
}));
