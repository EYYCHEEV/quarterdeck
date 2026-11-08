from __future__ import annotations

import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock

from account_helper_standin import StandinAccountHelper
from signup_flow import (
    BotIdentity,
    InviteOffer,
    JoinService,
    SignupService,
    confirmation_mac,
)
import invite_prompt


import public_join

HELPER_SERVER_PATH = (
    Path(__file__).resolve().parents[1] / "helper" / "server.py"
)
spec = importlib.util.spec_from_file_location(
    "golive_helper_server_for_join_test", HELPER_SERVER_PATH
)
if spec is None or spec.loader is None:
    raise RuntimeError("helper server module unavailable")
helper_server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper_server
spec.loader.exec_module(helper_server)


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value


class PublicJoinTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.clock = Clock()
        self.joins = JoinService(
            self.base / "join.sqlite",
            clock=self.clock,
            invite_hmac_key=b"I" * 32,
        )
        self.helper = StandinAccountHelper()
        self.signup = SignupService(self.joins, self.helper)
        self.rates = public_join.JoinRateState(
            self.base / "rates.sqlite", clock=self.clock
        )
        self.app = public_join.JoinApplication(
            self.signup,
            self.rates,
            trusted_proxy="192.0.2.10",
            public_origin="https://approval.example.invalid",
        )

    @staticmethod
    def runtime_document(release):
        return {
            "format": 1,
            "bind": {"address": "service.internal", "port": 19090},
            "paths": {
                "database": "/var/lib/quarterdeck-join/state.sqlite",
                "rates": "/var/lib/quarterdeck-join/rates.sqlite",
                "helperSocket": "/run/quarterdeck-control/helper.sock",
                "approvalSocket": "/run/quarterdeck-approval/approve.sock",
                "inviteKey": "/var/lib/quarterdeck-join/invite-hmac.key",
            },
            "trustedProxy": "proxy.internal",
            "publicOrigin": "https://approval.example.invalid",
            "sessionUrl": "https://approval.example.invalid/.well-known/jmap",
            "approverUid": 2500,
            "approvalSocketAccess": {"mode": "0660", "gid": 2501},
            "release": release,
        }

    def test_runtime_release_is_exactly_pinned_or_unpublished(self):
        path = self.base / "runtime.json"
        pinned = {
            "artifactUrl": (
                "https://releases.example.invalid/"
                "quarterdeck_mcp-1.2.3-py3-none-any.whl"
            ),
            "version": "1.2.3",
            "sha256": "ab" * 32,
        }
        unpublished = {
            "artifactUrl": None,
            "version": None,
            "sha256": None,
        }
        for release in (pinned, unpublished):
            with self.subTest(release=release):
                path.write_text(
                    json.dumps(self.runtime_document(release)),
                    encoding="utf-8",
                )
                runtime = public_join.load_runtime_config(path)
                self.assertEqual(
                    (
                        runtime.release_artifact_url,
                        runtime.release_version,
                        runtime.release_sha256,
                    ),
                    (
                        release["artifactUrl"],
                        release["version"],
                        release["sha256"],
                    ),
                )

        invalid = [
            {
                "artifactUrl": pinned["artifactUrl"],
                "version": None,
                "sha256": None,
            },
            {**pinned, "sha256": "${QD_RELEASE_SHA256}"},
            {"artifactUrl": pinned["artifactUrl"], "version": pinned["version"]},
            {**pinned, "extra": "not-allowed"},
        ]
        for release in invalid:
            with self.subTest(invalid=release):
                path.write_text(
                    json.dumps(self.runtime_document(release)),
                    encoding="utf-8",
                )
                with self.assertRaises(public_join.JoinRefused):
                    public_join.load_runtime_config(path)

    @staticmethod
    def request(path, document, *, caller="198.51.100.20", peer="192.0.2.10"):
        return public_join.Request(
            "POST",
            path,
            {
                "Content-Type": "application/json",
                "X-Forwarded-For": caller,
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "approval.example.invalid",
            },
            bytearray(json.dumps(document, separators=(",", ":")).encode("ascii")),
            peer,
        )

    @staticmethod
    def json_body(response):
        return json.loads(bytes(response.body))

    def start(self, caller="198.51.100.20", bot="bot-a"):
        offer = self.joins._create_invite_verified("test-approver", bot)
        invite = offer.take_code()
        try:
            response = self.app.handle(
                self.request(
                    "/qd/join/request",
                    {
                        "invite": invite.decode("ascii"),
                        "bot": bot,
                        "description": "public join test",
                    },
                    caller=caller,
                )
            )
        finally:
            public_join.clear_buffer(invite)
        self.assertEqual(response.status, 200)
        result = self.json_body(response)
        response.clear()
        return result

    def test_request_collect_once_and_confirm_after_client_readback(self):
        started = self.start()
        self.joins._approve_verified(started["code"], "test-approver")

        collected = self.app.handle(
            self.request(
                "/qd/join/collect",
                {
                    "phase": "collect",
                    "code": started["code"],
                    "bot": started["bot"],
                    "pairing": started["pairing"],
                },
            )
        )
        self.assertEqual(collected.status, 200)
        self.assertIn(("Cache-Control", "no-store"), collected.headers)
        header_bytes, credential_bytes = bytes(collected.body).split(b"\n", 1)
        offer = json.loads(header_bytes)
        credential = bytearray(credential_bytes)
        self.assertEqual(len(credential), offer["credentialBytes"])
        self.assertNotIn(bytes(credential), header_bytes)
        collected.clear()

        proof = confirmation_mac(
            credential,
            base64.b64decode(offer["nonce"], validate=True),
            started["code"],
            offer["accountId"],
            offer["keyId"],
        )
        confirmed = self.app.handle(
            self.request(
                "/qd/join/collect",
                {
                    "phase": "confirm",
                    "code": started["code"],
                    "bot": started["bot"],
                    "pairing": started["pairing"],
                    "proof": base64.b64encode(proof).decode("ascii"),
                },
            )
        )
        credential[:] = b"\x00" * len(credential)
        credential.clear()

        self.assertEqual(confirmed.status, 200)
        self.assertEqual(self.json_body(confirmed), {"ok": True, "bot": "bot-a"})
        confirmed.clear()
        self.assertEqual(
            [action[0] for action in self.helper.actions],
            ["prepare", "activate"],
        )
        self.assertEqual(self.joins.safe_account_state("bot-a")["state"], "active")

        replay = self.app.handle(
            self.request(
                "/qd/join/collect",
                {
                    "phase": "collect",
                    "code": started["code"],
                    "bot": started["bot"],
                    "pairing": started["pairing"],
                },
            )
        )
        self.assertEqual(replay.status, 403)
        replay.clear()

    def test_invalid_invites_count_before_lookup_and_auto_ban_the_caller(self):
        statuses = []
        for _ in range(7):
            response = self.app.handle(
                self.request(
                    "/qd/join/request",
                    {
                        "invite": "not-a-valid-invite",
                        "bot": "bot-a",
                        "description": "uniform refusal test",
                    },
                )
            )
            statuses.append(response.status)
            self.assertEqual(
                self.json_body(response),
                {"error": public_join.PUBLIC_BODY},
            )
            response.clear()
        self.assertEqual(statuses, [403, 403, 429, 429, 429, 429, 429])

    def test_wrong_bound_bot_does_not_consume_invite_then_right_bot_joins(self):
        offer = self.joins._create_invite_verified(
            "test-approver", "right-bot"
        )
        invite = offer.take_code()
        try:
            wrong = self.app.handle(
                self.request(
                    "/qd/join/request",
                    {
                        "invite": invite.decode("ascii"),
                        "bot": "wrong-bot",
                        "description": "wrong bot test",
                    },
                )
            )
            self.assertEqual(wrong.status, 403)
            wrong.clear()

            right = self.app.handle(
                self.request(
                    "/qd/join/request",
                    {
                        "invite": invite.decode("ascii"),
                        "bot": "right-bot",
                        "description": "right bot test",
                    },
                    caller="198.51.100.21",
                )
            )
            self.assertEqual(right.status, 200)
            self.assertEqual(self.json_body(right)["bot"], "right-bot")
            right.clear()
        finally:
            public_join.clear_buffer(invite)

    def test_bot_invite_authenticator_resolves_the_jmap_bot_and_account_then_clears_the_key(self):
        seen = []

        class Jmap:
            def __init__(self, session_url, credential, transport):
                seen.append(
                    (session_url, credential.header(), transport)
                )
                self.account = "account-active"

        class Mailbox:
            def __init__(self, jmap):
                seen.append(("mailbox", jmap.account))
                self.bot = "active-bot"

        key = bytearray(b"API_" + b"A" * 43)
        transport = object()
        with (
            mock.patch.object(public_join.qd_jmap, "Jmap", Jmap),
            mock.patch.object(public_join.qd_jmap, "Mailbox", Mailbox),
        ):
            identity = public_join.BotInviteAuthenticator(
                "https://approval.example.invalid/.well-known/jmap",
                transport=transport,
            ).authenticate(key)

        self.assertEqual(identity.bot_name, "active-bot")
        self.assertEqual(identity.account_id, "account-active")
        self.assertEqual(
            seen,
            [
                (
                    "https://approval.example.invalid/.well-known/jmap",
                    b"Bearer API_" + b"A" * 43,
                    transport,
                ),
                ("mailbox", "account-active"),
            ],
        )
        self.assertEqual(key, bytearray())

    def test_active_bot_key_creates_one_invite_prompt_without_returning_the_key(self):
        class Authenticator:
            def __init__(self):
                self.key = None

            def authenticate(self, key):
                self.key = key
                return BotIdentity("active-bot", "account-active")

        class Invites:
            def __init__(self):
                self.calls = []

            def create_bot_invite(self, identity, bot_name):
                self.calls.append(
                    (identity.bot_name, identity.account_id, bot_name)
                )
                return InviteOffer(
                    "AAAAAAAAAAAA",
                    bot_name,
                    identity.bot_name,
                    1000.0,
                    87400.0,
                    bytearray(b"abcdefghijklmnopqrstuv"),
                )

        authenticator = Authenticator()
        invites = Invites()
        app = public_join.JoinApplication(
            self.signup,
            self.rates,
            trusted_proxy="192.0.2.10",
            public_origin="https://approval.example.invalid",
            invites=invites,
            invite_authenticator=authenticator,
            release=invite_prompt.ReleaseConfig(
                "https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
                "1.2.3",
                "ab" * 32,
                "https://approval.example.invalid",
            ),
        )
        key = "API_" + "A" * 43
        request = self.request(
            "/qd/invite",
            {"botName": "target-bot"},
        )
        request.headers["Authorization"] = f"Bearer {key}"
        created = app.handle(request)

        self.assertEqual(created.status, 200)
        self.assertIn(("Cache-Control", "no-store"), created.headers)
        document = self.json_body(created)
        self.assertEqual(set(document), {"prompt"})
        self.assertIn("quarterdeck_mcp-1.2.3", document["prompt"])
        self.assertIn("abcdefghijklmnopqrstuv", document["prompt"])
        self.assertNotIn(key, document["prompt"])
        self.assertEqual(
            invites.calls,
            [("active-bot", "account-active", "target-bot")],
        )
        self.assertEqual(authenticator.key, bytearray())
        created.clear()

    def test_failed_pairing_attempts_count_and_auto_ban_only_that_caller(self):
        started = self.start()
        self.joins._approve_verified(started["code"], "test-approver")
        bad_pairing = base64.b64encode(bytes([9]) * 32).decode("ascii")
        request = {
            "phase": "collect",
            "code": started["code"],
            "bot": started["bot"],
            "pairing": bad_pairing,
        }

        for _ in range(30):
            refused = self.app.handle(
                self.request("/qd/join/collect", request)
            )
            self.assertEqual(refused.status, 403)
            refused.clear()
        banned = self.app.handle(
            self.request("/qd/join/collect", request)
        )
        self.assertEqual(banned.status, 429)
        banned.clear()
        other_started = self.start(
            caller="198.51.100.21",
            bot="bot-b",
        )
        self.joins._approve_verified(
            other_started["code"], "test-approver"
        )
        valid_other_caller = self.app.handle(
            self.request(
                "/qd/join/collect",
                {
                    "phase": "collect",
                    "code": other_started["code"],
                    "bot": other_started["bot"],
                    "pairing": other_started["pairing"],
                },
                caller="198.51.100.21",
            )
        )
        self.assertEqual(valid_other_caller.status, 200)
        valid_other_caller.clear()
    def test_helper_socket_client_round_trips_the_final_contract(self):
        helper = StandinAccountHelper()
        ledger = helper_server.MemoryLedger()
        threads = []

        def connector():
            local, remote = socket.socketpair()
            thread = threading.Thread(
                target=helper_server.HelperSocketHandler(
                    helper, os.getuid(), ledger
                ).handle,
                args=(remote,),
            )
            thread.start()
            threads.append((thread, remote))
            return local

        client = public_join.HelperSocketClient(
            "/private/helper.sock", connector=connector
        )
        prepared = client.prepare_collect(
            public_join.ApprovedJoin("ABCDEFGH", "bot-a")
        )
        credential = prepared.take_credential()
        self.assertEqual(credential, bytearray(b"API_" + b"A" * 36))
        credential[:] = b"\x00" * len(credential)
        credential.clear()
        record = client.activate_collect(prepared.target)
        replacement = client.replace(record)
        client.cancel(replacement)

        second = client.prepare_collect(
            public_join.ApprovedJoin("BCDEFGH2", "bot-b")
        )
        second.clear()
        client.rollback_collect(second.target)

        for thread, remote in threads:
            thread.join(2)
            remote.close()
            self.assertFalse(thread.is_alive())
        self.assertEqual(
            [action[0] for action in helper.actions],
            [
                "prepare",
                "activate",
                "replace",
                "cancel",
                "prepare",
                "rollback",
            ],
        )

    def test_periodic_recovery_revokes_an_expired_offer_without_a_direct_recovery_call(self):
        started = self.start()
        self.joins._approve_verified(started["code"], "test-approver")
        collected = self.app.handle(
            self.request(
                "/qd/join/collect",
                {
                    "phase": "collect",
                    "code": started["code"],
                    "bot": started["bot"],
                    "pairing": started["pairing"],
                },
            )
        )
        self.assertEqual(collected.status, 200)
        collected.clear()

        class OneTick:
            def __init__(inner_self):
                inner_self.calls = 0

            def wait(inner_self, _seconds):
                inner_self.calls += 1
                if inner_self.calls == 1:
                    self.clock.value += 1000
                    return False
                return True

            def set(inner_self):
                inner_self.calls = 2

        scheduler = public_join.PeriodicRecovery(
            self.signup,
            interval=60,
            stop_event=OneTick(),
        )
        scheduler.start(lambda: self.fail("periodic recovery failed"))
        scheduler.join(2)

        self.assertIsNone(scheduler.failure)
        self.assertEqual(
            [action[0] for action in self.helper.actions],
            ["prepare", "rollback"],
        )

    def test_invite_hmac_key_loader_requires_private_single_owner_file(self):
        path = self.base / "invite-hmac.key"
        path.write_bytes(b"I" * 32)
        os.chmod(path, 0o600)

        loaded = public_join._load_invite_hmac_key(path)
        self.assertEqual(loaded, bytearray(b"I" * 32))
        public_join.clear_buffer(loaded)

        os.chmod(path, 0o640)
        with self.assertRaises(public_join.JoinRefused):
            public_join._load_invite_hmac_key(path)

    def test_shared_approval_socket_allows_approval_identity_and_refuses_every_other_peer(self):
        temporary = tempfile.TemporaryDirectory(prefix="qds-", dir="/tmp")
        self.addCleanup(temporary.cleanup)
        socket_directory = Path(temporary.name)
        os.chmod(socket_directory, 0o2770)
        socket_path = socket_directory / "approve.sock"

        def run_once():
            ready = threading.Event()
            service = public_join.approval_service.ApprovalService(
                self.joins,
                socket_path,
                expected_uid=os.getuid(),
                actor_for_uid=lambda uid: (
                    public_join.approval_service.APPROVER_ROLE
                    if uid == os.getuid()
                    else ""
                ),
                socket_mode=0o660,
                socket_gid=os.getgid(),
            )
            thread = threading.Thread(
                target=service.serve_once,
                kwargs={"ready": ready},
                daemon=True,
            )
            thread.start()
            self.assertTrue(ready.wait(2))
            return thread

        allowed = run_once()
        self.assertEqual(
            public_join.approval_service.request_pending(socket_path),
            [],
        )
        allowed.join(2)
        self.assertFalse(allowed.is_alive())

        with mock.patch.object(
            public_join.approval_service,
            "_peer_uid",
            return_value=os.getuid() + 1,
        ):
            refused = run_once()
            self.assertIsNone(
                public_join.approval_service.request_pending(socket_path)
            )
            refused.join(2)
        self.assertFalse(refused.is_alive())

    def test_main_recovers_before_starting_private_approval_and_http_services(self):
        events = []
        runtime = public_join.RuntimeConfig(
            bind_address="service.internal",
            bind_port=19090,
            database_path="/state/join.sqlite",
            rates_path="/state/rates.sqlite",
            helper_socket="/run/helper.sock",
            approval_socket="/run/approve.sock",
            invite_key_path="/run/invite.key",
            trusted_proxy="192.0.2.10",
            public_origin="https://approval.example.invalid",
            session_url=(
                "https://approval.example.invalid/.well-known/jmap"
            ),
            approver_uid=2500,
            approval_socket_mode=0o660,
            approval_socket_gid=2501,
            release_artifact_url=(
                "https://releases.example.invalid/"
                "quarterdeck_mcp-1.2.3-py3-none-any.whl"
            ),
            release_version="1.2.3",
            release_sha256="ab" * 32,
        )

        class Joins:
            def __init__(self, path, *, invite_hmac_key):
                events.append(
                    ("joins", str(path), bytes(invite_hmac_key))
                )

        class HelperClient:
            def __init__(self, path):
                events.append(("helper", str(path)))

        class Signup:
            def __init__(self, joins, helper):
                events.append(
                    (
                        "signup",
                        joins.__class__.__name__,
                        helper.__class__.__name__,
                    )
                )

            def recover_unfinished(self, startup):
                events.append(("recover", startup))
                return 0

        class Rates:
            def __init__(self, path):
                events.append(("rates", str(path)))

        class Application:
            def __init__(self, signup, rates, **values):
                events.append(("application", values))

        class Approval:
            def __init__(
                self,
                joins,
                path,
                expected_uid,
                actor_for_uid,
                *,
                socket_mode,
                socket_gid,
            ):
                events.append(
                    (
                        "approval",
                        str(path),
                        expected_uid,
                        actor_for_uid(expected_uid),
                        socket_mode,
                        socket_gid,
                    )
                )

            def serve_forever(self):
                events.append(("approval-serve",))

        class Thread:
            def __init__(self, *, target, name, daemon):
                events.append(("thread", name, daemon))
                self.target = target

            def start(self):
                events.append(("thread-start",))


        key = bytearray(b"I" * 32)
        with (
            mock.patch.object(
                public_join.sys,
                "argv",
                ["public_join.py", "--config", "runtime.json"],
            ),
            mock.patch.object(
                public_join,
                "load_runtime_config",
                return_value=runtime,
            ),
            mock.patch.object(
                public_join,
                "_load_invite_hmac_key",
                return_value=key,
            ),
            mock.patch.object(public_join, "JoinService", Joins),
            mock.patch.object(
                public_join,
                "HelperSocketClient",
                HelperClient,
            ),
            mock.patch.object(public_join, "SignupService", Signup),
            mock.patch.object(public_join, "JoinRateState", Rates),
            mock.patch.object(public_join, "JoinApplication", Application),
            mock.patch.object(
                public_join.approval_service,
                "ApprovalService",
                Approval,
            ),
            mock.patch.object(public_join.threading, "Thread", Thread),
            mock.patch.object(public_join, "serve") as serve,
        ):
            self.assertEqual(public_join.main(), 0)

        self.assertLess(
            events.index(("recover", True)),
            events.index(("thread-start",)),
        )
        self.assertLess(
            events.index(("recover", True)),
            next(
                index
                for index, event in enumerate(events)
                if event[0] == "application"
            ),
        )
        self.assertIn(
            (
                "approval",
                "/run/approve.sock",
                2500,
                "qd-approver",
                0o660,
                2501,
            ),
            events,
        )
        serve.assert_called_once()
        self.assertEqual(
            serve.call_args.args[1:3],
            ("service.internal", 19090),
        )
        self.assertIsInstance(
            serve.call_args.args[3],
            public_join.PeriodicRecovery,
        )
        self.assertEqual(key, bytearray())

    def test_untrusted_or_ambiguous_forwarding_is_refused_before_signup(self):
        untrusted = self.app.handle(
            self.request(
                "/qd/join/request",
                {"bot": "bot-a", "description": "test"},
                peer="192.0.2.11",
            )
        )
        self.assertEqual(untrusted.status, 403)
        untrusted.clear()

        ambiguous = self.app.handle(
            self.request(
                "/qd/join/request",
                {"bot": "bot-a", "description": "test"},
                caller="198.51.100.20, 198.51.100.21",
            )
        )
        self.assertEqual(ambiguous.status, 403)
        ambiguous.clear()
        self.assertEqual(self.helper.actions, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
