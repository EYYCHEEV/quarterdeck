import json
import random
import string
import time
import unicodedata
import unittest

from test_chat import OTHER, OWN, ChatCase, chat_body

import qd_connect


HOW_ONE = "Write it as [words](your full https address), because the app opens only https links. Addresses inside code are left alone."
HOW_MANY = "Write each as [words](your full https address), because the app opens only https links. Addresses inside code are left alone."


def first_address(text):
    return next((address for _, address in qd_connect.bare_addresses(text)), None)


def listed(places):
    distinct = list(dict.fromkeys(places))
    names = [str(place) for place in distinct[:10]]
    if len(distinct) > 10:
        return ", ".join(names) + " and more"
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def refusal(places, card=False):
    if len(places) == 1:
        where = f"in the card's {places[0]}" if card else f"on line {places[0]}"
        return f"Refused, nothing sent: the message holds a bare web address {where}, and the Captain cannot click it. {HOW_ONE}"
    where = f"in the card's {listed(places)}" if card else f"on lines {listed(places)}"
    return f"Refused, nothing sent: the message holds {len(places)} bare web addresses, {where}, and the Captain cannot click them. {HOW_MANY}"


def chat_shape(text):
    return f"CHAT: {OWN}", chat_body(text)


def mail_shape(text):
    return "Quarterdeck reply", text


ADDRESS_TABLE = (
    ("see https://example.com/x", "https://example.com/x", [1]),
    ("see https://example.com/x.", "https://example.com/x", [1]),
    ("(https://example.com/x)", "https://example.com/x", [1]),
    ("<https://example.com/x>", "https://example.com/x", [1]),
    ('"https://example.com/x", then', "https://example.com/x", [1]),
    ("**https://example.com/x**", "https://example.com/x", [1]),
    ("HTTP://Example.com/X", "HTTP://Example.com/X", [1]),
    ("http://example.com/x", "http://example.com/x", [1]),
    ("a https://example.com/1 b https://example.com/2", "https://example.com/1", [1, 1]),
    ("[words](https://example.com/1) then https://example.com/2", "https://example.com/2", [1]),
    ("https://en.wikipedia.org/wiki/Python_(language)", "https://en.wikipedia.org/wiki/Python_(language)", [1]),
    ("```\ncode\n```\nhttps://example.com/x", "https://example.com/x", [4]),
    ("    ```\nhttps://example.com/x", "https://example.com/x", [2]),
    ("> https://example.com/x", "https://example.com/x", [1]),
    ("https://example.com/x`code`", "https://example.com/x", [1]),
    ("- https://example.com/x", "https://example.com/x", [1]),
    ("| https://example.com/x | y |", "https://example.com/x", [1]),
    ("https://example.com/a]b", "https://example.com/a]b", [1]),
    ("```sh extra\nhttps://example.com/x", "https://example.com/x", [2]),
)

CODE_AND_LINK_TABLE = (
    "[words](https://example.com/x)",
    "[https://example.com/x](https://example.com/x)",
    "run `curl https://example.com/x` now",
    "`https://example.com/x`",
    "```sh\ncurl https://example.com/x\n```",
    "~~~\nhttps://example.com/x\n~~~",
    "```\nhttps://example.com/x",
    "````\n```\nhttps://example.com/x\n```\n````",
    "~~~\n```\nhttps://example.com/x\n~~~",
    "> ```\n> https://example.com/x\n> ```",
    "```\r\nhttps://example.com/x\r\n```\r\n",
    "use https:// first",
    "https://.",
    "ftp://example.com/x",
    "no address here",
    "[Launcher review page](HTTPS://EXAMPLE.COM/x) is ready.",
    "- [words](https://example.com/x)\n- done",
    "```\nhttps://example.com/x\n``` ",
    "``` sh\nhttps://example.com/x\n```",
)

CARD_ID = f"{OWN}-12"
CARD_SUBJECT = "CARD: Pick the launcher layout"
LEARN = "https://learn.example.com/launcher"
RUN = "curl https://run.example.com/check"
FREE = "https://free.example.com/text"

