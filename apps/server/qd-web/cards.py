from __future__ import annotations

import hashlib
import json
import re
import threading
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo


MAX_LIST_CARDS = 200
MAX_LIST_PLAIN_MAIL = 20
KEPT_SENT = 64


class CardRefused(RuntimeError):
    pass


class ChatBotRefused(CardRefused):
    pass


class ChatTextRefused(CardRefused):
    pass


CHAT_PAGE = 15
CHAT_AFTER = 50
CHAT_FEATURES = ("quote", "read", "cursor")
QUOTE_LIMIT = 280
QUOTE_SHOWN = 4000
NAME_LIMIT = 40
UNSAFE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn", "Zs", "Zl", "Zp"})
BOT_ID = re.compile(r"[a-z][a-z0-9-]{0,31}")
PRODUCT_NAMES = {
    "stronkbot": "StronkBot",
    "quarterdeck": "Quarterdeck",
    "messdeck": "Messdeck",
}
NOTE_KEYS = frozenset({"qd", "bot", "upTo"})
LIST_NUMBER = re.compile(r"^[ \t]*\d{1,9}[.)](?=\s|$)", re.MULTILINE)


class ChatQuoteRefused(CardRefused):
    pass


class ChatReadRefused(CardRefused):
    pass


class ChatCursorRefused(CardRefused):
    pass


def printable_name(name: Any) -> bool:
    return (
        isinstance(name, str)
        and 1 <= len(name) <= NAME_LIMIT
        and all(
            character == " " or unicodedata.category(character) not in UNSAFE_CATEGORIES
            for character in name
        )
    )


def check_bot_names(names: Any) -> dict[str, str]:
    if not isinstance(names, dict) or any(
        not isinstance(identifier, str)
        or BOT_ID.fullmatch(identifier) is None
        or not printable_name(name)
        for identifier, name in names.items()
    ):
        raise ValueError("bot names are invalid")
    return dict(names)


def display_name(bot: str, names: Mapping[str, str]) -> str | None:
    name = names.get(bot)
    if name is None:
        name = " ".join(
            PRODUCT_NAMES.get(word, word.capitalize())
            for word in bot.split("-")
            if word
        )
    return name if printable_name(name) else None


def words_of(text: str) -> list[str]:
    words: list[str] = []
    start = None
    for position, character in enumerate(text):
        if unicodedata.category(character)[0] in "LN":
            if start is None:
                start = position
        elif start is not None:
            words.append(text[start:position])
            start = None
    if start is not None:
        words.append(text[start:])
    return words


def without_targets(text: str) -> str:
    parts: list[str] = []
    cursor = 0
    while True:
        found = text.find("](", cursor)
        if found < 0:
            parts.append(text[cursor:])
            return "".join(parts)
        position = found + 2
        depth = 1
        while position < len(text) and depth:
            depth += (text[position] == "(") - (text[position] == ")")
            position += 1
        parts.append(text[cursor : found + 2])
        parts.append(" ")
        cursor = position


def quote_inside(quote: str, text: str) -> bool:
    wanted = words_of(quote)
    if not wanted:
        return quote in text
    have = words_of(LIST_NUMBER.sub(" ", without_targets(text)))
    count = len(wanted)
    if count == 1:
        return any(wanted[0] in word for word in have)
    first, middle, last = wanted[0], wanted[1:-1], wanted[-1]
    return any(
        have[start].endswith(first)
        and have[start + count - 1].startswith(last)
        and have[start + 1 : start + count - 1] == middle
        for start in range(len(have) - count + 1)
    )


@dataclass(frozen=True, slots=True)
class MailMessage:
    id: str
    sender: str
    subject: str
    body: str
    sent: str
    seen: bool = True
    mail_ids: tuple[str, ...] = ()


class MailGateway(Protocol):
    def messages(self) -> list[MailMessage]: ...

    def send(
        self,
        recipient: str,
        subject: str,
        body: str,
        resend_key: str,
    ) -> str: ...

    def send_answer(self, recipient: str, subject: str, body: str, resend_key: str) -> str | None: ...

    def send_chat(self, recipient: str, subject: str, body: str, resend_key: str) -> tuple[str, bool]: ...

    def mark_seen(self, mail_ids: list[str]) -> None: ...


