# Notice

This app follows patterns from T3 Code at commit `6b7027b1f43eebc4c7edf5304236a0775b2d8928`.
No T3 Code file is copied whole. The files below were written by reading the T3 Code files named beside them, or were made from them.

| File here | T3 Code file | What was taken |
| --- | --- | --- |
| `package.json`, `web/package.json`, `standin/package.json` | `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `apps/web/package.json` | The package set and each exact version. |
| `vite.config.ts`, `web/vite.config.ts` | `vite.config.ts`, `apps/web/vite.config.ts` | Test projects, the browser test project, the build plugins. |
| `tools/t3-versions.txt` | `pnpm-lock.yaml` | Every package name, version and sha512 in it, one a line. `tools/check-versions.mjs list` makes it. Its first line names the commit and the sha256 of the lockfile it was made from. |

The look comes from the locked design pack fdp-sys-2, not from T3 Code. The files `web/src/styles/tokens.css` and `web/src/styles/app.css` and the fonts under `web/fonts/` are copied from that pack.

## Fonts

The fonts are IBM Plex Mono and IBM Plex Sans. The pack took them from the packages `@fontsource/ibm-plex-mono@5.3.0` and `@fontsource/ibm-plex-sans@5.3.0`, as its `fonts/VERSIONS.txt` records. They are under the SIL Open Font License 1.1 (OFL-1.1). Each license file sits beside its fonts: `web/fonts/ibm-plex-mono/LICENSE` and `web/fonts/ibm-plex-sans/LICENSE`.

## T3 Code license

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