FREE_TEXT_PATHS = (
    ("about",),
    ("context",),
    ("title",),
    ("pick_why",),
    ("you_do",),
    ("skip",),
    ("note",),
    ("options", 0, "does"),
    ("options", 1, "label"),
    ("words", 0, 1),
    ("commands", 0, "where"),
    ("learn", 0, "label"),
)


def card_body(**changes):
    card = {
        "learn": [{"label": "Launcher review page", "url": LEARN}],
        "commands": [{"where": "On the dev server", "run": RUN}],
        "qd": "card/1",
        "card": CARD_ID,
        "id": CARD_ID,
        "project": "Launcher",
        "title": "Pick the launcher layout",
        "about": "The launcher is the first screen a person sees.",
        "context": "Two layouts are ready.\nThe review page shows both.",
        "category": ["try-it"],
        "options": [
            {"label": "A. Keep the grid", "pick": True, "does": "Keeps today's grid."},
            {"label": "B. Use the list", "pick": False, "does": "Switches to a list."},
        ],
        "pick_why": "The grid is what people know.",
        "words": [["Launcher", "The first screen."]],
        "you_do": "Pick one.",
        "skip": "Skip it to keep the grid.",
        "note": "Longer note.\n\n```\nart\n```",
    }
    card.update(changes)
    return card


def put(card, path, value):
    node = card
    for step in path[:-1]:
        node = node[step]
    node[path[-1]] = value
    return card


def card_with(path, value):
    return put(card_body(), path, value)


def mail_json(document):
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


class LinkCase(ChatCase):
    def cli_chat(self, text, number):
        code, out, err = self.cli("chat", "--resend-id", f"link-{number}", stdin=text)
        return code == 0, out, err

    def cli_send(self, text, number):
        code, out, err = self.send_cli("captain", f"CHAT: {OWN}", chat_body(text), f"link-{number}")
        return code == 0, out, err

    def cli_mail(self, text, number):
        code, out, err = self.send_cli("captain", "Quarterdeck reply", text, f"link-{number}", "--mail-to-captain")
        return code == 0, out, err

    def mcp_outcome(self, name, arguments):
        result = self.mcp(name, arguments)
        [part] = result["content"]
        return not result.get("isError", False), "", part["text"]

    def mcp_chat(self, text, number):
        return self.mcp_outcome("qd_chat", {"text": text, "resend_id": f"link-{number}"})

    def mcp_send(self, text, number):
        return self.mcp_outcome(
            "qd_send",
            {"to": "captain", "subject": f"CHAT: {OWN}", "body": chat_body(text), "resend_id": f"link-{number}"},
        )

    def mcp_mail(self, text, number):
        return self.mcp_outcome(
            "qd_send",
            {
                "to": "captain",
                "subject": "Quarterdeck reply",
                "body": text,
                "resend_id": f"link-{number}",
                "mail_to_captain": True,
            },
        )

    def paths(self):
        return (
            ("qd chat", self.cli_chat, "\n", chat_shape),
            ("qd send with a chat body", self.cli_send, "\n", chat_shape),
            ("qd send --mail-to-captain", self.cli_mail, "\n", mail_shape),
            ("qd_chat", self.mcp_chat, "", chat_shape),
            ("qd_send with a chat body", self.mcp_send, "", chat_shape),
            ("qd_send with mail_to_captain", self.mcp_mail, "", mail_shape),
        )

    def assert_refused_everywhere(self, text, lines):
        for number, (name, run, end, _) in enumerate(self.paths()):
            with self.subTest(path=name, text=text):
                self.assertEqual(run(text, number), (False, "", refusal(lines) + end))
        self.assert_nothing_left_the_machine()

    def assert_sent_everywhere(self, text):
        expected = []
        for number, (name, run, _, shape) in enumerate(self.paths()):
            with self.subTest(path=name, text=text):
                sent, _, _ = run(text, number)
                self.assertTrue(sent)
                expected.append(shape(text))
        self.assertEqual(sorted(self.delivered("captain")), sorted(expected))


