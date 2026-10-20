#!/usr/bin/env node
// Offline candidate preparation. The generated child reads filesystem metadata only.
import assert from 'node:assert/strict';
import {constants, readFileSync, writeFileSync} from 'node:fs';
import {lstat, open, opendir, statfs} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {diagnosticProgram as previousProgram, diagnosticSha256 as previousSha256} from './hosted-startup-diagnostic.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

export async function collectStorageMetadata(root = '/data', {entryLimit = 25000, depthLimit = 16, durationMs = 20000} = {}) {
  if (!Number.isInteger(entryLimit) || entryLimit < 1 || entryLimit > 25000 || !Number.isInteger(depthLimit) || depthLimit < 1 || depthLimit > 16 || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 20000) throw Error('INVALID_BOUNDS');
  const deadline = performance.now() + durationMs, expired = () => performance.now() >= deadline;
  const names = ['postgres', 'objects', 'quarantine'];
  const summary = () => ({state: 'ERROR', complete: false, entries: 0, files: 0, directories: 0,
    logical_bytes: '0', allocated_bytes: '0', largest_file_bytes: '0', hardlink_files: 0,
    hardlink_entry_logical_bytes: '0', hardlink_entry_allocated_bytes: '0', symlinks: 0,
    special_files: 0, invalid_paths: 0, unreadable_entries: 0, changed_directories: 0,
    entry_limit_reached: false, depth_limit_reached: false, time_limit_reached: false});
  const result = {schema: 'thot.storage-metadata/1', complete: false,
    totals_scope: 'single_link_regular_files', roots: Object.fromEntries(names.map(name => [name, summary()])),
    filesystem: null, bounds: {entry_limit_per_root: entryLimit, depth_limit: depthLimit, deadline_ms: durationMs},
    database_opened: false, file_contents_read: false, writes: 0};
  const fdPath = handle => '/proc/self/fd/' + handle.fd;
  const childPath = (handle, name) => {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw Error('INVALID_CHILD');
    return fdPath(handle) + '/' + name;
  };
  const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  async function openDirectory(path) {
    const before = await lstat(path, {bigint: true});
    if (!before.isDirectory() || before.isSymbolicLink()) throw Error('UNSAFE_DIRECTORY');
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat({bigint: true});
      if (!after.isDirectory() || !unchanged(before, after)) throw Error('DIRECTORY_CHANGED');
      return handle;
    } catch (error) {await handle.close(); throw error;}
  }
  async function openRoot(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096) throw Error('INVALID_ROOT');
    let handle = await openDirectory('/');
    try {
      for (const part of path.split('/').filter(Boolean)) {
        if (expired()) throw Error('DEADLINE');
        const next = await openDirectory(childPath(handle, part));
        await handle.close(); handle = next;
      }
      return handle;
    } catch (error) {await handle.close(); throw error;}
  }
  const add = (record, key, value) => {record[key] = (BigInt(record[key]) + value).toString();};
  async function walk(directory, record, prefix, depth) {
    if (expired()) {record.time_limit_reached = true; record.complete = false; return;}
    const before = await directory.stat({bigint: true});
    const iterator = await opendir(fdPath(directory), {bufferSize: 32});
    try {
      for (;;) {
        if (expired()) {record.time_limit_reached = true; record.complete = false; break;}
        const entry = await iterator.read(); if (!entry) break;
        if (record.entries >= entryLimit) {record.entry_limit_reached = true; record.complete = false; break;}
        record.entries++;
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        const valid = relative.length <= 1200 && relative.split('/').length <= 16 && relative.split('/').every(part => /^[A-Za-z0-9_.-]{1,200}$/.test(part) && part !== '.' && part !== '..');
        if (!valid) {record.invalid_paths++; record.complete = false;}
        let stat;
        try {stat = await lstat(childPath(directory, entry.name), {bigint: true});}
        catch {record.unreadable_entries++; record.complete = false; continue;}
        if (stat.isSymbolicLink()) {record.symlinks++; record.complete = false;}
        else if (stat.isDirectory()) {
          record.directories++;
          if (!valid) continue;
          if (depth + 1 >= depthLimit) {record.depth_limit_reached = true; record.complete = false; continue;}
          let child;
          try {child = await openDirectory(childPath(directory, entry.name)); await walk(child, record, relative, depth + 1);}
          catch {record.unreadable_entries++; record.complete = false;}
          finally {await child?.close();}
        } else if (stat.isFile()) {
          if (stat.nlink !== 1n) {
            record.hardlink_files++; record.complete = false;
            add(record, 'hardlink_entry_logical_bytes', stat.size); add(record, 'hardlink_entry_allocated_bytes', stat.blocks * 512n);
          } else if (valid) {
            record.files++; add(record, 'logical_bytes', stat.size); add(record, 'allocated_bytes', stat.blocks * 512n);
            record.largest_file_bytes = (stat.size > BigInt(record.largest_file_bytes) ? stat.size : BigInt(record.largest_file_bytes)).toString();
          }
        } else {record.special_files++; record.complete = false;}
      }
    } finally {await iterator.close();}
    if (!unchanged(before, await directory.stat({bigint: true}))) {record.changed_directories++; record.complete = false;}
  }
  let data;
  try {
    data = await openRoot(root);
    const before = await data.stat({bigint: true});
    try {
      const fs = await statfs(fdPath(data), {bigint: true});
      result.filesystem = {available_bytes: String(fs.bavail * fs.bsize), free_bytes: String(fs.bfree * fs.bsize),
        total_bytes: String(fs.blocks * fs.bsize), free_inodes: String(fs.ffree), block_size: String(fs.bsize)};
    } catch {}
    for (const name of names) {
      const record = result.roots[name]; let directory;
      if (expired()) {record.time_limit_reached = true; continue;}
      try {
        const path = childPath(data, name); let stat;
        try {stat = await lstat(path, {bigint: true});}
        catch (error) {if (error.code === 'ENOENT') {record.state = 'ABSENT'; record.complete = true; continue;} throw error;}
        if (!stat.isDirectory() || stat.isSymbolicLink()) {record.state = 'UNSAFE'; continue;}
        directory = await openDirectory(path); record.state = 'PRESENT'; record.complete = true;
        await walk(directory, record, '', 0);
      } catch {record.complete = false; record.unreadable_entries++;}
      finally {await directory?.close();}
    }
    if (!unchanged(before, await data.stat({bigint: true}))) for (const record of Object.values(result.roots)) {record.changed_directories++; record.complete = false;}
    result.complete = result.filesystem !== null && Object.values(result.roots).every(record => record.complete);
  } catch {}
  finally {await data?.close();}
  if (expired()) {
    result.complete = false;
    for (const record of Object.values(result.roots)) {record.time_limit_reached = true; record.complete = false;}
  }
  return result;
}

