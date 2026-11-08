from __future__ import annotations

import hmac
from typing import Protocol

from helper_contract import (
    ApprovedJoin,
    BotRecord,
    CollectTarget,
    HelperRefused,
    PreparedCollect,
    ReplacementCommitted,
)

API_KEY_MIN_LENGTH = 24
API_KEY_MAX_LENGTH = 512
API_KEY_ALPHABET = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")


class Admin(Protocol):
    def create_account(self, bot_name: str) -> str: ...

    def verify_account(self, account_id: str, bot_name: str, active: bool) -> None: ...
    def account_exists(self, account_id: str) -> bool: ...


    def destroy_account(self, account_id: str) -> None: ...

    def create_key(self, account_id: str) -> tuple[str, bytearray]: ...

    def verify_key(self, account_id: str, key_id: str, active: bool) -> None: ...

    def activate_account(self, account_id: str) -> None: ...

    def deactivate_account(self, account_id: str) -> None: ...

    def activate_key(self, account_id: str, key_id: str) -> None: ...

    def revoke_key(self, account_id: str, key_id: str) -> None: ...

    def force_revoke_key(self, account_id: str, key_id: str) -> None: ...


class Adapter(Protocol):
    def save(self, bot_name: str, token: bytearray) -> str: ...

    def read(self, receipt: str) -> bytearray: ...

    def retire(self, receipt: str, reason: str) -> None: ...


class OpenClient(Protocol):
    def expect_refused(self) -> None: ...


class Verifier(Protocol):
    def expect_refused(self, token: bytearray) -> None: ...

    def prove(self, token: bytearray) -> None: ...

    def open(self, token: bytearray) -> OpenClient: ...


def clear(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)
        value.clear()


def _valid_api_key(value: bytearray) -> bool:
    return (
        isinstance(value, bytearray)
        and API_KEY_MIN_LENGTH <= len(value) <= API_KEY_MAX_LENGTH
        and value[:4] == b"API_"
        and all(character in API_KEY_ALPHABET for character in value[4:])
    )


def _same_secret(left: bytearray, right: bytearray) -> bool:
    return hmac.compare_digest(left, right)


def _quiet(action) -> bool:
    try:
        action()
        return True
    except Exception:
        return False


