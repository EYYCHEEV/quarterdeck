from __future__ import annotations

from contextlib import closing
import json
import os
import socket
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import approval_service
import signup_flow
from signup_flow import JoinService, PAIRING_BYTES, PublicFailure

ACCOUNT_SENTINEL = "ACCOUNT_SENTINEL_NOT_REAL"
KEY_SENTINEL = "KEY_SENTINEL_NOT_REAL"
RECEIPT_SENTINEL = "RECEIPT_SENTINEL_NOT_REAL"
DESCRIPTION_SENTINEL = "DESCRIPTION_SENTINEL_NOT_REAL"
REFUSAL = {"ok": False}


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value


def names_of(count):
    return [f"bot-{index:02d}" for index in range(count)]


class JoinFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.database = self.base / "state.sqlite"
        self.socket_directory = self.base / "s"
        self.socket_directory.mkdir()
        os.chmod(self.socket_directory, 0o2770)
        self.socket_path = self.socket_directory / "a.sock"
        self.clock = Clock()
        self.service = JoinService(
            self.database,
            self.clock,
            invite_hmac_key=b"I" * 32,
        )
        self.thread_errors = []
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.assert_no_thread_errors)

    def assert_no_thread_errors(self):
        self.assertEqual(self.thread_errors, [])

    def insert_record(self, bot_name, state):
        if state == "provisioning":
            values = (bot_name, None, None, None, state)
        else:
            values = (
                bot_name,
                ACCOUNT_SENTINEL,
                KEY_SENTINEL,
                RECEIPT_SENTINEL,
                state,
            )
        with closing(sqlite3.connect(self.database)) as database:
            database.execute(
                "INSERT INTO helper_record "
                "(bot_name, account_id, key_id, adapter_receipt, state) "
                "VALUES (?, ?, ?, ?, ?)",
                values,
            )
            database.commit()

    def insert_active(self, *names):
        for name in names:
            self.insert_record(name, "active")

    def set_state(self, bot_name, state):
        with closing(sqlite3.connect(self.database)) as database:
            database.execute(
                "UPDATE helper_record SET state = ? WHERE bot_name = ?",
                (state, bot_name),
            )
            database.commit()

    def remove_record(self, bot_name):
        with closing(sqlite3.connect(self.database)) as database:
            database.execute(
                "DELETE FROM helper_record WHERE bot_name = ?",
                (bot_name,),
            )
            database.commit()

    def clear_records(self):
        with closing(sqlite3.connect(self.database)) as database:
            database.execute("DELETE FROM helper_record")
            database.commit()

    def audit_count(self):
        with closing(sqlite3.connect(self.database)) as database:
            return database.execute("SELECT count(*) FROM audit").fetchone()[0]

    def request_join(self, bot_name):
        invite = self.service._create_invite_verified(
            "qd-approver",
            bot_name,
        ).take_code()
        pairing = bytearray(b"P" * PAIRING_BYTES)
        try:
            return self.service.request_join(
                invite,
                bot_name,
                DESCRIPTION_SENTINEL,
                pairing,
            )
        finally:
            invite[:] = b"\x00" * len(invite)
            invite.clear()
            pairing[:] = b"\x00" * len(pairing)
            pairing.clear()

    def serve_once(self, expected_uid, actor="qd-approver"):
        server = approval_service.ApprovalService(
            self.service,
            self.socket_path,
            expected_uid=expected_uid,
            actor_for_uid=lambda uid: actor,
            socket_mode=0o660,
            socket_gid=os.getgid(),
        )
        ready = threading.Event()

        def run():
            try:
                server.serve_once(ready=ready)
            except BaseException as error:
                self.thread_errors.append(repr(error))

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(2))
        return thread

    def exchange(self, payload, expected_uid=None, actor="qd-approver"):
        thread = self.serve_once(
            os.getuid() if expected_uid is None else expected_uid,
            actor,
        )
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(5)
        try:
            client.connect(str(self.socket_path))
            try:
                client.sendall(payload)
                client.shutdown(socket.SHUT_WR)
            except (BrokenPipeError, ConnectionResetError):
                pass
            answer = bytearray()
            while b"\n" not in answer:
                chunk = client.recv(4096)
                if not chunk:
                    break
                answer.extend(chunk)
        finally:
            client.close()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        return bytes(answer)

    def list_bots_raw(self, **options):
        return self.exchange(b'{"action":"listBots"}\n', **options)

    def list_bots(self, **options):
        return json.loads(self.list_bots_raw(**options))


