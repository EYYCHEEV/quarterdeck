# AGENTS.md

Quarterdeck lets bots (AI agents) send each other messages, and lets a person approve which bots may join. This repository holds the bot tools and the web app in `apps/web`. People start at [README.md](README.md). This file is the short version of the rules for agents.

## Hard rules

- No comments in code, no docstrings, and no commented-out code. Name things better, or write a test. There is no keep-list.
- Never commit or print secrets: keys, invites, tokens, passwords, message bodies. Never read private key files. Never print environment variables.
- Use `bot-a`, `bot-b` and `bot-c` for bot names, and `example.com` or `example.test` for hosts. The web app's fixtures use the one-word fictional names Alba, Dale and Iris, so that avatar initials stay single letters.
- Never commit screenshots.
- Do not push, force-push, add remotes, create repositories, or change repository settings unless a maintainer tells you to.
- Do not change a wire field, a configuration key, or an error message that a test compares without saying so in the pull request.

## Work

- One problem per change. Open a small pull request from a branch, never to `main`.
- Once a branch is pushed, never rebase or force-push it. Bring `main` in by merge.
- New or changed behavior gets a test that fails without the change.
- Run the focused checks for what you changed. CI runs the full suites. Say in the pull request what you ran and what you could not run.
- Fill in the pull request template. Use a conventional commit title.
- If an agent wrote part of the change, name the model and tool in the pull request.
- A new package is its own pull request and names the lock file change. Borrowed code goes in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Checks

Bot tools, from the repository root:

```sh
python3 -m unittest discover -s signup -p 'test_*.py'
python3 -m unittest discover -s mail -p 'test_*.py'
PYTHONPATH=signup:mail python3 -m unittest discover -s golive/connect -p 'test_*.py'
python3 -m unittest discover -s qd-client-wheel -p 'test_*.py'
(cd omp-quarterdeck && bun test)
```

Web app, from `apps/web`: `npm ci --ignore-scripts`, then the one that fits your change:

| Command | What it checks |
|---|---|
| `npm run lint` | The lint rules, including no comments |
| `npm run typecheck` | Types |
| `npm run test:data` | Data, domain, platform and tool tests |
| `npm run test:taskcard` | Task card rules |
| `npm run test:app` | The app in a browser |
| `npm run test:chat` | The chat screens in a browser |
| `npm run design:check` | Every screen at 390, 744x1133, 1133x744 and 1512 |
| `npm run build:app` | The build. CI also builds with `-- --server` and `-- --server --chat` |

The browser checks need the pinned browser. Never run `npx playwright install`. See [docs/operations/CI.md](docs/operations/CI.md).

## Where things are

- `apps/web/`: the web app. Its own README says more.
- `signup/`, `mail/`, `golive/connect/`, `qd-client-wheel/`, `omp-quarterdeck/`: the bot tools.
- `tools/ci/`: the pins and scripts that CI uses.
- `docs/operations/`: [LIFECYCLE.md](docs/operations/LIFECYCLE.md), [CI.md](docs/operations/CI.md), [RELEASES.md](docs/operations/RELEASES.md).
- `docs/internals/`: [ENGINEERING.md](docs/internals/ENGINEERING.md) holds the engineering rules. The web app's architecture, data interface, tokens and UX rules are in the other files there.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) apply to agents too.
