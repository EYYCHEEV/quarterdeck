from __future__ import annotations

import contextlib
import itertools
import json
import threading
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from datetime import datetime
from typing import Any

import qd_jmap

import cards
import mailstate
import security

SEND_WAIT_SECONDS = 8.0
SEND_WAITING = 4
SEND_KEPT = 1


class SendBusy(OSError):
    pass


class SendLine:
    def __init__(self, waiting: int, kept: int = SEND_KEPT) -> None:
        self._condition = threading.Condition()
        self._active = False
        self._limit = waiting
        self._kept = kept
        self._tickets = itertools.count()
        self._queues: dict[bool, deque[int]] = {True: deque(), False: deque()}

    def _head(self) -> int | None:
        for chat in (True, False):
            if self._queues[chat]:
                return self._queues[chat][0]
        return None

    def take(self, window: mailstate.Window, chat: bool = False) -> None:
        with self._condition:
            waiting = len(self._queues[True]) + len(self._queues[False])
            if not self._active and not waiting:
                if window.left() <= 0.0:
                    raise SendBusy("the send waited for its whole time")
                self._active = True
                return
            if waiting >= self._limit - (0 if chat else self._kept):
                raise SendBusy("too many sends are waiting")
            ticket = next(self._tickets)
            queue = self._queues[chat]
            queue.append(ticket)
            try:
                while self._active or self._head() != ticket:
                    left = window.left()
                    if left <= 0.0:
                        raise SendBusy("the send waited for its whole time")
                    self._condition.wait(left)
                if window.left() <= 0.0:
                    raise SendBusy("the send waited for its whole time")
            except BaseException:
                queue.remove(ticket)
                self._condition.notify_all()
                raise
            queue.popleft()
            self._active = True

    def release(self) -> None:
        with self._condition:
            self._active = False
            self._condition.notify_all()


_SEND_LINE = SendLine(SEND_WAITING)


@contextlib.contextmanager
def _own_window(seconds: float) -> Iterator[mailstate.Window]:
    yield mailstate.Window(time.monotonic, seconds)


PROPERTIES = [
    "id",
    "messageId",
    "from",
    "to",
    "subject",
    "receivedAt",
    "textBody",
    "bodyValues",
    "keywords",
]
MARK_PER_CALL = 16
MARK_CALLS = 8
ANSWER_FIELDS = frozenset({"qd", "card", "rev", "pick", "note", "at"})
ANSWER_SAME = ("qd", "card", "rev", "pick", "note")


