# Mail module seam

How qd-web (`apps/server/qd-web`) and the Mail module (`mail_api.py`) fit together. The Mail module is imported by qd-web at start. This note fixes the one class the Mail module provides, what qd-web passes in, how errors map, and how both sides stay inside the mail server's request budget.

## Who owns which files

- The Mail module owns `mail_api.py`, its tests, `mail_standins.py` and the mail API contract in `apps/server/api/mail-v1/`.
- qd-web owns every other file in `apps/server/qd-web/`.
- Neither side edits the other's files. A change that is needed in the other side's file is requested from that side.

## The class the Mail module provides

```python
class MailApi:
    def __init__(self, mailbox, sessions, *, clock, mail_state_path, mail_state): ...
    def handle(self, request, path) -> approval_app.Response: ...
```

- `mailbox`: the one `mail_gateway.CaptainMailbox` the cards use (same credential, same object). Read only; the Mail module never writes to the mailbox. Every request it makes goes through qd-web's metered transport (see the budget).
- `sessions`: the session gate (`application.SessionGate`: `authenticate`, `issue_csrf`, `fresh_until`).
- `clock`: a function returning seconds, like `time.time`.
- `mail_state_path`: the absolute path of one file inside the qd-web state volume (in the container: a file under `/var/lib/quarterdeck-qd-web`, a folder that only qd-web reads and writes). The thread table (MT-n numbers, only ever growing) lives in this one file. The Mail module creates the file if it is missing, with mode 0600, and writes nowhere else. qd-web checks only that the path is absolute and that its folder exists when it starts; it never creates or reads the file. A test passes a path inside a temp folder.
- `mail_state`: a function with no arguments that returns the mailbox's current Email state as text, from qd-web's newest good tick (at most 5 seconds old). It costs no request. It returns `None` only before the first tick has finished. A different text means something in the mailbox changed (mail arrived, was sent, or was changed).

`fingerprint()` is not called by qd-web. The Mail module finds changes only through `mail_state`.

### `handle(request, path)`

It is called only for GET of `/captain/mail` and `/captain/mail/<segment>`. Before it is called, qd-web has matched the route and method, refused any query string with 400 (no query parameters in v1), and refused a segment longer than 128 characters or with a character outside printable ASCII or a slash. Everything finer (the MT-n shape, 400 for malformed, 404 for unknown) belongs to the Mail module.

- It checks the session itself with `sessions.authenticate(request)` (one session check, as a cards GET does), then builds the answer.
- Build JSON answers with `application.CardApplication._response(status, payload, extra_headers)` so the headers equal the cards headers byte for byte. If the 200 carries `csrf` and `freshUntil` like the cards 200s, set them with `sessions.issue_csrf(owner)` and `sessions.fresh_until(owner)`.
- For the list's ETag and 304, use `application.etag_matches(request, etag)`, a module-level helper. It is the exact rule the cards list uses: one quoted value, no `W/` prefix, no list.

### Errors

Do not build error JSON. Raise, and qd-web maps:

| Raised | Answer |
|---|---|
| `application.NotFound` | 404 `{"error":"not found"}` |
| `cards.CardRefused` | 400 `{"error":"request refused"}` |
| `application.AuthenticationRequired`, `approval_security.ApprovalRefused` (from `sessions.authenticate`) | the same 401 and 403 as cards |
| anything else, including `qd_jmap.MailFailed` and any `OSError` | 503 `{"error":"request unavailable"}` |

## The mail server budget

The mail server allows 120 requests a minute for the owner's account, shared with the approval app (the compose service `captain-app`). qd-web's whole spend is held to at most 12 a minute idle and at most 60 a minute busy.

What qd-web does (it owns the tick):

- One tick every 5 seconds makes one request: a JMAP `Email/get` with `ids: []` for the account, and takes `state` from the answer. That is the only request an idle tick makes (12 a minute).
- The cards list is read only when that state differs from the state at its last good read. A refresh that fails leaves the old state in place, so the next tick tries again.
- If the server does not return a usable `state`, qd-web reads the cards list once every 60 seconds instead, and `mail_state()` then returns `blind-1`, `blind-2`, and so on, one new text per read. The Mail module needs no special case.
- Every request to the mail server goes through one metered transport (`mailstate.MeteredTransport`). In any 60 seconds it admits at most 36 requests from the tick and at most 60 in all, so the owner's own actions keep at least 24. A refusal never reaches the server: it raises `mailstate.BudgetRefused`, an `OSError`.
- After any answer other than 200, or when the server cannot be reached, the transport pauses every request for 10 seconds, then 20, 40 and at most 60 on repeats. The next good answer clears the pause. During a pause no request leaves qd-web, so there is no retry storm. The client gets 503.

What the Mail module does (rules for `handle` and everything under it):

1. Never read the mailbox on a timer, in a thread of its own, or at import. Read only inside `handle`.
2. Before the first mailbox request of a call, call `mail_state()`. If it returns a text equal to the text recorded at the last good sync, and the module's own full sweep is not due, make no request and answer from what it holds. If it differs, or is `None`, sync (its own 5-second limit may stay as a second guard).
3. Record the text seen before the sync starts, and store it only when the sync finishes. A change during the sync is then caught by the next call.
4. Let every mailbox failure (`qd_jmap.MailFailed`, `OSError`, including `BudgetRefused`) propagate unchanged. No retry, no loop, no catch and continue. Do not store the new state text, so the next call tries again after the pause.
5. The full sweep (every 600 seconds) may stay. It is counted with the owner's own actions.
6. Do not call `fingerprint()`.

## How it is mounted

`mounts.load_mail(...)` in qd-web imports `mail_api` and builds `MailApi(...)`, passing `mail_state` as above. If the module `mail_api` does not exist, mail is not mounted and `/captain/mail` is a plain 404. Any other import error, or a module whose constructor lacks the `mail_state` keyword, stops the server at start. So the Mail module's file can appear in the package with no edit to qd-web's files.

## Recording samples and tests

`webapp.QdWeb(card_application, bundle, mail=MailApi(...))` with `handle(request)` is the whole qd-web router. It can be built with stand-in sign-in and mail, as qd-web's own tests do. For a test, `mail_state` can be a plain function returning a changing text.

```sh
python3 -m unittest discover -s apps/server/qd-web -p 'test_*.py'
```

## Ids and mounts fixed for the Compose fragment

- qd-web runs as `2700:2700` (the approval app's user) with one extra group `2711` for the qd-auth socket (`group_add: ["2711"]`).
- The state volume is `${QD_ROOT}/volumes/qd-web-state:/var/lib/quarterdeck-qd-web:rw`, owned by 2700, mode 0700.
- The runtime config key `mailStatePath` holds `mail_state_path`.

See `apps/server/qd-web/README.md` for the runtime config and the full container table.
