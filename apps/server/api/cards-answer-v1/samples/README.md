# Cards answer API v1: recorded payloads

These files were recorded from the real chat app code, in process (BUILD-CARDS-ANSWER-V1): no server, no network, no live mailbox, no keys. The shape is in `../openapi.yaml`. The follow-up GET samples use the shapes of the frozen cards v1 API.
- Sign-in: the chat app's real `SocketApprovalGate` calls the real approval-owned sign-in service (`CaptainAuthSocketService`) over a private unix socket in a temp folder. Only the identity is a stand-in: nobody signs in, the sessions are started directly.
- Mail: the real `CaptainMailbox` and `qd_jmap.Mailbox` code run over a small in-memory stand-in mail service. The resend-key rule, the sent-mail read-back and the oversight-copy filter are the real code. The stand-in only stores messages.
- Names are stand-ins: bot-a (the steward), repo-lead, bot-b, account-user, quarterdeck.invalid. The clock is fixed at Thursday 5 November 2026, 10:00 AM ET, and moved by hand.
- The card service reads the mailbox back by hand (`check_once`), as the live server's 5 second check does. Until then the card still shows `open`.

## File shape
Each file is one JSON object with these keys, in this order.
- `request`: `method`, `path`, `headers` (only Content-Type) and `body` as sent. A POST body ends with `csrf`.
- `signIn`: `real` or `in-process` (see below).
- `status`, `headers` and `body`, as the app answered. A 303 has no body, so its `body` is `null`.
- `outbound` (POST samples only): the mail the stand-in mail service stored because of this request, by recipient (`to`) and `subject` only, never the body. `[]` means no mail was stored. A repeat the mailbox recognised as already sent is also `[]`.

Markers.
- `csrf` and `freshUntil` in a response are replaced by `csrf-placeholder` and `0`. In a request, `csrf` is shown as `csrf-placeholder`; `csrf-placeholder (already used)` marks a token spent earlier.
- `<4001 characters>` stands for a note of exactly 4001 `x` characters. The generator sends the real 4001.
- `Content-Length` is recomputed for the placeholder body.
- Mail ids in a thread that start with `qd.` come from the real resend-key rule (a hash of a stand-in name and key). Inbox ids (`msg-001`...) and times are made up.

## The cards in these samples
Eight cards, three projects. The steward bot-a gets a copy of every answer and comment, and gets one mail only when it posted the card.
- `repo-lead-1` (Repo, Review): two revisions; rev 2 adds option C. The stale answer and the revision and pick 400s use it.
- `repo-lead-2` (Repo, Ship): the first answer. `repo-lead-3` (Repo, Launch): the comments.
- `bot-a-1` (Fleet, Ops): `cant-decide`. `bot-a-2` (Fleet, Ops): the second answer. `bot-a-3` (Fleet, Launch): no answer ever succeeds on it, so it takes the error samples and stays open.
- `bot-b-1` (Web, Docs): `none`. `bot-b-2` (Web, Docs): withdrawn before it was answered.

