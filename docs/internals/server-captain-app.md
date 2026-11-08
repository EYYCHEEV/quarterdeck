# The approval app (captain-app)

The approval app (the compose service `captain-app`) is the owner's plain chat and Task Card server, a light backup app beside the main web app. Its code is in `apps/server/captain-app/`. It serves an interim chat page, the chat API, a shared events stream and the Task Card API, and it sits behind the same sign-in as the rest of the server.

This note covers what it serves, how sign-in and sessions work, how it reaches the mailbox, and how it is contained. The tests use stand-ins and the limits at the end say what they do not prove.

## Chat page and routes

The page is a plain interim chat page that uses only same-origin assets and APIs. It has no third-party runtime call or dependency. The full chat view lives in the web app.

The active bot list, the oversight bot, the project leads and the owner's account all come from the authoritative project registry. No account or bot value is built into the server or a route. The same generic thread route works for every active registry bot, including bots added later.

| Method | Public path | Purpose |
|---|---|---|
| GET | `/captain/chat` | Plain interim chat page |
| GET | `/captain/assets/chat.css` | Local page styles |
| GET | `/captain/assets/chat.js` | Local chat behavior |
| GET | `/captain/api/chats` | List every active registry bot and its latest message |
| GET | `/captain/api/chat?with=<bot>` | Read one active bot thread |
| POST | `/captain/api/chat?with=<bot>` | Send one message with a stable request identifier |
| GET | `/captain/events` | Shared server-sent refresh notifications |

All routes require the shared session. The POST route requires same-origin JSON and a one-use CSRF token. The server validates the `with` query against the active registry bot set and rejects missing, repeated, malformed and inactive bot values.

The page uses a compact message list, optimistic send with same-identifier retry, canonical-message reconciliation, cached last-good state during reconnects, seen and typing state, and safe Markdown and code-block rendering. These interaction patterns were adapted from T3 Code under the MIT License (upstream commit 22b5252467aef991517afb0155be57f5c9eb301e). The full copyright and license notice is in `THIRD_PARTY_NOTICES.md`. No source file carries a borrowed file-header comment.

The server returns `seenUpTo: null` and `writing: false` until an authoritative source can supply those states. It does not invent them. Server-sent events are shared invalidations: each page refreshes the list and the open thread after a change, and never treats an event payload as a canonical message.

## Task Cards

The Task Card APIs are implemented behind the private application. They are not in the chat-first route set, so a later route change can expose them without changing the card contract.

| Method | Private application path | Purpose |
|---|---|---|
| GET | `/captain/cards` | Short project, lane and card list plus a fresh CSRF token |
| GET | `/captain/cards/<id>` | One current card revision and its thread |
| POST | `/captain/cards/<id>/answer` | Pick plus note, including `cant-decide` and `none` |
| POST | `/captain/cards/<id>/comments` | Send one configured-account comment |

- The first list response shows at most 200 card summaries and 20 plain-mail metadata records. Each card summary has only `id`, `title`, `project`, `lane`, `due`, `state` and `changed-at`: no body, thread or options. Invalid mail has no body or action buttons. A 31-card stand-in list stays below 8 KiB uncompressed. The recorded 31-card sample list is 7572 bytes, also below 8 KiB. The server fetches a card body and thread only when that card opens.
- The list has a content-derived `ETag`; an unchanged `If-None-Match` refresh returns an empty `304`. The server compresses every nonempty JSON response when the client accepts gzip. On sign-out the shared auth module revokes the session and returns `Clear-Site-Data: "storage"`, so the browser removes a saved list.
- A card, update, comment, answer or withdrawal is accepted only after `qd_cards.check_mail` runs with the authoritative registry and the mail server's sender account. Ownership refusals go to the registry's oversight bot and do not appear as actionable cards. Other invalid card mail appears as plain mail without buttons.
- `qd_cards` builds answers and owns registry validation, card shape, ownership, update merge rules, outbound answer construction and resend keys. The resend key includes card id, revision, pick and recipient. An older known revision is accepted and marked stale. The response says `Got it`, the card id, the displayed pick and Eastern time.

## Package contents

