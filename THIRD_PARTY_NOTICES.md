# Third-party notices

Quarterdeck's own code is MIT licensed (see [LICENSE](LICENSE)). This file lists what it borrows from other projects, what it builds with, and what it runs next to.

The full license texts are in the [licenses](licenses) folder. They are not repeated here. Credit lives in this file and in the README, not in file headers.

## Shipped dependency notices

The notices for the packages that ship in the web app are generated from `apps/web/package-lock.json`, so they follow the packages that are actually used.

## T3 Code

- Project: T3 Code, https://github.com/pingdotgg/t3code
- License: MIT, Copyright (c) 2026 T3 Tools Inc. Full text: [licenses/T3-CODE-MIT.txt](licenses/T3-CODE-MIT.txt).
- Adapted from source at commit `22b5252467aef991517afb0155be57f5c9eb301e`, rewritten for Quarterdeck without T3 Code's libraries. Nothing is copied as is:
  - `apps/web/src/ui/copy.ts` from `apps/web/src/hooks/useCopyToClipboard.ts`: copy text with the clipboard API, fall back to selecting a hidden field and the browser copy command when the API is missing, and show a short "copied" state.
  - The code block frame in `apps/web/src/ui/markdown.tsx` (language label, Wrap lines and Copy code) from `apps/web/src/components/chat/MarkdownCodeBlock.tsx`. The markdown parser is Quarterdeck's own.
  - The chat package of the server, `apps/server/qd-web`, which arrives in a later change, adapts the interaction design for a compact message list, streaming refresh, optimistic sends with stable retry identifiers, canonical-message reconciliation, seen and typing state, and safe Markdown and code-block rendering, from the same commit.

## Tailwind CSS

- Project: Tailwind CSS 4.3.3, https://github.com/tailwindlabs/tailwindcss, used at build time (`tailwindcss`, `@tailwindcss/cli`).
- License: MIT, Copyright (c) Tailwind Labs, Inc. Full text: [licenses/TAILWIND-CSS-MIT.txt](licenses/TAILWIND-CSS-MIT.txt).
- Credit: the 4 px spacing grid and the utility classes come from Tailwind CSS. The colours, type sizes and radii in `apps/web/src/ui/theme.css` are Quarterdeck's own.

## taste-skill

- Project: taste-skill (design-taste-frontend) 2.1.5, https://github.com/Leonxlnx/taste-skill, commit `12af471f627f866411b4bd785b19646d3672784c`.
- License: MIT, Copyright (c) 2026 Leonxlnx. Full text: [licenses/TASTE-SKILL-MIT.txt](licenses/TASTE-SKILL-MIT.txt).
- Credit: rule lists 1 to 3 and 5 in [docs/internals/web-ux-rules.md](docs/internals/web-ux-rules.md) are adapted, in our own words, from its `references/app-screens.md` ("Data that tells the truth", "Empty, zero, loading and error states", "The phone") and `SKILL.md` (accessible names on every control). The checks in `apps/web/tools/ux-measure.mjs` are our own code. No file from the project is copied, installed or run.

## pstack

- Project: pstack, https://github.com/cursor/plugins (the `pstack/` folder). MIT.
- Credit: the no-comments practice this repository follows comes from pstack. None of its text or code is included, so no license text is kept here.

## Caddy

- Project: Caddy, https://github.com/caddyserver/caddy
- License: Apache-2.0. Full text: [licenses/CADDY-APACHE-2.0.txt](licenses/CADDY-APACHE-2.0.txt).
- Use: the deployment files that arrive in a later change refer to Caddy as a separate web server. No Caddy source is included in this repository.

## Stalwart Mail Server

- Project: Stalwart Mail Server, from the Stalwart Labs project on GitHub, https://github.com/stalwartlabs/stalwart
- License: AGPL-3.0, by its authors.
- Use: recipe only. The deployment files that arrive in a later change include a recipe for building a container image that runs Stalwart. No Stalwart code is included in this repository. See [licenses/STALWART-AGPL-3.0-NOTE.md](licenses/STALWART-AGPL-3.0-NOTE.md).
