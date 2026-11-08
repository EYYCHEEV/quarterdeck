import hashlib
import json
import os
import sys
import types
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
BASE = Path(os.environ.get("QD_WEB_BASE") or HERE.parent / "golive" / "api-cards-v1" / "app")
for part in (
    "captain-app",
    "golive/approval",
    "golive/shared",
    "golive/door",
    "qd-mail-stalwart",
    "qd-cards",
):
    sys.path.insert(0, str(BASE / part))
sys.path.insert(0, str(HERE))

import approval_app
import auth_bridge
import qd_jmap

SESSION_URL = "https://mail.qd.invalid/jmap/session"
ACCOUNT_NAME = "account-user"
DOMAIN = "qd.invalid"
INBOX, DRAFTS, SENT = "mb-inbox", "mb-drafts", "mb-sent"
STAND_IN_KEY = b"stand-in-key"
SOCKET_PATH = "/run/qd-test/auth.sock"
HOST = "quarterdeck.invalid"
SESSION_PLACEHOLDER = "session-placeholder"
REFUSAL_REPLY = b'{"ok":false,"csrf":"","freshUntil":0.0,"freshRequired":false}\n'
SIGNED_IN_REPLY = b'{"ok":true,"csrf":"fresh-csrf","freshUntil":0.0,"freshRequired":false}\n'
FIRST_RECEIVED = datetime(2026, 11, 4, 14, 0, tzinfo=timezone.utc)
READ_ONLY_METHODS = frozenset({"Identity/get", "Mailbox/get", "Email/query", "Email/get"})
MAIL_METHODS = frozenset({"Email/query", "Email/get"})


