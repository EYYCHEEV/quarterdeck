from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import base64
from contextlib import closing
import os
import re
import sqlite3
import threading
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import signup_flow
from signup_flow import (
    BOT_INVITE_LIMIT,
    INVITE_LIFETIME,
    BotIdentity,
    InviteOffer,
    JoinService,
    PublicFailure,
    SignupService,
)

INVITE_KEY = b"I" * 32


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value


class InviteFirstTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.database = self.base / "state.sqlite"
        self.clock = Clock()
        self.joins = JoinService(
            self.database,
            self.clock,
            invite_hmac_key=INVITE_KEY,
        )
        self.signup = SignupService(self.joins, object())

    def owner_invite(self, bot_name=None) -> InviteOffer:
        return self.joins._create_invite_verified("qd-approver", bot_name)

    def request(self, code, bot_name):
        invite = code if isinstance(code, bytearray) else bytearray(code)
        return self.signup.start_join(
            invite,
            bot_name,
            "invite-first test",
        )

    def record_bot(
        self,
        bot_name="active-bot",
        account_id="account-active",
        state="active",
    ):
        with closing(sqlite3.connect(self.database)) as database:
            database.execute(
                "INSERT INTO helper_record "
                "(bot_name, account_id, key_id, adapter_receipt, state) "
                "VALUES (?, ?, 'key-bot', 'receipt-bot', ?)",
                (bot_name, account_id, state),
            )
            database.commit()
        return BotIdentity(bot_name, account_id)

    def assert_public_failure(self, action):
        with self.assertRaises(PublicFailure) as caught:
            action()
        self.assertEqual(str(caught.exception), signup_flow.PUBLIC_FAILURE)

    def test_invite_is_128_bits_shown_once_and_only_its_keyed_hash_is_stored(self):
        offer = self.owner_invite("named-bot")
        code = offer.take_code()
        self.assertRegex(bytes(code), rb"[A-Za-z0-9_-]{22}")
        self.assertEqual(len(base64.urlsafe_b64decode(bytes(code) + b"==")), 16)
        self.assertNotIn(bytes(code), repr(offer).encode("utf-8"))
        self.assert_public_failure(offer.take_code)

        with closing(sqlite3.connect(self.database)) as database:
            row = database.execute(
                "SELECT invite_id, code_hash, inviter_name, bot_name, expires_at, "
                "consumed_at, cancelled_at FROM invite"
            ).fetchone()
        self.assertRegex(row[0], r"[A-Za-z0-9_-]{12}")
        self.assertEqual(len(row[1]), 32)
        self.assertNotEqual(row[1], bytes(code))
        self.assertEqual(row[2:4], ("Captain", "named-bot"))
        self.assertEqual(row[4], self.clock.value + INVITE_LIFETIME)
        self.assertEqual(row[5:], (None, None))
        self.assertNotIn(bytes(code), self.database.read_bytes())
        code[:] = b"\x00" * len(code)
        code.clear()

    def test_invite_buffer_is_cleared_if_pairing_randomness_fails(self):
        offer = self.owner_invite("rng-bot")
        code = offer.take_code()
        with (
            mock.patch.object(
                signup_flow,
                "random_buffer",
                side_effect=OSError("stand-in random failure"),
            ),
            self.assertRaises(OSError),
        ):
            self.signup.start_join(code, "rng-bot", "random failure")
        self.assertEqual(code, bytearray())
        with closing(sqlite3.connect(self.database)) as database:
            consumed_at = database.execute(
                "SELECT consumed_at FROM invite WHERE invite_id = ?",
                (offer.invite_id,),
            ).fetchone()[0]
        self.assertIsNone(consumed_at)

    def test_wrong_bound_bot_does_not_consume_then_right_bot_joins(self):
        offer = self.owner_invite("right-bot")
        code = offer.take_code()

        wrong = bytearray(code)
        self.assert_public_failure(lambda: self.request(wrong, "wrong-bot"))
        self.assertEqual(wrong, bytearray())
        with closing(sqlite3.connect(self.database)) as database:
            self.assertIsNone(
                database.execute(
                    "SELECT consumed_at FROM invite WHERE invite_id = ?",
                    (offer.invite_id,),
                ).fetchone()[0]
            )

        right = bytearray(code)
        handle = self.request(right, "right-bot")
        self.assertEqual(right, bytearray())
        pending = self.joins._pending_verified("qd-approver", 50)
        self.assertEqual(
            pending,
            [
                {
                    "botName": "right-bot",
                    "code": handle.code,
                    "requestedAt": self.clock.value,
                    "invitedBy": "Captain",
                }
            ],
        )
        handle.clear()
        code[:] = b"\x00" * len(code)
        code.clear()

    def test_invite_is_consumed_when_pending_even_if_owner_refuses(self):
        offer = self.owner_invite()
        code = offer.take_code()
        handle = self.request(bytearray(code), "first-bot")
        self.joins._refuse_verified(handle.code, "qd-approver")
        self.assert_public_failure(lambda: self.request(bytearray(code), "second-bot"))
        with closing(sqlite3.connect(self.database)) as database:
            consumed_at = database.execute(
                "SELECT consumed_at FROM invite WHERE invite_id = ?",
                (offer.invite_id,),
            ).fetchone()[0]
        self.assertEqual(consumed_at, self.clock.value)
        handle.clear()
        code[:] = b"\x00" * len(code)
        code.clear()

    def test_cancel_and_join_race_allows_exactly_one_winner(self):
        offer = self.owner_invite("race-bot")
        code = offer.take_code()
        barrier = threading.Barrier(2)

        def join():
            barrier.wait()
            try:
                handle = self.request(bytearray(code), "race-bot")
                handle.clear()
                return "joined"
            except PublicFailure:
                return "refused"

        def cancel():
            barrier.wait()
            try:
                self.joins._cancel_invite_verified(
                    offer.invite_id,
                    "qd-approver",
                )
                return "cancelled"
            except PublicFailure:
                return "refused"

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [pool.submit(join), pool.submit(cancel)]
            results = [outcome.result() for outcome in outcomes]
        self.assertEqual(results.count("refused"), 1)
        self.assertEqual(
            results.count("joined") + results.count("cancelled"),
            1,
        )
        with closing(sqlite3.connect(self.database)) as database:
            consumed_at, cancelled_at = database.execute(
                "SELECT consumed_at, cancelled_at FROM invite "
                "WHERE invite_id = ?",
                (offer.invite_id,),
            ).fetchone()
            pending = database.execute(
                "SELECT count(*) FROM join_request WHERE bot_name = 'race-bot'"
            ).fetchone()[0]
        self.assertNotEqual(consumed_at is None, cancelled_at is None)
        self.assertEqual(pending, int(consumed_at is not None))
        code[:] = b"\x00" * len(code)
        code.clear()

    def test_owner_lists_and_cancels_only_open_invites_without_recovering_code(self):
        offer = self.owner_invite("cancelled-bot")
        code = offer.take_code()
        self.assertEqual(
            self.joins._list_invites_verified("qd-approver", 50),
            [
                {
                    "inviteId": offer.invite_id,
                    "botName": "cancelled-bot",
                    "invitedBy": "Captain",
                    "createdAt": self.clock.value,
                    "expiresAt": self.clock.value + INVITE_LIFETIME,
                }
            ],
        )
        self.joins._cancel_invite_verified(offer.invite_id, "qd-approver")
        self.assertEqual(self.joins._list_invites_verified("qd-approver", 50), [])
        self.assert_public_failure(
            lambda: self.joins._cancel_invite_verified(offer.invite_id, "qd-approver")
        )
        self.assert_public_failure(lambda: self.request(bytearray(code), "cancelled-bot"))

        expired = self.owner_invite("expired-bot")
        expired_code = expired.take_code()
        self.clock.value += INVITE_LIFETIME + 1
        self.assert_public_failure(
            lambda: self.request(bytearray(expired_code), "expired-bot")
        )
        self.assertEqual(self.joins._list_invites_verified("qd-approver", 50), [])
        code[:] = b"\x00" * len(code)
        code.clear()
        expired_code[:] = b"\x00" * len(expired_code)
        expired_code.clear()

    def test_unknown_inactive_or_mismatched_bot_is_refused_uniformly(self):
        self.assert_public_failure(
            lambda: self.joins.create_bot_invite(
                BotIdentity("unknown-bot", "account-unknown"),
                "target-bot",
            )
        )
        inactive = self.record_bot(
            "inactive-bot",
            "account-inactive",
            "cancelled",
        )
        self.assert_public_failure(
            lambda: self.joins.create_bot_invite(inactive, "target-bot")
        )
        self.record_bot()
        self.assert_public_failure(
            lambda: self.joins.create_bot_invite(
                BotIdentity("active-bot", "other-account"),
                "target-bot",
            )
        )

    def test_any_active_bot_can_invite_and_is_named_as_inviter(self):
        identity = self.record_bot()
        offer = self.joins.create_bot_invite(identity, "target-bot")
        code = offer.take_code()
        handle = self.request(bytearray(code), "target-bot")
        self.assertEqual(
            self.joins._pending_verified("qd-approver", 50)[0]["invitedBy"],
            "active-bot",
        )
        handle.clear()
        code[:] = b"\x00" * len(code)
        code.clear()

    def test_active_bot_cannot_impersonate_change_or_delete_another_bot(self):
        first = self.record_bot("first-bot", "account-first")
        self.record_bot("second-bot", "account-second")
        self.assert_public_failure(
            lambda: self.joins.create_bot_invite(
                BotIdentity("second-bot", first.account_id),
                "target-bot",
            )
        )
        offer = self.joins.create_bot_invite(first, "target-bot")
        with closing(sqlite3.connect(self.database)) as database:
            bots = database.execute(
                "SELECT bot_name, account_id, state FROM helper_record "
                "ORDER BY bot_name"
            ).fetchall()
        self.assertEqual(
            bots,
            [
                ("first-bot", "account-first", "active"),
                ("second-bot", "account-second", "active"),
            ],
        )
        code = offer.take_code()
        code[:] = b"\x00" * len(code)
        code.clear()

    def test_active_bot_can_create_only_five_invites_per_rolling_hour(self):
        identity = self.record_bot()
        offers = [
            self.joins.create_bot_invite(identity, f"target-{index}")
            for index in range(BOT_INVITE_LIMIT)
        ]
        self.assert_public_failure(
            lambda: self.joins.create_bot_invite(
                identity,
                "target-over-limit",
            )
        )
        self.clock.value += signup_flow.BOT_INVITE_WINDOW + 1
        allowed = self.joins.create_bot_invite(
            identity,
            "target-after-window",
        )
        for offer in [*offers, allowed]:
            code = offer.take_code()
            code[:] = b"\x00" * len(code)
            code.clear()


if __name__ == "__main__":
    unittest.main(verbosity=2)
