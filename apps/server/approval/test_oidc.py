from __future__ import annotations

import base64
import http.client
import io
import json
import os
import tempfile
import ssl
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import approval_security
import oidc


def encoded(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def token(payload):
    header = encoded(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode("ascii"))
    body = encoded(json.dumps(payload, separators=(",", ":")).encode("ascii"))
    return f"{header}.{body}.standin-signature"


class Transport:
    def __init__(self, id_token):
        self.id_token = id_token
        self.calls = []

    def exchange(self, body):
        self.calls.append(bytes(body))
        return (
            200,
            {"content-type": "application/json", "cache-control": "no-store"},
            bytearray(
                json.dumps(
                    {"id_token": self.id_token, "token_type": "Bearer"},
                    separators=(",", ":"),
                ).encode("ascii")
            ),
        )


class GoogleOidcTests(unittest.TestCase):
    def provider(self, payload):
        transport = Transport(token(payload))
        provider = oidc.GoogleOidc(
            client_id="standin-client.apps.googleusercontent.com",
            client_secret=bytearray(b"not-a-live-client-secret"),
            allowed_email="captain@example.invalid",
            redirect_uri="https://approval.example.invalid/captain/oidc/callback",
            transport=transport,
            clock=lambda: 1000.0,
        )
        return provider, transport

    def claims(self, **changes):
        value = {
            "iss": "https://accounts.google.com",
            "aud": "standin-client.apps.googleusercontent.com",
            "sub": "google-subject-1",
            "exp": 1100,
            "iat": 990,
            "nonce": "N" * 43,
            "email": "captain@example.invalid",
            "email_verified": True,
        }
        value.update(changes)
        return value

    def test_authorization_uses_pkce_nonce_state_and_select_account_without_forced_reauth(self):
        provider, _ = self.provider(self.claims())
        location = provider.authorization_url(
            state="S" * 43,
            nonce="N" * 43,
            challenge="C" * 43,
        )
        parsed = urlsplit(location)
        query = parse_qs(parsed.query, strict_parsing=True)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "accounts.google.com")
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["code_challenge"], ["C" * 43])
        self.assertEqual(query["nonce"], ["N" * 43])
        self.assertEqual(query["state"], ["S" * 43])
        self.assertEqual(query["prompt"], ["select_account"])
        self.assertNotIn("max_age", query)

    def test_direct_token_exchange_checks_all_claims_and_exact_account(self):
        provider, transport = self.provider(self.claims())
        subject = provider.exchange_code(
            "standin-code", "V" * 43, "N" * 43, auth_started=1000.0
        )
        self.assertEqual(subject, oidc.FreshIdentity("google-subject-1", 990.0))
        self.assertEqual(len(transport.calls), 1)
        self.assertIn(b"code_verifier=" + b"V" * 43, transport.calls[0])
        self.assertNotIn(b"N" * 43, transport.calls[0])

        for changed in (
            {"iss": "https://example.invalid"},
            {"aud": "other-client"},
            {"exp": 999},
            {"iat": 1200},
            {"nonce": "wrong"},
            {"email": "other@example.invalid"},
            {"email_verified": False},
        ):
            refused, _ = self.provider(self.claims(**changed))
            with self.assertRaises(approval_security.ApprovalRefused):
                refused.exchange_code(
                    "standin-code", "V" * 43, "N" * 43, auth_started=1000.0
                )
    def test_private_config_carries_fresh_session_key_without_a_preseeded_subject(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            os.chmod(base, 0o700)
            path = base / "oidc.json"
            path.write_text(
                json.dumps(
                    {
                        "format": 1,
                        "clientId": "standin-client.apps.googleusercontent.com",
                        "clientSecret": "not-a-live-client-secret",
                        "allowedEmail": "captain@example.invalid",
                        "redirectUri": "https://approval.example.invalid/captain/oidc/callback",
                        "sessionKeyHex": "4b" * 32,
                    }
                ),
                encoding="utf-8",
            )
            os.chmod(path, 0o600)

            config = oidc.load_config(path)
            self.addCleanup(config.clear)
            self.assertEqual(config.session_key, bytearray(bytes([75]) * 32))
            self.assertFalse(hasattr(config, "allowed_subject"))

            os.chmod(path, 0o640)
            with self.assertRaises(approval_security.ApprovalRefused):
                oidc.load_config(path)


GOOGLE_TOKEN_HEADERS = (
    ("Cache-Control", "no-cache, no-store, max-age=0, must-revalidate"),
    ("Pragma", "no-cache"),
    ("Expires", "Mon, 01 Jan 1990 00:00:00 GMT"),
    ("Date", "Tue, 03 Nov 2026 03:17:00 GMT"),
    ("Content-Type", "application/json; charset=utf-8"),
    ("Vary", "X-Origin"),
    ("Vary", "Referer"),
    ("Server", "scaffolding on HTTPServer2"),
    ("X-XSS-Protection", "0"),
    ("X-Frame-Options", "SAMEORIGIN"),
    ("X-Content-Type-Options", "nosniff"),
    ("Alt-Svc", 'h3=":443"; ma=2592000'),
    ("Accept-Ranges", "none"),
    ("Vary", "Origin,Accept-Encoding"),
)


def raw_response(status, reason, headers, body):
    lines = [f"HTTP/1.1 {status} {reason}"]
    lines += [f"{name}: {value}" for name, value in headers]
    framing = [name.lower() for name, _ in headers]
    if "transfer-encoding" not in framing and "content-length" not in framing:
        lines.append(f"Content-Length: {len(body)}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


class _Socket:
    def __init__(self, data):
        self.data = data

    def makefile(self, mode, *args, **kwargs):
        return io.BytesIO(self.data)


class ParsedConnection:
    made = []

    def __init__(self, host, port, timeout=None, context=None):
        self.args = (host, port, timeout, context)
        ParsedConnection.made.append(self)

    def request(self, method, path, body=None, headers=None):
        self.sent = (method, path, bytes(body), dict(headers))

    def getresponse(self):
        response = http.client.HTTPResponse(_Socket(ParsedConnection.raw))
        response.begin()
        return response

    def close(self):
        pass


def google_token_body(id_token):
    return json.dumps(
        {
            "access_token": "standin-access",
            "expires_in": 3599,
            "scope": "openid https://www.googleapis.com/auth/userinfo.email",
            "token_type": "Bearer",
            "id_token": id_token,
        },
        separators=(",", ":"),
    ).encode("ascii")


class ProductionTransportParserTests(unittest.TestCase):
    def exchange(self, raw):
        ParsedConnection.raw = raw
        ParsedConnection.made = []
        with mock.patch.object(oidc.http.client, "HTTPSConnection", ParsedConnection):
            return oidc.GoogleTokenTransport().exchange(bytearray(b"standin=1"))

    def test_google_header_list_with_three_vary_is_parsed_for_200_and_400(self):
        for status, reason in ((200, "OK"), (400, "Bad Request")):
            with self.subTest(status=status):
                body = b'{"error":"invalid_grant"}' if status == 400 else google_token_body("a.b.c")
                got_status, headers, content = self.exchange(
                    raw_response(status, reason, GOOGLE_TOKEN_HEADERS, body)
                )
                self.assertEqual(got_status, status)
                self.assertEqual(bytes(content), body)
                self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
                self.assertIn("no-store", headers["cache-control"])
                connection = ParsedConnection.made[0]
                self.assertEqual(connection.args[:3], ("oauth2.googleapis.com", 443, 15))
                self.assertIsInstance(connection.args[3], ssl.SSLContext)

    def test_repeated_framing_security_or_unlisted_headers_are_refused(self):
        for name, first, second in (
            ("Content-Type", "application/json; charset=utf-8", "text/html"),
            ("Content-Length", "26", "27"),
            ("Transfer-Encoding", "identity", "chunked"),
            ("Content-Encoding", "identity", "gzip"),
            ("Cache-Control", "no-store", "public"),
            ("Pragma", "no-cache", "no-cache"),
            ("Location", "https://example.invalid/a", "https://example.invalid/b"),
            ("Set-Cookie", "a=1", "b=2"),
            ("WWW-Authenticate", "Basic", "Bearer"),
            ("X-Frame-Options", "SAMEORIGIN", "DENY"),
        ):
            with self.subTest(header=name):
                headers = tuple(
                    item for item in GOOGLE_TOKEN_HEADERS if item[0].lower() != name.lower()
                ) + ((name, first), (name, second))
                with self.assertRaises(approval_security.ApprovalRefused) as caught:
                    self.exchange(raw_response(200, "OK", headers, google_token_body("a.b.c")))
                self.assertEqual(str(caught.exception), "Google sign-in response is invalid")

    def test_outer_exchange_still_refuses_google_shaped_non_200(self):
        provider = oidc.GoogleOidc(
            client_id="standin-client.apps.googleusercontent.com",
            client_secret=bytearray(b"not-a-live-client-secret"),
            allowed_email="captain@example.invalid",
            redirect_uri="https://approval.example.invalid/captain/oidc/callback",
            clock=lambda: 1000.0,
        )
        ParsedConnection.raw = raw_response(
            400, "Bad Request", GOOGLE_TOKEN_HEADERS, b'{"error":"invalid_grant"}'
        )
        with mock.patch.object(oidc.http.client, "HTTPSConnection", ParsedConnection):
            with self.assertRaises(approval_security.ApprovalRefused):
                provider.exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)

    def test_google_shaped_success_reaches_claims_and_returns_the_subject(self):
        claims = {
            "iss": "https://accounts.google.com",
            "azp": "standin-client.apps.googleusercontent.com",
            "aud": "standin-client.apps.googleusercontent.com",
            "sub": "110169484474386276334",
            "email": "captain@example.invalid",
            "email_verified": True,
            "at_hash": "standin-at-hash",
            "nonce": "N" * 43,
            "iat": 990,
            "exp": 4590,
        }
        header = encoded(json.dumps({"alg": "RS256", "kid": "standin-kid", "typ": "JWT"}).encode("ascii"))
        id_token = header + "." + encoded(json.dumps(claims).encode("ascii")) + ".standin-signature"
        provider = oidc.GoogleOidc(
            client_id="standin-client.apps.googleusercontent.com",
            client_secret=bytearray(b"not-a-live-client-secret"),
            allowed_email="captain@example.invalid",
            redirect_uri="https://approval.example.invalid/captain/oidc/callback",
            clock=lambda: 1000.0,
        )
        ParsedConnection.raw = raw_response(200, "OK", GOOGLE_TOKEN_HEADERS, google_token_body(id_token))
        with mock.patch.object(oidc.http.client, "HTTPSConnection", ParsedConnection):
            subject = provider.exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)
        self.assertEqual(subject, oidc.FreshIdentity("110169484474386276334", 990.0))


