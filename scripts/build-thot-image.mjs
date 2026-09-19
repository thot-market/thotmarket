#!/usr/bin/env node
import {constants, readFileSync} from 'node:fs';
import {open, mkdir, readFile, writeFile, lstat, readdir, chmod, realpath} from 'node:fs/promises';
import {resolve, dirname, relative, join, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const runtimePython = new Set(JSON.parse(readFileSync(new URL('./runtime-python-files.json', import.meta.url), 'utf8')).files);
const NODE_IMAGE = 'node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
const QVL_SHA256 = '84bd935e37decbace7a902da2680d7486caca954438bb3196c8da8ed91f26d7b';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (ok, message) => {if (!ok) throw new Error(message);};
const fixed = new Set(['Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
  'contracts/package.json', 'contracts/pnpm-lock.yaml', 'contracts/scripts/thot-local-fixture.mjs',
  'deploy/thot-config.cvm.json', 'deploy/thot-config.trade-candidate.example.json', 'deploy/tee-recorder-policy.json', 'trace-vault/deploy/robinhood-measurements.json',
  'packages/provenance/requirements.txt', 'packages/provenance/vendor/ATTEST-PROXY-LICENSE']);
const runtimeScripts = new Set(['build-privy-auth.mjs', 'cvm-prestart.ts', 'capture-terminal-child.ts', 'robinhood-existing-browser.mjs',
  'robinhood-browser-link.mjs', 'thot-link.ts', 'thot.ts', 'thot-setup.ts',
  'install-capture-helper.ts', 'migrate-vault-objects.ts', 'storage-backup.ts', 'storage-restore.ts', 'storage-orphans.ts', 'tee-capture-server.ts']);
const privateAnvilScripts = new Set(['private-anvil-app.mjs', 'private-anvil-bootstrap.mjs', 'private-anvil-fund.mjs', 'private-anvil-rpc.mjs']);
const profiles = new Set(['public', 'private-anvil']);

function permitted(path, profile = 'public') {
  // Never read the contents of excluded credentials, fixtures or local state.
  if (path.split('/').some(part => /^\.|^(?:work|node_modules|fixtures|test[-_]?fixtures|private[-_]?fixtures|private|secrets?|credentials?|__pycache__)$/i.test(part)) && path !== '.dockerignore') {
    // The credentials package contains verifier code; its private state still cannot enter.
    if (!/^packages\/credentials\/src\/[^/]+\.ts$/.test(path)) return false;
  }
  if (path !== 'trace-vault/credential_robinhood.py' && /(?:^|\/)(?:[^/]*[._-])?(?:secrets?|credentials?|passwords?|private[-_]?keys?|token[-_]?dump)(?:[._-][^/]*)?\.[^/]+$/i.test(path)) return false;
  if (fixed.has(path)) return true;
  if (/^apps\/(?:api|worker)\/[^/]+\.ts$/.test(path)) return true;
  if (/^apps\/dashboard\/[^/]+\.(?:js|html|css)$/.test(path)) return true;
  if (/^apps\/site\/[^/]+\.(?:ts|js|html|css)$/.test(path)) return true;
  if (/^apps\/site\/assets\/(?:[^/]+\.(?:png|jpg|jpeg|webp|svg)|fonts\/[^/]+\.(?:woff2|txt))$/.test(path)) return true;
  if (/^packages\/[a-z0-9-]+\/src\/(?:[a-z0-9_-]+\/)*[^/]+\.(?:ts|mjs|js)$/.test(path)) return true;
  if (/^packages\/chain\/[^/]+\.ts$/.test(path)) return true;
  if (/^packages\/provenance\/(?:scripts\/[^/]+\.py|vendor\/[^/]+\.ts)$/.test(path)) return true;
  if (/^packages\/provenance\/portable\/(?:verify\.mjs|canonical\.mjs|hardware\.mjs|verify_dcap\.py|requirements\.txt|README\.txt)$/.test(path)) return true;
  if (/^migrations\/\d{3}_[a-z0-9_]+\.sql$/.test(path)) return true;
  if (/^contracts\/src\/[A-Za-z0-9_-]+\.sol$/.test(path)) return true;
  if (path.startsWith('scripts/') && (runtimeScripts.has(path.slice(8)) || (profile === 'private-anvil' && privateAnvilScripts.has(path.slice(8))))) return true;
  return runtimePython.has(path);
}

async function readRegular(root, path) {
  fail(!isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), 'UNSAFE_SOURCE_PATH');
  let at = root;
  for (const part of path.split('/').slice(0, -1)) {at = join(at, part); fail((await lstat(at)).isDirectory() && !(await lstat(at)).isSymbolicLink(), 'SOURCE_SYMLINK_OR_NON_DIRECTORY');}
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); fail(stat.isFile() && stat.size <= 32_000_000, 'SOURCE_NOT_REGULAR_OR_TOO_LARGE');
    const bytes = await handle.readFile(); fail(bytes.length === stat.size, 'SOURCE_CHANGED_DURING_READ');
    return {bytes, mode: stat.mode & 0o111 ? 0o555 : 0o444};
  } finally {await handle.close();}
}

