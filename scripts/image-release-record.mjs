#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const need = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function imageReleaseRecord(input) {
  const {repository, tag, commit, event, ref, runId, runAttempt, image, digest, imageId,
    snapshot, workflow = '.github/workflows/cvm-image.yml'} = input;
  need(repository === 'thot-market/thotmarket', 'Unexpected release repository');
  need(event === 'workflow_dispatch', 'Image publication requires manual dispatch');
  need(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/.test(tag), 'Invalid release tag');
  need(ref === `refs/tags/${tag}`, 'Dispatch ref does not match release tag');
  need(typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit), 'Invalid source commit');
  need(/^[1-9]\d*$/.test(String(runId)) && /^[1-9]\d*$/.test(String(runAttempt)), 'Invalid workflow run');
  need(workflow === '.github/workflows/cvm-image.yml', 'Unexpected signer workflow');
  need(image === `ghcr.io/${repository}`, 'Unexpected image package');
  need(typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest), 'Invalid OCI manifest digest');
  need(typeof imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(imageId), 'Invalid Docker image ID');
  need(snapshot?.format === 'thot.build-snapshot/1' && snapshot.profile === 'public', 'Public build snapshot required');
  need(snapshot.git_head === commit, 'Build snapshot source commit mismatch');
  need(sha256(snapshot.source_sha256) && sha256(snapshot.verifier_sha256), 'Invalid snapshot hashes');
  need(snapshot.platform === 'linux/amd64', 'Unexpected image platform');
  need(sha256(input.snapshotManifestSha256), 'Invalid snapshot manifest hash');
  return {
    schema: 'thot.cvm-image-release/1',
    source: {repository, tag, commit},
    builder: {workflow, ref, run_id: String(runId), run_attempt: String(runAttempt)},
    build: {profile: snapshot.profile, platform: snapshot.platform,
      source_snapshot_sha256: snapshot.source_sha256,
      snapshot_manifest_sha256: input.snapshotManifestSha256,
      dcap_verifier_sha256: snapshot.verifier_sha256},
    image: {name: image, oci_manifest_digest: digest, docker_image_id: imageId,
      pinned_reference: `${image}@${digest}`},
    deployment: {compose_hash: null, status: 'not-deployed'},
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath] = process.argv.slice(2);
  need(inputPath && outputPath, 'Usage: node scripts/image-release-record.mjs INPUT_JSON OUTPUT_JSON');
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  writeFileSync(outputPath, JSON.stringify(imageReleaseRecord(input), null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
