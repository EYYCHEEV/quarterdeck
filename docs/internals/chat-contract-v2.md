# Chat contract v2

The agreed contract between the server (`apps/server/qd-web`) and the web app (`apps/web`) for chat v2: quotes, read marks, seen and working state, files, a fast sync read and bot display names. It is a design note. The server's routes and limits are in `apps/server/qd-web/README.md`.

Filled samples that follow this contract are in `apps/server/api/chat-v2/samples/` (10 files with a `SHA256SUMS` index). The web app keeps byte-identical copies in `apps/web/src/data/server-payloads/chat/v2/`. They cover a thread with every field, a thread with the exact empty values below, rows with `unread: true` and `rev`, both quote kinds on send, files, the mark-read request and answer, and the two mail bodies. `freshUntil` is a number of seconds, as in the send answer.

## Rules

1. **Additive only.** Mail bodies stay `chat/1`. New fields are optional, with fixed empty values.
2. **What a client from before v2 needs, exactly.** Thread `seenUpTo`, `seenAt` and `working` present and `null`; chat row `unread` present and `false`; send answer `uploadVerdicts` present and `[]`. A missing or filled value breaks that client. It ignores a message's `quote` and `files`, the thread's `firstUnread`, and any new key.
3. **So the server does not fill** `seenUpTo`, `seenAt`, `working`, `unread` or `uploadVerdicts` until the v2 app release is in use. The fields the older client ignores may come earlier.
4. **Mail stays the carrier.** The seen note is mail under a new `qd` kind. The working signal is not mail.
5. **One contract for both apps.** The approval app (the compose service `captain-app`) ignores what it does not show yet.
6. **The mirror rule: the app never sends what the server cannot take yet.** Every thread answer carries `features`, a list of switched-on names, with `[]` as the empty value. A missing `features` means `[]`.
   - The server adds names as each part goes live: `"quote"`, `"read"` and `"cursor"` first, `"seen"` and `"working"` later, and `"files"` only after the app's attach change is live (the first v2 release reads file lists but keeps the + button and file paste off).
   - The app turns on the Quote action, the card quote, mark-read and the attach button only when that name is there. So one app release covers the whole run.
   - `features` sits on the thread answer, not the chat list. `GET /captain/api/chats` answers a bare list, and making it an object would break the older client, which ignores new keys on the thread answer.
7. **`rev` keeps seen and working fresh.** Each chat row carries `rev`, a number that changes whenever that thread's seen mark, working state, unread mark or last message changes. The thread answer repeats it. The app re-reads the open thread only when `rev` differs. A missing `rev` means no extra reads. It may also change on a server restart, which costs one extra read. The list stays a bare array.
8. **Strict and bounded.** A malformed new field makes the thread unreadable, as every field does. So **the server never emits a malformed field**: a bot-written quote that fails its checks becomes `null`, and the message still shows.
   - "Characters" means code points. A message quote's `from` is `"captain"` or `"bot"`.
   - The app sends a quote of at most 280 code points and reads up to 4,000. The server refuses the owner's quote over 280, and passes a bot's quote up to 4,000 without cutting it.

## A. Chat mail bodies

The subject stays `CHAT: <bot>`.

| Kind | v2 |
|---|---|
| Message | `{"qd":"chat/1","bot","text","clientId","fresh"}`, plus optional `quote` and `files` |
| Message quote | `{"id": <mail id>, "text": <the owner's exact selection or the whole message, at most 280 characters>}`, or the card kind `{"cardId", "version"}`. One level only |
| Seen note (bot tool) | `{"qd":"chat-seen/1","bot","upTo": <mail id>}`. Hidden from threads and the Mail screen |
| File ref | `{"id","name","type","size","kind": "photo" \| "file"}`, pointing into the files service. No bytes in mail |

## B. Server to app

Empty value first.

| Where | v2 |
|---|---|
| Thread message | `quote: null \| {id, from, at, text} \| {cardId, version}`; `files: [] \| [file ref + url]` |
| Thread | `seenUpTo: null \| <the owner's message id>`, `seenAt: null \| <time>`, `working: null \| {note, since, updatedAt}`, `firstUnread: null \| <bot message id>`, `features: [] \| [names]` (the mirror rule) |
| Chat row | `unread: false \| true` (the dot), `rev` (the `rev` rule) |
| File url | same origin, `/captain/api/files/<id>` |
| Bot object (chat rows and thread) | `name`: absent \| a display name of 1 to 40 code points, such as "Bot A". Ids never change. |

The server makes `name` from the id by the naming rule: split at hyphens, drop empty parts, capitalise each word, and spell a short fixed list of product words as written. An override list in the qd-web runtime config (`botNames`, bot id to name, set by the operator) comes first, for renames. So every bot has a `name`. The app shows `name` when present and the id otherwise. It ships in the first server release with quotes.

## C. App to server

