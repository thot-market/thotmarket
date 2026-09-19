# Public verification suites

This tree contains the release trust surface, not the private development workspace.
`release/test-suites.json` is the exact test inventory. `package.json` exposes only
commands supported by this export. Test selection is explicit: adding a file does
not silently add a provider call or operator task to CI.

| Command | Scope |
| --- | --- |
| `pnpm build` | Strict types and browser authentication bundle |
| `pnpm test` | Authentication, wallet/consent UI, privacy, storage/migrations, capture and recovery |
| `pnpm test:contracts` | Local contracts, governance, reserve, accounting and paid-delivery integration |
| `pnpm test:evidence` | Genuine historical DCAP fixtures, portable verification, evidence tampering and synthetic Python trade verification, capture and account linking |
| `pnpm test:browser` | Older AtomicTraceMarket synthetic purchase/delivery browser journey |
| `pnpm test:packaging` | Image import authenticity, packaging, snapshot and provenance boundaries |
| `pnpm test:all` | All five suites, sequentially |

Install Node 24, pnpm 10.34.5, and locked dependencies:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir contracts install --frozen-lockfile --ignore-scripts
pnpm build
```

Contracts/browser tests require Anvil 1.7.1 on PATH (or `THOT_ANVIL_PATH`). Money
fixtures are forced to `local-v2`; no upstream fork, funded wallet or hosted chain
is selected. Browser tests require Chromium/Chrome via the absolute
`THOT_E2E_BROWSER` path, plus Xvfb and ffmpeg on Linux. They use synthetic accounts.

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

## Deliberate exclusions

Hosted rollout orchestration, live provider login probes, historical launch
generators and load probes stay in private development. Image-delivery and
configuration-validation code remains where needed to inspect artifact authenticity,
along with its synthetic tests. Other retained regression tests are not automatically
part of a declared suite; read their prerequisites before running them. CI does not certify production accounts, funded operations, current
live attestation, or performance at production scale.

The `contracts/` tree is the contract build/test path. Its current THOT suites
and the older AtomicTraceMarket browser flow are different test targets. The
browser suite exercises the retained older 65/20/15 payment model and local-v2
mandates; it does not establish a complete THOT browser journey. That active
application migration remains unfinished. The retired Python router, settlement
bridge and their Solidity definitions are excluded.
