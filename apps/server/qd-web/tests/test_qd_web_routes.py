import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import application
import approval_app
import approval_security
import bundle
import cards
import live
import webapp


INDEX = b'<!doctype html><html><head><script>var theme = 1;</script><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'
FILES = {
    "index.html": INDEX,
    "app.css": b"body{margin:0}",
    "app.js": b"export const a = 1;",
    "chunk-ABCD1234.js": b"export const b = 2;",
}
CARD_BODY = {"card": {"id": "bot-a-1"}, "rev": 1, "state": "open", "thread": []}
LIST_BODY = {"projects": [], "plainMail": [], "truncated": False}


class Gate:
    def __init__(self):
        self.calls = []
        self.refuse = None
        self.csrf_refused = False

    def authenticate(self, request):
        self.calls.append(("authenticate", request.path))
        if self.refuse is not None:
            raise self.refuse
        return "owner"

    def authorize_post(self, request, csrf):
        self.calls.append(("authorize_post", request.path))
        if self.refuse is not None:
            raise self.refuse
        if self.csrf_refused:
            raise approval_security.ApprovalRefused("card csrf is invalid")
        return "owner"

    def issue_csrf(self, owner):
        return "csrf-next"

    def fresh_until(self, owner):
        return 5000.0


class Service:
    def __init__(self):
        self.answers = []
        self.comments = []

    def card(self, card_id):
        if card_id == "missing":
            raise cards.CardRefused("card is unknown")
        return dict(CARD_BODY, card={"id": card_id})

    def answer(self, card_id, rev, pick, note, *, now):
        self.answers.append((card_id, rev, pick, note))
        return {"message": f"Got it: {card_id} {pick} at 10:00 AM ET", "stale": False, "rev": rev}

    def comment(self, card_id, text, request_id):
        self.comments.append((card_id, text, request_id))

    def chat_list(self):
        return []


class Updates:
    def snapshot(self):
        return LIST_BODY

    def events(self, *, after):
        yield 'id: 1\nevent: refresh\ndata: {"cards":true,"chats":true,"mail":true}\n\n'


class Mail:
    def __init__(self, gate):
        self.gate = gate
        self.calls = []
        self.error = None

    def handle(self, request, path):
        self.calls.append((request.method, path))
        self.gate.authenticate(request)
        if self.error is not None:
            raise self.error
        return application.CardApplication._response(200, {"threads": [], "path": path})


def request(method, path, payload=None, *, headers=None, body=None):
    sent = {} if headers is None else dict(headers)
    data = bytearray(b"" if body is None else body)
    if payload is not None:
        data = bytearray(json.dumps(payload).encode("utf-8"))
        sent.setdefault("Content-Type", "application/json")
    return approval_app.Request(method, path, sent, data, "127.0.0.1")


def header(response, name):
    return next((value for key, value in response.headers if key.lower() == name.lower()), None)


class WebCase(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name)
        for name, data in FILES.items():
            (root / name).write_bytes(data)
        self.gate = Gate()
        self.service = Service()
        self.cards = application.CardApplication(self.gate, self.service, Updates(), clock=lambda: 1_700_000_000.0)
        self.bundle = bundle.Bundle.load(str(root))
        self.mail = Mail(self.gate)
        self.web = webapp.QdWeb(self.cards, self.bundle, mail=self.mail)
        self.bare = webapp.QdWeb(self.cards, self.bundle)

    def body(self, response):
        return json.loads(response.body)


