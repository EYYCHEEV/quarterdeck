from __future__ import annotations

import os
import tempfile
import unittest
from html.parser import HTMLParser
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import approval_app
import approval_security
import captain_auth
import invite_prompt
from test_approval_oidc_app import Backend, Clock, FakeOidc, TokenSource
from test_signin_support import production_sign_in


SIGN_IN_FAILED = "Sign-in did not finish. Open Safari itself, then sign in again and stay in one tab."
TOO_MANY_TRIES = "Too many sign-in tries. Wait one hour, then sign in again."
CSP = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
SECURITY_HEADERS = (
    ("Content-Type", "text/html; charset=utf-8"),
    ("Cache-Control", "no-store"),
    ("Content-Security-Policy", CSP),
    ("Referrer-Policy", "strict-origin"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
)
CLEAR_LOGIN_COOKIE = (
    "Set-Cookie",
    "__Host-qd-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
)
REFUSAL_PAGE_TAGS = {"html", "head", "meta", "title", "body", "main", "p", "a"}
ORIGIN = "https://approval.example.invalid"


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.doctype = None
        self.tags = []
        self.attributes = []
        self.links = []
        self.paragraphs = []
        self._open = []
        self._link = None
        self._paragraph = None
        self.feed(source)
        self.close()

    def handle_decl(self, decl):
        self.doctype = decl

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        self.attributes.append((tag, dict(attrs)))
        if tag == "meta":
            return
        self._open.append(tag)
        if tag == "a":
            self._link = [dict(attrs).get("href"), ""]
        if tag == "p":
            self._paragraph = ""

    def handle_endtag(self, tag):
        if tag in self._open:
            self._open.remove(tag)
        if tag == "a" and self._link is not None:
            self.links.append(tuple(self._link))
            self._link = None
        if tag == "p" and self._paragraph is not None:
            self.paragraphs.append(self._paragraph)
            self._paragraph = None

    def handle_data(self, data):
        if self._link is not None:
            self._link[1] += data
        if self._paragraph is not None:
            self._paragraph += data

    def meta(self):
        return [attributes for tag, attributes in self.attributes if tag == "meta"]


class SignInPagesCase(unittest.TestCase):
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
        self.addCleanup(setattr, captain_auth, "_authority", None)
        self.app = approval_app.ApprovalApplication(
            self.state,
            production_sign_in(self.state, self.oidc),
            Backend(),
            invite_prompt.ReleaseConfig(
                artifact_url="https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
                version="1.2.3",
                sha256="ab" * 32,
                join_address=ORIGIN,
            ),
            trusted_proxy="proxy.internal",
            public_origin=ORIGIN,
        )

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

    def start_login(self, caller="198.51.100.20"):
        response = self.app.handle(self.request("GET", "/captain/login", caller=caller))
        self.assertEqual(response.status, 303)
        state = parse_qs(urlsplit(dict(response.headers)["Location"]).query)["state"][0]
        if not hasattr(self, "device_cookies"):
            self.device_cookies = {}
        self.device_cookies[state] = self.cookie(response, "__Host-qd-device")
        return state, self.cookie(response, "__Host-qd-login")

    def callback(self, state, browser, code, caller="198.51.100.20"):
        return self.app.handle(
            self.request(
                "GET",
                f"/captain/oidc/callback?code={code}&state={state}",
                cookie=f"__Host-qd-login={browser}; __Host-qd-device={self.device_cookies[state]}",
                caller=caller,
            )
        )

    def login(self):
        state, browser = self.start_login()
        response = self.callback(state, browser, "accepted-code")
        self.assertEqual(response.status, 303)
        return self.cookie(response, "__Host-qd-approval")

    def ban(self, caller):
        for _ in range(approval_security.LOGIN_CALLER_LIMIT):
            self.state.record_login_failure(caller)


class RefusalPageTests(SignInPagesCase):
    def assert_refusal_page(self, response, status, text, link, clears_login_cookie):
        self.assertEqual(response.status, status)
        expected = list(SECURITY_HEADERS)
        if clears_login_cookie:
            expected.append(CLEAR_LOGIN_COOKIE)
        expected.append(("Content-Length", str(len(response.body))))
        self.assertEqual(list(response.headers), expected)
        page = Page(response.body.decode("utf-8"))
        self.assertEqual(page.doctype, "doctype html")
        self.assertTrue(response.body.startswith(b"<!doctype html>"))
        self.assertEqual(page.tags.count("main"), 1)
        self.assertEqual(page.tags.count("title"), 1)
        self.assertEqual(page.tags.count("html"), 1)
        self.assertIn({"charset": "utf-8"}, page.meta())
        self.assertIn(
            {"name": "viewport", "content": "width=device-width, initial-scale=1"},
            page.meta(),
        )
        self.assertEqual(page.paragraphs[0], text)
        if link:
            self.assertEqual(page.links, [("/captain/login", "Sign in again")])
        else:
            self.assertEqual(page.links, [])
            self.assertEqual(page.paragraphs, [text])
        self.assertEqual(response.body.count(text.encode("utf-8")), 1)

    def test_callback_refusal_is_the_sign_in_did_not_finish_page(self):
        state, browser = self.start_login()
        response = self.callback(state, browser, "wrong-code")
        self.assert_refusal_page(response, 401, SIGN_IN_FAILED, True, True)

    def test_blocked_fifth_failure_is_the_too_many_tries_page_and_clears_the_cookie(self):
        responses = []
        for _ in range(approval_security.LOGIN_CALLER_LIMIT):
            state, browser = self.start_login()
            responses.append(self.callback(state, browser, "wrong-code"))
        for response in responses[:-1]:
            self.assert_refusal_page(response, 401, SIGN_IN_FAILED, True, True)
        self.assert_refusal_page(responses[-1], 429, TOO_MANY_TRIES, False, True)

    def test_login_start_limit_is_the_too_many_tries_page(self):
        self.ban("198.51.100.20")
        response = self.app.handle(self.request("GET", "/captain/login"))
        self.assert_refusal_page(response, 429, TOO_MANY_TRIES, False, False)

    def test_callback_gate_is_the_too_many_tries_page_and_clears_the_cookie(self):
        state, browser = self.start_login()
        self.ban("198.51.100.20")
        response = self.callback(state, browser, "accepted-code")
        self.assert_refusal_page(response, 429, TOO_MANY_TRIES, False, True)
        self.assertEqual(self.oidc.exchanges, [])

    def test_rate_limited_error_handler_is_the_too_many_tries_page(self):
        session = self.login()
        self.ban("198.51.100.20")
        response = self.app.handle(
            self.request(
                "POST",
                "/captain/settings/approval-password",
                body=b"action=enable",
                cookie=f"__Host-qd-approval={session}",
                origin=ORIGIN,
            )
        )
        self.assert_refusal_page(response, 429, TOO_MANY_TRIES, False, False)

    def test_only_the_sign_in_page_offers_a_link(self):
        state, browser = self.start_login()
        refused = self.callback(state, browser, "wrong-code")
        self.ban("198.51.100.20")
        limited = self.app.handle(self.request("GET", "/captain/login"))
        self.assertIn(b'<a href="/captain/login">Sign in again</a>', refused.body)
        self.assertNotIn(b"<a ", limited.body)
        self.assertNotIn(b"/captain/login", limited.body)

    def test_page_is_fine_under_the_strict_content_security_policy(self):
        state, browser = self.start_login()
        refused = self.callback(state, browser, "wrong-code")
        self.ban("198.51.100.20")
        limited = self.app.handle(self.request("GET", "/captain/login"))
        for response in (refused, limited):
            with self.subTest(status=response.status):
                page = Page(response.body.decode("utf-8"))
                self.assertEqual(page.tags.count("main"), 1)
                self.assertLessEqual(set(page.tags), REFUSAL_PAGE_TAGS)
                for tag, attributes in page.attributes:
                    self.assertFalse(any(name.startswith("on") for name in attributes))
                    self.assertNotIn("style", attributes)
                    self.assertNotIn("nonce", attributes)
                    if tag != "meta":
                        self.assertLessEqual(set(attributes), {"href", "lang"})
                self.assertEqual(dict(response.headers)["Content-Security-Policy"], CSP)
                self.assertNotIn(b"<script", response.body.lower())
                self.assertNotIn(b"<style", response.body.lower())
                self.assertNotIn(b"javascript:", response.body.lower())

    def test_other_refusals_keep_their_plain_bodies(self):
        forwarded = self.app.handle(self.request("GET", "/captain/pending", peer="other.internal"))
        self.assertEqual((forwarded.status, forwarded.body), (403, b"Request refused"))
        missing = self.app.handle(self.request("GET", "/captain/unknown"))
        self.assertEqual((missing.status, missing.body), (404, b"Not found"))


class ChatEntryTests(SignInPagesCase):
    def test_login_start_stores_the_chat_page_as_the_return(self):
        state, _ = self.start_login()
        returns = captain_auth._authority._returns
        self.assertEqual(list(returns), [state])
        self.assertEqual(returns[state].next_path, "/captain/chat")

    def test_successful_callback_lands_on_chat(self):
        state, browser = self.start_login()
        response = self.callback(state, browser, "accepted-code")
        self.assertEqual(response.status, 303)
        self.assertEqual(dict(response.headers)["Location"], "/captain/chat")
        self.assertTrue(self.cookie(response, "__Host-qd-approval"))

    def test_pending_page_links_to_chat(self):
        session = self.login()
        page = self.app.handle(
            self.request("GET", "/captain/pending", cookie=f"__Host-qd-approval={session}")
        )
        self.assertEqual(page.status, 200)
        parsed = Page(page.body.decode("utf-8"))
        self.assertIn(("/captain/chat", "Chat"), parsed.links)
        self.assertEqual(parsed.links.count(("/captain/chat", "Chat")), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
