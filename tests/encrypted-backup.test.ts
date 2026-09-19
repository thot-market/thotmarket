import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, lstat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createEncryptedBackup, restoreEncryptedBackup } from '../packages/operations/src/encrypted-backup.ts';

const key = Buffer.alloc(32, 0x37); const appId = 'synthetic-recovery-app';
async function root() { return mkdtemp(join(tmpdir(), 'thot-encrypted-backup-')); }
async function externalData(path: string) { const app = await createApplication({ dataDir: path, masterKey: key }); await app.close(); }
async function digest(path: string) { const result = await createEncryptedBackup({ dataDir: path, archivePath: join(path, '..', 'archive.wkeb'), masterKey: key, appId }); return result; }

test('external-key encrypted archive round trips and excludes local key', async () => {
  const r = await root(); try { const source = join(r, 'source'); await externalData(source); const archive = await digest(source); assert(archive.bytes > 0 && archive.files > 0); assert.equal(await lstat(join(source, 'local-vault.key')).then(() => true, () => false), false); const restored = join(r, 'restored'); const result = await restoreEncryptedBackup({ archivePath: archive.archivePath, dataDir: restored, scratchDir: join(r, 'scratch'), masterKey: key, appId, expectedArchiveSha256: archive.archiveSha256 }); assert.equal(result.files, archive.files); assert.equal(await readFile(join(restored, 'postgres', 'PG_VERSION'), 'utf8'), await readFile(join(source, 'postgres', 'PG_VERSION'), 'utf8')); const reopened = await createApplication({ dataDir: restored, masterKey: key }); await reopened.close(); } finally { await rm(r, { recursive: true, force: true }); }
});

test('wrong key, wrong app identity, and archive corruption fail before destination creation', async () => {
  const r = await root(); try { const source = join(r, 'source'); await externalData(source); const archive = await digest(source); const target = join(r, 'target'); await assert.rejects(restoreEncryptedBackup({ archivePath: archive.archivePath, dataDir: target, scratchDir: join(r, 'scratch'), masterKey: Buffer.alloc(32, 0x38), appId, expectedArchiveSha256: archive.archiveSha256 }), /AUTH|INTEGRITY|GCM|authenticate|state/i); await assert.rejects(restoreEncryptedBackup({ archivePath: archive.archivePath, dataDir: target, scratchDir: join(r, 'scratch2'), masterKey: key, appId: 'other-app', expectedArchiveSha256: archive.archiveSha256 }), /IDENTITY/); const bytes = await readFile(archive.archivePath); bytes[bytes.length - 20] ^= 1; await writeFile(archive.archivePath, bytes); await assert.rejects(restoreEncryptedBackup({ archivePath: archive.archivePath, dataDir: target, scratchDir: join(r, 'scratch3'), masterKey: key, appId, expectedArchiveSha256: archive.archiveSha256 }), /HASH/); await assert.rejects(lstat(target), /ENOENT/); } finally { await rm(r, { recursive: true, force: true }); }
});

test('held source lease and existing destination are preserved', async () => {
  const r = await root(); try { const source = join(r, 'source'); await externalData(source); const leaseApp = await createApplication({ dataDir: source, masterKey: key }); await assert.rejects(createEncryptedBackup({ dataDir: source, archivePath: join(r, 'archive.wkeb'), masterKey: key, appId }), /LEASE_HELD/); await leaseApp.close(); const archive = await digest(source); const target = join(r, 'target'); await writeFile(target, 'occupied'); await assert.rejects(restoreEncryptedBackup({ archivePath: archive.archivePath, dataDir: target, scratchDir: join(r, 'scratch'), masterKey: key, appId, expectedArchiveSha256: archive.archiveSha256 }), /EEXIST/); assert.equal(await readFile(target, 'utf8'), 'occupied'); } finally { await rm(r, { recursive: true, force: true }); }
});

