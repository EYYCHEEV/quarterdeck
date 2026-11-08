import argparse
import hashlib
import json
import os
import sys
import tempfile
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
WORK = Path(os.environ.get("CARDS_API_WORK") or HERE.parents[1] / "work")
for part in (
    "captain-app",
    "golive/approval",
    "golive/shared",
    "golive/door",
    "qd-mail-stalwart",
    "qd-cards",
):
    sys.path.insert(0, str(WORK / part))

import approval_app
import approval_security
import application
import auth_bridge
import cards
import checker_adapter
import live

REGISTRY = {
    "format": 1,
    "steward": "bot-a",
    "captain": "account-user",
    "projects": {"Fleet": "bot-a", "Repo": "repo-lead", "Web": "bot-b"},
}
CAPTAIN = "account-user"
NOW = datetime(2026, 11, 3, 4, 0, tzinfo=timezone.utc)
ORIGIN = "https://quarterdeck.invalid"
HOST = "quarterdeck.invalid"
PLACEHOLDER_CSRF = "csrf-placeholder"
PLACEHOLDER_FRESH = 0
FIRST_SENT = datetime(2026, 11, 2, 9, 0, tzinfo=timezone(timedelta(hours=-5)))
MOVED_CARD = "repo-lead-7"
MOVED_FROM = "Launch"
MOVED_TO = "Review"
SOCKET_PATH = "/run/qd-test/auth.sock"
REFUSAL_REPLY = b'{"ok":false,"csrf":"","freshUntil":0.0,"freshRequired":false}\n'
SIGNED_IN_REPLY = b'{"ok":true,"csrf":"fresh-csrf","freshUntil":0.0,"freshRequired":false}\n'

CARD_ROWS = (
    ("bot-a-1", "Fleet", "Ops", "Pick the backup window"),
    ("bot-a-2", "Fleet", "Ops", "Approve the log retention change"),
    ("bot-a-3", "Fleet", "Ops", "Choose the alert channel"),
    ("bot-a-4", "Fleet", "Launch", "Rotate the build agents"),
    ("bot-a-5", "Fleet", "Launch", "Name the launch checklist owner"),
    ("bot-a-6", "Fleet", "Ops", "Set the status page wording"),
    ("bot-a-7", "Fleet", "Launch", "Pick the rollout order"),
    ("bot-a-8", "Fleet", "Ops", "Retire the old dashboard"),
    ("bot-a-9", "Fleet", "Ops", "Decide the pager rota"),
    ("bot-a-10", "Fleet", "Launch", "Choose the release train day"),
    ("repo-lead-1", "Repo", "Review", "Merge the queue rewrite"),
    ("repo-lead-2", "Repo", "Ship", "Run the data migration"),
    ("repo-lead-3", "Repo", "Launch", "Choose the branch naming rule"),
    ("repo-lead-4", "Repo", "Review", "Pick the review depth"),
    ("repo-lead-5", "Repo", "Review", "Approve the new lint rules"),
    ("repo-lead-6", "Repo", "Launch", "Decide the changelog format"),
    ("repo-lead-7", "Repo", "Launch", "Choose the release cut"),
    ("repo-lead-8", "Repo", "Ship", "Set the flaky test policy"),
    ("repo-lead-9", "Repo", "Ship", "Pick the hotfix process"),
    ("repo-lead-10", "Repo", "Launch", "Choose the docs host"),
    ("repo-lead-11", "Repo", "Review", "Drop the legacy flag"),
    ("repo-lead-12", "Repo", "Ship", "Name the next milestone"),
    ("bot-b-1", "Web", "Docs", "Pick the docs theme"),
    ("bot-b-2", "Web", "Docs", "Choose the search provider"),
    ("bot-b-3", "Web", "Docs", "Approve the new landing copy"),
    ("bot-b-4", "Web", "Ops", "Set the uptime target"),
    ("bot-b-5", "Web", "Ops", "Choose the cache lifetime"),
    ("bot-b-6", "Web", "Docs", "Decide the image sizes"),
    ("bot-b-7", "Web", "Docs", "Pick the font pairing"),
    ("bot-b-8", "Web", "Ops", "Choose the CDN plan"),
    ("bot-b-9", "Web", "Docs", "Name the help page"),
)
DUES = {
    "bot-a-1": "2026-11-04T09:00:00-05:00",
    "repo-lead-2": "2026-11-03T17:00:00-05:00",
    "repo-lead-7": "2026-11-04T18:00:00-05:00",
    "bot-b-5": "2026-11-05T12:00:00-05:00",
}
OPTION_NOTES = {
    "does": "Tags the newest change for release.",
    "cost": "No extra work for the team.",
    "risk": "Late fixes wait for the next cut.",
    "undo": "Delete the tag and cut again.",
    "tradeoff": "Speed over review time.",
    "why": "It keeps the release train moving.",
}