class ThreeActionHelper:
    def __init__(self, admin: Admin, adapter: Adapter, verifier: Verifier) -> None:
        self.admin = admin
        self.adapter = adapter
        self.verifier = verifier

    def _rollback_parts(
        self,
        bot_name: str,
        account_id: str | None,
        key_id: str | None,
        receipt: str | None,
        reason: str,
    ) -> None:
        failures: list[Exception] = []
        if account_id is not None and key_id is not None:
            try:
                self.admin.force_revoke_key(account_id, key_id)
            except Exception as error:
                failures.append(error)

        account_empty = False
        if account_id is not None:
            try:
                if self.admin.account_exists(account_id):
                    self.admin.deactivate_account(account_id)
                    self.admin.verify_account(account_id, bot_name, False)
                    account_empty = True
                else:
                    account_empty = True
            except Exception as error:
                failures.append(error)
            if account_empty:
                try:
                    self.admin.destroy_account(account_id)
                except Exception as error:
                    failures.append(error)

        if receipt is not None:
            try:
                self.adapter.retire(receipt, reason)
            except Exception as error:
                failures.append(error)

        if failures:
            raise HelperRefused("helper action refused") from failures[0]

    def prepare_collect(self, join: ApprovedJoin) -> PreparedCollect:
        account_id: str | None = None
        key_id: str | None = None
        receipt: str | None = None
        issued: bytearray | None = None
        readback: bytearray | None = None
        try:
            account_id = self.admin.create_account(join.bot_name)
            self.admin.verify_account(account_id, join.bot_name, False)
            key_id, issued = self.admin.create_key(account_id)
            if not _valid_api_key(issued):
                raise HelperRefused("helper action refused")
            self.admin.verify_key(account_id, key_id, False)

            receipt = self.adapter.save(join.bot_name, issued)
            readback = self.adapter.read(receipt)
            if not _valid_api_key(readback) or not _same_secret(readback, issued):
                raise HelperRefused("helper action refused")
            self.verifier.expect_refused(readback)

            target = CollectTarget(join.bot_name, account_id, key_id, receipt)
            prepared = PreparedCollect(target, readback)
            readback = None
            return prepared
        except Exception as error:
            try:
                self._rollback_parts(
                    join.bot_name,
                    account_id,
                    key_id,
                    receipt,
                    "prepare-refused",
                )
            except HelperRefused:
                pass
            if isinstance(error, HelperRefused):
                raise
            raise HelperRefused("helper action refused") from error
        finally:
            clear(readback)
            clear(issued)

    def activate_collect(self, target: CollectTarget) -> BotRecord:
        readback: bytearray | None = None
        try:
            if not isinstance(target, CollectTarget):
                raise HelperRefused("helper action refused")
            self.admin.verify_account(
                target.account_id, target.bot_name, False
            )
            self.admin.verify_key(target.account_id, target.key_id, False)
            readback = self.adapter.read(target.helper_receipt)
            if not _valid_api_key(readback):
                raise HelperRefused("helper action refused")
            self.verifier.expect_refused(readback)

            self.admin.activate_account(target.account_id)
            self.admin.activate_key(target.account_id, target.key_id)
            self.admin.verify_account(target.account_id, target.bot_name, True)
            self.admin.verify_key(target.account_id, target.key_id, True)
            self.verifier.prove(readback)
            return BotRecord(
                target.bot_name,
                target.account_id,
                target.key_id,
                target.helper_receipt,
            )
        except Exception as error:
            if isinstance(error, HelperRefused):
                raise
            raise HelperRefused("helper action refused") from error
        finally:
            clear(readback)

    def rollback_collect(self, target: CollectTarget) -> None:
        if not isinstance(target, CollectTarget):
            raise HelperRefused("helper action refused")
        self._rollback_parts(
            target.bot_name,
            target.account_id,
            target.key_id,
            target.helper_receipt,
            "collect-rollback",
        )

    def replace(self, record: BotRecord) -> BotRecord:
        old_secret: bytearray | None = None
        new_secret: bytearray | None = None
        readback: bytearray | None = None
        new_key_id: str | None = None
        new_receipt: str | None = None
        committed = False
        replacement: BotRecord | None = None
        try:
            old_secret = self.adapter.read(record.adapter_receipt)
            if not _valid_api_key(old_secret):
                raise HelperRefused("helper action refused")
            open_client = self.verifier.open(old_secret)

            new_key_id, new_secret = self.admin.create_key(record.account_id)
            if not _valid_api_key(new_secret):
                raise HelperRefused("helper action refused")
            self.admin.verify_key(record.account_id, new_key_id, False)
            new_receipt = self.adapter.save(record.bot_name, new_secret)
            readback = self.adapter.read(new_receipt)
            if not _valid_api_key(readback) or not _same_secret(readback, new_secret):
                raise HelperRefused("helper action refused")
            self.verifier.expect_refused(readback)

            self.admin.activate_key(record.account_id, new_key_id)
            self.admin.verify_key(record.account_id, new_key_id, True)
            self.verifier.prove(readback)
            replacement = BotRecord(record.bot_name, record.account_id, new_key_id, new_receipt)

            self.admin.revoke_key(record.account_id, record.key_id)
            committed = True
            open_client.expect_refused()
            self.adapter.retire(record.adapter_receipt, "replaced")
            return replacement
        except Exception as error:
            if committed and replacement is not None:
                raise ReplacementCommitted(replacement) from error
            if new_key_id is not None:
                _quiet(lambda: self.admin.force_revoke_key(record.account_id, new_key_id))
            if new_receipt is not None:
                _quiet(lambda: self.adapter.retire(new_receipt, "replace-refused"))
            if isinstance(error, HelperRefused):
                raise
            raise HelperRefused("helper action refused") from error
        finally:
            clear(readback)
            clear(new_secret)
            clear(old_secret)

    def cancel(self, record: BotRecord) -> None:
        old_secret: bytearray | None = None
        try:
            old_secret = self.adapter.read(record.adapter_receipt)
            if not _valid_api_key(old_secret):
                raise HelperRefused("helper action refused")
            open_client = self.verifier.open(old_secret)
            self.admin.deactivate_account(record.account_id)
            self.admin.verify_account(record.account_id, record.bot_name, False)
            self.admin.revoke_key(record.account_id, record.key_id)
            open_client.expect_refused()
            self.adapter.retire(record.adapter_receipt, "cancelled")
        except Exception as error:
            _quiet(lambda: self.admin.force_revoke_key(record.account_id, record.key_id))
            _quiet(lambda: self.admin.deactivate_account(record.account_id))
            if isinstance(error, HelperRefused):
                raise
            raise HelperRefused("helper action refused") from error
        finally:
            clear(old_secret)