class GoogleIssuerFormTests(unittest.TestCase):
    def provider(self, payload):
        provider = oidc.GoogleOidc(
            client_id="standin-client.apps.googleusercontent.com",
            client_secret=bytearray(b"not-a-live-client-secret"),
            allowed_email="captain@example.invalid",
            redirect_uri="https://approval.example.invalid/captain/oidc/callback",
            transport=Transport(token(payload)),
            clock=lambda: 1000.0,
        )
        return provider

    def claims(self, **changes):
        value = GoogleOidcTests.claims(None, **changes)
        return value

    def test_both_documented_google_issuer_forms_pass_for_the_same_account(self):
        for issuer in ("https://accounts.google.com", "accounts.google.com"):
            with self.subTest(issuer=issuer):
                subject = self.provider(self.claims(iss=issuer)).exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)
                self.assertEqual(subject, oidc.FreshIdentity("google-subject-1", 990.0))

    def test_other_issuers_and_wrong_accounts_stay_refused_under_both_forms(self):
        for issuer in (
            "https://accounts.google.com.evil.invalid",
            "accounts.google.com.",
            "http://accounts.google.com",
            "https://ACCOUNTS.google.com",
            "",
            ["https://accounts.google.com"],
            None,
        ):
            with self.subTest(issuer=issuer):
                with self.assertRaises(approval_security.ApprovalRefused):
                    self.provider(self.claims(iss=issuer)).exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)
        for issuer in ("https://accounts.google.com", "accounts.google.com"):
            for change in (
                {"email": "other@example.invalid"},
                {"email": "Captain@example.invalid"},
                {"email_verified": False},
                {"aud": "other-client.apps.googleusercontent.com"},
                {"azp": "other-client.apps.googleusercontent.com"},
                {"nonce": "M" * 43},
                {"exp": 999},
                {"iat": 389},
            ):
                with self.subTest(issuer=issuer, change=sorted(change)):
                    with self.assertRaises(approval_security.ApprovalRefused):
                        self.provider(self.claims(iss=issuer, **change)).exchange_code("standin-code", "V" * 43, "N" * 43, auth_started=1000.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
