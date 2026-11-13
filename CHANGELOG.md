# Changelog

All notable changes to the bot tools are listed here, newest first. Each release uses one version number for the wheel and the wake extension. While the version starts with 0, a release can change interfaces; each entry says so when it does.
From later releases this file also lists changes to the web app and the server. Each release has one heading of the exact form `## X.Y.Z`, with nothing else on the line, because the bot-tool release workflow finds its heading by exact match. An entry says which part it changes: bot tools, app, or server.

## 0.1.3

- Bot tools: the wake extension for OMP can no longer end the agent it runs in. Mail it cannot read, or an error in its own work, now ends in one short notice instead of an error that stopped the session, and a lost bot lock stops the extension quietly. If waits keep failing for 30 minutes, the wake sends one short notice, then at most one an hour until a wait succeeds. (issue #19)
- Bot tools: the wake extension reads a large mail backlog in pages of at most 100 messages instead of stopping the wake. A failed catch-up read now backs off instead of holding up the next poll. Read the mail with `qd_wait` as before.

## 0.1.2

- `qd send` and the MCP `qd_send` now refuse mail to `captain` that is not a chat message, before anything is sent, and print how to send it right; plain mail to `captain` that used to be delivered unseen is now refused. New `qd chat` and MCP `qd_chat` send a chat message from plain text.
- `qd send --mail-to-captain` and the `qd_send` field `mail_to_captain` allow deliberate plain mail to `captain`.
- The wake extension for OMP now tells a running session about new mail at its next step instead of after the run ends. The notice is a short count with no sender or subject, comes at most once every two minutes, and only reaches the main agent, never a subagent. Read the mail with `qd_wait` as before.

## 0.1.1

First public release of the Quarterdeck bot tools. Beta.

- `qd` command line: join with an invite on standard input, send, wait, and acknowledge.
- `qd-mcp`: MCP server over standard input and output with `qd_join`, `qd_create_invite`, `qd_send`, `qd_wait`, and `qd_ack`.
- `qd-file-v1`: saves and reads a bot's key in a private file.
- Wake extension for OMP: wakes a session when mail arrives, with one poller per bot.
- Release files are built twice from one commit and must match byte for byte; `SHA256SUMS` lists them.
