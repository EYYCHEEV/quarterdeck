import json
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(HERE))

import application
import approval_security
from r3_helpers import CardChecker, R3Env
from test_chat_server import answer, stamp

BOT = "bot-b"
OTHER = "bot-c"
MESSAGE = "Can you check the door file?"
MID = "b1@qd.invalid"
CAPTAIN_ID = "c1@qd.invalid"
QID = "q1@qd.invalid"
CARD = {"cardId": "Q176", "version": 3}
BAD_QUOTE = {"id": "nope@qd.invalid", "text": "door"}
REFUSED = (422, {"error": "quote"})
USUAL = {"id", "from", "text", "at", "refs", "clientId", "uploadVerdicts", "csrf", "freshUntil"}

BAD_MESSAGE_QUOTES = (
    ("unknown id", {"id": "nope@qd.invalid", "text": "door"}),
    ("bot message of another thread", {"id": "o1@qd.invalid", "text": "Other thread"}),
    ("captain message of another thread", {"id": "o2@qd.invalid", "text": "Other captain"}),
    ("text not inside", {"id": MID, "text": "window"}),
    ("skipped middle word", {"id": MID, "text": "check door"}),
    ("wrong case", {"id": MID, "text": "can you"}),
    ("empty text", {"id": MID, "text": ""}),
    ("blank text", {"id": MID, "text": "  \n"}),
    ("text not a string", {"id": MID, "text": 5}),
    ("id not a string", {"id": 5, "text": "door"}),
    ("a string", MID),
    ("a list", [{"id": MID, "text": "door"}]),
    ("an empty object", {}),
    ("an extra key", {"id": MID, "text": "door", "extra": 1}),
    ("from key present", {"id": MID, "text": "door", "from": "bot"}),
    ("at key present", {"id": MID, "text": "door", "at": stamp(2)}),
    ("missing text", {"id": MID}),
    ("missing id", {"text": "door"}),
    ("id and card id", {"id": MID, "text": "door", "cardId": "Q176"}),
)

BAD_CARD_QUOTES = (
    ("unknown card", {"cardId": "Q999", "version": 1}),
    ("version 99", {"cardId": "Q176", "version": 99}),
    ("version 4", {"cardId": "Q176", "version": 4}),
    ("version 0", {"cardId": "Q176", "version": 0}),
    ("string version", {"cardId": "Q176", "version": "3"}),
    ("float version", {"cardId": "Q176", "version": 3.0}),
    ("bool version", {"cardId": "Q176", "version": True}),
    ("missing version", {"cardId": "Q176"}),
    ("extra key", {"cardId": "Q176", "version": 3, "extra": 1}),
    ("from key present", {"cardId": "Q176", "version": 3, "from": "bot"}),
)


def seeded(case, text=MESSAGE, **options):
    env = R3Env(case, **options)
    env.mail.bot_says(BOT, text, 1, identifier=MID)
    env.refresh()
    return env


def carded(case, text=MESSAGE):
    env = R3Env(case, checker=CardChecker())
    env.mail.bot_says(BOT, text, 1, identifier=MID)
    env.mail.card("Q176", 10, revisions=3)
    env.refresh()
    return env


def mail_env(case, quote, text="Hi", note=False):
    env = R3Env(case, checker=CardChecker())
    env.mail.captain_says(BOT, "Please check", 1, identifier=CAPTAIN_ID)
    env.mail.bot_says(BOT, MESSAGE, 2, identifier=MID)
    env.mail.bot_says(OTHER, "Other thread text", 3, identifier="o1@qd.invalid")
    env.mail.captain_says(OTHER, "Other captain text", 4, identifier="o2@qd.invalid")
    if note:
        env.mail.note(BOT, CAPTAIN_ID, 5, identifier="n1@qd.invalid")
    env.mail.card("Q176", 20, revisions=3)
    env.mail.bot_says(BOT, text, 30, identifier=QID, quote=quote)
    env.refresh()
    return env


def quote_of(text, identifier=MID):
    return {"id": identifier, "text": text}


def sent_body(env, number=0):
    return json.loads(env.mail.send_calls[number][2])


def find(body, identifier):
    return next(message for message in body["messages"] if message["id"] == identifier)


def shown_quote(env, identifier, bot=BOT):
    return find(env.thread(bot), identifier).get("quote", "missing")


def expected_quote(identifier, who, minute, text):
    return {"id": identifier, "from": who, "at": stamp(minute), "text": text}


class QuoteCase(unittest.TestCase):
    def sends(self, env, response, quote):
        status, body = answer(response)
        self.assertEqual(status, 200, body)
        self.assertEqual(len(env.mail.send_calls), 1)
        self.assertEqual(sent_body(env).get("quote", "missing"), quote)
        return body

    def refused(self, env, response):
        self.assertEqual(answer(response), REFUSED)
        self.assertEqual(env.mail.send_calls, [])

    def accepts(self, message, text):
        env = seeded(self, message)
        self.sends(env, env.send_with(BOT, "Reply", quote=quote_of(text)), quote_of(text))

    def rejects(self, message, text):
        env = seeded(self, message)
        self.refused(env, env.send_with(BOT, "Reply", quote=quote_of(text)))


