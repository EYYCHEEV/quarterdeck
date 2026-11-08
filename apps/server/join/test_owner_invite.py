from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from unittest import mock

import approval_service
import invite_prompt
from test_list_bots import JoinFixture


class OwnerInviteProtocolTests(JoinFixture):
    def test_server_owner_invite_passes_both_approval_checks(self):
        with self.subTest(check="approval_service"):
            thread = self.serve_once(os.getuid())
            try:
                created = approval_service.request_invite_creation(
                    self.socket_path, "service-bot"
                )
            finally:
                thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertIsNotNone(created)
            self.assertEqual(created["invitedBy"], "Captain")

        approval_directory = Path(__file__).resolve().parents[1] / "approval"
        with mock.patch.object(sys, "path", [str(approval_directory), *sys.path]):
            import approval_app
            import approval_security

        def create_invite(bot_name):
            payload = json.dumps(
                {"action": "createInvite", "botName": bot_name}
            ).encode("ascii") + b"\n"
            response = json.loads(self.exchange(payload))
            self.assertTrue(response["ok"])
            return response["invite"]

        sign_in = mock.Mock(spec=approval_app.CaptainSignIn)
        sign_in.require_captain.return_value = object()
        sign_in.check_csrf.return_value = True
        sign_in.fresh_until.return_value = self.clock.value + 900
        backend = mock.Mock(spec=approval_app.ApprovalBackend)
        backend.create_invite.side_effect = create_invite
        state = approval_security.ApprovalState(
            self.base / "approval.sqlite", b"S" * 32, clock=self.clock
        )
        app = approval_app.ApprovalApplication(
            state,
            sign_in,
            backend,
            invite_prompt.ReleaseConfig(
                None, None, None, "https://approval.example.invalid"
            ),
            trusted_proxy="proxy.internal",
            public_origin="https://approval.example.invalid",
        )
        request = approval_app.Request(
            "POST",
            approval_app.INVITE_CREATE_PATH,
            {
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://approval.example.invalid",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "approval.example.invalid",
                "X-Forwarded-For": "192.0.2.1",
            },
            bytearray(b"botName=app-bot&csrf=stand-in"),
            "proxy.internal",
        )
        with self.subTest(check="approval_app"):
            response = app.handle(request)
            backend.create_invite.assert_called_once_with("app-bot")
            self.assertEqual(response.status, 200)
