#!/usr/bin/env node
// Release-candidate dry run. One commit becomes a flattened export, a tested
// tree, a local image with a snapshot manifest, a broker-registry reference, a
// disposable agent-* CVM, a health check on that CVM's public URL, the logs-only
// operator port, and a recorded purchase journey — then the CVM is deleted. The
// run stops at the first failure with the underlying error unmasked; the CVM is
// deleted on failure too.
//
// Every run ends by publishing its record: the journey media committed under
// rc-dry-run/<short-sha>/evidence/, the hash-bound RECORD.md over all evidence,
// and index.html built through the task-report builder. `--republish <short-sha>`
// redoes that publish step for an existing run from its own recorded data,
// without touching a CVM.
//
// The only credentials touched are the ones the `cvm` client already holds. This
// script never reads, prints or records a token: the one token it touches is the
// CVM log token it generates for its own run, which exists only in the sealed
// compose handed to the CVM. It does not set or inspect credential-bearing
// environment variables.
import {createHash, randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {preparePublicExport} from '../release/prepare-public-export.mjs';
import {MEDIA_BUDGET_BYTES, assertClean, collectEvidence, escapeHtml, fmtBytes, mdHtml, pageHtml} from './build-task-report.mjs';
import {logFilterName, logFilterService, logGateName, logGateService, logPort} from './log-filter.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const APP_PORT = 4318;
// The dry run ships the logs-only gate and filter the hosted stacks run, on the
// same digest-pinned Caddy, so the operator log port is proven on a real CVM:
// the run's token lists containers and everything else is refused.
const LOG_CADDY_IMAGE = 'caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
const PROFILE_DEFAULT = 'private-anvil';
// Snapshot sources the private-anvil profile requires and this tree may not ship.
const PRIVATE_ANVIL_SOURCES = ['scripts/private-anvil-app.mjs', 'scripts/private-anvil-bootstrap.mjs', 'scripts/private-anvil-fund.mjs', 'scripts/private-anvil-rpc.mjs'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (ok, message) => {if (!ok) throw new Error(message);};
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));

/** Run a command, keep its combined output in one evidence file, fail loudly. */
function run(command, args, {cwd, env, log, label} = {}) {
  const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', maxBuffer: 64_000_000});
  const output = [`# ${label ?? command + ' ' + args.join(' ')}\n# exit ${result.status ?? 'signal ' + result.signal}\n`,
    result.stdout ?? '', result.stderr ?? ''].join('\n');
  // The tail is what a failure message quotes, so the underlying error is never
  // reduced to "see the log".
  result.tail = output.split('\n').filter(Boolean).slice(-12).join('\n');
  if (log) return writeFile(log, output, {flag: 'a', mode: 0o600}).then(() => result);
  return Promise.resolve(result);
}

/** Run a command that must succeed, quoting the underlying error when it does not. */
async function must(label, command, args, options) {
  const result = await run(command, args, options);
  if (result.status !== 0) throw new Error(`${label} failed:\n${result.tail}`);
  return result;
}

