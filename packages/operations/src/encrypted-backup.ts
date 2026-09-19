import { constants } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { canonicalJson } from '../../protocol/src/index.ts';
import { DataDirectoryLease, LEASE_FILE, SHARED_LEASE_FILE, readStorageFormat, STORAGE_FORMAT_FILE, type StorageFormat } from './lease.ts';
import { assert, assertOperatorMetadataEntry, checkedDirectory, childPath, ENTRY_LIMIT, FILE_LIMIT, freshDirectory, digestFile, listTree, OPERATOR_METADATA_FILES, physicalPath, readBounded, TOTAL_LIMIT, type SnapshotEntry } from './paths.ts';

const MAGIC = Buffer.from('WKEB1');
const HEADER_LIMIT = 16 * 1024;
const MANIFEST_LIMIT = 8 * 1024 * 1024;
const TAG_BYTES = 16;
const CHUNK = 64 * 1024;
const DOMAIN = 'thot.encrypted-backup/v1';
const RECOVERY_ROOTS = [STORAGE_FORMAT_FILE, 'postgres', 'objects', 'quarantine', ...OPERATOR_METADATA_FILES];
// Preserve completed operator observations, but omit historical database copies
// and incomplete telemetry writes from recovery. Unknown roots still require
// review instead of being silently omitted.
const OMITTED_DIRECTORIES = ['.pre-migration-snapshots'];
const OMITTED_FILES = ['operator-activity.v1.json.tmp', '.operator-fleet.json.tmp'];

interface EncryptedHeader { format: 'thot.encrypted-backup/1'; appId: string; salt: string; nonce: string }
interface EncryptedManifest { format: 'thot.encrypted-backup/1'; appId: string; storageFormat: StorageFormat; entries: SnapshotEntry[] }
type ArchiveInfo = { header: EncryptedHeader; headerBytes: Buffer; payloadOffset: number; archiveBytes: number };

function keyFor(masterKey: Buffer, salt: Buffer) { assert(Buffer.isBuffer(masterKey) && masterKey.length === 32, 'INVALID_MASTER_KEY'); return Buffer.from(hkdfSync('sha256', masterKey, salt, DOMAIN, 32)); }
function headerBytes(header: EncryptedHeader) { const encoded = Buffer.from(canonicalJson(header)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(encoded.length); return Buffer.concat([MAGIC, prefix, encoded]); }
function checkedAppId(appId: string) { assert(typeof appId === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(appId), 'INVALID_APP_ID'); return appId; }
function disjoint(a: string, b: string) { assert(a !== b && !a.startsWith(b + '/') && !b.startsWith(a + '/'), 'NESTED_STORAGE_DESTINATION_FORBIDDEN'); }
async function readExact(file: FileHandle, size: number) { const out = Buffer.alloc(size); let at = 0; while (at < size) { const read = await file.read(out, at, size - at, null); if (!read.bytesRead) throw new Error('TRUNCATED_ENCRYPTED_BACKUP'); at += read.bytesRead; } return out; }
async function archiveInfo(path: string, expectedAppId: string): Promise<ArchiveInfo> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try {
    const stat = await file.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.size <= TOTAL_LIMIT + HEADER_LIMIT + TAG_BYTES, 'INVALID_ENCRYPTED_ARCHIVE');
    const magic = await readExact(file, MAGIC.length); assert(magic.equals(MAGIC), 'INVALID_ENCRYPTED_ARCHIVE');
    const size = (await readExact(file, 4)).readUInt32BE(0); assert(size > 0 && size <= HEADER_LIMIT, 'INVALID_ENCRYPTED_HEADER');
    const bytes = await readExact(file, size); let header: EncryptedHeader;
    try { header = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('INVALID_ENCRYPTED_HEADER'); }
    assert(header && Object.keys(header).sort().join(',') === 'appId,format,nonce,salt' && header.format === 'thot.encrypted-backup/1' && header.appId === expectedAppId && /^[a-f0-9]{64}$/.test(header.salt) && /^[a-f0-9]{24}$/.test(header.nonce), 'ENCRYPTED_BACKUP_IDENTITY_MISMATCH');
    assert(stat.size >= MAGIC.length + 4 + size + TAG_BYTES, 'TRUNCATED_ENCRYPTED_BACKUP');
    return { header, headerBytes: Buffer.concat([MAGIC, Buffer.from(size.toString(16).padStart(8, '0'), 'hex'), bytes]), payloadOffset: MAGIC.length + 4 + size, archiveBytes: stat.size };
  } finally { await file.close(); }
}

