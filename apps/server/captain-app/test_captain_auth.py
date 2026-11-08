import tempfile
import unittest
from pathlib import Path

import approval_app
import approval_security
import captain_auth
import oidc


class FakeOidc:
    def __init__(self):
        self.starts = []
        self.exchanges = []

    def authorization_url(self, *, state, nonce, challenge):
        self.starts.append(
            {
                "state": state,
                "nonce": nonce,
                "challenge": challenge,
            }
        )
        return f"https://provider.invalid/authorize?state={state}"

    def exchange_code(self, code, verifier, nonce, *, auth_started):
        self.exchanges.append((code, verifier, nonce))
        if code != "fixed-code":
            raise approval_security.ApprovalRefused(
                "stand-in code refused"
            )
        return oidc.FreshIdentity("account-user-subject", auth_started)


class CaptainAuthContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(
            dir=Path(__file__).resolve().parent
        )
        root = Path(cls.temporary.name)
        root.chmod(0o700)
        cls.now = [1_000.0]
        entropy = [0]

        def token_bytes(size):
            entropy[0] += 1
            return bytes([entropy[0]]) * size

        cls.state = approval_security.ApprovalState(
            root / "captain-auth.sqlite",
            b"a" * 32,
            clock=lambda: cls.now[0],
            token_bytes=token_bytes,
        )
        cls.oidc = FakeOidc()
        captain_auth.install(cls.state, cls.oidc)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @staticmethod
    def request(token):
        return approval_app.Request(
            "GET",
            "/captain/cards",
            {"Cookie": f"__Host-qd-approval={token}"},
            bytearray(),
            "private-proxy",
        )

    def test_require_captain_uses_the_pinned_identity_idle_and_total_limits(self):
        self.now[0] = 1000.0
        token = self.state.start_identity_session("account-user-subject")
        self.assertIsNotNone(token)
        self.assertIsNone(
            self.state.start_identity_session("a-different-google-subject")
        )

        session = captain_auth.require_captain(self.request(token))
        self.assertIsInstance(session, captain_auth.CaptainSession)

        for day in (6, 12, 18, 24, 29):
            self.now[0] = 1000.0 + day * 86400
            owner = self.state.authorize_session(token)
            self.assertIsNotNone(owner)
            self.assertTrue(self.state.touch_session(owner))
        self.now[0] = 1000.0 + 30 * 86400
        self.assertIsNone(captain_auth.require_captain(self.request(token)))

        self.now[0] = 1000.0
        idle_token = self.state.start_identity_session("account-user-subject")
        self.now[0] += 7 * 86400
        self.assertIsNone(
            captain_auth.require_captain(self.request(idle_token))
        )

    def test_login_redirect_accepts_only_allowlisted_printable_paths(self):
        response = captain_auth.login_redirect(
            "/oauth/authorize?client_id=grok"
        )

        self.assertEqual(response.status, 303)
        self.assertTrue(
            dict(response.headers)["Location"].startswith(
                "https://provider.invalid/authorize?state="
            )
        )
        self.assertIn("__Host-qd-login=", dict(response.headers)["Set-Cookie"])
        self.assertEqual(dict(response.headers)["Cache-Control"], "no-store")
        for path in (
            "https://outside.invalid/",
            "//outside.invalid/",
            "relative/path",
            "/captain/cards#fragment",
            "/\\evil.example",
            "/captain/%2Fevil.example",
            "/captain/%5cevil.example",
            "/captain/cards\u007f",
            "/captain/cards\u00e9",
            "/not-allowlisted",
        ):
            with self.subTest(path=path):
                with self.assertRaises(approval_security.ApprovalRefused):
                    captain_auth.login_redirect(path)

    def test_chat_page_is_accepted_as_the_return_path_and_the_callback_lands_on_it(self):
        started = captain_auth.login_redirect("/captain/chat")
        self.assertEqual(started.status, 303)
        state = self.oidc.starts[-1]["state"]
        self.assertEqual(captain_auth._authority._returns[state].next_path, "/captain/chat")
        browser = (
            dict(started.headers)["Set-Cookie"]
            .split(";", 1)[0]
            .split("=", 1)[1]
        )
        completed = captain_auth.oidc_callback(
            approval_app.Request(
                "GET",
                f"/captain/oidc/callback?code=fixed-code&state={state}",
                {"Cookie": f"__Host-qd-login={browser}"},
                bytearray(),
                "private-proxy",
            )
        )
        self.assertEqual(completed.status, 303)
        self.assertEqual(dict(completed.headers)["Location"], "/captain/chat")

    def test_paths_outside_captain_are_still_refused_as_return_paths(self):
        for path in (
            "/chat",
            "/captain",
            "/captainx/chat",
            "/oauth/authorize/chat",
            "https://outside.invalid/captain/chat",
            "//outside.invalid/captain/chat",
        ):
            with self.subTest(path=path):
                with self.assertRaises(approval_security.ApprovalRefused):
                    captain_auth.login_redirect(path)

    def test_logout_revokes_session_and_clears_the_phone_copy(self):
        self.now[0] = 6_000.0
        token = self.state.start_identity_session("account-user-subject")
        session = captain_auth.require_captain(self.request(token))
        csrf = captain_auth.csrf_token(session)

        response = captain_auth.logout_response(session, {"csrf": csrf})

        self.assertEqual(response.status, 303)
        headers = dict(response.headers)
        self.assertEqual(headers["Location"], "/captain/signed-out")
        self.assertEqual(headers["Clear-Site-Data"], '"storage"')
        cookies = [value for name, value in response.headers if name == "Set-Cookie"]
        for name in ("__Host-qd-approval", "__Host-qd-device"):
            self.assertIn(f"{name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0", cookies)
        self.assertIsNone(captain_auth.require_captain(self.request(token)))
        with self.assertRaises(approval_security.ApprovalRefused):
            captain_auth.logout_response(session, {"csrf": csrf})

    def test_oidc_callback_returns_to_bound_connector_request_once(self):
        next_path = (
            "/oauth/authorize?client_id=grok&state=connector-state"
        )
        started = captain_auth.login_redirect(next_path)
        state = self.oidc.starts[-1]["state"]
        browser = (
            dict(started.headers)["Set-Cookie"]
            .split(";", 1)[0]
            .split("=", 1)[1]
        )
        request = approval_app.Request(
            "GET",
            f"/captain/oidc/callback?code=fixed-code&state={state}",
            {"Cookie": f"__Host-qd-login={browser}"},
            bytearray(),
            "private-proxy",
        )

        completed = captain_auth.oidc_callback(request)

        self.assertEqual(completed.status, 303)
        self.assertEqual(dict(completed.headers)["Location"], next_path)
        cookies = [
            value
            for name, value in completed.headers
            if name == "Set-Cookie"
        ]
        self.assertEqual(len(cookies), 3)
        self.assertIn("SameSite=Lax", cookies[1])
        self.assertNotIn("Domain=", cookies[1])
        with self.assertRaises(approval_security.ApprovalRefused):
            captain_auth.oidc_callback(request)

    def _google_return(self, extra):
        started = captain_auth.login_redirect("/captain/pending")
        state = self.oidc.starts[-1]["state"]
        browser = (
            dict(started.headers)["Set-Cookie"]
            .split(";", 1)[0]
            .split("=", 1)[1]
        )
        request = approval_app.Request(
            "GET",
            f"/captain/oidc/callback?code=fixed-code&state={state}{extra}",
            {"Cookie": f"__Host-qd-login={browser}"},
            bytearray(),
            "private-proxy",
        )
        return request, state, browser

    GOOGLE_EXTRA = (
        "&scope=email+openid+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email"
        "&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com"
    )

    def test_oidc_callback_accepts_google_response_shape(self):
        for extra in (self.GOOGLE_EXTRA, self.GOOGLE_EXTRA + "&hd=example.invalid"):
            with self.subTest(extra=extra):
                request, _, _ = self._google_return(extra)
                before = len(self.oidc.exchanges)
                completed = captain_auth.oidc_callback(request)
                self.assertEqual(completed.status, 303)
                self.assertEqual(dict(completed.headers)["Location"], "/captain/pending")
                self.assertEqual(len(self.oidc.exchanges), before + 1)
                self.assertEqual(self.oidc.exchanges[-1][0], "fixed-code")

    def test_oidc_callback_refuses_bad_google_shapes_before_exchange(self):
        for extra in (
            "&iss=https%3A%2F%2Fevil.invalid",
            "&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com",
            "&code=second-code",
            "&scope=openid&scope=email",
            "&foo=1",
            "&error=access_denied",
            self.GOOGLE_EXTRA + "&next=%2Fcaptain%2Fcards",
        ):
            with self.subTest(extra=extra):
                request, state, browser = self._google_return(extra)
                before = len(self.oidc.exchanges)
                with self.assertRaises(approval_security.ApprovalRefused):
                    captain_auth.oidc_callback(request)
                self.assertEqual(len(self.oidc.exchanges), before)
                retry = approval_app.Request(
                    "GET",
                    f"/captain/oidc/callback?code=fixed-code&state={state}",
                    {"Cookie": f"__Host-qd-login={browser}"},
                    bytearray(),
                    "private-proxy",
                )
                with self.assertRaises(approval_security.ApprovalRefused):
                    captain_auth.oidc_callback(retry)
                self.assertEqual(len(self.oidc.exchanges), before)

    def test_oidc_callback_refuses_blank_and_malformed_fields_and_burns_state(self):
        for extra in (
            "&next=",
            "&iss=",
            "&code=",
            "&malformed",
        ):
            with self.subTest(extra=extra):
                request, state, browser = self._google_return(extra)
                before = len(self.oidc.exchanges)
                with self.assertRaises(approval_security.ApprovalRefused):
                    captain_auth.oidc_callback(request)
                self.assertEqual(len(self.oidc.exchanges), before)
                retry = approval_app.Request(
                    "GET",
                    f"/captain/oidc/callback?code=fixed-code&state={state}",
                    {"Cookie": f"__Host-qd-login={browser}"},
                    bytearray(),
                    "private-proxy",
                )
                with self.assertRaises(approval_security.ApprovalRefused):
                    captain_auth.oidc_callback(retry)
                self.assertEqual(len(self.oidc.exchanges), before)

    def test_tampered_callback_next_is_refused_and_burns_state(self):
        started = captain_auth.login_redirect(
            "/oauth/authorize?client_id=grok"
        )
        state = self.oidc.starts[-1]["state"]
        browser = (
            dict(started.headers)["Set-Cookie"]
            .split(";", 1)[0]
            .split("=", 1)[1]
        )
        tampered = approval_app.Request(
            "GET",
            (
                f"/captain/oidc/callback?code=fixed-code&state={state}"
                "&next=%2Fcaptain%2Fcards"
            ),
            {"Cookie": f"__Host-qd-login={browser}"},
            bytearray(),
            "private-proxy",
        )
        with self.assertRaises(approval_security.ApprovalRefused):
            captain_auth.oidc_callback(tampered)

        correct = approval_app.Request(
            "GET",
            f"/captain/oidc/callback?code=fixed-code&state={state}",
            {"Cookie": f"__Host-qd-login={browser}"},
            bytearray(),
            "private-proxy",
        )
        with self.assertRaises(approval_security.ApprovalRefused):
            captain_auth.oidc_callback(correct)

    def test_session_cookie_is_host_only_lax_and_csrf_is_one_use(self):
        self.now[0] = 6_000.0
        token = self.state.start_identity_session("account-user-subject")
        session = captain_auth.require_captain(self.request(token))
        self.assertIsNotNone(session)

        cookie = captain_auth.session_cookie(token)
        self.assertEqual(
            cookie,
            f"__Host-qd-approval={token}; Path=/; Secure; HttpOnly; "
            "SameSite=Lax; Max-Age=2592000",
        )
        self.assertNotIn("Domain=", cookie)

        csrf = captain_auth.csrf_token(session)
        form = {"csrf": csrf, "decision": "allow"}
        self.assertTrue(captain_auth.check_csrf(session, form))
        self.assertFalse(captain_auth.check_csrf(session, form))
        self.assertFalse(captain_auth.check_csrf(session, {"decision": "allow"}))

        self.now[0] = 7_000.0
        expiring_token = self.state.start_identity_session(
            "account-user-subject"
        )
        expiring = None
        for moment in (
            7_000.0,
            7_800.0,
            8_600.0,
            9_400.0,
            10_200.0,
            10_500.0,
        ):
            self.now[0] = moment
            expiring = captain_auth.require_captain(
                self.request(expiring_token)
            )
            self.assertIsNotNone(expiring)
        expired_csrf = captain_auth.csrf_token(expiring)
        self.now[0] = 7000.0 + 7 * 86400
        self.assertFalse(
            captain_auth.check_csrf(
                expiring,
                {"csrf": expired_csrf, "decision": "allow"},
            )
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