class StandInMailbox:
    def __init__(self, messages):
        self.inbox = list(messages)
        self.sent = []

    def messages(self):
        return list(self.inbox)

    def send(self, recipient, subject, body, resend_key):
        self.sent.append((recipient, subject, body, resend_key))
        return f"sent-{len(self.sent)}"

    def send_chat(self, recipient, subject, body, resend_key):
        return self.send(recipient, subject, body, resend_key), False


class FailingUpdates:
    def __init__(self, inner):
        self.inner = inner

    def snapshot(self):
        raise RuntimeError("stand-in service failure")

    def events(self, *, after):
        return self.inner.events(after=after)


class SocketConnection:
    def __init__(self, owner):
        self.owner = owner
        self.unread = owner.reply

    def __enter__(self):
        return self

    def __exit__(self, *details):
        return False

    def settimeout(self, seconds):
        return None

    def connect(self, path):
        if self.owner.connect_error is not None:
            raise self.owner.connect_error

    def sendall(self, data):
        self.owner.sent.append(bytes(data))

    def recv(self, size):
        chunk, self.unread = self.unread[:size], self.unread[size:]
        return chunk


class SocketStandIn:
    def __init__(self, reply, connect_error=None):
        self.reply = reply
        self.connect_error = connect_error
        self.opened = 0
        self.sent = []

    def __call__(self, family, kind):
        self.opened += 1
        return SocketConnection(self)


def card_body(card_id, project, lane, title, *, kind="decision", rich=False):
    body = {
        "qd": "card/1",
        "card": card_id,
        "id": card_id,
        "project": project,
        "lane": lane,
        "title": title,
        "about": f"{project} work that needs a call.",
        "context": "It is ready for a decision.\nNothing else is waiting on it.",
        "options": [
            {"label": "A. Go with the plan", "pick": True},
            {"label": "B. Hold for now"},
        ],
        "pick_why": "A keeps the schedule.",
        "you_do": "Pick one option.",
        "skip": "If no answer by due: the plan goes ahead.",
        "category": ["strategy"],
        "door": "two-way",
        "kind": kind,
    }
    if card_id in DUES:
        body["due"] = DUES[card_id]
    if kind == "action":
        body["commands"] = [{"where": "On the dev server", "run": "qd status --brief"}]
    if rich:
        body["ascii"] = "[Launch] --> [Review]"
        body["words"] = [["cut", "the moment a release is tagged"]]
        body["principles"] = {"follows": "Small steps", "departs": "None"}
        body["learn"] = [{"label": "Release guide", "url": "https://example.com/release-guide"}]
        body["note"] = "A longer page for this card.\nSecond line of the note."
        body["options"] = [
            {
                "label": "A. Cut from main",
                "pick": True,
                "pros": ["Simple", "Fast"],
                "cons": ["Less review time"],
                **OPTION_NOTES,
            },
            {
                "label": "B. Cut from the review lane",
                "pros": ["More review time"],
                "cons": ["Slower"],
                **OPTION_NOTES,
            },
        ]
    return body


