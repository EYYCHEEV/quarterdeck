from __future__ import annotations

import importlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable


OWNERSHIP_RULES = {"owner", "id-owner", "unknown-card"}


@dataclass(frozen=True, slots=True)
class CheckResult:
    document: dict[str, Any] | None
    errors: tuple[str, ...]
    ownership_refused: bool
    merged: dict[str, Any] | None = None

    def __iter__(self):
        yield self.document
        yield self.errors


def _public_errors(refusals) -> tuple[str, ...]:
    return tuple(
        refusal.public()
        if callable(getattr(refusal, "public", None))
        else str(refusal)
        for refusal in refusals
    )


class LaneAChecker:
    def __init__(
        self,
        registry: dict[str, Any],
        *,
        module=None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.module = module or importlib.import_module("qd_cards")
        registry_type = getattr(self.module, "Registry", None)
        from_json = getattr(registry_type, "from_json", None)
        for name in (
            "check_mail",
            "merge_update",
            "build_answers",
            "build_mail",
        ):
            if not callable(getattr(self.module, name, None)):
                raise RuntimeError("lane A checker contract is unavailable")
        if not callable(from_json):
            raise RuntimeError("lane A checker contract is unavailable")
        try:
            authoritative = from_json(registry)
            projects = dict(authoritative.projects)
            account_name = authoritative.captain
            oversight_bot = authoritative.steward
            if (
                any(
                    not isinstance(project, str)
                    or not project
                    or not isinstance(bot, str)
                    or not bot
                    for project, bot in projects.items()
                )
                or not isinstance(account_name, str)
                or not account_name
                or not isinstance(oversight_bot, str)
                or not oversight_bot
            ):
                raise ValueError
        except Exception:
            raise RuntimeError("card registry is invalid") from None
        self.registry = authoritative
        self.project_leads = projects
        self.account_name = account_name
        self.oversight_bot = oversight_bot
        self.active_bots = frozenset(
            {oversight_bot, *projects.values()}
        )
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def check(
        self,
        subject: str,
        body: str,
        *,
        sender: str,
        poster: str | None = None,
        base: dict[str, Any] | None = None,
        current_rev: int | None = None,
    ) -> CheckResult:
        result = self.module.check_mail(
            subject,
            body,
            sender=sender,
            registry=self.registry,
            poster=poster,
            base=base,
            current_rev=current_rev,
            now=self.clock(),
        )
        refusals = tuple(result.refusals)
        errors = _public_errors(refusals)
        ownership_refused = any(
            getattr(refusal, "rule", None) in OWNERSHIP_RULES
            for refusal in refusals
        )
        document = None
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                document = parsed
        except (TypeError, json.JSONDecodeError):
            pass
        merged = None
        if not refusals and getattr(result, "kind", None) == "update":
            if base is None or document is None:
                raise RuntimeError("valid update has no base card")
            changed = {
                key: value
                for key, value in document.items()
                if key not in {"qd", "card", "rev"}
            }
            merged = self.module.merge_update(base, changed)
        return CheckResult(
            document,
            errors,
            ownership_refused,
            merged,
        )

    def build_answers(
        self,
        card: str,
        revision: int,
        pick: str,
        note: str,
        at: str,
        poster: str,
    ) -> tuple[list[tuple[str, str, str, str]], int, tuple[str, ...]]:
        try:
            mails, hits = self.module.build_answers(
                card,
                revision,
                pick,
                note=note,
                at=at,
                poster=poster,
                registry=self.registry,
                now=self.clock(),
            )
        except self.module.CardRefused as error:
            return [], 0, _public_errors(error.refusals)
        return (
            [
                (
                    recipient,
                    mail.subject,
                    mail.body,
                    mail.resend_key,
                )
                for recipient, mail in mails
            ],
            hits,
            (),
        )

    def build_comment(
        self,
        card: str,
        text: str,
    ) -> tuple[tuple[str, str, str] | None, tuple[str, ...]]:
        try:
            mail = self.module.build_mail(
                "comment",
                {"card": card, "text": text},
                now=self.clock(),
            )
        except self.module.CardRefused as error:
            return None, _public_errors(error.refusals)
        return (
            (mail.subject, mail.body, mail.resend_key),
            (),
        )
