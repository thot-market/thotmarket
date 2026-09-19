# Short transactions for ciphertext storage

Imports, capture parts, raw checkpoints/completions and readable capture
projections prepare external objects outside the global application transaction.
The lock remains the coordinator for short metadata transitions. This does not
introduce multiple vault writers or change key custody.

## Write sequence

1. A short transaction checks the actor/key request commitment, claims a unique
   attempt and gives it a lease. Completed command results keep their existing
   idempotency representation. Concurrent same-key callers in one application
   share the pending result; another process receives a retryable response.
2. Each encrypted object gets a unique owner-bound reference in the attempt
   record **before** its upload starts. The record contains only references and
   status, never plaintext, credentials or serialized provider requests.
3. Verification, assessment, object reads and ciphertext uploads run outside the
   application transaction. A confirmed upload changes its staged status to
   `stored` in a short transaction. The independent quota ledger retains its
   existing reservation and storage transitions.
4. Commit rechecks the current attempt, lease, owner disablement and the domain
   state. Capture commits also recheck expiry and device authority. Ordered
   checkpoints retain prefix/time checks. Projections check current root,
   retention, deletion and the snapshot version so an owner edit or a newer save
   cannot be overwritten. State conflicts retry preparation at most twice.
5. One transaction publishes the domain references and idempotent result, marks
   the attempt committed and fences its claim. Competing logical duplicates
   return the existing record and leave their unused ciphertext reclaimable.

A single application admits at most 16 preparing operations; same-key joins do
not consume another slot. Admission overflow returns `STORAGE_BUSY` with HTTP
503 and `Retry-After: 1`. Another process holding the same key returns
`STORAGE_OPERATION_IN_PROGRESS`. An attempt has a 180-second operation budget
shared across its preparation retries; the lease prevents publishing after that
budget. Existing S3 requests have their own bounded transport timeout. This is a
commit deadline, not a promise that arbitrary injected dependencies can be
cancelled or that all client responses arrive within 180 seconds.

A failed staged command retains its input commitment. Reusing that key with
changed input returns `IDEMPOTENCY_CONFLICT`, even when its first attempt failed.
Use a new key for a changed operation.

## Interruptions and cleanup

Every unfinished attempt remains addressable after a process restart. The worker abandons
expired active attempts and reclaims only confirmed, unreferenced objects. A
cleanup pass handles at most 16 objects with at most four deletes in flight.
Referenced committed objects are never reclaimed by this path. A deletion
outage retains its record and conservative quota charge for retry.

If provider acceptance or the confirmation update is ambiguous, the reference
remains `pending`. It is not automatically deleted or uncharged on timeout.
Cross-store reconciliation must verify its actual storage/accounting state;
this change supplies its durable identity but does not implement that separate
recovery procedure. Maintenance statistics count these unresolved objects.

Readable projection and superseded-projection deletion jobs claim a durable
outbox lease before I/O and complete with a matching claim token. Expired claims
can be retried after interruption. Superseded encrypted projection references
are persisted in the deletion job and never reactivated. Original capture
bundles, parts and receipts are retained under the existing retention policy.
Capture proof reads use a metadata snapshot, read outside the lock and recheck
owner/deletion/retention access before returning content.

Other service paths, including some library, marketplace and retention work,
still have external work inside the legacy coordinator. This is a scoped save
fix, not a complete global-lock removal or a cross-store backup implementation.

## Measurements and acceptance

Maintenance roles can read aggregate transaction and staged-object timing
histograms at `/v1/maintenance/stats`, plus active and unresolved staged counts.
Timing series contain fixed operation/kind/outcome labels, no owner IDs or
content; they cover the current process lifetime and reset on restart.
`createApplication` also accepts opt-in transaction/object timing observers.

The disposable `scripts/benchmarks/storage-lock.mjs SOURCE OUTPUT.json 100`
compares 1/2/4/8 import and capture bursts with a 100-ms object-I/O fixture, real
vault encryption and independent SQL quota accounting. It accepts a local source
path, not a hosted URL. It excludes HTTP authentication, model calls, DCAP,
real R2 network behavior and sustained background load. Hosted acceptance must
rerun the real Haiku driver and sustained mixed workload on the exact candidate.

Migration `006_staged_storage.sql` adds durable claims/attempts and leased
outbox claims. Existing migrations are unchanged. Older application images
reject the newer schema; rollback needs a reviewed restoration plan. The cold
prestart snapshot now targets 006, but it is not a consistent backup of external
ciphertext and the independent quota database. Cross-store restore remains a
separate launch gate.
