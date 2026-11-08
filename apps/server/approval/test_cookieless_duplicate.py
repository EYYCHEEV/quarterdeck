from __future__ import annotations

import contextlib
import io
import unittest

import approval_security
import captain_auth
from test_signin_pages import SignInPagesCase


LOGIN = "__Host-qd-login"
SESSION = "__Host-qd-approval"
WRONG_COOKIE = "W" * 43
NEVER_ISSUED_STATE = "s" * 43
CHAT = "/captain/chat"
NO_COOKIE_HEADERS = (
    (None, "no", "no", "0"),
    ("other=1; x=2", "yes", "no", "2-5"),
    (f"{LOGIN}=", "yes", "yes", "1"),
)


def binding_line(stage, header="yes", name="yes", cookies="2-5"):
    return (
        f"QD_SIGNIN_REFUSED stage=state-binding-{stage} "
        f"cookie_header={header} login_name_in_header={name} cookies={cookies}\n"
    )


class CookielessCase(SignInPagesCase):
    def send(self, state, cookie=None, extra="", caller="198.51.100.20"):
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            response = self.app.handle(
                self.request(
                    "GET",
                    f"/captain/oidc/callback?code=accepted-code&state={state}{extra}",
                    cookie=cookie,
                    caller=caller,
                )
            )
        return response, captured.getvalue()

    def with_cookie(self, state, browser, extra="", caller="198.51.100.20"):
        return self.send(state, f"{LOGIN}={browser}; __Host-qd-device={self.device_cookies.get(state, '')}", extra, caller)

    def open_rows(self):
        with self.state._connect() as database:
            return [
                tuple(row)
                for row in database.execute(
                    "SELECT state_hash, browser_hash, expires FROM oidc_state ORDER BY state_hash"
                )
            ]

    def failure_count(self):
        with self.state._connect() as database:
            return database.execute("SELECT count(*) FROM login_failure").fetchone()[0]

    def returns(self):
        return dict(captain_auth._authority._returns)

    def assert_signed_in(self, response):
        self.assertEqual(response.status, 303)
        self.assertEqual(dict(response.headers)["Location"], CHAT)
        self.assertTrue(self.cookie(response, SESSION))

    def assert_untouched(self, state, rows, returns):
        self.assertEqual(self.open_rows(), rows)
        self.assertEqual(self.returns(), returns)
        self.assertIn(state, self.returns())


