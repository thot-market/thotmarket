# What a verifier checks

This guide separates checks you can perform on the source and synthetic examples
from checks requiring independently trusted artifact or deployment evidence.

## What this tree establishes

| Subject | Available here | Not established here |
| --- | --- | --- |
| Source | Inspectable snapshot; identify a Git checkout with `git rev-parse HEAD` | An authenticated publisher merely from a downloaded tree |
| CLI | Package manifest, source allowlist and build recipe | A published npm artifact bound to this source |
| Local behavior | Explicit synthetic test suites in [TESTING.md](TESTING.md) | A passing result until you run them on the selected snapshot |
| Capture integrity | [Offline synthetic example](packages/provenance/examples/receipt-format-v1/README.md) and tampering tests | Authentic recorder identity or complete activity coverage |
| Hardware verification | Verifiers and labeled historical fixtures | A fresh quote for the service you will use |
| Runtime image | Build and image-evidence verification code | An issued image digest, provenance bundle or independently matching build |
| Live service and updates | [Security boundaries](docs/security-model.md) and the checks below | Accepted workload/endpoint pins, KMS policy or deployment evidence |

This is an unaccepted source preview. Version strings and included policy files
are not evidence of a compatible live deployment. Obtain exact artifact digests,
trusted identities and current deployment evidence separately; missing evidence
means that link remains **not checked**.

## Try an offline integrity check

From the repository root, with Node.js 24+:

```sh
node packages/provenance/examples/receipt-format-v1/verify.mjs
node --test tests/receipt-format.test.ts
```

The example reports valid integrity under a supplied synthetic key, with hardware
absent/unverified and recorder identity unauthenticated. The tests cover changed
bodies/signatures, missing or reordered parts and unsigned summary changes. This
requires no account or provider connection. Follow the example README for the
precise signed fields and limitations.

Start with a project release tag and the maintainer identity you independently
trust. Values supplied by the server being checked are evidence, not trust pins.

## 1. Software and build identity

A public release should provide:

- Source archive, immutable annotated tag and exact public source commit.
- `SHA256SUMS`, image OCI manifest digest and dependency lockfile.
- Build provenance and a dependency SBOM from that exact build.
- Downloadable Sigstore attestation bundles for offline verification.
- Release notes, licence and the expected public builder/workflow identity.

Verify an artifact from a release after replacing the project placeholders:

```sh
sha256sum --check SHA256SUMS
gh attestation verify source.tar.gz -R PUBLIC_OWNER/PUBLIC_REPO
gh attestation verify oci://ghcr.io/PUBLIC_OWNER/IMAGE@sha256:OCI_MANIFEST_DIGEST \
  -R PUBLIC_OWNER/PUBLIC_REPO
```

These are proposed commands: they require actual attestations produced by the
approved public build workflow. Hash matching alone does not authenticate a
publisher. Review the attestation subject, source commit, workflow and issuer
against the independently selected release policy, not merely any valid signer.
Release-source packaging provenance and runtime-image build provenance are
different subjects and must both be identified accurately.

For a candidate produced by `cvm-image.yml`, first obtain the digest from its
retained `image-release.json` and compare that record with the independently
reviewed tag and commit. The registry digest can be checked with GHCR read
access, independently of whether a signature was issued.

When the repository is private, the image workflow skips GitHub artifact
attestation but still publishes the OCI digest and retains `image-release.json`,
`build-snapshot-manifest.json`, `attestation-status.json`, and `SHA256SUMS`.
The status file then says `not-issued` with reason `private-repository`; no
Sigstore bundles exist. Check these records against the tag, workflow run, and
registry digest, but do not call the private build signed or provenance-verified.
For either visibility, after replacing the values with independent expectations:

