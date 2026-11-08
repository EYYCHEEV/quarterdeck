import json
import sys
import tempfile
import unicodedata
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import cards
import qd_jmap
import server
import test_chat_r3_mail as gateway
from r3_helpers import R3Env, chat_body, note_body
from test_chat_server import ACCOUNT, stamp

SEEN = gateway.SEEN
ACCOUNT_ID = gateway.ACCOUNT_ID
message_id = gateway.message_id
BIDI = [0x061C, 0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)]
ORDINARY = [
    "Zo\u00eb Lead",
    "Zoe\u0308 Lead",
    "Zo\u00eb  Lead",
    "\u4f60\u597d Bot",
    "\u00dcnal \u00c7elik",
    "\u03a9-2",
    "O'Neil",
    "Dr. \u00dcnal \u2013 Lead",
    "\U0001F642 Bot",
    "\U0001F469\U0001F4BB Lead",
    "Emma-Lou 2",
]


class AliasedMessageIdTests(gateway.MailCase):
    def aliased(self, order=("valid", "later", "other-bot", "plain"), before=False):
        source = gateway.JmapServer()
        gateway.captain_mail(source, "bot-b", "hello", "c1")
        if before:
            gateway.bot_mail(source, "bot-b", "first", "b0")
        adders = {
            "valid": lambda: gateway.bot_mail(source, "bot-b", "valid", "dup", identifier="j-valid"),
            "later": lambda: gateway.bot_mail(source, "bot-b", "later", "dup", identifier="j-later"),
            "other-bot": lambda: gateway.bot_mail(source, "bot-c", "elsewhere", "dup", identifier="j-other-bot"),
            "plain": lambda: source.add("inbox", "someone", ACCOUNT, "A plain mail", "just words", "j-plain", "dup"),
        }
        for name in order:
            adders[name]()
        env = gateway.RealEnv(self, source)
        env.refresh()
        return source, env

    def test_a_mark_through_the_valid_target_sets_seen_only_on_the_validated_rows(self):
        source, env = self.aliased()
        posts = len(source.posts)
        self.assertEqual(env.read_status("bot-b", message_id("dup"))[0], 200)
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-valid": SEEN}})])
        self.assertEqual(
            [source.keywords_of(name) for name in ("j-valid", "j-later", "j-other-bot", "j-plain")],
            [{"$seen": True}, {}, {}, {}],
        )

    def test_an_ordinary_row_before_the_target_is_marked_with_it_and_the_aliases_are_not(self):
        source, env = self.aliased(before=True)
        posts = len(source.posts)
        self.assertEqual(env.read_status("bot-b", message_id("dup"))[0], 200)
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-b0": SEEN, "j-valid": SEEN}})])
        self.assertEqual([source.keywords_of(name) for name in ("j-later", "j-other-bot", "j-plain")], [{}, {}, {}])

    def test_when_another_bots_row_holds_the_shared_id_the_mark_is_refused_and_writes_nothing(self):
        source, env = self.aliased(order=("other-bot", "valid", "later", "plain"))
        posts = len(source.posts)
        self.assertEqual(env.read_status("bot-b", message_id("dup")), (422, {"error": "read"}))
        self.assertEqual(self.calls_since(source, posts), [])
        self.assertEqual([source.keywords_of(name) for name in ("j-valid", "j-later", "j-other-bot", "j-plain")], [{}, {}, {}, {}])

    def test_a_note_that_shares_its_id_with_other_mail_marks_only_itself(self):
        source = gateway.JmapServer()
        gateway.captain_mail(source, "bot-b", "hello", "c1")
        gateway.bot_mail(source, "bot-b", "one", "b1")
        gateway.note_mail(source, "bot-b", "bot-b", message_id("c1"), "dup")
        gateway.bot_mail(source, "bot-c", "elsewhere", "dup", identifier="j-other-bot")
        gateway.bot_mail(source, "bot-b", "two", "b2")
        env = gateway.RealEnv(self, source)
        env.refresh()
        posts = len(source.posts)
        self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
        [(name, arguments)] = self.calls_since(source, posts)
        self.assertEqual(sorted(arguments["update"]), ["j-b1", "j-b2", "j-dup"])
        self.assertEqual(source.keywords_of("j-other-bot"), {})


