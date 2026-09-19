# Thot source and release identity

Project-owned source is MIT licensed, copyright Thot Market. The command is `thot`
and the npm package is `@thotmarket/cli`. This monorepo contains the CLI, services,
contracts, build inputs and independent verifiers. CLI versions and container
versions can release independently; record their compatibility and exact digests.

The first branded source candidate uses THOT environment variables, local state
paths, token symbols and signed protocol domains throughout. It is a distinct
first-release baseline, not an automatic migration of an earlier private runtime.
Do not point it at an existing database or evidence directory without an explicit
migration and compatibility review. Migration files describe this new baseline;
they do not establish compatibility with a previously deployed schema. Startup now
rejects foreign storage markers and unmarked persistent state before opening it.
The shared directory lease is intentionally independent of branding. See
[the security model](docs/security-model.md) for key custody, privacy, and recovery.

Public test-only fixture signatures and commitments are regenerated under these
protocol domains. Their published seeds are synthetic and confer no production
trust. Recorder policy measurements and image digests still refer to their actual
bytes; descriptive registry names cannot establish a renamed workload's identity.
Build and verify new runtime artifacts and recorder policies from this source
before deployment acceptance. No hosted acceptance is implied by a source export.

Build the CLI in `packages/thot-cli` with `npm run build` and `npm pack`.
Use `thot setup claude`, `thot setup codex`, and `thot --help` to inspect it.
Use `--thot-url` or `THOT_URL` to select a vault and `THOT_RECORDER_POLICY_FILE`
to explicitly select an independently reviewed recorder policy when needed.
There are no installation scripts and the CLI does not install the provider tools.

A release review must scan source paths, file bytes, package tarballs, build logs,
container metadata and the final independent Git history. A source scan alone
does not establish that a built image or an earlier draft archive is clean.

The default recorder and brokerage measurement files are inert templates: they
contain no accepted workload instances. Supply independently reviewed policy
for a compatible deployment; historical private pins are not distributed as
accepted defaults. Do not disable verification to make these templates connect.
