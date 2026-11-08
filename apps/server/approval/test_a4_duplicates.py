from __future__ import annotations

from test_cookieless_duplicate import CookielessCase, LOGIN, binding_line
from http.cookies import SimpleCookie
import approval_security
import captain_auth
import test_session_callback as callback


class DuplicateCallbackTests(CookielessCase):
    def test_duplicate_login_cookies_consume_state_and_return_even_when_empty(self):
        for values in (("same", "same"), ("real", "wrong"), ("", ""), ("", "real")):
            with self.subTest(values=values):
                state, browser = self.start_login()
                header = "; ".join(f"{LOGIN}={browser if value in {'same', 'real'} else value}" for value in values)
                refused, line = self.send(state, header)
                self.assertEqual(refused.status, 401)
                self.assertEqual(self.open_rows(), [])
                self.assertNotIn(state, self.returns())
                self.assertEqual(line, binding_line("cookie-mismatch", cookies="2-5"))
                retry, _ = self.with_cookie(state, browser)
                self.assertEqual(retry.status, 401)
                self.assertEqual(self.oidc.exchanges, [])
                self.clock.value += 3601

    def test_duplicate_login_cookie_on_bad_query_also_consumes_both_records(self):
        state, browser = self.start_login()
        refused, line = self.send(state, f"{LOGIN}={browser}; {LOGIN}={browser}", extra="&next=bad")
        self.assertEqual(refused.status, 401)
        self.assertEqual(line, "QD_SIGNIN_REFUSED stage=shape\n")
        self.assertEqual(self.open_rows(), [])
        self.assertNotIn(state, self.returns())
        self.assertEqual(self.oidc.exchanges, [])


class NoEqualsCallbackTests(callback.SessionCallbackTests):
    def request(self, path, cookie=""):
        request = super().request(path, cookie or "")
        if cookie is None:
            request.headers.pop("Cookie", None)
        return request

    def test_present_malformed_login_tokens_burn_both_records_and_retry_cannot_exchange(self):
        for header in (LOGIN, f"other=1; {LOGIN}; x=2", f"{LOGIN} =bad", f"{LOGIN} junk", f"{LOGIN}:bad"):
            with self.subTest(header=header):
                state, valid_header, _ = self.begin()
                browser = SimpleCookie(valid_header)[LOGIN].value
                with self.assertRaises(approval_security.ApprovalRefused) as caught:
                    self.finish(state, header)
                self.assertEqual(approval_security.refusal_stage(caught.exception), "state-binding-cookie-mismatch")
                self.assertNotIn(state, captain_auth._authority._returns)
                self.assertFalse(self.state.consume_oidc(state, browser))
                with self.assertRaises(approval_security.ApprovalRefused):
                    self.finish(state, valid_header)
                self.assertEqual(self.provider.calls, [])

    def test_only_absent_header_absent_name_and_one_valid_empty_value_preserve_records(self):
        for header in (None, "other=1", f"{LOGIN}="):
            with self.subTest(header=header):
                state, valid_header, _ = self.begin()
                before = dict(captain_auth._authority._returns)
                calls = len(self.provider.calls)
                with self.assertRaises(approval_security.ApprovalRefused) as caught:
                    self.finish(state, header)
                self.assertEqual(approval_security.refusal_stage(caught.exception), "state-binding-no-cookie")
                self.assertEqual(captain_auth._authority._returns, before)
                self.assertEqual(len(self.provider.calls), calls)
                response = self.finish(state, valid_header)
                self.assertEqual(response.status, 303)