async function requireExternalLayout(lease: DataDirectoryLease): Promise<StorageFormat> {
  const format = await readStorageFormat(lease);
  assert(format.backend === 'pglite' && format.keyCustody === 'external' && format.objectStorage === undefined && format.objectKeyCustody === undefined, 'EXTERNAL_PGLITE_FILESYSTEM_LAYOUT_REQUIRED');
  assert(!(await readdir(lease.dataDir)).includes('local-vault.key'), 'LOCAL_KEY_FORBIDDEN_IN_EXTERNAL_BACKUP');
  await checkedDirectory(join(lease.dataDir, 'postgres')); const version = (await readBounded(join(lease.dataDir, 'postgres', 'PG_VERSION'), 100)).toString('utf8').trim(); assert(/^\d{1,2}$/.test(version), 'INVALID_PGLITE_LAYOUT');
  return format;
}

async function writeAll(file: FileHandle, bytes: Buffer) { let at = 0; while (at < bytes.length) { const result = await file.write(bytes, at, bytes.length - at, null); assert(result.bytesWritten > 0, 'STORAGE_WRITE_FAILED'); at += result.bytesWritten; } }
async function writeCipher(file: FileHandle, cipher: ReturnType<typeof createCipheriv>, bytes: Buffer) { const encrypted = cipher.update(bytes); if (encrypted.length) await writeAll(file, encrypted); }

