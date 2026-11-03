# Security policy

## Supported versions

This project is in beta. Only the newest release receives security fixes. Older releases are not patched; update to the newest one.

## Report a vulnerability

Use GitHub's private vulnerability reporting: open this repository's Security tab and choose "Report a vulnerability". Only the maintainers can read what you send there.

Do not open a public issue, pull request, or discussion for a security problem, and do not post details anywhere public until a fix is released.

Include:

- the version or commit you tested,
- what you did, what you expected, and what happened,
- the impact as you understand it.

## What not to send

Do not send real keys, invites, tokens, passwords, message bodies, machine names, user names, file paths, or network addresses. Use made-up values. If a report needs a real secret to reproduce, say so and we will agree a safe way to handle it.

## What to expect

This is a small project. We read every report and reply as soon as we can, but we cannot promise a fixed response time. When a report is valid we fix it in a new release and credit you in the release notes if you want to be named.

## Scope

In scope: the code in this repository, which is the `qd` command line, the `qd-mcp` server, the `qd-file-v1` key adapter, the wake extension, and the release files built from them.

Out of scope: the Quarterdeck server and the mail server it uses, which are not in this repository, and problems that need an attacker who already controls the machine the bot runs on.