| File | Request | Sign-in | What it shows |
|---|---|---|---|
| `answer-200-letter-pick-with-note.json` | `POST .../repo-lead-2/answer`, rev 1, pick B, a note | real | 200 receipt, `stale` false. Two mails go out: to the poster (repo-lead) and to the steward (bot-a) |
| `answer-200-older-revision-stale.json` | `POST .../repo-lead-1/answer`, rev 1 (the card is at rev 2), pick A, a note | real | 200 receipt with `stale` true: an older revision is accepted and sent |
| `answer-200-cant-decide.json` | `POST .../bot-a-1/answer`, pick `cant-decide`, a note | real | 200; the message says Can't decide. One mail, because the steward posted the card |
| `answer-200-none-empty-note.json` | `POST .../bot-b-1/answer`, pick `none`, an empty note | real | 200; the message says None of these |
| `answer-200-second-answer-to-a-done-card.json` | `POST .../bot-a-2/answer`, pick B, after an earlier answer A to the same revision | real | 200: a card that is already `done` takes a second answer with another pick, and a second mail goes out |
| `answer-503-second-answer-same-pick.json` | `POST .../bot-a-2/answer`, pick B again, same revision | real | 503 and no mail: the same revision and pick as the answer just before. It never clears |
| `answer-200-answer-to-a-withdrawn-card.json` | `POST .../bot-b-2/answer`, pick A on a withdrawn card | real | 200 and two mails: a withdrawn card still takes an answer |
| `answer-303-fresh-sign-in-needed.json` | `POST .../bot-a-3/answer` with a session whose fresh sign-in has ended | real | 303 to the step-up page, empty body, no mail. The token is spent |
| `answer-400-wrong-content-type.json` | `POST .../bot-a-3/answer` with Content-Type `text/plain` | real | 400. The token is not spent |
| `answer-400-extra-field.json` | `POST .../bot-a-3/answer` with a fifth field, `urgent` | real | 400. The token is not spent |
| `answer-400-id-not-shaped-like-a-card.json` | `POST /captain/cards/bad_id/answer` | real | 400, not the 404 note r2 says (issue 109) |
| `answer-400-unknown-card.json` | `POST .../repo-lead-99/answer` | real | 400 for an id shaped like a card that names no card. The token is spent |
| `answer-400-revision-does-not-exist.json` | `POST .../repo-lead-1/answer`, rev 3 (the card has 2) | real | 400. The token is spent |
| `answer-400-pick-not-on-revision.json` | `POST .../repo-lead-1/answer`, rev 1, pick C (C was added in rev 2) | real | 400. The token is spent |
| `answer-400-note-too-long.json` | `POST .../bot-a-3/answer`, a note of 4001 characters | real | 400. The token is spent |
| `answer-403-used-csrf.json` | `POST .../bot-a-3/answer` with a token that was already used | real | 403 |
| `answer-429-rate-limited.json` | `POST .../bot-a-3/answer` after 30 session checks in a minute | in-process | 429. Only the in-process sign-in answers this |
| `answer-403-rate-limited-on-the-real-sign-in.json` | the same request, after 30 session checks in a minute | real | 403: the real server's answer to the same rate limit (issue 111) |
| `answer-503-service-failure.json` | `POST .../bot-a-3/answer` while the mail service refuses the send | real | 503 and no mail. Retry with a new token |
| `comment-200-sent.json` | `POST .../repo-lead-3/comments`, requestId `req-0001` | real | 200 with `status` sent. Two mails go out: to repo-lead and to bot-a |
| `comment-400-empty-text.json` | `POST .../repo-lead-3/comments` with empty text | real | 400 |
| `comment-200-same-text-again.json` | the same text and the same requestId again | real | 200 and no second mail |
| `comment-200-same-text-new-request-id.json` | the same text with requestId `req-0003` | real | 200 and no second mail: requestId does not decide |
| `card-after-answer.json` | `GET /captain/cards/repo-lead-2`, after the answer mail was read back | real | `state` is `done` and the thread ends with the answer |
| `card-after-second-answer.json` | `GET /captain/cards/bot-a-2`, after the second answer | real | `state` is `done` and the thread holds both answers, A then B |
| `card-withdrawn-after-answer.json` | `GET /captain/cards/bot-b-2`, after the answer | real | `state` stays `withdrawn`; the thread ends with the answer |
| `list-after-answers.json` | `GET /captain/cards`, after every answer was read back | real | 8 cards. `state`, `answer` and `waitsOn` for each answered card, the stale answer, and the withdrawn card with its answer kept |

## Which sign-in path each sample comes from
- `real`: the chat app's `SocketApprovalGate`, the real `CaptainAuthSocketService` behind it and the real `ApprovalState` session store. This is how the real server decides sessions, tokens, fresh sign-in and rate limits.
- `in-process`: the chat app's `ApprovalGate`, the approval app's own session check. It is the only path that can answer 429, so `answer-429-rate-limited.json` is the one sample that uses it.
- The real sign-in service turns a rate limit into a plain refusal, so the chat app answers 403. `answer-403-rate-limited-on-the-real-sign-in.json` is the same request on the real path.
- The real server never answers 401 on these routes. A missing, expired or refused session answers 403, as in the cards v1 samples.

