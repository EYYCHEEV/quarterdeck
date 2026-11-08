from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import approval_security
from test_oidc_state import Clock, TokenSource


UNISSUED_STATE = "s" * 43
WRONG_COOKIE = "W" * 43


class OidcOutcomeTests(unittest.TestCase):
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

    def open_states(self):
        with self.state._connect() as database:
            return database.execute("SELECT count(*) FROM oidc_state").fetchone()[0]

    def test_matching_cookie_is_bound_and_burns_the_state(self):
        started = self.state.begin_oidc()
        self.assertEqual(
            self.state.consume_oidc_outcome(started.state, started.browser), "bound"
        )
        self.assertEqual(self.open_states(), 0)
        self.assertEqual(
            self.state.consume_oidc_outcome(started.state, started.browser),
            "unknown-state",
        )

    def test_missing_or_empty_cookie_is_no_cookie_and_leaves_the_state(self):
        for cookie in (None, ""):
            with self.subTest(cookie=cookie):
                started = self.state.begin_oidc()
                before = self.open_states()
                self.assertEqual(
                    self.state.consume_oidc_outcome(started.state, cookie), "no-cookie"
                )
                self.assertEqual(self.open_states(), before)
                self.assertEqual(
                    self.state.consume_oidc_outcome(started.state, started.browser),
                    "bound",
                )

    def test_wrong_or_malformed_cookie_is_cookie_mismatch_and_burns_the_state(self):
        for cookie in (WRONG_COOKIE, "short", "not a token!" * 4):
            with self.subTest(cookie=cookie):
                started = self.state.begin_oidc()
                self.assertEqual(
                    self.state.consume_oidc_outcome(started.state, cookie),
                    "cookie-mismatch",
                )
                self.assertEqual(self.open_states(), 0)
                self.assertEqual(
                    self.state.consume_oidc_outcome(started.state, started.browser),
                    "unknown-state",
                )

    def test_unissued_malformed_and_expired_states_are_unknown_state(self):
        started = self.state.begin_oidc()
        self.assertEqual(
            self.state.consume_oidc_outcome(UNISSUED_STATE, started.browser),
            "unknown-state",
        )
        self.assertEqual(
            self.state.consume_oidc_outcome("bad state!", started.browser),
            "unknown-state",
        )
        self.assertEqual(self.open_states(), 1)
        self.clock.value += approval_security.OIDC_LIFETIME + 1
        self.assertEqual(
            self.state.consume_oidc_outcome(started.state, started.browser),
            "unknown-state",
        )
        self.assertEqual(self.open_states(), 0)

    def test_unknown_state_wins_over_a_wrong_cookie_and_a_missing_cookie_wins_over_unknown_state(self):
        self.assertEqual(
            self.state.consume_oidc_outcome(UNISSUED_STATE, WRONG_COOKIE),
            "unknown-state",
        )
        self.assertEqual(
            self.state.consume_oidc_outcome(UNISSUED_STATE, None), "no-cookie"
        )

    def test_boolean_consume_is_true_only_when_bound(self):
        started = self.state.begin_oidc()
        self.assertFalse(self.state.consume_oidc(started.state, None))
        started = self.state.begin_oidc()
        self.assertFalse(self.state.consume_oidc(started.state, WRONG_COOKIE))
        self.assertFalse(self.state.consume_oidc(UNISSUED_STATE, WRONG_COOKIE))
        started = self.state.begin_oidc()
        self.assertTrue(self.state.consume_oidc(started.state, started.browser))
        self.assertFalse(self.state.consume_oidc(started.state, started.browser))

    def test_badly_formed_state_material_is_refused_as_unknown_state(self):
        with self.assertRaises(approval_security.ApprovalRefused) as caught:
            self.state.oidc_material("bad state!")
        self.assertEqual(
            approval_security.refusal_stage(caught.exception),
            "state-binding-unknown-state",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
