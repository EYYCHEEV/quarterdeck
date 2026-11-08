# UX rules for every screen

These rules sit on top of the look. The values of the look are in [web-tokens.md](web-tokens.md).

The rules below are written in our words. Lists 1 to 3 are adapted from the taste-skill project's chapter on app screens; list 5 comes from its rule on controls. The credit is in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

Each rule names its check. The checks run in `npm run design:check` (`apps/web/tools/design-check.mjs`, with the measuring code in `apps/web/tools/ux-measure.mjs`). Problems that were already on screen when a check arrived are listed in `apps/web/design-check/known.json`. A new one fails `npm run design:check`.

## 1. Numbers come from the rows on screen

- Every total or count on screen is computed from the rows it describes. It is never typed in or stored on its own.
- When a filter or a search changes the rows, every count that describes them changes in the same step: the subtitle ("6 of 12 Pages"), the Filter badge, and "Show 6 Pages" on the phone sheet.
- A fact shown in two places is one value in code, so the two can never disagree.
- Checks:
  - design-check `totals`: on Projects, the totals line matches the rows (projects, Task Cards, Lanes); on Pages, the subtitle matches the rows on screen.
  - `npm run test:app`: filtering and searching Pages changes the rows and the subtitle together, and "Show N Pages" counts the filtered rows.

## 2. Honest states that keep their frame

- A real zero prints as 0, in the normal style.
- A missing or not-applicable value is a quiet grey dash. It is never "--" at full size and never left blank.
- An empty list keeps its frame and its heading and adds one sentence, plus the way out when there is one (Clear filters).
- Loading shows the final layout with each value as a flat grey bar at its real size. Labels and headings show at once, and nothing moves when the data lands. A refresh keeps the old values on screen until the new ones arrive.
- An error shows inside the block that failed: one sentence saying what failed and when the data was last good, and a Retry button. Never a full-screen banner.
- Never on screen: NaN, undefined, null, Infinity, [object Object], lorem ipsum.
- Check: design-check `dishonest-value`, in every state at every size.

## 3. Lists on a phone

- The first list row starts in the top 60% of the phone screen. Controls above a list fit in one row; more go into a sheet.
- On a touch screen, every tap target is at least 44 by 44 px. A smaller control gets a larger invisible tap area, the way T3 Code does it on touch screens (`pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11`), so the look does not change. A text field cannot carry that invisible area, so it needs to be at least 36 px tall (T3 Code's own touch height for fields) and 44 px wide. New controls must meet this.
- Filters fold into one row of chips or a Filters sheet. Header actions other than the one main action go into a menu.
- Tables become rows of two lines. The page never scrolls sideways.
- One region at a time: opening a row shows its detail, and Back returns to the list at the same scroll position.
- Checks: design-check `first-row-low` at the phone sizes and `small-target` at the touch sizes (phones and iPads; a Mac with a mouse is not checked); the existing sideways-scroll checks.
- At the phone sizes, nothing the eye cannot see may take focus or be marked current (off screen, fully transparent unless it shows on focus, or clipped by a box that does not scroll). Check: design-check `hidden-active`.

## 4. Text contrast

- Text has a contrast of at least 4.5:1 against what is behind it. Large text (24 px, or 18.7 px bold) needs 3:1. Disabled controls are exempt.
- Check: design-check `contrast`, in every state at every size. A new text under the rule fails.

## 5. Every control has a name

- Every button, link, field and menu item has a name a screen reader can read: its visible text, or an `aria-label` when it shows only an icon.
- Check: design-check `no-name`, in every state at every size.

## What was taken from taste-skill and what was left

Taken:
- Totals and counts computed from the rows on screen, changing with every filter (list 1).
- Honest zeros, dashes, empty, loading and error states that keep their frame (list 2).
- Phone list rules: first row in the top 60%, 44 px targets, filters in one row or a sheet, two-line rows, one region at a time (list 3).
- A text contrast check (list 4).
- Every control has a name a screen reader can read (list 5).

Left:
- The skill itself, its install steps and its plugin files: no file from the project is copied, installed or run. Our checks cover what it measures for us.
- Its scripts (draw, inspect, lint, scenes, assets): the design check does this work for our app.
- Its art directions, app styles, house look rules and product face: Quarterdeck has its own look, set by the tokens in [web-tokens.md](web-tokens.md).
- Its picture downloads and CDN scripts (GSAP, Lenis): no outside code or pictures in our app.
- Its motion layer and scroll scenes: marketing-page work. Our motion values come from the theme.
- Its type, colour and layout laws: our tokens set these.
- Its chart, KPI and calendar rules: we have no charts or calendars.
