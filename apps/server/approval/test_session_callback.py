from __future__ import annotations

from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlencode, urlsplit

import approval_app
import approval_security
import captain_auth
import oidc
from test_friendly_sessions import FriendlySessionTests


class Provider:
    def __init__(self, clock):
        self.clock = clock
        self.calls = []

    def authorization_url(self, *, state, nonce, challenge, step_up=False):
        return 'https://identity.example.invalid/auth?' + urlencode({'state': state, 'nonce': nonce, 'challenge': challenge, 'prompt': 'select_account'})

    def exchange_code(self, code, verifier, nonce, *, auth_started):
        self.calls.append((verifier, nonce, auth_started))
        return oidc.FreshIdentity('captain-subject', self.clock())


class SessionCallbackTests(FriendlySessionTests):
    def setUp(self):
        super().setUp()
        captain_auth._authority = None
        self.addCleanup(setattr, captain_auth, '_authority', None)
        self.provider = Provider(self.clock)
        captain_auth.install(self.state, self.provider)

    def request(self, path, cookie=''):
        return approval_app.Request('GET', path, {'Cookie': cookie, 'User-Agent': 'stand-in iPhone Safari'}, bytearray(), 'proxy.internal')

    def cookies(self, response):
        jar = SimpleCookie()
        for name, value in response.headers:
            if name.lower() == 'set-cookie':
                jar.load(value)
        return {name: item.value for name, item in jar.items()}

    def begin(self, cookie='', step_up=False):
        make = captain_auth.step_up_redirect if step_up else captain_auth.login_redirect
        response = make('/captain/chat', request=self.request('/captain/step-up' if step_up else '/captain/login', cookie))
        state = parse_qs(urlsplit(dict(response.headers)['Location']).query)['state'][0]
        cookies = SimpleCookie(cookie)
        for name, value in self.cookies(response).items():
            cookies[name] = value
        header = '; '.join(f'{name}={item.value}' for name, item in cookies.items())
        return state, header, response

    def finish(self, state, header):
        return captain_auth.oidc_callback(self.request('/captain/oidc/callback?' + urlencode({'code': 'accepted-code', 'state': state}), header))

    def login(self):
        state, header, _ = self.begin()
        response = self.finish(state, header)
        return self.cookies(response), response

    def test_device_binding_mismatch_consumes_both_records_before_exchange(self):
        state, header, _ = self.begin()
        jar = SimpleCookie(header)
        jar['__Host-qd-device'] = 'A' * 43
        with self.assertRaises(approval_security.ApprovalRefused):
            self.finish(state, '; '.join(f'{name}={item.value}' for name, item in jar.items()))
        self.assertNotIn(state, captain_auth._authority._returns)
        with self.assertRaises(approval_security.ApprovalRefused):
            self.finish(state, header)
        self.assertEqual(self.provider.calls, [])

    def test_stepup_is_dedicated_rotates_session_and_csrf_and_uses_verified_issue_time(self):
        cookies, _ = self.login()
        first = cookies['__Host-qd-approval']
        owner = self.state.authorize_session(first)
        csrf = self.state.issue_csrf(owner)
        self.clock.value += 60
        header = '; '.join(f'{name}={value}' for name, value in cookies.items())
        state, header, started = self.begin(header, step_up=True)
        query = parse_qs(urlsplit(dict(started.headers)['Location']).query)
        self.assertEqual(query['prompt'], ['select_account'])
        self.assertNotIn('max_age', query)
        self.assertNotIn('claims', query)
        response = self.finish(state, header)
        second = self.cookies(response)
        self.assertEqual(dict(response.headers)['Location'], '/captain/chat')
        self.assertNotEqual(first, second['__Host-qd-approval'])
        self.assertNotEqual(cookies['__Host-qd-device'], second['__Host-qd-device'])
        self.assertIsNone(self.state.authorize_session(first))
        self.assertFalse(self.state.consume_csrf(owner, csrf))
        second_owner = self.state.authorize_session(second['__Host-qd-approval'])
        self.assertEqual(self.state.fresh_until(second_owner), self.clock.value + 900)
        self.assertEqual(len(self.state.devices(second_owner)), 1)
        self.assertIn('Max-Age=2592000', '\n'.join(value for name, value in response.headers if name == 'Set-Cookie'))
