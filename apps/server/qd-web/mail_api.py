from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any

import approval_app
import application
import cards
import qd_jmap

LIST_PATH = "/captain/mail"
THREAD_PREFIX = "/captain/mail/"
MAX_THREADS = 200
MAX_MAILS = 50
MAX_TEXT_BYTES = 16_384
MAX_ANSWER_BYTES = 1_048_576
MAX_DAYS = 31
MAX_RECIPIENTS = 20
MAX_ATTACHMENTS = 50
MAX_SUBJECT = 200
MAX_NAME = 255
MAX_BOTS = 50
WINDOW_MAILS = 2048
REFRESH_SECONDS = 5.0
FULL_SWEEP_SECONDS = 600.0
QUICK_PAGE = 64
FETCH_BATCH = 100
BODY_CACHE = 200
PROTOCOL_PREFIXES = ("CARD: ", "UPDATE: ", "ANSWER: ", "COMMENT: ", "WITHDRAW: ", "CHAT: ")
META_PROPERTIES = ["id", "messageId", "inReplyTo", "references", "subject", "from", "to", "receivedAt"]
SPACE = re.compile(r"\s+")
REPLY_PREFIX = re.compile(r"^(?:(?:re|fwd?):\s*)+", re.IGNORECASE)
CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
SCHEMA = """
CREATE TABLE IF NOT EXISTS threads (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mails (
    jmap_id TEXT PRIMARY KEY,
    message_key TEXT NOT NULL,
    n INTEGER NOT NULL REFERENCES threads(n),
    k INTEGER NOT NULL,
    UNIQUE (n, k)
);
CREATE INDEX IF NOT EXISTS mails_message_key ON mails(message_key);
"""


def scrub(text: str) -> str:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    return text


def one_line(text: str) -> str:
    return SPACE.sub(" ", CONTROL.sub(" ", scrub(text))).strip()


def thread_key(subject: str) -> str:
    text = REPLY_PREFIX.sub("", SPACE.sub(" ", subject).strip())
    return SPACE.sub(" ", text).strip().casefold()


def thread_subject(subject: str) -> str:
    return one_line(subject)[:MAX_SUBJECT] or "(no subject)"


def account_name(address: Any) -> str:
    return one_line(address.partition("@")[0])[:MAX_NAME].rstrip() if isinstance(address, str) else ""


def account_names(entries: Any) -> list[str]:
    if not isinstance(entries, list):
        return []
    found = [account_name(entry.get("email")) for entry in entries if isinstance(entry, dict)]
    return [name for name in found if name]


