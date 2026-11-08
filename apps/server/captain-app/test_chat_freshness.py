from __future__ import annotations

import json
import unittest

import application
import cards
import test_application as fixture
from test_cards import FakeMail, FixtureChecker


class ChatFreshnessTests(unittest.TestCase):
    request = fixture.ApplicationTests.request
    body = fixture.ApplicationTests.body
    tearDown = fixture.ApplicationTests.tearDown

    def setUp(self):
        fixture.ApplicationTests.setUp(self)
        self.mail = FakeMail()
        self.service = cards.CardService(
            self.mail, FixtureChecker(), bot_source=lambda: {"bot-d"},
        )
        self.app = application.CardApplication(application.ApprovalGate(self.approval), self.service, self.updates, clock=lambda: self.now[0])

    def fresh_session(self):
        started = self.state.start_browser_session('account-user-subject', device_hash=None, kind='Mac Safari', fresh_from=self.now[0])
        self.token = started.token

    def send(self, request_id):
        listing = self.app.handle(self.request('GET', '/captain/api/chat?with=bot-d'))
        self.assertEqual(listing.status, 200)
        values = {'text': 'Go ahead', 'requestId': request_id, 'csrf': self.body(listing)['csrf']}
        return self.app.handle(self.request('POST', '/captain/api/chat?with=bot-d', json.dumps(values).encode(), origin='https://quarterdeck.invalid'))

    def test_normal_send_stamps_true_only_while_server_freshness_is_current(self):
        self.fresh_session()
        response = self.send('fresh-message')
        self.assertEqual(response.status, 200)
        wire = json.loads(self.mail.sent[-1][2])
        self.assertIn('fresh', wire)
        self.assertIs(wire['fresh'], True)
        self.assertIs(self.body(response)['message']['fresh'], True)
        self.now[0] += 901
        response = self.send('stale-message')
        self.assertEqual(response.status, 200)
        self.assertIs(json.loads(self.mail.sent[-1][2])['fresh'], False)
        self.assertIs(self.body(response)['message']['fresh'], False)
        self.assertEqual(self.body(response)['freshUntil'], 1900.0)

    def test_a_client_cannot_supply_the_fresh_flag(self):
        self.fresh_session()
        csrf = self.body(self.app.handle(self.request('GET', '/captain/api/chat?with=bot-d')))['csrf']
        values = {'text': 'Go ahead', 'requestId': 'client-flag', 'csrf': csrf, 'fresh': True}
        response = self.app.handle(self.request('POST', '/captain/api/chat?with=bot-d', json.dumps(values).encode(), origin='https://quarterdeck.invalid'))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.mail.sent, [])

    def test_unfresh_card_answer_requires_stepup_without_answering(self):
        self.now[0] += 901
        csrf = self.body(self.app.handle(self.request('GET', '/captain/cards')))['csrf']
        response = self.app.handle(self.request('POST', '/captain/cards/test-1/answer', json.dumps({'rev': 1, 'pick': 'A', 'note': '', 'csrf': csrf}).encode(), origin='https://quarterdeck.invalid'))
        self.assertEqual(response.status, 303)
        self.assertEqual(dict(response.headers)['Location'], '/captain/step-up?next=%2Fcaptain%2Fchat')
        self.assertEqual(self.mail.sent, [])