class CardChecker(Protocol):
    account_name: str
    oversight_bot: str
    active_bots: frozenset[str]

    def check(
        self,
        subject: str,
        body: str,
        *,
        sender: str,
        poster: str | None = None,
        base: dict[str, Any] | None = None,
        current_rev: int | None = None,
    ) -> Any: ...

    def build_answers(
        self,
        card: str,
        revision: int,
        pick: str,
        note: str,
        at: str,
        poster: str,
    ) -> tuple[
        list[tuple[str, str, str, str]],
        int,
        tuple[str, ...],
    ]: ...

    def build_comment(
        self,
        card: str,
        text: str,
    ) -> tuple[
        tuple[str, str, str] | None,
        tuple[str, ...],
    ]: ...


class CardService:
    def __init__(
        self,
        mail: MailGateway,
        checker: CardChecker,
        chat_bots: tuple[tuple[str, str | None], ...] = (),
        bot_source: Callable[[], Iterable[str]] | None = None,
        bot_names: Mapping[str, str] | None = None,
    ) -> None:
        account_name = getattr(checker, "account_name", None)
        oversight_bot = getattr(checker, "oversight_bot", None)
        active_bots = getattr(checker, "active_bots", None)
        if (
            not isinstance(account_name, str)
            or not account_name
            or not isinstance(oversight_bot, str)
            or not oversight_bot
            or not isinstance(active_bots, frozenset)
            or oversight_bot not in active_bots
            or any(
                not isinstance(bot, str) or not bot
                for bot in active_bots
            )
        ):
            raise CardRefused("card account registry is invalid")
        self.mail = mail
        self.checker = checker
        self.account_name = account_name
        self.oversight_bot = oversight_bot
        self.active_bots = active_bots
        notes = dict(chat_bots)
        if account_name in notes:
            raise CardRefused("card account registry is invalid")
        self._bot_source = bot_source
        self._bot_names = check_bot_names({} if bot_names is None else bot_names)
        self._chat_notes = {
            name: note for name, note in notes.items() if note
        }
        self._reported: set[str] = set()
        self._cards: dict[str, dict[str, Any]] = {}
        self._messages: list[MailMessage] = []
        self._base: list[MailMessage] = []
        self._kept: list[MailMessage] = []
        self._marks: dict[str, int] = {}
        self._mark_serial = 0
        self._copy_lock = threading.Lock()


    @staticmethod
    def _plain(
        message: MailMessage,
        errors: tuple[str, ...],
    ) -> dict[str, Any]:
        return {
            "id": message.id,
            "sender": message.sender,
            "subject": message.subject,
            "sent": message.sent,
            "buttons": False,
            "errors": list(errors),
        }

    def _route_refusal(
        self,
        message: MailMessage,
        kind: str,
        card_id: object,
        errors: tuple[str, ...],
    ) -> None:
        if message.id in self._reported:
            return
        label = card_id if isinstance(card_id, str) and card_id else "unknown"
        self.mail.send(
            self.oversight_bot,
            f"REFUSED {kind.upper()}: {label}",
            "; ".join(errors),
            f"refused:{message.id}",
        )
        self._reported.add(message.id)

    def refresh(self) -> dict[str, Any]:
        summaries: list[dict[str, Any]] = []
        plain_mail: list[dict[str, Any]] = []
        card_index: dict[str, dict[str, Any]] = {}
        began = self._mark_serial
        messages = self.mail.messages()
        for position, message in enumerate(messages):
            if not message.subject.startswith("CARD: "):
                continue
            result = self.checker.check(
                message.subject,
                message.body,
                sender=message.sender,
            )
            document, errors = result
            if document is None or errors:
                if getattr(result, "ownership_refused", False):
                    card_id = (
                        document.get("id") or document.get("card")
                        if document is not None
                        else None
                    )
                    self._route_refusal(
                        message,
                        "card",
                        card_id,
                        errors or ("card ownership is invalid",),
                    )
                else:
                    plain_mail.append(
                        self._plain(
                            message,
                            errors or ("card body is invalid",),
                        )
                    )
                continue
            card_id = document.get("id")
            project = document.get("project")
            lane = document.get("lane")
            title = document.get("title")
            if not all(
                isinstance(value, str) and value
                for value in (card_id, project, lane, title)
            ):
                plain_mail.append(
                    self._plain(message, ("card identity is invalid",))
                )
                continue
            summary = {
                "id": card_id,
                "title": title,
                "project": project,
                "lane": lane,
                "due": document.get("due"),
                "state": "open",
                "changed-at": message.sent,
                "from": message.sender,
                "rev": 1,
                "answer": None,
            }
            summaries.append(summary)
            card_index[card_id] = {
                "message": message,
                "document": document,
                "poster": message.sender,
                "revisions": {1: document},
                "latest_rev": 1,
                "summary": summary,
                "thread": [
                    (
                        position,
                        {
                            "id": message.id,
                            "kind": "card",
                            "sender": message.sender,
                            "sent": message.sent,
                            "document": document,
                        },
                    )
                ],
            }
        for position, message in enumerate(messages):
            if not message.subject.startswith("UPDATE: "):
                continue
            card_hint = message.subject.removeprefix("UPDATE: ")
            entry = card_index.get(card_hint)
            result = self.checker.check(
                message.subject,
                message.body,
                sender=message.sender,
                poster=entry["poster"] if entry is not None else None,
                base=entry["document"] if entry is not None else None,
                current_rev=entry["latest_rev"] if entry is not None else None,
            )
            document, errors = result
            card_id = (
                document.get("card")
                if document is not None
                else card_hint
            )
            if document is None or errors or entry is None:
                if getattr(result, "ownership_refused", False):
                    self._route_refusal(
                        message,
                        "update",
                        card_id,
                        errors or ("card ownership is invalid",),
                    )
                else:
                    plain_mail.append(
                        self._plain(
                            message,
                            errors or ("card update has no card",),
                        )
                    )
                continue
            revision = document["rev"]
            revised = getattr(result, "merged", None)
            if revised is None:
                changed = {
                    key: value
                    for key, value in document.items()
                    if key not in {"qd", "card", "rev"}
                }
                revised = {**entry["document"], **changed}
            entry["revisions"][revision] = revised
            entry["latest_rev"] = revision
            entry["document"] = revised
            entry["summary"]["title"] = revised["title"]
            entry["summary"]["due"] = revised.get("due")
            entry["summary"]["changed-at"] = message.sent
            entry["summary"]["rev"] = revision
            lane = revised.get("lane")
            if isinstance(lane, str) and lane:
                entry["summary"]["lane"] = lane
            entry["thread"].append(
                (
                    position,
                    {
                        "id": message.id,
                        "kind": "update",
                        "sender": message.sender,
                        "sent": message.sent,
                        "document": document,
                    },
                )
            )
        prefixes = {
            "COMMENT: ": "comment",
            "ANSWER: ": "answer",
            "WITHDRAW: ": "withdraw",
        }
        for position, message in enumerate(messages):
            kind = next(
                (
                    value
                    for prefix, value in prefixes.items()
                    if message.subject.startswith(prefix)
                ),
                None,
            )
            if kind is None:
                continue
            suffix = message.subject.split(": ", 1)[1]
            card_hint = suffix.split(" ", 1)[0]
            entry = card_index.get(card_hint)
            result = self.checker.check(
                message.subject,
                message.body,
                sender=message.sender,
                poster=entry["poster"] if entry is not None else None,
                base=entry["document"] if entry is not None else None,
                current_rev=entry["latest_rev"] if entry is not None else None,
            )
            document, errors = result
            card_id = (
                document.get("card")
                if document is not None
                else card_hint
            )
            if document is None or errors or entry is None:
                if getattr(result, "ownership_refused", False):
                    self._route_refusal(
                        message,
                        kind,
                        card_id,
                        errors or ("card ownership is invalid",),
                    )
                else:
                    plain_mail.append(
                        self._plain(
                            message,
                            errors or ("card thread item has no card",),
                        )
                    )
                continue
            entry["thread"].append(
                (
                    position,
                    {
                        "id": message.id,
                        "kind": kind,
                        "sender": message.sender,
                        "sent": message.sent,
                        "document": document,
                    },
                )
            )
            entry["summary"]["changed-at"] = message.sent
            if kind == "answer":
                entry["summary"]["answer"] = {
                    "pick": document["pick"],
                    "at": document["at"],
                }
                if entry["summary"]["state"] == "open":
                    entry["summary"]["state"] = "done"
            elif kind == "withdraw":
                entry["summary"]["state"] = "withdrawn"
        projects: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for summary in summaries:
            summary["waitsOn"] = (
                summary["from"] if summary["state"] == "done" else None
            )
            projects.setdefault(summary["project"], {}).setdefault(
                summary["lane"], []
            ).append(summary)
        remaining = MAX_LIST_CARDS
        shown_projects = []
        truncated = len(plain_mail) > MAX_LIST_PLAIN_MAIL
        for project, lanes in sorted(projects.items()):
            shown_lanes = []
            for lane, summaries in sorted(lanes.items()):
                ordered = sorted(
                    summaries,
                    key=lambda item: item["id"],
                )
                count = min(remaining, len(ordered))
                if count:
                    shown_lanes.append(
                        {
                            "name": lane,
                            "cards": ordered[:count],
                        }
                    )
                    remaining -= count
                if count != len(ordered):
                    truncated = True
            if shown_lanes:
                shown_projects.append(
                    {
                        "name": project,
                        "lanes": shown_lanes,
                    }
                )
        self._cards = card_index
        with self._copy_lock:
            late = {
                identifier
                for identifier, serial in self._marks.items()
                if serial > began
            }
            self._marks = {
                identifier: serial
                for identifier, serial in self._marks.items()
                if serial > began
            }
            if late:
                messages = self._marked(messages, late)
            listed = {message.id for message in messages} if self._kept else ()
            self._kept = [kept for kept in self._kept if kept.id not in listed]
            self._base = messages
            self._messages = [*messages, *self._kept] if self._kept else messages
        return {
            "projects": shown_projects,
            "plainMail": plain_mail[:MAX_LIST_PLAIN_MAIL],
            "truncated": truncated,
        }

    def card(self, card_id: str) -> dict[str, Any]:
        entry = self._cards.get(card_id)
        if entry is None:
            raise CardRefused("card does not exist")
        return {
            "card": entry["document"],
            "rev": entry["latest_rev"],
            "state": entry["summary"]["state"],
            "thread": [
                event
                for _, event in sorted(
                    entry["thread"],
                    key=lambda item: item[0],
                )
            ],
        }

    def _validate_action(
        self,
        entry: dict[str, Any],
        subject: str,
        body: str,
    ) -> None:
        result = self.checker.check(
            subject,
            body,
            sender=self.account_name,
            poster=entry["poster"],
            base=entry["document"],
            current_rev=entry["latest_rev"],
        )
        _, errors = result
        if errors:
            raise CardRefused(
                f"outbound card action refused: {'; '.join(errors)}"
            )

    def answer(
        self,
        card_id: str,
        revision: int,
        pick: str,
        note: str,
        *,
        now: datetime,
    ) -> dict[str, Any]:
        entry = self._cards.get(card_id)
        if entry is None:
            raise CardRefused("card is not open")
        document = entry["revisions"].get(revision)
        if document is None:
            raise CardRefused("card revision does not exist")
        allowed = {"cant-decide", "none"}
        for option in document.get("options", []):
            label = option.get("label") if isinstance(option, dict) else None
            if isinstance(label, str) and len(label) >= 3 and label[1:3] == ". ":
                allowed.add(label[0])
        if pick not in allowed:
            raise CardRefused("answer pick is not on this revision")
        if (
            not isinstance(note, str)
            or len(note) > 4000
            or not isinstance(now, datetime)
            or now.tzinfo is None
        ):
            raise CardRefused("answer input is invalid")
        eastern = now.astimezone(ZoneInfo("America/New_York"))
        mails, _, errors = self.checker.build_answers(
            card_id,
            revision,
            pick,
            note,
            eastern.isoformat(timespec="seconds"),
            entry["poster"],
        )
        if errors or not mails:
            raise CardRefused(
                "outbound answer refused: "
                + "; ".join(errors or ("no answer mail",))
            )
        shown = eastern
        repeated = False
        checked: set[tuple[str, str]] = set()
        position = 0
        while position < len(mails):
            recipient, subject, body, resend_key = mails[position]
            position += 1
            message = (subject, body)
            if message not in checked:
                self._validate_action(entry, subject, body)
                checked.add(message)
            kept = self.mail.send_answer(
                recipient,
                subject,
                body,
                resend_key,
            )
            if kept is None:
                continue
            moment = self._kept_time(kept)
            if not repeated:
                repeated = True
                shown = moment
                mails[position:] = self._rebuilt(
                    entry,
                    (card_id, revision, pick, note),
                    kept,
                    mails[position:],
                )
            elif moment < shown:
                shown = moment
        display_pick = {
            "cant-decide": "Can't decide",
            "none": "None of these",
        }.get(pick, pick)
        return {
            "message": (
                f"Got it: {card_id} {display_pick} at "
                f"{shown.astimezone(eastern.tzinfo).strftime('%-I:%M %p')} ET"
            ),
            "stale": revision < entry["latest_rev"],
            "rev": revision,
        }

    @staticmethod
    def _kept_time(text: str) -> datetime:
        moment = datetime.fromisoformat(text)
        if moment.tzinfo is None:
            raise CardRefused("answer time is invalid")
        return moment

    def _rebuilt(
        self,
        entry: dict[str, Any],
        answer: tuple[str, int, str, str],
        at: str,
        rest: list[tuple[str, str, str, str]],
    ) -> list[tuple[str, str, str, str]]:
        if not rest:
            return rest
        mails, _, errors = self.checker.build_answers(*answer, at, entry["poster"])
        wanted = [mail[0] for mail in rest]
        again = [mail for mail in mails if mail[0] in wanted]
        if errors or [mail[0] for mail in again] != wanted:
            raise CardRefused(
                "outbound answer refused: "
                + "; ".join(errors or ("answer recipients changed",))
            )
        return again

    @staticmethod
    def _request(request_id: str) -> str:
        if (
            not isinstance(request_id, str)
            or re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id) is None
        ):
            raise CardRefused("request id is invalid")
        return request_id

    def comment(
        self,
        card_id: str,
        text: str,
        request_id: str,
    ) -> None:
        entry = self._cards.get(card_id)
        if (
            entry is None
            or not isinstance(text, str)
            or not 1 <= len(text) <= 4000
        ):
            raise CardRefused("comment is invalid")
        self._request(request_id)
        built, errors = self.checker.build_comment(card_id, text)
        if errors or built is None:
            raise CardRefused(
                "outbound comment refused: "
                + "; ".join(errors or ("no comment mail",))
            )
        subject, body, resend_key = built
        self._validate_action(entry, subject, body)
        recipients = [entry["poster"]]
        if entry["poster"] != self.oversight_bot:
            recipients.append(self.oversight_bot)
        for recipient in recipients:
            self.mail.send(
                recipient,
                subject,
                body,
                f"{resend_key}:to-{recipient}",
            )

    def _chat_set(self) -> frozenset[str]:
        joined = (
            frozenset()
            if self._bot_source is None
            else frozenset(self._bot_source())
        )
        return (joined | {self.oversight_bot}) - {self.account_name}

    @staticmethod
    def _chat_bot(bot: str, allowed: frozenset[str]) -> str:
        if (
            not isinstance(bot, str)
            or bot not in allowed
        ):
            raise ChatBotRefused("chat bot is not registered")
        return bot

    def _chat_parse(
        self,
        message: MailMessage,
        bot: str,
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        if (
            message.subject != f"CHAT: {bot}"
            or message.sender not in {bot, self.account_name}
        ):
            return None
        try:
            document = json.loads(message.body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(document, dict):
            return None
        client_id = document.get("clientId")
        if (
            document.get("qd") != "chat/1"
            or document.get("bot") != bot
            or not isinstance(document.get("text"), str)
            or (
                client_id is not None
                and (
                    not isinstance(client_id, str)
                    or re.fullmatch(
                        r"[A-Za-z0-9_-]{1,80}",
                        client_id,
                    )
                    is None
                )
            )
        ):
            return None
        event = {
            "id": message.id,
            "from": (
                "account"
                if message.sender == self.account_name
                else "bot"
            ),
            "text": document["text"],
            "at": message.sent,
        }
        if client_id is not None:
            event["clientId"] = client_id
        if message.sender == self.account_name and isinstance(document.get("fresh"), bool):
            event["fresh"] = document["fresh"]
        return event, document

    def _chat_event(
        self,
        message: MailMessage,
        bot: str,
    ) -> dict[str, Any] | None:
        parsed = self._chat_parse(message, bot)
        return None if parsed is None else parsed[0]

    def _chat_info(self, bot: str) -> dict[str, str]:
        info = {"id": bot}
        note = self._chat_notes.get(bot)
        if note:
            info["note"] = note
        return info

    def chat(self, bot: str) -> dict[str, Any]:
        bot = self._chat_bot(bot, self._chat_set())
        messages = [
            event
            for message in self._messages
            if (event := self._chat_event(message, bot)) is not None
        ]
        return {
            "bot": self._chat_info(bot),
            "messages": messages,
            "seenUpTo": None,
            "writing": False,
        }

    @staticmethod
    def _chat_mails(messages: list[MailMessage], bot: str) -> list[MailMessage]:
        subject = f"CHAT: {bot}"
        return [message for message in messages if message.subject == subject]

    @staticmethod
    def _chat_note(message: MailMessage, bot: str) -> str | None:
        if message.sender != bot:
            return None
        try:
            document = json.loads(message.body)
        except (ValueError, RecursionError):
            return None
        if (
            not isinstance(document, dict)
            or set(document) != NOTE_KEYS
            or document["qd"] != "chat-seen/1"
            or document["bot"] != bot
            or not isinstance(document["upTo"], str)
        ):
            return None
        return document["upTo"]

    def _chat_view(self, bot: str, mails: list[MailMessage]) -> dict[str, Any]:
        entries: list[tuple[MailMessage, dict[str, Any], dict[str, Any]]] = []
        pending: list[tuple[int, MailMessage, str]] = []
        for message in mails:
            parsed = self._chat_parse(message, bot)
            if parsed is not None:
                entries.append((message, *parsed))
                continue
            target = self._chat_note(message, bot)
            if target is not None:
                pending.append((len(entries), message, target))
        events = [event for _, event, _ in entries]
        index = {event["id"]: number for number, event in enumerate(events)}
        mine = [number for number, event in enumerate(events) if event["from"] == "account"]
        theirs = [number for number, event in enumerate(events) if event["from"] == "bot"]
        notes = [
            (position, message, index[target])
            for position, message, target in pending
            if target in index and events[index[target]]["from"] == "account"
        ]
        reached = notes[-1][2] if notes else None
        replied = (
            max((number for number in mine if number < theirs[-1]), default=None)
            if theirs
            else None
        )
        seen = max(
            (value for value in (reached, replied) if value is not None),
            default=None,
        )
        seen_at = None
        if seen is not None:
            by_note = next(
                (
                    (position, message.sent)
                    for position, message, target in notes
                    if target >= seen
                ),
                None,
            )
            by_bot = next((number for number in theirs if number > seen), None)
            if by_note is not None and (by_bot is None or by_note[0] <= by_bot):
                seen_at = by_note[1]
            elif by_bot is not None:
                seen_at = events[by_bot]["at"]
        counted = entries[mine[-1] + 1 if mine else 0:]
        first_unread = next(
            (event["id"] for message, event, _ in counted if not message.seen),
            None,
        )
        seen_up_to = events[seen]["id"] if seen is not None else None
        digest = hashlib.sha256(
            json.dumps(
                [
                    events[-1]["id"] if events else "",
                    seen_up_to,
                    seen_at,
                    first_unread,
                    first_unread is not None,
                    None,
                ],
                separators=(",", ":"),
            ).encode("ascii")
        ).hexdigest()
        return {
            "entries": entries,
            "events": events,
            "index": index,
            "notes": notes,
            "seenUpTo": seen_up_to,
            "seenAt": seen_at,
            "firstUnread": first_unread,
            "unread": first_unread is not None,
            "rev": int(digest[:13], 16),
        }

    def _bot_object(self, bot: str) -> dict[str, str]:
        info = {"id": bot}
        name = display_name(bot, self._bot_names)
        if name is not None:
            info["name"] = name
        note = self._chat_notes.get(bot)
        if note:
            info["note"] = note
        return info

    def chat_list(self) -> list[dict[str, Any]]:
        allowed = self._chat_set()
        groups: dict[str, list[MailMessage]] = {}
        for message in self._messages:
            if message.subject.startswith("CHAT: "):
                bot = message.subject.removeprefix("CHAT: ")
                if bot in allowed:
                    groups.setdefault(bot, []).append(message)
        rows = []
        for bot in sorted(allowed):
            view = self._chat_view(bot, groups.get(bot, []))
            latest = view["events"][-1] if view["events"] else None
            rows.append(
                {
                    "id": bot,
                    "preview": latest["text"][:160] if latest is not None else "",
                    "at": latest["at"] if latest is not None else "",
                    "last": latest["id"] if latest is not None else "",
                    "unread": view["unread"],
                    "rev": view["rev"],
                }
            )
        rows.sort(key=lambda row: row["at"], reverse=True)
        return rows

    def chat_rows(self) -> list[dict[str, Any]]:
        return [
            {
                "bot": self._bot_object(row["id"]),
                "preview": row["preview"],
                "at": row["at"],
                "last": row["last"],
                "unread": row["unread"],
                "rev": row["rev"],
            }
            for row in self.chat_list()
        ]

    @staticmethod
    def _chat_message(event: dict[str, Any]) -> dict[str, Any]:
        message = {
            "id": event["id"],
            "from": "captain" if event["from"] == "account" else "bot",
            "text": event["text"],
            "at": event["at"],
            "refs": [],
        }
        if "clientId" in event:
            message["clientId"] = event["clientId"]
        return message

    def _quote_resolve(
        self,
        quote: Any,
        events: list[dict[str, Any]],
        index: dict[str, int],
        limit: int,
    ) -> tuple[str, dict[str, Any] | None] | None:
        if not isinstance(quote, dict):
            return None
        keys = set(quote)
        if keys == {"id", "text"}:
            target, text = quote["id"], quote["text"]
            if (
                not isinstance(target, str)
                or target not in index
                or not isinstance(text, str)
                or not 1 <= len(text) <= limit
                or not text.strip()
                or not quote_inside(text, events[index[target]]["text"])
            ):
                return None
            return "message", events[index[target]]
        if keys == {"cardId", "version"}:
            card, version = quote["cardId"], quote["version"]
            entry = self._cards.get(card) if isinstance(card, str) else None
            if (
                entry is None
                or type(version) is not int
                or not 1 <= version <= entry["latest_rev"]
            ):
                return None
            return "card", None
        return None

    def _quote_shown(
        self,
        quote: Any,
        events: list[dict[str, Any]],
        index: dict[str, int],
    ) -> dict[str, Any] | None:
        resolved = self._quote_resolve(quote, events, index, QUOTE_SHOWN)
        if resolved is None:
            return None
        kind, target = resolved
        if kind == "card":
            return {"cardId": quote["cardId"], "version": quote["version"]}
        return {
            "id": target["id"],
            "from": "captain" if target["from"] == "account" else "bot",
            "at": target["at"],
            "text": quote["text"],
        }

    def chat_thread(
        self,
        bot: str,
        before: str | None = None,
        after: str | None = None,
    ) -> dict[str, Any]:
        bot = self._chat_bot(bot, self._chat_set())
        if before is not None and after is not None:
            raise CardRefused("chat cursor is invalid")
        view = self._chat_view(bot, self._chat_mails(self._messages, bot))
        events, index = view["events"], view["index"]
        end = len(events)
        start = max(0, end - CHAT_PAGE)
        if before is not None:
            if before not in index:
                raise CardRefused("chat cursor is invalid")
            end = index[before]
            start = max(0, end - CHAT_PAGE)
        elif after is not None:
            if after not in index or end - index[after] - 1 > CHAT_AFTER:
                raise ChatCursorRefused("chat cursor is stale")
            start = index[after] + 1
        shown = []
        for _, event, document in view["entries"][start:end]:
            message = self._chat_message(event)
            message["quote"] = self._quote_shown(document.get("quote"), events, index)
            message["files"] = []
            shown.append(message)
        return {
            "bot": self._bot_object(bot),
            "rev": view["rev"],
            "features": list(CHAT_FEATURES),
            "messages": shown,
            "seenUpTo": view["seenUpTo"],
            "seenAt": view["seenAt"],
            "working": None,
            "firstUnread": view["firstUnread"],
            "older": start > 0,
        }

    def chat_sent(self, bot: str, message_id: str) -> dict[str, Any] | None:
        for message in self._messages:
            if message.id == message_id:
                event = self._chat_event(message, bot)
                return None if event is None else self._chat_message(event)
        return None

    def check_chat_send(
        self,
        bot: str,
        text: str,
        request_id: str,
    ) -> tuple[str, str]:
        bot = self._chat_bot(bot, self._chat_set())
        if not isinstance(text, str) or not 1 <= len(text) <= 4000:
            raise ChatTextRefused("chat text is invalid")
        return bot, self._request(request_id)

    def check_chat_quote(self, bot: str, quote: Any) -> Any:
        view = self._chat_view(bot, self._chat_mails(self._messages, bot))
        if self._quote_resolve(quote, view["events"], view["index"], QUOTE_LIMIT) is None:
            raise ChatQuoteRefused("chat quote is invalid")
        return quote

    def _read_targets(self, bot: str, up_to: Any) -> tuple[str, list[MailMessage]]:
        bot = self._chat_bot(bot, self._chat_set())
        view = self._chat_view(bot, self._chat_mails(self._messages, bot))
        target = view["index"].get(up_to) if isinstance(up_to, str) else None
        if target is None or view["events"][target]["from"] != "bot":
            raise ChatReadRefused("chat read target is invalid")
        ordered = [
            (number * 2 + 1, message)
            for number, (message, event, _) in enumerate(view["entries"][: target + 1])
            if event["from"] == "bot"
        ]
        ordered += [
            (position * 2, message)
            for position, message, _ in view["notes"]
            if position <= target
        ]
        ordered.sort(key=lambda item: item[0])
        return bot, [message for _, message in ordered if not message.seen]

    def check_chat_read(self, bot: str, up_to: Any) -> tuple[str, str]:
        bot, _ = self._read_targets(bot, up_to)
        return bot, up_to

    @staticmethod
    def _marked(messages: list[MailMessage], wanted: set[str]) -> list[MailMessage]:
        return [
            replace(message, seen=True) if message.id in wanted else message
            for message in messages
        ]

    def mark_chat_read(self, bot: str, up_to: Any) -> None:
        _, rows = self._read_targets(bot, up_to)
        if not rows:
            return
        if not all(row.mail_ids for row in rows):
            raise RuntimeError("a row to mark has no mail id")
        self.mail.mark_seen([identifier for row in rows for identifier in row.mail_ids])
        ids = [row.id for row in rows]
        wanted = set(ids)
        with self._copy_lock:
            self._mark_serial += 1
            for identifier in ids:
                self._marks[identifier] = self._mark_serial
            self._base = self._marked(self._base, wanted)
            self._kept = self._marked(self._kept, wanted)
            self._messages = [*self._base, *self._kept]

    @staticmethod
    def _chat_body(
        bot: str,
        text: str,
        request_id: str,
        fresh: bool,
        quote: Any = None,
    ) -> str:
        document = {
            "qd": "chat/1",
            "bot": bot,
            "text": text,
            "clientId": request_id,
            "fresh": fresh,
        }
        if quote is not None:
            document["quote"] = quote
        return json.dumps(document, separators=(",", ":"), ensure_ascii=False)

    def keep_sent(
        self,
        message_id: str,
        bot: str,
        text: str,
        request_id: str,
        fresh: bool,
        at: str,
        quote: Any = None,
    ) -> None:
        message = MailMessage(
            message_id,
            self.account_name,
            f"CHAT: {bot}",
            self._chat_body(bot, text, request_id, fresh, quote),
            at,
        )
        with self._copy_lock:
            if any(known.id == message_id for known in self._messages):
                return
            self._kept = [*self._kept, message][-KEPT_SENT:]
            self._messages = [*self._base, *self._kept]

    def send_chat(
        self,
        bot: str,
        text: str,
        request_id: str,
        *, fresh: bool = False,
        quote: Any = None,
    ) -> tuple[str, bool]:
        bot, request_id = self.check_chat_send(bot, text, request_id)
        if not isinstance(fresh, bool):
            raise CardRefused("chat freshness is invalid")
        return self.mail.send_chat(
            bot,
            f"CHAT: {bot}",
            self._chat_body(bot, text, request_id, fresh, quote),
            f"chat:{bot}:{request_id}",
        )
