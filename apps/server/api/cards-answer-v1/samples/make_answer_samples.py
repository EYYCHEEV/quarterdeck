import argparse
import hashlib
import json
import os
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
WORK = Path(os.environ.get("CARDS_API_WORK") or HERE.parents[1] / "app")
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
import captain_auth_socket
import cards
import checker_adapter
import invite_prompt
import live
import mail_gateway
import qd_jmap
from test_signin_support import production_sign_in

ET = ZoneInfo("America/New_York")
START = datetime(2026, 11, 5, 10, 0, tzinfo=ET)
ORIGIN = "https://quarterdeck.invalid"
HOST = "quarterdeck.invalid"
DOMAIN = "quarterdeck.invalid"
CAPTAIN = "account-user"
STEWARD = "bot-a"
REGISTRY = {
    "format": 1,
    "steward": STEWARD,
    "captain": CAPTAIN,
    "projects": {"Fleet": "bot-a", "Repo": "repo-lead", "Web": "bot-b"},
}
PLACEHOLDER_CSRF = "csrf-placeholder"
PLACEHOLDER_FRESH = 0
USED_CSRF = "csrf-placeholder (already used)"
REAL = "real"
IN_PROCESS = "in-process"
INBOX = "box-inbox"
DRAFTS = "box-drafts"
SENT = "box-sent"
SESSION_LIMIT = approval_security.AUTH_SESSION_LIMIT
LONG_NOTE = "x" * 4001

CARD_ROWS = (
    ("repo-lead-1", "Repo", "Review", "Choose the release cut"),
    ("repo-lead-2", "Repo", "Ship", "Pick the review depth"),
    ("repo-lead-3", "Repo", "Launch", "Run the data migration"),
    ("bot-a-1", "Fleet", "Ops", "Pick the backup window"),
    ("bot-a-2", "Fleet", "Ops", "Choose the alert channel"),
    ("bot-a-3", "Fleet", "Launch", "Rotate the build agents"),
    ("bot-b-1", "Web", "Docs", "Pick the docs theme"),
    ("bot-b-2", "Web", "Docs", "Choose the search provider"),
)

EXPECTED_STATUS = {
    "answer-200-letter-pick-with-note.json": 200,
    "answer-200-older-revision-stale.json": 200,
    "answer-200-cant-decide.json": 200,
    "answer-200-none-empty-note.json": 200,
    "answer-200-second-answer-to-a-done-card.json": 200,
    "answer-503-second-answer-same-pick.json": 503,
    "answer-200-answer-to-a-withdrawn-card.json": 200,
    "answer-303-fresh-sign-in-needed.json": 303,
    "answer-400-wrong-content-type.json": 400,
    "answer-400-extra-field.json": 400,
    "answer-400-id-not-shaped-like-a-card.json": 400,
    "answer-400-unknown-card.json": 400,
    "answer-400-revision-does-not-exist.json": 400,
    "answer-400-pick-not-on-revision.json": 400,
    "answer-400-note-too-long.json": 400,
    "answer-403-used-csrf.json": 403,
    "answer-429-rate-limited.json": 429,
    "answer-403-rate-limited-on-the-real-sign-in.json": 403,
    "answer-503-service-failure.json": 503,
    "comment-200-sent.json": 200,
    "comment-400-empty-text.json": 400,
    "comment-200-same-text-again.json": 200,
    "comment-200-same-text-new-request-id.json": 200,
    "card-after-answer.json": 200,
    "card-after-second-answer.json": 200,
    "card-withdrawn-after-answer.json": 200,
    "list-after-answers.json": 200,
}


class NoCredential:
    def clear(self):
        return None


class NoIdentity:
    def authorization_url(self, **fields):
        raise RuntimeError("sign-in by identity is not part of these samples")

    def exchange_code(self, *values, **fields):
        raise RuntimeError("sign-in by identity is not part of these samples")


class NoBackend:
    def pending(self):
        return []

    def invites(self):
        return []


