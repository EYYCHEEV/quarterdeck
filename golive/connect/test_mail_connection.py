import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

import qd_connect
import qd_jmap
from test_qd_jmap_ack import BOT, MISSING, WANTED, StandInServer, stocked

KEY = "API_" + "k" * 24
KEEPS_CONNECTION = hasattr(qd_jmap.HttpTransport, "close")


class PerCallTransport:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def __call__(self, method, url, headers, body=None):
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=5) as answer:
                return answer.status, answer.read()
        except urllib.error.HTTPError as failure:
            return failure.code, b""


class Adapter:
    bot_name = BOT

    def read(self):
        return bytearray(KEY.encode())


class MailConnectionTest(unittest.TestCase):
    def setUp(self):
        stalwart = stocked(10)
        stalwart.keys = {KEY: BOT}
        self.server = StandInServer(stalwart)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(self.stop, thread)
        self.session = f"{self.server.base}/jmap/session"

    def stop(self, thread):
        self.server.shutdown()
        self.server.server_close()
        thread.join()

    def settle(self, count):
        deadline = time.monotonic() + 3
        while self.server.closed < count and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual((self.server.opened, self.server.closed), (count, count))

    def service(self, transport=None):
        return qd_connect.ConnectService(self.session, Adapter(), None, transport)

    def test_a_command_runs_on_a_transport_that_keeps_no_connection(self):
        with mock.patch.object(qd_jmap, "HttpTransport", PerCallTransport):
            self.assertFalse(self.service().ack(WANTED))
        deadline = time.monotonic() + 3
        while self.server.closed < self.server.opened and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreater(self.server.opened, 0)
        self.assertEqual(self.server.closed, self.server.opened)

    @unittest.skipUnless(KEEPS_CONNECTION, "this qd_jmap opens a new connection for each call")
    def test_a_command_closes_its_connection_when_it_succeeds(self):
        self.assertFalse(self.service().ack(WANTED))
        self.settle(1)

    @unittest.skipUnless(KEEPS_CONNECTION, "this qd_jmap opens a new connection for each call")
    def test_a_failing_command_closes_its_connection_while_its_exception_is_still_held(self):
        try:
            self.service().ack(MISSING)
        except qd_jmap.Refused as held:
            self.assertIsNotNone(held.__traceback__)
            self.settle(1)
        else:
            self.fail("the ack of a missing id was not refused")

    @unittest.skipUnless(KEEPS_CONNECTION, "this qd_jmap opens a new connection for each call")
    def test_a_transport_the_caller_supplied_is_not_closed_by_the_command(self):
        supplied = qd_jmap.HttpTransport()
        self.assertFalse(self.service(supplied).ack(WANTED))
        self.assertIsNotNone(supplied.connection)
        supplied.close()
        self.settle(1)


if __name__ == "__main__":
    unittest.main()
