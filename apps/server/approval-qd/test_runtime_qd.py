from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

SOURCE = Path(__file__).resolve().parents[1] / 'app'
for relative in reversed(('golive/approval', 'captain-app', 'signup', 'golive/shared')):
    sys.path.insert(0, str(SOURCE / relative))
PACKAGE = Path(__file__).resolve().parent / 'package'
for relative in reversed(('golive/approval', 'captain-app', 'signup', 'golive/shared')):
    sys.path.insert(0, str(PACKAGE / relative))
import approval_app
import approval_security
import oidc
import server
from test_server import ApprovalServerTests, FakeOidcConfig


class RuntimeQdTests(unittest.TestCase):
    def setUp(self):
        pin = mock.patch.dict(os.environ, {'QD_ORIGIN_PIN': 'https://qd.example.invalid'})
        pin.start()
        self.addCleanup(pin.stop)
        self.temporary = tempfile.TemporaryDirectory(prefix='r4-', dir=Path(__file__).resolve().parent / 'tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / 'runtime.json'

    def document(self, override=True):
        value = ApprovalServerTests.runtime_document({'artifactUrl': None, 'version': None, 'sha256': None})
        value['publicOrigin'] = 'https://qd.example.invalid' if override else 'https://mail.qd.example.invalid'
        value['paths']['state'] = str(self.root / 'state.sqlite')
        value['paths']['socket'] = str(self.root / 'missing-join.sock')
        value['paths']['captainAuthSocket'] = str(self.root / 'auth.sock')
        if override:
            value['oidcRedirectUri'] = 'https://qd.example.invalid/captain/oidc/callback'
        return value

    def start(self, document):
        self.config.write_text(json.dumps(document))
        private = FakeOidcConfig()
        private.redirect_uri = 'https://mail.qd.example.invalid/captain/oidc/callback'
        observed = []
        def capture(application, auth_service, address, port, **kwargs):
            request = approval_app.Request('GET', '/captain/login', {'X-Forwarded-For': '192.0.2.20', 'X-Forwarded-Host': urlsplit(document['publicOrigin']).netloc, 'X-Forwarded-Proto': 'https'}, bytearray(), 'proxy.internal')
            response = application.handle(request)
            observed.append((response.status, parse_qs(urlsplit(dict(response.headers).get('Location', '')).query).get('redirect_uri')))
        with mock.patch.object(server.sys, 'argv', ['server.py', '--config', str(self.config)]), mock.patch.object(server.oidc, 'load_config', return_value=private), mock.patch.object(server.captain_auth, '_authority', None), mock.patch.object(server, 'serve', side_effect=capture):
            status = server.main()
        self.assertEqual(private.redirect_uri, 'https://mail.qd.example.invalid/captain/oidc/callback')
        return status, observed

    def test_public_override_changes_login_and_keeps_private_config_unchanged(self):
        status, observed = self.start(self.document())
        self.assertEqual(status, 0)
        self.assertEqual(observed, [(303, ['https://qd.example.invalid/captain/oidc/callback'])])

    def test_legacy_config_keeps_original_callback(self):
        status, observed = self.start(self.document(override=False))
        self.assertEqual(status, 0)
        self.assertEqual(observed, [(303, ['https://mail.qd.example.invalid/captain/oidc/callback'])])

    def test_override_must_match_exact_public_callback(self):
        for value in (None, '', 1, 'https://mail.qd.example.invalid/captain/oidc/callback', 'http://qd.example.invalid/captain/oidc/callback', 'https://qd.example.invalid/captain/oidc/callback?next=evil', 'https://qd.example.invalid/other'):
            with self.subTest(value=value):
                document = self.document()
                document['oidcRedirectUri'] = value
                self.config.write_text(json.dumps(document))
                with self.assertRaises(approval_security.ApprovalRefused):
                    server.load_runtime_config(self.config)


if __name__ == '__main__':
    unittest.main(verbosity=2)
