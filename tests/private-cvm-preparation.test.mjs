import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Wallet } from 'ethers';
import { prepare, renderStableAppIngress, STABLE_INGRESS_IMAGE, STABLE_INGRESS_BOOT_REFRESH } from '../scripts/prepare-private-cvm.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'thot-cvm-prep-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wallet = Wallet.createRandom(), owners = Array.from({ length: 3 }, () => Wallet.createRandom().address);
  const chain = { chainId: 46630, mode: 'robinhood-testnet', rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    confirmations: 32, deploymentBlock: 123, operatorAddress: wallet.address, manualReserve: true, streamSales: true,
    codeHashes: {} };
  for (const name of ['token', 'market', 'locks', 'reserve', 'governor']) {
    chain[name] = Wallet.createRandom().address; chain.codeHashes[name] = '0x' + randomBytes(32).toString('hex');
  }
  const image = 'sha256:' + randomBytes(32).toString('hex');
  const key = randomBytes(32), nonce = randomBytes(12), clear = Buffer.from('reviewed image archive');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('thot.cvm-image/1'));
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const manifest = { schema: 'thot.private-image/1', algorithm: 'aes-256-gcm', aad: 'thot.cvm-image/1',
    nonce_b64: nonce.toString('base64'), tag_b64: cipher.getAuthTag().toString('base64'), image_id: image,
    archive_sha256: hash(clear), archive_size: clear.length, ciphertext_sha256: hash(encrypted), ciphertext_size: encrypted.length,
    chunks: [{ name: 'image-0000.bin', size: encrypted.length, sha256: hash(encrypted) }] };
  const config = { schema_version: 'thot.cvm-preparation/2', image_id: image,
    manifest_path: join(dir, 'manifest.json'), manifest_sha256: hash(JSON.stringify(manifest)),
    manifest_url: 'https://artifacts.example/reviewed-release/manifest.json',
    chain_path: join(dir, 'chain.json'), chain_sha256: hash(JSON.stringify(chain)),
    operator_key_path: join(dir, 'operator.key'), image_key_path: join(dir, 'image.key'),
    gateway_domain: 'reviewed-gateway.phala.network', data_volume: 'preserved-vault',
    governance_owners: owners, privy_app_id: 'reviewed-public-app', output_dir: join(dir, 'prepared') };
  const imageKey = key.toString('base64');
  await writeFile(join(dir, 'image-0000.bin'), encrypted);
  await writeFile(config.manifest_path, JSON.stringify(manifest));
  await writeFile(config.chain_path, JSON.stringify(chain));
  await writeFile(config.operator_key_path, wallet.privateKey, { mode: 0o600 });
  await writeFile(config.image_key_path, imageKey, { mode: 0o600 });
  return { dir, config, chain, wallet, imageKey };
}

