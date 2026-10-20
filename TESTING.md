# Public verification suites

This tree contains the release trust surface, not the private development workspace.
`release/test-suites.json` is the exact test inventory. `package.json` exposes only
commands supported by this export. Test selection is explicit: adding a file does
not silently add a provider call or operator task to CI.

| Command | Scope |
| --- | --- |
| `pnpm build` | Strict types and browser authentication bundle |
| `pnpm test` | Authentication, wallet/consent UI, privacy, storage/migrations, capture and recovery, log hygiene |
| `pnpm test:qc` | Local quality engine, synthetic judge adapter, owner API/races and standalone CLI (also included in unit) |
| `pnpm test:contracts` | Local contracts, governance, reserve, accounting and paid-delivery integration |
| `pnpm test:evidence` | Genuine historical DCAP fixtures, portable verification, evidence tampering and synthetic Python trade verification, capture and account linking |
| `pnpm test:browser` | Current THOT purchase, licensed delivery, recovery and payout in both fee modes, plus the older AtomicTraceMarket journey |
| `pnpm test:packaging` | Image import authenticity, packaging, snapshot and provenance boundaries |
| `pnpm test:all` | All five suites, sequentially |
| `pnpm rc:dry-run <commit>` | Release-candidate dry run on a disposable `agent-*` CVM; see below |

Install Node 24, pnpm 10.34.5, and locked dependencies:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir contracts install --frozen-lockfile --ignore-scripts
pnpm build
```

Contracts/browser tests require Anvil 1.7.1 on PATH (or `THOT_ANVIL_PATH`). Money
fixtures are forced to `local-v2`; no upstream fork, funded wallet or hosted chain
is selected. Browser tests require Chromium/Chrome via the absolute
`THOT_E2E_BROWSER` path, plus Xvfb and system ffmpeg on Linux. Install Playwright's
version-matched recording executable with `pnpm exec playwright-core install ffmpeg`
as well; system ffmpeg alone does not satisfy Playwright's `recordVideo` option.
They use synthetic accounts. The current THOT journeys run sequentially with
quoted-cost and percentage-fee fixtures. To run just one, use
`pnpm test:thot:browser` or `pnpm test:thot:browser:percentage`. See
[the local purchase demo](docs/local-purchase-demo.md) for the evidence format and
limits: local time acceleration does not prove a hosted payout deadline elapsed.

The focused QC browser flow needs Chromium but no Anvil:
`node --test tests/trace-auto-qc-browser.test.mjs`. It uses synthetic records and a
development identity; outbound requests are blocked. See
[the QC contract](docs/reusable-qc.md) for the scope and provider-test limitations.
Use a disk-backed `TMPDIR` if the system temporary filesystem has less than the
vault's required free-space reserve; do not disable the storage guard for tests.

For evidence tests, create three isolated Python environments, using Python 3.12:

```sh
python3 -m venv work/dcap
python3 -m venv work/portable
python3 -m venv work/trade
work/dcap/bin/pip install --require-hashes --only-binary=:all: -r packages/provenance/requirements.txt
work/portable/bin/pip install --require-hashes --only-binary=:all: -r packages/provenance/portable/requirements.txt
work/trade/bin/pip install --require-hashes --only-binary=:all: -r packages/provenance/trade-test-requirements.txt
export THOT_DCAP_TEST_PYTHON="$PWD/work/dcap/bin/python"
export THOT_PORTABLE_DCAP_TEST_PYTHON="$PWD/work/portable/bin/python"
export THOT_TRADE_TEST_PYTHON="$PWD/work/trade/bin/python"
pnpm test:evidence
```

The runner fails if prerequisites are absent rather than letting the dedicated
hardware suite silently skip. The public quote/collateral fixtures establish
historical verification, not current freshness or attestation of our live service.
Python trade fixtures are synthetic; preserve their distinction from genuine quotes.

## CI and release builds

Credential-free CI runs every suite on pushes, PRs, and manual dispatches. The
`Public source verification` check passes only if all five suite jobs pass. It
works while this repository is private as well as after publication.

The separate `Publish reviewed CVM image` workflow is manual, disabled until
`CVM_IMAGE_RELEASE_ENABLED` is set to `true`, and restricted to an annotated tag
dispatched from that same tag in `thot-market/thotmarket`. It builds a `public`
snapshot, publishes one Linux amd64 image to the repository's GHCR package,
attests its exact OCI manifest digest, and retains a record plus Sigstore bundles.
Configure the `cvm-image-release` GitHub environment for reviewed dispatches and
confirm the repository's package write access before enabling it. A private RC
package requires reviewer read access to that GHCR package.

The workflow does not deploy, approve a Safe compose hash, claim a Docker image
ID equals the registry manifest digest, or establish bitwise reproducibility.
The current recipe resolves OS/Python dependencies over the network. Pin the
published digest in Compose and independently review the provider's resulting
full compose hash before any CVM update.

The exported `scripts/build-thot-image.mjs` defaults to the `public` snapshot
profile. It packages only the reviewed public runtime and does not require or
include private Anvil operator scripts. The separate private-environment recipe
must explicitly select `--profile private-anvil` in the private source tree;
that profile is not a supported input in this exported tree.

The push workflow verifies source without publication or deployment credentials.

## Release-candidate dry run

`pnpm rc:dry-run <commit>` (or `node scripts/rc-dry-run.mjs <commit>`) chains the
existing pieces into one run against a disposable CVM, stopping at the first
failure with the underlying error left unmasked:

1. `release/prepare-public-export.mjs` writes a flattened `git archive` of the
   commit into a fresh directory and runs the branding check over the exported
   bytes themselves. It withholds `steering/`, `reports/` and `rc-dry-run/`,
   including their hosted evidence and media. The findings manifest stays outside
   the export; source-side reports remain subject to the repository branding check.
   The export policy is `status: draft-review-required`; the
   findings count is recorded and findings are not resolved here.
2. `pnpm install --frozen-lockfile --ignore-scripts` (root and `contracts/`),
   `pnpm typecheck` and `pnpm test` run in the exported tree, not this checkout.
3. `scripts/build-thot-image.mjs` builds a local image and its snapshot manifest.
   The default profile is `private-anvil`; a tree that does not ship the four
   `scripts/private-anvil-*.mjs` sources records that as a finding and builds the
   reviewed `public` runtime profile instead. The pinned DCAP verifier must be at
   `work/tools/dcap-qvl-v0.6.1/dcap-qvl-linux-x86_64-musl`.
4. `cvm image-push agent-rc-<short-sha> <image>` returns the published `{ref, digest}`.
5. A compose rendered for that exact reference is passed to
   `cvm create agent-rc-<short-sha> <compose> --private-registry --ttl 2`.
   The published port is pinned (`4318:8080`); a bare container port would
   publish a random host port and the gateway route `https://<app_id>-4318.…`
   would have no backend (an empty reply from the gateway, forever). The
   public tree ships no hosted deployment configuration — chain manifest,
   hosted auth and the KMS-bound master key belong to the withheld private
   flow — so the compose runs the candidate's local-development server: the
   API binds loopback in the container and a compose-level `haproxy:alpine`
   ingress sharing its network namespace publishes the port and maps the
   public host header to the loopback host that runtime accepts. The record
   carries this as a `cvm-deployment-shape` finding rather than implying a
   hosted deployment.
