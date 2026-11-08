# qd-web

The web server for the Quarterdeck app at `qd.example.invalid`. It is one standard-library Python service. It serves the web app's static bundle, the cards API v1 (list, one card, answer, comment), the events stream, a mount for the Mail module and the `/captain/chat` redirect.

Sign-in pages and the sign-in state belong to approval-qd (`apps/server/approval-qd`). qd-web only asks approval-qd's private auth socket whether a session is good.

Related notes: the seam to the Mail module is in `docs/internals/server-mail-seam.md`, and the chat contract is in `docs/internals/chat-contract-v2.md`.

## Routes

| Path | Methods | What |
|---|---|---|
| `/captain/cards`, `/captain/cards/{id}` | GET | cards API v1 |
| `/captain/cards/{id}/answer`, `/captain/cards/{id}/comments` | POST | answer and comment, as the frozen answer API |
| `/captain/events` | GET | server-sent events; every refresh event's data is `{"cards":true,"chats":<true or false>,"mail":true}`; `chats` is true only when the chat state changed in the span the event covers |
| `/captain/api/chats` | GET | the chat rows, newest first: `{bot:{id, name, note?}, preview, at, last, unread, rev}`; no query |
| `/captain/api/chat?bot=&before=&after=` | GET | the newest 15 messages of one bot, the 15 before `before`, or the messages after `after` (at most 50), oldest first, with `older`; a bot not in the list is 422 `bot` |
| `/captain/api/chat` | POST | send one chat message; body `{bot, text, clientId, csrf}` and an optional `quote`, at most 16 KB; the answer is one flat object `{id, from, text, at, refs, clientId, uploadVerdicts, csrf, freshUntil}`; no fresh sign-in; at most 10 sends a minute per session |
| `/captain/api/chat/read` | POST | mark read, see Chat answers; at most 30 a minute per session |
| `/captain/mail`, `/captain/mail/{ref}` | GET | the Mail module, when `mail_api.py` is in the package; otherwise 404 |
| `/captain/chat` | GET | 303 to `/`, empty body, no-store |
| `/`, `/queue`, `/queue/{id}`, `/lanes/{id}`, `/projects`, `/projects/{id}`, `/projects/{id}/pages`, `/projects/{id}/pages/{ref}`, `/projects/{id}/artifacts/{ref}`, `/chat/{id}`, `/mail`, `/mail/{ref}`, `/settings`, `/settings/{section}`, `/settings/bots/{id}` | GET, HEAD | the app page (`index.html`) |
| the bundle's own files | GET, HEAD | static files |

Every other path is 404 and every other method on a known path is 405 with an `Allow` header. A path with a character outside printable ASCII is 400. The older chat page, the `?with=` chat API and the chat assets are not served here; the approval app (the compose service `captain-app`) keeps them (`docs/internals/server-captain-app.md`).

## Chat answers

