from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import signup_flow
from account_helper_standin import StandinAccountHelper
from helper_contract import AccountHelper, BotRecord, HelperRefused, ReplacementCommitted
from signup_flow import (
    JoinService,
    PublicFailure,
    SignupService,
    clear,
    confirmation_mac,
)


class HelperContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.joins = JoinService(
            self.base / "state.sqlite",
            invite_hmac_key=b"I" * 32,
        )
        self.helper = StandinAccountHelper()
        self.signup = SignupService(self.joins, self.helper)

    def tearDown(self):
        self.temporary.cleanup()

    def approved_handle(self, bot_name="bot-a"):
        invite = self.joins._create_invite_verified(
            "test-approver",
            bot_name,
        ).take_code()
        handle = self.signup.start_join(
            invite,
            bot_name,
            "helper contract test",
        )
        self.joins._approve_verified(handle.code, "test-approver")
        return handle

    def connect(self, bot_name="bot-a"):
        handle = self.approved_handle(bot_name)
        pairing = handle.take_pairing()
        offer = self.signup.collect(handle.code, handle.bot_name, pairing)
        credential = offer.take_credential()
        proof = confirmation_mac(
            credential,
            offer.nonce,
            offer.approval_id,
            offer.account_id,
            offer.key_id,
        )
        try:
            return self.signup.confirm(handle.code, handle.bot_name, pairing, proof)
        finally:
            clear(credential)
            clear(pairing)

    def test_contract_exposes_only_phased_collect_replace_and_cancel_actions(self):
        actions = {
            name
            for name, value in AccountHelper.__dict__.items()
            if not name.startswith("_") and callable(value)
        }
        self.assertEqual(
            actions,
            {"prepare_collect", "activate_collect", "rollback_collect", "replace", "cancel"},
        )

    def test_approved_join_uses_phased_helper_without_retaining_a_local_key(self):
        bot = self.connect()
        self.assertEqual(
            [action[0] for action in self.helper.actions],
            ["prepare", "activate"],
        )
        self.assertEqual((bot.bot_name, bot.account_id, bot.key_id, bot.adapter_receipt), (
            "bot-a",
            "account-bot-a",
            "key-bot-a-1",
            "receipt-bot-a-1",
        ))
        self.assertFalse(hasattr(bot, "key"))
        self.assertFalse(hasattr(signup_flow, "random_api_key"))
        self.assertNotIn(b"API_", (self.base / "state.sqlite").read_bytes())

    def test_replace_and_cancel_delegate_only_safe_records(self):
        bot = self.connect()
        replacement = self.signup.replace(bot)
        self.signup.cancel(replacement)
        self.assertEqual(
            [action[0] for action in self.helper.actions],
            ["prepare", "activate", "replace", "cancel"],
        )
        self.assertEqual(
            self.helper.actions[1:],
            [
                ("activate", "bot-a", "account-bot-a", "key-bot-a-1", "receipt-bot-a-1"),
                ("replace", "bot-a", "account-bot-a", "key-bot-a-1", "receipt-bot-a-1"),
                ("cancel", "bot-a", "account-bot-a", "key-bot-a-2", "receipt-bot-a-2"),
            ],
        )
        self.assertFalse(hasattr(replacement, "key"))

    def test_helper_refusal_fails_closed_with_the_public_answer(self):
        self.helper.fail = "prepare"
        with self.assertRaises(PublicFailure) as caught:
            self.connect()
        self.assertEqual(str(caught.exception), signup_flow.PUBLIC_FAILURE)
        self.assertEqual(self.helper.actions[0][0], "prepare")

    def test_committed_replacement_preserves_safe_new_record_and_cannot_look_retryable(self):
        bot = self.connect()
        self.helper.fail = "replacement-committed"
        with self.assertRaises(ReplacementCommitted) as caught:
            self.signup.replace(bot)
        self.assertEqual(caught.exception.record.key_id, "key-bot-a-2")
        self.assertEqual(caught.exception.record.adapter_receipt, "receipt-bot-a-2")
        self.assertNotEqual(caught.exception.record.key_id, bot.key_id)

    def test_invalid_helper_record_fails_closed(self):
        self.helper.invalid_record = True
        with self.assertRaises(PublicFailure):
            self.connect()
        self.assertEqual([action[0] for action in self.helper.actions], ["prepare", "activate", "rollback"])

    def test_cancelled_bot_can_complete_a_new_approved_join(self):
        first = self.connect()
        self.signup.cancel(first)
        second = self.connect()
        self.assertEqual(second.bot_name, "bot-a")
        self.assertEqual(
            [action[0] for action in self.helper.actions],
            ["prepare", "activate", "cancel", "prepare", "activate"],
        )

    def test_safe_helper_record_rejects_a_raw_adapter_path_as_a_receipt(self):
        with self.assertRaises(HelperRefused):
            BotRecord("bot-a", "account-a", "key-a", "/private/keys/bot-a.pointer")



if __name__ == "__main__":
    unittest.main(verbosity=2)
