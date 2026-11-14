# Design tokens

All colour, type, corner, spacing, line and motion values of the web app live in one file: `apps/web/src/ui/theme.css`. It is a Tailwind CSS `@theme` block, so each token is also a utility class (`bg-panel`, `text-ink-2`, `rounded-key`, `text-meta`, `p-s3`, `wide:`). Screens, the shell and the UI kit use only these names.

Tailwind's own scales are switched off in the theme: its colours, type sizes, weights, line heights, letter spacings, corners, shadows and the number scale for spacing. A class such as `text-sm`, `p-4` or `rounded-lg` builds nothing. Only a step of the design builds a class.

These checks in `npm run lint` guard this:

- `apps/web/tools/arch-check.mjs` fails on a raw hex colour or a bracketed font size such as `text-[14px]` under `apps/web/src/ui/`, `screens/` or `shell/`.
- `apps/web/tools/colour-check.mjs` fails on any colour value in the app outside `theme.css`. A test may assert only a value that `theme.css` holds. The example pages in `apps/web/src/data/pages/` are bot content and keep their own colours.
- `apps/web/tools/lint/no-glass.mjs` fails on any glass styling: a backdrop filter, a blur, or the old frost names.
- `apps/web/tools/lint/raw-values.mjs` fails on a raw length, time or colour outside the theme, on a class from a switched-off scale, and on a see-through colour step such as `bg-panel/50`.
- `apps/web/tools/lint/theme-vars.mjs` fails when code reads a theme variable that the built stylesheet does not define in both looks.
- `apps/web/tools/lint/motion.mjs` fails on a motion time or easing written in code.

## Old layout measures

The layout has not changed yet, so some old measures remain: bracket classes such as `w-[320px]`, and lengths in the four screen sheets under `apps/web/public/`. Each one is named in `apps/web/tools/lint/raw-values-known.json` with the stage that removes it. The list holds 58 entries now: the four sheets and 54 classes. It only shrinks: an entry that nothing uses fails the lint, and so does a measure that is not on the list. In a listed sheet a raw length passes only on a size or place property; everything else in the sheet is checked in full.

## The values

The colours, type sizes, spacing steps and corners are Quarterdeck's own. The table gives the dark look, which is the default; the light look is below.

| Group | Tokens | Notes |
| --- | --- | --- |
| Surfaces | `page` #05090d, `side` and `well` #0a1118, `panel` #101a24, `control` and `raised` #172431 | Every surface is solid. Nothing is see-through but the scrim behind a sheet. `control` and `raised` are one colour: the raised surface |
| Lines | `line` #1f303f, `line-3` #4d7196 | `line-3` is the edge of a key |
| Text | `ink` #e3edf3, `ink-2` #9db0bf, `ink-3` #6f8596 | `ink-3` is the faintest ink. It is never used on the raised surface; see the rules below |
| Hand | `hand` #5cc8ff, `hand-edge` #397c9e, `on-hand` #021520 | What is his: the main key, the focus ring, the chosen option, the selected row |
| Wait | `wait` #ffb224, `wait-fill`, `wait-tint` #2d2411, `on-wait` #1a1000 | Waits on him: a blocker, past due, a join request's Approve key |
| Other signals | `stop` #ff6b5e, `moving` #7ddc7a, `new` #b39cff | `stop` is an error or a one-way step; `moving` is done, sent or live; `new` is unread or changed |
| Other colours | `scrim`, `shadow`, `glow`, `paper` #ffffff, `paper-ink` #3b3b42, `paper-ink-2` #55555c | `paper` is a white Page with its two inks |
| Faces | `font-sans` Plex Sans, `font-mono` Plex Mono | IBM Plex, four files in `apps/web/public/fonts/`: each face at 400 and 600, loaded with `swap`. A device face follows in each stack |
| Type | `label` 12, `meta` 13, `body` 15, `lead` 17, `title` 20, `display` 26 (px); `ref` 0.87em | Each size carries its line height: 1.35 for `label`, `meta`, `title` and `display`, 1.5 for `body` and `lead`. `title` and `display` must not go under 1.35, or the line no longer holds the Plex face. Text boxes on touch screens use `lead`, so Safari does not zoom |
| Weights | `regular` 400, `strong` 600 | |
| Line heights | `none` 1, `tight` 1.2, `snug` 1.35, `body` 1.5 | |
| Letter spacing | `key` 0.06em, `label` 0.08em, `brand` 0.14em | |
| Corners | `tag` 2, `key` 4, `panel` 6, `sheet` 14 (px), `round`, `circle` | |
| Shadows | `shadow-lift` (menus and sheets), `shadow-glow` (the lit key) | |
| Spacing steps | `s1` 4, `s2` 8, `s3` 12, `s4` 16, `s5` 24, `s6` 32, `s7` 48 (px); `nudge` 1, `hair` 2 | Used by padding, gap, margin and size classes: `p-s3`, `gap-s2`, `size-s5` |
| Sizes | `hit` 44, `key-h` 34, `row` 36, `float-pad` 76, `col-glyph` 14, `mark-new` 7, `progress-h` 3 (px) | `key-h` and `row` are 44 below 1400 px wide and on touch screens |
| Line widths | `line-w` 1, `line-w-rail` 2, `line-w-key` 3, `focus-w` 2, `focus-offset` 2 (px) | Read as variables, for example `var(--line-w)` |
| Breakpoints | `upright` 700, `wide` 1000, `mac` 1300 (px) | Phone and upright iPad, sideways, Mac with the sidebar |
| Motion | `transition-duration-quick` 80 ms, `-standard` 160 ms, `-screen` 240 ms; `dur-blink` 1060 ms, `dur-tick` 1200 ms; easings `ease-arrive`, `ease-leave`, `ease-sending`, `ease-blink`, `ease-tick` | No theme time is over 300 ms but the cursor's blink and the working tick. The only endless animations are the sending bar, the cursor and the working tick |

## Keys

A button takes the key skin from four classes in `theme.css`: `key` (the plain key), `key-lit` (the main key, filled with `hand`), `key-flat` (no fill) and `key-ask` (an amber outline). The UI kit's `Button` picks them by kind. A key's words are drawn in capitals in the mono face; the capitals come from CSS, so the words in the page stay as written.

Two utilities remain: `eyebrow` (a small uppercase label in `ink-2`) and `stretch` (an overlay that fills its parent).

## Hover

`hover:` applies only with a mouse: the theme redefines the variant for a fine pointer that can hover. Hover is an edge or a fill, never a new hue.

## Light look

The light look sets its own values for the colour tokens under `:root[data-appearance="light"]` in `theme.css`. Settings has an Appearance choice of System, Light and Dark; System follows the device.

## Hand

`hand` is one fixed token (#5cc8ff in the dark look) with its ink `on-hand` (#021520). There are no accent presets, custom colours or gradients: `apps/web/tools/arch-check.mjs` fails if their code comes back, and the shell test "Hand: the answer path is the lit key, solid in the hand colour, and its ink reads at least 4.5 to 1" checks the contrast.

## Rules for new styles

- Add a token to `theme.css` before using a new colour, type size, corner or spacing step.
- Text must pass 4.5 to 1 on its surface; `npm run design:check` measures it at every size.
- Never put the faintest ink, `ink-3`, on the raised surface (`raised` or `control`), in either look. It reads 4.1 to 1 there in the dark look and 4.25 to 1 in the light look. Use `ink-2` there. This covers a menu, a raised tile and a row while it is selected.
- Do not add to `raw-values-known.json`. It holds old layout measures only, and each entry names the stage that removes it.
