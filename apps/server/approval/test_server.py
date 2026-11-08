from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import approval_security
import server


class FakeOidcConfig:
    def __init__(self):
        self.client_id = "standin-client.apps.googleusercontent.com"
        self.client_secret = bytearray(b"not-a-live-client-secret")
        self.allowed_email = "captain@example.invalid"
        self.redirect_uri = (
            "https://approval.example.invalid/captain/oidc/callback"
        )
        self.session_key = bytearray(bytes([75]) * 32)

    def clear(self):
        approval_security.clear(self.client_secret)
        approval_security.clear(self.session_key)


class ApprovalServerTests(unittest.TestCase):
    @staticmethod
    def runtime_document(release):
        return {
            "format": 1,
            "bind": {"address": "service.internal", "port": 19091},
            "paths": {
                "oidc": "/var/lib/quarterdeck-approval/oidc.json",
                "state": "/var/lib/quarterdeck-approval/state.sqlite",
                "socket": "/run/quarterdeck-approval/approve.sock",
                "captainAuthSocket": "/run/quarterdeck-captain-auth/auth.sock",
            },
            "captainAuth": {
                "peerUid": 2700,
                "socketMode": "0660",
                "socketGid": 2701,
            },
            "trustedProxy": "proxy.internal",
            "publicOrigin": "https://approval.example.invalid",
            "release": release,
        }

    def test_runtime_release_is_exactly_pinned_or_unpublished(self):
        pinned = {
            "artifactUrl": (
                "https://releases.example.invalid/"
                "quarterdeck_mcp-1.2.3-py3-none-any.whl"
            ),
            "version": "1.2.3",
            "sha256": "ab" * 32,
        }
        unpublished = {
            "artifactUrl": None,
            "version": None,
            "sha256": None,
        }
        invalid = [
            {
                "artifactUrl": pinned["artifactUrl"],
                "version": None,
                "sha256": None,
            },
            {**pinned, "artifactUrl": "${QD_MCP_ARTIFACT_URL}"},
            {"artifactUrl": pinned["artifactUrl"], "version": pinned["version"]},
            {**pinned, "extra": "not-allowed"},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.json"
            for release in (pinned, unpublished):
                with self.subTest(release=release):
                    path.write_text(
                        json.dumps(self.runtime_document(release)),
                        encoding="utf-8",
                    )
                    runtime = server.load_runtime_config(path)
                    self.assertEqual(
                        (
                            runtime.release_artifact_url,
                            runtime.release_version,
                            runtime.release_sha256,
                        ),
                        (
                            release["artifactUrl"],
                            release["version"],
                            release["sha256"],
                        ),
                    )
            for release in invalid:
                with self.subTest(invalid=release):
                    path.write_text(
                        json.dumps(self.runtime_document(release)),
                        encoding="utf-8",
                    )
                    with self.assertRaises(
                        approval_security.ApprovalRefused
                    ):
                        server.load_runtime_config(path)

    def test_socket_backend_delegates_only_reviewed_captain_actions(self):
        with (
            mock.patch.object(
                server.approval_service,
                "request_pending",
                return_value=[
                    {
                        "botName": "bot-a",
                        "code": "ABCDEFGH",
                        "requestedAt": 1000.0,
                        "invitedBy": "Captain",
                    }
                ],
            ) as pending,
            mock.patch.object(
                server.approval_service,
                "request_invites",
                return_value=[],
            ) as invites,
            mock.patch.object(
                server.approval_service,
                "request_invite_creation",
                return_value={
                    "inviteId": "AAAAAAAAAAAA",
                    "code": "abcdefghijklmnopqrstuv",
                    "botName": "bot-b",
                    "invitedBy": "Captain",
                    "createdAt": 1000.0,
                    "expiresAt": 87400.0,
                },
            ) as create_invite,
            mock.patch.object(
                server.approval_service,
                "request_invite_cancellation",
                return_value=True,
            ) as cancel_invite,
            mock.patch.object(
                server.approval_service, "request_approval", return_value=True
            ) as approve,
            mock.patch.object(
                server.approval_service, "request_refusal", return_value=True
            ) as refuse,
        ):
            backend = server.ApprovalSocketBackend("approve.sock")
            self.assertEqual(
                backend.pending(),
                [
                    {
                        "botName": "bot-a",
                        "code": "ABCDEFGH",
                        "requestedAt": 1000.0,
                        "invitedBy": "Captain",
                    }
                ],
            )
            self.assertEqual(backend.invites(), [])
            created = backend.create_invite("bot-b")
            self.assertEqual(created["code"], "abcdefghijklmnopqrstuv")
            self.assertTrue(backend.cancel_invite("AAAAAAAAAAAA"))
            self.assertTrue(backend.approve("ABCDEFGH"))
            self.assertTrue(backend.refuse("ABCDEFGH"))

        pending.assert_called_once_with("approve.sock")
        invites.assert_called_once_with("approve.sock")
        create_invite.assert_called_once_with("approve.sock", "bot-b")
        cancel_invite.assert_called_once_with(
            "approve.sock", "AAAAAAAAAAAA"
        )
        approve.assert_called_once_with("approve.sock", "ABCDEFGH")
        refuse.assert_called_once_with("approve.sock", "ABCDEFGH")

    def test_socket_backend_refuses_unavailable_or_negative_service(self):
        backend = server.ApprovalSocketBackend("approve.sock")
        with (
            mock.patch.object(
                server.approval_service, "request_pending", return_value=None
            ),
            self.assertRaises(approval_security.ApprovalRefused),
        ):
            backend.pending()
        with (
            mock.patch.object(
                server.approval_service, "request_approval", return_value=False
            ),
            self.assertRaises(approval_security.ApprovalRefused),
        ):
            backend.approve("ABCDEFGH")

    def test_production_entrypoint_wires_google_and_reviewed_socket_before_serving(self):
        oidc_config = FakeOidcConfig()
        runtime = server.RuntimeConfig(
            bind_address="service.internal",
            bind_port=19091,
            oidc_path="oidc.json",
            state_path="state.sqlite",
            socket_path="approve.sock",
            captain_auth_socket_path="captain-auth.sock",
            captain_auth_peer_uid=2700,
            captain_auth_socket_mode=0o660,
            captain_auth_socket_gid=2701,
            trusted_proxy="proxy.internal",
            public_origin="https://approval.example.invalid",
            release_artifact_url="https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
            release_version="1.2.3",
            release_sha256="ab" * 32,
        )
        with (
            mock.patch.object(
                server.sys, "argv", ["server.py", "--config", "runtime.json"]
            ),
            mock.patch.object(
                server, "load_runtime_config", return_value=runtime
            ),
            mock.patch.object(
                server.oidc, "load_config", return_value=oidc_config
            ),
            mock.patch.object(
                server.approval_security,
                "ApprovalState",
                return_value=object(),
            ) as state,
            mock.patch.object(
                server.captain_auth,
                "install",
            ) as install,
            mock.patch.object(server, "serve") as serve,
        ):
            self.assertEqual(server.main(), 0)

        state.assert_called_once_with("state.sqlite", bytes([75]) * 32)
        application, auth_service, address, port = serve.call_args.args
        self.assertIsInstance(
            application.backend, server.ApprovalSocketBackend
        )
        self.assertEqual(application.backend.socket_path, "approve.sock")
        self.assertIs(application.sign_in, server.captain_auth)
        self.assertIsInstance(
            auth_service,
            server.captain_auth_socket.CaptainAuthSocketService,
        )
        self.assertEqual(auth_service.socket_path, server.Path("captain-auth.sock"))
        self.assertEqual(auth_service.expected_uid, 2700)
        self.assertEqual(auth_service.socket_mode, 0o660)
        self.assertEqual(auth_service.socket_gid, 2701)
        install.assert_called_once()
        self.assertIs(install.call_args.args[0], state.return_value)
        self.assertIsInstance(
            install.call_args.args[1], server.oidc.GoogleOidc
        )
        self.assertEqual((address, port), ("service.internal", 19091))
        self.assertEqual(oidc_config.client_secret, bytearray())
        self.assertEqual(oidc_config.session_key, bytearray())

    def test_production_entrypoint_refuses_before_binding_on_invalid_runtime(self):
        with (
            mock.patch.object(
                server.sys, "argv", ["server.py", "--config", "runtime.json"]
            ),
            mock.patch.object(
                server,
                "load_runtime_config",
                side_effect=approval_security.ApprovalRefused("refused"),
            ),
            mock.patch.object(server, "serve") as serve,
        ):
            self.assertEqual(server.main(), 2)
        serve.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
