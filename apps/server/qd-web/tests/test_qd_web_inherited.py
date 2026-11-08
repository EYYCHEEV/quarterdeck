import ast
import contextlib
import dataclasses
import gzip
import hashlib
import http.client
import inspect
import io
import json
import runpy
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import application
import approval_app
import live
import cards
import package_plan
import server


APPROVAL_GATE_SHA256 = "0b746d42e87645ad732ef32e417f75ca9341b1f3afaff30c06bcb4dc6e9432e3"
OWNER = b"owner"
CARD_PATH = "/captain/cards/card-1"


class Gate:
    def __init__(self):
        self.posts = []

    def authenticate(self, request):
        return OWNER

    def authorize_post(self, request, csrf):
        self.posts.append(csrf)
        return OWNER

    def issue_csrf(self, owner):
        return "next-token"

    def fresh_until(self, owner):
        return 7.0


class Service:
    def __init__(self):
        self.calls = []

    def card(self, card_id):
        self.calls.append(("card", card_id))
        return {"card": {"id": card_id, "text": "Caf\u00e9"}}

    def answer(self, card_id, rev, pick, note, *, now):
        self.calls.append(("answer", card_id, rev, pick, note, now.isoformat()))
        return {"status": "sent"}

    def comment(self, card_id, text, request_id):
        self.calls.append(("comment", card_id, text, request_id))


class Updates:
    SNAPSHOT = {"projects": [{"name": "Caf\u00e9"}], "z": 1, "a": 2}

    def __init__(self):
        self.after = []

    def snapshot(self):
        return dict(self.SNAPSHOT)

    def events(self, *, after):
        self.after.append(after)
        return iter(())


def build():
    gate, service, updates = Gate(), Service(), Updates()
    return application.CardApplication(gate, service, updates, clock=lambda: 1000.0), gate, service, updates


def request(method, path, body=b"", headers=None):
    return approval_app.Request(method, path, dict(headers or {}), bytearray(body), "127.0.0.1")


def post(path, payload, *, padded_to=None):
    body = json.dumps(payload).encode("utf-8")
    if padded_to is not None:
        body += b" " * (padded_to - len(body))
    return request("POST", path, body, {"Content-Type": "application/json"})


def answer_of(response):
    return response.status, json.loads(response.body)


