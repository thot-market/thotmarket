import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { canonicalJson } from '../../protocol/src/index.ts';
import { DataDirectoryLease, LEASE_FILE, SHARED_LEASE_FILE, readStorageFormat, STORAGE_FORMAT_FILE, type StorageFormat } from './lease.ts';
import { assert, assertOperatorMetadataEntry, checkedDirectory, childPath, digestFile, ENTRY_LIMIT, FILE_LIMIT, freshDirectory, listTree, OPERATOR_METADATA_FILES, physicalPath, readBounded, TOTAL_LIMIT, writeNew, type SnapshotEntry } from './paths.ts';

export interface BackupManifest { format: 'thot.offline-backup/1'; createdAt: string; storageFormat: StorageFormat; entries: SnapshotEntry[] }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const roots = new Set([STORAGE_FORMAT_FILE, 'local-vault.key', 'postgres', 'objects', 'quarantine', ...OPERATOR_METADATA_FILES]);
function disjoint(left: string, right: string) { assert(left !== right && !left.startsWith(right + sep) && !right.startsWith(left + sep), 'NESTED_STORAGE_DESTINATION_FORBIDDEN'); }
export async function requireLocalLayout(lease: DataDirectoryLease): Promise<StorageFormat> {
  const format = await readStorageFormat(lease);
  assert(format.backend === 'pglite' && format.keyCustody === 'local-file', 'OFFLINE_LOCAL_PGLITE_KEY_REQUIRED');
  assert(format.objectStorage!=='external','OFFLINE_LOCAL_OBJECT_STORAGE_REQUIRED');
  assert(format.objectKeyCustody!=='external','OFFLINE_LOCAL_OBJECT_KEYS_REQUIRED');
  await checkedDirectory(join(lease.dataDir, 'postgres'));
  const keyPath = join(lease.dataDir, 'local-vault.key'); const keyStat = await lstat(keyPath);
  assert(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.nlink === 1 && keyStat.size === 32 && (keyStat.mode & 0o077) === 0, 'INSECURE_LOCAL_KEY');
  const version = (await readBounded(join(lease.dataDir, 'postgres', 'PG_VERSION'), 100)).toString('utf8').trim();
  assert(/^\d{1,2}$/.test(version), 'INVALID_PGLITE_LAYOUT');
  return format;
}
async function copyEntries(source: string, destination: string, entries: SnapshotEntry[]): Promise<void> {
  for (const entry of entries) {
    const src = childPath(source, entry.path); const target = childPath(destination, entry.path);
    if (entry.type === 'directory') await mkdir(target, { mode: 0o700 });
    else {
      const copied = await digestFile(src, target);
      assert(copied.size === entry.size && copied.sha256 === entry.sha256, 'BACKUP_SOURCE_CHANGED');
    }
  }
}

/** Cold filesystem snapshot only. The app's lifetime lease must already be released. */
export async function createOfflineBackup(input: { dataDir: string; backupDir: string }): Promise<{ backupDir: string; manifestHash: string; files: number; totalBytes: number }> {
  const dataDir = physicalPath(input.dataDir); const backupDir = physicalPath(input.backupDir); disjoint(dataDir, backupDir);
  const lease = await DataDirectoryLease.acquire(dataDir, { mode: 'maintenance' });
  try {
    const storageFormat = await requireLocalLayout(lease);
    const names = await readdir(dataDir);
    assert(names.every(name => name === LEASE_FILE || name === SHARED_LEASE_FILE || roots.has(name)), 'UNKNOWN_DATA_DIRECTORY_ENTRY_REQUIRES_REVIEW');
    const entries = (await listTree(dataDir)).filter(entry => entry.path !== LEASE_FILE && entry.path !== SHARED_LEASE_FILE);
    entries.forEach(assertOperatorMetadataEntry);
    assert(entries.some(entry => entry.path === 'postgres' && entry.type === 'directory'), 'PGLITE_DATABASE_REQUIRED');
    await freshDirectory(backupDir); await mkdir(join(backupDir, 'payload'), { mode: 0o700 });
    await writeNew(join(backupDir, 'BACKUP-NOTICE'), 'Contains the private vault decryption key. Treat the entire directory as sensitive. Restore only with a verified manifest and its separately retained SHA256.\n');
    await copyEntries(dataDir, join(backupDir, 'payload'), entries);
    await lease.assertHeld();
    const manifest: BackupManifest = { format: 'thot.offline-backup/1', createdAt: new Date().toISOString(), storageFormat, entries };
    const bytes = canonicalJson(manifest); const manifestHash = digest(bytes);
    await writeNew(join(backupDir, 'manifest.json'), bytes);
    // Only the manifest+externally pinned hash establishes completion, not the notice.
    await verifyOfflineBackup({ backupDir, expectedManifestHash: manifestHash });
    return { backupDir, manifestHash, files: entries.filter(e => e.type === 'file').length, totalBytes: entries.reduce((n, e) => n + (e.size ?? 0), 0) };
  } finally { await lease.release(); }
}

