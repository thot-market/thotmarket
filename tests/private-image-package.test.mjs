import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagePrivateImage } from '../scripts/package-private-image.mjs';
import { downloadPrivateImage } from '../deploy/private-image-bootstrap.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'thot-image-package-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clear = randomBytes(7000), archivePath = join(dir, 'image.tar.gz');
  await writeFile(archivePath, clear, { mode: 0o600 });
  return { dir, clear, options: { archivePath, archiveSha256: hash(clear), imageId: 'sha256:' + 'a'.repeat(64), outputDir: join(dir, 'package'), chunkBytes: 513 } };
}

test('portable packager round-trips through measured bootstrap; public directory contains only authenticated ciphertext', async t => {
  const f = await fixture(t), result = await packagePrivateImage(f.options);
  const publicDir = join(result.output_dir, 'public');
  const files = await readdir(publicDir), manifestBytes = await readFile(join(publicDir, 'manifest.json'));
  const key = (await readFile(join(result.output_dir, 'image.key'), 'utf8')).trim();
  assert.equal(hash(manifestBytes), result.manifest_sha256);
  assert.equal(files.length, result.encrypted_chunks + 1);
  assert.equal((await stat(join(result.output_dir, 'image.key'))).mode & 0o777, 0o600);
  for (const file of files) {
    assert.ok(file === 'manifest.json' || /^image-\d{4}\.bin$/.test(file));
    const bytes = await readFile(join(publicDir, file));
    assert.ok(!bytes.includes(Buffer.from(key)) && !bytes.includes(f.clear.subarray(0, 64)));
  }
  const fetchImpl = async url => new Response(await readFile(join(publicDir, new URL(url).pathname.split('/').at(-1))));
  const outputPath = join(f.dir, 'restored', 'image.tar.gz');
  await downloadPrivateImage({ manifestUrl: 'https://artifacts.example/release/manifest.json', manifestSha256: result.manifest_sha256,
    imageId: f.options.imageId, keyBase64: key, outputPath, fetchImpl });
  assert.deepEqual(await readFile(outputPath), f.clear);
  await assert.rejects(packagePrivateImage(f.options));
  assert.equal(await readFile(join(result.output_dir, 'image.key'), 'utf8'), key + '\n');
});

for (const invalid of ['wrong archive hash', 'public archive', 'symlink archive', 'too many chunks', 'invalid image']) {
  test(`packager rejects ${invalid} and leaves no partial publication`, async t => {
    const f = await fixture(t);
    if (invalid === 'wrong archive hash') f.options.archiveSha256 = 'f'.repeat(64);
    if (invalid === 'public archive') await chmod(f.options.archivePath, 0o644);
    if (invalid === 'symlink archive') { const path = join(f.dir, 'alias.tar.gz'); await symlink(f.options.archivePath, path); f.options.archivePath = path; }
    if (invalid === 'too many chunks') f.options.chunkBytes = 1;
    if (invalid === 'invalid image') f.options.imageId = 'mutable:latest';
    await assert.rejects(packagePrivateImage(f.options));
    await assert.rejects(stat(f.options.outputDir), { code: 'ENOENT' });
  });
}
