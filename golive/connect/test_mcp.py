import io
import sys
import unittest
from unittest import mock

import qd_mcp


class FakeService:
    def __init__(self):
        self.calls = []

    def join(self, description, invite):
        self.calls.append(("join", description, bytes(invite)))
        return {"code": "PUBLIC-CODE"}
    def create_invite(self, bot=None):
        self.calls.append(("create-invite", bot))
        return "two-step stand-in prompt"

    def send(self, recipient, subject, body, resend_key, mail_to_captain=False):
        self.calls.append(("send", recipient, subject, body, resend_key))
        self.mail_to_captain = mail_to_captain
        return "message-id"

    def chat(self, text, resend_id):
        self.calls.append(("chat", text, resend_id))
        return "chat-message-id"

    def wait(self, after, timeout):
        self.calls.append(("wait", after, timeout))
        return [{"id": "message-id"}]

    def ack(self, message_id):
        self.calls.append(("ack", message_id))


class McpTests(unittest.TestCase):
    def test_lists_join_invite_send_chat_wait_and_ack(self):
        server = qd_mcp.Server(FakeService())
        response = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        names = [tool["name"] for tool in response["result"]["tools"]]
        self.assertEqual(
            names,
            ["qd_join", "qd_create_invite", "qd_send", "qd_chat", "qd_wait", "qd_ack"],
        )

    def test_dispatches_each_tool_without_accepting_a_credential(self):
        service = FakeService()
        server = qd_mcp.Server(service)
        calls = [
            (
                "qd_join",
                {
                    "description": "dogfood",
                    "invite": "abcdefghijklmnopqrstuv",
                },
            ),
            ("qd_create_invite", {"bot": "next-bot"}),
            ("qd_send", {"to": "other", "subject": "s", "body": "b", "resend_id": "r"}),
            ("qd_chat", {"text": "hello", "resend_id": "r"}),
            ("qd_wait", {"after": None, "timeout": 1.0}),
            ("qd_ack", {"id": "message-id"}),
        ]
        for index, (name, arguments) in enumerate(calls):
            response = server.handle(
                {
                    "jsonrpc": "2.0",
                    "id": index,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                }
            )
            self.assertFalse(response["result"].get("isError", False))
        self.assertEqual(
            service.calls,
            [
                (
                    "join",
                    "dogfood",
                    b"abcdefghijklmnopqrstuv",
                ),
                ("create-invite", "next-bot"),
                ("send", "other", "s", "b", "r"),
                ("chat", "hello", "r"),
                ("wait", None, 1.0),
                ("ack", "message-id"),
            ],
        )
        listed_schema = server.handle({"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": {}})
        self.assertNotIn("key", str(listed_schema).lower())
        self.assertNotIn("credential", str(listed_schema).lower())

    def test_send_passes_mail_to_captain_to_the_service_only_when_given(self):
        for extra, expected in (({}, False), ({"mail_to_captain": False}, False), ({"mail_to_captain": True}, True)):
            with self.subTest(extra=extra):
                service = FakeService()
                response = qd_mcp.Server(service).handle(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "qd_send",
                            "arguments": {"to": "captain", "subject": "s", "body": "b", "resend_id": "r", **extra},
                        },
                    }
                )
                self.assertFalse(response["result"].get("isError", False))
                self.assertIs(service.mail_to_captain, expected)

    def test_create_invite_accepts_no_target_bot_and_exposes_no_key_field(self):
        service = FakeService()
        server = qd_mcp.Server(service)

        response = server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "qd_create_invite",
                    "arguments": {},
                },
            }
        )

        self.assertFalse(response["result"].get("isError", False))
        self.assertEqual(service.calls, [("create-invite", None)])
        listed = server.handle(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {},
            }
        )
        schema = next(
            tool
            for tool in listed["result"]["tools"]
            if tool["name"] == "qd_create_invite"
        )["inputSchema"]
        self.assertNotIn("key", str(schema).lower())
        self.assertNotIn("credential", str(schema).lower())

    def test_errors_are_uniform_and_do_not_forward_exception_text(self):
        class Failing(FakeService):
            def ack(self, message_id):
                raise RuntimeError("sensitive stand-in text")

        response = qd_mcp.Server(Failing()).handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "qd_ack", "arguments": {"id": "message-id"}},
            }
        )
        self.assertTrue(response["result"]["isError"])
        self.assertEqual(response["result"]["content"], [{"type": "text", "text": "request could not be completed"}])

    def test_a_missing_settings_file_prints_only_the_public_line(self):
        error = io.StringIO()
        output = io.StringIO()
        with (
            mock.patch.object(sys, "stdin", io.StringIO("")),
            mock.patch.object(sys, "stdout", output),
            mock.patch.object(sys, "stderr", error),
        ):
            self.assertEqual(qd_mcp.main(["--config", "/absent-folder-for-test/absent-settings.json"]), 2)
        self.assertEqual(error.getvalue(), "qd-mcp: request could not be completed\n")
        self.assertNotIn("absent", error.getvalue())
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
