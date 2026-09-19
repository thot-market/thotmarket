# Encrypted remote vault placement

Local placement remains the default. An opt-in S3-compatible backend (including R2) stores only the existing authenticated encryption envelopes. Original object IDs, ciphertext, evidence commitments and owner references survive migration. Keys and plaintext processing stay in the application; using this adapter does not establish production readiness or change KMS approval.

The transaction and interruption protocol for current imports and captures is documented in [short transactions for ciphertext storage](staged-storage.md).

## Capacity philosophy

Contributors should not manage storage quotas. These are internal anti-abuse admission ceilings, not fixed product entitlements or a judgment about a trace's worth. We want useful contributions to grow. Retention volume, processing rate and concurrency are separate budgets; a large legitimate archive does not justify unlimited concurrent import work. Never infer value from an uploader's claimed appraisal or automatically send private content to a model to decide admission.

Operators can grant additional per-owner capacity without restarting writers or changing the namespace policy. The trusted administrative command requires an explicit `THOT_QUOTA_ADMIN_DATABASE_URL` credential reference, records the database actor, before/after allowance and reason, and cannot exceed the shared operational budget or reduce capacity below already retained usage:

```sh
node scripts/set-vault-allowance.ts \
  --owner CONTRIBUTOR_ID --bytes 107374182400 --objects 500000 \
  --reason 'Retain additional research contributions'
```

The separate variable is a tooling safeguard, not enforced separation of database privileges; provision least-privilege database roles operationally. No THOT balance or purchase is required for the default contributor allowance.

Grants take effect across writers immediately. There is no importer route or quota-settings UI for this capability. Shared capacity should be expanded through operator planning, monitoring and independently retained backups. The adapter does not implement automatic extension, a durable upload queue, operator notifications or user-requested extension workflow; failed saves preserve the selected draft and ask the contributor to retain/retry their file.

## Configuration

Set these in the sealed application environment, never in public site configuration:

```text
THOT_OBJECT_STORAGE=s3
THOT_S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
THOT_S3_REGION=auto
THOT_S3_BUCKET=private-vault
THOT_S3_PREFIX=pilot/objects/
THOT_STORAGE_NAMESPACE=pilot
THOT_S3_ACCESS_KEY_ID=<secret>
THOT_S3_SECRET_ACCESS_KEY=<secret>
THOT_QUOTA_DATABASE_URL=<private PostgreSQL connection URL>
```

For AWS S3 use the intended regional endpoint and region. HTTPS, a nonempty isolated prefix, and explicit credentials are required. Use separate prefixes/namespaces for independent environments. Every replica serving the same objects must use the same placement, namespace and quota policy. Policy/placement mismatches fail closed; the data-directory format records a placement identity so a bucket/prefix change cannot silently strand existing references. Credentials are not included in that identity.

Creating a new namespace requires the one-time `THOT_REMOTE_STORAGE_INITIALIZE=true` setting. Use it only for an intentionally empty destination, then remove it from the sealed environment. Normal startup refuses a missing ledger namespace rather than silently starting quota counters at zero after database loss. Restoring an older ledger still requires inventory reconciliation before intake; this implementation cannot detect an otherwise valid stale snapshot automatically.

The quota database can be separate from the application database; its tables use the `remote_vault_` prefix. The ledger commits independently of application metadata transactions, so a failed import cannot forget uploaded objects. All replicas serialize short quota updates on the namespace policy row; network/storage work does not hold that row lock. Portfolio confirmations return just the saved item, and portfolio metadata reads run with bounded concurrency outside the database lock. Original import writes and other existing paths still use the application-wide service lock; moving those side effects out requires durable staging and remains a hosted availability gate.

Default **remote** limits count actual serialized envelope bytes, including encryption/base64 overhead:

| Scope | Bytes | Objects |
| --- | --- | --- |
| Owner | 10 GiB | 100,000 |
| All user intake | 1 TiB | 10,000,000 |
| Operator journal | 1 GiB | 100,000 |

Override with a complete `THOT_REMOTE_QUOTAS` JSON object containing `ownerBytes`, `ownerObjects`, `userBytes`, `userObjects`, `journalBytes`, `journalObjects`. These are pilot policy defaults, not measured capacity or a user-facing storage promise. Policy is durable and mismatched writers are rejected; changing an established namespace policy needs an operator-coordinated ledger change with writers stopped. Per-owner grants use the live administrative capability above. Existing local limits remain unchanged.