class BareAddressRefusalTests(LinkCase):
    def test_a_bare_https_address_is_refused_on_every_path(self):
        self.assert_refused_everywhere("Review it at https://example.com/x/review please", [1])

    def test_a_bare_http_address_is_refused_on_every_path(self):
        self.assert_refused_everywhere("Review it at http://example.com/x please", [1])

    def test_an_upper_case_scheme_is_refused_on_every_path(self):
        self.assert_refused_everywhere("Review it at HTTPS://Example.com/X please", [1])

    def test_trailing_punctuation_is_not_part_of_the_found_address(self):
        text = "see https://example.com/x."

        self.assertEqual(first_address(text), "https://example.com/x")
        self.assert_refused_everywhere(text, [1])

    def test_every_bare_address_is_counted_with_its_line(self):
        self.assert_refused_everywhere(
            "[ok](https://zero.example.com/0) then https://one.example.com/1 and https://two.example.com/2\nhttps://three.example.com/3",
            [1, 1, 2],
        )

    def test_a_line_number_counts_the_lines_of_a_code_block_before_it(self):
        self.assert_refused_everywhere(
            "Run:\n```sh\ncurl https://example.com/in\n```\nthen see https://example.com/out",
            [5],
        )

    def test_lines_are_counted_across_every_kind_of_line_break(self):
        for number, separator in enumerate(("\n", "\r\n", "\r")):
            with self.subTest(separator=separator):
                text = f"one{separator}two{separator}see https://example.com/x"
                with self.assertRaises(qd_connect.MailRefused) as caught:
                    self.service.send("captain", "Quarterdeck reply", text, f"break-{number}", mail_to_captain=True)
                self.assertEqual(caught.exception.text("cli"), refusal([3]))
        self.assert_nothing_left_the_machine()

    def test_the_address_table_is_found_and_refused_with_its_lines(self):
        for number, (text, address, lines) in enumerate(ADDRESS_TABLE):
            with self.subTest(text=text):
                self.assertEqual(first_address(text), address)
                with self.assertRaises(qd_connect.MailRefused) as caught:
                    self.service.send("captain", f"CHAT: {OWN}", chat_body(text), f"table-{number}")
                self.assertEqual(caught.exception.text("cli"), refusal(lines))
        self.assert_nothing_left_the_machine()

    def test_both_surfaces_give_the_same_words(self):
        with self.assertRaises(qd_connect.MailRefused) as caught:
            self.service.send("captain", f"CHAT: {OWN}", chat_body("see https://example.com/x"), "r1")

        self.assertEqual(caught.exception.text("cli"), refusal([1]))
        self.assertEqual(caught.exception.text("mcp"), refusal([1]))
        self.assertIsInstance(caught.exception, qd_connect.ConnectRefused)
        self.assert_nothing_left_the_machine()

    def test_plain_mail_without_the_flag_keeps_its_own_refusal(self):
        for number, text in enumerate(("see https://example.com/x", "no address")):
            with self.subTest(text=text):
                with self.assertRaises(qd_connect.MailRefused) as caught:
                    self.service.send("captain", "Quarterdeck reply", text, f"plain-{number}")
                self.assertIn("mail to captain must be a chat message", caught.exception.text("cli"))
        self.assert_nothing_left_the_machine()