- `captain_auth.py`: the shared Google sign-in, session, safe return-path, logout and CSRF contract for approvals, cards and connector consent.
- `application.py`: authenticated same-origin JSON, static chat assets and server-sent events.
- `chat.html`, `chat.css`, `chat.js`: the dependency-free interim chat page.
- `cards.py`: a bounded inbox index, generic registry-backed chat and the owner's actions.
- `checker_adapter.py`: the narrow adapter to `qd_cards`.
- `mail_gateway.py`: the configured-account JMAP mailbox adapter. Its send method has no sender argument.
- `security.py`: one-load mutable key handling and least-privilege readback checks.
- `live.py`: one five-second inbox checker shared by every open server-sent-event tab.
- `server.py`: the private HTTP adapter for the approval app container.
- `packaging_plan.py`: fail-closed rendering, validation, output and manifest checks.
- The packaging inputs (compose reconciliation, door policy diff, package manifest and runtime config template) are templates under `deploy/captain-app/`.

The door base identity in the public files is a synthetic placeholder, the sha256 of the text `quarterdeck-public-synthetic-door-base-v1`, and deployment binds the real base privately.

## Sign-in and sessions

### One owner and one cookie

`captain_auth.py` is the sign-in and session contract for the approval sign-in service (`apps/server/approval`), Task Cards and connector consent. The connector imports this module. It does not create a second login, cookie, identity check, session table or CSRF policy.

The module imports the approval implementation:

- `oidc.GoogleOidc` verifies the configured Google account and returns its subject.
- `approval_security.ApprovalState` pins that subject and enforces a 15-minute idle limit, a 1-hour total limit, plus session and global request limits.
- `approval_app.Request` and `approval_app.Response` remain the shared HTTP boundary types.

The shared session cookie is `__Host-qd-approval`. It has `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax` and a one-hour browser lifetime. The `__Host-` prefix and the absence of a `Domain` attribute make it host-only. Server-side idle and total limits stay authoritative.

The approval sign-in service's HTTP boundary stays responsible for its caller checks, login rate limits, failure recording and automatic login bans before it calls this module. Adopting this module must not replace or bypass those controls.

### Published contract

- `require_captain(request) -> CaptainSession | None` checks the shared cookie through the imported session state.
- `login_redirect(next_path) -> Response` begins Google OIDC for one allowlisted local return path.
- `oidc_callback(request) -> Response` consumes the one-use browser-bound OIDC state, creates the shared session and redirects to its stored local return path.
- `csrf_token(session) -> str` issues a short-lived one-use token.
- `check_csrf(session, form) -> bool` consumes that token. Every state-changing POST must call it before changing state.
- `logout_response(session, form) -> Response` consumes CSRF, revokes the session, clears the shared cookie and sends `Clear-Site-Data: "storage"` for any phone-saved card list.

The connector authorize page calls `require_captain`. If there is no session, it calls `login_redirect` with its authorize URL. After sign-in it shows the configured consent question and accepts the decision only through a CSRF-checked POST. Binding the resulting OAuth token to the configured account stays with the connector.

### Safe return after sign-in

A return path is accepted only when all of these are true:

- its path starts with `/captain/`, or is exactly the connector authorize endpoint;
- it is printable ASCII and has no backslash;
- it has no scheme, host, fragment, network-path form, encoded slash or encoded backslash in its path.

The path and query are stored server-side under the imported one-use OIDC state. That state is also bound to the short-lived login cookie of the initiating browser. The callback accepts only `code` and `state` and never trusts a callback `next` parameter. It consumes the state, re-checks the stored path and preserves the connector authorize query exactly. A tampered callback burns the state.

### Web session lifetime

- The server enforces seven days without allowed human activity and thirty days overall.
- Authentication, data reads, cache checks, assets, CSRF issuance, event streams, health checks, redirects and failed sign-ins never extend the idle deadline. Only the server's explicit page and action allowlist touches last use.
- Activity never extends freshness.

### Fresh sign-in for risky actions

- Risky actions require the owner to have signed in with Google in the last 15 minutes. Normal and step-up requests both send `prompt=select_account`, with no `max_age` or `claims` parameter.
- Every exchange checks a numeric, non-boolean `iat` between the stored login record start minus sixty seconds and now plus sixty seconds, on top of the existing token checks. Freshness ends at `min(iat, now) + 900`, not at callback arrival.
- A stolen sign-in can still use a fresh window that is already open, for up to 15 minutes. It cannot open a new one by itself. Anyone who can use the owner's Google sign-in on a device can open a new window without a password. A forced re-sign-in with an `auth_time` requirement is not met; the 15-minute `iat` rule replaces it.
- Step-up replaces the session and its CSRF pool atomically, then returns to an allowlisted GET page. The original POST is never replayed. Ordinary sign-out, chat and reading need no step-up.
- The server stamps every outgoing `chat/1` with a boolean `fresh` and shows only "Fresh sign-in until <time>" or "Sign in again". Counting this flag toward high-risk chat approvals is not implemented policy. An idempotent send retry keeps the original message and its original send-time freshness.

