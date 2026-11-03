from __future__ import annotations

from helper_contract import (
    ApprovedJoin,
    BotRecord,
    CollectTarget,
    HelperRefused,
    PreparedCollect,
    ReplacementCommitted,
)


class StandinAccountHelper:
    def __init__(self) -> None:
        self.actions = []
        self.fail = None
        self.invalid_record = False

    def prepare_collect(self, join: ApprovedJoin) -> PreparedCollect:
        self.actions.append(("prepare", join.approval_id, join.bot_name))
        if self.fail == "prepare":
            raise HelperRefused("helper action refused")
        target = CollectTarget(
            join.bot_name,
            f"account-{join.bot_name}",
            f"key-{join.bot_name}-1",
            f"receipt-{join.bot_name}-1",
        )
        return PreparedCollect(target, bytearray(b"API_" + b"A" * 36))

    def activate_collect(self, target: CollectTarget) -> BotRecord:
        self.actions.append(
            ("activate", target.bot_name, target.account_id, target.key_id, target.helper_receipt)
        )
        if self.fail == "activate":
            raise HelperRefused("helper action refused")
        if self.invalid_record:
            return BotRecord(target.bot_name, "", "key-invalid", "receipt-invalid")
        return BotRecord(
            target.bot_name,
            target.account_id,
            target.key_id,
            target.helper_receipt,
        )

    def rollback_collect(self, target: CollectTarget) -> None:
        self.actions.append(
            ("rollback", target.bot_name, target.account_id, target.key_id, target.helper_receipt)
        )
        if self.fail == "rollback":
            raise HelperRefused("helper action refused")

    def replace(self, record: BotRecord) -> BotRecord:
        self.actions.append(
            ("replace", record.bot_name, record.account_id, record.key_id, record.adapter_receipt)
        )
        replacement = BotRecord(
            record.bot_name,
            record.account_id,
            f"key-{record.bot_name}-2",
            f"receipt-{record.bot_name}-2",
        )
        if self.fail == "replacement-committed":
            raise ReplacementCommitted(replacement)
        if self.fail == "replace":
            raise HelperRefused("helper action refused")
        return replacement

    def cancel(self, record: BotRecord) -> None:
        self.actions.append(
            ("cancel", record.bot_name, record.account_id, record.key_id, record.adapter_receipt)
        )
        if self.fail == "cancel":
            raise HelperRefused("helper action refused")
