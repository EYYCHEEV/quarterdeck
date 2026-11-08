# Quarterdeck web app

The screens of Quarterdeck, built as a static app. Quarterdeck is where the Captain, the person who uses the app, and bots work through Task Cards in Lanes inside Projects, with Mail between bots and chats in the sidebar. This folder holds the Queue, Task Card, Lane, Projects, Page, Artifact, Mail, Chat, Settings and Add bot screens.

A normal build runs on example data. The example data in `src/data` is synthetic: made-up projects, bots, cards, mail and pages. None of it is real. A build made with `--server` reads from the Quarterdeck server instead. The server is in `apps/server/`.

## Run it

You need Node 22.21.0 or newer. CI uses the exact Node version pinned in `tools/ci/pins.json` at the repository root. Every command on this page runs inside `apps/web`.

```sh
cd apps/web
npm ci --ignore-scripts
npm run build:app
npm run serve:app
```

- `npm ci --ignore-scripts` installs the exact versions in `package-lock.json` and runs no install script.
- `npm run build:app` writes the app into `dist`.
- `npm run serve:app` serves `dist` and prints the address to open. It listens on the loopback interface only, on port 8770 unless you set `PORT`. Open the printed address, then try `/queue` for the first screen.

### Build options

| Command | Result |
|---|---|
| `npm run build:app` | The default build: example data, no address switches, no test fixtures |
| `npm run build:preview` | A build into `preview` with relative addresses and one script file, so the files can be hosted under any path |
| `npm run build:app -- --server` | Reads from the Quarterdeck server with same-origin JSON. Chat is off |
| `npm run build:app -- --server --chat` | The same, with chat on |
| `npm run build:app -- --sizes` | Also prints the size of each chunk |
| `npm run build:app -- --fixtures` | Adds test fixtures and the address switches. For tests only. The browser checks make this build themselves |

## Layout

The layout follows the window width:

- Under 1000 px wide: the phone layout. An upright iPad gets it too.
- From 1000 px: the sideways layout.
- From 1300 px: the Mac layout, with the sidebar.

The design check looks at four sizes: 390 (phone), 744x1133 (upright iPad), 1133x744 (sideways iPad) and 1512 (Mac).

## Folders

| Folder | What it holds |
|---|---|
| `src/data/` | The example world behind the `QdData` interface, the card API stand-in, the clients that read the server, JSON content and test fixtures. The example data is synthetic |
| `src/data/server-payloads/` | Synthetic server replies that the tests read. See its README |
| `src/domain/` | The rules on the data models: Queue order, answers, filters, search, references, time text, routes, the Lane tracker. No React, no DOM |
| `src/platform/` | The only place that calls browser features directly: network reads, the event stream, storage, clipboard, opening links, the file picker, notifications, motion |
| `src/screens/` | One folder per screen |
| `src/shell/` | The frame, sidebar, drawer and Search, and `main.tsx`, which picks the data source |
| `src/ui/` | The UI kit and the design tokens in `theme.css` |
| `public/` | Static files the build copies as they are: screen stylesheets and sample media |
| `fixtures/` | Test-only pictures. Only a `--fixtures` build copies them |
| `design-check/known.json` | Layout and UX problems that were already on screen when a check arrived. A new problem fails the design check |
| `tools/` | Build and serve scripts, the layer check, the colour check, and the design check with its measuring helpers |
| `tools/lint/` | The comment, glass, theme variable and motion checks that `npm run lint` runs |

The folder also holds `index.html`, `tsconfig.json`, `package.json` and `package-lock.json`.

## Checks

Run the checks for what you touched before a pull request. CI runs them all.

| Command | What it proves |
|---|---|
| `npm run lint` | No code comments. The layer rule below. No colour value outside `src/ui/theme.css`. Glass styling only in the floating kit. Every theme variable the code reads is defined in the built stylesheet. Motion times and easings come only from the theme |
| `npm run typecheck` | The app type-checks |
| `npm run test:data` | The Node test runner over the domain, data, platform, UI kit and Page screen tests, and the tests of the tools |
| `npm run test:taskcard` | The Task Card and answer rules alone |
| `npm run test:app` | The browser test of the shell and every screen |
| `npm run test:chat` | The chat tests |
| `npm run design:check` | Every screen and pop-up at the four sizes above: the rules in [web-ux-rules.md](../../docs/internals/web-ux-rules.md), close paths, layout, and a usable first screen on a slow phone in about 2 seconds |
| `npm run design:check:all` | The same at the four extra sizes the tool knows (1280, 1024, 756 and 440 wide), as well. It takes much longer. CI does not run it |
| `npm run build:app` | The app builds |

The browser checks (`test:app`, `test:chat`, `design:check`) need a Chrome headless shell. Set `QD_CHROME` to its path. Never run `npx playwright install`. CI downloads a pinned build, as [CI.md](../../docs/operations/CI.md) describes. Never commit screenshots.

## The layer rule

`tools/arch-check.mjs` runs in `npm run lint`. It fails on any import that breaks this table. Every `.ts` and `.tsx` file under `src/` (declaration files aside) must live in one of the six layers.

| Layer | May import |
|---|---|
| `domain/` | Only `domain/`. No package |
| `platform/` | Only `platform/`, and `react` |
| `data/` | `data/`, `domain/` and `platform/`, and `react` |
| `ui/` | `ui/` and `platform/`, and `react` |
| `screens/` | Its own folder, `ui/`, `domain/` and `platform/`, and `react`. From `data/` only the hooks, session, settings and type files on the short list at the top of the check. Never another screen. Never `shell/` |
| `shell/` | Any layer, plus `react` and `react-dom`. It loads every screen except the Queue lazily |

The same check also fails on:

- a direct browser call outside `platform/`: network, event stream, storage, clipboard, new windows, file inputs, native pop-ups, notifications, view transitions, script animation and a script read of the Reduce Motion setting (`data/api-client.ts` may also make network calls);
- a raw hex colour or a bracketed font size such as `text-[14px]` under `ui/`, `screens/` or `shell/`;
- a full-height unit that ignores a phone's toolbars (`100vh`, `h-screen`); use dynamic viewport units;
- code of the removed gradient themes;
- a `ui/` part that no screen uses.

Pass `--reuse` to the script to list which UI kit parts each screen uses.

## More

- [CONTRIBUTING.md](../../CONTRIBUTING.md): how to propose a change.
- [docs/internals](../../docs/internals): [architecture](../../docs/internals/web-architecture.md), [data interface](../../docs/internals/web-data-interface.md), [tokens](../../docs/internals/web-tokens.md) and [UX rules](../../docs/internals/web-ux-rules.md).
- [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md): credits and licenses for borrowed parts.

Code in this folder has no comments. A name or a test carries the explanation.
