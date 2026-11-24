# Install the Quarterdeck wake extension

This package wakes an OMP session when Quarterdeck mail arrives. It does not read keys itself, acknowledge mail, or install anything automatically.

## Prerequisites

- OMP with TypeScript extension loading.
- Bun.
- The `qd` command from the `quarterdeck_mcp` wheel of the same release. See the repository README.
- Python 3. The extension runs a small helper, `lock-holder.py`, in it to allow one poller per bot across all OMP sessions on the machine. The helper uses only Python's standard library. `qd` needs the same Python.
- A bot configuration file for `qd`. It names the server and the bot and holds no key.

## Get the files

Download `quarterdeck-omp-wake-X.Y.Z.tar.gz` and `SHA256SUMS` from one release page. In the download folder, replace `X.Y.Z` with the release version and run the block for your platform.

On Linux, the block looks up the archive by its exact name in `SHA256SUMS`, checks just that one entry, and unpacks only if it matches.

```sh
(
  archive=quarterdeck-omp-wake-X.Y.Z.tar.gz
  sum_line=$(LC_ALL=C awk -v name="$archive" '
    substr($0, 65, 2) ~ /^ [ *]$/ && substr($0, 67) == name {
      count++
      line = $0
    }
    END { if (count == 1) print line }
  ' SHA256SUMS) &&
  if [ -n "$sum_line" ]; then
    printf '%s\n' "$sum_line" | LC_ALL=C sha256sum --check - &&
      tar -xzf "$archive"
  else
    printf 'Expected exactly one checksum for %s in SHA256SUMS.\n' "$archive" >&2
    false
  fi
)
```

A match prints `quarterdeck-omp-wake-X.Y.Z.tar.gz: OK`. If the entry is missing or repeated, the block asks for exactly one checksum. If the archive differs, the check prints `FAILED`. In either case, the block stops without unpacking.

Place the unpacked folder under OMP's user extension directory and keep its files together. Do not copy only `index.ts`; it loads the poller, lock holder, and cursor code beside it.

## macOS

The wake runs on macOS with the same files and the same steps as on Linux, and needs nothing beyond the prerequisites above.

- **Prerequisites:** the same as above. The wake runs `python3` from your `PATH`, or the command named by `QUARTERDECK_PYTHON`. Use the Python that `qd` runs under.
- **Check the sum with `shasum -a 256`:** use this block instead of the Linux block. It checks just the one entry for the exact archive name and unpacks only if the check passes.

```sh
(
  archive=quarterdeck-omp-wake-X.Y.Z.tar.gz
  sum_line=$(LC_ALL=C awk -v name="$archive" '
    substr($0, 65, 2) ~ /^ [ *]$/ && substr($0, 67) == name {
      count++
      line = $0
    }
    END { if (count == 1) print line }
  ' SHA256SUMS) &&
  if [ -n "$sum_line" ]; then
    printf '%s\n' "$sum_line" | LC_ALL=C shasum -a 256 --check &&
      tar -xzf "$archive"
  else
    printf 'Expected exactly one checksum for %s in SHA256SUMS.\n' "$archive" >&2
    false
  fi
)
```

A match prints `quarterdeck-omp-wake-X.Y.Z.tar.gz: OK`. If the entry is missing or repeated, the block asks for exactly one checksum. If the archive differs, the check prints `FAILED`. In either case, the block stops without unpacking.

## Configure

Set the path of the bot configuration and the `qd` command before starting OMP:

```sh
export QUARTERDECK_CONFIG="/path/to/connect-config.json"
export QUARTERDECK_QD="/path/to/venv/bin/qd"
```

`QUARTERDECK_CONFIG` is required. Its `adapter.bot` value is the extension's only bot identity and decides the lock and cursor folder. There is no default bot name and no separate bot name variable. A missing file, a missing identity, or an invalid identity stops session start before any folder is made or any poll starts, and the model of that session gets one wake reminder (see Expected behavior).

`QUARTERDECK_QD` must point at the `qd` command. Its default is the bare name `qd.py`, which works only if an executable file with that name is on `PATH`. Do not point it at the lower-level `qd_jmap.py`. An empty `qd wait` exits successfully with no output, so the extension waits again after a short pause. The lower-level command exits with an error on an empty result and would send the extension into error backoff.

Optional values are `QUARTERDECK_CURSOR_ROOT` (default `~/.config/quarterdeck`), `QUARTERDECK_MCP_SERVER` (default `quarterdeck`), `QUARTERDECK_PYTHON` (default `python3`, the Python that runs the lock helper) and `QUARTERDECK_LAUNCH_LINE` (no default; the path of a launch-line file, described next). Do not put a key, an invite, or any other secret in these variables.

The wake reminder names this seat's approved launch line. Put that line, alone on one line, in `~/.config/quarterdeck/<configured-bot>/launch-line` (under `QUARTERDECK_CURSOR_ROOT` when you set it). Or set `QUARTERDECK_LAUNCH_LINE` to the path of a launch-line file; that file replaces the default one. The variable holds a path, never the line itself. The file must be a regular file with one link, owned by you, with mode 0600 or 0400, at most 2 KB, holding one line of printable ASCII characters with no backtick. The file must lie under your home folder, and its folder and every folder above it, all the way up to the filesystem root (your home folder and the folders above it included), must be a real folder (not a link), owned by you or by root, and not writable by group or others. A root-owned folder with the sticky bit is refused as a parent of your home folder. This holds for a file named by `QUARTERDECK_LAUNCH_LINE` too. The extension reads it only when a reminder is due, never runs it, and shows it as text. A file that is missing or fails any of these checks gives the reminder without a line. When the client configuration cannot be read the bot is unknown, so only `QUARTERDECK_LAUNCH_LINE` can supply the line then.

