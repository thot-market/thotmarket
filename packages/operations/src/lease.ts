import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { assert, checkedDirectory, readBounded } from './paths.ts';

export const LEASE_FILE = '.thot-directory-lease';
// This coordination name is deliberately independent of the release namespace.
export const SHARED_LEASE_FILE = '.trace-directory-lease';
export const STORAGE_FORMAT_FILE = '.thot-storage.json';
export async function assertStorageNamespace(dataDir: string): Promise<void> {
  const names = await readdir(dataDir);
  assert(!names.some(name => /^\.[a-z0-9-]+-storage\.json$/.test(name) && name !== STORAGE_FORMAT_FILE), 'INCOMPATIBLE_STORAGE_NAMESPACE');
  assert(!names.some(name => /^\.[a-z0-9-]+-directory-lease$/.test(name) && name !== LEASE_FILE && name !== SHARED_LEASE_FILE), 'DATA_DIRECTORY_LEASE_HELD');
  // Never adopt unmarked persistent state as a fresh branded installation.
  assert(names.includes(STORAGE_FORMAT_FILE) || !names.some(name => ['postgres', 'objects', 'quarantine', 'local-vault.key'].includes(name)), 'UNMARKED_STORAGE_REQUIRES_REVIEW');
}
// keyCustody describes the application master key (also used for signing and
// pseudonyms). An absent objectKeyCustody means object keys derive from it.
export interface StorageFormat { version: 1; backend: 'pglite' | 'memory' | 'postgres'; keyCustody: 'local-file' | 'external'; objectStorage?:'external'; objectStorageIdentity?:string; objectKeyCustody?:'external' }

/** Cooperative, exclusive lifetime lease. Never guesses that an existing lease is stale. */
export class DataDirectoryLease {
  readonly dataDir: string; readonly mode: 'application' | 'maintenance';
  private token: string; private released = false; private inodes: Map<string, number>;
  private constructor(dataDir: string, mode: 'application' | 'maintenance', token: string, inodes: Map<string, number>) { this.dataDir = dataDir; this.mode = mode; this.token = token; this.inodes = inodes; }
  static async acquire(path: string, options: { mode: 'application' | 'maintenance'; create?: boolean }): Promise<DataDirectoryLease> {
    assert(['application', 'maintenance'].includes(options.mode), 'INVALID_DIRECTORY_LEASE_MODE');
    const dataDir = await checkedDirectory(path, options.create ?? false);
    assert(((await lstat(dataDir)).mode & 0o077) === 0, 'INSECURE_DATA_DIRECTORY');
    await assertStorageNamespace(dataDir);
    const token = randomUUID(), inodes = new Map<string, number>();
    try {
      // Retain the old lease as well, so older same-namespace processes also stop.
      for (const name of [SHARED_LEASE_FILE, LEASE_FILE]) {
        const file = await open(join(dataDir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          inodes.set(name, (await file.stat()).ino);
          await file.writeFile(JSON.stringify({ version: 1, mode: options.mode, storage_format: STORAGE_FORMAT_FILE, token, pid: process.pid, hostname: hostname(), started_at: new Date().toISOString() }));
          await file.sync();
        } finally { await file.close(); }
      }
      await assertStorageNamespace(dataDir);
      return new DataDirectoryLease(dataDir, options.mode, token, inodes);
    } catch (error: any) {
      for (const [name, inode] of inodes) {
        const path = join(dataDir, name);
        if ((await lstat(path)).ino === inode) await unlink(path);
      }
      if (error.code === 'EEXIST') throw new Error('DATA_DIRECTORY_LEASE_HELD');
      throw error;
    }
  }
  async assertHeld(): Promise<void> {
    assert(!this.released, 'DATA_DIRECTORY_LEASE_RELEASED');
    for (const [name, inode] of this.inodes) {
      const path = join(this.dataDir, name); const stat = await lstat(path);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.ino === inode, 'DATA_DIRECTORY_LEASE_CHANGED');
      const record = JSON.parse((await readBounded(path, 4096)).toString('utf8'));
      assert(record.token === this.token && record.mode === this.mode && record.pid === process.pid, 'DATA_DIRECTORY_LEASE_CHANGED');
    }
  }
  async release(): Promise<void> {
    if (this.released) return;
    await this.assertHeld();
    for (const name of [...this.inodes.keys()].reverse()) await unlink(join(this.dataDir, name));
    this.released = true;
  }
}

export async function ensureStorageFormat(lease: DataDirectoryLease, format: StorageFormat): Promise<void> {
  await lease.assertHeld(); const path = join(lease.dataDir, STORAGE_FORMAT_FILE);
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readStorageFormat(lease);
    assert(prior.backend === format.backend && prior.keyCustody === format.keyCustody && prior.objectStorage===format.objectStorage && prior.objectStorageIdentity===format.objectStorageIdentity && prior.objectKeyCustody===format.objectKeyCustody, 'STORAGE_FORMAT_CHANGED'); return;
  }
  try { await handle.writeFile(JSON.stringify(format)); await handle.sync(); } finally { await handle.close(); }
}
export async function readStorageFormat(lease: DataDirectoryLease): Promise<StorageFormat> {
  await lease.assertHeld();
  const value = JSON.parse((await readBounded(join(lease.dataDir, STORAGE_FORMAT_FILE), 4096)).toString('utf8'));
  assert(value && Object.keys(value).length === 3+(value.objectStorageIdentity===undefined?0:1)+(value.objectStorage===undefined?0:1)+(value.objectKeyCustody===undefined?0:1) && Object.keys(value).every(key=>['version','backend','keyCustody','objectStorage','objectStorageIdentity','objectKeyCustody'].includes(key)) && (value.objectStorageIdentity===undefined||value.objectStorage==='external'&&/^[a-f0-9]{64}$/.test(value.objectStorageIdentity)) && (value.objectStorage===undefined||value.objectStorage==='external') && (value.objectKeyCustody===undefined||value.objectKeyCustody==='external') && value.version === 1 && ['pglite', 'memory', 'postgres'].includes(value.backend) && ['local-file', 'external'].includes(value.keyCustody), 'UNSUPPORTED_STORAGE_FORMAT');
  return value;
}