class StandInMail:
    def __init__(self, now):
        self.now = now
        self.emails = {}
        self.log = []
        self.refuse_submissions = False

    def add_inbox(self, message_id, sender, subject, body, received):
        email_id = f"email-{len(self.emails) + 1}"
        self.emails[email_id] = {
            "id": email_id,
            "box": INBOX,
            "messageId": [message_id],
            "from": f"{sender}@{DOMAIN}",
            "to": f"{CAPTAIN}@{DOMAIN}",
            "subject": subject,
            "received": received.astimezone(timezone.utc),
            "body": body,
            "words": "",
        }

    def call(self, *calls):
        results = []
        for name, args in calls:
            handler = getattr(self, "do_" + name.replace("/", "_"), None)
            if handler is None:
                raise AssertionError(f"the stand-in mail service has no {name}")
            results.append(handler(args, results))
        return results

    def do_Identity_get(self, args, results):
        return {"list": [{"id": "identity-1", "email": f"{CAPTAIN}@{DOMAIN}"}]}

    def do_Mailbox_get(self, args, results):
        return {
            "list": [
                {"id": INBOX, "role": "inbox"},
                {"id": DRAFTS, "role": "drafts"},
                {"id": SENT, "role": "sent"},
            ]
        }

    def do_Email_query(self, args, results):
        wanted = args["filter"]
        header = None
        if "conditions" in wanted:
            conditions = wanted["conditions"]
            if wanted.get("operator") != "AND" or any(set(item) - {"inMailbox", "header"} for item in conditions):
                raise AssertionError("the stand-in mail service only answers AND of a mailbox and a header")
            box = next(item["inMailbox"] for item in conditions if "inMailbox" in item)
            header = next((item["header"] for item in conditions if "header" in item), None)
            if header is not None and header[0] != "Message-ID":
                raise AssertionError("the stand-in mail service only searches Message-ID")
        else:
            if set(wanted) != {"inMailbox"}:
                raise AssertionError("the stand-in mail service only filters by mailbox")
            box = wanted["inMailbox"]
        found = [
            email
            for email in self.emails.values()
            if email["box"] == box and (header is None or email["messageId"] == [header[1]])
        ]
        sort = args.get("sort")
        found.sort(key=lambda email: email["received"], reverse=bool(sort) and not sort[0]["isAscending"])
        start = args.get("position", 0)
        limit = args.get("limit")
        chosen = found[start:] if limit is None else found[start:start + limit]
        return {"ids": [email["id"] for email in chosen]}

    def property(self, email, name):
        if name == "id":
            return email["id"]
        if name == "messageId":
            return list(email["messageId"])
        if name == "from":
            return [{"email": email["from"]}]
        if name == "to":
            return [{"email": email["to"]}]
        if name == "subject":
            return email["subject"]
        if name == "receivedAt":
            return email["received"].isoformat(timespec="seconds").replace("+00:00", "Z")
        if name == "textBody":
            return [{"partId": "b", "type": "text/plain"}]
        if name == "bodyValues":
            return {"b": {"value": email["body"]}}
        if name == f"header:{qd_jmap.WORDS_HEADER}:asText":
            return email["words"]
        raise AssertionError(f"the stand-in mail service has no property {name}")

    def do_Email_get(self, args, results):
        return {
            "list": [
                {name: self.property(self.emails[email_id], name) for name in args["properties"]}
                for email_id in args["ids"]
            ]
        }

    def do_Email_set(self, args, results):
        wanted = args["create"]["m"]
        email_id = f"email-{len(self.emails) + 1}"
        self.emails[email_id] = {
            "id": email_id,
            "box": DRAFTS,
            "messageId": list(wanted["messageId"]),
            "from": wanted["from"][0]["email"],
            "to": wanted["to"][0]["email"],
            "subject": wanted["subject"],
            "received": self.now(),
            "body": wanted["bodyValues"]["b"]["value"],
            "words": wanted[f"header:{qd_jmap.WORDS_HEADER}:asText"],
        }
        return {"created": {"m": {"id": email_id}}}

    def do_EmailSubmission_set(self, args, results):
        email_id = results[-1]["created"]["m"]["id"]
        if self.refuse_submissions:
            return {"notCreated": {"s": {"type": "forbidden"}}}
        email = self.emails[email_id]
        email["box"] = SENT
        email["received"] = self.now()
        self.log.append((email["to"].partition("@")[0], email["subject"]))
        return {"created": {"s": {"id": "submission-1", "undoStatus": "pending"}}}


