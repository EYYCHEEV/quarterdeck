import json
import unittest

import qd_jmap
from fake_stalwart import FakeStalwart
from test_qd_jmap_ack import BOT, OFFLINE_SESSION, run_command

ORIGIN = "http://127.0.0.1:18080"
FIELDS = {
    "uploadUrl": "/jmap/upload/{accountId}/",
    "downloadUrl": "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
    "eventSourceUrl": "/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
}
FOREIGN_ORIGINS = (
    "http://127.0.0.1:18081",
    "https://elsewhere.example.test",
    "http://[::1]:18080",
    "http://someone@127.0.0.1:18080",
)
NOT_FIXED = ("{origin}/jmap/x/", "http://{host}/jmap/x/", "http://127.0.0.1:18080{rest}/x/", "https:{rest}", 5)


class SessionWithFields(FakeStalwart):
    def __init__(self, bots, fields):
        super().__init__(bots)
        self.fields = fields

    def __call__(self, method, url, headers, body=None):
        status, data = super().__call__(method, url, headers, body)
        if method == "GET" and status == 200:
            data = json.dumps({**json.loads(data), **self.fields}).encode()
        return status, data


class SessionOriginTest(unittest.TestCase):
    def wait(self, fields):
        server = SessionWithFields([BOT], fields)
        code, out, err = run_command(server, OFFLINE_SESSION, "wait", "--timeout", "0", transport=server)
        return server, code, out, err

    def assert_refused_on_another_origin(self, field):
        for origin in FOREIGN_ORIGINS:
            with self.subTest(origin=origin):
                server, code, out, err = self.wait({field: origin + FIELDS[field]})
                self.assertEqual((code, out), (qd_jmap.MAIL_FAILED, ""), err)
                self.assertIn(field, err)
                self.assertEqual(len(server.requests), 1)

    def test_an_upload_url_on_another_origin_is_refused(self):
        self.assert_refused_on_another_origin("uploadUrl")

    def test_a_download_url_on_another_origin_is_refused(self):
        self.assert_refused_on_another_origin("downloadUrl")

    def test_an_event_source_url_on_another_origin_is_refused(self):
        self.assert_refused_on_another_origin("eventSourceUrl")

    def test_templates_on_the_session_origin_are_accepted(self):
        for fields in ({name: ORIGIN + path for name, path in FIELDS.items()}, dict(FIELDS), {}):
            with self.subTest(fields=fields):
                server, code, out, err = self.wait(fields)
                self.assertEqual((code, out), (qd_jmap.NOTHING_NEW, ""), err)
                self.assertGreater(len(server.requests), 1)

    def test_a_template_whose_origin_is_not_fixed_before_its_first_brace_is_refused(self):
        for field in FIELDS:
            for template in NOT_FIXED:
                with self.subTest(field=field, template=template):
                    server, code, out, err = self.wait({field: template})
                    self.assertEqual((code, out), (qd_jmap.MAIL_FAILED, ""), err)
                    self.assertIn(field, err)
                    self.assertEqual(len(server.requests), 1)


if __name__ == "__main__":
    unittest.main()
