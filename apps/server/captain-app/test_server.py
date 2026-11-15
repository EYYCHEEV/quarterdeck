import contextlib
import gzip
import io
import json
import socket
import tempfile
import threading
import time
import types
import unittest
from email.message import Message
from pathlib import Path
from unittest import mock

import application
import approval_app
import approval_security
import auth_bridge
import captain_auth_socket
import chat_bot_list
import server
import test_signin_support


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


SIGNED = (
    ("Cookie", "__Host-qd-approval=good-session"),
    ("Origin", "https://quarterdeck.invalid"),
    ("X-Forwarded-For", "192.0.2.10"),
    ("X-Forwarded-Host", "quarterdeck.invalid"),
    ("X-Forwarded-Proto", "https"),
)
CHAT_SEND = "/captain/api/chat?with=bot-a"
REFUSED = (403, {"error": "request refused"})


class SignIn:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def __call__(self, payload):
        self.calls.append(payload)
        if self.error is not None:
            raise self.error
        if payload["session"] != "good-session":
            raise application.SessionRefused("Captain auth session was refused")
        return {"ok": True, "csrf": "spare", "freshUntil": 0.0, "freshRequired": False}


def without(name, pairs=SIGNED):
    return tuple(pair for pair in pairs if pair[0] != name)


class BodyLimitTests(unittest.TestCase):
    LONG = (16385, 131072)

    @staticmethod
    def framed(length, command="POST", path=CHAT_SEND, pairs=SIGNED, sign_in=None):
        sign_in = SignIn() if sign_in is None else sign_in
        headers = Message()
        headers["Content-Length"] = str(length)
        for name, value in pairs:
            headers[name] = value
        timeouts = []
        connection = types.SimpleNamespace(settimeout=timeouts.append)
        return types.SimpleNamespace(
            headers=headers,
            connection=connection,
            rfile=io.BytesIO(b"x" * length),
            command=command,
            path=path,
            timeouts=timeouts,
            client_address=("127.0.0.1", 4000),
            application=application.CardApplication(
                auth_bridge.SocketApprovalGate(sign_in),
                None,
                None,
                clock=lambda: 1000.0,
            ),
            sign_in=sign_in,
        )

    @staticmethod
    def read_of(fake):
        try:
            body = server.Handler._body(fake)
        except ValueError:
            return "too large", fake.rfile.tell()
        except Exception as error:
            response = getattr(error, "response", None)
            if response is None:
                raise
            return (response.status, json.loads(response.body)), fake.rfile.tell()
        return len(body), fake.rfile.tell()

    @staticmethod
    def asked(fake):
        return [
            (call["operation"], call["request"]["method"], call["request"]["path"])
            for call in fake.sign_in.calls
        ]

    def test_only_a_chat_send_is_read_up_to_128_kib(self):
        limit = 131072
        self.assertEqual(self.read_of(self.framed(limit)), (limit, limit))
        over = self.framed(limit + 1)
        self.assertEqual(
            (self.read_of(over), over.timeouts, over.sign_in.calls),
            (("too large", 0), [], []),
        )
        self.assertEqual((application.CHAT_SEND_BODY_BYTES, application.MAX_BODY_BYTES), (limit, 16384))

    def test_every_other_request_is_still_read_up_to_16_kib(self):
        others = (
            ("GET", CHAT_SEND),
            ("PUT", CHAT_SEND),
            ("HEAD", CHAT_SEND),
            ("post", CHAT_SEND),
            ("POST", "/captain/api/chat/read?with=bot-a"),
            ("POST", "/captain/api/chats"),
            ("POST", "/captain/cards/card-1/comments"),
            ("POST", "/captain/api/chat/?with=bot-a"),
            ("POST", "/captain/api/%63hat?with=bot-a"),
            ("POST", "//host.invalid/captain/api/chat?with=bot-a"),
        )
        for command, path in others:
            with self.subTest(command=command, path=path):
                self.assertEqual(self.read_of(self.framed(16384, command, path)), (16384, 16384))
                over = self.framed(16385, command, path)
                self.assertEqual((self.read_of(over), over.sign_in.calls), (("too large", 0), []))
                self.assertEqual(application.body_limit(command, path), 16384)
        self.assertEqual(application.body_limit("POST", CHAT_SEND), 131072)

    def test_a_chat_send_with_no_valid_bot_in_its_address_stays_at_16_kib(self):
        targets = (
            "/captain/api/chat",
            "/captain/api/chat?",
            "/captain/api/chat?bot=bot-a",
            "/captain/api/chat?with=",
            "/captain/api/chat?with=bad_bot",
            "/captain/api/chat?with=bot-a&with=bot-b",
            "/captain/api/chat?with=bot-a&extra=1",
            "/captain/api/chat?with=bot-a?with=bot-b",
            "/captain/api/chat?with=bot-a#part",
        )
        for path in targets:
            with self.subTest(path=path):
                self.assertEqual(self.read_of(self.framed(16384, "POST", path)), (16384, 16384))
                over = self.framed(16385, "POST", path)
                self.assertEqual((self.read_of(over), over.sign_in.calls), (("too large", 0), []))
                self.assertEqual(application.body_limit("POST", path), 16384)

    def test_a_signed_long_send_is_read_after_one_session_check_shaped_as_a_read(self):
        for size in (16384, 16385, 131072):
            with self.subTest(size=size):
                fake = self.framed(size)
                self.assertEqual(self.read_of(fake), (size, size))
                self.assertEqual(
                    self.asked(fake),
                    [] if size == 16384 else [("authenticate", "GET", CHAT_SEND)],
                )

    def test_no_cookie_at_all_is_refused_before_one_body_byte_is_read(self):
        for size in self.LONG:
            with self.subTest(size=size):
                fake = self.framed(size, pairs=without("Cookie"))
                self.assertEqual(self.read_of(fake), (REFUSED, 0))
                self.assertEqual((fake.timeouts, fake.sign_in.calls), ([], []))
        self.assertEqual(self.read_of(self.framed(16384, pairs=without("Cookie"))), (16384, 16384))

    def test_a_session_the_sign_in_service_refuses_is_refused_before_the_body(self):
        stale = (("Cookie", "__Host-qd-approval=stale-session"),) + without("Cookie")
        for size in self.LONG:
            with self.subTest(size=size):
                fake = self.framed(size, pairs=stale)
                self.assertEqual(self.read_of(fake), (REFUSED, 0))
                self.assertEqual(self.asked(fake), [("authenticate", "GET", CHAT_SEND)])
        fake = self.framed(16384, pairs=stale)
        self.assertEqual((self.read_of(fake), fake.sign_in.calls), ((16384, 16384), []))

    def test_a_wrong_origin_is_refused_before_the_body_and_before_the_session_check(self):
        origins = {
            "missing": None,
            "another host": "https://other.invalid",
            "plain http": "http://quarterdeck.invalid",
            "a port": "https://quarterdeck.invalid:443",
            "a trailing slash": "https://quarterdeck.invalid/",
            "another case": "https://Quarterdeck.invalid",
            "the word null": "null",
            "empty": "",
        }
        for name, origin in origins.items():
            pairs = without("Origin") + (() if origin is None else (("Origin", origin),))
            for size in self.LONG:
                with self.subTest(name=name, size=size):
                    fake = self.framed(size, pairs=pairs)
                    self.assertEqual(self.read_of(fake), (REFUSED, 0))
                    self.assertEqual((fake.timeouts, fake.sign_in.calls), ([], []))
            with self.subTest(name=name, size=16384):
                fake = self.framed(16384, pairs=pairs)
                self.assertEqual((self.read_of(fake), fake.sign_in.calls), ((16384, 16384), []))

    def test_no_forwarded_host_cannot_be_matched_by_a_bare_origin(self):
        pairs = without("Origin", without("X-Forwarded-Host")) + (("Origin", "https://"),)
        for size in self.LONG:
            with self.subTest(size=size):
                fake = self.framed(size, pairs=pairs)
                self.assertEqual((self.read_of(fake), fake.sign_in.calls), ((REFUSED, 0), []))

    def test_a_gate_that_says_too_many_or_fails_is_answered_before_the_body(self):
        cases = (
            (approval_security.ApprovalRateLimited("too many"), (429, {"error": "request refused"})),
            (approval_security.ApprovalRefused("Captain auth service is unavailable"), REFUSED),
            (RuntimeError("stand-in failure"), (503, {"error": "request unavailable"})),
        )
        for error, expected in cases:
            with self.subTest(error=type(error).__name__):
                fake = self.framed(16385, sign_in=SignIn(error))
                self.assertEqual(self.read_of(fake), (expected, 0))

    def test_the_handler_sends_the_refusal_itself_and_never_calls_the_route(self):
        fake = self.framed(16385, pairs=without("Cookie"))
        sent = []
        fake._body = lambda: server.Handler._body(fake)
        fake._request = lambda body: server.Handler._request(fake, body)
        fake._send = sent.append
        fake.application.handle = lambda request: self.fail("the route was called")
        server.Handler._handle(fake)
        self.assertEqual([(response.status, json.loads(response.body)) for response in sent], [REFUSED])
        self.assertEqual(fake.rfile.tell(), 0)