export async function createEncryptedBackup(input: { dataDir: string; archivePath: string; masterKey: Buffer; appId: string }): Promise<{ archivePath: string; archiveSha256: string; bytes: number; files: number; excludedEntries: string[] }> {
  const dataDir = physicalPath(input.dataDir); const archivePath = physicalPath(input.archivePath); checkedAppId(input.appId); disjoint(dataDir, archivePath);
  const lease = await DataDirectoryLease.acquire(dataDir, { mode: 'maintenance' });
  try {
    const storageFormat = await requireExternalLayout(lease); const names = await readdir(dataDir);
    assert(names.every(name => [LEASE_FILE, SHARED_LEASE_FILE, ...RECOVERY_ROOTS, ...OMITTED_DIRECTORIES, ...OMITTED_FILES].includes(name)), 'UNKNOWN_EXTERNAL_DATA_ENTRY_REQUIRES_REVIEW');
    const excludedEntries = names.filter(name => [...OMITTED_DIRECTORIES, ...OMITTED_FILES].includes(name)).sort();
    for (const name of excludedEntries) {
      const stat = await lstat(childPath(dataDir, name));
      assert(!stat.isSymbolicLink() && (OMITTED_DIRECTORIES.includes(name) ? stat.isDirectory() : stat.isFile() && stat.nlink === 1), 'UNSAFE_EXCLUDED_STORAGE_ENTRY');
    }
    const entries: SnapshotEntry[] = [];
    for (const name of names.filter(name => RECOVERY_ROOTS.includes(name)).sort()) {
      const path = childPath(dataDir, name), stat = await lstat(path);
      assert(!stat.isSymbolicLink(), 'STORAGE_SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) {
        assertOperatorMetadataEntry({path: name, type: 'directory'});
        assert(name !== STORAGE_FORMAT_FILE, 'INVALID_STORAGE_FORMAT');
        entries.push({path: name, type: 'directory'}, ...(await listTree(path)).map(entry => ({...entry, path: name + '/' + entry.path})));
      } else {
        assert((name === STORAGE_FORMAT_FILE || OPERATOR_METADATA_FILES.has(name)) && stat.isFile() && stat.nlink === 1, 'UNSAFE_STORAGE_FILE');
        entries.push({path: name, type: 'file', ...await digestFile(path)});
      }
    }
    assert(entries.length <= ENTRY_LIMIT, 'STORAGE_ENTRY_LIMIT');
    assert(entries.some(entry => entry.path === 'postgres' && entry.type === 'directory'), 'PGLITE_DATABASE_REQUIRED');
    const total = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0); assert(total <= TOTAL_LIMIT, 'STORAGE_TOTAL_LIMIT');
    const manifest: EncryptedManifest = { format: 'thot.encrypted-backup/1', appId: input.appId, storageFormat, entries };
    const manifestEncoded = Buffer.from(canonicalJson(manifest)); assert(manifestEncoded.length <= MANIFEST_LIMIT && total + manifestEncoded.length + 4 + HEADER_LIMIT + TAG_BYTES <= TOTAL_LIMIT, 'STORAGE_TOTAL_LIMIT');
    const salt = randomBytes(32); const nonce = randomBytes(12); const header: EncryptedHeader = { format: 'thot.encrypted-backup/1', appId: input.appId, salt: salt.toString('hex'), nonce: nonce.toString('hex') }; const aad = headerBytes(header);
    await checkedDirectory(dirname(archivePath)); const output = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); let archiveComplete = false;
    try {
      await writeAll(output, aad);
      const cipher = createCipheriv('aes-256-gcm', keyFor(input.masterKey, salt), nonce); cipher.setAAD(aad);
      const length = Buffer.alloc(4); length.writeUInt32BE(manifestEncoded.length); await writeCipher(output, cipher, length); await writeCipher(output, cipher, manifestEncoded);
      for (const entry of entries) if (entry.type === 'file') {
        const source = await open(childPath(dataDir, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW); try { const before = await source.stat(); assert(before.isFile() && before.nlink === 1 && before.size === entry.size, 'STORAGE_SOURCE_CHANGED'); const sourceHash = createHash('sha256'); let sourceBytes = 0; const buf = Buffer.alloc(CHUNK); while (true) { const read = await source.read(buf, 0, buf.length, null); if (!read.bytesRead) break; sourceBytes += read.bytesRead; assert(sourceBytes <= entry.size!, 'STORAGE_FILE_LIMIT'); sourceHash.update(buf.subarray(0, read.bytesRead)); await writeCipher(output, cipher, buf.subarray(0, read.bytesRead)); } const after = await source.stat(); assert(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.nlink === 1 && sourceBytes === entry.size && sourceHash.digest('hex') === entry.sha256, 'STORAGE_SOURCE_CHANGED'); } finally { await source.close(); }
      }
      const final = cipher.final(); if (final.length) await writeAll(output, final); const tag = cipher.getAuthTag(); await writeAll(output, tag); await output.sync(); archiveComplete = true;
    } finally { await output.close(); if (!archiveComplete) await rm(archivePath, { force: true }); }
    // Hash the exact archive, including ciphertext and tag; this avoids retaining archive bytes in memory.
    const digest = createHash('sha256'); const file = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW); try { const buf = Buffer.alloc(CHUNK); while (true) { const read = await file.read(buf, 0, buf.length, null); if (!read.bytesRead) break; digest.update(buf.subarray(0, read.bytesRead)); } } finally { await file.close(); }
    const archiveStat = await lstat(archivePath); await lease.assertHeld(); return { archivePath, archiveSha256: digest.digest('hex'), bytes: archiveStat.size, files: entries.filter(entry => entry.type === 'file').length, excludedEntries };
  } finally { await lease.release(); }
}