def mailbox_messages():
    counter = [0]
    minutes = [0]

    def sent():
        minutes[0] += 1
        return (FIRST_SENT + timedelta(minutes=minutes[0])).isoformat(timespec="seconds")

    def mail(sender, subject, body):
        counter[0] += 1
        text = body if isinstance(body, str) else json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        return cards.MailMessage(f"msg-{counter[0]:03d}", sender, subject, text, sent())

    def poster(card_id):
        return next(sender for sender in ("bot-a", "repo-lead", "bot-b") if card_id.startswith(sender + "-"))

    messages = []
    for card_id, project, lane, title in CARD_ROWS:
        kind = "action" if card_id == "repo-lead-2" else "decision"
        body = card_body(card_id, project, lane, title, kind=kind, rich=card_id == MOVED_CARD)
        messages.append(mail(poster(card_id), f"CARD: {title}", body))
    messages.append(mail("bot-a", "CARD: Broken card", "this is not a card"))
    messages.append(
        mail("repo-lead", "CARD: A title that is far too long to fit on one line of the card, so the checker refuses it",
             card_body("repo-lead-13", "Repo", "Review", "A title that is far too long to fit on one line of the card, so the checker refuses it")),
    )

    def update(card_id, revision, sender, **changes):
        messages.append(mail(sender, f"UPDATE: {card_id}", {"qd": "update/1", "card": card_id, "rev": revision, **changes}))

    def comment(card_id, sender, text):
        messages.append(mail(sender, f"COMMENT: {card_id}", {"qd": "comment/1", "card": card_id, "text": text}))

    def answer(card_id, pick, note):
        stamp = (FIRST_SENT + timedelta(minutes=minutes[0] + 1) - timedelta(seconds=20)).isoformat(timespec="seconds")
        messages.append(
            mail(CAPTAIN, f"ANSWER: {card_id} {pick}", {
                "qd": "answer/1", "card": card_id, "rev": 1, "pick": pick, "note": note, "at": stamp,
            })
        )

    def withdraw(card_id, sender, why):
        messages.append(mail(sender, f"WITHDRAW: {card_id}", {"qd": "withdraw/1", "card": card_id, "why": why}))

    comment(MOVED_CARD, "bot-a", "This one needs a date before the review lane picks it up.")
    update(MOVED_CARD, 2, "repo-lead", lane=MOVED_TO)
    answer("bot-a-3", "A", "Use the first channel.")
    update("bot-a-5", 2, "bot-a", title="Name the launch checklist owner and a backup", due="2026-11-06T09:00:00-05:00")
    comment(MOVED_CARD, "repo-lead", "Moved to the review lane as asked.")
    withdraw("bot-a-8", "bot-a", "The old dashboard stays for now.")
    answer("repo-lead-4", "cant-decide", "I need more detail first.")
    update(MOVED_CARD, 3, "repo-lead", title="Choose the release cut and its owner")
    answer("repo-lead-9", "B", "")
    answer("bot-b-2", "none", "Neither fits.")
    answer("bot-b-7", "A", "")
    withdraw("bot-b-7", "bot-b", "The font choice was made elsewhere.")
    withdraw("repo-lead-11", "repo-lead", "The flag is still in use.")
    update("bot-b-4", 2, "bot-a", due="2026-11-05T09:00:00-05:00")
    return messages


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def build_application(service, updates, state):
    approval = object.__new__(approval_app.ApprovalApplication)
    approval.state = state
    approval.trusted_proxy = "proxy"
    approval.public_origin = ORIGIN
    approval.forwarded_host = HOST
    return application.CardApplication(application.ApprovalGate(approval), service, updates, clock=lambda: 1000.0)


