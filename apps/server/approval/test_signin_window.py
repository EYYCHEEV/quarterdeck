from __future__ import annotations

import contextlib
import io
import unittest

import approval_security
import captain_auth
from test_signin_pages import SignInPagesCase


def binding_line(stage):
    return (
        f"QD_SIGNIN_REFUSED stage=state-binding-{stage} "
        "cookie_header=yes login_name_in_header=yes cookies=2-5\n"
    )


class SignInWindowTests(SignInPagesCase):
    def refused(self, act):
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            response = act()
        return response, captured.getvalue()

    def login_start_status(self):
        return self.app.handle(self.request("GET", "/captain/login")).status

    def test_window_is_900_seconds_and_the_other_lifetimes_stay_at_300(self):
        self.assertEqual(approval_security.OIDC_LIFETIME, 900)
        self.assertEqual(approval_security.PREAUTH_LIFETIME, 300)
        self.assertEqual(approval_security.CSRF_LIFETIME, 300)

    def test_login_cookie_carries_max_age_900_exactly(self):
        response = self.app.handle(self.request("GET", "/captain/login"))
        cookies = [value for name, value in response.headers if name.lower() == "set-cookie" and value.startswith("__Host-qd-login=")]
        self.assertEqual(len(cookies), 1)
        self.assertRegex(
            cookies[0],
            r"__Host-qd-login=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900\Z",
        )

    def test_state_still_signs_in_at_899_seconds(self):
        state, browser = self.start_login()
        self.clock.value += 899
        response = self.callback(state, browser, "accepted-code")
        self.assertEqual(response.status, 303)
        self.assertEqual(dict(response.headers)["Location"], "/captain/chat")

    def test_state_is_refused_at_901_seconds_as_unknown_state(self):
        state, browser = self.start_login()
        self.clock.value += 901
        response, log = self.refused(lambda: self.callback(state, browser, "accepted-code"))
        self.assertEqual(response.status, 401)
        self.assertEqual(log, binding_line("unknown-state"))
        self.assertEqual(self.oidc.exchanges, [])

    def test_return_record_lives_900_seconds(self):
        begun = self.clock.value
        first, _ = self.start_login()
        self.assertEqual(captain_auth._authority._returns[first].expires, begun + 900)
        self.clock.value += 899
        second, _ = self.start_login()
        self.assertIn(first, captain_auth._authority._returns)
        self.clock.value += 2
        self.start_login()
        self.assertNotIn(first, captain_auth._authority._returns)
        self.assertEqual(captain_auth._authority._returns[second].expires, begun + 899 + 900)

    def test_state_is_one_use_at_899_seconds(self):
        state, browser = self.start_login()
        self.clock.value += 899
        self.assertEqual(self.callback(state, browser, "accepted-code").status, 303)
        response, log = self.refused(lambda: self.callback(state, browser, "accepted-code"))
        self.assertEqual(response.status, 401)
        self.assertEqual(log, binding_line("unknown-state"))

    def test_refusal_burns_the_state_at_899_seconds(self):
        state, browser = self.start_login()
        self.clock.value += 899
        wrong, wrong_log = self.refused(lambda: self.callback(state, "W" * 43, "accepted-code"))
        self.assertEqual(wrong.status, 401)
        self.assertEqual(wrong_log, binding_line("cookie-mismatch"))
        retry, retry_log = self.refused(lambda: self.callback(state, browser, "accepted-code"))
        self.assertEqual(retry.status, 401)
        self.assertEqual(retry_log, binding_line("unknown-state"))
        self.assertEqual(self.oidc.exchanges, [])

    def test_cap_of_32_open_states_holds_until_the_window_ends(self):
        statuses = [self.login_start_status() for _ in range(33)]
        self.assertEqual(statuses, [303] * 32 + [403])
        self.clock.value += 899
        self.assertEqual(self.login_start_status(), 403)
        self.clock.value += 2
        self.assertEqual(self.login_start_status(), 303)

    def test_lockout_after_five_failures_still_holds(self):
        statuses = []
        for _ in range(5):
            state, browser = self.start_login()
            with contextlib.redirect_stderr(io.StringIO()):
                statuses.append(self.callback(state, browser, "wrong-code").status)
        self.assertEqual(statuses, [401, 401, 401, 401, 429])
        self.assertEqual(self.login_start_status(), 429)


if __name__ == "__main__":
    unittest.main(verbosity=2)
