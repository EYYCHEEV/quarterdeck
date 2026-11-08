import gzip
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import application
import auth_bridge
import bundle
import checker_adapter
import mail_gateway
import mailstate
import mounts
import server
from test_cards import FakeMail, FixtureChecker, card, message


NOW = 1_700_000_000.0
INDEX = b'<!doctype html><html><head><script>var theme = 1;</script></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'
REGISTRY = {"format": 1, "steward": "bot-a", "captain": "account-user", "projects": {"Fleet": "bot-a", "Repo": "repo-lead"}}


def config_document(**changes):
    document = {
        "format": 1,
        "bindPort": 8080,
        "jmapSessionUrl": "https://jmap.invalid/session",
        "keyPath": "/run/quarterdeck-captain-mail/captain.key",
        "keyReadbackPath": "/var/lib/quarterdeck-captain/key-readback.json",
        "registryPath": "/var/lib/quarterdeck-captain/project-registry.json",
        "authSocket": "/run/quarterdeck-qd-auth/auth.sock",
    }
    document.update(changes)
    return document


class Folder(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)

    def write_config(self, document):
        path = self.root / "runtime.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        return str(path)


class ConfigTests(Folder):
    def test_the_required_keys_give_the_defaults(self):
        config = server.load_runtime_config(self.write_config(config_document()))
        self.assertEqual(config.port, 8080)
        self.assertEqual(config.bundle_dir, "/opt/quarterdeck/qd-web/static")
        self.assertIsNone(config.mail_state_path)
        self.assertEqual(config.auth_socket, "/run/quarterdeck-qd-auth/auth.sock")

    def test_the_optional_keys_are_read(self):
        config = server.load_runtime_config(self.write_config(config_document(bundleDir="/srv/site", mailStatePath="/var/lib/quarterdeck-qd-web/mail-threads.json")))
        self.assertEqual((config.bundle_dir, config.mail_state_path), ("/srv/site", "/var/lib/quarterdeck-qd-web/mail-threads.json"))

    def test_every_bad_document_is_refused(self):
        required = list(config_document())
        bad = [config_document(format=2), config_document(bindPort=8081), config_document(chatBots=[]), config_document(extra=1)]
        bad += [{key: value for key, value in config_document().items() if key != missing} for missing in required]
        bad += [config_document(keyPath="relative"), config_document(registryPath="relative"), config_document(keyReadbackPath="relative"), config_document(authSocket="relative")]
        bad += [config_document(bundleDir="relative"), config_document(mailStatePath="relative"), config_document(bundleDir=""), config_document(mailStatePath=""), config_document(bundleDir=5), config_document(mailStatePath=None), config_document(jmapSessionUrl=""), config_document(keyPath="/a\0b")]
        bad += [[], "text", 5, None]
        for document in bad:
            with self.subTest(document=str(document)[:60]):
                with self.assertRaises(RuntimeError):
                    server.load_runtime_config(self.write_config(document))

    def test_a_missing_file_and_broken_json_are_refused(self):
        with self.assertRaises(RuntimeError):
            server.load_runtime_config(str(self.root / "absent.json"))
        broken = self.root / "broken.json"
        broken.write_text("{", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            server.load_runtime_config(str(broken))
        binary = self.root / "binary.json"
        binary.write_bytes(b"\xff\xfe")
        with self.assertRaises(RuntimeError):
            server.load_runtime_config(str(binary))

    def test_the_refusal_text_never_names_the_values(self):
        try:
            server.load_runtime_config(self.write_config(config_document(keyPath="relative-secret-name")))
        except RuntimeError as error:
            self.assertNotIn("relative-secret-name", str(error))


class MailMountTests(Folder):
    def module(self, **members):
        module = types.ModuleType("mail_api")
        for name, value in members.items():
            setattr(module, name, value)
        return module

    def test_without_the_module_nothing_is_mounted(self):
        with mock.patch.dict(sys.modules, {"mail_api": None}):
            self.assertIsNone(mounts.load_mail(object(), object(), lambda: 0.0, None, lambda: None))
            self.assertIsNone(mounts.load_mail(object(), object(), lambda: 0.0, "/var/lib/x/threads.json", lambda: None))

    def test_the_module_gets_the_mailbox_the_gate_the_clock_the_state_path_and_the_state_reader(self):
        calls = []

        class MailApi:
            def __init__(self, mailbox, sessions, *, clock, mail_state_path, mail_state):
                calls.append((mailbox, sessions, clock, mail_state_path, mail_state))

        mailbox, gate, clock, reader = object(), object(), lambda: 1.0, lambda: "s1"
        path = str(self.root / "threads.json")
        with mock.patch.dict(sys.modules, {"mail_api": self.module(MailApi=MailApi)}):
            mounted = mounts.load_mail(mailbox, gate, clock, path, reader)
        self.assertIsInstance(mounted, MailApi)
        self.assertEqual(calls, [(mailbox, gate, clock, path, reader)])

    def test_a_module_without_the_state_keyword_stops_the_start(self):
        class MailApi:
            def __init__(self, mailbox, sessions, *, clock, mail_state_path):
                pass

        with mock.patch.dict(sys.modules, {"mail_api": self.module(MailApi=MailApi)}):
            with self.assertRaises(TypeError):
                mounts.load_mail(object(), object(), lambda: 0.0, str(self.root / "threads.json"), lambda: None)

    def test_a_bad_state_path_stops_the_start_when_the_module_exists(self):
        class MailApi:
            def __init__(self, mailbox, sessions, *, clock, mail_state_path, mail_state):
                raise AssertionError("must not be built")

        for path in (None, "relative.json", str(self.root / "no-folder" / "threads.json"), 5):
            with self.subTest(path=path):
                with mock.patch.dict(sys.modules, {"mail_api": self.module(MailApi=MailApi)}):
                    with self.assertRaisesRegex(RuntimeError, r"^Captain mail state path is invalid$"):
                        mounts.load_mail(object(), object(), lambda: 0.0, path, lambda: None)

    def test_any_other_import_failure_stops_the_start(self):
        def broken(name):
            raise ModuleNotFoundError("No module named 'other'", name="other")

        with mock.patch.object(mounts.importlib, "import_module", broken):
            with self.assertRaises(ModuleNotFoundError):
                mounts.load_mail(object(), object(), lambda: 0.0, None, lambda: None)

    def test_an_error_inside_the_module_stops_the_start(self):
        class MailApi:
            def __init__(self, mailbox, sessions, *, clock, mail_state_path, mail_state):
                raise ValueError("thread table is broken")

        with mock.patch.dict(sys.modules, {"mail_api": self.module(MailApi=MailApi)}):
            with self.assertRaises(ValueError):
                mounts.load_mail(object(), object(), lambda: 0.0, str(self.root / "threads.json"), lambda: None)


class StateStub:
    def __init__(self):
        self.value = "one"
        self.runs = 0

    def run(self, refresh):
        self.runs += 1
        return refresh()

    def token(self):
        return self.value


class AuthStandIn:
    def __init__(self, path):
        self.path = path
        self.issued = set()
        self.count = 0
        self.requests = []
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(path)
        self.listener.listen(8)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def token(self):
        self.count += 1
        value = f"tok-{self.count}"
        self.issued.add(value)
        return value

    def answer(self, request):
        refused = {"ok": False, "csrf": "", "freshUntil": 0, "freshRequired": False}
        session = request["session"]
        if session not in {"good", "stale"}:
            return refused
        if request["operation"] == "authorize-post":
            if session == "stale":
                return {"ok": False, "csrf": "", "freshUntil": 0, "freshRequired": True}
            if request["csrf"] not in self.issued:
                return refused
            self.issued.discard(request["csrf"])
        return {"ok": True, "csrf": self.token(), "freshUntil": NOW + 600, "freshRequired": False}

    def serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            with connection:
                data = b""
                while not data.endswith(b"\n"):
                    chunk = connection.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                request = json.loads(data)
                self.requests.append(request)
                connection.sendall(json.dumps(self.answer(request)).encode() + b"\n")

    def close(self):
        try:
            self.listener.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.listener.close()


class Running(Folder):
    files = {"index.html": INDEX, "app.js": b"export const a = 1;", "app.css": b"body{}"}
    mail_module = None

    def setUp(self):
        super().setUp()
        site = self.root / "site"
        site.mkdir()
        for name, data in self.files.items():
            (site / name).write_bytes(data)
        self.auth = AuthStandIn(str(self.root / "auth.sock"))
        self.addCleanup(self.auth.close)
        self.mailbox = FakeMail([message("m1", "repo-lead", "CARD: Choose", card("repo-lead-1", "Repo", "Launch", "Choose"))])
        state = self.root / "state"
        state.mkdir()
        self.config = server.RuntimeConfig(8080, "https://jmap.invalid/session", "/k", "/r", "/g", str(self.root / "auth.sock"), str(site), str(state / "threads.json"))
        gate = auth_bridge.SocketApprovalGate(auth_bridge.ApprovalAuthClient(self.config.auth_socket))
        patched = mock.patch.dict(sys.modules, {"mail_api": self.mail_module})
        patched.start()
        self.addCleanup(patched.stop)
        self.state = StateStub()
        self.app, self.updates = server.assemble(self.config, mailbox=self.mailbox, checker=FixtureChecker(), gate=gate, state=self.state, clock=lambda: NOW)
        self.updates.check_once()
        self.httpd = server.PrivateServer(("127.0.0.1", 0), server.handler_for(self.app))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.updates.stop()
        self.httpd.shutdown()
        self.httpd.server_close()

    def call(self, method, path, *, headers=None, body=None, session="good"):
        sent = {} if headers is None else dict(headers)
        if session is not None:
            sent["Cookie"] = f"__Host-qd-approval={session}"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=sent)
            response = connection.getresponse()
            data = response.read()
            return response.status, {name.lower(): value for name, value in response.getheaders()}, data
        finally:
            connection.close()

    def post(self, path, payload, *, session="good"):
        return self.call("POST", path, headers={"Content-Type": "application/json"}, body=json.dumps(payload), session=session)

    def raw(self, data):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
            connection.sendall(data)
            connection.shutdown(socket.SHUT_WR)
            received = b""
            while True:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                received += chunk
        head, _, body = received.partition(b"\r\n\r\n")
        return int(head.split(b" ", 2)[1]), body


