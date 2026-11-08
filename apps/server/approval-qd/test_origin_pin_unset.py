from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import test_runtime_qd as fixtures

approval_security = fixtures.approval_security
server = fixtures.server

ORIGIN = "https://qd.example.invalid"


def runtime_document(root, origin=ORIGIN):
    value = fixtures.ApprovalServerTests.runtime_document({"artifactUrl": None, "version": None, "sha256": None})
    value["publicOrigin"] = origin
    value["oidcRedirectUri"] = origin + "/captain/oidc/callback"
    value["paths"]["state"] = str(root / "state.sqlite")
    value["paths"]["socket"] = str(root / "missing-join.sock")
    value["paths"]["captainAuthSocket"] = str(root / "auth.sock")
    return value


class OriginPinUnsetTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop(server.ORIGIN_PIN_ENVIRONMENT, None)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "runtime.json"
        self.config.write_text(json.dumps(runtime_document(self.root)), encoding="utf-8")

    def test_the_setting_name_is_the_documented_one(self):
        self.assertEqual(server.ORIGIN_PIN_ENVIRONMENT, "QD_ORIGIN_PIN")

    def test_an_override_without_the_pin_is_refused(self):
        with self.assertRaises(approval_security.ApprovalRefused):
            server.load_runtime_config(self.config)

    def test_an_empty_pin_is_refused(self):
        os.environ[server.ORIGIN_PIN_ENVIRONMENT] = ""
        with self.assertRaises(approval_security.ApprovalRefused):
            server.load_runtime_config(self.config)

    def test_a_pin_for_another_origin_is_refused(self):
        os.environ[server.ORIGIN_PIN_ENVIRONMENT] = "https://other.example.invalid"
        with self.assertRaises(approval_security.ApprovalRefused):
            server.load_runtime_config(self.config)

    def test_the_matching_pin_is_accepted(self):
        os.environ[server.ORIGIN_PIN_ENVIRONMENT] = ORIGIN
        server.load_runtime_config(self.config)

    def test_the_server_does_not_start_without_the_pin(self):
        served = mock.Mock()
        with mock.patch.object(server.sys, "argv", ["server.py", "--config", str(self.config)]), mock.patch.object(
            server.oidc, "load_config", return_value=fixtures.FakeOidcConfig()
        ), mock.patch.object(server.captain_auth, "_authority", None), mock.patch.object(server, "serve", served):
            status = server.main()
        self.assertEqual(status, 2)
        served.assert_not_called()


if __name__ == "__main__":
    unittest.main()
