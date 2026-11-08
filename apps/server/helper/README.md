# Three-action Stalwart helper

This package is the only Stalwart account-lifecycle boundary available to signup. It has three business actions:

1. Create one approved bot. The final contract splits this into `prepare_collect`, `activate_collect` and an idempotent `rollback_collect`, so the credential can be returned once and client possession can be proved before activation.
2. `replace(BotRecord)`: create, save, read back and prove a new server-issued key before revoking the real old Stalwart key.
3. `cancel(BotRecord)`: deactivate the account, revoke the real Stalwart key and prove that an already-open client is refused.

Create starts with an inactive account and key. Preparation reads back the empty permission state, saves and reads back the API key through the registered adapter, and proves the key is refused. Activation rereads the account, key and adapter state, applies the exact restricted allowlist, reads it back and proves JMAP works. Rollback revokes the key, returns the account to its empty inactive state, removes the incomplete account and retires the adapter receipt.

No returned record contains a credential. Mutable credential buffers are cleared. Failed preparation and activation are rolled back by signup. A failed replacement before old-key revocation revokes and retires the new key while keeping the old key. If a post-revocation proof fails, `ReplacementCommitted` carries only the safe new record, so callers do not retry as though the old key were still active.

## Stalwart contract

`stalwart_admin.py` uses the proved Stalwart v1.0.1 management methods:

- `x:Domain/query`
- `x:Account/query`, `x:Account/set`, `x:Account/get`
- `x:ApiKey/set`, `x:ApiKey/get`

Accounts and API keys use explicit `Replace` permission objects. The inactive set is empty. The active set is exactly: authenticate, receive and send mail, Identity/get, Mailbox/get, Email/get, Email/query, Email/create, Email/update and EmailSubmission/create. Readback rejects inherited permissions, admin, administrator, every `sys*` permission, impersonate, fetchAnyBlob, unlimitedRequests and unlimitedUploads.

Account quotas use Stalwart v1.0.1's real field names: `maxEmails`, `maxMailboxes`, `maxEmailIdentities`, `maxEmailSubmissions`, `maxApiKeys`, `maxAppPasswords`, `maxPublicKeys` and `maxDiskQuota`.

Stalwart issues the API key and stores only its hash. The helper accepts the variable-length `API_` URL-safe form, bounded to 512 bytes. It sends the key as a Bearer value only through the shared `qd_jmap` library, for the negative and positive proofs.

`management_transport.py` reads the normal administrator secret from one helper-owned mode 0600 regular file and sends it only as Basic authorization to Stalwart's loopback administration endpoint. It refuses redirects, public endpoints, environment credentials and command-line credentials. The helper container is the only role allowed to mount that file.

## Signup seam

The helper imports all contract types from `signup/helper_contract.py`. The helper image mounts the signup package directly on its import path, so there is no copied contract to drift. The cross-package integration suite (`apps/server/tests/`) exercises prepare, activate, rollback, replace and cancel through the final `SignupService`, including the invite-first join contract.

## Runtime entrypoint

`server.py --config RUNTIME.json` is the only helper entrypoint. The rendered configuration supplies the private socket, the expected join identity, the state and secret paths, the loopback management endpoint, the mail domain and the JMAP session URL. The server builds only its own dependencies, recovers every prepared target before binding, then serves its mode 0660 socket in the group-2400 set-group-ID control directory. It refuses a wrong owner, group, mode, public management address or unexpected peer.

The keys of `runtime-config.template.json`:

| Key | Meaning |
| --- | --- |
| `format` | 1 |
| `socket.path`, `socket.group` | the control socket and its group (2400) |
| `joinUid` | the only peer allowed to connect (the join service, 2100) |
| `paths.ledger`, `paths.keys` | the prepared-target ledger and the key store, under the helper state folder |
| `paths.adminSecret` | the administrator credential file |
| `management.username`, `management.address`, `management.port` | the loopback management endpoint, from `${deployment:admin-username}`, `${deployment:admin-address}` and `${deployment:admin-port}` |
| `mailDomain` | from `${deployment:mail-domain}` |
| `sessionUrl` | the JMAP session URL, from `${deployment:jmap-session-url}` |

Every deployment-specific address, port, domain and URL comes from the door policy through the render step in `deploy/containers/`. `management_transport.py` has no fallback endpoint.

## Residual risk

Python and the HTTP libraries make short-lived immutable copies while constructing authorization headers. Long-lived objects keep only mutable buffers and clear them, but Python cannot prove that every transient allocator copy was overwritten. A lost management response at the exact old-key revocation boundary can also require readback reconciliation before the caller knows whether the replacement committed. The helper never responds to that ambiguity by re-enabling an old key.

## Tests

```sh
python3 -m unittest discover -s apps/server/helper -p 'test_*.py'
```

The suite imports the signup package and `apps/server/shared`, so both must be importable. The tests use in-process stand-ins.
