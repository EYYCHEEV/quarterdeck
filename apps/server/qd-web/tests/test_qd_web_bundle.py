import base64
import dataclasses
import hashlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import approval_app
import bundle


CONTRACT_CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
INLINE = "(function () { var look = 'dark'; document.documentElement.setAttribute('data-appearance', look); })();"
INDEX = f'<!doctype html><html><head><meta charset="utf-8"><script>\n{INLINE}\n</script><link rel="stylesheet" href="/app.css"><link rel="modulepreload" href="/chunk-ABCD1234.js"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'.encode()


def digest_of(text):
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"


def request(method, path, headers=None):
    return approval_app.Request(method, path, {} if headers is None else headers, bytearray(), "127.0.0.1")


def header(response, name):
    return next((value for key, value in response.headers if key.lower() == name.lower()), None)


class Folder(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)

    def put(self, files):
        for name, data in files.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    def load(self, files=None, **limits):
        self.put({"index.html": INDEX, "app.css": b"body{}", "app.js": b"export{};"} if files is None else files)
        return bundle.Bundle.load(str(self.root), **limits)


class StartupRefusalTests(Folder):
    def test_a_folder_that_is_missing_is_refused(self):
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load(str(self.root / "absent"))

    def test_a_relative_path_is_refused(self):
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load("static")

    def test_a_file_in_place_of_the_folder_is_refused(self):
        self.put({"plain": b"x"})
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load(str(self.root / "plain"))

    def test_an_empty_folder_and_a_folder_without_index_html_are_refused(self):
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load(str(self.root))
        self.put({"app.js": b"x"})
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load(str(self.root))

    def test_an_index_html_that_is_a_link_is_refused(self):
        self.put({"real.html": INDEX})
        os.symlink(self.root / "real.html", self.root / "index.html")
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load(str(self.root))

    def test_the_limits_refuse_too_many_files_a_big_file_and_a_big_total(self):
        files = {"index.html": INDEX, "a.js": b"1" * 10, "b.js": b"2" * 10}
        with self.assertRaises(bundle.BundleRefused):
            self.load(files, max_files=2)
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load(str(self.root), max_file_bytes=len(INDEX) - 1)
        with self.assertRaises(bundle.BundleRefused):
            bundle.Bundle.load(str(self.root), max_total_bytes=len(INDEX) + 15)
        self.assertIsNotNone(bundle.Bundle.load(str(self.root), max_files=3, max_file_bytes=len(INDEX), max_total_bytes=len(INDEX) + 20))


