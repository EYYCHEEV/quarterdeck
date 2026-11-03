from __future__ import annotations

import contextlib
import io
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

from helper_contract import ApprovedJoin
from signup_flow import JoinService, PAIRING_BYTES, PUBLIC_FAILURE, PublicFailure


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value


class JoinClaimTests(unittest.TestCase):
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
        self.assertEqual(str(caught.exception), PUBLIC_FAILURE)

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
            invite[:] = b"\x00" * len(invite)
            invite.clear()

    def request_and_approve(self, bot_name):
        pairing = bytearray(os.urandom(PAIRING_BYTES))
        code = self.request_join(bot_name, "join state test", pairing)
        self.service._approve_verified(code, "test-approver")
        return code, pairing

    def test_valid_join_is_claimed_once_without_local_key_issuance_or_pairing_persistence(self):
        pairing = bytearray(os.urandom(PAIRING_BYTES))
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = self.request_join(
                "valid-bot",
                "join state test",
                pairing,
            )
            self.service._approve_verified(code, "test-approver")
            claimed = self.service.claim_approved(code, "valid-bot", pairing)
        self.assertEqual(claimed, ApprovedJoin(code, "valid-bot"))
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))
        database_bytes = (self.base / "state.sqlite").read_bytes()
        self.assertNotIn(bytes(pairing), database_bytes, "raw pairing bytes persisted")
        with closing(sqlite3.connect(self.base / "state.sqlite")) as database:
            tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertNotIn("key_record", tables)
        self.assertEqual(self.service.safe_account_state("valid-bot")["state"], "provisioning")
        pairing[:] = b"\x00" * len(pairing)

    def test_expired_join_fails_with_the_public_answer_and_claims_no_helper_action(self):
        code, pairing = self.request_and_approve("expired-bot")
        self.clock.value += 601
        self.assert_public_failure(lambda: self.service.claim_approved(code, "expired-bot", pairing))
        self.assertEqual(self.service.safe_account_state("expired-bot")["state"], "absent")
        pairing[:] = b"\x00" * len(pairing)

    def test_second_claim_fails_and_only_one_helper_reservation_exists(self):
        code, pairing = self.request_and_approve("replay-bot")
        self.service.claim_approved(code, "replay-bot", pairing)
        self.assert_public_failure(lambda: self.service.claim_approved(code, "replay-bot", pairing))
        self.assertEqual(self.service.safe_account_state("replay-bot")["state"], "provisioning")
        pairing[:] = b"\x00" * len(pairing)

    def test_two_claims_at_once_allow_at_most_one_helper_action(self):
        code, pairing = self.request_and_approve("race-bot")
        barrier = threading.Barrier(2)

        def claim():
            barrier.wait()
            try:
                return self.service.claim_approved(code, "race-bot", pairing)
            except PublicFailure as failure:
                self.assertEqual(str(failure), PUBLIC_FAILURE)
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: claim(), range(2)))
        self.assertEqual(sum(outcome is not None for outcome in outcomes), 1)
        self.assertEqual(self.service.safe_account_state("race-bot")["state"], "provisioning")
        pairing[:] = b"\x00" * len(pairing)

    def test_unknown_join_and_unknown_approval_have_the_same_public_answer(self):
        pairing = bytearray(os.urandom(PAIRING_BYTES))
        self.assert_public_failure(lambda: self.service.claim_approved("22222222", "unknown-bot", pairing))
        self.assert_public_failure(lambda: self.service._approve_verified("33333333", "test-approver"))
        self.assertEqual(self.service.safe_account_state("unknown-bot")["state"], "absent")
        pairing[:] = b"\x00" * len(pairing)

    def test_authenticated_failure_burst_is_rate_limited_without_changing_the_public_answer(self):
        pairing = bytearray(os.urandom(PAIRING_BYTES))
        code = self.request_join(
            "burst-bot",
            "failure limit test",
            pairing,
        )
        for _ in range(8):
            self.assert_public_failure(lambda: self.service.claim_approved(code, "burst-bot", pairing))
        counts = self.service.safe_failure_counts()
        self.assertGreater(counts["rate_limited"], 0)
        self.assertEqual(self.service.safe_account_state("burst-bot")["state"], "absent")
        pairing[:] = b"\x00" * len(pairing)


if __name__ == "__main__":
    unittest.main(verbosity=2)