class DuplicateCopyTests(gateway.MailCase):
    def world(self, change):
        source = gateway.JmapServer()
        gateway.bot_mail(source, "bot-b", "text", "dup", identifier="j-dup-1")
        gateway.bot_mail(source, "bot-b", "text", "dup", identifier="j-dup-2")
        second = source.emails["j-dup-2"]
        second["receivedAt"] = source.emails["j-dup-1"]["receivedAt"]
        change(second)
        box = gateway.adapter(source)
        box.messages()
        return source, box

    def marked(self, change):
        source, box = self.world(change)
        posts = len(source.posts)
        self.mark(box, [message_id("dup")])
        [(name, arguments)] = self.calls_since(source, posts)
        return sorted(arguments["update"])

    def test_an_exact_copy_is_marked_with_the_row(self):
        self.assertEqual(self.marked(lambda row: None), ["j-dup-1", "j-dup-2"])

    def test_a_copy_from_another_sender_is_not_marked(self):
        self.assertEqual(self.marked(lambda row: row.update({"from": [{"email": "bot-c@qd.invalid"}]})), ["j-dup-1"])

    def test_a_copy_with_another_subject_is_not_marked(self):
        self.assertEqual(self.marked(lambda row: row.update({"subject": "CHAT: bot-c"})), ["j-dup-1"])

    def test_a_copy_with_another_body_is_not_marked(self):
        self.assertEqual(self.marked(lambda row: row["bodyValues"]["1"].update({"value": chat_body("bot-b", "other words")})), ["j-dup-1"])

    def test_a_copy_at_another_position_is_not_marked(self):
        self.assertEqual(self.marked(lambda row: row.update({"receivedAt": "2026-11-07T07:30:00Z"})), ["j-dup-1"])

    def test_a_listed_inbox_row_carries_the_ids_of_its_exact_copies_only(self):
        for change, expected in (
            (lambda row: None, ("j-dup-1", "j-dup-2")),
            (lambda row: row.update({"subject": "CHAT: bot-c"}), ("j-dup-1",)),
        ):
            with self.subTest(expected=expected):
                source, box = self.world(change)
                rows = {row.id: row for row in box.messages()}
                self.assertEqual(getattr(rows[message_id("dup")], "mail_ids", "absent"), expected)

    def test_a_sent_row_carries_no_mail_ids(self):
        source = gateway.JmapServer()
        gateway.captain_mail(source, "bot-b", "hello", "c1")
        gateway.bot_mail(source, "bot-b", "one", "b1")
        rows = {row.id: row for row in gateway.adapter(source).messages()}
        self.assertEqual(getattr(rows[message_id("c1")], "mail_ids", "absent"), ())
        self.assertEqual(getattr(rows[message_id("b1")], "mail_ids", "absent"), ("j-b1",))

    def test_a_sent_copy_that_shares_the_id_is_never_a_carried_id(self):
        source = gateway.JmapServer()
        source.add("sent", ACCOUNT, "bot-b", "CHAT: bot-b", chat_body("bot-b", "x", client_id="c", fresh=False), "j-sent", "both", {})
        source.add("inbox", "bot-b", ACCOUNT, "CHAT: bot-b", chat_body("bot-b", "x", client_id="c", fresh=False), "j-inbox", "both")
        source.emails["j-inbox"]["receivedAt"] = source.emails["j-sent"]["receivedAt"]
        source.emails["j-inbox"]["from"] = [{"email": f"{ACCOUNT}@qd.invalid"}]
        rows = {row.id: row for row in gateway.adapter(source).messages()}
        self.assertNotIn("j-sent", getattr(rows[message_id("both")], "mail_ids", ()))


