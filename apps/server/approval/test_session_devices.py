from __future__ import annotations

import contextlib
import io

from test_friendly_sessions import FriendlySessionTests


class DeviceSessionTests(FriendlySessionTests):
    def test_bound_device_replacement_rotates_both_cookies_and_burns_old_csrf(self):
        first = self.state.start_browser_session('captain-subject', device_hash=None, kind='iPhone Safari', fresh_from=self.start)
        self.assertIsNotNone(first)
        owner = self.state.authorize_session(first.token)
        csrf = self.state.issue_csrf(owner)
        bound = self.state.device_verifier(first.device_handle)
        self.clock.value += 60
        second = self.state.start_browser_session('captain-subject', device_hash=bound, kind='iPhone Safari', fresh_from=self.clock.value)
        self.assertIsNotNone(second)
        self.assertNotEqual(first.token, second.token)
        self.assertNotEqual(first.device_handle, second.device_handle)
        self.assertIsNone(self.state.authorize_session(first.token))
        self.assertFalse(self.state.consume_csrf(owner, csrf))
        self.assertIsNotNone(self.state.authorize_session(second.token))
        devices = self.state.devices(self.state.authorize_session(second.token))
        self.assertEqual(len(devices), 1)
        self.assertTrue(devices[0]['current'])
        self.assertEqual(devices[0]['kind'], 'iPhone Safari')
        self.assertEqual(self.state.fresh_until(self.state.authorize_session(second.token)), self.start + 60 + 900)
        database_bytes = (self.root / 'state.sqlite').read_bytes()
        self.assertNotIn(first.device_handle.encode(), database_bytes)
        self.assertNotIn(second.device_handle.encode(), database_bytes)

    def test_expiry_commits_one_fixed_end_line_and_never_logs_values(self):
        first = self.state.start_browser_session('captain-subject', device_hash=None, kind='Mac Safari', fresh_from=self.start)
        self.clock.value += 7 * 86400
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            self.assertIsNone(self.state.authorize_session(first.token))
            self.assertIsNone(self.state.authorize_session(first.token))
        self.assertEqual(log.getvalue().splitlines().count('QD_SESSION_END reason=idle'), 1)
        for value in (first.token, first.device_handle, 'captain-subject', 'Mac Safari'):
            self.assertNotIn(value, log.getvalue())

    def test_ninth_device_ends_the_oldest_idle_one_instead_of_refusing_signin(self):
        sessions = []
        for index in range(8):
            sessions.append(self.state.start_browser_session('captain-subject', device_hash=None, kind='Other browser', fresh_from=self.clock.value))
            self.clock.value += 1
        owner = self.state.authorize_session(sessions[0].token)
        self.assertTrue(self.state.touch_session(owner))
        self.clock.value += 1
        newest = self.state.start_browser_session('captain-subject', device_hash=self.state.device_verifier('x' * 43), kind='Other browser', fresh_from=self.clock.value)
        self.assertIsNotNone(newest)
        self.assertIsNotNone(self.state.authorize_session(sessions[0].token))
        self.assertIsNone(self.state.authorize_session(sessions[1].token))
        self.assertEqual(len(self.state.devices(self.state.authorize_session(newest.token))), 8)

    def test_activity_never_extends_freshness_and_device_end_revokes_csrf(self):
        first = self.state.start_browser_session('captain-subject', device_hash=None, kind='Mac Safari', fresh_from=self.start)
        owner = self.state.authorize_session(first.token)
        csrf = self.state.issue_csrf(owner)
        device = self.state.devices(owner)[0]['id']
        self.clock.value += 901
        self.assertTrue(self.state.touch_session(owner))
        self.assertEqual(self.state.fresh_until(owner), self.start + 900)
        self.assertTrue(self.state.revoke_device(owner, device))
        self.assertIsNone(self.state.authorize_session(first.token))
        self.assertFalse(self.state.consume_csrf(owner, csrf))
