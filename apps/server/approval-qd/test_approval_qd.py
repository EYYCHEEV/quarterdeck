from __future__ import annotations

import base64
import http.client
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlencode, urlsplit

SOURCE = Path(__file__).resolve().parents[1] / 'app'
for relative in reversed(('golive/approval', 'captain-app', 'signup', 'golive/shared', 'golive/door', 'qd-mail-stalwart', 'qd-cards')):
    sys.path.insert(0, str(SOURCE / relative))
PACKAGE = Path(__file__).resolve().parent / 'package'
for relative in reversed(('golive/approval', 'captain-app', 'signup', 'golive/shared')):
    sys.path.insert(0, str(PACKAGE / relative))

import approval_app
import approval_security
import auth_bridge
import captain_auth_socket
import invite_prompt
import oidc
import server

QD_ORIGIN = 'https://qd.example.invalid'
MAIL_ORIGIN = 'https://mail.qd.example.invalid'
SESSION = '__Host-qd-approval'
DEVICE = '__Host-qd-device'
LOGIN = '__Host-qd-login'


class GoogleStandIn:
    def __init__(self):
        self.nonce = None
        self.calls = []

    @staticmethod
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')

    def exchange(self, body):
        values = parse_qs(body.decode(), strict_parsing=True)
        self.calls.append(values)
        now = time.time()
        payload = {'iss': oidc.ISSUER, 'aud': 'standin-client.apps.googleusercontent.com', 'sub': 'standin-captain', 'exp': now + 300, 'iat': now, 'nonce': self.nonce, 'email': 'captain@example.invalid', 'email_verified': True}
        token = self.encode({'alg': 'RS256', 'typ': 'JWT'}) + '.' + self.encode(payload) + '.standin-signature'
        return 200, {'content-type': 'application/json', 'cache-control': 'no-store'}, bytearray(json.dumps({'id_token': token}).encode())


