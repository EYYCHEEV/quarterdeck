from __future__ import annotations

import re
from urllib.parse import urlencode

import approval_app
import captain_auth
import invite_prompt
from test_approval_app import FakeBackend
from test_session_callback import SessionCallbackTests


class SessionPageTests(SessionCallbackTests):
    def setUp(self):
        super().setUp()
        self.backend = FakeBackend()
        self.app = approval_app.ApprovalApplication(self.state, captain_auth, self.backend, invite_prompt.ReleaseConfig(None, None, None, 'https://approval.example.invalid'), trusted_proxy='proxy.internal', public_origin='https://approval.example.invalid')

    def request(self, path, cookie='', *, method='GET', body=b'', navigation=False, origin=True):
        headers = {'Cookie': cookie, 'User-Agent': 'stand-in iPhone Safari', 'X-Forwarded-For': '198.51.100.20', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'approval.example.invalid'}
        if navigation:
            headers['Sec-Fetch-Dest'] = 'document'
        if method == 'POST':
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
            if origin:
                headers['Origin'] = 'https://approval.example.invalid'
        return approval_app.Request(method, path, headers, bytearray(body), 'proxy.internal')

    def header(self, cookies):
        return '; '.join(f'{name}={value}' for name, value in cookies.items())

    def csrf(self, cookie):
        response = self.app.handle(self.request('/captain/pending', cookie))
        self.assertEqual(response.status, 200)
        return re.search(rb'name="csrf" value="([A-Za-z0-9_-]+)"', response.body).group(1).decode()

    def test_stale_approval_returns_to_safe_get_stepup_without_calling_backend(self):
        cookies, _ = self.login()
        self.clock.value += 901
        header = self.header(cookies)
        csrf = self.csrf(header)
        self.backend.calls.clear()
        response = self.app.handle(self.request('/captain/approve', header, method='POST', body=urlencode({'csrf': csrf, 'code': 'ABCDEFGH'}).encode()))
        self.assertEqual(response.status, 303)
        self.assertEqual(dict(response.headers)['Location'], '/captain/step-up?next=%2Fcaptain%2Fpending')
        self.assertEqual(self.backend.calls, [])
        stepup = self.app.handle(self.request(dict(response.headers)['Location'], header))
        self.assertEqual(stepup.status, 303)
        self.assertIn('prompt=select_account', dict(stepup.headers)['Location'])
        self.assertNotIn('max_age=', dict(stepup.headers)['Location'])

    def test_devices_page_lists_only_coarse_kind_and_current_device(self):
        cookies, _ = self.login()
        page = self.app.handle(self.request('/captain/settings/devices', self.header(cookies), navigation=True))
        self.assertEqual(page.status, 200)
        self.assertIn(b'width=device-width, initial-scale=1', page.body)
        self.assertIn(b'iPhone Safari', page.body)
        self.assertIn(b'This device', page.body)
        self.assertIn(b'Sign out everywhere', page.body)
        self.assertIn(b'signed in with Google in the last 15 minutes', page.body)
        self.assertNotIn(b'198.51.100.20', page.body)
        self.assertNotIn(b'stand-in iPhone Safari', page.body)

    def test_logout_lands_on_a_static_signed_out_page_without_google_redirect(self):
        cookies, _ = self.login()
        header = self.header(cookies)
        response = self.app.handle(self.request('/captain/logout', header, method='POST', body=urlencode({'csrf': self.csrf(header)}).encode()))
        self.assertEqual(response.status, 303)
        self.assertEqual(dict(response.headers)['Location'], '/captain/signed-out')
        page = self.app.handle(self.request('/captain/signed-out'))
        self.assertEqual(page.status, 200)
        self.assertIn(b'You are signed out', page.body)
        self.assertIn(b'Sign in</button>', page.body)
        self.assertNotIn('Location', dict(page.headers))
        self.assertNotIn(b'accounts.google.com', page.body)
        self.assertEqual(self.cookies(response)['__Host-qd-device'], '')
