from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path


WORK = Path(__file__).resolve().parents[2]
SIGNUP = WORK / "signup"
HELPER = Path(os.environ.get("QD_HELPER_DIR", WORK / "golive" / "helper")).resolve()
sys.path.insert(0, str(SIGNUP))

import signup_flow as signup


spec = importlib.util.spec_from_file_location("three_action_helper_under_test", HELPER / "helper.py")
if spec is None or spec.loader is None:
    raise RuntimeError("helper module unavailable")
helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper
spec.loader.exec_module(helper)


class StandinAdmin:
    def __init__(self) -> None:
        self.accounts: dict[str, dict[str, object]] = {}
        self.keys: dict[str, dict[str, object]] = {}
        self.next_key = 0

    def create_account(self, bot_name: str) -> str:
        account_id = f"account-{len(self.accounts) + 1}"
        self.accounts[account_id] = {"name": bot_name, "active": False}
        return account_id

    def verify_account(self, account_id: str, bot_name: str, active: bool) -> None:
        if self.accounts.get(account_id) != {"name": bot_name, "active": active}:
            raise RuntimeError("account readback mismatch")
    def account_exists(self, account_id: str) -> bool:
        return account_id in self.accounts


    def destroy_account(self, account_id: str) -> None:
        self.accounts.pop(account_id, None)
        for key_id in [key for key, value in self.keys.items() if value["account"] == account_id]:
            self.keys.pop(key_id)

    def create_key(self, account_id: str) -> tuple[str, bytearray]:
        self.next_key += 1
        key_id = f"key-{self.next_key}"
        token = bytearray(b"API_" + bytes([64 + self.next_key]) * 38)
        self.keys[key_id] = {"account": account_id, "active": False, "token": bytes(token)}
        return key_id, token

    def verify_key(self, account_id: str, key_id: str, active: bool) -> None:
        value = self.keys.get(key_id)
        if value is None or value["account"] != account_id or value["active"] is not active:
            raise RuntimeError("key readback mismatch")

    def activate_account(self, account_id: str) -> None:
        self.accounts[account_id]["active"] = True

    def deactivate_account(self, account_id: str) -> None:
        self.accounts[account_id]["active"] = False

    def activate_key(self, account_id: str, key_id: str) -> None:
        self.keys[key_id]["active"] = True

    def revoke_key(self, account_id: str, key_id: str) -> None:
        if key_id in self.keys:
            self.keys[key_id]["active"] = False

    def force_revoke_key(self, account_id: str, key_id: str) -> None:
        self.revoke_key(account_id, key_id)

    def accepts(self, token: bytearray) -> bool:
        candidate = bytes(token)
        return any(
            value["token"] == candidate
            and value["active"]
            and bool(self.accounts.get(str(value["account"]), {}).get("active"))
            for value in self.keys.values()
        )

    def has_active_state(self) -> bool:
        return any(bool(value["active"]) for value in self.accounts.values()) or any(
            bool(value["active"]) for value in self.keys.values()
        )


class StandinAdapter:
    def __init__(self) -> None:
        self.values: dict[str, bytearray] = {}
        self.retired: list[tuple[str, str]] = []

    def save(self, bot_name: str, token: bytearray) -> str:
        receipt = f"{bot_name}-slot-{len(self.values) + 1}"
        self.values[receipt] = bytearray(token)
        return receipt

    def read(self, receipt: str) -> bytearray:
        return bytearray(self.values[receipt])

    def retire(self, receipt: str, reason: str) -> None:
        if (receipt, reason) not in self.retired:
            self.retired.append((receipt, reason))
        self.values.pop(receipt, None)


class StandinOpenClient:
    def __init__(self, verifier: "StandinVerifier", token: bytearray) -> None:
        self.verifier = verifier
        self.token = bytearray(token)

    def expect_refused(self) -> None:
        try:
            if self.verifier.fail_open_check:
                raise RuntimeError("stand-in open-client proof failure")
            if self.verifier.admin.accepts(self.token):
                raise RuntimeError("old client still accepted")
        finally:
            helper.clear(self.token)


