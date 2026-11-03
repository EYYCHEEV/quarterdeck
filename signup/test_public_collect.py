from __future__ import annotations

import base64
import contextlib
import io
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from helper_contract import BotRecord, CollectTarget, PreparedCollect
from signup_flow import (
    CONFIRM_WINDOW,
    JoinService,
    PublicFailure,
    SignupService,
    clear,
    confirmation_mac,
)

KNOWN_KEY = bytearray(b"API_" + b"K" * 36)


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value


class PhasedHelperStandin:
    def __init__(self):
        self.actions = []
        self.fail = None

    def prepare_collect(self, join):
        self.actions.append(("prepare", join.approval_id, join.bot_name))
        if self.fail == "prepare":
            raise RuntimeError("stand-in prepare failure")
        target = CollectTarget(
            join.bot_name,
            f"account-{join.bot_name}",
            f"key-{join.bot_name}",
            f"receipt-{join.bot_name}",
        )
        return PreparedCollect(target, bytearray(KNOWN_KEY))

    def activate_collect(self, target):
        self.actions.append(("activate", target.bot_name, target.account_id, target.key_id))
        if self.fail == "activate":
            raise RuntimeError("stand-in activate failure")
        return BotRecord(
            target.bot_name,
            target.account_id,
            target.key_id,
            target.helper_receipt,
        )

    def rollback_collect(self, target):
        self.actions.append(("rollback", target.bot_name, target.account_id, target.key_id))
        if self.fail == "rollback":
            raise RuntimeError("stand-in rollback failure")

    def replace(self, record):
        raise AssertionError("replace is outside this test")

    def cancel(self, record):
        raise AssertionError("cancel is outside this test")


class PublicCollectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.database = self.base / "state.sqlite"
        self.clock = Clock()
        self.joins = JoinService(
            self.database,
            self.clock,
            invite_hmac_key=b"I" * 32,
        )
        self.helper = PhasedHelperStandin()
        self.signup = SignupService(self.joins, self.helper)

    def tearDown(self):
        self.temporary.cleanup()

    def approved_join(self, bot_name="bot-a"):
        invite = self.joins._create_invite_verified(
            "test-approver",
            bot_name,
        ).take_code()
        handle = self.signup.start_join(
            invite,
            bot_name,
            "public collect test",
        )
        pairing = handle.take_pairing()
        self.joins._approve_verified(handle.code, "test-approver")
        return handle.code, handle.bot_name, pairing

    def snapshot(self):
        with contextlib.closing(sqlite3.connect(self.database)) as database:
            database.row_factory = sqlite3.Row
            join_rows = [tuple(row) for row in database.execute(
                "SELECT code, approved, refused, consumed FROM join_request ORDER BY code"
            )]
            helper_rows = [tuple(row) for row in database.execute(
                "SELECT bot_name, account_id, key_id, adapter_receipt, state FROM helper_record ORDER BY bot_name"
            )]
            collect_rows = [tuple(row) for row in database.execute(
                "SELECT approval_id, bot_name, account_id, key_id, helper_receipt, "
                "nonce, expected_mac, deadline, state "
                "FROM collect_record ORDER BY approval_id"
            )]
            audit_count = database.execute("SELECT count(*) FROM audit").fetchone()[0]
            failure_count = database.execute("SELECT count(*) FROM failure_event").fetchone()[0]
        return join_rows, helper_rows, collect_rows, audit_count, failure_count

    @staticmethod
    def proof(offer, credential):
        return confirmation_mac(
            credential,
            offer.nonce,
            offer.approval_id,
            offer.account_id,
            offer.key_id,
        )

    def test_bad_pairing_collect_and_confirm_change_nothing_before_real_bot_succeeds(self):
        code, bot_name, pairing = self.approved_join()
        before = self.snapshot()
        bad_pairing = bytearray(b"X" * len(pairing))

        with self.assertRaises(PublicFailure):
            self.signup.collect(code, bot_name, bad_pairing)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.helper.actions, [])

        with self.assertRaises(PublicFailure):
            self.signup.confirm(code, bot_name, bad_pairing, b"0" * 32)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.helper.actions, [])

        offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        proof = self.proof(offer, credential)
        connected = self.signup.confirm(code, bot_name, pairing, proof)
        self.assertEqual((connected.bot_name, connected.account_id, connected.key_id), (
            "bot-a",
            "account-bot-a",
            "key-bot-a",
        ))
        self.assertEqual([action[0] for action in self.helper.actions], ["prepare", "activate"])
        clear(credential)
        clear(pairing)
        clear(bad_pairing)

    def test_bad_pairing_confirm_preserves_real_awaiting_offer(self):
        code, bot_name, pairing = self.approved_join()
        offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        before = self.snapshot()
        helper_actions = list(self.helper.actions)
        bad_pairing = bytearray(b"X" * len(pairing))

        self.assertEqual(before[2][0][-1], "awaiting-confirmation")
        with self.assertRaises(PublicFailure):
            self.signup.confirm(
                code,
                bot_name,
                bad_pairing,
                self.proof(offer, credential),
            )
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.helper.actions, helper_actions)

        connected = self.signup.confirm(
            code,
            bot_name,
            pairing,
            self.proof(offer, credential),
        )
        self.assertEqual(
            (connected.bot_name, connected.account_id, connected.key_id),
            ("bot-a", "account-bot-a", "key-bot-a"),
        )
        self.assertEqual(
            [action[0] for action in self.helper.actions],
            ["prepare", "activate"],
        )
        clear(credential)
        clear(pairing)
        clear(bad_pairing)

    def test_collect_is_one_shot_and_second_collect_returns_no_credential(self):
        code, bot_name, pairing = self.approved_join()
        offer = self.signup.collect(code, bot_name, pairing)
        with self.assertRaises(PublicFailure):
            self.signup.collect(code, bot_name, pairing)
        self.assertEqual([action[0] for action in self.helper.actions], ["prepare"])
        credential = offer.take_credential()
        self.assertEqual(credential, KNOWN_KEY)
        clear(credential)
        clear(pairing)

    def test_pairing_authenticated_wrong_mac_revokes_immediately(self):
        code, bot_name, pairing = self.approved_join()
        offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        with self.assertRaises(PublicFailure):
            self.signup.confirm(code, bot_name, pairing, b"W" * 32)
        self.assertEqual([action[0] for action in self.helper.actions], ["prepare", "rollback"])
        self.assertEqual(self.joins.safe_account_state(bot_name)["state"], "absent")
        with self.assertRaises(PublicFailure):
            self.signup.confirm(code, bot_name, pairing, self.proof(offer, credential))
        clear(credential)
        clear(pairing)

    def test_late_confirmation_revokes_and_timer_uses_the_same_rollback(self):
        code, bot_name, pairing = self.approved_join()
        offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        self.clock.value += CONFIRM_WINDOW + 1
        with self.assertRaises(PublicFailure):
            self.signup.confirm(code, bot_name, pairing, self.proof(offer, credential))
        self.assertEqual([action[0] for action in self.helper.actions], ["prepare", "rollback"])
        self.assertEqual(self.signup.recover_unfinished(startup=False), 0)
        clear(credential)
        clear(pairing)

    def test_timer_revokes_an_unconfirmed_offer_after_its_deadline(self):
        code, bot_name, pairing = self.approved_join()
        offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        self.clock.value += CONFIRM_WINDOW + 1
        self.assertEqual(self.signup.recover_unfinished(startup=False), 1)
        self.assertEqual([action[0] for action in self.helper.actions], ["prepare", "rollback"])
        self.assertEqual(self.joins.safe_account_state(bot_name)["state"], "absent")
        clear(credential)
        clear(pairing)

    def test_timer_retries_a_failed_immediate_revocation_before_deadline(self):
        code, bot_name, pairing = self.approved_join()
        offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        self.helper.fail = "rollback"
        with self.assertRaises(PublicFailure):
            self.signup.confirm(code, bot_name, pairing, b"W" * 32)
        self.helper.fail = None
        self.assertEqual(self.signup.recover_unfinished(startup=False), 1)
        self.assertEqual(
            [action[0] for action in self.helper.actions],
            ["prepare", "rollback", "rollback"],
        )
        self.assertEqual(self.joins.safe_account_state(bot_name)["state"], "absent")
        clear(credential)
        clear(pairing)

    def test_restart_mid_collect_revokes_even_before_deadline(self):
        code, bot_name, pairing = self.approved_join()
        offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        restarted = SignupService(
            JoinService(
                self.database,
                self.clock,
                invite_hmac_key=b"I" * 32,
            ),
            self.helper,
        )
        self.assertEqual(restarted.recover_unfinished(startup=True), 1)
        self.assertEqual([action[0] for action in self.helper.actions], ["prepare", "rollback"])
        self.assertEqual(restarted.joins.safe_account_state(bot_name)["state"], "absent")
        clear(credential)
        clear(pairing)

    def test_api_key_never_enters_durable_state_output_arguments_environment_or_repr(self):
        code, bot_name, pairing = self.approved_join()
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            offer = self.signup.collect(code, bot_name, pairing)
        credential = offer.take_credential()
        variants = (
            bytes(KNOWN_KEY),
            bytes(KNOWN_KEY).hex().encode("ascii"),
            base64.b64encode(KNOWN_KEY),
            repr(bytes(KNOWN_KEY)).encode("ascii"),
        )
        observed = (
            self.database.read_bytes()
            + stdout.getvalue().encode("utf-8")
            + stderr.getvalue().encode("utf-8")
            + repr(offer).encode("utf-8")
            + "\0".join(sys.argv).encode("utf-8")
            + "\0".join(f"{key}={value}" for key, value in os.environ.items()).encode("utf-8")
        )
        for variant in variants:
            self.assertNotIn(variant, observed)
        clear(credential)
        clear(pairing)


if __name__ == "__main__":
    unittest.main(verbosity=2)
