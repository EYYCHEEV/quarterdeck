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
from fake_stalwart import DOMAIN, FakeStalwart


OWN = "stronkbot-lead"
OTHER = "other-bot"
API_KEY = "API_" + "A" * 43
SESSION = "https://quarterdeck.example.test/.well-known/jmap"
UNIFORM_CLI = "qd: request could not be completed\n"
UNIFORM_MCP = "request could not be completed"
MARKER = "MARKER-7731"
PLAIN_REPLY = f"Hello Captain, this is my plan. {MARKER}\n"


def cli_refusal(bot=OWN):
    return (
        "\n".join(
            [
                "qd: refused: mail to captain must be a chat message, or he never sees it.",
                "Send it with: printf '%s' \"your reply\" | qd --config CONFIG chat --resend-id ID",
                f'That sends subject "CHAT: {bot}" and body {{"qd":"chat/1","bot":"{bot}","text":"your reply"}}.',
                'Recipe: "Reply to the Captain" in the Quarterdeck README. Deliberate plain mail to captain: add --mail-to-captain.',
            ]
        )
        + "\n"
    )


def mcp_refusal(bot=OWN):
    return "\n".join(
        [
            "qd: refused: mail to captain must be a chat message, or he never sees it.",
            "Send it with the qd_chat tool (text, resend_id).",
            f'That sends subject "CHAT: {bot}" and body {{"qd":"chat/1","bot":"{bot}","text":"your reply"}}.',
            'Recipe: "Reply to the Captain" in the Quarterdeck README. Deliberate plain mail to captain: set mail_to_captain to true.',
        ]
    )


def chat_body(text, bot=OWN, **extra):
    return json.dumps({"qd": "chat/1", "bot": bot, "text": text, **extra}, ensure_ascii=False)


class FreshAdapter:
    def __init__(self, bot_name):
        self.bot_name = bot_name
        self.reads = 0

    def read(self):
        self.reads += 1
        return bytearray(API_KEY.encode("ascii"))


class NamelessAdapter:
    def __init__(self):
        self.reads = 0

    def read(self):
        self.reads += 1
        return bytearray(API_KEY.encode("ascii"))


class ChatCase(unittest.TestCase):
    def setUp(self):
        self.server = FakeStalwart([OWN, OTHER, "captain"])
        self.server.keys[API_KEY] = OWN
        self.adapter = FreshAdapter(OWN)
        self.service = self.build(self.adapter)

    def build(self, adapter):
        return qd_connect.ConnectService(SESSION, adapter, None, self.server)

    def delivered(self, bot):
        return [
            (mail["subject"], mail["bodyValues"]["b"]["value"])
            for mail in self.server.mail[bot].values()
        ]

    def assert_nothing_left_the_machine(self):
        self.assertEqual(self.delivered("captain"), [])
        self.assertEqual(self.server.requests, [])
        self.assertEqual(self.adapter.reads, 0)

    def cli(self, *argv, stdin="", service=None):
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(sys, "stdin", io.StringIO(stdin)),
            mock.patch.object(sys, "stdout", out),
            mock.patch.object(sys, "stderr", err),
        ):
            try:
                code = qd.main(
                    ["--config", "fixed", *argv],
                    service=service if service is not None else self.service,
                )
            except SystemExit as stop:
                code = stop.code
        return code, out.getvalue(), err.getvalue()

    def send_cli(self, to, subject, body, resend_id="r1", *flags, service=None):
        return self.cli(
            "send", "--to", to, "--subject", subject, "--resend-id", resend_id, *flags,
            stdin=body,
            service=service,
        )

    def mcp(self, name, arguments, service=None):
        response = qd_mcp.Server(service if service is not None else self.service).handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )
        return response["result"]


