#!/usr/bin/env node
// Point private dev or staging at an image and wait until it runs. Run where the `cvm` client is
// installed. Only the app service's image changes; volumes, chain, secrets and other services stay.
// Usage: node scripts/deploy-hosted.mjs dev|staging ghcr.io/OWNER/IMAGE@sha256:DIGEST
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const APP_SERVICE = 'private-anvil-app';
const [target, image] = process.argv.slice(2);
if (!['dev', 'staging'].includes(target) || !/^[\w./-]+@sha256:[a-f0-9]{64}$/.test(image ?? '')) {
  throw new Error('Usage: deploy-hosted.mjs dev|staging IMAGE@sha256:DIGEST');
}
const cvm = (...args) => execFileSync('cvm', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']});
const compose = JSON.parse(cvm('hosted-compose', target));
const app = compose.services?.[APP_SERVICE];
if (!app) throw new Error(`No ${APP_SERVICE} service in the ${target} compose`);
if (app.image === image) { console.log(`${target} already runs ${image}`); process.exit(0); }
console.log(`${target}: ${app.image} -> ${image}`);
app.image = image;
const dir = await mkdtemp(join(tmpdir(), 'thot-deploy-'));
try {
  await writeFile(join(dir, 'compose.json'), JSON.stringify(compose));
  execFileSync('cvm', ['deploy', target, join(dir, 'compose.json')], {stdio: 'inherit'});
} finally { await rm(dir, {recursive: true, force: true}); }
for (const started = Date.now(); Date.now() - started < 20 * 60_000;) {
  const status = JSON.parse(cvm('hosted', target));
  if (status.status === 'running' && !status.in_progress && Object.values(status.images ?? {}).includes(image)) {
    console.log(`${target} running ${image} (compose ${status.compose_hash}). Load the site through its gate to confirm.`);
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 15_000));
}
throw new Error(`${target} did not reach running with ${image} within 20 minutes; see cvm hosted ${target}`);