class ContractRouteTests(WebCase):
    def test_the_card_list_is_served_with_a_strong_etag_and_the_tokens(self):
        response = self.web.handle(request("GET", "/captain/cards"))
        self.assertEqual(response.status, 200)
        body = self.body(response)
        self.assertEqual((body["csrf"], body["freshUntil"]), ("csrf-next", 5000.0))
        self.assertEqual(body["projects"], [])
        self.assertRegex(header(response, "ETag"), r'^"[0-9a-f]{64}"$')
        self.assertEqual(header(response, "Cache-Control"), "no-store")

    def test_the_card_list_answers_304_for_the_exact_etag(self):
        first = self.web.handle(request("GET", "/captain/cards"))
        etag = header(first, "ETag")
        again = self.web.handle(request("GET", "/captain/cards", headers={"If-None-Match": etag}))
        self.assertEqual((again.status, again.body, header(again, "Content-Length")), (304, b"", "0"))
        self.assertEqual(header(again, "ETag"), etag)
        weak = self.web.handle(request("GET", "/captain/cards", headers={"If-None-Match": "W/" + etag}))
        self.assertEqual(weak.status, 200)

    def test_one_card_is_served(self):
        response = self.web.handle(request("GET", "/captain/cards/bot-a-1"))
        self.assertEqual((response.status, self.body(response)["card"]), (200, {"id": "bot-a-1"}))

    def test_a_card_id_that_is_not_shaped_like_one_answers_404_on_get(self):
        response = self.web.handle(request("GET", "/captain/cards/bad_id"))
        self.assertEqual((response.status, self.body(response)), (404, {"error": "not found"}))

    def test_an_unknown_but_well_formed_card_answers_400(self):
        response = self.web.handle(request("GET", "/captain/cards/missing"))
        self.assertEqual((response.status, self.body(response)), (400, {"error": "request refused"}))

    def test_an_answer_goes_to_the_service_and_returns_the_receipt(self):
        response = self.web.handle(request("POST", "/captain/cards/bot-a-1/answer", {"rev": 1, "pick": "A", "note": "", "csrf": "t"}))
        self.assertEqual(response.status, 200)
        self.assertEqual(self.service.answers, [("bot-a-1", 1, "A", "")])
        self.assertEqual(self.body(response)["csrf"], "csrf-next")

    def test_a_comment_goes_to_the_service(self):
        response = self.web.handle(request("POST", "/captain/cards/bot-a-1/comments", {"text": "Hi", "requestId": "r-1", "csrf": "t"}))
        self.assertEqual((response.status, self.body(response)["status"]), (200, "sent"))
        self.assertEqual(self.service.comments, [("bot-a-1", "Hi", "r-1")])

    def test_a_post_to_an_answer_route_with_a_bad_id_shape_keeps_the_frozen_400(self):
        for tail in ("answer", "comments"):
            with self.subTest(tail=tail):
                response = self.web.handle(request("POST", f"/captain/cards/bad_id/{tail}", {"rev": 1, "pick": "A", "note": "", "csrf": "t"}))
                self.assertEqual((response.status, self.body(response)), (400, {"error": "request refused"}))
        self.assertEqual((self.service.answers, self.service.comments), ([], []))

    def test_a_used_token_is_403_and_sends_nothing(self):
        self.gate.csrf_refused = True
        response = self.web.handle(request("POST", "/captain/cards/bot-a-1/answer", {"rev": 1, "pick": "A", "note": "", "csrf": "t"}))
        self.assertEqual((response.status, self.service.answers), (403, []))

    def test_a_missing_session_is_401_in_process_and_403_when_refused(self):
        self.gate.refuse = application.AuthenticationRequired("approval session required")
        self.assertEqual(self.web.handle(request("GET", "/captain/cards")).status, 401)
        self.gate.refuse = approval_security.ApprovalRefused("refused")
        self.assertEqual(self.web.handle(request("GET", "/captain/cards")).status, 403)
        self.gate.refuse = approval_security.ApprovalRateLimited("limited")
        self.assertEqual(self.web.handle(request("GET", "/captain/cards")).status, 429)

    def test_a_service_failure_is_503(self):
        self.service.card = lambda card_id: (_ for _ in ()).throw(RuntimeError("down"))
        response = self.web.handle(request("GET", "/captain/cards/bot-a-1"))
        self.assertEqual((response.status, self.body(response)), (503, {"error": "request unavailable"}))

    def test_a_stale_fresh_sign_in_is_a_303_to_the_step_up_page_with_no_body(self):
        self.gate.refuse = approval_security.FreshSignInRequired("Fresh sign-in is required")
        response = self.web.handle(request("POST", "/captain/cards/bot-a-1/answer", {"rev": 1, "pick": "A", "note": "", "csrf": "t"}))
        self.assertEqual((response.status, response.body), (303, b""))
        self.assertEqual(header(response, "Location"), "/captain/step-up?next=%2Fcaptain%2Fchat")
        self.assertEqual(header(response, "Content-Length"), "0")

    def test_a_query_on_an_api_path_is_400_before_any_session_check(self):
        for method, path in (("GET", "/captain/cards?x=1"), ("GET", "/captain/cards/bot-a-1?x=1"), ("POST", "/captain/cards/bot-a-1/answer?x=1"), ("GET", "/captain/mail?x=1"), ("GET", "/captain/events?x=1")):
            with self.subTest(path=path):
                self.gate.calls.clear()
                response = self.web.handle(request(method, path, {"rev": 1, "pick": "A", "note": "", "csrf": "t"} if method == "POST" else None))
                self.assertEqual((response.status, self.gate.calls), (400, []))

    def test_the_events_stream_opens_through_the_card_application(self):
        stream = self.web.open_events(request("GET", "/captain/events"), last_event_id="7")
        self.assertEqual(stream.status, 200)
        self.assertEqual(dict(stream.headers)["Content-Type"], "text/event-stream; charset=utf-8")
        self.assertIn('"mail":true', next(iter(stream.events)))
        self.assertEqual(self.gate.calls, [("authenticate", "/captain/events")])

    def test_only_a_plain_get_of_the_events_path_is_an_events_request(self):
        self.assertTrue(self.web.is_events(request("GET", "/captain/events")))
        self.assertTrue(self.web.is_events(request("GET", "/captain/events?x=1")))
        for method, path in (("POST", "/captain/events"), ("HEAD", "/captain/events"), ("GET", "/captain/events/x"), ("GET", "/captain/event")):
            with self.subTest(method=method, path=path):
                self.assertFalse(self.web.is_events(request(method, path)))

    def test_an_events_request_with_a_query_is_refused_400(self):
        with self.assertRaises(cards.CardRefused):
            self.web.open_events(request("GET", "/captain/events?x=1"), last_event_id=None)

    def test_the_events_path_allows_only_get(self):
        for method in ("POST", "HEAD", "PUT"):
            with self.subTest(method=method):
                response = self.web.handle(request(method, "/captain/events"))
                self.assertEqual((response.status, header(response, "Allow")), (405, "GET"))


