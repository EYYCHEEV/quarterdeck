import argparse
import hashlib
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
QD_WEB = Path(os.environ.get("QD_WEB") or HERE.parents[1])
sys.path.insert(0, str(QD_WEB))

import mail_standins as standins

import application
import approval_app
import approval_security
import mail_api
import mail_gateway
import qd_jmap
import webapp

PLACEHOLDER_CSRF = "csrf-placeholder"
PLACEHOLDER_FRESH = 0
ORIGIN = "https://quarterdeck.invalid"
HOST = standins.HOST
REFUSAL_REPLY = standins.REFUSAL_REPLY
SIGNED_IN_REPLY = standins.SIGNED_IN_REPLY
ACCOUNT = standins.ACCOUNT_NAME
OLD_QUESTION = "Search group limit: how many rows per group?"
LONG_LINE = "the nightly check passed on every lane and nothing needs a decision."
HTML_SUMMARY = (
    "<html><head><style>b { color: red }</style></head><body><h1>Weekly build summary</h1>"
    "<p>All <b>12</b> builds passed.</p><ul><li>Fleet: 5 builds</li><li>Web: 7 builds</li></ul>"
    "<p>Details: <a href=\"https://example.com/builds\">build page</a>.</p><script>track()</script></body></html>"
)

EXPECTED_STATUS = {
    "list-5-threads.json": 200,
    "list-not-modified-304.json": 304,
    "list-empty.json": 200,
    "list-truncated-200-threads.json": 200,
    "thread-with-attachments-and-refs.json": 200,
    "thread-html-only.json": 200,
    "thread-sent-and-received.json": 200,
    "thread-cut-long-body.json": 200,
    "thread-omitted-older-mails.json": 200,
    "error-400-bad-ref.json": 400,
    "error-401-sign-in-required.json": 401,
    "error-403-session-refused.json": 403,
    "error-404-no-thread.json": 404,
    "error-503-request-unavailable.json": 503,
}


def person(name):
    return {"name": "", "email": f"{name}@{standins.DOMAIN}"}


def at(day, hour, minute):
    return f"2026-11-{day:02d}T{hour:02d}:{minute:02d}:00Z"


def mail(index, sender, recipient, received, subject, text, **fields):
    return standins.message(
        index,
        subject=subject,
        text=text,
        receivedAt=received,
        **{"from": person(sender), "to": [person(recipient)]},
        **fields,
    )


def story():
    messages = [
        mail(1, "repo-lead", ACCOUNT, at(2, 14, 5), OLD_QUESTION,
             "How many rows should a search group show before 'more'?\nI need a number to finish the Search lane."),
        mail(2, "bot-a", "repo-lead", at(2, 14, 30), f"Re: {OLD_QUESTION}",
             "I wrote the Search notes down as AR-4 and the layout as PG-2.\nWe still need a rows-per-group number.",
             attachments=[
                 {"name": "search-notes.pdf", "size": 48213, "type": "application/pdf"},
                 {"name": "layout.png", "size": 20480, "type": "image/png"},
             ]),
        mail(3, ACCOUNT, "repo-lead", at(2, 15, 12), f"Re: {OLD_QUESTION}",
             "Five rows, then a 'show more' link.\nPlease read AR-4 again before you start.",
             mailbox=standins.SENT),
        mail(4, "repo-lead", ACCOUNT, at(2, 16, 40), "Search group, final answer",
             "Thanks. Five rows it is. Closing this out.", inReplyTo=["msg-003@qd.invalid"]),
        mail(5, "bot-b", ACCOUNT, at(3, 13, 0), "Weekly build summary", None, html=HTML_SUMMARY),
        mail(6, "bot-b", ACCOUNT, at(3, 18, 0), "Release window", "Can we release on Thursday?"),
        mail(7, ACCOUNT, "bot-b", at(3, 18, 20), "Re: Release window",
             "Thursday works.\r\nPlease confirm the build is green first.\r\nThanks.", mailbox=standins.SENT),
        mail(8, "bot-b", ACCOUNT, at(4, 12, 0), "Fwd: Release window",
             "The build is green. See PG-7 for the checklist and AR-12 for the notes."),
        mail(9, "bot-a", ACCOUNT, at(4, 13, 30), "Daily status",
             "".join(f"Line {number:04d}: {LONG_LINE}\n" for number in range(1, 301))),
    ]
    digest_start = datetime(2026, 11, 4, 15, 0, tzinfo=timezone.utc)
    for number in range(1, 61):
        received = (digest_start + timedelta(minutes=5 * number)).strftime("%Y-%m-%dT%H:%M:%SZ")
        messages.append(mail(9 + number, "bot-b", ACCOUNT, received, "Backlog digest", f"Digest {number:02d}: nothing new today."))
    messages.append(mail(70, "bot-a", ACCOUNT, at(4, 12, 30), "CARD: Pick the release day", '{"qd":"card/1"}'))
    messages.append(mail(71, "bot-a", ACCOUNT, at(4, 12, 40), "CHAT: bot-a", '{"qd":"chat/1"}'))
    return messages


