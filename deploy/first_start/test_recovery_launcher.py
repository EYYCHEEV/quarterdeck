import os
import stat
import unittest
from types import SimpleNamespace
from unittest import mock

import recovery_launcher


NOT_A_CREDENTIAL = bytes([65]) * 43


class RecoveryLauncherTests(unittest.TestCase):
    def test_private_file_is_read_without_following_links_and_only_child_gets_recovery_environment(self):
        metadata = SimpleNamespace(
            st_mode=stat.S_IFREG | 0o600,
            st_uid=os.getuid(),
            st_nlink=1,
        )
        reads = [NOT_A_CREDENTIAL, b"", b""]
        with (
            mock.patch.object(recovery_launcher.os, "lstat", return_value=metadata),
            mock.patch.object(recovery_launcher.os, "open", return_value=9) as opened,
            mock.patch.object(recovery_launcher.os, "read", side_effect=reads),
            mock.patch.object(recovery_launcher.os, "close") as closed,
        ):
            password = recovery_launcher.read_private_password("/run/quarterdeck/recovery-password")

        opened.assert_called_once_with(
            "/run/quarterdeck/recovery-password",
            os.O_RDONLY | os.O_NOFOLLOW,
        )
        closed.assert_called_once_with(9)
        self.assertEqual(password, bytearray(NOT_A_CREDENTIAL))

        child = recovery_launcher.child_environment(password, 18080)
        self.assertEqual(set(child), {
            "PATH",
            "SSL_CERT_FILE",
            "STALWART_RECOVERY_MODE",
            "STALWART_RECOVERY_MODE_PORT",
            "STALWART_RECOVERY_MODE_LOG_LEVEL",
            "STALWART_RECOVERY_ADMIN",
        })
        self.assertEqual(child["STALWART_RECOVERY_MODE"], "1")
        self.assertTrue(child["STALWART_RECOVERY_ADMIN"].startswith("qd-recovery:"))
        self.assertNotIn("STALWART_RECOVERY_ADMIN", os.environ)
        recovery_launcher.clear(password)
        self.assertEqual(password, bytearray(len(NOT_A_CREDENTIAL)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
