import types
import unittest

import approval_app
import approval_security
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


class LongPostAdmissionTests(unittest.TestCase):
    HOST = "quarterdeck.invalid"
    ORIGINS = {
        "the public origin": "https://quarterdeck.invalid",
        "missing": None,
        "plain http": "http://quarterdeck.invalid",
        "another host": "https://other.invalid",
        "a longer host": "https://quarterdeck.invalid.other.invalid",
        "a port": "https://quarterdeck.invalid:443",
        "a trailing slash": "https://quarterdeck.invalid/",
        "a path": "https://quarterdeck.invalid/captain",
        "another case": "https://Quarterdeck.Invalid",
        "an upper case scheme": "HTTPS://quarterdeck.invalid",
        "a user": "https://user@quarterdeck.invalid",
        "a space after": "https://quarterdeck.invalid ",
        "the host alone": "quarterdeck.invalid",
        "the word null": "null",
        "empty": "",
    }

    def request(self, origin, name="Origin"):
        headers = {
            "Cookie": "__Host-qd-approval=fixed-session-placeholder",
            "X-Forwarded-For": "192.0.2.10",
            "X-Forwarded-Host": self.HOST,
            "X-Forwarded-Proto": "https",
            "Ignored": "not-forwarded",
        }
        if origin is not None:
            headers[name] = origin
        return approval_app.Request(
            "POST",
            "/captain/api/chat?with=bot-a",
            headers,
            bytearray(),
            "proxy",
        )

    @staticmethod
    def accepts(check, request):
        try:
            check(request)
        except approval_security.ApprovalRefused:
            return False
        return True

    def test_the_copied_origin_rule_agrees_with_the_sign_in_service_on_every_row(self):
        service = types.SimpleNamespace(
            public_origin="https://" + self.HOST,
            _headers=approval_app.ApprovalApplication._headers,
        )
        for name, origin in self.ORIGINS.items():
            for header in ("Origin", "origin", "ORIGIN"):
                with self.subTest(name=name, header=header):
                    request = self.request(origin, header)
                    theirs = self.accepts(
                        lambda asked: approval_app.ApprovalApplication._origin(service, asked),
                        request,
                    )
                    ours = self.accepts(auth_bridge.SocketApprovalGate._origin, request)
                    wanted = name == "the public origin"
                    self.assertEqual((ours, theirs), (wanted, wanted))

    def test_admission_asks_one_session_question_shaped_as_a_read_of_the_same_address(self):
        calls = []

        def transport(payload):
            calls.append(payload)
            return {"ok": True, "csrf": "spare", "freshUntil": 1900.0, "freshRequired": False}

        gate = auth_bridge.SocketApprovalGate(transport)
        request = self.request("https://quarterdeck.invalid")

        self.assertIsNone(gate.admit_post(request))

        self.assertEqual(
            calls,
            [
                {
                    "operation": "authenticate",
                    "session": "fixed-session-placeholder",
                    "request": {
                        "method": "GET",
                        "path": "/captain/api/chat?with=bot-a",
                        "headers": {
                            "Origin": "https://quarterdeck.invalid",
                            "X-Forwarded-For": "192.0.2.10",
                            "X-Forwarded-Host": self.HOST,
                            "X-Forwarded-Proto": "https",
                        },
                        "peer": "proxy",
                    },
                }
            ],
        )
        self.assertEqual(request.method, "POST")

    def test_admission_refuses_a_wrong_origin_before_the_session_question(self):
        calls = []
        gate = auth_bridge.SocketApprovalGate(calls.append)
        for name, origin in self.ORIGINS.items():
            if name == "the public origin":
                continue
            with self.subTest(name=name):
                with self.assertRaises(approval_security.ApprovalRefused):
                    gate.admit_post(self.request(origin))
        self.assertEqual(calls, [])

    def test_admission_passes_on_what_the_sign_in_service_says(self):
        for error in (
            auth_bridge.application.SessionRefused("Captain auth session was refused"),
            approval_security.FreshSignInRequired("Fresh sign-in is required"),
            approval_security.ApprovalRefused("Captain auth service is unavailable"),
        ):
            with self.subTest(error=type(error).__name__):
                def transport(payload, error=error):
                    raise error

                gate = auth_bridge.SocketApprovalGate(transport)
                with self.assertRaises(type(error)) as caught:
                    gate.admit_post(self.request("https://quarterdeck.invalid"))
                self.assertIs(caught.exception, error)


if __name__ == "__main__":
    unittest.main(verbosity=2)
