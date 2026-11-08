import ast
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import tokenize
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PKG = ROOT / "qd-web"
sys.path[:0] = [str(PKG), str(ROOT), str(HERE)]

import application
import approval_security
import cards
import qd_jmap
import server
from r3_helpers import CARRIES, READ_PATH, REPLY, CardChecker, R3Env, R3Mail, captured, chat_body, lines_of, note_body
from test_chat_server import ACCOUNT, BASE_TIME, FILES, STEWARD, Checker, Gate, answer, clean, request, stamp
from test_mail_api import MailCase
import mail_standins as standins

SAMPLES = Path(os.environ.get("QD_SAMPLES") or ROOT.parent / "golive" / "chat-v2-samples")
REFUSED = (400, {"error": "request refused"})


def mid(name):
    return f"{name}@qd.invalid"


def seed(env, *script, bot="bot-b"):
    for kind, name, minute, *rest in script:
        if kind == "c":
            env.mail.captain_says(bot, f"text {name}", minute, identifier=mid(name))
        elif kind == "b":
            env.mail.bot_says(bot, f"text {name}", minute, identifier=mid(name), seen=rest[0] if rest else True)
        else:
            env.mail.note(bot, mid(rest[0]), minute, identifier=mid(name), seen=rest[1] if len(rest) > 1 else False)
    env.refresh()
    return env


def row_of(env, bot="bot-b"):
    return next(row for row in env.rows() if row["bot"]["id"] == bot)


def rev_of(env, bot="bot-b"):
    body = env.thread(bot)
    assert row_of(env, bot)["rev"] == body["rev"]
    return body["rev"]


class NameTests(unittest.TestCase):
    def bots(self, env):
        env.refresh()
        return {row["bot"]["id"]: row["bot"] for row in env.rows()}

    def test_the_rule_splits_at_hyphens_and_capitalises_each_word(self):
        env = R3Env(self, bots=("bot-b", "a--b-", "z", "bot-2", "b2c"))
        bots = self.bots(env)
        got = {bot: bots[bot]["name"] for bot in ("bot-b", "a--b-", "z", "bot-2", "b2c")}
        self.assertEqual(got, {"bot-b": "Bot B", "a--b-": "A B", "z": "Z", "bot-2": "Bot 2", "b2c": "B2c"})

    def test_the_product_names_keep_their_capitals_in_any_position(self):
        env = R3Env(self, bots=("stronkbot", "stronkbot-lead", "lead-stronkbot", "quarterdeck-web", "messdeck-lead"))
        bots = self.bots(env)
        got = {bot: value["name"] for bot, value in bots.items() if bot != STEWARD}
        self.assertEqual(got, {
            "stronkbot": "StronkBot",
            "stronkbot-lead": "StronkBot Lead",
            "lead-stronkbot": "Lead StronkBot",
            "quarterdeck-web": "Quarterdeck Web",
            "messdeck-lead": "Messdeck Lead",
        })

    def test_an_override_wins_over_the_rule_and_the_product_names(self):
        env = R3Env(self, bots=("bot-b", "stronkbot-lead", "bot-c"), names={"bot-b": "Builder One", "stronkbot-lead": "The Lead"})
        bots = self.bots(env)
        self.assertEqual([bots[bot]["name"] for bot in ("bot-b", "stronkbot-lead", "bot-c")], ["Builder One", "The Lead", "Bot C"])

    def test_an_override_for_a_bot_that_is_not_listed_adds_nothing(self):
        env = R3Env(self, names={"bot-z": "Nobody", STEWARD: "The Steward"})
        bots = self.bots(env)
        self.assertEqual(sorted(bots), sorted([STEWARD, "bot-b", "bot-c"]))
        self.assertEqual(bots[STEWARD]["name"], "The Steward")

    def test_a_thread_names_the_bot_the_same_way_and_keeps_the_note(self):
        env = R3Env(self, notes=(("bot-b", "Builds things"),), names={"bot-b": "Builder One"})
        env.refresh()
        self.assertEqual(env.thread("bot-b")["bot"], {"id": "bot-b", "name": "Builder One", "note": "Builds things"})
        self.assertEqual(env.thread("bot-c")["bot"], {"id": "bot-c", "name": "Bot C"})
        self.assertEqual(row_of(env, "bot-b")["bot"], {"id": "bot-b", "name": "Builder One", "note": "Builds things"})

    def test_a_32_character_id_gives_a_name_of_that_length(self):
        identifier = "a" + "b" * 31
        env = R3Env(self, bots=(identifier,))
        self.assertEqual(len(self.bots(env)[identifier]["name"]), 32)

    def test_display_name_gives_none_when_the_result_is_empty_too_long_or_not_printable(self):
        self.assertIsNone(cards.display_name("-", {}))
        self.assertIsNone(cards.display_name("a" * 50, {}))
        self.assertEqual(cards.display_name("bot-b", {}), "Bot B")
        self.assertEqual(cards.display_name("bot-b", {"bot-b": "X"}), "X")

    def test_a_bot_whose_name_is_none_has_no_name_key(self):
        env = R3Env(self)
        env.refresh()
        with mock.patch.object(cards, "display_name", return_value=None):
            self.assertEqual(env.thread("bot-b")["bot"], {"id": "bot-b"})
            self.assertEqual(row_of(env, "bot-b")["bot"], {"id": "bot-b"})

    def test_the_service_refuses_a_bad_mapping(self):
        bad = ({"Bot-A": "x"}, {"bot_a": "x"}, {"a" * 33: "x"}, {"bot-a": ""}, {"bot-a": "x" * 41}, {"bot-a": 5}, {"bot-a": "a\nb"}, ["bot-a"], "bot-a", 5)
        for names in bad:
            with self.subTest(names=names):
                with self.assertRaises(ValueError):
                    R3Env(self, names=names)