class CardApplicationTests(unittest.TestCase):
    def test_an_unknown_get_path_and_a_bad_card_id_are_404(self):
        app, gate, service, updates = build()
        for path in ("/captain/other", "/captain/cards/bad_id", "/captain/cards/", "/captain/cards/-a", "/captain/cards/a/b"):
            with self.subTest(path=path):
                self.assertEqual(answer_of(app.handle(request("GET", path))), (404, {"error": "not found"}))
        self.assertEqual(service.calls, [])

    def test_a_url_with_a_scheme_a_host_or_a_fragment_is_404_and_a_query_is_400(self):
        app, gate, service, updates = build()
        for path in ("http://host.invalid/captain/cards", "//host.invalid/captain/cards", "/captain/cards#part"):
            with self.subTest(path=path):
                self.assertEqual(answer_of(app.handle(request("GET", path))), (404, {"error": "not found"}))
        self.assertEqual(answer_of(app.handle(request("GET", "/captain/cards?a=1"))), (400, {"error": "request refused"}))
        self.assertEqual(service.calls, [])

    def test_other_methods_are_405(self):
        app, gate, service, updates = build()
        for method in ("PUT", "DELETE", "HEAD", "PATCH"):
            with self.subTest(method=method):
                self.assertEqual(answer_of(app.handle(request(method, "/captain/cards"))), (405, {"error": "method not allowed"}))

    def test_the_request_body_is_cleared_after_every_outcome(self):
        app, gate, service, updates = build()
        cases = [
            request("POST", CARD_PATH + "/comments", b"not json", {"Content-Type": "application/json"}),
            request("GET", "/captain/cards", b"secret"),
            request("PUT", "/captain/cards", b"secret"),
            post(CARD_PATH + "/comments", {"text": "Hello", "requestId": "r-1", "csrf": "c"}),
        ]
        for case in cases:
            with self.subTest(method=case.method):
                app.handle(case)
                self.assertEqual(len(case.body), 0)

    def test_a_body_of_exactly_the_limit_is_read_and_one_more_byte_is_refused(self):
        app, gate, service, updates = build()
        payload = {"text": "Hello", "requestId": "r-1", "csrf": "c"}
        limit = application.MAX_BODY_BYTES
        self.assertEqual(limit, 16_384)
        self.assertEqual(answer_of(app.handle(post(CARD_PATH + "/comments", payload, padded_to=limit))), (200, {"status": "sent", "csrf": "next-token", "freshUntil": 7.0}))
        self.assertEqual(service.calls, [("comment", "card-1", "Hello", "r-1")])
        self.assertEqual(answer_of(app.handle(post(CARD_PATH + "/comments", payload, padded_to=limit + 1))), (400, {"error": "request refused"}))
        self.assertEqual(len(service.calls), 1)

    def test_bad_bodies_are_400_and_reach_neither_the_gate_nor_the_service(self):
        app, gate, service, updates = build()
        good = {"text": "Hello", "requestId": "r-1", "csrf": "c"}
        cases = {
            "plain text type": request("POST", CARD_PATH + "/comments", json.dumps(good).encode(), {"Content-Type": "text/plain"}),
            "no type": request("POST", CARD_PATH + "/comments", json.dumps(good).encode()),
            "type with a charset": request("POST", CARD_PATH + "/comments", json.dumps(good).encode(), {"Content-Type": "application/json; charset=utf-8"}),
            "broken json": request("POST", CARD_PATH + "/comments", b"{", {"Content-Type": "application/json"}),
            "bad utf-8": request("POST", CARD_PATH + "/comments", b"\xff\xfe", {"Content-Type": "application/json"}),
            "a list": request("POST", CARD_PATH + "/comments", b"[]", {"Content-Type": "application/json"}),
            "a missing field": post(CARD_PATH + "/comments", {"text": "Hello", "csrf": "c"}),
            "an extra field": post(CARD_PATH + "/comments", dict(good, more=1)),
            "a number for the token": post(CARD_PATH + "/comments", dict(good, csrf=5)),
            "answer fields on a comment": post(CARD_PATH + "/comments", {"rev": 1, "pick": "A", "note": "", "csrf": "c"}),
            "comment fields on an answer": post(CARD_PATH + "/answer", good),
        }
        for name, case in cases.items():
            with self.subTest(name=name):
                self.assertEqual(answer_of(app.handle(case)), (400, {"error": "request refused"}))
        self.assertEqual((gate.posts, service.calls), ([], []))

    def test_an_answer_and_a_comment_reach_the_service_with_the_clock_time(self):
        app, gate, service, updates = build()
        self.assertEqual(answer_of(app.handle(post(CARD_PATH + "/answer", {"rev": 3, "pick": "B", "note": "n", "csrf": "t"})))[0], 200)
        self.assertEqual(service.calls, [("answer", "card-1", 3, "B", "n", "1970-01-01T00:16:40+00:00")])
        self.assertEqual(gate.posts, ["t"])

    def test_text_is_written_without_escaping_non_ascii_and_the_tag_covers_the_same_bytes(self):
        app, gate, service, updates = build()
        card_body = app.handle(request("GET", CARD_PATH)).body
        self.assertIn("Caf\u00e9".encode("utf-8"), card_body)
        self.assertNotIn(b"\\u00e9", card_body)
        listed = app.handle(request("GET", "/captain/cards"))
        self.assertIn("Caf\u00e9".encode("utf-8"), listed.body)
        encoded = json.dumps(Updates.SNAPSHOT, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        etag = f'"{hashlib.sha256(encoded).hexdigest()}"'
        self.assertEqual(dict(listed.headers)["ETag"], etag)
        again = app.handle(request("GET", "/captain/cards", headers={"If-None-Match": etag}))
        self.assertEqual((again.status, again.body, dict(again.headers)["ETag"], dict(again.headers)["Content-Length"]), (304, b"", etag, "0"))

    def test_the_stream_cursor_rules(self):
        for value, expected in ((None, 0), ("", 0), ("7", 7), ("007", 7), ("0", 0)):
            with self.subTest(value=value):
                app, gate, service, updates = build()
                response = app.open_events(request("GET", "/captain/events"), last_event_id=value)
                self.assertEqual((response.status, updates.after), (200, [expected]))
        for value in ("x", "-1", "1.5", " 1", "1 ", "+1", "\u0661\u0662", "1x"):
            with self.subTest(value=value):
                app, gate, service, updates = build()
                with self.assertRaises(cards.CardRefused):
                    app.open_events(request("GET", "/captain/events"), last_event_id=value)
                self.assertEqual(updates.after, [])

    def test_the_stream_is_only_for_a_get_of_the_events_path(self):
        app, gate, service, updates = build()
        for method, path in (("POST", "/captain/events"), ("GET", "/captain/event"), ("GET", "/captain/events/")):
            with self.subTest(method=method, path=path):
                with self.assertRaises(cards.CardRefused):
                    app.open_events(request(method, path), last_event_id=None)

    def test_the_stream_headers(self):
        app, gate, service, updates = build()
        response = app.open_events(request("GET", "/captain/events"), last_event_id=None)
        headers = dict(response.headers)
        self.assertEqual(headers["Content-Type"], "text/event-stream; charset=utf-8")
        self.assertEqual((headers["Connection"], headers["X-Accel-Buffering"], headers["Cache-Control"]), ("keep-alive", "no", "no-store"))
        self.assertEqual(list(response.events), [])
        with self.assertRaises(dataclasses.FrozenInstanceError):
            response.status = 500

    def test_every_failure_has_its_status_and_text(self):
        failures = {
            application.AuthenticationRequired("x"): (401, {"error": "sign in required"}),
            application.NotFound("x"): (404, {"error": "not found"}),
            application.approval_security.ApprovalRateLimited("x"): (429, {"error": "request refused"}),
            application.approval_security.ApprovalRefused("x"): (403, {"error": "request refused"}),
            cards.CardRefused("x"): (400, {"error": "request refused"}),
            RuntimeError("x"): (503, {"error": "request unavailable"}),
        }
        for error, expected in failures.items():
            with self.subTest(error=type(error).__name__):
                self.assertEqual(answer_of(application.CardApplication._failure(error)), expected)
        fresh = application.CardApplication._failure(application.approval_security.FreshSignInRequired("x"))
        self.assertEqual((fresh.status, fresh.body, dict(fresh.headers)["Location"]), (303, b"", "/captain/step-up?next=%2Fcaptain%2Fchat"))


class SessionGateTests(unittest.TestCase):
    def test_the_in_process_gate_is_the_frozen_text(self):
        text = inspect.getsource(application.ApprovalGate)
        self.assertEqual(hashlib.sha256(text.encode("utf-8")).hexdigest(), APPROVAL_GATE_SHA256)

    def test_no_shipped_module_builds_the_in_process_gate(self):
        for name in sorted(package_plan.SHIPPED_FILES):
            if not name.endswith(".py") or name == "application.py":
                continue
            tree = ast.parse((PKG / name).read_text(encoding="utf-8"))
            used = [
                node
                for node in ast.walk(tree)
                if (isinstance(node, ast.Name) and node.id == "ApprovalGate")
                or (isinstance(node, ast.Attribute) and node.attr == "ApprovalGate")
                or (isinstance(node, ast.alias) and node.name == "ApprovalGate")
            ]
            with self.subTest(name=name):
                self.assertEqual(used, [])

    def test_the_server_builds_the_gate_that_asks_the_sign_in_service(self):
        tree = ast.parse((PKG / "server.py").read_text(encoding="utf-8"))
        built = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "SocketApprovalGate"
        ]
        self.assertEqual(len(built), 1)