def message(index, **fields):
    record = {
        "id": f"e{index:03d}",
        "messageId": [f"msg-{index:03d}@{DOMAIN}"],
        "inReplyTo": [],
        "references": [],
        "mailbox": INBOX,
        "seen": False,
        "from": {"name": "Bot A", "email": f"bot-a@{DOMAIN}"},
        "to": [{"name": "", "email": f"{ACCOUNT_NAME}@{DOMAIN}"}],
        "subject": f"Subject {index}",
        "receivedAt": (FIRST_RECEIVED + timedelta(minutes=index)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "text": f"Body of message {index}.\nSecond line.",
        "html": None,
        "attachments": [],
    }
    record.update(fields)
    return record


class StandInStalwart:
    def __init__(self, messages=(), *, key=STAND_IN_KEY):
        self.messages = list(messages)
        self.key = key
        self.http = []
        self.calls = []
        self.refused = []
        self.unreachable = False
        self.refuse_with = 0
        self.stamp = None
        self.times = []

    def method_names(self):
        return [name for name, _ in self.calls]

    def mail_calls(self):
        return [(name, args) for name, args in self.calls if name in MAIL_METHODS]

    def __call__(self, method, url, headers, body=None):
        self.http.append((method, url))
        if self.stamp is not None:
            self.times.append(self.stamp())
        if self.unreachable:
            raise OSError("stand-in mail server unreachable")
        if self.refuse_with:
            return self.refuse_with, b""
        if headers.get("Authorization") != b"Bearer " + self.key:
            return 401, b""
        if method == "GET":
            return 200, json.dumps(
                {"apiUrl": "/jmap/api", "primaryAccounts": {"urn:ietf:params:jmap:mail": "acc-1"}}
            ).encode()
        responses = []
        for name, args, call_id in json.loads(body)["methodCalls"]:
            self.calls.append((name, args))
            responses.append(self.answer(name, args, call_id))
        return 200, json.dumps({"methodResponses": responses}).encode()

    def answer(self, name, args, call_id):
        if name not in READ_ONLY_METHODS:
            self.refused.append(name)
            return ["error", {"type": "unknownMethod"}, call_id]
        if name == "Identity/get":
            return [name, {"list": [{"id": "ident-1", "email": f"{ACCOUNT_NAME}@{DOMAIN}"}]}, call_id]
        if name == "Mailbox/get":
            boxes = [{"id": INBOX, "role": "inbox"}, {"id": DRAFTS, "role": "drafts"}, {"id": SENT, "role": "sent"}]
            return [name, {"list": boxes}, call_id]
        if name == "Email/query":
            return [name, self.query(args), call_id]
        return [name, self.get(args), call_id]

    def query(self, args):
        wanted = (args.get("filter") or {}).get("inMailbox")
        rows = [item for item in self.messages if wanted is None or item["mailbox"] == wanted]
        descending = any(not rule.get("isAscending", True) for rule in args.get("sort", []))
        rows.sort(key=lambda item: (item["receivedAt"], item["id"]), reverse=descending)
        position = args.get("position", 0)
        limit = min(args.get("limit", 256), 256)
        return {"ids": [item["id"] for item in rows[position:position + limit]], "position": position}

    def get(self, args):
        wanted = args.get("properties") or ["id"]
        cap = args.get("maxBodyValueBytes")
        found, missing = [], []
        by_id = {item["id"]: item for item in self.messages}
        for email_id in args.get("ids") or []:
            item = by_id.get(email_id)
            if item is None:
                missing.append(email_id)
            else:
                found.append(self.view(item, wanted, args.get("fetchTextBodyValues", False), cap))
        return {"list": found, "notFound": missing, "state": self.state()}

    def state(self):
        marks = sorted(f"{item['id']}:{item['mailbox']}" for item in self.messages)
        return hashlib.sha256("|".join(marks).encode()).hexdigest()[:16]

    @staticmethod
    def view(item, wanted, with_values, cap):
        body = item["text"] if item["text"] is not None else item["html"]
        kind = "text/plain" if item["text"] is not None else "text/html"
        truncated = False
        if body is not None and cap is not None:
            raw = body.encode("utf-8", "surrogatepass")
            if len(raw) > cap:
                body, truncated = raw[:cap].decode("utf-8", "ignore"), True
        parts = {
            "id": item["id"],
            "messageId": item["messageId"],
            "mailboxIds": {item["mailbox"]: True},
            "keywords": {"$seen": True} if item["seen"] else {},
            "from": [item["from"]],
            "to": item["to"],
            "subject": item["subject"],
            "receivedAt": item["receivedAt"],
            "hasAttachment": bool(item["attachments"]),
            "preview": (body or "")[:256],
            "size": len((body or "").encode("utf-8", "surrogatepass")) + sum(entry["size"] for entry in item["attachments"]),
            "textBody": [] if body is None else [{"partId": "1", "type": kind}],
            "attachments": [
                {"partId": f"a{number}", "name": entry["name"], "size": entry["size"], "type": entry.get("type", "application/octet-stream")}
                for number, entry in enumerate(item["attachments"])
            ],
            "inReplyTo": item["inReplyTo"],
            "references": item["references"],
        }
        if with_values and body is not None:
            parts["bodyValues"] = {"1": {"value": body, "isEncodingProblem": False, "isTruncated": truncated}}
        return {name: parts[name] for name in wanted if name in parts}


def jmap_over(server):
    credential = qd_jmap.Credential(bytearray(STAND_IN_KEY))
    return qd_jmap.Mailbox(qd_jmap.Jmap(SESSION_URL, credential, server))


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

    def operations(self):
        return [json.loads(item)["operation"] for item in self.sent]


def real_gate():
    return auth_bridge.SocketApprovalGate(auth_bridge.ApprovalAuthClient(SOCKET_PATH))


@contextmanager
def sign_in_service(reply=SIGNED_IN_REPLY, connect_error=None):
    owner = SocketStandIn(reply, connect_error)
    with mock.patch.object(auth_bridge, "socket", types.SimpleNamespace(socket=owner, AF_UNIX=1, SOCK_STREAM=1)):
        yield owner


def get_request(path, *, cookie=True, headers=None, method="GET"):
    sent = {"X-Forwarded-Proto": "https", "X-Forwarded-Host": HOST, "X-Forwarded-For": "192.0.2.10"}
    if cookie:
        sent["Cookie"] = f"__Host-qd-approval={SESSION_PLACEHOLDER}"
    sent.update(headers or {})
    return approval_app.Request(method, path, sent, bytearray(), "proxy")
