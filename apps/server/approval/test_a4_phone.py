from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urlencode

from test_approval_app import ApprovalApplicationTests


VIEWPORT = b'<meta name="viewport" content="width=device-width, initial-scale=1">'
NOW = datetime(2026, 11, 4, 18, 54, tzinfo=timezone.utc).timestamp()


class PhonePageTests(ApprovalApplicationTests):
    def test_pending_uses_viewport_and_eastern_human_times(self):
        self.clock.value = NOW
        session, _ = self.login()
        self.backend.pending = lambda: [{'code': 'ABCDEFGH', 'botName': 'bot-a', 'requestedAt': NOW - 120, 'invitedBy': 'Captain'}]
        self.backend.invites = lambda: [{'inviteId': 'abcdefghijkl', 'botName': 'bot-a', 'invitedBy': 'Captain', 'createdAt': NOW - 120, 'expiresAt': NOW + 86280}]
        self.state.record_activity('Approved bot-a')
        response = self.app.handle(self.request('GET', '/captain/pending', cookie=f'__Host-qd-approval={session}'))
        self.assertEqual(response.status, 200)
        self.assertIn(VIEWPORT, response.body)
        self.assertIn(b'requested 2 min ago (1:52 PM ET)', response.body)
        self.assertIn(b'expires in 23 h (1:52 PM ET, Nov 5)', response.body)
        self.assertNotIn(b'server time', response.body)
        self.assertNotIn(str(NOW).encode(), response.body)
        self.assertIn(b'min-height:44px', response.body)

    def test_invite_page_uses_viewport_and_nonce_allowed_styles(self):
        session, _ = self.login()
        token = self.state.authorize_session(session)
        csrf = self.state.issue_csrf(token)
        self.backend.create_invite = lambda bot: {'inviteId': 'abcdefghijkl', 'code': 'abcdefghijklmnopqrstuv', 'botName': bot, 'invitedBy': 'Captain', 'createdAt': 1000.0, 'expiresAt': 87400.0}
        response = self.app.handle(self.request('POST', '/captain/invites/create', body=urlencode({'botName': 'bot-a', 'csrf': csrf}).encode(), cookie=f'__Host-qd-approval={session}', origin='https://approval.example.invalid'))
        self.assertEqual(response.status, 200)
        self.assertIn(VIEWPORT, response.body)
        self.assertIn('style-src', dict(response.headers)['Content-Security-Policy'])
        self.assertNotIn('unsafe-inline', dict(response.headers)['Content-Security-Policy'])
