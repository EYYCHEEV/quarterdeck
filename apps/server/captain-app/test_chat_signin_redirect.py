import json
import hashlib
import types
import unittest
from pathlib import Path
from unittest import mock

import application
import approval_app
import approval_security
import auth_bridge
import captain_auth_socket
import server
from test_application import FakeCards, FakeUpdates


ROOT = Path(__file__).resolve().parent
REFUSAL = b'{"ok":false,"csrf":"","freshUntil":0.0,"freshRequired":false}\n'
SIGNED_IN = b'{"ok":true,"csrf":"fresh-csrf","freshUntil":0.0,"freshRequired":false}\n'
REFUSED_BODY = b'{"error":"request refused"}'
CHAT_PAGE = "/captain/chat"
SIGN_IN_REDIRECT_HEADERS = [
    *approval_app.ApprovalApplication._security_headers(
        "text/plain; charset=utf-8"
    ),
    ("Location", "/captain/login"),
    ("Content-Length", "0"),
]
HTML_ACCEPT = "text/html,application/xhtml+xml"


class AuthSocketStandIn:
    def __init__(self, reply=b"", connect_error=None):
        self.reply = reply
        self.connect_error = connect_error
        self.opened = 0
        self.sent = []

    def __call__(self, family, kind):
        self.opened += 1
        return _Connection(self)


class _Connection:
    def __init__(self, owner):
        self.owner = owner
        self.unread = owner.reply

    def __enter__(self):
        return self

    def __exit__(self, *details):
        return False

    def settimeout(self, seconds):
        return None

    def connect(self, path):
        if self.owner.connect_error is not None:
            raise self.owner.connect_error

    def sendall(self, data):
        self.owner.sent.append(bytes(data))

    def recv(self, size):
        chunk, self.unread = self.unread[:size], self.unread[size:]
        return chunk


class Sink:
    def __init__(self):
        self.body = bytearray()

    def write(self, value):
        self.body.extend(value)
        return len(value)

    def flush(self):
        return None


class RefusingGate:
    def __init__(self, error):
        self.error = error

    def authenticate(self, request):
        raise self.error


