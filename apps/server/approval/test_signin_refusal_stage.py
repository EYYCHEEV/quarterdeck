from __future__ import annotations

import base64
import contextlib
import io
import itertools
import json
import os
import re
import ssl
import tempfile
import unittest
from http.cookies import SimpleCookie
from dataclasses import replace
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import approval_app
import approval_security
import captain_auth
import invite_prompt
import oidc
from test_oidc import GOOGLE_TOKEN_HEADERS, ParsedConnection, google_token_body, raw_response


CLIENT_ID = "qdcanaryclient7Q.apps.googleusercontent.com"
CANARIES = (
    "QDCANARYSECRET9X",
    "QDCANARYCODE5K",
    "QDCANARYCOOKIE3M",
    "QDCANARYFIELD8P",
    "QDCANARYBODY2W",
    "QDCANARYTLS6R",
    "qdcanary-other@example.invalid",
    "198.51.100.77",
    "qdcanaryclient7Q",
)
ALLOWED = "captain@example.invalid"
STAGES = (
    "shape",
    "state-binding-no-cookie",
    "state-binding-cookie-mismatch",
    "state-binding-unknown-state",
    "state-binding-no-return",
    "transport-tls",
    "response-metadata",
    "response-status",
    "claims",
    "session-policy",
    "gate",
)
SIGN_IN_FAILED = b"Sign-in did not finish. Open Safari itself, then sign in again and stay in one tab."
TOO_MANY_TRIES = b"Too many sign-in tries. Wait one hour, then sign in again."
NEVER_ISSUED_STATE = "QDCANARYFIELD8P" + "z" * 30
BINDING_FACTS = r"cookie_header=(?:yes|no) login_name_in_header=(?:yes|no) cookies=(?:0|1|2-5|6\+)"
FACT_CALLERS = itertools.count(1)


