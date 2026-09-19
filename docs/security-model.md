# Trace confidentiality, custody, and release security

This document describes the pre-release system's actual trust boundaries. It is
not a claim of production acceptance or a guarantee that recorded content is safe
to sell. The priorities are keeping private traces from unauthorized readers,
preserving recoverable data, and making intentional disclosures understandable.

## What is protected

Private prompts, model responses, tool results, code, brokerage evidence, provider
credentials, capture capabilities, wallet sessions, signing keys, and backups have
different lifetimes and recipients. A trace's title, owner mapping, timestamps,
purchase history, and ciphertext size can also be sensitive even without its text.

The API enforces the contributor's ownership on private trace reads. A buyer must
have the appropriate purchase and release authority. Capture-device credentials
authorize uploading for their owner; they do not authorize reading the owner's
whole vault. Delivery-link capabilities remain bound to an authenticated buyer
and expire; they are not anonymous object-store URLs.

Standing sale authorization intentionally permits future eligible recordings to
be offered automatically. Ordinary buyers get licensed content after purchase.
An opted-in reserve reviewer may inspect the stable one-in-20 sample, and eligible
dispute reviewers may inspect the disputed purchased release. These are authorized
plaintext recipients. Encryption cannot stop any recipient from keeping a copy.
Revocation stops the operations it explicitly governs; it cannot retract content
already delivered or erase someone else's copies.

Release assessment now runs locally. Configuring a legacy privacy-provider key
does not send traces to an external classification service. Receipts report
`baseline_only`. Baseline redaction catches selected patterns and supplied spans;
it cannot reliably identify confidential ideas, proprietary source code, all
names, or every credential format. Recording privately is the safer choice for
mixed-sensitive sessions. Automatic-sale consent must not be treated as a general
permission to send plaintext to additional service providers.

## Who is trusted with plaintext and keys

| Component or actor | Authority and limits |
| --- | --- |
| Contributor's computer and browser | See source content and authentication material. A compromised extension, provider tool, OS account, or page script can steal them before enclave protection applies. |
| Recorder | Sees the provider request and response. The attested capture channel binds its key to an accepted workload before sending credentials. Accepted measurements and verifier correctness matter. |
| Application process | Decrypts vault objects to perform authorized operations. A compromise of this process or its permitted runtime code can expose many users' data. Object-key derivation is not independent per-user custody. |
| Authentication provider and wallet | Establish identity/session authority. Wallet-signature verification does not protect a stolen browser session. Hosted role mappings are separate from arbitrary identity claims. |
| KMS and deployment authority | Determine which workloads can obtain application keys. Actual KMS policy and upgrade authority must be verified for the deployment; marketplace governance alone does not establish KMS control. |
| TLS ingress and serving origin | Protect the client connection and deliver browser code. Their termination point, image, DNS/certificate control, and upstream routing are part of the trusted system. |
| Model/brokerage providers | Receive the requests their integration intentionally sends. A provider's own service sees its input; local vault encryption does not hide that input from it. |
| Object storage | Holds encrypted vault objects, with metadata leakage such as sizes. It can delete or withhold objects. Encryption does not create backups or guarantee availability. |
| Database operator | Can see stored metadata. A database writer may alter ownership/session/release state that the application trusts; encrypting object blobs does not make a compromised database harmless. |
| Buyer and authorized reviewers | Receive only the permitted release through application checks. Once they have plaintext, onward-use restrictions depend on recipient behavior and enforcement. |
| Build, dependency, and release operators | Can influence executable bytes. Source review is only useful if the running image and delivered client are tied to that source and approved configuration. |

The local-file vault key is useful for disposable development, not isolation from
the machine's owner. dstack custody can restrict key release to an approved CVM,
but the approved application still receives the key. Cloud-managed and onchain
KMS policies have different administrators. Do not infer either policy from an
attestation badge or from the three owners of an unrelated marketplace contract.

## Expected attacks and defenses

An unauthenticated internet caller should not mint a development identity, obtain
a trace by guessing its ID, redeem another buyer's link, or use a provider API key
as vault authorization. A public bind or public reverse-proxy origin now requires
hosted configuration even when the chain configuration was accidentally omitted.
Development role selection is limited to the local development configuration.

An authenticated malicious user may upload hostile content, race requests, reuse
old capabilities, or guess another owner's IDs. Owner-scoped database reads,
capture-device revocation, release commitments, short-lived delivery links,
authenticated encryption, bounded input processing, and transaction guards are
the relevant controls. These checks need regression coverage on the exported
source as well as on private development source.