class ConfigNameTests(unittest.TestCase):
    def config(self, **extra):
        root = Path(tempfile.mkdtemp(prefix="qd-config-"))
        self.addCleanup(clean, root)
        document = {
            "format": 1,
            "bindPort": 8080,
            "jmapSessionUrl": "https://jmap.invalid/session",
            "keyPath": "/k",
            "keyReadbackPath": "/r",
            "registryPath": "/g",
            "authSocket": "/a",
        }
        document.update(extra)
        path = root / "runtime.json"
        path.write_text(json.dumps(document))
        return path

    def test_the_names_are_optional_and_empty_by_default(self):
        self.assertEqual(dict(server.load_runtime_config(self.config()).bot_names), {})

    def test_a_valid_mapping_is_read_as_pairs(self):
        names = {"bot-a": "Steward", "stronkbot-lead": "StronkBot Lead", "a" + "b" * 31: "x"}
        config = server.load_runtime_config(self.config(botNames=names))
        self.assertEqual(dict(config.bot_names), names)
        self.assertTrue(all(isinstance(pair, tuple) and len(pair) == 2 for pair in config.bot_names))

    def test_forty_code_points_pass_with_astral_characters_and_forty_one_do_not(self):
        good = {"bot-a": "\U0001F600" * 40, "bot-b": "\U0001F469\U0001F4BB Lead", "bot-c": "x" * 40}
        self.assertEqual(dict(server.load_runtime_config(self.config(botNames=good)).bot_names), good)
        with self.assertRaises(RuntimeError):
            server.load_runtime_config(self.config(botNames={"bot-a": "\U0001F600" * 41}))

    def test_every_bad_value_refuses_the_whole_config_with_the_fixed_words(self):
        bad = [
            [], "x", None, 5,
            {"Bot-A": "x"}, {"1bot": "x"}, {"bot_a": "x"}, {"a" * 33: "x"}, {"": "x"}, {"bot-a\n": "x"},
            {"bot-a": ""}, {"bot-a": "x" * 41}, {"bot-a": "tab\there"}, {"bot-a": "line\nbreak"}, {"bot-a": "line\u2028sep"},
            {"bot-a": "para\u2029sep"}, {"bot-a": "nul\u0000"}, {"bot-a": 5}, {"bot-a": None}, {"bot-a": ["x"]}, {"bot-a": True},
        ]
        for value in bad:
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError) as caught:
                    server.load_runtime_config(self.config(botNames=value))
                self.assertEqual(str(caught.exception), "Captain runtime configuration is invalid")

    def test_the_runtime_config_keeps_its_old_positional_shape(self):
        config = server.RuntimeConfig(8080, "https://jmap.invalid/session", "/k", "/r", "/g", "/a", "/site", "/state")
        self.assertEqual(dict(config.bot_names), {})

    def test_assemble_gives_the_service_the_configured_names(self):
        root = Path(tempfile.mkdtemp(prefix="qd-assemble-"))
        self.addCleanup(clean, root)
        site = root / "site"
        site.mkdir()
        for name, data in FILES.items():
            (site / name).write_bytes(data)

        class State:
            def run(self, refresh):
                return refresh()

            def token(self):
                return "t"

        names = (("bot-a", "The Steward"),)
        config = server.RuntimeConfig(8080, "https://jmap.invalid/session", "/k", "/r", "/g", "/a", str(site), None, None, names)
        with mock.patch.dict(sys.modules, {"mail_api": None}):
            app, updates = server.assemble(config, mailbox=R3Mail(), checker=Checker(), gate=Gate(), state=State(), clock=lambda: BASE_TIME)
        updates.check_once()
        status, rows = answer(app.handle(request("GET", "/captain/api/chats")))
        self.assertEqual((status, [row["bot"] for row in rows]), (200, [{"id": STEWARD, "name": "The Steward"}]))

    def test_assemble_hands_the_names_to_the_service(self):
        tree = ast.parse((PKG / "server.py").read_text(encoding="utf-8"))
        calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "CardService"
        ]
        self.assertTrue(calls)
        for call in calls:
            self.assertIn("bot_names", [keyword.arg for keyword in call.keywords])


