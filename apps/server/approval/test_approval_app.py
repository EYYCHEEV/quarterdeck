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


class FakeAuthenticator:
    def authorization_url(self, *, state, nonce, challenge, step_up=False):
        return "https://identity.example.invalid/auth?" + urlencode(
            {"state": state, "nonce": nonce, "code_challenge": challenge}
        )

    def exchange_code(self, code, verifier, nonce, *, auth_started):
        if code != "accepted-code":
            raise approval_security.ApprovalRefused("uniform refusal")
        return oidc.FreshIdentity("captain-subject", auth_started)


class TokenSource:
    def __init__(self):
        self.value = 0

    def __call__(self, size):
        self.value += 1
        return bytes([self.value]) * size


class FakeBackend:
    def __init__(self):
        self.calls = []

    def pending(self):
        self.calls.append(("pending",))
        return [
            {
                "code": "ABCDEFGH",
                "botName": "bot-a",
                "requestedAt": 1000.0,
                "invitedBy": "Captain",
            }
        ]

    def invites(self):
        return []

    def create_invite(self, bot_name):
        raise AssertionError("invite creation not expected")

    def cancel_invite(self, invite_id):
        raise AssertionError("invite cancellation not expected")

    def approve(self, code):
        self.calls.append(("approve", code))
        return True

    def refuse(self, code):
        self.calls.append(("refuse", code))
        return True


class ApprovalApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.clock = Clock()
        self.backend = FakeBackend()
        self.state = approval_security.ApprovalState(
            self.base / "state.sqlite",
            bytes([75]) * 32,
            clock=self.clock,
            token_bytes=TokenSource(),
        )
        self.app = approval_app.ApprovalApplication(
            self.state,
            production_sign_in(self.state, FakeAuthenticator()),
            self.backend,
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
    def request(method, path, *, body=b"", cookie=None, origin=None, peer="proxy.internal", caller="198.51.100.20"):
        headers = {
            "X-Forwarded-For": caller,
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "approval.example.invalid",
        }
        if body:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if cookie:
            headers["Cookie"] = cookie
        if origin:
            headers["Origin"] = origin
        return approval_app.Request(method, path, headers, bytearray(body), peer)

    @staticmethod
    def cookie(response, name):
        values = SimpleCookie()
        for header, value in response.headers:
            if header.lower() == "set-cookie":
                values.load(value)
        return values[name].value

    def login(self):
        started = self.app.handle(self.request("GET", "/captain/step-up?next=%2Fcaptain%2Fchat"))
        self.assertEqual(started.status, 303)
        browser = self.cookie(started, "__Host-qd-login")
        state = parse_qs(
            urlsplit(dict(started.headers)["Location"]).query,
            strict_parsing=True,
        )["state"][0]
        logged_in = self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code=accepted-code&state={state}",
                cookie=f"__Host-qd-login={browser}; __Host-qd-device={self.cookie(started, '__Host-qd-device')}",
            )
        )
        self.assertEqual(logged_in.status, 303)
        return self.cookie(logged_in, "__Host-qd-approval"), logged_in

    def test_google_login_creates_short_private_session_then_lists_pending(self):
        session, logged_in = self.login()
        set_cookie = [
            value
            for name, value in logged_in.headers
            if name.lower() == "set-cookie"
        ]
        self.assertTrue(
            any(
                "Secure" in value
                and "HttpOnly" in value
                and "SameSite=Lax" in value
                and "Max-Age=2592000" in value
                for value in set_cookie
            )
        )

        pending = self.app.handle(
            self.request(
                "GET",
                "/captain/pending",
                cookie=f"__Host-qd-approval={session}",
            )
        )
        self.assertEqual(pending.status, 200)
        self.assertIn(b"bot-a", pending.body)
        self.assertIn(b"requested less than 1 min ago (7:16 PM ET)", pending.body)
        self.assertEqual(self.backend.calls, [("pending",)])

    def test_actions_require_one_use_csrf_and_logout_invalidates_session(self):
        session, _ = self.login()
        cookie = f"__Host-qd-approval={session}"
        pending = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        csrf = re.search(
            rb'name="csrf" value="([A-Za-z0-9_-]+)"', pending.body
        ).group(1).decode("ascii")
        action_body = urlencode({"code": "ABCDEFGH", "csrf": csrf}).encode("ascii")
        approved = self.app.handle(
            self.request(
                "POST",
                "/captain/approve",
                body=action_body,
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(approved.status, 303)
        self.assertEqual(self.backend.calls, [("pending",), ("approve", "ABCDEFGH")])

        replay = self.app.handle(
            self.request(
                "POST",
                "/captain/approve",
                body=action_body,
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(replay.status, 403)
        self.assertEqual(self.backend.calls, [("pending",), ("approve", "ABCDEFGH")])

        next_page = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        refuse_csrf = re.search(
            rb'name="csrf" value="([A-Za-z0-9_-]+)"', next_page.body
        ).group(1).decode("ascii")
        refused_action = self.app.handle(
            self.request(
                "POST",
                "/captain/refuse",
                body=urlencode(
                    {"code": "ABCDEFGH", "csrf": refuse_csrf}
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(refused_action.status, 303)
        self.assertEqual(
            self.backend.calls,
            [
                ("pending",),
                ("approve", "ABCDEFGH"),
                ("pending",),
                ("refuse", "ABCDEFGH"),
            ],
        )

        logout_page = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        logout_csrf = re.search(
            rb'name="csrf" value="([A-Za-z0-9_-]+)"', logout_page.body
        ).group(1).decode("ascii")
        logged_out = self.app.handle(
            self.request(
                "POST",
                "/captain/logout",
                body=urlencode({"csrf": logout_csrf}).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(logged_out.status, 303)
        logged_out_headers = dict(logged_out.headers)
        self.assertEqual(logged_out_headers["Clear-Site-Data"], '"storage"')
        cookies = [value for name, value in logged_out.headers if name == "Set-Cookie"]
        for name in ("__Host-qd-approval", "__Host-qd-device"):
            self.assertIn(f"{name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0", cookies)

        refused = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        self.assertEqual(refused.status, 303)
        self.assertEqual(dict(refused.headers)["Location"], "/captain/login")

    def test_untrusted_forwarding_never_reaches_login_or_backend(self):
        response = self.app.handle(
            self.request("GET", "/captain/login", peer="other-proxy.internal")
        )
        self.assertEqual(response.status, 403)
        self.assertEqual(self.backend.calls, [])
        forged = self.app.handle(
            self.request(
                "GET",
                "/captain/login",
                caller="198.51.100.20, 198.51.100.21",
            )
        )
        self.assertEqual(forged.status, 403)
        self.assertEqual(self.backend.calls, [])
        malformed = self.app.handle(
            self.request("GET", "/captain/login", caller="not-an-address")
        )
        self.assertEqual(malformed.status, 403)
        self.assertEqual(self.backend.calls, [])



if __name__ == "__main__":
    unittest.main(verbosity=2)
