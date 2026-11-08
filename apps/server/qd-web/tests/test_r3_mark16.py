import ast
import io
import sys
import tokenize
import unittest
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import mail_gateway
import qd_jmap
import test_chat_r3_mail as gateway
from r3_helpers import chat_body
from test_chat_1a import SESSION
from test_chat_server import ACCOUNT

SEEN = gateway.SEEN
ACCOUNT_ID = gateway.ACCOUNT_ID
message_id = gateway.message_id
SIZES = (
    (1, [[1]]),
    (15, [[15]]),
    (16, [[16]]),
    (17, [[16, 1]]),
    (20, [[16, 4]]),
    (32, [[16, 16]]),
    (33, [[16, 16, 1]]),
    (128, [[16] * 8]),
    (129, [[16] * 8, [1]]),
    (130, [[16] * 8, [2]]),
    (144, [[16] * 8, [16]]),
)


def names_of(count):
    return [f"m{number:03d}" for number in range(count)]


def sets_of(source, posts, method="Email/set"):
    return [
        [len(arguments["update"]) for name, arguments, call_id in request if name == method]
        for request in source.posts[posts:]
        if any(name == method for name, arguments, call_id in request)
    ]


def updated_ids(source, posts):
    return Counter(
        identifier
        for request in source.posts[posts:]
        for name, arguments, call_id in request
        if name == "Email/set"
        for identifier in arguments["update"]
    )


class StandInTests(gateway.MailCase):
    def box(self, count=17):
        source = gateway.JmapServer()
        for name in names_of(count):
            gateway.bot_mail(source, "bot-b", f"text {name}", name)
        box = gateway.adapter(source)
        box.messages()
        return source, box

    def test_a_set_of_16_is_accepted_and_a_set_of_17_is_refused_with_nothing_changed(self):
        source, box = self.box(17)
        ids = [f"j-{name}" for name in names_of(17)]
        [done] = box.mailbox.jmap.call(("Email/set", {"update": {identifier: SEEN for identifier in ids[:16]}}))
        self.assertEqual(len(done["updated"]), 16)
        self.assertEqual(source.refused, [])
        with self.assertRaises(qd_jmap.MailFailed):
            box.mailbox.jmap.call(("Email/set", {"update": {identifier: SEEN for identifier in ids}}))
        self.assertEqual(source.refused, [("objects", 17)])
        self.assertEqual(source.keywords_of(ids[16]), {})

    def test_every_kind_of_object_in_a_set_counts_toward_the_16(self):
        source, box = self.box(17)
        ids = [f"j-{name}" for name in names_of(17)]
        with self.assertRaises(qd_jmap.MailFailed):
            box.mailbox.jmap.call(("Email/set", {"destroy": ids}))
        with self.assertRaises(qd_jmap.MailFailed):
            box.mailbox.jmap.call(("Email/set", {"update": {identifier: SEEN for identifier in ids[:9]}, "destroy": ids[9:]}))
        self.assertEqual(source.refused, [("objects", 17), ("objects", 17)])
        self.assertEqual(len(source.emails), 17)

    def test_eight_calls_in_a_request_are_accepted_and_nine_are_refused(self):
        source, box = self.box(1)
        probe = ("Email/get", {"ids": [], "properties": ["id"]})
        self.assertEqual(len(box.mailbox.jmap.call(*[probe] * 8)), 8)
        self.assertEqual(source.refused, [])
        with self.assertRaises(qd_jmap.MailFailed):
            box.mailbox.jmap.call(*[probe] * 9)
        self.assertEqual(source.refused, [("calls", 9)])


