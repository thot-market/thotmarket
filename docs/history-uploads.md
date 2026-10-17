# Daily private history uploads

Keep using Claude Code or Codex normally, then upload selected local conversation
histories to your private THOT library. This is separate from live capture and
does not authorize a listing or sale. Imported histories are **unverified**.

## Install and connect

Requires Node.js 24 or later. Use a reviewed source release from
[THOT releases](https://github.com/thot-market/thotmarket/releases); the global
npm CLI is not yet published. From that checkout:

```sh
node scripts/install-capture-helper.ts --thot-url https://app.thot.market
```

Add `~/.local/bin` to your PATH if needed. Choose a specific directory containing
the histories you want to upload. Common locations are `~/.claude/projects` and
`~/.codex/sessions`; verify the contents and choose a narrower project folder
when appropriate. The helper does not choose or search those locations for you.

```sh
thot-history connect --client claude --source "$HOME/.claude/projects/CHOSEN-PROJECT"
# Or choose a Codex history directory:
thot-history connect --client codex --source "$HOME/.codex/sessions/CHOSEN-DIRECTORY"
```

The command shows the selected folders and opens THOT in your browser. Sign in
through the existing Privy flow and approve **private history uploads**. Folder
paths stay on your computer; THOT receives opaque source identifiers.

By default, every existing JSONL path is excluded, including later edits to it.
Only newly created paths are eligible. Add `--backfill` when connecting only if
you also want to upload existing histories. Repeat `--source` to select more
folders. Choose `--time HH:MM` to change the daily time from 02:00 UTC.

## Run and schedule

Pairing alone neither uploads a file nor installs a scheduled task. Use the
connection ID printed by the helper:

```sh
thot-history run --id CONNECTION_ID
thot-history status --id CONNECTION_ID
thot-history enable --id CONNECTION_ID
```

`enable` installs a per-user systemd timer on Linux or a LaunchAgent on macOS.
No scheduler is installed by package installation. The computer and user session
must be available, and the source checkout or package must stay in place. Linux
requires a working systemd user session; this tool does not enable lingering.
Missed work catches up after the computer or user session becomes available;
macOS checks due work within 15 minutes. Windows scheduling is not supported.

The helper uploads at most 20 stable files per run, with a 2 MB limit per file.
Files must remain unchanged for two minutes. Symlinks, unsupported or malformed
histories, oversized files and active writes are skipped with safe status codes.
No provider credential or model call is needed. Repeated unchanged files are
deduplicated; a changed file produces a new immutable private version, which may
overlap an earlier snapshot. Old deposits and sold releases are never overwritten.

## Pause or disconnect

```sh
thot-history pause --id CONNECTION_ID
thot-history resume --id CONNECTION_ID
thot-history disable --id CONNECTION_ID
thot-history disconnect --id CONNECTION_ID
```

`pause` stops local reading and requests a server pause. `resume` requires server
confirmation. `disable` removes the owned schedule and leaves local uploads
paused. `disconnect` revokes the upload grant. Previously saved histories remain
in your private library; those commands do not erase them or revoke sale licenses.

You can also pause or disconnect an uploader in **My work → Connections → Daily
history uploads**. Browser sign-out does not revoke a paired uploader. A local
pause also needs the local resume command. Grants expire after 30 days without a
successful upload. Credentials and checkpoints are encrypted with owner-only
permissions under `~/.local/state/thot/history`; keep that directory private.

## Review before selling

Open an imported conversation in **My work**, prepare a sale copy and review the
exact messages before authorizing a listing. Excluding a message changes the
stored release and requires a fresh review. A release already committed to a
listing cannot be edited. Automated privacy filtering is incomplete: inspect
code, tool output and confidential context yourself. Saving, evaluation and
listing do not guarantee a buyer or payment.

Live capture is a different flow: start sessions through `thot-capture`. Its
device permission does not grant access to historical files. Private live
captures cannot currently be converted into manual sale listings; optional
automatic sales require a separate wallet-signed policy for future sessions.