class CookielessCallbackTests(CookielessCase):
    def test_a_cookieless_callback_then_the_real_one_signs_in(self):
        state, browser = self.start_login()
        refused, line = self.send(state)
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, binding_line("no-cookie", "no", "no", "0"))
        self.assert_signed_in(self.with_cookie(state, browser)[0])
        self.assertEqual(self.oidc.exchanges[-1][0], "accepted-code")

    def test_the_real_callback_then_a_cookieless_one_is_refused_and_the_session_stays(self):
        state, browser = self.start_login()
        response, line = self.with_cookie(state, browser)
        self.assert_signed_in(response)
        session = self.cookie(response, SESSION)
        self.assertEqual(line, "QD_SESSION_START\n")
        refused, line = self.send(state)
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, binding_line("no-cookie", "no", "no", "0"))
        page = self.app.handle(self.request("GET", "/captain/pending", cookie=f"{SESSION}={session}"))
        self.assertEqual(page.status, 200)

    def test_a_cookie_mismatch_still_burns_the_state(self):
        state, browser = self.start_login()
        refused, line = self.with_cookie(state, WRONG_COOKIE)
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, binding_line("cookie-mismatch"))
        self.assertEqual(self.open_rows(), [])
        self.assertNotIn(state, self.returns())
        retry, line = self.with_cookie(state, browser)
        self.assertEqual(retry.status, 401)
        self.assertEqual(line, binding_line("unknown-state"))
        self.assertEqual(self.oidc.exchanges, [])

    def test_the_four_answers_are_identical_from_outside(self):
        answers = []
        lines = []

        def no_cookie():
            state, _ = self.start_login()
            return self.send(state)

        def cookie_mismatch():
            state, _ = self.start_login()
            return self.with_cookie(state, WRONG_COOKIE)

        def unknown_state():
            _, browser = self.start_login()
            return self.with_cookie(NEVER_ISSUED_STATE, browser)

        def no_return():
            state, browser = self.start_login()
            captain_auth._authority._returns.clear()
            return self.with_cookie(state, browser)

        for act in (no_cookie, cookie_mismatch, unknown_state, no_return):
            response, line = act()
            answers.append((response.status, response.headers, response.body))
            lines.append(line)
        self.assertEqual(len(set(answers)), 1)
        self.assertEqual(answers[0][0], 401)
        self.assertEqual(
            lines,
            [
                binding_line("no-cookie", "no", "no", "0"),
                binding_line("cookie-mismatch"),
                binding_line("unknown-state"),
                binding_line("no-return"),
            ],
        )

    def test_a_cookieless_shape_refusal_does_not_burn_and_the_real_callback_signs_in(self):
        state, browser = self.start_login()
        rows = self.open_rows()
        returns = self.returns()
        refused, line = self.send(state, extra="&next=%2Fcaptain%2Fcards")
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, "QD_SIGNIN_REFUSED stage=shape\n")
        self.assert_untouched(state, rows, returns)
        self.assert_signed_in(self.with_cookie(state, browser)[0])

    def test_a_shape_refusal_with_the_cookie_still_burns(self):
        state, browser = self.start_login()
        refused, line = self.with_cookie(state, browser, extra="&next=%2Fcaptain%2Fcards")
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, "QD_SIGNIN_REFUSED stage=shape\n")
        self.assertEqual(self.open_rows(), [])
        self.assertNotIn(state, self.returns())
        retry, line = self.with_cookie(state, browser)
        self.assertEqual(line, binding_line("unknown-state"))
        self.assertEqual(self.oidc.exchanges, [])

    def test_a_shape_refusal_with_a_wrong_cookie_still_burns(self):
        state, browser = self.start_login()
        refused, line = self.with_cookie(state, WRONG_COOKIE, extra="&next=%2Fcaptain%2Fcards")
        self.assertEqual(line, "QD_SIGNIN_REFUSED stage=shape\n")
        self.assertEqual(self.open_rows(), [])
        self.assertNotIn(state, self.returns())

    def test_a_malformed_cookieless_state_is_unknown_state_and_burns_nothing(self):
        state, browser = self.start_login()
        rows = self.open_rows()
        returns = self.returns()
        refused, line = self.send("bad state!")
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, binding_line("unknown-state", "no", "no", "0"))
        self.assert_untouched(state, rows, returns)

    def test_a_cookieless_never_issued_state_is_no_cookie_and_burns_nothing(self):
        state, browser = self.start_login()
        rows = self.open_rows()
        returns = self.returns()
        refused, line = self.send(NEVER_ISSUED_STATE)
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, binding_line("no-cookie", "no", "no", "0"))
        self.assert_untouched(state, rows, returns)

    def test_every_kind_of_missing_cookie_behaves_the_same(self):
        for header, cookie_header, name, count in NO_COOKIE_HEADERS:
            with self.subTest(header=header):
                state, browser = self.start_login()
                rows = self.open_rows()
                returns = self.returns()
                refused, line = self.send(state, header)
                self.assertEqual(refused.status, 401)
                self.assertEqual(line, binding_line("no-cookie", cookie_header, name, count))
                self.assert_untouched(state, rows, returns)
                self.assert_signed_in(self.with_cookie(state, browser)[0])
                self.clock.value += approval_security.LOGIN_WINDOW + 1

    def test_a_refused_cookieless_callback_still_counts_as_a_login_failure(self):
        state, _ = self.start_login()
        self.assertEqual(self.failure_count(), 0)
        refused, _ = self.send(state)
        self.assertEqual(refused.status, 401)
        self.assertEqual(self.failure_count(), 1)

    def test_five_cookieless_callbacks_in_a_row_lock_the_caller_out(self):
        state, browser = self.start_login()
        statuses = [self.send(state)[0].status for _ in range(5)]
        self.assertEqual(statuses, [401, 401, 401, 401, 429])
        gated, line = self.with_cookie(state, browser)
        self.assertEqual(gated.status, 429)
        self.assertEqual(line, "QD_SIGNIN_REFUSED stage=gate\n")
        self.assertEqual(self.oidc.exchanges, [])

    def test_ten_cookieless_callbacks_never_change_the_state_or_the_record(self):
        state, browser = self.start_login()
        rows = self.open_rows()
        returns = self.returns()
        for index in range(10):
            refused, line = self.send(state, caller=f"203.0.113.{index + 1}")
            self.assertEqual(refused.status, 401)
            self.assertEqual(line, binding_line("no-cookie", "no", "no", "0"))
            self.assert_untouched(state, rows, returns)
        self.assert_signed_in(self.with_cookie(state, browser)[0])


class CookielessStateApiTests(CookielessCase):
    def test_a_missing_or_empty_cookie_is_no_cookie_and_leaves_the_row_and_the_record(self):
        for cookie in (None, "", b"", 0):
            with self.subTest(cookie=cookie):
                state, _ = self.start_login()
                rows = self.open_rows()
                returns = self.returns()
                self.assertEqual(self.state.consume_oidc_outcome(state, cookie), "no-cookie")
                self.assertFalse(self.state.consume_oidc(state, cookie))
                self.assertEqual(len(self.open_rows()), 1)
                self.assert_untouched(state, rows, returns)
                with self.assertRaises(approval_security.ApprovalRefused) as caught:
                    captain_auth._authority.consume_return(state, cookie)
                self.assertEqual(
                    approval_security.refusal_stage(caught.exception),
                    "state-binding-no-cookie",
                )
                self.assertEqual(len(self.open_rows()), 1)
                self.assert_untouched(state, rows, returns)
                self.clock.value += approval_security.OIDC_LIFETIME + 1

    def test_no_cookie_wins_over_an_unknown_state_at_the_state_api(self):
        self.assertEqual(self.state.consume_oidc_outcome(NEVER_ISSUED_STATE, None), "no-cookie")
        self.assertEqual(self.state.consume_oidc_outcome("bad state!", ""), "no-cookie")

    def test_the_other_outcomes_still_burn(self):
        state, browser = self.start_login()
        self.assertEqual(self.state.consume_oidc_outcome(state, WRONG_COOKIE), "cookie-mismatch")
        self.assertEqual(self.open_rows(), [])
        self.assertEqual(self.state.consume_oidc_outcome(state, browser), "unknown-state")
        state, browser = self.start_login()
        self.assertEqual(self.state.consume_oidc_outcome(state, browser), "bound")
        self.assertEqual(self.open_rows(), [])

    def test_a_cookieless_probe_leaves_a_later_bound_outcome_intact(self):
        state, browser = self.start_login()
        self.assertEqual(self.state.consume_oidc_outcome(state, None), "no-cookie")
        bound = self.state.device_verifier(self.device_cookies[state])
        self.assertEqual(captain_auth._authority.consume_return(state, browser, bound).next_path, CHAT)


if __name__ == "__main__":
    unittest.main(verbosity=2)