Captured text is untrusted data. Assays use a constrained feature interface and
an isolated worker; they are not a permission to run arbitrary buyer code over
private traces. Any future LLM appraisal or external processor needs its own
explicit data-release policy. Prompt injection can influence a model's output;
model confidence is not an authorization check.

Python modules in the application image are enumerated in
[`scripts/runtime-python-files.json`](../scripts/runtime-python-files.json).
They support witness, brokerage capture and evidence verification. The old
single-owner router and its separate settlement key are not application image
inputs or part of the public source distribution.

Resource limits reduce overload but do not guarantee service under attack. Shared
rate budgets, database capacity, disk exhaustion, provider outages, and RPC outages
can deny service. Admission limits are not a substitute for per-target monitoring,
storage headroom, and tested restoration. Never delete users' traces to make a
release or test pass.

## Storage and release compatibility

The first branded source baseline intentionally has distinct cryptographic
domains, KMS derivation paths, protocol signatures, and checksummed migrations.
It is not an in-place upgrade of earlier private state. Changing those identifiers
can make old ciphertext unreadable even with the same input master key.

Startup and maintenance now reject a foreign storage marker or unmarked
persistent state before opening a database or creating a key. A shared
`.trace-directory-lease`, together with the existing namespace lease, coordinates
new source projections and older same-namespace writers. A failed or interrupted
maintenance operation keeps its protective leases; automated recovery must never
clear a maintenance lease. Deployment recovery runs under the existing exclusive
process lock and checks the shared lease's storage namespace before archiving it.

This guard preserves existing bytes; it does not migrate them. Use fresh,
disposable data for a first branded staging deployment. Moving retained users
requires an explicit migration that preserves or re-encrypts their objects,
reconciles schema checksums, handles old signed evidence, and proves restoration
with the required old key and KMS identity. Never point two old/new deployments at
one live volume while trying this. Backups must be independent of the failure
domain they protect against; a ciphertext-only snapshot also requires recoverable
key custody and compatible decryption code.

Recorder pins identify actual executable bytes. Renaming a protocol string does
not update an existing recorder image. Build matching recorder/client artifacts
and verify their policy before accepting a branded deployment; do not weaken
signature or attestation checks merely to accept an old incompatible recorder.

## Contracts and verification limits

The included governor implementation permits one configured owner to execute,
with no governance notice delay in the controller itself. One owner key can execute governor-authorized actions, subject to
the target contract's limits. It is not a two-party approval boundary. Dispute
review is likewise concentrated, and small buyers below the dispute spend gate
rely on the operator's delivery attestation. These are material trust assumptions,
not problems resolved by encrypting traces.

The legacy `ThotReserveVault` successor path checks a recipient's `token()` getter,
which does not prove the recipient is a constrained vault. After its campaign
sunset, authorized governance can transfer remaining funds to a contract that
imitates that getter. Treat this as privileged withdrawal authority if using that
legacy reserve. The newer campaign reserve has no successor-transfer path.

Review the flattened source actually used for the artifact. Private deployment
tooling, extension code, image recipes, verifier dependencies, ingress settings,
and secret injection also affect security. Necessary build and client sources
belong in the verification surface. A passing source test does not establish a
running workload's image, KMS policy, TLS termination, or backup recoverability.
Acceptance must bind the exact source, image digest, complete compose/config,
recorder measurements, client delivery, and key-release policy together.

## Trace claims to implementation

| Boundary | Implementation | Regression coverage |
| --- | --- | --- |
| Account and owner authorization | [API](../apps/api/server.ts), [access policy](../packages/auth/src/access.ts) | [Security boundaries](../tests/security-boundaries.test.ts), [delivery links](../tests/delivery-links.test.ts) |
| Recorder identity before credentials | [Client](../packages/capture/src/tee/client.ts), [attestation](../packages/capture/src/tee/attestation.ts) | [TEE capture](../tests/tee-capture.test.ts), [authorization](../tests/recorder-authorization.test.ts) |
| Private state and recovery | [Vault](../packages/vault/src/index.ts), [operations](../packages/operations/src/index.ts) | [Storage operations](../tests/storage-operations.test.ts), [encrypted backup](../tests/encrypted-backup.test.ts) |
| Local baseline filtering | [Scrubber](../packages/scrubber/src/index.ts) | [Privacy](../tests/privacy.test.ts), [integration privacy](../tests/integration-privacy.test.ts) |

These are source and test references, not evidence that a live deployment passed
them. See [verification](../VERIFYING.md) for the separate artifact and workload links.
