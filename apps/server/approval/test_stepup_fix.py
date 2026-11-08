from __future__ import annotations

import unittest
import os
import tempfile
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import approval_security
import approval_app
import captain_auth

from test_oidc import GoogleOidcTests
from test_oidc import token
from test_oidc_state import Clock


class SupportedGoogleTests(unittest.TestCase):
    def provider(self, changes=None):
        claims = GoogleOidcTests.claims(None, **(changes or {}))
        return GoogleOidcTests.provider(None, claims)

    def test_normal_and_stepup_use_supported_account_selection_without_extra_claims(self):
        provider, _ = self.provider()
        for step_up in (False, True):
            with self.subTest(step_up=step_up):
                query = parse_qs(urlsplit(provider.authorization_url(state='S' * 43, nonce='N' * 43, challenge='C' * 43, step_up=step_up)).query)
                self.assertEqual(query['prompt'], ['select_account'])
                self.assertNotIn('max_age', query)
                self.assertNotIn('claims', query)
                self.assertEqual(query['state'], ['S' * 43])
                self.assertEqual(query['nonce'], ['N' * 43])
                self.assertEqual(query['code_challenge'], ['C' * 43])
                self.assertEqual(query['code_challenge_method'], ['S256'])

    def test_google_response_without_auth_time_completes_stepup(self):
        provider, _ = self.provider()
        identity = provider.exchange_code('standin-code', 'V' * 43, 'N' * 43, auth_started=1000.0)
        self.assertEqual(identity.subject, 'google-subject-1')
        self.assertEqual(identity.signed_in_at, 990.0)

    def test_iat_is_bound_to_this_login_and_future_skew_never_extends_freshness(self):
        for issued in (939, 1061, None, True, "990", float("nan"), float("inf")):
            with self.subTest(issued=issued):
                provider, _ = self.provider({"iat": issued})
                with self.assertRaises(approval_security.ApprovalRefused):
                    provider.exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)
        claims = GoogleOidcTests.claims(None)
        del claims["iat"]
        provider, _ = GoogleOidcTests.provider(None, claims)
        with self.assertRaises(approval_security.ApprovalRefused):
            provider.exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)
        for issued, expected in ((940, 940.0), (990, 990.0), (1060, 1000.0)):
            with self.subTest(issued=issued):
                provider, _ = self.provider({"iat": issued})
                identity = provider.exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)
                self.assertEqual(identity.subject, "google-subject-1")
                self.assertEqual(identity.signed_in_at, expected)

    def test_auth_time_presence_or_content_has_no_effect(self):
        provider, _ = self.provider()
        expected = provider.exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)
        for value in (None, True, 0, 100000, "not-used", {"not": "used"}):
            with self.subTest(claim_kind=type(value).__name__):
                provider, _ = self.provider({"auth_time": value})
                self.assertEqual(provider.exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0), expected)


class GoogleRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        directory = Path(self.folder.name)
        os.chmod(directory, 0o700)
        self.clock = Clock()
        self.state = approval_security.ApprovalState(directory / "state.sqlite", b"s" * 32, clock=self.clock)
        self.provider, self.transport = GoogleOidcTests.provider(None, GoogleOidcTests.claims(None))
        self.provider.clock = self.clock
        captain_auth._authority = None
        captain_auth.install(self.state, self.provider)
        self.addCleanup(setattr, captain_auth, "_authority", None)

    def request(self, path, cookies):
        return approval_app.Request("GET", path, {"Cookie": cookies, "User-Agent": "stand-in iPhone Safari"}, bytearray(), "proxy.internal")

    def cookies(self, response, previous=""):
        jar = SimpleCookie(previous)
        for name, value in response.headers:
            if name.lower() == "set-cookie":
                jar.load(value)
        return jar

    def header(self, jar):
        return "; ".join(f"{name}={value.value}" for name, value in jar.items())

    def begin(self, previous="", step_up=False):
        make = captain_auth.step_up_redirect if step_up else captain_auth.login_redirect
        response = make("/captain/chat", request=self.request("/captain/step-up" if step_up else "/captain/login", previous))
        state = parse_qs(urlsplit(dict(response.headers)["Location"]).query)["state"][0]
        return state, self.header(self.cookies(response, previous))

    def finish(self, state, header, issued):
        claims = GoogleOidcTests.claims(None, nonce=self.state.oidc_material(state).nonce, iat=issued, exp=self.clock.value + 300)
        self.transport.id_token = token(claims)
        return captain_auth.oidc_callback(self.request("/captain/oidc/callback?" + urlencode({"state": state, "code": "standin-code"}), header))

    def test_normal_signin_starts_freshness_from_clamped_verified_issue_time(self):
        for issued, expected in ((990, 1890.0), (1030, 1900.0)):
            with self.subTest(issued=issued):
                state, header = self.begin()
                response = self.finish(state, header, issued)
                self.assertEqual(response.status, 303)
                owner = self.state.authorize_session(self.cookies(response)["__Host-qd-approval"].value)
                self.assertEqual(self.state.fresh_until(owner), expected)
                self.assertEqual(dict(response.headers)["Location"], "/captain/chat")

    def test_stepup_without_auth_time_rotates_session_csrf_and_handle(self):
        state, header = self.begin()
        first_response = self.finish(state, header, 990)
        first = self.cookies(first_response)
        first_token = first["__Host-qd-approval"].value
        owner = self.state.authorize_session(first_token)
        csrf = self.state.issue_csrf(owner)
        self.clock.value += 60
        state, header = self.begin(self.header(first), step_up=True)
        response = self.finish(state, header, 1060)
        second = self.cookies(response)
        self.assertNotEqual(first_token, second["__Host-qd-approval"].value)
        self.assertNotEqual(first["__Host-qd-device"].value, second["__Host-qd-device"].value)
        self.assertIsNone(self.state.authorize_session(first_token))
        self.assertFalse(self.state.consume_csrf(owner, csrf))
        current = self.state.authorize_session(second["__Host-qd-approval"].value)
        self.assertEqual(self.state.fresh_until(current), 1960.0)
        self.assertEqual(len(self.state.devices(current)), 1)
        self.assertEqual(dict(response.headers)["Location"], "/captain/chat")
