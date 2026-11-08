# Lifecycle: from a change to a release

This page shows how a change travels from an idea to a running release, and what happens when a release goes wrong. It is short on purpose. A reviewed commit on `main` is built, staged and released by the maintainers. The detailed release steps are kept in the maintainers' private repositories.

The way out of a bad release is the next good release.

## The stages

| Stage | What happens | Where it is public |
|---|---|---|
| 1. Change | One problem, one short-lived branch | [CONTRIBUTING.md](../../CONTRIBUTING.md) |
| 2. Pull request | The template, a conventional title, a review | [CONTRIBUTING.md](../../CONTRIBUTING.md) |
| 3. Checks | Every lane runs on GitHub-hosted runners | [CI.md](CI.md) |
| 4. Merge | One squash merge at a time, on green | This page |
| 5. Candidate and proof | A merged commit is built once and proven | Maintainers only |
| 6. Release decision | The class of the change decides how it ships | This page |
| 7. Deploy | The proven build goes live | Maintainers only |
| 8. Watch | Two watches look for trouble | This page |
| 9. Fix forward | The next good release replaces a bad one | This page |

## 1. Change

- One problem becomes one branch. The branch is short-lived.
- Where it is practical, write the failing test first, then the fix.
- While you edit, run the focused checks for what you changed. CI runs the full suites on the pull request. See [ENGINEERING.md](../internals/ENGINEERING.md).
- Plans, research notes and scratch files are not committed. The merged pull request is the record.

## 2. Pull request

- Fill in the pull request template: problem, change, scope and approval, screens, verification, release class and rollback, dependency and lock changes, the CHANGELOG line, and agent assistance.
- The title is a conventional commit title. It becomes the commit message when the pull request is squash-merged.
- A review follows. A change to a sensitive path gets a security review as part of it.
- Name the release class of the change in the template (see stage 6).

## 3. Checks

- Every pull request and every push to `main` runs the CI workflow on GitHub-hosted runners. The lanes are listed in [CI.md](CI.md).
- A check run never deploys anything.
- Three checks are required before a merge: `qd-check`, `qd-review` and `pr-title`.
  - `qd-check` always runs. It fails if any lane failed or was skipped when it should not have been.
  - `qd-review` is posted by a maintainer once the review of the pull request's current head is done.
  - `pr-title` checks the conventional title.

## 4. Merge

- One maintainer, the integration owner, merges. Pull requests are merged one at a time.
- The merge needs `qd-check`, `qd-review` and `pr-title` green on the current head of the branch.
- The merge is a squash merge. The merge call names the head commit, so a commit pushed after the checks cannot slip in.
- After the merge, the integration owner reads back that the pull request is merged into `main`.
- Merged is not released. Merging only makes the commit a candidate.

## 5. Candidate and proof

A reviewed commit on `main` is built, staged and released by the maintainers. The full steps are private.

Two rules are public:

- The bytes that were proven are the bytes that ship. Nothing is rebuilt after the proof.
- No file that a public CI job produces is ever used as a release input.

## 6. Release decision

The class of a change is computed from what changed. It is checked again when the release is applied. Anything unclear gets the highest class.

| Class | What changes | How it ships |
|---|---|---|
| A, app | App code and settings of the web app and the server's app services | Under the standing policy once a maintainer has activated it. Before that, a maintainer approves each batch. The mail server is not restarted |
| B, door | The door policy, the web proxy settings, and files built into the mail server image | A maintainer approves each batch. The mail server restarts briefly |
| C, mail server | The mail server, the web proxy or the Python base image, and the mail server's settings | A maintainer decides case by case. The mail server restarts |
| D, state format | Anything the previous release cannot read | Never shipped by the release process. It needs its own migration decision |
| Release machinery | The programs that apply a release and the programs that prove one | Never shipped through the release process. Each change is a reviewed setup change approved by the maintainers |

Class A releases ship by themselves under the standing policy once a maintainer has activated it. The policy is limited in time and in number, and it never covers classes B to D or the release machinery.

## 7. Deploy

The maintainers release the proven build to the live server. The previous release stays available, so an undo needs no download. The full steps are private.

## 8. Watch

Two watches look for trouble after a release.

1. **The release watch, 10 minutes.** It runs before the release counts as committed. It checks readiness, crash loops, the error rate and a full journey through the deployed app: send a message, get a reply, post a card and answer it. Any failure means an automatic undo.
2. **The follow-up watch, 24 hours.** After the release is committed, a short core journey runs every 15 minutes: send, reply, answer, and the first screen. Two failures in a row mean the same automatic undo, if the undo needs no data restore. A new release ends the follow-up watch of the old one and starts its own.

## 9. Fix forward

The way out of a bad release is the next good release. An undo is a safety net for the first hours. It is not the plan.

| Situation | What happens |
|---|---|
| A check fails before the switch | Stop. Nothing changed on the live server. The next candidate tries again |
| A check fails in the release watch | Automatic undo to the previous release |
| The core journey fails twice in a row in the follow-up watch | Automatic undo, if no data restore is needed |
| A problem is found later | Fix forward: a small pull request, or a revert pull request, goes through the same stages |
| A fix needs data put back | Never automatic. A maintainer decides |
| The undo itself fails | Keep what is healthy, freeze releases, alert the maintainers, keep the logs. No retry loop |

**The line no undo crosses.** An automatic undo brings back code, settings and images only. Mail, acknowledgements, resend keys, cursors and the app's state stay as they are. If the previous release cannot read the current state, the change was class D and the release process would not have shipped it.

**Going back on purpose is a revert pull request.** It is a new release with a new version number, and it is proven like any other. A revert pull request takes the normal review path for the lines it changes. A release is never silently replaced.

After any undo, candidates that are waiting are built and proven again against the restored release.
