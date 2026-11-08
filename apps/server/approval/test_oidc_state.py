from __future__ import annotations

import base64
import hashlib
import os
import tempfile
import unittest
from pathlib import Path

import approval_security


class Clock:
    def __init__(self, value=1000.0):
        self.value = value

    def __call__(self):
        return self.value


class TokenSource:
    def __init__(self):
        self.value = 0

    def __call__(self, size):
        self.value += 1
        return bytes([self.value]) * size


class OidcStateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.clock = Clock()
        self.state = approval_security.ApprovalState(
            self.base / "state.sqlite",
            bytes([75]) * 32,
            clock=self.clock,
            token_bytes=TokenSource(),
        )

    def test_wrong_browser_burns_state_and_material_is_derived_not_stored(self):
        started = self.state.begin_oidc()
        expected_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(started.verifier.encode("ascii")).digest()
        ).decode("ascii").rstrip("=")
        self.assertEqual(started.challenge, expected_challenge)

        stored = (self.base / "state.sqlite").read_bytes()
        for value in (
            started.state,
            started.browser,
            started.nonce,
            started.verifier,
        ):
            self.assertNotIn(value.encode("ascii"), stored)

        self.assertFalse(
            self.state.consume_oidc(started.state, "W" * 43)
        )
        self.assertFalse(
            self.state.consume_oidc(started.state, started.browser)
        )

        again = self.state.begin_oidc()
        self.assertTrue(self.state.consume_oidc(again.state, again.browser))
        material = self.state.oidc_material(again.state)
        self.assertEqual(material.nonce, again.nonce)
        self.assertEqual(material.verifier, again.verifier)
        self.assertEqual(material.challenge, again.challenge)

    def test_identity_session_pins_first_subject_and_enforces_friendly_limits(self):
        token = self.state.start_identity_session("google-subject-1")
        self.assertIsNotNone(token)
        self.assertIsNone(
            self.state.start_identity_session("different-google-subject")
        )
        self.assertEqual(
            self.state.recent_activity()[0]["summary"],
            "Google identity pinned",
        )
        self.assertIsNotNone(self.state.authorize_session(token))
        self.clock.value += 7 * 86400
        self.assertIsNone(self.state.authorize_session(token))

        token = self.state.start_identity_session("google-subject-1")
        owner = self.state.authorize_session(token)
        for _ in range(4):
            self.clock.value += 6 * 86400
            self.assertTrue(self.state.touch_session(owner))
            self.assertIsNotNone(self.state.authorize_session(token))
        self.clock.value += 6 * 86400
        self.assertIsNone(self.state.authorize_session(token))


if __name__ == "__main__":
    unittest.main(verbosity=2)
