# Optional capture status metrics

Claude Code and Codex share a capture status row in an isolated tmux server.
The default row reports private storage, saved exchanges, pending local exchanges
and sync retries. Capture interruption remains visibly red with explicit wording.

For diagnostics, select the optional metrics row for one invocation:

```sh
THOT_CAPTURE_STATUS=metrics thot-capture claude
THOT_CAPTURE_STATUS=metrics thot-capture codex
```

Example: `THOT | RECORDING | PRIVATE VAULT | 12 saved · 2 pending · save p50/last 110/140ms · lag 2.0s · ↑ 42KiB/s`.

`save p50/last` reports the lower median of the last 20 successful, validated
checkpoint/final-save request durations and the latest request duration. It includes
receipt parsing/validation, but excludes preceding part uploads and local receipt
persistence. It is not end-to-end model latency or a storage durability guarantee.

`lag` is the age of the oldest locally persisted part still awaiting an accepted
checkpoint. After a partial save, it follows the remaining unsaved part. After a
helper restart, its initial timestamp comes from the encrypted part file's mtime.
It is a local diagnostic estimate, not independently attested time.

Upload throughput is acknowledged part JSON bytes divided by the latest successful
upload batch's elapsed time, including local reads and server acknowledgement wait.
It excludes HTTP/TLS overhead and is not raw network bandwidth. The last measurement
stays visible while idle. Save samples and throughput reset when the helper restarts.

The metrics row does not change authentication, capture bytes, save acceptance,
local retention or retry behavior. It prints no prompt, token, account or project
identity. Noninteractive runs retain the existing initial stderr status line;
there is no continuously refreshed metrics bar without an interactive terminal.