class StandinVerifier:
    def __init__(self, admin: StandinAdmin) -> None:
        self.admin = admin
        self.fail_open_check = False

    def expect_refused(self, token: bytearray) -> None:
        if self.admin.accepts(token):
            raise RuntimeError("inactive key accepted")

    def prove(self, token: bytearray) -> None:
        if not self.admin.accepts(token):
            raise RuntimeError("active key refused")

    def open(self, token: bytearray) -> StandinOpenClient:
        return StandinOpenClient(self, token)


class SignupHelperIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.joins = signup.JoinService(
            Path(self.temporary.name) / "join.sqlite3",
            invite_hmac_key=b"I" * signup.INVITE_HMAC_KEY_BYTES,
        )
        self.admin = StandinAdmin()
        self.adapter = StandinAdapter()
        self.verifier = StandinVerifier(self.admin)
        self.account_helper = helper.ThreeActionHelper(self.admin, self.adapter, self.verifier)
        self.service = signup.SignupService(self.joins, self.account_helper)

    def approved_handle(self) -> signup.JoinHandle:
        offer = self.joins._create_invite_verified(
            "qd-approver", "bot-a"
        )
        invite = offer.take_code()
        try:
            handle = self.service.start_join(
                invite,
                "bot-a",
                "integration stand-in",
            )
        finally:
            signup.clear(invite)
        self.joins._approve_verified(handle.code, "qd-approver")
        return handle

    def connect(self) -> signup.ConnectedBot:
        handle = self.approved_handle()
        pairing = handle.take_pairing()
        offer = self.service.collect(handle.code, handle.bot_name, pairing)
        credential = offer.take_credential()
        proof = signup.confirmation_mac(
            credential,
            offer.nonce,
            offer.approval_id,
            offer.account_id,
            offer.key_id,
        )
        try:
            return self.service.confirm(
                handle.code, handle.bot_name, pairing, proof
            )
        finally:
            signup.clear(credential)
            credential.clear()
            signup.clear(pairing)
            pairing.clear()

    def test_provision_through_signup_service(self) -> None:
        connected = self.connect()
        self.assertEqual(connected.bot_name, "bot-a")
        self.assertEqual(self.joins.safe_account_state("bot-a")["state"], "active")
        self.assertTrue(self.admin.keys[connected.key_id]["active"])

    def test_committed_replacement_state_is_kept(self) -> None:
        connected = self.connect()
        old_key_id = connected.key_id
        self.verifier.fail_open_check = True
        with self.assertRaises(signup.ReplacementCommitted) as caught:
            self.service.replace(connected)
        replacement = caught.exception.record
        with self.joins._connect() as database:
            row = database.execute(
                "SELECT key_id, adapter_receipt, state FROM helper_record WHERE bot_name = ?",
                ("bot-a",),
            ).fetchone()
        self.assertEqual((row["key_id"], row["adapter_receipt"], row["state"]), (
            replacement.key_id,
            replacement.adapter_receipt,
            "active",
        ))
        self.assertFalse(self.admin.keys[old_key_id]["active"])
        self.assertTrue(self.admin.keys[replacement.key_id]["active"])

    def test_cancel_through_signup_service(self) -> None:
        connected = self.connect()
        self.service.cancel(connected)
        self.assertEqual(self.joins.safe_account_state("bot-a")["state"], "cancelled")
        self.assertFalse(self.admin.has_active_state())

    def test_failure_after_successful_activation_rolls_back_key_and_account(self) -> None:
        def fail_confirm(target: signup.CollectTarget, record: signup.BotRecord) -> None:
            raise RuntimeError("stand-in durable confirmation failure")

        self.joins.confirm_activation = fail_confirm
        with self.assertRaises(signup.PublicFailure):
            self.connect()
        self.assertFalse(
            self.admin.has_active_state(),
            "successful helper activation left an orphan active key",
        )
        self.assertEqual(self.joins.safe_account_state("bot-a")["state"], "absent")


if __name__ == "__main__":
    unittest.main(verbosity=2)