class StronkBotCaseTests(ChatCase):
    def test_a_plain_reply_to_captain_is_refused_with_four_lines_and_nothing_is_sent(self):
        code, out, err = self.send_cli("captain", "Quarterdeck reply", PLAIN_REPLY)

        self.assertEqual(self.delivered("captain"), [])
        self.assertEqual(code, 2)
        self.assertEqual(err, cli_refusal(OWN))
        self.assertEqual(out, "")
        self.assert_nothing_left_the_machine()

    def test_the_refusal_names_no_message_text_key_host_or_path(self):
        _, _, err = self.send_cli("captain", f"subject {MARKER}", PLAIN_REPLY)

        for forbidden in (MARKER, API_KEY, "example.test", "quarterdeck.example", "fixed"):
            self.assertNotIn(forbidden, err)

    def test_the_refusal_is_its_own_class_under_connect_refused(self):
        with self.assertRaises(qd_connect.MailRefused) as caught:
            self.service.send("captain", "Quarterdeck reply", PLAIN_REPLY, "r1")

        self.assertIsInstance(caught.exception, qd_connect.ConnectRefused)
        self.assert_nothing_left_the_machine()


class WhatPassesTests(ChatCase):
    def refused(self, subject, body):
        code, out, err = self.send_cli("captain", subject, body)
        self.assertEqual(self.delivered("captain"), [], (subject, body))
        self.assertEqual((code, out, err), (2, "", cli_refusal(OWN)), (subject, body))

    def test_a_wrong_subject_is_refused(self):
        for subject in (
            "Quarterdeck reply",
            f"chat: {OWN}",
            f"CHAT: {OTHER}",
            f"CHAT:{OWN}",
            f"CHAT: {OWN} ",
            f" CHAT: {OWN}",
            f"CHAT: {OWN}\n",
            "CHAT",
            "CHAT: ",
            f"CHAT: {OWN.upper()}",
        ):
            with self.subTest(subject=subject):
                self.refused(subject, chat_body("hello"))
        self.assert_nothing_left_the_machine()

    def test_a_bot_that_is_not_the_own_bot_is_refused(self):
        for bot in (OTHER, OWN.upper(), f"{OWN} ", "", None, 7, [OWN], {"bot": OWN}):
            with self.subTest(bot=bot):
                self.refused(
                    f"CHAT: {OWN}",
                    json.dumps({"qd": "chat/1", "bot": bot, "text": "hello"}),
                )
        self.assert_nothing_left_the_machine()

    def test_a_wrong_or_missing_schema_tag_is_refused(self):
        for document in (
            {"bot": OWN, "text": "hello"},
            {"qd": "chat/2", "bot": OWN, "text": "hello"},
            {"qd": "chat", "bot": OWN, "text": "hello"},
            {"qd": 1, "bot": OWN, "text": "hello"},
            {"qd": "chat/1", "text": "hello"},
        ):
            with self.subTest(document=document):
                self.refused(f"CHAT: {OWN}", json.dumps(document))
        self.assert_nothing_left_the_machine()

    def test_empty_whitespace_or_non_string_text_is_refused(self):
        for text in ("", " ", "   ", "\n", "\t \n", "\u00a0", "\u2003", None, 0, 7, True, ["hi"], {"t": "hi"}):
            with self.subTest(text=text):
                self.refused(
                    f"CHAT: {OWN}",
                    json.dumps({"qd": "chat/1", "bot": OWN, "text": text}),
                )
        self.refused(f"CHAT: {OWN}", json.dumps({"qd": "chat/1", "bot": OWN}))
        self.assert_nothing_left_the_machine()

    def test_a_body_that_is_not_one_json_object_is_refused(self):
        for body in (
            PLAIN_REPLY,
            "",
            "\n",
            "chat",
            "null",
            "true",
            "7",
            '"hello"',
            json.dumps(["qd", "chat/1", OWN, "hello"]),
            json.dumps([{"qd": "chat/1", "bot": OWN, "text": "hello"}]),
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hello"',
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hello"}}',
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hello"} {}',
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hello"}x',
            "{'qd':'chat/1','bot':'" + OWN + "','text':'hello'}",
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hello","n":NaN}',
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hello","n":Infinity}',
            "\ufeff" + chat_body("hello"),
            "[" * 100000,
        ):
            with self.subTest(body=body[:60]):
                self.refused(f"CHAT: {OWN}", body)
        self.assert_nothing_left_the_machine()

    def test_an_unknown_own_bot_name_refuses_every_send_to_captain(self):
        for adapter in (FreshAdapter(None), FreshAdapter(""), FreshAdapter("Not A Bot"), FreshAdapter(7), NamelessAdapter()):
            with self.subTest(adapter=vars(adapter)):
                service = self.build(adapter)
                code, out, err = self.send_cli(
                    "captain",
                    f"CHAT: {getattr(adapter, 'bot_name', None)}",
                    chat_body("hello", bot=getattr(adapter, "bot_name", None)),
                    service=service,
                )
                self.assertEqual((code, out, err), (2, "", cli_refusal("<bot>")))
                self.assertEqual(adapter.reads, 0)
        self.assertEqual(self.delivered("captain"), [])
        self.assertEqual(self.server.requests, [])

    def test_a_body_that_is_not_text_is_refused_by_the_check(self):
        good = chat_body("hello Captain")
        for body in (good.encode("utf-8"), bytearray(good.encode("utf-8")), 5, None, [good]):
            with self.subTest(body=body):
                with self.assertRaises(qd_connect.MailRefused):
                    self.service.send("captain", f"CHAT: {OWN}", body, "r1")
        self.assert_nothing_left_the_machine()

    def test_the_correct_shape_is_sent_to_captain(self):
        body = chat_body("hello Captain")
        code, out, err = self.send_cli("captain", f"CHAT: {OWN}", body, "good-1")

        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, qd_jmap.message_id(OWN, "good-1", DOMAIN) + "\n")
        self.assertEqual(self.delivered("captain"), [(f"CHAT: {OWN}", body)])

    def test_the_seat_guide_form_with_a_trailing_newline_and_extra_keys_is_sent(self):
        bodies = [
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hi"}\n',
            '{"qd":"chat/1","bot":"' + OWN + '","text":"hi"}\r\n',
            '  \n{"qd": "chat/1", "bot": "' + OWN + '", "text": "hi"}  \n\n',
            chat_body("hi", extra=1, nested={"a": [1, 2]}),
            chat_body("line one\nline two", reply_to="msg-1"),
            chat_body("caf\u00e9 \u4f60\u597d"),
            '{"text":"hi","bot":"' + OWN + '","qd":"chat/1"}',
        ]
        for index, body in enumerate(bodies):
            with self.subTest(body=body):
                code, _, err = self.send_cli("captain", f"CHAT: {OWN}", body, f"shape-{index}")
                self.assertEqual((code, err), (0, ""))
        self.assertEqual(
            sorted(self.delivered("captain")),
            sorted((f"CHAT: {OWN}", body.replace("\r\n", "\n")) for body in bodies),
        )


