import json
import os
import re
import unittest
from pathlib import Path
from unittest import mock

import qd_cards

ROOT = Path(__file__).resolve().parent
ENVIRONMENT = "QD_CARD_LINK_ORIGIN"
ORIGIN = "http://qd.example.invalid"
OLD_PATTERN = re.compile(r"http://qd\.example\.invalid:87[89][0-9](?:/[A-Za-z0-9._~%/?#=&+,;:@!$*()-]*)?")
PATH_CHARACTERS = "._~%/?#=&+,;:@!$*()-"
PORTS = ("", ":80", ":878", ":8779", ":8780", ":8781", ":8787", ":8789", ":8790", ":8799", ":8800", ":87870", ":87a7", ":-8787", ": 8787", ":08787")
TAILS = (
    "",
    "/",
    "/cards/1",
    "/a/b/c?d=e&f=g#h",
    "/" + PATH_CHARACTERS,
    "/Z9",
    "/a b",
    "/a<b",
    '/a"b',
    "/a\\b",
    "/a\nb",
    "/a\tb",
    "/\u00e9",
    "x",
    "?q=1",
    "#frag",
    "@evil.example.invalid",
)
OTHERS = (
    "",
    "http://QD.example.invalid:8787",
    "https://qd.example.invalid:8787",
    "http://qd.example.invalid.:8787",
    "http://a.qd.example.invalid:8787",
    "http://qd.example.invalid:8787@evil.example.invalid",
    "http://user@qd.example.invalid:8787",
    "http://evil.example.invalid:8787",
    "http://qd-example.invalid:8787",
    "http//qd.example.invalid:8787",
    " http://qd.example.invalid:8787",
    "http://qd.example.invalid:8787 ",
    "http://qd.example.invalid:8787\n",
)


def cases():
    out = [ORIGIN + port + tail for port in PORTS for tail in TAILS]
    out.extend(OTHERS)
    return out


class CardLinkOriginTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop(ENVIRONMENT, None)

    def test_the_setting_name_is_the_documented_one(self):
        self.assertEqual(qd_cards.CARD_LINK_ORIGIN_ENVIRONMENT, ENVIRONMENT)

    def test_unset_refuses_every_plain_http_card_link(self):
        for url in cases():
            with self.subTest(url=url):
                self.assertFalse(qd_cards.card_link_ok(url))
                if url.startswith("http://"):
                    self.assertFalse(qd_cards.learn_link_ok(url))

    def test_a_malformed_or_empty_setting_refuses_every_link(self):
        values = (
            "",
            " ",
            "qd.example.invalid",
            "https://qd.example.invalid",
            "http://",
            "http://qd.example.invalid:8787",
            "http://qd.example.invalid/",
            "http://qd.example.invalid ",
            "http://qd.example.invalid\n",
            "http://qd_example.invalid",
            "HTTP://qd.example.invalid",
        )
        for value in values:
            os.environ[ENVIRONMENT] = value
            for url in (ORIGIN + ":8787", ORIGIN + ":8787/x", value + ":8787", value + ":8787/x"):
                with self.subTest(value=value, url=url):
                    self.assertFalse(qd_cards.card_link_ok(url))
                    self.assertFalse(qd_cards.learn_link_ok(url) and url.startswith("http://"))

    def test_the_set_origin_and_the_old_pattern_agree_on_every_case(self):
        os.environ[ENVIRONMENT] = ORIGIN
        accepted = 0
        for url in cases():
            expected = OLD_PATTERN.fullmatch(url) is not None
            accepted += expected
            with self.subTest(url=url):
                self.assertEqual(qd_cards.card_link_ok(url), expected)
                if url.startswith("http://"):
                    self.assertEqual(qd_cards.learn_link_ok(url), expected)
        self.assertGreater(accepted, 20)

    def test_only_ports_8780_to_8799_are_accepted(self):
        os.environ[ENVIRONMENT] = ORIGIN
        for port in range(0, 65536):
            allowed = 8780 <= port <= 8799
            self.assertEqual(qd_cards.card_link_ok("%s:%d/x" % (ORIGIN, port)), allowed, port)

    def test_the_setting_chooses_the_origin(self):
        os.environ[ENVIRONMENT] = "http://other.example.invalid"
        self.assertTrue(qd_cards.card_link_ok("http://other.example.invalid:8787/x"))
        self.assertFalse(qd_cards.card_link_ok(ORIGIN + ":8787/x"))

    def test_https_learn_links_do_not_need_the_setting(self):
        self.assertTrue(qd_cards.learn_link_ok("https://example.com/release-guide"))
        self.assertFalse(qd_cards.learn_link_ok("https://example.com/a?utm_source=x"))
        self.assertFalse(qd_cards.learn_link_ok(None))
        self.assertFalse(qd_cards.learn_link_ok(7))

    def test_the_compose_overlay_carries_the_deploy_time_reference(self):
        diff = json.loads((ROOT / "compose-diff.json").read_text(encoding="utf-8"))
        environment = diff["integratedService"]["definition"]["environment"]
        self.assertEqual(environment[ENVIRONMENT], "${QD_CARD_LINK_ORIGIN}")


if __name__ == "__main__":
    unittest.main()
