# Approval page

This package owns the owner-facing authentication and presentation boundary: Google sign-in, approvals and invites. The signup package (`signup/`) remains the sole owner of join state, invites and decisions. The page never receives a mail server administrator credential.

## Public surface

The reverse proxy exposes only these exact routes to this service:

- `GET /captain/login`
- `GET /captain/oidc/callback`
- `GET /captain/pending`
- `POST /captain/invites/create`
- `POST /captain/invites/cancel`
- `POST /captain/approve`
- `POST /captain/refuse`
- `POST /captain/settings/approval-password`
- `POST /captain/logout`

The protected socket client supports listing pending joins, listing and creating or cancelling unused invites, and approving or refusing a pending join. Every unavailable, malformed or negative socket response fails closed.

## Google sign-in

`GET /captain/login` starts a Google OpenID Connect authorization-code flow with PKCE S256, one-use state, nonce and `select_account`. A short `__Host-` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`) binds the callback to the browser that started it. A wrong, malformed or duplicate browser cookie burns the state. An absent cookie refuses without consuming it.

The server exchanges the code directly at Google's token endpoint over checked TLS. It verifies issuer, audience, authorized party, expiry, issue time, nonce, the owner's exact verified email and a pinned immutable subject. It stores no Google token.

- Approval sessions use a `Secure`, `HttpOnly`, `SameSite=Lax` host cookie and expire after seven idle days and thirty days overall.
- Risky actions require the owner to have signed in with Google in the last 15 minutes. Both normal and step-up requests use `prompt=select_account` with no `max_age` or `claims` parameter.
- Every exchange requires a numeric, non-boolean `iat` between the stored request start minus sixty seconds and now plus sixty seconds, in addition to the existing token checks. Freshness ends at `min(iat, now) + 900`, and activity never extends it.
- Step-up rotates the session, device handle and CSRF pool, then returns to a safe GET page without replaying the action.
- A stolen sign-in can still use a fresh window that is already open, for up to 15 minutes. It cannot open a new one by itself. Anyone who can use the owner's Google sign-in on a device can open a new window without a password. A forced re-sign-in with an `auth_time` requirement is not met; the 15-minute `iat` rule replaces it.

The private OpenID Connect file holds the client id, the client secret, the allowed email, the redirect URI and the session-signing key (keys `clientId`, `clientSecret`, `allowedEmail`, `redirectUri` and `sessionKeyHex`; the template is `oidc-config.template.json` in `deploy/approval/`). It must be an owner-only mode 0600 file in an owner-only directory. Creating the Google client, placing its secret and completing the first subject-pinning sign-in are separate operator steps that need the owner's explicit approval. No bot sees, sets or stores those values.

An earlier password-plus-phone login implementation remains in the code but is unreachable from the current route dispatch. It is not a supported login path.

## Approval and invite controls

All state-changing requests require the exact HTTPS origin and a one-use CSRF value. The pending page shows the inviter for each join and visible history for every approve, refuse and approval-password setting change.

- The optional setting "Ask for a password to approve a bot" defaults to off. When enabled, each approve request must include the password; refuse does not. Only a salted scrypt verifier is stored, in the approval-only mode 0600 state. The current password is required to change or disable it, and wrong values count toward limits and auto-ban. A forgotten password is reset by an offline operator step that needs the owner's explicit approval.
- The Add bot action creates an optionally name-bound invite and shows the shared two-step, release-pinned prompt once with a copy button. Open invites show no code and can be cancelled by the owner. There is no manager role or manager toggle.

## Request security

- The reverse proxy is the only trusted proxy. The app requires the exact HTTPS origin and one valid forwarded client address.
- Login and authenticated limits are persistent, bounded and fail closed. Repeated failures auto-ban the client without ending existing sessions.
- Caller identifiers, browser values, sessions, CSRF values and OpenID Connect state are stored only as keyed hashes.
- HTML is escaped, and responses use no-store, a closed content security policy, no-referrer and anti-framing headers.
- Request bodies are bounded, read with a five-second timeout and cleared after handling.
- The private SQLite state file is mode 0600 in an owner-only directory and uses full synchronous writes.

## Runtime config

The template is `runtime-config.template.json` in `deploy/approval/`. Its keys:

- `format` (1) and `bind` (`address`, `port`, filled from `${deployment:approval-address}` and `${deployment:approval-port}`).
- `paths`: `oidc`, `state`, `socket` (the protected approval socket) and `captainAuthSocket` (the private sign-in socket shared with the approval app, the compose service `captain-app`).
- `captainAuth`: `peerUid`, `socketMode` and `socketGid` for that socket.
- `trustedProxy` (`${deployment:caddy-address}`) and `publicOrigin` (`${deployment:public-origin}`).
- `release`: `artifactUrl`, `version` and `sha256` of the public bot-tool release that the invite prompt pins. All three are `null` until a release is configured.

## Tests

```sh
python3 -m unittest discover -s apps/server/approval -p 'test_*.py'
```

The suite imports the signup package and `apps/server/shared`, so both must be importable. All tests use in-process stand-ins. They make no listener, Google call, live credential, account, certificate or deployment change.
