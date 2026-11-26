import contextlib
import gc
import http.client
import io
import json
import os
import socket
import socketserver
import ssl
import threading
import time
import unittest
from unittest import mock

import qd_jmap
from fake_stalwart import DOMAIN, FakeStalwart

BOT = "bot-b"
WANTED = f"qd.wanted.bot-a@{DOMAIN}"
MISSING = f"qd.missing.bot-a@{DOMAIN}"
SMALL, BUSY = 10, 5000
ACK_CALLS = 5
OFFLINE_SESSION = "http://127.0.0.1:18080/jmap/session"
AUTH = {"Authorization": b"Bearer " + f"key-of-{BOT}".encode()}


class SubstringStalwart(FakeStalwart):
    def matches(self, email_id, email, flt):
        if "header" in flt:
            name, value = flt["header"]
            return name == "Message-ID" and value in email["messageId"][0]
        return super().matches(email_id, email, flt)


def put(server, number, mail_id):
    server.mail[BOT][f"x{number}"] = {
        "n": number,
        "receivedAt": server.tick(),
        "mailboxIds": {f"inbox-{BOT}": True},
        "messageId": [mail_id],
        "keywords": {},
        "from": [{"email": f"other@{DOMAIN}"}],
        "subject": f"ASK: {number}",
    }


def stocked(size, copies=1, factory=FakeStalwart):
    server = factory([BOT])
    middle = size // 2
    for number in range(size):
        put(server, number, WANTED if middle <= number < middle + copies else f"qd.other.{number}@{DOMAIN}")
    return server


def copies_of(server, mail_id):
    return sorted(i for i, e in server.mail[BOT].items() if e["messageId"] == [mail_id])


def handled(server):
    return sorted(i for i, e in server.mail[BOT].items() if e["keywords"].get(qd_jmap.HANDLED))


def method_calls(server):
    return [(name, args) for _, _, _, body in server.requests if body
            for name, args, _ in json.loads(body)["methodCalls"]]


def run_command(stalwart, session, *args, transport=None):
    read_end, write_end = os.pipe()
    os.write(write_end, stalwart.key_of(BOT).encode())
    os.close(write_end)
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = qd_jmap.main(["--session", session, "--key-fd", str(read_end), *args], transport=transport)
    return code, out.getvalue(), err.getvalue()


@contextlib.contextmanager
def watching(connection_class):
    made = []
    real_init = connection_class.__init__

    def init(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        made.append(self)

    with mock.patch.object(connection_class, "__init__", init):
        yield made


def command_like_connect(stalwart, session, mail_id):
    credential = qd_jmap.Credential(bytearray(stalwart.key_of(BOT).encode()))
    try:
        mailbox = qd_jmap.Mailbox(qd_jmap.Jmap(session, credential, qd_jmap.HttpTransport()))
        return mailbox.ack(mail_id)
    finally:
        credential.clear()


class StandInHandler(socketserver.StreamRequestHandler):
    def handle(self):
        while self.serve_one():
            pass

    def serve_one(self):
        request_line = self.rfile.readline(65537)
        if not request_line:
            return False
        method, path, _ = request_line.decode("latin-1").split(" ", 2)
        headers = {}
        while (line := self.rfile.readline(65537).decode("latin-1")) not in ("\r\n", "\n", ""):
            name, _, value = line.partition(":")
            headers[name.strip()] = value.strip()
        length = int(headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        self.server.paths.append(path)
        if path == "/redirect":
            self.respond(302, b"", Location="/target")
        elif path == "/big":
            self.respond(200, b"x" * 100)
        elif self.server.fail_after is not None and len(self.server.paths) > self.server.fail_after:
            self.respond(500, b"")
        else:
            status, answer = self.server.stalwart(method, self.server.base + path, headers, body)
            self.respond(status, answer)
        return True

    def respond(self, status, body, **headers):
        head = [f"HTTP/1.1 {status} Stand-in", f"Content-Length: {len(body)}"]
        head.extend(f"{name}: {value}" for name, value in headers.items())
        self.wfile.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)

    def setup(self):
        super().setup()
        with self.server.lock:
            self.server.opened += 1

    def finish(self):
        try:
            super().finish()
        finally:
            with self.server.lock:
                self.server.closed += 1


class StandInServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, stalwart):
        super().__init__(("127.0.0.1", 0), StandInHandler)
        self.stalwart = stalwart
        self.lock = threading.Lock()
        self.opened = self.closed = 0
        self.paths = []
        self.fail_after = None

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


