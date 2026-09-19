import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicLaunchConfig, readPublicMarketProof, type LaunchConfiguration } from '../apps/api/public-site.ts';
import { publicSiteConfig, reviewerOrigin, workspaceUrl } from '../apps/site/server.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = join(repoRoot, 'apps/site');
const fixedTime = new Date('2020-01-01T00:00:00Z');

// Deliberately no directory copy: adding source/config files to apps/site cannot publish them.
export const publicFiles: Readonly<Record<string, string>> = Object.freeze({
  'index.html': 'index.html',
  'read.html': 'article.html',
  'tutorial.html': 'tutorial.html',
  'whitepaper.html': 'whitepaper.html',
  'mechanism.html': 'mechanism.html',
  'affiliates.html': 'affiliates.html',
  'app.html': 'access.html',
  'site.css': 'site.css',
  'reading.css': 'reading.css',
  'referrals.css': 'referrals.css',
  'referrals.js': 'referrals.js',
  'site.js': 'site.js',
  'access.js': 'access.js',
  'assets/thot-logo.png': 'assets/thot-logo.png',
  'assets/source-mercor-training.png': 'assets/source-mercor-training.png',
  'assets/source-shou-router.png': 'assets/source-shou-router.png',
  'assets/source-dylan-router.png': 'assets/source-dylan-router.png',
  'assets/source-aidan-data.png': 'assets/source-aidan-data.png',
  'assets/robinhood-trade-proof-flow.svg': 'assets/robinhood-trade-proof-flow.svg',
  'assets/thot-feast.jpg': 'assets/thot-feast.jpg',
  'assets/thot-research-iceberg.webp': 'assets/thot-research-iceberg.webp',
  'assets/thot-human-capital.webp': 'assets/thot-human-capital.webp',
  'assets/thot-cold-start.webp': 'assets/thot-cold-start.webp',
  'assets/fonts/bricolage-grotesque-latin.woff2': 'assets/fonts/bricolage-grotesque-latin.woff2',
  'assets/fonts/dm-sans-latin.woff2': 'assets/fonts/dm-sans-latin.woff2',
  'assets/fonts/bricolage-grotesque-latin-OFL.txt': 'assets/fonts/bricolage-grotesque-latin-OFL.txt',
  'assets/fonts/dm-sans-latin-OFL.txt': 'assets/fonts/dm-sans-latin-OFL.txt',
});

export const redirects = `# Exact same-origin proxy routes; no catch-all or private app forwarding.
/read/ /read 301
/tutorial/ /tutorial 301
/whitepaper/ /whitepaper 301
/mechanism/ /mechanism 301
/affiliates/ /affiliates 301
/app/ /app 301
/favicon.png /assets/thot-logo.png 200
/healthz /healthz.json 200
/v1/public/launch-config /v1/public/launch-config.json 200
/v1/public/site-config /v1/public/site-config.json 200
/v1/public/market-proof /v1/public/market-proof.json 200
`;

export const headers = `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
  Cache-Control: no-store
  ! Access-Control-Allow-Origin

/v1/public/*
  Content-Type: application/json; charset=utf-8

/healthz
  Content-Type: application/json; charset=utf-8

/app
  X-Robots-Tag: noindex

/app/*
  X-Robots-Tag: noindex
`;

