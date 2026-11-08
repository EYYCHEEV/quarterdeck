from __future__ import annotations

from http.cookies import SimpleCookie
import os
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import approval_app
import approval_security
import invite_prompt
import oidc
from test_signin_support import production_sign_in


class Clock:
    def __init__(self, value=1_000.0):
        self.value = value

    def __call__(self):
        return self.value


class TokenSource:
    def __init__(self):
        self.value = 0

    def __call__(self, size):
        self.value += 1
        return bytes([self.value]) * size


class Authenticator:
    def __init__(self):
        self.calls = 0

    def authorization_url(self, *, state, nonce, challenge):
        return "https://identity.example.invalid/auth?" + urlencode(
            {"state": state, "nonce": nonce, "code_challenge": challenge}
        )

    def exchange_code(self, code, verifier, nonce, *, auth_started):
        self.calls += 1
        if code != "accepted-code":
            raise approval_security.ApprovalRefused("uniform refusal")
        return oidc.FreshIdentity("captain-subject", auth_started)


class Backend:
    def pending(self):
        return []
    def invites(self):
        return []

    def create_invite(self, bot_name):
        raise AssertionError("invite creation not expected")

    def cancel_invite(self, invite_id):
        raise AssertionError("invite cancellation not expected")


    def approve(self, code):
        return True

    def refuse(self, code):
        return True


class ApprovalLimitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.clock = Clock()
        self.authenticator = Authenticator()
        self.state = approval_security.ApprovalState(
            self.base / "state.sqlite",
            bytes([75]) * 32,
            clock=self.clock,
            token_bytes=TokenSource(),
        )
        self.app = approval_app.ApprovalApplication(
            self.state,
            production_sign_in(self.state, self.authenticator),
            Backend(),
            invite_prompt.ReleaseConfig(
                "https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
                "1.2.3",
                "ab" * 32,
                "https://approval.example.invalid",
            ),
            trusted_proxy="proxy.internal",
            public_origin="https://approval.example.invalid",
        )

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def request(method, path, *, body=b"", cookie=None, origin=None, caller="198.51.100.20"):
        headers = {
            "X-Forwarded-For": caller,
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "approval.example.invalid",
            "Sec-Fetch-Dest": "document",
        }
        if body:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if cookie:
            headers["Cookie"] = cookie
        if origin:
            headers["Origin"] = origin
        return approval_app.Request(method, path, headers, bytearray(body), "proxy.internal")

    @staticmethod
    def cookie(response, name):
        values = SimpleCookie()
        for header, value in response.headers:
            if header.lower() == "set-cookie":
                values.load(value)
        return values[name].value

    def login(self, caller, code):
        started = self.app.handle(
            self.request("GET", "/captain/login", caller=caller)
        )
        if started.status != 303:
            return started
        browser = self.cookie(started, "__Host-qd-login")
        state = parse_qs(
            urlsplit(dict(started.headers)["Location"]).query,
            strict_parsing=True,
        )["state"][0]
        return self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code={code}&state={state}",
                cookie=f"__Host-qd-login={browser}; __Host-qd-device={self.cookie(started, '__Host-qd-device')}",
                caller=caller,
            )
        )

    def test_fifth_failed_login_bans_that_caller_before_more_exchanges(self):
        statuses = [
            self.login("198.51.100.20", "wrong-code").status
            for _ in range(5)
        ]
        self.assertEqual(statuses, [401, 401, 401, 401, 429])
        checked = self.authenticator.calls

        blocked = self.login("198.51.100.20", "accepted-code")
        self.assertEqual(blocked.status, 429)
        self.assertEqual(self.authenticator.calls, checked)

        other = self.login("198.51.100.21", "accepted-code")
        self.assertEqual(other.status, 303)



    def test_twentieth_global_failure_closes_login_without_killing_existing_session(self):
        existing = self.login("198.51.100.10", "accepted-code")
        self.assertEqual(existing.status, 303)
        session = self.cookie(existing, "__Host-qd-approval")

        statuses = [
            self.login(f"198.51.100.{index + 30}", "wrong-code").status
            for index in range(20)
        ]
        self.assertEqual(statuses[-1], 429)
        checked = self.authenticator.calls

        closed = self.login("198.51.100.90", "accepted-code")
        self.assertEqual(closed.status, 429)
        self.assertEqual(self.authenticator.calls, checked)

        existing_request = self.app.handle(
            self.request(
                "GET",
                "/captain/pending",
                cookie=f"__Host-qd-approval={session}",
                caller="198.51.100.10",
            )
        )
        self.assertEqual(existing_request.status, 200)

    def test_thirty_authenticated_requests_per_minute_are_allowed_then_refused(self):
        logged_in = self.login("198.51.100.20", "accepted-code")
        session = self.cookie(logged_in, "__Host-qd-approval")
        cookie = f"__Host-qd-approval={session}"
        statuses = [
            self.app.handle(
                self.request(
                    "GET",
                    "/captain/pending",
                    cookie=cookie,
                    caller="198.51.100.20",
                )
            ).status
            for _ in range(31)
        ]
        self.assertEqual(statuses[:30], [200] * 30)
        self.assertEqual(statuses[30], 429)

    def test_global_authenticated_cap_refuses_request_121_without_ending_sessions(self):
        sessions = []
        for index in range(5):
            logged_in = self.login(
                f"198.51.100.{index + 10}",
                "accepted-code",
            )
            self.assertEqual(logged_in.status, 303)
            sessions.append(self.cookie(logged_in, "__Host-qd-approval"))
            self.clock.value += 30

        for index, session in enumerate(sessions):
            statuses = [
                self.app.handle(
                    self.request(
                        "GET",
                        "/captain/pending",
                        cookie=f"__Host-qd-approval={session}",
                        caller=f"198.51.100.{index + 10}",
                    )
                ).status
                for _ in range(24)
            ]
            self.assertEqual(statuses, [200] * 24)

        refused = self.app.handle(
            self.request(
                "GET",
                "/captain/pending",
                cookie=f"__Host-qd-approval={sessions[0]}",
                caller="198.51.100.10",
            )
        )
        self.assertEqual(refused.status, 429)

    def test_distinct_google_flows_create_distinct_sessions(self):
        first = self.login("198.51.100.20", "accepted-code")
        second = self.login("198.51.100.21", "accepted-code")
        self.assertEqual(first.status, 303)
        self.assertEqual(second.status, 303)
        self.assertNotEqual(
            self.cookie(first, "__Host-qd-approval"),
            self.cookie(second, "__Host-qd-approval"),
        )

    def test_session_expires_after_seven_idle_days(self):
        logged_in = self.login("198.51.100.20", "accepted-code")
        session = self.cookie(logged_in, "__Host-qd-approval")
        self.clock.value += 7 * 86400
        expired = self.app.handle(
            self.request(
                "GET",
                "/captain/pending",
                cookie=f"__Host-qd-approval={session}",
                caller="198.51.100.20",
            )
        )
        self.assertEqual(expired.status, 303)

    def test_session_expires_after_thirty_days_even_when_active(self):
        logged_in = self.login("198.51.100.20", "accepted-code")
        session = self.cookie(logged_in, "__Host-qd-approval")
        cookie = f"__Host-qd-approval={session}"
        for _ in range(4):
            self.clock.value += 6 * 86400
            active = self.app.handle(
                self.request(
                    "GET",
                    "/captain/pending",
                    cookie=cookie,
                    caller="198.51.100.20",
                )
            )
            self.assertEqual(active.status, 200)
        self.clock.value += 6 * 86400
        expired = self.app.handle(
            self.request(
                "GET",
                "/captain/pending",
                cookie=cookie,
                caller="198.51.100.20",
            )
        )
        self.assertEqual(expired.status, 303)
if __name__ == "__main__":
    unittest.main(verbosity=2)
