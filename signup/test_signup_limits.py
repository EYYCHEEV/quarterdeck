from __future__ import annotations

from contextlib import closing
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import signup_flow
from signup_flow import JoinService, PublicFailure


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value


class SignupLimitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.clock = Clock()
        self.service = JoinService(
            self.base / "state.sqlite",
            self.clock,
            invite_hmac_key=b"I" * 32,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def assert_public_failure(self, action):
        with self.assertRaises(PublicFailure) as caught:
            action()
        self.assertEqual(str(caught.exception), signup_flow.PUBLIC_FAILURE)

    def request_join(self, bot_name, description, pairing):
        invite = self.service._create_invite_verified(
            "test-approver",
            bot_name,
        ).take_code()
        try:
            return self.service.request_join(
                invite,
                bot_name,
                description,
                pairing,
            )
        finally:
            signup_flow.clear(invite)
            invite.clear()

    def test_outstanding_per_bot_and_total_requests_are_bounded_then_expire(self):
        pairing = bytearray(b"P" * signup_flow.PAIRING_BYTES)
        with (
            mock.patch.object(signup_flow, "MAX_OUTSTANDING_PER_BOT", 2, create=True),
            mock.patch.object(signup_flow, "MAX_OUTSTANDING_TOTAL", 3, create=True),
            mock.patch.object(signup_flow, "MAX_JOIN_ROWS", 6, create=True),
        ):
            self.request_join("bot-a", "first", pairing)
            self.request_join("bot-a", "second", pairing)
            self.assert_public_failure(
                lambda: self.request_join("bot-a", "third", pairing)
            )
            self.request_join("bot-b", "third total", pairing)
            self.assert_public_failure(
                lambda: self.request_join(
                    "bot-c",
                    "fourth total",
                    pairing,
                )
            )
            self.clock.value += signup_flow.PAIRING_LIFETIME + 1
            self.request_join("bot-c", "after expiry", pairing)
        with closing(sqlite3.connect(self.base / "state.sqlite")) as database:
            rows = database.execute("SELECT count(*) FROM join_request").fetchone()[0]
        self.assertEqual(rows, 1, "expired durable join rows were not removed")
        pairing[:] = b"\x00" * len(pairing)

    def test_one_bots_failure_burst_cannot_block_another_valid_bot(self):
        valid_pairing = bytearray(b"V" * signup_flow.PAIRING_BYTES)
        valid_code = self.request_join(
            "valid-bot",
            "valid request",
            valid_pairing,
        )
        self.service._approve_verified(valid_code, "test-approver")
        invalid_pairing = bytearray(b"X" * signup_flow.PAIRING_BYTES)
        invalid_code = self.request_join(
            "burst-bot",
            "authenticated failure source",
            invalid_pairing,
        )
        for _ in range(8):
            self.assert_public_failure(
                lambda: self.service.claim_approved(invalid_code, "burst-bot", invalid_pairing)
            )
        claimed = self.service.claim_approved(valid_code, "valid-bot", valid_pairing)
        self.assertEqual(self.service.safe_account_state("valid-bot")["state"], "provisioning")
        valid_pairing[:] = b"\x00" * len(valid_pairing)
        invalid_pairing[:] = b"\x00" * len(invalid_pairing)

    def test_global_failure_cap_still_fails_closed(self):
        pairing = bytearray(b"G" * signup_flow.PAIRING_BYTES)
        with mock.patch.object(signup_flow, "GLOBAL_FAILURE_LIMIT", 3, create=True):
            refused_code = self.request_join(
                "bad-bot",
                "authenticated failure source",
                pairing,
            )
            for _ in range(3):
                self.assert_public_failure(
                    lambda: self.service.claim_approved(refused_code, "bad-bot", pairing)
                )
            code = self.request_join(
                "other-bot",
                "valid before collect",
                pairing,
            )
            self.service._approve_verified(code, "test-approver")
            self.assert_public_failure(lambda: self.service.claim_approved(code, "other-bot", pairing))
        pairing[:] = b"\x00" * len(pairing)


if __name__ == "__main__":
    unittest.main(verbosity=2)