export async function restoreEncryptedBackup(input: { archivePath: string; dataDir: string; scratchDir: string; masterKey: Buffer; appId: string; expectedArchiveSha256: string }): Promise<{ dataDir: string; appId: string; files: number; bytes: number }> {
  const archivePath = physicalPath(input.archivePath); const dataDir = physicalPath(input.dataDir); const requestedScratch = physicalPath(input.scratchDir); assert(requestedScratch !== dataDir && !requestedScratch.startsWith(dataDir + '/'), 'SCRATCH_INSIDE_DESTINATION_FORBIDDEN'); const scratchDir = await checkedDirectory(requestedScratch, true); checkedAppId(input.appId); assert(((await lstat(scratchDir)).mode & 0o077) === 0, 'INSECURE_SCRATCH_DIRECTORY'); await checkedDirectory(dirname(archivePath)); disjoint(archivePath, dataDir); assert(/^[a-f0-9]{64}$/.test(input.expectedArchiveSha256), 'TRUSTED_ARCHIVE_HASH_REQUIRED');
  const info = await archiveInfo(archivePath, input.appId); const encrypted = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW); const scratchPath = join(scratchDir, `.thot-decrypted-${randomBytes(16).toString('hex')}`); let scratch: FileHandle | undefined;
  try {
    const digest = createHash('sha256'); const prefix = await readExact(encrypted, info.payloadOffset); assert(prefix.equals(info.headerBytes), 'ENCRYPTED_ARCHIVE_CHANGED'); digest.update(prefix); const decipher = createDecipheriv('aes-256-gcm', keyFor(input.masterKey, Buffer.from(info.header.salt, 'hex')), Buffer.from(info.header.nonce, 'hex')); decipher.setAAD(info.headerBytes); scratch = await open(scratchPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let tail = Buffer.alloc(0); let remaining = info.archiveBytes - info.payloadOffset; const buf = Buffer.alloc(CHUNK); while (remaining > 0) { const read = await encrypted.read(buf, 0, Math.min(buf.length, remaining), null); assert(read.bytesRead > 0, 'TRUNCATED_ENCRYPTED_BACKUP'); remaining -= read.bytesRead; const chunk = buf.subarray(0, read.bytesRead); digest.update(chunk); const combined = Buffer.concat([tail, chunk]); if (combined.length > TAG_BYTES) { const body = combined.subarray(0, combined.length - TAG_BYTES); tail = combined.subarray(combined.length - TAG_BYTES); const plain = decipher.update(body); if (plain.length) await writeAll(scratch, plain); } else tail = combined; }
    assert((await encrypted.read(Buffer.alloc(1), 0, 1, null)).bytesRead === 0, 'ENCRYPTED_ARCHIVE_CHANGED'); assert(digest.digest('hex') === input.expectedArchiveSha256, 'ENCRYPTED_ARCHIVE_HASH_MISMATCH'); assert(tail.length === TAG_BYTES, 'TRUNCATED_ENCRYPTED_BACKUP'); decipher.setAuthTag(tail); const final = decipher.final(); if (final.length) await writeAll(scratch, final); await scratch.sync(); await scratch.close(); scratch = undefined;
    const readScratch = await open(scratchPath, constants.O_RDONLY | constants.O_NOFOLLOW); try {
      const manifestLength = (await readExact(readScratch, 4)).readUInt32BE(0); assert(manifestLength > 0 && manifestLength <= MANIFEST_LIMIT, 'INVALID_ENCRYPTED_MANIFEST'); const manifestBytes = await readExact(readScratch, manifestLength); let manifest: EncryptedManifest; try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('INVALID_ENCRYPTED_MANIFEST'); }
      assert(canonicalJson(manifest) === manifestBytes.toString('utf8') && manifest.format === 'thot.encrypted-backup/1' && manifest.appId === input.appId && Object.keys(manifest).sort().join(',') === 'appId,entries,format,storageFormat' && manifest.storageFormat?.version === 1 && Object.keys(manifest.storageFormat).sort().join(',') === 'backend,keyCustody,version' && manifest.storageFormat.backend === 'pglite' && manifest.storageFormat.keyCustody === 'external' && manifest.storageFormat.objectStorage === undefined && manifest.storageFormat.objectKeyCustody === undefined && Array.isArray(manifest.entries) && manifest.entries.length <= ENTRY_LIMIT, 'INVALID_ENCRYPTED_MANIFEST');
      const seen = new Set<string>(); const dirs = new Set<string>(); const roots = new Set(RECOVERY_ROOTS); let total = 0; for (const entry of manifest.entries) { assert(!seen.has(entry.path) && entry.path !== LEASE_FILE && entry.path !== SHARED_LEASE_FILE && roots.has(entry.path.split('/')[0]!), 'INVALID_ENCRYPTED_ENTRY'); const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''; assert(!parent || dirs.has(parent), 'INVALID_ENCRYPTED_ENTRY'); seen.add(entry.path); childPath(join(scratchDir, 'unused'), entry.path); assertOperatorMetadataEntry(entry); if (entry.type === 'directory') { assert(Object.keys(entry).sort().join(',') === 'path,type', 'INVALID_ENCRYPTED_ENTRY'); dirs.add(entry.path); } else { assert(entry.type === 'file' && Object.keys(entry).sort().join(',') === 'path,sha256,size,type' && Number.isSafeInteger(entry.size) && entry.size! >= 0 && entry.size! <= FILE_LIMIT && /^[a-f0-9]{64}$/.test(entry.sha256!), 'INVALID_ENCRYPTED_ENTRY'); total += entry.size!; assert(total <= TOTAL_LIMIT, 'STORAGE_TOTAL_LIMIT'); } }
      assert(manifest.entries.some(entry => entry.path === STORAGE_FORMAT_FILE && entry.type === 'file') && manifest.entries.some(entry => entry.path === 'postgres/PG_VERSION' && entry.type === 'file'), 'INCOMPLETE_ENCRYPTED_BACKUP');
      let storageBytes: Buffer | undefined; let pgVersionBytes: Buffer | undefined; const fileBytes = Buffer.alloc(CHUNK); for (const entry of manifest.entries) if (entry.type === 'file') { const digest = createHash('sha256'); const captured: Buffer[] = []; let left = entry.size!; while (left) { const read = await readScratch.read(fileBytes, 0, Math.min(left, fileBytes.length), null); assert(read.bytesRead > 0, 'ENCRYPTED_PAYLOAD_TRUNCATED'); digest.update(fileBytes.subarray(0, read.bytesRead)); if (entry.path === STORAGE_FORMAT_FILE || entry.path === 'postgres/PG_VERSION') { assert(entry.size! <= 8192, 'INVALID_ENCRYPTED_ENTRY'); captured.push(Buffer.from(fileBytes.subarray(0, read.bytesRead))); } left -= read.bytesRead; } if (entry.path === STORAGE_FORMAT_FILE) storageBytes = Buffer.concat(captured); if (entry.path === 'postgres/PG_VERSION') pgVersionBytes = Buffer.concat(captured); assert(digest.digest('hex') === entry.sha256, 'ENCRYPTED_CONTENT_MISMATCH'); }
      assert(storageBytes && canonicalJson(JSON.parse(storageBytes.toString('utf8'))) === canonicalJson(manifest.storageFormat), 'ENCRYPTED_STORAGE_FORMAT_MISMATCH'); assert(pgVersionBytes && /^\d{1,2}\n?$/.test(pgVersionBytes.toString('utf8')), 'INVALID_PGLITE_LAYOUT');
      const extra = Buffer.alloc(1); assert((await readScratch.read(extra, 0, 1, null)).bytesRead === 0, 'ENCRYPTED_PAYLOAD_EXTRA');
      await freshDirectory(dataDir); const lease = await DataDirectoryLease.acquire(dataDir, { mode: 'maintenance' }); let complete = false; try { const source = await open(scratchPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { let position = 4 + manifestLength; for (const entry of manifest.entries) { const target = childPath(dataDir, entry.path); if (entry.type === 'directory') await mkdir(target, { mode: 0o700 }); else { const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { let left = entry.size!; while (left) { const read = await source.read(fileBytes, 0, Math.min(left, fileBytes.length), position); position += read.bytesRead; assert(read.bytesRead > 0, 'ENCRYPTED_PAYLOAD_TRUNCATED'); await writeAll(out, fileBytes.subarray(0, read.bytesRead)); left -= read.bytesRead; } await out.sync(); } finally { await out.close(); } } } } finally { await source.close(); } await lease.assertHeld(); complete = true; return { dataDir, appId: input.appId, files: manifest.entries.filter(entry => entry.type === 'file').length, bytes: total }; } finally { if (complete) await lease.release(); }
    } finally { await readScratch.close(); }
  } finally { if (scratch) await scratch.close(); await encrypted.close(); await rm(scratchPath, { force: true }); }
}
