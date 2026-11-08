from __future__ import annotations

import contextlib
import io
import sqlite3
from contextlib import closing

import approval_app
import approval_security
import captain_auth
import application
from urllib.parse import urlencode
from test_session_callback import SessionCallbackTests
from test_session_pages import SessionPageTests


class ActivityTests(SessionPageTests):
    def web(self, method, path, token, fields=None):
        return self.request(path, '__Host-qd-approval=' + token, method=method, body=urlencode(fields or {}).encode() if method == 'POST' else b'')

    def test_server_activity_allowlist_denies_background_and_unknown_routes(self):
        token = self.state.start_identity_session('captain-subject')
        owner = self.state.authorize_session(token)
        gate = application.ApprovalGate(self.app)
        self.clock.value += 600
        paths = ['/captain/api/chats', '/captain/api/chat?with=bot-a', '/captain/events', '/captain/assets/chat.js', '/captain/health', '/captain/status', '/captain/new-route', '/captain/step-up']
        for path in paths:
            request = self.web('GET', path, token)
            request.headers['Sec-Fetch-Dest'] = 'document'
            gate.authenticate(request)
        request = self.web('GET', '/captain/chat', token)
        request.headers.update({'Sec-Fetch-Dest': 'document', 'If-None-Match': 'stand-in'})
        gate.authenticate(request)
        for _ in range(2):
            self.state.issue_csrf(owner)
        self.assertEqual(self.state.devices(owner)[0]['lastUsed'], self.start)
        request.headers.pop('If-None-Match')
        gate.authenticate(request)
        self.assertEqual(self.state.devices(owner)[0]['lastUsed'], self.clock.value)
        for path in ['/captain/api/chat', '/captain/cards/card-a/comments']:
            self.clock.value += 1
            request = self.web('POST', path, token)
            gate.authorize_post(request, self.state.issue_csrf(owner))
            self.assertEqual(self.state.devices(owner)[0]['lastUsed'], self.clock.value)
        self.assertEqual(self.state.fresh_until(owner), 0)

    def test_every_existing_risky_route_is_server_selected(self):
        for path in ['/captain/approve', '/captain/refuse', '/captain/invites/create', '/captain/invites/cancel', '/captain/settings/approval-password', approval_security.EVERYWHERE_PATH, '/captain/cards/card-a/answer']:
            with self.subTest(path=path):
                self.assertTrue(approval_security.requires_fresh('POST', path))
                self.assertFalse(approval_security.requires_fresh('GET', path))
        for path in ['/captain/api/chat', '/captain/logout', '/captain/cards/card-a/comments']:
            self.assertFalse(approval_security.requires_fresh('POST', path))
        self.assertFalse(approval_security.activity_allowed('POST', '/captain/new-action', {}))

    def test_all_risky_actions_refuse_after_normal_signin_freshness_expires(self):
        cookies, _ = self.login()
        token = cookies['__Host-qd-approval']
        owner = self.state.authorize_session(token)
        other = self.state.start_browser_session('captain-subject', device_hash=None, kind='Mac Safari', fresh_from=None)
        target = next(row['id'] for row in self.state.devices(owner) if not row['current'])
        self.clock.value += 901
        self.backend.calls.clear()
        forms = [
            ('/captain/approve', {'code': 'ABCDEFGH'}),
            ('/captain/refuse', {'code': 'ABCDEFGH'}),
            ('/captain/invites/create', {'botName': 'sample-bot'}),
            ('/captain/invites/cancel', {'inviteId': 'A' * 12}),
            ('/captain/settings/approval-password', {'action': 'enable', 'currentPassword': '', 'newPassword': 'standin-only-password'}),
            (approval_security.DEVICE_SIGNOUT_PATH, {'deviceId': str(target)}),
            (approval_security.EVERYWHERE_PATH, {}),
        ]
        for path, fields in forms:
            with self.subTest(path=path):
                csrf = self.state.issue_csrf(owner)
                response = self.app.handle(self.web('POST', path, token, {**fields, 'csrf': csrf}))
                self.assertEqual(response.status, 303)
                self.assertTrue(dict(response.headers)['Location'].startswith('/captain/step-up?next='))
                self.assertFalse(self.state.consume_csrf(owner, csrf))
        gate = application.ApprovalGate(self.app)
        with self.assertRaises(approval_security.FreshSignInRequired):
            gate.authorize_post(self.web('POST', '/captain/cards/card-a/answer', token), self.state.issue_csrf(owner))
        self.assertEqual(self.backend.calls, [])
        self.assertFalse(self.state.approval_password_required())
        self.assertIsNotNone(self.state.authorize_session(other.token))
        self.assertEqual(self.state.fresh_until(owner), self.start + 900)

    def test_devices_and_everywhere_require_origin_and_one_use_csrf(self):
        first = self.state.start_browser_session('captain-subject', device_hash=None, kind='Mac Safari', fresh_from=self.start)
        second = self.state.start_browser_session('captain-subject', device_hash=None, kind='iPhone Safari', fresh_from=None)
        owner = self.state.authorize_session(first.token)
        target = next(row['id'] for row in self.state.devices(owner) if not row['current'])
        for path, fields in [(approval_security.DEVICE_SIGNOUT_PATH, {'deviceId': str(target)}), (approval_security.EVERYWHERE_PATH, {})]:
            csrf = self.state.issue_csrf(owner)
            request = self.web('POST', path, first.token, {**fields, 'csrf': csrf})
            request.headers['Origin'] = 'https://other.example.invalid'
            self.assertEqual(self.app.handle(request).status, 403)
            request = self.web('POST', path, first.token, {**fields, 'csrf': 'bad'})
            self.assertEqual(self.app.handle(request).status, 403)
        self.assertIsNotNone(self.state.authorize_session(second.token))
        self.clock.value += 901
        csrf = self.state.issue_csrf(owner)
        response = self.app.handle(self.web('POST', approval_security.EVERYWHERE_PATH, first.token, {'csrf': csrf}))
        self.assertEqual(response.status, 303)
        self.assertTrue(dict(response.headers)['Location'].startswith('/captain/step-up?next='))
        self.assertIsNotNone(self.state.authorize_session(second.token))
        self.assertFalse(self.state.consume_csrf(owner, csrf))