class WhatIsSentTests(LinkCase):
    def test_a_markdown_link_is_sent_unchanged_on_every_path(self):
        self.assert_sent_everywhere("Read [Launcher review page](https://example.com/x) first.")

    def test_an_address_in_a_code_span_is_sent_unchanged_on_every_path(self):
        self.assert_sent_everywhere("Run `curl https://example.com/x` first.")

    def test_an_address_in_a_fenced_block_is_sent_unchanged_on_every_path(self):
        self.assert_sent_everywhere("Run:\n\n```sh\ncurl https://example.com/x\n```\n\nThen wait.")

    def test_the_code_and_link_table_is_sent(self):
        for number, text in enumerate(CODE_AND_LINK_TABLE):
            with self.subTest(text=text):
                self.service.send("captain", f"CHAT: {OWN}", chat_body(text), f"table-{number}")
        self.assertEqual(len(self.delivered("captain")), len(CODE_AND_LINK_TABLE))

    def test_long_lines_that_look_like_links_are_checked_quickly(self):
        texts = ("[" * 100000, "[a](" * 25000, "`a" * 50000, "x" * 100000, "```" + " " * 100000 + "!")
        started = time.monotonic()

        for number, text in enumerate(texts):
            self.service.send("captain", f"CHAT: {OWN}", chat_body(text), f"long-{number}")

        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(len(self.delivered("captain")), len(texts))

    def test_only_the_text_field_of_a_chat_message_is_checked(self):
        body = chat_body("hello", note="https://example.com/x")

        self.service.send("captain", f"CHAT: {OWN}", body, "extra-1")

        self.assertEqual(self.delivered("captain"), [(f"CHAT: {OWN}", body)])

    def test_mail_to_another_bot_with_a_bare_address_is_sent_unchanged(self):
        text = "see https://example.com/x and HTTP://EXAMPLE.COM/Y"
        chat_shaped = chat_body(text, bot=OTHER)
        code, _, err = self.send_cli(OTHER, "Status", text, "other-1")
        self.assertEqual((code, err), (0, ""))
        code, _, err = self.send_cli(OTHER, f"CHAT: {OTHER}", chat_shaped, "other-2", "--mail-to-captain")
        self.assertEqual((code, err), (0, ""))
        result = self.mcp("qd_send", {"to": OTHER, "subject": "Status", "body": text, "resend_id": "other-3"})
        self.assertFalse(result.get("isError", False))
        result = self.mcp(
            "qd_send",
            {"to": OTHER, "subject": "Status", "body": text, "resend_id": "other-4", "mail_to_captain": True},
        )
        self.assertFalse(result.get("isError", False))

        self.assertEqual(
            sorted(self.delivered(OTHER)),
            sorted([("Status", text), (f"CHAT: {OTHER}", chat_shaped), ("Status", text), ("Status", text)]),
        )
        self.assertEqual(self.delivered("captain"), [])


