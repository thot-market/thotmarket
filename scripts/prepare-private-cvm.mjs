import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet, getAddress } from 'ethers';
import { renderPrelaunch } from './render-private-image-prelaunch.mjs';
import { renderPrivateR2 } from './render-private-r2.mjs';
import { validateManifest } from '../deploy/private-image-bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fields = ['schema_version', 'image_id', 'manifest_path', 'manifest_sha256', 'manifest_url',
  'chain_path', 'chain_sha256', 'operator_key_path', 'image_key_path', 'gateway_domain',
  'data_volume', 'governance_owners', 'privy_app_id', 'privy_client_id', 'stable_app_origin', 'output_dir', 'remote_storage'];
const fail = () => { throw new Error('Invalid reviewed deployment configuration'); };
const check = value => { if (!value) fail(); };

export const STABLE_INGRESS_IMAGE = 'dstacktee/dstack-ingress:2.5@sha256:97285855a83ce6682447eb1f36e59c1927b9188a51b213e34d79acadd8425c78';
const STABLE_APP_ORIGINS = ['https://app.test.thot.market', 'https://app.staging.thot.market', 'https://app.thot.market'];

/** Refresh the public quote before upstream starts its certificate-renewal loop. */
export const STABLE_INGRESS_BOOT_REFRESH = `set -euo pipefail
certificate="/etc/letsencrypt/lego/certificates/\${DOMAIN:?domain required}.crt"
if [ -s "$certificate" ]; then
  shopt -s nullglob
  accounts=(/etc/letsencrypt/lego/accounts/acme-v02.api.letsencrypt.org/*/account.json)
  [ "\${#accounts[@]}" -eq 1 ] || { echo 'INGRESS_ACCOUNT_AMBIGUOUS' >&2; exit 1; }
  source /scripts/evidence-lib.sh
  destination=/evidences
  mkdir -p "$destination"
  temporary=$(mktemp -d "$destination/.boot-evidence.XXXXXX")
  trap 'rm -rf -- "$temporary"' EXIT
  export EVIDENCE_DIR="$temporary"
  curl() { command curl --fail --max-time 30 "$@"; }
  evidence_reset
  evidence_collect_account "\${accounts[0]}"
  evidence_collect_cert "$DOMAIN" "$certificate"
  evidence_finalize
  python3 - "$temporary/quote.json" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as stream:
    value = json.load(stream)
quote = value.get('quote')
if not isinstance(quote, str) or not (0 < len(quote) < 200000) or len(quote) % 2 or not re.fullmatch('[0-9a-fA-F]+', quote):
    raise SystemExit('INGRESS_BOOT_QUOTE_INVALID')
PY
  for name in acme-account.json "cert-\${DOMAIN}.pem" sha256sum.txt quote.json; do
    chmod 644 "$temporary/$name"
    mv -f -- "$temporary/$name" "$destination/$name"
  done
  cd /
  rmdir "$temporary"
  trap - EXIT
  unset EVIDENCE_DIR
fi
exec /scripts/entrypoint.sh "$@"
`;

/** A DNS-only alias terminates TLS in this CVM; native identity and /data stay unchanged. */
export function renderStableAppIngress(config) {
  if (config.stable_app_origin === undefined) return { originEnv: '', service: '', volumes: '' };
  check(STABLE_APP_ORIGINS.includes(config.stable_app_origin));
  check(/^[a-z][a-z0-9_-]{0,62}$/.test(config.data_volume));
  const domain = new URL(config.stable_app_origin).hostname;
  const certificateVolume = `${config.data_volume}-certificates`;
  const evidenceVolume = `${config.data_volume}-evidences`;
  return {
    originEnv: `      THOT_ALLOWED_APP_ORIGINS: '${JSON.stringify([config.stable_app_origin])}'`,
    certificateVolume, evidenceVolume,
    service: `  dstack-ingress:
    image: "${STABLE_INGRESS_IMAGE}"
    entrypoint:
      - /bin/bash
      - -euc
      - |
${STABLE_INGRESS_BOOT_REFRESH.trimEnd().replaceAll('$', () => '$$').split('\n').map(line => '        ' + line).join('\n')}
      - --
    command: ["haproxy", "-W", "-f", "/etc/haproxy/haproxy.cfg"]
    restart: unless-stopped
    ports: ["443:443"]
    environment:
      DOMAIN: "${domain}"
      CHALLENGE_TYPE: "tls-alpn-01"
      TARGET_ENDPOINT: "thot-app:4318"
      GATEWAY_DOMAIN: "gateway.\${DSTACK_GATEWAY_DOMAIN:?dstack gateway domain}"
      DNS_SETUP_MODE: "wait"
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock
      - ${certificateVolume}:/etc/letsencrypt
      - ${evidenceVolume}:/evidences
`,
    volumes: `  ${certificateVolume}: {}\n  ${evidenceVolume}: {}`,
  };
}