- A bot object is `{id, name, note?}`. `name` is the `botNames` entry for the id when there is one. Otherwise it is the id split at hyphens (empty parts dropped) with each word capitalised, and a short fixed list of product words spelled as written. It is left out when the result is empty, over 40 code points or not printable; the same check serves both (see `botNames` under Runtime config).
- A row is `{bot, preview, at, last, unread, rev}`. A thread is `{bot, rev, features, messages, seenUpTo, seenAt, working, firstUnread, older}`. `features` is `["quote","read","cursor"]` and names only what is built. `working` is `null`. A message adds `quote` (`null`, `{id, from, at, text}` or `{cardId, version}`) and `files` (always `[]`) to its older fields.
- A seen note is a mail with the subject `CHAT: <bot>` from the bot's own address whose body is exactly `{"qd":"chat-seen/1","bot":<that bot>,"upTo":<one of the owner's messages in that thread>}`. Anything else is ignored. Notes are never messages, previews, `last`, unread or replies, and the Mail module hides them like all `CHAT: ` mail.
- `seenUpTo` is the later of the newest valid note's `upTo` and the owner's newest message that comes before the bot's newest chat message, or `null`. `seenAt` is the time of the first note or bot message that covers it.
- The counted messages are the bot's chat messages after the owner's newest message (all of them when the owner has none). `firstUnread` is the oldest counted message without `$seen`, or `null`; a row's `unread` is true when any counted message lacks it.
- `rev` is the number from the first 13 hex digits of the sha256 of (last message id, `seenUpTo`, `seenAt`, `firstUnread`, `unread`, `working`), so it changes exactly when one of them does. The event stream names a chat when its row changes, including its `rev`.
- Newer only: `GET /captain/api/chat?bot=<id>&after=<message id>` answers the messages after that id, oldest first, at most 50, with the thread's other fields. An id that is not in that thread, or more than 50 newer messages, is 409 `cursor`. `after` together with `before` is 400.

### Mark read

`POST /captain/api/chat/read` with exactly `{bot, upTo, csrf}` (JSON, at most 4096 bytes, no query).

- It sets `$seen`, through `Email/set` with only the `keywords/$seen` key, on every bot chat message of that thread up to and including `upTo` that lacks it, and on that bot's valid notes up to then. It sets nothing else and never un-reads.
- The mail server allows 16 objects in one set and 8 calls in one request, so the ids go in sets of at most 16, at most 8 sets to a request (20 unread mails are one request of 16 and 4; 130 are two requests). Every set must be confirmed, or the mark is a mail failure.
- It writes only to the Inbox mail ids that each validated row carries, never to every mail with the same Message-ID. A second Inbox mail with the same Message-ID is marked with the row only when its sender, subject, body and time all match the row's. An id that is not an Inbox mail of the last listing is refused. With nothing to set it makes no mail call.
- It answers exactly `{csrf, freshUntil}`. A bot not in the list is 422 `bot`. An `upTo` that is not one of that bot's chat messages in the thread is 422 `read`. A body fault is 400. More than 30 a minute per session is 429 `rate`. A mail failure or a refused allowance is 502 `mail` at once, with no waiting.
- It needs no fresh sign-in and does not extend the session's idle time.

### Quotes

A send may add `quote`, either `{id, text}` (a message of that thread) or `{cardId, version}` (a card in the card index, version 1 up to its latest).

- The text is 1 to 280 code points and must sit inside the message by words. Runs of letters and digits are compared as written. A link's target and a list number at the start of a line are left out of the message's words. The first and last words of the quote may be part of a word, and nothing in the middle may be skipped. A quote with no letters or digits must be an exact part of the message.
- The server fills `from` and `at`; a send that carries them is refused.
- Every fault is 422 `{"error":"quote"}` and does not count toward the send limit.
- The `chat/1` mail carries the quote as sent. In a thread, a quote that fails the checks (also one over 4000 code points) shows as `null` and the message still shows.

## The card list and its size

The list has a content-derived `ETag`; an unchanged `If-None-Match` refresh returns an empty `304`. The server compresses every nonempty JSON response when the client accepts gzip. A 31-card stand-in list of open cards (one project and lane, short titles, a due time each) is 6934 bytes uncompressed, below 8 KiB. A 31-card sample with answered and withdrawn cards and two plain-mail records is 7572 bytes, also below 8 KiB; each answered card adds about 50 bytes.

## Mail server budget

The mail server allows 120 requests a minute for the owner's account, and the approval app uses the same account. So qd-web holds itself to 12 requests a minute idle and 60 a minute at most.

- One tick every 5 seconds makes one request: a JMAP `Email/get` with no ids, which returns the account's Email state. The cards list is read only when that state differs from the one at the last good read. The Mail module gets the same state text through `mail_state` and reads only when it changed. The state text is never sent to a client.
- Every request to the mail server goes through one counter (`mailstate.py`). In any 60 seconds the tick may use 36 and everything together 60, so the owner's own actions keep at least 24. A tick that cannot cover a refresh makes no request at all and tries again at the next tick.
- After any answer other than 200, or when the server cannot be reached, every request is held back for 10 seconds, then 20, 40 and at most 60 on repeats. A good answer clears it. Nothing leaves qd-web during a pause, so there is no retry storm, and a client that needs the mailbox gets 503. The tick and every other request never wait.
- A send has one 8-second deadline that starts when it arrives. It spends that deadline on waiting for its turn and on any pause together. Only one send is in the mail path at a time, and at most 4 may wait behind it, counting chats and card mail together.
  - One of the 4 places is kept for chat. Card answers, comments and notices fill at most 3: a card that arrives when 3 or more are waiting is refused at once, and a chat only when 4 are waiting.
  - Waiting sends get explicit tickets. The next send is the oldest waiting chat, and when no chat waits, the oldest waiting card send. Chats keep their arrival order, and a stream of cards cannot overtake a chat.
  - A send that meets a pause that ends inside what is left of its 8 seconds waits it out and goes on. A send whose 8 seconds run out, or that meets a longer pause, fails: 502 `mail` for a chat, with the log cause `SendBusy` or `BudgetRefused`. A card answer or comment goes through the same line and, when refused, gives its usual 503.
- If the server returns no usable state, the cards list is read once a minute instead and `mail_state` gives `blind-1`, `blind-2` and so on.
- Measured against the stand-in server: idle 12 a minute; busy (a change before every tick, the Mail module reading on each change) 51 in the worst 60 seconds, the tick alone 30; a server that answers 429 to everything is asked 4 times in 2 minutes.
- A chat send is put into the server's copy of the mailbox as soon as it succeeds, so the next thread read and the app's look-up by `clientId` find it. The copy holds at most the newest 64 such sends that no refresh has listed yet; an older one leaves the copy. The next refresh that lists a message replaces it, and the thread never shows it twice.
- The copy keeps the mail server's read mark (`$seen`) of every message. A mark read sets it at once in the copy, and a refresh that began before the mark and ends after it does not undo it.
- With `incremental` on, a refresh asks `Email/changes` since the state the tick read, fetches only the changed messages (with `keywords`) and gives the list a full read would give. On any doubt (no earlier state, an error such as `cannotCalculateChanges`, `hasMoreChanges`, more than one page of changes, an unusable new state) it reads everything again.

## Log lines

One line each to stderr. None carries message text, a client id, a cookie, a token or an address.

- `QD_CHAT_REPLY route=<list|thread|send|read> status=<code> error=<the answer's error code, spaces written as _, or -> cause=<class name of the innermost exception, or -> ms=<whole milliseconds>`: every answer on `/captain/api/chats`, `/captain/api/chat` (GET and POST) and `/captain/api/chat/read`. A newer-only read (`after`) is logged as `thread`.
- `QD_MAIL_REFRESH ms=<n> requests=<n>`: a refresh of the copy ran (also one that failed). A tick that finds the state unchanged logs nothing.
- `QD_MAIL_BUDGET refused=<pause|full> background=<true|false>`: the counter refused a request.
- The two mail lines share a cap of 30 lines a minute. After a capped minute one `QD_MAIL_LINES_SUPPRESSED count=<n>` line says how many were left out.

