from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import approval_security
from test_oidc_state import Clock, TokenSource


class FriendlySessionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        os.chmod(self.root, 0o700)
        self.clock = Clock()
        self.start = self.clock.value
        self.state = approval_security.ApprovalState(self.root / 'state.sqlite', b's' * 32, clock=self.clock, token_bytes=TokenSource())

    def test_background_authentication_neither_expires_early_nor_extends_seven_day_idle(self):
        token = self.state.start_identity_session('captain-subject')
        for day in (1, 3, 6):
            self.clock.value = self.start + day * 86400
            self.assertIsNotNone(self.state.authorize_session(token))
        self.clock.value = self.start + 7 * 86400
        self.assertIsNone(self.state.authorize_session(token))

    def test_explicit_activity_renews_idle_but_never_moves_the_thirty_day_limit(self):
        token = self.state.start_identity_session('captain-subject')
        owner = self.state.authorize_session(token)
        for day in (6, 12, 18, 24, 29):
            self.clock.value = self.start + day * 86400
            self.assertTrue(self.state.touch_session(owner))
            self.assertIsNotNone(self.state.authorize_session(token))
        self.clock.value = self.start + 30 * 86400
        self.assertIsNone(self.state.authorize_session(token))
        self.assertFalse(self.state.touch_session(owner))