6. The candidate must answer `/healthz` on the CVM's public URL
   (`https://<app_id>-4318.<gateway base domain>`). The probe uses curl, not
   Node's built-in `fetch`: `fetch` ignores the proxy environment, so on a
   proxied machine it cannot resolve the gateway at all (`EAI_AGAIN`), while
   curl honours `HTTPS_PROXY`/`NO_PROXY` and reaches the URL proxied or direct.
   The default deadline is 40 minutes: a first-boot pull of the ~1.9 GB image
   on a 1-vCPU CVM takes many minutes before the app can answer at all
   (`--timeout-seconds` to change).
7. The logs-only operator port ships with the CVM: the compose carries the
   token gate and logs-only filter of `scripts/log-filter.mjs` (on the
   digest-pinned Caddy the private stacks pin), publishing port 4330. The run
   generates its log token at run time — the token exists only in the sealed
   compose handed to the CVM, whose hash the record carries, and is never
   printed or recorded. The run then proves the port's contract through its
   public URL: listing containers with the token succeeds, a request without
   the token is refused by the gate (401), and container inspect is refused by
   the filter (403) — inspect returns sealed environment values, so it is the
   one read that must never pass. `scripts/cvm-logs.mjs` is the client for the
   same port; see `DEVELOPMENT.md`.