class Headers(http.client.HTTPMessage):
    pass


def headers_of(*pairs):
    message = Headers()
    for name, value in pairs:
        message[name] = value
    return message


class Connection:
    def __init__(self):
        self.timeouts = []

    def settimeout(self, value):
        self.timeouts.append(value)


class Trickle:
    def __init__(self, data, step):
        self.data = data
        self.step = step
        self.position = 0
        self.calls = 0

    def readinto(self, view):
        self.calls += 1
        if self.calls > 200:
            raise AssertionError("read loop did not end")
        chunk = self.data[self.position:self.position + min(self.step, len(view))]
        view[:len(chunk)] = chunk
        self.position += len(chunk)
        return len(chunk)


def framed(headers, data=b"", step=4096):
    return types.SimpleNamespace(headers=headers, connection=Connection(), rfile=Trickle(data, step))


class BodyFramingTests(unittest.TestCase):
    def test_a_plain_length_reads_exactly_that_many_bytes_and_sets_the_read_timeout(self):
        fake = framed(headers_of(("Content-Length", "5")), b"helloEXTRA")
        body = server.Handler._body(fake)
        self.assertEqual((bytes(body), fake.rfile.position, fake.connection.timeouts), (b"hello", 5, [5]))

    def test_a_body_arriving_in_pieces_is_assembled(self):
        fake = framed(headers_of(("Content-Length", "11")), b"hello world", step=2)
        self.assertEqual(bytes(server.Handler._body(fake)), b"hello world")
        self.assertEqual(fake.rfile.calls, 6)

    def test_no_length_is_an_empty_body_with_nothing_read(self):
        fake = framed(headers_of())
        self.assertEqual(bytes(server.Handler._body(fake)), b"")
        self.assertEqual(fake.rfile.calls, 0)

    def test_the_limit_is_inclusive(self):
        limit = application.MAX_BODY_BYTES
        fake = framed(headers_of(("Content-Length", str(limit))), b"x" * limit)
        self.assertEqual(len(server.Handler._body(fake)), limit)
        fake = framed(headers_of(("Content-Length", str(limit + 1))), b"x" * (limit + 1))
        with self.assertRaises(ValueError):
            server.Handler._body(fake)
        self.assertEqual((fake.rfile.calls, fake.connection.timeouts), (0, []))

    def test_every_other_framing_is_refused_before_any_read(self):
        cases = {
            "chunked": headers_of(("Transfer-Encoding", "chunked")),
            "identity transfer": headers_of(("Transfer-Encoding", "identity")),
            "chunked with a length": headers_of(("Transfer-Encoding", "chunked"), ("Content-Length", "1")),
            "two lengths": headers_of(("Content-Length", "1"), ("Content-Length", "1")),
            "two different lengths": headers_of(("Content-Length", "1"), ("Content-Length", "2")),
            "a sign": headers_of(("Content-Length", "+5")),
            "a minus": headers_of(("Content-Length", "-1")),
            "an underscore": headers_of(("Content-Length", "1_0")),
            "text after digits": headers_of(("Content-Length", "5x")),
            "empty": headers_of(("Content-Length", "")),
            "wide digits": headers_of(("Content-Length", "\uff15")),
            "a superscript": headers_of(("Content-Length", "\u00b2")),
            "arabic digits": headers_of(("Content-Length", "\u0665")),
        }
        for name, headers in cases.items():
            with self.subTest(name=name):
                fake = framed(headers, b"xxxxxxxxxx")
                with self.assertRaises(ValueError):
                    server.Handler._body(fake)
                self.assertEqual(fake.rfile.calls, 0)

    def test_a_body_that_ends_early_is_refused(self):
        fake = framed(headers_of(("Content-Length", "10")), b"abc")
        with self.assertRaises((ValueError, BufferError)):
            server.Handler._body(fake)