class ActiveBotNamesTests(JoinFixture):
    def test_empty_database_gives_an_empty_list(self):
        names = self.service.active_bot_names()
        self.assertIsInstance(names, list)
        self.assertEqual(names, [])

    def test_only_active_records_are_listed(self):
        self.insert_record("kept-one", "active")
        self.insert_record("still-joining", "provisioning")
        self.insert_record("removed", "cancelled")
        self.insert_record("kept-two", "active")
        names = self.service.active_bot_names()
        self.assertEqual(names, ["kept-one", "kept-two"])
        for name in names:
            self.assertIsInstance(name, str)

    def test_names_come_back_in_join_order_not_alphabetical(self):
        self.insert_active("zeta", "alpha", "mid")
        self.assertEqual(self.service.active_bot_names(), ["zeta", "alpha", "mid"])

    def test_a_removed_bot_that_joins_again_goes_to_the_end(self):
        self.insert_active("alpha", "beta", "gamma")
        self.set_state("alpha", "cancelled")
        self.assertEqual(self.service.active_bot_names(), ["beta", "gamma"])
        self.remove_record("alpha")
        self.insert_record("alpha", "provisioning")
        self.assertEqual(self.service.active_bot_names(), ["beta", "gamma"])
        with closing(sqlite3.connect(self.database)) as database:
            database.execute(
                "UPDATE helper_record SET account_id = ?, key_id = ?, adapter_receipt = ?, state = 'active' "
                "WHERE bot_name = 'alpha'",
                (ACCOUNT_SENTINEL, KEY_SENTINEL, RECEIPT_SENTINEL),
            )
            database.commit()
        self.assertEqual(self.service.active_bot_names(), ["beta", "gamma", "alpha"])

    def test_a_removal_drops_the_name_at_the_next_call(self):
        self.insert_active("alpha", "beta")
        self.assertEqual(self.service.active_bot_names(), ["alpha", "beta"])
        self.set_state("alpha", "cancelled")
        self.assertEqual(self.service.active_bot_names(), ["beta"])

    def test_the_call_changes_nothing_and_writes_no_audit_row(self):
        self.insert_active("alpha", "beta")
        self.insert_record("joining", "provisioning")
        self.request_join("pending-bot")
        before_bytes = self.database.read_bytes()
        before_audit = self.audit_count()
        for _ in range(3):
            self.service.active_bot_names()
        self.assertEqual(self.audit_count(), before_audit)
        self.assertEqual(self.database.read_bytes(), before_bytes)

    def test_every_name_must_match_the_bot_name_grammar(self):
        bad_names = [
            "Bad",
            "bad_name",
            "bad name",
            "1abc",
            "-abc",
            "",
            "a" * 33,
            "abc\n",
            "abc.def",
            "caf\u00e9",
        ]
        for bad in bad_names:
            with self.subTest(name=bad):
                self.clear_records()
                self.insert_active("fine-one", bad, "fine-two")
                with self.assertRaises(PublicFailure):
                    self.service.active_bot_names()

    def test_the_longest_and_shortest_legal_names_pass(self):
        self.insert_active("a", "b" + "9" * 31, "c-d-9")
        self.assertEqual(
            self.service.active_bot_names(),
            ["a", "b" + "9" * 31, "c-d-9"],
        )

    def test_a_name_that_is_not_text_is_refused(self):
        for bad in (None, b"alpha"):
            with self.subTest(name=bad):
                self.clear_records()
                self.insert_active("fine-one")
                self.insert_active(bad)
                with self.assertRaises(PublicFailure):
                    self.service.active_bot_names()

    def test_a_database_failure_is_the_fixed_public_failure(self):
        for error in (
            sqlite3.OperationalError("database is locked"),
            sqlite3.DatabaseError("broken"),
        ):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(self.service, "_connect", side_effect=error):
                    with self.assertRaises(PublicFailure) as caught:
                        self.service.active_bot_names()
                self.assertEqual(str(caught.exception), signup_flow.PUBLIC_FAILURE)

    def test_a_failed_query_is_the_fixed_public_failure(self):
        self.insert_active("alpha")
        real_connect = self.service._connect

        def broken_connect():
            database = real_connect()
            database.execute("ALTER TABLE helper_record RENAME TO helper_record_gone")
            return database

        with mock.patch.object(self.service, "_connect", broken_connect):
            with self.assertRaises(PublicFailure):
                self.service.active_bot_names()


