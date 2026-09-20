# Thot CLI

The command line client for capturing Claude Code and Codex sessions to a private Thot vault. Source lives alongside the server, capture protocol and independent verifiers in the Thot monorepo.

Requires Node.js 24+ and your existing Claude Code or Codex installation/login. Interactive capture also requires tmux. Python 3 and the reviewed hardware verifier enable independent recorder checks and are required by `--require-reference`. Provider clients are not installed by this package.

## Connect to the production deployment

The production Thot deployment runs on Robinhood chain 4663. The app (your vault) and its
recorder are reached at their native gateway URLs:

- App (`--thot-url`): `https://484da3c15305127b71262614961583a8f473e00d-4318.dstack-base-prod5.phala.network`
- Recorder (`--recorder-url`): `https://ea21eee02e790a01b776070bb846e5d7e3b98b7a-4321.dstack-base-prod5.phala.network`

There is no automatic default; pass the target explicitly (or save it, below). Capturing and
saving to your private vault works today. **Marketplace purchases are paused, so nothing here
implies a sale or payout.** Testnet is a separate explicit opt-in, never a default.

```sh
# 1. Check local prerequisites (installs nothing, opens no account, makes no model call)
thot setup codex          # or: thot setup claude

# 2. From your project, capture a session to the production vault via the production recorder
thot codex \
  --thot-url https://484da3c15305127b71262614961583a8f473e00d-4318.dstack-base-prod5.phala.network \
  --recorder-url https://ea21eee02e790a01b776070bb846e5d7e3b98b7a-4321.dstack-base-prod5.phala.network
# or: thot claude --thot-url <same app URL> --recorder-url <same recorder URL>

thot --help
```

`thot` opens your browser once to authorize this tool to your signed-in vault account; work
normally in the coding client and exit it to save. To avoid repeating `--thot-url`, save it once
(`~/.config/thot/capture.json`); it is then used after an explicit `--thot-url`/`THOT_URL`:

```sh
node scripts/install-capture-helper.ts --thot-url https://484da3c15305127b71262614961583a8f473e00d-4318.dstack-base-prod5.phala.network
```

The npm release that provides the global `thot` command is pending; until then, run from a source
checkout as shown under **From a source checkout** below (the commands are otherwise identical).

Existing `THOT_URL`, saved capture configuration, connection and encrypted capture storage remain compatible. This package does not migrate or erase local state. The sanitized `thot` command uses `--thot-url`.

This prerelease ships **no automatic hosted default**: supply `--thot-url` (or `THOT_URL`/saved configuration) and `--recorder-url` (or `THOT_RECORDER_URL`), or a reviewed reference policy containing the recorder URL. Localhost works when explicitly selected. `--thot-url`/`THOT_URL` remain accepted as aliases. Connect to a production deployment by its **native URL** with a matching recorder, so a production app is never paired with a testnet/default recorder; **testnet stays an explicit opt-in, never a default.** A later package release may ship an accepted production pair as a default only after routing/attestation acceptance. Private hosted deployment descriptors and their pins are excluded from the package.

Normal mode reports whether hardware and independently supplied references were checked before launching the provider client. If the hardware verifier is unavailable, normal mode labels the connection **service trust**: the HTTPS recorder endpoint sees model credentials and content, and the encrypted channel alone does not prove an enclave identity. A hardware quote/key-binding rejection remains fatal. `--reference-policy FILE --require-reference` stops before forwarding provider credentials unless hardware and the listed recorder measurements match. `THOT_RECORDER_POLICY_FILE` (legacy `THOT_RECORDER_POLICY_FILE`) overrides the policy file. The local assessment is saved with the encrypted capture and written as `client-verification.json` on export; a server P2 receipt alone does not imply independent client verification.

Distribution of the reviewed production recorder reference policy is pending; there is not yet a public download linked here. Once you have a reviewed policy, pass `--reference-policy FILE --require-reference` (or set `THOT_RECORDER_POLICY_FILE`); the reviewed policy already contains the recorder URL, so it can stand in for `--recorder-url`. Without a reference policy, `--recorder-url` selects the recorder under service trust and the CLI still reports, before forwarding any provider credential, whether hardware and references were checked.

