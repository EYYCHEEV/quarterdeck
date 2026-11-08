from __future__ import annotations

from http.cookies import SimpleCookie
import os
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from unittest import mock

import approval_app
import approval_security
import auth_bridge
import captain_auth_socket
import invite_prompt
import oidc
from test_signin_support import production_sign_in


class FakeOidc:
    def authorization_url(self, *, state, nonce, challenge):
        return "https://identity.example.invalid/auth?" + urlencode(
            {"state": state, "nonce": nonce, "code_challenge": challenge}
        )

    def exchange_code(self, code, verifier, nonce, *, auth_started):
        if code != "accepted-code":
            raise approval_security.ApprovalRefused("stand-in refusal")
        return oidc.FreshIdentity("captain-subject", auth_started)


class Backend:
    def pending(self):
        return []

    def invites(self):
        return []

    def create_invite(self, bot_name):
        raise AssertionError("not expected")

    def cancel_invite(self, invite_id):
        raise AssertionError("not expected")

    def approve(self, code):
        raise AssertionError("not expected")

    def refuse(self, code):
        raise AssertionError("not expected")


class CaptainAuthSocketTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.base.chmod(0o700)
        self.state = approval_security.ApprovalState(
            self.base / "state.sqlite",
            b"s" * 32,
        )
        self.sign_in = production_sign_in(self.state, FakeOidc())
        self.app = approval_app.ApprovalApplication(
            self.state,
            self.sign_in,
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
        self.socket_dir = self.base / "captain-auth"
        self.socket_dir.mkdir()
        self.socket_dir.chmod(0o2770)
        self.socket_path = self.socket_dir / "auth.sock"

    @staticmethod
    def _cookie(response, name):
        values = SimpleCookie()
        for header, value in response.headers:
            if header.lower() == "set-cookie":
                values.load(value)
        return values[name].value

    def _request(self, method, path, *, cookie=None, origin=None):
        headers = {
            "X-Forwarded-For": "198.51.100.20",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "approval.example.invalid",
        }
        if cookie:
            headers["Cookie"] = cookie
        if origin:
            headers["Origin"] = origin
        return approval_app.Request(
            method,
            path,
            headers,
            bytearray(),
            "proxy.internal",
        )

    def _login(self):
        started = self.app.handle(self._request("GET", "/captain/login"))
        browser = self._cookie(started, "__Host-qd-login")
        state = parse_qs(
            urlsplit(dict(started.headers)["Location"]).query,
            strict_parsing=True,
        )["state"][0]
        completed = self.app.handle(
            self._request(
                "GET",
                f"/captain/oidc/callback?code=accepted-code&state={state}",
                cookie=f"__Host-qd-login={browser}; __Host-qd-device={self._cookie(started, '__Host-qd-device')}",
            )
        )
        return self._cookie(completed, "__Host-qd-approval")

    def _service(self):
        return captain_auth_socket.CaptainAuthSocketService(
            self.sign_in,
            self.app,
            self.socket_path,
            expected_uid=os.getuid(),
            socket_mode=0o660,
            socket_gid=os.getgid(),
        )

    def _run_once(self, service):
        ready = threading.Event()
        thread = threading.Thread(
            target=service.serve_once,
            kwargs={"ready": ready},
        )
        thread.start()
        self.assertTrue(ready.wait(5))
        self.addCleanup(lambda: thread.join(5))
        return thread

    def test_shared_cookie_authenticates_chat_and_post_csrf_is_one_use(self):
        token = self._login()
        service = self._service()
        thread = self._run_once(service)
        gate = auth_bridge.SocketApprovalGate(
            auth_bridge.ApprovalAuthClient(str(self.socket_path))
        )
        cookie = f"__Host-qd-approval={token}"
        read = gate.authenticate(
            self._request("GET", "/captain/api/chats", cookie=cookie)
        )
        thread.join(5)
        self.assertFalse(thread.is_alive())

        thread = self._run_once(service)
        posted = gate.authorize_post(
            self._request(
                "POST",
                "/captain/api/chat",
                cookie=cookie,
                origin="https://approval.example.invalid",
            ),
            read.csrf,
        )
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertNotEqual(posted.csrf, read.csrf)

        thread = self._run_once(service)
        with self.assertRaises(approval_security.ApprovalRefused):
            gate.authorize_post(
                self._request(
                    "POST",
                    "/captain/api/chat",
                    cookie=cookie,
                    origin="https://approval.example.invalid",
                ),
                read.csrf,
            )
        thread.join(5)
        self.assertFalse(thread.is_alive())

    def test_wrong_peer_identity_and_unsafe_socket_directory_fail_closed(self):
        token = self._login()
        service = self._service()
        with mock.patch.object(
            captain_auth_socket,
            "_peer_uid",
            return_value=os.getuid() + 1,
        ):
            thread = self._run_once(service)
            client = auth_bridge.ApprovalAuthClient(str(self.socket_path))
            with self.assertRaises(approval_security.ApprovalRefused):
                client(
                    {
                        "operation": "authenticate",
                        "session": token,
                        "request": {
                            "method": "GET",
                            "path": "/captain/api/chats",
                            "headers": {
                                "x-forwarded-for": "198.51.100.20",
                                "x-forwarded-proto": "https",
                                "x-forwarded-host": "approval.example.invalid",
                            },
                            "peer": "proxy.internal",
                        },
                    }
                )
            thread.join(5)
            self.assertFalse(thread.is_alive())

        self.socket_dir.chmod(0o770)
        with self.assertRaises(approval_security.ApprovalRefused):
            service.listener()


if __name__ == "__main__":
    unittest.main(verbosity=2)