class ListBotsSocketTests(JoinFixture):
    def test_active_names_come_back_in_join_order(self):
        self.insert_record("zeta", "active")
        self.insert_record("middle", "provisioning")
        self.insert_record("alpha", "active")
        self.insert_record("gone", "cancelled")
        self.insert_record("beta", "active")
        self.assertEqual(
            self.list_bots(),
            {"ok": True, "bots": ["zeta", "alpha", "beta"]},
        )

    def test_empty_database_answers_an_empty_list(self):
        self.assertEqual(self.list_bots(), {"ok": True, "bots": []})

    def test_the_answer_keys_are_exactly_ok_and_bots(self):
        self.insert_active("alpha", "beta")
        answer = self.list_bots()
        self.assertEqual(list(answer), ["ok", "bots"])
        self.assertIs(answer["ok"], True)
        self.assertEqual(answer["bots"], ["alpha", "beta"])
        for name in answer["bots"]:
            self.assertIsInstance(name, str)

    def test_the_answer_never_carries_keys_codes_descriptions_or_ids(self):
        code = self.request_join("pending-bot")
        self.insert_active("alpha", "beta")
        self.insert_record("joining", "provisioning")
        self.insert_record("removed", "cancelled")
        invite = self.service._create_invite_verified("qd-approver", "invited-bot")
        invite_id = invite.invite_id
        invite.clear()
        raw = self.list_bots_raw()
        self.assertEqual(raw, b'{"ok":true,"bots":["alpha","beta"]}\n')
        for forbidden in (
            ACCOUNT_SENTINEL,
            KEY_SENTINEL,
            RECEIPT_SENTINEL,
            DESCRIPTION_SENTINEL,
            code,
            invite_id,
            "pending-bot",
            "invited-bot",
            "joining",
            "removed",
            "provisioning",
            "cancelled",
            "state",
            "account",
            "key",
        ):
            self.assertNotIn(forbidden.encode("ascii"), raw)

    def test_the_call_writes_no_audit_row_and_changes_nothing(self):
        self.insert_active("alpha", "beta")
        before_bytes = self.database.read_bytes()
        before_audit = self.audit_count()
        self.assertEqual(self.list_bots(), {"ok": True, "bots": ["alpha", "beta"]})
        self.assertEqual(self.audit_count(), before_audit)
        self.assertEqual(self.database.read_bytes(), before_bytes)

    def test_a_removal_drops_the_name_at_the_next_call(self):
        self.insert_active("alpha", "beta")
        self.assertEqual(self.list_bots()["bots"], ["alpha", "beta"])
        self.set_state("beta", "cancelled")
        self.assertEqual(self.list_bots(), {"ok": True, "bots": ["alpha"]})

    def test_a_wrong_peer_uid_is_refused_and_leaks_no_name(self):
        self.insert_active("alpha", "beta")
        before_audit = self.audit_count()
        raw = self.list_bots_raw(expected_uid=os.getuid() + 1)
        self.assertEqual(raw, b'{"ok":false}\n')
        self.assertEqual(self.audit_count(), before_audit)

    def test_a_peer_that_is_not_the_approver_role_is_refused(self):
        self.insert_active("alpha")
        for actor in ("", "someone-else", "qd-approver2", "QD-APPROVER"):
            with self.subTest(actor=actor):
                self.assertEqual(
                    self.list_bots_raw(actor=actor),
                    b'{"ok":false}\n',
                )

    @staticmethod
    def oversize_request():
        head = b'{"action":"listBots","pad":"'
        tail = b'"}\n'
        fill = approval_service.MAX_REQUEST_BYTES + 1 - len(head) - len(tail)
        return head + b"x" * fill + tail

    def test_a_malformed_request_is_refused(self):
        self.insert_active("alpha")
        payloads = {
            "not json": b"not json\n",
            "truncated json": b'{"action":"listBots"\n',
            "list body": b"[]\n",
            "list holding the action": b'["listBots"]\n',
            "string body": b'"listBots"\n',
            "null body": b"null\n",
            "empty object": b"{}\n",
            "empty line": b"\n",
            "wrong case": b'{"action":"listbots"}\n',
            "trailing space": b'{"action":"listBots "}\n',
            "action is null": b'{"action":null}\n',
            "no newline": b'{"action":"listBots"}',
            "two lines": b'{"action":"listBots"}\n{"action":"listBots"}\n',
            "oversize": self.oversize_request(),
            "binary": b"\xff\xfe\x00\n",
        }
        for label, payload in payloads.items():
            with self.subTest(request=label):
                self.assertEqual(self.exchange(payload), b'{"ok":false}\n')

    def test_extra_keys_are_refused(self):
        self.insert_active("alpha")
        requests = (
            {"action": "listBots", "botName": "alpha"},
            {"action": "listBots", "code": "ABCDEFGH"},
            {"action": "listBots", "limit": 1},
            {"action": "listBots", "ok": True},
            {"action": "listBots", "inviteId": "AAAAAAAAAAAA"},
            {"action": "listBots", "password": "not-a-real-password"},
        )
        for request in requests:
            with self.subTest(request=sorted(request)):
                payload = json.dumps(request, separators=(",", ":")).encode("ascii") + b"\n"
                self.assertEqual(self.exchange(payload), b'{"ok":false}\n')

    def test_sixty_four_active_names_are_answered(self):
        expected = names_of(64)
        self.insert_active(*expected)
        self.assertEqual(self.list_bots(), {"ok": True, "bots": expected})

    def test_sixty_five_active_names_are_refused_not_truncated(self):
        self.insert_active(*names_of(65))
        self.assertEqual(self.list_bots_raw(), b'{"ok":false}\n')

    def test_many_more_active_names_are_refused(self):
        self.insert_active(*names_of(100))
        self.assertEqual(self.list_bots_raw(), b'{"ok":false}\n')

    def test_a_name_that_breaks_the_grammar_refuses_the_whole_answer(self):
        for bad in ("Bad_Name", "UPPER", "a" * 33, "1abc", "", "bad name", None, b"blob"):
            with self.subTest(name=bad):
                self.clear_records()
                self.insert_active("fine-one", bad, "fine-two")
                self.assertEqual(self.list_bots_raw(), b'{"ok":false}\n')

    def test_a_database_failure_is_a_refusal_and_not_a_crash(self):
        self.insert_active("alpha")
        with mock.patch.object(
            self.service,
            "_connect",
            side_effect=sqlite3.OperationalError("database is locked"),
        ):
            self.assertEqual(self.list_bots_raw(), b'{"ok":false}\n')
        self.assertEqual(self.list_bots(), {"ok": True, "bots": ["alpha"]})

    def test_the_other_actions_still_answer_after_the_new_one(self):
        code = self.request_join("pending-bot")
        self.insert_active("alpha")
        self.assertEqual(self.list_bots(), {"ok": True, "bots": ["alpha"]})
        pending = json.loads(self.exchange(b'{"action":"pending"}\n'))
        self.assertEqual(pending["ok"], True)
        self.assertEqual([item["code"] for item in pending["pending"]], [code])
        self.assertEqual(
            json.loads(self.exchange(b'{"action":"listInvites"}\n'))["ok"],
            True,
        )
        self.assertEqual(
            json.loads(
                self.exchange(
                    json.dumps({"action": "approve", "code": code}, separators=(",", ":")).encode("ascii")
                    + b"\n"
                )
            ),
            {"ok": True},
        )
        self.assertEqual(json.loads(self.exchange(b'{"action":"listManagers"}\n')), REFUSAL)