class DevicePolicyTests(SessionCallbackTests):
    def test_invalid_or_unknown_device_cookie_never_selects_an_existing_device(self):
        existing, _ = self.login()
        old = existing['__Host-qd-approval']
        variants = ['', '__Host-qd-device=broken', '__Host-qd-device=' + 'A' * 43, '__Host-qd-device=' + existing['__Host-qd-device'] + '; __Host-qd-device=' + existing['__Host-qd-device'], '__Host-qd-device=' + existing['__Host-qd-device'] + '; __Host-qd-device']
        for header in variants:
            with self.subTest(header_kind=variants.index(header)):
                state, bound, _ = self.begin(header)
                response = self.finish(state, bound)
                self.assertEqual(response.status, 303)
                self.assertIsNotNone(self.state.authorize_session(old))
        self.assertEqual(len(self.state.devices(self.state.authorize_session(old))), 1 + len(variants))

    def test_other_device_and_everywhere_revoke_only_when_fresh_and_burn_csrf(self):
        first = self.state.start_browser_session('captain-subject', device_hash=None, kind='Mac Safari', fresh_from=None)
        second = self.state.start_browser_session('captain-subject', device_hash=None, kind='iPhone Safari', fresh_from=None)
        owner = self.state.authorize_session(first.token)
        second_owner = self.state.authorize_session(second.token)
        target = next(row['id'] for row in self.state.devices(owner) if not row['current'])
        csrf = self.state.issue_csrf(second_owner)
        self.assertFalse(self.state.revoke_device(owner, target))
        self.assertFalse(self.state.revoke_device(owner))
        fresh = self.state.start_browser_session('captain-subject', device_hash=self.state.device_verifier(first.device_handle), kind='Mac Safari', fresh_from=self.start, replace_owner=owner)
        fresh_owner = self.state.authorize_session(fresh.token)
        self.assertTrue(self.state.revoke_device(fresh_owner, target))
        self.assertFalse(self.state.consume_csrf(second_owner, csrf))
        third = self.state.start_identity_session('captain-subject')
        third_owner = self.state.authorize_session(third)
        fresh_csrf = self.state.issue_csrf(fresh_owner)
        third_csrf = self.state.issue_csrf(third_owner)
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            self.assertTrue(self.state.revoke_device(fresh_owner))
        self.assertEqual(log.getvalue(), 'QD_SESSION_END reason=everywhere\n' * 2)
        self.assertFalse(self.state.consume_csrf(fresh_owner, fresh_csrf))
        self.assertFalse(self.state.consume_csrf(third_owner, third_csrf))

    def test_replacement_failure_rolls_back_all_rows_and_emits_no_lifecycle_line(self):
        first = self.state.start_browser_session('captain-subject', device_hash=None, kind='Mac Safari', fresh_from=self.start)
        owner = self.state.authorize_session(first.token)
        csrf = self.state.issue_csrf(owner)
        with self.state._connect() as database:
            database.execute("CREATE TRIGGER fail_new_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT, 'fixture'); END")
        log = io.StringIO()
        with contextlib.redirect_stderr(log), self.assertRaises(sqlite3.IntegrityError):
            self.state.start_browser_session('captain-subject', device_hash=self.state.device_verifier(first.device_handle), kind='Mac Safari', fresh_from=self.start)
        self.assertEqual(log.getvalue(), '')
        self.assertIsNotNone(self.state.authorize_session(first.token))
        self.assertTrue(self.state.consume_csrf(owner, csrf))
        self.assertEqual(len(self.state.devices(owner)), 1)

    def test_old_schema_ends_existing_sessions_once_and_restart_keeps_new_ones(self):
        path = self.root / 'old.sqlite'
        with closing(sqlite3.connect(path)) as database, database:
            database.execute('CREATE TABLE session(token_hash BLOB PRIMARY KEY, created REAL NOT NULL, last_seen REAL NOT NULL)')
            database.execute('INSERT INTO session VALUES(?, ?, ?)', (b'x' * 32, self.start, self.start))
        path.chmod(0o600)
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            migrated = approval_security.ApprovalState(path, b's' * 32, clock=self.clock)
        self.assertEqual(log.getvalue(), 'QD_SESSION_END reason=signed-out\n')
        token = migrated.start_identity_session('captain-subject')
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            restarted = approval_security.ApprovalState(path, b's' * 32, clock=self.clock)
        self.assertEqual(log.getvalue(), '')
        self.assertIsNotNone(restarted.authorize_session(token))
