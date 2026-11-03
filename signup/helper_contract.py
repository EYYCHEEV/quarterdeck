from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
SAFE_VALUE = re.compile(r"[^\x00-\x1f\x7f]{1,256}\Z")
OPAQUE_RECEIPT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\Z")
APPROVAL_ID = re.compile(r"[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}\Z")
API_KEY_ALPHABET = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
API_KEY_MIN_BYTES = 24
API_KEY_MAX_BYTES = 512


def _valid_api_key(value: bytearray) -> bool:
    return (
        isinstance(value, bytearray)
        and API_KEY_MIN_BYTES <= len(value) <= API_KEY_MAX_BYTES
        and value.startswith(b"API_")
        and all(byte in API_KEY_ALPHABET for byte in value[4:])
    )


def _clear(value: bytearray) -> None:
    value[:] = b"\x00" * len(value)
    value.clear()


class HelperRefused(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ApprovedJoin:
    approval_id: str
    bot_name: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.approval_id, str)
            or APPROVAL_ID.fullmatch(self.approval_id) is None
            or not isinstance(self.bot_name, str)
            or BOT_NAME.fullmatch(self.bot_name) is None
        ):
            raise HelperRefused("helper action refused")


@dataclass(frozen=True, slots=True)
class CollectTarget:
    bot_name: str
    account_id: str
    key_id: str
    helper_receipt: str

    def __post_init__(self) -> None:
        if not isinstance(self.bot_name, str) or BOT_NAME.fullmatch(self.bot_name) is None:
            raise HelperRefused("helper action refused")
        if any(
            not isinstance(value, str) or SAFE_VALUE.fullmatch(value) is None
            for value in (self.account_id, self.key_id)
        ):
            raise HelperRefused("helper action refused")
        if (
            not isinstance(self.helper_receipt, str)
            or OPAQUE_RECEIPT.fullmatch(self.helper_receipt) is None
        ):
            raise HelperRefused("helper action refused")


class PreparedCollect:
    __slots__ = ("target", "_credential", "closed")

    def __init__(self, target: CollectTarget, credential: bytearray) -> None:
        if not isinstance(target, CollectTarget) or not _valid_api_key(credential):
            raise HelperRefused("helper action refused")
        self.target = target
        self._credential = credential
        self.closed = False

    def take_credential(self) -> bytearray:
        if self.closed:
            raise HelperRefused("helper action refused")
        credential = self._credential
        self._credential = bytearray()
        self.closed = True
        return credential

    def clear(self) -> None:
        _clear(self._credential)
        self.closed = True

    def __repr__(self) -> str:
        return f"PreparedCollect(target={self.target!r}, credential=<redacted>)"


@dataclass(frozen=True, slots=True)
class BotRecord:
    bot_name: str
    account_id: str
    key_id: str
    adapter_receipt: str

    def __post_init__(self) -> None:
        if not isinstance(self.bot_name, str) or BOT_NAME.fullmatch(self.bot_name) is None:
            raise HelperRefused("helper action refused")
        if any(
            not isinstance(value, str) or SAFE_VALUE.fullmatch(value) is None
            for value in (self.account_id, self.key_id)
        ):
            raise HelperRefused("helper action refused")
        if (
            not isinstance(self.adapter_receipt, str)
            or OPAQUE_RECEIPT.fullmatch(self.adapter_receipt) is None
        ):
            raise HelperRefused("helper action refused")


class ReplacementCommitted(RuntimeError):
    def __init__(self, record: BotRecord) -> None:
        super().__init__("replacement committed; post-commit proof failed")
        self.record = record


class AccountHelper(Protocol):
    def prepare_collect(self, join: ApprovedJoin) -> PreparedCollect: ...

    def activate_collect(self, target: CollectTarget) -> BotRecord: ...

    def rollback_collect(self, target: CollectTarget) -> None: ...

    def replace(self, record: BotRecord) -> BotRecord: ...

    def cancel(self, record: BotRecord) -> None: ...