class SeenTests(unittest.TestCase):
    def seen(self, *script):
        body = seed(R3Env(self), *script).thread()
        return body["seenUpTo"], body["seenAt"]

    def test_nothing_is_seen_without_a_note_or_a_bot_message_after_his(self):
        self.assertEqual(self.seen(), (None, None))
        self.assertEqual(self.seen(("c", "c1", 1)), (None, None))
        self.assertEqual(self.seen(("b", "b1", 1), ("c", "c1", 2)), (None, None))

    def test_a_bot_message_after_his_marks_it_seen_at_the_bot_message_time(self):
        self.assertEqual(self.seen(("c", "c1", 1), ("b", "b1", 2)), (mid("c1"), stamp(2)))

    def test_his_newest_message_before_the_newest_bot_message_is_the_one(self):
        self.assertEqual(self.seen(("c", "c1", 1), ("b", "b1", 2), ("c", "c2", 3), ("b", "b2", 4)), (mid("c2"), stamp(4)))
        self.assertEqual(self.seen(("c", "c1", 1), ("c", "c2", 2), ("b", "b1", 3)), (mid("c2"), stamp(3)))
        self.assertEqual(self.seen(("c", "c1", 1), ("b", "b1", 2), ("c", "c2", 3), ("b", "b2", 4), ("c", "c3", 5)), (mid("c2"), stamp(4)))

    def test_a_note_sets_seen_up_to_and_is_not_a_message_or_a_reply(self):
        env = seed(R3Env(self), ("c", "c1", 1), ("c", "c2", 2), ("n", "n1", 3, "c1"))
        body = env.thread()
        self.assertEqual((body["seenUpTo"], body["seenAt"]), (mid("c1"), stamp(3)))
        self.assertEqual([message["id"] for message in body["messages"]], [mid("c1"), mid("c2")])
        self.assertEqual(row_of(env)["last"], mid("c2"))

    def test_the_later_of_the_note_and_the_reply_wins(self):
        cases = {
            "note later": ((("c", "c1", 1), ("b", "b1", 2), ("c", "c2", 3), ("n", "n1", 4, "c2")), (mid("c2"), stamp(4))),
            "reply later": ((("c", "c1", 1), ("n", "n1", 2, "c1"), ("c", "c2", 3), ("b", "b1", 4)), (mid("c2"), stamp(4))),
            "note earlier target": ((("c", "c1", 1), ("c", "c2", 2), ("b", "b1", 3), ("n", "n1", 4, "c1")), (mid("c2"), stamp(3))),
            "same target": ((("c", "c1", 1), ("n", "n1", 2, "c1"), ("b", "b1", 3)), (mid("c1"), stamp(2))),
        }
        for name, (script, expected) in cases.items():
            with self.subTest(name):
                self.assertEqual(self.seen(*script), expected)

    def test_seen_at_is_the_earliest_item_that_covers_it(self):
        self.assertEqual(self.seen(("c", "c1", 1), ("b", "b1", 2), ("n", "n1", 3, "c1")), (mid("c1"), stamp(2)))
        self.assertEqual(self.seen(("c", "c1", 1), ("n", "n1", 2, "c1"), ("b", "b1", 3)), (mid("c1"), stamp(2)))

    def test_the_newest_note_names_seen_up_to_even_when_an_older_note_named_a_later_message(self):
        self.assertEqual(self.seen(("c", "c1", 1), ("c", "c2", 2), ("n", "n1", 3, "c2"), ("n", "n2", 4, "c1")), (mid("c1"), stamp(3)))

    def test_a_note_from_another_address_is_ignored(self):
        for sender in ("bot-c", ACCOUNT, STEWARD):
            with self.subTest(sender=sender):
                env = R3Env(self)
                env.mail.captain_says("bot-b", "one", 1, identifier=mid("c1"))
                env.mail.captain_says("bot-b", "two", 2, identifier=mid("c2"))
                env.mail.note("bot-b", mid("c1"), 3, sender=sender)
                env.refresh()
                body = env.thread()
                self.assertEqual((body["seenUpTo"], body["seenAt"]), (None, None))

    def test_a_note_in_another_bots_subject_with_the_wrong_bot_inside_is_ignored_everywhere(self):
        env = R3Env(self)
        env.mail.captain_says("bot-b", "one", 1, identifier=mid("c1"))
        env.mail.captain_says("bot-c", "other", 2, identifier=mid("c2"))
        env.mail.put("bot-b", "CHAT: bot-c", note_body("bot-b", mid("c1")), 3, mid("n1"), False)
        env.mail.put("bot-b", "CHAT: bot-c", note_body("bot-c", mid("c1")), 4, mid("n2"), False)
        env.refresh()
        for bot in ("bot-b", "bot-c"):
            body = env.thread(bot)
            self.assertEqual((body["seenUpTo"], body["seenAt"]), (None, None), bot)

    def test_a_malformed_note_is_ignored(self):
        good = {"qd": "chat-seen/1", "bot": "bot-b", "upTo": mid("c1")}
        bodies = {
            "wrong qd": {**good, "qd": "chat-seen/2"},
            "extra key": {**good, "extra": 1},
            "missing bot": {"qd": "chat-seen/1", "upTo": mid("c1")},
            "missing up to": {"qd": "chat-seen/1", "bot": "bot-b"},
            "wrong bot": {**good, "bot": "bot-c"},
            "number target": {**good, "upTo": 5},
            "null target": {**good, "upTo": None},
            "list target": {**good, "upTo": [mid("c1")]},
            "unknown target": {**good, "upTo": mid("zz")},
            "a bot message as target": {**good, "upTo": mid("b0")},
            "a note as target": {**good, "upTo": mid("n0")},
        }
        for name, document in bodies.items():
            with self.subTest(name):
                env = R3Env(self)
                env.mail.bot_says("bot-b", "first", 0, identifier=mid("b0"))
                env.mail.captain_says("bot-b", "one", 1, identifier=mid("c1"))
                env.mail.captain_says("bot-b", "two", 2, identifier=mid("c2"))
                env.mail.note("bot-b", mid("c1"), 3, identifier=mid("n0"), body="nope")
                env.mail.note("bot-b", mid("c1"), 4, identifier=mid("n9"), body=json.dumps(document))
                env.refresh()
                body = env.thread()
                self.assertEqual((body["seenUpTo"], body["seenAt"]), (None, None))
                self.assertEqual([message["id"] for message in body["messages"]], [mid("b0"), mid("c1"), mid("c2")])
        for text in ("nope", "[]", "5", "null", ""):
            with self.subTest(text=text):
                env = R3Env(self)
                env.mail.captain_says("bot-b", "one", 1, identifier=mid("c1"))
                env.mail.note("bot-b", mid("c1"), 3, body=text)
                env.refresh()
                self.assertEqual(env.thread()["seenUpTo"], None)

    def test_a_note_never_changes_the_row_preview_at_last_or_unread(self):
        env = seed(R3Env(self), ("c", "c1", 1), ("b", "b1", 2, True), ("n", "n1", 3, "c1", False))
        row = row_of(env)
        self.assertEqual((row["last"], row["preview"], row["at"], row["unread"]), (mid("b1"), "text b1", stamp(2), False))

    def test_a_bot_with_only_a_stray_note_has_an_empty_thread_and_an_empty_row(self):
        env = R3Env(self)
        env.mail.note("bot-b", mid("zz"), 1)
        env.refresh()
        self.assertEqual(env.thread()["messages"], [])
        self.assertEqual((row_of(env)["last"], row_of(env)["unread"]), ("", False))

    def test_a_note_for_one_bot_does_not_touch_another_bots_thread(self):
        env = R3Env(self)
        env.mail.captain_says("bot-b", "one", 1, identifier=mid("c1"))
        env.mail.captain_says("bot-c", "one", 2, identifier=mid("c2"))
        env.mail.note("bot-b", mid("c1"), 3)
        env.refresh()
        self.assertEqual(env.thread("bot-b")["seenUpTo"], mid("c1"))
        self.assertEqual(env.thread("bot-c")["seenUpTo"], None)


