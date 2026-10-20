# Reusable trace quality checks

The first version checks a selected saved conversation for structural problems,
missing tool evidence, repeated assistant text and credential-shaped material.
It produces review signals, not an estimate of sale price or proof of task success.
The package works without the marketplace, a database or a model-provider key.

## Owner journey

Upload a conversation, sync coding history, or finish a recording. The server
queues local checks automatically; the browser can be closed. **My work** shows
**Queued for checks**, **Checking**, **Checked**, **Needs attention**, or
**Check unavailable** beside each conversation. Grouped recordings show counts,
so one checked recording does not hide an unchecked or flagged recording.

Opening the reader shows a compact status above the conversation. Expand
**Review findings** or **Check details** only when needed. Inside the details,
choose **Private copy**, **Sale version**, or an individual recording. Changing
the selection immediately clears the previous result and feedback. Preparing a
sale version schedules its own checks; it does not reuse the private-copy status.
A running capture waits until its saved content is ready to check.

Saved results and human feedback survive reload. The current pending reader
polls status, stops on close/completion/account change, and does not depend on
wallet balance loading. The library separately refreshes to discover newly
uploaded or synced records. **Retry check** appears only for a retryable technical
failure. A completed quality finding is not an execution failure and has no retry
button. The normal journey has no **Run checks** step.

**Looks right**, **Something is wrong**, and **Not sure** save owner feedback tied
to the selected source and report. This feedback is an unverified assertion, not
a training label or sale consent. The details explicitly distinguish local checks
from AI review, task success, pricing and sale authorization.

Results remain owner-private. QC does not modify a trace, release, price, listing,
wallet, sale authorization or purchase. A `reject` result is a QC finding; it does
not add a marketplace enforcement gate. Existing release rights and sale checks
continue to apply independently.

## Standalone CLI

Use Node.js 24+ from this checkout:

```sh
node scripts/trace-qc.ts --input tests/fixtures/qc/complete.json
node scripts/trace-qc.ts --input tests/fixtures/qc/complete.json \
  --scope release --format html --output /tmp/trace-quality-report.html
```

Input is a JSON object with a `turns` array. Every turn has a supported `role` and
string `content`; structured tool calls use `tool_calls[].id`,
`tool_calls[].function.name`, optional `function.arguments`, and matching tool
results use `tool_call_id`. Other JSON metadata is included in the content digest.
The synthetic fixture demonstrates this shape. Flattened history without tool
identifiers cannot establish call/result linkage; the check reports missing evidence.

Limits are 2 MiB of canonical JSON, 1,000 turns, depth 64, and 100,000 JSON nodes.
Unsupported, oversized or malformed inputs are not truncated and scored as complete.
The CLI also bounds input file bytes and refuses symlinks and non-regular files.
Output files are created with owner-only permissions and must not already exist.
Completed `pass`, `flag` or `reject` reports exit 0; unparseable/oversized input or execution/I/O
failure exits 2. Consumers must inspect `status`, not just the exit code.

## Library contract

```ts
import {runTraceQc, runSemanticQc} from '../packages/qc/index.ts';

const report = runTraceQc(content, {scope: 'private'});
// No provider supplied: returns not_run without network access.
const semantic = await runSemanticQc(content, undefined, {scope: 'private'});
```

`trace-qc/v1` binds a result to `content_digest` (SHA-256 of canonical JSON),
`scope`, and `policy_version`. This is a content commitment, not a signature.
Source identity and source changes are tracked separately by the API. Change the
policy version when check logic, rubric semantics or the result contract changes;
existing cached reports are immutable.

| Field | Meaning |
| --- | --- |
| `status` | `pass`, `flag`, `reject`, or `error` for the deterministic checks |
| `findings` | Fixed codes/messages, severity, zero-based turn indices and occurrence count; no copied source excerpts |
| `checks` | Each check's status, including `not_applicable`, and evaluated turn indices |
| `coverage` | Turn counts; `truncated: false` means no hidden sampling |
| `semantic` | `not_run` for the deterministic report; this is not a semantic pass |