def encoded(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def id_token(nonce, **changes):
    claims = {
        "iss": "https://accounts.google.com",
        "azp": CLIENT_ID,
        "aud": CLIENT_ID,
        "sub": "110169484474386276334",
        "email": ALLOWED,
        "email_verified": True,
        "nonce": nonce,
        "iat": 990,
        "exp": 4590,
    }
    claims.update(changes)
    header = encoded(json.dumps({"alg": "RS256", "kid": "k", "typ": "JWT"}).encode("ascii"))
    return header + "." + encoded(json.dumps(claims).encode("ascii")) + ".standin-signature"


class Clock:
    def __init__(self):
        self.value = 1000.0

    def __call__(self):
        return self.value


class Backend:
    def pending(self):
        return []

    def invites(self):
        return []


class RefusalStageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        os.chmod(base, 0o700)
        self.clock = Clock()
        self.state = approval_security.ApprovalState(base / "state.sqlite", bytes([75]) * 32, clock=self.clock)
        self.provider = oidc.GoogleOidc(
            client_id=CLIENT_ID,
            client_secret=bytearray(b"QDCANARYSECRET9X"),
            allowed_email=ALLOWED,
            redirect_uri="https://approval.example.invalid/captain/oidc/callback",
            clock=Clock(),
        )
        captain_auth._authority = None
        self.addCleanup(setattr, captain_auth, "_authority", None)
        captain_auth.install(self.state, self.provider)
        self.app = approval_app.ApprovalApplication(
            self.state,
            captain_auth,
            Backend(),
            invite_prompt.ReleaseConfig(
                artifact_url="https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
                version="1.2.3",
                sha256="ab" * 32,
                join_address="https://approval.example.invalid",
            ),
            trusted_proxy="proxy.internal",
            public_origin="https://approval.example.invalid",
        )
        patcher = mock.patch.object(oidc.http.client, "HTTPSConnection", ParsedConnection)
        patcher.start()
        self.addCleanup(patcher.stop)
        ParsedConnection.raw = b""
        ParsedConnection.made = []

    @staticmethod
    def request(path, cookie=None, caller="198.51.100.77"):
        headers = {
            "X-Forwarded-For": caller,
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "approval.example.invalid",
        }
        if cookie:
            headers["Cookie"] = cookie
        return approval_app.Request("GET", path, headers, bytearray(), "proxy.internal")

    def start(self):
        response = self.app.handle(self.request("/captain/login"))
        self.assertEqual(response.status, 303)
        cookies = SimpleCookie()
        for name, value in response.headers:
            if name.lower() == "set-cookie":
                cookies.load(value)
        state = parse_qs(urlsplit(dict(response.headers)["Location"]).query)["state"][0]
        self.device_cookie = cookies["__Host-qd-device"].value
        return state, cookies["__Host-qd-login"].value, self.state.oidc_material(state).nonce

    def callback(self, state, browser, extra="", code="QDCANARYCODE5K"):
        return self.app.handle(
            self.request(
                f"/captain/oidc/callback?code={code}&state={state}{extra}",
                cookie=f"__Host-qd-login={browser}; __Host-qd-device={getattr(self, 'device_cookie', '')}",
            )
        )

    def callback_without_cookie(self, state, code="QDCANARYCODE5K"):
        return self.app.handle(
            self.request(f"/captain/oidc/callback?code={code}&state={state}")
        )

    def forget_returns(self):
        captain_auth._authority._returns.clear()

    def open_state_count(self):
        with self.state._connect() as database:
            return database.execute("SELECT count(*) FROM oidc_state").fetchone()[0]

    @staticmethod
    def binding_line(stage, header, name, cookies):
        return (
            f"QD_SIGNIN_REFUSED stage=state-binding-{stage} "
            f"cookie_header={header} login_name_in_header={name} cookies={cookies}\n"
        )

    def facts_for(self, header):
        request = self.request(
            f"/captain/oidc/callback?code=QDCANARYCODE5K&state={NEVER_ISSUED_STATE}",
            caller=f"203.0.113.{next(FACT_CALLERS)}",
        )
        if header is not None:
            request.headers["Cookie"] = header
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            response = self.app.handle(request)
        self.assertEqual(response.status, 401)
        line = captured.getvalue()
        prefix = re.match(r"QD_SIGNIN_REFUSED stage=state-binding-(?:no-cookie|unknown-state) ", line)
        self.assertIsNotNone(prefix)
        prefix = prefix.group(0)
        self.assertTrue(line.endswith("\n"))
        return dict(item.split("=") for item in line[len(prefix):].split())

    def refused_with(self, stage, act):
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            response = act()
        self.assertIn(response.status, (401, 429))
        self.assertIn({401: SIGN_IN_FAILED, 429: TOO_MANY_TRIES}[response.status], response.body)
        line = captured.getvalue()
        if stage.startswith("state-binding-"):
            self.assertIsNotNone(re.fullmatch(rf"QD_SIGNIN_REFUSED stage={stage} {BINDING_FACTS}\n", line))
        else:
            self.assertEqual(line, f"QD_SIGNIN_REFUSED stage={stage}\n")
        visible = captured.getvalue() + repr(response.headers) + response.body.decode("ascii")
        for canary in CANARIES:
            self.assertNotIn(canary, visible)
        return line

    def test_shape_refusal_logs_shape(self):
        state, browser, _ = self.start()
        self.refused_with("shape", lambda: self.callback(state, browser, "&next=QDCANARYFIELD8P"))

    def test_wrong_browser_logs_state_binding(self):
        state, _, _ = self.start()
        self.refused_with("state-binding-cookie-mismatch", lambda: self.callback(state, "QDCANARYCOOKIE3M" + "x" * 30))

    def test_reused_state_logs_state_binding(self):
        state, browser, nonce = self.start()
        ParsedConnection.raw = raw_response(200, "OK", GOOGLE_TOKEN_HEADERS, google_token_body(id_token(nonce)))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.callback(state, browser).status, 303)
        self.refused_with("state-binding-unknown-state", lambda: self.callback(state, browser))

    def test_expired_state_logs_state_binding(self):
        state, browser, nonce = self.start()
        ParsedConnection.raw = raw_response(200, "OK", GOOGLE_TOKEN_HEADERS, google_token_body(id_token(nonce)))
        self.clock.value += approval_security.OIDC_LIFETIME + 1
        self.refused_with("state-binding-unknown-state", lambda: self.callback(state, browser))
        self.assertEqual(ParsedConnection.made, [])

    def test_no_session_exists_after_any_refused_claim(self):
        state, browser, nonce = self.start()
        ParsedConnection.raw = raw_response(
            200, "OK", GOOGLE_TOKEN_HEADERS, google_token_body(id_token(nonce, email_verified=False))
        )
        with contextlib.redirect_stderr(io.StringIO()):
            response = self.callback(state, browser)
        self.assertEqual(response.status, 401)
        self.assertNotIn("__Host-qd-approval=", repr(response.headers).replace("__Host-qd-approval=;", ""))
        with self.state._connect() as database:
            self.assertEqual(database.execute("SELECT count(*) FROM session").fetchone()[0], 0)
            self.assertEqual(database.execute("SELECT count(*) FROM identity").fetchone()[0], 0)

    def test_tls_failure_logs_transport_tls(self):
        state, browser, _ = self.start()

        def broken(self):
            raise ssl.SSLCertVerificationError("QDCANARYTLS6R 198.51.100.77")

        with mock.patch.object(ParsedConnection, "getresponse", broken):
            self.refused_with("transport-tls", lambda: self.callback(state, browser))

    def test_repeated_guarded_header_logs_response_metadata(self):
        state, browser, nonce = self.start()
        headers = GOOGLE_TOKEN_HEADERS + (("Content-Type", "text/html; QDCANARYBODY2W"),)
        ParsedConnection.raw = raw_response(200, "OK", headers, google_token_body(id_token(nonce)))
        self.refused_with("response-metadata", lambda: self.callback(state, browser))

    def test_google_error_status_logs_response_status(self):
        state, browser, _ = self.start()
        ParsedConnection.raw = raw_response(
            400,
            "Bad Request",
            GOOGLE_TOKEN_HEADERS,
            b'{"error":"invalid_grant","error_description":"QDCANARYBODY2W QDCANARYCODE5K"}',
        )
        self.refused_with("response-status", lambda: self.callback(state, browser))

    def test_wrong_account_and_bad_claims_log_claims(self):
        for change in (
            {"email": "qdcanary-other@example.invalid"},
            {"email_verified": False},
            {"aud": "qdcanaryclient7Q-other"},
            {"iss": "https://accounts.google.com.QDCANARYFIELD8P"},
        ):
            with self.subTest(change=sorted(change)):
                state, browser, nonce = self.start()
                ParsedConnection.raw = raw_response(
                    200, "OK", GOOGLE_TOKEN_HEADERS, google_token_body(id_token(nonce, **change))
                )
                self.refused_with("claims", lambda: self.callback(state, browser))

    def test_other_pinned_subject_logs_session_policy(self):
        self.assertIsNotNone(self.state.start_identity_session("another-google-subject"))
        state, browser, nonce = self.start()
        ParsedConnection.raw = raw_response(200, "OK", GOOGLE_TOKEN_HEADERS, google_token_body(id_token(nonce)))
        self.refused_with("session-policy", lambda: self.callback(state, browser))

    def test_banned_caller_logs_gate_without_a_new_failure(self):
        state, browser, _ = self.start()
        for _ in range(approval_security.LOGIN_CALLER_LIMIT):
            self.state.record_login_failure("198.51.100.77")
        self.refused_with("gate", lambda: self.callback(state, browser))

    def test_success_logs_only_fixed_session_start(self):
        state, browser, nonce = self.start()
        ParsedConnection.raw = raw_response(200, "OK", GOOGLE_TOKEN_HEADERS, google_token_body(id_token(nonce)))
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            response = self.callback(state, browser)
        self.assertEqual(response.status, 303)
        self.assertEqual(captured.getvalue(), "QD_SESSION_START\n")

    def test_missing_cookie_logs_no_cookie(self):
        state, _, _ = self.start()
        self.refused_with("state-binding-no-cookie", lambda: self.callback_without_cookie(state))

    def test_empty_cookie_logs_no_cookie(self):
        state, _, _ = self.start()
        self.refused_with("state-binding-no-cookie", lambda: self.callback(state, ""))

    def test_malformed_cookie_logs_cookie_mismatch(self):
        state, _, _ = self.start()
        self.refused_with("state-binding-cookie-mismatch", lambda: self.callback(state, "QDCANARYCOOKIE3M!"))

    def test_never_issued_state_logs_unknown_state(self):
        _, browser, _ = self.start()
        never_issued = "QDCANARYFIELD8P" + "z" * 30
        self.refused_with("state-binding-unknown-state", lambda: self.callback(never_issued, browser))

    def test_badly_formed_state_logs_unknown_state(self):
        _, browser, _ = self.start()
        self.refused_with("state-binding-unknown-state", lambda: self.callback("QDCANARYFIELD8P!", browser))

    def test_missing_return_record_logs_no_return(self):
        state, browser, _ = self.start()
        self.forget_returns()
        self.refused_with("state-binding-no-return", lambda: self.callback(state, browser))
        self.assertEqual(ParsedConnection.made, [])

    def test_expired_return_record_logs_no_return(self):
        state, browser, _ = self.start()
        captain_auth._authority._returns[state] = replace(captain_auth._authority._returns[state], expires=self.clock.value)
        self.refused_with("state-binding-no-return", lambda: self.callback(state, browser))
        self.assertEqual(ParsedConnection.made, [])

    def test_a_missing_cookie_wins_over_an_unknown_state(self):
        never_issued = "QDCANARYFIELD8P" + "z" * 30
        self.refused_with("state-binding-no-cookie", lambda: self.callback_without_cookie(never_issued))

    def test_unknown_state_wins_over_a_wrong_cookie(self):
        never_issued = "QDCANARYFIELD8P" + "z" * 30
        self.refused_with(
            "state-binding-unknown-state",
            lambda: self.callback(never_issued, "QDCANARYCOOKIE3M" + "x" * 30),
        )

    def test_missing_cookie_wins_over_a_missing_return_record(self):
        state, _, _ = self.start()
        self.forget_returns()
        self.refused_with("state-binding-no-cookie", lambda: self.callback_without_cookie(state))

    def test_wrong_cookie_wins_over_a_missing_return_record(self):
        state, _, _ = self.start()
        self.forget_returns()
        self.refused_with(
            "state-binding-cookie-mismatch",
            lambda: self.callback(state, "QDCANARYCOOKIE3M" + "x" * 30),
        )

    def test_every_refusal_with_a_cookie_burns_the_state_and_the_retry_is_unknown(self):
        causes = (
            ("cookie-mismatch", lambda state, browser: self.callback(state, "W" * 43), lambda: None),
            ("no-return", lambda state, browser: self.callback(state, browser), self.forget_returns),
        )
        for name, act, prepare in causes:
            with self.subTest(cause=name):
                self.clock.value += approval_security.LOGIN_WINDOW + 1
                state, browser, _ = self.start()
                prepare()
                with contextlib.redirect_stderr(io.StringIO()):
                    first = act(state, browser)
                self.assertEqual(first.status, 401)
                self.assertEqual(self.open_state_count(), 0)
                self.refused_with("state-binding-unknown-state", lambda: self.callback(state, browser))
                self.assertEqual(self.open_state_count(), 0)
                self.assertEqual(ParsedConnection.made, [])

    def test_the_four_causes_get_byte_identical_answers_and_distinct_log_lines(self):
        never_issued = "QDCANARYFIELD8P" + "z" * 30

        def no_cookie():
            state, _, _ = self.start()
            return self.callback_without_cookie(state)

        def cookie_mismatch():
            state, _, _ = self.start()
            return self.callback(state, "W" * 43)

        def unknown_state():
            _, browser, _ = self.start()
            return self.callback(never_issued, browser)

        def no_return():
            state, browser, _ = self.start()
            self.forget_returns()
            return self.callback(state, browser)

        answers = []
        lines = []
        for act in (no_cookie, cookie_mismatch, unknown_state, no_return):
            captured = io.StringIO()
            with contextlib.redirect_stderr(captured):
                response = act()
            answers.append((response.status, response.headers, response.body))
            lines.append(captured.getvalue())
        self.assertEqual(len(set(answers)), 1)
        self.assertEqual(
            lines,
            [
                self.binding_line("no-cookie", "no", "no", "0"),
                self.binding_line("cookie-mismatch", "yes", "yes", "2-5"),
                self.binding_line("unknown-state", "yes", "yes", "2-5"),
                self.binding_line("no-return", "yes", "yes", "2-5"),
            ],
        )

    def test_cookie_header_fact_is_no_for_an_absent_or_empty_header_and_yes_otherwise(self):
        for header, expected in ((None, "no"), ("", "no"), ("   ", "no"), (";", "yes"), ("a=b", "yes")):
            with self.subTest(header=header):
                self.assertEqual(self.facts_for(header)["cookie_header"], expected)

    def test_login_name_fact_needs_our_exact_name_then_equals_at_a_cookie_boundary(self):
        named = (
            "__Host-qd-login=abc",
            "a=b; __Host-qd-login=abc",
            "a=b;__Host-qd-login=abc",
            "a=b;   __Host-qd-login=abc",
            "__Host-qd-login=",
            "a=b; __Host-qd-login=abc; c=d",
        )
        unnamed = (
            None,
            "",
            "a=b",
            "xx__Host-qd-login=abc",
            "a=b; xx__Host-qd-login=abc",
            "a=__Host-qd-login=abc",
            'a="__Host-qd-login=abc"',
            "__Host-qd-login",
            "__Host-qd-login; a=b",
            "__Host-qd-login =abc",
            "__host-qd-login=abc",
            "__Host-qd-login-x=abc",
        )
        for header in named:
            with self.subTest(header=header):
                self.assertEqual(self.facts_for(header)["login_name_in_header"], "yes")
        for header in unnamed:
            with self.subTest(header=header):
                self.assertEqual(self.facts_for(header)["login_name_in_header"], "no")

    def test_cookie_count_fact_buckets_the_semicolon_separated_pairs(self):
        cases = (
            (None, "0"),
            ("", "0"),
            (";", "0"),
            ("; ;", "0"),
            ("a=b", "1"),
            ("a=b;", "1"),
            ("a=b; c=d", "2-5"),
            ("secure; flag", "2-5"),
            ("a=b; c=d; e=f; g=h; i=j", "2-5"),
            ("a=b; c=d; e=f; g=h; i=j; k=l", "6+"),
            ("; ".join(["x=1"] * 20), "6+"),
        )
        for header, expected in cases:
            with self.subTest(header=header):
                self.assertEqual(self.facts_for(header)["cookies"], expected)

    def test_facts_never_show_values_other_cookie_names_or_lengths(self):
        header = "QDCANARYCOOKIE3M=QDCANARYFIELD8P; other-name=QDCANARYBODY2W; __Host-qd-login=" + "x" * 43
        request = self.request(
            f"/captain/oidc/callback?code=QDCANARYCODE5K&state={NEVER_ISSUED_STATE}"
        )
        request.headers["Cookie"] = header
        line = self.refused_with("state-binding-unknown-state", lambda: self.app.handle(request))
        self.assertEqual(line, self.binding_line("unknown-state", "yes", "yes", "2-5"))
        for fragment in ("QDCANARY", "other-name", "xxxx", "__Host-qd-login", "198.51.100.77", "43"):
            self.assertNotIn(fragment, line)

    def test_badly_formed_state_line_carries_the_facts(self):
        _, browser, _ = self.start()
        line = self.refused_with("state-binding-unknown-state", lambda: self.callback("QDCANARYFIELD8P!", browser))
        self.assertEqual(line, self.binding_line("unknown-state", "yes", "yes", "2-5"))

    def test_empty_login_cookie_is_no_cookie_but_the_header_and_name_are_still_reported(self):
        state, _, _ = self.start()
        line = self.refused_with("state-binding-no-cookie", lambda: self.callback(state, ""))
        self.assertEqual(line, self.binding_line("no-cookie", "yes", "yes", "2-5"))

    def test_other_stages_keep_the_old_one_field_line_even_with_cookies_present(self):
        state, browser, _ = self.start()
        shape = self.refused_with("shape", lambda: self.callback(state, browser, "&next=QDCANARYFIELD8P"))
        self.assertEqual(shape, "QD_SIGNIN_REFUSED stage=shape\n")
        for _ in range(approval_security.LOGIN_CALLER_LIMIT):
            self.state.record_login_failure("198.51.100.77")
        gate = self.refused_with("gate", lambda: self.callback(state, browser))
        self.assertEqual(gate, "QD_SIGNIN_REFUSED stage=gate\n")
        for line in (shape, gate):
            self.assertNotIn("cookie_header", line)

    def test_login_cookie_name_is_one_value_in_approval_and_captain_auth(self):
        self.assertEqual(approval_app.LOGIN_COOKIE, "__Host-qd-login")
        self.assertEqual(approval_app.LOGIN_COOKIE, captain_auth.LOGIN_COOKIE)

    def test_stage_names_are_the_fixed_enum(self):
        self.assertEqual(tuple(approval_security.REFUSAL_STAGES[: len(STAGES)]), STAGES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