class UnreadTests(unittest.TestCase):
    def unread(self, *script, bot="bot-b"):
        env = seed(R3Env(self), *script, bot=bot)
        return env.thread(bot)["firstUnread"], row_of(env, bot)["unread"]

    def test_the_counted_messages_are_the_bot_messages_after_his_newest(self):
        self.assertEqual(self.unread(("b", "b1", 1, False), ("b", "b2", 2, False), ("c", "c1", 3), ("b", "b3", 4, False)), (mid("b3"), True))

    def test_every_bot_message_counts_when_he_has_none(self):
        self.assertEqual(self.unread(("b", "b1", 1, False), ("b", "b2", 2, False)), (mid("b1"), True))

    def test_his_reply_ends_the_counting_of_older_unseen_messages(self):
        self.assertEqual(self.unread(("b", "b1", 1, False), ("c", "c1", 2)), (None, False))

    def test_a_new_bot_message_after_his_reply_counts_alone(self):
        self.assertEqual(self.unread(("b", "b1", 1, False), ("c", "c1", 2), ("b", "b2", 3, False)), (mid("b2"), True))

    def test_the_first_unread_is_the_oldest_counted_message_without_a_seen_mark(self):
        self.assertEqual(self.unread(("b", "b1", 1, True), ("b", "b2", 2, False), ("b", "b3", 3, False)), (mid("b2"), True))
        self.assertEqual(self.unread(("b", "b1", 1, False), ("b", "b2", 2, True), ("b", "b3", 3, False)), (mid("b1"), True))
        self.assertEqual(self.unread(("b", "b1", 1, True), ("b", "b2", 2, True)), (None, False))

    def test_a_bot_with_no_messages_has_nothing_unread(self):
        self.assertEqual(self.unread(), (None, False))

    def test_an_unseen_note_never_counts(self):
        self.assertEqual(self.unread(("c", "c1", 0), ("b", "b1", 1, True), ("n", "n1", 2, "c1", False)), (None, False))

    def test_a_gateway_that_cannot_tell_says_seen_so_nothing_is_unread(self):
        env = R3Env(self)
        env.mail.inbox.append(cards.MailMessage(mid("b1"), "bot-b", "CHAT: bot-b", '{"qd":"chat/1","bot":"bot-b","text":"hi"}', stamp(1)))
        env.refresh()
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (None, False))

    def test_each_bot_has_its_own_unread_state(self):
        env = seed(R3Env(self), ("b", "b1", 1, False))
        seed(env, ("b", "x1", 2, True), bot="bot-c")
        self.assertEqual((row_of(env, "bot-b")["unread"], row_of(env, "bot-c")["unread"]), (True, False))

    def test_a_read_mark_set_elsewhere_shows_after_the_next_refresh(self):
        env = seed(R3Env(self), ("b", "b1", 1, False), ("b", "b2", 2, False))
        self.assertEqual(env.thread()["firstUnread"], mid("b1"))
        env.mail.set_seen(mid("b1"), True)
        self.assertEqual(env.thread()["firstUnread"], mid("b1"))
        env.refresh()
        self.assertEqual(env.thread()["firstUnread"], mid("b2"))
        env.mail.set_seen(mid("b2"), True)
        env.refresh()
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (None, False))

    def test_a_new_bot_message_makes_the_row_unread_after_a_refresh(self):
        env = seed(R3Env(self), ("b", "b1", 1, True))
        self.assertFalse(row_of(env)["unread"])
        env.mail.bot_says("bot-b", "again", 2, identifier=mid("b2"), seen=False)
        env.refresh()
        self.assertEqual((row_of(env)["unread"], env.thread()["firstUnread"]), (True, mid("b2")))

    def test_a_sent_message_ends_the_counting_at_once(self):
        env = seed(R3Env(self), ("b", "b1", 1, False))
        self.assertEqual(env.send_with("bot-b", "On it").status, 200)
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (None, False))


class RevTests(unittest.TestCase):
    def test_rev_is_an_int_below_sixteen_to_the_thirteenth_on_every_row_and_thread(self):
        env = seed(R3Env(self), ("c", "c1", 1), ("b", "b1", 2, False))
        for row in env.rows():
            with self.subTest(bot=row["bot"]["id"]):
                self.assertIs(type(row["rev"]), int)
                self.assertTrue(0 <= row["rev"] < 16 ** 13)
                body = env.thread(row["bot"]["id"])
                self.assertIs(type(body["rev"]), int)
                self.assertEqual(body["rev"], row["rev"])

    def test_the_same_data_gives_the_same_rev_in_two_services_and_after_another_refresh(self):
        script = (("c", "c1", 1), ("b", "b1", 2, False), ("n", "n1", 3, "c1"))
        first = seed(R3Env(self), *script)
        second = seed(R3Env(self), *script)
        value = rev_of(first)
        self.assertEqual(rev_of(second), value)
        first.refresh()
        self.assertEqual(rev_of(first), value)

    def test_every_step_of_a_conversation_has_its_own_rev(self):
        env = R3Env(self)
        seen = [rev_of(env)]
        env.mail.bot_says("bot-b", "one", 1, identifier=mid("b1"), seen=False)
        env.refresh()
        seen.append(rev_of(env))
        env.mail.bot_says("bot-b", "two", 2, identifier=mid("b2"), seen=False)
        env.refresh()
        seen.append(rev_of(env))
        env.mail.set_seen(mid("b1"), True)
        env.refresh()
        seen.append(rev_of(env))
        env.mail.set_seen(mid("b2"), True)
        env.refresh()
        seen.append(rev_of(env))
        env.mail.captain_says("bot-b", "reply", 3, identifier=mid("c1"))
        env.refresh()
        seen.append(rev_of(env))
        env.mail.note("bot-b", mid("c1"), 4)
        env.refresh()
        seen.append(rev_of(env))
        self.assertEqual(len(set(seen)), len(seen), seen)

    def test_a_note_that_changes_only_seen_up_to_and_seen_at_changes_rev(self):
        env = seed(R3Env(self), ("c", "c1", 1), ("c", "c2", 2))
        before = (rev_of(env), row_of(env)["unread"], env.thread()["firstUnread"], row_of(env)["last"])
        env.mail.note("bot-b", mid("c1"), 3)
        env.refresh()
        after = (rev_of(env), row_of(env)["unread"], env.thread()["firstUnread"], row_of(env)["last"])
        self.assertNotEqual(before[0], after[0])
        self.assertEqual(before[1:], after[1:])

    def test_a_change_of_the_first_unread_alone_changes_rev(self):
        env = seed(R3Env(self), ("b", "b1", 1, False), ("b", "b2", 2, False))
        before = rev_of(env)
        env.mail.set_seen(mid("b1"), True)
        env.refresh()
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (mid("b2"), True))
        self.assertNotEqual(rev_of(env), before)

    def test_a_new_last_message_changes_rev(self):
        env = seed(R3Env(self), ("b", "b1", 1, True))
        before = rev_of(env)
        env.mail.bot_says("bot-b", "more", 2, identifier=mid("b2"), seen=True)
        env.refresh()
        self.assertNotEqual(rev_of(env), before)

    def test_another_bots_traffic_leaves_rev_alone(self):
        env = seed(R3Env(self), ("b", "b1", 1, False))
        before = rev_of(env)
        env.mail.bot_says("bot-c", "elsewhere", 2, identifier=mid("x1"), seen=False)
        env.refresh()
        self.assertEqual(rev_of(env), before)

    def test_a_mark_read_changes_rev(self):
        env = seed(R3Env(self), ("c", "c1", 0), ("b", "b1", 1, False), ("b", "b2", 2, False))
        before = rev_of(env)
        self.assertEqual(env.read_status("bot-b", mid("b2"))[0], 200)
        after = rev_of(env)
        self.assertNotEqual(after, before)

    def test_the_stream_fires_for_a_chat_when_only_rev_changes(self):
        env = seed(R3Env(self), ("c", "c1", 1), ("c", "c2", 2))
        env.updates.check_once()
        version = env.updates.version
        self.assertFalse(env.updates.check_once())
        env.mail.note("bot-b", mid("c1"), 3)
        self.assertTrue(env.updates.check_once())
        self.assertGreater(env.updates.version, version)


