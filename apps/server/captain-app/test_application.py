import json
import tempfile
import unittest
from pathlib import Path

import approval_app
import approval_security
import application
import test_signin_support


class _NoGoogle:
    def authorization_url(self, **values):
        raise AssertionError("Google is not used by these tests")

    def exchange_code(self, code, verifier, nonce):
        raise AssertionError("Google is not used by these tests")


class FakeCards:
    def __init__(self):
        self.answers = []
        self.comments = []
        self.chat_sends = []
        self.refresh_calls = 0

    def refresh(self):
        self.refresh_calls += 1
        return {"projects": [], "plainMail": []}

    def card(self, card_id):
        return {"card": {"id": card_id}, "rev": 1, "state": "open", "thread": []}

    def answer(self, card_id, rev, pick, note, *, now):
        self.answers.append((card_id, rev, pick, note))
        return {"message": f"Got it: {card_id} {pick}", "stale": False, "rev": rev}

    def comment(self, card_id, text, request_id):
        self.comments.append((card_id, text, request_id))

    def chat(self, bot):
        return {
            "bot": {"id": bot},
            "messages": [
                {
                    "id": "m1",
                    "from": "bot",
                    "at": "now",
                    "text": "Ready",
                }
            ],
            "seenUpTo": None,
            "writing": False,
        }

    @staticmethod
    def chat_list():
        return [
            {
                "id": "bot-d",
                "preview": "Ready",
                "at": "now",
                "unread": False,
            }
        ]

    def send_chat(self, bot, text, request_id, *, fresh=False):
        self.chat_sends.append((bot, text, request_id))
        return "sent-chat", fresh

class FakeUpdates:
    def __init__(self):
        self.afters = []
        self.snapshot_calls = 0

    def snapshot(self):
        self.snapshot_calls += 1
        return {"projects": [], "plainMail": []}

    def events(self, *, after):
        self.afters.append(after)
        return iter(
            ['id: 1\nevent: refresh\ndata: {"cards":true,"chats":true}\n\n']
        )