test('truncated or untrusted archives leave no destination or scratch plaintext', async () => {
  const r = await root(); try {
    const source = join(r, 'source'); await externalData(source); const archive = await digest(source);
    const scratch = join(r, 'scratch'); const target = join(r, 'target');
    const original = await readFile(archive.archivePath);
    await writeFile(archive.archivePath, original.subarray(0, original.length - 1));
    await assert.rejects(restoreEncryptedBackup({ archivePath: archive.archivePath, dataDir: target, scratchDir: scratch, masterKey: key, appId, expectedArchiveSha256: archive.archiveSha256 }), /HASH|TRUNCATED/);
    assert.equal(await lstat(target).then(() => true, () => false), false);
    assert.deepEqual(await readdir(scratch), []);
    await writeFile(archive.archivePath, original);
    const untrustedScratch = join(r, 'scratch-untrusted');
    await assert.rejects(restoreEncryptedBackup({ archivePath: archive.archivePath, dataDir: target, scratchDir: untrustedScratch, masterKey: key, appId, expectedArchiveSha256: '0'.repeat(64) }), /HASH/);
    assert.equal(await lstat(target).then(() => true, () => false), false);
    assert.deepEqual(await readdir(untrustedScratch), []);
  } finally { await rm(r, { recursive: true, force: true }); }
});

test('unknown source top-level entries are rejected without creating an archive', async () => {
  const r = await root(); try {
    const source = join(r, 'source'); await externalData(source); await writeFile(join(source, 'unexpected-state'), 'synthetic', { mode: 0o600 });
    await assert.rejects(createEncryptedBackup({ dataDir: source, archivePath: join(r, 'archive.wkeb'), masterKey: key, appId }), /UNKNOWN_EXTERNAL_DATA_ENTRY_REQUIRES_REVIEW/);
    assert.equal(await lstat(join(r, 'archive.wkeb')).then(() => true, () => false), false);
    assert.equal(await readFile(join(source, 'unexpected-state'), 'utf8'), 'synthetic');
  } finally { await rm(r, { recursive: true, force: true }); }
});


test('invalid scratch placement cannot create the restore destination', async () => {
  const r = await root();
  try {
    const target = join(r, 'target');
    for (const scratchDir of [target, join(target, 'scratch')]) {
      await assert.rejects(restoreEncryptedBackup({ archivePath: join(r, 'absent.thot'), dataDir: target, scratchDir, masterKey: key, appId, expectedArchiveSha256: '0'.repeat(64) }), /SCRATCH_INSIDE_DESTINATION_FORBIDDEN/);
      await assert.rejects(lstat(target), /ENOENT/);
    }
  } finally { await rm(r, { recursive: true, force: true }); }
});

test('historical snapshots and incomplete telemetry are excluded while completed metadata restores', async () => {
  const r = await root();
  try {
    const source = join(r, 'source'); await externalData(source);
    await mkdir(join(source, '.pre-migration-snapshots'));
    await writeFile(join(source, '.pre-migration-snapshots', 'old-database'), 'historical-copy');
    await writeFile(join(source, 'operator-activity.v1.json'), '{"observation":"optional"}');
    await writeFile(join(source, '.operator-fleet.json'), '{"observation":"optional"}');
    await writeFile(join(source, 'operator-activity.v1.json.tmp'), 'incomplete observation');
    await writeFile(join(source, '.operator-fleet.json.tmp'), 'incomplete observation');
    const archive = await digest(source);
    assert.deepEqual(archive.excludedEntries, ['.operator-fleet.json.tmp', '.pre-migration-snapshots', 'operator-activity.v1.json.tmp']);
    const target = join(r, 'restored');
    await restoreEncryptedBackup({archivePath:archive.archivePath,dataDir:target,scratchDir:join(r,'scratch'),masterKey:key,appId,expectedArchiveSha256:archive.archiveSha256});
    const restored = await createApplication({dataDir:target,masterKey:key}); await restored.close();
    for (const name of archive.excludedEntries) await assert.rejects(lstat(join(target,name)), /ENOENT/);
    for (const name of ['operator-activity.v1.json', '.operator-fleet.json']) assert.equal(await readFile(join(target,name),'utf8'), await readFile(join(source,name),'utf8'));
    // Even omitted entries may not point outside the reviewed storage tree.
    await rm(join(source, '.operator-fleet.json.tmp'));
    await symlink(join(r,'elsewhere'),join(source,'.operator-fleet.json.tmp'));
    await assert.rejects(createEncryptedBackup({dataDir:source,archivePath:join(r,'unsafe.wkeb'),masterKey:key,appId}),/UNSAFE_EXCLUDED_STORAGE_ENTRY/);
  } finally { await rm(r,{recursive:true,force:true}); }
});