async function readPrivate(path) {
  let file;
  try {
    check(isAbsolute(path));
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await file.stat();
    check(st.isFile() && st.nlink === 1 && st.size <= 1024 && (st.mode & 0o777) === 0o600 && st.uid === process.getuid());
    return (await file.readFile('utf8')).trim();
  } finally { await file?.close(); }
}

/** Output must be ignored work/ or outside this checkout; no symlinked ancestors. */
export async function validatePrivateOutput(path) {
  check(typeof path === 'string' && isAbsolute(path));
  const target = resolve(path);
  const rel = relative(root, target);
  check(rel.startsWith('..' + '/') || isAbsolute(rel) || rel.startsWith('work/'));
  let ancestor = dirname(target);
  const absent = [];
  while (true) {
    try {
      const st = await lstat(ancestor);
      check(st.isDirectory() && !st.isSymbolicLink());
      // macOS /var -> /private/var is a system alias; callers should resolve it.
      check(await realpath(ancestor) === ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      absent.push(ancestor); ancestor = dirname(ancestor);
    }
  }
  for (const directory of absent.reverse()) await mkdir(directory, { mode: 0o700 });
  return target;
}

function publicChain(bytes, expectedHash) {
  check(bytes.length <= 32_000 && hash(bytes) === expectedHash);
  const chain = JSON.parse(bytes.toString('utf8'));
  if (process.env.THOT_NEAR_PRIVACY_KEY) check(/^[A-Za-z0-9_-]{8,256}$/.test(process.env.THOT_NEAR_PRIVACY_KEY.trim()));
  const inspect = value => {
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      check(!/private.?key|secret|mnemonic|operatorSigner/i.test(key)); inspect(item);
    }
  };
  inspect(chain);
  check(chain.chainId === 46630 && chain.mode === 'robinhood-testnet');
  check(chain.rpcUrl === 'https://rpc.testnet.chain.robinhood.com');
  check(chain.manualReserve === true && chain.streamSales === true);
  check(Number.isSafeInteger(chain.confirmations) && chain.confirmations >= 32);
  check(Number.isSafeInteger(chain.deploymentBlock) && chain.deploymentBlock >= 0);
  for (const key of ['token', 'market', 'locks', 'reserve', 'governor']) {
    check(/^0x[0-9a-fA-F]{40}$/.test(chain[key]) && BigInt(chain[key]) !== 0n);
    check(/^0x[0-9a-fA-F]{64}$/.test(chain.codeHashes?.[key]));
  }
  return chain;
}

