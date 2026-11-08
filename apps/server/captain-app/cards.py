from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo


MAX_LIST_CARDS = 200
MAX_LIST_PLAIN_MAIL = 20


class CardRefused(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class MailMessage:
    id: str
    sender: str
    subject: str
    body: str
    sent: str


class MailGateway(Protocol):
    def messages(self) -> list[MailMessage]: ...

    def send(
        self,
        recipient: str,
        subject: str,
        body: str,
        resend_key: str,
    ) -> str: ...

    def send_chat(self, recipient: str, subject: str, body: str, resend_key: str) -> tuple[str, bool]: ...


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
        self._chat_notes = {
            name: note for name, note in notes.items() if note
        }
        self._reported: set[str] = set()
        self._cards: dict[str, dict[str, Any]] = {}
        self._messages: list[MailMessage] = []


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
        projects: dict[str, dict[str, list[dict[str, Any]]]] = {}
        plain_mail: list[dict[str, Any]] = []
        card_index: dict[str, dict[str, Any]] = {}
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
            }
            projects.setdefault(project, {}).setdefault(lane, []).append(
                summary
            )
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
                entry["summary"]["state"] = "done"
            elif kind == "withdraw":
                entry["summary"]["state"] = "withdrawn"
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
        self._messages = messages
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
        checked: set[tuple[str, str]] = set()
        for recipient, subject, body, resend_key in mails:
            message = (subject, body)
            if message not in checked:
                self._validate_action(entry, subject, body)
                checked.add(message)
            self.mail.send(
                recipient,
                subject,
                body,
                resend_key,
            )
        display_pick = {
            "cant-decide": "Can't decide",
            "none": "None of these",
        }.get(pick, pick)
        return {
            "message": (
                f"Got it: {card_id} {display_pick} at "
                f"{eastern.strftime('%-I:%M %p')} ET"
            ),
            "stale": revision < entry["latest_rev"],
            "rev": revision,
        }

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
            raise CardRefused("chat bot is not registered")
        return bot

    def _chat_event(
        self,
        message: MailMessage,
        bot: str,
    ) -> dict[str, Any] | None:
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
        return event

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

    def chat_list(self) -> list[dict[str, Any]]:
        allowed = self._chat_set()
        latest_by_bot: dict[str, dict[str, Any]] = {}
        for message in self._messages:
            if not message.subject.startswith("CHAT: "):
                continue
            bot = message.subject.removeprefix("CHAT: ")
            if bot not in allowed:
                continue
            event = self._chat_event(message, bot)
            if event is not None:
                latest_by_bot[bot] = event
        rows = []
        for bot in sorted(allowed):
            latest = latest_by_bot.get(bot)
            rows.append(
                {
                    "id": bot,
                    "preview": (
                        latest["text"][:160]
                        if latest is not None
                        else ""
                    ),
                    "at": (
                        latest["at"]
                        if latest is not None
                        else ""
                    ),
                    "last": (
                        latest["id"]
                        if latest is not None
                        else ""
                    ),
                    "unread": False,
                }
            )
        rows.sort(key=lambda row: row["at"], reverse=True)
        return rows

    def send_chat(
        self,
        bot: str,
        text: str,
        request_id: str,
        *, fresh: bool = False,
    ) -> tuple[str, bool]:
        bot = self._chat_bot(bot, self._chat_set())
        request_id = self._request(request_id)
        if not isinstance(text, str) or not 1 <= len(text) <= 4000:
            raise CardRefused("chat text is invalid")
        if not isinstance(fresh, bool):
            raise CardRefused("chat freshness is invalid")
        body = json.dumps(
            {
                "qd": "chat/1",
                "bot": bot,
                "text": text,
                "clientId": request_id,
                "fresh": fresh,
            },
            separators=(",", ":"),
            ensure_ascii=False,
        )
        return self.mail.send_chat(
            bot,
            f"CHAT: {bot}",
            body,
            f"chat:{bot}:{request_id}",
        )
