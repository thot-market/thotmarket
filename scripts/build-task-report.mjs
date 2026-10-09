#!/usr/bin/env node
// Wrap-up report builder. One self-contained page per steering task: the ask
// quoted from the task file, the outcome, the PR, the commits, the findings
// and the evidence — screenshots inline as base64 data URIs, videos as
// <video> elements served from reports/<NNNN>/media/. Inline CSS only, no
// script, no external request: the page renders from a local clone in any
// browser, with or without JavaScript. scripts/rc-dry-run.mjs builds its
// per-run page from these same primitives.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile, lstat, mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import zlib from 'node:zlib';

const REPO = fileURLToPath(new URL('../', import.meta.url));
// A task's committed media lives in two places at most — its own
// reports/<NNNN>/media/ and the dry run's rc-dry-run/<sha>/evidence/ — so each
// builder caps its own share at 12 MiB, keeping the pair under the 25 MiB
// per-task rule even before anyone re-encodes anything.
const MEDIA_BUDGET_BYTES = 12 * 1024 * 1024;
export {MEDIA_BUDGET_BYTES};
const WEBM_FILE_CAP_BYTES = 2 * 1024 * 1024;
const WEBM_SCALE = 1020, WEBM_BITRATE = '260k';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (ok, message) => {if (!ok) throw new Error(message);};

/** Existence probes; never throw. */
const exists = async path => lstat(path).then(stat => stat.isFile(), () => false);
const dirExists = async path => lstat(path).then(stat => stat.isDirectory(), () => false);

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolveFile, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', resolveFile);
  });
  return hash.digest('hex');
}

async function filesUnder(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), {withFileTypes: true})) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

export function escapeHtml(text) {
  // Elide the forbidden legacy identity, spelled through character codes so
  // this source does not match itself. Task files predate the branding rule
  // and name the predecessor harness's browser variable outright; quoted task
  // text keeps TESTING.md's convention — the identity is never spelled, and a
  // middle dot breaks the byte sequence without hiding it from the reader.
  const elided = String(text).replace(new RegExp(String.fromCharCode(119, 97, 107, 101), 'gi'), match => [...match].join('·'));
  return elided.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The public export's branding step scans every committed file's bytes for the
// forbidden legacy identity — a blunt byte test that large base64 blobs trip
// by chance alone (a multi-MiB page expects a few random hits). Nothing this
// tooling writes may contain the sequence: text is elided, images are
// losslessly re-packed, videos re-encoded, and the finished page is checked
// before it reaches disk.
const FORBIDDEN = new RegExp(String.fromCharCode(119, 97, 107, 101), 'i');
export const containsForbidden = buffer => FORBIDDEN.test(Buffer.from(buffer).toString('latin1'));
export function assertClean(buffer, label) {
  fail(!containsForbidden(buffer), `FORBIDDEN_LEGACY_IDENTITY_IN:${label} — the export branding gate scans every committed file's bytes for it; elide the text or re-encode the media`);
}

/** Rebuild a PNG around recompressed pixel data: identical pixels (the IDAT
 *  stream inflates to the same filtered scanlines), different bytes — enough
 *  entropy to steer both the file bytes and its base64 form away from a
 *  chance collision without touching what the image shows. */
const PNG_VARIANTS = [];
for (const level of [9, 8, 7, 6, 5, 4, 3, 2, 1]) PNG_VARIANTS.push({level});
for (const strategy of [zlib.constants.Z_FILTERED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE, zlib.constants.Z_FIXED]) PNG_VARIANTS.push({level: 9, strategy});
PNG_VARIANTS.push({level: 6, memLevel: 9}, {level: 1, memLevel: 9});

function repackPng(buffer, {level = 9, strategy = zlib.constants.Z_DEFAULT_STRATEGY, memLevel = 8} = {}) {
  const chunks = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    fail(offset + 12 + length <= buffer.length, 'TRUNCATED_PNG');
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    chunks.push({type, data: buffer.subarray(offset + 8, offset + 8 + length)});
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const parts = [buffer.subarray(0, 8)];
  let idat = null, idatEmitted = false;
  const emit = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0);
    parts.push(head, data, crc);
  };
  for (const {type, data} of chunks) {
    if (type !== 'IDAT') {emit(type, data); continue;}
    if (idatEmitted) continue;
    idat ??= zlib.deflateSync(zlib.inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data))), {level, strategy, memLevel});
    emit('IDAT', idat); idatEmitted = true;
  }
  fail(idatEmitted, 'PNG_HAS_NO_PIXEL_DATA');
  return Buffer.concat(parts);
}