class CardMailTests(LinkCase):
    def send_to_captain(self, subject, body, number):
        return self.service.send("captain", subject, body, f"card-{number}", mail_to_captain=True)

    def assert_refused(self, subject, body, expected, number=0):
        with self.assertRaises(qd_connect.MailRefused) as caught:
            self.send_to_captain(subject, body, number)
        self.assertEqual(caught.exception.text("cli"), expected)

    def test_a_card_with_learn_and_command_links_is_sent_unchanged(self):
        body = mail_json(card_body())

        code, _, err = self.send_cli("captain", CARD_SUBJECT, body, "card-cli", "--mail-to-captain")
        result = self.mcp(
            "qd_send",
            {
                "to": "captain",
                "subject": CARD_SUBJECT,
                "body": body,
                "resend_id": "card-mcp",
                "mail_to_captain": True,
            },
        )

        self.assertEqual((code, err), (0, ""))
        self.assertFalse(result.get("isError", False))
        self.assertEqual(self.delivered("captain"), [(CARD_SUBJECT, body)] * 2)

    def test_an_update_with_a_learn_link_is_sent_unchanged(self):
        subject = f"UPDATE: {CARD_ID}"
        body = mail_json(
            {
                "learn": [{"label": "Launcher review page", "url": LEARN}],
                "qd": "update/1",
                "card": CARD_ID,
                "rev": 2,
                "note": "Updated note.",
            }
        )

        self.send_to_captain(subject, body, 1)

        self.assertEqual(self.delivered("captain"), [(subject, body)])

    def test_a_bare_address_in_card_text_is_refused_naming_its_field(self):
        for number, path in enumerate(FREE_TEXT_PATHS):
            with self.subTest(path=path):
                body = mail_json(card_with(path, f"See {FREE} for more"))
                self.assert_refused(CARD_SUBJECT, body, refusal([path[0]], True), number)
        self.assert_nothing_left_the_machine()

    def test_a_bare_address_in_an_update_note_is_refused_naming_its_field(self):
        body = mail_json(
            {
                "learn": [{"label": "Launcher review page", "url": LEARN}],
                "qd": "update/1",
                "card": CARD_ID,
                "rev": 2,
                "note": f"See {FREE}",
            }
        )

        self.assert_refused(f"UPDATE: {CARD_ID}", body, refusal(["note"], True))
        self.assert_nothing_left_the_machine()

    def test_a_card_refusal_prints_the_full_words(self):
        body = mail_json(card_with(("context",), f"See {FREE}"))

        code, out, err = self.send_cli("captain", CARD_SUBJECT, body, "card-cli", "--mail-to-captain")

        self.assertEqual((code, out, err), (2, "", refusal(["context"], True) + "\n"))
        self.assert_nothing_left_the_machine()

    def test_a_comment_and_a_withdraw_are_checked_in_every_field(self):
        comment = f"COMMENT: {CARD_ID}"
        withdraw = f"WITHDRAW: {CARD_ID}"
        linked = mail_json({"qd": "comment/1", "card": CARD_ID, "text": "Read [the page](https://example.com/x) first."})
        refused = (
            (comment, mail_json({"qd": "comment/1", "card": CARD_ID, "text": f"See {FREE}"}), "text"),
            (withdraw, mail_json({"qd": "withdraw/1", "card": CARD_ID, "why": f"See {FREE}"}), "why"),
            (
                comment,
                mail_json({"qd": "comment/1", "card": CARD_ID, "text": "x", "learn": [{"label": "a", "url": LEARN}]}),
                "learn",
            ),
        )

        for number, (subject, body, field) in enumerate(refused):
            with self.subTest(subject=subject):
                self.assert_refused(subject, body, refusal([field], True), number)
        self.send_to_captain(comment, linked, 9)

        self.assertEqual(self.delivered("captain"), [(comment, linked)])

    def test_a_bare_address_under_a_key_the_card_format_does_not_have_is_named_as_other_fields(self):
        body = mail_json(card_body(**{"https://key.example.com/secret": f"See {FREE}"}))

        self.assert_refused(CARD_SUBJECT, body, refusal(["other fields"], True))
        self.assert_nothing_left_the_machine()

    def test_a_body_that_only_looks_like_a_card_is_checked_whole(self):
        good = mail_json(card_body())
        cases = (
            ("Quarterdeck reply", good),
            (CARD_SUBJECT, mail_json(card_body(qd="card/2"))),
            (CARD_SUBJECT, good[:-1] + ',"id":"other"}'),
            (CARD_SUBJECT, mail_json([card_body()])),
            (CARD_SUBJECT + "\nmore", good),
            (f"ANSWER: {CARD_ID} A", mail_json(card_body(qd="answer/1"))),
        )

        for number, (subject, body) in enumerate(cases):
            with self.subTest(subject=subject, body=body[:40]):
                self.assert_refused(subject, body, refusal([1, 1]), number)
        self.assert_nothing_left_the_machine()

    def test_only_a_list_of_link_objects_is_left_to_the_app(self):
        cases = (
            (card_body(learn=LEARN), "learn"),
            (card_body(learn=[LEARN]), "learn"),
            (card_body(learn=[{"label": "a", "url": [LEARN]}]), "learn"),
            (card_body(learn={"a": {"label": "a", "url": LEARN}}), "learn"),
            (card_body(learn=[{"label": "a", "url": LEARN, "extra": FREE}]), "learn"),
            (card_body(commands=[{"where": "On the dev server", "run": RUN, "extra": FREE}]), "commands"),
            (card_body(commands=RUN), "commands"),
        )

        for number, (card, field) in enumerate(cases):
            with self.subTest(card=mail_json(card)[:60]):
                self.assert_refused(CARD_SUBJECT, mail_json(card), refusal([field], True), number)
        self.assert_nothing_left_the_machine()

    def test_a_mail_body_that_is_not_a_card_is_still_checked_whole(self):
        bodies = (f"see {FREE}", mail_json({"note": f"see {FREE}"}), mail_json({"url": LEARN}))

        for number, body in enumerate(bodies):
            with self.subTest(body=body):
                self.assert_refused("Quarterdeck reply", body, refusal([1]), number)
        self.assert_nothing_left_the_machine()