class ChatRedirectTests(WebCase):
    def test_a_get_of_the_chat_path_is_a_303_to_the_root_with_no_body(self):
        response = self.web.handle(request("GET", "/captain/chat"))
        self.assertEqual((response.status, response.body), (303, b""))
        self.assertEqual(header(response, "Location"), "/")
        self.assertEqual(header(response, "Cache-Control"), "no-store")
        self.assertEqual(header(response, "Content-Length"), "0")

    def test_the_redirect_needs_no_session_and_ignores_a_cookie_and_the_accept_header(self):
        for headers in ({}, {"Cookie": "__Host-qd-approval=x"}, {"Accept": "text/html"}):
            with self.subTest(headers=headers):
                response = self.web.handle(request("GET", "/captain/chat", headers=headers))
                self.assertEqual((response.status, header(response, "Location")), (303, "/"))
        self.assertEqual(self.gate.calls, [])

    def test_a_query_on_the_chat_path_does_not_change_the_target(self):
        response = self.web.handle(request("GET", "/captain/chat?with=bot-a&next=https://elsewhere.invalid/"))
        self.assertEqual((response.status, header(response, "Location")), (303, "/"))

    def test_other_methods_on_the_chat_path_are_405_with_allow_get(self):
        for method in ("POST", "HEAD", "PUT", "DELETE"):
            with self.subTest(method=method):
                response = self.web.handle(request(method, "/captain/chat"))
                self.assertEqual((response.status, header(response, "Allow")), (405, "GET"))

    def test_the_old_chat_pages_and_api_are_gone(self):
        for path in ("/captain/api/chat", "/captain/api/chats", "/captain/api/chat?with=bot-a", "/captain/assets/chat.js", "/captain/assets/chat.css", "/captain/chat.html"):
            for method in ("GET", "POST"):
                with self.subTest(path=path, method=method):
                    response = self.web.handle(request(method, path, {"text": "hi", "requestId": "r-1", "csrf": "t"} if method == "POST" else None))
                    self.assertEqual((response.status, self.body(response)), (404, {"error": "not found"}))
        self.assertEqual(self.service.comments, [])

    def test_the_application_no_longer_carries_the_chat_code(self):
        for name in ("CHAT_PATH", "CHATS_PATH", "STATIC_ROUTES", "ASSET_PATHS", "ASSET_LINKS", "STATIC_SECURITY_HEADERS", "IMMUTABLE_CACHE", "HTML_MEDIA_TYPES", "LOGIN_PATH"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(application, name))
        for name in ("_asks_for_html", "_sign_in_refused", "_chat_target", "_static", "_asset_cache"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(application.CardApplication, name))

    def test_the_application_builds_without_any_chat_files(self):
        self.assertIsNotNone(application.CardApplication(self.gate, self.service, Updates(), clock=lambda: 0.0))