test('explicit reviewed inputs produce current measured app settings and private env only', async t => {
  const f = await fixture(t), plan = await prepare(f.config);
  const compose = await readFile(join(f.config.output_dir, 'app.compose.yml'), 'utf8');
  const prelaunch = await readFile(join(f.config.output_dir, 'prelaunch.sh'), 'utf8');
  const env = await readFile(join(f.config.output_dir, 'sealed.env'), 'utf8');
  const publicPlan = await readFile(join(f.config.output_dir, 'rollout-plan.json'), 'utf8');
  assert.match(compose, new RegExp(f.config.image_id));
  assert.ok(compose.includes('preserved-vault:/data') && compose.includes('preserved-vault: {}'));
  assert.ok(compose.includes('reviewed-gateway.phala.network'));
  assert.ok(compose.includes('THOT_ENABLE_OPENROUTER_RELAY: "true"'));
  assert.ok(compose.includes('THOT_ENABLE_CLERK_AUTH: "false"'));
  assert.ok(compose.includes('allow_public_signup:true'));
  assert.ok(compose.includes('THOT_PRIVY_APP_ID: "reviewed-public-app"'));
  assert.ok(compose.includes('flock') && compose.includes('/data/.thot-process-lock'));
  assert.ok(compose.includes('MAINTENANCE_REVIEW_REQUIRED'));
  assert.ok(compose.includes('read_only: true') && compose.includes('pull_policy: never'));
  for (const owner of [f.wallet.address, ...f.config.governance_owners]) assert.ok(compose.includes(owner));
  assert.equal(plan.compose_sha256, hash(compose));
  assert.equal(plan.prelaunch_sha256, hash(prelaunch));
  assert.equal(spawnSync('bash', ['-n', join(f.config.output_dir, 'prelaunch.sh')]).status, 0);
  const embedded = compose.match(/node --input-type=module -e '\n([\s\S]*?)\n        ' && unset/);
  assert.ok(embedded);
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '--check'], { input: embedded[1] }).status, 0);
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0) {
    const checked = spawnSync('docker', ['compose', '--file', join(f.config.output_dir, 'app.compose.yml'), 'config', '--quiet'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, DSTACK_APP_ID: 'a'.repeat(40), DSTACK_GATEWAY_DOMAIN: f.config.gateway_domain,
        THOT_CHAIN_CONFIG_B64: Buffer.from(JSON.stringify(f.chain)).toString('base64'), THOT_TESTNET_OPERATOR_KEY: f.wallet.privateKey },
    });
    assert.equal(checked.status, 0, 'Generated deployment must pass Docker Compose validation');
  }
  for (const publicText of [compose, prelaunch, publicPlan]) {
    assert.ok(!publicText.includes(f.wallet.privateKey)); assert.ok(!publicText.includes(f.imageKey));
    assert.ok(!/__THOT_[A-Z_]+__/.test(publicText));
  }
  assert.equal(env.split('\n').filter(Boolean).length, 3);
  assert.ok(env.includes(f.wallet.privateKey) && env.includes(f.imageKey));
  for (const filename of ['app.compose.yml', 'prelaunch.sh', 'sealed.env', 'rollout-plan.json']) {
    assert.equal((await stat(join(f.config.output_dir, filename))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(f.config.output_dir)).mode & 0o777, 0o700);
  await assert.rejects(prepare(f.config));
  assert.equal(await readFile(join(f.config.output_dir, 'sealed.env'), 'utf8'), env);
});

test('optional public Privy client and explicit private deployer export are supported', async t => {
  const f = await fixture(t);
  await writeFile(f.config.operator_key_path, JSON.stringify({ address: f.wallet.address, privateKey: f.wallet.privateKey }));
  f.config.privy_client_id = 'reviewed-public-client';
  await prepare(f.config);
  assert.match(await readFile(join(f.config.output_dir, 'app.compose.yml'), 'utf8'), /THOT_PRIVY_CLIENT_ID: "reviewed-public-client"/);
});

for (const invalid of ['unknown key', 'image mismatch', 'manifest hash', 'chain hash', 'weak finality', 'wrong operator',
  'duplicate owners', 'worker is owner', 'gateway injection', 'volume injection', 'key permissions', 'key symlink', 'nested secret']) {
  test(`preparation fails closed for ${invalid}, without echoing secrets`, async t => {
    const f = await fixture(t);
    if (invalid === 'unknown key') f.config.secret = f.wallet.privateKey;
    if (invalid === 'image mismatch') f.config.image_id = 'sha256:' + 'f'.repeat(64);
    if (invalid === 'manifest hash') f.config.manifest_sha256 = 'f'.repeat(64);
    if (invalid === 'chain hash') f.config.chain_sha256 = 'f'.repeat(64);
    if (invalid === 'wrong operator') await writeFile(f.config.operator_key_path, Wallet.createRandom().privateKey);
    if (invalid === 'duplicate owners') f.config.governance_owners[1] = f.config.governance_owners[0];
    if (invalid === 'worker is owner') f.config.governance_owners[0] = f.wallet.address;
    if (invalid === 'gateway injection') f.config.gateway_domain = 'x.phala.network";malicious';
    if (invalid === 'volume injection') f.config.data_volume = '/tmp/sensitive';
    if (invalid === 'key permissions') await chmod(f.config.image_key_path, 0o644);
    if (invalid === 'key symlink') { const path = join(f.dir, 'symlink.key'); await symlink(f.config.image_key_path, path); f.config.image_key_path = path; }
    if (invalid === 'weak finality' || invalid === 'nested secret') {
      if (invalid === 'weak finality') f.chain.confirmations = 1;
      else f.chain.extra = { privateKey: f.wallet.privateKey };
      const bytes = JSON.stringify(f.chain); await writeFile(f.config.chain_path, bytes); f.config.chain_sha256 = hash(bytes);
    }
    await assert.rejects(prepare(f.config), error => !String(error).includes(f.wallet.privateKey) && !String(error).includes(f.imageKey));
    await assert.rejects(stat(f.config.output_dir), { code: 'ENOENT' });
  });
}