class MarkReadTests(unittest.TestCase):
    def full(self):
        env = R3Env(self)
        env.mail.put(ACCOUNT, "CHAT: bot-b", chat_body("bot-b", "q0", client_id="k0", fresh=False), 0, mid("c0"), False)
        env.mail.captain_says("bot-b", "q1", 1, identifier=mid("c1"))
        env.mail.bot_says("bot-b", "a1", 2, identifier=mid("b1"), seen=False)
        env.mail.bot_says("bot-b", "a2", 3, identifier=mid("b2"), seen=False)
        env.mail.note("bot-b", mid("c1"), 4, identifier=mid("n1"))
        env.mail.bot_says("bot-b", "a3", 5, identifier=mid("b3"), seen=False)
        env.mail.bot_says("bot-c", "other", 6, identifier=mid("x1"), seen=False)
        env.mail.put("bot-c", "CHAT: bot-b", note_body("bot-b", mid("c1")), 3, mid("f1"), False)
        env.refresh()
        return env

    def test_it_sets_exactly_the_unseen_bot_mails_up_to_the_target(self):
        env = self.full()
        self.assertEqual(env.read_status("bot-b", mid("b2")), (200, {"csrf": "csrf-next", "freshUntil": 5000.0}))
        self.assertEqual(env.mail.marked, [[mid("b1"), mid("b2")]])

    def test_a_note_up_to_the_target_is_set_too_and_in_thread_order(self):
        env = self.full()
        self.assertEqual(env.read_status("bot-b", mid("b3"))[0], 200)
        self.assertEqual(env.mail.marked, [[mid("b1"), mid("b2"), mid("n1"), mid("b3")]])

    def test_a_mail_that_already_has_the_mark_is_left_out(self):
        env = self.full()
        env.mail.set_seen(mid("b1"), True)
        env.refresh()
        env.read_status("bot-b", mid("b3"))
        self.assertEqual(env.mail.marked, [[mid("b2"), mid("n1"), mid("b3")]])

    def test_his_messages_other_bots_and_forged_notes_are_never_set(self):
        env = self.full()
        env.read_status("bot-b", mid("b3"))
        every = {identifier for call in env.mail.marked for identifier in call}
        self.assertTrue(every.isdisjoint({mid("c0"), mid("c1"), mid("x1"), mid("f1")}))
        unseen = {message.id for message in env.mail.inbox if not message.seen}
        self.assertEqual(unseen, {mid("c0"), mid("x1"), mid("f1")})

    def test_nothing_to_set_makes_no_mail_call_and_still_answers_200(self):
        env = self.full()
        env.read_status("bot-b", mid("b3"))
        self.assertEqual(env.read_status("bot-b", mid("b3")), (200, {"csrf": "csrf-next", "freshUntil": 5000.0}))
        self.assertEqual(len(env.mail.marked), 1)

    def test_the_copy_shows_the_mark_at_once_without_a_refresh(self):
        env = self.full()
        self.assertEqual(env.thread()["firstUnread"], mid("b1"))
        env.read_status("bot-b", mid("b2"))
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (mid("b3"), True))
        env.read_status("bot-b", mid("b3"))
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (None, False))
        self.assertEqual(row_of(env, "bot-c")["unread"], True)

    def test_the_mark_survives_a_refresh_that_read_the_mail_before_it(self):
        env = self.full()
        stale = list(env.mail.inbox)
        original = env.mail.messages

        def during():
            self.assertEqual(env.read_status("bot-b", mid("b3"))[0], 200)
            return list(stale)

        env.mail.messages = during
        env.refresh()
        env.mail.messages = original
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (None, False))
        env.refresh()
        self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (None, False))

    def test_the_gate_sees_the_csrf_of_the_body(self):
        env = self.full()
        env.read_status("bot-b", mid("b2"), payload={"csrf": "the-one"})
        self.assertEqual(env.gate.csrf_seen[-1], "the-one")

    def test_a_bot_that_is_not_listed_is_422_bot_and_sets_nothing(self):
        env = self.full()
        for bot in ("nobody", ACCOUNT, "", None, 7, "BOT-B", ["bot-b"]):
            with self.subTest(bot=bot):
                self.assertEqual(env.read_status(bot, mid("b2")), (422, {"error": "bot"}))
        self.assertEqual(env.mail.marked, [])

    def test_a_target_that_is_not_one_of_the_bots_chat_messages_is_422_read_and_sets_nothing(self):
        env = self.full()
        for target in (mid("c1"), mid("n1"), mid("zz"), mid("x1"), mid("f1"), 5, None, True, ["b2"], "", "b" * 300):
            with self.subTest(target=target):
                self.assertEqual(env.read_status("bot-b", target), (422, {"error": "read"}))
        self.assertEqual(env.mail.marked, [])

    def test_the_bot_check_comes_before_the_target_check_and_the_gate_before_both(self):
        env = self.full()
        self.assertEqual(env.read_status("nobody", 5), (422, {"error": "bot"}))
        env.gate.refuse = application.SessionRefused("approval session required")
        self.assertEqual(env.read_status("nobody", 5), (401, {"error": "session"}))

    def test_a_malformed_request_is_400_before_anything_else(self):
        env = self.full()
        good = {"bot": "bot-b", "upTo": mid("b2"), "csrf": "t"}
        bodies = {
            "missing csrf": {"bot": "bot-b", "upTo": mid("b2")},
            "missing bot": {"upTo": mid("b2"), "csrf": "t"},
            "missing target": {"bot": "bot-b", "csrf": "t"},
            "extra key": {**good, "x": 1},
            "csrf number": {**good, "csrf": 5},
            "csrf null": {**good, "csrf": None},
            "list": [good],
            "null": None,
        }
        for name, payload in bodies.items():
            with self.subTest(name):
                sent = request("POST", READ_PATH, payload) if payload is not None else request("POST", READ_PATH, body=b"null", headers={"Content-Type": "application/json"})
                self.assertEqual(answer(env.web.handle(sent)), REFUSED)
        for name, sent in {
            "not json": request("POST", READ_PATH, body=b"nope", headers={"Content-Type": "application/json"}),
            "no content type": request("POST", READ_PATH, body=json.dumps(good).encode()),
            "wrong content type": request("POST", READ_PATH, body=json.dumps(good).encode(), headers={"Content-Type": "text/plain"}),
            "query": request("POST", READ_PATH + "?bot=bot-b", good),
        }.items():
            with self.subTest(name):
                self.assertEqual(answer(env.web.handle(sent)), REFUSED)
        self.assertEqual(env.mail.marked, [])

    def test_a_body_of_4096_bytes_is_read_and_one_more_is_refused(self):
        env = self.full()
        head = json.dumps({"bot": "bot-b", "upTo": mid("b2"), "csrf": "t"})
        for size, status in ((4096, 200), (4097, 400)):
            with self.subTest(size=size):
                body = (head + " " * (size - len(head))).encode()
                response = env.web.handle(request("POST", READ_PATH, body=body, headers={"Content-Type": "application/json"}))
                self.assertEqual(response.status, status)

    def test_a_gate_refusal_is_401_or_403_as_for_a_send_and_sets_nothing(self):
        env = self.full()
        env.gate.refuse = application.SessionRefused("approval session required")
        self.assertEqual(env.read_status("bot-b", mid("b2")), (401, {"error": "session"}))
        env.gate.refuse = None
        env.gate.csrf_error = approval_security.ApprovalRefused("card csrf is invalid")
        self.assertEqual(env.read_status("bot-b", mid("b2"))[0], 403)
        self.assertEqual(env.mail.marked, [])

    def test_thirty_marks_a_minute_pass_and_the_thirty_first_is_429_rate(self):
        env = self.full()
        statuses = [env.read_status("bot-b", mid("b2"))[0] for _ in range(30)]
        self.assertEqual(statuses, [200] * 30)
        self.assertEqual(env.read_status("bot-b", mid("b2")), (429, {"error": "rate"}))
        env.now += 59
        self.assertEqual(env.read_status("bot-b", mid("b2"))[0], 429)
        env.now += 2
        self.assertEqual(env.read_status("bot-b", mid("b2"))[0], 200)

    def test_the_mark_limit_is_per_session_and_apart_from_the_send_limit(self):
        env = self.full()
        for _ in range(30):
            env.read_status("bot-b", mid("b2"))
        self.assertEqual(env.read_status("bot-b", mid("b2"), token="session-two")[0], 200)
        self.assertEqual(env.send_with("bot-b", "Hi", token="session-one").status, 200)
        sends = [env.send_with("bot-b", f"hi {number}", token="session-three").status for number in range(10)]
        self.assertEqual(sends, [200] * 10)
        self.assertEqual(env.read_status("bot-b", mid("b2"), token="session-three")[0], 200)

    def test_refused_marks_do_not_count_toward_the_limit(self):
        env = self.full()
        for _ in range(40):
            self.assertEqual(env.read_status("bot-b", mid("zz"))[0], 422)
            self.assertEqual(env.read_status("nobody", mid("b2"))[0], 422)
        self.assertEqual([env.read_status("bot-b", mid("b2"))[0] for _ in range(30)], [200] * 30)

    def test_a_mail_failure_is_502_mail_at_once_and_the_copy_is_unchanged(self):
        for failure in (qd_jmap.MailFailed("down"), qd_jmap.Refused("no"), OSError("budget"), RuntimeError("odd")):
            with self.subTest(failure=type(failure).__name__):
                env = self.full()
                env.mail.mark_error = failure
                self.assertEqual(env.read_status("bot-b", mid("b3")), (502, {"error": "mail"}))
                self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (mid("b1"), True))
                env.mail.mark_error = None
                self.assertEqual(env.read_status("bot-b", mid("b3"))[0], 200)
                self.assertEqual((env.thread()["firstUnread"], row_of(env)["unread"]), (None, False))

    def test_a_mark_makes_no_mail_server_read(self):
        env = self.full()
        reads = env.mail.reads
        env.read_status("bot-b", mid("b3"))
        self.assertEqual(env.mail.reads, reads)

    def test_a_mark_needs_no_fresh_sign_in_and_does_not_extend_the_session(self):
        self.assertFalse(approval_security.requires_fresh("POST", READ_PATH))
        self.assertFalse(approval_security.activity_allowed("POST", READ_PATH, {}))
        self.assertTrue(approval_security.activity_allowed("POST", "/captain/api/chat", {}))

    def test_the_answer_carries_the_security_headers_and_json_type(self):
        env = self.full()
        response = env.read("bot-b", mid("b2"))
        headers = dict(response.headers)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_a_get_on_the_read_route_is_405_and_an_unknown_path_is_404(self):
        env = self.full()
        response = env.get(READ_PATH)
        self.assertEqual(response.status, 405)
        self.assertEqual(dict(response.headers)["Allow"], "POST")
        self.assertEqual(env.get(READ_PATH + "x").status, 404)
        for method in ("PUT", "DELETE"):
            self.assertEqual(env.web.handle(request(method, READ_PATH)).status, 405)

    def test_the_read_route_is_404_when_chat_is_not_wired(self):
        from test_chat_server import Env

        env = Env(self, with_chat=False)
        self.assertEqual(env.web.handle(request("POST", READ_PATH, {"bot": "bot-b", "upTo": "x", "csrf": "t"})).status, 404)


