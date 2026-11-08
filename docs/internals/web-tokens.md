# Design tokens

All colour, type, radius, size-step and motion values of the web app live in one file: `apps/web/src/ui/theme.css`. It is a Tailwind CSS `@theme` block, so each token is also a utility class (`bg-panel`, `text-ink-2`, `rounded-card`, `text-meta`, `wide:`). Screens, the shell and the UI kit use only these names; no raw colour or font size is written there.

Two checks in `npm run lint` guard this:

- `apps/web/tools/arch-check.mjs` fails on a raw hex colour or a bracketed font size such as `text-[14px]` under `apps/web/src/ui/`, `screens/` or `shell/`.
- `apps/web/tools/colour-check.mjs` fails on any colour value in the app outside `theme.css`. A test may assert only a value that `theme.css` holds. The example pages in `apps/web/src/data/pages/` are bot content and keep their own colours.

## The values

The colours, type sizes and radii are Quarterdeck's own. The table gives the dark look, which is the default; the light look is below.

| Group | Tokens | Notes |
| --- | --- | --- |
| Surfaces | `page`, `panel`, `control`, `raised`, `well`, `side`, `bubble` | `bubble` is the chat bubble |
| Lines | `line`, `line-2`, `line-3` | White at 7, 11 and 40 percent |
| Text | `ink` #ececef, `ink-2` #a9a9b2, `ink-3` #8a8a93 | `ink-3` passes 4.5 to 1 on every surface |
| Other ink | `code-ink` #d9dae0 (commands and code), `picture-ink` #d6d7dd (pictures), `paper-ink` #3b3b42 and `paper-ink-2` #55555c (text on a white Page), `hover` #161619 (row hover), `you` #d8d8de (the Captain's avatar) | Named so screens do not write raw values |
| Brass | `brass`, `brass-ink`, `brass-soft`, `brass-edge`, utility `brass-fill` | Only on the answer path, focus rings and the chat unread dot |
| Meaning | `red`, `p0`, `p1`, `green`, `blue`, `violet`, `link`; every one but `link` has a `-soft` fill | Violet means changed; red is P0, past due, one-way and errors; green is Live, sent and Got it |
| Other colours | `paper`, `scrim`, `shadow`, `frost`, `lanes-edge`, `avatar-1` to `avatar-5`, and the chat colours `chat-accent`, `chat-on-accent`, `chat-bot`, `chat-bot-ink`, `chat-bot-muted`, `chat-bot-inset`, `chat-bot-line`, `chat-bot-link` | Values are in `theme.css` |
| Type | `screen` 28, `card` 23, `row` 16, `body` 15, `meta` 13.5, `small` 13, `caps` 11.5, `picture` 12.5 (px) | System font stack; mono `ui-monospace, "DejaVu Sans Mono", monospace` |
| Type, more steps | `screen-wide` 30, `title-lg` 26, `title` 22, `lead` 15.5, `prose` 14.5, `note` 14, `code` 13, `tag` 12.5, and avatar initials `initial-xl` 17, `initial-sm` 10, `initial-xs` 9 (px) | These set the size only; the line height stays the one around them |
| Shadow and utilities | `shadow-pop` (menus); utilities `brass-fill` (brass background with its ink), `frost` (floating glass), `eyebrow` (a small uppercase label in `ink-3`) and `stretch` (an overlay that fills its parent) | Glass lives only in the floating kit; `npm run lint` fails on it elsewhere |
| Radius | `tile` 7, `small` 12, `control` 14, `panel` 18, `card` 20 (px) | |
| Sizes | `upright` 700, `wide` 1000, `mac` 1300 (px) | Breakpoints: phone and upright iPad, sideways, Mac with the sidebar |
| Motion | `transition-duration-quick` 100 ms, `-standard` 200 ms, `-screen` 240 ms; easings `ease-arrive` and `ease-leave` | `npm run lint` fails a literal time or easing written in code, a theme time over 300 ms and an endless animation, the one rule of the sending bar excepted |

## Light look

The light look sets its own values for the colour tokens under `:root[data-appearance="light"]` in `theme.css`. Settings has an Appearance choice of System, Light and Dark; System follows the device. `npm run lint` fails when code reads a theme variable that the built stylesheet does not define.

## Brass

Brass is one fixed token, `brass` (#e8b35d in the dark look), with its ink `brass-ink` (#1c1408). It marks the answer path (`brass-fill`), the focus ring and the chat unread dot, and nothing else. In the dark look `brass-soft` and `brass-edge` are the same colour at 11 and 56 percent. There are no accent presets, custom colours or gradients: `apps/web/tools/arch-check.mjs` fails if their code comes back, and the shell test "Brass: the answer path is solid brass, and its ink reads at least 4.5 to 1" checks the contrast.

## Rules for new styles

- Add a token to `theme.css` before using a new colour, type size or radius.
- Text must pass 4.5 to 1 on its surface; `npm run design:check` measures it at every size.