class MarkSeenIdTests(gateway.MailCase):
    def world(self):
        source = gateway.JmapServer()
        gateway.captain_mail(source, "bot-b", "hello", "c1")
        gateway.bot_mail(source, "bot-b", "one", "b1")
        gateway.bot_mail(source, "bot-b", "two", "b2")
        box = gateway.adapter(source)
        box.messages()
        return source, box

    def test_a_known_inbox_mail_id_is_set_seen_and_nothing_else(self):
        source, box = self.world()
        posts = len(source.posts)
        box.mark_seen(["j-b1"])
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-b1": SEEN}})])
        self.assertEqual([source.keywords_of(name) for name in ("j-b1", "j-b2")], [{"$seen": True}, {}])

    def test_a_message_id_is_not_a_mail_id_and_is_refused_with_no_request(self):
        source, box = self.world()
        http = len(source.http)
        with self.assertRaises(qd_jmap.MailFailed):
            box.mark_seen([message_id("b1")])
        self.assertEqual(len(source.http), http)
        self.assertEqual(source.keywords_of("j-b1"), {})

    def test_an_id_that_is_not_in_the_inbox_is_refused_before_anything_is_set(self):
        source, box = self.world()
        http = len(source.http)
        for refused in ("j-c1", "j-nobody"):
            with self.subTest(refused=refused):
                with self.assertRaises(qd_jmap.MailFailed):
                    box.mark_seen(["j-b1", refused, "j-b2"])
        self.assertEqual(len(source.http), http)
        self.assertEqual([source.keywords_of(name) for name in ("j-b1", "j-b2", "j-c1")], [{}, {}, {"$seen": True}])

    def test_an_id_moved_out_of_the_inbox_since_the_listing_is_still_refused_after_the_next_listing(self):
        source, box = self.world()
        source.move("j-b2", "sent")
        box.messages()
        with self.assertRaises(qd_jmap.MailFailed):
            box.mark_seen(["j-b2"])
        self.assertEqual(source.keywords_of("j-b2"), {})


class CarriedIdsServiceTests(unittest.TestCase):
    def add(self, env, identifier, sender, body, minute, seen, mail_ids, subject="CHAT: bot-b"):
        env.mail.inbox.append(cards.MailMessage(identifier, sender, subject, body, stamp(minute), seen, mail_ids))

    def world(self):
        env = R3Env(self)
        self.add(env, "c1@qd.invalid", ACCOUNT, chat_body("bot-b", "hello", client_id="k1", fresh=False), 1, True, ())
        self.add(env, "b1@qd.invalid", "bot-b", chat_body("bot-b", "one"), 2, False, ("j-b1-copy-1", "j-b1-copy-2"))
        self.add(env, "n1@qd.invalid", "bot-b", note_body("bot-b", "c1@qd.invalid"), 3, False, ("j-n1",))
        self.add(env, "b2@qd.invalid", "bot-b", chat_body("bot-b", "two"), 4, False, ("j-b2",))
        self.add(env, "b3@qd.invalid", "bot-b", chat_body("bot-b", "three"), 5, False, ("j-b3",))
        env.refresh()
        return env

    def test_the_mark_hands_the_mail_the_carried_ids_of_the_validated_rows_in_thread_order(self):
        env = self.world()
        self.assertEqual(env.read_status("bot-b", "b2@qd.invalid")[0], 200)
        self.assertEqual(env.mail.marked, [["j-b1-copy-1", "j-b1-copy-2", "j-n1", "j-b2"]])

    def test_the_copy_shows_the_validated_rows_read_and_the_row_after_them_unread(self):
        env = self.world()
        self.assertEqual(env.read_status("bot-b", "b2@qd.invalid")[0], 200)
        self.assertEqual(env.thread("bot-b")["firstUnread"], "b3@qd.invalid")

    def test_a_row_that_is_already_read_hands_over_nothing(self):
        env = self.world()
        env.mail.set_seen("b1@qd.invalid", True)
        env.refresh()
        self.assertEqual(env.read_status("bot-b", "b2@qd.invalid")[0], 200)
        self.assertEqual(env.mail.marked, [["j-n1", "j-b2"]])

    def test_an_unread_row_that_carries_no_mail_id_is_502_mail_and_changes_nothing(self):
        env = R3Env(self)
        self.add(env, "b1@qd.invalid", "bot-b", chat_body("bot-b", "one"), 1, False, ())
        env.refresh()
        self.assertEqual(env.read_status("bot-b", "b1@qd.invalid"), (502, {"error": "mail"}))
        self.assertEqual(env.mail.marked, [])
        self.assertEqual(env.thread("bot-b")["firstUnread"], "b1@qd.invalid")