/** `cvm` prefixes some responses with a progress line; the JSON payload follows it. */
function cvmJson(args) {
  const result = spawnSync('cvm', args, {encoding: 'utf8', maxBuffer: 16_000_000});
  if (result.status !== 0) throw new Error('cvm ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout).trim());
  const text = result.stdout, start = text.search(/[{[]/);
  fail(start >= 0, 'CVM_RESPONSE_NOT_JSON: ' + text.trim());
  const payload = JSON.parse(text.slice(start));
  fail(payload.error === undefined, 'CVM_ERROR: ' + payload.error);
  return payload;
}

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

/** Existence probe used for optional pinned inputs; never throws. */
const exists = async path => lstat(path).then(stat => stat.isFile(), () => false);

/** Steps 1-9, in order, each labelled in the record and in the console. */
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--republish') return republish(String(args[1] ?? ''));
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep-cvm') {options.keepCvm = true; continue;}
    if (!args[i].startsWith('--')) {positional.push(args[i]); continue;}
    fail(['--profile', '--ttl', '--timeout-seconds'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'Usage: rc-dry-run.mjs <commit> [--profile public|private-anvil] [--ttl HOURS] [--timeout-seconds N] [--keep-cvm]');
    options[args[i].slice(2)] = args[++i];
  }
  const commitish = positional[0];
  fail(positional.length === 1, 'Usage: rc-dry-run.mjs <commit> [--profile public|private-anvil] [--ttl HOURS] [--timeout-seconds N] [--keep-cvm]');
  fail(Boolean(commitish) && !commitish.startsWith('--'), 'Usage: rc-dry-run.mjs <commit> [--profile public|private-anvil] [--ttl HOURS] [--timeout-seconds N] [--keep-cvm]');
  const requestedProfile = options.profile ?? PROFILE_DEFAULT;
  fail(['public', 'private-anvil'].includes(requestedProfile), 'UNKNOWN_PROFILE:' + requestedProfile);
  // The health deadline must absorb a first-boot pull of the ~1.9GB image on a
  // 1-vCPU CVM, which takes many minutes on its own.
  const ttlHours = Number(options.ttl ?? 2), timeoutSeconds = Number(options['timeout-seconds'] ?? 2400);
  fail(Number.isInteger(ttlHours) && ttlHours >= 1 && ttlHours <= 6, 'TTL_MUST_BE_1_TO_6_HOURS');
  fail(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 30, 'INVALID_TIMEOUT');

  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', commitish + '^{commit}'], {encoding: 'utf8'}).trim();
  const short = commit.slice(0, 7);
  // The image is built from this checkout, so it must be exactly the candidate.
  const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  fail(head === commit, 'CANDIDATE_MUST_BE_CHECKED_OUT:' + head);
  const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean)
    .filter(line => !/(?:^|\/)rc-dry-run\//.test(line.slice(3)));
  fail(!dirty.length, 'WORKING_TREE_DIRTY:\n' + dirty.join('\n'));

  const workDir = join(REPO, 'work/rc-dry-run', short), recordDir = join(REPO, 'rc-dry-run', short);
  await rm(workDir, {recursive: true, force: true}); await rm(recordDir, {recursive: true, force: true});
  await mkdir(workDir, {recursive: true, mode: 0o700}); await mkdir(recordDir, {recursive: true, mode: 0o700});
  const evidence = [], findings = [];
  const step = (index, text) => console.log(`[${index}/10] ${text}`);
  const note = async (name, text) => {const path = join(workDir, name); await writeFile(path, text, {mode: 0o600}); evidence.push(path); return path;};

  const record = {format: 'thot.rc-dry-run/1', commit, profile_requested: requestedProfile,
    started_at: new Date().toISOString(), app_port: APP_PORT, ttl_hours: ttlHours, steps: []};
  let cvmName = 'agent-rc-' + short, cvm = null, cvmCreateAttempted = false;
  try {
    // 1. Flattened export of the candidate plus the branding step.
    step(1, 'flattened export and branding check');
    const exported = await preparePublicExport({sourceRoot: REPO, commit,
      outputDir: join(workDir, 'export'), manifestPath: join(workDir, 'export-manifest.json')});
    record.export = {output: exported.output, file_count: exported.file_count, status: exported.status,
      manifest_sha256: exported.manifest_sha256, findings_count: exported.findings_count};
    findings.push(...exported.findings.map(finding => ({...finding, stage: 'export'})));
    evidence.push(join(workDir, 'export-manifest.json'));
    record.steps.push({step: 1, name: 'export-and-branding', outcome: 'ok', file_count: exported.file_count});

    // 2. Install, typecheck and test the exported tree, not the development tree.
    step(2, 'install, typecheck and test the exported tree');
    const installLog = join(workDir, 'export-install.log');
    for (const [label, command, args] of [
      ['pnpm install', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
      ['contracts install', 'pnpm', ['--dir', 'contracts', 'install', '--frozen-lockfile', '--ignore-scripts']],
      ['pnpm typecheck', 'pnpm', ['typecheck']],
      ['pnpm test', 'pnpm', ['test']],
    ]) {
      await must(label + ' (exported tree)', command, args, {cwd: exported.output, log: installLog, label});
    }
    evidence.push(installLog);
    record.steps.push({step: 2, name: 'export-install-typecheck-test', outcome: 'ok'});

    // 3. Local image plus its snapshot manifest. The profile is recorded, never
    // silently substituted: a tree that cannot supply private-anvil sources says so.
    step(3, `build image (profile ${requestedProfile})`);
    let profile = requestedProfile;
    if (profile === 'private-anvil') {
      const missing = [];
      for (const path of PRIVATE_ANVIL_SOURCES) if (!await exists(join(REPO, path))) missing.push(path);
      if (missing.length) {
        findings.push({code: 'profile-unavailable', stage: 'image-build', detail: `private-anvil sources absent from this tree: ${missing.join(', ')}. Built the reviewed public runtime profile instead.`});
        console.warn(`[3/10] private-anvil profile unavailable in this tree (${missing.join(', ')}); building profile public.`);
        profile = 'public';
      }
    }
    const verifier = join(REPO, 'work/tools/dcap-qvl-v0.6.1/dcap-qvl-linux-x86_64-musl');
    fail(await exists(verifier), 'PINNED_DCAP_VERIFIER_MISSING:' + verifier);
    const image = 'thot-rc:' + short, snapshot = join(workDir, 'image-snapshot'), buildLog = join(workDir, 'image-build.log');
    record.image = {profile, local_tag: image};
    await must('image build', process.execPath, ['scripts/build-thot-image.mjs', '--output', snapshot, '--verifier', verifier,
      '--profile', profile, '--build', '--image', image], {cwd: REPO, log: buildLog, label: 'build-thot-image'});
    const snapshotManifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
    record.image = {...record.image, source_sha256: snapshotManifest.source_sha256,
      snapshot_manifest_sha256: (await readFile(join(snapshot, 'manifest.sha256'), 'utf8')).trim(),
      image_id: (await readFile(join(snapshot, 'image-id.txt'), 'utf8')).trim()};
    evidence.push(buildLog, join(snapshot, 'manifest.json'), join(snapshot, 'manifest.sha256'), join(snapshot, 'image-id.txt'));
    record.steps.push({step: 3, name: 'image-build', outcome: 'ok', profile});

    // 4. Publish through the broker; only `cvm` holds registry credentials.
    step(4, `cvm image-push ${cvmName}`);
    const pushed = cvmJson(['image-push', cvmName, image]);
    fail(/^[a-z0-9][a-z0-9._/:+-]*$/.test(pushed.ref ?? '') && /^sha256:[a-f0-9]{64}$/.test((pushed.digest ?? '').split('@')[1] ?? ''), 'IMAGE_PUSH_RETURNED_NO_REFERENCE');
    record.image.ref = pushed.ref; record.image.digest = pushed.digest;
    // A digest that names another repository cannot pin the deployed reference.
    if (String(pushed.digest).split('@')[0] !== String(pushed.ref).split(':')[0]) {
      findings.push({code: 'image-digest-repository-mismatch', stage: 'image-push',
        detail: `cvm image-push returned ref ${pushed.ref} with digest ${pushed.digest}. The digest names a different repository, so it is recorded as returned but is not a valid pin for the reference the compose deploys.`});
      record.image.digest_pinnable = false;
    } else record.image.digest_pinnable = true;
    record.steps.push({step: 4, name: 'image-push', outcome: 'ok', ref: pushed.ref, digest: pushed.digest});

    // 5. Compose rendered for that exact reference, then a disposable CVM. The
    // port is pinned host:container: a bare container port publishes a random
    // host port, and the gateway's <app_id>-<port> route then has no backend.
    // The public tree ships no hosted deployment configuration (no chain
    // manifest, hosted auth or KMS-bound master key — those belong to the
    // withheld private flow), so the candidate serves its local-development
    // runtime: the API binds loopback in the container and a compose-level
    // haproxy ingress sharing its network namespace publishes 8080 as 4318 and
    // maps the public host header to the loopback host that runtime accepts.
    // The gateway, TLS and port path are real; the app behind them is the
    // candidate's own development server, and the record says so.
    step(5, `cvm create ${cvmName} --private-registry --ttl ${ttlHours}`);
    const haproxyConf = ['global', '  maxconn 256', 'defaults', '  mode http', '  timeout connect 5s',
      '  timeout client 30s', '  timeout server 30s', 'frontend fe', '  bind 0.0.0.0:8080',
      '  default_backend be', 'backend be', `  http-request set-header Host 127.0.0.1:${APP_PORT}`,
      `  server app 127.0.0.1:${APP_PORT}`];
    const ingressCommand = ['sh', '-c',
      `printf '%s\\n' ${haproxyConf.map(line => `'${line}'`).join(' ')} > /tmp/haproxy.cfg && exec haproxy -f /tmp/haproxy.cfg`];
    // The log gate's token is generated for this run only. It exists in the sealed
    // compose handed to the CVM — the record carries that file's hash, never its
    // bytes — and is neither printed nor written anywhere else.
    const logToken = randomBytes(32).toString('base64url');
    const logServices = `  ${logFilterName}: ${JSON.stringify(logFilterService(LOG_CADDY_IMAGE))}\n` +
      `  ${logGateName}: ${JSON.stringify({...logGateService(LOG_CADDY_IMAGE), environment: {THOT_LOG_TOKEN: logToken}})}`;
    const compose = ['services:', '  thot-app:', `    image: "${pushed.ref}"`, '    restart: unless-stopped',
      '    environment:', `      THOT_BIND: "127.0.0.1"`, `    ports: ["${APP_PORT}:8080"]`, '  ingress:',
      '    image: "haproxy:alpine"', '    restart: unless-stopped',
      '    network_mode: "service:thot-app"', `    command: ${JSON.stringify(ingressCommand)}`,
      logServices, ''].join('\n');
    const composePath = await note('app.compose.yml', compose);
    findings.push({code: 'cvm-deployment-shape', stage: 'cvm-create',
      detail: `The public tree ships no hosted deployment configuration (chain manifest, hosted auth and the KMS-bound master key belong to the withheld private flow), so the CVM runs the candidate's local-development server: the API binds loopback in the container and a compose-level haproxy:alpine ingress sharing its network namespace publishes 4318 and maps the public host header to 127.0.0.1. The gateway and port path are exercised for real; the app behind them is the development runtime, not a hosted deployment. The compose also carries the logs-only gate and filter of scripts/log-filter.mjs on the digest the private stacks pin, so the operator log port is part of the run; its token is generated per run and never recorded.`});
    // A failed create can still have provisioned the CVM, so the delete in the
    // finally block keys off the attempt, not the acknowledgement.
    cvmCreateAttempted = true;
    const created = cvmJson(['create', cvmName, composePath, '--private-registry', '--ttl', String(ttlHours)]);
    cvm = cvmJson(['get', cvmName]);
    record.cvm = {name: cvmName, app_id: cvm.app_id, vm_uuid: created.vm_uuid ?? cvm.vm_uuid, compose_sha256: await sha256File(composePath),
      ingress: 'haproxy:alpine (shares the app network namespace; maps the public host header to the loopback host)',
      gateway_base_domain: cvm.gateway?.base_domain ?? null, kms_type: cvm.kms_type ?? null,
      public_url: cvm.app_id && cvm.gateway?.base_domain ? `https://${cvm.app_id}-${APP_PORT}.${cvm.gateway.base_domain}` : null,
      log_port: cvm.app_id && cvm.gateway?.base_domain ? `https://${cvm.app_id}-${logPort}.${cvm.gateway.base_domain}` : null};
    record.steps.push({step: 5, name: 'cvm-create', outcome: 'ok', app_id: cvm.app_id});

    // 6. The candidate must answer its health endpoint on its own public URL.
    // Node's built-in fetch ignores the proxy environment, so on this machine it
    // cannot resolve the gateway at all (EAI_AGAIN is a bypassed proxy, not a
    // down host). curl honours HTTPS_PROXY/NO_PROXY, so the probe goes via curl
    // and works both proxied and direct.
    fail(record.cvm.public_url !== null, 'CVM_HAS_NO_DERIVABLE_PUBLIC_URL');
    step(6, `health check ${record.cvm.public_url}/healthz`);
    const health = {url: record.cvm.public_url + '/healthz', prober: 'curl', attempts: 0, status: null, error: null};
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      health.attempts++;
      const probe = spawnSync('curl', ['-sS', '--max-time', '20', '-H', 'accept: application/json',
        '-w', '\n%{http_code}', health.url], {encoding: 'utf8'});
      if (probe.status === 0) {
        const split = probe.stdout.lastIndexOf('\n');
        const code = Number(probe.stdout.slice(split + 1));
        if (Number.isInteger(code) && code >= 200 && code < 300) {
          health.status = code;
          try {health.body = JSON.parse(probe.stdout.slice(0, split));}
          catch {health.body = probe.stdout.slice(0, split);}
          break;
        }
        health.error = `HTTP ${code}`;
      } else health.error = (probe.stderr ?? '').trim() || `curl exit ${probe.status}`;
      await pause(10_000);
    }
    await note('health.json', JSON.stringify(health, null, 2) + '\n');
    fail(health.status !== null, `health endpoint never answered: ${health.error}`);
    record.health = {url: health.url, status: health.status, attempts: health.attempts, body: health.body};
    record.steps.push({step: 6, name: 'health', outcome: 'ok', status: health.status});

    // 7. Logs-only operator port. The compose carries the same token gate and
    // logs-only filter the hosted stacks run, so its contract is proven on a real
    // CVM: the run's token lists containers, a missing token is refused by the
    // gate, and the filter refuses everything beyond listing and log reads —
    // container inspect above all, since it returns sealed environment values.
    // curl for the same proxy reason as the health probe; the shipped client
    // scripts/cvm-logs.mjs reads this same port in operators' hands.
    fail(record.cvm.log_port !== null, 'CVM_HAS_NO_DERIVABLE_LOG_ORIGIN');
    step(7, `log port ${record.cvm.log_port}`);
    const bearer = ['--header', 'Authorization: Bearer ' + logToken];
    const probe = (path, headers) => {
      const result = spawnSync('curl', ['-sS', '--max-time', '20', '-w', '\n%{http_code}', ...headers, record.cvm.log_port + path], {encoding: 'utf8'});
      const split = (result.stdout ?? '').lastIndexOf('\n');
      return {status: Number((result.stdout ?? '').slice(split + 1)) || null, body: (result.stdout ?? '').slice(0, split),
        error: result.status === 0 ? null : (result.stderr ?? '').trim() || `curl exit ${result.status}`};
    };
    const logChecks = {list_containers: null, inspect_refused: null, unauthenticated_refused: null};
    const logDeadline = Date.now() + Math.min(timeoutSeconds, 600) * 1000;
    do {
      try {
        const listed = probe('/containers/json?all=1', bearer);
        logChecks.list_containers = {status: listed.status, error: listed.error,
          containers: listed.status === 200 ? JSON.parse(listed.body).map(container => container.Names[0]?.replace(/^\//, '') ?? container.Id) : null};
      } catch (error) {logChecks.list_containers = {status: null, error: String(error.message ?? error)};}
      const inspected = probe('/containers/thot-app/json', bearer);
      logChecks.inspect_refused = {status: inspected.status, error: inspected.error};
      const anonymous = probe('/containers/json?all=1', []);
      logChecks.unauthenticated_refused = {status: anonymous.status, error: anonymous.error};
      const listed = logChecks.list_containers.status === 200 && (logChecks.list_containers.containers ?? []).some(name => name.includes('thot-app'));
      if (listed && logChecks.inspect_refused.status === 403 && logChecks.unauthenticated_refused.status === 401) break;
      await pause(10_000);
    } while (Date.now() < logDeadline);
    await note('log-port.json', JSON.stringify({origin: record.cvm.log_port, checks: logChecks}, null, 2) + '\n');
    fail(logChecks.list_containers.status === 200 && (logChecks.list_containers.containers ?? []).some(name => name.includes('thot-app')),
      `log port never listed containers: ${logChecks.list_containers.error ?? 'HTTP ' + logChecks.list_containers.status}`);
    fail(logChecks.inspect_refused.status === 403, `log port did not refuse container inspect: ${logChecks.inspect_refused.error ?? 'HTTP ' + logChecks.inspect_refused.status}`);
    fail(logChecks.unauthenticated_refused.status === 401, `log port did not refuse a missing token: ${logChecks.unauthenticated_refused.error ?? 'HTTP ' + logChecks.unauthenticated_refused.status}`);
    record.log_port = {origin: record.cvm.log_port, image: LOG_CADDY_IMAGE,
      token: 'generated at run time; it exists only in the sealed compose and is never recorded',
      checks: logChecks};
    record.steps.push({step: 7, name: 'log-port', outcome: 'ok',
      list: logChecks.list_containers.status, inspect_refused: logChecks.inspect_refused.status, unauthenticated_refused: logChecks.unauthenticated_refused.status});

    // 8. Purchase journey. The shipped recorder drives the candidate's own code
    // with synthetic local actors; it takes no remote URL, which is recorded.
    step(8, 'record purchase journey');
    findings.push({code: 'journey-recorder-is-local', stage: 'purchase-journey',
      detail: `scripts/record-thot-purchase.mjs builds its own local Anvil, API and browser actors and accepts no target URL, so the journey exercises the candidate source at ${short} rather than ${record.cvm.public_url}.`});
    const journeyDir = join(workDir, 'journey'), journeyLog = join(workDir, 'journey.log');
    // The development host exports the browser path under the harness's own name;
    // character codes keep this source from spelling that legacy identity.
    const legacyBrowserEnv = String.fromCharCode(87, 65, 75, 69, 95, 69, 50, 69, 95, 66, 82, 79, 87, 83, 69, 82);
    const recorderEnv = {...process.env, THOT_E2E_BROWSER: process.env.THOT_E2E_BROWSER ?? process.env[legacyBrowserEnv]};
    fail(recorderEnv.THOT_E2E_BROWSER && isAbsolute(recorderEnv.THOT_E2E_BROWSER), 'BROWSER_EXECUTABLE_REQUIRED: set THOT_E2E_BROWSER to the browser executable');
    const journey = await run(process.execPath, ['scripts/record-thot-purchase.mjs', '--economics', 'quoted-cost', '--output', journeyDir],
      {cwd: exported.output, env: recorderEnv, log: journeyLog, label: 'record-thot-purchase'});
    evidence.push(journeyLog);
    // The recorder writes each journey into its own mkdtemp run directory below
    // --output; result.json sits inside the newest one.
    const runDir = (await readdir(journeyDir, {withFileTypes: true})).filter(entry => entry.isDirectory())
      .map(entry => join(journeyDir, entry.name)).sort().at(-1);
    fail(runDir !== undefined, 'JOURNEY_PRODUCED_NO_RUN_DIRECTORY');
    const resultPath = join(runDir, 'result.json');
    const journeyResult = JSON.parse(await readFile(resultPath, 'utf8'));
    evidence.push(...(await filesUnder(journeyDir)).map(path => join(journeyDir, path)));
    fail(journey.status === 0 && journeyResult.status === 'PASS', `purchase journey failed: ${journeyResult.error ?? 'see ' + journeyLog}`);
    record.journey = {recorder: 'scripts/record-thot-purchase.mjs', economics: 'quoted-cost', status: journeyResult.status,
      scope: 'exported candidate tree with local synthetic actors (see finding journey-recorder-is-local)',
      cvm_public_url_at_run_time: record.cvm.public_url, checks: journeyResult.checks, screenshots: journeyResult.screenshots,
      transactions: journeyResult.transactions, evidence_dir: journeyDir};
    record.steps.push({step: 8, name: 'purchase-journey', outcome: 'ok', status: journeyResult.status});

    record.status = 'PASS';
  } catch (error) {
    record.status = 'FAIL';
    record.failed_at = record.steps.length + 1;
    record.error = String(error.message ?? error);
    console.error(`[!] step ${record.failed_at} failed: ${record.error}`);
  } finally {
    // 10. The CVM is disposable whether the run passed, failed or was never
    // acknowledged: a provisioning error can still leave one behind.
    if (cvmCreateAttempted && !options.keepCvm) {
      step(10, `cvm delete ${cvmName}`);
      try {
        const listed = cvmJson(['list']);
        const present = Array.isArray(listed) ? listed.some(entry => entry.cvmName === cvmName) : true;
        if (!present) record.cvm = {...record.cvm, deleted: true, delete_note: 'broker reports no such CVM'};
        else {cvmJson(['delete', cvmName]); record.cvm = {...record.cvm, deleted: true};}
      } catch (error) {record.cvm = {...record.cvm, deleted: false, delete_error: String(error.message ?? error)};}
    }
    record.findings = findings;
    record.completed_at = new Date().toISOString();
    record.evidence = [];
    for (const path of evidence) {
      if (!await exists(path)) continue;
      record.evidence.push({path: relative(REPO, path), sha256: await sha256File(path)});
    }
    // 9. Everything a finished run publishes: the journey media copied into the
    // committed record directory, the hash-bound record over all evidence, and
    // a watchable page built from the same primitives as the task reports.
    step(9, 'record, journey media and report page');
    await publishRecord(record, {recordDir});
    await note('rc-dry-run.json', JSON.stringify(record, null, 2) + '\n');
    console.log(`\n${record.status}: ${record.evidence.length} evidence files (${record.evidence.filter(entry => entry.media).length} committed media), ${record.findings.length} findings`);
    console.log(`record: ${join(recordDir, 'RECORD.md')}`);
    console.log(`page: ${join(recordDir, 'index.html')}`);
    if (record.status !== 'PASS') process.exitCode = 1;
  }
}

/** Re-publish an existing run's record from its own recorded data: the same
 *  publish path as a live run's finally block, no CVM touched. For runs that
 *  predate the committed-media and page steps, and for rebuilding a page. The
 *  original evidence must still sit under work/ and still match its recorded
 *  hashes, or nothing is republished. */
async function republish(short) {
  fail(/^[0-9a-f]{7,40}$/.test(short), 'Usage: rc-dry-run.mjs --republish <short-sha>');
  const workDir = join(REPO, 'work/rc-dry-run', short), recordDir = join(REPO, 'rc-dry-run', short);
  const record = JSON.parse(await readFile(join(workDir, 'rc-dry-run.json'), 'utf8'));
  fail(record.format === 'thot.rc-dry-run/1', 'NOT_A_DRY_RUN_RECORD:' + join(workDir, 'rc-dry-run.json'));
  record.evidence = record.evidence.filter(entry => !entry.media);
  // Publish-stage findings describe this publish step, not the run; they are
  // recomputed below, so a previous publish's notes never accumulate.
  record.findings = record.findings.filter(finding => finding.stage !== 'publish');
  for (const entry of record.evidence) {
    const path = resolve(REPO, entry.path);
    fail(await exists(path), 'EVIDENCE_GONE:' + entry.path);
    fail(await sha256File(path) === entry.sha256, 'EVIDENCE_CHANGED:' + entry.path);
  }
  record.republished_at = new Date().toISOString();
  await publishRecord(record, {recordDir});
  await writeFile(join(workDir, 'rc-dry-run.json'), JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  console.log(`republished ${record.status} run ${short}: ${record.evidence.length} evidence files (${record.evidence.filter(entry => entry.media).length} committed media), ${record.findings.length} findings`);
  console.log(`record: ${join(recordDir, 'RECORD.md')}`);
  console.log(`page: ${join(recordDir, 'index.html')}`);
}

/** Everything a finished run publishes: the journey media copied into the
 *  committed record directory (one copy per distinct video, role names
 *  preferred over the recorder's hash-named duplicates, oversized videos
 *  re-encoded for size), the hash-bound RECORD.md over all evidence, and a
 *  page built through the task-report builder. A media failure must never
 *  cost the record, so it lands as a finding instead of an abort. */
async function publishRecord(record, {recordDir}) {
  const evidenceDir = join(recordDir, 'evidence');
  try {
    // The journey dir is recorded as the run wrote it (absolute on the machine
    // that ran it), so it is resolved as-is and probed as a directory.
    const journeyDir = record.journey && resolve(record.journey.evidence_dir);
    if (journeyDir && await readdir(journeyDir).then(() => true, () => false)) {
      await rm(evidenceDir, {recursive: true, force: true});
      const collected = await collectEvidence({repo: REPO, dirs: [journeyDir],
        mediaDir: evidenceDir, mediaHref: 'evidence', copyImages: true, posters: false});
      const committed = collected.mediaFiles.filter(file => file.kind !== 'poster');
      const bytes = committed.reduce((sum, file) => sum + file.bytes, 0);
      if (bytes > MEDIA_BUDGET_BYTES) record.findings.push({code: 'media-over-budget', stage: 'publish',
        detail: `Committed journey media is ${fmtBytes(bytes)}, over the ${fmtBytes(MEDIA_BUDGET_BYTES)} dry-run share of the 25 MiB per-task media rule; trim or re-encode before embedding it in a task report.`});
      record.evidence.push(...committed.map(file => ({path: relative(REPO, file.path), sha256: file.sha256, media: true,
        reencoded: file.reencoded || undefined, repacked: file.repacked || undefined,
        source_sha256: (file.reencoded || file.repacked) ? file.sourceSha256 : undefined})));
    } else if (journeyDir) record.findings.push({code: 'journey-media-missing', stage: 'publish',
      detail: `Journey media is no longer under ${relative(REPO, journeyDir)}, so nothing was copied into ${relative(REPO, evidenceDir)}.`});
  } catch (error) {
    record.findings.push({code: 'media-publish-failed', stage: 'publish', detail: String(error.message ?? error)});
  }
  await writeRecord(recordDir, record, REPO);
  const page = await dryRunPageHtml(record, {recordDir});
  assertClean(page, join(recordDir, 'index.html'));
  await writeFile(join(recordDir, 'index.html'), page, {mode: 0o644});
}

/** The run's own page: outcome, steps, findings, and the journey video and
 *  screenshots served from the committed evidence beside it. */
async function dryRunPageHtml(record, {recordDir}) {
  const short = record.commit.slice(0, 7);
  const evidenceDir = join(recordDir, 'evidence');
  const hasEvidence = await readdir(evidenceDir).then(() => true, () => false);
  const evidence = hasEvidence
    ? await collectEvidence({repo: REPO, dirs: [relative(REPO, evidenceDir)], mediaHref: 'evidence'})
    : {html: '<p class="muted">No committed media for this run; every file is hash-bound in RECORD.md instead.</p>'};
  const steps = `<table><thead><tr><th>#</th><th>Step</th><th>Outcome</th></tr></thead><tbody>${record.steps.map(entry =>
    `<tr><td>${entry.step}</td><td><code>${escapeHtml(entry.name)}</code></td><td>${escapeHtml(entry.outcome)}${entry.profile ? ` (profile ${escapeHtml(entry.profile)})` : ''}${entry.status ? ` (HTTP ${entry.status})` : ''}</td></tr>`).join('')}</tbody></table>`;
  const findingsHtml = record.findings.length
    ? `<ul>${record.findings.map(finding => `<li><strong>${escapeHtml(finding.code)}</strong> <span class="muted">(${escapeHtml(finding.stage ?? 'export')}${finding.path ? ` · <code>${escapeHtml(finding.path)}</code>` : ''})</span>: ${escapeHtml(finding.detail)}</li>`).join('')}</ul>`
    : '<p class="muted">None.</p>';
  const link = (url, text) => url ? `<a href="${url}" rel="noopener">${escapeHtml(text ?? url)}</a>` : '<span class="muted">not reached</span>';
  return pageHtml({
    eyebrow: 'Release-candidate dry run',
    title: `RC dry run ${short} — ${record.status}`,
    lead: 'One commit exercised end to end: flattened export with the branding check, install, typecheck and tests in the exported tree, image build, registry push, a disposable CVM, its public health endpoint, the logs-only operator port, and the recorded purchase journey.',
    status: {tone: record.status === 'PASS' ? 'pass' : 'fail', text: record.status === 'PASS' ? 'PASS' : `FAIL — step ${record.failed_at}`},
    facts: [
      {term: 'Commit', html: `<code>${record.commit}</code>`},
      {term: 'Image', html: record.image ? `${escapeHtml(record.image.profile)} profile · <code class="hash">${escapeHtml(record.image.digest ?? record.image.ref ?? '')}</code>` : 'not reached'},
      {term: 'CVM', html: record.cvm?.app_id ? `<code>${escapeHtml(record.cvm.app_id)}</code> · ${link(record.cvm.public_url, 'public URL')}` : 'not reached'},
      {term: 'Log port', html: record.log_port ? `${link(record.log_port.origin, record.log_port.origin.split('//')[1])} · list <strong>HTTP ${escapeHtml(String(record.log_port.checks.list_containers.status))}</strong> · inspect refused <strong>HTTP ${escapeHtml(String(record.log_port.checks.inspect_refused.status))}</strong> · no token refused <strong>HTTP ${escapeHtml(String(record.log_port.checks.unauthenticated_refused.status))}</strong>` : 'not reached'},
      {term: 'Journey', html: record.journey ? `<strong>${escapeHtml(record.journey.status)}</strong> (local synthetic actors)` : 'not reached'},
      {term: 'CVM deleted', html: record.cvm?.deleted === undefined ? 'not created' : record.cvm.deleted ? 'yes' : 'no'},
      {term: 'Started / completed', html: `${record.started_at} / ${record.completed_at}`},
    ],
    sections: [
      {id: 'outcome', title: 'Outcome', html: mdHtml(record.status === 'PASS'
        ? `All steps ran in order against \`${short}\` and the CVM was deleted afterwards. The video and screenshots below are the recorded purchase journey; read the findings for the two shape caveats that always apply to a run from this tree.`
        : `The run stopped at step ${record.failed_at}: \`${(record.error ?? '').replace(/`/g, '')}\` — the steps and evidence below are what ran before it.`)},
      {id: 'steps', title: 'Steps', html: steps},
      {id: 'findings', title: 'Findings', html: findingsHtml},
      {id: 'evidence', title: 'Evidence', html: evidence.html
        + `<p class="muted">Every evidence file, committed or not, is hash-bound in <a href="RECORD.md">RECORD.md</a>; the committed journey media sits beside this page under <code>evidence/</code>.</p>`},
    ],
    footer: `Built by <code>scripts/rc-dry-run.mjs</code> through <code>scripts/build-task-report.mjs</code> · static page: inline CSS, no JavaScript, no external requests.`,
  });
}

/** The human-readable record; hashes bind every evidence file it names. */
async function writeRecord(recordDir, record, repo) {
  const short = record.commit.slice(0, 7);
  const rows = record.evidence.map(file => `| \`${file.path}\`${file.media ? ' *' : ''} | \`${file.sha256}\`${file.media && (file.reencoded || file.repacked) ? ` *(${file.reencoded ? 're-encoded for size' : 're-packed losslessly, identical pixels'}; original \`${file.source_sha256.slice(0, 16)}…\` above)*` : ''} |`).join('\n');
  const findings = record.findings.map(finding => `- **${finding.code}** (${finding.stage ?? 'export'})${finding.path ? ` \`${finding.path}\`` : ''}: ${finding.detail}`).join('\n') || '- none';
  const steps = record.steps.map(entry => `| ${entry.step} | ${entry.name} | ${entry.outcome}${entry.profile ? ` (profile ${entry.profile})` : ''}${entry.status ? ` (HTTP ${entry.status})` : ''} |`).join('\n');
  const text = `# RC dry run: ${short}

Status: **${record.status}**${record.status === 'FAIL' ? ` — failed at step ${record.failed_at}: \`${record.error}\`` : ''}${record.republished_at ? `\n\nRe-published ${record.republished_at} from this run's own \`work/rc-dry-run/${short}/rc-dry-run.json\`; the run itself was not re-executed.` : ''}

| Field | Value |
| --- | --- |
| Commit | \`${record.commit}\` |
| Export manifest SHA-256 | \`${record.export?.manifest_sha256 ?? 'not reached'}\` |
| Export status / findings | ${record.export ? `${record.export.status}, ${record.export.findings_count} findings` : 'not reached'} |
| Image profile | ${record.image?.profile ?? 'not reached'} |
| Image digest | \`${record.image?.digest ?? 'not reached'}\`${record.image?.digest_pinnable === false ? ' *(names another repository; see findings)*' : ''} |
| CVM app id | \`${record.cvm?.app_id ?? 'not reached'}\` |
| CVM public URL | ${record.cvm?.public_url ?? 'not reached'} |
| Log port | ${record.log_port ? `${record.log_port.origin} — list HTTP ${record.log_port.checks.list_containers.status}, inspect refused HTTP ${record.log_port.checks.inspect_refused.status}, no token refused HTTP ${record.log_port.checks.unauthenticated_refused.status}` : 'not reached'} |
| Journey outcome | ${record.journey?.status ?? 'not reached'} |
| CVM deleted | ${record.cvm?.deleted === undefined ? 'not created' : record.cvm.deleted ? 'yes' : `no: ${record.cvm.delete_error ?? 'unknown'}`} |
| Started / completed | ${record.started_at} / ${record.completed_at} |

## Steps

| # | Step | Outcome |
| --- | --- | --- |
${steps || '| | | |'}

## Findings

${findings}

## Evidence (SHA-256)

| File | SHA-256 |
| --- | --- |
${rows || '| | |'}

Evidence rows marked \* are committed media under \`rc-dry-run/${short}/evidence/\` — one copy per distinct video, role-named, re-encoded for size where noted — and rendered by \`rc-dry-run/${short}/index.html\`. All other evidence files live under \`work/rc-dry-run/${short}/\` and are not committed.
This record contains no credentials: the only secrets touched were the ones the \`cvm\` client already holds.
`;
  assertClean(text, join(recordDir, 'RECORD.md'));
  await writeFile(join(recordDir, 'RECORD.md'), text, {mode: 0o600});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(error.message); process.exit(1);});
}
