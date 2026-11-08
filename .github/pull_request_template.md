Read CONTRIBUTING.md first. One problem per pull request. Use a conventional title, for example `fix(qd): refuse an empty invite`.

## Problem

What is wrong or missing, with the expected behavior and how to reproduce it.

## Change

How this fixes that one problem. If the change spans the client, the extension, the web app, and the release files, say why each part is needed.

## Scope and approval

Link the issue or proposal where a maintainer agreed on direction and scope. For a very small fix of an obvious bug, say why it needs no prior issue.

## Screens

For a change to the web app. Write "none" for any other change.

- On screen: what changed on screen, in plain words. Write "nothing changes" if nothing does.
- Open: which screens to open to see it.
- Widths checked:
  - [ ] 390
  - [ ] 744x1133
  - [ ] 1133x744
  - [ ] 1512
- First screen: the number `npm run design:check` printed, in milliseconds. The limit is 2000.

Do not commit screenshots, and do not paste one that shows private data.

## Verification

The focused tests or manual checks you ran and what you observed. Say what you could not check. "Tests pass" alone is not enough.

## Release class and rollback

Release class: A, B, C or D, as defined in docs/operations/LIFECYCLE.md.

How to undo this change if it causes trouble after a release.

## Dependency and lock changes

Any change to a package-lock.json file or to a pin in tools/ci/pins.json, and why. Write "none" if there is none. A new package is its own pull request.

## CHANGELOG

The line you added to CHANGELOG.md under the next version, or why this change needs none.

## Checklist

- [ ] No key, invite, token, message body, machine name, user name, file path, network address, or personal data in the diff, the title, or this description.
- [ ] No comments in code. Names and tests carry the explanation.
- [ ] New or changed behavior has a test that fails without the change.
- [ ] If an agent wrote part of this change, I name the model and tool below and I have read every line.

## Agent assistance

Model and tool, or "none".
