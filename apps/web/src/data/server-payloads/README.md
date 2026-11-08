# Server payloads for the Queue

These files are synthetic replies of the Quarterdeck server's web API, made up for tests. They hold example data only. The client tests and the browser test read them in place of a real server. Every token in them is a made-up stand-in: `csrf` is `"csrf-placeholder"` and `freshUntil` is `0`, unless a test sets its own.

No file here is a copy of a reply from a running server. The files in `recorded/` and `answer/recorded/` were made by running the server's code in process with stand-in names only (`bot-a`, `repo-lead`, `account-user`, `example.com`), with no server and no network. Their sha256 values are pinned in `server_recorded_test.mjs` and `server_answer_recorded_test.mjs`, so do not edit them without updating the pins.

| Where | What it holds |
| --- | --- |
| this folder | Card lists and card documents |
| `answer/` | Receipts for answers and comments |
| `recorded/` | Nine replies of the cards API: the list of 31 cards, three cards, four errors and a not-modified answer |
| `answer/recorded/` | 27 replies of the answer API, each with its request and any mail the server queued |
| `chat/` | Chat rows, threads and a send receipt |
| `chat/v2/` | Samples of chat contract v2, with a `SHA256SUMS` index |
| `bots/` | Replies of the bots API |
| `mail/` | Replies of the Mail API, with [its own README](mail/README.md) |

## Rules the samples follow

- On a GET both 401 and 403 mean sign in again. The client keeps local data (seen marks, drafts), because only the server's sign-out clears it (`Clear-Site-Data: "storage"`).
- Any valid answer closes the card, `cant-decide` and `none` included: state `done`, `waitsOn` the poster.
- A card's lane is its latest non-blank lane, and the list's lane is used in both views.
- A well-formed id that names no card answers 400.

## The card files

Each is one JSON object. The tests turn each into a `Response`.

- `list-fixed-only.json`: `GET /captain/cards` with only the fixed fields (`id`, `title`, `project`, `lane`, `due`, `state`, `changed-at`), the case of a server that does not send the added fields yet. A done card there has no `answer`.
- `list-added.json`: cards in two projects and four lanes, with the lane name `Search` under both projects, answers with the picks `A`, `cant-decide` and `none`, and one plain-mail record that is not a card.
- `card-open.json`: `GET /captain/cards/<id>` (`card`, `rev`, `state`, `thread`) for one open card with pictures, commands, mail, page and artifact references, a one-way option, and a door of its own on an option. It is at `rev` 3, and its thread has four events (the card, an update, a comment, an update).
- `card-answered.json`: a done card whose thread holds an answer to a comment (pick B, no note) and the final answer (pick A, with a note). Only the final answer at the card's `rev` lands on the card.
- `card-withdrawn.json`: a withdrawn card with its `withdraw` event and an empty context.

How tests use them: `api_client_test.mjs`, `api_answer_test.mjs`, `server_card_test.mjs` and the other `server_*_test.mjs` files read them from disk. `apps/web/shell_test.mjs` serves them as the replies of routed requests: `GET /captain/cards` gets a list file and `GET /captain/cards/<id>` gets `card-open.json`.

## The answer and comment files

Written by hand in `answer/`. They cover client and source mechanics such as token rotation, the in-flight sign-out and the byte limits.

- `answer-200-current.json`: the receipt for an answer to the current revision: `message` (`Got it: <id> <pick> at <h:mm AM/PM> ET`), `stale` false, `rev`, and the new `csrf` and `freshUntil`. It is not the card document.
- `answer-200-stale.json`: the same for an older revision, `stale` true.
- `comment-200.json`: `{"status": "sent", "csrf": ..., "freshUntil": ...}`.
- `request-refused.json`: `{"error": "request refused"}`, the body of the 400 and of the 403.

`answer_body_test.mjs`, `api_answer_test.mjs` and the `server_*_test.mjs` answer tests read these files.

Some answers are written inline in the tests, for the cases the files do not cover: a 303 (`Location: /captain/step-up?next=/captain/chat`; the server sends it percent-encoded and the client never reads it), the 401, 404, 405 and 5xx. The 429 and the 503 in those tests get empty or arbitrary bodies, and the tests check the client does not read them.

## Client rules the answer tests check

- A 403 on a POST ends the session like a 403 on a GET. The client gives `SignInRequired` after the one POST and sends no read of its own, and it drops its token, its freshness and its held list. The source reports it through `sessionEnded`, so the server data goes, the stream stops and the one 61-second timer starts. While that lasts, an answer or a comment sends nothing and says `SignInRequired`, and the source never sends the draft again. A 303 stays a step-up and never ends the session.
- A `NotConfirmed` answer (a 503 after the request left, a network failure, an unreadable receipt) is checked by one GET of the card. If its thread shows an answer at the same revision with the same pick and the same note, it is treated as sent. The note must match: an earlier answer with the same revision and pick but another note does not count.
- The client does not parse the words of the receipt `message`. It drops a token when it sends it, so the next answer reads the list first.
- The answer and comment paths take the card id through the same check as the one-card read (letters, digits and hyphens, 1 to 64 characters, no leading hyphen), so an id like `..` or `a/b` can never reach the server.