test('preparation authenticates the key and uploaded chunk set before emitting any deployment', async t => {
  const f = await fixture(t);
  await writeFile(f.config.image_key_path, randomBytes(32).toString('base64'));
  await assert.rejects(prepare(f.config));
  await assert.rejects(stat(f.config.output_dir), { code: 'ENOENT' });
  await writeFile(f.config.image_key_path, f.imageKey);
  const chunk = join(f.dir, 'image-0000.bin');
  const corrupt = await readFile(chunk); corrupt[0] ^= 1; await writeFile(chunk, corrupt);
  await assert.rejects(prepare(f.config));
  await assert.rejects(stat(f.config.output_dir), { code: 'ENOENT' });
});


test('stable TLS alias preserves native identity, application data and separate persistent certificate keys', async t => {
  const f = await fixture(t);
  f.config.stable_app_origin = 'https://app.test.thot.market';
  const plan = await prepare(f.config);
  const compose = await readFile(join(f.config.output_dir, 'app.compose.yml'), 'utf8');
  assert.ok(compose.includes(`image: "${STABLE_INGRESS_IMAGE}"`));
  assert.ok(compose.includes(`THOT_ALLOWED_APP_ORIGINS: '["https://app.test.thot.market"]'`));
  assert.ok(compose.includes('THOT_PUBLIC_ORIGIN: "https://${DSTACK_APP_ID:?dstack app identity}-4318.${DSTACK_GATEWAY_DOMAIN:?dstack gateway domain}"'));
  assert.ok(compose.includes('preserved-vault:/data'));
  assert.ok(compose.includes('preserved-vault-certificates:/etc/letsencrypt'));
  assert.ok(compose.includes('preserved-vault-evidences:/evidences'));
  assert.ok(compose.includes('CHALLENGE_TYPE: "tls-alpn-01"'));
  assert.ok(compose.includes('DNS_SETUP_MODE: "wait"'));
  assert.ok(compose.includes('GATEWAY_DOMAIN: "gateway.${DSTACK_GATEWAY_DOMAIN:?dstack gateway domain}"'));
  assert.ok(!/CLOUDFLARE_API_TOKEN|CERTBOT_EMAIL/.test(compose));
  assert.ok(compose.includes('certificate="/etc/letsencrypt/lego/certificates/$${DOMAIN:?domain required}.crt"'));
  assert.ok(compose.includes('exec /scripts/entrypoint.sh "$$@"'));
  if (spawnSync('docker', ['compose', 'version'], {stdio:'ignore'}).status === 0) {
    const checked=spawnSync('docker',['compose','-f',join(f.config.output_dir,'app.compose.yml'),'config','--format','json'],{encoding:'utf8',env:{PATH:process.env.PATH,DSTACK_APP_ID:'a'.repeat(40),DSTACK_GATEWAY_DOMAIN:'dstack-pha-prod5.phala.network',THOT_PRIVATE_IMAGE_KEY_B64:f.imageKey,THOT_TESTNET_OPERATOR_KEY:f.wallet.privateKey,THOT_CHAIN_CONFIG_B64:Buffer.from(JSON.stringify(f.chain)).toString('base64')}});
    assert.equal(checked.status,0,'Final generated Compose must parse without host DOMAIN or shell-local variables');
    assert.deepEqual(JSON.parse(checked.stdout).services['dstack-ingress'].entrypoint,['/bin/bash','-euc',STABLE_INGRESS_BOOT_REFRESH.replaceAll('$',()=> '$$'),'--']);
  }
  assert.equal(plan.stable_app_origin, f.config.stable_app_origin);
  assert.equal(plan.certificate_volume, 'preserved-vault-certificates');
  assert.equal(plan.evidence_volume, 'preserved-vault-evidences');
  assert.equal((await readFile(join(f.config.output_dir, 'sealed.env'), 'utf8')).split('\n').filter(Boolean).length, 3);
  for (const invalid of ['http://app.test.thot.market', 'https://app.test.thot.market/app', 'https://app.test.thot.market/',
    'https://app.test.thot.market:443', 'https://app.test.thot.market?x=1', 'https://evil.example', 'https://app.test.thot.market\nDOMAIN: injected']) {
    assert.throws(() => renderStableAppIngress({ ...f.config, stable_app_origin: invalid }));
  }
});

