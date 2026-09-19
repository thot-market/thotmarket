# THOT receipt format: portable integrity example, version 1

**All data is synthetic. There is no TEE quote, hardware assurance, real provider
call, actual vault acknowledgement, or permission to sell.** A public test-only
seed generates the example signature; anyone can reproduce it. No private key
or upload credential is stored in the exported JSON.

Run with Node.js 24 or later, without installing packages or contacting a server:

```sh
node verify.mjs
# Or point the verifier at another copy of this exported directory:
node verify.mjs /path/to/export
```

Copy this whole directory to use it independently of the repository. The result
reports `integrity: valid`, two verified parts, and a valid signature **under the
supplied public key**. It also reports `hardware_evidence: ABSENT_UNVERIFIED`,
`recorder_identity: UNAUTHENTICATED`, and unsigned summaries as
`NOT_AUTHENTICATED`. Invalid or missing committed evidence exits with status 1.

## What to read

- `parts/1.json` and `parts/2.json`: original synthetic request/response records.
- `example.json` → `bundle`: actual `thot.proxy-capture/2` manifest fields.
- `example.json` → `evidence.statement`: actual recorder seal fields and signature.
- `example.json` → `evidence.attestation.statement`: recorder public signing and
  channel keys in the existing key-statement format. The hardware quote and
  event log are deliberately absent; this is not complete TEE evidence.
- `example.json` → `capture_receipt` and `capture_summary`: illustrative unsigned
  vault outputs using the existing shapes. This example uses `P0_OPERATOR`,
  never `P2_TEE`. Real ingestion would reject this fixture as TEE evidence.
- `locations.json`: an **unsigned example adapter map**, from existing exchange
  commitments to local file names. This is not a new THOT evidence-reference
  schema. Rename or move files and update this map; signed identity stays intact.

`example_format`, `warning`, and the wrapper arrangement exist only for this
teaching fixture, not as an ingestion or universal export protocol.

## The binding chain

1. Remove `commitment` from an exchange. SHA-256 of its UTF-8 canonical JSON is
   the exchange commitment. Bodies are base64 strings inside that JSON; hashing
   decoded response text or the entire part file is a different operation.
2. The `/2` manifest lists ordered `{sequence, commitment}` descriptors. Its
   `root` hashes the canonical manifest with `root` removed.
3. The recorder signs canonical JSON of its seal: `purpose`, `capture_id`,
   `client`, `consent_hash`, `bundle_hash`, `session_root`. `bundle_hash` hashes
   the entire bundle, including `root`. The included consent object is checked
   against `consent_hash`; a consent hash does not establish legal permission.
4. Hardware verification would authenticate the public key statement through a
   quote, replayed event log, approved measurements, and DCAP trust/collateral.
   This verifier does none of those checks. Adding a `quote` field only changes
   its output to `present_but_UNVERIFIED`.
5. Vault-generated receipt text, counts, trace IDs and confidence labels are
   unsigned interpretation. Altering them does not invalidate the recorder seal;
   they must not be treated as authenticated merely because integrity passes.

The example receipt's `raw_trace_hash` and `source_bundle_hash` follow current
ingestion: both hash `{...bundle, tee_evidence: evidence}`. They do not identify
the readable transcript. The example verifier authenticates original parts and
the recorder seal, **not** the unsigned receipt, summary, storage durability,
wall-clock truth, provider authorship, user identity, or complete conversation.

Canonical JSON here is THOT's current recursively sorted-key implementation,
not a claim of RFC 8785 conformance. `canonical.mjs` is a standalone JavaScript
copy of `packages/protocol/src/canonical.ts` in this tree;
repository tests check parity. This verifier supports the current `/2` integrity
chain only, not legacy `/1`, all ingestion validation, or arbitrary-size exports.
Its local adapter limits each JSON file to 1 MB and confines reads to the export.

## Component boundaries

The recorder emits original parts plus a signed manifest. A replaceable storage
adapter preserves encrypted bytes. The vault controls decryption/access,
retention, indexing, verification policy and durable acknowledgement. Market
workflows consume separately authorized releases. A file path, object-store key
or URL belongs in a placement map, not the signed provenance identity.

This example uses plaintext **synthetic** part files for legibility. Real evidence
needs the existing vault encryption/access controls or another reviewed custody
implementation. Moving bytes does not automatically transfer decryption keys,
ownership, retention responsibility or permission to process them.

Current integration boundaries still matter: capture upload tokens expire after
24 hours; the recorder periodically asks the vault authorizer whether recording
may continue. With explicit `until-saved` retention, the helper removes its encrypted local
part cache after a matching final vault response and fsynced local receipt; the
default keeps local bodies. Those behaviours are outside this
portable integrity example. Offline hardware verification additionally needs a
verified collateral/time/policy design; copying a quote is insufficient.

## Reproduce and test in the repository

```sh
node packages/provenance/examples/generate-receipt-format.ts
node --test tests/receipt-format.test.ts
```

The generator contains explicitly public test-only signing material. It never
calls a provider, recorder, vault, hardware verifier or market. Tests cover golden
regeneration, production canonicalization parity, altered bodies and signatures,
missing/reordered parts, changed unsigned summaries, unchanged identity after
locator relocation, and execution from a detached exported directory.

Implementation: [records and manifest](../../../capture/src/index.ts),
[keys and seal](../../../capture/src/tee/server.ts),
[signature binding](../../../capture/src/tee/attestation.ts),
[unsigned receipt](../../../market/src/agent-capture.ts),
[local retention](../../../capture/src/sync.ts), and
[hardware verifier](../../scripts/verify_recorder.py).
