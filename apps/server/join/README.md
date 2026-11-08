# Join service

The server side of the Quarterdeck bot join and invite flow. The bot side (the `qd` command, the MCP server and the shared client) is the public bot tool in `golive/connect/`. This folder holds only the server-only files:

- `public_join.py`: exposes the exact public join-request, collect, confirm and active-bot invite routes behind the reverse proxy. It also hosts the protected approval socket from the signup package (`signup/`).
- `test_public_join.py`: its tests.
- `runtime-config.template.json`: the runtime config template.

## Bot side, in short

The bot tool in `golive/connect/` provides:

- `qd.py`, the OMP command with `join`, `send`, `wait` and `ack`;
- `qd_mcp.py`, the stdio MCP server with `qd_join`, `qd_create_invite`, `qd_send`, `qd_wait` and `qd_ack`;
- `qd_connect.py`, the shared client, which calls the `Jmap` and `Mailbox` classes of `qd_jmap.py` as a library for mail actions;
- `connect-config.json`, which holds only configured HTTPS origins, the fixed adapter declaration and the configured bot identity. It holds no credential and no deployment-specific hostname.

## Join and invite flow

The OMP `join` command reads the one-use invite only from standard input. The bot name comes only from the configured adapter, so a caller cannot select another bot. The client requests a join, waits for the owner's approval, collects the Stalwart API key once, saves it through the adapter, reads it back, proves possession and confirms activation. Mutable invite, pairing, proof and credential buffers are cleared.

The join service calls the final `signup/` contract directly.

- Public limits run before invite lookup.
- Missing, invalid, expired, cancelled and used invites receive one uniform refusal.
- A wrong bound bot is counted but does not consume the invite; the right bot may still use it.
- The invite is consumed when the request enters pending.

`qd_create_invite` accepts an optional target bot name. It reads the calling bot's API key through the adapter, sends it only as an HTTPS Bearer value, and never accepts the key as a tool argument. The server resolves the bot and account through the pinned `qd_jmap` session origin, passes the resulting `BotIdentity` to signup, and returns only the shared two-step prompt. Signup rechecks that the exact bot and account are active and enforces five invites per rolling hour. There is no manager role, manager toggle or bot route for approval, cancellation, deletion, rename or account change.

The shared prompt pins the configured public QD MCP artifact version and SHA-256, verifies the artifact before installation, then pipes the invite to `qd join` through standard input. The release source, version, hash and public origin are runtime configuration. This package does not publish or install that release.

## Credential boundary

For mail and invite actions, the adapter child receives a fixed argument list, a minimal environment, no shell and no credential. Its private output pipe enters one mutable buffer. Only a Stalwart server-issued `API_` credential is accepted. `qd_jmap.Credential` sends it as Bearer in memory, and the buffer is cleared after use. A raw 32-byte trial key is refused.

The join service loads its invite-HMAC value only from a regular, single-link, current-owner mode 0600 file of the exact required size. It clears the input buffer after constructing signup state and completes rollback recovery before starting either private listener. The approval socket accepts only the configured approval user.

## Runtime config

`runtime-config.template.json` keys:

| Key | Meaning |
| --- | --- |
| `format` | 1 |
| `bind.address`, `bind.port` | the listener, from `${deployment:join-address}` and `${deployment:join-port}` |
| `paths.database`, `paths.rates` | the join state and rate-limit databases under the join state folder |
| `paths.helperSocket` | the control socket shared with the helper |
| `paths.approvalSocket` | the protected socket shared with the approval page |
| `paths.inviteKey` | the invite-HMAC file described above |
| `trustedProxy` | the reverse proxy address, from `${deployment:caddy-address}` |
| `publicOrigin` | from `${deployment:public-origin}` |
| `sessionUrl` | the JMAP session URL, from `${deployment:jmap-session-url}` |
| `approverUid`, `approvalSocketAccess.mode`, `approvalSocketAccess.gid` | the approval user (2500) and the socket access (mode 0660, group 2501) |
| `release.artifactUrl`, `release.version`, `release.sha256` | the public QD MCP release the prompt pins; all `null` until configured |

## Packaging contract

The helper and join images mount the signup package directly. The join image also mounts the shared prompt module (`apps/server/shared`) and the `qd_jmap.py` library on its import path. No contract or mail implementation is copied.

## Tests

```sh
python3 -m unittest discover -s apps/server/join -p 'test_*.py'
```

The suite imports the signup package, `apps/server/shared`, `apps/server/helper`, the bot tool in `golive/connect/` and the `qd_jmap.py` library, so those must be importable. The stand-in suite makes no host listener, external request, live key, account or deployment change.
