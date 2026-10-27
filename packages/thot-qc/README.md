# THOT local QC

Review approved THOT data on your own computer. Your wallet key stays in your wallet.
Mac and Linux need Node.js 24 or newer. Windows users can use WSL; native Windows
credential-file permissions are not supported.

Install the reviewed release archive:

```sh
npm install --global ./thotmarket-qc-0.1.0.tgz
thot-qc --help
```

Sign in at https://app.thot.market/app with the configured operator wallet, open
https://app.thot.market/ops, and click **Connect local QC**. Import the downloaded
connection on the computer where you will review data:

```sh
thot-qc login --config ~/Downloads/thot-qc-connection.json
thot-qc inventory --output inventory.json
thot-qc pull --directory review-batch-001 --limit 20
thot-qc review-source --trace TRACE_ID --output source.json
thot-qc check --input source.json --output report.json
```

Login protects the downloaded file and saves an owner-only connection at
`~/.config/thot/qc.json`. Delete the original download after importing it. The
connection expires within eight hours (or sooner when its browser session expires),
and signing out of that browser session revokes its access. Different computers can
have separate connections. Use `thot-qc logout` to revoke this computer's connection.
It cannot make purchases, read private originals, mint tokens or administer the service.

Inventory is metadata only. `review_allowed: true` means a contributor permitted
local review of that exact scrubbed release. Inventory pagination uses `--offset`
and `--limit`; deduplicate by trace ID and source version. `review-source` downloads
only that permitted release. Stop requesting copies after permission is withdrawn.
Keep downloaded material private and honor its retention terms.

`check` runs offline, without a server, wallet, cloud agent or model key. You can rerun
it and inspect the source with your own tools. Trace text is untrusted data, never
instructions to execute. Sending it to a remote model needs appropriate permission.

`pull` creates a new private directory with inventory, sources, offline reports and
`index.json`. It downloads at most 20 permitted source versions per invocation;
blocked or changed items are marked unavailable. It never requests private originals.
Use `--offset` / `--limit` to select another inventory page; if a grouped page has
more than 20 eligible sources, use `review-source` for the remaining IDs from its
saved inventory. No local copies are silently overwritten or sent to a model.

Save your judgment without copying a version hash:

```sh
thot-qc judge --input source.json --verdict flag --usefulness 2 --completeness 3 --evaluator local-rubric-v1 --output verdict.json
thot-qc submit --trace TRACE_ID --input verdict.json --output receipt.json
```

`judge` checks the exported content digest and binds your opinion to its release
version. It records your judgment; it does not infer those scores automatically.

Scores are 0–4 and verdict is `pass`, `flag` or `reject`. The server rechecks current
permission and version. This opinion does not price, buy or hide the item.
All outputs are new owner-only JSON files; an existing output is never overwritten.
A changed source needs a new review. `401` means reconnect, `403` means no permission,
`409` means the reviewed source changed. Source contents and credentials never print.

Developers: from a full source checkout, run `node packages/thot-qc/build.mjs`, then
`npm pack ./packages/thot-qc`. The package includes its runtime; users do not need
the full THOT repository or access to a particular server.
