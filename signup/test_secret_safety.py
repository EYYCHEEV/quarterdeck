from __future__ import annotations

import base64
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import signup_flow
from account_helper_standin import StandinAccountHelper
from helper_contract import BotRecord
from signup_flow import ConnectedBot, JoinHandle, JoinService, PublicFailure, SignupService

ROOT = Path(__file__).resolve().parent
CRASH_STANDIN = ROOT / "crash_repr_standin.py"
KNOWN_PAIRING = bytearray(b"PAIRING_SECRET_FOR_REPR_CHECK_1234")


class SecretSafetyTests(unittest.TestCase):
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

    @staticmethod
    def variants(value):
        raw = bytes(value)
        return (raw, raw.hex().encode("ascii"), base64.b64encode(raw), repr(raw).encode("ascii"))

    def test_secret_bearing_join_handle_has_a_redacted_representation(self):
        handle = JoinHandle("ABCDEFGH", "bot-a", bytearray(KNOWN_PAIRING))
        rendered = repr(handle).encode("utf-8")
        for variant in self.variants(KNOWN_PAIRING):
            self.assertNotIn(variant, rendered)
        handle.clear()

    def test_connected_bot_contains_only_safe_helper_identifiers(self):
        bot = ConnectedBot(BotRecord("bot-a", "account-a", "key-id-a", "receipt-a"))
        self.assertFalse(hasattr(bot, "key"))
        self.assertFalse(hasattr(bot, "pointer"))
        self.assertEqual(bot.as_record(), BotRecord("bot-a", "account-a", "key-id-a", "receipt-a"))

    def test_prepare_failure_keeps_pairing_out_of_durable_and_observed_boundaries(self):
        pairing = bytearray(KNOWN_PAIRING)
        self.helper.fail = "prepare"
        invite = self.joins._create_invite_verified(
            "test-approver",
            "bot-a",
        ).take_code()
        with mock.patch.object(signup_flow, "random_buffer", return_value=pairing):
            handle = self.signup.start_join(
                invite,
                "bot-a",
                "failure clearing",
            )
        self.joins._approve_verified(handle.code, "test-approver")
        client_pairing = handle.take_pairing()
        try:
            with self.assertRaises(PublicFailure) as caught:
                self.signup.collect(handle.code, handle.bot_name, client_pairing)
            self.assertEqual(str(caught.exception), signup_flow.PUBLIC_FAILURE)
            self.assertTrue(handle.closed)
            database_bytes = (self.base / "state.sqlite").read_bytes()
            for variant in self.variants(KNOWN_PAIRING):
                self.assertNotIn(variant, database_bytes)
        finally:
            signup_flow.clear(client_pairing)

    def test_crash_text_never_renders_pairing_material(self):
        completed = subprocess.run(
            [sys.executable, str(CRASH_STANDIN)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.base,
            env={"PATH": "/usr/bin", "PYTHONPATH": str(ROOT), "PYTHONDONTWRITEBYTECODE": "1"},
            timeout=5,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        output = completed.stdout + completed.stderr
        for variant in self.variants(KNOWN_PAIRING):
            self.assertNotIn(variant, output)
        self.assertEqual(set(self.base.iterdir()), {self.base / "state.sqlite"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
