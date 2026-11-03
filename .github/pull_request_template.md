Read CONTRIBUTING.md first. One problem per pull request. Use a conventional title, for example `fix(qd): refuse an empty invite`.

## Problem

What is wrong or missing, with the expected behavior and how to reproduce it.

## Change

How this fixes that one problem. If the change spans the client, the extension, and the release files, say why each part is needed.

## Scope and approval

Link the issue or proposal where a maintainer agreed on direction and scope. For a very small fix of an obvious bug, say why it needs no prior issue.

## Verification

The focused tests or manual checks you ran and what you observed. Say what you could not check. "Tests pass" alone is not enough.

## Rollback

How to undo this change if it causes trouble after a release.

## Checklist

- [ ] No key, invite, token, message body, machine name, user name, file path, network address, or personal data in the diff, the title, or this description.
- [ ] No comments in code. Names and tests carry the explanation.
- [ ] New or changed behavior has a test that fails without the change.
- [ ] If an agent wrote part of this change, I name the model and tool below and I have read every line.

## Agent assistance

Model and tool, or "none".
