import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createThotBuildSnapshot, verifyThotBuildSnapshot} from '../scripts/build-thot-image.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'thot-source-')), source = join(root, 'repo');
  await mkdir(source);
  const put = async (path, value) => {await mkdir(join(source, path, '..'), {recursive: true}); await writeFile(join(source, path), value);};
  for (const [path, content] of Object.entries({'Dockerfile': 'FROM node:24-slim\nCOPY apps ./apps\n', 'package.json': '{}\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n', 'tsconfig.json': '{}\n', 'apps/api/server.ts': 'export const version="committed";\n', 'scripts/cvm-prestart.ts': 'export const ready=true;\n', 'scripts/private-anvil-app.mjs': 'export const app=true;\n', 'scripts/private-anvil-bootstrap.mjs': 'import "../contracts/scripts/thot-local-fixture.mjs";\n', 'scripts/private-anvil-fund.mjs': 'export const fund=true;\n', 'scripts/private-anvil-rpc.mjs': 'export const rpc=true;\n', 'contracts/package.json': '{}\n', 'contracts/pnpm-lock.yaml': 'lockfileVersion: 9\n', 'contracts/scripts/thot-local-fixture.mjs': 'export const compileThot=()=>({});\n', 'contracts/src/ThotMarket.sol': 'pragma solidity ^0.8.30; contract ThotMarket {}\n', 'deploy/thot-config.trade-candidate.example.json': '{}\n'})) await put(path, content);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], {stdio: 'ignore'});
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const verifier = Buffer.from('synthetic verifier bytes, not executable and never used to build'), verifierPath = join(root, 'verifier');
  await writeFile(verifierPath, verifier);
  const options = name => ({sourceRoot: source, outputDir: join(root, name), verifierPath, expectedVerifierSha256: hash(verifier), profile: 'private-anvil'});
  return {root, source, put, options};
}