class MarkSetTests(gateway.MailCase):
    def world(self, count):
        source = gateway.JmapServer()
        gateway.bot_mail(source, "bot-c", "elsewhere one", "other-one")
        gateway.bot_mail(source, "bot-c", "elsewhere two", "other-two")
        source.add("inbox", "someone", ACCOUNT, "A plain mail", "just words", "j-plain", "plain")
        for name in names_of(count):
            gateway.bot_mail(source, "bot-b", f"text {name}", name)
        gateway.bot_mail(source, "bot-b", "a later one", "later")
        box = gateway.adapter(source)
        box.messages()
        return source, box

    def marked(self, count):
        source, box = self.world(count)
        posts = len(source.posts)
        self.mark(box, [message_id(name) for name in names_of(count)])
        return source, posts

    def assert_exact(self, source, posts, count, sizes):
        self.assertEqual(sets_of(source, posts), sizes)
        self.assertEqual(source.refused, [])
        self.assertEqual(updated_ids(source, posts), Counter({f"j-{name}": 1 for name in names_of(count)}))
        for name, arguments, call_id in (call for request in source.posts[posts:] for call in request):
            self.assertEqual(name, "Email/set")
            self.assertEqual(set(arguments), {"accountId", "update"})
            self.assertEqual(arguments["accountId"], ACCOUNT_ID)
            for patch in arguments["update"].values():
                self.assertEqual(patch, SEEN)
        self.assertEqual([source.keywords_of(f"j-{name}") for name in names_of(count)], [{"$seen": True}] * count)
        for untouched in ("j-other-one", "j-other-two", "j-plain", "j-later"):
            self.assertEqual(source.keywords_of(untouched), {}, untouched)

    def test_16_unread_mails_make_one_set_of_16(self):
        source, posts = self.marked(16)
        self.assert_exact(source, posts, 16, [[16]])
        self.assertEqual(len(source.posts) - posts, 1)

    def test_17_unread_mails_make_a_set_of_16_and_a_set_of_1_in_one_request(self):
        source, posts = self.marked(17)
        self.assert_exact(source, posts, 17, [[16, 1]])
        self.assertEqual(len(source.posts) - posts, 1)

    def test_20_unread_mails_make_a_set_of_16_and_a_set_of_4_in_one_request(self):
        source, posts = self.marked(20)
        self.assert_exact(source, posts, 20, [[16, 4]])
        self.assertEqual(len(source.posts) - posts, 1)

    def test_130_unread_mails_make_two_requests_the_first_with_eight_sets_of_16_and_the_second_with_one_set_of_2(self):
        source, posts = self.marked(130)
        self.assert_exact(source, posts, 130, [[16] * 8, [2]])
        self.assertEqual(len(source.posts) - posts, 2)

    def test_every_size_from_the_edges_up_to_a_second_request(self):
        for count, sizes in SIZES:
            with self.subTest(count=count):
                source, posts = self.marked(count)
                self.assert_exact(source, posts, count, sizes)
                self.assertEqual(len(source.posts) - posts, len(sizes))

    def test_a_refused_set_in_the_second_request_raises_after_the_first_request_was_set(self):
        source, box = self.world(130)
        source.not_updated.add("j-m129")
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id(name) for name in names_of(130)])
        self.assertEqual(source.keywords_of("j-m000"), {"$seen": True})
        self.assertEqual(source.keywords_of("j-m129"), {})

    def test_a_refused_id_in_the_first_set_raises(self):
        source, box = self.world(20)
        source.not_updated.add("j-m000")
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id(name) for name in names_of(20)])

    def test_the_sets_of_a_send_are_one_object_each_and_accepted(self):
        source = gateway.JmapServer()
        box = gateway.adapter(source)
        box.send_chat("bot-b", "CHAT: bot-b", chat_body("bot-b", "hi", client_id="k1", fresh=False), "chat:bot-b:k1")
        self.assertEqual(source.refused, [])
        sets = [arguments for request in source.posts for name, arguments, call_id in request if name == "Email/set"]
        self.assertEqual([len(arguments["create"]) for arguments in sets], [1])


class ReadRouteTests(gateway.MailCase):
    def seeded(self, count, later):
        source = gateway.JmapServer()
        gateway.bot_mail(source, "bot-c", "elsewhere one", "other-one")
        source.add("inbox", "someone", ACCOUNT, "A plain mail", "just words", "j-plain", "plain")
        for number in range(1, count + 1):
            gateway.bot_mail(source, "bot-b", f"bot says {number}", f"b{number:03d}")
        if later:
            gateway.bot_mail(source, "bot-b", "bot says later", "later")
        env = gateway.RealEnv(self, source)
        env.refresh()
        return source, env

    def read_all(self, count, later):
        source, env = self.seeded(count, later)
        self.assertEqual(env.first_unread(), message_id("b001"))
        self.assertIs(env.unread(), True)
        http = len(source.http)
        status, body = env.read_status("bot-b", message_id(f"b{count:03d}"))
        self.assertEqual((status, body), (200, {"csrf": "csrf-next", "freshUntil": 5000.0}))
        return source, env, len(source.http) - http

    def test_20_unread_mails_are_all_read_in_one_request_and_the_last_read_line_moves(self):
        source, env, requests = self.read_all(20, later=True)
        self.assertEqual(requests, 1)
        self.assertEqual(source.refused, [])
        self.assertEqual([source.keywords_of(f"j-b{number:03d}") for number in range(1, 21)], [{"$seen": True}] * 20)
        self.assertEqual(env.first_unread(), message_id("later"))
        env.refresh()
        self.assertEqual(env.first_unread(), message_id("later"))
        self.assertIs(env.unread(), True)
        for untouched in ("j-later", "j-other-one", "j-plain"):
            self.assertEqual(source.keywords_of(untouched), {}, untouched)

    def test_130_unread_mails_are_all_read_in_two_requests_and_nothing_stays_unread(self):
        source, env, requests = self.read_all(130, later=False)
        self.assertEqual(requests, 2)
        self.assertEqual(source.refused, [])
        self.assertEqual([source.keywords_of(f"j-b{number:03d}") for number in range(1, 131)], [{"$seen": True}] * 130)
        self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
        self.assertIs(env.unread(), False)
        env.refresh()
        self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
        self.assertIs(env.unread(), False)
        for untouched in ("j-other-one", "j-plain"):
            self.assertEqual(source.keywords_of(untouched), {}, untouched)

    def test_the_edges_16_and_17_are_read_in_one_request_with_nothing_left_unread(self):
        for count in (16, 17):
            with self.subTest(count=count):
                source, env, requests = self.read_all(count, later=False)
                self.assertEqual(requests, 1)
                self.assertEqual(source.refused, [])
                self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
                self.assertIs(env.unread(), False)
                self.assertEqual([source.keywords_of(f"j-b{number:03d}") for number in range(1, count + 1)], [{"$seen": True}] * count)

    def test_a_mark_through_a_middle_message_reads_only_up_to_it(self):
        source, env = self.seeded(40, later=False)
        status, body = env.read_status("bot-b", message_id("b020"))
        self.assertEqual(status, 200)
        self.assertEqual(source.refused, [])
        self.assertEqual([source.keywords_of(f"j-b{number:03d}") for number in range(1, 41)], [{"$seen": True}] * 20 + [{}] * 20)
        self.assertEqual(env.first_unread(), message_id("b021"))


