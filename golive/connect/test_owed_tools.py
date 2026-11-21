import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[1] / "mail"))

import qd
import qd_connect
import qd_jmap
import qd_mcp

ENTRIES = [
    {"id": "m-1", "sent": "2026-11-20T09:00:00-05:00"},
    {"id": "m-2", "sent": "2026-11-20T09:01:00-05:00"},
]
KEY = bytearray(b"API_" + b"A" * 43)


class FakeService:
    def __init__(self, entries=ENTRIES, owed_on_ack=False):
        self.entries = entries
        self.owed_on_ack = owed_on_ack
        self.acked = []

    def owed(self):
        return self.entries

    def ack(self, message_id):
        self.acked.append(message_id)
        return self.owed_on_ack


class FakeAdapter:
    bot_name = "bot-a"

    def read(self):
        return bytearray(KEY)


class FakeJmap:
    def __init__(self, session, credential, transport):
        pass


class FakeMailbox:
    owed_entries = ENTRIES
    owed_failure = None
    calls = []

    def __init__(self, jmap):
        pass

    def ack(self, message_id):
        self.calls.append(("ack", message_id))

    def owed(self):
        self.calls.append(("owed",))
        if self.owed_failure is not None:
            raise self.owed_failure
        return self.owed_entries


def run_cli(service, *argv):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", err):
        try:
            code = qd.main(["--config", "fixed", *argv], service=service)
        except SystemExit as stop:
            code = stop.code
    return code, out.getvalue(), err.getvalue()


def call_tool(service, name, arguments):
    request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    return qd_mcp.Server(service).handle(request)["result"]


class ServiceTests(unittest.TestCase):
    def setUp(self):
        FakeMailbox.calls = []
        FakeMailbox.owed_entries = ENTRIES
        FakeMailbox.owed_failure = None
        patches = (
            mock.patch.object(qd_connect.qd_jmap, "Jmap", FakeJmap),
            mock.patch.object(qd_connect.qd_jmap, "Mailbox", FakeMailbox),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.service = qd_connect.ConnectService("https://quarterdeck.example.test/.well-known/jmap", FakeAdapter(), None, object())

    def test_owed_gives_the_mailbox_entries(self):
        self.assertEqual(self.service.owed(), ENTRIES)

    def test_ack_says_the_mail_is_still_owed_when_it_is(self):
        self.assertIs(self.service.ack("m-2"), True)
        self.assertEqual(FakeMailbox.calls, [("ack", "m-2"), ("owed",)])

    def test_ack_says_nothing_is_owed_for_other_mail(self):
        self.assertIs(self.service.ack("m-9"), False)

    def test_a_failed_owed_lookup_never_turns_a_done_ack_into_a_failure(self):
        for failure in (qd_jmap.MailFailed("down"), KeyError("x"), AttributeError("y")):
            with self.subTest(failure=type(failure).__name__):
                FakeMailbox.calls = []
                FakeMailbox.owed_failure = failure
                self.assertIs(self.service.ack("m-1"), False)
                self.assertEqual(FakeMailbox.calls, [("ack", "m-1"), ("owed",)])

    def test_a_failed_ack_is_still_a_failure_and_looks_nothing_up(self):
        with mock.patch.object(FakeMailbox, "ack", side_effect=qd_jmap.Refused("no such mail")):
            with self.assertRaises(qd_jmap.Refused):
                self.service.ack("m-1")
        self.assertEqual(FakeMailbox.calls, [])


class CliTests(unittest.TestCase):
    def test_owed_prints_one_compact_json_line_per_entry(self):
        code, out, err = run_cli(FakeService(), "owed")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(
            out,
            '{"id":"m-1","sent":"2026-11-20T09:00:00-05:00"}\n{"id":"m-2","sent":"2026-11-20T09:01:00-05:00"}\n',
        )

    def test_owed_prints_nothing_when_nothing_is_owed(self):
        self.assertEqual(run_cli(FakeService(entries=[]), "owed"), (0, "", ""))

    def test_owed_takes_no_arguments(self):
        code, out, _ = run_cli(FakeService(), "owed", "m-1")
        self.assertEqual((code, out), (2, ""))

    def test_a_failing_owed_prints_only_the_public_line(self):
        class Failing(FakeService):
            def owed(self):
                raise RuntimeError("sensitive stand-in text")

        self.assertEqual(run_cli(Failing(), "owed"), (2, "", "qd: request could not be completed\n"))

    def test_ack_on_an_owed_chat_warns_once_on_stderr_with_the_id_and_the_reply_command(self):
        service = FakeService(owed_on_ack=True)
        code, out, err = run_cli(service, "ack", "m-1")
        self.assertEqual((code, out), (0, ""))
        self.assertEqual(service.acked, ["m-1"])
        self.assertEqual(err.count("\n"), 1)
        self.assertIn("m-1", err)
        self.assertIn("qd --config CONFIG chat --resend-id ID", err)

    def test_ack_on_other_mail_stays_silent(self):
        self.assertEqual(run_cli(FakeService(), "ack", "m-1"), (0, "", ""))


class McpTests(unittest.TestCase):
    def test_qd_owed_is_the_last_tool_and_takes_no_arguments(self):
        tools = qd_mcp.Server(FakeService()).handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
        self.assertEqual(tools[-1]["name"], "qd_owed")
        self.assertEqual(tools[-1]["inputSchema"], {"type": "object", "properties": {}, "additionalProperties": False})

    def test_qd_owed_returns_the_entries_as_compact_json(self):
        result = call_tool(FakeService(), "qd_owed", {})
        self.assertFalse(result.get("isError", False))
        self.assertEqual(result["content"], [{"type": "text", "text": json.dumps(ENTRIES, separators=(",", ":"))}])

    def test_qd_owed_returns_an_empty_list_when_nothing_is_owed(self):
        self.assertEqual(call_tool(FakeService(entries=[]), "qd_owed", {})["content"][0]["text"], "[]")

    def test_qd_owed_refuses_any_argument(self):
        for arguments in ({"extra": 1}, None, [], "x"):
            with self.subTest(arguments=arguments):
                self.assertTrue(call_tool(FakeService(), "qd_owed", arguments).get("isError", False))

    def test_qd_ack_on_an_owed_chat_names_the_id_and_qd_chat(self):
        text = call_tool(FakeService(owed_on_ack=True), "qd_ack", {"id": "m-1"})["content"][0]["text"]
        self.assertTrue(text.startswith("acknowledged"))
        self.assertIn("m-1", text)
        self.assertIn("qd_chat", text)

    def test_qd_ack_on_other_mail_says_only_acknowledged(self):
        self.assertEqual(call_tool(FakeService(), "qd_ack", {"id": "m-1"})["content"][0]["text"], "acknowledged")


if __name__ == "__main__":
    unittest.main()