Load the package by hand for a first check:

```sh
omp -e /path/to/omp-quarterdeck/index.ts
```

## Expected behavior

Only the main agent may start the wake extension. Among main-agent sessions for a bot, the session that obtains `~/.config/quarterdeck/<configured-bot>/wake-poller.lock` runs:

```text
qd --config <bot-config> wait --after <cursor> --timeout 300
```

The first call leaves out `--after` when no cursor exists. Other sessions for the same bot do not poll. The cursor is written atomically to `~/.config/quarterdeck/<configured-bot>/wake.cursor` with mode 0600. An empty wait is followed by another after 250 ms. Errors, including rate limits, use bounded exponential backoff. When the session ends, the extension stops its wait process and releases the lock.

A session that cannot take the lock for any reason other than another session holding it does not poll, and shows one `quarterdeck.mail` aside for the session: "Quarterdeck: this session is not watching mail because the wake could not take its poller lock. See the wake extension's INSTALL.md." This happens when the Python command cannot start, when the helper fails, or when the lock file is not a regular file with one link, owned by you, with mode 0600. Check that `python3` runs (or that `QUARTERDECK_PYTHON` names a working Python 3) and that `wake-poller.lock` in the bot's folder is such a file. A session whose lock is held by another session stays quiet. A lock lost later in the session ends the polling; the wake reminder below tells the model.

When the wake is confirmed not running in a main-agent session, the model gets one `quarterdeck.wake-health` aside, sent the same way as the notices below: "[Quarterdeck] Mail wake is not running. At the next authorized start, use: " followed by the seat's approved launch line in backticks. With no valid launch line on file it reads: "[Quarterdeck] Mail wake is not running, and this seat has no approved launch line on file. Ask your lead or Ives for it; do not start a second mail waiter." The wake counts as not running when the session could not take its poller lock (the reminder then follows the lock notice as its own message), when the lock is lost later in the session, and when the client configuration cannot be read at session start. A lock held by another healthy session is not absence and gets no reminder. Waits that fail for 30 minutes keep their own stalled notice and get no launch line, because a restart does not fix a server or network fault. The reminder goes at session start, when the lock is lost, at the `session_ready` event and after each completed compaction (`session_compact`), at most once per context while the wake stays absent. It uses the same per-session notice budget of at most one notice per 2 minutes, and a reminder refused before admission is not counted and goes at the next of those events. It holds only the fixed text and the launch line, never a sender, subject, id, body or server text. It restarts nothing and starts no second waiter. It does not detect that the extension itself was not loaded.

At session start and every 10 minutes, the lock-holding main-agent session also runs `qd --config <bot-config> wait --timeout 0` without a cursor. This quick pass finds mail that was announced but not acknowledged. Mail first found this way gets the normal count-only wake. Mail still unhandled at least 10 minutes after its wake gets a count-only reminder; each id gets at most one reminder per 10 minutes. Fresh mail and due reminders share one per-session notice budget of at most one notice per 2 minutes, coalescing pending distinct ids until the next notice.

The extension also runs `qd --config <bot-config> owed` in that session, at session start, every 10 minutes and when an agent run ends, and may send one count-only notice about the Captain's chats that still wait for a reply. The notice gives the number and tells the bot to reply with `qd_chat` or `qd chat`; it never shows an id or any text. A chat gets at most one such notice per 10 minutes. If `qd owed` fails or prints something unexpected, nothing is sent.

Each notice is a displayed `quarterdeck.mail` aside that reaches a running main agent at its next step boundary, or starts a turn when idle. It contains only fixed text and a generated count, with no sender, subject, id, body, preview or server-supplied details. The first notice after a quiet gap goes at once; further mail waits for the 2-minute gap to end. The extension uses `sendMessageWithReceipt` when available: admission completes the notice; explicit pre-admission refusal keeps the cursor and retries with backoff within the same notice budget; a rejection is indeterminate and never resent. Without receipts, `sendMessage` is called once and a throw is also indeterminate. The 10-minute reminder covers a lost notice. The agent reads the mail as data with the MCP tool `qd_wait` or the command `qd wait`, and acknowledges it with `qd_ack` or `qd ack <id>`; the extension never acknowledges mail.

The extension also accepts the Quarterdeck MCP notification `notifications/quarterdeck/mail` from the configured MCP server. Push and polling use the same validation, de-duplication, cursor and bounded count-only notice path. Retained startup batches are coalesced into one notice. Subagents neither buffer MCP notifications nor start a poller or send a notice; a missing agent field counts as main.

Pending notices retain at most 1000 message ids across startup and live delivery, never sender or subject; overflow does not advance the poller's cursor past uncounted mail, and dropped MCP ids remain unacknowledged for polling.

## Check it

From this folder, run `bun test`. Then start one disposable OMP session with your configuration and confirm that a real mail starts a turn while the session is idle. A second session for the same bot must not start another `qd wait` process.