```sh
sha256sum --check SHA256SUMS
docker buildx imagetools inspect ghcr.io/thot-market/thotmarket@sha256:OCI_MANIFEST_DIGEST
test "$(sha256sum build-snapshot-manifest.json | cut -d ' ' -f 1)" = \
  "$(jq -r '.build.snapshot_manifest_sha256' image-release.json)"
jq -e --arg commit EXACT_SOURCE_COMMIT \
  --arg tag vX.Y.Z-rc.N \
  --arg image ghcr.io/thot-market/thotmarket@sha256:OCI_MANIFEST_DIGEST \
  '.source.repository == "thot-market/thotmarket" and
   .source.commit == $commit and .source.tag == $tag and
   .builder.workflow == ".github/workflows/cvm-image.yml" and
   .builder.ref == ("refs/tags/" + $tag) and
   .image.pinned_reference == $image and
   .deployment.compose_hash == null' image-release.json
```

GHCR authentication and package-read access may be needed for the registry
inspection. These checks establish internal consistency and registry presence,
not an authenticated build origin.

The following attestation commands apply only when bundles were actually issued
by a public-repository run. A later signature does not retroactively prove a
previous private build unless it names and verifies that exact digest:

```sh
gh attestation verify oci://ghcr.io/thot-market/thotmarket@sha256:OCI_MANIFEST_DIGEST \
  -R thot-market/thotmarket \
  --signer-workflow thot-market/thotmarket/.github/workflows/cvm-image.yml \
  --source-ref refs/tags/vX.Y.Z-rc.N --source-digest EXACT_SOURCE_COMMIT

gh attestation verify image-release.json \
  --bundle image-release.sigstore.json \
  -R thot-market/thotmarket \
  --signer-workflow thot-market/thotmarket/.github/workflows/cvm-image.yml \
  --source-ref refs/tags/vX.Y.Z-rc.N --source-digest EXACT_SOURCE_COMMIT
```

The public build-run artifact also contains Sigstore bundles for the image and
release record. The record deliberately leaves `compose_hash` null: a full provider
manifest and Safe approval are separate deployment evidence. GitHub's image
attestation binds the OCI digest to its workflow identity; it does not prove
reproducibility or which bytes a CVM is running.

Use these as separate reference values when preparing an onchain-KMS CVM update:

| Evidence | Value to carry forward | Check |
| --- | --- | --- |
| Checked `image-release.json` and, if issued, verified image attestation | `image.pinned_reference` (`ghcr.io/...@sha256:...`) | Exact image reference in each proposed Docker Compose service intended to use this image; unsigned private records do not establish builder identity |
| Image release record and attestation status | `source.commit`, `source.tag`, `builder.workflow`, build snapshot hash, signing status | Independently reviewed source; expected signer identity only when attestation verification passes |
| Provider's prepared **full app-compose manifest** | Provider `compose_hash` and app ID | Exact manifest, image references, configuration and expected predecessor; this hash is the proposed `DstackApp.addComposeHash` argument |
| Onchain approval and final CVM evidence | Approved compose hash and observed measurement | Same prepared hash was approved, committed and observed for the intended app |

The GHCR digest is an input to the reviewed Compose configuration. It cannot be
converted into the full compose hash: other images, settings and the provider's
full app-compose envelope also matter. Obtain the hash through the provider's
prepare flow, compare the returned full manifest with the reviewed proposal,
then use **that exact hash** in the Safe transaction. Keep the image digest in
the operator's governance proposal as a separate cross-check. Verify the same
hash after commit and in fresh workload evidence; an approved hash alone does
not show that the intended image is running.

Sigstore proves the signing/build identity and artifact binding. It does not
prove that a deployed enclave runs the artifact, that the code is correct, or
that an independent build reproduced it byte for byte.

## 2. Deployment and live enclave identity

A deployment statement should bind the release and image to:

- Environment and immutable deployment revision.
- Expected app ID, complete dstack app-compose manifest and its hash.
- OCI image digest, loaded Docker image ID and encrypted-image archive/manifest
  hashes where used. These hashes have different meanings.
- Independently approved OS/boot measurements, verifier version and hash.
- KMS/update mode and the actual policy that authorizes workload changes.
- Public origin/TLS policy, chain ID and contract/runtime code pins.
- Fresh evidence collection time, acceptance scope and unresolved checks.

Fetch fresh quote/certificate/event-log evidence and verify Intel DCAP status,
non-debug attributes, quote-to-key binding, event-log replay, approved OS boot
measurements and expected app/full-manifest identity. Freshness and an explicit
endpoint-to-attested-key binding must be checked separately; a previously saved
successful verdict is not a fresh proof. The public release must ship the
reviewed verifier, its dependencies and concrete invocation before this step
is advertised as available.

