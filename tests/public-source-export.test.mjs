import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {preparePublicExport} from '../release/prepare-public-export.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

async function fixture(t, files) {
  const temporary = await mkdtemp(join(tmpdir(), 'thot-public-export-'));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const sourceRoot = join(temporary, 'source');
  await mkdir(sourceRoot);
  git(sourceRoot, 'init', '--quiet');
  git(sourceRoot, 'config', 'user.name', 'Thot Market');
  git(sourceRoot, 'config', 'user.email', 'development@thot.market');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(sourceRoot, path)), {recursive: true});
    await writeFile(join(sourceRoot, path), content);
  }
  git(sourceRoot, 'add', '--all');
  git(sourceRoot, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic export fixture');
  return {sourceRoot, commit: git(sourceRoot, 'rev-parse', 'HEAD'),
    outputDir: join(temporary, 'public'), manifestPath: join(temporary, 'manifest.json')};
}

async function filesBelow(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), {withFileTypes: true})) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) result.push(...await filesBelow(root, path));
    else result.push(path);
  }
  return result.sort();
}

test('export retains committed public source and fixtures while withholding task and hosted evidence', async t => {
  const publicFiles = {
    'README.md': '# Thot Market\n',
    'DEVELOPMENT.md': 'Publicly understandable development instructions.\n',
    '.github/workflows/verify.yml': 'name: Public source verification\n',
    'apps/dashboard/app.js': 'export const revision = "committed";\n',
    'apps/site/assets/logo.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    'docs/local-purchase-demo.md': 'Synthetic local purchase evidence.\n',
    'packages/provenance/fixtures/quote.json': '{"synthetic":true}\n',
    'tests/fixtures/exchange.json': '{"synthetic":true}\n',
    'release/test-suites.json': '{"suites":{}}\n',
  };
  const privateFiles = {
    'steering/0019-task.md': 'Internal coordination.\n',
    'reports/0019/index.html': '<p>Private environment review.</p>\n',
    'reports/0019/evidence/deployment.json': '{"host":"private-host.example.invalid"}\n',
    'reports/0019/media/journey.webm': 'Private task media.\n',
    'rc-dry-run/abcdef0/RECORD.md': 'Private hosted run identifier.\n',
    'rc-dry-run/abcdef0/evidence/journey.png': 'Private hosted screenshot.\n',
  };
  const options = await fixture(t, {...publicFiles, ...privateFiles});
  await writeFile(join(options.sourceRoot, 'apps/dashboard/app.js'), 'uncommitted changes');
  await writeFile(join(options.sourceRoot, 'untracked.txt'), 'not committed');
  const result = await preparePublicExport(options);
  assert.equal(result.commit, options.commit);
  assert.equal(result.status, 'draft-review-required');
  assert.deepEqual(await filesBelow(options.outputDir), Object.keys(publicFiles).sort());
  await assert.rejects(stat(join(options.outputDir, '.git')), {code: 'ENOENT'});
  for (const [path, content] of Object.entries(publicFiles)) {
    assert.deepEqual(await readFile(join(options.outputDir, path)), Buffer.from(content));
  }
  const manifestBytes = await readFile(options.manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(result.manifest_sha256, sha(manifestBytes));
  assert.equal(manifest.file_count, Object.keys(publicFiles).length);
  assert.deepEqual(manifest.files, Object.keys(publicFiles).sort().map(path => ({path, sha256: sha(publicFiles[path])})));
  assert.deepEqual(manifest.findings.map(item => item.path).sort(), Object.keys(privateFiles).sort());
  assert.equal(result.findings_count, Object.keys(privateFiles).length);
  assert.ok(manifest.findings.every(item => item.code === 'withheld-internal-path'));
  assert.equal(manifestBytes.includes(Buffer.from('private-host.example.invalid')), false);
});

test('findings manifest cannot be written into the public export', async t => {
  const options = await fixture(t, {'README.md': '# Thot Market\n'});
  for (const manifestPath of [options.outputDir, join(options.outputDir, 'findings.json'), join(options.outputDir, 'nested', 'findings.json')]) {
    await assert.rejects(preparePublicExport({...options, manifestPath}), /MANIFEST_MUST_BE_OUTSIDE_EXPORT/);
    await assert.rejects(stat(options.outputDir), {code: 'ENOENT'});
  }
});

test('withholding private evidence does not exempt public runtime bytes from branding validation', async t => {
  const disallowed = String.fromCharCode(119, 97, 107, 101);
  const options = await fixture(t, {
    'README.md': '# Thot Market\n',
    'reports/0019/index.html': 'Private report.\n',
    'apps/dashboard/app.js': `export const project = "${disallowed}";\n`,
  });
  await assert.rejects(preparePublicExport(options), /Legacy project identity in public source: apps\/dashboard\/app.js/);
  await assert.rejects(stat(options.manifestPath), {code: 'ENOENT'});
});
