import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '../deploy/private-image-bootstrap.mjs';
import { validatePrivateOutput } from './prepare-private-cvm.mjs';

const MAX_CHUNK = 16 * 1024 * 1024;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = value => { if (!value) throw Error('Invalid private image package input'); };

/** Offline packaging only. Upload public/; the sibling image.key must remain private. */
export async function packagePrivateImage({ archivePath, archiveSha256, imageId, outputDir, chunkBytes = MAX_CHUNK }) {
  let input, directory, created = false, key;
  try {
    check(isAbsolute(archivePath) && /^[a-f0-9]{64}$/.test(archiveSha256));
    check(/^sha256:[a-f0-9]{64}$/.test(imageId));
    check(Number.isSafeInteger(chunkBytes) && chunkBytes > 0 && chunkBytes <= MAX_CHUNK);
    input = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await input.stat();
    check(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 0o077) === 0);
    check(before.size > 0 && before.size <= MAX_ARCHIVE && Math.ceil(before.size / chunkBytes) <= 128);
    directory = await validatePrivateOutput(outputDir);
    await mkdir(directory, { mode: 0o700 }); created = true;
    const publicDir = resolve(directory, 'public');
    await mkdir(publicDir, { mode: 0o700 });
    key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('thot.cvm-image/1'));
    const plaintextHash = createHash('sha256'), ciphertextHash = createHash('sha256');
    let position = 0, encryptedSize = 0;
    const chunks = [];
    while (position < before.size) {
      const clear = Buffer.alloc(Math.min(chunkBytes, before.size - position));
      let offset = 0;
      while (offset < clear.length) {
        const { bytesRead } = await input.read(clear, offset, clear.length - offset, position + offset);
        check(bytesRead > 0); offset += bytesRead;
      }
      position += clear.length;
      plaintextHash.update(clear);
      const encrypted = cipher.update(clear);
      clear.fill(0);
      ciphertextHash.update(encrypted); encryptedSize += encrypted.length;
      const name = `image-${String(chunks.length).padStart(4, '0')}.bin`;
      await writeFile(resolve(publicDir, name), encrypted, { flag: 'wx', mode: 0o600 });
      chunks.push({ name, size: encrypted.length, sha256: hash(encrypted) });
    }
    check(cipher.final().length === 0);
    const after = await input.stat();
    check(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
    check(plaintextHash.digest('hex') === archiveSha256);
    const manifest = { schema: 'thot.private-image/1', algorithm: 'aes-256-gcm', aad: 'thot.cvm-image/1',
      nonce_b64: nonce.toString('base64'), tag_b64: cipher.getAuthTag().toString('base64'), image_id: imageId,
      archive_sha256: archiveSha256, archive_size: before.size,
      ciphertext_sha256: ciphertextHash.digest('hex'), ciphertext_size: encryptedSize, chunks };
    validateManifest(manifest, imageId);
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(resolve(publicDir, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(directory, 'image.key'), key.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
    const summary = { schema_version: 'thot.private-image-package/1', image_id: imageId,
      manifest_sha256: hash(manifestBytes), public_directory: 'public', private_key_file: 'image.key',
      archive_sha256: archiveSha256, archive_bytes: before.size, encrypted_chunks: chunks.length };
    await writeFile(resolve(directory, 'package.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { output_dir: directory, ...summary };
  } catch {
    if (created) await rm(directory, { recursive: true, force: true });
    throw Error('Private image packaging failed; no existing output was overwritten and key material was not logged');
  } finally { key?.fill(0); await input?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    check(args.length === 8);
    const options = {};
    const names = { '--archive': 'archivePath', '--archive-sha256': 'archiveSha256', '--image-id': 'imageId', '--output': 'outputDir' };
    for (let index = 0; index < args.length; index += 2) {
      check(names[args[index]] && !(names[args[index]] in options));
      options[names[args[index]]] = args[index + 1];
    }
    console.log(JSON.stringify(await packagePrivateImage(options)));
  } catch { console.error('Private image packaging failed; review the archive pin, paths and private-file permissions.'); process.exitCode = 1; }
}
