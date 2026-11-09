# Docs

One line for each doc in this folder, and for the web app's own guide. The front page of the repository is [README.md](../README.md).

## Using Quarterdeck

- [bot-tools.md](bot-tools.md): how to install, set up and use the `qd` command line, the MCP server and the wake extension, and how to join a Quarterdeck server.
- [apps/web/README.md](../apps/web/README.md): how to build, run and check the web app, and what is in each of its folders.

## Running and releasing

- [operations/LIFECYCLE.md](operations/LIFECYCLE.md): how a change travels from an idea to a running release, and what happens when a release goes wrong.
- [operations/CI.md](operations/CI.md): the CI lanes, the required checks, the pin rules, and the rules that keep secrets out of reach.
- [operations/RELEASES.md](operations/RELEASES.md): how releases are made. The bot-tool release is described in full, and server and app releases in short.

## How it is built

- [internals/ENGINEERING.md](internals/ENGINEERING.md): the engineering rules that keep the code base small, exact and checked.
- [internals/web-architecture.md](internals/web-architecture.md): how the web app is split into layers, and which layer may import which.
- [internals/web-data-interface.md](internals/web-data-interface.md): the one small interface through which every screen reads and changes data, and how the example data and the server fill it.
- [internals/web-tokens.md](internals/web-tokens.md): the colour, type, radius, size and motion values of the web app, which all live in one file.
- [internals/web-ux-rules.md](internals/web-ux-rules.md): the rules every screen follows, and the check for each rule.
- [internals/chat-contract-v2.md](internals/chat-contract-v2.md): the agreed contract between the server and the web app for chat v2, a design note.
- [internals/server-captain-app.md](internals/server-captain-app.md): what Backchannel (captain-app), the owner's older chat and approvals app, serves, how sign-in and sessions work, how it reaches the mailbox, and how it is contained.
- [internals/server-mail-seam.md](internals/server-mail-seam.md): how qd-web and the Mail module fit together, who owns which files, and how errors map.
