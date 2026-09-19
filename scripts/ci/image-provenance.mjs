import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const check = (ok, code) => { if (!ok) throw Error(code); };
export function githubWorkflowIdentity({repository, workflow, ref}) {
  check(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository)
    && !repository.split('/').some(part => part === '.' || part === '..')
    && typeof workflow === 'string' && /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflow)
    && typeof ref === 'string' && /^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
    && !ref.includes('..') && !ref.includes('//') && !/[/.]$/.test(ref)
    && !ref.split('/').some(part => part.endsWith('.lock')), 'PROVENANCE_INVALID_BUILD_IDENTITY');
  return `https://github.com/${repository}/${workflow}@${ref}`;
}

export function imageReleaseRecord(input) {
  const { repository, revision, branch, runId, runAttempt, imageId, archiveSha256,
    sourceSha256, snapshotSha256, recorderPolicySha256, verifierSha256, packageManifestSha256, workloadManifestSha256 } = input;
  check(/^[\w.-]+\/[\w.-]+$/.test(repository) && /^[a-f0-9]{40}$/.test(revision)
    && (input.ref !== undefined || ['dev', 'staging'].includes(branch)) && /^\d+$/.test(runId) && /^\d+$/.test(runAttempt), 'PROVENANCE_INVALID_BUILD_IDENTITY');
  const workflow = input.workflow ?? '.github/workflows/deploy-cvm.yml';
  const ref = input.ref ?? `refs/heads/${branch}`;
  githubWorkflowIdentity({repository, workflow, ref});
  check(/^sha256:[a-f0-9]{64}$/.test(imageId), 'PROVENANCE_INVALID_IMAGE_ID');
  for (const hash of [archiveSha256, sourceSha256, snapshotSha256, recorderPolicySha256, verifierSha256, packageManifestSha256, workloadManifestSha256]) {
    check(/^[a-f0-9]{64}$/.test(hash), 'PROVENANCE_INVALID_HASH');
  }
  // Construct an explicit allowlist; never serialize env, target inventories or sealed configuration.
  return { schema: 'thot.image-release-provenance/1',
    builder: { repository, revision, ref,
      workflow, run_id: runId, run_attempt: runAttempt },
    artifact: { format: 'docker-save+gzip', archive_sha256: archiveSha256, docker_image_id: imageId,
      oci_manifest_digest: null },
    materials: { source_snapshot_sha256: sourceSha256, build_snapshot_manifest_sha256: snapshotSha256,
      recorder_policy_sha256: recorderPolicySha256, dcap_verifier_sha256: verifierSha256 },
    deployment: { encrypted_package_manifest_sha256: packageManifestSha256,
      full_workload_manifest_sha256: workloadManifestSha256, status: 'intended-not-live-attestation' } };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function signImageRelease({ record, archivePath, snapshotManifestPath, evidenceDir, run, repositoryInfo }) {
  check(repositoryInfo?.private === false && repositoryInfo?.full_name === record.builder.repository,
    'PROVENANCE_PUBLIC_REPOSITORY_REQUIRED');
  check(await sha256File(archivePath) === record.artifact.archive_sha256, 'PROVENANCE_ARCHIVE_CHANGED');
  const snapshot = await readFile(snapshotManifestPath);
  check(createHash('sha256').update(snapshot).digest('hex') === record.materials.build_snapshot_manifest_sha256,
    'PROVENANCE_SNAPSHOT_CHANGED');
  const identity = githubWorkflowIdentity(record.builder);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const recordPath = resolve(evidenceDir, 'image-release.json');
  await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await copyFile(snapshotManifestPath, resolve(evidenceDir, 'build-snapshot-manifest.json'));
  for (const [path, name] of [[archivePath, 'image-archive.sigstore.json'], [recordPath, 'image-release.sigstore.json']]) {
    const bundle = resolve(evidenceDir, name);
    await run('cosign', ['sign-blob', '--yes', '--bundle', bundle, path]);
    await run('cosign', ['verify-blob', '--bundle', bundle, '--certificate-identity', identity,
      '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', path]);
  }
  // Recheck before allowing mutation: signing a record never replaces checking actual bytes.
  check(await sha256File(archivePath) === record.artifact.archive_sha256, 'PROVENANCE_ARCHIVE_CHANGED');
  return { identity, evidenceDir };
}