## Failure behavior

Uploads use conditional `If-None-Match: *`, one SDK attempt, a 30-second operation deadline, and Content-MD5. Reads enforce both declared size and bytes actually streamed, and terminate stalled bodies. Provider `NoSuchKey` maps to ENOENT; missing buckets, access denial and outages remain failures. No fallback writes to CVM disk occur.

Admission reserves bytes/objects before encryption or remote upload. A crash, timeout, key failure or SQL metadata rollback leaves the reservation counted. An ambiguous provider response must never free capacity: the provider may have accepted the object. Pending objects need operator reconciliation; there is no automatic reservation expiry or garbage collector in this implementation. Inspect pending rows and preserve them until quiesced verification establishes whether the bytes exist. Verified accepted objects can transition to stored with matching owner/size; operators must not decrement counters speculatively.

Deletion authenticates ledger ownership and the envelope, records deletion intent, deletes remotely, and then releases counters. A crash after deletion can retry using ledger ownership even when the object is absent. Failed deletion retains capacity. Tombstones prevent reusing old object IDs. User intake cannot select the separately reserved operator-journal class.

## Copying existing encrypted objects

Stop all source writers first. Keep the original complete state and a tested backup. Run inside the original approved key-custody boundary, with remote configuration above:

```sh
node scripts/migrate-vault-objects.ts \
  --source /data/thot \
  --manifest /private/migration-manifest.json
```

The tool takes the exclusive source maintenance lease. For hosted external keys it requires `THOT_MASTER_KEY_SOURCE=dstack` and the original authorized dstack socket/identity. Local-key sources require the existing private `local-vault.key`. It authenticates each source envelope, reserves remote capacity, copies ciphertext unchanged and reads it back byte-for-byte. Existing identical destination objects can be verified and resumed without extra quota charges. It never deletes source objects or changes source format/database references. The manifest is private (owner IDs/object IDs) and created exclusively with mode 0600; stdout reports only counts and its digest.

An interrupted copy with a missing destination remains pending and needs reconciliation; rerunning does not overwrite or guess whether a pending write is safe. This tool is the object-copy phase, not an automatic full state cutover.

Before serving migrated inventory, restore/copy the matching metadata state to an isolated replacement, establish the intended external-placement format identity, and verify original evidence, owner isolation, library reads and deletion retries under approved key custody. Do not hand-edit a running source's format marker or discard the source rollback copy. The old local backup helpers deliberately reject remote layouts rather than produce an incomplete recovery archive.

## Recovery and scaling acceptance still required

Remote placement is not an independent backup. Application credentials with delete permission must not also control retained backup deletion. Retain encrypted database/config snapshots, the quota ledger, and a consistent object inventory/copy using separate credentials/retention authority. Test recovery with the original CVM and primary object placement unavailable; retain the approved KMS identity/policy and independently trusted manifest. Missing namespaces and mismatched policies fail startup. Operators must keep intake stopped when restoring a stale ledger until inventory reconciliation establishes accurate counters.

Scheduled snapshots, backup-age alerts, object retention/replication, full metadata cutover automation, KMS disaster recovery, SQL-record abuse budgets, representative provider acceptance and two-API replica interference are not established by this source candidate. Neither S3 nor R2 storage alone proves a 100/1,000-user workload safe. Keep one settlement coordinator; recorder live sessions remain pinned and fleet routing is separate work.

## Validation

```sh
pnpm typecheck
node --test tests/remote-vault.test.ts tests/s3-store.test.ts tests/vault-quotas.test.ts tests/ciphertext-store.test.ts
THOT_QUOTA_TEST_DATABASE_URL=<disposable PostgreSQL URL> node --test tests/remote-quota-postgres.test.ts
```

The S3 tests exercise actual SDK signing/commands through a synthetic transport, including oversize and stalled streams. PostgreSQL tests use independent pools. JSONL integration exercises private import, restart/read and deletion without a local objects directory. The PostgreSQL test requires a separately supplied disposable database; the declared public suites do not run that test. cloud provider/KMS deployment acceptance remains separate.

Provider contracts: [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