class QuoteSendTests(QuoteCase):
    def test_a_message_quote_is_sent_in_the_mail_as_given(self):
        env = seeded(self)
        quote = quote_of("check the door")
        self.sends(env, env.send_with(BOT, "Reply", quote=quote), quote)

    def test_quote_text_is_kept_byte_for_byte_with_spaces_and_a_trailing_newline(self):
        env = seeded(self)
        quote = quote_of("  check the door  \n")
        self.sends(env, env.send_with(BOT, "Reply", quote=quote), quote)

    def test_the_mail_body_is_the_usual_chat_body_plus_the_quote(self):
        env = seeded(self)
        quote = quote_of("door")
        self.sends(env, env.send_with(BOT, "Reply", quote=quote, client_id="client-aaa"), quote)
        expected = {"qd": "chat/1", "bot": BOT, "text": "Reply", "clientId": "client-aaa", "fresh": False, "quote": quote}
        self.assertEqual(sent_body(env), expected)

    def test_a_send_without_a_quote_has_no_quote_key_and_the_old_body(self):
        env = seeded(self)
        self.assertEqual(env.send_with(BOT, "Hi", client_id="client-aaa").status, 200)
        expected = '{"qd":"chat/1","bot":"bot-b","text":"Hi","clientId":"client-aaa","fresh":false}'
        self.assertEqual(env.mail.send_calls, [(BOT, "CHAT: bot-b", expected, "chat:bot-b:client-aaa")])

    def test_a_quote_send_answers_like_any_send(self):
        env = seeded(self)
        status, body = answer(env.send_with(BOT, "Reply", quote=quote_of("door"), client_id="client-aaa"))
        self.assertEqual(status, 200)
        self.assertLessEqual(USUAL, set(body))
        self.assertEqual((body["from"], body["text"], body["clientId"]), ("captain", "Reply", "client-aaa"))
        self.assertEqual((body["refs"], body["uploadVerdicts"]), ([], []))

    def test_a_quote_send_is_one_mail_to_the_bot_with_the_chat_subject_and_resend_key(self):
        env = seeded(self)
        self.sends(env, env.send_with(BOT, "Reply", quote=quote_of("door"), client_id="client-aaa"), quote_of("door"))
        recipient, subject, body, key = env.mail.send_calls[0]
        self.assertEqual((recipient, subject, key), (BOT, "CHAT: bot-b", "chat:bot-b:client-aaa"))

    def test_the_row_last_is_the_new_message_after_a_quote_send_and_refresh(self):
        env = seeded(self)
        status, body = answer(env.send_with(BOT, "Reply", quote=quote_of("door")))
        self.assertEqual(status, 200)
        env.refresh()
        self.assertEqual(env.row(BOT)["last"], body["id"])

    def test_the_row_rev_changes_after_a_quote_send_and_refresh(self):
        env = seeded(self)
        before = env.row(BOT).get("rev")
        self.assertEqual(env.send_with(BOT, "Reply", quote=quote_of("door")).status, 200)
        env.refresh()
        after = env.row(BOT).get("rev")
        self.assertIsInstance(after, int)
        self.assertNotEqual(before, after)


class QuoteWordAcceptTests(QuoteCase):
    def test_the_whole_message_passes(self):
        self.accepts(MESSAGE, MESSAGE)

    def test_a_run_of_whole_words_passes(self):
        for text in ("check the door", "Can you", "you check", "door file", "Can you check the door file", "file"):
            with self.subTest(text=text):
                self.accepts(MESSAGE, text)

    def test_a_first_word_that_is_the_end_of_a_word_passes(self):
        for text in ("ou check the door", "n you check", "ou check the door fi"):
            with self.subTest(text=text):
                self.accepts(MESSAGE, text)

    def test_a_last_word_that_is_the_start_of_a_word_passes(self):
        for text in ("Can you check the do", "you check th", "Can yo"):
            with self.subTest(text=text):
                self.accepts(MESSAGE, text)

    def test_both_ends_partial_passes(self):
        for text in ("ou check the door fi", "n you check the d"):
            with self.subTest(text=text):
                self.accepts(MESSAGE, text)

    def test_a_one_word_quote_that_is_part_of_a_word_passes(self):
        for text in ("atche", "matches", "It", "tch", "ere"):
            with self.subTest(text=text):
                self.accepts("It matches here", text)

    def test_punctuation_in_the_quote_does_not_matter(self):
        for text in ("check the door file?", "\"check the door\"", "check, the door; file?!"):
            with self.subTest(text=text):
                self.accepts(MESSAGE, text)