test('stable ingress refresh precedes the upstream entrypoint and preserves its exact command after Compose interpolation', async t => {
  assert.equal(spawnSync('bash', ['-n'], { input: STABLE_INGRESS_BOOT_REFRESH }).status, 0);
  assert.ok(STABLE_INGRESS_BOOT_REFRESH.indexOf('evidence_finalize') < STABLE_INGRESS_BOOT_REFRESH.indexOf('exec /scripts/entrypoint.sh'));
  assert.doesNotMatch(STABLE_INGRESS_BOOT_REFRESH, /\.key\b|cert_loop|lego (?:renew|run)|docker\.sock/);
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) return t.skip('Docker Compose unavailable');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'thot-ingress-compose-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rendered = renderStableAppIngress({ stable_app_origin: 'https://app.test.thot.market', data_volume: 'vault' });
  const path = join(dir, 'compose.yml');
  await writeFile(path, `services:\n${rendered.service}volumes:\n${rendered.volumes}\n`);
  const checked = spawnSync('docker', ['compose', '-f', path, 'config', '--format', 'json'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, DSTACK_GATEWAY_DOMAIN: 'dstack-pha-prod5.phala.network' },
  });
  assert.equal(checked.status, 0, checked.stderr);
  const ingress = JSON.parse(checked.stdout).services['dstack-ingress'];
  assert.equal(ingress.image, STABLE_INGRESS_IMAGE);
  // `compose config` re-escapes literal dollars so its output can itself be deployed.
  assert.deepEqual(ingress.entrypoint, ['/bin/bash', '-euc', STABLE_INGRESS_BOOT_REFRESH.replaceAll('$', () => '$$'), '--']);
  assert.deepEqual(ingress.command, ['haproxy', '-W', '-f', '/etc/haproxy/haproxy.cfg']);
});

test('boot refresh permits initial certificate issuance and rejects ambiguous persisted accounts before starting upstream', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'thot-ingress-boot-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entrypoint = join(dir, 'entrypoint.sh'), marker = join(dir, 'started.json');
  await writeFile(entrypoint, '#!/bin/bash\nprintf "%s\\n" "$@" > "$START_MARKER"\n', { mode: 0o700 });
  const script = STABLE_INGRESS_BOOT_REFRESH.replaceAll('/etc/letsencrypt', join(dir, 'certificates'))
    .replace('/scripts/entrypoint.sh', entrypoint);
  const args = ['haproxy', '-W', '-f', '/etc/haproxy/haproxy.cfg'];
  const run = () => spawnSync('bash', ['-euc', script, '--', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, DOMAIN: 'app.test.thot.market', START_MARKER: marker },
  });
  assert.equal(run().status, 0);
  assert.equal(await readFile(marker, 'utf8'), args.join('\n') + '\n');
  await rm(marker);
  await mkdir(join(dir, 'certificates/lego/certificates'), { recursive: true });
  await writeFile(join(dir, 'certificates/lego/certificates/app.test.thot.market.crt'), 'public certificate fixture');
  for (const account of ['first', 'second']) {
    const path = join(dir, 'certificates/lego/accounts/acme-v02.api.letsencrypt.org', account);
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'account.json'), '{}');
  }
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /INGRESS_ACCOUNT_AMBIGUOUS/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});
