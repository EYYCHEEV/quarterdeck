# Data interface

Every screen of the web app reads and changes data through one small interface, `QdData`. The default build answers it with the example world, which is synthetic. A build made with `--server` answers it from the Quarterdeck server. The choice is made in one place, `apps/web/src/shell/main.tsx`, and no screen changes.

## Where things live

| File | What it holds |
| --- | --- |
| `apps/web/src/domain/types.ts` | The models: `World`, `Card`, `Answer`, `Choice`, `Project`, `Lane`, `Task`, `Bot`, `MailThread`, `Page`, `Artifact`. No React, no DOM. |
| `apps/web/src/domain/*.ts` | The rules on those models: Queue order and why line (`queue.ts`), answers and receipts (`answer.ts`), filters and sort (`query.ts`), search (`search.ts`), references (`references.ts`), time text (`time.ts`: `whenText` reads a clock time on the same New York day, a weekday and time within 7 days, a date and time after that), routes (`routes.ts`), what is new since the Captain last looked at a Lane (`seen.ts`) and the Lane tracker (`tracker.ts`: the stage row, the step and count lines, Stages, blockers, quiet Lanes, the Captain's Approve on a sign-off card). Tested with `node --test`. |
| `apps/web/src/data/source.ts` | `QdData`, `AnswerInput` and the `Refused` error. |
| `apps/web/src/data/example-data.ts` | `createExampleData(switches, cardApi?)`: the example world behind `QdData`, built once from the card stand-in (or the card API given), the card content and the fixtures. |
| `apps/web/src/data/world.ts` | `buildWorld()`: turns card threads, content and the session (answers, seen) into one `World`. |
| `apps/web/src/data/example-content.ts`, `card-content.json`, `test-fixtures.json` | Projects, Lanes, bots, Mail, Pages, Artifacts and the card content by id, and the fixture cards F-1 to F-5. |
| `apps/web/src/data/hooks.tsx` | `DataProvider`, `useQd()`, `useWorld()` (the world, the time of the last good list, `failed` and `retry`) and `useEvidence(cardId)`. |
| `apps/web/src/data/session.ts` | What lives only while the app is open: Queue search, filters, sort and scroll, answer drafts per card version, chat drafts, the last receipt. |
| `apps/web/src/data/settings.ts` | Settings (appearance: System, Light or Dark), kept in localStorage `qd.settings`. |
| `apps/web/src/data/chat-types.ts`, `chat-example.ts`, `chat-hooks.ts` | `ChatApi`, the example chat (Seen, writing, reply, and a `firstUnread` for a bot seeded unread) and its hooks. A thread carries `seenUpTo`, `seenAt`, `working`, `firstUnread` and `features` (the names the server switched on); the server chat part also marks a thread read (`POST /captain/api/chat/read`) and re-reads an open thread when a row's `rev` changes. |
| `apps/web/src/data/card.ts`, `example-cards.ts`, `card-api.ts`, `card-standin.ts` | Card contract v1, the example card threads and the card API with its in-memory stand-in (below). |
| `apps/web/src/data/loader.ts` | `createLoader()`: loading, failed and retry for one read, newest load wins, a failed reload keeps the last value. |
| `apps/web/src/data/evidence.ts`, `evidence.json`, `evidence-fixtures.json`, `apps/web/public/evidence/media/`, `apps/web/fixtures/evidence/media/` | `toEvidence()`, the card evidence shipped with the example data, the test-only evidence cards EV-1 to EV-6, and the pictures, posters, screenshots and video they name. The build copies `apps/web/public` into the app, so a file `media/x.png` is served at `/evidence/media/x.png`. The test-only pictures live in `apps/web/fixtures`, which only a `--fixtures` build copies. |
| `apps/web/src/data/pages.ts`, `pages.json`, `pages-fixtures.json`, `pages/*.html`, `page-files.ts`, `apps/web/src/domain/pages.ts`, `apps/web/src/domain/page-public.ts` | The example Pages content (each Page's Lane, pinned, public state and versions, and the make-public card with its Evidence), the test-only Pages PG-8 and PG-9, the local Page files (one per kept version), and the rules for the list, the viewer and publishing. `pages.json` is read by key, so only the keys the app uses reach the first load. |
| `apps/web/src/data/lanes.json`, `lanes-addendum.json`, `lanes-seen.json`, `lanes.ts` | The Lane trackers of the 8 example Lanes, the addendum (help text for one Lane, a sign-off card, Lane renames and new Activity lines) and each Lane's last-looked time. `exampleLanes()` merges the addendum into the Lanes; `lastLooked` on a `Lane` is its last-looked time, or `null` when the Captain never opened it. |
| `apps/web/src/data/trackers.ts`, `lane-fixtures.ts`, `lanes-fixtures.json`, `seen-fixtures.json` | `toTracker()` turns a tracker record into a `Tracker`; `loadTrackers()` loads them in a chunk of their own, so the first screen does not carry them. The Lane tracker fixtures (LT-1 to LT-10) and the catch-up fixture Project are test-only: only a `--fixtures` build holds them. |
| `apps/web/src/data/server-payloads/` | Synthetic server replies that the data tests and the browser test read. See its README. |

Screens never import example data. They call the hooks; `apps/web/tools/arch-check.mjs` fails the lint if a screen imports anything else from `apps/web/src/data/` than the hooks, session, settings and type files on its short list.

## The interface

| Member | Meaning |
| --- | --- |
| `now()` | The clock for time text. The example source is fixed at Mon Nov 2, 2026, 10:00 AM ET. |
| `load()` | The whole `World`: cards with their answers and seen marks, Lanes, Projects, bots, Mail, Pages, Artifacts. |
| `watch(onChange)` | Calls `onChange` when something changed; returns a stop function. |
| `answer(cardId, { choice, note, version })` | Sends the Captain's answer to the card version the Captain answered: a letter, Approve, None of these, or a note. If a newer version came in while the Captain answered, the choice (by letter) and note stay, and the answer names the version on screen when it was sent, even if a newer one arrives while it is sending. Resolves with the `Answer` the receipt is built from; rejects when it was not sent. |
| `markSeen(cardId)` | Clears the violet changed dot once the Captain opened the card. |
| `markLooked(laneId)` | Sets the Lane's last-looked time to now, so its "N new" count is cleared and its Project's count drops. The Lane screen calls it once when it opens and keeps the old time for its "You last looked" line while it stays open. |
| `trackers()` | The Lane trackers by Lane id (`Tracker`), loaded when a screen shows them (Projects, a Lane) through their own loader in `DataProvider`, which loads again whenever `watch` fires. Rejects when it fails; `useTrackers()` gives `{ trackers, failed, retry }`. |
| `openPage(file)` | The HTML of a Page's file, for its frame. |
| `publishPage(ref, version)` | Makes that kept version of a Page public, by the Captain. Resolves when it is public; rejects with `Refused` when the Page has no file, the version is not kept, a removal is pending or that version is already public. The public address stays the same when a newer version replaces the public one. |
| `unpublishPage(ref)` | Makes a public Page private. The Page reads "Public, removal pending" until the Pages host confirms; the example host confirms after 3 seconds. Rejects with `Refused` when the Page is not public or a removal is already pending. |
| `evidence(cardId)` | The card's pictures, videos, preview and live links and the check record (`CardEvidence`), or `null` when the card has none. Loaded only when a card shows it. |
| `chat` | `ChatApi`: chat list, open a thread, send, Seen and writing notices. |

Rules every source follows: commands return a promise; nothing is changed in place (a change makes a new `World`); a real source calls its listeners when new data arrives, not only after its own commands; a failure rejects so the screen can say so beside what failed and offer Try again.

## Switches in the address

For tests and the design check only. Every address switch works only in a build made with `npm run build:app -- --fixtures` (`test:app`, the fixtures part of `test:chat` and `design:check` build that way); each failure happens once, so Retry works. A plain `npm run build:app` builds a switch-free app: it ignores every address switch, contains no switch reader, and holds no fixture card, fixture evidence or fixture picture.

| Switch | Effect |
| --- | --- |
| `?delay=<ms>` | Every card call and send waits that long. |
| `?fail=list,refresh,send,chat,page,publish,evidence,trackers` | The first list load, the first refresh, the first answer, the first chat send, the first Page load, the first Make public, the first evidence load or the first tracker load fails. Changes the source announces through `watch` do not bring the trackers back; Retry does. |
| `?fixtures=now` or `late` | Adds the fixture cards at once, or after the first list (the "N cards changed" line). |
| `?fixtures=evidence` | Adds the six evidence test cards (EV-1 to EV-6) and their evidence instead. |
| `?fixtures=pages` | Adds the test-only Pages PG-8 (its file is missing, so it fails to load) and PG-9 (no file, no Lane). |
| `?fixtures=lanes` | Adds the Project test-lane-tracker with the Lanes of LT-1 to LT-10 (a Lane with no steps, names of 44 and 45 characters, five and seven stages, a blocker on a bot, a quiet Lane, a check by the bot that did the work, a pending sign-off with its card fx-signoff-1, a Done Lane to reopen). |
| `?fixtures=catch-up` | Adds the Project test-catch-up with four Lanes: nothing new, some new, never opened, and a bot update after the Captain looked. Its row says 6 new; opening Some new makes it 4. |
| `?queue=empty` | The Queue has no cards. |
| `?pagenext=<ms>` | Fixtures build only. That long after the first load, each Page that keeps versions gets one newer version, as if its bot had just made it. |

More switches exist for single tests. `apps/web/src/data/switches.ts` reads every one of them.

## Card API stand-in

`apps/web/src/data/card-api.ts` is the card API that `createExampleData` reads cards through: `listCards()`, `openCard(id)`, `postAnswer(id, { rev, pick, note? })`, `postComment(id, text)`, `watch(listener)`. `createStandInCardApi()` (in `card-standin.ts`) answers it in memory with a fixed clock. Rules the real server must keep too: a refused call rejects with `Refused`; an answer on an older revision comes back with `older: true`; the same answer sent twice is one answer; the server writes the time.

`apps/web/src/data/card.ts` is card contract v1 as a module: the names and fields of the contract, with `BUDGET` and `MAX_BODY_BYTES` as real values. When the contract changes, `card.ts` changes with it.

## How a real source plugs in

1. Write a function that returns a `QdData` from the real server (same-origin JSON, a change stream for `watch`).
2. Pass it to `DataProvider` in `apps/web/src/shell/main.tsx` instead of `createExampleData(...)`.
3. Change no screen.

A build made with `--server` already does this: `main.tsx` passes `createServerSource(createApiClient())` from `apps/web/src/data/server-source.ts` and `apps/web/src/data/api-client.ts` to `DataProvider`. Chat is part of that source only in a build made with `--server --chat`.

The sign-up half, Add bot, has its own client in `apps/web/src/data/bots-client.ts` and its hooks in `bots-hooks.ts`. The example build answers them with example bots. The tests use the samples in `apps/web/src/data/server-payloads/bots/` as the server's replies.

## Tests

`npm run test:data` runs the domain, data, platform, UI kit and Page screen tests, and the tests of the tools, with the Node test runner. They cover the Queue order, answers and receipts, filters, search, time text, routes, the world built from content and fixtures, the card stand-in (every refusal, older revisions, repeated answers, change notices, a failing server) and the loader (newest load wins, a failed reload keeps the last value). `npm run test:taskcard` runs the card and answer rules alone.
