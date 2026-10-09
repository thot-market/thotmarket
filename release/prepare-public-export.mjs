#!/usr/bin/env node
// Flattened public export of one commit, plus the branding step that gates it.
// `git archive` gives the committed bytes with no working-tree or history noise;
// internal coordination paths are withheld and reported as findings instead of
// being dropped silently. The export carries no credentials and no git metadata.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPublicBranding, INTERNAL_PATHS} from '../scripts/check-public-branding.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (ok, message) => {if (!ok) throw new Error(message);};
// Reports and dry-run evidence may identify private hosted environments even
// after passing the branding check. Keep their source-side review history, but
// do not publish it with the runtime, tests and documentation. This export-only
// boundary does not exempt those files from the repository's branding check.
const WITHHELD_EXPORT_PATHS = [...INTERNAL_PATHS, /^reports\//, /^rc-dry-run\//];

/** Every regular file below root, refusing symlinks and special files. */
async function walk(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), {withFileTypes: true})) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    fail(!entry.isSymbolicLink(), 'EXPORT_SYMLINK:' + path);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else {fail(entry.isFile(), 'EXPORT_SPECIAL_FILE:' + path); files.push(path);}
  }
  return files.sort();
}

async function digest(root, path) {
  const hash = createHash('sha256');
  await new Promise((resolveStream, reject) => {
    const stream = createReadStream(join(root, path));
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', resolveStream);
  });
  return hash.digest('hex');
}

/**
 * @param {object} options
 * @param {string} [options.sourceRoot] git checkout supplying the commit
 * @param {string} options.commit revision; must resolve to exactly one commit
 * @param {string} options.outputDir destination; must not already exist
 * @param {string} [options.manifestPath] where to write the export manifest
 *   (outside the export, so the manifest never describes itself)
 */
export async function preparePublicExport({sourceRoot = REPO, commit, outputDir, manifestPath}) {
  fail(typeof commit === 'string' && commit.trim() && !commit.includes('\0'), 'EXPORT_COMMIT_REQUIRED');
  fail(typeof outputDir === 'string' && isAbsolute(outputDir), 'ABSOLUTE_OUTPUT_DIRECTORY_REQUIRED');
  const root = resolve(sourceRoot), output = resolve(outputDir);
  if (manifestPath) {
    fail(isAbsolute(manifestPath), 'ABSOLUTE_MANIFEST_PATH_REQUIRED');
    const fromOutput = relative(output, resolve(manifestPath));
    fail(fromOutput === '..' || fromOutput.startsWith('../') || isAbsolute(fromOutput), 'MANIFEST_MUST_BE_OUTSIDE_EXPORT');
  }
  // Same boundary as scripts/build-thot-image.mjs: ignored work/ or outside the source.
  const within = relative(root, output);
  fail(output !== root && (within.startsWith('..') || isAbsolute(within) || within === 'work' || within.startsWith('work/')), 'OUTPUT_MUST_BE_IN_WORK_OR_OUTSIDE_SOURCE');
  fail(await lstat(output).then(() => false, error => error.code === 'ENOENT'), 'OUTPUT_MUST_BE_A_FRESH_DIRECTORY');
  const revision = execFileSync('git', ['-C', root, 'rev-parse', '--verify', commit + '^{commit}'], {encoding: 'utf8'}).trim();
  fail(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(revision), 'EXPORT_COMMIT_NOT_RESOLVED:' + commit);
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  const archive = output + '.tar';
  execFileSync('git', ['-C', root, 'archive', '--format=tar', '--output', archive, revision]);
  try {
    await mkdir(output, {mode: 0o700});
    execFileSync('tar', ['-x', '-f', archive, '-C', output]);
  } catch (error) {await rm(output, {recursive: true, force: true}); throw error;}
  finally {await rm(archive, {force: true});}

  const exported = await walk(output);
  const findings = [];
  for (const path of exported.filter(path => WITHHELD_EXPORT_PATHS.some(pattern => pattern.test(path)))) {
    await rm(join(output, path), {recursive: true, force: true});
    findings.push({code: 'withheld-internal-path', path, detail: 'Development coordination, task reports and hosted-run evidence are not public release surface.'});
  }
  const files = [];
  for (const path of await walk(output)) files.push({path, sha256: await digest(output, path)});
  // The branding step runs over the exported bytes themselves, so a clean source
  // checkout cannot vouch for content that never left it.
  execFileSync('git', ['-C', output, 'init', '--quiet']);
  try {
    execFileSync('git', ['-C', output, 'add', '--all']);
    const branded = checkPublicBranding(output);
    fail(branded.files === files.length, 'BRANDING_FILE_COUNT_MISMATCH');
  } finally {await rm(join(output, '.git'), {recursive: true, force: true});}

  const manifest = {format: 'thot.public-export/1', status: 'draft-review-required', commit: revision,
    created_at: new Date().toISOString(), file_count: files.length, files, findings,
    note: 'Flattened git archive of one commit. Findings are recorded for review and are not resolved here.'};
  const encoded = JSON.stringify(manifest, null, 2) + '\n';
  const manifest_sha256 = sha(encoded);
  if (manifestPath) await writeFile(manifestPath, encoded, {mode: 0o600});
  return {output, commit: revision, status: manifest.status, file_count: files.length,
    findings_count: findings.length, findings, manifest_sha256};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    fail(['--commit', '--output', '--source', '--manifest'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'Usage: prepare-public-export.mjs --commit REV --output DIR [--source ROOT] [--manifest FILE]');
    options[args[i].slice(2)] = args[++i];
  }
  fail(Boolean(options.commit && options.output), 'Usage: prepare-public-export.mjs --commit REV --output DIR [--source ROOT] [--manifest FILE]');
  try {console.log(JSON.stringify(await preparePublicExport({sourceRoot: options.source, commit: options.commit,
    outputDir: options.output, manifestPath: options.manifest}), null, 2));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
