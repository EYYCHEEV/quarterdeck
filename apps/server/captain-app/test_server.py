import contextlib
import gzip
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import application
import approval_app
import chat_bot_list
import server


ROOT = Path(__file__).resolve().parent


class ServerConfigTests(unittest.TestCase):
    def test_runtime_config_accepts_only_the_private_fixed_port_shape(self):
        template = json.loads(
            (ROOT / "runtime-config.template.json").read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            path = Path(temporary) / "runtime.json"
            path.write_text(json.dumps(template), encoding="utf-8")

            config = server.load_runtime_config(path)

            self.assertEqual(config.port, 8080)
            self.assertEqual(config.auth_socket, template["authSocket"])
            for change in (
                lambda value: value.update(bindPort=80),
                lambda value: value.update(authSocket="relative.sock"),
                lambda value: value.update(extra="not-allowed"),
                lambda value: value.update(jmapSessionUrl=""),
            ):
                candidate = dict(template)
                change(candidate)
                path.write_text(json.dumps(candidate), encoding="utf-8")
                with self.assertRaises(RuntimeError):
                    server.load_runtime_config(path)

    def write_config(self, temporary, **changes):
        template = json.loads(
            (ROOT / "runtime-config.template.json").read_text(encoding="utf-8")
        )
        template.update(changes)
        path = Path(temporary) / "runtime.json"
        path.write_text(json.dumps(template), encoding="utf-8")
        return path

    def test_runtime_config_without_chat_bots_has_none(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            config = server.load_runtime_config(self.write_config(temporary))

            self.assertEqual(config.chat_bots, ())

    def test_runtime_config_reads_chat_bots_with_and_without_notes(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            path = self.write_config(
                temporary,
                chatBots=[{"name": "fern"}, {"name": "dale", "note": "x" * 200}],
            )

            config = server.load_runtime_config(path)

            self.assertEqual(config.chat_bots, (("fern", None), ("dale", "x" * 200)))
            path = self.write_config(temporary, chatBots=[])
            self.assertEqual(server.load_runtime_config(path).chat_bots, ())
            names = [f"bot-{number}" for number in range(16)]
            path = self.write_config(
                temporary,
                chatBots=[{"name": name} for name in names],
            )
            self.assertEqual(len(server.load_runtime_config(path).chat_bots), 16)
            path = self.write_config(temporary, chatBots=[{"name": "a" * 32}])
            self.assertEqual(server.load_runtime_config(path).chat_bots, (("a" * 32, None),))

    def test_runtime_config_refuses_every_invalid_chat_bots_value(self):
        invalid = {
            "not a list": {"name": "fern"},
            "a string": "fern",
            "an entry that is not an object": ["fern"],
            "missing name": [{"note": "text"}],
            "uppercase name": [{"name": "Fern"}],
            "name starting with a digit": [{"name": "1fern"}],
            "empty name": [{"name": ""}],
            "name too long": [{"name": "a" * 33}],
            "name with a dot": [{"name": "fa.de"}],
            "name not a string": [{"name": 7}],
            "duplicate name": [{"name": "fern"}, {"name": "fern"}],
            "seventeen entries": [{"name": f"bot-{number}"} for number in range(17)],
            "note over 200 characters": [{"name": "fern", "note": "x" * 201}],
            "note not a string": [{"name": "fern", "note": 5}],
            "note null": [{"name": "fern", "note": None}],
            "unknown entry key": [{"name": "fern", "extra": "no"}],
        }
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            for label, value in invalid.items():
                with self.subTest(label):
                    path = self.write_config(temporary, chatBots=value)
                    with self.assertRaises(RuntimeError):
                        server.load_runtime_config(path)


    def test_runtime_wires_registry_accounts_into_mailbox_and_chat(self):
        config = server.RuntimeConfig(
            8080,
            "https://mail.invalid/.well-known/jmap",
            "/run/key",
            "/run/readback",
            "/run/registry",
            "/run/auth.sock",
        )
        checker = mock.Mock(
            account_name="account-user",
            oversight_bot="bot-a",
            active_bots=frozenset({"bot-a", "bot-b", "bot-d"}),
            project_leads={
                "Alpha": "bot-a",
                "Beta": "bot-b",
                "Delta": "bot-d",
            },
            captain="legacy-account",
        )
        mailbox = mock.Mock()
        service = mock.Mock()
        updates = mock.Mock()
        registry = {"stand-in": "registry"}
        readback = {"stand-in": "readback"}

        with (
            mock.patch.object(
                server,
                "load_runtime_config",
                return_value=config,
            ),
            mock.patch.object(
                server,
                "_load_object",
                side_effect=[registry, readback],
            ),
            mock.patch.object(
                server.checker_adapter,
                "LaneAChecker",
                return_value=checker,
            ),
            mock.patch.object(
                server.mail_gateway.CaptainMailbox,
                "open",
                return_value=mailbox,
            ) as opened,
            mock.patch.object(
                server.cards,
                "CardService",
                return_value=service,
            ) as built,
            mock.patch.object(
                server.live,
                "LiveUpdates",
                return_value=updates,
            ),
            mock.patch.object(server, "serve") as served,
        ):
            result = server.main(["--config", "stand-in.json"])

        self.assertEqual(result, 0)
        opened.assert_called_once_with(
            config.session_url,
            config.key_path,
            readback,
            account_name="account-user",
            oversight_bot="bot-a",
        )
        built.assert_called_once_with(mailbox, checker, bot_source=mock.ANY)
        source = built.call_args.kwargs["bot_source"]
        self.assertIsInstance(source.__self__, chat_bot_list.ChatBotList)
        self.assertEqual(source.__func__, chat_bot_list.ChatBotList.names)
        served.assert_called_once()

    def test_the_chat_set_comes_from_the_file_beside_the_auth_socket_only(self):
        with tempfile.TemporaryDirectory() as folder:
            payload = {"v": 1, "at": int(time.time()), "bots": ["fern"]}
            file = Path(folder) / "chat-bots.json"
            file.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
            file.chmod(0o640)
            config = server.RuntimeConfig(
                8080,
                "https://mail.invalid/.well-known/jmap",
                "/run/key",
                "/run/readback",
                "/run/registry",
                str(Path(folder) / "auth.sock"),
                (("legacy", None),),
            )
            checker = mock.Mock(
                account_name="account-user",
                oversight_bot="bot-a",
                active_bots=frozenset({"bot-a", "bot-b"}),
            )
            mailbox = mock.Mock()
            mailbox.send_chat.return_value = ("sent-1", False)
            real = server.cards.CardService
            built = []

            def build(*args, **kwargs):
                service = real(*args, **kwargs)
                built.append(service)
                return service

            with (
                mock.patch.object(server, "load_runtime_config", return_value=config),
                mock.patch.object(server, "_load_object", side_effect=[{}, {}]),
                mock.patch.object(server.checker_adapter, "LaneAChecker", return_value=checker),
                mock.patch.object(server.mail_gateway.CaptainMailbox, "open", return_value=mailbox),
                mock.patch.object(server.cards, "CardService", side_effect=build),
                mock.patch.object(server.live, "LiveUpdates", return_value=mock.Mock()),
                mock.patch.object(server, "serve"),
            ):
                self.assertEqual(server.main(["--config", "stand-in.json"]), 0)

            service = built[0]
            self.assertEqual(
                sorted(row["id"] for row in service.chat_list()),
                ["bot-a", "fern"],
            )
            service.send_chat("fern", "Hi", "request-1")
            with self.assertRaises(server.cards.CardRefused):
                service.send_chat("legacy", "Hi", "request-2")
            with self.assertRaises(server.cards.CardRefused):
                service.chat("legacy")

    def test_a_runtime_chat_bots_value_alone_grants_nothing(self):
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))
        with tempfile.TemporaryDirectory() as folder:
            config = server.RuntimeConfig(
                8080,
                "https://mail.invalid/.well-known/jmap",
                "/run/key",
                "/run/readback",
                "/run/registry",
                str(Path(folder) / "auth.sock"),
                (("legacy", None), ("fern", "A note")),
            )
            checker = mock.Mock(
                account_name="account-user",
                oversight_bot="bot-a",
                active_bots=frozenset({"bot-a", "bot-b"}),
            )
            real = server.cards.CardService
            built = []

            def build(*args, **kwargs):
                service = real(*args, **kwargs)
                built.append(service)
                return service

            with (
                mock.patch.object(server, "load_runtime_config", return_value=config),
                mock.patch.object(server, "_load_object", side_effect=[{}, {}]),
                mock.patch.object(server.checker_adapter, "LaneAChecker", return_value=checker),
                mock.patch.object(server.mail_gateway.CaptainMailbox, "open", return_value=mock.Mock()),
                mock.patch.object(server.cards, "CardService", side_effect=build),
                mock.patch.object(server.live, "LiveUpdates", return_value=mock.Mock()),
                mock.patch.object(server, "serve"),
            ):
                self.assertEqual(server.main(["--config", "stand-in.json"]), 0)

            service = built[0]
            self.assertEqual(
                sorted(row["id"] for row in service.chat_list()),
                ["bot-a"],
            )
            for name in ("legacy", "fern"):
                with self.assertRaises(server.cards.CardRefused):
                    service.send_chat(name, "Hi", "request-1")
                with self.assertRaises(server.cards.CardRefused):
                    service.chat(name)

    def test_event_stream_never_writes_a_second_response_after_headers(self):
        def broken_events():
            raise RuntimeError("stand-in stream failure")
            yield

        class BrokenApplication:
            @staticmethod
            def open_events(request, *, last_event_id):
                return application.StreamResponse(
                    200,
                    (("Content-Type", "text/event-stream"),),
                    broken_events(),
                )

        class Sink:
            def write(self, value):
                return len(value)

            def flush(self):
                return None

        handler = object.__new__(server.Handler)
        handler.application = BrokenApplication()
        handler.headers = {}
        handler.wfile = Sink()
        statuses = []
        handler.send_response_only = statuses.append
        handler.send_header = lambda name, value: None
        handler.end_headers = lambda: None
        request = approval_app.Request(
            "GET",
            "/captain/events",
            {},
            bytearray(),
            "private-proxy",
        )

        handler._handle_events(request)

        self.assertEqual(statuses, [200])

    def test_event_stream_reports_a_missing_session_as_sign_in_required(self):
        class UnsignedApplication:
            @staticmethod
            def open_events(request, *, last_event_id):
                raise application.AuthenticationRequired(
                    "stand-in session missing"
                )

        class Sink:
            def write(self, value):
                return len(value)

        handler = object.__new__(server.Handler)
        handler.application = UnsignedApplication()
        handler.headers = {}
        handler.wfile = Sink()
        statuses = []
        handler.send_response_only = statuses.append
        handler.send_header = lambda name, value: None
        handler.end_headers = lambda: None
        request = approval_app.Request(
            "GET",
            "/captain/events",
            {},
            bytearray(),
            "private-proxy",
        )

        handler._handle_events(request)

        self.assertEqual(statuses, [401])

    def test_json_responses_are_gzipped_when_the_client_accepts_it(self):
        class Sink:
            def __init__(self):
                self.body = bytearray()

            def write(self, value):
                self.body.extend(value)
                return len(value)

        handler = object.__new__(server.Handler)
        handler.headers = {"Accept-Encoding": "gzip"}
        handler.wfile = Sink()
        sent_headers = []
        handler.send_response_only = lambda status: None
        handler.send_header = lambda name, value: sent_headers.append(
            (name, value)
        )
        handler.end_headers = lambda: None
        body = json.dumps(
            {"cards": [{"id": f"card-{number}"} for number in range(31)]},
            separators=(",", ":"),
        ).encode()

        handler._send(
            approval_app.Response(
                200,
                (
                    ("Content-Type", "application/json; charset=utf-8"),
                    ("Content-Length", str(len(body))),
                ),
                body,
            )
        )

        headers = dict(sent_headers)
        self.assertEqual(headers["Content-Encoding"], "gzip")
        self.assertEqual(headers["Vary"], "Accept-Encoding")
        self.assertEqual(gzip.decompress(handler.wfile.body), body)
        self.assertEqual(
            headers["Content-Length"],
            str(len(handler.wfile.body)),
        )

    def test_explicit_gzip_refusal_overrides_wildcard_acceptance(self):
        class Sink:
            def __init__(self):
                self.body = bytearray()

            def write(self, value):
                self.body.extend(value)
                return len(value)

        handler = object.__new__(server.Handler)
        handler.headers = {"Accept-Encoding": "gzip;q=0, *;q=1"}
        handler.wfile = Sink()
        sent_headers = []
        handler.send_response_only = lambda status: None
        handler.send_header = lambda name, value: sent_headers.append(
            (name, value)
        )
        handler.end_headers = lambda: None
        body = b'{"status":"ok"}'

        handler._send(
            approval_app.Response(
                200,
                (
                    ("Content-Type", "application/json; charset=utf-8"),
                    ("Content-Length", str(len(body))),
                ),
                body,
            )
        )

        self.assertNotIn("Content-Encoding", dict(sent_headers))
        self.assertEqual(handler.wfile.body, body)

    def test_start_failure_closes_every_owned_runtime_resource(self):
        class FakeServer:
            closed = False

            def server_close(self):
                self.closed = True

        class FailingUpdates:
            stopped = False

            def start(self):
                raise RuntimeError("stand-in start failure")

            def stop(self):
                self.stopped = True

        class FakeMailbox:
            closed = False

            def close(self):
                self.closed = True

        owned_server = FakeServer()
        updates = FailingUpdates()
        mailbox = FakeMailbox()
        with mock.patch.object(
            server,
            "PrivateServer",
            return_value=owned_server,
        ):
            with self.assertRaises(RuntimeError):
                server.serve(object(), updates, mailbox, 8080)

        self.assertTrue(owned_server.closed)
        self.assertTrue(updates.stopped)
        self.assertTrue(mailbox.closed)

if __name__ == "__main__":
    unittest.main(verbosity=2)