def crowd():
    bots = ("bot-a", "bot-b", "repo-lead")
    start = datetime(2026, 11, 4, 0, 0, tzinfo=timezone.utc)
    return [
        mail(
            number,
            bots[number % 3],
            ACCOUNT,
            (start + timedelta(minutes=number)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            f"Topic {number:03d}",
            f"Note {number:03d}.",
        )
        for number in range(1, 206)
    ]


class NoSite:
    def has(self, path):
        return False

    def serve(self, request):
        raise RuntimeError("this recorder serves no static files")


class Clock:
    def __call__(self):
        return 1000.0


def captain_for(server):
    credential = qd_jmap.Credential(bytearray(standins.STAND_IN_KEY))
    mailbox = qd_jmap.Mailbox(qd_jmap.Jmap(standins.SESSION_URL, credential, server))
    return mail_gateway.CaptainMailbox(mailbox, credential, account_name=ACCOUNT, oversight_bot="bot-oversight")


def in_process_gate(state):
    approval = object.__new__(approval_app.ApprovalApplication)
    approval.state = state
    approval.trusted_proxy = "proxy"
    approval.public_origin = ORIGIN
    approval.forwarded_host = HOST
    return application.ApprovalGate(approval)


def web_over(server, gate, folder, name):
    api = mail_api.MailApi(
        captain_for(server), gate, clock=Clock(), mail_state_path=Path(folder) / name, mail_state=server.state
    )
    return webapp.QdWeb(None, NoSite(), mail=api)


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def exchange(web, path, token, *, cookie=True, etag=None):
    headers = {"Cookie": f"__Host-qd-approval={token}"} if cookie else {}
    if etag is not None:
        headers["If-None-Match"] = etag
    request = standins.get_request(path, cookie=False, headers=headers)
    response = web.handle(request)
    names = [name for name, _ in response.headers]
    if len(names) != len(set(names)):
        raise RuntimeError("a response repeats a header name")
    shown = dict(response.headers)
    body = json.loads(response.body) if response.body else None
    if isinstance(body, dict):
        if "csrf" in body:
            body["csrf"] = PLACEHOLDER_CSRF
        if "freshUntil" in body:
            body["freshUntil"] = PLACEHOLDER_FRESH
    if body is not None:
        shown["Content-Length"] = str(len(compact(body).encode("utf-8")))
    return {"status": response.status, "headers": shown, "body": body}


def through_real_gate(server, folder, reply, path, *, cookie=True, connect_error=None):
    web = web_over(server, standins.real_gate(), folder, "threads-real-gate.sqlite3")
    with standins.sign_in_service(reply, connect_error) as owner:
        request = standins.get_request(path, cookie=cookie)
        response = web.handle(request)
    body = json.loads(response.body) if response.body else None
    return {"status": response.status, "headers": dict(response.headers), "body": body}, owner


def render(sample):
    return (json.dumps(sample, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def build():
    entropy = [0]

    def token_bytes(size):
        entropy[0] += 1
        return bytes([entropy[0]]) * size

    server = standins.StandInStalwart(story())
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        root.chmod(0o700)
        state = approval_security.ApprovalState(
            root / "approval.sqlite", b"s" * 32, clock=lambda: 1000.0, token_bytes=token_bytes
        )
        token = state.start_browser_session(
            "account-user-subject", device_hash=None, kind="Other browser", fresh_from=1000.0
        ).token
        gate = in_process_gate(state)
        web = web_over(server, gate, root, "threads-main.sqlite3")
        listing = exchange(web, "/captain/mail", token)
        etag = listing["headers"]["ETag"]
        crowded = web_over(standins.StandInStalwart(crowd()), gate, root, "threads-crowd.sqlite3")
        empty = web_over(standins.StandInStalwart([]), gate, root, "threads-empty.sqlite3")
        failing_server = standins.StandInStalwart(story())
        failing = web_over(failing_server, gate, root, "threads-failing.sqlite3")
        failing_server.unreachable = True
        refused, owner = through_real_gate(standins.StandInStalwart(story()), root, REFUSAL_REPLY, "/captain/mail")
        if owner.operations() != ["authenticate"]:
            raise RuntimeError("the sign-in service was not asked exactly once to authenticate")
        samples = {
            "list-5-threads.json": listing,
            "list-not-modified-304.json": exchange(web, "/captain/mail", token, etag=etag),
            "list-empty.json": exchange(empty, "/captain/mail", token),
            "list-truncated-200-threads.json": exchange(crowded, "/captain/mail", token),
            "thread-with-attachments-and-refs.json": exchange(web, "/captain/mail/MT-1", token),
            "thread-html-only.json": exchange(web, "/captain/mail/MT-2", token),
            "thread-sent-and-received.json": exchange(web, "/captain/mail/MT-3", token),
            "thread-cut-long-body.json": exchange(web, "/captain/mail/MT-4", token),
            "thread-omitted-older-mails.json": exchange(web, "/captain/mail/MT-5", token),
            "error-400-bad-ref.json": exchange(web, "/captain/mail/MT-0", token),
            "error-401-sign-in-required.json": exchange(web, "/captain/mail", token, cookie=False),
            "error-403-session-refused.json": refused,
            "error-404-no-thread.json": exchange(web, "/captain/mail/MT-99", token),
            "error-503-request-unavailable.json": exchange(failing, "/captain/mail", token),
        }
        if server.refused:
            raise RuntimeError("the stand-in mail server saw a method that is not a read")
        state = None
    for name, status in EXPECTED_STATUS.items():
        if samples[name]["status"] != status:
            raise RuntimeError(f"{name} answered {samples[name]['status']}, not {status}")
    return {name: render(sample) for name, sample in samples.items()}


def sums(folder):
    lines = []
    for path in sorted(
        (item for item in folder.iterdir() if item.is_file() and item.name != "SHA256SUMS.txt"),
        key=lambda item: item.name.encode("utf-8"),
    ):
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
    return "".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Record the Mail API v1 sample payloads from the real module, in process.")
    parser.add_argument("--out", help="a folder to write the sample files and SHA256SUMS.txt into; files are never overwritten")
    parser.add_argument("--sums", help="write only SHA256SUMS.txt for this existing folder; it is never overwritten")
    args = parser.parse_args(argv)
    if args.sums:
        with (Path(args.sums) / "SHA256SUMS.txt").open("x", encoding="ascii") as handle:
            handle.write(sums(Path(args.sums)))
        return 0
    files = build()
    for name, data in files.items():
        print(name, len(data), "bytes")
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            with (out / name).open("xb") as handle:
                handle.write(data)
        with (out / "SHA256SUMS.txt").open("x", encoding="ascii") as handle:
            handle.write(sums(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