class AfterTests(unittest.TestCase):
    def long(self, count=56):
        env = R3Env(self)
        for number in range(count):
            env.mail.bot_says("bot-b", f"text {number}", number, identifier=f"m{number:03d}@qd.invalid")
        env.refresh()
        return env

    def test_after_gives_the_newer_messages_oldest_first_with_the_thread_fields(self):
        env = self.long(20)
        body = env.thread("bot-b", "bot=bot-b&after=m015@qd.invalid")
        self.assertEqual([message["id"] for message in body["messages"]], [f"m{n:03d}@qd.invalid" for n in range(16, 20)])
        self.assertEqual(set(body), set(env.thread("bot-b")))
        self.assertIs(body["older"], True)
        self.assertEqual(body["rev"], env.thread("bot-b")["rev"])
        self.assertEqual(body["features"], ["quote", "read", "cursor"])

    def test_after_the_newest_message_gives_an_empty_list(self):
        env = self.long(20)
        body = env.thread("bot-b", "bot=bot-b&after=m019@qd.invalid")
        self.assertEqual(body["messages"], [])

    def test_exactly_fifty_newer_messages_are_given_and_fifty_one_is_409_cursor(self):
        env = self.long(56)
        body = env.thread("bot-b", "bot=bot-b&after=m005@qd.invalid")
        self.assertEqual(len(body["messages"]), 50)
        self.assertEqual(body["messages"][0]["id"], "m006@qd.invalid")
        self.assertEqual(body["messages"][-1]["id"], "m055@qd.invalid")
        self.assertEqual(env.thread_status("bot=bot-b&after=m004@qd.invalid"), (409, {"error": "cursor"}))

    def test_an_id_that_is_not_in_the_thread_is_409_cursor(self):
        env = self.long(10)
        env.mail.bot_says("bot-c", "c", 3, identifier=mid("x1"))
        env.mail.note("bot-b", "m001@qd.invalid", 4, identifier=mid("n1"))
        env.mail.captain_says("bot-b", "mine", 5, identifier=mid("c1"))
        env.refresh()
        for cursor in ("nothing@qd.invalid", mid("x1"), mid("n1")):
            with self.subTest(cursor=cursor):
                self.assertEqual(env.thread_status("bot=bot-b&after=" + cursor), (409, {"error": "cursor"}))
        self.assertEqual(env.thread_status("bot=bot-b&after=" + mid("c1"))[0], 200)

    def test_the_service_refuses_after_together_with_before(self):
        env = self.long(10)
        with self.assertRaises(cards.CardRefused):
            env.service.chat_thread("bot-b", "m001@qd.invalid", "m002@qd.invalid")

    def test_a_malformed_or_doubled_cursor_is_400(self):
        env = self.long(10)
        for query in (
            "bot=bot-b&after=",
            "bot=bot-b&after=bad id",
            "bot=bot-b&after=m001@qd.invalid&before=m005@qd.invalid",
            "bot=bot-b&after=m001@qd.invalid&after=m002@qd.invalid",
            "after=m001@qd.invalid",
            "bot=bot-b&after=" + "a" * 257,
        ):
            with self.subTest(query=query):
                self.assertEqual(env.thread_status(query), REFUSED)

    def test_an_after_read_is_logged_as_a_thread_read(self):
        env = self.long(10)
        buffer, context = captured()
        with context:
            env.thread_status("bot=bot-b&after=m001@qd.invalid")
            env.thread_status("bot=bot-b&after=nothing@qd.invalid")
        routes = [REPLY.fullmatch(line.rstrip()).group(1, 2, 3) for line in lines_of(buffer)]
        self.assertEqual(routes, [("thread", "200", "-"), ("thread", "409", "cursor")])

    def test_an_after_read_makes_no_mail_server_read(self):
        env = self.long(10)
        reads = env.mail.reads
        env.thread_status("bot=bot-b&after=m001@qd.invalid")
        self.assertEqual(env.mail.reads, reads)