def card_body(card_id, project, lane, title):
    return {
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
        "kind": "decision",
    }


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def exchange(app, token, method, path, *, payload=None, content_type="application/json", cookie=True):
    headers = {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": HOST,
        "X-Forwarded-For": "192.0.2.10",
    }
    if cookie:
        headers["Cookie"] = f"__Host-qd-approval={token}"
    body = bytearray()
    if method == "POST":
        headers["Origin"] = ORIGIN
        if content_type is not None:
            headers["Content-Type"] = content_type
        body = bytearray(json.dumps(payload).encode("utf-8"))
    response = app.handle(approval_app.Request(method, path, headers, body, "proxy"))
    names = [name for name, _ in response.headers]
    if len(names) != len(set(names)):
        raise RuntimeError("a response repeats a header name")
    shown = dict(response.headers)
    answer = json.loads(response.body) if response.body else None
    csrf = None
    if isinstance(answer, dict):
        if "csrf" in answer:
            csrf = answer["csrf"]
            answer["csrf"] = PLACEHOLDER_CSRF
        if "freshUntil" in answer:
            answer["freshUntil"] = PLACEHOLDER_FRESH
    if answer is not None:
        shown["Content-Length"] = str(len(compact(answer).encode("utf-8")))
    return {"status": response.status, "headers": shown, "body": answer}, csrf


class Client:
    def __init__(self, world, app, label, token):
        self.world = world
        self.app = app
        self.label = label
        self.token = token
        self.csrf = None

    def get(self, path):
        shown, csrf = exchange(self.app, self.token, "GET", path)
        if csrf is not None:
            self.csrf = csrf
        return {"request": {"method": "GET", "path": path}, "signIn": self.label, **shown}

    def post(self, path, fields, *, csrf=None, shown_csrf=PLACEHOLDER_CSRF, content_type="application/json", shown_fields=None):
        token = self.csrf if csrf is None else csrf
        before = len(self.world.mail.log)
        shown, fresh = exchange(
            self.app, self.token, "POST", path, payload={**fields, "csrf": token}, content_type=content_type
        )
        if fresh is not None:
            self.csrf = fresh
        request = {
            "method": "POST",
            "path": path,
            "headers": {"Content-Type": content_type},
            "body": {**(fields if shown_fields is None else shown_fields), "csrf": shown_csrf},
        }
        outbound = [{"to": to, "subject": subject} for to, subject in self.world.mail.log[before:]]
        return {"request": request, "signIn": self.label, **shown, "outbound": outbound}

    def answer(self, card_id, rev, pick, note, **options):
        return self.post(f"/captain/cards/{card_id}/answer", {"rev": rev, "pick": pick, "note": note}, **options)

    def comment(self, card_id, text, request_id, **options):
        return self.post(f"/captain/cards/{card_id}/comments", {"text": text, "requestId": request_id}, **options)