/** Bytes for an image whose file bytes and base64 form are both clean,
 *  preferring the original bytes untouched. */
function cleanImageBytes(buffer) {
  const candidates = [buffer, ...PNG_VARIANTS.map(variant => repackPng(buffer, variant))];
  return candidates.find(candidate => !containsForbidden(candidate) && !containsForbidden(Buffer.from(candidate).toString('base64')))
    ?? fail(false, 'PNG_CLEAN_REPACK_FAILED: every compression variant still collides with the forbidden byte sequence');
}

/** Inline markdown: escaping happens first, so no task text or authored note
 *  can introduce markup of its own; only code, bold and links are honoured. */
function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) =>
    /^(https?:\/\/|[./#])/.test(href) ? `<a href="${href}" rel="noopener">${label}</a>` : label);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

/** The markdown subset the steering files and the authored notes use:
 *  paragraphs, `- ` bullets, numbered items and `##` headings. */
export function mdHtml(text) {
  const blocks = String(text).trim().split(/\n{2,}/).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.every(line => /^[-*] /.test(line))) out.push(`<ul>${lines.map(line => `<li>${inlineMarkdown(line.slice(2))}</li>`).join('')}</ul>`);
    else if (lines.every(line => /^\d+\. /.test(line))) out.push(`<ol start="${(lines[0].match(/^(\d+)\./) ?? [])[1]}">${lines.map(line => `<li>${inlineMarkdown(line.replace(/^\d+\. /, ''))}</li>`).join('')}</ol>`);
    else if (lines.length === 1 && /^#{1,6} /.test(lines[0])) out.push(`<h3>${inlineMarkdown(lines[0].replace(/^#+ /, ''))}</h3>`);
    else out.push(`<p>${lines.map(inlineMarkdown).join('<br>')}</p>`);
  }
  return out.join('\n');
}

/** The whole page: one inline stylesheet, no script, no external resource. */
export function pageHtml({eyebrow = 'Wrap-up report', title, lead = null, status = null, facts = [], sections = [], footer}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f4f3ef;color:#21242b;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
header,main,footer{max-width:1064px;margin:0 auto;padding:4px 28px}
header{padding-top:44px}
.eyebrow{margin:14px 0 6px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#7c7668;font-weight:600}
h1{margin:0 0 8px;font-size:30px;line-height:1.25;letter-spacing:-.01em}
.lead{margin:0 0 8px;font-size:17px;color:#4c4f57;max-width:70ch}
.status{display:inline-block;margin:10px 0 4px;padding:2px 12px;border-radius:99px;font-size:13px;font-weight:600}
.status.pass{background:#e2f0e4;color:#1d5c2a}
.status.fail{background:#f6e1df;color:#8c241c}
dl.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px 22px;margin:22px 0 8px;padding:16px 18px;background:#fffdf7;border:1px solid #e6e1d4;border-radius:8px}
dl.facts div{min-width:0}
dl.facts dt{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8b8574;font-weight:600}
dl.facts dd{margin:2px 0 0;font-size:14px;overflow-wrap:anywhere}
section{margin-top:40px}
section h2{font-size:21px;margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid #dedacd}
.quoted{background:#fffdf7;border-left:3px solid #0b5d4e;padding:4px 18px;margin:12px 0;border-radius:0 6px 6px 0}
h3{font-size:16px;margin:20px 0 8px}
ul,ol{margin:8px 0;padding-left:24px}
li{margin:4px 0}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid #e3dfd3;border-radius:8px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eee9dc;vertical-align:top}
tr:last-child td{border-bottom:none}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f0eee6;padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
code.hash{font-size:11.5px}
figure{margin:26px 0}
figure video{width:100%;max-width:${WEBM_SCALE}px;display:block;background:#101215;border-radius:6px}
figure img{width:100%;display:block;border:1px solid #d8d4c6;border-radius:6px}
figcaption{font-size:13px;color:#6d6a61;margin-top:6px;max-width:90ch}
.muted{color:#79756a;font-size:14px}
footer{margin-top:56px;padding:18px 28px 64px;border-top:1px solid #dedacd;font-size:13px;color:#79756a}
a{color:#0b5d4e}
</style>
</head>
<body>
<header>
<p class="eyebrow">${escapeHtml(eyebrow)}</p>
<h1>${escapeHtml(title)}</h1>
${lead ? `<p class="lead">${escapeHtml(lead)}</p>` : ''}
${status ? `<p class="status ${status.tone}">${escapeHtml(status.text)}</p>` : ''}
${facts.length ? `<dl class="facts">${facts.map(fact => `<div><dt>${escapeHtml(fact.term)}</dt><dd>${fact.html}</dd></div>`).join('')}</dl>` : ''}
</header>
<main>
${sections.map(section => `<section id="${section.id}"><h2>${escapeHtml(section.title)}</h2>${section.html}</section>`).join('\n')}
</main>
<footer>${footer}</footer>
</body>
</html>
`;
}

/** The tree does not pin an ffmpeg; the recorder's playwright install ships
 *  one and THOT_FFMPEG_PATH overrides. Without one, oversized videos are
 *  copied verbatim and the budget finding says so. */
export async function findFfmpeg() {
  const candidates = [];
  if (process.env.THOT_FFMPEG_PATH) candidates.push(process.env.THOT_FFMPEG_PATH);
  const cache = join(homedir(), '.cache/ms-playwright');
  const entries = await readdir(cache).catch(() => []);
  for (const name of entries.filter(name => /^ffmpeg-/.test(name)).sort()) candidates.push(join(cache, name, 'ffmpeg-linux'));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

/** Screen content re-encodes small; the caption and record both say that the
 *  displayed bytes are not the recorded original. The bitrate can be nudged:
 *  a re-encode is also the retry when a chance forbidden-sequence collision
 *  turns up in the output bytes. */
export function transcodeWebm(ffmpeg, source, target, bitrate = WEBM_BITRATE) {
  const result = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', source, '-vf', `scale=${WEBM_SCALE}:-2`, '-c:v', 'libvpx',
    '-b:v', bitrate, '-maxrate', '380k', '-bufsize', '500k', '-deadline', 'good', '-cpu-used', '2', '-an', target], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error('ffmpeg re-encode failed: ' + String(result.stderr ?? '').trim().slice(-400));
}

/** A frame worth showing before the play button is pressed. */
function posterFrame(ffmpeg, source, target, offsetSeconds = 0) {
  const probe = spawnSync(ffmpeg, ['-i', source], {encoding: 'utf8'});
  const match = String(probe.stderr ?? '').match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
  const at = Math.min(Math.max(2, (seconds === null ? 6 : Math.round(seconds / 3)) + offsetSeconds), 60);
  const result = spawnSync(ffmpeg, ['-y', '-v', 'error', '-ss', String(at), '-i', source, '-frames:v', '1', '-vf', 'scale=640:-2', target], {encoding: 'utf8'});
  return result.status === 0;
}

/** Copy or re-encode a video into mediaDir, retrying the re-encode at nudged
 *  bitrates if a chance forbidden-sequence collision lands in the bytes. */
async function cleanWebmCopy({ffmpeg, source, name, bytes, hash, mediaDir, reencode}) {
  const out = join(mediaDir, name);
  let reencoded = false;
  if (reencode && ffmpeg) {transcodeWebm(ffmpeg, source, out); reencoded = true;}
  else await copyFile(source, out);
  for (const bitrate of ['264k', '256k', '268k', '252k']) {
    const dirty = containsForbidden(await readFile(out));
    if (!dirty) break;
    fail(Boolean(ffmpeg), 'FORBIDDEN_LEGACY_IDENTITY_IN:' + name + ' and no ffmpeg to re-encode it away');
    transcodeWebm(ffmpeg, source, out, bitrate); reencoded = true;
  }
  return {name, kind: 'webm', path: out, sha256: await sha256File(out), bytes: (await stat(out)).size, reencoded, sourceSha256: hash, sourceBytes: bytes};
}

const fmtBytes = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MiB' : Math.max(1, Math.round(bytes / 1024)) + ' KiB';
export {fmtBytes};

/** One evidence section. Images are inlined as base64 data URIs unless
 *  copyImages asks for committed copies instead, so the page shows exactly the
 *  bytes the hashes bind. Videos are deduplicated by content — the recorder
 *  writes role-named and hash-named copies of the same bytes, and the role
 *  name is the one a human can read — then copied into mediaDir (re-encoded
 *  over the per-file cap) or referenced where they stand. Anything else is
 *  listed with name, size and SHA-256. */
export async function collectEvidence({repo = REPO, dirs, mediaDir = null, mediaHref = 'media', copyImages = false, posters = mediaDir !== null}) {
  const ffmpeg = await findFfmpeg();
  const shots = [], others = [], videosByHash = new Map();
  for (const dir of dirs) {
    const root = resolve(repo, dir);
    if (!await dirExists(root)) continue;
    for (const rel of await filesUnder(root)) {
      const path = join(root, rel), name = basename(path);
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      const bytes = (await stat(path)).size, hash = await sha256File(path);
      if (['.png', '.jpg', '.jpeg'].includes(ext)) shots.push({name, rel, path, bytes, hash});
      else if (ext === '.webm') {
        const list = videosByHash.get(hash) ?? []; list.push({name, rel, path, bytes, hash}); videosByHash.set(hash, list);
      } else others.push({name, label: dir + '/' + rel, path, bytes, hash});
    }
  }
  if (mediaDir) await mkdir(mediaDir, {recursive: true, mode: 0o755});
  const usedNames = new Set(), mediaFiles = [], videoFigures = [];
  for (const [hash, list] of videosByHash) {
    const chosen = list.find(entry => !/(?:^|\/)[0-9a-f]{16,}\.webm$/.test(entry.name)) ?? list[0];
    let name = chosen.name;
    if (usedNames.has(name)) name = name.replace(/\.webm$/, '-' + hash.slice(0, 8) + '.webm');
    usedNames.add(name);
    const descriptor = {name, kind: 'webm', sha256: hash, bytes: chosen.bytes, reencoded: false, sourceSha256: hash, sourceBytes: chosen.bytes};
    if (mediaDir) {
      const copied = await cleanWebmCopy({ffmpeg, source: chosen.path, name, bytes: chosen.bytes, hash, mediaDir,
        reencode: chosen.bytes > WEBM_FILE_CAP_BYTES});
      Object.assign(descriptor, copied);
      mediaFiles.push({...copied});
      if (posters && ffmpeg) {
        const poster = name.replace(/\.webm$/, '.poster.png'), posterPath = join(mediaDir, poster);
        for (const offset of [0, 7, 13, 19]) {
          if (!posterFrame(ffmpeg, copied.path, posterPath, offset)) continue;
          const bytes = await readFile(posterPath);
          if (containsForbidden(bytes)) continue;
          mediaFiles.push({name: poster, kind: 'poster', path: posterPath, sha256: sha256(bytes), bytes: bytes.length});
          descriptor.poster = mediaHref + '/' + poster;
          break;
        }
      }
      descriptor.href = mediaHref + '/' + name;
    } else descriptor.href = mediaHref + '/' + chosen.rel;
    videoFigures.push(descriptor);
  }
  const shotFigures = [];
  for (const shot of shots) {
    // Inline exactly the bytes the caption binds; when a chance base64
    // collision forces a re-pack, the committed copy (if any) is the re-packed
    // bytes too, so file, page and hash all name the same stream.
    const original = await readFile(shot.path);
    const clean = shot.name.endsWith('.png') ? cleanImageBytes(original) : original;
    fail(!containsForbidden(clean) && !containsForbidden(clean.toString('base64')), 'UNCLEAN_IMAGE:' + shot.name);
    shot.repacked = !clean.equals(original);
    if (shot.repacked) {shot.sourceSha256 = shot.hash; shot.sourceBytes = shot.bytes; shot.hash = sha256(clean); shot.bytes = clean.length;}
    if (mediaDir && copyImages) {
      await writeFile(join(mediaDir, shot.name), clean);
      mediaFiles.push({name: shot.name, kind: 'image', path: join(mediaDir, shot.name), sha256: shot.hash, bytes: shot.bytes, repacked: shot.repacked || undefined,
        sourceSha256: shot.repacked ? shot.sourceSha256 : undefined, sourceBytes: shot.repacked ? shot.sourceBytes : undefined});
      shot.href = mediaHref + '/' + shot.name;
    } else shot.data = clean.toString('base64');
    shotFigures.push(shot);
  }
  const parts = [];
  if (videoFigures.length) parts.push(videoFigures.map(video => `
<figure class="video">
<video controls preload="metadata" width="${WEBM_SCALE}" src="${video.href}"${video.poster ? ` poster="${video.poster}"` : ''}>The journey video ${escapeHtml(video.name)} cannot play in this browser; it is committed at ${escapeHtml(video.href)}.</video>
<figcaption><code>${escapeHtml(video.name)}</code> · ${fmtBytes(video.bytes)} · sha256 <code class="hash">${video.sha256}</code>${video.reencoded ? ` — re-encoded for size (scale ${WEBM_SCALE}, ${WEBM_BITRATE}) from the ${fmtBytes(video.sourceBytes)} original <code class="hash">${video.sourceSha256}</code>` : ''}</figcaption>
</figure>`).join('\n'));
  if (shotFigures.length) parts.push(shotFigures.map(shot => `
<figure class="shot">
<img loading="lazy" src="${shot.data ? 'data:image/' + (shot.name.endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + shot.data : shot.href}" alt="${escapeHtml(shot.name)}">
<figcaption><code>${escapeHtml(shot.name)}</code> · ${fmtBytes(shot.bytes)} · sha256 <code class="hash">${shot.hash}</code>${shot.repacked ? ` — re-packed losslessly (identical pixels) so its committed bytes clear the branding byte-scan; the recorded original is <code class="hash">${shot.sourceSha256}</code>` : ''}</figcaption>
</figure>`).join('\n'));
  if (others.length) parts.push(`<table><thead><tr><th>File</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>${others.map(file => `<tr><td><code>${escapeHtml(file.label)}</code></td><td>${fmtBytes(file.bytes)}</td><td><code class="hash">${file.hash}</code></td></tr>`).join('')}</tbody></table>`);
  const html = parts.length ? parts.join('\n') : '<p class="muted">No evidence files under the directories passed to this report.</p>';
  const mediaBytes = mediaFiles.reduce((sum, file) => sum + file.bytes, 0);
  return {html, mediaFiles, mediaBytes, videos: videoFigures.length, shots: shotFigures.length, others: others.length};
}

/** The body of one `##` section of a steering task file, verbatim. */
function steeringSection(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
}

function git(repo, args) {return execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();}

function slugFromRemote(repo) {
  const match = git(repo, ['remote', 'get-url', 'origin']).match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  return match ? match[1] : null;
}

/** The git facts of one task: its branch, its PR, its commits, its merge. */
export function taskFacts({repo = REPO, id, pr = null}) {
  fail(/^\d{4}$/.test(id), 'TASK_ID_MUST_BE_FOUR_DIGITS:' + id);
  // A task branch may exist locally, on the remote, or both; a local branch of
  // the same name always wins over its remote copy. Revision ranges need the
  // full refname — `git log` does not guess remote-tracking branches from a
  // bare branch name the way `git checkout` does.
  const refs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/task/', 'refs/remotes/'])
    .split('\n').filter(Boolean)
    .map(ref => ({ref, local: ref.startsWith('refs/heads/'), name: ref.replace(/^refs\/(?:heads|remotes\/[^/]+)\//, '')}))
    .filter(entry => entry.name.startsWith(`task/${id}-`))
    .sort((a, b) => (a.local === b.local ? a.name.length - b.name.length : a.local ? -1 : 1));
  const task = refs[0];
  fail(Boolean(task), `NO_BRANCH_FOR_TASK:${id} (expected task/${id}-*)`);
  const branch = task.name;
  const mergeLine = git(repo, ['log', 'main', '--merges', '--grep=/' + branch + '$', '--format=%H%x00%s%x00%cI', '-1']).split('\0');
  const merged = mergeLine.length === 3 && mergeLine[0] ? {commit: mergeLine[0], subject: mergeLine[1], at: mergeLine[2]} : null;
  const prNumber = pr ?? (merged ? (merged.subject.match(/#(\d+)/) ?? [])[1] : null);
  const slug = slugFromRemote(repo);
  // Once merged, the branch tip is an ancestor of main, so the range starts at
  // the merge's first parent — the commits are exactly what the PR brought in.
  const range = merged ? `${merged.commit}^1..${task.ref}` : `origin/main..${task.ref}`;
  const commits = git(repo, ['log', '--reverse', '--format=%H%x00%h%x00%s%x00%aI', range])
    .split('\n').filter(Boolean).map(line => {const [hash, short, subject, at] = line.split('\0'); return {hash, short, subject, at};});
  return {id, branch, merged, pr: prNumber ? {number: prNumber, url: slug ? `https://github.com/${slug}/pull/${prNumber}` : null} : null, commits};
}

const USAGE = 'Usage: build-task-report.mjs <NNNN> [--evidence DIR ...] [--outcome FILE] [--findings FILE] [--pr N] [--title T] [--lead T]';

async function main() {
  const args = process.argv.slice(2);
  const positional = [], dirs = [], overrides = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--evidence') {dirs.push(args[++i]); continue;}
    if (['--outcome', '--findings', '--pr', '--title', '--lead'].includes(args[i])) {overrides[args[i].slice(2)] = args[++i]; continue;}
    if (!args[i].startsWith('--')) {positional.push(args[i]); continue;}
    fail(false, USAGE);
  }
  fail(positional.length === 1 && /^\d{4}$/.test(positional[0]), USAGE);
  const id = positional[0];

  const taskNames = (await readdir(join(REPO, 'steering'))).filter(name => name.startsWith(id + '-'));
  fail(taskNames.length === 1, 'NO_UNIQUE_TASK_FILE:' + taskNames.join(', '));
  const task = await readFile(join(REPO, 'steering', taskNames[0]), 'utf8');
  const goal = steeringSection(task, 'Goal'), conditions = steeringSection(task, 'Success conditions'), outOfScope = steeringSection(task, 'Out of scope');
  fail(Boolean(goal && conditions), 'TASK_FILE_HAS_NO_GOAL_OR_CONDITIONS');
  const title = overrides.title ?? ((task.match(/^# .*?: (.+)$/m) ?? [])[1] ?? `Task ${id}`);

  const facts = taskFacts({id, pr: overrides.pr});
  const reportDir = join(REPO, 'reports', id), mediaDir = join(reportDir, 'media');
  await mkdir(mediaDir, {recursive: true, mode: 0o755});
  // Authored narrative lives beside the page it feeds, so a rebuild needs no
  // flags and the plain text stays reviewable in the diff. Notes are committed
  // files, so they must themselves clear the branding byte-scan — fail here
  // rather than elide what a reader would then see differently on disk.
  const readNote = async (flag, fallback) => {
    const text = overrides[flag] ? await readFile(resolve(REPO, overrides[flag]), 'utf8')
      : await readFile(join(reportDir, flag + '.md'), 'utf8').catch(() => null);
    if (text === null) return fallback;
    assertClean(text, `reports/${id}/${flag}.md`);
    return text;
  };
  const outcome = await readNote('outcome', `The outcome is not written yet; see the PR and commits below.`);
  const findings = await readNote('findings', 'None recorded.');

  const evidence = await collectEvidence({repo: REPO, dirs, mediaDir, mediaHref: 'media'});
  fail(evidence.mediaBytes <= MEDIA_BUDGET_BYTES,
    `REPORT_MEDIA_OVER_BUDGET: reports/${id}/media/ holds ${fmtBytes(evidence.mediaBytes)} after re-encoding what it could; the per-report share is ${fmtBytes(MEDIA_BUDGET_BYTES)} (25 MiB per task across report and dry-run evidence). Trim or re-encode the videos and rebuild.`);

  const factsHtml = [
    facts.pr ? {term: 'PR', html: `<a href="${facts.pr.url}" rel="noopener">#${facts.pr.number}</a>`} : {term: 'PR', html: '<span class="muted">not opened yet</span>'},
    {term: 'Branch', html: `<code>${escapeHtml(facts.branch)}</code>`},
    {term: 'Commits', html: `${facts.commits.length} ${facts.merged ? 'in the PR' : 'on the branch'}`},
    facts.merged ? {term: 'Merged', html: `main at <code>${facts.merged.commit.slice(0, 7)}</code> · ${facts.merged.at.slice(0, 10)}`} : {term: 'Merged', html: '<span class="muted">branch open</span>'},
    {term: 'Report built', html: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'},
  ];
  const commitsHtml = `<ol>${facts.commits.map(commit => `<li><code>${commit.short}</code> ${inlineMarkdown(commit.subject)} <span class="muted">${commit.at.slice(0, 10)}</span></li>`).join('')}</ol>`
    + (facts.merged ? `<p class="muted">Merged as <code>${facts.merged.commit.slice(0, 7)}</code>: ${escapeHtml(facts.merged.subject)}</p>`
      : '<p class="muted">The branch was still open when this page was built; the commit that adds the page is not listed in it.</p>');
  const askHtml = `<div class="quoted">${mdHtml(goal)}</div>`
    + (outOfScope ? `<h3>Out of scope</h3><div class="quoted">${mdHtml(outOfScope)}</div>` : '');
  const page = pageHtml({
    title: `${id} · ${title}`,
    lead: overrides.lead ?? 'What was asked, what happened, and the evidence — one page per task.',
    facts: factsHtml,
    sections: [
      {id: 'ask', title: 'The ask', html: askHtml},
      {id: 'conditions', title: 'Success conditions', html: `<div class="quoted">${mdHtml(conditions)}</div>`},
      {id: 'outcome', title: 'Outcome', html: mdHtml(outcome)},
      {id: 'commits', title: 'Commits', html: commitsHtml},
      {id: 'findings', title: 'Findings', html: mdHtml(findings)},
      {id: 'evidence', title: 'Evidence', html: (dirs.length ? `<p class="muted">Media below comes from ${dirs.map(dir => `<code>${escapeHtml(dir)}</code>`).join(', ')}.</p>` : '') + evidence.html},
    ],
    footer: `Built by <code>scripts/build-task-report.mjs</code> · static page: inline CSS, no JavaScript, no external requests · media committed under <code>reports/${id}/media/</code> (${fmtBytes(evidence.mediaBytes)} of the ${fmtBytes(MEDIA_BUDGET_BYTES)} report share; 25 MiB per task across report and dry-run evidence).`,
  });
  assertClean(page, `reports/${id}/index.html`);
  await writeFile(join(reportDir, 'index.html'), page, {mode: 0o644});
  console.log(`reports/${id}/index.html: ${(page.length / 1024 / 1024).toFixed(1)} MiB page, ${evidence.videos} videos, ${evidence.shots} screenshots, ${fmtBytes(evidence.mediaBytes)} media`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(error.message); process.exit(1);});
}