class ApplicationTests(unittest.TestCase):

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        root = Path(self.temporary.name)
        root.chmod(0o700)
        self.now = [1000.0]
        entropy = [0]

        def token_bytes(size):
            entropy[0] += 1
            return bytes([entropy[0]]) * size

        self.state = approval_security.ApprovalState(
            root / "approval.sqlite",
            b"s" * 32,
            clock=lambda: self.now[0],
            token_bytes=token_bytes,
        )
        self.token = self.state.start_browser_session("account-user-subject", device_hash=None, kind="Other browser", fresh_from=self.now[0]).token
        self.approval = object.__new__(approval_app.ApprovalApplication)
        self.approval.state = self.state
        self.approval.sign_in = test_signin_support.production_sign_in(
            self.state,
            _NoGoogle(),
        )
        self.addCleanup(setattr, self.approval.sign_in, "_authority", None)
        self.approval.trusted_proxy = "proxy"
        self.approval.public_origin = "https://quarterdeck.invalid"
        self.approval.forwarded_host = "quarterdeck.invalid"
        self.cards = FakeCards()
        self.updates = FakeUpdates()
        self.app = application.CardApplication(
            application.ApprovalGate(self.approval),
            self.cards,
            self.updates,
            clock=lambda: self.now[0],
        )

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, method, path, body=b"", *, cookie=True, origin=None):
        headers = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "quarterdeck.invalid",
            "X-Forwarded-For": "192.0.2.10",
        }
        if cookie:
            headers["Cookie"] = f"__Host-qd-approval={self.token}"
        if origin is not None:
            headers["Origin"] = origin
        if body:
            headers["Content-Type"] = "application/json"
        return approval_app.Request(method, path, headers, bytearray(body), "proxy")

    def body(self, response):
        return json.loads(response.body)

    def test_same_approval_session_guards_json_get_and_one_use_csrf_post(self):
        approval_request = self.request("GET", "/captain/pending")
        self.assertIsNotNone(self.approval._session(approval_request))

        listing = self.app.handle(self.request("GET", "/captain/cards"))
        self.assertEqual(listing.status, 200)
        listing_body = self.body(listing)
        csrf = listing_body.pop("csrf")
        self.assertEqual(listing_body.pop("freshUntil"), 1900.0)
        self.assertEqual(listing_body, {"projects": [], "plainMail": []})
        self.assertEqual(dict(listing.headers)["Content-Type"], "application/json; charset=utf-8")
        etag = dict(listing.headers)["ETag"]
        unchanged_request = self.request("GET", "/captain/cards")
        unchanged_request.headers["If-None-Match"] = etag
        unchanged = self.app.handle(unchanged_request)
        self.assertEqual(unchanged.status, 304)
        self.assertEqual(unchanged.body, b"")
        self.assertEqual(dict(unchanged.headers)["ETag"], etag)
        self.assertEqual(self.cards.refresh_calls, 0)
        self.assertEqual(self.updates.snapshot_calls, 2)

        payload = json.dumps({"rev": 1, "pick": "A", "note": "", "csrf": csrf}).encode()
        answered = self.app.handle(self.request(
            "POST",
            "/captain/cards/repo-lead-1/answer",
            payload,
            origin="https://quarterdeck.invalid",
        ))
        self.assertEqual(answered.status, 200)
        self.assertEqual(self.cards.answers, [("repo-lead-1", 1, "A", "")])

        replay = self.app.handle(self.request(
            "POST",
            "/captain/cards/repo-lead-1/answer",
            payload,
            origin="https://quarterdeck.invalid",
        ))
        self.assertEqual(replay.status, 403)
        self.assertEqual(len(self.cards.answers), 1)

        unsigned = self.app.handle(self.request("GET", "/captain/cards", cookie=False))
        self.assertEqual(unsigned.status, 401)

    def test_plain_interim_chat_page_uses_same_origin_assets(self):
        page = self.app.handle(self.request("GET", "/captain/chat"))
        script = self.app.handle(
            self.request("GET", "/captain/assets/chat.js")
        )
        style = self.app.handle(
            self.request("GET", "/captain/assets/chat.css")
        )

        self.assertEqual(page.status, 200)
        page_headers = dict(page.headers)
        self.assertEqual(
            page_headers["Content-Type"],
            "text/html; charset=utf-8",
        )
        self.assertIn("script-src 'self'", page_headers["Content-Security-Policy"])
        self.assertIn(b"Select a bot", page.body)
        self.assertNotIn(b"bot-a", page.body)
        self.assertEqual(
            dict(script.headers)["Content-Type"],
            "text/javascript; charset=utf-8",
        )
        self.assertIn(b"EventSource", script.body)
        self.assertIn(b"requestId", script.body)
        self.assertEqual(
            dict(style.headers)["Content-Type"],
            "text/css; charset=utf-8",
        )

    def test_chat_routes_refuse_unsigned_named_or_malformed_targets(self):
        unsigned = self.app.handle(
            self.request("GET", "/captain/chat", cookie=False)
        )
        missing = self.app.handle(
            self.request("GET", "/captain/api/chat")
        )
        repeated = self.app.handle(
            self.request(
                "GET",
                "/captain/api/chat?with=bot-a&with=bot-b",
            )
        )
        encoded_slash = self.app.handle(
            self.request("GET", "/captain/api/chat?with=bot-a%2Fother")
        )
        named_route = self.app.handle(
            self.request("GET", "/captain/api/chat/bot-a")
        )

        self.assertEqual(unsigned.status, 401)
        self.assertEqual(missing.status, 400)
        self.assertEqual(repeated.status, 400)
        self.assertEqual(encoded_slash.status, 400)
        self.assertEqual(named_route.status, 404)

        thread = self.app.handle(
            self.request("GET", "/captain/api/chat?with=bot-d")
        )
        payload = json.dumps({
            "text": "Go ahead",
            "requestId": "request-cross-origin",
            "csrf": self.body(thread)["csrf"],
        }).encode()
        refused = self.app.handle(self.request(
            "POST",
            "/captain/api/chat?with=bot-d",
            payload,
            origin="https://other.invalid",
        ))
        self.assertEqual(refused.status, 403)
        self.assertEqual(self.cards.chat_sends, [])

    def test_comment_and_generic_chat_are_same_origin_authenticated_json_routes(self):
        chats = self.app.handle(
            self.request("GET", "/captain/api/chats")
        )
        self.assertEqual(chats.status, 200)
        chats_body = self.body(chats)
        chats_body.pop("csrf")
        self.assertEqual(chats_body.pop("freshUntil"), 1900.0)
        self.assertEqual(
            chats_body,
            {
                "chats": [
                    {
                        "id": "bot-d",
                        "preview": "Ready",
                        "at": "now",
                        "unread": False,
                    }
                ]
            },
        )

        chat = self.app.handle(
            self.request("GET", "/captain/api/chat?with=bot-d")
        )
        self.assertEqual(chat.status, 200)
        chat_body = self.body(chat)
        csrf = chat_body.pop("csrf")
        self.assertEqual(chat_body.pop("freshUntil"), 1900.0)
        self.assertEqual(chat_body, {
            "bot": {"id": "bot-d"},
            "messages": [
                {
                    "id": "m1",
                    "from": "bot",
                    "at": "now",
                    "text": "Ready",
                }
            ],
            "seenUpTo": None,
            "writing": False,
        })

        comment_payload = json.dumps({
            "text": "One detail",
            "requestId": "request-1",
            "csrf": csrf,
        }).encode()
        commented = self.app.handle(self.request(
            "POST",
            "/captain/cards/repo-lead-1/comments",
            comment_payload,
            origin="https://quarterdeck.invalid",
        ))
        self.assertEqual(commented.status, 200)
        next_csrf = self.body(commented)["csrf"]
        self.assertEqual(
            self.cards.comments,
            [("repo-lead-1", "One detail", "request-1")],
        )

        chat_payload = json.dumps({
            "text": "Go ahead",
            "requestId": "request-2",
            "csrf": next_csrf,
        }).encode()
        sent = self.app.handle(self.request(
            "POST",
            "/captain/api/chat?with=bot-d",
            chat_payload,
            origin="https://quarterdeck.invalid",
        ))
        self.assertEqual(sent.status, 200)
        sent_body = self.body(sent)
        sent_body.pop("csrf")
        self.assertEqual(sent_body.pop("freshUntil"), 1900.0)
        self.assertEqual(
            sent_body,
            {
                "status": "sent",
                "message": {
                    "id": "sent-chat",
                    "clientId": "request-2",
                    "from": "account",
                    "at": "1970-01-01T00:16:40+00:00",
                    "text": "Go ahead",
                    "fresh": True,
                },
            },
        )
        self.assertEqual(
            self.cards.chat_sends,
            [("bot-d", "Go ahead", "request-2")],
        )

    def test_event_stream_uses_the_same_session_and_shared_checker(self):
        stream = self.app.open_events(
            self.request("GET", "/captain/events"),
            last_event_id="0",
        )
        self.assertEqual(stream.status, 200)
        self.assertEqual(
            dict(stream.headers)["Content-Type"],
            "text/event-stream; charset=utf-8",
        )
        self.assertEqual(
            next(stream.events),
            'id: 1\nevent: refresh\ndata: {"cards":true,"chats":true}\n\n',
        )
        self.assertEqual(self.updates.afters, [0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