class World:
    def __init__(self, folder):
        folder.chmod(0o700)
        self.clock = [START.timestamp()]
        self.mail = StandInMail(self.now_utc)
        self.load_cards()
        mailbox = mail_gateway.CaptainMailbox(
            qd_jmap.Mailbox(self.mail), NoCredential(), account_name=CAPTAIN, oversight_bot=STEWARD
        )
        checker = checker_adapter.LaneAChecker(REGISTRY, clock=self.now_utc)
        self.service = cards.CardService(mailbox, checker)
        self.updates = live.LiveUpdates(self.service)
        self.updates.check_once()
        self.state = approval_security.ApprovalState(folder / "approval.sqlite", b"s" * 32, clock=self.seconds)
        sign_in = production_sign_in(self.state, NoIdentity())
        self.approval = approval_app.ApprovalApplication(
            self.state,
            sign_in,
            NoBackend(),
            invite_prompt.ReleaseConfig(None, None, None, ORIGIN),
            trusted_proxy="proxy",
            public_origin=ORIGIN,
        )
        socket_dir = folder / "captain-auth"
        socket_dir.mkdir()
        os.chown(socket_dir, -1, os.getgid())
        socket_dir.chmod(0o2770)
        self.socket_path = socket_dir / "auth.sock"
        self.owner = captain_auth_socket.CaptainAuthSocketService(
            sign_in,
            self.approval,
            self.socket_path,
            expected_uid=os.getuid(),
            socket_mode=0o660,
            socket_gid=os.getgid(),
        )
        self.owner.start()
        gate = auth_bridge.SocketApprovalGate(auth_bridge.ApprovalAuthClient(str(self.socket_path)))
        self.real = application.CardApplication(gate, self.service, self.updates, clock=self.seconds)
        self.inprocess = application.CardApplication(
            application.ApprovalGate(self.approval), self.service, self.updates, clock=self.seconds
        )

    def seconds(self):
        return self.clock[0]

    def now_utc(self):
        return datetime.fromtimestamp(self.clock[0], timezone.utc)

    def tick(self, seconds=20):
        self.clock[0] += seconds

    def poll(self):
        return self.updates.check_once()

    def load_cards(self):
        number = [0]
        first = START - timedelta(hours=2)

        def add(sender, subject, body):
            number[0] += 1
            self.mail.add_inbox(
                f"msg-{number[0]:03d}", sender, subject, compact(body), first + timedelta(minutes=number[0])
            )

        for card_id, project, lane, title in CARD_ROWS:
            add(card_id.rsplit("-", 1)[0], f"CARD: {title}", card_body(card_id, project, lane, title))
        add(
            "repo-lead",
            "UPDATE: repo-lead-1",
            {
                "qd": "update/1",
                "card": "repo-lead-1",
                "rev": 2,
                "options": [
                    {"label": "A. Cut from main", "pick": True},
                    {"label": "B. Cut from the review lane"},
                    {"label": "C. Cut next week"},
                ],
            },
        )
        add(
            "bot-b",
            "WITHDRAW: bot-b-2",
            {"qd": "withdraw/1", "card": "bot-b-2", "why": "The provider was chosen elsewhere."},
        )

    def session(self, fresh):
        started = self.state.start_browser_session(
            "account-user-subject",
            device_hash=None,
            kind="Other browser",
            fresh_from=self.clock[0] if fresh else None,
        )
        return started.token

    def client(self, label, *, fresh=True):
        app = self.real if label == REAL else self.inprocess
        return Client(self, app, label, self.session(fresh))

    def close(self):
        previous = threading.excepthook

        def quiet(args):
            known = (
                args.thread is not None
                and args.thread.name == "captain-auth-socket"
                and isinstance(args.exc_value, AttributeError)
            )
            if not known:
                previous(args)

        threading.excepthook = quiet
        try:
            self.owner.close()
        finally:
            threading.excepthook = previous


