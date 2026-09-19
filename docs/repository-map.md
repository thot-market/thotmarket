# Source map

Use the [CLI guide](../packages/thot-cli/README.md) to inspect and run capture,
[TESTING.md](../TESTING.md) to build and exercise synthetic cases, and
[VERIFYING.md](../VERIFYING.md) to check evidence and its limits.

| Path | What it supplies |
| --- | --- |
| `apps/api`, `apps/worker` | API authorization, storage access and background settlement; both affect custody. |
| `apps/dashboard` | Browser application, authentication and consent interfaces, including privileged operator views. |
| `apps/site` | Website assets served by the application. Included to inspect delivered content; motivation lives on the website. |
| `packages/thot-cli` | CLI entry point, exact packaged-source list and local build recipe. |
| `packages/capture` | Local capture, account pairing, encrypted channel, recorder and verification policy. |
| `packages/market`, `packages/chain`, `contracts` | Release authorization, payment lifecycle and onchain authority. |
| Other `packages/*` | Authentication, credentials, policy, storage, cryptography, assessments and recovery used by the application. |
| `packages/provenance` | Verifiers, synthetic examples and explicitly historical third-party hardware fixtures. |
| `integrations/robinhood-browser-extension` | Trust-sensitive browser connector source and its permission boundary. |
| `trace-vault` | Python witness, brokerage capture and evidence verification. The image inputs are enumerated in `scripts/runtime-python-files.json`; this is not a second supported npm installation. |
| `migrations` | Checksummed database schema inputs. |
| `deploy` | Runtime config schemas, recorder policy inputs and encrypted-image bootstrap implementation. Example endpoints are non-routable and default instance sets are empty; independently accepted policy must be supplied. |
| `scripts` | Runtime entry points, build and evidence tools, synthetic fixtures and storage maintenance. |
| `tests`, `contracts/test`, `trace-vault/tests` | Regression tests. The declared suites and their prerequisites are in TESTING.md. |

## Useful entry points

- [Recorder service](../scripts/tee-capture-server.ts) and
  [client](../packages/capture/src/tee/client.ts): trace where credentials and
  plaintext flow; see [the security model](security-model.md).
- [Contract authority](governance-environments.md): understand owner powers before
  interpreting governance labels.
- [Remote storage](remote-vault-storage.md): inspect ciphertext placement, quotas,
  failure behavior and migration constraints.
- [Capture metrics](capture-status-metrics.md): interpret saved/pending status.
- [Build snapshot tool](../scripts/build-thot-image.mjs), [Dockerfile](../Dockerfile),
  and [image verifier](../scripts/verify-image-release.mjs): inspect artifact inputs
  and evidence checks. A build recipe is not a published or reproducible image.

Some image utilities retain “private” in their names because they handle encrypted
image delivery. The bootstrap, packaging, prelaunch renderer and configuration
validator are included for review and their synthetic tests; they do not supply
an accepted deployment or authorize one. Storage maintenance scripts similarly
require an explicit data directory and appropriate key custody. They are not
steps in installing the CLI.

The source baseline has its own protocol and storage namespace. See
[compatibility](../BRANDING.md) before using retained data from another baseline.
