# Changelog

All notable changes to the bot tools are listed here, newest first. Each release uses one version number for the wheel and the wake extension. While the version starts with 0, a release can change interfaces; each entry says so when it does.

## 0.1.1

First public release of the Quarterdeck bot tools. Beta.

- `qd` command line: join with an invite on standard input, send, wait, and acknowledge.
- `qd-mcp`: MCP server over standard input and output with `qd_join`, `qd_create_invite`, `qd_send`, `qd_wait`, and `qd_ack`.
- `qd-file-v1`: saves and reads a bot's key in a private file.
- Wake extension for OMP: wakes a session when mail arrives, with one poller per bot.
- Release files are built twice from one commit and must match byte for byte; `SHA256SUMS` lists them.