### From a source checkout

Generate the runtime once, then invoke the entry point by its full path from the repository root:

```sh
node packages/thot-cli/build.mjs
node packages/thot-cli/bin/thot.js --help
node packages/thot-cli/bin/thot.js setup codex
node packages/thot-cli/bin/thot.js codex \
  --thot-url https://484da3c15305127b71262614961583a8f473e00d-4318.dstack-base-prod5.phala.network \
  --recorder-url https://ea21eee02e790a01b776070bb846e5d7e3b98b7a-4321.dstack-base-prod5.phala.network
```

Use `node packages/thot-cli/bin/thot.js` in place of `thot` when running from source. Run
`node packages/thot-cli/build.mjs` first: `bin/thot.js` loads the generated `runtime/`, so invoking
it before the build (or as `node bin/thot.js` from the repo root) fails.
`npm pack` creates a local tarball you can inspect; it does not authenticate a
published package. See [package.json](package.json), [the build recipe](build.mjs)
and [the packaged-source list](reviewed-source-files.json). CLI and application
versions are independent. Prepare a reviewed tarball from an exact sanitized
source tag; publication is a separate manual operation. No npm publication or
production endpoint is established here.

No installation lifecycle scripts, provider credentials, deployment manifests or npm tokens belong in the distributed package. Building locally does not authorize npm publication.

## Local footprint and credentials

`setup` probes local prerequisites; it does not install the provider clients, open
accounts or make model calls. Building writes generated `runtime/` files inside
this package. There are no installation lifecycle scripts.

Capture starts your installed provider client with routing overrides scoped to that
child process. It does not rewrite global provider configuration or login files.
The provider client still has its ordinary project permissions. Interactive runs
use an isolated tmux server and a local loopback proxy.

| Location under your home directory | Contents |
| --- | --- |
| `.config/thot/capture.json` | Optional saved application origin; read after `--thot-url` and `THOT_URL`. |
| `.local/state/thot/connections/` | Remembered device authorization, scoped by origin and client. |
| `.local/state/thot/captures/` | Encrypted local recordings, upload state, checkpoints and receipts. |

`THOT_USER_HOME` overrides the home used for these paths. Local encryption keys
are stored alongside the encrypted state with owner-only file permissions; this
does not protect against an attacker controlling your OS account.

First connection opens the selected application's account authorization page and
uses a short-lived loopback callback. The application receives connection metadata
(including device name and project basename) and saved capture content. The local
proxy sends provider credentials and model traffic through the verified recorder;
the recorder forwards requests to the provider. Both approved recorder code and
the provider see that traffic. The vault application can decrypt stored recordings.
See [the security model](../../docs/security-model.md).

## Stop, retry, export and disconnect

Exit the provider client normally and check the final save status. An interrupted
save retains local encrypted state; `thot --retry CAPTURE_ID` retries saving without
replaying model calls. Encrypted local bodies are kept by default. Opt into
`--local-retention until-saved` to remove local parts after an acknowledged final
save; it does not delete vault copies or all connection/checkpoint metadata.

`thot --export CAPTURE_ID --output NEW_DIRECTORY` writes **plaintext** owner
content for inspection. Keep it private and use a separately trusted verifier.

```sh
thot --disconnect codex --thot-url https://YOUR-THOT-APP-ORIGIN
```

Disconnect revokes the remembered device at that origin; it does not erase local
state or saved vault conversations. New automatic listings stop. Use the app's
Connections flow to review wallet revocation of prepared unfunded offers.
Disconnecting cannot retract already delivered content or revoke your provider
login. Stop any active capture separately.

Implementation: [pairing](../capture/src/connect.ts),
[child invocation](../capture/src/index.ts),
[local state](../capture/src/local-state.ts), [sync](../capture/src/sync.ts).
Regression coverage includes [device revocation](../../tests/capture-devices.test.ts),
[sync](../../tests/capture-sync.test.ts) and
[durability](../../tests/capture-durability.test.ts).