export const metadataProgram = 'import{constants}from"node:fs";import{lstat,open,opendir,statfs}from"node:fs/promises";\n' + collectStorageMetadata.toString() + '\nprocess.stdout.write(JSON.stringify(await collectStorageMetadata("/data"))+"\\n");';
export const metadataSha256 = sha(metadataProgram);

export function validStorageMetadata(value) {
  const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
  const decimal = v => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(v);
  const count = v => Number.isInteger(v) && v >= 0 && v <= 25001;
  if (!exact(value, ['schema','complete','totals_scope','roots','filesystem','bounds','database_opened','file_contents_read','writes']) || value.schema !== 'thot.storage-metadata/1' || typeof value.complete !== 'boolean' || value.totals_scope !== 'single_link_regular_files' || value.database_opened !== false || value.file_contents_read !== false || value.writes !== 0) return false;
  if (!exact(value.bounds, ['entry_limit_per_root','depth_limit','deadline_ms']) || value.bounds.entry_limit_per_root !== 25000 || value.bounds.depth_limit !== 16 || value.bounds.deadline_ms !== 20000 || !exact(value.roots, ['postgres','objects','quarantine'])) return false;
  const numbers = ['entries','files','directories','hardlink_files','symlinks','special_files','invalid_paths','unreadable_entries','changed_directories'];
  const bytes = ['logical_bytes','allocated_bytes','largest_file_bytes','hardlink_entry_logical_bytes','hardlink_entry_allocated_bytes'];
  const flags = ['complete','entry_limit_reached','depth_limit_reached','time_limit_reached'];
  for (const record of Object.values(value.roots)) {
    if (!exact(record, ['state', ...numbers, ...bytes, ...flags]) || !['PRESENT','ABSENT','UNSAFE','ERROR'].includes(record.state) || !numbers.every(k => count(record[k])) || !bytes.every(k => decimal(record[k])) || !flags.every(k => typeof record[k] === 'boolean')) return false;
    if (record.complete && (!['PRESENT','ABSENT'].includes(record.state) || record.entry_limit_reached || record.depth_limit_reached || record.time_limit_reached || ['hardlink_files','symlinks','special_files','invalid_paths','unreadable_entries','changed_directories'].some(k => record[k] !== 0))) return false;
    if (record.files + record.directories + record.hardlink_files + record.symlinks + record.special_files > record.entries || BigInt(record.largest_file_bytes) > BigInt(record.logical_bytes)) return false;
  }
  const fsKeys = ['available_bytes','free_bytes','total_bytes','free_inodes','block_size'];
  if (value.filesystem !== null && (!exact(value.filesystem, fsKeys) || !fsKeys.every(k => decimal(value.filesystem[k])))) return false;
  return value.complete === (value.filesystem !== null && Object.values(value.roots).every(record => record.complete));
}