| Call | v2 |
|---|---|
| Send | `bot, text, clientId, csrf`, plus optional `quote` (a message `{id, text}` or a card `{cardId, version}`) and `files: [<file id>]`. The server checks that the quoted message is in that thread, or that the card is the owner's at that version. The card kind carries Talk to and Ask and replaces the older card line |
| Mark read | `POST /captain/api/chat/read` with `bot, upTo, csrf`. It sets the mail read mark up to `upTo` in the owner's mailbox, which the approval app sees too. It answers exactly `{csrf, freshUntil}`, like send; the app ignores other keys, and anything else counts as not marked. It is a new door route |
| Files | new `GET /captain/api/files/<id>`, a new door route |
| Newer only (sync) | `GET /captain/api/chat?bot=<id>&after=<message id>` answers only the messages after that id, oldest first, with the thread's other fields and `rev`. An unknown or dropped id answers 409 `{"error": "cursor"}`, and the app then reads the newest page. The thread lists `"cursor"` in `features` when this is on; the app never sends `after` before that |

Example rows, mark-read request and answer:

```json
[
  {"bot": {"id": "bot-a"}, "preview": "Looking at it now.", "at": "<time>", "last": "Mb0a4", "unread": true, "rev": 42},
  {"bot": {"id": "bot-b"}, "preview": "", "at": "", "last": "", "unread": false, "rev": 7}
]
```

```json
{"bot": "bot-a", "upTo": "Mb0a4", "csrf": "CSRF"}
```

```json
{"csrf": "CSRF2", "freshUntil": 1794000060.0}
```

### Quote checks

- **Message quote text:** the owner's exact selection, or the whole message. At most 280 code points; a longer text is cut at the last whole word inside 280 code points, as a plain prefix with no "..." added (any fold is display only). It must not be empty.
- **The inside check:** the server accepts the quote only when the quoted message is in that thread and its text contains the quote text.
  - Both sides compare word sequences: runs of Unicode letters and digits (the classes `\p{L}` and `\p{N}`), as written, so accents and other scripts match. Markdown marks, list bullets and line breaks in the source never cause a refusal.
  - When the server makes a message's word list, it skips a link's target (the `(url)` right after `](text)`) and a list number at the start of a line (such as `1.` or `2)`), so a quote of what the owner sees on screen passes too. Nothing else is skipped, so a quote can never leave out a word from the middle of the message.
  - The first and last words of the quote may be part of a word (a selection that starts or ends mid-word): the first must end a word of the message and the last must start one, and the words between must match whole and in order. A one-word quote needs only to be part of one word of the message.
  - A quote with no letters or digits (an emoji, say) is checked as exact text instead.
  - The app runs the same check before sending. When it fails (rare: a selection across numbered list items), the app quotes the whole message instead.
  - The server stores and sends on the text exactly as the owner sent it.
- **Card quote:** accepted when the card is the owner's and `version` is a version that card has had (1 up to its current one). Card and message quotes switch on together under `"quote"`, so Task Card "Talk to" sends a real card quote from then on.
- **The server fills** `from` and `at` for a message quote. The owner never sends them; a send with them is refused.
- **One refusal for every quote fault:** status 422, body exactly `{"error": "quote"}` (unknown id, message not in that thread, text not inside, too long, empty, card not the owner's, unknown version, malformed). The app shows its own words on the failed row with no Try again, for example "Not sent: that message is no longer in this chat." The server never writes words for the screen.
- **To the bot:** the `chat/1` mail carries the same `quote` object the owner sent, as in the sample `mail-chat-1-with-quote-and-file.json`. A bot's own quote that fails these checks becomes `null` in the thread (the strict and bounded rule), and the message still shows.
- **Until `"quote"` is listed,** the long-press menu shows Copy only, so a missing Reply is not a bug.

## D. Working signal

- The bot's tool sends `working` with a short note, then `idle`, to the server, not as mail. The server keeps it in memory.
- It clears on `idle`, on the bot's next chat message, or after a 60-minute cap. The app itself shows "No word for 10 minutes".
- **Open:** how the server checks the bot. The lean is its own mail key, checked against the mail server the way the join service does, never a new key type.

## E. Faster arrival

The server listens to the mail server's own push for the owner's account, and keeps the 5-second check as a fallback. No contract change.

## F. Bots

Bots write `chat/1` bodies themselves and send them with `qd send`, already in Markdown. So the bot side is the chat skill and instructions plus an optional small `qd chat` helper for quote, seen and working, not a change hidden in one tool.

## Still open

1. **Files url and the page's content rules.** If `/captain/api/files/<id>` redirects to storage, the browser checks the storage address against the page's image rules. Choose one: (a) the server streams the bytes, which costs server traffic; or (b) the page's rules allow the storage download address for pictures and files only. Decide in the files build, with a security review.
2. **The working signal's identity check** (D).
