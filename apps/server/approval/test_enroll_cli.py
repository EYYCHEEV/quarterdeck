from __future__ import annotations

import base64
import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import approval_security
import enroll


class EnrollmentCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.path = self.base / "secrets.json"

    def tearDown(self):
        self.temporary.cleanup()

    def test_captain_enters_password_twice_and_receives_only_phone_enrollment_uri(self):
        output = io.StringIO()
        with (
            mock.patch.object(enroll, "SECRET_PATH", self.path),
            mock.patch.object(enroll.sys, "argv", ["enroll.py"]),
            mock.patch.object(
                enroll.getpass,
                "getpass",
                side_effect=["not-a-live-password", "not-a-live-password"],
            ),
            mock.patch.object(enroll.os, "urandom", side_effect=lambda size: bytes([size]) * size),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(enroll.main(), 0)

        rendered = output.getvalue()
        self.assertIn("otpauth://totp/Quarterdeck%3ACaptain?", rendered)
        self.assertNotIn("not-a-live-password", rendered)
        session_key = base64.b64encode(bytes([32]) * 32).decode("ascii")
        self.assertNotIn(session_key, rendered)
        loaded = approval_security.load_enrollment(self.path)
        self.assertTrue(loaded.verify_password(bytearray(b"not-a-live-password")))
        self.assertEqual(loaded.totp_secret, bytearray(bytes([20]) * 20))

    def test_mismatch_or_argument_refuses_without_creating_secrets(self):
        with (
            mock.patch.object(enroll, "SECRET_PATH", self.path),
            mock.patch.object(enroll.sys, "argv", ["enroll.py"]),
            mock.patch.object(
                enroll.getpass,
                "getpass",
                side_effect=["not-a-live-password", "different"],
            ),
        ):
            self.assertEqual(enroll.main(), 2)
        self.assertFalse(self.path.exists())

        with mock.patch.object(enroll.sys, "argv", ["enroll.py", "value"]):
            self.assertEqual(enroll.main(), 2)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