## Where the recorded behaviour differs from note r2
1. A second answer with the same revision and the same pick is refused with 503, and it never clears. Note r2 says a second answer is not refused. A different pick or revision goes out and the later answer wins (`answer-200-second-answer-to-a-done-card.json`, `card-after-second-answer.json`). Only a repeat word for word in the same second answers 200 with no new mail. Cause: the mail's resend key repeats while its words carry a new time, so a retry of one answer after a lost reply fails the same way. Filed as issue 108.
2. 429 never reaches a client on the real server. Note r2 says 429 means wait. On the real path a session over 30 checks in 60 seconds gets 403 (`answer-403-rate-limited-on-the-real-sign-in.json`); 429 is only in-process (`answer-429-rate-limited.json`). A GET counts one check and a POST two. A client told to treat 403 as "sign in again" gets that advice for up to a minute when it only needs to wait. Issue 111.
3. A repeated comment sends nothing new. Note r2 says it depends on the mail key and a sample will record it. The key comes from the card and the text, so the same text goes out once whatever its requestId and however long after (`comment-200-same-text-again.json`, `comment-200-same-text-new-request-id.json`). New text goes out again.
4. The 303 Location is percent-encoded. Note r2 writes `/captain/step-up?next=/captain/chat`; the server sends `/captain/step-up?next=%2Fcaptain%2Fchat`.
5. The receipt names cant-decide and none in words. Note r2 writes `Got it: <id> <pick> at <h:mm AM/PM> ET`. A letter pick shows the letter, `cant-decide` shows Can't decide and `none` shows None of these.
6. Tokens are spent by more than a 200. Note r2 says a used or stale token is refused. A 303, a 400 from the service (unknown card, revision, pick, long note, a refused comment) and a 503 also spend the token and return no new one. A 400 for a bad body (content type, a missing or extra field, over 16 KiB, a csrf that is not text) leaves it unspent. After any spent token, do a GET to get a new one.
7. A POST to a path that is not a card route answers 400, not 404. Note r2 says any other path is 404. The 404 branch can never be reached. Issue 109.
8. A list or an object for `rev` or `pick` answers 503, not 400. Found by a test, not a sample. Issue 110.
9. The content type must be exactly `application/json`. Note r2 says exactly; a charset suffix or capital letters answer 400.

## Confirmed as in note r2
- The 200 is a receipt, not the card. The card and the list change to `done` only after the mail is read back.
- An older revision is accepted with `stale` true. There is no 409.
- Answering needs a fresh sign-in (303 when not fresh); a comment does not.
- A done card and a withdrawn card still take an answer. A withdrawn card stays withdrawn and keeps the answer; the latest valid answer shows in the list.
- A note may be 4000 characters and 4001 is refused. A requestId is 1 to 80 of A-Z, a-z, 0-9, underscore or hyphen.

## Not recorded
- An answer mail the outbound check refuses (note r2 lists it as a 400). I found no input that triggers it: a stale answer whose pick was removed in a later revision is accepted and sent.
- The real mail server. The mail is a stand-in, so real delivery, a lagging sent copy and a refused recipient are not exercised.
- The front door. These POST paths are not routed yet, so headers it adds or removes, gzip and its own 404 and 405 are not in the samples.
- The step-up page. The 303 is recorded, not the sign-in behind it.
- The events refresh after an answer. The samples read the mailbox back by hand.

## Regenerate and check
- Regenerate into a new folder (files are never overwritten), from this folder: `python3 -B make_answer_samples.py --out NEWFOLDER`
- Check everything, from the `api-cards-answer-v1` folder: `python3 -B -m unittest test_openapi_answer_samples`
- `CARDS_API_WORK` is the app folder that holds `captain-app`. It defaults to `app` next to the `api-cards-answer-v1` folder. `CARDS_V1_DIR` is the frozen cards v1 folder that holds its `openapi.yaml`; it defaults to the folder next to this one or `api-cards-v1`. `CARDS_API_RECORD` is the app record, default `record/SHA256SUMS-CARDS-API-V1-APP.txt` next to the app folder.
- `SHA256SUMS.txt` lists every file in this folder except itself.
