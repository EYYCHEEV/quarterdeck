from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import approval_admin
import approval_security


class ApprovalAdminTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.path = self.base / "state.sqlite"
        self.state = approval_security.ApprovalState(
            self.path,
            bytes([76]) * 32,
            clock=lambda: 1000.0,
            token_bytes=lambda size: bytes([77]) * size,
        )
        self.state.change_approval_password(
            None,
            bytearray(b"stand-in-approval-password"),
            enabled=True,
        )

    def test_offline_reset_disables_password_and_records_visible_activity(self):
        approval_admin.reset_approval_password(self.path, clock=lambda: 1001.0)

        self.assertFalse(self.state.approval_password_required())
        self.assertEqual(
            self.state.recent_activity()[0],
            {
                "happened": 1001.0,
                "summary": "Approval password reset by server operator",
            },
        )

    def test_offline_reset_refuses_state_not_mode_0600(self):
        os.chmod(self.path, 0o640)

        with self.assertRaisesRegex(ValueError, "mode 0600"):
            approval_admin.reset_approval_password(self.path, clock=lambda: 1001.0)

        os.chmod(self.path, 0o600)
        self.assertTrue(self.state.approval_password_required())


if __name__ == "__main__":
    unittest.main(verbosity=2)
