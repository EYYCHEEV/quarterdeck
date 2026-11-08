# CI

Every pull request and every push to `main` runs `.github/workflows/ci.yml` on GitHub-hosted `ubuntu-24.04` runners. No job in this repository runs on a self-hosted runner.

This page lists the lanes, the required checks, the pin rules, and the rules that keep secrets out of reach.

The stdlib-only `tools/ci/workflow-contexts` checker runs through the CI tool tests on every pull request. It checks expressions against GitHub's documented [context availability table](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability), checks the placement of status functions and `hashFiles()`, and rejects unknown workflow, job and step keys or flow-style mappings it cannot place. It supports this repository's block-style YAML; it is not GitHub's own parser.

## Lanes

| Lane | What it runs | Pinned by | Timeout |
|---|---|---|---|
| python | The bot-tool unittest suites: `signup`, `mail`, `golive/connect` and `qd-client-wheel` | The runner's `python3` | 10 min |
| extension | `bun test` for `omp-quarterdeck` | `oven-sh/setup-bun` by commit, Bun 1.3.14 | 10 min |
| web-static | In `apps/web`: `npm ci --ignore-scripts`, `npm audit signatures`, lint, typecheck, `test:data` and `test:taskcard` | Node 22.21.0 linux-x64 by checksum in `tools/ci/pins.json`, and the lock file's integrity values | 10 min |
| web-build | Builds `npm run build:app -- --server` and `npm run build:app -- --server --chat`, and writes each bundle's sha256 to the job summary. It publishes no release artifact | As web-static | 10 min |
| web-browser | `test:app` and `test:chat` | Playwright 1.64.1 from the lock file, and the Chrome for Testing headless shell below | 25 min |
| web-design | `design:check` as four parallel jobs, one per size: 390, 744x1133, 1133x744 and 1512. The 390 job also measures the first screen | As web-browser | 40 min each |
| web-design-selftest | The design check at 390 with a planted spill. It must exit with code 1 and print a failure line, or the lane fails | As web-browser | 30 min |
| leaks | gitleaks 8.30.1: `dir` on the checkout and `git` on the pull request's own commits. Output is redacted: the rule id and the path only | The tarball and its checksums file, by sha256 in `tools/ci/pins.json` | 10 min |
| no-comments | Python by its tokenizer; `.ts`, `.tsx`, `.js` and `.mjs` by a check for a line that starts with a comment; `.css`, `.html`, `.yml` and shell files by their own checks. The keep-list is empty. Inside `apps/web`, the web-static lane also runs the syntax-aware TypeScript scanner through `npm run lint`. The lane checks file kinds too: no symlinks or special files, and every binary file listed by sha256 in `tools/ci/binaries.txt` | Scripts in this repository | 5 min |
| pr-title | The title is a conventional commit title | None | 2 min |
| qd-check | The aggregate. It always runs. It fails if any lane failed or was skipped when it should not have been | None | 2 min |

Lanes for the server and for the full stack arrive together with the server.

Path filters only choose which lanes do real work. `qd-check` always runs, so a required check is never left unreported.

## Required checks

A pull request needs three checks green on its current head before it can be merged.

- `qd-check`: the aggregate of every lane.
- `qd-review`: posted by a maintainer once the review of the current head is done. For a sensitive path, the review includes a security review.
- `pr-title`: the conventional title.

The merge rules are in [LIFECYCLE.md](LIFECYCLE.md).

## Pinned actions

The repository allows exactly four actions, each pinned by full commit SHA:

| Action | Commit |
|---|---|
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `oven-sh/setup-bun` | `0c5077e51419868618aeaa5fe8019c62421857d6` |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| `actions/download-artifact` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |

A workflow never refers to an action by tag or branch. Node and the browser come from `tools/ci/pins.json` through `tools/ci/fetch-pinned`, so they need no extra action.

The `ubuntu-24.04` runner image itself is updated by GitHub and cannot be pinned by digest. Every tool that matters is pinned inside it.

## The browser

- Playwright is pinned to 1.64.1, exactly, in `apps/web/package.json` and in the lock file.
- The browser is the Chrome for Testing headless shell 156.0.8078.80, fetched by `tools/ci/fetch-pinned chrome-headless-shell` from the official Chrome for Testing storage.
- `fetch-pinned` checks four things and fails the job if any one differs: the size of the download, the sha256 of the zip file, the sha256 of the unpacked binary, and the version the binary prints, `Google Chrome for Testing 156.0.8078.80`. The expected values are in `tools/ci/pins.json`.
- The tests start the browser from the path in the `QD_CHROME` environment variable. If it is not set, the run fails. It never falls back to another browser.
- Never run `npx playwright install`. It downloads an unpinned build.

## Add a lane

1. Add the job to `.github/workflows/ci.yml` with its own `timeout-minutes` and `permissions: contents: read`, or less.
2. Use only the four pinned actions. Get any tool you need through `tools/ci/pins.json` and `tools/ci/fetch-pinned`.
3. Do not put a path filter on the lane in a way that could leave a required check unreported.
4. Add the lane to the `needs` list of `qd-check`, and to the result test in that job.
5. Add the lane to the table on this page.
6. Follow the secret rules below.

## Move a pin

A pin is an action commit, a tool version in `tools/ci/pins.json`, the browser, or a lock file entry.

1. Make one pull request that moves only that pin and its record.
2. Name the old value, the new value and the reason in the pull request.
3. The pull request gets a security review.
4. Where a pin record requires it, the maintainer approves the move before it is merged.

A new action needs the same pull request and also a change of the repository's allowed-actions list, which a maintainer makes. Moving Node to a new major version is its own pull request. Setup never selects a later patch version by itself.

## Keep secrets out

No secret is reachable from a pull request.

- Every workflow starts with `permissions: {}`. Jobs get only the grants listed in their own block, and none gets write access, except the manual release job described below.
- `actions/checkout` runs with `persist-credentials: false`.
- No workflow uses `pull_request_target`, and no `workflow_run` runs code from a pull request.
- No job uses a self-hosted runner.
- The repository has no Actions secrets, no environments and no deploy keys. Fork pull requests need a maintainer's approval before their workflows run.
- The only job that can write is the manual bot-tool release `draft` job in `.github/workflows/release.yml`. It has `contents: write` and nothing else, no configured secret and no pull request trigger. See [RELEASES.md](RELEASES.md).
- Superseded pull request runs are cancelled. Runs on `main` never cancel each other.
- GitHub secret scanning and push protection are on.

## Logs and artifacts

- Jobs print the kind of a finding and its path, never the value. Bundle sha256 values are fine.
- Artifacts are kept for 7 days. In the CI workflow, only failure pictures made from fixture data are uploaded. A step first refuses any failure file that is not a picture, the upload runs only when that step passed, and it takes only `.png` files. A test in `tools/ci` fails if an upload step loses that guard. The release workflow keeps its built files for 7 days between its two jobs.
- Screenshots are never committed. A screenshot that CI makes is a 7-day artifact made from fixture data.
- No file that CI produces is a release input.
