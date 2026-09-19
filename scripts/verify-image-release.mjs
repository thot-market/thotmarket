#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256File, githubWorkflowIdentity } from './ci/image-provenance.mjs';

export async function verifyImageRelease({ recordPath, recordBundle, archivePath, archiveBundle,
  snapshotManifestPath, expectedIdentity, expectedRevision, expectedImageId, expectedWorkloadHash,
  execute = execFileSync }) {
  const identity = typeof expectedIdentity === 'string' && expectedIdentity.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(\.github\/workflows\/[^@]+)@(refs\/.*)$/);
  if (!identity || githubWorkflowIdentity({repository:identity[1],workflow:identity[2],ref:identity[3]}) !== expectedIdentity
    || !/^[a-f0-9]{40}$/.test(expectedRevision) || !/^sha256:[a-f0-9]{64}$/.test(expectedImageId)
    || !/^[a-f0-9]{64}$/.test(expectedWorkloadHash)) throw Error('Invalid independent trust pins');
  const verify = (path, bundle) => execute('cosign', ['verify-blob', '--bundle', bundle,
    '--certificate-identity', expectedIdentity, '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', path], { stdio: 'pipe' });
  verify(recordPath, recordBundle);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.schema !== 'thot.image-release-provenance/1'
    || `https://github.com/${record.builder.repository}/${record.builder.workflow}@${record.builder.ref}` !== expectedIdentity
    || record.builder.revision !== expectedRevision || record.artifact.docker_image_id !== expectedImageId
    || record.deployment.full_workload_manifest_sha256 !== expectedWorkloadHash
    || await sha256File(archivePath) !== record.artifact.archive_sha256
    || await sha256File(snapshotManifestPath) !== record.materials.build_snapshot_manifest_sha256) {
    throw Error('Release bytes or independent pins do not match');
  }
  verify(archivePath, archiveBundle);
  return { signed_archive: 'PASS', signed_release_binding: 'PASS', snapshot_manifest: 'PASS',
    image_id: expectedImageId, revision: expectedRevision, live_cvm_attestation: 'NOT CHECKED',
    archive_contents_image_id: 'NOT CHECKED', reproducible_build: 'NOT CHECKED' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const names = { '--record': 'recordPath', '--record-bundle': 'recordBundle', '--archive': 'archivePath',
      '--archive-bundle': 'archiveBundle', '--snapshot-manifest': 'snapshotManifestPath',
      '--identity': 'expectedIdentity', '--revision': 'expectedRevision', '--image-id': 'expectedImageId',
      '--workload-hash': 'expectedWorkloadHash' };
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!names[args[i]] || !args[i + 1] || options[names[args[i]]]) throw Error('Invalid arguments');
      options[names[args[i]]] = args[i + 1];
    }
    if (Object.keys(options).length !== Object.keys(names).length) throw Error('Missing arguments');
    console.log(JSON.stringify(await verifyImageRelease(options), null, 2));
  } catch { console.error('Image release verification FAILED; check signatures, artifact bytes and independently obtained trust pins.'); process.exitCode = 1; }
}
