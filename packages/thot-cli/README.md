# Thot CLI

The command line client for capturing Claude Code and Codex sessions to a private Thot vault. Source lives alongside the server, capture protocol and independent verifiers in the Thot monorepo.

Requires Node.js 24+ and your existing Claude Code or Codex installation/login. Interactive capture also requires tmux. Python 3 and the reviewed hardware verifier enable independent recorder checks and are required by `--require-reference`. Provider clients are not installed by this package.

```sh
thot setup claude
thot setup codex
thot claude --thot-url https://YOUR-VAULT-ORIGIN --recorder-url https://YOUR-RECORDER-ORIGIN
thot codex --thot-url https://YOUR-VAULT-ORIGIN --reference-policy /path/to/reviewed-recorder-policy.json --require-reference -- exec "review this project"
thot --help
```

After selecting an accepted production API and recorder pair, a later package
release can ship those defaults. This prerelease requires an explicit target.

Existing `THOT_URL`, saved capture configuration, connection and encrypted capture storage remain compatible. This package does not migrate or erase local state. The sanitized `thot` command uses `--thot-url`.

No production API or recorder is accepted yet, so this prerelease has no automatic hosted default. Supply `--thot-url` (or `THOT_URL`/saved configuration) and `--recorder-url` (or `THOT_RECORDER_URL`), or use a reviewed reference policy containing the recorder URL. Localhost works when explicitly selected. Private hosted deployment descriptors and their pins are excluded from the package.

Normal mode reports whether hardware and independently supplied references were checked before launching the provider client. If the hardware verifier is unavailable, normal mode labels the connection **service trust**: the HTTPS recorder endpoint sees model credentials and content, and the encrypted channel alone does not prove an enclave identity. A hardware quote/key-binding rejection remains fatal. `--reference-policy FILE --require-reference` stops before forwarding provider credentials unless hardware and the listed recorder measurements match. `THOT_RECORDER_POLICY_FILE` remains supported as a policy override. The local assessment is saved with the encrypted capture and written as `client-verification.json` on export; a server P2 receipt alone does not imply independent client verification.

From the repository root:

```sh
cd packages/thot-cli
npm run build
node bin/thot.js --help
node bin/thot.js setup codex
```

Use `node bin/thot.js` in place of `thot` in the examples when building from source.
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