function screenSource(path, bytes) {
  if (!/\.(?:ts|mjs|js|py|sh|json|yaml|yml|sql|html|css|txt)$/.test(path) && !fixed.has(path)) return;
  const text = bytes.toString('utf8');
  fail(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk_(?:live|test)_[A-Za-z0-9_-]{24,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bprivy_app_secret_[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\b(?:private_key|api_key|secret_key)\s*[:=]\s*["'][A-Za-z0-9_\/-]{32,}["']/i.test(text), 'POSSIBLE_SECRET_IN_BUILD_SOURCE:' + path);
}

export async function createThotBuildSnapshot({sourceRoot = REPO, outputDir, verifierPath, expectedVerifierSha256 = QVL_SHA256, profile = 'public'}) {
  fail(profiles.has(profile), 'INVALID_BUILD_PROFILE');
  const root = await realpath(sourceRoot), output = resolve(outputDir);
  const outputRelative = relative(root, output).split('\\').join('/');
  fail(output !== root && (outputRelative.startsWith('../') || outputRelative.startsWith('work/')), 'OUTPUT_MUST_BE_IN_WORK_OR_OUTSIDE_SOURCE');
  const verifier = await readRegular(dirname(resolve(verifierPath)), resolve(verifierPath).split('/').at(-1));
  fail(sha(verifier.bytes) === expectedVerifierSha256, 'VERIFIER_HASH_MISMATCH');
  fail(verifier.bytes.length >= 4, 'INVALID_VERIFIER');
  const sourcePaths = () => {
    // --cached includes deleted tracked paths until the deletion is staged. A
    // snapshot follows the working tree and should not try to open them.
    const deleted = new Set(execFileSync('git', ['-C', root, 'ls-files', '--deleted', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean));
    return [...new Set(execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {encoding: 'utf8'})
      .split('\0').filter(path => path && !deleted.has(path) && permitted(path, profile)))].sort();
  };
  const paths = sourcePaths();
  for (const required of ['Dockerfile', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'apps/api/server.ts', 'scripts/cvm-prestart.ts',
    ...(profile === 'private-anvil' ? [...privateAnvilScripts].map(name => 'scripts/' + name) : []),
    'contracts/package.json', 'contracts/pnpm-lock.yaml',
    'contracts/scripts/thot-local-fixture.mjs', 'contracts/src/ThotMarket.sol',
    'deploy/thot-config.trade-candidate.example.json']) fail(paths.includes(required), 'REQUIRED_BUILD_SOURCE_MISSING:' + required);
  const files = [];
  for (const path of paths) {
    const source = await readRegular(root, path); screenSource(path, source.bytes);
    files.push({path, ...source, sha256: sha(source.bytes), size: source.bytes.length});
  }
  const afterPaths = sourcePaths();
  fail(JSON.stringify(paths) === JSON.stringify(afterPaths), 'WORKING_TREE_CHANGED_DURING_SNAPSHOT');
  for (const file of files) {const current = await readRegular(root, file.path); fail(sha(current.bytes) === file.sha256 && current.mode === file.mode, 'WORKING_TREE_CHANGED_DURING_SNAPSHOT');}
  const sourceEntries = files.map(({path, sha256, size, mode}) => ({path, sha256, size, mode}));
  const sourceHash = sha(JSON.stringify(sourceEntries));
  const dockerfile = files.find(file => file.path === 'Dockerfile').bytes.toString('utf8');
  fail(/^FROM node:24-slim\s*$/m.test(dockerfile), 'UNREVIEWED_DOCKER_BASE');
  const recipe = dockerfile.replace(/^FROM node:24-slim\s*$/m, 'FROM ' + NODE_IMAGE);
  const manifest = {format: 'thot.build-snapshot/1', profile, source_sha256: sourceHash,
    git_head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    platform: 'linux/amd64', base_image: NODE_IMAGE, recipe_sha256: sha(recipe),
    verifier_sha256: expectedVerifierSha256, source_files: sourceEntries,
    note: 'Current working-tree bytes, including permitted untracked source. No registry push. Network-resolved OS/Python packages mean image builds need not be bit-for-bit reproducible; record and pin the final image digest.'};
  // A snapshot is never overwritten. Its recorded hash is the external trust pin.
  await mkdir(dirname(output), {recursive: true, mode: 0o700}); await mkdir(output, {mode: 0o700});
  await mkdir(join(output, 'source')); await mkdir(join(output, 'verifier'));
  for (const file of files) {
    const destination = join(output, 'source', file.path); await mkdir(dirname(destination), {recursive: true});
    await writeFile(destination, file.bytes, {flag: 'wx', mode: file.mode}); await chmod(destination, file.mode);
  }
  await writeFile(join(output, 'verifier', 'dcap-qvl'), verifier.bytes, {flag: 'wx', mode: 0o555});
  await writeFile(join(output, 'Dockerfile.build'), recipe, {flag: 'wx', mode: 0o444});
  const encoded = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(output, 'manifest.json'), encoded, {flag: 'wx', mode: 0o444});
  const manifestHash = sha(encoded);
  await writeFile(join(output, 'manifest.sha256'), manifestHash + '\n', {flag: 'wx', mode: 0o444});
  return {output, source_sha256: sourceHash, manifest_sha256: manifestHash, file_count: files.length,
    build_command: ['node', fileURLToPath(import.meta.url), '--snapshot', output, '--expected-manifest-sha256', manifestHash, '--build', '--image', 'thot-market:v0.9-' + sourceHash.slice(0, 12)]};
}

async function treeFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), {withFileTypes: true})) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    fail(!entry.isSymbolicLink(), 'SNAPSHOT_SYMLINK');
    if (entry.isDirectory()) files.push(...await treeFiles(root, path));
    else {fail(entry.isFile(), 'SNAPSHOT_SPECIAL_FILE'); files.push(path);}
  }
  return files.sort();
}

