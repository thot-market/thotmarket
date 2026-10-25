# Developing Thot Market

This repository is where Thot Market is developed. Public source releases are flattened from it, so
everything here should make sense to someone with no access to any particular person's machine,
accounts or notes. If a change only works because of something you know that isn't written down in
this tree, it isn't finished.

Most work is done by development agents. People write the tasks, read the results, and decide what
ships.

## The loop

Small changes, straight to `main`.

1. Describe the work where it happens: a GitHub issue or the PR description says the goal, how to
   tell it is done, and anything beyond the defaults below that the work is authorized to do.
   `steering/` holds longer briefs when one is useful; it is optional.
2. Branch from `main`, keep the PR small, and merge it yourself when CI is green. UI changes attach
   before/after screenshots to the PR. The PR is the record; there is no separate report page.
3. Leftovers become a new issue or PR.

## What an agent may do

By default: change code in this repository, run tests, launch disposable `agent-*` CVMs through the
`cvm` client, push branches, open and merge PRs, and deploy a merged `main` to private dev and
staging. Production is never deployed from the development environment, and nobody there publishes
releases.

The agent's environment is an isolated VM whose internet traffic leaves through a VPN, with a broker
for CVMs. It has its own GitHub account scoped to this repository, its own model key, a test wallet,
and the credentials for private dev and staging. A
`SANDBOX.md` on that machine describes the network and tools; read it first. Nothing about any
person's accounts or machines is available there, and nothing should need to be.

People can work the same way locally. The rules below apply either way.

## Testing, from cheapest to closest to production

| Step | What it shows | How |
| --- | --- | --- |
| Build and unit tests | Types, API, storage, capture, privacy, log hygiene | `pnpm build`, `pnpm test` |
| Local chain | Contracts, purchase, delivery and payout on a disposable Anvil chain | `pnpm test:contracts`, `pnpm test:browser` |
| Evidence and packaging | DCAP verification, provenance, image snapshot | `pnpm test:evidence`, `pnpm test:packaging` |
| Disposable CVM | The candidate image boots in a TEE (infrastructure changes only) | `pnpm rc:dry-run <commit>` (see `TESTING.md`) |
| Private dev, staging | Persistent state, real registries, on-chain approval (staging) | `cvm deploy dev`, then `cvm deploy staging`, from the development VM |
| Production | The live market | Maintainers only, from a tagged release |

`TESTING.md` lists the exact suites and their prerequisites. CI runs the suites on every PR; run
locally what your change touches.

Staging and production are governed on chain: every Compose change is approved by a Safe before the
provider applies it. For staging, the development environment's broker holds an approval key, so
`cvm deploy staging` approves its own change. Production approval stays with maintainers, and a
release reaches production only after a maintainer reviews the tagged source and image.

## Private dev and staging

Both run the private-Anvil stack: a local chain, the app with its gate and wallet RPC, the quota
database, a token-gated log port, and an observer that logs container exits (with exit codes) and
per-container memory every five minutes. From the development VM:

```sh
cvm hosted dev                                   # status, Compose hash, images, containers
cvm hosted-compose dev > dev.json                # the live Compose
cvm deploy dev dev.json [--env dev.env.json]     # deploy an edited Compose; --env re-seals the secrets
cvm hosted-logs dev [CONTAINER]                  # container logs
cvm serial dev                                   # VM console: boot, kernel, OOM kills
cvm restart dev                                  # saves status, console and all logs first, then restarts
```

The same commands take `staging`. A re-seal replaces the whole secret set, so `--env` must carry every
value, not only the one that changed; the VM keeps the current sets. Staging also has a debug SSH
container with the Docker socket, for the keys listed in its Compose.

After a deploy, load the site through its gate. Container states can all read `running` while the site
is unreachable.

Private Anvil bootstrap must explicitly enable transaction-driven mining after disabling interval
mining: `evm_setIntervalMining(0)`, then `evm_setAutomine(true)`. On Anvil 1.7.1, disabling the interval
alone leaves transactions pending. Retain the application's stale-clock catch-up for contract
deadlines while the chain is idle; it is not a substitute for mining submitted transactions.

For an authorized correction of an existing inline bootstrap, prepare an owner-only candidate with
`node scripts/enable-private-anvil-automine.mjs before.json candidate.json`. The helper refuses
unknown or already modified bootstrap commands and does not deploy. Compare current live Compose
with the backup immediately before applying the candidate through the broker. Preserve images,
secrets and persistent volumes. Verify a test-operator transaction, idle block growth, existing
balances and the site after rollout; never reset the chain to solve confirmation latency.


## Data rules

- Fixtures are synthetic. Never commit a real trace, prompt, answer, key, token, mnemonic, wallet
  mapping or customer record. Tests that need a secret generate one at run time.
- No personal context in the tree, commit messages, PRs or reports: no personal names, handles,
  emails, home paths, machine hostnames, personal registries or repositories, and no hosted
  identifiers (CVM IDs, app IDs, gateway hostnames) unless they are deliberate public endpoints.
  The one accepted attribution is the vendored attest-proxy license and its pinned upstream.
- Logs are operational only: request IDs, status, timings, error codes, stage names. Never request
  bodies, trace or licensed content, or credentials. `tests/log-hygiene.test.ts` enforces this for
  the API; keep new log lines to the same standard.
- Commits use `Thot Market <development@thot.market>`. Releases use `Thot Market
  <release@thot.market>` with UTC timestamps.

## Releases

One image digest moves from dev to staging to production.

1. `node scripts/release.mjs` (a maintainer with `gh` signed in): exports `origin/main` with the
   branding and redaction checks, publishes it to the public repository as the next
   `vX.Y.Z-rc.N`, waits for the public checks, builds the image from that tag (the image build
   refuses a commit whose checks have not passed), creates the pre-release and prints
   `image@sha256:…`.
2. From the development VM: `node scripts/deploy-hosted.mjs dev IMAGE@DIGEST`, load the site, then
   the same for `staging` (its Safe approval is automatic).
3. Production: a maintainer promotes the same digest with the Safe-governed image update (inspect,
   prepare, approve, commit, verify) and checks health and the app.

`pnpm rc:dry-run` is for infrastructure changes (Compose, base image, boot path), not every release.

## Reading logs from a running CVM

Each CVM publishes a logs-only port (4330). With the environment's log token:

```sh
CVM_LOG_TOKEN=<token> node scripts/cvm-logs.mjs https://<app-id>-4330.<gateway>                      # containers
CVM_LOG_TOKEN=<token> node scripts/cvm-logs.mjs https://<app-id>-4330.<gateway> <container> --follow  # one container
```

The port can list containers and read their output, nothing else: container inspection, exec and
every write are refused. Tokens are issued per environment by a maintainer; on the development VM,
`cvm hosted-logs dev|staging` already uses them. A release-candidate dry run publishes the same
gate and filter on its disposable CVM with a token generated for that run, and checks the contract
itself: listing works, inspecting a container is refused (see `TESTING.md`).