const notFound = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found — thot market</title><link rel="icon" href="/assets/thot-logo.png"><link rel="stylesheet" href="/site.css"></head>
<body><main class="hero section-space wrap"><p class="hero-intro">404</p><h1>Nothing here.</h1><p class="hero-description">This page does not exist.</p><div class="hero-actions"><a class="button" href="/">Back to thot market</a></div></main></body></html>
`;

export function assertPublicText(name: string, data: Buffer) {
  if (!/\.(?:html|css|js|json|txt)$/.test(name)) return;
  const text = data.toString('utf8');
  if (/\/Users\/|file:\/\/|(?:^|[\s"'(])\/home\/|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|sourceMappingURL/i.test(text)) throw Error('PRIVATE_SOURCE_MARKER_IN_PUBLIC_ASSET: ' + name);
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error('SYMLINK_IN_UPLOAD_DIRECTORY');
    if (entry.isDirectory()) output.push(...await listFiles(join(dir, entry.name), name + '/'));
    else if (entry.isFile()) output.push(name);
    else throw Error('NONREGULAR_UPLOAD_FILE');
  }
  return output.sort();
}

export async function buildCloudflarePages(options: { outputParent?: string; reviewerUrl?: string; appUrl?: string; migration?: boolean; launch?: LaunchConfiguration; zip?: boolean } = {}) {
  if (options.migration && (options.appUrl !== undefined || options.reviewerUrl !== undefined)) throw Error('MIGRATION_WORKSPACE_URL_CONFLICT');
  const reviewer = reviewerOrigin(options.reviewerUrl);
  if (options.reviewerUrl !== undefined && !reviewer) throw Error('INVALID_REVIEWER_ORIGIN');
  if (options.appUrl !== undefined && !workspaceUrl(options.appUrl)) throw Error('INVALID_WORKSPACE_URL');
  const accessConfig = options.migration
    ? { appUrl: null, reviewerUrl: null, access: 'migration', privateAppHosted: false }
    : publicSiteConfig(options);
  const launch = publicLaunchConfig(options.launch);
  if (options.launch?.state === 'launched' && launch.state !== 'launched') throw Error('INCOMPLETE_LAUNCH_CONFIGURATION');
  const files = new Map<string, Buffer>();
  for (const [target, source] of Object.entries(publicFiles)) {
    const path = join(siteRoot, source);
    if (!(await lstat(path)).isFile()) throw Error('PUBLIC_SOURCE_MUST_BE_REGULAR_FILE');
    files.set(target, await readFile(path));
  }
  if (options.migration) {
    const page = files.get('app.html')!.toString('utf8');
    const workspace = '<section id="access-workspace" class="hero section-space wrap">';
    const migration = '<section id="access-migration" class="hero section-space wrap" hidden>';
    if (!page.includes(workspace) || !page.includes(migration)) throw Error('MIGRATION_ACCESS_TEMPLATE_MISSING');
    files.set('app.html', Buffer.from(page.replace(workspace, workspace.replace('>', ' hidden>')).replace(migration, migration.replace(' hidden', ''))));
  }
  files.set('_redirects', Buffer.from(redirects));
  files.set('_headers', Buffer.from(headers));
  files.set('404.html', Buffer.from(notFound));
  files.set('healthz.json', Buffer.from(JSON.stringify({ status: 'ok', service: 'thot-public-site', privateAppHosted: false }) + '\n'));
  files.set('v1/public/launch-config.json', Buffer.from(JSON.stringify(launch) + '\n'));
  files.set('v1/public/site-config.json', Buffer.from(JSON.stringify(accessConfig) + '\n'));
  files.set('v1/public/market-proof.json', Buffer.from(JSON.stringify(await readPublicMarketProof(options.appUrl)) + '\n'));
  if (files.size > 1000) throw Error('PAGES_DASHBOARD_FILE_LIMIT');
  for (const [name, bytes] of files) {
    if (bytes.length > 25 * 1024 * 1024) throw Error('PAGES_DASHBOARD_ASSET_TOO_LARGE: ' + name);
    assertPublicText(name, bytes);
  }
  const parent = resolve(options.outputParent ?? join(repoRoot, 'work/cloudflare-pages'));
  const directory = join(parent, 'thot-market');
  await mkdir(directory, { recursive: true });
  // Fail closed if a prior output directory has unexpected additions. Never zip or delete them.
  for (const name of await listFiles(directory)) if (!files.has(name)) throw Error('UNEXPECTED_UPLOAD_FILE: ' + name);
  for (const [name, bytes] of files) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o644 });
    await chmod(path, 0o644);
    await utimes(path, fixedTime, fixedTime);
  }
  const names = [...files.keys()].sort();
  const entries = names.map(name => ({ name, bytes: files.get(name)!.length, sha256: createHash('sha256').update(files.get(name)!).digest('hex') }));
  const manifest = { files: entries, totalBytes: entries.reduce((sum, file) => sum + file.bytes, 0), launchState: launch.state, reviewerAccess: accessConfig.access === 'invited-reviewers', walletAccess: accessConfig.access === 'wallet', workspaceMigration: accessConfig.access === 'migration', privateAppHosted: false };
  await writeFile(join(parent, 'thot-market.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  let archive: string | undefined;
  if (options.zip !== false) {
    archive = join(parent, 'thot-market.zip');
    await rm(archive, { force: true });
    // -X removes extra UID/GID and OS metadata; fixed timestamps and explicit paths
    // prevent local provenance, a parent directory, or macOS resource files entering the ZIP.
    execFileSync('zip', ['-X', '-q', archive, ...names], { cwd: directory, stdio: 'pipe' });
  }
  return { directory, archive, manifest, zipBytes: archive ? (await stat(archive)).size : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--migration') && !(args.length === 2 && ['--reviewer-url', '--app-url'].includes(args[0]!))) throw Error('Usage: node scripts/build-cloudflare-pages.ts [--migration | --app-url https://workspace-origin/app | --reviewer-url https://reviewer-origin]');
  const result = await buildCloudflarePages(args[0] === '--migration' ? { migration: true } : args[0] === '--app-url' ? { appUrl: args[1] } : { reviewerUrl: args[1] });
  process.stdout.write(JSON.stringify({ directory: result.directory, archive: result.archive, files: result.manifest.files.length, zipBytes: result.zipBytes, launchState: result.manifest.launchState, reviewerAccess: result.manifest.reviewerAccess, walletAccess: result.manifest.walletAccess, workspaceMigration: result.manifest.workspaceMigration }) + '\n');
}
