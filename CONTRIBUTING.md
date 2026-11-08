# Contributing

## Read this first

This project is in beta and has limited review capacity. Opening a pull request does not oblige us to review or merge it. We may ask for a smaller scope, close it, or build the idea ourselves later. Following this guide makes a pull request eligible for review. It does not promise acceptance.

The same rules apply to drafts. A draft can be closed for the same reasons as a ready pull request.

Report security problems privately as described in [SECURITY.md](SECURITY.md). Never open a public issue for one.

## Where the work happens

This repository is where Quarterdeck is built: the web app, the bot tools, the server, their checks and everything else that can be shared. All work happens in a clone of this repository, on a branch, and lands here by pull request. Deployment to the maintainers' live server, and design experiments, are kept in separate private repositories, so neither belongs in a pull request here.

## What we welcome

Focused bug fixes, reliability fixes, tests, and documentation fixes are the most likely to be accepted. Unrequested features, opinionated rewrites, and unrelated cleanup are not.

## Agree on scope first

A change to behavior needs a maintainer's agreement on direction and scope before you write it. Open a feature proposal issue, wait for a maintainer's reply, and link that reply in your pull request. Calling a behavior change a bug fix does not remove this step.

A very small fix for an obvious bug can come without a prior issue. In the pull request, explain the defect and why the fix qualifies.

Search existing issues and the changelog before you start.

## One problem per pull request

Count underlying problems, not linked issues. If a pull request solves two independent problems, split it. Include the code, tests, and documentation that one problem needs, and explain how they relate when that is not obvious.

## Show evidence

Say how you found the problem, how you checked the change, and what you saw. Give the commands and the output that matter, and say what you could not check. "Tests pass" alone does not show the change works. Match the evidence to the change: a focused test for behavior that can be tested, a manual check where it cannot.

## Set up and check

### Bot tools

You need Python 3.11 or newer, Bun, and `flock`. Run the same checks as CI from the repository root:

```sh
python3 -m unittest discover -s signup -p 'test_*.py'
python3 -m unittest discover -s mail -p 'test_*.py'
PYTHONPATH=signup:mail python3 -m unittest discover -s golive/connect -p 'test_*.py'
python3 -m unittest discover -s qd-client-wheel -p 'test_*.py'
(cd omp-quarterdeck && bun test)
```

Tests use in-process stand-ins. A test must never reach a real server, a real mailbox, or a real key.

### Web app

You need Node 22 and npm. The exact Node version CI uses is in `tools/ci/pins.json`. Start here:

```sh
cd apps/web
npm ci --ignore-scripts
npm run build:app
npm run serve:app
```

`npm run serve:app` serves the build on your own machine and prints the address to open. The layout follows the window width.

Before a pull request, run the checks for what you changed:

| Command | What it proves |
|---|---|
| `npm run lint` | The web app's lint rules pass, including no comments |
| `npm run typecheck` | The app type-checks |
| `npm run test:data` | The data, domain, platform, UI and tool unit tests pass |
| `npm run test:taskcard` | The task card and answer rules hold |
| `npm run test:app` | The app shell works in a browser |
| `npm run test:chat` | The chat screens work in a browser |
| `npm run design:check` | Every screen and pop-up at 390, 744x1133, 1133x744 and 1512: locked rules, close paths, layout, and the first screen on a slow phone |
| `npm run build:app` | The app builds. CI also builds `npm run build:app -- --server` and `npm run build:app -- --server --chat` |

CI runs all of them on every pull request, so you do not have to run each one. The browser checks need the pinned Chrome for Testing browser, set through `QD_CHROME`. Never run `npx playwright install`. If you cannot run a browser check, say so in the pull request. See [docs/operations/CI.md](docs/operations/CI.md).

## Code rules

- No comments in code, no docstrings, and no commented-out code. If code needs explaining, give it a better name or add a test. License and notice text is not a comment and stays. There is no keep-list and no exception list. The `no-comments` check in CI fails a pull request that adds one.
- The client uses only the Python standard library. Adding a dependency needs a proposal first.
- Do not change a wire field, a configuration key, or an error message that a test compares without saying so in the pull request.
- New or changed behavior comes with a test that fails without the change.
- Never commit screenshots. A screenshot that CI makes is a short-lived artifact made from fixture data.
- Keep secrets out of everything: code, tests, fixtures, issues, logs, and commit messages. Use `bot-a`, `bot-b`, and `bot-c` for bot names and `example.com` or `example.test` for hosts. The web app's fixtures use the one-word fictional names Alba, Dale and Iris, so that avatar initials stay single letters.
- The engineering rules behind these are in [docs/internals/ENGINEERING.md](docs/internals/ENGINEERING.md).

## Pull request rules

- Use a conventional commit title in plain words, for example `fix(qd): refuse an empty invite`. Maintainers squash-merge and use the title as the commit message.
- Fill in the pull request template.
- The required checks must pass on the final commit: `qd-check`, `qd-review` and `pr-title`. A maintainer posts `qd-review` when the review of the current head is done.
- Keep your branch current with `main` by merging `main` into it. Never rebase or force-push a branch you have pushed.
- Nobody pushes to `main` directly.
- One maintainer, the integration owner, merges when the required checks are green on the current head. Pull requests are merged one at a time.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under the next version for any change a user can see.

## Commit messages and pull request titles

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): summary`.

- Types: `feat`, `fix`, `docs`, `test`, `ci`, `chore`, `refactor`, `perf`, `build`.
- Scopes we use: `qd`, `web`, `chat`, `tokens`, `data`, `task-card`, `design-check`, `build`. A short lowercase word that names the part you changed is also fine.
- Example: `feat(chat): show "bot-a is writing" while a reply is in progress`.

## Pull request text

- The template's Screens section holds what is on screen, which screens to open, the widths you checked and the first-screen number. Do not repeat them as separate lines elsewhere.
- Say "a maintainer", not a person's name.
- Do not refer to private repositories, internal records, or private conversations, and do not name people.
- Keep keys, invites, tokens, message bodies, machine names, user names, file paths, and network addresses out of the title, the description, and every comment.

## Third-party code

Borrowed code or values keep their license. Add them to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), put the full license text in [licenses](licenses), and credit them in the Attribution section at the end of [README.md](README.md). Credit does not go in file headers. A new package is its own pull request that names the lock file change.

## Issues

Report app and server bugs as public issues, with the public bug form. Choose the area: web, server, bot tools, or docs. Propose features with the feature proposal form. Security reports go through private vulnerability reporting, as [SECURITY.md](SECURITY.md) describes.

## How releases work

See [docs/operations](docs/operations): [LIFECYCLE.md](docs/operations/LIFECYCLE.md) for how a change becomes a release, [CI.md](docs/operations/CI.md) for the checks and pins, and [RELEASES.md](docs/operations/RELEASES.md) for releases.

## If an agent helped

You may use an agent. You are responsible for every line you submit, so read it and run it. Name the model and tool in the pull request template. Agents follow [AGENTS.md](AGENTS.md).

## Your contribution and the license

By submitting a contribution you confirm you have the right to submit it, and you agree it is licensed under the same terms as the project, which are in [LICENSE](LICENSE).

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
