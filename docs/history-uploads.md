# Daily private history uploads

Keep using Claude Code or Codex normally, then upload selected local conversation
histories to your private THOT library. This is separate from live capture and
does not authorize a listing or sale. Imported histories are **unverified**.

## Install and connect

Requires Node.js 24 or later, an existing history directory and browser sign-in.
Check that `node --version` reports v24 or later in each terminal. This history
uploader does not need a provider API key, a running Claude Code/Codex client,
Python or tmux; those are separate live-capture prerequisites. Use a reviewed
source release from
[THOT releases](https://github.com/thot-market/thotmarket/releases); the global
npm CLI is not yet published. From that checkout:

```sh
node scripts/install-capture-helper.ts --thot-url 'https://app.thot.market'
"$HOME/.local/bin/thot-history" --help
```

Continue only when the help text appears. These commands use the installed
executable by its full path and work in a fresh shell without adding the helper
to PATH. Keep the extracted source folder in place: the installer links to its
scripts. If you prefer short commands, run `export PATH="$HOME/.local/bin:$PATH"`
and add that line to your shell startup file for future terminals.

Choose a specific directory containing the histories you want to upload. Common locations are `~/.claude/projects` and
`~/.codex/sessions`; verify the contents and choose a narrower project folder
when appropriate. Keep paths in quotes, including paths with spaces. The helper
does not choose or search those locations for you.

```sh
"$HOME/.local/bin/thot-history" connect --client claude --source "$HOME/.claude/projects/CHOSEN-PROJECT"
# Or choose a Codex history directory:
"$HOME/.local/bin/thot-history" connect --client codex --source "$HOME/.codex/sessions/CHOSEN-DIRECTORY"
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
connection ID printed by the helper. First run once and inspect its result:

```sh
"$HOME/.local/bin/thot-history" run --id CONNECTION_ID
"$HOME/.local/bin/thot-history" status --id CONNECTION_ID
```

To request daily uploads separately:

```sh
"$HOME/.local/bin/thot-history" enable --id CONNECTION_ID
```

`enable` installs a per-user systemd timer on Linux or a LaunchAgent on macOS.
An active upload permission in the browser is not proof of a running local
schedule. Check `status` for the local schedule request and last run, and inspect
your platform scheduler if needed. A failed `enable` reports an error; a
`pending-linux` or `pending-darwin` schedule request is not confirmed.
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
"$HOME/.local/bin/thot-history" pause --id CONNECTION_ID
"$HOME/.local/bin/thot-history" resume --id CONNECTION_ID
"$HOME/.local/bin/thot-history" disable --id CONNECTION_ID
"$HOME/.local/bin/thot-history" disconnect --id CONNECTION_ID
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

## If setup needs attention

- **`node` is missing or older than v24:** install Node.js 24 or later, reopen the
  terminal and check `node --version` before rerunning the installer.
- **The helper path is missing:** rerun the installer from the retained source
  folder. A deleted or moved source folder leaves a broken helper link.
- **History directory not found:** choose an existing directory, check its
  contents, and keep the `--source` path in quotes.
- **Nothing uploaded:** existing paths are excluded by default, and files must
  be unchanged for two minutes. Use a new session, or disconnect and reconnect
  with `--backfill` to include existing history. Check the run's status codes.
- **Scheduler unavailable:** on Linux, check `systemctl --user status` in your
  logged-in session; on macOS, use a logged-in user session. Use `run` for manual
  uploads while fixing the scheduler, then retry `enable`. No persistent personal
  scheduler is installed merely by connecting in the browser.
- **Paused, expired or revoked:** use `resume` for a pause; run `connect` again for
  expired or revoked permission. Signing out of the browser does not do this.

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