STOPPING = (
    ("an escape", "\x1b"),
    ("a bell", "\x07"),
    ("a delete", "\x7f"),
    ("a next line", "\x85"),
    ("a bidi override", "\u202e"),
    ("a zero width space", "\u200b"),
    ("a byte order mark", "\ufeff"),
    ("a soft hyphen", "\xad"),
    ("a no-break space", "\xa0"),
    ("an ideographic space", "\u3000"),
    ("a line separator", "\u2028"),
    ("a paragraph separator", "\u2029"),
    ("a private use character", "\ue000"),
    ("an unassigned character", "\u0378"),
    ("a double quote", '"'),
    ("a single quote", "'"),
    ("a left single quote", "\u2018"),
    ("a right single quote", "\u2019"),
    ("a left double quote", "\u201c"),
    ("a right double quote", "\u201d"),
)

SWEPT = frozenset({"Cc", "Cf", "Zs", "Zl", "Zp"})
SAMPLED = frozenset({"Co", "Cn"})
SAMPLE_STEP = 997
EDGES = ("\ue000", "\uf8ff", "\U000f0000", "\U0010fffd", "\u0378", "\uffff", "\U0010ffff")

SEEDS = (7, 2026, 424242)
MESSAGES_PER_SEED = 400
CARDS_PER_SEED = 150
ADDRESS_POOL = string.ascii_letters + string.digits + "-._~:/?#&=+%@,;\\[]()!*$^{}"
ADDRESS_STARTS = ("", "public.example\\@", "exa%2Emple.example/", "user:pw@host.example:8443/", "x.example/")
WORDS = ("see", "open", "the", "page", "and", "now", "-", "*", "ok.", "x,")
SEPARATORS = ("\n", "\r\n", "\r")
SECRET_SHAPES = (
    "Reset it at https://example.com/reset/SECRETSEGMENT9/confirm now",
    "Open https://example.com/x?SECRETNAME9=1 now",
    "Open https://user:password@example.com/x now",
    "Open https://example.com/x?token=abc123&page=2 now",
    "Open https://example.com/x#secret-part now",
    "Open https://example.com/a\\b now",
    "Open http://example.com:8080/x now",
    "Open HTTPS://Example.com/X now",
    "Open https://exa_mple.com/x now",
    "Open https://ex%41mple.com/x now",
    "Open https://example.com/a\x1b[2Jb\x07c now",
    "Open https://example.com/a\u202eb now",
    'Open https://example.com/a"b now',
    "Open https://example.com/a\u201cb now",
    "Open https://exa\x1b[2Jmple.com/x now",
    "Open https://" + "a" * 5000 + ".example.com/x now",
)


def stopping_characters():
    found = list(EDGES)
    for code in range(0x110000):
        character = chr(code)
        category = unicodedata.category(character)
        if category in SWEPT or (category in SAMPLED and code % SAMPLE_STEP == 0):
            found.append(character)
    return found


class ScannerEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.swept = stopping_characters()

    def test_the_address_ends_before_each_stopping_character(self):
        for name, character in STOPPING:
            with self.subTest(name=name):
                text = f"see https://example.com/a{character}b now"
                self.assertEqual(first_address(text), "https://example.com/a")

    def test_the_address_ends_before_every_control_format_separator_private_and_unassigned_character(self):
        missed = [
            f"{ord(character):04X}"
            for character in self.swept
            if first_address(f"https://example.com/x{character}y") != "https://example.com/x"
        ]

        self.assertGreater(len(self.swept), 1000)
        self.assertEqual((len(missed), missed[:10]), (0, []))

    def test_the_text_after_the_stop_is_scanned_as_ordinary_text(self):
        cases = (
            ("https://\u200bhttps://example.com/y", "https://example.com/y"),
            ("https://\u200b[words](https://example.com/y)", None),
            ('https://example.com/x"[words](https://example.com/y)', "https://example.com/x"),
            ("\u200b`https://example.com/y`", None),
            ("see \u200b https://example.com/y", "https://example.com/y"),
        )

        for text, address in cases:
            with self.subTest(text=text):
                self.assertEqual(first_address(text), address)

    def test_long_lines_with_many_stops_are_scanned_quickly(self):
        texts = ("https://\u200b" * 30000, "https://a\x1b" * 30000, 'https://"' * 40000, "\xe9" * 100000, "x\u200b" * 100000)
        started = time.monotonic()

        for text in texts:
            first_address(text)

        self.assertLess(time.monotonic() - started, 5.0)