class _NoGoogle:
    def authorization_url(self, **values):
        raise AssertionError("Google is not used by these tests")

    def exchange_code(self, code, verifier, nonce):
        raise AssertionError("Google is not used by these tests")


class SignInServiceAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        root.chmod(0o700)
        state = approval_security.ApprovalState(
            root / "approval.sqlite",
            b"s" * 32,
            clock=lambda: 1000.0,
        )
        self.token = state.start_browser_session(
            "account-user-subject",
            device_hash=None,
            kind="Other browser",
            fresh_from=1000.0,
        ).token
        approval = object.__new__(approval_app.ApprovalApplication)
        approval.state = state
        approval.sign_in = test_signin_support.production_sign_in(state, _NoGoogle())
        self.addCleanup(setattr, approval.sign_in, "_authority", None)
        approval.trusted_proxy = "127.0.0.1"
        approval.public_origin = "https://quarterdeck.invalid"
        approval.forwarded_host = "quarterdeck.invalid"
        service = object.__new__(captain_auth_socket.CaptainAuthSocketService)
        service.sign_in = approval.sign_in
        service.application = approval
        self.asked = []

        def answer(payload):
            self.asked.append((payload["operation"], payload["request"]["method"], payload["request"]["path"]))
            try:
                csrf, fresh_until = service._authorize(payload)
            except approval_security.FreshSignInRequired:
                raise
            except Exception:
                raise application.SessionRefused("Captain auth session was refused") from None
            return {"ok": True, "csrf": csrf, "freshUntil": fresh_until, "freshRequired": False}

        self.answer = answer

    def pairs(self, host="quarterdeck.invalid", token=None):
        return (
            ("Cookie", f"__Host-qd-approval={self.token if token is None else token}"),
            ("Origin", "https://" + host),
            ("X-Forwarded-For", "192.0.2.10"),
            ("X-Forwarded-Host", host),
            ("X-Forwarded-Proto", "https"),
        )

    def read(self, size, pairs):
        fake = BodyLimitTests.framed(size, pairs=pairs, sign_in=self.answer)
        return BodyLimitTests.read_of(fake), fake.timeouts

    def test_the_sign_in_service_itself_admits_a_signed_long_send_asked_as_a_read(self):
        for size in BodyLimitTests.LONG:
            with self.subTest(size=size):
                self.assertEqual(self.read(size, self.pairs()), ((size, size), [5]))
        self.assertEqual(self.asked, [("authenticate", "GET", CHAT_SEND)] * 2)

    def test_an_origin_and_a_forwarded_host_that_both_name_another_host_are_refused_by_the_sign_in_service(self):
        for size in BodyLimitTests.LONG:
            with self.subTest(size=size):
                self.assertEqual(self.read(size, self.pairs("other.invalid")), ((REFUSED, 0), []))
        self.assertEqual(self.asked, [("authenticate", "GET", CHAT_SEND)] * 2)

    def test_the_sign_in_service_itself_refuses_a_session_it_does_not_know(self):
        unknown = self.token[::-1]
        self.assertNotEqual(unknown, self.token)
        for size in BodyLimitTests.LONG:
            with self.subTest(size=size):
                self.assertEqual(self.read(size, self.pairs(token=unknown)), ((REFUSED, 0), []))
        self.assertEqual(self.asked, [("authenticate", "GET", CHAT_SEND)] * 2)