class RefusalRuleTests(WebCase):
    def test_every_other_path_is_404_for_get_and_post(self):
        paths = ("/nope", "/captain", "/captain/", "/captain/nothing", "/captain/cards/", "/captain/cards/bot-a-1/other", "/captain/cards/a/b/c", "/captain/login", "/captain/oidc/callback", "/captain/step-up", "/captain/logout", "/captain/events/x", "/captain/mail/a/b", "/captain/mail/", "/index.html.bak")
        for path in paths:
            for method in ("GET", "POST"):
                with self.subTest(path=path, method=method):
                    response = self.bare.handle(request(method, path))
                    self.assertEqual((response.status, self.body(response)), (404, {"error": "not found"}))

    def test_every_other_method_on_a_known_path_is_405_with_the_allowed_methods(self):
        known = {
            "/captain/cards": "GET",
            "/captain/cards/bot-a-1": "GET",
            "/captain/cards/bot-a-1/answer": "POST",
            "/captain/cards/bot-a-1/comments": "POST",
            "/captain/events": "GET",
            "/captain/mail": "GET",
            "/captain/mail/MT-1": "GET",
            "/captain/chat": "GET",
            "/": "GET, HEAD",
            "/app.css": "GET, HEAD",
            "/queue": "GET, HEAD",
        }
        for path, allow in known.items():
            wrong = [m for m in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE") if m not in allow.split(", ")]
            for method in wrong:
                with self.subTest(path=path, method=method):
                    response = self.web.handle(request(method, path))
                    self.assertEqual((response.status, self.body(response), header(response, "Allow")), (405, {"error": "method not allowed"}, allow))

    def test_a_wrong_method_sends_nothing_and_checks_no_session(self):
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS"):
            self.web.handle(request(method, "/captain/cards/bot-a-1/answer", {"rev": 1, "pick": "A", "note": "", "csrf": "t"}))
        self.assertEqual((self.gate.calls, self.service.answers), ([], []))

    def test_a_get_of_the_answer_or_comment_route_is_405_not_404(self):
        for tail in ("answer", "comments"):
            response = self.web.handle(request("GET", f"/captain/cards/bot-a-1/{tail}"))
            self.assertEqual((response.status, header(response, "Allow")), (405, "POST"))

    def test_an_absolute_uri_or_a_fragment_is_404(self):
        for path in ("http://elsewhere.invalid/captain/cards", "//elsewhere.invalid/captain/cards", "/captain/cards#x"):
            with self.subTest(path=path):
                self.assertEqual(self.web.handle(request("GET", path)).status, 404)

    def test_every_refusal_carries_the_api_security_headers(self):
        for response in (self.web.handle(request("GET", "/nope")), self.web.handle(request("PUT", "/captain/cards"))):
            self.assertEqual(header(response, "Content-Type"), "application/json; charset=utf-8")
            self.assertEqual(header(response, "Cache-Control"), "no-store")
            self.assertEqual(header(response, "X-Content-Type-Options"), "nosniff")
            self.assertEqual(header(response, "X-Frame-Options"), "DENY")
            self.assertEqual(header(response, "Content-Length"), str(len(response.body)))

    def test_the_request_body_is_wiped_on_every_path_through_the_router(self):
        cases = (
            ("POST", "/captain/cards/bot-a-1/answer"),
            ("POST", "/nope"),
            ("PUT", "/captain/cards"),
            ("GET", "/captain/chat"),
            ("POST", "/"),
        )
        for method, path in cases:
            with self.subTest(method=method, path=path):
                sent = request(method, path, body=b"secret body")
                self.web.handle(sent)
                self.assertEqual(len(sent.body), 0)


class StaticRouteTests(WebCase):
    def test_the_root_and_the_app_pages_serve_index_html_without_a_session(self):
        for path in ("/", "/index.html", "/queue", "/queue/bot-a-1", "/lanes/Fleet", "/projects", "/projects/Fleet", "/projects/Fleet/pages", "/projects/Fleet/pages/PG-1", "/projects/Fleet/artifacts/AR-1", "/chat/bot-a", "/mail", "/mail/MT-1", "/settings", "/settings/general", "/settings/bots/bot-a"):
            with self.subTest(path=path):
                response = self.web.handle(request("GET", path))
                self.assertEqual((response.status, response.body), (200, INDEX))
                self.assertEqual(header(response, "Cache-Control"), "no-store")
        self.assertEqual(self.gate.calls, [])

    def test_files_of_the_bundle_are_served_with_their_types(self):
        expected = {"/app.css": "text/css; charset=utf-8", "/app.js": "text/javascript; charset=utf-8", "/chunk-ABCD1234.js": "text/javascript; charset=utf-8"}
        for path, kind in expected.items():
            with self.subTest(path=path):
                response = self.web.handle(request("GET", path))
                self.assertEqual((response.status, header(response, "Content-Type")), (200, kind))

    def test_head_returns_the_headers_and_the_length_but_no_body(self):
        get = self.web.handle(request("GET", "/app.js"))
        head = self.web.handle(request("HEAD", "/app.js"))
        self.assertEqual((head.status, head.body), (200, b""))
        self.assertEqual(header(head, "Content-Length"), str(len(FILES["app.js"])))
        self.assertEqual(header(head, "ETag"), header(get, "ETag"))

    def test_an_unknown_file_or_app_path_is_404(self):
        for path in ("/missing.js", "/queue/", "/queue/a/b", "/lanes", "/projects/Fleet/other", "/chat", "/mail/a/b", "/%61pp.js", "/app.js/"):
            with self.subTest(path=path):
                self.assertEqual(self.web.handle(request("GET", path)).status, 404)

    def test_a_query_on_a_static_path_is_ignored(self):
        self.assertEqual(self.web.handle(request("GET", "/app.js?v=1")).body, FILES["app.js"])


class MailMountTests(WebCase):
    def test_the_mail_list_and_one_thread_reach_the_mail_module(self):
        for path in ("/captain/mail", "/captain/mail/MT-1"):
            with self.subTest(path=path):
                response = self.web.handle(request("GET", path))
                self.assertEqual((response.status, self.body(response)["path"]), (200, path))
        self.assertEqual(self.mail.calls, [("GET", "/captain/mail"), ("GET", "/captain/mail/MT-1")])
        self.assertEqual(len(self.gate.calls), 2)

    def test_without_the_module_mail_is_a_plain_404(self):
        for path in ("/captain/mail", "/captain/mail/MT-1"):
            with self.subTest(path=path):
                self.assertEqual(self.bare.handle(request("GET", path)).status, 404)

    def test_a_segment_that_is_too_long_or_not_printable_is_400_before_the_module(self):
        for tail in ("a" * 129, "a b", "caf\u00e9", "a\tb"):
            with self.subTest(tail=tail):
                self.assertEqual(self.web.handle(request("GET", "/captain/mail/" + tail)).status, 400)
        self.assertEqual(self.mail.calls, [])

    def test_a_segment_of_128_printable_characters_reaches_the_module(self):
        self.assertEqual(self.web.handle(request("GET", "/captain/mail/" + "a" * 128)).status, 200)

    def test_the_mail_module_errors_map_to_the_shared_statuses(self):
        cases = (
            (application.NotFound("no thread"), 404, {"error": "not found"}),
            (cards.CardRefused("bad ref"), 400, {"error": "request refused"}),
            (application.AuthenticationRequired("none"), 401, {"error": "sign in required"}),
            (approval_security.ApprovalRefused("no"), 403, {"error": "request refused"}),
            (approval_security.ApprovalRateLimited("slow"), 429, {"error": "request refused"}),
            (RuntimeError("mail server down"), 503, {"error": "request unavailable"}),
        )
        for error, status, payload in cases:
            with self.subTest(error=type(error).__name__):
                self.mail.error = error
                response = self.web.handle(request("GET", "/captain/mail"))
                self.assertEqual((response.status, self.body(response)), (status, payload))

    def test_the_session_refusal_is_the_gates_even_before_the_module_works(self):
        self.gate.refuse = approval_security.ApprovalRefused("refused")
        self.assertEqual(self.web.handle(request("GET", "/captain/mail")).status, 403)


class ErrorTextTests(WebCase):
    def test_not_found_has_a_class_the_mail_module_can_raise(self):
        self.assertTrue(issubclass(application.NotFound, Exception))
        self.assertFalse(issubclass(application.NotFound, cards.CardRefused))


class AliasAndQueryTests(WebCase):
    def test_a_target_with_a_scheme_a_host_or_a_fragment_is_404_for_every_kind_of_route(self):
        targets = (
            "http://x/captain/cards",
            "//x/captain/cards",
            "/captain/cards#frag",
            "/captain/cards/bot-a-1#frag",
            "/captain/chat#frag",
            "/captain/mail#frag",
            "/#frag",
            "/app.js#frag",
            "http://x/app.js",
            "//x/app.js",
        )
        for target in targets:
            with self.subTest(target=target):
                self.assertEqual(self.web.handle(request("GET", target)).status, 404)

    def test_the_card_application_refuses_any_query_itself_and_not_only_the_router(self):
        payload = {"rev": 1, "pick": "A", "note": "", "csrf": "t"}
        for method, target in (("GET", "/captain/cards?x=1"), ("GET", "/captain/cards/bot-a-1?x=1"), ("POST", "/captain/cards/bot-a-1/answer?x=1")):
            with self.subTest(target=target):
                response = self.cards.handle(request(method, target, payload if method == "POST" else None))
                self.assertEqual(response.status, 400)

    def test_the_plain_handler_never_serves_events_and_never_checks_the_session_for_them(self):
        self.gate.refuse = approval_security.ApprovalRefused("refused")
        response = self.web.handle(request("GET", "/captain/events"))
        self.assertEqual(response.status, 404)
        self.assertEqual(self.gate.calls, [])


class LiveEventTests(unittest.TestCase):
    class Service:
        def __init__(self):
            self.payload = {"projects": [], "plainMail": []}

        def refresh(self):
            return self.payload

        def chat_list(self):
            return []

    def next_event(self, updates, after=0):
        return next(updates.events(after=after))

    def test_every_event_carries_the_fixed_text_with_mail(self):
        updates = live.LiveUpdates(self.Service())
        updates.check_once()
        self.assertEqual(self.next_event(updates), 'id: 1\nevent: refresh\ndata: {"cards":true,"chats":true,"mail":true}\n\n')

    def test_without_a_mail_source_a_card_change_still_sends_one_event(self):
        service = self.Service()
        updates = live.LiveUpdates(service)
        self.assertTrue(updates.check_once())
        self.assertFalse(updates.check_once())
        service.payload = {"projects": [1], "plainMail": []}
        self.assertTrue(updates.check_once())
        self.assertEqual(updates.version, 2)

    class StubGate:
        def __init__(self):
            self.value = "one"

        def run(self, refresh):
            return refresh()

        def token(self):
            return self.value

    def test_a_changed_mail_state_sends_an_event_and_an_unchanged_one_does_not(self):
        gate = self.StubGate()
        updates = live.LiveUpdates(self.Service(), gate)
        self.assertTrue(updates.check_once())
        self.assertFalse(updates.check_once())
        gate.value = "two"
        self.assertTrue(updates.check_once())
        self.assertEqual(updates.version, 2)

    def test_a_mail_change_does_not_change_the_card_snapshot(self):
        gate = self.StubGate()
        updates = live.LiveUpdates(self.Service(), gate)
        updates.check_once()
        before = updates.snapshot()
        gate.value = "two"
        updates.check_once()
        self.assertIs(updates.snapshot(), before)

    def test_the_card_encoding_is_unchanged_when_there_is_no_mail_source(self):
        service = self.Service()
        updates = live.LiveUpdates(service)
        updates.check_once()
        self.assertEqual(updates._encoded, b'{"cards":{"plainMail":[],"projects":[]},"chats":[]}')


class EtagRuleTests(unittest.TestCase):
    def test_the_exact_rule_matches_one_value_only(self):
        etag = '"' + "a" * 64 + '"'
        self.assertTrue(application.etag_matches(request("GET", "/captain/cards", headers={"If-None-Match": etag}), etag))
        self.assertTrue(application.etag_matches(request("GET", "/captain/cards", headers={"if-none-match": etag}), etag))
        for offered in ("W/" + etag, etag + ", " + etag, "", "*"):
            with self.subTest(offered=offered):
                self.assertFalse(application.etag_matches(request("GET", "/captain/cards", headers={"If-None-Match": offered}), etag))
        self.assertFalse(application.etag_matches(request("GET", "/captain/cards"), etag))


if __name__ == "__main__":
    unittest.main()
