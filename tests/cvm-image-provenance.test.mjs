import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { imageReleaseRecord, signImageRelease } from '../scripts/ci/image-provenance.mjs';
const hash = data => createHash('sha256').update(data).digest('hex');
const input = { repository: 'public-owner/public-project', revision: 'a'.repeat(40), branch: 'staging', runId: '123', runAttempt: '1',
  imageId: 'sha256:' + 'b'.repeat(64), archiveSha256: hash('archive'), sourceSha256: 'c'.repeat(64),
  snapshotSha256: hash('{}'), recorderPolicySha256: 'd'.repeat(64), verifierSha256: 'e'.repeat(64),
  packageManifestSha256: 'f'.repeat(64), workloadManifestSha256: '1'.repeat(64) };
test('release record binds all build/deployment hashes and excludes arbitrary secrets', () => {
  const record = imageReleaseRecord({ ...input, sealed_env: 'PRIVATE_SENTINEL', operator_key: 'PRIVATE_SENTINEL' });
  assert.ok(!JSON.stringify(record).includes('PRIVATE_SENTINEL'));
  assert.equal(record.artifact.oci_manifest_digest, null);
  assert.equal(record.artifact.docker_image_id, input.imageId);
  assert.equal(record.materials.recorder_policy_sha256, input.recorderPolicySha256);
  assert.equal(record.deployment.full_workload_manifest_sha256, input.workloadManifestSha256);
  for (const field of Object.keys(input)) {
    assert.throws(() => imageReleaseRecord({ ...input, [field]: 'invalid' }), /PROVENANCE_INVALID/);
  }
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cvm-provenance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archivePath = join(dir, 'archive'), snapshotManifestPath = join(dir, 'snapshot');
  await writeFile(archivePath, 'archive'); await writeFile(snapshotManifestPath, '{}');
  return { record: imageReleaseRecord(input), archivePath, snapshotManifestPath, evidenceDir: join(dir, 'evidence'),
    repositoryInfo: { private: false, full_name: input.repository } };
}
test('signs exact archive and release record and verifies both with exact workflow identity', async t => {
  const f = await fixture(t), calls = [];
  await signImageRelease({ ...f, run: async (command, args) => { calls.push({ command, args }); } });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].args.at(-1), f.archivePath);
  for (const i of [1, 3]) {
    assert.equal(calls[i].args[0], 'verify-blob');
    assert.ok(calls[i].args.includes('https://github.com/public-owner/public-project/.github/workflows/deploy-cvm.yml@refs/heads/staging'));
    assert.ok(calls[i].args.includes('https://token.actions.githubusercontent.com'));
  }
  assert.deepEqual(JSON.parse(await readFile(join(f.evidenceDir, 'image-release.json'))), f.record);
});
test('private identity, changed bytes and signer failure never authorize deployment', async t => {
  const f = await fixture(t); let calls = 0;
  const run = async () => { calls++; throw Error('signer failed'); };
  await assert.rejects(signImageRelease({ ...f, run, repositoryInfo: { private: true, full_name: input.repository } }), /PUBLIC_REPOSITORY_REQUIRED/);
  await writeFile(f.archivePath, 'tampered');
  await assert.rejects(signImageRelease({ ...f, run }), /ARCHIVE_CHANGED/);
  await writeFile(f.archivePath, 'archive'); await writeFile(f.snapshotManifestPath, 'tampered');
  await assert.rejects(signImageRelease({ ...f, run }), /SNAPSHOT_CHANGED/);
  assert.equal(calls, 0);
  await writeFile(f.snapshotManifestPath, '{}');
  await assert.rejects(signImageRelease({ ...f, run }), /signer failed/);
  assert.equal(calls, 1);
});
test('post-sign archive mutation is rejected even if signature commands return success', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(signImageRelease({ ...f, run: async () => { if (++calls === 4) await writeFile(f.archivePath, 'tampered'); } }), /ARCHIVE_CHANGED/);
});

test('consumer verifier rejects changed archive and independent pins, and keeps live checks explicit', async t => {
  const { verifyImageRelease } = await import('../scripts/verify-image-release.mjs');
  const f = await fixture(t), recordPath = join(f.evidenceDir, 'image-release.json');
  await signImageRelease({ ...f, run: async () => {} });
  const options = { recordPath, recordBundle: 'record.bundle', archivePath: f.archivePath, archiveBundle: 'archive.bundle',
    snapshotManifestPath: f.snapshotManifestPath,
    expectedIdentity: 'https://github.com/public-owner/public-project/.github/workflows/deploy-cvm.yml@refs/heads/staging',
    expectedRevision: input.revision, expectedImageId: input.imageId, expectedWorkloadHash: input.workloadManifestSha256,
    execute: () => {} };
  const result = await verifyImageRelease(options);
  assert.equal(result.signed_archive, 'PASS'); assert.equal(result.live_cvm_attestation, 'NOT CHECKED');
  for (const [field, value] of [['expectedRevision', '9'.repeat(40)], ['expectedImageId', 'sha256:' + '9'.repeat(64)],
    ['expectedWorkloadHash', '9'.repeat(64)], ['expectedIdentity', options.expectedIdentity.replace('staging', 'dev')]]) {
    await assert.rejects(verifyImageRelease({ ...options, [field]: value }), /do not match/);
  }
  await assert.rejects(verifyImageRelease({ ...options, execute: () => { throw Error('bad signature'); } }), /bad signature/);
  await writeFile(f.archivePath, 'tampered');
  await assert.rejects(verifyImageRelease(options), /do not match/);
});

test('consumer requires the exact independently selected workflow and version tag', async t => {
  const {verifyImageRelease}=await import('../scripts/verify-image-release.mjs');
  const f=await fixture(t);
  f.record=imageReleaseRecord({...input,workflow:'.github/workflows/build-image.yml',ref:'refs/tags/v0.3.0-rc.4'});
  await signImageRelease({...f,run:async()=>{}});
  const expectedIdentity='https://github.com/public-owner/public-project/.github/workflows/build-image.yml@refs/tags/v0.3.0-rc.4';
  const calls=[];
  const options={recordPath:join(f.evidenceDir,'image-release.json'),recordBundle:'record.bundle',archivePath:f.archivePath,archiveBundle:'archive.bundle',snapshotManifestPath:f.snapshotManifestPath,
    expectedIdentity,expectedRevision:input.revision,expectedImageId:input.imageId,expectedWorkloadHash:input.workloadManifestSha256,execute:(_command,args)=>calls.push(args)};
  assert.equal((await verifyImageRelease(options)).signed_release_binding,'PASS');
  assert.equal(calls.length,2);
  for(const args of calls)assert.equal(args[args.indexOf('--certificate-identity')+1],expectedIdentity);
  for(const wrong of [expectedIdentity.replace('rc.4','rc.5'),expectedIdentity.replace('build-image','other')])await assert.rejects(verifyImageRelease({...options,expectedIdentity:wrong}),/do not match/);
  for(const wrong of [expectedIdentity+'*',expectedIdentity.replace('/tags/','/pull/'),expectedIdentity.replace('build-image.yml','../build-image.yml')]){
    let executed=false;
    await assert.rejects(verifyImageRelease({...options,expectedIdentity:wrong,execute:()=>{executed=true;}}));
    assert.equal(executed,false);
  }
});