def exchange(app, token, path, *, cookie=True, etag=None):
    headers = {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": HOST,
        "X-Forwarded-For": "192.0.2.10",
    }
    if cookie:
        headers["Cookie"] = f"__Host-qd-approval={token}"
    if etag is not None:
        headers["If-None-Match"] = etag
    response = app.handle(approval_app.Request("GET", path, headers, bytearray(), "proxy"))
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


def render(sample):
    return (json.dumps(sample, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def build_service():
    mailbox = StandInMailbox(mailbox_messages())
    checker = checker_adapter.LaneAChecker(REGISTRY, clock=lambda: NOW)
    service = cards.CardService(mailbox, checker)
    updates = live.LiveUpdates(service)
    updates.check_once()
    if mailbox.sent:
        raise RuntimeError("the stand-in mailbox saw a refusal mail")
    return service, updates


def through_real_gate(service, updates, reply, path, *, cookie=True, connect_error=None):
    owner = SocketStandIn(reply, connect_error)
    stand_in = types.SimpleNamespace(socket=owner, AF_UNIX=1, SOCK_STREAM=1)
    with mock.patch.object(auth_bridge, "socket", stand_in):
        gate = auth_bridge.SocketApprovalGate(auth_bridge.ApprovalAuthClient(SOCKET_PATH))
        app = application.CardApplication(gate, service, updates, clock=lambda: 1000.0)
        return exchange(app, "session-placeholder", path, cookie=cookie), owner


def build():
    service, updates = build_service()
    entropy = [0]

    def token_bytes(size):
        entropy[0] += 1
        return bytes([entropy[0]]) * size

    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        root.chmod(0o700)
        state = approval_security.ApprovalState(
            root / "approval.sqlite",
            b"s" * 32,
            clock=lambda: 1000.0,
            token_bytes=token_bytes,
        )
        token = state.start_browser_session(
            "account-user-subject", device_hash=None, kind="Other browser", fresh_from=1000.0
        ).token
        app = build_application(service, updates, state)
        failing = build_application(service, FailingUpdates(updates), state)
        listing = exchange(app, token, "/captain/cards")
        etag = listing["headers"]["ETag"]
        refused, owner = through_real_gate(service, updates, REFUSAL_REPLY, "/captain/cards")
        if [json.loads(item)["operation"] for item in owner.sent] != ["authenticate"]:
            raise RuntimeError("the sign-in service was not asked exactly once to authenticate")
        samples = {
            "list-31-cards.json": listing,
            "list-not-modified-304.json": exchange(app, token, "/captain/cards", etag=etag),
            "card-open-with-thread.json": exchange(app, token, f"/captain/cards/{MOVED_CARD}"),
            "card-answered.json": exchange(app, token, "/captain/cards/bot-a-3"),
            "card-withdrawn.json": exchange(app, token, "/captain/cards/bot-a-8"),
            "error-400-unknown-card.json": exchange(app, token, "/captain/cards/repo-lead-99"),
            "error-401-sign-in-required.json": exchange(app, token, "/captain/cards", cookie=False),
            "error-403-session-refused.json": refused,
            "error-503-request-unavailable.json": exchange(failing, token, "/captain/cards"),
        }
        state = None
    expected = {
        "list-31-cards.json": 200,
        "list-not-modified-304.json": 304,
        "card-open-with-thread.json": 200,
        "card-answered.json": 200,
        "card-withdrawn.json": 200,
        "error-400-unknown-card.json": 400,
        "error-401-sign-in-required.json": 401,
        "error-403-session-refused.json": 403,
        "error-503-request-unavailable.json": 503,
    }
    for name, status in expected.items():
        if samples[name]["status"] != status:
            raise RuntimeError(f"{name} answered {samples[name]['status']}, not {status}")
    return {name: render(sample) for name, sample in samples.items()}


def sums(folder):
    lines = []
    for path in sorted((item for item in folder.iterdir() if item.is_file() and item.name != "SHA256SUMS.txt"), key=lambda item: item.name.encode("utf-8")):
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
    return "".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Record the cards API v1 sample payloads from the real application code, in process.")
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
