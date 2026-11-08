import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[1] / "qd-mail-stalwart"))

import jmap_verifier


TOKEN = bytearray(b"API_" + b"A" * 38)
SESSION = "https://mail.example.invalid/.well-known/jmap"


class FakeTransport:
    def __init__(self, active=False):
        self.active = active
        self.headers = []

    def __call__(self, method, url, headers, body=None):
        self.headers.append(headers)
        if not self.active:
            return 401, b""
        if method == "GET":
            return 200, json.dumps(
                {
                    "apiUrl": "https://mail.example.invalid/jmap",
                    "primaryAccounts": {"urn:ietf:params:jmap:mail": "account-1"},
                }
            ).encode()
        calls = json.loads(body)["methodCalls"]
        responses = []
        for name, arguments, call_id in calls:
            if name == "Identity/get":
                result = {"list": [{"id": "identity-1"}]}
            elif name == "Mailbox/get":
                result = {"list": [{"role": "inbox"}, {"role": "drafts"}, {"role": "sent"}]}
            else:
                raise AssertionError(name)
            responses.append([name, result, call_id])
        return 200, json.dumps({"methodResponses": responses}).encode()


class JmapVerifierTests(unittest.TestCase):
    def test_refusal_positive_proof_and_open_client_revocation(self):
        transport = FakeTransport()
        verifier = jmap_verifier.JmapVerifier(SESSION, transport)
        verifier.expect_refused(TOKEN)

        transport.active = True
        verifier.prove(TOKEN)
        opened = verifier.open(TOKEN)
        transport.active = False
        opened.expect_refused()

        self.assertTrue(all(headers["Authorization"].startswith(b"Bearer API_") for headers in transport.headers))
        self.assertEqual(opened.credential._key, bytearray())

    def test_network_failure_is_not_accepted_as_revocation(self):
        def broken(*args, **kwargs):
            raise OSError("stand-in network failure")

        verifier = jmap_verifier.JmapVerifier(SESSION, broken)
        with self.assertRaises(jmap_verifier.VerifyRefused):
            verifier.expect_refused(TOKEN)


if __name__ == "__main__":
    unittest.main(verbosity=2)