class Instance:
    def __init__(self, root, origin):
        root.mkdir(mode=0o700)
        self.root = root
        self.origin = origin
        self.host = urlsplit(origin).netloc
        self.transport = GoogleStandIn()
        self.provider = oidc.GoogleOidc(client_id='standin-client.apps.googleusercontent.com', client_secret=bytearray(b'fixed-placeholder'), allowed_email='captain@example.invalid', redirect_uri=origin + '/captain/oidc/callback', transport=self.transport)
        self.state = approval_security.ApprovalState(root / 'state.sqlite', b'S' * 32)
        name = 'standin_auth_' + root.name
        spec = importlib.util.spec_from_file_location(name, PACKAGE / 'captain-app/captain_auth.py')
        self.auth = importlib.util.module_from_spec(spec)
        sys.modules[name] = self.auth
        spec.loader.exec_module(self.auth)
        self.auth.install(self.state, self.provider)
        self.backend = server.ApprovalSocketBackend(root / 'absent-join.sock')
        self.app = approval_app.ApprovalApplication(self.state, self.auth, self.backend, invite_prompt.ReleaseConfig(None, None, None, origin), trusted_proxy='127.0.0.1', public_origin=origin)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.handler_for(self.app))
        self.http.daemon_threads = True
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={'poll_interval': 0.01})
        self.thread.start()
        self.cookies = {}

    def close(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(5)
        self.provider.clear()
        sys.modules.pop(self.auth.__name__, None)

    def request_facts(self, method, path, cookies=None, body=b'', origin=None):
        headers = {'X-Forwarded-For': '192.0.2.20', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': self.host}
        values = self.cookies if cookies is None else cookies
        if values:
            headers['Cookie'] = '; '.join(f'{name}={value}' for name, value in values.items())
        if body:
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        if origin is not None:
            headers['Origin'] = origin
        return approval_app.Request(method, path, headers, bytearray(body), '127.0.0.1')

    def request(self, method, path, cookies=None, form=None, origin=None):
        body = b'' if form is None else urlencode(form).encode()
        facts = self.request_facts(method, path, cookies, body, origin)
        client = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=5)
        try:
            client.request(method, path, body=body, headers=facts.headers)
            response = client.getresponse()
            headers = response.getheaders()
            content = response.read()
            jar = SimpleCookie()
            for name, value in headers:
                if name.lower() == 'set-cookie':
                    jar.load(value)
            for name, value in jar.items():
                if value['max-age'] == '0':
                    self.cookies.pop(name, None)
                else:
                    self.cookies[name] = value.value
            return response.status, headers, content
        finally:
            client.close()

    def begin(self, step_up=False):
        result = self.request('GET', '/captain/step-up?next=/captain/cards' if step_up else '/captain/login')
        query = parse_qs(urlsplit(dict(result[1])['Location']).query)
        self.transport.nonce = query['nonce'][0]
        return query, result

    def finish(self, query, cookies=None):
        return self.request('GET', '/captain/oidc/callback?' + urlencode({'code': 'standin-code', 'state': query['state'][0], 'iss': oidc.ISSUER}), cookies)

    def login(self):
        query, started = self.begin()
        return started, self.finish(query)


class ApprovalQdTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='q4-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.qd = Instance(self.base / 'q', QD_ORIGIN)
        self.addCleanup(self.qd.close)
        self.mail = Instance(self.base / 'm', MAIL_ORIGIN)
        self.addCleanup(self.mail.close)

    def test_login_uses_qd_callback_and_pkce(self):
        query, response = self.qd.begin()
        self.assertEqual(response[0], 303)
        self.assertEqual(query['redirect_uri'], ['https://qd.example.invalid/captain/oidc/callback'])
        self.assertEqual(query['code_challenge_method'], ['S256'])
        self.assertEqual(query['prompt'], ['select_account'])
        self.assertEqual(len(query['state'][0]), 43)

    def test_callback_makes_host_only_cookie_and_rejects_mail_host(self):
        query, _ = self.qd.begin()
        facts = self.qd.request_facts('GET', '/captain/oidc/callback?' + urlencode({'code': 'standin-code', 'state': query['state'][0]}))
        facts.headers['X-Forwarded-Host'] = 'mail.qd.example.invalid'
        self.assertEqual(self.qd.app.handle(facts).status, 403)
        status, headers, _ = self.qd.finish(query)
        self.assertEqual(status, 303)
        self.assertEqual(dict(headers)['Location'], '/captain/chat')
        jar = SimpleCookie()
        for name, value in headers:
            if name.lower() == 'set-cookie':
                jar.load(value)
        for name in (SESSION, DEVICE):
            self.assertEqual(jar[name]['domain'], '')
            self.assertEqual(jar[name]['path'], '/')
            self.assertTrue(jar[name]['secure'])
            self.assertTrue(jar[name]['httponly'])
        session = self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards'))
        self.assertIsNotNone(session)
        self.assertEqual(self.qd.transport.calls[0]['redirect_uri'], ['https://qd.example.invalid/captain/oidc/callback'])

    def test_step_up_rotates_session_and_returns_to_cards(self):
        self.qd.login()
        old = dict(self.qd.cookies)
        old_session = self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards'))
        csrf = self.qd.auth.csrf_token(old_session)
        query, started = self.qd.begin(step_up=True)
        self.assertEqual(started[0], 303)
        self.assertEqual(query['redirect_uri'], ['https://qd.example.invalid/captain/oidc/callback'])
        status, headers, _ = self.qd.finish(query)
        self.assertEqual(status, 303)
        self.assertEqual(dict(headers)['Location'], '/captain/cards')
        self.assertNotEqual(old[SESSION], self.qd.cookies[SESSION])
        self.assertNotEqual(old[DEVICE], self.qd.cookies[DEVICE])
        self.assertIsNone(self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards', old)))
        self.assertFalse(self.qd.auth.check_csrf(old_session, {'csrf': csrf}))

    def test_logout_requires_post_csrf_and_clears_storage(self):
        self.qd.login()
        old = dict(self.qd.cookies)
        session = self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards'))
        self.assertEqual(self.qd.request('GET', '/captain/logout')[0], 404)
        self.assertEqual(self.qd.request('POST', '/captain/logout', form={'csrf': 'invalid'}, origin=QD_ORIGIN)[0], 403)
        self.assertIsNotNone(self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards')))
        csrf = self.qd.auth.csrf_token(session)
        status, headers, _ = self.qd.request('POST', '/captain/logout', form={'csrf': csrf}, origin=QD_ORIGIN)
        self.assertEqual(status, 303)
        self.assertEqual(dict(headers).get('Clear-Site-Data'), '"storage"')
        self.assertEqual(dict(headers)['Location'], '/captain/signed-out')
        self.assertNotIn(SESSION, self.qd.cookies)
        self.assertNotIn(DEVICE, self.qd.cookies)
        self.assertIsNone(self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards', old)))
        self.assertEqual(self.qd.request('GET', '/captain/signed-out')[0], 200)

    def test_sessions_and_oidc_state_refused_in_both_directions(self):
        self.qd.login()
        self.mail.login()
        for receiving, other in ((self.qd, self.mail), (self.mail, self.qd)):
            self.assertIsNone(receiving.auth.require_captain(receiving.request_facts('GET', '/captain/cards', other.cookies)))
            self.assertIsNotNone(receiving.auth.require_captain(receiving.request_facts('GET', '/captain/cards')))
            other_session = other.auth.require_captain(other.request_facts('GET', '/captain/cards'))
            other_csrf = other.auth.csrf_token(other_session)
            self.assertEqual(receiving.request('POST', '/captain/logout', form={'csrf': other_csrf}, origin=receiving.origin)[0], 403)
            query, _ = other.begin()
            self.assertEqual(receiving.finish(query, other.cookies)[0], 401)
            self.assertEqual(len(receiving.transport.calls), 1)
        self.assertNotEqual(self.qd.state.path, self.mail.state.path)

    def test_auth_socket_answers_web_bridge_and_fails_without_socket(self):
        self.qd.login()
        folder = self.qd.root / 'a'
        folder.mkdir(mode=0o700)
        folder.chmod(0o2770)
        path = folder / 'a.sock'
        service = captain_auth_socket.CaptainAuthSocketService(self.qd.auth, self.qd.app, path, expected_uid=os.getuid(), socket_mode=0o660, socket_gid=os.getgid())
        service.start()
        self.addCleanup(service.close)
        gate = auth_bridge.SocketApprovalGate(auth_bridge.ApprovalAuthClient(str(path)))
        grant = gate.authenticate(self.qd.request_facts('GET', '/captain/cards'))
        self.assertEqual(len(grant.csrf), 43)
        self.assertGreater(grant.fresh_until, time.time())
        self.assertEqual(path.stat().st_mode & 0o777, 0o660)
        with self.assertRaises(approval_security.ApprovalRefused):
            auth_bridge.ApprovalAuthClient(str(folder / 'absent.sock'))({'operation': 'authenticate'})

    def test_missing_join_fails_closed_and_login_keeps_working(self):
        self.qd.login()
        self.assertEqual(self.qd.request('GET', '/captain/pending')[0], 403)
        self.assertFalse((self.qd.root / 'absent-join.sock').exists())
        self.assertEqual(self.qd.request('GET', '/captain/login')[0], 303)
        self.assertTrue(self.qd.thread.is_alive())

    def test_missing_join_approve_refuses_valid_code_without_crash(self):
        self.qd.login()
        session = self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards'))
        csrf = self.qd.auth.csrf_token(session)
        response = self.qd.request('POST', '/captain/approve', form={'csrf': csrf, 'code': 'ABCDEFGH'}, origin=QD_ORIGIN)
        self.assertEqual(response[0], 403)
        self.assertFalse((self.qd.root / 'absent-join.sock').exists())
        self.assertEqual(self.qd.request('GET', '/captain/login')[0], 303)
        self.assertTrue(self.qd.thread.is_alive())

    def test_public_store_session_creation_requires_no_google(self):
        created = self.qd.state.start_browser_session('standin-captain', device_hash=None, kind='Other browser', fresh_from=time.time())
        self.assertIsNotNone(created)
        self.qd.cookies = {SESSION: created.token, DEVICE: created.device_handle}
        session = self.qd.auth.require_captain(self.qd.request_facts('GET', '/captain/cards'))
        self.assertIsNotNone(session)
        self.assertGreater(self.qd.auth.fresh_until(session), time.time())
        self.assertEqual(self.qd.transport.calls, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
