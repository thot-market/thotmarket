# Developing Thot Market

This repository is where Thot Market is developed. Public source releases are flattened from it, so
everything here should make sense to someone with no access to any particular person's machine,
accounts or notes. If a change only works because of something you know that isn't written down in
this tree, it isn't finished.

Most work is done by development agents. People write the tasks, read the results, and decide what
ships.

## The loop

1. A steward writes a task in `steering/NNNN-slug.md` from `steering/TEMPLATE.md`: the goal, checkable
   success conditions, what is out of scope, and what the agent is authorized to do. The task lands on
   `main` through its own `steering/NNNN-*` PR.
2. An agent is dispatched on the task by name. It works on `task/NNNN-*`, runs the tests the task
   names, and opens a PR against `main`.
3. When the success conditions hold, the agent merges its own PR. The PR is the record, not a gate.
   Before merging it commits a wrap-up page, `reports/NNNN/index.html` (built by
   `scripts/build-task-report.mjs`): the ask, the outcome, the evidence, the commits.
4. Anything left over becomes a new task file. Closed tasks are not edited.

`steering/README.md` has the exact rules the agent follows. A steward reviewing the outcome should be
able to read the report page and the PR without running anything.

## What an agent may do

By default, and never more than the task's Authorization section says: change code in this
repository, run tests, launch disposable CVMs named `agent-*` through the `cvm` client, push its
task branch, and open and merge its PR. Deploying to private dev or staging needs a task that
authorizes it. Production is never deployed from the development environment, and nobody there
publishes releases or modifies other branches.

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
| Disposable CVM | The candidate image actually boots and serves in a TEE, and answers on its logs-only port | `pnpm rc:dry-run <commit>` (see `TESTING.md`) |
| Private dev, staging | Persistent state, real registries, on-chain approval (staging) | `cvm deploy dev`, then `cvm deploy staging`, from the development VM |
| Production | The live market | Maintainers only, from a tagged release |

`TESTING.md` lists the exact suites and their prerequisites. A task should name the steps it needs
and put their output in its report.

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

A release candidate is a commit on `main`. A maintainer exports it with the file allowlist, reviews
the export (identity, redaction, the diff since the last release), tags `vX.Y.Z-rc.N`, builds the
image once, and runs it on a disposable CVM (`rc:dry-run`). The same image digest then goes to
staging and, after acceptance there, to production. Each step is recorded with the commit, the image
digest and the Compose hash it produced.

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