def run(world):
    samples = {}
    main = world.client(REAL)
    main.get("/captain/cards")
    world.tick()

    samples["answer-200-letter-pick-with-note.json"] = main.answer("repo-lead-2", 1, "B", "Hold until Monday.")
    world.tick()
    world.poll()
    samples["card-after-answer.json"] = main.get("/captain/cards/repo-lead-2")
    world.tick()

    samples["answer-200-older-revision-stale.json"] = main.answer("repo-lead-1", 1, "A", "Going with A.")
    world.tick()
    samples["answer-200-cant-decide.json"] = main.answer("bot-a-1", 1, "cant-decide", "I need to see the cost first.")
    world.tick()
    samples["answer-200-none-empty-note.json"] = main.answer("bot-b-1", 1, "none", "")
    world.tick()

    main.answer("bot-a-2", 1, "A", "")
    world.tick()
    world.poll()
    samples["answer-200-second-answer-to-a-done-card.json"] = main.answer("bot-a-2", 1, "B", "Changed my mind.")
    world.tick()
    world.poll()
    samples["card-after-second-answer.json"] = main.get("/captain/cards/bot-a-2")
    world.tick()
    samples["answer-503-second-answer-same-pick.json"] = main.answer("bot-a-2", 1, "B", "Changed my mind again.")
    main.get("/captain/cards")
    world.tick()

    samples["answer-200-answer-to-a-withdrawn-card.json"] = main.answer("bot-b-2", 1, "A", "")
    world.tick()
    world.poll()
    samples["card-withdrawn-after-answer.json"] = main.get("/captain/cards/bot-b-2")
    world.tick()

    ended = world.client(REAL, fresh=False)
    ended.get("/captain/cards")
    samples["answer-303-fresh-sign-in-needed.json"] = ended.answer("bot-a-3", 1, "A", "")
    world.tick()

    samples["answer-400-wrong-content-type.json"] = main.answer("bot-a-3", 1, "A", "", content_type="text/plain")
    samples["answer-400-extra-field.json"] = main.post(
        "/captain/cards/bot-a-3/answer", {"rev": 1, "pick": "A", "note": "", "urgent": True}
    )
    samples["answer-400-id-not-shaped-like-a-card.json"] = main.post(
        "/captain/cards/bad_id/answer", {"rev": 1, "pick": "A", "note": ""}
    )
    samples["answer-400-unknown-card.json"] = main.answer("repo-lead-99", 1, "A", "")
    main.get("/captain/cards")
    samples["answer-400-revision-does-not-exist.json"] = main.answer("repo-lead-1", 3, "A", "")
    main.get("/captain/cards")
    samples["answer-400-pick-not-on-revision.json"] = main.answer("repo-lead-1", 1, "C", "")
    main.get("/captain/cards")
    spent = main.csrf
    samples["answer-400-note-too-long.json"] = main.answer(
        "bot-a-3", 1, "A", LONG_NOTE, shown_fields={"rev": 1, "pick": "A", "note": "<4001 characters>"}
    )
    world.tick()
    samples["answer-403-used-csrf.json"] = main.answer(
        "bot-a-3", 1, "A", "", csrf=spent, shown_csrf=USED_CSRF
    )
    main.get("/captain/cards")
    world.tick()

    world.mail.refuse_submissions = True
    samples["answer-503-service-failure.json"] = main.answer("bot-a-3", 1, "A", "")
    world.mail.refuse_submissions = False
    main.get("/captain/cards")
    world.tick()

    samples["comment-200-sent.json"] = main.comment("repo-lead-3", "Can this wait until the review lane opens?", "req-0001")
    world.tick()
    samples["comment-400-empty-text.json"] = main.comment("repo-lead-3", "", "req-0002")
    main.get("/captain/cards")
    samples["comment-200-same-text-again.json"] = main.comment("repo-lead-3", "Can this wait until the review lane opens?", "req-0001")
    samples["comment-200-same-text-new-request-id.json"] = main.comment(
        "repo-lead-3", "Can this wait until the review lane opens?", "req-0003"
    )

    world.tick(120)
    flooded = world.client(IN_PROCESS)
    for _ in range(SESSION_LIMIT):
        flooded.get("/captain/cards")
    samples["answer-429-rate-limited.json"] = flooded.answer("bot-a-3", 1, "A", "")

    world.tick(120)
    flooded = world.client(REAL)
    for _ in range(SESSION_LIMIT):
        flooded.get("/captain/cards")
    samples["answer-403-rate-limited-on-the-real-sign-in.json"] = flooded.answer("bot-a-3", 1, "A", "")

    world.tick(120)
    world.poll()
    reader = world.client(REAL)
    samples["list-after-answers.json"] = reader.get("/captain/cards")

    for name, status in EXPECTED_STATUS.items():
        if samples[name]["status"] != status:
            raise RuntimeError(f"{name} answered {samples[name]['status']}, not {status}")
    if set(samples) != set(EXPECTED_STATUS):
        raise RuntimeError("the recorded samples are not the expected set")
    return samples


def render(sample):
    return (json.dumps(sample, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def build():
    with tempfile.TemporaryDirectory() as folder:
        world = World(Path(folder))
        try:
            samples = run(world)
        finally:
            world.close()
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
    parser = argparse.ArgumentParser(
        description="Record the cards answer API v1 sample payloads from the real application code, in process."
    )
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