class NameFormatTests(unittest.TestCase):
    def refused(self, name):
        with self.assertRaises(ValueError):
            cards.check_bot_names({"bot-a": name})

    def test_every_bidirectional_control_is_refused_at_every_position(self):
        for code in BIDI:
            for name in (f"Zo{chr(code)}e Lead", f"{chr(code)}Lead", f"Lead{chr(code)}"):
                with self.subTest(code=hex(code), name=ascii(name)):
                    self.refused(name)

    def test_the_right_to_left_override_is_refused_by_the_name_check_itself(self):
        self.assertFalse(cards.printable_name("Zo\u202ee Lead"))
        self.assertTrue(cards.printable_name("Zo\u00eb Lead"))

    def test_every_character_of_the_small_refused_categories_is_refused(self):
        kinds = {"Cc", "Cf", "Cs", "Zs", "Zl", "Zp"}
        refused = [chr(code) for code in range(0x110000) if unicodedata.category(chr(code)) in kinds and chr(code) != " "]
        self.assertGreater(len(refused), 2000)
        for character in refused:
            if cards.printable_name(f"a{character}b"):
                self.fail(f"accepted U+{ord(character):04X} {unicodedata.category(character)}")

    def test_private_use_and_unassigned_characters_are_refused(self):
        samples = [0xE000, 0xF8FF, 0xF0000, 0xFFFFD, 0x100000, 0x10FFFD, 0x0378, 0x0380, 0xFFFF, 0xFFFE, 0xFDD0, 0x1FFFF, 0x2FFFF, 0x10FFFF]
        for code in samples:
            with self.subTest(code=hex(code)):
                self.refused(f"Zo{chr(code)}e")

    def test_a_lone_surrogate_is_refused(self):
        for text in ("Zo\ud800e", "\udc00", "ab\udfffcd"):
            with self.subTest(text=ascii(text)):
                self.refused(text)

    def test_no_separator_but_the_plain_space_is_allowed(self):
        for code in (0x00A0, 0x1680, 0x2000, 0x2003, 0x2009, 0x200A, 0x202F, 0x205F, 0x3000, 0x2028, 0x2029, 0x0009, 0x000A, 0x000D, 0x0085):
            with self.subTest(code=hex(code)):
                self.refused(f"Zo{chr(code)}e")
        self.assertEqual(cards.check_bot_names({"bot-a": "Zoe Lead"}), {"bot-a": "Zoe Lead"})

    def test_a_non_breaking_space_is_refused_in_a_name_made_of_plain_words(self):
        self.refused("Zo\u00eb\u00a0Lead")

    def test_format_characters_that_join_or_hide_are_refused(self):
        for text in ("\U0001F469\u200d\U0001F4BB Lead", "Zo\u200ce", "Zo\u200be", "\ufeffZoe", "Zo\u00ade", "Zo\u2060e", "Zo\u2062e"):
            with self.subTest(text=ascii(text)):
                self.refused(text)

    def test_ordinary_non_ascii_names_and_plain_spaces_pass(self):
        for name in ORDINARY:
            with self.subTest(name=ascii(name)):
                self.assertEqual(cards.check_bot_names({"bot-a": name}), {"bot-a": name})
                self.assertTrue(cards.printable_name(name))

    def test_the_other_name_rules_still_hold(self):
        for name in ("", "x" * 41, 5, None, ["x"]):
            with self.subTest(name=repr(name)):
                self.refused(name)
        self.assertEqual(cards.check_bot_names({"bot-a": "x" * 40}), {"bot-a": "x" * 40})

    def test_a_name_with_a_bidirectional_control_stops_the_service_from_being_built(self):
        with self.assertRaises(ValueError):
            R3Env(self, names={"bot-b": "Zo\u202ee Lead"})

    def test_names_made_by_the_rule_go_through_the_same_check(self):
        for identifier in ("bot-b", "stronkbot-lead", "a--b-", "z", "bot-2", "a" + "b" * 31):
            with self.subTest(identifier=identifier):
                name = cards.display_name(identifier, {})
                self.assertTrue(cards.printable_name(name))
        with mock.patch.object(cards, "printable_name", return_value=False):
            self.assertIsNone(cards.display_name("bot-b", {}))
            self.assertIsNone(cards.display_name("bot-b", {"bot-b": "Builder"}))

    def test_one_check_serves_the_config_and_the_naming_rule(self):
        with mock.patch.object(cards, "printable_name", side_effect=lambda name: name != "Bad Name"):
            with self.assertRaises(ValueError):
                cards.check_bot_names({"bot-a": "Bad Name"})
            self.assertEqual(cards.display_name("bot-a", {"bot-a": "Bad Name"}), None)
            self.assertEqual(cards.display_name("bot-a", {"bot-a": "Good Name"}), "Good Name")


