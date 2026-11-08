from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path

import approval_security


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.path = self.base / "secrets.json"

    def tearDown(self):
        self.temporary.cleanup()

    def test_captain_enrollment_stores_only_private_verifier_and_clears_password(self):
        password = bytearray(b"not-a-live-password")
        approval_security.write_enrollment(
            self.path,
            password,
            salt=bytes([83]) * 16,
            totp_secret=bytes([84]) * 20,
            session_key=bytes([75]) * 32,
        )

        self.assertEqual(password, bytearray())
        metadata = self.path.stat()
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
        body = self.path.read_bytes()
        self.assertNotIn(b"not-a-live-password", body)

        loaded = approval_security.load_enrollment(self.path)
        self.assertTrue(loaded.verify_password(bytearray(b"not-a-live-password")))
        self.assertFalse(loaded.verify_password(bytearray(b"not-the-password")))
        self.assertEqual(loaded.totp_secret, bytearray(bytes([84]) * 20))
        self.assertEqual(loaded.session_key, bytearray(bytes([75]) * 32))

    def test_enrollment_refuses_unsafe_directory(self):
        password = bytearray(b"not-a-live-password")
        os.chmod(self.base, 0o755)
        with self.assertRaises(approval_security.ApprovalRefused):
            approval_security.write_enrollment(
                self.path,
                password,
                salt=bytes([83]) * 16,
                totp_secret=bytes([84]) * 20,
                session_key=bytes([75]) * 32,
            )
        self.assertEqual(password, bytearray())

    def test_enrollment_refuses_to_replace_existing_secrets(self):
        self.path.write_bytes(b"existing")
        password = bytearray(b"not-a-live-password")
        with self.assertRaises(FileExistsError):
            approval_security.write_enrollment(
                self.path,
                password,
                salt=bytes([83]) * 16,
                totp_secret=bytes([84]) * 20,
                session_key=bytes([75]) * 32,
            )
        self.assertEqual(password, bytearray())
        self.assertEqual(self.path.read_bytes(), b"existing")

    def test_password_and_phone_code_are_both_required(self):
        password = bytearray(b"not-a-live-password")
        approval_security.write_enrollment(
            self.path,
            password,
            salt=bytes([83]) * 16,
            totp_secret=b"12345678901234567890",
            session_key=bytes([75]) * 32,
        )
        loaded = approval_security.load_enrollment(self.path)

        self.assertEqual(
            loaded.verify_login(bytearray(b"not-a-live-password"), "287082", now=59),
            1,
        )
        self.assertIsNone(
            loaded.verify_login(bytearray(b"not-the-password"), "287082", now=59)
        )
        self.assertIsNone(
            loaded.verify_login(bytearray(b"not-a-live-password"), "000000", now=59)
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
