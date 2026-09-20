# Thot Market

**A market for useful AI research. [thot.market](https://thot.market)**

Thot Market lets people save the work they do with AI and offer selected research
to buyers under explicit sale terms. A research trace is a record of that work:
the questions, model responses and context behind an investigation, a coding
session or an analysis.

This monorepo contains the command line client, web application, marketplace
contracts, TEE recorder and verification tools. CLI capture uses a trusted
execution environment (TEE) to record model exchanges and sign evidence of what it observed.
The client reports its recorder verification status before forwarding model
credentials. An independently selected reference policy enables strict measurement
checks; reviewing that policy and the code it approves is part of deciding whether
to trust the system.

Contributors can import supported histories or capture new sessions, keep them in
a private library, and authorize selected research for sale. Buyers inspect
listing metadata and supported property results before purchasing a licensed
release. Saving privately and authorizing a sale are separate actions.

## Use Thot Market

Open the **[production app](https://484da3c15305127b71262614961583a8f473e00d-4318.dstack-base-prod5.phala.network)**
or read the [tutorial](https://thot.market/tutorial). The production deployment uses
Robinhood chain 4663. Capture and private saving are available; **marketplace
purchases remain paused**. These instructions do not imply a sale or payout.
The [project introduction](https://thot.market/read) explains the motivation; the
[whitepaper](https://thot.market/whitepaper) covers the market design.

### Capture from the command line

The CLI package is `@thotmarket/cli`, with command `thot`. The instructions below
build it from this checkout; they do not require a published npm release. You need
Node.js 24+, your existing Claude Code or Codex installation and login,
and tmux for interactive capture. Python 3 and the reviewed hardware verifier
enable independent recorder checks and are required for strict verification.
Setup reports the recorder verification prerequisites.

```sh
cd packages/thot-cli
npm run build
node bin/thot.js setup codex
node bin/thot.js codex \
  --thot-url https://484da3c15305127b71262614961583a8f473e00d-4318.dstack-base-prod5.phala.network \
  --recorder-url https://ea21eee02e790a01b776070bb846e5d7e3b98b7a-4321.dstack-base-prod5.phala.network \
  --project /path/to/project
```

Replace `/path/to/project` with the project you want to capture. For Claude Code,
substitute `claude` for `codex` in both commands. The helper connects your tool to
your account and reports hardware and reference-check status before forwarding
model credentials. Without an available hardware verifier, normal mode uses
service trust: the HTTPS recorder sees credentials and content. Hardware quote or
key-binding rejection remains fatal. Strict checks require a reviewed policy and
`--reference-policy FILE --require-reference`; distribution of the production
reference policy is pending. See the [CLI guide](packages/thot-cli/README.md)
for policy configuration and prerequisites, or run `node bin/thot.js --help`.
The [source identity guide](BRANDING.md) describes this source baseline and its
compatibility boundaries; select an origin and recorder policy accepted for the
CLI version you build.

## Build and test the source

This repository contains the contracts, application, capture clients and verifiers
needed to inspect how Thot Market records, authorizes, delivers and settles research.

From the repository root, use Node.js 24+ and pnpm 10.34.5:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test
```

`pnpm build` checks TypeScript and builds the browser authentication bundle.
`pnpm test` runs the default application suite. The [testing guide](TESTING.md)
covers contract, evidence, browser and packaging suites, including Anvil and Python
prerequisites. Local tests use disposable accounts and synthetic data; historical
hardware fixtures are identified separately.

## Find your way around

The [source map](docs/repository-map.md) explains the remaining directories and
which tools support local use, security review and artifact inspection.

| Component | Source |
| --- | --- |
| API, browser dashboard and background settlement | [apps](apps) |
| CLI package, entry point and build inputs | [packages/thot-cli](packages/thot-cli) |
| Capture client, encrypted channel and TEE recorder | [packages/capture/src/tee](packages/capture/src/tee) |
| Account authentication and runtime guards | [packages/auth](packages/auth), [packages/runtime](packages/runtime) |
| Listings, licensed releases and purchase lifecycle | [packages/market](packages/market) |
| Escrow, reserve and governance contracts | [contracts/src](contracts/src) |
| Capture evidence and portable verification | [packages/provenance](packages/provenance) |

## Review the trust boundaries

The [security model](docs/security-model.md) maps plaintext recipients, key
custody, authorization, storage compatibility and deployment assumptions.

For CLI capture, the local helper routes model requests through an encrypted
channel to the approved recorder, which forwards them to the model provider.
The recorder processes request credentials and model traffic; the provider still
receives the requests. TEE verification does not remove trust in the approved
software, hardware or provider. Review the
[client](packages/capture/src/tee/client.ts),
[recorder](packages/capture/src/tee/server.ts), and
[identity checks](packages/capture/src/tee/attestation.ts) together. Imported
histories and relay recordings should not be assumed to carry the same evidence.

To inspect what the CLI ships, start with its
[package manifest](packages/thot-cli/package.json),
[build script](packages/thot-cli/build.mjs) and
[source allowlist](packages/thot-cli/reviewed-source-files.json).

## Verify the claims

The [verification guide](VERIFYING.md) distinguishes software provenance, live
enclave identity and individual capture integrity. It includes proposed release
requirements and commands that need independently approved pins and actual
release evidence. This source candidate alone does not establish a published
package, reproducible image or verified live deployment. The
[portable verifier instructions](packages/provenance/portable/README.txt) explain
how to inspect an authorized capture export. A valid signed checkpoint covers its
recorded prefix; it does not prove that all tool activity was witnessed. Passing
source tests does not establish which software a live service runs.

Start with the [offline synthetic example](packages/provenance/examples/receipt-format-v1/README.md)
to check integrity without an account or network connection. See the
[verification status](VERIFYING.md#what-this-tree-establishes) for the evidence
this source tree supplies and the bindings it does not establish.

Project-owned source is [MIT licensed](LICENSE), copyright Thot Market.
Third-party notices and license terms remain with their respective files.