class QuoteWordRefuseTests(QuoteCase):
    def test_a_first_word_that_is_not_the_end_of_a_word_is_422(self):
        for text in ("Ca you", "Ca you check"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_a_last_word_that_is_not_the_start_of_a_word_is_422(self):
        for text in ("check the oor", "Can you check the oo"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_a_skipped_middle_word_is_422(self):
        for text in ("check door", "Can check", "Can you the door"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_a_middle_word_that_the_message_has_elsewhere_but_not_in_that_place_is_422(self):
        self.rejects(MESSAGE, "Can door check")
        self.rejects("alpha other gamma mid", "alpha mid gamma")

    def test_a_part_word_in_the_middle_is_422(self):
        for text in ("Can yo check", "ou chec the"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_reordered_words_are_422(self):
        for text in ("door the check", "you Can", "file door"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_a_word_the_message_does_not_have_is_422(self):
        for text in ("check the window", "Can you fix", "please check the door"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_a_one_word_quote_that_is_in_no_word_is_422(self):
        for text in ("xyz", "doorr", "Cann"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_matching_is_case_sensitive(self):
        for text in ("can you", "CAN YOU", "Check the door", "DOOR"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)


class QuoteScriptTests(QuoteCase):
    def test_accented_words_match_as_written(self):
        message = "Caf\u00e9 d\u00e9j\u00e0 vu"
        for text in ("d\u00e9j\u00e0 vu", "j\u00e0 v", "d\u00e9j"):
            with self.subTest(text=text):
                self.accepts(message, text)

    def test_accents_are_not_folded(self):
        for message, text in (("Caf\u00e9 time", "Cafe time"), ("Caf\u00e9 time", "cafe"), ("Caf\u00e9 d\u00e9j\u00e0 vu", "deja vu")):
            with self.subTest(text=text):
                self.rejects(message, text)

    def test_cyrillic_words_match(self):
        message = "\u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440"
        for text in ("\u043c\u0438\u0440", message, "\u0438\u0432\u0435\u0442 \u043c"):
            with self.subTest(text=text):
                self.accepts(message, text)

    def test_cyrillic_matching_is_case_sensitive(self):
        message = "\u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440"
        self.rejects(message, "\u043f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440")

    def test_digits_count_as_words(self):
        for text in ("12 ready", "version 12", "2 ready"):
            with self.subTest(text=text):
                self.accepts("version 12 ready", text)

    def test_a_missing_digit_word_is_422(self):
        self.rejects("version 12 ready", "version ready")


class QuoteMarkdownTests(QuoteCase):
    LISTED = "- first item\n- second item\n\n**bold** word"

    def test_bullets_and_line_breaks_never_cause_a_refusal(self):
        for text in ("first item second item", "bold word", "item second"):
            with self.subTest(text=text):
                self.accepts(self.LISTED, text)

    def test_a_quote_that_carries_the_marks_passes(self):
        for text in ("- first item\n- second item", "**bold** word", "first item\n- second item"):
            with self.subTest(text=text):
                self.accepts(self.LISTED, text)

    def test_headings_quotes_and_code_marks_never_cause_a_refusal(self):
        self.accepts("# Title\n> quoted line\n`code` here", "Title quoted line code here")


class QuoteLinkTests(QuoteCase):
    DOCS = "See [the docs](https://example.com/a_b/c?x=1) now"

    def test_a_link_target_is_skipped(self):
        for text in ("See the docs now", "the docs now", "docs now"):
            with self.subTest(text=text):
                self.accepts(self.DOCS, text)

    def test_words_of_a_link_target_are_not_in_the_message(self):
        for text in ("the docs https example", "docs https", "example com", "x 1"):
            with self.subTest(text=text):
                self.rejects(self.DOCS, text)

    def test_a_target_with_balanced_parentheses_is_skipped(self):
        self.accepts("[x](https://e.com/a_(b)) then", "x then")

    def test_words_of_a_balanced_parenthesis_target_are_not_in_the_message(self):
        for text in ("x b then", "e com", "b then"):
            with self.subTest(text=text):
                self.rejects("[x](https://e.com/a_(b)) then", text)

    def test_links_in_other_forms_have_their_targets_skipped(self):
        for message, text in (
            ("[one](http://a.test/1) and [two](http://b.test/2) end", "one and two end"),
            ("![alt](http://x.test/p.png) end", "alt end"),
        ):
            with self.subTest(text=text):
                self.accepts(message, text)


class QuoteListNumberTests(QuoteCase):
    NUMBERED = "1. First thing\n2) Second thing\n3. Third"

    def test_list_numbers_at_the_start_of_a_line_are_skipped(self):
        for text in ("First thing Second thing", "thing Second", "Second thing Third"):
            with self.subTest(text=text):
                self.accepts(self.NUMBERED, text)

    def test_a_list_number_in_the_quote_is_422(self):
        for text in ("1 First thing", "thing 2 Second", "3 Third"):
            with self.subTest(text=text):
                self.rejects(self.NUMBERED, text)

    def test_indented_and_two_digit_list_numbers_are_skipped(self):
        for message, text in (
            ("Steps:\n   1. Open\n   2. Close", "Steps Open Close"),
            ("10) Tenth thing\n11. Eleventh", "Tenth thing Eleventh"),
        ):
            with self.subTest(text=text):
                self.accepts(message, text)

    def test_a_number_not_at_the_start_of_a_line_is_a_word(self):
        for message, text in (("Version 2.0 is out", "2 0 is out"), ("See 3) item here", "3 item here")):
            with self.subTest(text=text):
                self.accepts(message, text)

    def test_a_decimal_at_the_start_of_a_line_is_a_word(self):
        self.accepts("1.5 apples today", "1 5 apples")

    def test_a_ten_digit_number_at_the_start_of_a_line_is_a_word(self):
        self.accepts("1234567890. Big deal", "1234567890 Big deal")


class QuoteNoWordTests(QuoteCase):
    GREAT = "Great \U0001F44D job"

    def test_an_emoji_quote_passes_when_the_message_has_it(self):
        self.accepts(self.GREAT, "\U0001F44D")

    def test_another_emoji_or_a_doubled_one_is_422(self):
        for text in ("\U0001F44E", "\U0001F44D\U0001F44D"):
            with self.subTest(text=text):
                self.rejects(self.GREAT, text)

    def test_spaces_around_an_emoji_are_part_of_the_exact_text(self):
        self.accepts(self.GREAT, " \U0001F44D ")

    def test_a_punctuation_only_quote_passes_when_the_raw_message_has_it(self):
        self.accepts("Wait... what", "...")

    def test_a_punctuation_only_quote_is_422_when_the_raw_message_has_no_such_text(self):
        for message in ("Wait what", "Wait.. what"):
            with self.subTest(message=message):
                self.rejects(message, "...")

    def test_a_quote_with_letters_next_to_an_emoji_is_checked_by_words(self):
        for text in ("\U0001F44D job", "Great \U0001F44D"):
            with self.subTest(text=text):
                self.accepts(self.GREAT, text)


class QuoteLengthTests(QuoteCase):
    def test_exactly_280_code_points_passes(self):
        self.accepts("word " * 100, "word " * 56)

    def test_281_code_points_is_422(self):
        self.rejects("word " * 100, "word " * 56 + "w")

    def test_code_points_are_counted_not_bytes(self):
        self.accepts("\U0001F600" * 300, "\U0001F600" * 280)

    def test_281_emoji_is_422(self):
        self.rejects("\U0001F600" * 300, "\U0001F600" * 281)

    def test_empty_text_is_422(self):
        self.rejects(MESSAGE, "")

    def test_blank_text_is_422(self):
        for text in (" ", "   ", "\n", " \n ", "\t"):
            with self.subTest(text=text):
                self.rejects(MESSAGE, text)

    def test_text_that_is_not_a_string_is_422(self):
        for text in (5, None, ["a"], {"a": 1}, True, 1.5):
            with self.subTest(text=text):
                env = seeded(self)
                self.refused(env, env.send_with(BOT, "Reply", quote={"id": MID, "text": text}))


class QuoteIdFaultTests(QuoteCase):
    def test_an_unknown_id_is_422(self):
        env = seeded(self)
        self.refused(env, env.send_with(BOT, "Reply", quote={"id": "nope@qd.invalid", "text": "door"}))

    def test_a_message_of_another_bots_thread_is_422_and_passes_in_its_own(self):
        env = seeded(self)
        env.mail.bot_says(OTHER, "Other thread text", 2, identifier="o1@qd.invalid")
        env.mail.captain_says(OTHER, "Other captain text", 3, identifier="o2@qd.invalid")
        env.refresh()
        for identifier, text in (("o1@qd.invalid", "Other thread"), ("o2@qd.invalid", "Other captain")):
            with self.subTest(identifier=identifier):
                self.refused(env, env.send_with(BOT, "Reply", quote=quote_of(text, identifier)))
        quote = quote_of("Other thread", "o1@qd.invalid")
        self.sends(env, env.send_with(OTHER, "Reply", quote=quote), quote)

    def test_the_id_of_a_seen_note_is_422(self):
        env = R3Env(self)
        env.mail.captain_says(BOT, "Please check", 1, identifier=CAPTAIN_ID)
        env.mail.bot_says(BOT, MESSAGE, 2, identifier=MID)
        env.mail.note(BOT, CAPTAIN_ID, 3, identifier="n1@qd.invalid")
        env.refresh()
        for text in ("seen", "chat seen", "bot b"):
            with self.subTest(text=text):
                self.refused(env, env.send_with(BOT, "Reply", quote=quote_of(text, "n1@qd.invalid")))

    def test_an_id_that_is_not_a_string_is_422(self):
        for identifier in (5, None, [MID], {"a": 1}):
            with self.subTest(identifier=identifier):
                env = seeded(self)
                self.refused(env, env.send_with(BOT, "Reply", quote={"id": identifier, "text": "door"}))

    def test_his_own_message_may_be_quoted(self):
        env = seeded(self)
        env.mail.captain_says(BOT, "Please look at the door", 2, identifier=CAPTAIN_ID)
        env.refresh()
        quote = quote_of("look at the door", CAPTAIN_ID)
        self.sends(env, env.send_with(BOT, "Reply", quote=quote), quote)

    def test_his_message_just_sent_may_be_quoted_before_any_refresh(self):
        env = seeded(self)
        first = answer(env.send_with(BOT, "Please look at the door"))[1]["id"]
        quote = quote_of("look at the door", first)
        status, body = answer(env.send_with(BOT, "Reply", quote=quote))
        self.assertEqual(status, 200, body)
        self.assertEqual(sent_body(env, 1)["quote"], quote)


class QuoteShapeFaultTests(QuoteCase):
    def faults(self, quotes):
        for label, quote in quotes:
            with self.subTest(label=label):
                env = carded(self)
                self.refused(env, env.send_with(BOT, "Reply", quote=quote))

    def test_a_quote_that_is_not_an_object_is_422(self):
        self.faults(
            (
                ("string", MID),
                ("list", [quote_of("door")]),
                ("null", None),
                ("empty object", {}),
                ("empty string", ""),
                ("zero", 0),
                ("false", False),
                ("true", True),
                ("number", 5),
                ("empty list", []),
            )
        )

    def test_a_message_quote_missing_a_key_is_422(self):
        self.faults((("missing text", {"id": MID}), ("missing id", {"text": "door"})))

    def test_a_card_quote_missing_a_key_is_422(self):
        self.faults((("missing version", {"cardId": "Q176"}), ("missing card id", {"version": 3})))

    def test_extra_keys_are_422(self):
        self.faults(
            (
                ("message quote", dict(quote_of("door"), extra=1)),
                ("card quote", dict(CARD, extra=1)),
            )
        )

    def test_both_id_and_card_id_are_422(self):
        self.faults(
            (
                ("text and card id", dict(quote_of("door"), cardId="Q176")),
                ("card id and version", {"id": MID, "cardId": "Q176", "version": 3}),
                ("all four", dict(quote_of("door"), cardId="Q176", version=3)),
            )
        )

    def test_from_or_at_in_a_message_quote_is_422(self):
        self.faults(
            (
                ("from", dict(quote_of("door"), **{"from": "bot"})),
                ("at", dict(quote_of("door"), at=stamp(1))),
                ("from and at", dict(quote_of("door"), at=stamp(1), **{"from": "bot"})),
            )
        )

    def test_from_or_at_in_a_card_quote_is_422(self):
        self.faults(
            (
                ("from", dict(CARD, **{"from": "bot"})),
                ("at", dict(CARD, at=stamp(10))),
            )
        )


class CardQuoteTests(QuoteCase):
    def test_the_latest_version_passes_and_the_mail_carries_the_quote(self):
        env = carded(self)
        self.sends(env, env.send_with(BOT, "Talk to me about this.", quote=CARD), CARD)

    def test_earlier_versions_pass_and_the_mail_carries_exactly_that_quote(self):
        for version in (1, 2):
            with self.subTest(version=version):
                env = carded(self)
                quote = {"cardId": "Q176", "version": version}
                self.sends(env, env.send_with(BOT, "Talk to me", quote=quote), quote)

    def test_the_card_quote_mail_body_is_the_usual_body_plus_the_quote(self):
        env = carded(self)
        self.sends(env, env.send_with(BOT, "Talk", quote=CARD, client_id="client-aaa"), CARD)
        expected = {"qd": "chat/1", "bot": BOT, "text": "Talk", "clientId": "client-aaa", "fresh": False, "quote": CARD}
        self.assertEqual(sent_body(env), expected)

    def test_a_version_the_card_never_had_is_422(self):
        for version in (4, 0, -1, "3", 3.0, True, None):
            with self.subTest(version=version):
                env = carded(self)
                self.refused(env, env.send_with(BOT, "Talk", quote={"cardId": "Q176", "version": version}))

    def test_an_unknown_card_is_422(self):
        for card_id in ("Q999", "q176", "", "Q176 "):
            with self.subTest(card_id=card_id):
                env = carded(self)
                self.refused(env, env.send_with(BOT, "Talk", quote={"cardId": card_id, "version": 1}))

    def test_a_card_id_that_is_not_a_string_is_422(self):
        for card_id in (5, None, ["Q176"], {"a": 1}):
            with self.subTest(card_id=card_id):
                env = carded(self)
                self.refused(env, env.send_with(BOT, "Talk", quote={"cardId": card_id, "version": 1}))

    def test_a_card_quote_with_no_cards_at_all_is_422(self):
        env = seeded(self)
        self.refused(env, env.send_with(BOT, "Talk", quote={"cardId": "Q176", "version": 1}))


class QuoteOrderTests(QuoteCase):
    def test_a_bad_text_with_a_bad_quote_is_400_text(self):
        env = seeded(self)
        self.assertEqual(answer(env.send_with(BOT, "", quote=BAD_QUOTE)), (400, {"error": "text"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_an_unknown_bot_with_a_bad_quote_is_422_bot(self):
        env = seeded(self)
        self.assertEqual(answer(env.send_with("nobody", "Reply", quote=BAD_QUOTE)), (422, {"error": "bot"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_a_signed_out_request_with_a_bad_quote_is_401(self):
        env = seeded(self)
        env.gate.refuse = application.SessionRefused("approval session required")
        self.assertEqual(answer(env.send_with(BOT, "Reply", quote=BAD_QUOTE)), (401, {"error": "session"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_a_csrf_refusal_with_a_bad_quote_is_403_and_not_422(self):
        env = seeded(self)
        env.gate.csrf_error = approval_security.ApprovalRefused("card csrf is invalid")
        self.assertEqual(answer(env.send_with(BOT, "Reply", quote=BAD_QUOTE)), (403, {"error": "request refused"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_a_body_fault_with_a_bad_quote_is_400_request_refused(self):
        env = seeded(self)
        self.assertEqual(answer(env.send_with(BOT, "Reply", quote=BAD_QUOTE, extra=1)), (400, {"error": "request refused"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_twelve_refused_quotes_do_not_use_up_the_send_limit(self):
        env = seeded(self)
        for number in range(12):
            with self.subTest(number=number):
                self.assertEqual(answer(env.send_with(BOT, "Reply", quote=BAD_QUOTE, token="session-limit")), REFUSED)
        results = [answer(env.send_with(BOT, f"m{number}", token="session-limit"))[0] for number in range(10)]
        self.assertEqual(results, [200] * 10)
        self.assertEqual(answer(env.send_with(BOT, "one too many", token="session-limit")), (429, {"error": "rate"}))
        self.assertEqual(len(env.mail.send_calls), 10)

    def test_twelve_different_refused_quotes_do_not_use_up_the_send_limit(self):
        env = carded(self)
        faults = [quote for label, quote in BAD_MESSAGE_QUOTES[:6] + BAD_CARD_QUOTES[:6]]
        for quote in faults:
            self.assertEqual(answer(env.send_with(BOT, "Reply", quote=quote, token="session-limit")), REFUSED)
        results = [answer(env.send_with(BOT, f"m{number}", token="session-limit"))[0] for number in range(10)]
        self.assertEqual(results, [200] * 10)
        self.assertEqual(answer(env.send_with(BOT, "one too many", token="session-limit"))[0], 429)

    def test_good_quote_sends_count_toward_the_limit(self):
        env = seeded(self)
        results = [env.send_with(BOT, f"m{number}", quote=quote_of("door"), token="session-limit").status for number in range(11)]
        self.assertEqual(results, [200] * 10 + [429])
        self.assertEqual(len(env.mail.send_calls), 10)

    def test_a_bad_quote_is_422_and_a_good_one_is_429_when_the_limit_is_used_up(self):
        env = seeded(self)
        for number in range(10):
            self.assertEqual(env.send_with(BOT, f"m{number}", token="session-limit").status, 200)
        self.assertEqual(answer(env.send_with(BOT, "x", quote=BAD_QUOTE, token="session-limit")), REFUSED)
        self.assertEqual(answer(env.send_with(BOT, "x", quote=quote_of("door"), token="session-limit")), (429, {"error": "rate"}))


class QuoteDisplayTests(QuoteCase):
    def test_a_bot_message_quoting_his_message_shows_from_captain(self):
        env = R3Env(self)
        env.mail.captain_says(BOT, MESSAGE, 1, identifier=CAPTAIN_ID)
        env.mail.bot_says(BOT, "Done", 2, identifier="b2@qd.invalid", quote=quote_of("check the door", CAPTAIN_ID))
        env.refresh()
        shown = shown_quote(env, "b2@qd.invalid")
        self.assertEqual(shown, expected_quote(CAPTAIN_ID, "captain", 1, "check the door"))
        self.assertEqual(set(shown), {"id", "from", "at", "text"})

    def test_a_bot_message_quoting_a_bot_message_shows_from_bot(self):
        env = seeded(self)
        env.mail.bot_says(BOT, "Done", 2, identifier="b2@qd.invalid", quote=quote_of("door file"))
        env.refresh()
        self.assertEqual(shown_quote(env, "b2@qd.invalid"), expected_quote(MID, "bot", 1, "door file"))

    def test_his_sent_message_quoting_a_bot_message_shows_from_bot_at_once(self):
        env = seeded(self)
        status, body = answer(env.send_with(BOT, "Reply", quote=quote_of("check the door")))
        self.assertEqual(status, 200)
        shown = find(env.thread(BOT), body["id"])
        self.assertEqual((shown["from"], shown["text"]), ("captain", "Reply"))
        self.assertEqual(shown["quote"], expected_quote(MID, "bot", 1, "check the door"))
        self.assertEqual(set(shown["quote"]), {"id", "from", "at", "text"})

    def test_his_sent_message_quoting_a_bot_message_shows_from_bot_after_a_refresh(self):
        env = seeded(self)
        status, body = answer(env.send_with(BOT, "Reply", quote=quote_of("check the door")))
        self.assertEqual(status, 200)
        env.refresh()
        self.assertEqual(shown_quote(env, body["id"]), expected_quote(MID, "bot", 1, "check the door"))

    def test_his_mail_message_quoting_a_bot_message_shows_from_bot(self):
        env = seeded(self)
        env.mail.captain_says(BOT, "Reply", 2, identifier="c2@qd.invalid", quote=quote_of("door file"))
        env.refresh()
        self.assertEqual(shown_quote(env, "c2@qd.invalid"), expected_quote(MID, "bot", 1, "door file"))

    def test_his_message_quoting_his_own_message_shows_from_captain(self):
        env = R3Env(self)
        env.mail.captain_says(BOT, "Please look at the door", 1, identifier=CAPTAIN_ID)
        env.mail.captain_says(BOT, "Again", 2, identifier="c2@qd.invalid", quote=quote_of("look at", CAPTAIN_ID))
        env.refresh()
        self.assertEqual(shown_quote(env, "c2@qd.invalid"), expected_quote(CAPTAIN_ID, "captain", 1, "look at"))

    def test_the_quote_at_is_the_quoted_message_time_not_the_quoting_one(self):
        env = R3Env(self)
        env.mail.captain_says(BOT, MESSAGE, 7, identifier=CAPTAIN_ID)
        env.mail.bot_says(BOT, "Done", 9, identifier="b2@qd.invalid", quote=quote_of("door", CAPTAIN_ID))
        env.refresh()
        shown = find(env.thread(BOT), "b2@qd.invalid")
        self.assertEqual(shown["at"], stamp(9))
        self.assertEqual((shown.get("quote") or {}).get("at"), stamp(7))

    def test_quote_text_is_shown_as_stored_with_spaces_and_a_newline(self):
        env = seeded(self)
        env.mail.bot_says(BOT, "Done", 2, identifier="b2@qd.invalid", quote=quote_of("  check the door\n"))
        env.refresh()
        self.assertEqual(shown_quote(env, "b2@qd.invalid"), expected_quote(MID, "bot", 1, "  check the door\n"))

    def test_a_card_quote_on_a_bot_mail_is_shown_as_it_is(self):
        env = R3Env(self, checker=CardChecker())
        env.mail.card("Q176", 10, revisions=3)
        env.mail.bot_says(BOT, "About this card", 1, identifier="b2@qd.invalid", quote=CARD)
        env.refresh()
        shown = shown_quote(env, "b2@qd.invalid")
        self.assertEqual(shown, {"cardId": "Q176", "version": 3})

    def test_a_card_quote_on_a_mail_of_his_is_shown_as_it_is(self):
        env = R3Env(self, checker=CardChecker())
        env.mail.card("Q176", 10, revisions=3)
        env.mail.captain_says(BOT, "Talk to me", 1, identifier=CAPTAIN_ID, quote={"cardId": "Q176", "version": 1})
        env.refresh()
        self.assertEqual(shown_quote(env, CAPTAIN_ID), {"cardId": "Q176", "version": 1})

    def test_his_sent_card_quote_is_shown_at_once(self):
        env = carded(self)
        status, body = answer(env.send_with(BOT, "Talk to me about this.", quote=CARD))
        self.assertEqual(status, 200)
        self.assertEqual(shown_quote(env, body["id"]), {"cardId": "Q176", "version": 3})

    def test_a_message_with_no_quote_has_quote_null_and_no_files(self):
        env = seeded(self)
        env.mail.captain_says(BOT, "Plain", 2, identifier=CAPTAIN_ID)
        env.refresh()
        messages = env.thread(BOT)["messages"]
        self.assertEqual([message["id"] for message in messages], [MID, CAPTAIN_ID])
        for message in messages:
            with self.subTest(id=message["id"]):
                self.assertIn("quote", message)
                self.assertIsNone(message["quote"])
                self.assertEqual(message.get("files"), [])

    def test_a_message_with_a_quote_has_the_usual_keys_and_empty_files(self):
        env = seeded(self)
        env.mail.bot_says(BOT, "Done", 2, identifier="b2@qd.invalid", quote=quote_of("door"))
        env.refresh()
        shown = find(env.thread(BOT), "b2@qd.invalid")
        self.assertEqual(set(shown), {"id", "from", "text", "at", "refs", "quote", "files"})
        self.assertEqual(shown["files"], [])


class QuoteBadInMailTests(QuoteCase):
    def test_a_bad_message_quote_in_mail_shows_null_and_the_message_still_shows(self):
        for label, quote in BAD_MESSAGE_QUOTES:
            with self.subTest(label=label):
                env = mail_env(self, quote)
                shown = find(env.thread(BOT), QID)
                self.assertEqual(shown["text"], "Hi")
                self.assertIsNone(shown.get("quote", "missing"))

    def test_a_bad_card_quote_in_mail_shows_null_and_the_message_still_shows(self):
        for label, quote in BAD_CARD_QUOTES:
            with self.subTest(label=label):
                env = mail_env(self, quote)
                shown = find(env.thread(BOT), QID)
                self.assertEqual(shown["text"], "Hi")
                self.assertIsNone(shown.get("quote", "missing"))

    def test_good_quotes_in_the_same_setup_are_shown_so_null_is_not_the_default(self):
        for quote, expected in (
            (quote_of("door file"), expected_quote(MID, "bot", 2, "door file")),
            ({"cardId": "Q176", "version": 2}, {"cardId": "Q176", "version": 2}),
        ):
            with self.subTest(quote=quote):
                env = mail_env(self, quote)
                self.assertEqual(shown_quote(env, QID), expected)

    def test_a_quote_of_a_seen_note_id_in_mail_shows_null_and_the_message_still_shows(self):
        env = mail_env(self, {"id": "n1@qd.invalid", "text": "seen"}, note=True)
        shown = find(env.thread(BOT), QID)
        self.assertEqual(shown["text"], "Hi")
        self.assertIsNone(shown.get("quote", "missing"))

    def test_a_bot_quote_of_exactly_4000_code_points_is_shown_in_full(self):
        text = "word " * 800
        env = R3Env(self)
        env.mail.bot_says(BOT, text, 1, identifier=MID)
        env.mail.bot_says(BOT, "Reply", 2, identifier=QID, quote=quote_of(text))
        env.refresh()
        self.assertEqual(shown_quote(env, QID), expected_quote(MID, "bot", 1, text))

    def test_a_bot_quote_of_4001_code_points_is_null_and_the_message_still_shows(self):
        text = "word " * 800 + "w"
        env = R3Env(self)
        env.mail.bot_says(BOT, text, 1, identifier=MID)
        env.mail.bot_says(BOT, "Reply", 2, identifier=QID, quote=quote_of(text))
        env.refresh()
        shown = find(env.thread(BOT), QID)
        self.assertEqual(shown["text"], "Reply")
        self.assertIsNone(shown.get("quote", "missing"))

    def test_a_bot_quote_over_280_code_points_is_not_cut(self):
        text = "word " * 100
        env = R3Env(self)
        env.mail.bot_says(BOT, text, 1, identifier=MID)
        env.mail.bot_says(BOT, "Reply", 2, identifier=QID, quote=quote_of(text))
        env.refresh()
        self.assertEqual(shown_quote(env, QID), expected_quote(MID, "bot", 1, text))

    def test_the_word_rules_apply_to_a_bot_quote_part_words_at_the_ends_pass(self):
        env = seeded(self)
        env.mail.bot_says(BOT, "Reply", 2, identifier=QID, quote=quote_of("ou check the door fi"))
        env.refresh()
        self.assertEqual(shown_quote(env, QID), expected_quote(MID, "bot", 1, "ou check the door fi"))

    def test_the_word_rules_apply_to_a_bot_quote_a_skipped_word_is_null(self):
        env = seeded(self)
        env.mail.bot_says(BOT, "Reply", 2, identifier=QID, quote=quote_of("check door"))
        env.refresh()
        self.assertIsNone(shown_quote(env, QID))


class QuoteReadShapeTests(QuoteCase):
    def test_the_expanded_quote_is_the_same_on_plain_before_and_after_reads(self):
        env = R3Env(self)
        env.mail.captain_says(BOT, MESSAGE, 1, identifier=CAPTAIN_ID)
        env.mail.bot_says(BOT, "Done", 2, identifier="b2@qd.invalid", quote=quote_of("check the door", CAPTAIN_ID))
        env.mail.bot_says(BOT, "More", 3, identifier="b3@qd.invalid")
        env.refresh()
        plain = env.thread(BOT)
        before = env.thread(BOT, f"bot={BOT}&before=b3@qd.invalid")
        after = env.thread(BOT, f"bot={BOT}&after={CAPTAIN_ID}")
        expected = expected_quote(CAPTAIN_ID, "captain", 1, "check the door")
        for name, body in (("plain", plain), ("before", before), ("after", after)):
            with self.subTest(read=name):
                self.assertEqual(find(body, "b2@qd.invalid")["quote"], expected)
        self.assertEqual(find(plain, "b2@qd.invalid"), find(after, "b2@qd.invalid"))
        self.assertEqual(find(plain, "b2@qd.invalid"), find(before, "b2@qd.invalid"))

    def test_an_after_read_expands_a_quote_of_a_message_outside_the_page(self):
        env = R3Env(self)
        env.mail.captain_says(BOT, MESSAGE, 1, identifier=CAPTAIN_ID)
        env.mail.bot_says(BOT, "Done", 2, identifier="b2@qd.invalid", quote=quote_of("door file", CAPTAIN_ID))
        env.mail.bot_says(BOT, "More", 3, identifier="b3@qd.invalid")
        env.refresh()
        body = env.thread(BOT, f"bot={BOT}&after={CAPTAIN_ID}")
        self.assertEqual([message["id"] for message in body["messages"]], ["b2@qd.invalid", "b3@qd.invalid"])
        self.assertEqual(body["messages"][0]["quote"], expected_quote(CAPTAIN_ID, "captain", 1, "door file"))
        self.assertIsNone(body["messages"][1]["quote"])

    def test_a_card_quote_is_the_same_on_plain_and_after_reads(self):
        env = R3Env(self, checker=CardChecker())
        env.mail.card("Q176", 10, revisions=3)
        env.mail.bot_says(BOT, "First", 1, identifier=MID)
        env.mail.bot_says(BOT, "About it", 2, identifier="b2@qd.invalid", quote=CARD)
        env.refresh()
        plain = find(env.thread(BOT), "b2@qd.invalid")
        after = find(env.thread(BOT, f"bot={BOT}&after={MID}"), "b2@qd.invalid")
        self.assertEqual(plain["quote"], {"cardId": "Q176", "version": 3})
        self.assertEqual(plain, after)

    def test_a_bad_quote_is_null_on_an_after_read_too(self):
        env = seeded(self)
        env.mail.bot_says(BOT, "Reply", 2, identifier=QID, quote=quote_of("window"))
        env.refresh()
        body = env.thread(BOT, f"bot={BOT}&after={MID}")
        self.assertEqual([message["id"] for message in body["messages"]], [QID])
        self.assertIsNone(body["messages"][0].get("quote", "missing"))


if __name__ == "__main__":
    unittest.main()
