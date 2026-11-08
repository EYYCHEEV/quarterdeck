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
import captain_auth
import oidc
from test_signin_support import production_sign_in


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


class FakeOidc:
    def __init__(self):
        self.authorization = []
        self.exchanges = []

    def authorization_url(self, *, state, nonce, challenge, step_up=False):
        self.authorization.append((state, nonce, challenge))
        return "https://identity.example.invalid/auth?" + urlencode(
            {"state": state, "nonce": nonce, "code_challenge": challenge}
        )

    def exchange_code(self, code, verifier, nonce, *, auth_started):
        self.exchanges.append((code, verifier, nonce))
        if code != "accepted-code":
            raise approval_security.ApprovalRefused("uniform refusal")
        return oidc.FreshIdentity("captain-subject", auth_started)


class Backend:
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
        self.calls.append(("invites",))
        return [
            {
                "inviteId": "AAAAAAAAAAAA",
                "botName": "bot-b",
                "invitedBy": "Captain",
                "createdAt": 1000.0,
                "expiresAt": 87400.0,
            }
        ]

    def create_invite(self, bot_name):
        self.calls.append(("create-invite", bot_name))
        return {
            "inviteId": "BBBBBBBBBBBB",
            "code": "abcdefghijklmnopqrstuv",
            "botName": bot_name,
            "invitedBy": "Captain",
            "createdAt": 1000.0,
            "expiresAt": 87400.0,
        }

    def cancel_invite(self, invite_id):
        self.calls.append(("cancel-invite", invite_id))
        return True

    def approve(self, code):
        self.calls.append(("approve", code))
        return True

    def refuse(self, code):
        self.calls.append(("refuse", code))
        return True