class SmokeTests(Running):
    def test_the_card_list_is_served_over_a_real_socket(self):
        status, headers, data = self.call("GET", "/captain/cards")
        self.assertEqual(status, 200)
        body = json.loads(data)
        self.assertEqual(body["projects"][0]["lanes"][0]["cards"][0]["id"], "repo-lead-1")
        self.assertRegex(headers["etag"], r'^"[0-9a-f]{64}"$')
        self.assertTrue(body["csrf"].startswith("tok-"))
        self.assertEqual(body["freshUntil"], NOW + 600)

    def test_the_list_answers_304_for_its_etag(self):
        _, headers, _ = self.call("GET", "/captain/cards")
        status, again, data = self.call("GET", "/captain/cards", headers={"If-None-Match": headers["etag"]})
        self.assertEqual((status, data, again["content-length"]), (304, b"", "0"))

    def test_one_card_is_served(self):
        status, _, data = self.call("GET", "/captain/cards/repo-lead-1")
        self.assertEqual((status, json.loads(data)["card"]["id"]), (200, "repo-lead-1"))

    def test_an_answer_is_sent_as_mail_and_its_token_works_once(self):
        _, _, data = self.call("GET", "/captain/cards")
        token = json.loads(data)["csrf"]
        status, _, receipt = self.post("/captain/cards/repo-lead-1/answer", {"rev": 1, "pick": "A", "note": "", "csrf": token})
        body = json.loads(receipt)
        self.assertEqual((status, body["stale"], body["rev"]), (200, False, 1))
        self.assertRegex(body["message"], r"^Got it: repo-lead-1 A at ")
        self.assertEqual([entry[0] for entry in self.mailbox.sent], ["repo-lead", "bot-a"])
        again, _, refused = self.post("/captain/cards/repo-lead-1/answer", {"rev": 1, "pick": "B", "note": "", "csrf": token})
        self.assertEqual((again, json.loads(refused)), (403, {"error": "request refused"}))
        self.assertEqual(len(self.mailbox.sent), 2)

    def test_a_comment_is_sent_as_mail(self):
        _, _, data = self.call("GET", "/captain/cards")
        status, _, receipt = self.post("/captain/cards/repo-lead-1/comments", {"text": "Hello", "requestId": "r-1", "csrf": json.loads(data)["csrf"]})
        self.assertEqual((status, json.loads(receipt)["status"]), (200, "sent"))
        self.assertTrue(self.mailbox.sent)

    def test_a_stale_fresh_sign_in_is_a_303_with_no_body(self):
        status, headers, data = self.post("/captain/cards/repo-lead-1/answer", {"rev": 1, "pick": "A", "note": "", "csrf": "tok-1"}, session="stale")
        self.assertEqual((status, data), (303, b""))
        self.assertEqual(headers["location"], "/captain/step-up?next=%2Fcaptain%2Fchat")
        self.assertEqual(self.mailbox.sent, [])

    def test_the_events_stream_sends_the_fixed_refresh_text(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(connection.close)
        connection.request("GET", "/captain/events", headers={"Cookie": "__Host-qd-approval=good"})
        response = connection.getresponse()
        self.assertEqual((response.status, response.getheader("Content-Type")), (200, "text/event-stream; charset=utf-8"))
        lines = [response.readline() for _ in range(3)]
        self.assertEqual(lines, [b"id: 1\n", b"event: refresh\n", b'data: {"cards":true,"chats":true,"mail":true}\n'])

    def test_the_events_stream_refuses_a_missing_session_and_a_bad_cursor_and_a_query(self):
        self.assertEqual(self.call("GET", "/captain/events", session=None)[0], 403)
        self.assertEqual(self.call("GET", "/captain/events", session="bad")[0], 403)
        self.assertEqual(self.call("GET", "/captain/events", headers={"Last-Event-ID": "x1"})[0], 400)
        self.assertEqual(self.call("GET", "/captain/events?x=1")[0], 400)

    def test_a_missing_or_refused_session_is_403_on_the_real_bridge(self):
        for session in (None, "bad"):
            with self.subTest(session=session):
                status, _, data = self.call("GET", "/captain/cards", session=session)
                self.assertEqual((status, json.loads(data)), (403, {"error": "request refused"}))

    def test_an_auth_socket_that_is_down_is_403_and_never_serves_cards(self):
        self.auth.close()
        status, _, data = self.call("GET", "/captain/cards")
        self.assertEqual((status, json.loads(data)), (403, {"error": "request refused"}))
        self.assertNotIn(b"repo-lead-1", data)

    def test_the_bundle_is_served_without_a_session(self):
        status, headers, data = self.call("GET", "/", session=None)
        self.assertEqual((status, data), (200, INDEX))
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertIn("'sha256-", headers["content-security-policy"])
        self.assertEqual(self.call("GET", "/queue/repo-lead-1", session=None)[2], INDEX)
        self.assertEqual(self.call("GET", "/app.js", session=None)[2], b"export const a = 1;")
        self.assertEqual(self.auth.requests, [])

    def test_head_has_no_body_and_the_length_of_a_get(self):
        status, headers, data = self.call("HEAD", "/app.js", session=None)
        self.assertEqual((status, data, headers["content-length"]), (200, b"", str(len(self.files["app.js"]))))

    def test_the_chat_path_is_a_303_to_the_root(self):
        status, headers, data = self.call("GET", "/captain/chat", session=None)
        self.assertEqual((status, headers["location"], data), (303, "/", b""))

    def test_other_methods_are_405_and_unknown_paths_are_404_for_any_method(self):
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS", "BREW"):
            with self.subTest(method=method):
                status, headers, _ = self.call(method, "/captain/cards")
                self.assertEqual((status, headers["allow"]), (405, "GET"))
        for method in ("GET", "POST", "PUT", "BREW"):
            with self.subTest(method=method):
                self.assertEqual(self.call(method, "/nope")[0], 404)
        self.assertEqual(self.call("HEAD", "/captain/cards")[0], 405)
        self.assertEqual(self.call("GET", "/captain/cards/repo-lead-1/answer")[0], 405)

    def test_the_old_chat_assets_and_the_sign_in_paths_are_404_here(self):
        for path in ("/captain/api/chat?with=bot-a", "/captain/assets/chat.js", "/captain/login", "/captain/oidc/callback", "/captain/step-up", "/captain/logout"):
            with self.subTest(path=path):
                self.assertIn(self.call("GET", path)[0], {400, 404})
        self.assertEqual(self.call("POST", "/captain/logout")[0], 404)

    def test_json_is_compressed_for_a_client_that_accepts_gzip_and_the_bundle_is_not(self):
        status, headers, data = self.call("GET", "/captain/cards", headers={"Accept-Encoding": "gzip"})
        self.assertEqual((status, headers["content-encoding"], headers["vary"]), (200, "gzip", "Accept-Encoding"))
        self.assertEqual(json.loads(gzip.decompress(data))["projects"][0]["name"], "Repo")
        self.assertNotIn("content-encoding", self.call("GET", "/app.js", headers={"Accept-Encoding": "gzip"})[1])

    def test_framing_that_is_not_plain_is_refused_400(self):
        base = b"POST /captain/cards/repo-lead-1/answer HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
        cases = {
            "chunked": base + b"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            "two lengths": base + b"Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
            "bad length": base + b"Content-Length: 1x\r\n\r\nx",
            "too large": base + b"Content-Length: 20000\r\n\r\n",
            "short body": base + b"Content-Length: 10\r\n\r\nabc",
        }
        for name, data in cases.items():
            with self.subTest(name=name):
                status, body = self.raw(data)
                self.assertEqual((status, json.loads(body)), (400, {"error": "request refused"}))
        self.assertEqual(self.mailbox.sent, [])

    def test_percent_encoded_bytes_in_a_path_are_never_decoded(self):
        self.assertEqual(self.call("GET", "/captain/cards/a%0d%0ab")[0], 404)
        self.assertEqual(self.call("GET", "/captain/mail/a%00b")[0], 404)
        self.assertEqual(self.call("GET", "/%61pp.js", session=None)[0], 404)
        self.assertEqual(self.call("GET", "/app.js%00.css", session=None)[0], 404)


class MailSmokeTests(Running):
    class MailApi:
        def __init__(self, mailbox, sessions, *, clock, mail_state_path, mail_state):
            self.sessions = sessions
            self.path = mail_state_path
            self.mail_state = mail_state

        def handle(self, request, path):
            owner = self.sessions.authenticate(request)
            return application.CardApplication._response(
                200, {"threads": [], "path": path, "state": self.mail_state(), "csrf": self.sessions.issue_csrf(owner)}
            )

    mail_module = types.ModuleType("mail_api")
    mail_module.MailApi = MailApi

    def test_the_mail_routes_work_end_to_end_with_the_real_bridge(self):
        status, _, data = self.call("GET", "/captain/mail")
        self.assertEqual((status, json.loads(data)["path"]), (200, "/captain/mail"))
        self.assertEqual(self.call("GET", "/captain/mail/MT-1")[0], 200)
        self.assertEqual(self.call("GET", "/captain/mail", session=None)[0], 403)
        self.assertEqual(self.call("GET", "/captain/mail?x=1")[0], 400)
        self.assertEqual(self.call("POST", "/captain/mail")[0], 405)

    def test_the_module_reads_the_shared_state_the_tick_holds(self):
        self.assertEqual(json.loads(self.call("GET", "/captain/mail")[2])["state"], "one")
        self.state.value = "two"
        self.assertEqual(json.loads(self.call("GET", "/captain/mail")[2])["state"], "two")

    def test_a_changed_mail_state_sends_the_next_event(self):
        self.state.value = "one"
        self.updates.check_once()
        before = self.updates.version
        self.state.value = "two"
        self.assertTrue(self.updates.check_once())
        self.assertEqual(self.updates.version, before + 1)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(connection.close)
        connection.request("GET", "/captain/events", headers={"Cookie": "__Host-qd-approval=good", "Last-Event-ID": str(before)})
        response = connection.getresponse()
        self.assertEqual(response.readline(), f"id: {before + 1}\n".encode())


class StartupFailureTests(Folder):
    def paths(self, **changes):
        site = self.root / "site"
        site.mkdir(exist_ok=True)
        (site / "index.html").write_bytes(INDEX)
        registry = self.root / "registry.json"
        registry.write_text(json.dumps(REGISTRY), encoding="utf-8")
        readback = self.root / "readback.json"
        readback.write_text("{}", encoding="utf-8")
        document = config_document(
            keyPath=str(self.root / "captain.key"),
            keyReadbackPath=str(readback),
            registryPath=str(registry),
            authSocket=str(self.root / "auth.sock"),
            bundleDir=str(site),
        )
        document.update(changes)
        return self.write_config(document)

    def test_a_bad_config_stops_the_start_before_anything_opens(self):
        with mock.patch.object(mail_gateway.CaptainMailbox, "open") as opened:
            with self.assertRaises(RuntimeError):
                server.main(["--config", self.write_config({"format": 2})])
        opened.assert_not_called()

    def test_a_missing_registry_or_readback_stops_the_start_before_the_mailbox_opens(self):
        for key in ("registryPath", "keyReadbackPath"):
            with self.subTest(key=key):
                path = self.paths(**{key: str(self.root / "absent.json")})
                with mock.patch.object(mail_gateway.CaptainMailbox, "open") as opened:
                    with self.assertRaises(RuntimeError):
                        server.main(["--config", path])
                opened.assert_not_called()

    def test_a_bundle_that_cannot_load_closes_the_mailbox_and_stops(self):
        for change in ({"bundleDir": str(self.root / "absent")}, {"bundleDir": str(self.root / "empty-bundle")}):
            with self.subTest(change=change):
                (self.root / "empty-bundle").mkdir(exist_ok=True)
                path = self.paths(**change)
                fake = mock.Mock()
                fake.close = mock.Mock()
                with mock.patch.object(mail_gateway.CaptainMailbox, "open", return_value=fake):
                    with self.assertRaises(bundle.BundleRefused):
                        server.main(["--config", path])
                fake.close.assert_called_once_with()

    def test_a_bad_mail_state_path_closes_the_mailbox_and_stops_when_the_module_exists(self):
        class MailApi:
            def __init__(self, mailbox, sessions, *, clock, mail_state_path, mail_state):
                raise AssertionError("must not be built")

        module = types.ModuleType("mail_api")
        module.MailApi = MailApi
        path = self.paths(mailStatePath=str(self.root / "no-folder" / "threads.json"))
        fake = mock.Mock()
        with mock.patch.dict(sys.modules, {"mail_api": module}):
            with mock.patch.object(mail_gateway.CaptainMailbox, "open", return_value=fake):
                with self.assertRaises(RuntimeError):
                    server.main(["--config", path])
        fake.close.assert_called_once_with()

    def test_the_mailbox_is_opened_through_one_metered_transport_that_the_gate_shares(self):
        path = self.paths()
        fake = mock.Mock()
        seen = {}

        def stop_at_once(app, updates, mailbox, port):
            seen["updates"] = updates

        with mock.patch.dict(sys.modules, {"mail_api": None}):
            with mock.patch.object(mail_gateway.CaptainMailbox, "open", return_value=fake) as opened:
                with mock.patch.object(server, "serve", stop_at_once):
                    server.main(["--config", path])
        transport = opened.call_args.kwargs["transport"]
        self.assertIsInstance(transport, mailstate.MeteredTransport)
        gate = seen["updates"]._gate
        self.assertIsInstance(gate, mailstate.StateGate)
        self.assertIs(gate._budget, transport._budget)
        self.assertIs(gate._clock, time.monotonic)
        self.assertIs(transport._budget._clock, time.monotonic)

    def test_a_started_server_that_stops_closes_the_mailbox_and_the_updates(self):
        path = self.paths()
        fake = mock.Mock()
        served = []

        def stop_at_once(app, updates, mailbox, port):
            served.append(port)
            mailbox.close()

        with mock.patch.dict(sys.modules, {"mail_api": None}):
            with mock.patch.object(mail_gateway.CaptainMailbox, "open", return_value=fake):
                with mock.patch.object(server, "serve", stop_at_once):
                    self.assertEqual(server.main(["--config", path]), 0)
        self.assertEqual(served, [8080])
        fake.close.assert_called_once_with()


class ChecksTests(unittest.TestCase):
    def test_the_checker_adapter_loads_the_real_checker_with_a_registry(self):
        checker = checker_adapter.LaneAChecker(REGISTRY)
        self.assertEqual((checker.account_name, checker.oversight_bot), ("account-user", "bot-a"))


if __name__ == "__main__":
    unittest.main()
