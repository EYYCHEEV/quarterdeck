# Cards API v1: recorded payloads

These files were recorded from the real chat app code, in process: no server, no network, no live mailbox. The mailbox is a stand-in, the sessions are stand-ins, and every name is a stand-in (bot-a, bot-b, repo-lead, account-user, quarterdeck.invalid, example.com). The card checker is the real one. The shape is in `../openapi.yaml`.

Each file is one JSON object with three keys: `status`, `headers` and `body`.
- `csrf` is replaced by `"csrf-placeholder"` and `freshUntil` by `0`. Neither is used for reading.
- `Content-Length` is recomputed for the placeholder body. A real token and a real `freshUntil` make the list about 40 bytes longer.
- A 304 has no body, so its `body` is `null`.
- Mail ids (`msg-001`...) and times (2 November 2026, offset -05:00) are made up.

| File | Request | What it shows |
|---|---|---|
| `list-31-cards.json` | `GET /captain/cards` | The list: 31 cards in 3 projects (Fleet, Repo, Web) and 7 lane groups (lanes Docs, Launch, Ops, Review, Ship), 24 open, 4 answered (`done`), 3 withdrawn, and 2 plain-mail records for mail that is not a valid card |
| `list-not-modified-304.json` | `GET /captain/cards` with `If-None-Match` set to the list's ETag | The empty 304 with the same ETag |
| `card-open-with-thread.json` | `GET /captain/cards/repo-lead-7` | An open card at rev 3 with a thread of a card, two comments and two updates |
| `card-answered.json` | `GET /captain/cards/bot-a-3` | An answered card: `state` is `done`, the thread ends with the answer |
| `card-withdrawn.json` | `GET /captain/cards/bot-a-8` | A withdrawn card: `state` is `withdrawn`, the thread ends with the withdrawal |
| `error-400-unknown-card.json` | `GET /captain/cards/repo-lead-99` | A well-formed id that names no card: 400 `request refused` (not 404) |
| `error-401-sign-in-required.json` | `GET /captain/cards` with no session | 401 `sign in required` |
| `error-403-session-refused.json` | `GET /captain/cards` with a session the sign-in service refuses | 403 `request refused`, the real server's answer when the session is missing, expired or refused |
| `error-503-request-unavailable.json` | `GET /captain/cards` while the list source fails | 503 `request unavailable` |

## The card an update moved
`repo-lead-7` (Repo project). It was posted in lane Launch. Its first update (rev 2) moved it to lane Review, and a later update (rev 3) changed its title. In `list-31-cards.json` it appears only under Review, never under Launch, and its summary says `"lane": "Review"`, `"rev": 3`. `card-open-with-thread.json` shows the same card with `"lane": "Review"` and the update in its thread.

## Other cards worth finding in the list
- Answered: `bot-a-3` (pick A), `repo-lead-4` (pick `cant-decide`), `repo-lead-9` (pick B), `bot-b-2` (pick `none`). Each has `state` `done` and `waitsOn` set to its poster.
- Withdrawn: `bot-a-8` and `repo-lead-11` (no answer), and `bot-b-7`, which was answered and then withdrawn: it keeps its `answer`, `state` is `withdrawn` and `waitsOn` is `null`.
- Updated: `bot-a-5` (title and due, rev 2), `bot-b-4` (due, rev 2) and `repo-lead-7` (above).

## Which sign-in path each error comes from
- `error-401-sign-in-required.json`: the in-process sign-in check (`ApprovalGate`, the approval app's own session store). A request with no session cookie is refused there with 401 `sign in required`. The real server does not use this check.
- `error-403-session-refused.json`: the real server's sign-in path. `SocketApprovalGate` and `ApprovalAuthClient` are the real code. Only the socket is a stand-in, and it answers that the session was refused. The sign-in service was asked once, to authenticate. The answer is 403 `request refused`.
- On the real server a missing cookie, a refused or expired session, a sign-in service that cannot be reached and a bad reply from it all answer this same 403 (the tests check each). A fresh sign-in is never asked for on these GET routes, so there is no redirect.
- On a GET, clients should treat 401 and 403 alike: ask him to sign in again and keep local data. A 403 can also mean the sign-in connection failed, which is no reason to throw away his drafts. Local data is cleared only when the server says so: sign-out sends `Clear-Site-Data`, and the client never clears on its own.

## Size
The list body is 7572 bytes (compact JSON, with the placeholders). That is under 8 KiB for 31 cards.

## Worth knowing
- `from` is the poster, and stays the poster when someone else updates the card.
- The card document has `qd` and `card` only until its first update; after an update it has neither.
- A card is listed under its current lane. If an update removes or blanks the lane, the list keeps the last lane the card had.
- The server compresses JSON when the client accepts gzip. These files are the uncompressed application responses.

## Regenerate and check
- Regenerate into a new folder (files are never overwritten): `python3 -B make_samples.py --out NEWFOLDER`
- Check everything (from the `api-cards-v1` folder): `python3 -B -m unittest test_openapi_samples`
- If this folder is copied away from the `cards-api-v1` tree, set `CARDS_API_WORK` to that tree's `work` folder (the one that holds `captain-app`). The generator and the check read the app code from there; without it they look for `../work` next to the `api-cards-v1` folder.
- `SHA256SUMS.txt` lists every file in this folder except itself.