def random_address(rng):
    scheme = rng.choice(("http", "https", "HTTP", "HTTPS", "Https"))
    start = rng.choice(ADDRESS_STARTS)
    body = "".join(rng.choice(ADDRESS_POOL) for _ in range(rng.randint(1, 40)))
    return f"{scheme}://{start}{body}z"


def random_lines(rng):
    lines = []
    places = []
    for number in range(1, rng.randint(1, 14) + 1):
        words = [rng.choice(WORDS) for _ in range(rng.randint(0, 3))]
        if rng.random() < 0.5:
            for _ in range(rng.randint(1, 3)):
                words.insert(rng.randint(0, len(words)), random_address(rng))
                places.append(number)
        lines.append(" ".join(words))
    if not places:
        lines[-1] = f"{lines[-1]} {random_address(rng)}".strip()
        places.append(len(lines))
    return lines, places


def random_text(rng):
    lines, places = random_lines(rng)
    text = lines[0]
    for before, line in zip(lines, lines[1:]):
        text += ("\n" if not before or not line else rng.choice(SEPARATORS)) + line
    return text, places


class RefusalNamesNothingTests(LinkCase):
    def test_the_refusal_is_the_fixed_words_whatever_the_address_holds(self):
        for text in SECRET_SHAPES:
            self.assert_refused_everywhere(text, [1])

    def test_a_backslash_before_an_at_sign_in_the_site_part_is_refused_without_naming_it(self):
        self.assert_refused_everywhere("Open https://public.example\\@SUFFIXSECRET/reset/TOKEN123 now", [1])

    def test_an_encoded_dot_in_the_host_is_refused_without_naming_it(self):
        self.assert_refused_everywhere("Open https://exa%2Emple.example/reset/TOKEN123 now", [1])

    def test_a_lone_surrogate_in_an_address_still_gets_the_fixed_words(self):
        body = chat_body("see https://exa\ud800mple.com/x now")

        with self.assertRaises(qd_connect.MailRefused) as caught:
            self.service.send("captain", f"CHAT: {OWN}", body, "r1")

        self.assertEqual(caught.exception.text("cli"), refusal([1]))
        self.assert_nothing_left_the_machine()