A tool result that contains a recognized success phrase is still unverified.
An error phrase can describe a legitimate failed attempt followed by recovery;
even `0 tests failed` can trigger an error regex. Unrecognized output stays
unassessed. Repetition needs human context. Credential patterns can have both
false positives and false negatives; passing them does not certify privacy or
detect all personal information.

## Optional semantic adapter

`runSemanticQc(content, provider, options)` accepts an explicitly supplied async
function. It receives `messages`, an `AbortSignal`, rubric ID and rubric hash.
There is no default endpoint, environment-key lookup, automatic retry, or use of
the owner's inference/relay credentials. The owner API and browser do not call
this adapter. An integrating application must choose and authorize any provider,
handle data egress and charges, and honor cancellation itself.

The adapter retains the OpenJudge trajectory-accuracy 1–3 rubric and requires
strict JSON with `status`, `score`, `reason_code`, `coverage`, and `evidence`.
Coverage must list every supplied turn exactly once. A scored response needs a
valid task-outcome evidence reference and a reason matching its score. Free-text
explanations are neither accepted nor persisted. Outputs with extra fields,
invalid references, partial coverage or out-of-range scores are errors. The
adapter never clamps scores or turns a failed evaluation into zero quality.

Incomplete evidence or detected credential-shaped content prevents the provider
call. A provider can also abstain. Default deadline is 10 seconds (maximum 30),
prompt limit 128,000 bytes (maximum 256,000), output limit 32,000 bytes. These
bound awaiting an asynchronous provider; they cannot preempt synchronous code
inside a caller-supplied function. Model evidence references are assertions, not
independent verification. Tests use synthetic provider responses, so no accuracy,
prompt-injection resistance or real-model calibration is claimed.

## API, storage and lifecycle

Authenticated contributor routes use the existing owner identity and idempotency
header. Operators and buyers cannot read another owner's results.

| Route | Input |
| --- | --- |
| `GET /v1/contributor/library/:id/qc` | Optional `scope=private` or `scope=release` |
| `POST /v1/contributor/library/:id/qc` | Explicit local check API retained for integrations; `{ "scope": "private" }` or `release` |
| `POST /v1/contributor/library/:id/qc/retry` | Same scope; requeues only a retryable failed background check |
| `POST /v1/contributor/library/:id/qc/review` | `scope`, `source_version`, `report_digest`, `decision`, `feedback` |

Review decisions are `agree`, `disagree`, or `unsure`; feedback codes are
`false_positive`, `missed_issue`, `useful`, and `unclear`. Arbitrary review text,
model endpoints, prompts, and API keys are not accepted. The review must match
the current source version and report, even if an identical content digest was
reused after a source reference changed.

Responses contain `selected_source`, `status` (`not_run` or `complete`), `cached`,
`report`, `report_digest`, latest `review`, and `automation`. The automation state
(`preparing`, `queued`, `running`, `complete`, `failed`, or `not_scheduled`) is
separate from the report outcome (`pass`, `flag`, `reject`, or `error`). The
`retryable` flag identifies an execution failure the owner can requeue; a completed
adverse result is not retryable merely because it contains findings. `selected_source` identifies the
trace, scope, content hash, source version, release revision and source coverage.
Known capture or readable-projection gaps carry distinct warnings even if their
available turns pass content checks. Imported or unknown source completeness stays unestablished.
Acquisition metadata changes invalidate the source binding while leaving the
content digest unchanged. Private scope
uses the selected raw saved record; release scope uses its prepared scrubbed
release and verifies the release content commitment. A grouped reader is not
one combined release.

Results are immutable and cached per owner, trace, scope, source and policy.
Identical content under a new reference can reuse encrypted report bytes, but
gets a new source binding. Reading a result or saving feedback rechecks ownership,
retention, deletion and source identity after vault I/O. Vault reads, evaluation
and encrypted writes run outside the global database transaction lock.