class ConfigAndAnswerTests(unittest.TestCase):
    def config(self, names):
        folder = tempfile.TemporaryDirectory(prefix="qd-config-")
        self.addCleanup(folder.cleanup)
        document = {
            "format": 1,
            "bindPort": 8080,
            "jmapSessionUrl": "https://jmap.invalid/session",
            "keyPath": "/k",
            "keyReadbackPath": "/r",
            "registryPath": "/g",
            "authSocket": "/a",
            "botNames": names,
        }
        path = Path(folder.name) / "runtime.json"
        path.write_text(json.dumps(document))
        return path

    def test_the_runtime_config_refuses_each_bidirectional_control_with_the_fixed_words(self):
        for code in BIDI:
            with self.subTest(code=hex(code)):
                with self.assertRaises(RuntimeError) as caught:
                    server.load_runtime_config(self.config({"bot-a": f"Zo{chr(code)}e Lead"}))
                self.assertEqual(str(caught.exception), "Captain runtime configuration is invalid")

    def test_the_runtime_config_refuses_a_non_breaking_space_and_a_joiner(self):
        for text in ("Zo\u00a0e", "A\u200db"):
            with self.subTest(text=ascii(text)):
                with self.assertRaises(RuntimeError):
                    server.load_runtime_config(self.config({"bot-a": text}))

    def test_the_runtime_config_keeps_ordinary_non_ascii_names(self):
        names = {f"bot-{number}": name for number, name in enumerate(ORDINARY)}
        self.assertEqual(dict(server.load_runtime_config(self.config(names)).bot_names), names)

    def test_a_configured_ordinary_name_is_what_the_row_and_the_thread_answer(self):
        env = R3Env(self, names={"bot-b": "Zo\u00eb Lead"})
        env.refresh()
        self.assertEqual(env.thread("bot-b")["bot"]["name"], "Zo\u00eb Lead")
        self.assertEqual(next(row for row in env.rows() if row["bot"]["id"] == "bot-b")["bot"]["name"], "Zo\u00eb Lead")


class NoOtherWriteTests(unittest.TestCase):
    def test_the_server_code_has_one_email_set_and_it_is_the_mark(self):
        source = (PKG / "mail_gateway.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("Email/set"), 1)
        self.assertEqual(source.count("def mark_seen"), 1)