### Device cookie and sign-out

- The host-only device cookie is a thirty-two-byte random handle with `Secure`, `HttpOnly` and `SameSite=Lax` and a thirty-day maximum age. It is not authorization. Only a server-key HMAC verifier is stored, scoped to the single pinned owner account.
- OIDC state binds that verifier at start and requires the same handle at callback. A successful sign-in revokes the old device session, creates its replacement and rotates the handle in one transaction.
- Invalid, missing, duplicate and unknown handles create a separate device. A ninth device ends the oldest idle session.
- Sign-out clears both cookies and revokes the owned CSRF pool. The Devices page shows coarse browser kind, sign-in time and last use, never an address or a raw user agent. Signing out another device or everywhere requires freshness; signing out this device does not.
- Signed out is an explicit page with a Sign in button, never an automatic Google return. The first schema migration ends existing sessions once.
- Lifecycle output is only `QD_SESSION_START` or `QD_SESSION_END reason=<signed-out|idle|overall|device-replaced|everywhere|cap>`, without values that identify anyone or any device.

## Containment

- The approval app container has a read-only root, dropped capabilities, no public port, bounded CPU, memory, processes and files, and only the private service network.
- A private Unix socket carries shared-session authorization between the approval sign-in service and the approval app. The socket is not public and is shared only with those two processes. The approval app presents the shared cookie and request facts to a private adapter, and the approval sign-in service applies the same `captain_auth` contract and returns only an authorization plus a fresh CSRF token. This keeps approval secrets out of the container that holds the mail key.
- The approval sign-in service imports `captain_auth.py`, passes it into `ApprovalApplication` for login, callback, logout, session and CSRF operations, and owns the private socket handler while keeping its caller limits and automatic login bans.
- The reference route set exposes four exact route matchers: the chat page and assets, the chat list, the generic chat thread and the event stream. It has no Task Card routes, no wildcard and no port 80. The public door stays HTTPS on port 443.

### Mail key separation

- The approval app alone mounts the owner's mail key directory. It loads one printable-ASCII line from a single-link file owned by the service with mode `0600` inside an owned `0700` directory. The long-lived key stays in one mutable buffer and is cleared on close and on failure. The JMAP transport makes only its short request-header copy.
- Startup also checks a readback object that proves the owner's account and mailbox, the exact imported mail permission set, no administrator role, no impersonation and a bounded request rate. The container receives no approval secret, administrator credential, Docker socket, public port or private-network dependency.
- The mailbox is opened with the registry's configured owner account. The mail server derives `From` from that authenticated account, and the adapter never accepts a caller-supplied sender.
- One process-owned checker refreshes every five seconds. Every open tab reads the same in-memory version through server-sent events, so tabs do not create extra mailbox polling. A transient check failure keeps the last good state.

## Deferred native-app refresh-token family contract

This is a future contract for native apps. It is not implemented.

- Each family must be bound to the app client, the owner account, the device record, the scope and the resource server.
- The server must enforce seven days idle and thirty days overall.
- Every use must atomically spend the current refresh token and create its sole replacement.
- Reuse of a spent token must revoke the active descendant, that family's access tokens and that device's push registration.
- Per-device sign-out must revoke the family's tokens, and sign-out everywhere must revoke every family.
- Store verifiers only, never token values, and never log either.
- Do not call this sender-constrained.

## Tests and limits

```sh
python3 -m unittest discover -s apps/server/captain-app -p 'test_*.py'
```

The suite imports the sibling server modules (`apps/server/approval`, `apps/server/shared`, `apps/server/door`, `apps/server/cards`) and the JMAP library under `apps/server/mail/`, so those must be importable. Also run their own tests from their own folders. No package install is needed.

The stand-ins do not prove a public cellular round trip, the roughly two-second phone target, browser rendering on the owner's phone, a real Google callback, a real mail-server permission readback or the deployment wiring.