test('public image profile builds from an export without private Anvil scripts', async () => {
  const f = await fixture();
  try {
    const publicOptions = {...f.options('public'), profile: 'public'};
    const result = await createThotBuildSnapshot(publicOptions);
    const {manifest} = await verifyThotBuildSnapshot(result.output, result.manifest_sha256);
    assert.equal(manifest.profile, 'public');
    assert(!manifest.source_files.some(file => file.path.startsWith('scripts/private-anvil-')));
    for (const name of ['app', 'bootstrap', 'fund', 'rpc']) await rm(join(f.source, 'scripts/private-anvil-' + name + '.mjs'));
    const exported = await createThotBuildSnapshot({...publicOptions, outputDir: join(f.root, 'exported')});
    assert.equal(exported.source_sha256, result.source_sha256);
    await assert.rejects(createThotBuildSnapshot({...f.options('incomplete-private'), outputDir: join(f.root, 'incomplete-private')}), /REQUIRED_BUILD_SOURCE_MISSING:scripts\/private-anvil-app\.mjs/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('snapshot includes dirty tracked and new runtime code, but excludes credentials, fixtures and unexpected files', async () => {
  const f = await fixture();
  try {
    await f.put('apps/api/server.ts', 'export const version="dirty working tree";\n');
    await f.put('packages/market/src/new-feature.ts', 'export const automatic=true;\n');
    for (const path of ['packages/provenance/portable/verify.mjs', 'packages/provenance/portable/canonical.mjs', 'packages/provenance/portable/hardware.mjs', 'packages/provenance/portable/verify_dcap.py', 'packages/provenance/portable/requirements.txt', 'packages/provenance/portable/README.txt']) await f.put(path, 'portable runtime asset');
    for (const path of ['.env', '.env.production', 'work/private.json', 'apps/api/.env', 'apps/api/secrets.ts', 'apps/api/api-key.pem', 'apps/api/unexpected.bin', 'packages/market/private-fixtures/customer.ts', 'packages/market/src/privatefixtures/customer.ts', 'packages/provenance/fixtures/private.json', 'config/clerk.private.json']) await f.put(path, 'private fixture sentinel');
    const result = await createThotBuildSnapshot(f.options('snapshot'));
    assert.equal(await readFile(join(result.output, 'source/apps/api/server.ts'), 'utf8'), 'export const version="dirty working tree";\n');
    const verified = await verifyThotBuildSnapshot(result.output, result.manifest_sha256);
    assert.ok(verified.manifest.source_files.some(file => file.path === 'packages/market/src/new-feature.ts'));
    for (const path of ['scripts/private-anvil-app.mjs', 'scripts/private-anvil-bootstrap.mjs', 'scripts/private-anvil-fund.mjs', 'scripts/private-anvil-rpc.mjs', 'contracts/package.json', 'contracts/pnpm-lock.yaml', 'contracts/scripts/thot-local-fixture.mjs', 'contracts/src/ThotMarket.sol']) assert.ok(verified.manifest.source_files.some(file => file.path === path));
    for (const path of ['packages/provenance/portable/verify.mjs', 'packages/provenance/portable/canonical.mjs', 'packages/provenance/portable/hardware.mjs', 'packages/provenance/portable/verify_dcap.py', 'packages/provenance/portable/requirements.txt', 'packages/provenance/portable/README.txt']) assert.ok(verified.manifest.source_files.some(file => file.path === path));
    const reviewedPrivateAnvilScripts = new Set(['scripts/private-anvil-app.mjs', 'scripts/private-anvil-bootstrap.mjs', 'scripts/private-anvil-fund.mjs', 'scripts/private-anvil-rpc.mjs']);
    assert.ok(!verified.manifest.source_files.some(file => !reviewedPrivateAnvilScripts.has(file.path) && /\.env|private|secret|unexpected|api-key|\.git/.test(file.path)));
    assert.match(await readFile(join(result.output, 'Dockerfile.build'), 'utf8'), /FROM node:24-slim@sha256:[a-f0-9]{64}/);
    assert.match(result.source_sha256, /^[a-f0-9]{64}$/);
    const repeat = await createThotBuildSnapshot(f.options('same-bytes'));
    assert.equal(repeat.source_sha256, result.source_sha256); assert.equal(repeat.manifest_sha256, result.manifest_sha256);
    await f.put('packages/market/src/new-feature.ts', 'export const automatic="changed";\n');
    const changed = await createThotBuildSnapshot(f.options('changed-bytes'));
    assert.notEqual(changed.source_sha256, result.source_sha256);
    await assert.rejects(createThotBuildSnapshot(f.options('snapshot')), /EEXIST/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('private Anvil runtime compiler inputs are present in the built image recipe', async () => {
  const productionRecipe = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(productionRecipe, /COPY contracts\/package\.json contracts\/pnpm-lock\.yaml \.\/contracts\//);
  assert.match(productionRecipe, /RUN pnpm --dir contracts install --frozen-lockfile/);
  assert.match(productionRecipe, /COPY contracts\/src \.\/contracts\/src/);
  assert.match(productionRecipe, /COPY contracts\/scripts\/thot-local-fixture\.mjs \.\/contracts\/scripts\/thot-local-fixture\.mjs/);
  const dockerignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  for (const path of ['!contracts/package.json', '!contracts/pnpm-lock.yaml', '!contracts/scripts/thot-local-fixture.mjs', '!contracts/src/**']) assert.match(dockerignore, new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
});

test('snapshot excludes a deleted tracked optional runtime file', async () => {
  const f = await fixture();
  try {
    await f.put('apps/api/obsolete.ts', 'export const obsolete = true;\n');
    execFileSync('git', ['-C', f.source, 'add', 'apps/api/obsolete.ts']);
    execFileSync('git', ['-C', f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'add obsolete'], {stdio: 'ignore'});
    await rm(join(f.source, 'apps/api/obsolete.ts'));
    const result = await createThotBuildSnapshot(f.options('deleted-optional'));
    const verified = await verifyThotBuildSnapshot(result.output, result.manifest_sha256);
    assert.ok(!verified.manifest.source_files.some(file => file.path === 'apps/api/obsolete.ts'));
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('snapshot verification rejects mutation, injected files and changed manifest pins', async () => {
  const f = await fixture();
  try {
    const result = await createThotBuildSnapshot(f.options('snapshot'));
    await assert.rejects(verifyThotBuildSnapshot(result.output, '0'.repeat(64)), /SNAPSHOT_MANIFEST_CHANGED/);
    const path = join(result.output, 'source/apps/api/server.ts'); await chmod(path, 0o644); await writeFile(path, 'modified');
    await assert.rejects(verifyThotBuildSnapshot(result.output, result.manifest_sha256), /SNAPSHOT_SOURCE_CHANGED/);
    const clean = await createThotBuildSnapshot(f.options('clean'));
    await writeFile(join(clean.output, 'source', '.env'), 'never enter build context');
    await assert.rejects(verifyThotBuildSnapshot(clean.output, clean.manifest_sha256), /UNEXPECTED_SNAPSHOT_FILE/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('source symlinks, likely secret literals and a wrong verifier pin fail before a build', async () => {
  const f = await fixture();
  try {
    await f.put('apps/api/private.ts', '-----BEGIN PRIVATE KEY-----');
    await assert.rejects(createThotBuildSnapshot(f.options('secret')), /POSSIBLE_SECRET_IN_BUILD_SOURCE/);
    await rm(join(f.source, 'apps/api/private.ts'));
    await symlink(join(f.root, 'verifier'), join(f.source, 'apps/api/leak.ts'));
    await assert.rejects(createThotBuildSnapshot(f.options('symlink')), /ELOOP|SOURCE_SYMLINK/);
    await rm(join(f.source, 'apps/api/leak.ts'));
    await assert.rejects(createThotBuildSnapshot({...f.options('bad-verifier'), expectedVerifierSha256: '0'.repeat(64)}), /VERIFIER_HASH_MISMATCH/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('Privy application secrets cannot enter a private CVM source snapshot', async () => {
  const f = await fixture();
  try {
    await f.put('apps/api/privy-config.ts', 'export const secret = "privy_app_secret_' + 'x'.repeat(48) + '";\n');
    await assert.rejects(createThotBuildSnapshot(f.options('privy-secret')), /POSSIBLE_SECRET_IN_BUILD_SOURCE:apps\/api\/privy-config\.ts/);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('private CVM snapshot requires the public Robinhood trade verifier configuration', async () => {
  const f = await fixture();
  try {
    execFileSync('git', ['-C', f.source, 'rm', '-q', 'deploy/thot-config.trade-candidate.example.json']);
    await assert.rejects(createThotBuildSnapshot(f.options('missing-trade-config')), /REQUIRED_BUILD_SOURCE_MISSING:deploy\/thot-config\.trade-candidate\.example\.json/);
    await f.put('deploy/thot-config.trade-candidate.example.json', JSON.stringify({
      verifierExecutable: '/usr/bin/python3',
      witnessUrl: 'https://witness.example.test',
      appraiserUrl: 'https://appraiser.example.test',
    }) + '\n');
    const result = await createThotBuildSnapshot(f.options('with-trade-config'));
    const verified = await verifyThotBuildSnapshot(result.output, result.manifest_sha256);
    assert.ok(verified.manifest.source_files.some(file => file.path === 'deploy/thot-config.trade-candidate.example.json'));
    const productionRecipe = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    assert.match(productionRecipe, /COPY deploy\/thot-config\.cvm\.json deploy\/thot-config\.trade-candidate\.example\.json deploy\/tee-recorder-policy\.json \.\/deploy\//);
    const dockerignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
    assert.match(dockerignore, /^!deploy\/thot-config\.trade-candidate\.example\.json$/m);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});