export async function verifyThotBuildSnapshot(snapshot, expectedManifestSha256) {
  fail(/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? ''), 'EXPECTED_MANIFEST_HASH_REQUIRED');
  const output = await realpath(snapshot), encoded = (await readRegular(output, 'manifest.json')).bytes;
  fail(sha(encoded) === expectedManifestSha256, 'SNAPSHOT_MANIFEST_CHANGED');
  const manifest = JSON.parse(encoded);
  fail(manifest.format === 'thot.build-snapshot/1' && Array.isArray(manifest.source_files), 'INVALID_BUILD_MANIFEST');
  // Older pinned snapshots predate explicit profiles and included the private runtime.
  const profile = manifest.profile ?? 'private-anvil';
  fail(profiles.has(profile), 'INVALID_BUILD_PROFILE');
  fail(sha(JSON.stringify(manifest.source_files)) === manifest.source_sha256, 'SOURCE_MANIFEST_MISMATCH');
  for (const child of ['source', 'verifier']) {const stat = await lstat(join(output, child)); fail(stat.isDirectory() && !stat.isSymbolicLink(), 'SNAPSHOT_SYMLINK_OR_NON_DIRECTORY');}
  const actual = await treeFiles(join(output, 'source'));
  fail(JSON.stringify(actual) === JSON.stringify(manifest.source_files.map(file => file.path).sort()), 'UNEXPECTED_SNAPSHOT_FILE');
  for (const file of manifest.source_files) {
    fail(permitted(file.path, profile), 'DISALLOWED_SNAPSHOT_PATH');
    const source = await readRegular(join(output, 'source'), file.path);
    fail(sha(source.bytes) === file.sha256 && source.bytes.length === file.size && ((await lstat(join(output, 'source', file.path))).mode & 0o777) === file.mode, 'SNAPSHOT_SOURCE_CHANGED:' + file.path);
  }
  fail(sha((await readRegular(output, 'Dockerfile.build')).bytes) === manifest.recipe_sha256, 'SNAPSHOT_RECIPE_CHANGED');
  fail(sha((await readRegular(output, 'verifier/dcap-qvl')).bytes) === manifest.verifier_sha256, 'SNAPSHOT_VERIFIER_CHANGED');
  fail(JSON.stringify(await treeFiles(join(output, 'verifier'))) === JSON.stringify(['dcap-qvl']), 'UNEXPECTED_VERIFIER_FILE');
  return {output, manifest};
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--build') {options.build = true; continue;}
    fail(['--output', '--source', '--verifier', '--snapshot', '--expected-manifest-sha256', '--image', '--profile'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'INVALID_BUILD_ARGUMENT');
    options[args[i].slice(2)] = args[++i];
  }
  fail(Boolean(options.output) !== Boolean(options.snapshot), 'CHOOSE_OUTPUT_OR_SNAPSHOT');
  fail(!options.snapshot || !options.profile, 'PROFILE_IS_BOUND_TO_SNAPSHOT');
  let result;
  if (options.output) result = await createThotBuildSnapshot({sourceRoot: options.source ?? REPO, outputDir: options.output,
    verifierPath: options.verifier ?? join(REPO, 'work/tools/dcap-qvl-v0.6.1/dcap-qvl-linux-x86_64-musl'), profile: options.profile ?? 'public'});
  if (options.build) {
    fail(typeof options.image === 'string' && /^[a-z0-9][a-z0-9._/:+-]{0,199}$/.test(options.image), 'LOCAL_IMAGE_TAG_REQUIRED');
    const {output, manifest} = await verifyThotBuildSnapshot(result?.output ?? options.snapshot, result?.manifest_sha256 ?? options['expected-manifest-sha256']);
    const imageIdPath = join(output, 'image-id.txt');
    const command = ['build', '--load', '--platform', 'linux/amd64', '--file', join(output, 'Dockerfile.build'), '--build-context', 'verifier=' + join(output, 'verifier'),
      '--build-arg', 'THOT_SOURCE_REVISION=content-sha256:' + manifest.source_sha256, '--label', 'org.opencontainers.image.source.digest=sha256:' + manifest.source_sha256,
      '--iidfile', imageIdPath, '--tag', options.image, join(output, 'source')];
    const built = spawnSync('docker', command, {stdio: 'inherit'}); fail(built.status === 0, 'LOCAL_IMAGE_BUILD_FAILED');
    result = {...result, output, source_sha256: manifest.source_sha256, image_id: (await readFile(imageIdPath, 'utf8')).trim(), registry_push: false};
  } else if (options.snapshot) {
    const verified = await verifyThotBuildSnapshot(options.snapshot, options['expected-manifest-sha256']);
    result = {verified: true, output: verified.output, source_sha256: verified.manifest.source_sha256};
  }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => {console.error(error.message); process.exitCode = 1;});