class Wire:
    def __init__(self, accept="gzip"):
        self.headers = {} if accept is None else {"Accept-Encoding": accept}
        self.status = None
        self.sent = []
        self.ended = 0
        self.wfile = io.BytesIO()

    def _accepts_gzip(self):
        return server.Handler._accepts_gzip(self)

    def send_response_only(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent.append((name, value))

    def end_headers(self):
        self.ended += 1


BODY = json.dumps({"projects": [{"name": "Repo"}] * 20}).encode("utf-8")


def reply(headers, body=BODY, status=200):
    return approval_app.Response(status, tuple(headers), body)


class AcceptEncodingTests(unittest.TestCase):
    def accepts(self, value):
        headers = {} if value is None else {"Accept-Encoding": value}
        return server.Handler._accepts_gzip(types.SimpleNamespace(headers=headers))

    def test_the_quality_rules(self):
        yes = ["gzip", "GZIP", " gzip ", "gzip;q=1", "gzip;q=0.5", "gzip; q=0.001", "gzip;Q=1", "*", "* ;q=0.1", "deflate, gzip;q=0.8", "gzip;foo=bar", "gzip;q=0;q=1", "*;q=0, gzip", ",,gzip", "br, *;q=0.5", "gzip;q=1.0"]
        no = [None, "", "identity", "deflate", "gzip;q=0", "gzip;q=0.0", "gzip;q=1.5", "gzip;q=-1", "gzip;q=abc", "gzip;q=", "gzip;x=1;q=0", "*;q=0", "gzip;q=0, *", "gzip;q=0, *;q=1", "identity, *;q=0", "gzipx", "x-gzip"]
        for value in yes:
            with self.subTest(value=value):
                self.assertTrue(self.accepts(value))
        for value in no:
            with self.subTest(value=value):
                self.assertFalse(self.accepts(value))


class SendTests(unittest.TestCase):
    def send(self, response, accept="gzip"):
        wire = Wire(accept)
        server.Handler._send(wire, response)
        return wire

    def test_json_is_compressed_for_a_client_that_accepts_gzip(self):
        wire = self.send(reply([("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(BODY))), ("Cache-Control", "no-store")]))
        data = wire.wfile.getvalue()
        self.assertEqual(data, gzip.compress(BODY, compresslevel=6, mtime=0))
        self.assertEqual(data[4:8], b"\x00\x00\x00\x00")
        self.assertEqual(wire.status, 200)
        self.assertEqual(wire.ended, 1)
        self.assertEqual(
            wire.sent,
            [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Cache-Control", "no-store"),
                ("Content-Encoding", "gzip"),
                ("Vary", "Accept-Encoding"),
                ("Content-Length", str(len(data))),
            ],
        )

    def test_the_vary_list_keeps_what_was_there_and_names_accept_encoding_once(self):
        cases = {
            "Cookie": "Cookie, Accept-Encoding",
            "Origin,Cookie": "Origin, Cookie, Accept-Encoding",
            "Origin, accept-encoding": "Origin, accept-encoding",
            "ACCEPT-ENCODING": "ACCEPT-ENCODING",
            " , Cookie , ": "Cookie, Accept-Encoding",
        }
        for before, after in cases.items():
            with self.subTest(before=before):
                wire = self.send(reply([("Content-Type", "application/json"), ("vary", before), ("content-encoding", "identity")]))
                self.assertEqual([value for name, value in wire.sent if name == "Vary"], [after])
                self.assertEqual([value for name, value in wire.sent if name.lower() == "content-encoding"], ["gzip"])
                self.assertEqual([name for name, value in wire.sent if name.lower() == "vary"], ["Vary"])

    def test_nothing_changes_when_gzip_is_not_asked_for_or_not_useful(self):
        cases = {
            "client does not accept": (reply([("Content-Type", "application/json"), ("Content-Length", str(len(BODY)))]), "identity"),
            "client sends nothing": (reply([("Content-Type", "application/json"), ("Content-Length", str(len(BODY)))]), None),
            "not json": (reply([("Content-Type", "text/html; charset=utf-8"), ("Content-Length", str(len(BODY)))]), "gzip"),
            "no type": (reply([("Content-Length", str(len(BODY)))]), "gzip"),
            "empty body": (reply([("Content-Type", "application/json"), ("Content-Length", "0")], b"", 304), "gzip"),
        }
        for name, (response, accept) in cases.items():
            with self.subTest(name=name):
                wire = self.send(response, accept)
                self.assertEqual(wire.sent, list(response.headers))
                self.assertEqual(wire.wfile.getvalue(), response.body)
                self.assertEqual((wire.status, wire.ended), (response.status, 1))

    def test_the_type_is_matched_without_regard_to_case(self):
        wire = self.send(reply([("content-type", "Application/JSON; charset=utf-8")]))
        self.assertIn(("Content-Encoding", "gzip"), wire.sent)


class HandleTests(unittest.TestCase):
    class Fake:
        def __init__(self, body, application_object):
            self.body = body
            self.application = application_object
            self.sent = []
            self.streamed = []
            self.command = "POST"
            self.path = "/captain/cards"
            self.headers = {}
            self.client_address = ("127.0.0.1", 40000)

        def _body(self):
            return self.body

        def _request(self, body):
            return server.Handler._request(self, body)

        def _send(self, response):
            self.sent.append(response)

        def _handle_events(self, request):
            self.streamed.append(request)

    class Raising:
        def is_events(self, request):
            return False

        def handle(self, request):
            self.seen = request
            raise RuntimeError("broken")

    class Quiet(Raising):
        def handle(self, request):
            return approval_app.Response(200, (), b"{}")

    class Streaming(Raising):
        def is_events(self, request):
            return True

    def test_a_failure_answers_400_and_clears_the_body(self):
        body = bytearray(b"secret")
        fake = self.Fake(body, self.Raising())
        server.Handler._handle(fake)
        self.assertEqual(answer_of(fake.sent[0]), (400, {"error": "request refused"}))
        self.assertEqual(len(body), 0)
        self.assertIs(fake.application.seen.body, body)

    def test_a_body_that_cannot_be_read_answers_400(self):
        fake = self.Fake(None, self.Quiet())
        fake._body = lambda: (_ for _ in ()).throw(ValueError("framing"))
        server.Handler._handle(fake)
        self.assertEqual(answer_of(fake.sent[0]), (400, {"error": "request refused"}))

    def test_a_good_request_is_answered_by_the_application_and_a_stream_is_handed_over(self):
        fake = self.Fake(bytearray(b"{}"), self.Quiet())
        server.Handler._handle(fake)
        self.assertEqual([item.status for item in fake.sent], [200])
        self.assertEqual(fake.streamed, [])
        fake = self.Fake(bytearray(), self.Streaming())
        server.Handler._handle(fake)
        self.assertEqual((fake.sent, len(fake.streamed)), ([], 1))

    def test_the_request_carries_the_method_the_path_the_headers_the_body_and_the_peer(self):
        body = bytearray(b"b")
        fake = self.Fake(body, self.Quiet())
        fake.headers = headers_of(("X-One", "1"))
        made = server.Handler._request(fake, body)
        self.assertEqual((made.method, made.path, made.headers, made.peer), ("POST", "/captain/cards", {"X-One": "1"}, "127.0.0.1"))
        self.assertIs(made.body, body)


class ServeTests(unittest.TestCase):
    def parts(self, events, *, start_fails=False, serve_fails=False):
        class Httpd:
            def __init__(self, address, handler):
                events.append(("bind", address, handler.application))

            def serve_forever(self, poll_interval):
                events.append(("serve", poll_interval))
                if serve_fails:
                    raise RuntimeError("serve failed")

            def server_close(self):
                events.append("server_close")

        class Updates:
            def start(self):
                events.append("updates.start")
                if start_fails:
                    raise RuntimeError("start failed")

            def stop(self):
                events.append("updates.stop")

        class Mailbox:
            def close(self):
                events.append("mailbox.close")

        return Httpd, Updates(), Mailbox()

    def run_serve(self, events, **faults):
        Httpd, updates, mailbox = self.parts(events, **faults)
        marker = object()
        original = server.PrivateServer
        server.PrivateServer = Httpd
        try:
            server.serve(marker, updates, mailbox, 8080)
        finally:
            server.PrivateServer = original
        return marker

    def test_the_order_of_a_normal_run(self):
        events = []
        marker = self.run_serve(events)
        self.assertEqual(events, [("bind", ("", 8080), marker), "updates.start", ("serve", 0.5), "server_close", "updates.stop", "mailbox.close"])

    def test_everything_is_closed_when_serving_fails(self):
        events = []
        with self.assertRaises(RuntimeError):
            self.run_serve(events, serve_fails=True)
        self.assertEqual(events[-3:], ["server_close", "updates.stop", "mailbox.close"])

    def test_nothing_serves_and_everything_is_closed_when_the_updates_do_not_start(self):
        events = []
        with self.assertRaises(RuntimeError):
            self.run_serve(events, start_fails=True)
        self.assertNotIn(("serve", 0.5), events)
        self.assertEqual(events[-3:], ["server_close", "updates.stop", "mailbox.close"])

    def test_the_server_class_settings(self):
        self.assertIs(server.PrivateServer.daemon_threads, True)
        self.assertIs(server.PrivateServer.allow_reuse_address, False)

    def test_the_bound_handler_class(self):
        marker = object()
        bound = server.handler_for(marker)
        self.assertTrue(issubclass(bound, server.Handler))
        self.assertIs(bound.application, marker)
        self.assertEqual(bound.__name__, "BoundCaptainHandler")


class TickService:
    def __init__(self, failures=0):
        self.refreshes = 0
        self.value = 0
        self.failures = failures
        self.delay = 0.0
        self.inside = threading.Event()
        self.lock = threading.Lock()

    def refresh(self):
        with self.lock:
            self.refreshes += 1
            if self.refreshes <= self.failures:
                raise RuntimeError("mail server refused")
            payload = {"n": self.value}
        if self.delay:
            self.inside.set()
            time.sleep(self.delay)
        return payload

    def chat_list(self):
        return []


def wait_until(test, check, seconds=10.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.01)
    return check()


def bounded(test, function, seconds=5.0):
    box = []
    worker = threading.Thread(target=lambda: box.append(function()), daemon=True)
    worker.start()
    worker.join(seconds)
    test.assertFalse(worker.is_alive(), "the call did not return")
    return box[0]


class TickThreadTests(unittest.TestCase):
    def make(self, interval=0.4, failures=0):
        service = TickService(failures)
        updates = live.LiveUpdates(service)
        updates.interval_seconds = interval
        self.addCleanup(self.finish, updates)
        return service, updates

    def finish(self, updates):
        closer = threading.Thread(target=updates.stop, daemon=True)
        closer.start()
        closer.join(5)
        self.assertFalse(closer.is_alive(), "stop did not return")

    def test_the_tick_is_every_five_seconds(self):
        self.assertEqual(live.LiveUpdates.interval_seconds, 5)
        self.assertEqual(live.LiveUpdates(TickService()).interval_seconds, 5)

    def test_start_checks_once_at_once_and_the_loop_waits_a_full_interval_before_it_checks(self):
        service, updates = self.make(interval=0.5)
        updates.start()
        self.assertEqual(service.refreshes, 1)
        self.assertEqual(updates.version, 1)
        time.sleep(0.15)
        self.assertEqual(service.refreshes, 1)
        self.assertTrue(wait_until(self, lambda: service.refreshes >= 2))
        self.assertLessEqual(service.refreshes, 3)

    def test_the_loop_waits_between_checks(self):
        service, updates = self.make(interval=0.3)
        updates.start()
        self.assertTrue(wait_until(self, lambda: service.refreshes >= 3))
        start = time.monotonic()
        before = service.refreshes
        time.sleep(0.6)
        self.assertLessEqual(service.refreshes - before, 4)
        self.assertGreaterEqual(time.monotonic() - start, 0.6)

    def test_a_failing_check_is_swallowed_and_the_loop_keeps_its_pace(self):
        service, updates = self.make(interval=0.3, failures=3)
        updates.start()
        self.assertTrue(wait_until(self, lambda: service.refreshes >= 4))
        self.assertTrue(wait_until(self, lambda: updates.version == 1))
        started = time.monotonic()
        before = service.refreshes
        time.sleep(0.6)
        self.assertLessEqual(service.refreshes - before, 4)
        self.assertGreaterEqual(time.monotonic() - started, 0.6)

    def test_a_second_start_changes_nothing_and_a_start_after_stop_ticks_again(self):
        service, updates = self.make(interval=0.2)
        updates.start()
        first = updates._thread
        count = service.refreshes
        updates.start()
        self.assertIs(updates._thread, first)
        self.assertEqual(service.refreshes, count)
        self.finish(updates)
        self.assertFalse(first.is_alive())
        self.assertIsNone(updates._thread)
        before = service.refreshes
        updates.start()
        self.assertTrue(updates._thread.is_alive())
        self.assertEqual(updates._thread.name, "quarterdeck-card-checker")
        self.assertTrue(updates._thread.daemon)
        self.assertTrue(wait_until(self, lambda: service.refreshes >= before + 3))

    def test_stop_ends_the_thread_and_a_stream_that_is_waiting(self):
        service, updates = self.make()
        updates.start()
        received = []

        def consume():
            for item in updates.events(after=updates.version):
                received.append(item)
                if len(received) >= 3:
                    return

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        time.sleep(0.1)
        self.assertTrue(reader.is_alive())
        thread = updates._thread
        self.finish(updates)
        reader.join(5)
        self.assertFalse(reader.is_alive())
        self.assertFalse(thread.is_alive())
        self.assertEqual(received, [])

    def test_stop_waits_for_a_check_that_is_running(self):
        service, updates = self.make(interval=0.05)
        updates.start()
        self.assertTrue(wait_until(self, lambda: service.refreshes >= 2))
        service.delay = 0.5
        self.assertTrue(service.inside.wait(5))
        thread = updates._thread
        self.finish(updates)
        self.assertFalse(thread.is_alive())

    def test_a_change_wakes_a_waiting_stream_with_the_fixed_text(self):
        service, updates = self.make()
        updates.check_once()
        received = []
        seen = threading.Event()

        def consume():
            for item in updates.events(after=updates.version):
                received.append(item)
                seen.set()
                return

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        time.sleep(0.1)
        self.assertEqual(received, [])
        service.value = 1
        self.assertIs(bounded(self, updates.check_once), True)
        self.assertTrue(seen.wait(5))
        self.assertEqual(received, ['id: 2\nevent: refresh\ndata: {"cards":true,"chats":false,"mail":true}\n\n'])

    def test_a_check_that_finds_nothing_new_keeps_the_version(self):
        service, updates = self.make()
        self.assertIs(updates.check_once(), True)
        self.assertIs(updates.check_once(), False)
        self.assertEqual(updates.version, 1)
        service.value = 5
        self.assertIs(updates.check_once(), True)
        self.assertEqual((updates.version, updates.snapshot()), (2, {"n": 5}))

    def test_the_cursor_must_be_a_non_negative_integer(self):
        service, updates = self.make()
        updates.check_once()
        for bad in (-1, True, False, "1", 1.5, None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    next(updates.events(after=bad))
        first = bounded(self, lambda: next(updates.events(after=0)))
        self.assertTrue(first.startswith("id: 1\n"))


class ObjectLoaderTests(unittest.TestCase):
    def test_only_a_json_object_is_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.json"
            path.write_text('{"a": 1}', encoding="utf-8")
            self.assertEqual(server._load_object(str(path)), {"a": 1})
            for text in ("[]", '"text"', "5", "null", "{", ""):
                path.write_text(text, encoding="utf-8")
                with self.subTest(text=text):
                    with self.assertRaises(RuntimeError):
                        server._load_object(str(path))
            path.write_bytes(b"\xff\xfe")
            with self.assertRaises(RuntimeError):
                server._load_object(str(path))
            with self.assertRaises(RuntimeError):
                server._load_object(str(Path(folder) / "absent.json"))


class CommandLineTests(unittest.TestCase):
    def test_a_start_without_the_config_option_is_refused_naming_the_program(self):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as stopped:
                server.main([])
        self.assertEqual(stopped.exception.code, 2)
        self.assertIn("usage: qd-web [-h] --config CONFIG", errors.getvalue())

    def test_running_the_file_as_a_program_exits_with_the_status_of_main(self):
        errors = io.StringIO()
        saved = sys.argv
        sys.argv = ["server.py"]
        try:
            with contextlib.redirect_stderr(errors):
                with self.assertRaises(SystemExit) as stopped:
                    runpy.run_path(str(PKG / "server.py"), run_name="__main__")
        finally:
            sys.argv = saved
        self.assertEqual(stopped.exception.code, 2)

    def test_the_configuration_is_frozen(self):
        config = server.RuntimeConfig(8080, "https://jmap.invalid/session", "/k", "/r", "/g", "/a")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            config.port = 1
        self.assertFalse(hasattr(config, "__dict__"))


if __name__ == "__main__":
    unittest.main()