/** Authenticate the local upload set without persisting a second plaintext archive. */
async function verifyLocalImage(manifestPath, manifest, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.nonce_b64, 'base64'));
  decipher.setAAD(Buffer.from(manifest.aad));
  decipher.setAuthTag(Buffer.from(manifest.tag_b64, 'base64'));
  const archiveHash = createHash('sha256'), encryptedHash = createHash('sha256');
  let clearSize = 0;
  for (const chunk of manifest.chunks) {
    let file;
    try {
      file = await open(resolve(dirname(manifestPath), chunk.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await file.stat();
      check(st.isFile() && st.size === chunk.size);
      const bytes = await file.readFile();
      check(bytes.length === chunk.size && hash(bytes) === chunk.sha256);
      encryptedHash.update(bytes);
      const clear = decipher.update(bytes);
      clearSize += clear.length; archiveHash.update(clear); clear.fill(0);
    } finally { await file?.close(); }
  }
  const final = decipher.final();
  clearSize += final.length; archiveHash.update(final); final.fill(0);
  check(clearSize === manifest.archive_size && archiveHash.digest('hex') === manifest.archive_sha256);
  check(encryptedHash.digest('hex') === manifest.ciphertext_sha256);
}

export async function prepare(config) {
  let output, created = false;
  try {
    check(config && typeof config === 'object' && !Array.isArray(config));
    check(Object.keys(config).every(key => fields.includes(key)));
    for (const key of fields.filter(key => !['privy_client_id', 'stable_app_origin', 'remote_storage'].includes(key))) check(key in config);
    check(config.schema_version === 'thot.cvm-preparation/2');
    check(/^sha256:[a-f0-9]{64}$/.test(config.image_id));
    for (const key of ['manifest_sha256', 'chain_sha256']) check(/^[a-f0-9]{64}$/.test(config[key]));
    check(/^[a-z0-9][a-z0-9.-]*\.phala\.network$/.test(config.gateway_domain));
    check(!config.gateway_domain.includes('..'));
    check(/^[a-z][a-z0-9_-]{0,62}$/.test(config.data_volume));
    check(/^[a-zA-Z0-9_-]{8,128}$/.test(config.privy_app_id));
    if (config.privy_client_id !== undefined) check(/^[a-zA-Z0-9_-]{8,128}$/.test(config.privy_client_id));
    check(Array.isArray(config.governance_owners) && config.governance_owners.length === 3);
    const owners = config.governance_owners.map(getAddress);
    check(new Set(owners).size === 3 && owners.every(owner => BigInt(owner) !== 0n));
    for (const key of ['manifest_path', 'chain_path']) check(isAbsolute(config[key]));
    const manifestBytes = await readFile(config.manifest_path);
    check(manifestBytes.length < 128_000 && hash(manifestBytes) === config.manifest_sha256);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    validateManifest(manifest, config.image_id);
    const chainBytes = await readFile(config.chain_path);
    const chain = publicChain(chainBytes, config.chain_sha256);
    let operatorKey = await readPrivate(config.operator_key_path);
    // Accommodate the explicit private export format used by the testnet deployer.
    if (operatorKey.startsWith('{')) {
      const value = JSON.parse(operatorKey);
      check(Object.keys(value).every(key => ['address', 'privateKey'].includes(key)));
      operatorKey = value.privateKey;
      check(new Wallet(operatorKey).address === getAddress(value.address));
    }
    check(/^0x[0-9a-fA-F]{64}$/.test(operatorKey));
    const operator = new Wallet(operatorKey).address;
    check(operator === getAddress(chain.operatorAddress) && !owners.includes(operator));
    const imageKey = await readPrivate(config.image_key_path);
    const keyBytes = Buffer.from(imageKey, 'base64');
    check(keyBytes.length === 32 && keyBytes.toString('base64') === imageKey);
    try { await verifyLocalImage(config.manifest_path, manifest, keyBytes); }
    finally { keyBytes.fill(0); }
    const stable = renderStableAppIngress(config);
    const remote = await renderPrivateR2(config.remote_storage, config.data_volume);
    const substitutions = {
      __THOT_REMOTE_ENV__: remote.environment, __THOT_QUOTA_SERVICE__: remote.service, __THOT_QUOTA_VOLUMES__: remote.volumes,
      __THOT_IMAGE_ID__: config.image_id, __THOT_CHAIN_SHA256__: config.chain_sha256,
      __THOT_GATEWAY_DOMAIN__: config.gateway_domain, __THOT_VOLUME__: config.data_volume,
      __THOT_PRIVY_APP_ID__: config.privy_app_id,
      __THOT_STABLE_ORIGIN_ENV__: stable.originEnv,
      __THOT_STABLE_INGRESS_SERVICE__: stable.service,
      __THOT_STABLE_INGRESS_VOLUMES__: stable.volumes,
      __THOT_OPERATOR_ADDRESSES_JSON__: JSON.stringify([operator, ...owners]),
      __THOT_PRIVY_CLIENT_ENV__: config.privy_client_id ? `      THOT_PRIVY_CLIENT_ID: "${config.privy_client_id}"` : '',
    };
    let compose = await readFile(resolve(root, 'deploy/thot-app.compose.yml'), 'utf8');
    for (const [marker, value] of Object.entries(substitutions)) {
      // A string replacement interprets $$ and collapses Compose's shell escaping.
      check(compose.includes(marker)); compose = compose.replaceAll(marker, () => value);
    }
    check(!/__THOT_[A-Z_]+__/.test(compose));
    const prelaunch = renderPrelaunch({ manifestUrl: config.manifest_url,
      manifestSha256: config.manifest_sha256, imageId: config.image_id,
      helperSource: await readFile(resolve(root, 'deploy/private-image-bootstrap.mjs'), 'utf8') });
    output = await validatePrivateOutput(config.output_dir);
    await mkdir(output, { mode: 0o700 }); created = true;
    const plan = {
      schema_version: 'thot.cvm-rollout/2', image_id: config.image_id,
      manifest_url: config.manifest_url, manifest_sha256: config.manifest_sha256,
      chain_sha256: config.chain_sha256, compose_sha256: hash(compose), prelaunch_sha256: hash(prelaunch),
      operator_address: operator, governance_owners: owners, gateway_domain: config.gateway_domain,
      data_volume: config.data_volume, confirmations: chain.confirmations,
      ...(config.stable_app_origin ? { stable_app_origin: config.stable_app_origin,
        certificate_volume: stable.certificateVolume, evidence_volume: stable.evidenceVolume } : {}),
      files: { compose: 'app.compose.yml', prelaunch: 'prelaunch.sh', sealed_env: 'sealed.env' },
      review_required: ['Verify the three approved owners and the testnet one-owner threshold against the pinned governor on chain.',
        'Use the existing CVM ID and exact existing volume for upgrades; native origin and KMS determine vault identity.',
        'Stop any other process using the dedicated worker key before starting this deployment.',
        'When enabling R2 on an existing local vault, stop here until reviewed ciphertext/quota migration and the storage-format transition are complete; changing placement alone is rejected.',
        'Retain prior encrypted artifacts and configuration; verify workload attestation and live flows after deployment.'],
    };
    for (const [name, text] of Object.entries({
      'app.compose.yml': compose, 'prelaunch.sh': prelaunch,
      'sealed.env': remote.sealedEnv + (process.env.THOT_NEAR_PRIVACY_KEY ? `THOT_NEAR_PRIVACY_KEY=${process.env.THOT_NEAR_PRIVACY_KEY.trim()}\n` : '') + `THOT_PRIVATE_IMAGE_KEY_B64=${imageKey}\nTHOT_TESTNET_OPERATOR_KEY=${operatorKey}\nTHOT_CHAIN_CONFIG_B64=${chainBytes.toString('base64')}\n`,
      'rollout-plan.json': JSON.stringify(plan, null, 2) + '\n',
    })) await writeFile(resolve(output, name), text, { flag: 'wx', mode: 0o600 });
    return { output_dir: output, ...plan };
  } catch {
    if (created) await rm(output, { recursive: true, force: true });
    throw new Error('Private CVM preparation failed; no existing output was overwritten and credential values were not logged');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(process.argv.length === 4 && process.argv[2] === '--config');
    const result = await prepare(JSON.parse(await readFile(process.argv[3], 'utf8')));
    console.log(JSON.stringify({ output_dir: result.output_dir, image_id: result.image_id, files: result.files }));
  } catch { console.error('Private CVM preparation failed; review the explicit configuration and private-file permissions.'); process.exitCode = 1; }
}
