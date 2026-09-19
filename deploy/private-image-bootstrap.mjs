import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const MAX_CHUNK = 16 * 1024 * 1024;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 5;
const RETRY_DELAY_MS = 250;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const requireValue = (ok) => { if (!ok) throw new Error('Private image validation failed'); };

function base64(value, length) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.length === length && bytes.toString('base64') === value);
  return bytes;
}

export function validateManifest(manifest, imageId) {
  requireValue(manifest && manifest.schema === 'thot.private-image/1');
  requireValue(manifest.algorithm === 'aes-256-gcm' && manifest.aad === 'thot.cvm-image/1');
  requireValue(/^sha256:[a-f0-9]{64}$/.test(imageId) && manifest.image_id === imageId);
  for (const field of ['archive_sha256', 'ciphertext_sha256']) requireValue(hashPattern.test(manifest[field]));
  for (const field of ['archive_size', 'ciphertext_size']) {
    requireValue(Number.isSafeInteger(manifest[field]) && manifest[field] > 0 && manifest[field] <= MAX_ARCHIVE);
  }
  requireValue(manifest.archive_size === manifest.ciphertext_size);
  base64(manifest.nonce_b64, 12);
  base64(manifest.tag_b64, 16);
  requireValue(Array.isArray(manifest.chunks) && manifest.chunks.length > 0 && manifest.chunks.length <= 128);
  let total = 0;
  const names = new Set();
  for (const chunk of manifest.chunks) {
    requireValue(chunk && /^image-[0-9]{4}\.bin$/.test(chunk.name) && !names.has(chunk.name));
    requireValue(Number.isSafeInteger(chunk.size) && chunk.size > 0 && chunk.size <= MAX_CHUNK);
    requireValue(hashPattern.test(chunk.sha256));
    names.add(chunk.name);
    total += chunk.size;
  }
  requireValue(total === manifest.ciphertext_size);
  return manifest;
}

class RetryableDownloadError extends Error {}

async function fetchBytes(url, limit, fetchImpl, signal) {
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', signal,
          headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
        });
      } catch (error) {
        // Node fetch reports transport failures as TypeError; do not retry aborts.
        if (signal.aborted || !(error instanceof TypeError)) throw error;
        throw new RetryableDownloadError();
      }
      if (response.status === 404 || response.status >= 500 && response.status <= 599) {
        await response.body?.cancel().catch(() => {});
        throw new RetryableDownloadError();
      }
      requireValue(response.status === 200 && response.body && !response.redirected);
      const length = response.headers.get('content-length');
      if (length !== null) requireValue(/^\d+$/.test(length) && Number(length) <= limit);
      const chunks = [];
      let size = 0;
      try {
        for await (const part of response.body) {
          size += part.length;
          if (size > limit) throw new Error('Private image validation failed');
          chunks.push(Buffer.from(part));
        }
      } catch (error) {
        if (signal.aborted || size > limit) throw error;
        // An interrupted response body is a transport failure; start a fresh GET.
        throw new RetryableDownloadError();
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (!(error instanceof RetryableDownloadError) || signal.aborted || attempt === DOWNLOAD_ATTEMPTS - 1) throw error;
      await delay(RETRY_DELAY_MS * 2 ** attempt, undefined, { signal });
    }
  }
}

/** Decrypt only to an exclusive private staging file; publish it after every check. */
export async function downloadPrivateImage({
  manifestUrl, manifestSha256, imageId, keyBase64, outputPath,
  fetchImpl = fetch, timeoutMs = 20 * 60 * 1000,
}) {
  let key;
  let file;
  let temporary;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const url = new URL(manifestUrl);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
    requireValue(url.pathname.endsWith('/manifest.json') && hashPattern.test(manifestSha256));
    requireValue(typeof outputPath === 'string' && outputPath.startsWith('/'));
    key = base64(keyBase64, 32);
    const manifestBytes = await fetchBytes(url, 64 * 1024, fetchImpl, abort.signal);
    requireValue(digest(manifestBytes) === manifestSha256);
    const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')), imageId);
    const out = resolve(outputPath);
    const directory = dirname(out);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
    temporary = `${out}.${randomBytes(12).toString('hex')}.partial`;
    file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const decipher = createDecipheriv('aes-256-gcm', key, base64(manifest.nonce_b64, 12));
    decipher.setAAD(Buffer.from(manifest.aad));
    decipher.setAuthTag(base64(manifest.tag_b64, 16));
    const encryptedHash = createHash('sha256');
    const archiveHash = createHash('sha256');
    let archiveSize = 0;
    const write = async (data) => {
      archiveSize += data.length;
      requireValue(archiveSize <= manifest.archive_size);
      archiveHash.update(data);
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await file.write(data, offset, data.length - offset);
        requireValue(bytesWritten > 0);
        offset += bytesWritten;
      }
    };
    for (const chunk of manifest.chunks) {
      const next = new URL(chunk.name, url);
      requireValue(next.origin === url.origin && dirname(next.pathname) === dirname(url.pathname));
      const encrypted = await fetchBytes(next, chunk.size, fetchImpl, abort.signal);
      requireValue(encrypted.length === chunk.size && digest(encrypted) === chunk.sha256);
      encryptedHash.update(encrypted);
      await write(decipher.update(encrypted));
    }
    // No plaintext is imported by Docker until authentication has succeeded.
    await write(decipher.final());
    requireValue(encryptedHash.digest('hex') === manifest.ciphertext_sha256);
    requireValue(archiveSize === manifest.archive_size && archiveHash.digest('hex') === manifest.archive_sha256);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, out);
    temporary = undefined;
    return { image_id: imageId, archive_sha256: manifest.archive_sha256, archive_size: archiveSize };
  } catch {
    throw new Error('Private image bootstrap failed; no unverified image was imported');
  } finally {
    clearTimeout(timer);
    key?.fill(0);
    await file?.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestUrl, manifestSha256, imageId, outputPath] = process.argv.slice(2);
  const keyBase64 = process.env.THOT_PRIVATE_IMAGE_KEY_B64;
  delete process.env.THOT_PRIVATE_IMAGE_KEY_B64;
  try {
    const result = await downloadPrivateImage({ manifestUrl, manifestSha256, imageId, outputPath, keyBase64 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Private image bootstrap failed; inspect only non-secret deployment metadata.\n');
    process.exitCode = 1;
  }
}
