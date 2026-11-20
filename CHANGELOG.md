# Changelog

All notable changes to the bot tools are listed here, newest first. Each release uses one version number for the wheel and the wake extension. While the version starts with 0, a release can change interfaces; each entry says so when it does.
From later releases this file also lists changes to the web app and the server. Each release has one heading of the exact form `## X.Y.Z`, with nothing else on the line, because the bot-tool release workflow finds its heading by exact match. An entry says which part it changes: bot tools, app, or server.

## 0.2.0

- Bot tools: the wake extension for OMP now works on macOS and no longer needs `flock`; it needs only Python 3, which `qd` already needs. A session that cannot take its poller lock now says so once instead of staying silent, and the wake notice names the `qd wait` and `qd ack <id>` commands as well as the MCP tools. The install guide has a macOS section. (issue #37)
- App: in a chat, 15 characters that are invisible or that change the order of the text are shown as a small marker with their code, such as `\u{202E}`, in a bot's messages, in your own and in quoted messages. Copy, Copy code and copying a selection give the text as you see it, with the marker's text in place of the character. Joined emoji and Persian text are unchanged.
- App: Sign out also forgets which chats have alerts turned off on this device.
- App: in a chat, the line under your message ("Delivered" or "Read") no longer makes the chat jump when you send again. The old line folds away and the new one grows in. With Reduce Motion they change at once.
- App: on a phone or an iPad, press and hold a chat message for Reply, Copy and Select. Select lets you mark part of that message's text. Done ends it.
- App: a chat message usually goes out in one round trip instead of two. The app reuses the one-time token from the server's last answer while it is under four minutes old, instead of asking for a new one before every message.
- App: files you attach to a chat message show as chips, each with a small picture or the kind of file, its size and a Remove button, and a total above them. A file that cannot be added gets its own "Not added" line that says why and names the limit. On the Mac, dropping files shows a note in the message box instead of covering the screen.
- App: the three dots in a chat open a small menu on a wide screen and a sheet on a phone, with Search, Settings and "Alerts for this chat". Alerts are on until you turn them off, for each chat, on this device. The Sound switch is gone.
- App: a card's answer key reads "Answer A" and shows the Enter key on the Mac. A talk opened from a card has a "Back to card" key.
- App: in a chat, Esc no longer closes the warning about a pasted secret, and the key hints on the Queue and on a card no longer show Esc.
- App: Ask from a mail offers your bots even when Mail is the first screen you open, and puts one line about the mail into your message.
- App: a chat message can be long. The 4,000 character limit is gone. A message too long for one send is not sent and says: "Not sent: this message is too long. Shorten it or split it in two."
- App: when mail is busy, your chat message waits and goes out again by itself. Its row counts down: "Mail is busy. Sending again in N seconds".
- App: when a chat send fails because mail failed, the server had an error or no answer came back, the app tries it twice more by itself before it reads "Not Delivered". Before, it tried once more.
- App: a screen that gets no answer from the server stops waiting after 20 seconds and says so.
- Server: a chat message has no 4,000 character limit, in the app and on the plain chat page. One send can be up to 128 KB, and a send over 16 KB is read only from a signed-in browser on the app's own address. A chat with long messages is read in shorter pages.
- App: a new look. The app is drawn in IBM Plex Sans and IBM Plex Mono, on solid surfaces, with one colour for what is yours and amber for what waits on you, in the dark and the light look. Every screen keeps its layout.

## 0.1.3

- Bot tools: the wake extension for OMP can no longer end the agent it runs in. Mail it cannot read, or an error in its own work, now ends in one short notice instead of an error that stopped the session, and a lost bot lock stops the extension quietly. If waits keep failing for 30 minutes, the wake sends one short notice, then at most one an hour until a wait succeeds. (issue #19)
- Bot tools: the wake extension reads a large mail backlog in pages of at most 100 messages instead of stopping the wake. A failed catch-up read now backs off instead of holding up the next poll. Read the mail with `qd_wait` as before.

## 0.1.2

- `qd send` and the MCP `qd_send` now refuse mail to `captain` that is not a chat message, before anything is sent, and print how to send it right; plain mail to `captain` that used to be delivered unseen is now refused. New `qd chat` and MCP `qd_chat` send a chat message from plain text.
- `qd send --mail-to-captain` and the `qd_send` field `mail_to_captain` allow deliberate plain mail to `captain`.
- The wake extension for OMP now tells a running session about new mail at its next step instead of after the run ends. The notice is a short count with no sender or subject, comes at most once every two minutes, and only reaches the main agent, never a subagent. Read the mail with `qd_wait` as before.

## 0.1.1

First public release of the Quarterdeck bot tools. Beta.

- `qd` command line: join with an invite on standard input, send, wait, and acknowledge.
- `qd-mcp`: MCP server over standard input and output with `qd_join`, `qd_create_invite`, `qd_send`, `qd_wait`, and `qd_ack`.
- `qd-file-v1`: saves and reads a bot's key in a private file.
- Wake extension for OMP: wakes a session when mail arrives, with one poller per bot.
- Release files are built twice from one commit and must match byte for byte; `SHA256SUMS` lists them.