class WhatIsServedTests(Folder):
    def test_files_are_served_as_they_are_on_disk(self):
        site = self.load({"index.html": INDEX, "app.js": b"export const x = 1;\n", "app.css": b"a{}"})
        for path, data in (("/app.js", b"export const x = 1;\n"), ("/app.css", b"a{}"), ("/", INDEX), ("/index.html", INDEX)):
            with self.subTest(path=path):
                self.assertEqual(site.serve(request("GET", path)).body, data)

    def test_types_come_from_a_short_allow_list(self):
        names = {
            "a.html": "text/html; charset=utf-8",
            "a.css": "text/css; charset=utf-8",
            "a.js": "text/javascript; charset=utf-8",
            "a.mjs": "text/javascript; charset=utf-8",
            "a.json": "application/json",
            "a.webmanifest": "application/manifest+json",
            "a.svg": "image/svg+xml",
            "a.png": "image/png",
            "a.jpg": "image/jpeg",
            "a.jpeg": "image/jpeg",
            "a.webp": "image/webp",
            "a.gif": "image/gif",
            "a.ico": "image/vnd.microsoft.icon",
            "a.woff2": "font/woff2",
            "a.woff": "font/woff",
            "a.txt": "text/plain; charset=utf-8",
        }
        site = self.load({"index.html": INDEX, **{name: b"x" for name in names}})
        for name, kind in names.items():
            with self.subTest(name=name):
                self.assertEqual(header(site.serve(request("GET", "/" + name)), "Content-Type"), kind)

    def test_files_that_must_not_be_served_are_skipped_and_listed(self):
        self.put({"real.js": b"x"})
        os.symlink(self.root / "real.js", self.root / "link.js")
        site = self.load({
            "index.html": INDEX,
            "app.js.map": b"{}",
            "notes.ts": b"x",
            ".secret.js": b"x",
            "sub/.hidden.css": b"x",
            "has space.js": b"x",
            "caf\u00e9.js": b"x",
            "captain/inside.js": b"x",
            "ok/inner.js": b"x",
        })
        self.assertEqual(site.skipped, tuple(sorted((".secret.js", "app.js.map", "captain/inside.js", "caf\u00e9.js", "has space.js", "link.js", "notes.ts", "sub/.hidden.css"))))
        for path in ("/app.js.map", "/notes.ts", "/.secret.js", "/sub/.hidden.css", "/has space.js", "/has%20space.js", "/link.js", "/captain/inside.js"):
            with self.subTest(path=path):
                self.assertFalse(site.has(path))
                self.assertIsNone(site.serve(request("GET", path)))
        self.assertTrue(site.has("/ok/inner.js"))
        self.assertTrue(site.has("/real.js"))

    def test_a_request_path_is_never_joined_to_the_folder(self):
        site = self.load()
        for path in ("/../etc/passwd", "/..%2fetc/passwd", "/app.js/", "//app.js", "/./app.js", "/%61pp.js", "/app.js%00", "/app.js\\", "/APP.JS"):
            with self.subTest(path=path):
                self.assertIsNone(site.serve(request("GET", path)))
                self.assertFalse(site.has(path))

    def test_the_bundle_is_read_once_at_start(self):
        site = self.load()
        (self.root / "app.js").write_bytes(b"changed")
        self.assertEqual(site.serve(request("GET", "/app.js")).body, b"export{};")

    def test_the_app_paths_serve_index_html_and_nothing_else_does(self):
        site = self.load()
        yes = ("/", "/queue", "/queue/bot-a-1", "/lanes/Fleet", "/projects", "/projects/Fleet", "/projects/Fleet/pages", "/projects/Fleet/pages/PG-1", "/projects/Fleet/artifacts/AR-1", "/chat/bot-a", "/mail", "/mail/MT-1", "/queue/a%20b", "/queue/MT-1.2", "/settings", "/settings/general", "/settings/bots", "/settings/bots/bot-a")
        no = ("/queue/", "/queue/a/b", "/lanes", "/lanes/", "/projects/", "/projects/Fleet/", "/projects/Fleet/other", "/projects/Fleet/pages/a/b", "/chat", "/mail/", "/settings/", "/settings/a/b", "/settings/bots/", "/settings/other/bot-a", "/settings/bots/a/b", "/captain", "/captain/cards", "/queue/" + "a" * 200, "/queue/a b", "/index", "/login", "/about")
        for path in yes:
            with self.subTest(path=path):
                self.assertTrue(site.has(path))
                self.assertEqual(site.serve(request("GET", path)).body, INDEX)
        for path in no:
            with self.subTest(path=path):
                self.assertFalse(site.has(path))
                self.assertIsNone(site.serve(request("GET", path)))

    def test_a_file_wins_over_an_app_path_of_the_same_name(self):
        site = self.load({"index.html": INDEX, "chat/bot-a.txt": b"not a page"})
        self.assertEqual(site.serve(request("GET", "/chat/bot-a.txt")).body, b"not a page")