class FeatureTests(unittest.TestCase):
    def test_every_thread_answer_lists_quote_read_and_cursor_in_that_order(self):
        env = seed(R3Env(self), ("b", "b1", 1), ("b", "b2", 2))
        for query in ("bot=bot-b", "bot=bot-c", f"bot=bot-b&before={mid('b2')}", f"bot=bot-b&after={mid('b1')}"):
            with self.subTest(query=query):
                self.assertEqual(env.thread("bot-b", query)["features"], ["quote", "read", "cursor"])

    def test_the_row_list_stays_a_bare_list_of_rows_with_exactly_these_keys(self):
        env = seed(R3Env(self), ("b", "b1", 1))
        rows = env.rows()
        self.assertIsInstance(rows, list)
        for row in rows:
            self.assertEqual(set(row), {"bot", "preview", "at", "last", "unread", "rev"})

    def test_a_thread_has_exactly_these_keys_and_a_message_these(self):
        env = seed(R3Env(self), ("c", "c1", 1), ("b", "b1", 2))
        body = env.thread()
        self.assertEqual(set(body), {"bot", "rev", "features", "messages", "seenUpTo", "seenAt", "working", "firstUnread", "older"})
        self.assertIsNone(body["working"])
        first, second = body["messages"]
        self.assertEqual(set(first), {"id", "from", "text", "at", "refs", "quote", "files"})
        self.assertEqual((first["quote"], first["files"], second["quote"], second["files"]), (None, [], None, []))

    def test_a_send_that_carries_files_is_still_refused_and_sends_nothing(self):
        env = seed(R3Env(self))
        for files in ([], ["f-1"], None):
            with self.subTest(files=files):
                self.assertEqual(answer(env.send_with("bot-b", "Hi", files=files)), REFUSED)
        self.assertEqual(env.mail.send_calls, [])

    def test_the_send_answer_is_unchanged(self):
        env = seed(R3Env(self))
        status, body = answer(env.send_with("bot-b", "Hi", client_id="client-aaa"))
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"id", "from", "text", "at", "refs", "clientId", "uploadVerdicts", "csrf", "freshUntil"})

    def test_answers_match_the_agreed_samples(self):
        if not SAMPLES.is_dir():
            self.skipTest("samples folder is not beside this folder")
        thread = json.loads((SAMPLES / "thread-filled.json").read_text())
        rows = json.loads((SAMPLES / "rows.json").read_text())
        answer_sample = json.loads((SAMPLES / "read-answer.json").read_text())
        env = seed(R3Env(self), ("c", "c1", 1), ("b", "b1", 2, False))
        body = env.thread()
        self.assertEqual(set(body), set(thread))
        self.assertEqual(set(body["messages"][0]) - {"clientId"}, set(thread["messages"][1]) - {"clientId"})
        self.assertEqual(set(row_of(env)), set(rows[0]))
        self.assertEqual(set(env.read_status("bot-b", mid("b1"))[1]), set(answer_sample))
        self.assertTrue(set(body["bot"]) >= set(thread["bot"]))