class AckSetTests(gateway.MailCase):
    def world(self, copies, handled=0):
        source = gateway.JmapServer()
        for number in range(copies):
            keywords = {qd_jmap.HANDLED: True} if number < handled else None
            source.add("inbox", "bot-b", ACCOUNT, "CHAT: bot-b", chat_body("bot-b", "same words"), f"j-dup-{number:03d}", "dup", keywords)
        source.add("inbox", "bot-b", ACCOUNT, "CHAT: bot-b", chat_body("bot-b", "other words"), "j-other", "other")
        credential = qd_jmap.Credential(bytearray(b"stand-in"))
        return source, qd_jmap.Mailbox(qd_jmap.Jmap(SESSION, credential, source))

    def acked(self, copies, handled=0):
        source, box = self.world(copies, handled)
        posts = len(source.posts)
        box.ack(message_id("dup"))
        return source, posts

    def test_every_copy_is_marked_handled_in_sets_of_at_most_16_and_8_sets_to_a_request(self):
        cases = ((1, [[1]]), (15, [[15]]), (16, [[16]]), (17, [[16, 1]]), (20, [[16, 4]]), (128, [[16] * 8]), (129, [[16] * 8, [1]]), (130, [[16] * 8, [2]]))
        for copies, sizes in cases:
            with self.subTest(copies=copies):
                source, posts = self.acked(copies)
                self.assertEqual(sets_of(source, posts), sizes)
                self.assertEqual(source.refused, [])
                self.assertEqual(updated_ids(source, posts), Counter({f"j-dup-{number:03d}": 1 for number in range(copies)}))
                self.assertEqual([source.keywords_of(f"j-dup-{number:03d}") for number in range(copies)], [{qd_jmap.HANDLED: True}] * copies)
                self.assertEqual(source.keywords_of("j-other"), {})
                self.assertEqual(len([request for request in source.posts[posts:] if any(name == "Email/set" for name, arguments, call_id in request)]), len(sizes))

    def test_copies_that_are_already_handled_are_left_out_of_the_sets(self):
        source, posts = self.acked(20, handled=5)
        self.assertEqual(sets_of(source, posts), [[15]])
        self.assertEqual(source.refused, [])

    def test_nothing_is_set_when_every_copy_is_handled(self):
        source, posts = self.acked(20, handled=20)
        self.assertEqual(sets_of(source, posts), [])

    def test_a_copy_the_server_does_not_confirm_in_any_set_is_a_mail_failure(self):
        for copies, victim in ((20, "j-dup-000"), (20, "j-dup-019"), (130, "j-dup-129")):
            with self.subTest(copies=copies, victim=victim):
                source, box = self.world(copies)
                source.not_updated.add(victim)
                with self.assertRaises(qd_jmap.MailFailed):
                    box.ack(message_id("dup"))

    def test_a_message_that_is_not_in_the_inbox_is_still_refused(self):
        source, box = self.world(3)
        with self.assertRaises(qd_jmap.Refused):
            box.ack(message_id("nobody"))


class EverySetCallSiteTests(unittest.TestCase):
    def sites(self, name):
        tree = ast.parse((PKG / name).read_text(encoding="utf-8"))
        return [
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and node.value == "Email/set"
        ]

    def test_the_package_has_exactly_the_known_email_set_call_sites(self):
        found = {}
        for path in sorted(PKG.glob("*.py")):
            sites = self.sites(path.name)
            if sites:
                found[path.name] = len(sites)
        self.assertEqual(found, {"mail_gateway.py": 1, "qd_jmap.py": 3})

    def test_the_mark_names_sets_of_16_and_8_sets_to_a_request(self):
        self.assertEqual(mail_gateway.MARK_PER_CALL, 16)
        self.assertEqual(mail_gateway.MARK_CALLS, 8)


class NoCommentsTests(unittest.TestCase):
    def test_this_file_has_no_comments_or_docstrings(self):
        source = Path(__file__).read_text(encoding="utf-8")
        comments = [token for token in tokenize.generate_tokens(io.StringIO(source).readline) if token.type == tokenize.COMMENT]
        self.assertEqual(comments, [])
        tree = ast.parse(source)
        docs = [node for node in ast.walk(tree) if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef)) and ast.get_docstring(node)]
        self.assertEqual(docs, [])
        self.assertNotIn("\u2014", source)
        self.assertNotIn("\u2013", source)
