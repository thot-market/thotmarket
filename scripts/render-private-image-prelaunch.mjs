import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_IMAGE = 'node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export function renderPrelaunch({ manifestUrl, manifestSha256, imageId, helperSource, includeAppMetadata = true }) {
  const url = new URL(manifestUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/manifest.json')
      || !/^[a-f0-9]{64}$/.test(manifestSha256) || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error('Expected exact HTTPS manifest URL and SHA256 pins');
  }
  const delimiter = 'THOT_PRIVATE_IMAGE_BOOTSTRAP_EOF';
  if (helperSource.split('\n').includes(delimiter)) throw new Error('Bootstrap delimiter collision');
  const metadata = includeAppMetadata ? `
# Custom prelaunch replaces Phala's default metadata injection. Reproduce only
# the app identity and gateway exports; never enable development SSH access.
if [ -S /var/run/dstack.sock ]; then
  DSTACK_APP_ID=$(curl --fail --silent --show-error --max-time 20 --unix-socket /var/run/dstack.sock http://dstack/Info | jq -er .app_id)
elif [ -S /var/run/tappd.sock ]; then
  DSTACK_APP_ID=$(curl --fail --silent --show-error --max-time 20 --unix-socket /var/run/tappd.sock http://dstack/prpc/Tappd.Info | jq -er .app_id)
else
  echo 'dstack identity socket is unavailable.' >&2
  exit 1
fi
if [ -z "\${DSTACK_GATEWAY_DOMAIN:-}" ] && [ -f /dstack/user_config ]; then
  DSTACK_GATEWAY_DOMAIN=$(jq -r '.default_gateway_domain // empty' /dstack/user_config)
fi
if [ -z "\${DSTACK_GATEWAY_DOMAIN:-}" ]; then
  DSTACK_GATEWAY_DOMAIN=$(jq -er .default_gateway_domain /dstack/app-compose.json)
fi
if [[ ! "$DSTACK_APP_ID" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$DSTACK_GATEWAY_DOMAIN" =~ ^([a-z0-9][a-z0-9-]*\\.)+phala\\.network$ ]]; then
  echo 'Unexpected dstack app identity or gateway domain.' >&2
  exit 1
fi
export DSTACK_APP_ID DSTACK_GATEWAY_DOMAIN
export DSTACK_APP_DOMAIN="$DSTACK_APP_ID.$DSTACK_GATEWAY_DOMAIN"
` : '';
  return `#!/bin/bash
# Measured import of a private image. Production OS; no SSH or private registry.
# The final application container receives no Docker socket or image decryption key.
set +x
set -euo pipefail
thot_import_private_image() {
  local thot_expected=${quote(imageId)}
  local thot_cache=/dstack/persistent/thot-private-image
  local thot_actual
  thot_actual=$(docker image inspect --format '{{.Id}}' "$thot_expected" 2>/dev/null || true)
  if [ "$thot_actual" = "$thot_expected" ]; then
    echo 'Verified private application image is already cached.'
    return 0
  fi
  if [ -z "\${THOT_PRIVATE_IMAGE_KEY_B64:-}" ]; then
    echo 'Private image decryption key is not configured.' >&2
    return 1
  fi
  umask 077
  mkdir -p "$thot_cache"
  chmod 700 "$thot_cache"
  rm -f "$thot_cache"/image.tar.gz.*.partial "$thot_cache/image.tar.gz"
  cat > "$thot_cache/bootstrap.mjs" <<'${delimiter}'
${helperSource}
${delimiter}
  if ! docker run --rm --pull=missing --platform linux/amd64 --read-only \\
    --cap-drop=ALL --security-opt=no-new-privileges --memory=256m --pids-limit=64 \\
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \\
    -e THOT_PRIVATE_IMAGE_KEY_B64 \\
    -v "$thot_cache:/out" \\
    ${quote(NODE_IMAGE)} node /out/bootstrap.mjs \\
    ${quote(url.href)} ${quote(manifestSha256)} "$thot_expected" /out/image.tar.gz; then
    rm -f "$thot_cache"/image.tar.gz.*.partial "$thot_cache/image.tar.gz"
    return 1
  fi
  if ! docker load --input "$thot_cache/image.tar.gz" >/dev/null; then
    rm -f "$thot_cache/image.tar.gz"
    return 1
  fi
  thot_actual=$(docker image inspect --format '{{.Id}}' "$thot_expected")
  if [ "$thot_actual" != "$thot_expected" ]; then
    echo 'Loaded application image differs from the measured image pin.' >&2
    return 1
  fi
  rm -f "$thot_cache/image.tar.gz" "$thot_cache/bootstrap.mjs"
  echo 'Private application image imported and verified.'
}
thot_import_private_image
unset THOT_PRIVATE_IMAGE_KEY_B64
unset -f thot_import_private_image
${metadata}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestUrl, manifestSha256, imageId, outputFile] = process.argv.slice(2);
  if (!outputFile) throw new Error('Usage: node scripts/render-private-image-prelaunch.mjs HTTPS_MANIFEST_URL MANIFEST_SHA256 IMAGE_ID OUTPUT_FILE');
  const helperSource = await readFile(fileURLToPath(new URL('../deploy/private-image-bootstrap.mjs', import.meta.url)), 'utf8');
  const script = renderPrelaunch({ manifestUrl, manifestSha256, imageId, helperSource });
  await writeFile(outputFile, script, { mode: 0o600 });
  console.log('Wrote measured prelaunch script; no credentials are embedded.');
}
