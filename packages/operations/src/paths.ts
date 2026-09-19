import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';

export const FILE_LIMIT = 128 * 1024 * 1024;
export const TOTAL_LIMIT = 1024 * 1024 * 1024;
export const ENTRY_LIMIT = 20_000;
export function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
export function physicalPath(path: string): string {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), 'INVALID_STORAGE_PATH');
  let absolute = resolve(path);
  // Normalize only macOS's fixed OS aliases, not user-controlled symbolic links.
  if (process.platform === 'darwin') absolute = absolute.replace(/^\/var(?=\/)/, '/private/var').replace(/^\/tmp(?=\/)/, '/private/tmp');
  assert(![parse(absolute).root, homedir(), '/Users', '/private', '/tmp', '/private/tmp', '/var', '/private/var'].includes(absolute), 'BROAD_STORAGE_PATH_FORBIDDEN');
  return absolute;
}
export async function checkedDirectory(path: string, create = false): Promise<string> {
  const absolute = physicalPath(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep)) {
    current = join(current, part);
    try { const stat = await lstat(current); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'STORAGE_SYMLINK_OR_NON_DIRECTORY'); }
    catch (error: any) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return absolute;
}
export async function freshDirectory(path: string): Promise<string> {
  const absolute = physicalPath(path);
  await checkedDirectory(dirname(absolute));
  await mkdir(absolute, { mode: 0o700 }); // EEXIST is deliberately not recovered from.
  return absolute;
}
export function childPath(root: string, relative: string): string {
  assert(typeof relative === 'string' && relative.length <= 1200 && relative.split('/').length <= 16 && relative.split('/').every(part => /^[A-Za-z0-9_.-]{1,200}$/.test(part) && part !== '.' && part !== '..'), 'INVALID_MANIFEST_PATH');
  const result = resolve(root, relative);
  assert(result.startsWith(root + sep), 'MANIFEST_PATH_ESCAPE');
  return result;
}
export async function checkedFile(path: string, limit = FILE_LIMIT): Promise<FileHandle> {
  await checkedDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= limit, 'UNSAFE_STORAGE_FILE');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await checkedFile(path, limit);
  try {
    const buffer = Buffer.alloc(limit + 1); let total = 0;
    while (total < buffer.length) { const r = await handle.read(buffer, total, buffer.length - total, null); if (!r.bytesRead) break; total += r.bytesRead; }
    assert(total <= limit, 'STORAGE_FILE_LIMIT'); return buffer.subarray(0, total);
  } finally { await handle.close(); }
}
export async function writeNew(path: string, content: Buffer | string): Promise<void> {
  await checkedDirectory(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
export interface SnapshotEntry { path: string; type: 'directory' | 'file'; size?: number; sha256?: string }
// These exact optional files contain coarse operator observations. They remain
// inside the sensitive snapshot; a matching directory or temporary file is not
// an approved container for arbitrary additional state.
export const OPERATOR_METADATA_FILES: ReadonlySet<string> = new Set(['operator-activity.v1.json', '.operator-fleet.json']);
export function assertOperatorMetadataEntry(entry: SnapshotEntry): void {
  const root = entry.path.split('/')[0]!;
  if (OPERATOR_METADATA_FILES.has(root)) assert(entry.path === root && entry.type === 'file', 'INVALID_OPERATOR_METADATA_ENTRY');
}
export async function digestFile(source: string, destination?: string, fileLimit = FILE_LIMIT): Promise<{ size: number; sha256: string }> {
  const input = await checkedFile(source, fileLimit); let output: FileHandle | undefined;
  try {
    const before = await input.stat(); assert(before.size <= fileLimit, 'STORAGE_FILE_LIMIT');
    if (destination) { await checkedDirectory(dirname(destination)); output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    const digest = createHash('sha256'); let size = 0; const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      size += bytesRead; assert(size <= fileLimit, 'STORAGE_FILE_LIMIT');
      const chunk = buffer.subarray(0, bytesRead); digest.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    const after = await input.stat();
    assert(after.size === before.size && size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.nlink === 1, 'STORAGE_CHANGED_DURING_READ');
    if (output) await output.sync();
    return { size, sha256: digest.digest('hex') };
  } finally { await input.close(); if (output) await output.close(); }
}
export async function listTree(root: string, limits: {fileLimit?: number; totalLimit?: number} = {}): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = []; let bytes = 0;
  async function walk(relative: string) {
    const path = childPath(root, relative); const stat = await lstat(path);
    assert(!stat.isSymbolicLink(), 'STORAGE_SYMLINK_FORBIDDEN');
    assert(entries.length < ENTRY_LIMIT, 'STORAGE_ENTRY_LIMIT');
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of (await readdir(path)).sort()) await walk(relative + '/' + name);
    } else {
      assert(stat.isFile() && stat.nlink === 1, 'UNSAFE_STORAGE_FILE');
      const info = await digestFile(path, undefined, limits.fileLimit ?? FILE_LIMIT); bytes += info.size; assert(bytes <= (limits.totalLimit ?? TOTAL_LIMIT), 'STORAGE_TOTAL_LIMIT');
      entries.push({ path: relative, type: 'file', ...info });
    }
  }
  for (const entry of (await readdir(root)).sort()) await walk(entry);
  return entries;
}