def message_ids(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(scrub(item) for item in value if isinstance(item, str) and item)


def new_york(moment: datetime) -> datetime:
    return moment.astimezone(qd_jmap.ET)


BODY_PROPERTIES = ["id", "textBody", "bodyValues", "attachments"]
RAW_BODY_BYTES = 2 * MAX_TEXT_BYTES + 1
MAX_ATTACHMENT_NAME = 255
THREAD_REF = re.compile(r"MT-([1-9][0-9]{0,8})")
CODE = re.compile(r"(?<![A-Za-z0-9-])(AR|PG)-([1-9][0-9]{0,8})(?![A-Za-z0-9])")
SKIPPED_TAGS = frozenset({"script", "style", "head", "title", "template"})
PARAGRAPH_TAGS = frozenset({"p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table"})
LINE_TAGS = frozenset({"div", "li", "tr", "ul", "ol", "hr", "section", "article", "header", "footer", "pre"})


def encoded(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def thread_number(path: str) -> int:
    found = THREAD_REF.fullmatch(path.removeprefix(THREAD_PREFIX)) if path.startswith(THREAD_PREFIX) else None
    if found is None:
        raise cards.CardRefused("mail ref is invalid")
    return int(found.group(1))


class HtmlText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skipping = 0
        self.pending = 0
        self.space = False

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in SKIPPED_TAGS:
            self.skipping += 1
        elif tag == "br":
            self.pending = min(self.pending + 1, 2)
        elif tag in PARAGRAPH_TAGS:
            self.pending = max(self.pending, 2)
        elif tag in LINE_TAGS:
            self.pending = max(self.pending, 1)

    def handle_startendtag(self, tag: str, attrs: Any) -> None:
        if tag not in SKIPPED_TAGS:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        if tag in SKIPPED_TAGS:
            self.skipping = max(0, self.skipping - 1)
        elif tag in PARAGRAPH_TAGS:
            self.pending = max(self.pending, 2)
        elif tag in LINE_TAGS:
            self.pending = max(self.pending, 1)

    def handle_data(self, data: str) -> None:
        if self.skipping:
            return
        spaced = SPACE.sub(" ", data)
        words = spaced.strip()
        if not words:
            self.space = self.space or bool(spaced)
            return
        if self.parts:
            if self.pending:
                self.parts.append("\n" * self.pending)
            elif self.space or spaced.startswith(" "):
                self.parts.append(" ")
        self.parts.append(words)
        self.pending = 0
        self.space = spaced.endswith(" ")


def html_text(source: str) -> str:
    parser = HtmlText()
    parser.feed(source)
    parser.close()
    return "".join(parser.parts)


def plain_text(email: dict[str, Any]) -> tuple[str, bool]:
    values = email.get("bodyValues")
    values = values if isinstance(values, dict) else {}
    chunks: list[str] = []
    cut = False
    for part in email.get("textBody") or []:
        value = values.get(part.get("partId")) if isinstance(part, dict) else None
        if not isinstance(value, dict) or not isinstance(value.get("value"), str):
            continue
        cut = cut or value.get("isTruncated") is True
        chunk = value["value"]
        if str(part.get("type", "")).lower() == "text/html":
            chunk = html_text(chunk)
        chunks.append(chunk)
    text = scrub("".join(chunks)).replace("\r\n", "\n").replace("\r", "\n")
    raw = text.encode("utf-8")
    if len(raw) > MAX_TEXT_BYTES:
        return raw[:MAX_TEXT_BYTES].decode("utf-8", "ignore"), True
    return text, cut


def reference_codes(text: str) -> list[str]:
    found: dict[str, list[str]] = {"AR": [], "PG": []}
    for kind, number in CODE.findall(text):
        code = f"{kind}-{number}"
        if code not in found[kind]:
            found[kind].append(code)
    return found["AR"] + found["PG"]


def attachment_list(email: dict[str, Any]) -> list[dict[str, Any]]:
    shown: list[dict[str, Any]] = []
    for part in email.get("attachments") or []:
        if not isinstance(part, dict):
            continue
        name = part.get("name")
        size = part.get("size")
        clean = one_line(name)[:MAX_ATTACHMENT_NAME] if isinstance(name, str) else ""
        valid = isinstance(size, int) and not isinstance(size, bool) and size >= 0
        shown.append({"name": clean or "attachment", "size": size if valid else 0})
        if len(shown) == MAX_ATTACHMENTS:
            break
    return shown


@dataclass(frozen=True, slots=True)
class Meta:
    jmap_id: str
    key: str
    in_reply_to: tuple[str, ...]
    references: tuple[str, ...]
    subject: str
    sender: str
    recipients: tuple[str, ...]
    received: datetime

    @classmethod
    def parse(cls, email: Any, fallback_recipient: str) -> "Meta | None":
        if not isinstance(email, dict) or not isinstance(email.get("id"), str) or not email["id"]:
            return None
        try:
            received = datetime.fromisoformat(email["receivedAt"].replace("Z", "+00:00"))
        except (KeyError, AttributeError, ValueError):
            return None
        if received.tzinfo is None:
            return None
        own = message_ids(email.get("messageId"))
        senders = account_names(email.get("from"))
        recipients = account_names(email.get("to"))[:MAX_RECIPIENTS]
        subject = email.get("subject")
        return cls(
            email["id"],
            own[0] if own else "",
            message_ids(email.get("inReplyTo")),
            message_ids(email.get("references")),
            scrub(subject) if isinstance(subject, str) else "",
            senders[0] if senders else "unknown",
            tuple(recipients) if recipients else (fallback_recipient,),
            received.astimezone(timezone.utc),
        )


class JmapMailSource:
    def __init__(self, jmap: Any, folders: tuple[str, ...], account: str) -> None:
        self.jmap = jmap
        self.folders = folders
        self.account = account
        self._windows: dict[str, list[str]] = {}
        self._scan_windows: dict[str, list[str]] = {}
        self._scan_folder = 0
        self._scan_position = 0

    @classmethod
    def for_captain(cls, captain: Any) -> "JmapMailSource":
        mailbox = captain.mailbox
        return cls(mailbox.jmap, (mailbox.inbox_id, mailbox.sent), captain.account_name)

    def sweep(self) -> list[str]:
        while self._scan_folder < len(self.folders):
            arguments = {
                "filter": {"inMailbox": self.folders[self._scan_folder]},
                "position": self._scan_position,
                "limit": qd_jmap.PAGE,
                "sort": [{"property": "receivedAt", "isAscending": False}],
            }
            [found] = self.jmap.call(("Email/query", arguments))
            page = found.get("ids", [])
            self._scan_windows.setdefault(self.folders[self._scan_folder], []).extend(
                item for item in page if isinstance(item, str)
            )
            self._scan_position += qd_jmap.PAGE
            if len(page) < qd_jmap.PAGE or self._scan_position >= WINDOW_MAILS:
                self._scan_folder += 1
                self._scan_position = 0
        self._windows = self._scan_windows
        self._scan_windows = {}
        self._scan_folder = self._scan_position = 0
        return [item for window in self._windows.values() for item in window]

    def newest(self, count: int) -> list[str]:
        answers = self.jmap.call(
            *[
                (
                    "Email/query",
                    {
                        "filter": {"inMailbox": folder},
                        "limit": count,
                        "sort": [{"property": "receivedAt", "isAscending": False}],
                    },
                )
                for folder in self.folders
            ]
        )
        ids: list[str] = []
        for folder, answer in zip(self.folders, answers, strict=True):
            page = [item for item in answer.get("ids", []) if isinstance(item, str)]
            ids.extend(page)
            known = set(page)
            for item in self._windows.get(folder, ()):
                if len(page) >= WINDOW_MAILS:
                    break
                if item not in known:
                    page.append(item)
                    known.add(item)
            self._windows[folder] = page
        return ids

    def visible_ids(self) -> set[str]:
        return {item for window in self._windows.values() for item in window}

    def metadata(self, ids: list[str]) -> list[Meta]:
        found: list[Meta] = []
        for start in range(0, len(ids), FETCH_BATCH):
            [got] = self.jmap.call(
                ("Email/get", {"ids": ids[start : start + FETCH_BATCH], "properties": META_PROPERTIES})
            )
            for email in got.get("list", []):
                meta = Meta.parse(email, self.account)
                if meta is not None:
                    found.append(meta)
        return found

    def bodies(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        found: dict[str, dict[str, Any]] = {}
        for start in range(0, len(ids), FETCH_BATCH):
            [got] = self.jmap.call(
                (
                    "Email/get",
                    {
                        "ids": ids[start : start + FETCH_BATCH],
                        "properties": BODY_PROPERTIES,
                        "fetchTextBodyValues": True,
                        "maxBodyValueBytes": RAW_BODY_BYTES,
                    },
                )
            )
            for email in got.get("list", []):
                if isinstance(email, dict) and isinstance(email.get("id"), str):
                    found[email["id"]] = email
        return found


class ThreadTable:
    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = str(path)
        try:
            os.close(os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600))
        except OSError:
            raise RuntimeError("mail thread table is unavailable") from None
        db = self._connect()
        try:
            layout = db.execute("PRAGMA table_info(mails)").fetchall()
            if layout and (
                [column[1] for column in layout] != ["jmap_id", "message_key", "n", "k"]
                or [column[1] for column in layout if column[5]] != ["jmap_id"]
            ):
                raise RuntimeError("mail thread table layout requires a fresh state folder")
            db.executescript(SCHEMA)
        finally:
            db.close()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=5, isolation_level=None)

    def subjects(self) -> dict[int, str]:
        db = self._connect()
        try:
            return dict(db.execute("SELECT n, subject FROM threads"))
        finally:
            db.close()

    def place(self, mails: list[Meta]) -> dict[str, tuple[int, int]]:
        placed: dict[str, tuple[int, int]] = {}
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            try:
                for mail in mails:
                    placed[mail.jmap_id] = self._place_one(db, mail)
            except BaseException:
                db.execute("ROLLBACK")
                raise
            db.execute("COMMIT")
        finally:
            db.close()
        return placed

    @staticmethod
    def _place_one(db: sqlite3.Connection, mail: Meta) -> tuple[int, int]:
        row = db.execute("SELECT n, k FROM mails WHERE jmap_id = ?", (mail.jmap_id,)).fetchone()
        if row is not None:
            return row[0], row[1]
        thread = None
        for named in (*mail.in_reply_to, *reversed(mail.references)):
            found = db.execute("SELECT n FROM mails WHERE message_key = ? LIMIT 2", (named,)).fetchall()
            if len(found) == 1:
                thread = found[0][0]
                break
        if thread is None:
            key = thread_key(mail.subject)
            found = db.execute("SELECT n FROM threads WHERE key = ?", (key,)).fetchone()
            if found is None:
                thread = db.execute(
                    "INSERT INTO threads (key, subject) VALUES (?, ?)", (key, thread_subject(mail.subject))
                ).lastrowid
            else:
                thread = found[0]
        arrival = db.execute("SELECT COALESCE(MAX(k), 0) + 1 FROM mails WHERE n = ?", (thread,)).fetchone()[0]
        db.execute("INSERT INTO mails (jmap_id, message_key, n, k) VALUES (?, ?, ?, ?)", (mail.jmap_id, mail.key, thread, arrival))
        return thread, arrival


@dataclass(frozen=True, slots=True)
class Listing:
    threads: list[dict[str, Any]]
    truncated: bool

    def core(self) -> dict[str, Any]:
        return {"threads": self.threads, "truncated": self.truncated}

    def digest(self) -> str:
        text = json.dumps(self.core(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(slots=True)
class Sync:
    full: bool
    state: str | None
    ids: list[str] | None = None
    missing: list[str] = field(default_factory=list)
    found: list[Meta] = field(default_factory=list)
    cursor: int = 0


class MailService:
    def __init__(self, source: Any, table: ThreadTable, mail_state, *, clock=time.monotonic) -> None:
        self.source = source
        self.table = table
        self.mail_state = mail_state
        self.clock = clock
        self._lock = threading.Lock()
        self._mail: dict[str, Meta] = {}
        self._ignored: set[str] = set()
        self._placed: dict[str, tuple[int, int]] = {}
        self._bodies: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._state: str | None = None
        self._synced: float | None = None
        self._swept: float | None = None
        self._pending: Sync | None = None

    def _unknown(self, ids: list[str]) -> list[str]:
        known = self._mail.keys() | self._ignored
        return list(dict.fromkeys(item for item in ids if item not in known))

    def _sync(self) -> None:
        seen = self.mail_state()
        now = self.clock()
        if self._pending is None:
            full = self._swept is None or now - self._swept >= FULL_SWEEP_SECONDS
            if seen is None:
                if self._synced is not None and now - self._synced < REFRESH_SECONDS:
                    return
            elif seen == self._state and not full:
                return
            self._pending = Sync(full, seen)
        pending = self._pending
        if pending.ids is None:
            if not pending.full:
                ids = self.source.newest(QUICK_PAGE)
                pending.full = len(self._unknown(ids)) >= QUICK_PAGE
            if pending.full:
                ids = self.source.sweep()
            pending.ids = ids
            pending.missing = self._unknown(ids)
        while pending.cursor < len(pending.missing):
            batch = pending.missing[pending.cursor : pending.cursor + FETCH_BATCH]
            pending.found.extend(self.source.metadata(batch))
            pending.cursor += len(batch)
        fresh = [meta for meta in pending.found if not meta.subject.startswith(PROTOCOL_PREFIXES)]
        fresh.sort(key=lambda meta: (meta.received, meta.jmap_id))
        placed = self.table.place(fresh)
        self._placed.update(placed)
        self._ignored.update(set(pending.missing) - {meta.jmap_id for meta in fresh})
        for meta in fresh:
            self._mail[meta.jmap_id] = meta
        present = self.source.visible_ids()
        self._mail = {key: meta for key, meta in self._mail.items() if key in present}
        self._placed = {key: arrival for key, arrival in self._placed.items() if key in present}
        self._ignored &= present
        if pending.full:
            self._swept = now
        self._state = pending.state
        self._synced = now
        self._pending = None

    def _groups(self) -> dict[int, dict[int, Meta]]:
        groups: dict[int, dict[int, Meta]] = {}
        for jmap_id, meta in self._mail.items():
            thread, arrival = self._placed[jmap_id]
            groups.setdefault(thread, {})[arrival] = meta
        return groups

    @staticmethod
    def _summary(thread: int, subject: str, mails: dict[int, Meta]) -> dict[str, Any]:
        ordered = [mails[arrival] for arrival in sorted(mails)]
        bots: list[str] = []
        for meta in ordered:
            for name in (meta.sender, *meta.recipients):
                if name not in bots and len(bots) < MAX_BOTS:
                    bots.append(name)
        newest = max(meta.received for meta in ordered)
        days = sorted({new_york(meta.received).date().isoformat() for meta in ordered}, reverse=True)
        return {
            "ref": f"MT-{thread}",
            "subject": subject,
            "project": None,
            "lane": None,
            "card": None,
            "bots": bots,
            "lastAt": new_york(newest).isoformat(timespec="seconds"),
            "count": len(ordered),
            "days": days[:MAX_DAYS],
        }

    def listing(self) -> Listing:
        with self._lock:
            self._sync()
            groups = self._groups()
            subjects = self.table.subjects()
            ranked = sorted(
                groups.items(),
                key=lambda item: (max(meta.received for meta in item[1].values()), item[0]),
                reverse=True,
            )
            summaries = [self._summary(thread, subjects[thread], mails) for thread, mails in ranked[:MAX_THREADS]]
            return Listing(summaries, len(ranked) > MAX_THREADS)

    @staticmethod
    def _mail_row(number: int, arrival: int, meta: Meta, email: dict[str, Any]) -> dict[str, Any]:
        text, cut = plain_text(email)
        return {
            "ref": f"MT-{number}.{arrival}",
            "from": meta.sender,
            "to": list(meta.recipients),
            "cc": [],
            "at": new_york(meta.received).isoformat(timespec="seconds"),
            "text": text,
            "cut": cut,
            "refs": reference_codes(text),
            "attachments": attachment_list(email),
        }

    def thread(self, number: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        with self._lock:
            self._sync()
            mails = self._groups().get(number)
            if not mails:
                raise application.NotFound("no such thread")
            summary = self._summary(number, self.table.subjects()[number], mails)
            shown = sorted(mails)[-MAX_MAILS:]
            ids = [mails[arrival].jmap_id for arrival in shown]
            missing = [item for item in ids if item not in self._bodies]
            if missing:
                self._bodies.update(self.source.bodies(missing))
            bodies = {}
            for item in ids:
                if item in self._bodies:
                    self._bodies.move_to_end(item)
                    bodies[item] = self._bodies[item]
            while len(self._bodies) > BODY_CACHE:
                self._bodies.popitem(last=False)
        fields = {key: summary[key] for key in ("ref", "subject", "project", "lane", "card", "bots", "lastAt", "count")}
        rows = [
            self._mail_row(number, arrival, mails[arrival], bodies[mails[arrival].jmap_id])
            for arrival in shown
            if mails[arrival].jmap_id in bodies
        ]
        return fields, rows


class MailApi:
    def __init__(
        self,
        mailbox: Any,
        sessions: Any,
        *,
        clock,
        mail_state_path: str | os.PathLike[str],
        mail_state,
    ) -> None:
        self.sessions = sessions
        self.service = MailService(
            JmapMailSource.for_captain(mailbox),
            ThreadTable(mail_state_path),
            mail_state,
            clock=clock,
        )

    def _list(self, request: approval_app.Request, owner: object) -> approval_app.Response:
        listing = self.service.listing()
        etag = '"' + listing.digest() + '"'
        if application.etag_matches(request, etag):
            headers = (
                *approval_app.ApprovalApplication._security_headers("application/json; charset=utf-8"),
                ("ETag", etag),
                ("Content-Length", "0"),
            )
            return approval_app.Response(304, headers, b"")
        payload = {
            **listing.core(),
            "csrf": self.sessions.issue_csrf(owner),
            "freshUntil": self.sessions.fresh_until(owner),
        }
        return application.CardApplication._response(200, payload, (("ETag", etag),))

    def _thread(self, owner: object, number: int) -> approval_app.Response:
        fields, mails = self.service.thread(number)
        csrf = self.sessions.issue_csrf(owner)
        fresh_until = self.sessions.fresh_until(owner)
        shell = {"thread": {**fields, "omitted": fields["count"], "mails": []}, "csrf": csrf, "freshUntil": fresh_until}
        sizes = [len(encoded(mail)) for mail in mails]
        base = len(encoded(shell))
        while mails and base + sum(sizes) + len(mails) - 1 > MAX_ANSWER_BYTES:
            mails.pop(0)
            sizes.pop(0)
        thread = {**fields, "omitted": fields["count"] - len(mails), "mails": mails}
        return application.CardApplication._response(
            200, {"thread": thread, "csrf": csrf, "freshUntil": fresh_until}
        )

    def handle(self, request: approval_app.Request, path: str) -> approval_app.Response:
        owner = self.sessions.authenticate(request)
        if path == LIST_PATH:
            return self._list(request, owner)
        return self._thread(owner, thread_number(path))