class EarlyAnswerOverASocketTests(unittest.TestCase):
    FOLLOW = (
        f"GET {CHAT_SEND} HTTP/1.1\r\n"
        "Host: quarterdeck.invalid\r\n"
        "Cookie: __Host-qd-approval=good-session\r\n"
        "\r\n"
    ).encode("ascii")
    HEAD = (
        f"POST {CHAT_SEND} HTTP/1.1\r\n"
        "Host: quarterdeck.invalid\r\n"
        "Connection: keep-alive\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: 16385\r\n"
        "Origin: https://quarterdeck.invalid\r\n"
        "X-Forwarded-For: 192.0.2.10\r\n"
        "X-Forwarded-Host: quarterdeck.invalid\r\n"
        "X-Forwarded-Proto: https\r\n"
        "\r\n"
    ).encode("ascii")

    def setUp(self):
        self.sign_in = SignIn()
        app = application.CardApplication(
            auth_bridge.SocketApprovalGate(self.sign_in),
            None,
            None,
            clock=lambda: 1000.0,
        )
        self.httpd = server.PrivateServer(("127.0.0.1", 0), server.handler_for(app))
        self.addCleanup(self.httpd.server_close)
        threading.Thread(
            target=self.httpd.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        ).start()
        self.addCleanup(self.httpd.shutdown)

    def exchange(self, data):
        received = b""
        with socket.create_connection(self.httpd.server_address, timeout=5) as connection:
            try:
                connection.sendall(data)
            except OSError:
                pass
            try:
                while chunk := connection.recv(4096):
                    received += chunk
            except OSError:
                pass
        return received

    def test_a_refused_long_send_closes_the_connection_and_what_follows_it_is_never_a_request(self):
        body = self.FOLLOW + b"x" * (16385 - len(self.FOLLOW))
        received = self.exchange(self.HEAD + body + self.FOLLOW)
        head, _, answer = received.partition(b"\r\n\r\n")
        self.assertEqual(received.count(b"HTTP/1."), 1)
        self.assertEqual((int(head.split(b" ", 2)[1]), json.loads(answer)), REFUSED)
        self.assertEqual(self.sign_in.calls, [])
        self.assertEqual(self.exchange(self.FOLLOW).count(b"HTTP/1."), 1)
        self.assertEqual(BodyLimitTests.asked(self), [("authenticate", "GET", CHAT_SEND)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