class ApprovalOidcApplicationTests(unittest.TestCase):
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
        self.oidc = FakeOidc()
        self.sign_in = production_sign_in(self.state, self.oidc)
        self.backend = Backend()
        self.app = approval_app.ApprovalApplication(
            self.state,
            self.sign_in,
            self.backend,
            invite_prompt.ReleaseConfig(
                artifact_url="https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
                version="1.2.3",
                sha256="ab" * 32,
                join_address="https://approval.example.invalid",
            ),
            trusted_proxy="proxy.internal",
            public_origin="https://approval.example.invalid",
        )

    @staticmethod
    def request(
        method,
        path,
        *,
        body=b"",
        cookie=None,
        origin=None,
        peer="proxy.internal",
        caller="198.51.100.20",
    ):
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

    @staticmethod
    def csrf(response):
        return re.search(
            rb'name="csrf" value="([A-Za-z0-9_-]+)"', response.body
        ).group(1).decode("ascii")

    def start_login(self, step_up=False):
        response = self.app.handle(self.request("GET", "/captain/step-up" if step_up else "/captain/login"))
        self.assertEqual(response.status, 303)
        browser = self.cookie(response, "__Host-qd-login")
        self.device_cookie = self.cookie(response, "__Host-qd-device")
        location = dict(response.headers)["Location"]
        state = parse_qs(urlsplit(location).query, strict_parsing=True)["state"][0]
        set_cookie = [
            value for name, value in response.headers if name.lower() == "set-cookie"
        ]
        self.assertTrue(
            any(
                "Secure" in value
                and "HttpOnly" in value
                and "SameSite=Lax" in value
                for value in set_cookie
            )
        )
        return state, browser

    def login(self):
        state, browser = self.start_login(step_up=True)
        response = self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code=accepted-code&state={state}",
                cookie=f"__Host-qd-login={browser}; __Host-qd-device={self.device_cookie}",
            )
        )
        self.assertEqual(response.status, 303)
        return self.cookie(response, "__Host-qd-approval")

    def test_google_callback_shape_signs_in_through_the_production_callback(self):
        self.assertIs(self.sign_in, captain_auth)
        state, browser = self.start_login()
        response = self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code=accepted-code&state={state}"
                "&scope=email+openid+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email"
                "&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com",
                cookie=f"__Host-qd-login={browser}; __Host-qd-device={self.device_cookie}",
            )
        )
        self.assertEqual(response.status, 303)
        self.assertEqual(dict(response.headers)["Location"], "/captain/chat")
        self.assertTrue(self.cookie(response, "__Host-qd-approval"))

    def test_password_and_phone_code_login_path_does_not_exist(self):
        response = self.app.handle(
            self.request(
                "POST",
                "/captain/login",
                body=urlencode(
                    {
                        "password": "not-a-live-password",
                        "phoneCode": "123456",
                        "csrf": "not-a-live-csrf",
                    }
                ).encode("ascii"),
                cookie="__Host-qd-preauth=not-a-live-preauth",
                origin="https://approval.example.invalid",
            )
        )

        self.assertEqual(response.status, 404)
        self.assertFalse(
            any(
                name.lower() == "set-cookie"
                and value.startswith("__Host-qd-approval=")
                for name, value in response.headers
            )
        )
        self.assertFalse(hasattr(self.app, "_login"))
        self.assertFalse(hasattr(self.app, "_login_page"))
        self.assertFalse(hasattr(approval_security.ApprovalState, "start_session"))

    def test_callback_is_bound_to_browser_and_wrong_browser_burns_state(self):
        state, browser = self.start_login()
        wrong = self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code=accepted-code&state={state}",
                cookie=f"__Host-qd-login={'W' * 43}",
            )
        )
        self.assertEqual(wrong.status, 401)
        self.assertEqual(self.oidc.exchanges, [])

        burned = self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code=accepted-code&state={state}",
                cookie=f"__Host-qd-login={browser}",
            )
        )
        self.assertEqual(burned.status, 401)
        self.assertEqual(self.oidc.exchanges, [])

        session = self.login()
        pending = self.app.handle(
            self.request(
                "GET",
                "/captain/pending",
                cookie=f"__Host-qd-approval={session}",
            )
        )
        self.assertEqual(pending.status, 200)
        self.assertIn(b"bot-a", pending.body)

    def test_optional_password_applies_only_to_approve_and_changes_are_visible(self):
        session = self.login()
        cookie = f"__Host-qd-approval={session}"
        page = self.app.handle(self.request("GET", "/captain/pending", cookie=cookie))
        csrf = self.csrf(page)
        enabled = self.app.handle(
            self.request(
                "POST",
                "/captain/settings/approval-password",
                body=urlencode(
                    {
                        "action": "enable",
                        "currentPassword": "",
                        "newPassword": "not-a-live-approval-password",
                        "csrf": csrf,
                    }
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(enabled.status, 303)

        page = self.app.handle(self.request("GET", "/captain/pending", cookie=cookie))
        self.assertIn(b"Approval password required", page.body)
        approve_csrf = self.csrf(page)
        wrong = self.app.handle(
            self.request(
                "POST",
                "/captain/approve",
                body=urlencode(
                    {
                        "code": "ABCDEFGH",
                        "csrf": approve_csrf,
                        "approvalPassword": "wrong-password",
                    }
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(wrong.status, 403)
        self.assertNotIn(("approve", "ABCDEFGH"), self.backend.calls)

        page = self.app.handle(self.request("GET", "/captain/pending", cookie=cookie))
        refuse_csrf = self.csrf(page)
        refused = self.app.handle(
            self.request(
                "POST",
                "/captain/refuse",
                body=urlencode({"code": "ABCDEFGH", "csrf": refuse_csrf}).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(refused.status, 303)
        self.assertIn(("refuse", "ABCDEFGH"), self.backend.calls)

        page = self.app.handle(self.request("GET", "/captain/pending", cookie=cookie))
        approve_csrf = self.csrf(page)
        approved = self.app.handle(
            self.request(
                "POST",
                "/captain/approve",
                body=urlencode(
                    {
                        "code": "ABCDEFGH",
                        "csrf": approve_csrf,
                        "approvalPassword": "not-a-live-approval-password",
                    }
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(approved.status, 303)
        history = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        self.assertIn(b"Refused ABCDEFGH", history.body)
        self.assertIn(b"Approved ABCDEFGH", history.body)

    def test_every_post_form_strict_origin_preserves_origin_header(self):
        session = self.login()
        page = self.app.handle(
            self.request(
                "GET",
                "/captain/pending",
                cookie=f"__Host-qd-approval={session}",
            )
        )
        actions = set(
            re.findall(
                r'<form method="post" action="([^"]+)">',
                page.body.decode("utf-8"),
            )
        )
        self.assertEqual(
            actions,
            {
                "/captain/approve",
                "/captain/refuse",
                "/captain/invites/create",
                "/captain/invites/cancel",
                "/captain/settings/approval-password",
                "/captain/logout",
            },
        )
        policy = dict(page.headers)["Referrer-Policy"]
        origin_from_fetch_rule = {
            "no-referrer": "null",
            "strict-origin": "https://approval.example.invalid",
        }
        self.assertIn(policy, origin_from_fetch_rule)
        for action in actions:
            with self.subTest(action=action):
                self.assertEqual(
                    origin_from_fetch_rule[policy],
                    "https://approval.example.invalid",
                )

    def test_add_bot_shows_prompt_once_and_open_invite_can_be_cancelled(self):
        session = self.login()
        cookie = f"__Host-qd-approval={session}"
        page = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        self.assertIn(b"invited by Captain", page.body)
        self.assertIn(b"bot-b", page.body)
        created = self.app.handle(
            self.request(
                "POST",
                "/captain/invites/create",
                body=urlencode(
                    {"botName": "new-bot", "csrf": self.csrf(page)}
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(created.status, 200)
        self.assertIn(b"abcdefghijklmnopqrstuv", created.body)
        self.assertIn(b"sha256sum --check --strict", created.body)
        self.assertIn(b"Copy", created.body)
        self.assertIn(("create-invite", "new-bot"), self.backend.calls)

        later = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        self.assertNotIn(b"abcdefghijklmnopqrstuv", later.body)
        cancelled = self.app.handle(
            self.request(
                "POST",
                "/captain/invites/cancel",
                body=urlencode(
                    {
                        "inviteId": "AAAAAAAAAAAA",
                        "csrf": self.csrf(later),
                    }
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(cancelled.status, 303)
        self.assertIn(
            ("cancel-invite", "AAAAAAAAAAAA"),
            self.backend.calls,
        )

    def test_fifth_wrong_approval_password_bans_that_caller(self):
        session = self.login()
        cookie = f"__Host-qd-approval={session}"
        page = self.app.handle(self.request("GET", "/captain/pending", cookie=cookie))
        enabled = self.app.handle(
            self.request(
                "POST",
                "/captain/settings/approval-password",
                body=urlencode(
                    {
                        "action": "enable",
                        "currentPassword": "",
                        "newPassword": "not-a-live-approval-password",
                        "csrf": self.csrf(page),
                    }
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(enabled.status, 303)

        statuses = []
        for _ in range(5):
            page = self.app.handle(
                self.request("GET", "/captain/pending", cookie=cookie)
            )
            statuses.append(
                self.app.handle(
                    self.request(
                        "POST",
                        "/captain/approve",
                        body=urlencode(
                            {
                                "code": "ABCDEFGH",
                                "csrf": self.csrf(page),
                                "approvalPassword": "wrong-password",
                            }
                        ).encode("ascii"),
                        cookie=cookie,
                        origin="https://approval.example.invalid",
                    )
                ).status
            )
        self.assertEqual(statuses, [403, 403, 403, 403, 429])
        self.assertNotIn(("approve", "ABCDEFGH"), self.backend.calls)

        page = self.app.handle(
            self.request("GET", "/captain/pending", cookie=cookie)
        )
        blocked = self.app.handle(
            self.request(
                "POST",
                "/captain/approve",
                body=urlencode(
                    {
                        "code": "ABCDEFGH",
                        "csrf": self.csrf(page),
                        "approvalPassword": "not-a-live-approval-password",
                    }
                ).encode("ascii"),
                cookie=cookie,
                origin="https://approval.example.invalid",
            )
        )
        self.assertEqual(blocked.status, 429)
        self.assertNotIn(("approve", "ABCDEFGH"), self.backend.calls)


if __name__ == "__main__":
    unittest.main(verbosity=2)
