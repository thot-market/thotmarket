import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createThotBuildSnapshot, verifyThotBuildSnapshot} from '../scripts/build-thot-image.mjs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('scripts/runtime-python-files.json', root), 'utf8'));

test('Docker and snapshot share an explicit current Python runtime boundary', async () => {
  assert.equal(manifest.format, 'thot.runtime-python-files/1');
  assert.equal(new Set(manifest.files).size, manifest.files.length);
  const docker = await readFile(new URL('Dockerfile', root), 'utf8');
  const copy = docker.replace(/\\\n\s*/g, ' ').split('\n').find(line => /^COPY trace-vault\//.test(line));
  assert(copy);
  assert.deepEqual(copy.split(/\s+/).slice(1, -1).sort(), [...manifest.files].sort());
  for (const path of manifest.files) {
    assert.match(path, /^trace-vault\/[a-z_]+\.py$/);
    assert((await readFile(new URL(path, root))).length > 0);
  }
  assert(!manifest.files.includes('trace-vault/server.py'));
  assert(!manifest.files.includes('trace-vault/settlement_keys.py'));
});

test('an added Python file cannot silently enter the image snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'thot-runtime-scope-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const source = join(dir, 'source'); await mkdir(source);
  const files = {
    'Dockerfile':'FROM node:24-slim\n', 'package.json':'{}', 'pnpm-lock.yaml':'', 'tsconfig.json':'{}',
    'apps/api/server.ts':'export {};', 'scripts/cvm-prestart.ts':'export {};',
    'deploy/thot-config.trade-candidate.example.json':'{}',
    'contracts/package.json':'{}', 'contracts/pnpm-lock.yaml':'',
    'contracts/scripts/thot-local-fixture.mjs':'export {};',
    'contracts/src/ThotMarket.sol':'pragma solidity ^0.8.30; contract ThotMarket {}',
    'trace-vault/attestation_verify.py':'# reviewed verifier',
    'trace-vault/unreviewed_extension.py':'# must not enter artifact',
    'trace-vault/server.py':'# retired router',
    'trace-vault/settlement_keys.py':'# retired key authority',
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(source,path)), {recursive:true}); await writeFile(join(source,path),bytes);
  }
  const git = args => execFileSync('git',['-C',source,...args],{stdio:'pipe'});
  git(['init','-q','-b','main']); git(['add','.']);
  git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture']);
  const verifier = join(dir,'qvl'); const bytes=Buffer.from('synthetic verifier');await writeFile(verifier,bytes);
  const result = await createThotBuildSnapshot({sourceRoot:source,outputDir:join(dir,'snapshot'),verifierPath:verifier,expectedVerifierSha256:createHash('sha256').update(bytes).digest('hex')});
  const {manifest: built} = await verifyThotBuildSnapshot(result.output,result.manifest_sha256);
  assert(built.source_files.some(file=>file.path==='trace-vault/attestation_verify.py'));
  for(const path of ['trace-vault/unreviewed_extension.py','trace-vault/server.py','trace-vault/settlement_keys.py'])assert(!built.source_files.some(file=>file.path===path),path);
});
