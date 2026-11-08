import hashlib
import re
import tempfile
import unittest
from pathlib import Path

import approval_app
import approval_security
import application
import test_signin_support
from test_application import FakeCards, FakeUpdates, _NoGoogle


ROOT = Path(application.__file__).parent
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; "
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; "
    "base-uri 'none'"
)
IMMUTABLE = "private, max-age=31536000, immutable"


def digest(name):
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()


def expected_page():
    page = (ROOT / "chat.html").read_text(encoding="utf-8")
    for name in ("chat.css", "chat.js"):
        page = page.replace(
            f"/captain/assets/{name}",
            f"/captain/assets/{name}?v={digest(name)[:12]}",
        )
    return page.encode("utf-8")


class ChatCacheTests(unittest.TestCase):
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
        self.token = self.state.start_identity_session("account-user-subject")
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
        self.app = self.build()

    def tearDown(self):
        self.temporary.cleanup()

    def build(self, **options):
        return application.CardApplication(
            application.ApprovalGate(self.approval),
            self.cards,
            self.updates,
            clock=lambda: self.now[0],
            **options,
        )

    def request(self, path, *, cookie=True, headers=None):
        values = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "quarterdeck.invalid",
            "X-Forwarded-For": "192.0.2.10",
        }
        if cookie:
            values["Cookie"] = f"__Host-qd-approval={self.token}"
        values.update(headers or {})
        return approval_app.Request("GET", path, values, bytearray(), "proxy")

    def test_chat_page_is_no_cache_with_a_content_hash_etag(self):
        page = self.app.handle(self.request("/captain/chat"))

        self.assertEqual(page.status, 200)
        headers = dict(page.headers)
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertEqual(
            headers["ETag"],
            '"' + hashlib.sha256(page.body).hexdigest() + '"',
        )
        self.assertEqual(page.body, expected_page())

    def test_chat_page_links_carry_the_first_twelve_hex_of_each_asset_hash(self):
        body = self.app.handle(self.request("/captain/chat")).body.decode()

        self.assertEqual(
            re.findall(r'/captain/assets/chat\.(?:css|js)[^"]*', body),
            [
                f"/captain/assets/chat.css?v={digest('chat.css')[:12]}",
                f"/captain/assets/chat.js?v={digest('chat.js')[:12]}",
            ],
        )

    def test_chat_page_answers_an_empty_304_for_a_matching_if_none_match(self):
        first = self.app.handle(self.request("/captain/chat"))
        etag = dict(first.headers)["ETag"]
        for label, value in (
            ("exact", etag),
            ("weak", "W/" + etag),
            ("list", '"other", ' + etag),
            ("weak list", 'W/"other", W/' + etag),
        ):
            with self.subTest(label):
                response = self.app.handle(
                    self.request("/captain/chat", headers={"If-None-Match": value})
                )

                self.assertEqual(response.status, 304)
                self.assertEqual(response.body, b"")
                headers = dict(response.headers)
                self.assertEqual(headers["ETag"], etag)
                self.assertEqual(headers["Cache-Control"], "no-cache")
                self.assertEqual(headers["Content-Length"], "0")
                self.assertEqual(headers["Content-Security-Policy"], CSP)
        for label, value in (
            ("other", '"0000"'),
            ("empty", ""),
            ("bare", etag.strip('"')),
        ):
            with self.subTest(label):
                response = self.app.handle(
                    self.request("/captain/chat", headers={"If-None-Match": value})
                )

                self.assertEqual(response.status, 200)
                self.assertEqual(response.body, first.body)

    def test_a_304_needs_a_signed_in_caller(self):
        etag = dict(self.app.handle(self.request("/captain/chat")).headers)["ETag"]

        response = self.app.handle(
            self.request("/captain/chat", cookie=False, headers={"If-None-Match": etag})
        )

        self.assertEqual(response.status, 401)

    def test_assets_are_immutable_only_for_the_current_hash_mark(self):
        current = {name: digest(name)[:12] for name in ("chat.js", "chat.css")}
        for name, mark in current.items():
            path = f"/captain/assets/{name}"
            other = "chat.css" if name == "chat.js" else "chat.js"
            cases = {
                f"?v={mark}": IMMUTABLE,
                "": "no-cache",
                "?v=000000000000": "no-cache",
                f"?v={current[other]}": "no-cache",
                "?v=": "no-cache",
                "?v": "no-cache",
                f"?v={mark}&x=1": "no-cache",
                f"?x=1&v={mark}": "no-cache",
                f"?v={mark}&v={mark}": "no-cache",
                f"?v={mark.upper()}": "no-cache",
                f"?v={digest(name)}": "no-cache",
                f"?w={mark}": "no-cache",
                f"?v={mark}%00": "no-cache",
            }
            for query, expected in cases.items():
                with self.subTest(path=path, query=query):
                    response = self.app.handle(self.request(path + query))

                    self.assertEqual(response.status, 200)
                    self.assertEqual(dict(response.headers)["Cache-Control"], expected)

    def test_every_other_header_stays_exactly_as_before(self):
        for path, content_type, extra in (
            ("/captain/chat", "text/html; charset=utf-8", ("ETag",)),
            ("/captain/assets/chat.js", "text/javascript; charset=utf-8", ()),
            ("/captain/assets/chat.css", "text/css; charset=utf-8", ()),
        ):
            with self.subTest(path):
                response = self.app.handle(self.request(path))
                headers = dict(response.headers)

                self.assertEqual(headers["Content-Type"], content_type)
                self.assertEqual(headers["Content-Security-Policy"], CSP)
                self.assertEqual(headers["Referrer-Policy"], "no-referrer")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["X-Frame-Options"], "DENY")
                self.assertEqual(headers["Content-Length"], str(len(response.body)))
                self.assertEqual(
                    sorted(name for name, _ in response.headers),
                    sorted(
                        [
                            "Content-Type",
                            "Cache-Control",
                            "Content-Security-Policy",
                            "Referrer-Policy",
                            "X-Content-Type-Options",
                            "X-Frame-Options",
                            "Content-Length",
                            *extra,
                        ]
                    ),
                )

    def test_asset_bodies_are_the_files_and_other_routes_keep_their_query_refusal(self):
        for name in ("chat.js", "chat.css"):
            response = self.app.handle(
                self.request(f"/captain/assets/{name}?v={digest(name)[:12]}")
            )
            self.assertEqual(response.body, (ROOT / name).read_bytes())
        self.assertEqual(self.app.handle(self.request("/captain/chat?v=abc")).status, 400)
        self.assertEqual(self.app.handle(self.request("/captain/cards?v=abc")).status, 400)
        self.assertEqual(
            self.app.handle(self.request("/captain/api/chats?v=abc")).status, 400
        )

    def test_signed_out_answers_do_not_change_with_or_without_a_mark(self):
        mark = digest("chat.js")[:12]
        plain = self.app.handle(self.request("/captain/assets/chat.js", cookie=False))
        marked = self.app.handle(
            self.request(f"/captain/assets/chat.js?v={mark}", cookie=False)
        )
        page = self.app.handle(self.request("/captain/chat", cookie=False))

        self.assertEqual(
            (marked.status, marked.headers, marked.body),
            (plain.status, plain.headers, plain.body),
        )
        self.assertEqual(plain.status, 401)
        self.assertEqual(page.status, 401)
        self.assertNotIn(b"chat.js", plain.body)

    def test_hashes_and_bodies_are_fixed_when_the_server_starts(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            for name in ("chat.html", "chat.js", "chat.css"):
                (root / name).write_bytes((ROOT / name).read_bytes())
            app = self.build(assets_dir=root)
            before = app.handle(self.request("/captain/chat")).body
            (root / "chat.js").write_bytes(b"changed after start")
            (root / "chat.html").write_bytes(b"changed after start")
            after = app.handle(self.request("/captain/chat")).body
            script = app.handle(self.request("/captain/assets/chat.js"))

            self.assertEqual(before, after)
            self.assertEqual(script.body, (ROOT / "chat.js").read_bytes())

    def test_a_page_that_lacks_or_repeats_a_link_stops_the_start(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            for name in ("chat.js", "chat.css"):
                (root / name).write_bytes((ROOT / name).read_bytes())
            page = (ROOT / "chat.html").read_bytes()
            for label, broken in (
                ("no links", b"<html></html>"),
                ("script link gone", page.replace(b"/captain/assets/chat.js", b"/x.js")),
                ("style link gone", page.replace(b"/captain/assets/chat.css", b"/x.css")),
                ("links repeated", page + page),
            ):
                with self.subTest(label):
                    (root / "chat.html").write_bytes(broken)
                    with self.assertRaises(RuntimeError):
                        self.build(assets_dir=root)

    def test_the_rendered_caddy_routes_match_on_the_path_alone(self):
        import json

        import packaging_plan

        base = json.loads(
            (ROOT.parent / "golive" / "door" / "door-policy.json").read_text(encoding="utf-8")
        )
        diff = {
            "format": 1,
            "baseSha256": packaging_plan.DOOR_BASE_SHA256,
            "upstream": "captain-app:8080",
            "routes": packaging_plan.ROUTES,
        }

        fragment = packaging_plan.render_door_diff(base, diff)

        self.assertIn(
            "    path /captain/chat /captain/assets/chat.css /captain/assets/chat.js\n",
            fragment,
        )
        self.assertIn("    path /captain/api/chat\n", fragment)
        for forbidden in ("path_regexp", "query", "expression", "vars", "?"):
            self.assertNotIn(forbidden, fragment)


if __name__ == "__main__":
    unittest.main(verbosity=2)
