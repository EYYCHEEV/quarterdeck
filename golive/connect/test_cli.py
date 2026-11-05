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


class FakeService:
    def join(self, description, invite):
        self.joined = (description, bytes(invite))
        return {"code": "PUBLIC-CODE"}

    def send(self, recipient, subject, body, resend_id, mail_to_captain=False):
        self.sent = (recipient, subject, body, resend_id)
        self.mail_to_captain = mail_to_captain
        return "message-id"

    def chat(self, text, resend_id):
        self.chatted = (text, resend_id)
        return "chat-message-id"

    def wait(self, after, timeout):
        return [{"id": "message-id", "body": "hello"}]

    def ack(self, message_id):
        if message_id == "fail":
            raise RuntimeError("sensitive stand-in text")


class CliTests(unittest.TestCase):
    def test_command_exposes_join_send_wait_and_ack_without_a_credential_argument(self):
        help_text = qd.parser().format_help().lower()
        self.assertNotIn("credential", help_text)
        self.assertNotIn("api key", help_text)
        service = FakeService()

        output = io.StringIO()
        with (
            mock.patch.object(
                sys,
                "stdin",
                io.StringIO("abcdefghijklmnopqrstuv\n"),
            ),
            mock.patch.object(sys, "stdout", output),
        ):
            self.assertEqual(
                qd.main(
                    [
                        "--config",
                        "fixed",
                        "join",
                        "--description",
                        "dogfood",
                    ],
                    service=service,
                ),
                0,
            )
        self.assertEqual(
            service.joined,
            ("dogfood", b"abcdefghijklmnopqrstuv"),
        )
        self.assertNotIn("invite", qd.parser().format_help().lower())
        self.assertEqual(output.getvalue(), "PUBLIC-CODE\n")

        output = io.StringIO()
        with (
            mock.patch.object(sys, "stdin", io.StringIO("body")),
            mock.patch.object(sys, "stdout", output),
        ):
            self.assertEqual(
                qd.main(
                    ["--config", "fixed", "send", "--to", "other", "--subject", "s", "--resend-id", "r"],
                    service=service,
                ),
                0,
            )
        self.assertEqual(service.sent, ("other", "s", "body", "r"))
        self.assertEqual(output.getvalue(), "message-id\n")

        output = io.StringIO()
        with mock.patch.object(sys, "stdout", output):
            self.assertEqual(qd.main(["--config", "fixed", "wait", "--timeout", "1"], service=service), 0)
        self.assertEqual(output.getvalue(), '{"id":"message-id","body":"hello"}\n')
        self.assertEqual(qd.main(["--config", "fixed", "ack", "message-id"], service=service), 0)

    def test_command_errors_are_uniform(self):
        error = io.StringIO()
        with mock.patch.object(sys, "stderr", error):
            self.assertEqual(qd.main(["--config", "fixed", "ack", "fail"], service=FakeService()), 2)
        self.assertEqual(error.getvalue(), "qd: request could not be completed\n")

    def test_only_the_mail_refusal_prints_its_own_message(self):
        class Refusing(FakeService):
            def send(self, recipient, subject, body, resend_id, mail_to_captain=False):
                raise qd_connect.ConnectRefused("sensitive stand-in text")

        error = io.StringIO()
        with (
            mock.patch.object(sys, "stdin", io.StringIO("body")),
            mock.patch.object(sys, "stderr", error),
        ):
            code = qd.main(
                ["--config", "fixed", "send", "--to", "captain", "--subject", "s", "--resend-id", "r"],
                service=Refusing(),
            )
        self.assertEqual(code, 2)
        self.assertEqual(error.getvalue(), "qd: request could not be completed\n")

    def test_send_passes_the_mail_to_captain_flag_only_when_given(self):
        for flags, expected in (([], False), (["--mail-to-captain"], True)):
            with self.subTest(flags=flags):
                service = FakeService()
                with (
                    mock.patch.object(sys, "stdin", io.StringIO("body")),
                    mock.patch.object(sys, "stdout", io.StringIO()),
                ):
                    code = qd.main(
                        ["--config", "fixed", "send", "--to", "captain", "--subject", "s", "--resend-id", "r", *flags],
                        service=service,
                    )
                self.assertEqual(code, 0)
                self.assertIs(service.mail_to_captain, expected)
                self.assertEqual(service.sent, ("captain", "s", "body", "r"))

    def test_chat_reads_standard_input_and_prints_the_message_id(self):
        service = FakeService()
        output = io.StringIO()
        with (
            mock.patch.object(sys, "stdin", io.StringIO("hello Captain\n")),
            mock.patch.object(sys, "stdout", output),
        ):
            code = qd.main(["--config", "fixed", "chat", "--resend-id", "r"], service=service)
        self.assertEqual(code, 0)
        self.assertEqual(service.chatted, ("hello Captain\n", "r"))
        self.assertEqual(output.getvalue(), "chat-message-id\n")

    def test_chat_takes_no_recipient_or_subject(self):
        for extra in (["--to", "captain"], ["--subject", "s"], ["--mail-to-captain"]):
            with self.subTest(extra=extra), mock.patch.object(sys, "stderr", io.StringIO()):
                with self.assertRaises(SystemExit):
                    qd.parser().parse_args(["--config", "fixed", "chat", "--resend-id", "r", *extra])

    def test_a_missing_settings_file_prints_only_the_public_line(self):
        error = io.StringIO()
        output = io.StringIO()
        with (
            mock.patch.object(sys, "stderr", error),
            mock.patch.object(sys, "stdout", output),
        ):
            self.assertEqual(
                qd.main(["--config", "/absent-folder-for-test/absent-settings.json", "wait", "--timeout", "0"]),
                2,
            )
        self.assertEqual(error.getvalue(), "qd: request could not be completed\n")
        self.assertNotIn("absent", error.getvalue())
        self.assertEqual(output.getvalue(), "")

    def test_checked_in_config_uses_only_file_v1_and_https(self):
        config = json.loads(
            (ROOT / "connect-config.json").read_text(encoding="utf-8")
        )
        self.assertEqual(config["adapter"]["name"], "file-v1")
        self.assertTrue(config["session"].startswith("https://"))
        self.assertEqual(set(config), {"format", "session", "join", "adapter"})
        self.assertEqual(config["join"], "https://quarterdeck.example.test")
        self.assertEqual(config["adapter"]["bot"], "example-bot")


if __name__ == "__main__":
    unittest.main(verbosity=2)