class DeliberateMailTests(ChatCase):
    def test_the_flag_lets_a_plain_send_to_captain_through(self):
        code, out, err = self.send_cli(
            "captain", "Quarterdeck reply", PLAIN_REPLY, "plain-1", "--mail-to-captain"
        )

        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, qd_jmap.message_id(OWN, "plain-1", DOMAIN) + "\n")
        self.assertEqual(self.delivered("captain"), [("Quarterdeck reply", PLAIN_REPLY)])

    def test_the_flag_also_works_when_the_own_bot_name_is_unknown(self):
        service = self.build(NamelessAdapter())

        service.send("captain", "Quarterdeck reply", PLAIN_REPLY, "plain-1", mail_to_captain=True)

        self.assertEqual(self.delivered("captain"), [("Quarterdeck reply", PLAIN_REPLY)])

    def test_only_a_real_true_skips_the_check(self):
        for value in ("yes", "false", "", 1, [True], object()):
            with self.subTest(value=value):
                with self.assertRaises(qd_connect.MailRefused):
                    self.service.send("captain", "Quarterdeck reply", PLAIN_REPLY, "r1", mail_to_captain=value)
        self.assert_nothing_left_the_machine()

    def test_sends_to_other_bots_are_the_same_with_and_without_the_flag(self):
        for flags, resend_id in (((), "plain-a"), (("--mail-to-captain",), "plain-b")):
            with self.subTest(flags=flags):
                code, out, err = self.send_cli(OTHER, "Status", PLAIN_REPLY, resend_id, *flags)
                self.assertEqual((code, err), (0, ""))
                self.assertEqual(out, qd_jmap.message_id(OWN, resend_id, DOMAIN) + "\n")
        self.assertEqual(
            self.delivered(OTHER),
            [("Status", PLAIN_REPLY), ("Status", PLAIN_REPLY)],
        )
        self.assertEqual(self.delivered("captain"), [])

    def test_without_the_flag_the_check_is_the_only_gate_for_captain(self):
        code, _, err = self.send_cli("captain", "Quarterdeck reply", PLAIN_REPLY, "plain-1")

        self.assertEqual((code, err), (2, cli_refusal(OWN)))
        self.assertEqual(self.delivered("captain"), [])


