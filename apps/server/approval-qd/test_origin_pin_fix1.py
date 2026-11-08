from __future__ import annotations

from http.cookies import SimpleCookie
import json
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

import test_runtime_qd as fixtures
from test_approval_qd import GoogleStandIn


class OriginPinFixTests(fixtures.RuntimeQdTests):
    def test_fix1_matching_alternate_origin_is_refused_before_serving(self):
        document = self.document()
        document['publicOrigin'] = 'https://evil.example'
        document['oidcRedirectUri'] = 'https://evil.example/captain/oidc/callback'
        self.assertEqual(self.start(document), (2, []))

    def test_fix1_non_string_origins_are_refused_without_escaping_exception(self):
        for origin in (None, 1, False, [], {}):
            with self.subTest(origin=origin):
                document = self.document()
                document['publicOrigin'] = origin
                self.config.write_text(json.dumps(document))
                with self.assertRaises(fixtures.approval_security.ApprovalRefused):
                    fixtures.server.load_runtime_config(self.config)
                self.assertEqual(self.start(document), (2, []))

    def flow(self, document, private_callback):
        self.config.write_text(json.dumps(document))
        private = fixtures.FakeOidcConfig()
        private.redirect_uri = private_callback
        transport = GoogleStandIn()
        observed = []

        def capture(application, auth_service, address, port, **kwargs):
            headers = {'X-Forwarded-For': '192.0.2.20', 'X-Forwarded-Host': urlsplit(document['publicOrigin']).netloc, 'X-Forwarded-Proto': 'https'}
            started = application.handle(fixtures.approval_app.Request('GET', '/captain/login', headers, bytearray(), 'proxy.internal'))
            query = parse_qs(urlsplit(dict(started.headers).get('Location', '')).query)
            transport.nonce = query['nonce'][0]
            jar = SimpleCookie()
            for name, value in started.headers:
                if name.lower() == 'set-cookie':
                    jar.load(value)
            headers['Cookie'] = '; '.join(f'{name}={value.value}' for name, value in jar.items())
            callback = '/captain/oidc/callback?' + urlencode({'state': query['state'][0], 'code': 'standin-code', 'iss': fixtures.oidc.ISSUER})
            completed = application.handle(fixtures.approval_app.Request('GET', callback, headers, bytearray(), 'proxy.internal'))
            observed.append((started.status, query.get('redirect_uri'), completed.status, [call.get('redirect_uri') for call in transport.calls]))

        with mock.patch.object(fixtures.server.sys, 'argv', ['server.py', '--config', str(self.config)]), mock.patch.object(fixtures.server.oidc, 'load_config', return_value=private), mock.patch.object(fixtures.server.oidc, 'GoogleTokenTransport', return_value=transport), mock.patch.object(fixtures.server.captain_auth, '_authority', None), mock.patch.object(fixtures.server, 'serve', side_effect=capture):
            status = fixtures.server.main()
        self.assertEqual(private.redirect_uri, private_callback)
        return status, observed

    def test_fix1_exact_pair_reaches_authorize_and_token_exchange(self):
        result = self.flow(self.document(), 'https://mail.qd.example.invalid/captain/oidc/callback')
        callback = 'https://qd.example.invalid/captain/oidc/callback'
        self.assertEqual(result, (0, [(303, [callback], 303, [[callback]])]))

    def test_fix1_staging_without_override_uses_private_staging_callback(self):
        document = self.document(override=False)
        document['publicOrigin'] = 'https://stage.example.invalid'
        callback = 'https://stage.example.invalid/captain/oidc/callback'
        self.assertEqual(self.flow(document, callback), (0, [(303, [callback], 303, [[callback]])]))


if __name__ == '__main__':
    unittest.main(verbosity=2)
