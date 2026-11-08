# Web app architecture

`apps/web` is a static client for the Quarterdeck screens: Queue, Task Card, Lane, Projects, Page, Artifact, Mail, Chat, Settings and Add bot. It is not a backend. A default build runs on example data. A build made with `--server` reads from the Quarterdeck server instead. Every command on this page runs inside `apps/web`.

## Layers

The source lives in `apps/web/src/` in six layers. Each layer imports only from the layers named here:

- `apps/web/src/domain/`: the rules (Queue order, answers, filters, search, references, time text, routes, what is new since the Captain last looked at a Lane, the Lane tracker). No React, no DOM; imports only `domain/`.
- `apps/web/src/platform/`: the only layer that calls browser features directly: network reads (`read-text`), the event stream (`events`), storage, clipboard, opening links, the file picker, notifications and push, view transitions, script animation and the Reduce Motion setting. Imports only `platform/`.
- `apps/web/src/data/`: the example world behind `QdData` ([web-data-interface.md](web-data-interface.md)) and the clients that read the server; imports `domain/` and `platform/`.
- `apps/web/src/ui/`: the UI kit, styled only with the tokens in `ui/theme.css` ([web-tokens.md](web-tokens.md)); imports `ui/` and `platform/`.
- `apps/web/src/screens/`: one folder per screen; imports `ui/`, `domain/`, `platform/` and the data hooks, never another screen and never `shell/`.
- `apps/web/src/shell/`: the frame, sidebar, drawer and Search, and `main.tsx`, which picks the data source. It loads every screen lazily except the Queue. A screen whose script fails to load shows "Could not load this screen." with Retry in the screen area; Retry imports it again.

Packages: `domain/` uses none, `platform/`, `data/`, `ui/` and `screens/` may use `react`, and `shell/` may use `react` and `react-dom`.

## The layer check

`apps/web/tools/arch-check.mjs` is part of `npm run lint`. It fails on any import that breaks the layers above. From `data/` a screen may import only the hooks, session, settings and type files on the short list at the top of the check. The check also fails on:

- a direct browser call outside `platform/` (the one other file that may call the network is `data/api-client.ts`; every other file reads through `platform/`);
- a raw hex colour or a bracketed font size such as `text-[14px]` under `ui/`, `screens/` or `shell/`;
- a full-height unit that ignores a phone's toolbars (`100vh`, `h-screen`); use dynamic viewport units;
- code of the removed gradient themes;
- a `ui/` part that no screen uses;
- a file outside the six layers.

Pass `--reuse` to the script to list which UI kit parts each screen uses.

## Build, serve and test

- Build with `npm run build:app`. The first screen ships as one chunk. Add `-- --sizes` to print the chunk sizes.
- `npm run build:app -- --server` builds the app against the Quarterdeck server instead of the example world, and `npm run build:app -- --server --chat` turns chat on as well.
- `npm run build:app -- --fixtures` adds test cards and address switches. Only tests and the design check use it.
- Serve the build with `npm run serve:app`.
- Test with `npm run test:data`, `npm run test:taskcard`, `npm run test:app` and `npm run test:chat`. Check the look and layout with `npm run design:check`.
- A screen links its stylesheet from `apps/web/public` by root path (`<link href="/chat.css">`).

`apps/web/tools/lint/no-comments.mjs` is the comment lint that CI also runs. The other scripts in `apps/web/tools/lint/` check the glass styling, the theme variables and the motion values.