class OtherFailuresStayUniformTests(ChatCase):
    def test_other_spellings_of_captain_never_reach_the_captain_mailbox(self):
        for recipient in ("Captain", "CAPTAIN", "captain ", " captain", "captain\n", "captain@example.test", "captain+x", "captain.", "cap\u0442ain"):
            with self.subTest(recipient=recipient):
                code, out, err = self.send_cli(recipient, "Quarterdeck reply", PLAIN_REPLY, "spelling-1")
                self.assertEqual((code, out, err), (2, "", UNIFORM_CLI))
        self.assertEqual(self.delivered("captain"), [])

    def test_a_bad_recipient_or_subject_to_another_bot_prints_only_the_uniform_line(self):
        for recipient, subject in (("Bad Recipient!", "s"), (OTHER, ""), (OTHER, "two\nlines")):
            with self.subTest(recipient=recipient, subject=subject):
                code, out, err = self.send_cli(recipient, subject, "body", "bad-1")
                self.assertEqual((code, out, err), (2, "", UNIFORM_CLI))
                self.assertNotIn("refused", err)

    def test_a_down_server_prints_only_the_uniform_line_for_a_correct_chat(self):
        self.server.down = True

        code, out, err = self.cli("chat", "--resend-id", "down-1", stdin="hello\n")
        self.assertEqual((code, out, err), (2, "", UNIFORM_CLI))
        code, out, err = self.send_cli("captain", "Quarterdeck reply", "plain", "down-2", "--mail-to-captain")
        self.assertEqual((code, out, err), (2, "", UNIFORM_CLI))

    def test_a_changed_resend_is_refused_with_the_uniform_line(self):
        self.assertEqual(self.cli("chat", "--resend-id", "same", stdin="first\n")[0], 0)

        code, out, err = self.cli("chat", "--resend-id", "same", stdin="second\n")

        self.assertEqual((code, out, err), (2, "", UNIFORM_CLI))
        self.assertEqual(self.delivered("captain"), [(f"CHAT: {OWN}", chat_body("first"))])

    def test_an_unknown_message_to_ack_prints_only_the_uniform_line(self):
        code, out, err = self.cli("ack", "no-such-message")

        self.assertEqual((code, out, err), (2, "", UNIFORM_CLI))


