from __future__ import annotations

import copy
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "golive" / "helper"
CAPTAIN_APP = ROOT / "captain-app"
DOOR = ROOT / "golive" / "door"
for directory in (HELPER, CAPTAIN_APP, DOOR):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

import stalwart_admin
import captain_account
import security


NAME = "account-user"
ACCOUNT_ID = "account-id"
KEY_ID = "key-id"
KEY = b"API_" + b"standin_key_material_123456"


class TtyBytes(io.BytesIO):
    def isatty(self):
        return True


class FakeTransport:
    def __init__(self, *, rate=120, period=60_000):
        self.rate = rate
        self.period = period
        self.calls = []
        self.account_permissions = copy.deepcopy(
            stalwart_admin.ACTIVE_PERMISSIONS
        )
        self.key_permissions = copy.deepcopy(
            stalwart_admin.ACTIVE_KEY_PERMISSIONS
        )

    def call(self, method, arguments, call_id):
        self.calls.append((method, copy.deepcopy(arguments), call_id))
        if method == "x:Account/query":
            return {"ids": ["account-id"]}
        if method == "x:Account/get":
            return {
                "list": [
                    {
                        "id": "account-id",
                        "name": NAME,
                        "roles": {"@type": "User"},
                        "permissions": copy.deepcopy(self.account_permissions),
                        "quotas": copy.deepcopy(stalwart_admin.ACCOUNT_QUOTAS),
                        "encryptionAtRest": {"@type": "Disabled"},
                    }
                ]
            }
        if method == "x:ApiKey/get":
            return {
                "list": [
                    {
                        "id": "key-id",
                        "description": "Quarterdeck restricted bot credential",
                        "permissions": copy.deepcopy(self.key_permissions),
                        "allowedIps": {},
                    }
                ]
            }
        if method == "x:Http/get":
            if arguments != {
                "ids": ["singleton"],
                "properties": ["id", "rateLimitAuthenticated"],
            }:
                raise AssertionError((method, arguments, call_id))
            return {
                "list": [
                    {
                        "id": "singleton",
                        "rateLimitAuthenticated": {
                            "count": self.rate,
                            "period": self.period,
                        },
                    }
                ]
            }
        raise AssertionError((method, arguments, call_id))


class FakeAdmin:
    def __init__(
        self,
        *,
        rate=120,
        period=60_000,
        create_error=None,
        account_id=ACCOUNT_ID,
        key_id=KEY_ID,
    ):
        self.transport = FakeTransport(rate=rate, period=period)
        self.calls = []
        self.issued = bytearray(KEY)
        self.create_error = create_error
        self.account_id = account_id
        self.key_id = key_id

    def create_account(self, name):
        self.calls.append(("create_account", name))
        if self.create_error:
            raise self.create_error
        return self.account_id

    def create_key(self, account_id):
        self.calls.append(("create_key", account_id))
        return self.key_id, self.issued

    def verify_account(self, account_id, name, active):
        self.calls.append(("verify_account", account_id, name, active))

    def verify_key(self, account_id, key_id, active):
        self.calls.append(("verify_key", account_id, key_id, active))

    def activate_account(self, account_id):
        self.calls.append(("activate_account", account_id))

    def activate_key(self, account_id, key_id):
        self.calls.append(("activate_key", account_id, key_id))

    def revoke_key(self, account_id, key_id):
        self.calls.append(("revoke_key", account_id, key_id))


class CaptainAccountTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.key_parent = self.base / "key"
        self.state_parent = self.base / "state"
        self.key_parent.mkdir(mode=0o700)
        self.state_parent.mkdir(mode=0o700)
        self.key_path = self.key_parent / "captain.key"
        self.ids_path = self.state_parent / "captain-ids.json"
        self.readback_path = self.state_parent / "key-readback.json"
        self.registry_path = self.state_parent / "project-registry.json"
        self.registry = {
            "format": 1,
            "steward": "bot-a",
            "captain": NAME,
            "projects": {"Project A": "bot-b", "Project New": "bot-d"},
        }
        self.registry_path.write_text(json.dumps(self.registry), encoding="utf-8")
        self.registry_path.chmod(0o600)

    def run_tool(self, mode, *, source=b"", admin=None, name_only=False):
        stdout = io.BytesIO()
        stderr = io.BytesIO()
        factory = (lambda path: admin) if admin is not None else None
        status = captain_account.run(
            mode,
            name_only=name_only,
            key_path=self.key_path,
            readback_path=self.readback_path,
            ids_path=self.ids_path,
            registry_path=self.registry_path,
            runtime_path=self.base / "helper-runtime.json",
            stdin=io.BytesIO(source),
            stdout=stdout,
            stderr=stderr,
            admin_factory=factory,
        )
        return status, stdout.getvalue(), stderr.getvalue()

    def test_prepare_checks_all_outputs_and_carries_private_ids(self):
        status, stdout, stderr = self.run_tool("prepare")
        self.assertEqual(
            (status, stdout, stderr),
            (0, (NAME + "\n").encode(), b""),
        )

        self.ids_path.write_text(
            json.dumps(
                {
                    "format": 1,
                    "account": NAME,
                    "accountId": ACCOUNT_ID,
                    "keyId": KEY_ID,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        self.ids_path.chmod(0o600)
        status, stdout, stderr = self.run_tool("prepare")
        self.assertEqual(
            (status, stdout, stderr),
            (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"),
        )

        status, stdout, stderr = self.run_tool(
            "prepare",
            name_only=True,
        )
        self.assertEqual(
            (status, stdout, stderr),
            (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"),
        )

        self.key_path.write_bytes(KEY + b"\n")
        self.key_path.chmod(0o600)
        status, stdout, stderr = self.run_tool("prepare", name_only=True)
        self.assertEqual(
            (status, stdout, stderr),
            (
                0,
                f"{NAME}\n{ACCOUNT_ID}\n{KEY_ID}\n".encode(),
                b"",
            ),
        )

        self.readback_path.write_text("{}\n", encoding="utf-8")
        self.readback_path.chmod(0o600)
        status, stdout, stderr = self.run_tool("prepare", name_only=True)
        self.assertEqual(
            (status, stdout, stderr),
            (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"),
        )

    def test_prepare_refuses_malformed_private_ids(self):
        self.key_path.write_bytes(KEY + b"\n")
        self.key_path.chmod(0o600)
        self.ids_path.write_text(
            json.dumps(
                {
                    "format": 1,
                    "account": NAME,
                    "accountId": "bad/id",
                    "keyId": KEY_ID,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        self.ids_path.chmod(0o600)

        status, stdout, stderr = self.run_tool(
            "prepare",
            name_only=True,
        )
        self.assertEqual(
            (status, stdout, stderr),
            (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"),
        )

    def test_create_uses_inactive_admin_sequence_and_pipe_only(self):
        admin = FakeAdmin()
        status, stdout, stderr = self.run_tool(
            "create", source=(NAME + "\n").encode(), admin=admin
        )

        self.assertEqual(status, 0)
        self.assertEqual(stderr, b"")
        self.assertEqual(
            stdout,
            (NAME + "\n").encode()
            + KEY
            + f"\n{ACCOUNT_ID}\n{KEY_ID}\n".encode(),
        )
        self.assertEqual(
            admin.calls,
            [
                ("create_account", NAME),
                ("create_key", "account-id"),
                ("verify_account", "account-id", NAME, False),
                ("verify_key", "account-id", "key-id", False),
            ],
        )
        self.assertEqual(admin.issued, bytearray())

    def test_create_refusal_has_fixed_output_and_never_echoes_name_or_key(self):
        admin = FakeAdmin(create_error=RuntimeError("stand-in already exists"))
        status, stdout, stderr = self.run_tool(
            "create", source=(NAME + "\n").encode(), admin=admin
        )
        self.assertEqual((status, stdout, stderr), (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"))
        self.assertNotIn(NAME.encode(), stderr)
        self.assertNotIn(KEY, stderr)

    def test_place_rechecks_registry_and_exclusive_writes_private_files(self):
        source = (
            (NAME + "\n").encode()
            + KEY
            + f"\n{ACCOUNT_ID}\n{KEY_ID}\n".encode()
        )
        status, stdout, stderr = self.run_tool("place", source=source)

        self.assertEqual(
            (status, stdout, stderr),
            (0, f"KEY_PLACED bytes={len(KEY)}\n".encode(), b""),
        )
        self.assertEqual(self.key_path.read_bytes(), KEY + b"\n")
        self.assertEqual(
            json.loads(self.ids_path.read_text(encoding="utf-8")),
            {
                "format": 1,
                "account": NAME,
                "accountId": ACCOUNT_ID,
                "keyId": KEY_ID,
            },
        )
        for path in (self.key_path, self.ids_path):
            metadata = path.stat()
            self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
            self.assertEqual(metadata.st_uid, os.getuid())
            self.assertEqual(metadata.st_nlink, 1)
        self.assertNotIn(KEY, stdout + stderr)
        loaded = security.SecretKey.load(self.key_path)
        try:
            self.assertEqual(loaded.header(), b"Bearer " + KEY)
        finally:
            loaded.clear()

        status, stdout, stderr = self.run_tool("place", source=source)
        self.assertEqual((status, stdout, stderr), (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"))
        self.assertEqual(self.key_path.read_bytes(), KEY + b"\n")


    def test_place_refuses_malformed_carried_ids(self):
        for account_id, key_id in (
            ("bad/id", KEY_ID),
            (ACCOUNT_ID, ""),
            ("x" * 65, KEY_ID),
        ):
            with self.subTest(account_id=account_id, key_id=key_id):
                source = (
                    (NAME + "\n").encode()
                    + KEY
                    + f"\n{account_id}\n{key_id}\n".encode()
                )
                status, stdout, stderr = self.run_tool(
                    "place",
                    source=source,
                )
                self.assertEqual(
                    (status, stdout, stderr),
                    (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"),
                )
                self.assertFalse(self.key_path.exists())
                self.assertFalse(self.ids_path.exists())

    def test_create_refuses_malformed_returned_ids(self):
        for account_id, key_id in (
            ("bad/id", KEY_ID),
            (ACCOUNT_ID, ""),
            ("x" * 65, KEY_ID),
        ):
            with self.subTest(account_id=account_id, key_id=key_id):
                admin = FakeAdmin(account_id=account_id, key_id=key_id)
                status, stdout, stderr = self.run_tool(
                    "create",
                    source=(NAME + "\n").encode(),
                    admin=admin,
                )
                self.assertEqual(
                    (status, stdout, stderr),
                    (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"),
                )

    def test_place_fsync_failure_leaves_partial_file_for_operator_decision(self):
        source = (
            (NAME + "\n").encode()
            + KEY
            + f"\n{ACCOUNT_ID}\n{KEY_ID}\n".encode()
        )
        original_fsync = captain_account.os.fsync
        calls = 0

        def fail_first(descriptor):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("stand-in fsync failure")
            return original_fsync(descriptor)

        with mock.patch.object(captain_account.os, "fsync", side_effect=fail_first):
            status, stdout, stderr = self.run_tool("place", source=source)
        self.assertEqual((status, stdout, stderr), (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"))
        self.assertTrue(self.key_path.exists())
        self.assertNotIn(KEY, stdout + stderr)

    def test_activate_uses_live_ids_policy_and_rate_to_emit_readback(self):
        admin = FakeAdmin()
        status, stdout, stderr = self.run_tool(
            "activate",
            source=f"{NAME}\n{ACCOUNT_ID}\n{KEY_ID}\n".encode(),
            admin=admin,
        )

        self.assertEqual((status, stderr), (0, b""))
        readback = json.loads(stdout)
        self.assertEqual(
            readback,
            {
                "account": NAME,
                "mailbox": NAME,
                "permissions": sorted(stalwart_admin.ALLOWED_PERMISSIONS),
                "administrator": False,
                "impersonation": False,
                "requestsPerMinute": 120,
            },
        )
        self.assertEqual(
            admin.calls,
            [
                ("verify_account", "account-id", NAME, False),
                ("verify_key", "account-id", "key-id", False),
                ("activate_account", "account-id"),
                ("activate_key", "account-id", "key-id"),
                ("verify_account", "account-id", NAME, True),
                ("verify_key", "account-id", "key-id", True),
            ],
        )
        self.assertEqual(
            admin.transport.account_permissions,
            stalwart_admin.ACTIVE_PERMISSIONS,
        )
        self.assertEqual(
            admin.transport.key_permissions,
            stalwart_admin.ACTIVE_KEY_PERMISSIONS,
        )

    def test_activate_readback_refuses_swapped_permission_shapes(self):
        for attribute, wrong_shape in (
            ("account_permissions", stalwart_admin.ACTIVE_KEY_PERMISSIONS),
            ("key_permissions", stalwart_admin.ACTIVE_PERMISSIONS),
        ):
            with self.subTest(attribute=attribute):
                admin = FakeAdmin()
                setattr(admin.transport, attribute, copy.deepcopy(wrong_shape))
                status, stdout, stderr = self.run_tool(
                    "activate",
                    source=f"{NAME}\n{ACCOUNT_ID}\n{KEY_ID}\n".encode(),
                    admin=admin,
                )
                self.assertEqual(
                    (status, stdout, stderr),
                    (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"),
                )

    def test_activate_refuses_wrong_rate_period_or_bound(self):
        for rate, period in ((121, 60_000), (120, 1_000), (0, 60_000)):
            with self.subTest(rate=rate, period=period):
                admin = FakeAdmin(rate=rate, period=period)
                status, stdout, stderr = self.run_tool(
                    "activate",
                    source=f"{NAME}\n{ACCOUNT_ID}\n{KEY_ID}\n".encode(),
                    admin=admin,
                )
                self.assertEqual((status, stdout, stderr), (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"))
                self.assertNotIn(
                    "activate_account",
                    {call[0] for call in admin.calls},
                )

    def test_readback_verifies_lane_b_contract_and_exclusive_writes(self):
        document = {
            "account": NAME,
            "mailbox": NAME,
            "permissions": sorted(stalwart_admin.ALLOWED_PERMISSIONS),
            "administrator": False,
            "impersonation": False,
            "requestsPerMinute": 120,
        }
        status, stdout, stderr = self.run_tool(
            "readback", source=json.dumps(document).encode() + b"\n"
        )
        self.assertEqual((status, stdout, stderr), (0, b"READBACK_WRITTEN\n", b""))
        self.assertEqual(json.loads(self.readback_path.read_text()), document)
        self.assertEqual(stat.S_IMODE(self.readback_path.stat().st_mode), 0o600)

        document["administrator"] = True
        self.readback_path.unlink()
        status, stdout, stderr = self.run_tool(
            "readback", source=json.dumps(document).encode() + b"\n"
        )
        self.assertEqual((status, stdout, stderr), (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"))
        self.assertFalse(self.readback_path.exists())

    def test_revoke_removes_only_inactive_key_and_never_destroys_account(self):
        admin = FakeAdmin()
        status, stdout, stderr = self.run_tool(
            "revoke",
            source=f"{NAME}\n{ACCOUNT_ID}\n{KEY_ID}\n".encode(),
            admin=admin,
        )
        self.assertEqual((status, stdout, stderr), (0, b"KEY_REVOKED\n", b""))
        self.assertEqual(
            admin.calls,
            [
                ("verify_account", "account-id", NAME, False),
                ("verify_key", "account-id", "key-id", False),
                ("revoke_key", "account-id", "key-id"),
            ],
        )
        self.assertNotIn("destroy_account", {call[0] for call in admin.calls})

    def test_create_builds_the_existing_admin_adapter_from_helper_runtime(self):
        runtime_path = self.base / "helper-runtime.json"
        runtime_path.write_text(
            json.dumps(
                {
                    "format": 1,
                    "socket": {
                        "path": "/run/quarterdeck-control/helper.sock",
                        "group": 2400,
                    },
                    "joinUid": 2100,
                    "paths": {
                        "ledger": "/var/lib/quarterdeck-helper/prepared.sqlite",
                        "keys": "/var/lib/quarterdeck-helper/keys",
                        "adminSecret": "/run/quarterdeck-admin/credential",
                    },
                    "management": {
                        "username": "admin-standin",
                        "address": "127.0.0.1",
                        "port": 18080,
                    },
                    "mailDomain": "mail.example.invalid",
                    "sessionUrl": "https://mail.example.invalid/jmap/session",
                }
            ),
            encoding="utf-8",
        )
        runtime_path.chmod(0o600)
        reader = object()
        transport = object()
        admin = FakeAdmin()
        with (
            mock.patch.object(
                captain_account.management_transport,
                "PrivateSecretFile",
                return_value=reader,
            ) as secret_file,
            mock.patch.object(
                captain_account.management_transport,
                "ManagementTransport",
                return_value=transport,
            ) as management,
            mock.patch.object(
                captain_account.stalwart_admin,
                "StalwartAdmin",
                return_value=admin,
            ) as admin_type,
        ):
            status, stdout, stderr = self.run_tool(
                "create",
                source=(NAME + "\n").encode(),
            )

        self.assertEqual(status, 0)
        self.assertEqual(stderr, b"")
        self.assertEqual(
            stdout,
            (NAME + "\n").encode()
            + KEY
            + f"\n{ACCOUNT_ID}\n{KEY_ID}\n".encode(),
        )
        secret_file.assert_called_once_with("/run/quarterdeck-admin/credential")
        self.assertEqual(management.call_args.args[:2], ("admin-standin", reader))
        self.assertTrue(callable(management.call_args.kwargs["connection_factory"]))
        admin_type.assert_called_once_with(transport, "mail.example.invalid")

    def test_secret_pipe_tty_is_refused(self):
        stdout = TtyBytes()
        stderr = io.BytesIO()
        status = captain_account.run(
            "create",
            name_only=False,
            key_path=self.key_path,
            readback_path=self.readback_path,
            ids_path=self.ids_path,
            registry_path=self.registry_path,
            runtime_path=self.base / "helper-runtime.json",
            stdin=io.BytesIO((NAME + "\n").encode()),
            stdout=stdout,
            stderr=stderr,
            admin_factory=lambda path: FakeAdmin(),
        )
        self.assertEqual((status, stdout.getvalue(), stderr.getvalue()), (2, b"", b"CAPTAIN_ACCOUNT_REFUSED\n"))

    def test_fixed_paths_and_source_have_no_hardcoded_pilot_names_or_secret_channels(self):
        self.assertEqual(
            captain_account.KEY_PATH,
            Path("/run/quarterdeck-captain-mail/captain.key"),
        )
        self.assertEqual(
            captain_account.READBACK_PATH,
            Path("/var/lib/quarterdeck-captain/key-readback.json"),
        )
        self.assertEqual(
            captain_account.IDS_PATH,
            Path("/var/lib/quarterdeck-captain/captain-ids.json"),
        )
        source = Path(captain_account.__file__).read_text(encoding="utf-8").lower()
        for forbidden in ("iris", "fern", "dale", "os.environ", "logging"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
