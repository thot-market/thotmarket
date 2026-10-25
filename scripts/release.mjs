#!/usr/bin/env node
// One-command release candidate: export a commit, publish it to the public repository as the next
// `vX.Y.Z-rc.N`, wait for its public checks, build the image from that tag, and print the digest.
// Usage: node scripts/release.mjs [commit]   (default: origin/main). Needs `gh` signed in as a maintainer.
import {execFileSync} from 'node:child_process';
import {cp, mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preparePublicExport} from '../release/prepare-public-export.mjs';
import {installReleaseGitIdentity} from './check-release-git-identity.mjs';

const PUBLIC = 'thot-market/thotmarket';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts}) ?? '').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function nextTag(tags) {
  const versions = tags.map(tag => /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(tag)).filter(Boolean)
    .map(m => m.slice(1, 5).map(n => Number(n ?? 0)))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  if (!versions.length) throw new Error('No existing release tag to continue from');
  const [major, minor, patch, rc] = versions.at(-1);
  return `v${major}.${minor}.${patch}-rc.${rc + 1}`;
}

async function waitForRun(workflow, sha) {
  for (;;) {
    const [latest] = JSON.parse(run('gh', ['run', 'list', '-R', PUBLIC, '--workflow', workflow, '--commit', sha, '--limit', '1', '--json', 'databaseId,status,conclusion']));
    if (latest?.status === 'completed') {
      if (latest.conclusion !== 'success') throw new Error(`${workflow} ${latest.conclusion} for ${sha}: gh run view ${latest.databaseId} -R ${PUBLIC}`);
      return latest.databaseId;
    }
    await sleep(20_000);
  }
}

async function main(commit = 'origin/main') {
  run('git', ['-C', root, 'fetch', '-q', 'origin']);
  const source = run('git', ['-C', root, 'rev-parse', commit + '^{commit}']);
  const tag = nextTag(run('git', ['ls-remote', '--tags', '--refs', `https://github.com/${PUBLIC}.git`]).split('\n').map(line => line.split('refs/tags/')[1]).filter(Boolean));
  const work = await mkdtemp(join(tmpdir(), 'thot-release-'));
  try {
    console.log(`Releasing ${source.slice(0, 12)} as ${tag}`);
    await preparePublicExport({sourceRoot: root, commit: source, outputDir: join(work, 'export'), manifestPath: join(work, 'export-manifest.json')});
    const repo = join(work, 'public');
    run('gh', ['repo', 'clone', PUBLIC, repo, '--', '-q']); // full history: the release hook verifies every prior release commit
    installReleaseGitIdentity(repo);
    for (const entry of await readdir(repo)) if (entry !== '.git') await rm(join(repo, entry), {recursive: true, force: true});
    await cp(join(work, 'export'), repo, {recursive: true});
    // The release identity comes from the clone's config; a caller's GIT_AUTHOR_*/GIT_COMMITTER_* must not override it.
    const env = Object.fromEntries(Object.entries({...process.env, TZ: 'UTC'}).filter(([key]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(key)));
    run('git', ['-C', repo, 'add', '-A']);
    run('git', ['-C', repo, 'commit', '-q', '-m', `Release ${tag}`], {env});
    run('git', ['-C', repo, 'tag', '-a', tag, '-m', `Release ${tag}`], {env});
    const published = run('git', ['-C', repo, 'rev-parse', 'HEAD']);
    run('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD:main', tag], {stdio: ['ignore', 'inherit', 'inherit']});
    console.log(`Pushed ${PUBLIC}@${published.slice(0, 12)}; waiting for public checks`);
    await waitForRun('verify.yml', published);
    run('gh', ['workflow', 'run', 'cvm-image.yml', '-R', PUBLIC, '--ref', tag, '-f', `tag=${tag}`]);
    await sleep(10_000);
    console.log('Building image (approve the cvm-image-release environment in GitHub if asked)');
    const imageRun = await waitForRun('cvm-image.yml', published);
    run('gh', ['run', 'download', String(imageRun), '-R', PUBLIC, '-D', join(work, 'image')]);
    const [artifact] = await readdir(join(work, 'image'));
    const record = JSON.parse(await readFile(join(work, 'image', artifact, 'image-release.json'), 'utf8'));
    const image = `${record.image}@${record.digest}`;
    run('gh', ['release', 'create', tag, '-R', PUBLIC, '--prerelease', '--verify-tag', '--title', tag,
      '--notes', `Source: ${published}\nImage: ${image}`]);
    console.log(JSON.stringify({tag, source, published, image}, null, 2));
  } finally {
    await rm(work, {recursive: true, force: true});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