class ChatCommandTests(ChatCase):
    def test_chat_sends_the_exact_subject_and_body_and_prints_the_message_id(self):
        code, out, err = self.cli("chat", "--resend-id", "chat-1", stdin="Hello Captain.\n\n")

        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, qd_jmap.message_id(OWN, "chat-1", DOMAIN) + "\n")
        self.assertEqual(
            self.delivered("captain"),
            [(f"CHAT: {OWN}", json.dumps({"qd": "chat/1", "bot": OWN, "text": "Hello Captain."}, ensure_ascii=False))],
        )

    def test_chat_strips_only_trailing_whitespace_and_keeps_unicode_readable(self):
        text = "  caf\u00e9 \u4f60\u597d\n\tsecond line \"quoted\" \\ back"

        code, _, err = self.cli("chat", "--resend-id", "chat-2", stdin=text + " \n\t\n")

        self.assertEqual((code, err), (0, ""))
        [(subject, body)] = self.delivered("captain")
        self.assertEqual(subject, f"CHAT: {OWN}")
        self.assertEqual(body, json.dumps({"qd": "chat/1", "bot": OWN, "text": text}, ensure_ascii=False))
        self.assertIn("\u4f60\u597d", body)
        self.assertEqual(json.loads(body)["text"], text)

    def test_chat_refuses_empty_text_with_one_line_and_sends_nothing(self):
        for stdin in ("", "\n", "   \n\t\n"):
            with self.subTest(stdin=stdin):
                code, out, err = self.cli("chat", "--resend-id", "chat-3", stdin=stdin)
                self.assertEqual((code, out, err), (2, "", "qd: refused: chat text is empty.\n"))
        self.assert_nothing_left_the_machine()

    def test_chat_with_the_same_id_and_words_sends_nothing_twice(self):
        first = self.cli("chat", "--resend-id", "chat-4", stdin="Hello Captain.\n")
        second = self.cli("chat", "--resend-id", "chat-4", stdin="Hello Captain.\n")

        self.assertEqual(first, second)
        self.assertEqual(first[0], 0)
        self.assertEqual(len(self.delivered("captain")), 1)

    def test_chat_needs_a_resend_id(self):
        code, out, err = self.cli("chat", stdin="hello\n")

        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("the following arguments are required: --resend-id", err)
        self.assert_nothing_left_the_machine()

    def test_chat_with_an_unknown_own_bot_name_is_refused_before_anything_leaves(self):
        adapter = NamelessAdapter()

        code, out, err = self.cli("chat", "--resend-id", "chat-5", stdin="hello\n", service=self.build(adapter))

        self.assertEqual((code, out), (2, ""))
        self.assertTrue(err.startswith("qd: refused: "), err)
        self.assertEqual(adapter.reads, 0)
        self.assertEqual(self.delivered("captain"), [])

    def test_chat_goes_through_the_same_checked_send_path(self):
        seen = []
        original = qd_connect.ConnectService.send

        def spy(service, recipient, subject, body, resend_id, **keywords):
            seen.append((recipient, subject, body, resend_id, keywords))
            return original(service, recipient, subject, body, resend_id, **keywords)

        with mock.patch.object(qd_connect.ConnectService, "send", spy):
            code, _, _ = self.cli("chat", "--resend-id", "chat-6", stdin="hello\n")

        self.assertEqual(code, 0)
        self.assertEqual(
            seen,
            [("captain", f"CHAT: {OWN}", chat_body("hello"), "chat-6", {})],
        )