Do not accept the live server's self-reported image/tag as proof of its measured
workload. Do not describe marketplace contract governance as enclave update
governance unless that KMS policy actually enforces it.

## 3. An individual capture

For a capture shared by its authorized owner, independently check its content
commitments, ordered manifest, signed checkpoint, consent binding and approved
recorder signing/channel-key attestation. This is separate from verifying the
marketplace application's deployment. An observed answer must match the saved
response bytes. A checkpoint covers its prefix, not later or bypassed traffic.

Private conversations, tokens, owner keys and personal proof packages are not
public release assets. Use the synthetic portable verifier example for public
demonstrations; authorized real-capture checks remain owner-scoped.

## Expected presentation

Publish separate results for software provenance, live workload/TLS binding,
recorder identity and capture integrity. Each result should say passed, failed
or not checked, identify the exact version/digest and evidence time, and explain
the remaining trust assumption. An overall green badge must not hide an
unchecked link in this chain.

## References

- https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
- https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline
- https://docs.sigstore.dev/cosign/verifying/verify/

## Encrypted Docker archive releases

For the encrypted `docker save` delivery path, the release artifact is a gzip
archive, and the Docker image ID is a config digest. Neither is an OCI registry
manifest digest. Do not run `cosign verify IMAGE@DIGEST` against an image ID.

For a deployment using encrypted image delivery, the verifier expects `image-archive.sigstore.json`,
`image-release.json`, `image-release.sigstore.json` and
`build-snapshot-manifest.json`. The signed release record binds the exact
archive SHA-256 and Docker image ID to the source commit, effective source
snapshot, environment recorder-policy override, pinned DCAP verifier, encrypted
package manifest and full intended workload manifest. It is a custom signed
build/deployment statement, not a SLSA-level certification or live deployment
success claim. This tree does not include an automated image-build/signing lane
or issued copies of these assets.

Install Cosign 3.1.3 and Node 24. Obtain the archive through authorized decrypted
access; provenance assets do not contain it or its encryption key. Obtain the
expected workflow identity, revision, image ID and full workload hash from an
independently reviewed release policy, not by trusting values in the record.
Then run:

```sh
node scripts/verify-image-release.mjs \
  --record image-release.json \
  --record-bundle image-release.sigstore.json \
  --archive image.tar.gz \
  --archive-bundle image-archive.sigstore.json \
  --snapshot-manifest build-snapshot-manifest.json \
  --identity INDEPENDENTLY_APPROVED_SIGNING_IDENTITY \
  --revision REVIEWED_SOURCE_COMMIT \
  --image-id sha256:REVIEWED_DOCKER_IMAGE_ID \
  --workload-hash REVIEWED_FULL_WORKLOAD_HASH
```

A successful result checks signatures, archive bytes, snapshot-manifest bytes
and independent release pins. It explicitly reports live CVM attestation,
archive-content/image-ID inspection, and reproducibility as `NOT CHECKED`.
Use the separate DCAP/live-workload verifier for the running CVM; inspect the
archive's image config or reproduce the build to test the builder's claim.
Without authorized archive access, the record signature alone cannot verify
its image bytes. Evidence must be obtained from the artifact publisher and checked against
independently approved pins; no retention or availability is promised here.

Read [the trace security model](docs/security-model.md) alongside these checks. It
explains plaintext recipients, key custody, private deployment authority, baseline
filtering, and the fresh-storage requirement for the first branded release.

The default recorder and brokerage measurement files are inert templates: they
contain no accepted workload instances. Supply independently reviewed policy
for a compatible deployment; historical private pins are not distributed as
accepted defaults. Do not disable verification to make these templates connect.

The image verifier accepts an exact GitHub workflow identity of the form
`https://github.com/OWNER/REPO/.github/workflows/FILE.yml@refs/tags/TAG`
or an exact `refs/heads/BRANCH` identity. Select that identity independently;
there is no trusted default branch. Signature verification and the signed record
must both match it. An identity accepted by the tool is not evidence that this
repository has produced a signed image.