## Static bundle

- Served from the folder named by `bundleDir` (default `/opt/quarterdeck/qd-web/static`, read only). The folder is read once at start into a table, and a request path is only ever looked up in that table, never joined to a folder.
- Start is refused when the folder is missing, has no `index.html`, or breaks a size limit (4096 files, 16 MiB a file, 128 MiB in all).
- Skipped and listed, not served: links, dot files and folders, names with characters outside `A-Z a-z 0-9 . _ ~ @ + = -`, anything under `captain/`, and extensions outside a short allow-list.
- `index.html` and the app pages get `Cache-Control: no-store` and no `ETag`. Hashed chunks (`chunk-` plus eight capital letters or digits and `.js`, at the top level) get `public, max-age=31536000, immutable`. Everything else gets `no-cache` with a strong `ETag` and `304`.
- Content-Security-Policy: `default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. Each inline script in `index.html` is hashed at start and added as `script-src 'self' 'sha256-...'`.

## Runtime config

`runtime.json` is read once at start. The template is `runtime-config.template.json` in `deploy/qd-web/`; the deployment placeholder `${deployment:jmap-session-url}` is filled when the config is rendered.

- Required: `format` (1), `bindPort` (8080 in the template), `jmapSessionUrl`, `keyPath`, `keyReadbackPath`, `registryPath`, `authSocket`.
- Optional: `bundleDir`, `mailStatePath`, `chatBotsPath` and `botNames`.
  - `mailStatePath` is the one file in the state volume that holds the Mail thread table. With `mail_api.py` in the package it is required and its folder must exist (see `docs/internals/server-mail-seam.md`).
  - `chatBotsPath` is the file `chat-bots.json` that lists the bots the owner may chat with.
  - `botNames` is an object from bot id to display name.
- Every path must be absolute. Any other key is refused.
- `botNames` is checked once at start and never at request time. Each id must match `[a-z][a-z0-9-]{0,31}`. Each name must be a string of 1 to 40 code points with no character of the Unicode categories Cc, Cf, Cs, Co or Cn (so no control, bidirectional, joining or zero-width, surrogate, private-use or unassigned character) and no separator other than the plain space. Ordinary non-ASCII letters and plain spaces pass; a joined emoji needs a joining character and is refused. Any fault stops the start with `Captain runtime configuration is invalid`. A name here wins over the naming rule, and the names the rule makes pass the same check.
- Without `chatBotsPath`, or when the file is missing or invalid, the chat list holds the steward bot only. One fixed line `QD_CHAT_BOTS_REFUSED` is logged for each run of failures, and no earlier copy of the file is kept.
- The `chat-bots.json` file is read again on every list and every send. It must be a regular file of at most 4096 bytes, not writable by group or other, owned like its folder, holding exactly `v` (1), `at` (a whole number of seconds since the epoch) and `bots` (at most 64 names of the form `[a-z][a-z0-9-]{0,31}`). A file without `at` is refused. As in the Mail module's chat reader, a file is also refused when its `at` is more than 90 seconds older than the server clock or more than 60 seconds ahead of it, so a list that stopped being refreshed cannot keep a removed bot.

## Container

The Compose fragment is `compose-fragment.json` in `deploy/qd-web/`; `package_plan.py` validates it. The service runs as the approval app's user 2700:2700 with one extra group, 2711, for the qd-auth socket. It has a read-only root, all capabilities dropped, no-new-privileges and no published port (the reverse proxy reaches port 8080 on the service network). The one stated layout exception is that qd-web shares the approval app's user, because the mailbox key reader accepts only a key owned by the running user.

| Host | In the container | Mode |
|---|---|---|
| `${QD_PACKAGE}/qd-web` | `/opt/quarterdeck/qd-web` (code and `static/`) | ro |
| `${QD_ROOT}/qd-web-config` | `/etc/quarterdeck-qd-web` (`runtime.json`) | ro |
| `${QD_ROOT}/secrets/captain-mail-key` | `/run/quarterdeck-captain-mail` | ro |
| `${QD_ROOT}/volumes/captain-state` | `/var/lib/quarterdeck-captain` (registry and key readback) | ro |
| `${QD_ROOT}/volumes/qd-web-state` | `/var/lib/quarterdeck-qd-web` (mail thread table) | rw |
| `${QD_ROOT}/volumes/qd-auth` | `/run/quarterdeck-qd-auth` (auth socket) | ro |

## Files

- Shared with the approval app and taken unchanged: `auth_bridge.py`, `cards.py`, `checker_adapter.py`, `mail_gateway.py`, `security.py`, `approval_app.py`, `approval_security.py`, `invite_prompt.py`, `door_policy.py`, `qd_cards.py`, `qd_jmap.py`.
- Changed for qd-web: `application.py` (chat removed, one shared failure mapper), `live.py` (the state gate and the fixed event text), `server.py`.
- Specific to qd-web: `webapp.py` (the router), `bundle.py`, `mounts.py`, `mailstate.py`, `package_plan.py`, `chat_api.py` (chat rows, threads, send, mark read) and `bot_list.py` (the `chat-bots.json` reader).

`application.ApprovalGate` is the approval app's in-process session gate, kept byte for byte because the frozen sample generators and the frozen answer suite build it. `server.py` never builds it: sessions are checked only through `auth_bridge.SocketApprovalGate`, and a test pins both facts.

## Tests

```sh
python3 -m unittest discover -s apps/server/qd-web -p 'test_*.py'
```

The suites cover the routes, the static bundle, the server, the modules shared with the approval app, the mail budget, the package plan, the frozen answer samples and the cards. They use stand-ins for sign-in and mail.