Reports and review assertions live in the encrypted vault. Database rows contain
references, hashes, versions and timestamps; audit and idempotency records do not
contain source excerpts or review decisions. Deleting or expiring a trace removes
its QC objects and rows through the existing trace cleanup path. Failed staged
writes use existing abandoned-object cleanup. Each trace is limited to 128 result
bindings and 128 feedback assertions; repeated cached reads do not consume these
limits. After the cap, new writes return `QC_STORAGE_LIMIT`; existing results remain
readable. There is no automatic pruning of historical feedback in this version.

Migration `007_trace_qc.sql` adds two tables and owner/trace indexes. It preserves
published migration bytes and existing ledger/capture records. Older binaries
reject a database with an unknown migration; rolling code back alone after 007
is not supported. Use the established tested database backup/restore process for
a rollback. This task does not run migrations on hosted environments.

## Automatic worker

Ingestion commits metadata-only QC jobs in the existing durable outbox. No trace
body or finding is included in those jobs. Private source completion and prepared
sale revisions are tracked separately. Source identity includes acquisition
coverage, so an identical content digest cannot silently reuse an earlier
complete-capture status after the capture becomes incomplete.

QC runs in an independent worker lane, outside the financial-chain cycle. It does
not wait for chain readiness, and reading/evaluation/encrypted report writes do
not hold the global database transaction lock. Workers deduplicate by owner,
trace, scope, source and policy. Each job gets at most three execution attempts;
an owner may explicitly retry a transient failure up to three times, with the
same three-attempt limit per cycle. Permanent failures do not offer retry. The
legacy explicit run API also uses this durable claim and attempt budget; it cannot
run unfinished checkpoints, interrupt a running job or bypass a failed job.
Claim fencing applies when committing a report
as well as when acknowledging a job. A bounded discovery cursor catches up older
retained terminal records without requiring the owner to visit a page.

This automation uses the local deterministic engine only. It does not call the
optional semantic adapter, use a provider key, send traces to a model, perform
cleaning, or spend funds. Worker queue/status metadata uses existing tables;
there is no schema migration after task 0033's migration 007.

## Reused upstream material

The implementation vendors only selected logic and rubric text, with original
Apache-2.0 licenses and an adaptation notice in `packages/qc/vendor/`. No Python
framework or model runtime is added as an application dependency.

| Project | Pinned source | Reuse and changes |
| --- | --- | --- |
| [Data-Juicer](https://github.com/datajuicer/data-juicer/tree/79b1308b5178ba25705b282c43e1372a93802b05) | `tool_success_tagger_mapper.py` | Tool success/error patterns ported to TypeScript. Unknown output remains unknown; optimistic upstream fallback and usage counters are omitted. |
| [OpenJudge](https://github.com/agentscope-ai/OpenJudge/tree/d1e06420bac4b9b755480e2a763a259b4e9b017e) | `trajectory_accuracy.py` | Accuracy rubric retained; output contract replaced with validated coverage and evidence references. |

`packages/qc/vendor/sources.json` records exact commit IDs, paths, SHA-256 hashes
and selected symbols. The upstream normalizer was not adopted because dropping
tool identifiers/arguments would lose evidence this contract needs. These are
narrow adaptations, not the complete upstream evaluators or their benchmarks.

## Validation and next steps

`pnpm test:qc` runs engine, synthetic judge, API, automatic-worker and CLI checks. Run on a disk
temporary directory with enough headroom for the existing vault guard. For the
browser flow, set `THOT_E2E_BROWSER` to Chromium and run
`node --test tests/trace-auto-qc-browser.test.mjs` after `pnpm build`. It uses real local
HTTP, storage and Chromium, synthetic traces, a development identity and blocked
external network access. It does not validate hosted Privy or a live model.

Before a value evaluator is enabled, collect a separately consented, versioned
set of human-reviewed examples; distinguish owner feedback from adjudicated
labels; compare judge versions on a held-out set and measure abstention, false
positives and cost. Validate usefulness against an actual downstream task and
buyer demand before experimenting with price. Engineering-QC source discussed
in another workspace was unavailable here and has not been integrated. These
follow-ups do not block using this bounded first QC tool.
