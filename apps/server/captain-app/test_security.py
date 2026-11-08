import os
import tempfile
import unittest
from pathlib import Path

import security


class SecretKeyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.path = self.root / "captain-mail.key"

    def tearDown(self):
        self.temporary.cleanup()

    def write_key(self, content=b"fixed-test-placeholder-key\n"):
        self.path.write_bytes(content)
        self.path.chmod(0o600)

    def test_key_is_loaded_once_from_exact_private_single_link_file_and_cleared(self):
        self.write_key()
        key = security.SecretKey.load(self.path)
        self.assertEqual(len(key), len(b"fixed-test-placeholder-key"))
        self.assertEqual(repr(key), "SecretKey(<hidden>)")

        self.path.write_bytes(b"changed-placeholder-key\n")
        self.path.chmod(0o600)
        self.assertEqual(len(key), len(b"fixed-test-placeholder-key"))

        key.clear()
        self.assertEqual(len(key), 0)

    def test_unsafe_or_inexact_key_files_are_refused(self):
        cases = {
            "wrong mode": (b"fixed-test-placeholder-key\n", 0o640, False),
            "missing newline": (b"fixed-test-placeholder-key", 0o600, False),
            "extra line": (b"fixed-test-placeholder-key\nsecond\n", 0o600, False),
            "spaces": (b"fixed test placeholder\n", 0o600, False),
            "hard link": (b"fixed-test-placeholder-key\n", 0o600, True),
        }
        for name, (content, mode, hard_link) in cases.items():
            with self.subTest(name=name):
                self.write_key(content)
                self.path.chmod(mode)
                link = self.root / "other-link"
                if hard_link:
                    os.link(self.path, link)
                with self.assertRaises(security.SecurityRefused):
                    security.SecretKey.load(self.path)
                if link.exists():
                    link.unlink()

    def test_readback_requires_captain_mailbox_only_least_privilege_and_bounded_requests(self):
        allowed = set(security.expected_mail_permissions())
        good = {
            "account": "account-user",
            "mailbox": "account-user",
            "permissions": sorted(allowed),
            "administrator": False,
            "impersonation": False,
            "requestsPerMinute": 120,
        }
        security.verify_key_readback(good, "account-user")

        mutations = []
        for change in (
            lambda value: value.update(account="other"),
            lambda value: value["permissions"].append("admin"),
            lambda value: value.update(administrator=True),
            lambda value: value.update(impersonation=True),
            lambda value: value.update(requestsPerMinute=None),
        ):
            candidate = {**good, "permissions": list(good["permissions"])}
            change(candidate)
            mutations.append(candidate)
        for candidate in mutations:
            with self.assertRaises(security.SecurityRefused):
                security.verify_key_readback(candidate, "account-user")


if __name__ == "__main__":
    unittest.main(verbosity=2)
