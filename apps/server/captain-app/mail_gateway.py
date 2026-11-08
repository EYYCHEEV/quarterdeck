from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from typing import Any

import qd_jmap

import cards
import security


PROPERTIES = [
    "id",
    "messageId",
    "from",
    "to",
    "subject",
    "receivedAt",
    "textBody",
    "bodyValues",
]


class CaptainMailbox:
    def __init__(
        self,
        mailbox: Any,
        credential: Any,
        *,
        account_name: str,
        oversight_bot: str,
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

    def messages(self) -> list[cards.MailMessage]:
        inbox = self.mailbox.inbox(False, PROPERTIES)
        sent = self._without_oversight_copies(self._sent_messages())
        result = []
        seen: set[str] = set()
        for message in sorted(
            [*inbox, *sent],
            key=lambda value: value.get("receivedAt", ""),
        ):
            message_id = qd_jmap.first_id(message)
            if not isinstance(message_id, str) or message_id in seen:
                continue
            seen.add(message_id)
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
                continue
            result.append(
                cards.MailMessage(
                    message_id,
                    sender,
                    message.get("subject", ""),
                    self._body(message),
                    sent_at,
                )
            )
        return result

    def send(
        self,
        recipient: str,
        subject: str,
        body: str,
        resend_key: str,
    ) -> str:
        if self._closed:
            raise security.SecurityRefused("Captain mailbox is closed")
        return self.mailbox.send(
            recipient,
            subject,
            body,
            resend_key,
        )

    def send_chat(self, recipient: str, subject: str, body: str, resend_key: str) -> tuple[str, bool]:
        wanted = json.loads(body)
        fields = {"qd", "bot", "text", "clientId"}
        if (
            not isinstance(wanted, dict) or set(wanted) != fields | {"fresh"}
            or wanted["qd"] != "chat/1" or wanted["bot"] != recipient
            or subject != f"CHAT: {recipient}" or not isinstance(wanted["fresh"], bool)
        ):
            raise security.SecurityRefused("Captain chat envelope is invalid")
        try:
            return self.send(recipient, subject, body, resend_key), wanted["fresh"]
        except qd_jmap.Refused:
            message_id = qd_jmap.message_id(self.mailbox.bot, resend_key, self.mailbox.domain)
            kept = self.mailbox.sent_copy(message_id)
            if not kept:
                raise
            [reply] = self.mailbox.jmap.call(("Email/get", {"ids": kept[:1], "properties": PROPERTIES, "fetchTextBodyValues": True}))
            rows = reply.get("list", [])
            if len(rows) != 1:
                raise
            original = rows[0]
            sender = (original.get("from") or [{}])[0].get("email", "").partition("@")[0]
            if (
                sender != self.account_name or self._recipient(original) != recipient
                or original.get("subject") != subject or qd_jmap.first_id(original) != message_id
            ):
                raise
            try:
                document = json.loads(self._body(original))
            except (ValueError, TypeError):
                raise security.SecurityRefused("Captain chat resend is invalid") from None
            if (
                not isinstance(document, dict) or set(document) not in (fields, fields | {"fresh"})
                or not isinstance(document.get("fresh", False), bool)
                or any(document.get(field) != wanted[field] for field in fields)
            ):
                raise
            return message_id, document.get("fresh", False)

    def close(self) -> None:
        if self._closed:
            return
        self.credential.clear()
        self._closed = True
