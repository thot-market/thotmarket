import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { downloadPrivateImage } from '../deploy/private-image-bootstrap.mjs';
import { renderPrelaunch } from '../scripts/render-private-image-prelaunch.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const imageId = `sha256:${'a'.repeat(64)}`;
function fixture() {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const clear = Buffer.from('private application source must not be imported without authentication\n'.repeat(40));
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('thot.cvm-image/1'));
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const files = new Map();
  const chunks = [];
  for (let start = 0, index = 0; start < encrypted.length; start += 513, index++) {
    const part = encrypted.subarray(start, start + 513);
    const name = `image-${String(index).padStart(4, '0')}.bin`;
    files.set(name, part);
    chunks.push({ name, size: part.length, sha256: hash(part) });
  }
  const manifest = {
    schema: 'thot.private-image/1', algorithm: 'aes-256-gcm', aad: 'thot.cvm-image/1',
    nonce_b64: nonce.toString('base64'), tag_b64: cipher.getAuthTag().toString('base64'), image_id: imageId,
    archive_sha256: hash(clear), archive_size: clear.length,
    ciphertext_sha256: hash(encrypted), ciphertext_size: encrypted.length, chunks,
  };
  const commit = () => {
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    return hash(files.get('manifest.json'));
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(new URL(url).origin, 'https://artifacts.example');
    const content = files.get(new URL(url).pathname.split('/').at(-1));
    if (!content) return new Response('', { status: 404 });
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= content.length) return controller.close();
      controller.enqueue(content.subarray(offset, offset + 97));
      offset += 97;
    } }), { headers: { 'content-length': String(content.length) } });
  };
  return { key, clear, files, manifest, fetchImpl, commit };
}

async function run(t, f, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'thot-private-image-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'image.tar.gz');
  const options = {
    manifestUrl: 'https://artifacts.example/build/manifest.json', manifestSha256: f.commit(),
    imageId, keyBase64: f.key.toString('base64'), outputPath, fetchImpl: f.fetchImpl, ...overrides,
  };
  return { directory, outputPath, options };
}

test('private image download authenticates fragmented ciphertext and atomically publishes owner-only archive', async (t) => {
  const f = fixture();
  const { outputPath, options } = await run(t, f);
  const result = await downloadPrivateImage(options);
  assert.deepEqual(await readFile(outputPath), f.clear);
  assert.equal(result.archive_sha256, hash(f.clear));
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});

test('private image download recovers from transient manifest and chunk failures', async (t) => {
  const f = fixture();
  const attempts = new Map();
  const fetchImpl = async (url, options) => {
    const name = new URL(url).pathname.split('/').at(-1);
    const count = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, count);
    if (name === 'manifest.json' && count === 1) throw new TypeError('temporary network failure');
    if (name === 'manifest.json' && count === 2) return new Response('', { status: 503 });
    if (name === 'image-0000.bin' && count === 1) return new Response('', { status: 404 });
    if (name === 'image-0000.bin' && count === 2) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(f.files.get(name).subarray(0, 8));
        controller.error(new TypeError('connection reset'));
      } }));
    }
    return f.fetchImpl(url, options);
  };
  const { outputPath, options } = await run(t, f, { fetchImpl });
  await downloadPrivateImage(options);
  assert.deepEqual(await readFile(outputPath), f.clear);
  assert.equal(attempts.get('manifest.json'), 3);
  assert.equal(attempts.get('image-0000.bin'), 3);
});

test('persistent missing chunk exhausts bounded retries without publishing plaintext', async (t) => {
  const f = fixture();
  let attempts = 0;
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname.endsWith('/image-0000.bin')) {
      attempts++;
      return new Response('', { status: 404 });
    }
    return f.fetchImpl(url, options);
  };
  const { directory, options } = await run(t, f, { fetchImpl });
  await assert.rejects(downloadPrivateImage(options), /Private image bootstrap failed/);
  assert.equal(attempts, 5);
  assert.deepEqual(await readdir(directory), []);
});

