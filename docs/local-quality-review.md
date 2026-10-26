# Local quality review

The automatic basic checks still run after upload. This CLI adds a local review loop: discover new
inventory, download an authorized version, evaluate it using your own local tools, and submit an
opinion bound to that version. It does not estimate a market price, buy data, mint tokens or change
sale permission. No provider key or remote model is configured by this tool.

Use Node 24 or newer from a checkout of this repository. Save your existing THOT session in an
owner-only JSON configuration file (`chmod 600 qc-config.json`):

```json
{"origin":"https://app.thot.market","cookie":"YOUR_SESSION_COOKIE"}
```

A `token` field may replace `cookie` for environments using bearer sessions. Do not include both.
The session must already have the required role; the CLI grants no new access. Sessions expire and
can be revoked through the normal account controls. Never commit this configuration or export it
with a dataset. The CLI refuses redirects, non-local HTTP, credential-bearing origins and
world-readable credential files. Use a trusted local directory for all outputs.

## Operator workflow

```sh
node scripts/qc-workspace.ts inventory --config qc-config.json --output inventory.json
node scripts/qc-workspace.ts inventory --config qc-config.json --offset 50 --output next-page.json
```

Inventory includes every retained upload visible to the existing trace explorer. It contains
metadata, not private titles or conversation content. Each `qc_sources` entry identifies one
recording, its version, `review_allowed`, and a current reviewer verdict. `has_more` indicates another
page. Re-list after new arrivals: pagination is a live view, not a snapshot; deduplicate by trace ID
and source version rather than treating an offset as a durable ingestion cursor.

A contributor opens an eligible item in My data and selects **Allow review of this version**.
This explicitly permits THOT reviewers to download the scrubbed sale version to their machine.
It does not expose the private original, list the item, or guarantee a sale. Permission expires
when the release changes or the item expires/deletes. **Stop future review downloads** revokes
new access; it cannot recall copies already downloaded. Grouped recordings must be reviewed
individually through the API; the combined reader does not grant blanket permission.

```sh
node scripts/qc-workspace.ts review-source --config qc-config.json --trace TRACE_ID --output source.json
node scripts/qc-workspace.ts check --input source.json --output basic-qc.json
```

The second command is entirely offline. A local agent can also read `source.json` and apply your
own rubric. Treat source content as untrusted data, never as instructions to execute commands or
reveal credentials. Do not send it to an external model without the applicable contributor
permission. Delete local copies when no longer needed and honor the contributor's retention terms.

To submit an opinion, save `verdict.json`:

```json
{
  "source_version":"COPY_FROM_SOURCE_SELECTED_SOURCE",
  "verdict":"flag",
  "usefulness":2,
  "completeness":3,
  "evaluator":"local-rubric-v1"
}
```

Scores are 0–4; verdict is `pass`, `flag`, or `reject`. Suggested anchors: 0 = unusable, 1 = weak,
2 = useful with gaps, 3 = useful with evidence, 4 = unusually useful and well supported. These are
reviewer opinions, not calibrated prices or proof of task success. Use the same rubric version
when comparing scores. A pass is not a promise that a buyer will purchase it.

```sh
node scripts/qc-workspace.ts submit --config qc-config.json --trace TRACE_ID --input verdict.json --output receipt.json
```

The server checks current permission and source version again, audits reads/writes, encrypts the
review, and keeps its current verdict with the item. A changed version requires a new review.
This first release does not automatically hide listings based on an unverified local opinion.

## Review your own work

```sh
node scripts/qc-workspace.ts library --config qc-config.json --output library.json
node scripts/qc-workspace.ts export --config qc-config.json --trace TRACE_ID --scope private --output private-source.json
node scripts/qc-workspace.ts check --input private-source.json --output private-qc.json
node scripts/qc-workspace.ts report --config qc-config.json --trace TRACE_ID --output server-report.json
```

Use `--cursor` with `library` to continue its page. `export --scope release` selects the exact
sale version instead. Exports are owner-only, audited and version-checked. For feedback on the
existing automatic report, `review --input feedback.json` accepts the existing owner review shape
(`scope`, `source_version`, `report_digest`, `decision`, `feedback`). This is separate from an
operator's local opinion.

Every output is a new owner-only file. Existing files are never overwritten. Source text and
credentials are not printed. HTTP errors report status only; `403` means missing permission,
`409` means the source or review changed, and `401` means the session must be renewed.