class RequestBotsTests(JoinFixture):
    def setUp(self):
        super().setUp()
        self.standin_count = 0

    def standin(self, payload):
        self.standin_count += 1
        path = self.base / f"c{self.standin_count}.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        listener.listen(1)
        received = []

        def run():
            try:
                connection, _ = listener.accept()
                with connection:
                    received.append(connection.recv(4096))
                    try:
                        connection.sendall(payload)
                    except OSError:
                        pass
            except OSError:
                pass

        thread = threading.Thread(target=run, daemon=True)
        thread.start()

        def finish():
            listener.close()
            thread.join(2)

        self.addCleanup(finish)
        return path, received

    def ask(self, payload):
        path, received = self.standin(payload)
        return approval_service.request_bots(path), received

    def answer(self, value):
        return json.dumps(value, separators=(",", ":")).encode("ascii") + b"\n"

    def test_the_client_returns_the_names_from_the_real_service(self):
        self.insert_record("zeta", "active")
        self.insert_record("middle", "provisioning")
        self.insert_record("alpha", "active")
        thread = self.serve_once(os.getuid())
        self.assertEqual(approval_service.request_bots(self.socket_path), ["zeta", "alpha"])
        thread.join(2)
        self.assertFalse(thread.is_alive())

    def test_the_client_returns_an_empty_list_for_an_empty_answer(self):
        thread = self.serve_once(os.getuid())
        self.assertEqual(approval_service.request_bots(self.socket_path), [])
        thread.join(2)

    def test_the_client_returns_none_when_the_real_service_refuses(self):
        self.insert_active("alpha")
        thread = self.serve_once(os.getuid() + 1)
        self.assertIsNone(approval_service.request_bots(self.socket_path))
        thread.join(2)

    def test_the_client_returns_none_when_the_real_service_has_too_many_bots(self):
        self.insert_active(*names_of(65))
        thread = self.serve_once(os.getuid())
        self.assertIsNone(approval_service.request_bots(self.socket_path))
        thread.join(2)

    def test_the_client_sends_exactly_the_list_bots_action(self):
        result, received = self.ask(self.answer({"ok": True, "bots": ["alpha"]}))
        self.assertEqual(result, ["alpha"])
        self.assertEqual(received, [b'{"action":"listBots"}\n'])

    def test_the_client_accepts_sixty_four_names_and_legal_edge_names(self):
        names = names_of(61) + ["a", "b" + "9" * 31, "c-d-9"]
        self.assertEqual(len(names), 64)
        result, _ = self.ask(self.answer({"ok": True, "bots": names}))
        self.assertEqual(result, names)

    def test_the_client_returns_none_for_sixty_five_names(self):
        result, _ = self.ask(self.answer({"ok": True, "bots": names_of(65)}))
        self.assertIsNone(result)

    def test_the_client_returns_none_for_a_refused_answer(self):
        for label, payload in {
            "refused": self.answer({"ok": False}),
            "refused with bots": self.answer({"ok": False, "bots": ["alpha"]}),
            "ok is one": self.answer({"ok": 1, "bots": []}),
            "ok is text": self.answer({"ok": "true", "bots": []}),
            "ok is null": self.answer({"ok": None, "bots": []}),
            "no ok": self.answer({"bots": []}),
        }.items():
            with self.subTest(answer=label):
                result, _ = self.ask(payload)
                self.assertIsNone(result)

    def test_the_client_returns_none_for_wrong_keys(self):
        for label, payload in {
            "no bots": self.answer({"ok": True}),
            "extra key": self.answer({"ok": True, "bots": [], "extra": 1}),
            "extra key with names": self.answer({"ok": True, "bots": ["alpha"], "keys": ["K"]}),
            "pending instead": self.answer({"ok": True, "pending": []}),
            "invites instead": self.answer({"ok": True, "invites": []}),
        }.items():
            with self.subTest(answer=label):
                result, _ = self.ask(payload)
                self.assertIsNone(result)

    def test_the_client_returns_none_when_bots_is_not_a_list(self):
        for label, value in {
            "text": "alpha",
            "null": None,
            "object": {"alpha": 1},
            "number": 7,
            "true": True,
        }.items():
            with self.subTest(bots=label):
                result, _ = self.ask(self.answer({"ok": True, "bots": value}))
                self.assertIsNone(result)

    def test_the_client_returns_none_when_a_name_is_not_text(self):
        for label, value in {
            "number": 1,
            "null": None,
            "true": True,
            "list": ["alpha"],
            "object": {"name": "alpha"},
        }.items():
            with self.subTest(name=label):
                result, _ = self.ask(self.answer({"ok": True, "bots": ["alpha", value]}))
                self.assertIsNone(result)

    def test_the_client_returns_none_when_a_name_breaks_the_grammar(self):
        for bad in (
            "Bad",
            "bad_name",
            "bad name",
            "1abc",
            "-abc",
            "",
            "a" * 33,
            "abc\n",
            "abc.def",
            "caf\u00e9",
        ):
            with self.subTest(name=bad):
                result, _ = self.ask(self.answer({"ok": True, "bots": ["alpha", bad]}))
                self.assertIsNone(result)

    def test_the_client_returns_none_for_a_repeated_name(self):
        result, _ = self.ask(self.answer({"ok": True, "bots": ["alpha", "beta", "alpha"]}))
        self.assertIsNone(result)

    def test_the_client_returns_none_for_malformed_or_non_object_answers(self):
        for label, payload in {
            "not json": b"not json\n",
            "truncated": b'{"ok":true,"bots":[\n',
            "empty line": b"\n",
            "list": b"[]\n",
            "text": b'"ok"\n',
            "null": b"null\n",
            "binary": b"\xff\xfe\n",
            "no newline": b'{"ok":true,"bots":[]}',
            "two lines": b'{"ok":true,"bots":[]}\n{"ok":true,"bots":[]}\n',
            "nothing": b"",
        }.items():
            with self.subTest(answer=label):
                result, _ = self.ask(payload)
                self.assertIsNone(result)

    def test_the_client_returns_none_for_an_oversize_answer(self):
        payload = (
            b'{"ok":true,"bots":[]}'
            + b" " * (approval_service.MAX_RESPONSE_BYTES + 1000)
            + b"\n"
        )
        result, _ = self.ask(payload)
        self.assertIsNone(result)
        payload = b'{"ok":true,"bots":["' + b"a" * 20000 + b'"]}\n'
        result, _ = self.ask(payload)
        self.assertIsNone(result)

    def test_the_client_returns_none_when_nothing_is_listening(self):
        self.assertIsNone(approval_service.request_bots(self.base / "missing.sock"))
        stale = self.base / "stale.sock"
        stale.write_bytes(b"")
        self.assertIsNone(approval_service.request_bots(stale))


if __name__ == "__main__":
    unittest.main(verbosity=2)