class HeaderTests(Folder):
    def test_the_csp_has_the_contract_policy_and_the_hash_of_the_inline_script(self):
        site = self.load()
        self.assertEqual(site.csp, f"default-src 'self'; script-src 'self' {digest_of(chr(10) + INLINE + chr(10))}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def test_a_page_with_no_inline_script_gets_exactly_the_contract_policy(self):
        site = self.load({"index.html": b'<html><body><script type="module" src="/app.js"></script></body></html>'})
        self.assertEqual(site.csp, CONTRACT_CSP)

    def test_every_inline_script_is_hashed_once_in_document_order(self):
        page = b"<html><SCRIPT>one()</SCRIPT><script type='module'>two()</script><script>one()</script><script src='/a.js'>ignored()</script><script async src=/b.js></script></html>"
        site = self.load({"index.html": page})
        self.assertEqual(site.csp, f"default-src 'self'; script-src 'self' {digest_of('one()')} {digest_of('two()')}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def test_the_csp_and_the_other_security_headers_are_on_every_static_answer(self):
        site = self.load()
        for method, path, extra in (("GET", "/", {}), ("HEAD", "/app.js", {}), ("GET", "/app.css", {}), ("GET", "/queue", {})):
            with self.subTest(path=path, method=method):
                response = site.serve(request(method, path, extra))
                self.assertEqual(header(response, "Content-Security-Policy"), site.csp)
                self.assertEqual(header(response, "X-Content-Type-Options"), "nosniff")
                self.assertEqual(header(response, "X-Frame-Options"), "DENY")
                self.assertEqual(header(response, "Referrer-Policy"), "no-referrer")
        etag = header(site.serve(request("GET", "/app.js")), "ETag")
        again = site.serve(request("GET", "/app.js", {"If-None-Match": etag}))
        self.assertEqual((again.status, header(again, "Content-Security-Policy")), (304, site.csp))

    def test_index_html_is_no_store_and_has_no_etag(self):
        site = self.load()
        for path in ("/", "/index.html", "/queue", "/mail/MT-1"):
            with self.subTest(path=path):
                response = site.serve(request("GET", path))
                self.assertEqual(header(response, "Cache-Control"), "no-store")
                self.assertIsNone(header(response, "ETag"))
                self.assertEqual(header(response, "Content-Type"), "text/html; charset=utf-8")

    def test_only_hashed_chunk_names_get_the_long_cache(self):
        hashed = {"chunk-ABCD1234.js", "chunk-0Z9Y8X7W.js"}
        plain = {"app.js", "app.css", "lanes.css", "chunk-abcd1234.js", "chunk-ABCD123.js", "chunk-ABCD12345.js", "chunk-ABCD1234.css", "sub/chunk-ABCD1234.js", "logo.png", "chunk-ABCD1234.js.txt"}
        site = self.load({"index.html": INDEX, **{name: b"x" for name in hashed | plain}})
        for name in hashed:
            with self.subTest(name=name):
                self.assertEqual(header(site.serve(request("GET", "/" + name)), "Cache-Control"), "public, max-age=31536000, immutable")
        for name in plain:
            with self.subTest(name=name):
                self.assertEqual(header(site.serve(request("GET", "/" + name)), "Cache-Control"), "no-cache")

    def test_the_etag_is_the_strong_sha256_of_the_file(self):
        site = self.load()
        response = site.serve(request("GET", "/app.js"))
        self.assertEqual(header(response, "ETag"), '"' + hashlib.sha256(b"export{};").hexdigest() + '"')

    def test_a_matching_etag_gives_an_empty_304_with_the_same_validators(self):
        site = self.load()
        etag = header(site.serve(request("GET", "/app.js")), "ETag")
        for offered in (etag, "W/" + etag, f'"other", {etag}', f"{etag} , W/\"x\""):
            with self.subTest(offered=offered):
                response = site.serve(request("GET", "/app.js", {"If-None-Match": offered}))
                self.assertEqual((response.status, response.body, header(response, "Content-Length")), (304, b"", "0"))
                self.assertEqual((header(response, "ETag"), header(response, "Cache-Control")), (etag, "no-cache"))
        for offered in ('"other"', "", "*"):
            with self.subTest(offered=offered):
                self.assertEqual(site.serve(request("GET", "/app.js", {"If-None-Match": offered})).status, 200)

    def test_a_conditional_head_is_also_304(self):
        site = self.load()
        etag = header(site.serve(request("GET", "/app.js")), "ETag")
        self.assertEqual(site.serve(request("HEAD", "/app.js", {"if-none-match": etag})).status, 304)

    def test_head_has_the_length_of_the_file_and_no_body(self):
        site = self.load()
        head = site.serve(request("HEAD", "/app.js"))
        get = site.serve(request("GET", "/app.js"))
        self.assertEqual((head.status, head.body, header(head, "Content-Length")), (200, b"", str(len(get.body))))
        self.assertEqual(head.headers, get.headers)
        index = site.serve(request("HEAD", "/queue"))
        self.assertEqual((index.body, header(index, "Content-Length")), (b"", str(len(INDEX))))

    def test_content_length_is_the_body_length_for_a_get(self):
        site = self.load()
        for path in ("/", "/app.js", "/app.css"):
            response = site.serve(request("GET", path))
            self.assertEqual(header(response, "Content-Length"), str(len(response.body)))


class HardeningTests(Folder):
    def test_the_default_limits_are_the_documented_ones(self):
        self.assertEqual((bundle.MAX_FILES, bundle.MAX_FILE_BYTES, bundle.MAX_TOTAL_BYTES), (4096, 16 * 1024 * 1024, 128 * 1024 * 1024))

    def test_an_entry_cannot_be_changed_after_the_load(self):
        entry = self.load()._entries["/app.js"]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            entry.body = b""
        self.assertFalse(hasattr(entry, "__dict__"))

    def test_the_served_paths_are_listed_sorted(self):
        self.assertEqual(self.load().paths, ("/app.css", "/app.js", "/index.html"))

    def test_every_bad_folder_argument_is_refused_for_that_reason(self):
        (self.root / "plain").write_bytes(b"x")
        for argument in (5, None, "relative", ".", "/with\0nul", str(self.root / "absent"), str(self.root / "plain")):
            with self.subTest(argument=repr(argument)):
                with self.assertRaisesRegex(bundle.BundleRefused, r"^bundle folder is invalid$"):
                    bundle.Bundle.load(argument)

    def test_a_dot_folder_and_a_linked_folder_are_skipped_and_listed_and_their_files_not_served(self):
        self.put({"index.html": INDEX, ".hidden/inner.js": b"x", "real/inner.js": b"y"})
        os.symlink(self.root / "real", self.root / "linked")
        site = bundle.Bundle.load(str(self.root))
        self.assertEqual(site.skipped, (".hidden/", "linked/"))
        self.assertEqual(site.paths, ("/index.html", "/real/inner.js"))

    def test_a_file_is_read_up_to_its_limit_and_no_further(self):
        path = self.root / "five"
        path.write_bytes(b"abcde")
        self.assertEqual(bundle._read(str(path), 5), b"abcde")
        with self.assertRaisesRegex(bundle.BundleRefused, r"^bundle file is too large$"):
            bundle._read(str(path), 4)

    def test_a_device_is_not_a_plain_file(self):
        with self.assertRaisesRegex(bundle.BundleRefused, r"^bundle file is not a plain file$"):
            bundle._read("/dev/null", 10)

    def test_each_start_refusal_says_why_in_one_fixed_sentence(self):
        cases = (
            ({}, {}, "bundle has no index.html"),
            ({"index.html": INDEX, "a.js": b"1", "b.js": b"2"}, {"max_files": 2}, "bundle has too many files"),
            ({"index.html": INDEX}, {"max_file_bytes": len(INDEX) - 1, "max_total_bytes": 1}, "bundle file is too large"),
            ({"index.html": INDEX, "a.js": b"1" * 10}, {"max_file_bytes": len(INDEX), "max_total_bytes": len(INDEX) + 5}, "bundle is too large"),
        )
        for files, limits, text in cases:
            with self.subTest(text=text):
                folder = tempfile.TemporaryDirectory()
                self.addCleanup(folder.cleanup)
                for name, data in files.items():
                    (Path(folder.name) / name).write_bytes(data)
                with self.assertRaisesRegex(bundle.BundleRefused, "^" + re.escape(text) + "$"):
                    bundle.Bundle.load(folder.name, **limits)

    def test_a_target_with_a_scheme_a_host_or_a_fragment_is_never_served(self):
        site = self.load()
        for target in ("/app.js#frag", "http://x/app.js", "//x/app.js", "/#frag"):
            with self.subTest(target=target):
                self.assertIsNone(site.serve(request("GET", target)))


if __name__ == "__main__":
    unittest.main()
