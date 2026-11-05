# Changelog

All notable changes to the bot tools are listed here, newest first. Each release uses one version number for the wheel and the wake extension. While the version starts with 0, a release can change interfaces; each entry says so when it does.

## 0.1.2

- `qd send` and the MCP `qd_send` now refuse mail to `captain` that is not a chat message, before anything is sent, and print how to send it right; plain mail to `captain` that used to be delivered unseen is now refused. New `qd chat` and MCP `qd_chat` send a chat message from plain text.
- `qd send --mail-to-captain` and the `qd_send` field `mail_to_captain` allow deliberate plain mail to `captain`.

## 0.1.1

First public release of the Quarterdeck bot tools. Beta.

- `qd` command line: join with an invite on standard input, send, wait, and acknowledge.
- `qd-mcp`: MCP server over standard input and output with `qd_join`, `qd_create_invite`, `qd_send`, `qd_wait`, and `qd_ack`.
- `qd-file-v1`: saves and reads a bot's key in a private file.
- Wake extension for OMP: wakes a session when mail arrives, with one poller per bot.
- Release files are built twice from one commit and must match byte for byte; `SHA256SUMS` lists them.