## The chat files

Written by hand in `chat/` for the "Server Chat:" cases in `apps/web/shell_test.mjs`. The token is `"csrf-placeholder"` and `freshUntil` is `0`.

- `rows.json`: `GET /captain/api/chats`, three rows newest first: `iris`, `alba`, and `dale` with no messages (`preview`, `at` and `last` all `""`), last.
- `thread-iris-newest.json`: the newest 15 of the 30 messages of `iris`, `older: true`. One bot message holds HTML, which the app shows as text; the guard cases add a `<script>` and a `javascript:` link to it in the test.
- `thread-iris-older.json`: the 15 before those, `older: false`.
- `thread-alba.json` and `thread-dale-empty.json`: one message, and none.
- `send-200.json`: the flat 200 of `POST /captain/api/chat`, the sent message beside `uploadVerdicts: []`, `csrf` and `freshUntil`. The tests put the sent `text` and `clientId` in place of the placeholders.

The 429, 422, 400 and 502 refusals carry `{"error": "rate"}`, `bot`, `text` and `mail` inline in the tests, and a lost answer is an aborted request.

## The chat v2 samples

`chat/v2/` holds the ten files of the chat contract v2 samples, kept as written. `SHA256SUMS` lists the sha256 of each file; check them with `sha256sum -c SHA256SUMS` inside that folder. Do not edit the files without updating the sums. `chat_client_test.mjs` reads them.

- `rows.json`: two rows, one with `unread: true` and `rev` 42, one empty with `rev` 7.
- `thread-filled.json`: every field: `rev`, `features` (quote, read, seen, working, files), a message quote, a card quote, two file lists, `seenUpTo`, `seenAt`, `working` and `firstUnread`.
- `thread-r5-empty-values.json`: the contract's exact empty values; the client must read it to the same screen state as before.
- `read-request.json` and `read-answer.json`: `POST /captain/api/chat/read` with `{bot, upTo, csrf}` and its answer, exactly `{csrf, freshUntil}`. `freshUntil` is a number, as in every send answer.
- `send-quote-message.json`, `send-quote-card.json` and `send-files.json`: the send bodies for a message quote, a card quote and files.
- `mail-chat-1-with-quote-and-file.json` and `mail-chat-seen-1.json`: the two mail bodies (server side; the app does not read them).

Bounds the client chose where the contract gives none (a thread with a field outside them is unreadable, as with every field): a working note and a quoted text up to 4,000 code points; a message with up to 50 files, a file name up to 512 characters and a type up to 255; up to 64 feature names (unknown names are ignored, repeats collapse); a card id of 1 to 64 letters, digits and hyphens; a `rev` that is a whole number from 0 up.

## The bots files

Written by hand in `bots/` for `bots_client_test.mjs`, `server_bots_test.mjs` and the "Server Bots" cases in `apps/web/shell_test.mjs`. The token is `"csrf-placeholder"` and `freshUntil` is `0`; the tests set their own.

- `list-200.json`: `GET /captain/api/bots`. Two join requests (one invited by `Captain`, which the app shows as "you", and one invited by another bot), two open invites (one for a named bot, one for any bot), three joined bots, and `approveHere: false`.
- `invite-200.json`: the answer to `POST /captain/api/bots/invites`, with the new invite, its `code` and its `prompt`. The app shows both once and keeps neither.
- `action-200.json`: the answer to `POST /captain/api/bots/refuse` and `/invites/cancel`, exactly `{csrf, freshUntil}`.

Bounds the client chose where the contract gives none (a list with a field outside them is unreadable): a name, `invitedBy` or `by` of 1 to 64 characters with no control characters; an invite or bot id of 1 to 64 letters, digits, `_`, `.` or `-`; times with a date, a clock time and a zone; a token up to 512 characters; a prompt up to 4,096 characters. The refusals (303, 401, 403, 404 `gone`, 422 `name`, 429 `rate`, 400 and 503) are written inline in the tests.

Token rule: every action reads the list after the tap and posts that read's token, and no token from a list or a receipt is held. The contract does not say how long a token lasts, so a held token can go stale, and the 403 for it would end the session. `server_bots_test.mjs` checks this against a fake server that takes only the newest token it gave.

## What is not here

The event stream and the 404, 405 and 429 answers are written inline in the tests.
