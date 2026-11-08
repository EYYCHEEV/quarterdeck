from __future__ import annotations

import json
import os
import socket
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from helper_contract import ApprovedJoin, BotRecord, CollectTarget, PreparedCollect

import server


class FakeHelper:
    def __init__(self):
        self.calls = []
        self.credentials = []

    def prepare_collect(self, join):
        self.calls.append(("prepare", join.approval_id, join.bot_name))
        credential = bytearray(b"API_" + b"A" * 36)
        self.credentials.append(credential)
        target = CollectTarget(join.bot_name, "account-1", "key-1", "receipt-1")
        return PreparedCollect(target, credential)

    def activate_collect(self, target):
        self.calls.append(("activate", target))
        return BotRecord(
            target.bot_name,
            target.account_id,
            target.key_id,
            target.helper_receipt,
        )

    def rollback_collect(self, target):
        self.calls.append(("rollback", target))

    def replace(self, record):
        self.calls.append(("replace", record))
        return BotRecord(record.bot_name, record.account_id, "key-2", "receipt-2")

    def cancel(self, record):
        self.calls.append(("cancel", record))


class HelperServerTests(unittest.TestCase):
    def exchange(self, request, *, ledger=None):
        service = FakeHelper()
        local, remote = socket.socketpair()
        thread = threading.Thread(
            target=server.HelperSocketHandler(
                service, os.getuid(), ledger
            ).handle,
            args=(remote,),
        )
        thread.start()
        local.sendall(json.dumps(request, separators=(",", ":")).encode("ascii") + b"\n")
        header = bytearray()
        while b"\n" not in header:
            header.extend(local.recv(4096))
        line, remainder = header.split(b"\n", 1)
        response = json.loads(line)
        credential = bytearray(remainder)
        expected = response.get("credentialBytes", 0)
        while len(credential) < expected:
            credential.extend(local.recv(expected - len(credential)))
        local.close()
        thread.join(2)
        remote.close()
        self.assertFalse(thread.is_alive())
        return service, response, credential

    def test_prepare_sends_one_raw_credential_then_clears_server_buffer(self):
        service, response, credential = self.exchange(
            {"action": "prepare", "approvalId": "ABCDEFGH", "botName": "bot-a"}
        )

        self.assertEqual(
            response,
            {
                "ok": True,
                "target": {
                    "botName": "bot-a",
                    "accountId": "account-1",
                    "keyId": "key-1",
                    "helperReceipt": "receipt-1",
                },
                "credentialBytes": 40,
            },
        )
        self.assertEqual(credential, bytearray(b"API_" + b"A" * 36))
        self.assertEqual(service.credentials[0], bytearray())
        self.assertEqual(service.calls, [("prepare", "ABCDEFGH", "bot-a")])

    def test_activate_and_rollback_accept_only_final_contract_shapes(self):
        target = {
            "botName": "bot-a",
            "accountId": "account-1",
            "keyId": "key-1",
            "helperReceipt": "receipt-1",
        }
        ledger = server.MemoryLedger()
        ledger.store(
            CollectTarget("bot-a", "account-1", "key-1", "receipt-1")
        )
        service, response, credential = self.exchange(
            {"action": "activate", "target": target},
            ledger=ledger,
        )
        self.assertEqual(
            response,
            {
                "ok": True,
                "record": {
                    "botName": "bot-a",
                    "accountId": "account-1",
                    "keyId": "key-1",
                    "adapterReceipt": "receipt-1",
                },
            },
        )
        self.assertEqual(credential, bytearray())
        self.assertEqual(service.calls[0][0], "activate")

        service, response, _ = self.exchange(
            {"action": "rollback", "target": target}
        )
        self.assertEqual(response, {"ok": True})
        self.assertEqual(service.calls[0][0], "rollback")

        _, refused, _ = self.exchange(
            {"action": "activate", "target": {**target, "extra": "refuse"}}
        )
        self.assertEqual(refused, {"ok": False})

    def test_peer_other_than_join_role_is_refused_before_helper_call(self):
        service = FakeHelper()
        local, remote = socket.socketpair()
        with mock.patch.object(server, "_peer_uid", return_value=os.getuid() + 1):
            thread = threading.Thread(
                target=server.HelperSocketHandler(service, os.getuid()).handle,
                args=(remote,),
            )
            thread.start()
            local.sendall(
                b'{"action":"prepare","approvalId":"ABCDEFGH","botName":"bot-a"}\n'
            )
            self.assertEqual(local.recv(64), b'{"ok":false}\n')
            thread.join(2)
        local.close()
        remote.close()
        self.assertEqual(service.calls, [])

    def test_prepared_target_ledger_recovers_without_storing_credential(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            os.chmod(root, 0o700)
            ledger = server.PreparedLedger(root / "prepared.sqlite")
            target = CollectTarget(
                "bot-a", "account-1", "key-1", "receipt-1"
            )
            ledger.store(target)
            helper_service = FakeHelper()

            self.assertEqual(ledger.pending(), [target])
            self.assertNotIn(
                b"API_", (root / "prepared.sqlite").read_bytes()
            )
            self.assertEqual(
                server.recover_prepared(helper_service, ledger), 1
            )
            self.assertEqual(ledger.pending(), [])
            self.assertEqual(helper_service.calls, [("rollback", target)])

    def test_private_adapter_round_trip_and_idempotent_retirement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            os.chmod(root, 0o700)
            adapter = server.PrivateKeyAdapter(root, token_hex=lambda size: "a" * (size * 2))
            original = bytearray(b"API_" + b"B" * 36)
            receipt = adapter.save("bot-a", original)
            key_path = root / receipt

            self.assertEqual(adapter.read(receipt), original)
            self.assertEqual(stat.S_IMODE(key_path.stat().st_mode), 0o600)
            adapter.retire(receipt, "test")
            adapter.retire(receipt, "test")
            self.assertFalse(key_path.exists())


    def test_configured_entrypoint_builds_dependencies_recovers_then_serves_prepare_and_rollback(self):
        runtime = server.RuntimeConfig(
            socket_path="/run/quarterdeck-control/helper.sock",
            socket_group=2400,
            expected_uid=2100,
            ledger_path="/var/lib/quarterdeck-helper/prepared.sqlite",
            key_directory="/var/lib/quarterdeck-helper/keys",
            admin_secret_path="/run/quarterdeck-admin/credential",
            admin_username="quarterdeck-admin",
            management_address="::1",
            management_port=19081,
            mail_domain="example.invalid",
            session_url="https://mail.example.invalid/.well-known/jmap",
        )
        events = []
        service = FakeHelper()
        ledger = server.MemoryLedger()

        def serve(handler, socket_path, socket_group):
            events.append(("serve", socket_path, socket_group))
            for request in (
                {
                    "action": "prepare",
                    "approvalId": "ABCDEFGH",
                    "botName": "bot-a",
                },
                {
                    "action": "rollback",
                    "target": {
                        "botName": "bot-a",
                        "accountId": "account-1",
                        "keyId": "key-1",
                        "helperReceipt": "receipt-1",
                    },
                },
            ):
                local, remote = socket.socketpair()
                thread = threading.Thread(target=handler.handle, args=(remote,))
                thread.start()
                local.sendall(
                    json.dumps(request, separators=(",", ":")).encode("ascii")
                    + b"\n"
                )
                header = bytearray()
                while b"\n" not in header:
                    header.extend(local.recv(8192))
                line, remainder = header.split(b"\n", 1)
                response = json.loads(line)
                credential = bytearray(remainder)
                expected = response.get("credentialBytes", 0)
                while len(credential) < expected:
                    credential.extend(local.recv(expected - len(credential)))
                local.close()
                thread.join(2)
                remote.close()
                self.assertFalse(thread.is_alive())
                self.assertTrue(response["ok"])

        with (
            mock.patch.object(server, "load_runtime_config", return_value=runtime),
            mock.patch.object(
                server.management_transport,
                "PrivateSecretFile",
                return_value="secret-reader",
            ) as secret_reader,
            mock.patch.object(
                server.management_transport,
                "ManagementTransport",
                return_value="management-transport",
            ) as management,
            mock.patch.object(
                server.stalwart_admin,
                "StalwartAdmin",
                return_value="stalwart-admin",
            ) as admin,
            mock.patch.object(
                server,
                "PrivateKeyAdapter",
                return_value="private-adapter",
            ) as adapter,
            mock.patch.object(
                server.jmap_verifier,
                "JmapVerifier",
                return_value="jmap-verifier",
            ) as verifier,
            mock.patch.object(
                server.helper,
                "ThreeActionHelper",
                return_value=service,
            ) as helper_service,
            mock.patch.object(
                server,
                "PreparedLedger",
                return_value=ledger,
            ) as prepared_ledger,
            mock.patch.object(
                server,
                "recover_prepared",
                side_effect=lambda _helper, _ledger: events.append(("recover",))
                or 0,
            ),
            mock.patch.object(server, "_peer_uid", return_value=2100),
            mock.patch.object(server, "serve", side_effect=serve),
        ):
            self.assertEqual(
                server.main(["--config", "/var/lib/quarterdeck-helper/runtime.json"]),
                0,
            )

        self.assertEqual(events[0], ("recover",))
        self.assertEqual(
            events[1],
            ("serve", "/run/quarterdeck-control/helper.sock", 2400),
        )
        self.assertEqual(
            service.calls,
            [
                ("prepare", "ABCDEFGH", "bot-a"),
                (
                    "rollback",
                    CollectTarget(
                        "bot-a",
                        "account-1",
                        "key-1",
                        "receipt-1",
                    ),
                ),
            ],
        )
        secret_reader.assert_called_once_with(
            "/run/quarterdeck-admin/credential"
        )
        management.assert_called_once()
        admin.assert_called_once_with("management-transport", "example.invalid")
        adapter.assert_called_once_with("/var/lib/quarterdeck-helper/keys")
        verifier.assert_called_once_with(
            "https://mail.example.invalid/.well-known/jmap"
        )
        helper_service.assert_called_once_with(
            "stalwart-admin",
            "private-adapter",
            "jmap-verifier",
        )
        prepared_ledger.assert_called_once_with(
            "/var/lib/quarterdeck-helper/prepared.sqlite"
        )

if __name__ == "__main__":
    unittest.main(verbosity=2)