class SampleReplayTests(unittest.TestCase):
    def setUp(self):
        if not SAMPLES.is_dir():
            self.skipTest("samples folder is not beside this folder")
        self.thread = json.loads((SAMPLES / "thread-filled.json").read_text())

    def build(self, count=4, last_seen=False):
        env = R3Env(self, checker=CardChecker())
        env.mail.card("Q176", 10, revisions=3)
        for number, message in enumerate(self.thread["messages"][:count]):
            sender = ACCOUNT if message["from"] == "captain" else "bot-a"
            document = {"qd": "chat/1", "bot": "bot-a", "text": message["text"]}
            if "clientId" in message:
                document["clientId"] = message["clientId"]
            quote = message["quote"]
            if quote is not None:
                document["quote"] = {"id": quote["id"], "text": quote["text"]} if "id" in quote else quote
            if message["files"]:
                document["files"] = message["files"]
            seen = number != 3 or last_seen
            tail = (seen, (message["id"],)) if CARRIES else (seen,)
            env.mail.inbox.append(cards.MailMessage(message["id"], sender, "CHAT: bot-a", json.dumps(document), message["at"], *tail))
        env.refresh()
        return env

    def test_the_thread_of_the_filled_sample_comes_back_with_the_same_values_where_it_is_built(self):
        env = self.build()
        body = env.thread("bot-a")
        left_out = ("rev", "features", "working", "bot", "messages")
        self.assertEqual({key: value for key, value in body.items() if key not in left_out}, {key: value for key, value in self.thread.items() if key not in left_out})
        self.assertEqual(body["messages"], [{**message, "files": []} for message in self.thread["messages"]])
        self.assertEqual(body["bot"]["id"], "bot-a")

    def test_the_row_of_the_filled_sample_comes_back_with_the_same_values(self):
        rows = json.loads((SAMPLES / "rows.json").read_text())
        env = self.build()
        row = row_of(env, "bot-a")
        self.assertEqual({key: value for key, value in row.items() if key not in ("rev", "bot")}, {key: value for key, value in rows[0].items() if key not in ("rev", "bot")})
        empty = row_of(env, "bot-b")
        self.assertEqual({key: value for key, value in empty.items() if key not in ("rev", "bot")}, {key: value for key, value in rows[1].items() if key not in ("rev", "bot")})

    def test_the_two_quote_requests_of_the_samples_are_accepted_and_the_mail_carries_them(self):
        for name in ("send-quote-message.json", "send-quote-card.json"):
            with self.subTest(name=name):
                env = self.build()
                payload = json.loads((SAMPLES / name).read_text())
                response = env.web.handle(request("POST", "/captain/api/chat", payload))
                self.assertEqual(response.status, 200, response.body)
                self.assertEqual(json.loads(env.mail.send_calls[0][2])["quote"], payload["quote"])

    def test_the_read_request_of_the_sample_is_accepted_and_answers_the_sample_keys(self):
        env = self.build()
        payload = json.loads((SAMPLES / "read-request.json").read_text())
        status, body = answer(env.web.handle(request("POST", READ_PATH, payload)))
        self.assertEqual(status, 200)
        self.assertEqual(set(body), set(json.loads((SAMPLES / "read-answer.json").read_text())))
        self.assertEqual(env.mail.marked, [[payload["upTo"]]])

    def test_the_seen_note_of_the_sample_sets_seen_up_to(self):
        env = self.build(count=3)
        note = json.loads((SAMPLES / "mail-chat-seen-1.json").read_text())
        env.mail.inbox.append(cards.MailMessage("Mn0a1", "bot-a", "CHAT: bot-a", json.dumps(note), "2026-11-06T15:45:30-05:00", False))
        env.refresh()
        body = env.thread("bot-a")
        self.assertEqual((body["seenUpTo"], body["seenAt"]), (note["upTo"], "2026-11-06T15:45:30-05:00"))
        self.assertEqual([message["id"] for message in body["messages"]], ["Mc0a1", "Mb0a2", "Mc0a3"])

    def test_the_mail_of_the_sample_with_a_quote_and_a_file_shows_the_quote_and_no_file(self):
        mail = json.loads((SAMPLES / "mail-chat-1-with-quote-and-file.json").read_text())
        env = R3Env(self)
        env.mail.inbox.append(cards.MailMessage("Mc0a1", ACCOUNT, "CHAT: bot-a", json.dumps({"qd": "chat/1", "bot": "bot-a", "text": mail["quote"]["text"], "clientId": "k1", "fresh": False}), "2026-11-06T15:40:00-05:00"))
        env.mail.inbox.append(cards.MailMessage("Mb0a2", "bot-a", "CHAT: bot-a", json.dumps(mail), "2026-11-06T15:42:00-05:00"))
        env.refresh()
        shown = env.thread("bot-a")["messages"][1]
        self.assertEqual(shown["quote"], {"id": "Mc0a1", "from": "captain", "at": "2026-11-06T15:40:00-05:00", "text": mail["quote"]["text"]})
        self.assertEqual(shown["files"], [])


class LogTests(unittest.TestCase):
    def test_a_mark_is_logged_as_route_read_with_the_status_and_error_word(self):
        env = MarkReadTests.full(self)
        buffer, context = captured()
        with context:
            env.read_status("bot-b", mid("b2"))
            env.read_status("nobody", mid("b2"))
            env.read_status("bot-b", mid("zz"))
            env.mail.mark_error = OSError("gone")
            env.read_status("bot-b", mid("b3"))
        got = [REPLY.fullmatch(line.rstrip()).group(1, 2, 3) for line in lines_of(buffer)]
        self.assertEqual(got, [("read", "200", "-"), ("read", "422", "bot"), ("read", "422", "read"), ("read", "502", "mail")])

    def test_no_log_line_carries_ids_text_or_names(self):
        env = MarkReadTests.full(self)
        buffer, context = captured()
        with context:
            env.read_status("bot-b", mid("b2"))
            env.thread("bot-b")
        text = buffer.getvalue()
        for word in ("qd.invalid", "text a1", "bot-b", "csrf"):
            self.assertNotIn(word, text)


class NoteOnTheMailScreenTests(MailCase):
    def test_a_seen_note_is_not_mail_on_the_screen_or_in_a_thread(self):
        messages = [
            standins.message(1, subject="CHAT: bot-a"),
            standins.message(2, subject="ASK: a real question"),
        ]
        api, _ = self.build(messages)
        response, _ = self.fetch(api, "/captain/mail")
        self.assertEqual(response.status, 200)
        threads = self.body_of(response)["threads"]
        self.assertEqual([item["subject"] for item in threads], ["ASK: a real question"])
        for item in threads:
            self.assertEqual(self.fetch(api, "/captain/mail/" + item["ref"])[0].status, 200)


class NoCommentsTests(unittest.TestCase):
    NEW = ("r3_helpers.py", "test_chat_r3.py", "test_chat_r3_line.py", "test_chat_r3_quotes.py", "test_chat_r3_mail.py", "test_chat_r3_fix1.py")

    def test_the_new_test_files_have_no_comments_or_docstrings(self):
        for name in self.NEW:
            with self.subTest(name=name):
                source = (HERE / name).read_text(encoding="utf-8")
                comments = [token for token in tokenize.generate_tokens(io.StringIO(source).readline) if token.type == tokenize.COMMENT]
                self.assertEqual(comments, [])
                tree = ast.parse(source)
                docs = [node for node in ast.walk(tree) if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and ast.get_docstring(node) is not None]
                self.assertEqual(docs, [])


if __name__ == "__main__":
    unittest.main()