class AckCallsTest(unittest.TestCase):
    def ack(self, server, mail_id=WANTED):
        code, out, err = run_command(server, OFFLINE_SESSION, "ack", mail_id, transport=server)
        self.assertEqual(code, 0, err)
        return server

    def test_ack_makes_as_many_server_calls_on_5000_messages_as_on_10_and_marks_the_copy(self):
        small, busy = self.ack(stocked(SMALL)), self.ack(stocked(BUSY))
        self.assertEqual(len(busy.requests), len(small.requests))
        self.assertLessEqual(len(busy.requests), ACK_CALLS)
        for server in (small, busy):
            self.assertEqual(len(copies_of(server, WANTED)), 1)
            self.assertEqual(handled(server), copies_of(server, WANTED))

    def test_ack_marks_both_copies_of_an_id_among_5000_messages(self):
        busy = self.ack(stocked(BUSY, copies=2))
        self.assertEqual(len(copies_of(busy, WANTED)), 2)
        self.assertEqual(handled(busy), copies_of(busy, WANTED))
        self.assertLessEqual(len(busy.requests), ACK_CALLS)

    def test_ack_marks_only_copies_whose_own_id_is_the_one_asked(self):
        server = stocked(SMALL, factory=SubstringStalwart)
        put(server, 99, f"longer.{WANTED}")
        self.ack(server)
        self.assertEqual(handled(server), copies_of(server, WANTED))
        self.assertEqual(len(copies_of(server, f"longer.{WANTED}")), 1)

    def test_an_id_with_no_copy_is_refused_in_todays_words_after_the_fallback_scan(self):
        server = stocked(BUSY)
        code, out, err = run_command(server, OFFLINE_SESSION, "ack", MISSING, transport=server)
        self.assertEqual((code, out), (qd_jmap.REFUSED, ""))
        self.assertEqual(err, f"qd-jmap: refused, nothing changed: {BOT}'s inbox has no message {MISSING}\n")
        calls = method_calls(server)
        queries = [args["filter"] for name, args in calls if name == "Email/query"]
        header_queries = [flt for flt in queries if "header" in json.dumps(flt)]
        scan_pages = [flt for flt in queries if "header" not in json.dumps(flt)]
        self.assertEqual(len(header_queries), 1)
        self.assertEqual(queries[0], header_queries[0])
        self.assertEqual(len(scan_pages), -(-BUSY // qd_jmap.PAGE))
        self.assertNotIn("Email/set", [name for name, _ in calls])
        self.assertEqual(handled(server), [])

    def test_a_copy_the_search_index_has_not_caught_up_with_is_still_found_by_the_scan(self):
        server = stocked(BUSY, copies=2)
        server.not_yet_indexed.update(copies_of(server, WANTED))
        self.ack(server)
        self.assertEqual(handled(server), copies_of(server, WANTED))


class ConnectionTest(unittest.TestCase):
    def setUp(self):
        self.stalwart = stocked(SMALL)
        self.server = self.start(self.stalwart)
        self.session = f"{self.server.base}/jmap/session"

    def start(self, stalwart):
        server = StandInServer(stalwart)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.stop, server, thread)
        return server

    @staticmethod
    def stop(server, thread):
        server.shutdown()
        server.server_close()
        thread.join()

    def settle(self, server, count):
        deadline = time.monotonic() + 3
        while server.closed < count and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual((server.opened, server.closed), (count, count))

    def test_one_command_over_several_calls_opens_one_connection_and_closes_it_at_the_end(self):
        code, _, err = run_command(self.stalwart, self.session, "ack", WANTED)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.stalwart.requests), ACK_CALLS)
        self.settle(self.server, 1)

    def test_the_connection_is_closed_after_a_refusal(self):
        code, _, _ = run_command(self.stalwart, self.session, "ack", MISSING)
        self.assertEqual(code, qd_jmap.REFUSED)
        self.settle(self.server, 1)

    def test_the_connection_is_closed_after_a_failed_call(self):
        self.server.fail_after = 3
        code, _, err = run_command(self.stalwart, self.session, "ack", WANTED)
        self.assertEqual(code, qd_jmap.MAIL_FAILED)
        self.assertIn("500", err)
        self.settle(self.server, 1)

    def test_a_transport_let_go_at_the_end_of_a_command_closes_its_connection(self):
        self.assertFalse(command_like_connect(self.stalwart, self.session, WANTED))
        gc.collect()
        self.settle(self.server, 1)

    def test_a_transport_let_go_after_a_refusal_closes_its_connection(self):
        with self.assertRaises(qd_jmap.Refused):
            command_like_connect(self.stalwart, self.session, MISSING)
        gc.collect()
        self.settle(self.server, 1)

    def test_a_connection_left_idle_is_not_reused(self):
        now = [0.0]
        transport = qd_jmap.HttpTransport(clock=lambda: now[0])
        for moment in (0.0, 1.0, 100.0):
            now[0] = moment
            self.assertEqual(transport("GET", self.session, AUTH, None)[0], 200)
        transport.close()
        self.settle(self.server, 2)

    def test_a_call_to_another_origin_gets_its_own_connection_and_the_first_is_closed(self):
        other = self.start(FakeStalwart([BOT]))
        transport = qd_jmap.HttpTransport()
        self.assertEqual(transport("GET", self.session, AUTH, None)[0], 200)
        self.assertEqual(transport("GET", f"{other.base}/jmap/session", AUTH, None)[0], 200)
        self.settle(self.server, 1)
        self.assertEqual((other.opened, other.paths), (1, ["/jmap/session"]))
        self.assertEqual(self.server.paths, ["/jmap/session"])
        transport.close()
        self.settle(other, 1)

    def test_a_redirect_answer_is_refused_and_not_followed(self):
        code, out, err = run_command(self.stalwart, f"{self.server.base}/redirect", "wait", "--timeout", "0")
        self.assertEqual((code, out), (qd_jmap.MAIL_FAILED, ""))
        self.assertIn("302", err)
        self.assertEqual(self.server.paths, ["/redirect"])
        self.assertEqual(self.stalwart.requests, [])
        transport = qd_jmap.HttpTransport()
        self.assertEqual(transport("GET", f"{self.server.base}/redirect", AUTH, None), (302, b""))
        self.assertEqual(self.server.paths, ["/redirect", "/redirect"])

    def test_no_proxy_is_used_whatever_the_environment_says(self):
        proxy = socket.socket()
        self.addCleanup(proxy.close)
        proxy.bind(("127.0.0.1", 0))
        proxy.listen()
        proxy.setblocking(False)
        address = f"http://127.0.0.1:{proxy.getsockname()[1]}"
        names = ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")
        with mock.patch.dict(os.environ, {**{name: address for name in names}, "no_proxy": "", "NO_PROXY": ""}):
            code, _, err = run_command(self.stalwart, self.session, "ack", WANTED)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.stalwart.requests), ACK_CALLS)
        with self.assertRaises(BlockingIOError):
            proxy.accept()

    def test_an_answer_over_the_limit_comes_back_one_byte_past_it_and_that_connection_is_not_reused(self):
        transport = qd_jmap.HttpTransport()
        with mock.patch.object(qd_jmap, "MAX_ANSWER_BYTES", 10):
            status, data = transport("GET", f"{self.server.base}/big", {}, None)
        self.assertEqual((status, len(data)), (200, 11))
        self.assertEqual(transport("GET", self.session, AUTH, None)[0], 200)
        transport.close()
        self.settle(self.server, 2)

    def test_a_plain_connection_times_out_after_30_seconds(self):
        transport = qd_jmap.HttpTransport()
        with watching(http.client.HTTPConnection) as made:
            self.assertEqual(transport("GET", self.session, AUTH, None)[0], 200)
        transport.close()
        self.assertEqual([connection.timeout for connection in made], [30])

    def test_a_tls_connection_checks_the_certificate_and_the_name_and_times_out_after_30_seconds(self):
        with watching(http.client.HTTPSConnection) as made:
            self.assertRaises(OSError, qd_jmap.HttpTransport(), "GET", "https://127.0.0.1:1/x", {}, None)
        [connection] = made
        self.assertEqual(connection.timeout, 30)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(connection._context.check_hostname)


if __name__ == "__main__":
    unittest.main()
