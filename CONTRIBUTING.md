# Contributing

## Read this first

This project is in beta and has limited review capacity. Opening a pull request does not oblige us to review or merge it. We may ask for a smaller scope, close it, or build the idea ourselves later. Following this guide makes a pull request eligible for review. It does not promise acceptance.

The same rules apply to drafts. A draft can be closed for the same reasons as a ready pull request.

Report security problems privately as described in [SECURITY.md](SECURITY.md). Never open a public issue for one.

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

You need Python 3.11 or newer, Bun, and `flock`. Run the same checks as CI from the repository root:

```sh
python3 -m unittest discover -s signup -p 'test_*.py'
python3 -m unittest discover -s mail -p 'test_*.py'
PYTHONPATH=signup:mail python3 -m unittest discover -s golive/connect -p 'test_*.py'
python3 -m unittest discover -s qd-client-wheel -p 'test_*.py'
(cd omp-quarterdeck && bun test)
```

Tests use in-process stand-ins. A test must never reach a real server, a real mailbox, or a real key.

## Code rules

- No comments in code, no docstrings, and no commented-out code. If code needs explaining, give it a better name or add a test. License and notice text is not a comment and stays. The `no-comments` check in CI fails a pull request that adds one.
- The client uses only the Python standard library. Adding a dependency needs a proposal first.
- Do not change a wire field, a configuration key, or an error message that a test compares without saying so in the pull request.
- Keep secrets out of everything: code, tests, fixtures, issues, logs, and commit messages. Use `bot-a`, `bot-b`, and `bot-c` for bot names and `example.com` or `example.test` for hosts.

## Pull request rules

- Use a conventional commit title in plain words, for example `fix(qd): refuse an empty invite`. Maintainers squash-merge and use the title as the commit message.
- Fill in the pull request template.
- The required checks must pass on the final commit.
- Keep your branch current with `main`.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under the next version for any change a user can see.

## If an agent helped

You may use an agent. You are responsible for every line you submit, so read it and run it. Name the model and tool in the pull request template.

## Your contribution and the license

By submitting a contribution you confirm you have the right to submit it, and you agree it is licensed under the same terms as the project, which are in [LICENSE](LICENSE).

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
