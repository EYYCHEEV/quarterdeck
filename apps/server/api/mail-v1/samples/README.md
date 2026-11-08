# Mail API v1: recorded payloads

These files were recorded from the real Mail module (`mail_api.py`), in process: no server, no network, no live mailbox. They went through qd-web's own router (`webapp.QdWeb`), so the status and error text are the ones the router sends. The mail server is a stand-in that speaks the same mail protocol (JMAP) the live gateway uses and refuses anything that is not a read. The sessions are stand-ins, and every name is a stand-in (bot-a, bot-b, repo-lead, account-user, quarterdeck.invalid, example.com). The shape is in `../openapi.yaml` and follows the Mail API v1 note r3.

Each file is one JSON object with three keys: `status`, `headers` and `body`.
- `csrf` is replaced by `"csrf-placeholder"` and `freshUntil` by `0`. Neither is used for reading.
- `Content-Length` is recomputed for the placeholder body. A real token and a real `freshUntil` make a body about 40 bytes longer.
- A 304 has no body, so its `body` is `null`.
- Times (2 to 4 November 2026, offset -05:00) are made up. The mail ids the server uses inside are never shown: the API only shows thread codes (MT-n) and mail codes (MT-n.k).

| File | Request | What it shows |
|---|---|---|
| `list-5-threads.json` | `GET /captain/mail` | The list: 5 threads, newest first, with its ETag. The body is 1042 bytes |
| `list-not-modified-304.json` | `GET /captain/mail` with `If-None-Match` set to the list's ETag | The empty 304 with the same ETag |
| `list-empty.json` | `GET /captain/mail` on an empty mailbox | `threads` empty, `truncated` false |
| `list-truncated-200-threads.json` | `GET /captain/mail` with 205 threads | The newest 200 (MT-205 down to MT-6) and `truncated` true. The body is 36037 bytes |
| `thread-with-attachments-and-refs.json` | `GET /captain/mail/MT-1` | A thread of 4 mails from the inbox and the sent folder, with attachments (names and sizes only) and `refs` |
| `thread-html-only.json` | `GET /captain/mail/MT-2` | A message that has only an HTML body, shown as plain text |
| `thread-sent-and-received.json` | `GET /captain/mail/MT-3` | A thread he took part in; one mail arrived with CRLF line ends and is shown with LF only |
| `thread-cut-long-body.json` | `GET /captain/mail/MT-4` | A long body cut at 16384 bytes, with `cut` true. The body is 16962 bytes |
| `thread-omitted-older-mails.json` | `GET /captain/mail/MT-5` | A thread of 60 mails: the newest 50 are returned, `omitted` is 10 and the first mail is MT-5.11 |
| `error-400-bad-ref.json` | `GET /captain/mail/MT-0` | A malformed ref: 400 `request refused` |
| `error-401-sign-in-required.json` | `GET /captain/mail` with no session | 401 `sign in required` |
| `error-403-session-refused.json` | `GET /captain/mail` with a session the sign-in service refuses | 403 `request refused`, the real server's answer when the session is missing, expired or refused |
| `error-404-no-thread.json` | `GET /captain/mail/MT-99` | A well-formed ref that names no thread: 404 `not found` |
| `error-503-request-unavailable.json` | `GET /captain/mail` while the mail server cannot be reached | 503 `request unavailable` |

## The story the stand-in mailbox tells
- MT-1, `Search group limit: how many rows per group?`: the first mail comes from repo-lead; bot-a replies with two attachments; he answers from his sent folder; and a last mail from repo-lead, `Search group, final answer`, has another subject but names his answer in its In-Reply-To header, so it joins MT-1.
- MT-2, `Weekly build summary`: one mail from bot-b with only an HTML body.
- MT-3, `Release window`: bot-b asks, he answers (his reply arrives with CRLF line ends), and bot-b forwards with `Fwd:`, which joins the same thread. The last mail points at AR-12 and PG-7.
- MT-4, `Daily status`: one mail whose body is longer than the cap.
- MT-5, `Backlog digest`: 60 short mails from bot-b.
- Two more mails are in the stand-in mailbox and are never shown, because they are card mail and chat mail: `CARD: Pick the release day` and `CHAT: bot-a`.
- Thread numbers go by first appearance, oldest received first, so the oldest thread is MT-1.

## Which sign-in path each error comes from
- `error-401-sign-in-required.json`: the in-process sign-in check (`ApprovalGate`, the approval app's own session store). A request with no session cookie is refused there with 401 `sign in required`. The real server does not use this check.
- `error-403-session-refused.json`: the real server's sign-in path. `SocketApprovalGate` and `ApprovalAuthClient` are the real code. Only the socket is a stand-in, and it answers that the session was refused. The sign-in service was asked once, to authenticate. The answer is 403 `request refused`.
- On the real server a missing cookie, a refused or expired session, a sign-in service that cannot be reached and a bad reply from it all answer this same 403 (the tests check each). A fresh sign-in is never asked for on these GET routes, so there is no redirect.
- On a GET, clients should treat 401 and 403 alike: sign in again and keep local data. A 403 can also mean the sign-in connection failed, which is no reason to throw away his drafts. Local data is cleared only when the server says so: sign-out sends `Clear-Site-Data`, and the client never clears on its own.

## Worth knowing
- Card mail (subjects starting `CARD: `, `UPDATE: `, `ANSWER: `, `COMMENT: ` and `WITHDRAW: `) and chat mail (`CHAT: `) are never shown, whether or not their bodies are valid.
- `project`, `lane` and `card` are `null` and `cc` is `[]` in v1.
- `text` never holds a carriage return: the server turns CRLF and any lone CR into LF before it caps or scans the text.
- `refs` holds the AR-n codes then the PG-n codes found in the returned text only.
- A name (in `bots`, `from` and `to`) is one line of 1 to 255 characters, and a thread lists at most 50 bots, in first-appearance order.
- The server compresses JSON when the client accepts gzip. These files are the uncompressed application responses.

## Regenerate and check
- Regenerate into a new folder (files are never overwritten): `python3 -B make_samples.py --out NEWFOLDER`
- Check everything (from the `api-mail-v1` folder): `python3 -B -m unittest test_openapi_samples`
- If this folder is copied away from the `qd-web` tree, set `QD_WEB` to that tree's folder (the one that holds `mail_api.py`, `mail_standins.py` and the app modules). The generator and the check read the module code from there; without it they look one folder up from `api-mail-v1`.
- `SHA256SUMS.txt` lists every file in this folder except itself.
