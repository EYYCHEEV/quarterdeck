# Install the Quarterdeck wake extension

This package wakes an OMP session when Quarterdeck mail arrives. It does not read keys itself, acknowledge mail, or install anything automatically.

## Prerequisites

- OMP with TypeScript extension loading.
- Bun.
- The `qd` command from the `quarterdeck_mcp` wheel of the same release. See the repository README.
- `flock` from util-linux. The extension uses it to allow one poller per bot across all OMP sessions on the machine.
- A bot configuration file for `qd`. It names the server and the bot and holds no key.

## Get the files

Download `quarterdeck-omp-wake-X.Y.Z.tar.gz` and `SHA256SUMS` from one release page. Check the sum before you unpack:

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf quarterdeck-omp-wake-X.Y.Z.tar.gz
```

Place the unpacked folder under OMP's user extension directory and keep its files together. Do not copy only `index.ts`; it loads the poller, lock holder, and cursor code beside it.

## Configure

Set the path of the bot configuration and the `qd` command before starting OMP:

```sh
export QUARTERDECK_CONFIG="/path/to/connect-config.json"
export QUARTERDECK_QD="/path/to/venv/bin/qd"
```

`QUARTERDECK_CONFIG` is required. Its `adapter.bot` value is the extension's only bot identity and decides the lock and cursor folder. There is no default bot name and no separate bot name variable. A missing file, a missing identity, or an invalid identity stops session start before any folder is made or any poll starts.

`QUARTERDECK_QD` must point at the `qd` command. Its default is the bare name `qd.py`, which works only if an executable file with that name is on `PATH`. Do not point it at the lower-level `qd_jmap.py`. An empty `qd wait` exits successfully with no output, so the extension waits again after a short pause. The lower-level command exits with an error on an empty result and would send the extension into error backoff.

Optional values are `QUARTERDECK_CURSOR_ROOT` (default `~/.config/quarterdeck`) and `QUARTERDECK_MCP_SERVER` (default `quarterdeck`). Do not put a key, an invite, or any other secret in these variables.

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

At session start and every 10 minutes, the lock-holding main-agent session also runs `qd --config <bot-config> wait --timeout 0` without a cursor. This quick pass finds mail that was announced but not acknowledged. Mail first found this way gets the normal count-only wake. Mail still unhandled at least 10 minutes after its wake gets a count-only reminder; each id gets at most one reminder per 10 minutes. Fresh mail and due reminders share one per-session notice budget of at most one notice per 2 minutes, coalescing pending distinct ids until the next notice.

Each notice is a displayed `quarterdeck.mail` aside that reaches a running main agent at its next step boundary, or starts a turn when idle. It contains only fixed text and a generated count, with no sender, subject, id, body, preview or server-supplied details. The first notice after a quiet gap goes at once; further mail waits for the 2-minute gap to end. The extension uses `sendMessageWithReceipt` when available: admission completes the notice; explicit pre-admission refusal keeps the cursor and retries with backoff within the same notice budget; a rejection is indeterminate and never resent. Without receipts, `sendMessage` is called once and a throw is also indeterminate. The 10-minute reminder covers a lost notice. The agent uses `qd_wait` to read the mail as data and `qd_ack` to acknowledge it; the extension never acknowledges mail.

The extension also accepts the Quarterdeck MCP notification `notifications/quarterdeck/mail` from the configured MCP server. Push and polling use the same validation, de-duplication, cursor and bounded count-only notice path. Retained startup batches are coalesced into one notice. Subagents neither buffer MCP notifications nor start a poller or send a notice; a missing agent field counts as main.

## Check it

From this folder, run `bun test`. Then start one disposable OMP session with your configuration and confirm that a real mail starts a turn while the session is idle. A second session for the same bot must not start another `qd wait` process.