class McpTests(ChatCase):
    def test_a_plain_send_to_captain_is_refused_with_the_four_lines_and_nothing_is_sent(self):
        result = self.mcp(
            "qd_send",
            {"to": "captain", "subject": "Quarterdeck reply", "body": PLAIN_REPLY, "resend_id": "m1"},
        )

        self.assertEqual(self.delivered("captain"), [])
        self.assertTrue(result.get("isError"))
        self.assertEqual(result["content"], [{"type": "text", "text": mcp_refusal(OWN)}])
        self.assert_nothing_left_the_machine()

    def test_the_refusal_to_an_unknown_own_bot_keeps_the_literal_placeholder(self):
        adapter = NamelessAdapter()

        result = self.mcp(
            "qd_send",
            {"to": "captain", "subject": "s", "body": "b", "resend_id": "m1"},
            service=self.build(adapter),
        )

        self.assertTrue(result.get("isError"))
        self.assertEqual(result["content"], [{"type": "text", "text": mcp_refusal("<bot>")}])
        self.assertEqual(adapter.reads, 0)

    def test_the_correct_shape_is_sent(self):
        body = chat_body("hello Captain")

        result = self.mcp(
            "qd_send",
            {"to": "captain", "subject": f"CHAT: {OWN}", "body": body + "\n", "resend_id": "m2"},
        )

        self.assertFalse(result.get("isError", False))
        self.assertEqual(self.delivered("captain"), [(f"CHAT: {OWN}", body + "\n")])

    def test_mail_to_captain_lets_a_plain_send_through(self):
        result = self.mcp(
            "qd_send",
            {
                "to": "captain",
                "subject": "Quarterdeck reply",
                "body": PLAIN_REPLY,
                "resend_id": "m3",
                "mail_to_captain": True,
            },
        )

        self.assertFalse(result.get("isError", False))
        self.assertEqual(self.delivered("captain"), [("Quarterdeck reply", PLAIN_REPLY)])

    def test_mail_to_captain_false_still_refuses(self):
        result = self.mcp(
            "qd_send",
            {
                "to": "captain",
                "subject": "Quarterdeck reply",
                "body": PLAIN_REPLY,
                "resend_id": "m4",
                "mail_to_captain": False,
            },
        )

        self.assertTrue(result.get("isError"))
        self.assertEqual(result["content"], [{"type": "text", "text": mcp_refusal(OWN)}])
        self.assertEqual(self.delivered("captain"), [])

    def test_mail_to_captain_must_be_a_real_boolean(self):
        for value in ("true", "false", "", 1, 0, None, [], {}):
            with self.subTest(value=value):
                result = self.mcp(
                    "qd_send",
                    {
                        "to": "captain",
                        "subject": "Quarterdeck reply",
                        "body": PLAIN_REPLY,
                        "resend_id": "m5",
                        "mail_to_captain": value,
                    },
                )
                self.assertTrue(result.get("isError"))
                self.assertEqual(result["content"], [{"type": "text", "text": UNIFORM_MCP}])
        self.assert_nothing_left_the_machine()

    def test_mail_to_captain_changes_nothing_for_other_bots(self):
        for extra, resend_id in (({}, "m6"), ({"mail_to_captain": True}, "m7"), ({"mail_to_captain": False}, "m8")):
            with self.subTest(extra=extra):
                result = self.mcp(
                    "qd_send",
                    {"to": OTHER, "subject": "Status", "body": PLAIN_REPLY, "resend_id": resend_id, **extra},
                )
                self.assertFalse(result.get("isError", False))
        self.assertEqual(self.delivered(OTHER), [("Status", PLAIN_REPLY)] * 3)

    def test_an_unknown_field_is_still_refused(self):
        for tool, arguments in (
            ("qd_send", {"to": OTHER, "subject": "s", "body": "b", "resend_id": "x", "extra": 1}),
            ("qd_send", {"to": OTHER, "subject": "s", "body": "b", "resend_id": "x", "mail_to_captain": True, "extra": 1}),
            ("qd_send", {"to": OTHER, "subject": "s", "body": "b"}),
            ("qd_send", {"subject": "s", "body": "b", "resend_id": "x", "mail_to_captain": True}),
            ("qd_chat", {"text": "hello", "resend_id": "x", "extra": 1}),
            ("qd_chat", {"text": "hello", "resend_id": "x", "mail_to_captain": True}),
            ("qd_chat", {"text": "hello"}),
            ("qd_chat", {"resend_id": "x"}),
            ("qd_chat", {}),
            ("qd_chat", None),
            ("qd_chat", ["hello", "x"]),
        ):
            with self.subTest(tool=tool, arguments=arguments):
                result = self.mcp(tool, arguments)
                self.assertTrue(result.get("isError"))
                self.assertEqual(result["content"], [{"type": "text", "text": UNIFORM_MCP}])
        self.assertEqual(self.delivered("captain"), [])
        self.assertEqual(self.delivered(OTHER), [])

    def test_qd_chat_sends_the_exact_subject_and_body(self):
        result = self.mcp("qd_chat", {"text": "Hello Captain.\n\n", "resend_id": "c1"})

        self.assertFalse(result.get("isError", False))
        self.assertEqual(result["content"], [{"type": "text", "text": qd_jmap.message_id(OWN, "c1", DOMAIN)}])
        self.assertEqual(
            self.delivered("captain"),
            [(f"CHAT: {OWN}", json.dumps({"qd": "chat/1", "bot": OWN, "text": "Hello Captain."}, ensure_ascii=False))],
        )

    def test_qd_chat_refuses_empty_text_with_one_line(self):
        for text in ("", "  \n\t"):
            with self.subTest(text=text):
                result = self.mcp("qd_chat", {"text": text, "resend_id": "c2"})
                self.assertTrue(result.get("isError"))
                self.assertEqual(result["content"], [{"type": "text", "text": "qd: refused: chat text is empty."}])
        self.assert_nothing_left_the_machine()

    def test_qd_chat_with_a_non_string_text_prints_only_the_uniform_line(self):
        for text in (None, 7, ["hi"], {"a": 1}, True):
            with self.subTest(text=text):
                result = self.mcp("qd_chat", {"text": text, "resend_id": "c3"})
                self.assertTrue(result.get("isError"))
                self.assertEqual(result["content"], [{"type": "text", "text": UNIFORM_MCP}])
        self.assertEqual(self.delivered("captain"), [])

    def test_qd_chat_with_the_same_id_and_words_sends_nothing_twice(self):
        first = self.mcp("qd_chat", {"text": "Hello Captain.", "resend_id": "c4"})
        second = self.mcp("qd_chat", {"text": "Hello Captain.\n", "resend_id": "c4"})

        self.assertEqual(first, second)
        self.assertFalse(first.get("isError", False))
        self.assertEqual(len(self.delivered("captain")), 1)

    def test_other_failures_stay_uniform(self):
        for arguments in (
            {"to": "Bad Recipient!", "subject": "s", "body": "b", "resend_id": "u1"},
            {"to": OTHER, "subject": "", "body": "b", "resend_id": "u2"},
            {"to": OTHER, "subject": ["s"], "body": "b", "resend_id": "u3"},
        ):
            with self.subTest(arguments=arguments):
                result = self.mcp("qd_send", arguments)
                self.assertTrue(result.get("isError"))
                self.assertEqual(result["content"], [{"type": "text", "text": UNIFORM_MCP}])

    def test_the_tool_list_has_qd_chat_with_exactly_text_and_resend_id_and_the_optional_flag(self):
        response = qd_mcp.Server(self.service).handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
        )
        tools = {tool["name"]: tool for tool in response["result"]["tools"]}

        chat = tools["qd_chat"]["inputSchema"]
        self.assertEqual(set(chat["properties"]), {"text", "resend_id"})
        self.assertEqual(set(chat["required"]), {"text", "resend_id"})
        self.assertIs(chat["additionalProperties"], False)
        self.assertEqual(chat["properties"]["text"], {"type": "string"})
        send = tools["qd_send"]["inputSchema"]
        self.assertEqual(send["properties"]["mail_to_captain"], {"type": "boolean"})
        self.assertEqual(set(send["required"]), {"to", "subject", "body", "resend_id"})
        self.assertIs(send["additionalProperties"], False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
