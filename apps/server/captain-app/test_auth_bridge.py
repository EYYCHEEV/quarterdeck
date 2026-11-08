import unittest

import approval_app
import auth_bridge


class AuthBridgeTests(unittest.TestCase):
    def test_socket_gate_forwards_only_request_facts_and_returns_fresh_csrf(self):
        calls = []

        def transport(payload):
            calls.append(payload)
            return {"ok": True, "csrf": f"csrf-{len(calls)}", "freshUntil": 1900.0, "freshRequired": False}

        gate = auth_bridge.SocketApprovalGate(transport)
        request = approval_app.Request(
            "POST",
            "/captain/cards/card-1/answer",
            {
                "Cookie": "__Host-qd-approval=fixed-session-placeholder",
                "Origin": "https://quarterdeck.invalid",
                "X-Forwarded-For": "192.0.2.10",
                "X-Forwarded-Host": "quarterdeck.invalid",
                "X-Forwarded-Proto": "https",
                "Ignored": "not-forwarded",
            },
            bytearray(),
            "proxy",
        )

        read = gate.authenticate(request)
        post = gate.authorize_post(request, "one-use-csrf")

        self.assertEqual(gate.issue_csrf(read), "csrf-1")
        self.assertEqual(gate.issue_csrf(post), "csrf-2")
        self.assertEqual(gate.fresh_until(read), 1900.0)
        self.assertEqual([call["operation"] for call in calls], ["authenticate", "authorize-post"])
        self.assertNotIn("Ignored", calls[0]["request"]["headers"])
        self.assertEqual(calls[1]["csrf"], "one-use-csrf")


if __name__ == "__main__":
    unittest.main(verbosity=2)