class SignedOutChatPageTests(unittest.TestCase):
    def stand_in(self, **options):
        stand_in = AuthSocketStandIn(**options)
        patched = mock.patch.object(
            auth_bridge,
            "socket",
            types.SimpleNamespace(
                socket=stand_in,
                AF_UNIX=1,
                SOCK_STREAM=1,
            ),
        )
        patched.start()
        self.addCleanup(patched.stop)
        return stand_in

    @staticmethod
    def application(gate):
        return application.CardApplication(
            gate,
            FakeCards(),
            FakeUpdates(),
            clock=lambda: 1000.0,
        )

    def socket_application(self, **options):
        stand_in = self.stand_in(**options)
        gate = auth_bridge.SocketApprovalGate(
            auth_bridge.ApprovalAuthClient("/run/qd-test/auth.sock")
        )
        return self.application(gate), stand_in

    @staticmethod
    def request(
        method,
        path,
        *,
        accept=None,
        cookie=True,
        body=b"",
        accept_name="Accept",
    ):
        headers = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "quarterdeck.invalid",
            "X-Forwarded-For": "192.0.2.10",
        }
        if cookie:
            headers["Cookie"] = "__Host-qd-approval=session-placeholder"
        if accept is not None:
            headers[accept_name] = accept
        if body:
            headers["Content-Type"] = "application/json"
            headers["Origin"] = "https://quarterdeck.invalid"
        return approval_app.Request(
            method,
            path,
            headers,
            bytearray(body),
            "proxy",
        )

    def assert_sent_to_sign_in(self, response):
        self.assertEqual(response.status, 303)
        self.assertEqual(list(response.headers), SIGN_IN_REDIRECT_HEADERS)
        self.assertEqual(response.body, b"")
        self.assertNotIn(
            "set-cookie",
            {name.lower() for name, value in response.headers},
        )

    def assert_plain_refusal(self, response):
        self.assertEqual(response.status, 403)
        self.assertEqual(response.body, REFUSED_BODY)
        self.assertNotIn(
            "location",
            {name.lower() for name, value in response.headers},
        )

    def assert_manual_sign_in(self, response):
        self.assertEqual(response.status, 401)
        self.assertEqual(
            list(response.headers),
            [
                *approval_app.ApprovalApplication._security_headers(),
                ("Content-Length", str(len(response.body))),
            ],
        )
        self.assertIn(
            b"Your sign-in has ended or could not be checked.",
            response.body,
        )
        self.assertIn(
            b'<a href="/captain/login">Sign in again</a>',
            response.body,
        )
        for automatic in (b"<script", b"<meta http-equiv", b"<form"):
            self.assertNotIn(automatic, response.body.lower())
        self.assertNotIn(b"session-placeholder", response.body)

    def test_no_session_cookie_with_html_accept_goes_to_sign_in_without_asking_approval(self):
        app, stand_in = self.socket_application()

        response = app.handle(
            self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT, cookie=False)
        )

        self.assert_sent_to_sign_in(response)
        self.assertEqual(stand_in.opened, 0)

    def test_session_refused_by_approval_gets_manual_sign_in_without_a_redirect(self):
        app, stand_in = self.socket_application(reply=REFUSAL)

        response = app.handle(
            self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
        )

        self.assert_manual_sign_in(response)
        self.assertEqual(stand_in.opened, 1)
        asked = json.loads(stand_in.sent[0])
        self.assertEqual(asked["operation"], "authenticate")
        self.assertEqual(asked["request"]["path"], CHAT_PAGE)

    def test_an_always_refusing_socket_never_redirects_over_five_page_loads(self):
        app, stand_in = self.socket_application(reply=REFUSAL)
        bodies = []
        for load in range(5):
            with self.subTest(load=load):
                response = app.handle(
                    self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
                )
                bodies.append(response.body)
                self.assert_manual_sign_in(response)
        self.assertEqual(bodies, [bodies[0]] * 5)
        self.assertEqual(stand_in.opened, 5)
        self.assertEqual(
            [json.loads(sent)["request"]["path"] for sent in stand_in.sent],
            [CHAT_PAGE] * 5,
        )

    def test_every_generic_socket_failure_class_requires_a_tap_not_a_redirect(self):
        document = {
            "operation": "authenticate",
            "session": "t" * 43,
            "request": {
                "method": "GET",
                "path": CHAT_PAGE,
                "headers": {},
                "peer": "proxy",
            },
        }
        for failure in ("peer", "shape", "caller policy", "internal"):
            with self.subTest(failure=failure):
                service = object.__new__(captain_auth_socket.CaptainAuthSocketService)
                service.expected_uid = 1
                caller = mock.Mock()
                identity = mock.Mock()
                service.application = types.SimpleNamespace(_caller=caller)
                service.sign_in = types.SimpleNamespace(require_captain=identity)
                if failure == "caller policy":
                    caller.side_effect = approval_security.ApprovalRefused("stand-in")
                elif failure == "internal":
                    identity.side_effect = RuntimeError("stand-in")
                frame = b"[]\n" if failure == "shape" else json.dumps(document).encode()
                peer = 2 if failure == "peer" else 1
                answers = []
                connection = mock.Mock()
                connection.sendall.side_effect = lambda data: answers.append(bytes(data))
                with (
                    mock.patch.object(captain_auth_socket, "_peer_uid", return_value=peer),
                    mock.patch.object(captain_auth_socket, "_receive", return_value=bytearray(frame)),
                ):
                    service._handle(connection)
                self.assertEqual(answers, [REFUSAL])
                self.assertEqual(caller.call_count, int(failure in {"caller policy", "internal"}))
                self.assertEqual(identity.call_count, int(failure == "internal"))
                app, stand_in = self.socket_application(reply=answers[0])
                response = app.handle(
                    self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
                )
                self.assert_manual_sign_in(response)
                self.assertEqual(stand_in.opened, 1)

    def test_present_but_unusable_session_cookies_never_redirect(self):
        cookies = (
            "__Host-qd-approval=",
            "__Host-qd-approval",
            "__Host-qd-approval=one; __Host-qd-approval=two",
            "__Host-qd-approval=; other=ok",
        )
        app, stand_in = self.socket_application(reply=REFUSAL)
        for cookie in cookies:
            with self.subTest(cookie=cookie):
                request = self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
                request.headers["Cookie"] = cookie
                self.assert_manual_sign_in(app.handle(request))
        self.assertEqual(stand_in.opened, 0)

    def test_unrelated_cookies_do_not_prevent_the_no_session_redirect(self):
        app, stand_in = self.socket_application()
        for cookie in (
            "other=ok",
            "__Host-qd-approval-extra=ok",
            "other=ok; __Host-qd-login=login-placeholder",
        ):
            with self.subTest(cookie=cookie):
                request = self.request(
                    "GET", CHAT_PAGE, accept=HTML_ACCEPT, cookie=False
                )
                request.headers["cookie"] = cookie
                self.assert_sent_to_sign_in(app.handle(request))
        self.assertEqual(stand_in.opened, 0)

    def test_unreachable_approval_keeps_the_refusal_so_sign_in_cannot_loop(self):
        for failure in (
            ConnectionRefusedError(),
            FileNotFoundError(),
            PermissionError(),
            TimeoutError(),
        ):
            with self.subTest(failure=type(failure).__name__):
                app, stand_in = self.socket_application(
                    connect_error=failure
                )

                response = app.handle(
                    self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
                )

                self.assert_plain_refusal(response)
                self.assertEqual(stand_in.opened, 1)

    def test_invalid_approval_answers_keep_the_refusal_so_sign_in_cannot_loop(self):
        answers = {
            "empty": b"",
            "not json": b"not json\n",
            "no newline": b'{"ok":false,"csrf":""}',
            "oversize": b"x" * 9000 + b"\n",
            "list": b"[]\n",
            "missing csrf": b'{"ok":false}\n',
            "missing ok": b'{"csrf":""}\n',
            "extra field": b'{"ok":false,"csrf":"","extra":1}\n',
            "refusal with csrf": b'{"ok":false,"csrf":"x"}\n',
            "null csrf": b'{"ok":false,"csrf":null}\n',
            "zero for false": b'{"ok":0,"csrf":""}\n',
            "null ok": b'{"ok":null,"csrf":""}\n',
            "string ok": b'{"ok":"false","csrf":""}\n',
            "accepted without csrf string": b'{"ok":true,"csrf":1}\n',
            "two lines": REFUSAL + REFUSAL,
        }
        for name, answer in answers.items():
            with self.subTest(answer=name):
                app, stand_in = self.socket_application(reply=answer)

                response = app.handle(
                    self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
                )

                self.assert_plain_refusal(response)
                self.assertEqual(stand_in.opened, 1)

    def test_signed_in_html_request_still_gets_the_chat_page(self):
        app, stand_in = self.socket_application(reply=SIGNED_IN)

        response = app.handle(
            self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(
            dict(response.headers)["Content-Type"],
            "text/html; charset=utf-8",
        )
        page = (ROOT / "chat.html").read_bytes()
        for name in ("chat.css", "chat.js"):
            mark = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()[:12]
            page = page.replace(
                f"/captain/assets/{name}".encode(),
                f"/captain/assets/{name}?v={mark}".encode(),
            )
        self.assertEqual(response.body, page)
        self.assertEqual(stand_in.opened, 1)

    def test_accept_header_decides_who_is_sent_to_sign_in(self):
        sent_to_sign_in = {
            "text/html": "plain html",
            "TEXT/HTML": "media type case",
            "text/html;q=0.1": "small quality",
            "text/html; q=1": "space before q",
            "text/html;q=1.000": "full quality with zeros",
            "text/html;level=1;q=0.5": "other parameter first",
            "application/xhtml+xml": "xhtml alone",
            "text/html,application/xhtml+xml": "html and xhtml",
            "application/json, text/html": "html second",
            "application/json;q=1, text/html;q=0.2": "html low rank",
            (
                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                "*/*;q=0.8"
            ): "browser default",
        }
        kept = {
            "text/html;q=0": "html refused",
            "text/html;q=0.0": "html refused with a decimal",
            "text/html; q=0.000": "html refused with zeros",
            "application/xhtml+xml;q=0": "xhtml refused",
            "text/html;q=0, application/xhtml+xml;q=0": "both refused",
            "application/json, text/html;q=0": "html refused second",
            "*/*": "wildcard alone",
            "text/*": "text wildcard",
            "application/json": "json",
            "text/plain": "plain text",
            "text/htmlx": "similar name",
            "xtext/html": "similar name before",
            "text/html;q=abc": "garbage quality",
            "text/html;q=2": "quality above one",
            "text/html;q=-1": "negative quality",
            "text/html;q=": "empty quality",
            "text/html;q=nan": "not a number quality",
            "text/html;q=1.5": "quality above one with decimals",
            "garbage": "garbage",
            ",,;;;==": "punctuation",
            "": "empty header",
            "   ": "blank header",
        }
        app, stand_in = self.socket_application(reply=REFUSAL)
        for accept in sent_to_sign_in:
            with self.subTest(accept=accept, expected="sign in"):
                response = app.handle(
                    self.request("GET", CHAT_PAGE, accept=accept, cookie=False)
                )
                self.assert_sent_to_sign_in(response)
        for accept in kept:
            with self.subTest(accept=accept, expected="refusal"):
                response = app.handle(
                    self.request("GET", CHAT_PAGE, accept=accept, cookie=False)
                )
                self.assert_plain_refusal(response)

    def test_missing_accept_header_keeps_the_refusal(self):
        for cookie in (True, False):
            with self.subTest(cookie=cookie):
                app, stand_in = self.socket_application(reply=REFUSAL)

                response = app.handle(
                    self.request("GET", CHAT_PAGE, cookie=cookie)
                )

                self.assert_plain_refusal(response)

    def test_accept_header_name_is_case_insensitive(self):
        app, stand_in = self.socket_application(reply=REFUSAL)

        response = app.handle(
            self.request(
                "GET",
                CHAT_PAGE,
                accept=HTML_ACCEPT,
                accept_name="accept",
                cookie=False,
            )
        )

        self.assert_sent_to_sign_in(response)

    def test_other_routes_keep_the_refusal_for_signed_out_html_requests(self):
        routes = (
            ("GET", "/captain/api/chats", b""),
            ("GET", "/captain/api/chat?with=bot-d", b""),
            ("GET", "/captain/cards", b""),
            ("GET", "/captain/cards/repo-lead-1", b""),
            ("GET", "/captain/assets/chat.js", b""),
            ("GET", "/captain/assets/chat.css", b""),
            ("GET", "/captain/chat/", b""),
            (
                "POST",
                "/captain/api/chat?with=bot-d",
                json.dumps(
                    {"text": "Go", "requestId": "r-1", "csrf": "c"}
                ).encode(),
            ),
            (
                "POST",
                "/captain/cards/repo-lead-1/comments",
                json.dumps(
                    {"text": "Go", "requestId": "r-1", "csrf": "c"}
                ).encode(),
            ),
            (
                "POST",
                "/captain/cards/repo-lead-1/answer",
                json.dumps(
                    {"rev": 1, "pick": "A", "note": "", "csrf": "c"}
                ).encode(),
            ),
        )
        scenarios = (
            ("no cookie", {"cookie": False}, b""),
            ("refused session", {}, REFUSAL),
        )
        for scenario, options, reply in scenarios:
            app, stand_in = self.socket_application(reply=reply)
            for method, path, body in routes:
                with self.subTest(scenario=scenario, method=method, path=path):
                    response = app.handle(
                        self.request(
                            method,
                            path,
                            accept=HTML_ACCEPT,
                            body=body,
                            **options,
                        )
                    )

                    self.assert_plain_refusal(response)

    def test_event_stream_keeps_the_refusal_for_signed_out_html_requests(self):
        scenarios = (
            ("no cookie", {"cookie": False}, b""),
            ("refused session", {}, REFUSAL),
        )
        for scenario, options, reply in scenarios:
            with self.subTest(scenario=scenario):
                app, stand_in = self.socket_application(reply=reply)
                request = self.request(
                    "GET",
                    "/captain/events",
                    accept="text/event-stream, text/html",
                    **options,
                )
                with self.assertRaises(approval_security.ApprovalRefused):
                    app.open_events(request, last_event_id=None)

                handler = object.__new__(server.Handler)
                handler.application = app
                handler.headers = {}
                handler.wfile = Sink()
                statuses = []
                sent = []
                handler.send_response_only = statuses.append
                handler.send_header = lambda name, value: sent.append(name)
                handler.end_headers = lambda: None

                handler._handle_events(request)

                self.assertEqual(statuses, [403])
                self.assertEqual(bytes(handler.wfile.body), REFUSED_BODY)
                self.assertNotIn("Location", sent)

    def test_server_sends_the_redirect_with_no_body_and_no_cookie(self):
        app, stand_in = self.socket_application(reply=REFUSAL)
        handler = object.__new__(server.Handler)
        handler.headers = {"Accept-Encoding": "gzip"}
        handler.wfile = Sink()
        statuses = []
        sent = []
        handler.send_response_only = statuses.append
        handler.send_header = lambda name, value: sent.append((name, value))
        handler.end_headers = lambda: None

        handler._send(
            app.handle(
                self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT, cookie=False)
            )
        )

        self.assertEqual(statuses, [303])
        self.assertEqual(sent, SIGN_IN_REDIRECT_HEADERS)
        self.assertEqual(bytes(handler.wfile.body), b"")

    def test_application_does_not_redirect_for_any_refused_cookie(self):
        cases = (
            (
                "gate says sign in required",
                application.AuthenticationRequired("stand-in"),
                401,
                401,
            ),
            (
                "gate says session refused",
                application.SessionRefused("stand-in"),
                401,
                403,
            ),
            (
                "gate refuses without a session answer",
                approval_security.ApprovalRefused("stand-in"),
                403,
                403,
            ),
            (
                "gate is rate limited",
                approval_security.ApprovalRateLimited("stand-in"),
                429,
                429,
            ),
            (
                "gate is broken",
                RuntimeError("stand-in"),
                503,
                503,
            ),
        )
        for name, error, with_html, without_html in cases:
            app = self.application(RefusingGate(error))
            with self.subTest(case=name, accept="html"):
                response = app.handle(
                    self.request("GET", CHAT_PAGE, accept=HTML_ACCEPT)
                )
                self.assertEqual(response.status, with_html)
            with self.subTest(case=name, accept="none"):
                response = app.handle(self.request("GET", CHAT_PAGE))
                self.assertEqual(response.status, without_html)
            with self.subTest(case=name, route="api"):
                response = app.handle(
                    self.request(
                        "GET",
                        "/captain/api/chats",
                        accept=HTML_ACCEPT,
                    )
                )
                self.assertEqual(response.status, without_html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