export function runStorageMetadata(stage, code, run = spawnSync) {
  if (stage !== 'prestart' || code !== 'STORAGE_TOTAL_LIMIT') return null;
  const output = status => ({schema: 'thot.startup-storage-metadata/1', probe_sha256: metadataSha256, status, metadata: null});
  let child;
  try {
    child = run(process.execPath, ['--input-type=module','-e',metadataProgram], {
      encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 16384,
      stdio: ['ignore','pipe','ignore'], env: {}});
  } catch {return output('FAILED');}
  if (child.error?.code === 'ETIMEDOUT') return output('TIMEOUT');
  if (child.error?.code === 'ENOBUFS' || typeof child.stdout === 'string' && Buffer.byteLength(child.stdout) > 16384) return output('OUTPUT_LIMIT');
  if (child.error || child.status !== 0 || typeof child.stdout !== 'string') return output('FAILED');
  try {
    const metadata = JSON.parse(child.stdout);
    if (!validStorageMetadata(metadata)) return output('INVALID_RESULT');
    return {...output(metadata.complete ? 'COMPLETE' : 'INCOMPLETE'), metadata};
  } catch {return output('INVALID_RESULT');}
}

const insertion = 'try{unlinkSync(path)}catch{}';
assert.equal(previousSha256, '9ec660748e7e8a7badd335f9f40c41bb4f67333f6b233b8c438160128cae2ab7');
assert.equal(previousProgram.split(insertion).length, 2);
const augmentation = 'import{spawnSync}from"node:child_process";const metadataProgram=' + JSON.stringify(metadataProgram) + ',metadataSha256=' + JSON.stringify(metadataSha256) + ';\n' + validStorageMetadata.toString() + '\n' + runStorageMetadata.toString() + '\nconst metadataResult=runStorageMetadata(stage,code);if(metadataResult)process.stdout.write(JSON.stringify(metadataResult)+"\\n");';
export const diagnosticProgram = previousProgram.replace(insertion, () => augmentation + insertion);
export const diagnosticSha256 = sha(diagnosticProgram);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const composeQuote = value => quote(value.replaceAll('$', () => '$$'));

export function buildStorageMetadataCandidate(input, {expectedCommandSha256, expectedImage} = {}) {
  assert.match(expectedCommandSha256 ?? '', /^[a-f0-9]{64}$/, 'REVIEWED_COMMAND_HASH_REQUIRED');
  assert.match(expectedImage ?? '', /^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/, 'PINNED_IMAGE_REQUIRED');
  const compose = structuredClone(input), service = compose.services?.['private-anvil-app'];
  assert(service, 'PRIVATE_DEV_APP_REQUIRED'); assert.equal(service.image, expectedImage, 'IMAGE_CHANGED');
  assert(!Object.hasOwn(service, 'entrypoint') && !Object.hasOwn(service, 'working_dir'), 'STARTUP_OVERRIDE');
  assert.equal(service.environment?.THOT_CVM_PRE_MIGRATION_SNAPSHOT, 'true', 'SNAPSHOT_OPT_IN_REQUIRED');
  assert.equal(service.environment?.THOT_DATA_DIR, '/data', 'DATA_ROOT_CHANGED');
  const command = service.command;
  assert(Array.isArray(command) && command.length === 7 && command.every(v => typeof v === 'string'), 'UNRECOGNIZED_COMMAND');
  assert.deepEqual(command.slice(0, 6), ['flock','--no-fork','--nonblock','/data/.thot-process-lock','sh','-c'], 'UNRECOGNIZED_COMMAND');
  assert.equal(sha(JSON.stringify(command)), expectedCommandSha256, 'COMMAND_CHANGED');
  const marker = 'exec node --input-type=module -e ', before = marker + composeQuote(previousProgram), after = marker + composeQuote(diagnosticProgram);
  assert(command[6].endsWith(before) && command[6].split(before).length === 2, 'UNRECOGNIZED_DIAGNOSTIC_SUFFIX');
  service.command = [...command.slice(0, 6), command[6].slice(0, -before.length) + after];
  const reversed = structuredClone(compose);
  reversed.services['private-anvil-app'].command[6] = service.command[6].slice(0, -after.length) + before;
  assert.deepEqual(reversed, input, 'NON_DIAGNOSTIC_COMPOSE_CHANGE');
  return {compose, change: {service: 'private-anvil-app', command_index: 6, previous_command_sha256: expectedCommandSha256,
    candidate_command_sha256: sha(JSON.stringify(service.command)), previous_diagnostic_sha256: previousSha256,
    candidate_diagnostic_sha256: diagnosticSha256, metadata_sha256: metadataSha256}};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [input, output, expectedCommandSha256, expectedImage, ...extra] = process.argv.slice(2);
    assert(input && output && !extra.length, 'USAGE_INPUT_OUTPUT_COMMAND_SHA256_IMAGE');
    const candidate = buildStorageMetadataCandidate(JSON.parse(readFileSync(input, 'utf8')), {expectedCommandSha256, expectedImage});
    writeFileSync(output, JSON.stringify(candidate.compose, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    console.log(JSON.stringify({status: 'PREPARED_NOT_DEPLOYED', ...candidate.change}));
  } catch {console.error('METADATA_CANDIDATE_PREPARATION_FAILED'); process.exitCode = 1;}
}