class RefusalWordsTests(LinkCase):
    def words_for(self, text, number):
        with self.assertRaises(qd_connect.MailRefused) as caught:
            self.service.send("captain", f"CHAT: {OWN}", chat_body(text), f"words-{number}")
        return caught.exception.text("cli")

    def test_one_address_gets_the_words_for_one_address(self):
        self.assertEqual(
            self.words_for("Hello.\nSee https://example.com/x now", 0),
            "Refused, nothing sent: the message holds a bare web address on line 2, and the Captain cannot click it. "
            "Write it as [words](your full https address), because the app opens only https links. "
            "Addresses inside code are left alone.",
        )

    def test_several_addresses_get_the_count_and_the_lines(self):
        text = "https://a.example.com/1 https://b.example.com/2\nno link\nhttps://c.example.com/3\n\n\n\nhttps://d.example.com/4"

        self.assertEqual(
            self.words_for(text, 1),
            "Refused, nothing sent: the message holds 4 bare web addresses, on lines 1, 3 and 7, and the Captain cannot click them. "
            "Write each as [words](your full https address), because the app opens only https links. "
            "Addresses inside code are left alone.",
        )

    def test_ten_lines_are_all_listed(self):
        text = "\n".join(f"https://example.com/{number}" for number in range(10))

        self.assertEqual(
            self.words_for(text, 2),
            "Refused, nothing sent: the message holds 10 bare web addresses, on lines 1, 2, 3, 4, 5, 6, 7, 8, 9 and 10, and the Captain cannot click them. "
            "Write each as [words](your full https address), because the app opens only https links. "
            "Addresses inside code are left alone.",
        )

    def test_more_than_ten_lines_end_with_and_more(self):
        text = "\n".join(f"https://example.com/{number}" for number in range(12))

        self.assertEqual(
            self.words_for(text, 3),
            "Refused, nothing sent: the message holds 12 bare web addresses, on lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and more, and the Captain cannot click them. "
            "Write each as [words](your full https address), because the app opens only https links. "
            "Addresses inside code are left alone.",
        )

    def test_a_card_field_is_named_in_place_of_the_line(self):
        body = mail_json(card_with(("note",), f"See {FREE}"))

        with self.assertRaises(qd_connect.MailRefused) as caught:
            self.service.send("captain", CARD_SUBJECT, body, "words-4", mail_to_captain=True)

        self.assertEqual(
            caught.exception.text("cli"),
            "Refused, nothing sent: the message holds a bare web address in the card's note, and the Captain cannot click it. "
            "Write it as [words](your full https address), because the app opens only https links. "
            "Addresses inside code are left alone.",
        )

    def test_several_card_fields_are_named_in_the_order_of_the_card(self):
        card = card_with(("note",), f"See {FREE}")
        put(card, ("context",), f"See {FREE} and {FREE}")
        body = mail_json(card)

        with self.assertRaises(qd_connect.MailRefused) as caught:
            self.service.send("captain", CARD_SUBJECT, body, "words-5", mail_to_captain=True)

        self.assertEqual(
            caught.exception.text("cli"),
            "Refused, nothing sent: the message holds 3 bare web addresses, in the card's context and note, and the Captain cannot click them. "
            "Write each as [words](your full https address), because the app opens only https links. "
            "Addresses inside code are left alone.",
        )


class RefusalPropertyTests(LinkCase):
    def test_the_refusal_text_is_exactly_the_fixed_words_for_its_count_and_lines(self):
        for seed in SEEDS:
            rng = random.Random(seed)
            for number in range(MESSAGES_PER_SEED):
                text, places = random_text(rng)
                message = f"seed={seed} number={number} text={text!r}"
                if number % 2:
                    subject, body = chat_shape(text)
                    options = {}
                else:
                    subject, body = mail_shape(text)
                    options = {"mail_to_captain": True}

                with self.assertRaises(qd_connect.MailRefused) as caught:
                    self.service.send("captain", subject, body, f"words-{seed}-{number}", **options)

                self.assertEqual(caught.exception.text("cli"), refusal(places), message)
                self.assertEqual(caught.exception.text("mcp"), refusal(places), message)
        self.assert_nothing_left_the_machine()

    def test_the_card_refusal_text_is_exactly_the_fixed_words_for_its_count_and_fields(self):
        for seed in SEEDS:
            rng = random.Random(seed)
            for number in range(CARDS_PER_SEED):
                card = card_body()
                counted = {}
                for path in rng.sample(FREE_TEXT_PATHS, rng.randint(1, 5)):
                    text, places = random_text(rng)
                    put(card, path, text)
                    counted[path[0]] = counted.get(path[0], 0) + len(places)
                expected = [field for field in card for _ in range(counted.get(field, 0))]
                body = mail_json(card)
                message = f"seed={seed} number={number} body={body!r}"

                with self.assertRaises(qd_connect.MailRefused) as caught:
                    self.service.send("captain", CARD_SUBJECT, body, f"fields-{seed}-{number}", mail_to_captain=True)

                self.assertEqual(caught.exception.text("cli"), refusal(expected, True), message)
        self.assert_nothing_left_the_machine()


if __name__ == "__main__":
    unittest.main(verbosity=2)
