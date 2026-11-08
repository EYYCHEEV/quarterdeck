# Server payloads for Mail

The 14 files here are synthetic replies of the Mail API v1, made up for tests. They hold stand-in names and example mail only. This folder holds no copy of a reply from a running server. Tests that need a recorded reply use synthetic ones.

Each file is one JSON object with `status`, `headers` and `body`. In every body `csrf` is `"csrf-placeholder"` and `freshUntil` is `0`.

## How tests use them

- `mail_client_test.mjs` pins the sha256 of each file, so a change to a file needs the pin changed in the same change. It turns the bodies into the arguments of `parseMailList` and `parseMailThread`, and into the answers of a fake transport.
- `server_mail_test.mjs` reads them as the Mail replies of its fake transport.
- `apps/web/shell_test.mjs` serves `list-5-threads.json` as the reply of a routed request.

## What the samples follow

- A name (`bots`, `from`, `to`, `cc`) is one line of 1 to 255 characters, a thread lists at most 50 bots, a mail has at most 20 recipients and 50 attachments, and every mail carries `attachments`.
- The refresh event of the event stream has the data `{"cards":true,"chats":true,"mail":true}` on every event. The event stream itself is not in these files.

## The files

- `list-5-threads.json`: `GET /captain/mail`, five threads (MT-5 down to MT-1), newest first, null place.
- `list-empty.json`: the same on an empty mailbox.
- `list-truncated-200-threads.json`: 205 threads in the mailbox, the newest 200 (MT-205 down to MT-6) and `truncated` true.
- `list-not-modified-304.json`: the empty 304 for the five-thread list's ETag.
- `thread-with-attachments-and-refs.json`: `GET /captain/mail/MT-1`, four mails, two attachments on one, `refs` on two.
- `thread-html-only.json`: MT-2, a mail with only an HTML body, shown as plain text.
- `thread-sent-and-received.json`: MT-3, three mails, the last pointing at AR-12 and PG-7; one had CRLF line ends and arrives with LF.
- `thread-cut-long-body.json`: MT-4, one mail cut at 16384 bytes with `cut` true.
- `thread-omitted-older-mails.json`: MT-5, 60 mails, the newest 50 returned, `omitted` 10, first mail MT-5.11.
- `error-400-bad-ref.json`: a ref that is not a thread code.
- `error-401-sign-in-required.json`.
- `error-403-session-refused.json`.
- `error-404-no-thread.json`: a well-formed ref that names no thread.
- `error-503-request-unavailable.json`.
