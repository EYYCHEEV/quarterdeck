import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[1] / "mail"))

import qd_connect


NOT_A_REAL_API_KEY = bytearray(b"API_" + bytes([65]) * 43)


class FakeAdapter:
    def __init__(self, value, *, bot_name="new-bot"):
        self.value = value
        self.bot_name = bot_name
        self.saved = None

    def save(self, value):
        self.saved = bytearray(value)

    def read(self):
        if self.saved is not None:
            return bytearray(self.saved)
        return self.value


class FakeJmap:
    seen_header = None

    def __init__(self, session, credential, transport):
        self.session = session
        self.transport = transport
        FakeJmap.seen_header = credential.header()


class FakeMailbox:
    calls = []

    def __init__(self, jmap):
        self.jmap = jmap

    def send(self, recipient, subject, body, resend_key):
        self.calls.append(("send", recipient, subject, body, resend_key))
        return "message-id"

    def pending(self, after=None):
        self.calls.append(("pending", after))
        return [{"id": "message-id"}]

    def ack(self, message_id):
        self.calls.append(("ack", message_id))


class ConnectTests(unittest.TestCase):
    def setUp(self):
        FakeMailbox.calls = []
        FakeJmap.seen_header = None

    def service(self, key):
        return qd_connect.ConnectService(
            session_url="https://quarterdeck.example.test/.well-known/jmap",
            adapter=FakeAdapter(key),
            joiner=None,
            transport=object(),
        )

    def test_mail_actions_use_qd_jmap_library_bearer_key_in_memory_then_clear_it(self):
        key = bytearray(NOT_A_REAL_API_KEY)
        with (
            mock.patch.object(qd_connect.qd_jmap, "Jmap", FakeJmap),
            mock.patch.object(qd_connect.qd_jmap, "Mailbox", FakeMailbox),
        ):
            result = self.service(key).send("second-bot", "subject", "body", "resend-1")

        self.assertEqual(result, "message-id")
        self.assertEqual(FakeJmap.seen_header, b"Bearer " + NOT_A_REAL_API_KEY)
        self.assertEqual(FakeMailbox.calls, [("send", "second-bot", "subject", "body", "resend-1")])
        self.assertEqual(key, bytearray())

    def test_wait_and_ack_use_mailbox(self):
        with (
            mock.patch.object(qd_connect.qd_jmap, "Jmap", FakeJmap),
            mock.patch.object(qd_connect.qd_jmap, "Mailbox", FakeMailbox),
            mock.patch.object(qd_connect.qd_jmap, "wait", side_effect=lambda mailbox, after, timeout: mailbox.pending(after)),
        ):
            found = self.service(bytearray(NOT_A_REAL_API_KEY)).wait("cursor", 2.0)
            self.service(bytearray(NOT_A_REAL_API_KEY)).ack("message-id")
        self.assertEqual(found, [{"id": "message-id"}])
        self.assertEqual(FakeMailbox.calls, [("pending", "cursor"), ("ack", "message-id")])

    def test_old_raw_key_type_is_refused(self):
        with self.assertRaises(qd_connect.ConnectRefused):
            self.service(bytearray(bytes([66]) * 32)).ack("message-id")

    def test_file_adapter_invocation_is_fixed_and_contains_no_key(self):
        adapter = qd_connect.FileV1Adapter(
            executable="/opt/quarterdeck/signup/file_v1_adapter.py",
            registry="/etc/quarterdeck/adapter-registry.json",
            bot="new-bot",
            entry="primary",
        )
        argv, environment, cwd = adapter.invocation("save")
        self.assertEqual(
            argv,
            [
                "/opt/quarterdeck/signup/file_v1_adapter.py",
                "save",
                "/etc/quarterdeck/adapter-registry.json",
                "new-bot",
                "primary",
                "file-v1",
            ],
        )
        self.assertEqual(environment, {"PATH": "/usr/bin:/usr/sbin", "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(cwd, "/")
        self.assertNotIn(bytes(NOT_A_REAL_API_KEY).decode("ascii"), repr((argv, environment, cwd)))

    def test_file_adapter_uses_each_configured_identity_without_a_name_allowlist(self):
        for bot_name in ("bot-a", "bot-b", "bot-c", "bot-new"):
            with self.subTest(bot_name=bot_name):
                adapter = qd_connect.FileV1Adapter(
                    executable=(
                        "/opt/quarterdeck/signup/file_v1_adapter.py"
                    ),
                    registry=(
                        "/etc/quarterdeck/adapter-registry.json"
                    ),
                    bot=bot_name,
                    entry="primary",
                )
                argv, _, _ = adapter.invocation("read")
                self.assertEqual(adapter.bot_name, bot_name)
                self.assertEqual(argv[3], bot_name)

    def test_join_waits_for_approval_saves_reads_back_and_confirms(self):
        class Clock:
            def __init__(self):
                self.value = 1000.0

            def __call__(self):
                return self.value

            def sleep(self, amount):
                self.value += amount

        class Transport:
            def __init__(self):
                self.calls = []
                self.collects = 0

            def post(self, path, document):
                self.calls.append((path, set(document)))
                if path == "/qd/join/request":
                    return (
                        200,
                        {"content-type": "application/json", "cache-control": "no-store"},
                        bytearray(
                            json.dumps(
                                {
                                    "code": "ABCDEFGH",
                                    "bot": "new-bot",
                                    "pairing": base64.b64encode(b"P" * 32).decode("ascii"),
                                },
                                separators=(",", ":"),
                            ).encode("ascii")
                        ),
                    )
                if document["phase"] == "collect":
                    self.collects += 1
                    if self.collects == 1:
                        return (
                            403,
                            {"content-type": "application/json", "cache-control": "no-store"},
                            bytearray(b'{"error":"request could not be completed"}'),
                        )
                    header = json.dumps(
                        {
                            "code": "ABCDEFGH",
                            "bot": "new-bot",
                            "accountId": "account-1",
                            "keyId": "key-1",
                            "nonce": base64.b64encode(b"N" * 32).decode("ascii"),
                            "deadline": 1300.0,
                            "credentialBytes": len(NOT_A_REAL_API_KEY),
                        },
                        separators=(",", ":"),
                    ).encode("ascii")
                    return (
                        200,
                        {
                            "content-type": "application/vnd.quarterdeck.collect-v1",
                            "cache-control": "no-store",
                        },
                        bytearray(header + b"\n" + NOT_A_REAL_API_KEY),
                    )
                expected = qd_connect.confirmation_mac(
                    NOT_A_REAL_API_KEY,
                    b"N" * 32,
                    "ABCDEFGH",
                    "account-1",
                    "key-1",
                )
                if base64.b64decode(document["proof"], validate=True) != expected:
                    raise AssertionError("confirmation proof did not match")
                return (
                    200,
                    {"content-type": "application/json", "cache-control": "no-store"},
                    bytearray(b'{"ok":true,"bot":"new-bot"}'),
                )

        clock = Clock()
        transport = Transport()
        adapter = FakeAdapter(bytearray(), bot_name="new-bot")
        service = qd_connect.ConnectService(
            "https://quarterdeck.example.test/.well-known/jmap",
            adapter,
            qd_connect.PublicJoinClient(
                "https://quarterdeck.example.test", transport=transport
            ),
            clock=clock,
            sleeper=clock.sleep,
        )
        invite = bytearray(b"abcdefghijklmnopqrstuv")
        self.assertEqual(
            service.join("dogfood", invite),
            {"code": "ABCDEFGH", "bot": "new-bot", "status": "active"},
        )
        self.assertEqual(invite, bytearray())
        self.assertEqual(adapter.saved, NOT_A_REAL_API_KEY)
        self.assertEqual(
            transport.calls,
            [
                (
                    "/qd/join/request",
                    {"invite", "bot", "description"},
                ),
                ("/qd/join/collect", {"phase", "code", "bot", "pairing"}),
                ("/qd/join/collect", {"phase", "code", "bot", "pairing"}),
                (
                    "/qd/join/collect",
                    {"phase", "code", "bot", "pairing", "proof"},
                ),
            ],
        )

    def test_join_request_sends_the_one_use_invite_then_clears_its_buffer(self):
        class Transport:
            def __init__(self):
                self.document = None

            def post(self, path, document):
                self.document = document
                return (
                    200,
                    {
                        "content-type": "application/json",
                        "cache-control": "no-store",
                    },
                    bytearray(
                        json.dumps(
                            {
                                "code": "ABCDEFGH",
                                "bot": "new-bot",
                                "pairing": base64.b64encode(b"P" * 32).decode(
                                    "ascii"
                                ),
                            },
                            separators=(",", ":"),
                        ).encode("ascii")
                    ),
                )

        invite = bytearray(b"abcdefghijklmnopqrstuv")
        transport = Transport()
        started = qd_connect.PublicJoinClient(
            "https://approval.example.test",
            transport=transport,
        ).request("new-bot", "dogfood", invite)

        self.assertEqual(
            transport.document,
            {
                "invite": "abcdefghijklmnopqrstuv",
                "bot": "new-bot",
                "description": "dogfood",
            },
        )
        self.assertEqual(invite, bytearray())
        started.clear()

    def test_create_invite_uses_the_bot_key_in_memory_and_returns_only_the_shared_prompt(self):
        class Transport:
            def __init__(self):
                self.calls = []

            def post(self, path, document, *, bearer=None):
                self.calls.append(
                    (
                        path,
                        document,
                        bytes(bearer) if bearer is not None else None,
                    )
                )
                return (
                    200,
                    {
                        "content-type": "application/json",
                        "cache-control": "no-store",
                    },
                    bytearray(
                        json.dumps(
                            {"prompt": "two-step stand-in prompt"},
                            separators=(",", ":"),
                        ).encode("ascii")
                    ),
                )

        key = bytearray(NOT_A_REAL_API_KEY)
        transport = Transport()
        service = qd_connect.ConnectService(
            "https://approval.example.test/.well-known/jmap",
            FakeAdapter(key, bot_name="active-bot"),
            qd_connect.PublicJoinClient(
                "https://approval.example.test",
                transport=transport,
            ),
        )

        prompt = service.create_invite("target-bot")

        self.assertEqual(prompt, "two-step stand-in prompt")
        self.assertEqual(
            transport.calls,
            [
                (
                    "/qd/invite",
                    {"botName": "target-bot"},
                    bytes(NOT_A_REAL_API_KEY),
                )
            ],
        )
        self.assertEqual(key, bytearray())
        self.assertNotIn(
            bytes(NOT_A_REAL_API_KEY).decode("ascii"),
            prompt,
        )

    def test_settings_file_must_be_private_owned_and_not_linked(self):
        with tempfile.TemporaryDirectory() as directory:
            source = ROOT / "connect-config.json"
            settings = Path(directory) / "connect-config.json"
            settings.write_bytes(source.read_bytes())
            settings.chmod(0o600)

            self.assertEqual(
                qd_connect.load_config(settings),
                json.loads(source.read_text(encoding="utf-8")),
            )

            for mode in (0o640, 0o604):
                with self.subTest(mode=oct(mode)):
                    settings.chmod(mode)
                    with self.assertRaises(qd_connect.ConnectRefused):
                        qd_connect.load_config(settings)

            settings.chmod(0o600)
            linked = Path(directory) / "linked-config.json"
            linked.symlink_to(settings)
            with self.assertRaises(qd_connect.ConnectRefused):
                qd_connect.load_config(linked)

            hard_linked = Path(directory) / "hard-linked-config.json"
            os.link(settings, hard_linked)
            with self.assertRaises(qd_connect.ConnectRefused):
                qd_connect.load_config(settings)



if __name__ == "__main__":
    unittest.main(verbosity=2)