8. `scripts/record-thot-purchase.mjs` records a purchase journey. The recorder
   builds its own local Anvil, API and synthetic browser actors and takes no
   target URL, so the journey exercises the candidate source rather than the CVM;
   the record says so explicitly rather than implying a remote journey.
9. `rc-dry-run/<short-sha>/RECORD.md` lists the commit, export manifest hash,
   image digest, CVM app id, log-port check outcomes, journey outcome and the
   SHA-256 of every evidence file. The journey media (`.webm` and PNGs, one
   copy per distinct video, role-named, oversized videos re-encoded for size)
   is copied into `rc-dry-run/<short-sha>/evidence/` and committed alongside a
   hash-bound page, `rc-dry-run/<short-sha>/index.html`, built through the
   task-report builder. All other evidence files stay in
   `work/rc-dry-run/<short-sha>/` and are not committed.
   `node scripts/rc-dry-run.mjs --republish <short-sha>` redoes that publish
   step for an existing run from its own
   `work/rc-dry-run/<short-sha>/rc-dry-run.json`, without touching a CVM.
10. `cvm delete` removes the CVM whether the run passed or failed (`--keep-cvm`
   to retain it for inspection).

The working tree must be exactly the candidate commit apart from `rc-dry-run/`
output, because the image is built from this checkout. The journey step needs
Foundry's `anvil` on `PATH` (or `THOT_ANVIL_PATH`; v1.7.1 is the version the
fixture is written against) and a browser executable in `THOT_E2E_BROWSER`
(the script also picks up the predecessor harness's browser variable). The
script never reads,
prints or writes a credential: the only secrets involved are the ones the `cvm`
client already holds, and the record contains none.

A full run has been exercised for real here — export, branding,
install/typecheck/test in the exported tree, image build with its snapshot
manifest, `cvm image-push`, `cvm create --private-registry`, the health check on
the CVM's public URL, the recorded purchase journey and `cvm delete`. Failures
surface as the underlying error rather than being worked around, so a blocked
run reports the blocker instead of an unverified health claim. See `rc-dry-run/`
for the latest record.

## Task wrap-up reports

`node scripts/build-task-report.mjs <NNNN> [--evidence DIR ...]` ends every
steering task with one self-contained page, `reports/<NNNN>/index.html`: the
goal and success conditions quoted from `steering/<NNNN>-*.md`, the outcome, the
PR link, the commits, the findings, and the evidence — screenshots inlined as
base64, journey videos as `<video>` elements served from `reports/<NNNN>/media/`
(deduplicated by content, re-encoded for size over 2 MiB, poster frames beside
them). The page uses inline CSS only, no script and no external request, and is
readable without JavaScript.

The outcome and findings are authored next to the page they feed —
`reports/<NNNN>/outcome.md` and `reports/<NNNN>/findings.md` are read by
default, `--outcome FILE` and `--findings FILE` point elsewhere — so a rebuild
needs no flags and the plain text stays reviewable in the diff. The PR link and
commits come from git (the `task/NNNN-*` branch and its merge on `main`);
`--pr N` states the number for a branch whose PR is not merged yet. Committed
media is capped at 12 MiB per report and 12 MiB per dry-run evidence directory,
keeping a task under the 25 MiB rule across both; over that, the builder fails
and the dry run records a finding.

Both builders keep their output inside the branding byte-scan: the forbidden
legacy identity is elided in quoted task text (task files predate the rule and
name the predecessor harness's browser variable), PNGs whose bytes or base64
form collide with the sequence by chance are losslessly re-packed (identical
pixels, hashes re-bound and noted), colliding videos are re-encoded, and every
page, note and record is scanned before it reaches disk.

## Deliberate exclusions

Hosted rollout orchestration, live provider login probes, historical launch
generators and load probes stay in private development. Image-delivery and
configuration-validation code remains where needed to inspect artifact authenticity,
along with its synthetic tests. Other retained regression tests are not automatically
part of a declared suite; read their prerequisites before running them. CI does not certify production accounts, funded operations, current
live attestation, or performance at production scale.

The `contracts/` tree is the contract build/test path. The browser suite runs both
the older AtomicTraceMarket flow and the current THOT purchase recorder in
quoted-cost and percentage modes. These use disposable Anvil chains and synthetic
actors; they do not establish production network behavior or hosted authentication.
The retired Python router, settlement bridge and their Solidity definitions are
excluded.