for (const mutation of ['manifest hash', 'chunk bytes', 'tag', 'wrong key', 'gzip hash', 'wrong image', 'path traversal', 'oversize']) {
  test(`private image rejects ${mutation} and removes incomplete plaintext`, async (t) => {
    const f = fixture();
    if (mutation === 'tag') f.manifest.tag_b64 = randomBytes(16).toString('base64');
    if (mutation === 'gzip hash') f.manifest.archive_sha256 = 'b'.repeat(64);
    if (mutation === 'wrong image') f.manifest.image_id = `sha256:${'c'.repeat(64)}`;
    if (mutation === 'path traversal') f.manifest.chunks[0].name = '../private-key';
    if (mutation === 'oversize') f.manifest.chunks[0].size = 16 * 1024 * 1024 + 1;
    const { directory, options } = await run(t, f);
    if (mutation === 'manifest hash') options.manifestSha256 = 'd'.repeat(64);
    if (mutation === 'wrong key') options.keyBase64 = randomBytes(32).toString('base64');
    if (mutation === 'chunk bytes') f.files.get(f.manifest.chunks[0].name)[0] ^= 1;
    await assert.rejects(downloadPrivateImage(options), { message: 'Private image bootstrap failed; no unverified image was imported' });
    assert.deepEqual(await readdir(directory), []);
  });
}

test('bootstrap hides arbitrary upstream errors and rejects insecure or credential-bearing URLs', async (t) => {
  const f = fixture();
  const { options } = await run(t, f);
  for (const manifestUrl of ['http://artifacts.example/manifest.json', 'https://secret@artifacts.example/manifest.json', 'https://artifacts.example/manifest.json?key=secret']) {
    await assert.rejects(downloadPrivateImage({ ...options, manifestUrl }), /Private image bootstrap failed/);
  }
  await assert.rejects(downloadPrivateImage({ ...options, fetchImpl: async () => { throw new Error('upstream credential secret'); } }), (error) => !String(error).includes('credential secret'));
});

test('prelaunch is valid shell, pins helper runtime and app, and avoids decrypt key literals or final Docker socket mounts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-prelaunch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = renderPrelaunch({ manifestUrl: 'https://artifacts.example/build/manifest.json', manifestSha256: 'b'.repeat(64), imageId, helperSource: '/* pinned helper */' });
  const path = join(directory, 'prelaunch.sh');
  await writeFile(path, script);
  assert.equal(spawnSync('bash', ['-n', path]).status, 0);
  assert.ok(script.includes('node:24-slim@sha256:'));
  assert.ok(script.includes('docker image inspect'));
  assert.ok(script.includes('-e THOT_PRIVATE_IMAGE_KEY_B64'));
  assert.ok(!script.includes('/var/run/docker.sock'));
  assert.ok(script.includes('unset THOT_PRIVATE_IMAGE_KEY_B64'));
  const imageLoad = script.indexOf('docker load --input');
  assert.ok(imageLoad > script.indexOf('node /out/bootstrap.mjs'));
});

test('prelaunch cached image path permits outer Compose startup without a key or download', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-prelaunch-cache-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = renderPrelaunch({ manifestUrl: 'https://artifacts.example/build/manifest.json', manifestSha256: 'b'.repeat(64), imageId, helperSource: '', includeAppMetadata: false });
  const docker = join(directory, 'docker');
  await writeFile(docker, `#!/bin/sh\nif [ "$1 $2" = 'image inspect' ]; then printf '%s\\n' '${imageId}'; else exit 9; fi\n`, { mode: 0o700 });
  const path = join(directory, 'script.sh');
  await writeFile(path, `${script}\necho OUTER_COMPOSE_REACHED\n`);
  const result = spawnSync('bash', [path], { encoding: 'utf8', env: { PATH: `${directory}:/usr/bin:/bin` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OUTER_COMPOSE_REACHED/);
});