class CaptainMailbox:
    def __init__(
        self,
        mailbox: Any,
        credential: Any,
        *,
        account_name: str,
        oversight_bot: str,
        incremental: bool = False,
        patient: Any = None,
    ) -> None:
        if (
            not isinstance(account_name, str)
            or not account_name
            or not isinstance(oversight_bot, str)
            or not oversight_bot
            or account_name == oversight_bot
            or getattr(mailbox, "bot", None) != account_name
        ):
            credential.clear()
            raise security.SecurityRefused(
                "Configured account does not own this mailbox"
            )
        self.mailbox = mailbox
        self.credential = credential
        self.account_name = account_name
        self.oversight_bot = oversight_bot
        self._closed = False
        self._patient = patient if patient is not None else _own_window
        self._incremental = incremental
        self._hint: str | None = None
        self._state: str | None = None
        self._inbox: dict[str, dict[str, Any]] = {}
        self._sent: dict[str, dict[str, Any]] = {}
        self._inbox_ids: frozenset[str] = frozenset()

    @classmethod
    def open(
        cls,
        session_url: str,
        key_path: str,
        readback: dict[str, Any],
        *,
        account_name: str,
        oversight_bot: str,
        transport=None,
        incremental: bool = False,
        patient: Any = None,
    ) -> "CaptainMailbox":
        security.verify_key_readback(readback, account_name)
        credential = security.SecretKey.load(key_path)
        try:
            jmap = qd_jmap.Jmap(
                session_url,
                credential,
                transport or qd_jmap.HttpTransport(),
            )
            return cls(
                qd_jmap.Mailbox(jmap),
                credential,
                account_name=account_name,
                oversight_bot=oversight_bot,
                incremental=incremental,
                patient=patient,
            )
        except Exception:
            credential.clear()
            raise

    def _sent_messages(self) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        position = 0
        while True:
            [found] = self.mailbox.jmap.call(
                (
                    "Email/query",
                    {
                        "filter": {"inMailbox": self.mailbox.sent},
                        "position": position,
                        "limit": qd_jmap.PAGE,
                        "sort": [
                            {
                                "property": "receivedAt",
                                "isAscending": True,
                            }
                        ],
                    },
                )
            )
            ids = found.get("ids", [])
            if ids:
                [got] = self.mailbox.jmap.call(
                    (
                        "Email/get",
                        {
                            "ids": ids,
                            "properties": PROPERTIES,
                            "fetchTextBodyValues": True,
                        },
                    )
                )
                by_id = {
                    message["id"]: message
                    for message in got.get("list", [])
                }
                messages.extend(
                    by_id[email_id]
                    for email_id in ids
                    if email_id in by_id
                )
            if len(ids) < qd_jmap.PAGE:
                return messages
            position += len(ids)

    @staticmethod
    def _body(message: dict[str, Any]) -> str:
        return qd_jmap.normal_body(
            "".join(
                message.get("bodyValues", {})
                .get(part.get("partId"), {})
                .get("value", "")
                for part in message.get("textBody", [])
                if isinstance(part, dict)
            )
        )

    @staticmethod
    def _recipient(message: dict[str, Any]) -> str:
        return (
            (message.get("to") or [{}])[0]
            .get("email", "")
            .partition("@")[0]
        )

    def _without_oversight_copies(
        self,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for message in messages:
            grouped[
                (message.get("subject", ""), self._body(message))
            ].append(message)
        result = []
        for group in grouped.values():
            direct = [
                message
                for message in group
                if self._recipient(message) != self.oversight_bot
            ]
            result.extend(direct or group)
        return result

    def note_state(self, state: str | None) -> None:
        self._hint = state

    def _changed(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        [changes] = self.mailbox.jmap.call(
            ("Email/changes", {"sinceState": self._state})
        )
        new_state = changes["newState"]
        ids = [*changes.get("created", []), *changes.get("updated", [])]
        if (
            changes.get("hasMoreChanges")
            or not isinstance(new_state, str)
            or len(ids) > qd_jmap.PAGE
        ):
            raise RuntimeError("the changes cannot be used")
        fetched: dict[str, dict[str, Any]] = {}
        if ids:
            [got] = self.mailbox.jmap.call(
                (
                    "Email/get",
                    {
                        "ids": ids,
                        "properties": [*PROPERTIES, "mailboxIds"],
                        "fetchTextBodyValues": True,
                    },
                )
            )
            fetched = {message["id"]: message for message in got.get("list", [])}
        for identifier in changes.get("destroyed", []):
            self._inbox.pop(identifier, None)
            self._sent.pop(identifier, None)
        for identifier in ids:
            folders = fetched.get(identifier, {}).get("mailboxIds", {})
            for table, folder in (
                (self._inbox, self.mailbox.inbox_id),
                (self._sent, self.mailbox.sent),
            ):
                if folders.get(folder):
                    table[identifier] = fetched[identifier]
                else:
                    table.pop(identifier, None)
        self._state = new_state
        return list(self._inbox.values()), list(self._sent.values())

    def _read(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        hint, self._hint = self._hint, None
        if self._incremental and self._state is not None:
            try:
                return self._changed()
            except Exception:
                self._state = None
        inbox = self.mailbox.inbox(False, PROPERTIES)
        sent = self._sent_messages()
        if self._incremental:
            self._state = hint
            self._inbox = {message["id"]: message for message in inbox}
            self._sent = {message["id"]: message for message in sent}
        return inbox, sent

    def _row(self, message: dict[str, Any]) -> tuple[str, str, str, str] | None:
        sender = (
            (message.get("from") or [{}])[0]
            .get("email", "")
            .partition("@")[0]
        )
        try:
            sent_at = datetime.fromisoformat(
                message["receivedAt"].replace("Z", "+00:00")
            ).astimezone(qd_jmap.ET).isoformat(timespec="seconds")
        except (KeyError, TypeError, ValueError):
            return None
        return sender, message.get("subject", ""), self._body(message), sent_at

    def messages(self) -> list[cards.MailMessage]:
        inbox, listed = self._read()
        sent = self._without_oversight_copies(listed)
        ordered = sorted(
            [*((message, True) for message in inbox), *((message, False) for message in sent)],
            key=lambda value: value[0].get("receivedAt", ""),
        )
        rows = [
            (message, from_inbox, qd_jmap.first_id(message), self._row(message))
            for message, from_inbox in ordered
        ]
        copies: dict[tuple[str, tuple[str, str, str, str]], list[str]] = {}
        for message, from_inbox, message_id, row in rows:
            if (
                from_inbox
                and row is not None
                and isinstance(message_id, str)
                and isinstance(message.get("id"), str)
            ):
                copies.setdefault((message_id, row), []).append(message["id"])
        result = []
        seen: set[str] = set()
        for message, _, message_id, row in rows:
            if not isinstance(message_id, str) or message_id in seen:
                continue
            seen.add(message_id)
            if row is None:
                continue
            keywords = message.get("keywords")
            result.append(
                cards.MailMessage(
                    message_id,
                    *row,
                    isinstance(keywords, dict) and keywords.get("$seen") is True,
                    tuple(copies.get((message_id, row), ())),
                )
            )
        self._inbox_ids = frozenset(
            message["id"] for message in inbox if isinstance(message.get("id"), str)
        )
        return result

    def mark_seen(self, mail_ids: list[str]) -> None:
        if self._closed:
            raise security.SecurityRefused("Captain mailbox is closed")
        email_ids = list(dict.fromkeys(mail_ids))
        if any(email_id not in self._inbox_ids for email_id in email_ids):
            raise qd_jmap.MailFailed("the mail to mark is not in the inbox")
        calls = [
            (
                "Email/set",
                {
                    "update": {
                        email_id: {"keywords/$seen": True}
                        for email_id in email_ids[start : start + MARK_PER_CALL]
                    }
                },
            )
            for start in range(0, len(email_ids), MARK_PER_CALL)
        ]
        for start in range(0, len(calls), MARK_CALLS):
            replies = self.mailbox.jmap.call(*calls[start : start + MARK_CALLS])
            for reply, (_, sent_arguments) in zip(replies, calls[start : start + MARK_CALLS]):
                updated = reply.get("updated")
                if reply.get("notUpdated") or not isinstance(updated, dict) or set(updated) != set(sent_arguments["update"]):
                    raise qd_jmap.MailFailed("the mail was not marked read")

    def send(
        self,
        recipient: str,
        subject: str,
        body: str,
        resend_key: str,
    ) -> str:
        return self._send(recipient, subject, body, resend_key, False)

    def send_answer(self, recipient: str, subject: str, body: str, resend_key: str) -> str | None:
        try:
            self.send(recipient, subject, body, resend_key)
        except qd_jmap.Refused:
            kept = self._kept_body(recipient, subject, resend_key)
            first = None if kept is None else self._first_answer_time(kept[1], body)
            if first is None:
                raise
            return first
        return None

    def _send(
        self,
        recipient: str,
        subject: str,
        body: str,
        resend_key: str,
        chat: bool,
    ) -> str:
        if self._closed:
            raise security.SecurityRefused("Captain mailbox is closed")
        with self._patient(SEND_WAIT_SECONDS) as window:
            _SEND_LINE.take(window, chat)
            try:
                return self.mailbox.send(
                    recipient,
                    subject,
                    body,
                    resend_key,
                )
            finally:
                _SEND_LINE.release()

    def send_chat(self, recipient: str, subject: str, body: str, resend_key: str) -> tuple[str, bool]:
        wanted = json.loads(body)
        fields = {"qd", "bot", "text", "clientId"}
        if isinstance(wanted, dict) and "quote" in wanted:
            fields = fields | {"quote"}
        if (
            not isinstance(wanted, dict) or set(wanted) != fields | {"fresh"}
            or wanted["qd"] != "chat/1" or wanted["bot"] != recipient
            or subject != f"CHAT: {recipient}" or not isinstance(wanted["fresh"], bool)
            or ("quote" in fields and not isinstance(wanted["quote"], dict))
        ):
            raise security.SecurityRefused("Captain chat envelope is invalid")
        try:
            return self._send(recipient, subject, body, resend_key, True), wanted["fresh"]
        except qd_jmap.Refused:
            kept = self._kept_body(recipient, subject, resend_key)
            if kept is None:
                raise
            message_id, text = kept
            try:
                document = json.loads(text)
            except (ValueError, TypeError):
                raise security.SecurityRefused("Captain chat resend is invalid") from None
            if (
                not isinstance(document, dict) or set(document) not in (fields, fields | {"fresh"})
                or not isinstance(document.get("fresh", False), bool)
                or any(document.get(field) != wanted[field] for field in fields)
            ):
                raise
            return message_id, document.get("fresh", False)

    def _kept_body(self, recipient: str, subject: str, resend_key: str) -> tuple[str, str] | None:
        message_id = qd_jmap.message_id(self.mailbox.bot, resend_key, self.mailbox.domain)
        kept = self.mailbox.sent_copy(message_id)
        if not kept:
            return None
        [reply] = self.mailbox.jmap.call(("Email/get", {"ids": kept[:1], "properties": PROPERTIES, "fetchTextBodyValues": True}))
        rows = reply.get("list", [])
        if len(rows) != 1:
            return None
        original = rows[0]
        sender = (original.get("from") or [{}])[0].get("email", "").partition("@")[0]
        if (
            sender != self.account_name or self._recipient(original) != recipient
            or original.get("subject") != subject or qd_jmap.first_id(original) != message_id
        ):
            return None
        return message_id, self._body(original)

    @staticmethod
    def _first_answer_time(kept: str, wanted: str) -> str | None:
        try:
            before, now = json.loads(kept), json.loads(wanted)
        except (ValueError, TypeError):
            return None
        if not isinstance(before, dict) or not isinstance(now, dict):
            return None
        if set(before) != ANSWER_FIELDS or set(now) != ANSWER_FIELDS:
            return None
        if any(json.dumps(before[field], sort_keys=True) != json.dumps(now[field], sort_keys=True) for field in ANSWER_SAME):
            return None
        first = before["at"]
        if not isinstance(first, str):
            return None
        try:
            zone = datetime.fromisoformat(first).tzinfo
        except ValueError:
            return None
        return first if zone is not None else None

    def close(self) -> None:
        if self._closed:
            return
        self.credential.clear()
        self._closed = True
