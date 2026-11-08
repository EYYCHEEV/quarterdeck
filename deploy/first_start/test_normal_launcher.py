import hashlib
import json
import os
import stat
import unittest
from types import SimpleNamespace
from unittest import mock

import normal_launcher


POLICY = {
    "hostname": "mail.example.invalid",
    "publicUrl": "https://mail.example.invalid",
}
POLICY_BYTES = (
    json.dumps(POLICY, sort_keys=True).encode("ascii") + b"\n"
)
POLICY_DIGEST = hashlib.sha256(POLICY_BYTES).hexdigest()
MARKER_BYTES = json.dumps(
    {
        "format": 1,
        "policySha256": POLICY_DIGEST,
        "readbackVerified": True,
        "recoveryPasswordRetired": True,
    },
    sort_keys=True,
).encode("ascii") + b"\n"


class NormalLauncherTests(unittest.TestCase):
    def safe_metadata(self):
        return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=os.getuid(), st_nlink=1)

    def test_gate_execs_with_small_environment_after_verified_retirement(self):
        file_data = {
            "/opt/quarterdeck/door-policy.json": POLICY_BYTES,
            "/var/lib/quarterdeck/first-start.json": MARKER_BYTES,
        }
        with (
            mock.patch.object(normal_launcher.os, "environ", {"LANG": "C", "UNRELATED": "ignored"}),
            mock.patch.object(normal_launcher.os.path, "lexists", return_value=False),
            mock.patch.object(normal_launcher.os, "lstat", return_value=self.safe_metadata()),
            mock.patch.object(normal_launcher, "read_bounded", side_effect=lambda path, _limit: file_data[path]),
            mock.patch.object(normal_launcher.os, "execve") as execve,
        ):
            normal_launcher.launch(
                "/opt/stalwart/bin/stalwart",
                ["--config", "/etc/stalwart/config.json"],
                policy_path="/opt/quarterdeck/door-policy.json",
                marker_path="/var/lib/quarterdeck/first-start.json",
                active_password_path="/run/quarterdeck/recovery-password",
            )

        execve.assert_called_once_with(
            "/opt/stalwart/bin/stalwart",
            ["/opt/stalwart/bin/stalwart", "--config", "/etc/stalwart/config.json"],
            {
                "PATH": "/usr/bin:/usr/sbin",
                "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
                "STALWART_PUBLIC_URL": POLICY["publicUrl"],
            },
        )

    def test_gate_refuses_any_recovery_setting_even_empty(self):
        with mock.patch.object(normal_launcher.os, "environ", {"STALWART_RECOVERY_MODE": ""}):
            with self.assertRaises(normal_launcher.NormalStartRefused):
                normal_launcher.launch("/opt/stalwart/bin/stalwart", [])

    def test_gate_refuses_an_active_recovery_password(self):
        with (
            mock.patch.object(normal_launcher.os, "environ", {}),
            mock.patch.object(normal_launcher.os.path, "lexists", return_value=True),
        ):
            with self.assertRaises(normal_launcher.NormalStartRefused):
                normal_launcher.launch("/opt/stalwart/bin/stalwart", [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
