from __future__ import annotations

import contextlib
import io
import unittest

import approval_app
from test_signin_pages import SignInPagesCase


LOGIN = "__Host-qd-login"
SESSION = "__Host-qd-approval"
TOKEN = "A" * 43
BREAKING_PAIRS = (
    'x={"a":1}',
    "x=a b",
    'x=a"b',
    'x="a',
    "secure",
    'x={"a":1}; y=a b; z=a"b; w="a; secure; flag',
)


def read(header, name=LOGIN, key="Cookie"):
    headers = {} if header is None else {key: header}
    request = approval_app.Request("GET", "/", headers, bytearray(), "proxy.internal")
    return approval_app.ApprovalApplication._cookie(request, name)


class CookieReaderTests(unittest.TestCase):
    def test_a_single_cookie_returns_its_value_for_both_names(self):
        for name in (LOGIN, SESSION):
            with self.subTest(name=name):
                self.assertEqual(read(f"{name}={TOKEN}", name), TOKEN)

    def test_each_breaking_shape_before_our_cookie_still_finds_ours(self):
        for name in (LOGIN, SESSION):
            for pair in BREAKING_PAIRS:
                with self.subTest(name=name, pair=pair):
                    self.assertEqual(read(f"{pair}; {name}={TOKEN}", name), TOKEN)

    def test_breaking_shapes_after_or_around_our_cookie_still_find_ours(self):
        for pair in BREAKING_PAIRS:
            with self.subTest(pair=pair):
                self.assertEqual(read(f"{LOGIN}={TOKEN}; {pair}"), TOKEN)
                self.assertEqual(read(f"{pair}; {LOGIN}={TOKEN}; {pair}"), TOKEN)

    def test_two_copies_of_our_name_give_none(self):
        for header in (
            f"{LOGIN}={TOKEN}; {LOGIN}={TOKEN}",
            f"{LOGIN}={TOKEN}; {LOGIN}=B{TOKEN}",
            f"{LOGIN}={TOKEN}; {LOGIN}=",
            f"{LOGIN}={TOKEN}; a=b; {LOGIN}={TOKEN}",
            f'x={{"a":1}}; {LOGIN}={TOKEN}; secure; {LOGIN}={TOKEN}',
        ):
            with self.subTest(header=header):
                self.assertIsNone(read(header))

    def test_bare_or_damaged_target_cannot_hide_beside_one_valid_cookie(self):
        for name in (LOGIN, SESSION, "__Host-qd-device"):
            for damaged in (name, name + " =broken", name + ":broken"):
                with self.subTest(name=name, damaged=damaged):
                    self.assertIsNone(read(f"{damaged}; {name}={TOKEN}", name))
                    self.assertIsNone(read(f"{name}={TOKEN}; {damaged}", name))

    def test_a_longer_name_that_ends_with_ours_does_not_match(self):
        self.assertIsNone(read(f"xx{LOGIN}={TOKEN}"))
        self.assertIsNone(read(f"{LOGIN}-x={TOKEN}"))
        self.assertIsNone(read(f"x={LOGIN}={TOKEN}"))
        self.assertEqual(read(f"xx{LOGIN}=BAD; {LOGIN}={TOKEN}"), TOKEN)
        self.assertEqual(read(f"{LOGIN}={TOKEN}; xx{LOGIN}=BAD"), TOKEN)

    def test_name_matching_is_case_sensitive(self):
        for name in (LOGIN.lower(), LOGIN.upper(), "__host-qd-login", "__Host-QD-login"):
            with self.subTest(name=name):
                self.assertIsNone(read(f"{name}={TOKEN}"))

    def test_an_empty_or_missing_header_gives_none(self):
        for header in (None, "", "   ", ";", "; ;"):
            with self.subTest(header=header):
                self.assertIsNone(read(header))

    def test_an_empty_value_gives_none(self):
        for header in (f"{LOGIN}=", f"{LOGIN}=   ", f"a=b; {LOGIN}=; c=d"):
            with self.subTest(header=header):
                self.assertIsNone(read(header))

    def test_the_value_is_not_unquoted_or_rewritten(self):
        self.assertEqual(read(f'{LOGIN}="{TOKEN}"'), f'"{TOKEN}"')
        self.assertEqual(read(f"{LOGIN}=abc=="), "abc==")
        self.assertEqual(read(f"{LOGIN}=a%20b"), "a%20b")

    def test_only_the_whitespace_around_the_pair_is_stripped(self):
        self.assertEqual(read(f"  {LOGIN}={TOKEN}  ;x=1"), TOKEN)
        self.assertEqual(read(f"x=1;\t{LOGIN}={TOKEN}\t"), TOKEN)
        self.assertIsNone(read(f"{LOGIN} ={TOKEN}"))

    def test_the_header_name_is_found_in_any_case(self):
        self.assertEqual(read(f"{LOGIN}={TOKEN}", key="cookie"), TOKEN)
        self.assertEqual(read(f"{LOGIN}={TOKEN}", key="COOKIE"), TOKEN)


class CookieReaderPathTests(SignInPagesCase):
    def callback_with_header(self, state, header):
        return self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code=accepted-code&state={state}",
                cookie=header,
            )
        )

    def test_login_cookie_after_a_breaking_pair_completes_sign_in(self):
        for pair in BREAKING_PAIRS:
            with self.subTest(pair=pair):
                state, browser = self.start_login()
                response = self.callback_with_header(state, f"{pair}; {LOGIN}={browser}; __Host-qd-device={self.device_cookies[state]}")
                self.assertEqual(response.status, 303)
                self.assertEqual(dict(response.headers)["Location"], "/captain/chat")
                self.assertTrue(self.cookie(response, SESSION))

    def test_two_login_cookies_are_refused_as_malformed(self):
        state, browser = self.start_login()
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            response = self.callback_with_header(state, f"{LOGIN}={browser}; {LOGIN}={browser}")
        self.assertEqual(response.status, 401)
        self.assertEqual(
            captured.getvalue(),
            "QD_SIGNIN_REFUSED stage=state-binding-cookie-mismatch "
            "cookie_header=yes login_name_in_header=yes cookies=2-5\n",
        )
        self.assertEqual(self.oidc.exchanges, [])

    def test_session_cookie_after_a_breaking_pair_is_accepted_and_two_copies_are_not(self):
        session = self.login()
        for pair in BREAKING_PAIRS:
            with self.subTest(pair=pair):
                page = self.app.handle(
                    self.request("GET", "/captain/pending", cookie=f"{pair}; {SESSION}={session}")
                )
                self.assertEqual(page.status, 200)
        doubled = self.app.handle(
            self.request("GET", "/captain/pending", cookie=f"{SESSION}={session}; {SESSION}={session}")
        )
        self.assertEqual(doubled.status, 303)
        self.assertEqual(dict(doubled.headers)["Location"], "/captain/login")


if __name__ == "__main__":
    unittest.main(verbosity=2)