export async function verifyOfflineBackup(input: { backupDir: string; expectedManifestHash: string }): Promise<{ manifest: BackupManifest; manifestHash: string }> {
  const backupDir = await checkedDirectory(input.backupDir);
  assert(/^[a-f0-9]{64}$/.test(input.expectedManifestHash), 'TRUSTED_MANIFEST_HASH_REQUIRED');
  assert(((await lstat(backupDir)).mode & 0o077) === 0, 'INSECURE_BACKUP_DIRECTORY');
  const manifestBytes = await readBounded(join(backupDir, 'manifest.json'), 8_000_000);
  assert(digest(manifestBytes) === input.expectedManifestHash, 'BACKUP_MANIFEST_HASH_MISMATCH');
  let manifest: BackupManifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('INVALID_BACKUP_MANIFEST'); }
  assert(manifest && Object.keys(manifest).sort().join(',') === 'createdAt,entries,format,storageFormat' && manifest.format === 'thot.offline-backup/1' && Number.isFinite(Date.parse(manifest.createdAt)) && Array.isArray(manifest.entries) && manifest.entries.length <= ENTRY_LIMIT, 'INVALID_BACKUP_MANIFEST');
  assert(manifest.storageFormat?.version === 1 && manifest.storageFormat.backend === 'pglite' && manifest.storageFormat.keyCustody === 'local-file' && Object.keys(manifest.storageFormat).length === 3, 'UNSUPPORTED_BACKUP_STORAGE');
  let total = 0; const seen = new Set<string>();
  for (const entry of manifest.entries) {
    assert(entry && typeof entry === 'object' && !seen.has(entry.path), 'DUPLICATE_MANIFEST_PATH'); seen.add(entry.path);
    childPath(join(backupDir, 'payload'), entry.path);
    assert(roots.has(entry.path.split('/')[0]!), 'UNSUPPORTED_BACKUP_ENTRY');
    assertOperatorMetadataEntry(entry);
    if (entry.type === 'directory') assert(Object.keys(entry).sort().join(',') === 'path,type', 'INVALID_BACKUP_ENTRY');
    else {
      assert(entry.type === 'file' && Object.keys(entry).sort().join(',') === 'path,sha256,size,type' && Number.isSafeInteger(entry.size) && entry.size! >= 0 && entry.size! <= FILE_LIMIT && /^[a-f0-9]{64}$/.test(entry.sha256!), 'INVALID_BACKUP_ENTRY');
      total += entry.size!; assert(total <= TOTAL_LIMIT, 'BACKUP_TOTAL_LIMIT');
    }
  }
  for (const name of [STORAGE_FORMAT_FILE, 'local-vault.key', 'postgres/PG_VERSION']) assert(seen.has(name), 'INCOMPLETE_BACKUP');
  assert(manifest.entries.find(entry => entry.path === 'local-vault.key')?.size === 32, 'INVALID_BACKUP_KEY');
  const top = await readdir(backupDir); assert(top.every(name => ['payload', 'manifest.json', 'BACKUP-NOTICE'].includes(name)), 'UNKNOWN_BACKUP_ENTRY');
  if (top.includes('BACKUP-NOTICE')) {
    await readBounded(join(backupDir, 'BACKUP-NOTICE'), 4096);
    assert(((await lstat(join(backupDir, 'BACKUP-NOTICE'))).mode & 0o077) === 0, 'INSECURE_BACKUP_PERMISSIONS');
  }
  await checkedDirectory(join(backupDir, 'payload'));
  const actual = await listTree(join(backupDir, 'payload'));
  assert(canonicalJson(actual) === canonicalJson(manifest.entries), 'BACKUP_CONTENT_MISMATCH');
  for (const path of [backupDir, join(backupDir, 'payload'), join(backupDir, 'manifest.json'), ...actual.map(entry => childPath(join(backupDir, 'payload'), entry.path))]) assert(((await lstat(path)).mode & 0o077) === 0, 'INSECURE_BACKUP_PERMISSIONS');
  const storedFormat = JSON.parse((await readBounded(join(backupDir, 'payload', STORAGE_FORMAT_FILE), 4096)).toString('utf8'));
  assert(canonicalJson(storedFormat) === canonicalJson(manifest.storageFormat), 'BACKUP_FORMAT_MISMATCH');
  return { manifest, manifestHash: input.expectedManifestHash };
}

/** Verify all bytes first, then restore only into a newly created, disjoint destination. */
export async function restoreOfflineBackup(input: { backupDir: string; dataDir: string; expectedManifestHash: string }): Promise<{ dataDir: string; manifestHash: string }> {
  const backupDir = physicalPath(input.backupDir); const dataDir = physicalPath(input.dataDir); disjoint(backupDir, dataDir);
  const verified = await verifyOfflineBackup({ backupDir, expectedManifestHash: input.expectedManifestHash });
  await freshDirectory(dataDir);
  const lease = await DataDirectoryLease.acquire(dataDir, { mode: 'maintenance' });
  let complete = false;
  try {
    // A failed restore retains its maintenance lease, preventing accidental application start.
    await copyEntries(join(backupDir, 'payload'), dataDir, verified.manifest.entries);
    await requireLocalLayout(lease); await lease.assertHeld();
    const restored = (await listTree(dataDir)).filter(entry => entry.path !== LEASE_FILE && entry.path !== SHARED_LEASE_FILE);
    assert(canonicalJson(restored) === canonicalJson(verified.manifest.entries), 'RESTORE_CONTENT_MISMATCH');
    complete = true;
    return { dataDir, manifestHash: verified.manifestHash };
  } finally { if (complete) await lease.release(); }
}
