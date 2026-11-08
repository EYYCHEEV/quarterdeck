import ast
import contextlib
import inspect
import io
import json
import re
import sys
import tokenize
import types
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import live
import mail_gateway
import mailstate
import qd_jmap
import security
from r3_helpers import CardChecker, R3Env, chat_body, note_body
from test_chat_1a import FakeMailServer, patience_of
from test_chat_1a import adapter as plain_adapter
from test_chat_server import ACCOUNT, STEWARD, answer
from test_qd_web_budget import Clock

ACCOUNT_ID = "a1"
HOST = "qd.invalid"
SEEN = {"keywords/$seen": True}
KEEP = object()
SET_LIMIT = 16
CALL_LIMIT = 8
PARAMETERS = inspect.signature(mail_gateway.CaptainMailbox).parameters


class Unknown(Exception):
    pass


def option(value):
    return {"incremental": value} if "incremental" in PARAMETERS else {}


def adapter(source, budget=None, **options):
    box = plain_adapter(source, budget, **options)
    listing = box.messages

    def messages():
        rows = listing()
        box.listed = {row.id: row for row in rows}
        return rows

    box.messages = messages
    return box


def carried(row, identifier):
    return list(getattr(row, "mail_ids", None) or [identifier])


def message_id(name):
    return f"{name}@{HOST}"


def bot_mail(source, bot, text, name, *, identifier=None, keywords=None):
    return source.add("inbox", bot, ACCOUNT, f"CHAT: {bot}", chat_body(bot, text), identifier or f"j-{name}", name, keywords)


def captain_mail(source, bot, text, name, *, identifier=None):
    body = chat_body(bot, text, client_id=f"c-{name}", fresh=False)
    return source.add("sent", ACCOUNT, bot, f"CHAT: {bot}", body, identifier or f"j-{name}", name, {"$seen": True})


def note_mail(source, sender, bot, up_to, name):
    return source.add("inbox", sender, ACCOUNT, f"CHAT: {bot}", note_body(bot, up_to), f"j-{name}", name)


class JmapServer(FakeMailServer):
    def __init__(self):
        super().__init__()
        self.state = 1
        self.history = []
        self.http = []
        self.posts = []
        self.get_log = []
        self.changes_asked = []
        self.changes_error = None
        self.changes_state = KEEP
        self.more_changes = False
        self.broken = {}
        self.not_updated = set()
        self.silent = set()
        self.set_error = None
        self.refused = []

    def current(self):
        return f"s{self.state}"

    def touch(self, kind, identifier):
        self.state += 1
        self.history.append((self.state, kind, identifier))

    def add(self, box, sender, recipient, subject, body, identifier=None, name=None, keywords=None):
        identifier = super().add(box, sender, recipient, subject, body, identifier)
        row = self.emails[identifier]
        row["messageId"] = [f"{name or identifier}@{HOST}"]
        if keywords is not None:
            row["keywords"] = dict(keywords)
        self.touch("created", identifier)
        return identifier

    def move(self, identifier, box):
        super().move(identifier, box)
        self.touch("updated", identifier)

    def drop(self, identifier):
        del self.emails[identifier]
        self.touch("destroyed", identifier)

    def hide(self, identifier):
        del self.emails[identifier]
        self.touch("updated", identifier)

    def flag(self, identifier, keyword, on=True):
        keywords = self.emails[identifier].setdefault("keywords", {})
        if on:
            keywords[keyword] = True
        else:
            keywords.pop(keyword, None)
        self.touch("updated", identifier)

    def keywords_of(self, identifier):
        return dict(self.emails[identifier].get("keywords", {}))

    def __call__(self, method, url, headers, body=None):
        self.http.append(method)
        if method == "GET":
            return super().__call__(method, url, headers, body)
        calls = json.loads(body)["methodCalls"]
        self.posts.append(calls)
        self.requests.append([name for name, arguments, call_id in calls])
        if len(calls) > CALL_LIMIT:
            self.refused.append(("calls", len(calls)))
            return 400, b""
        for name, arguments, call_id in calls:
            fault = self.broken.get("update" if name == "Email/set" and "update" in arguments else name)
            if fault == "down":
                raise OSError("down")
            if isinstance(fault, int):
                return fault, b""
        responses = []
        for name, arguments, call_id in calls:
            try:
                responses.append([name, self.answer(name, arguments), call_id])
            except Unknown as refusal:
                responses.append(["error", {"type": refusal.args[0]}, call_id])
        return 200, json.dumps({"methodResponses": responses}).encode()

    def answer(self, name, arguments):
        if name == "Email/set":
            objects = sum(len(arguments.get(kind) or {}) for kind in ("create", "update", "destroy"))
            if objects > SET_LIMIT:
                self.refused.append(("objects", objects))
                raise Unknown("requestTooLarge")
        if name == "Email/changes":
            return self.changes(arguments["sinceState"])
        if name == "Email/get":
            ids = list(arguments["ids"])
            properties = arguments.get("properties")
            boxes = sorted({box for identifier in ids if identifier in self.emails for box in self.emails[identifier]["mailboxIds"]})
            self.get_log.append({"properties": None if properties is None else list(properties), "ids": ids, "boxes": boxes})
            answered = super().answer(name, arguments)
            answered["state"] = self.current()
            return answered
        if name == "Email/set" and "update" in arguments:
            return self.update(arguments["update"])
        answered = super().answer(name, arguments)
        if name == "Email/set":
            self.emails[self.draft]["keywords"] = dict(arguments["create"]["m"].get("keywords", {}))
        if name == "EmailSubmission/set":
            self.emails[self.draft].get("keywords", {}).pop("$draft", None)
        return answered

    def update(self, changes):
        if self.set_error is not None:
            raise Unknown(self.set_error)
        done, refused = {}, {}
        for identifier, patch in changes.items():
            if identifier in self.not_updated or identifier not in self.emails:
                refused[identifier] = {"type": "notFound"}
                continue
            if identifier in self.silent:
                continue
            keywords = self.emails[identifier].setdefault("keywords", {})
            for path, value in patch.items():
                keyword = path.removeprefix("keywords/")
                if value is None:
                    keywords.pop(keyword, None)
                else:
                    keywords[keyword] = value
            self.touch("updated", identifier)
            done[identifier] = None
        return {"updated": done or None, "notUpdated": refused or None}

    def changes(self, since):
        self.changes_asked.append(since)
        if self.changes_error is not None:
            raise Unknown(self.changes_error)
        if not (isinstance(since, str) and re.fullmatch(r"s\d+", since)):
            raise Unknown("cannotCalculateChanges")
        events = [event for event in self.history if event[0] > int(since[1:])]
        gone = {identifier for state, kind, identifier in events if kind == "destroyed"}
        made = [identifier for state, kind, identifier in events if kind == "created" and identifier not in gone]
        changed = []
        for state, kind, identifier in events:
            if kind == "updated" and identifier not in gone and identifier not in made and identifier not in changed:
                changed.append(identifier)
        return {
            "oldState": since,
            "newState": self.current() if self.changes_state is KEEP else self.changes_state,
            "hasMoreChanges": self.more_changes,
            "created": list(dict.fromkeys(made)),
            "updated": changed,
            "destroyed": sorted(gone),
        }


class RealEnv(R3Env):
    def __init__(self, case, source, **options):
        self.source = source
        self.box = adapter(source, **options)
        super().__init__(case, checker=CardChecker())

    def rewire(self, names=None):
        self.mail = self.box
        super().rewire(names)

    def first_unread(self, bot="bot-b"):
        return self.thread(bot).get("firstUnread", "absent")

    def unread(self, bot="bot-b"):
        return self.row(bot).get("unread", "absent")


class MailCase(unittest.TestCase):
    def setUp(self):
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def hint(self, box, state):
        self.assertTrue(callable(getattr(box, "note_state", None)), "note_state is missing")
        box.note_state(state)

    def mark(self, box, ids):
        self.assertTrue(callable(getattr(box, "mark_seen", None)), "mark_seen is missing")
        listed = getattr(box, "listed", {})
        return box.mark_seen([name for identifier in ids for name in carried(listed.get(identifier), identifier)])

    def read(self, box, source, state=None):
        self.hint(box, source.current() if state is None else state)
        return box.messages()

    def full(self, source):
        return adapter(source).messages()

    def seen_of(self, messages):
        return {message.id: getattr(message, "seen", None) for message in messages}

    def names_since(self, source, mark):
        return [name for request in source.posts[mark:] for name, arguments, call_id in request]

    def calls_since(self, source, mark):
        return [(name, arguments) for request in source.posts[mark:] for name, arguments, call_id in request]

    def sent_bodies(self, source):
        return [row["bodyValues"]["1"]["value"] for row in source.emails.values() if row["mailboxIds"].get("sent")]

    def napper(self, clock, naps):
        def nap(seconds):
            naps.append(seconds)
            clock.now += seconds

        return nap


class KeywordTests(MailCase):
    def test_the_inbox_listing_asks_for_keywords(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "b1")
        adapter(source).messages()
        inbox_gets = [entry for entry in source.get_log if entry["boxes"] == ["inbox"]]
        self.assertTrue(inbox_gets)
        for entry in inbox_gets:
            self.assertIn("keywords", entry["properties"])

    def test_seen_is_true_only_when_the_keywords_have_seen_true(self):
        cases = (
            ("no keywords property", None, False),
            ("empty keywords", {}, False),
            ("flagged only", {"$flagged": True}, False),
            ("answered and draft", {"$answered": True, "$draft": True}, False),
            ("seen false", {"$seen": False}, False),
            ("seen", {"$seen": True}, True),
            ("seen and flagged", {"$seen": True, "$flagged": True}, True),
        )
        source = JmapServer()
        for number, (label, keywords, wanted) in enumerate(cases):
            bot_mail(source, "bot-b", label, f"k{number}", keywords=keywords)
        got = self.seen_of(adapter(source).messages())
        self.assertEqual(len(got), len(cases))
        for number, (label, keywords, wanted) in enumerate(cases):
            with self.subTest(label=label):
                self.assertIs(got[message_id(f"k{number}")], wanted)

    def test_a_sent_copy_of_his_own_message_reads_as_seen_when_the_server_says_so(self):
        source = JmapServer()
        captain_mail(source, "bot-b", "hello", "c1")
        messages = adapter(source).messages()
        self.assertEqual([(message.id, message.sender, getattr(message, "seen", None)) for message in messages], [(message_id("c1"), ACCOUNT, True)])

    def test_a_message_sent_through_the_gateway_reads_as_seen_in_the_next_listing(self):
        source = JmapServer()
        box = adapter(source)
        sent, fresh = box.send_chat("bot-b", "CHAT: bot-b", chat_body("bot-b", "hi", client_id="k1", fresh=False), "chat:bot-b:k1")
        [message] = box.messages()
        self.assertEqual((message.id, message.sender, getattr(message, "seen", None)), (sent, ACCOUNT, True))


class MarkSeenTests(MailCase):
    def world(self, count=2):
        source = JmapServer()
        for number in range(count):
            bot_mail(source, "bot-b", f"text {number}", f"m{number:03d}")
        box = adapter(source)
        box.messages()
        return source, box

    def test_one_message_makes_one_http_request_with_one_set_that_adds_only_seen(self):
        source, box = self.world(2)
        http, posts = len(source.http), len(source.posts)
        self.mark(box, [message_id("m001")])
        self.assertEqual(len(source.http) - http, 1)
        self.assertEqual(
            [[(name, arguments) for name, arguments, call_id in request] for request in source.posts[posts:]],
            [[("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-m001": SEEN}})]],
        )
        self.assertEqual(source.keywords_of("j-m001"), {"$seen": True})
        self.assertEqual(source.keywords_of("j-m000"), {})

    def test_the_other_keywords_of_the_message_are_left_alone(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "text", "m1", keywords={"$flagged": True, "$answered": True})
        box = adapter(source)
        box.messages()
        posts = len(source.posts)
        self.mark(box, [message_id("m1")])
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-m1": SEEN}})])
        self.assertEqual(source.keywords_of("j-m1"), {"$flagged": True, "$answered": True, "$seen": True})

    def test_every_inbox_copy_of_one_message_id_is_updated_in_one_call(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "text", "dup", identifier="j-dup-1")
        bot_mail(source, "bot-b", "text", "dup", identifier="j-dup-2")
        source.emails["j-dup-2"]["receivedAt"] = source.emails["j-dup-1"]["receivedAt"]
        bot_mail(source, "bot-b", "other", "other")
        box = adapter(source)
        box.messages()
        posts = len(source.posts)
        self.mark(box, [message_id("dup")])
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-dup-1": SEEN, "j-dup-2": SEEN}})])
        self.assertEqual([source.keywords_of(name) for name in ("j-dup-1", "j-dup-2", "j-other")], [{"$seen": True}, {"$seen": True}, {}])

    def test_an_already_read_message_can_be_passed_and_is_set_again_without_harm(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "text", "m1", keywords={"$seen": True, "$flagged": True})
        box = adapter(source)
        box.messages()
        posts = len(source.posts)
        self.mark(box, [message_id("m1")])
        self.assertEqual(len(source.posts) - posts, 1)
        self.assertEqual(source.keywords_of("j-m1"), {"$seen": True, "$flagged": True})

    def test_several_messages_go_in_one_method_call_of_one_request(self):
        source, box = self.world(5)
        posts = len(source.posts)
        self.mark(box, [message_id(f"m{number:03d}") for number in (4, 0, 2)])
        self.assertEqual(len(source.posts) - posts, 1)
        [(name, arguments)] = self.calls_since(source, posts)
        self.assertEqual((name, arguments), ("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-m004": SEEN, "j-m000": SEEN, "j-m002": SEEN}}))
        self.assertEqual(source.keywords_of("j-m001"), {})

    def test_an_empty_list_makes_no_http_request(self):
        source, box = self.world()
        http = len(source.http)
        self.mark(box, [])
        self.assertEqual(len(source.http), http)

    def test_an_unknown_message_id_raises_mail_failed_and_makes_no_request(self):
        source, box = self.world()
        http = len(source.http)
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id("nobody")])
        self.assertEqual(len(source.http), http)

    def test_one_unknown_id_among_known_ones_raises_before_anything_is_set(self):
        source, box = self.world(3)
        http = len(source.http)
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id("m000"), message_id("nobody"), message_id("m001")])
        self.assertEqual(len(source.http), http)
        self.assertEqual([source.keywords_of(name) for name in ("j-m000", "j-m001")], [{}, {}])

    def test_a_mark_before_any_listing_raises_mail_failed_and_makes_no_request(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "text", "m1")
        box = adapter(source)
        http = len(source.http)
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id("m1")])
        self.assertEqual(len(source.http), http)

    def test_a_message_that_arrived_after_the_last_listing_is_unknown_until_the_next_one(self):
        source, box = self.world(1)
        bot_mail(source, "bot-b", "late", "late")
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id("late")])
        box.messages()
        self.mark(box, [message_id("late")])
        self.assertEqual(source.keywords_of("j-late"), {"$seen": True})

    def test_a_message_that_exists_only_in_sent_raises_mail_failed_and_makes_no_request(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "text", "m1")
        captain_mail(source, "bot-b", "mine", "c1")
        box = adapter(source)
        box.messages()
        http = len(source.http)
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id("c1")])
        self.assertEqual(len(source.http), http)
        self.assertEqual(source.keywords_of("j-c1"), {"$seen": True})

    def test_only_the_inbox_copy_is_updated_when_sent_holds_the_same_message_id(self):
        source = JmapServer()
        source.add("inbox", "bot-b", ACCOUNT, "CHAT: bot-b", chat_body("bot-b", "x"), "j-inbox", "both")
        source.add("sent", ACCOUNT, "bot-b", "CHAT: bot-b", chat_body("bot-b", "x", client_id="c", fresh=False), "j-sent", "both", {})
        box = adapter(source)
        box.messages()
        posts = len(source.posts)
        self.mark(box, [message_id("both")])
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-inbox": SEEN}})])
        self.assertEqual((source.keywords_of("j-inbox"), source.keywords_of("j-sent")), ({"$seen": True}, {}))

    def only_seen(self, source, posts):
        for name, arguments in self.calls_since(source, posts):
            self.assertEqual(name, "Email/set")
            self.assertEqual(set(arguments), {"accountId", "update"})
            self.assertEqual(arguments["accountId"], ACCOUNT_ID)
            for patch in arguments["update"].values():
                self.assertEqual(patch, SEEN)

    def test_two_hundred_and_fifty_messages_make_sets_of_16_with_eight_sets_to_a_request(self):
        source, box = self.world(250)
        posts = len(source.posts)
        self.mark(box, [message_id(f"m{number:03d}") for number in range(250)])
        sizes = [[len(arguments["update"]) for name, arguments, call_id in request] for request in source.posts[posts:]]
        self.assertEqual(sizes, [[16] * 8, [16] * 7 + [10]])
        self.assertEqual(source.refused, [])
        self.only_seen(source, posts)
        counts = Counter(identifier for name, arguments in self.calls_since(source, posts) for identifier in arguments["update"])
        self.assertEqual(counts, Counter({f"j-m{number:03d}": 1 for number in range(250)}))
        self.assertTrue(all(row.get("keywords") == {"$seen": True} for row in source.emails.values()))

    def test_eight_hundred_and_fifty_messages_make_seven_requests_and_every_id_is_set_once(self):
        source, box = self.world(850)
        posts = len(source.posts)
        self.mark(box, [message_id(f"m{number:03d}") for number in range(850)])
        sizes = [[len(arguments["update"]) for name, arguments, call_id in request] for request in source.posts[posts:]]
        self.assertEqual(sizes, [[16] * 8] * 6 + [[16] * 5 + [2]])
        self.assertEqual(source.refused, [])
        self.only_seen(source, posts)
        counts = Counter(identifier for name, arguments in self.calls_since(source, posts) for identifier in arguments["update"])
        self.assertEqual(counts, Counter({f"j-m{number:03d}": 1 for number in range(850)}))
        self.assertTrue(all(row.get("keywords") == {"$seen": True} for row in source.emails.values()))

    def test_an_answer_that_does_not_confirm_every_id_raises_mail_failed(self):
        cases = (
            ("the only id refused", 1, lambda source: source.not_updated.add("j-m000")),
            ("one of three refused", 3, lambda source: source.not_updated.add("j-m001")),
            ("one of three left out of the answer", 3, lambda source: source.silent.add("j-m001")),
            ("every id refused", 3, lambda source: source.not_updated.update({"j-m000", "j-m001", "j-m002"})),
            ("a method error", 3, lambda source: setattr(source, "set_error", "serverFail")),
        )
        for label, count, arrange in cases:
            with self.subTest(label=label):
                source, box = self.world(count)
                arrange(source)
                with self.assertRaises(qd_jmap.MailFailed):
                    self.mark(box, [message_id(f"m{number:03d}") for number in range(count)])

    def test_a_refused_id_in_the_last_call_of_a_long_list_raises_mail_failed(self):
        source, box = self.world(250)
        source.not_updated.add("j-m249")
        with self.assertRaises(qd_jmap.MailFailed):
            self.mark(box, [message_id(f"m{number:03d}") for number in range(250)])

    def test_a_transport_or_http_failure_raises_mail_failed(self):
        for label, fault in (("unreachable", "down"), ("503", 503), ("429", 429), ("401", 401)):
            with self.subTest(label=label):
                source, box = self.world(2)
                source.broken["update"] = fault
                with self.assertRaises(qd_jmap.MailFailed):
                    self.mark(box, [message_id("m000")])
                self.assertEqual(source.keywords_of("j-m000"), {})


class NoWaitTests(MailCase):
    def build(self, pause=5.0):
        clock = Clock()
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "m1")
        budget = mailstate.Budget(clock, first_pause=pause)
        box = adapter(source, budget, **patience_of(budget))
        box.messages()
        clock.now += 61.0
        return clock, source, budget, box

    def test_a_mark_during_a_five_second_pause_raises_at_once_and_does_not_sleep(self):
        clock, source, budget, box = self.build(5.0)
        budget.admit()
        budget.settle(False)
        naps = []
        posts = len(source.posts)
        with mock.patch("time.sleep", self.napper(clock, naps)):
            with self.assertRaises((qd_jmap.MailFailed, OSError)):
                self.mark(box, [message_id("m1")])
        self.assertEqual(naps, [])
        self.assertEqual(len(source.posts), posts)
        self.assertEqual(source.keywords_of("j-m1"), {})

    def test_a_mark_in_a_used_up_minute_raises_at_once_and_does_not_sleep(self):
        clock, source, budget, box = self.build()
        for _ in range(mailstate.LIMIT):
            budget.admit()
        naps = []
        posts = len(source.posts)
        with mock.patch("time.sleep", self.napper(clock, naps)):
            with self.assertRaises((qd_jmap.MailFailed, OSError)):
                self.mark(box, [message_id("m1")])
        self.assertEqual(naps, [])
        self.assertEqual(len(source.posts), posts)

    def test_a_mark_never_opens_the_patient_window_that_a_send_opens(self):
        clock = Clock()
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "m1")
        budget = mailstate.Budget(clock)
        opened = []

        def patient(seconds):
            opened.append(seconds)
            return budget.patient(seconds)

        box = adapter(source, budget, patient=patient)
        box.messages()
        self.mark(box, [message_id("m1")])
        self.assertEqual(opened, [])
        self.assertEqual(source.keywords_of("j-m1"), {"$seen": True})
        box.send("bot-b", "CHAT: bot-b", "body", "key-1")
        self.assertEqual(opened, [mail_gateway.SEND_WAIT_SECONDS])

    def test_the_mark_works_again_once_the_pause_is_over(self):
        clock, source, budget, box = self.build(5.0)
        budget.admit()
        budget.settle(False)
        naps = []
        with mock.patch("time.sleep", self.napper(clock, naps)):
            with self.assertRaises((qd_jmap.MailFailed, OSError)):
                self.mark(box, [message_id("m1")])
            clock.now += 6.0
            self.mark(box, [message_id("m1")])
        self.assertEqual(naps, [])
        self.assertEqual(source.keywords_of("j-m1"), {"$seen": True})


class EndToEndTests(MailCase):
    def seeded(self, count=3, **options):
        source = JmapServer()
        for number in range(1, count + 1):
            bot_mail(source, "bot-b", f"bot says {number}", f"b{number}")
        env = RealEnv(self, source, **options)
        env.refresh()
        return source, env

    def test_the_first_unread_message_and_the_row_dot_come_through_the_real_mailbox(self):
        source, env = self.seeded(2)
        self.assertEqual(env.first_unread(), message_id("b1"))
        self.assertIs(env.unread(), True)

    def test_mark_read_sets_seen_on_exactly_those_messages_in_one_request_and_answers_200(self):
        source, env = self.seeded(3)
        http, posts = len(source.http), len(source.posts)
        status, body = env.read_status("bot-b", message_id("b2"))
        self.assertEqual((status, body), (200, {"csrf": "csrf-next", "freshUntil": 5000.0}))
        self.assertEqual(len(source.http) - http, 1)
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-b1": SEEN, "j-b2": SEEN}})])
        self.assertEqual([source.keywords_of(name) for name in ("j-b1", "j-b2", "j-b3")], [{"$seen": True}, {"$seen": True}, {}])

    def test_the_next_reads_show_nothing_unread_with_no_mail_request_and_no_refresh(self):
        source, env = self.seeded(2)
        self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
        http = len(source.http)
        self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
        self.assertIs(env.unread(), False)
        self.assertEqual(len(source.http), http)

    def test_a_refresh_after_the_mark_still_shows_nothing_unread(self):
        source, env = self.seeded(2)
        self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
        env.refresh()
        self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
        self.assertIs(env.unread(), False)

    def test_a_message_after_the_marked_one_stays_unread_and_a_mark_set_elsewhere_shows_after_a_refresh(self):
        source, env = self.seeded(3)
        self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
        self.assertEqual(env.first_unread(), message_id("b3"))
        env.refresh()
        self.assertEqual(env.first_unread(), message_id("b3"))
        self.assertIs(env.unread(), True)
        source.flag("j-b3", "$seen")
        self.assertEqual(env.first_unread(), message_id("b3"))
        env.refresh()
        self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
        self.assertIs(env.unread(), False)

    def test_a_message_already_read_elsewhere_is_not_set_again(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "b1", keywords={"$seen": True})
        bot_mail(source, "bot-b", "two", "b2")
        env = RealEnv(self, source)
        env.refresh()
        self.assertEqual(env.first_unread(), message_id("b2"))
        posts = len(source.posts)
        self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
        self.assertEqual(self.calls_since(source, posts), [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-b2": SEEN}})])

    def test_nothing_to_set_answers_200_and_makes_no_mail_request(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "b1", keywords={"$seen": True})
        env = RealEnv(self, source)
        env.refresh()
        http = len(source.http)
        self.assertEqual(env.read_status("bot-b", message_id("b1"))[0], 200)
        self.assertEqual(len(source.http), http)

    def test_a_valid_note_before_the_mark_is_set_too_and_forged_later_and_other_mail_is_not(self):
        source = JmapServer()
        captain_mail(source, "bot-b", "hello", "c1")
        bot_mail(source, "bot-b", "one", "b1")
        note_mail(source, "bot-b", "bot-b", message_id("c1"), "note1")
        note_mail(source, "bot-c", "bot-b", message_id("c1"), "forged")
        bot_mail(source, "bot-b", "two", "b2")
        note_mail(source, "bot-b", "bot-b", message_id("c1"), "note2")
        bot_mail(source, "bot-b", "three", "b3")
        env = RealEnv(self, source)
        env.refresh()
        posts = len(source.posts)
        self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
        self.assertEqual(
            self.calls_since(source, posts),
            [("Email/set", {"accountId": ACCOUNT_ID, "update": {"j-b1": SEEN, "j-note1": SEEN, "j-b2": SEEN}})],
        )
        for name in ("j-forged", "j-note2", "j-b3"):
            self.assertEqual(source.keywords_of(name), {})
        self.assertEqual(source.keywords_of("j-c1"), {"$seen": True})

    def test_a_mail_server_failure_on_the_mark_is_502_mail_leaves_the_copy_alone_and_a_retry_works(self):
        faults = (
            ("a method error", lambda source: setattr(source, "set_error", "serverFail"), lambda source: setattr(source, "set_error", None)),
            ("ids not updated", lambda source: source.not_updated.update({"j-b1", "j-b2"}), lambda source: source.not_updated.clear()),
            ("http 503", lambda source: source.broken.update({"update": 503}), lambda source: source.broken.clear()),
            ("unreachable", lambda source: source.broken.update({"update": "down"}), lambda source: source.broken.clear()),
        )
        for label, arrange, repair in faults:
            with self.subTest(label=label):
                source, env = self.seeded(2)
                arrange(source)
                self.assertEqual(env.read_status("bot-b", message_id("b2")), (502, {"error": "mail"}))
                self.assertEqual(env.first_unread(), message_id("b1"))
                self.assertIs(env.unread(), True)
                self.assertEqual([source.keywords_of(name) for name in ("j-b1", "j-b2")], [{}, {}])
                repair(source)
                self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
                self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
                self.assertEqual([source.keywords_of(name) for name in ("j-b1", "j-b2")], [{"$seen": True}, {"$seen": True}])

    def test_a_budget_pause_gives_502_mail_at_once_without_waiting(self):
        clock = Clock()
        budget = mailstate.Budget(clock, first_pause=5.0)
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "b1")
        env = RealEnv(self, source, budget=budget, **patience_of(budget))
        env.refresh()
        clock.now += 61.0
        budget.admit()
        budget.settle(False)
        naps = []
        posts = len(source.posts)
        with mock.patch("time.sleep", self.napper(clock, naps)):
            result = env.read_status("bot-b", message_id("b1"))
        self.assertEqual(result, (502, {"error": "mail"}))
        self.assertEqual(naps, [])
        self.assertEqual(self.names_since(source, posts), [])
        self.assertEqual(env.first_unread(), message_id("b1"))

    def test_a_send_with_a_quote_through_the_real_api_and_mailbox_keeps_the_quote_in_the_mail(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "Shall we meet for lunch tomorrow", "b1")
        env = RealEnv(self, source)
        env.refresh()
        quote = {"id": message_id("b1"), "text": "lunch"}
        status, body = answer(env.send_with("bot-b", "Yes please", quote=quote))
        self.assertEqual(status, 200, body)
        [stored] = self.sent_bodies(source)
        document = json.loads(stored)
        self.assertEqual((document["text"], document["quote"]), ("Yes please", quote))
        env.refresh()
        last = env.thread("bot-b")["messages"][-1]
        self.assertEqual(last["text"], "Yes please")
        self.assertEqual((last["quote"]["id"], last["quote"]["from"], last["quote"]["text"]), (message_id("b1"), "bot", "lunch"))


class QuoteSendTests(MailCase):
    QUOTES = (
        ("a message quote", {"id": message_id("b1"), "text": "lunch"}),
        ("a card quote", {"cardId": "Q1", "version": 2}),
        ("a message quote with an accent and a line break", {"id": message_id("b1"), "text": "caf\u00e9\nbar"}),
    )
    KEY = "chat:bot-b:k"

    def send(self, box, body):
        return box.send_chat("bot-b", "CHAT: bot-b", body, self.KEY)

    def test_a_send_with_a_quote_creates_one_mail_whose_body_is_the_body_sent(self):
        for label, quote in self.QUOTES:
            with self.subTest(label=label):
                source = JmapServer()
                box = adapter(source)
                body = chat_body("bot-b", "Sure", quote=quote, client_id="k", fresh=False)
                identifier, fresh = self.send(box, body)
                self.assertEqual((identifier, fresh), (qd_jmap.message_id(ACCOUNT, self.KEY, HOST), False))
                [stored] = self.sent_bodies(source)
                self.assertEqual(stored, body)
                self.assertEqual(json.loads(stored)["quote"], quote)
                self.assertEqual(len(source.emails), 1)

    def test_the_fresh_flag_of_a_quoted_send_is_handed_back(self):
        source = JmapServer()
        box = adapter(source)
        body = chat_body("bot-b", "Sure", quote={"id": message_id("b1"), "text": "lunch"}, client_id="k", fresh=True)
        self.assertEqual(self.send(box, body)[1], True)

    def test_repeating_a_quoted_send_with_the_same_key_and_body_makes_no_second_mail(self):
        for label, quote in self.QUOTES:
            with self.subTest(label=label):
                source = JmapServer()
                box = adapter(source)
                body = chat_body("bot-b", "Sure", quote=quote, client_id="k", fresh=False)
                first = self.send(box, body)
                second = self.send(box, body)
                self.assertEqual(first, second)
                self.assertEqual(len(self.sent_bodies(source)), 1)
                self.assertEqual(len(source.emails), 1)

    def test_a_send_without_a_quote_is_stored_exactly_as_before(self):
        source = JmapServer()
        box = adapter(source)
        body = chat_body("bot-b", "Plain words", client_id="k", fresh=False)
        self.send(box, body)
        self.assertEqual(self.sent_bodies(source), [body])
        self.assertNotIn("quote", json.loads(self.sent_bodies(source)[0]))

    def test_a_body_the_gateway_refuses_today_is_still_refused_and_creates_no_mail(self):
        def make(**changes):
            document = json.loads(chat_body("bot-b", "Hi", client_id="k", fresh=False))
            for key, value in changes.items():
                if value is KEEP:
                    del document[key]
                else:
                    document[key] = value
            return json.dumps(document, separators=(",", ":"))

        cases = (
            ("an unknown top-level key", make(extra=1)),
            ("an unknown top-level key beside a quote", make(extra=1, quote={"id": message_id("b1"), "text": "x"})),
            ("another qd value", make(qd="chat/2")),
            ("another bot in the body", make(bot="bot-c")),
            ("no client id", make(clientId=KEEP)),
            ("a fresh that is not a boolean", make(fresh="no")),
            ("a quote that is a string", make(quote="text")),
            ("a quote that is a list", make(quote=["x"])),
            ("a quote that is null", make(quote=None)),
        )
        for label, body in cases:
            with self.subTest(label=label):
                source = JmapServer()
                box = adapter(source)
                with self.assertRaises(security.SecurityRefused):
                    self.send(box, body)
                self.assertEqual(source.emails, {})
        source = JmapServer()
        with self.assertRaises(security.SecurityRefused):
            adapter(source).send_chat("bot-b", "CHAT: bot-c", make(), self.KEY)
        self.assertEqual(source.emails, {})


class IncrementalRefreshTests(MailCase):
    def fixture(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "m1")
        captain_mail(source, "bot-b", "two", "m2")
        source.add("inbox", "bot-c", ACCOUNT, "plain subject", "plain body", "j-m3", "m3")
        source.add("sent", ACCOUNT, STEWARD, "CHAT: bot-a", chat_body("bot-a", "three", client_id="c3", fresh=False), "j-m4", "m4", {"$seen": True})
        bot_mail(source, "bot-b", "six", "m8", keywords={"$seen": True, "$flagged": True})
        return source

    def steps(self):
        return (
            ("a new inbox message", lambda s: bot_mail(s, "bot-b", "four", "m5")),
            ("a new sent message", lambda s: captain_mail(s, "bot-b", "five", "m6")),
            ("a new draft", lambda s: s.add("drafts", ACCOUNT, "bot-b", "CHAT: bot-b", "draft body", "j-m7", "m7")),
            ("a read mark set by another client", lambda s: s.flag("j-m1", "$seen")),
            ("a read mark taken away by another client", lambda s: s.flag("j-m8", "$seen", False)),
            ("a destroyed inbox message", lambda s: s.drop("j-m1")),
            ("a destroyed sent message", lambda s: s.drop("j-m2")),
            ("an inbox message moved to a folder that is neither inbox nor sent", lambda s: s.move("j-m1", "drafts")),
            ("an inbox message moved to sent", lambda s: s.move("j-m3", "sent")),
            ("a sent message moved to the inbox", lambda s: s.move("j-m2", "inbox")),
            ("a sent message moved to a folder that is neither inbox nor sent", lambda s: s.move("j-m2", "drafts")),
            ("a second copy of one message id", lambda s: bot_mail(s, "bot-b", "one", "m1", identifier="j-m1-copy")),
            (
                "several changes at once",
                lambda s: (bot_mail(s, "bot-b", "four", "m5"), s.flag("j-m1", "$seen"), s.drop("j-m3"), s.move("j-m2", "drafts")),
            ),
        )

    def test_the_first_read_is_a_full_read_even_with_a_state_hint(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        mark = len(source.posts)
        got = self.read(box, source)
        names = self.names_since(source, mark)
        self.assertIn("Email/query", names)
        self.assertNotIn("Email/changes", names)
        self.assertEqual(source.changes_asked, [])
        self.assertEqual(got, self.full(source))

    def test_a_second_read_makes_only_changes_and_get_requests_and_fewer_requests_than_a_full_read(self):
        source = self.fixture()
        plain = adapter(source)
        mark = len(source.posts)
        plain.messages()
        full_cost = len(source.posts) - mark
        box = adapter(source, **option(True))
        self.read(box, source)
        bot_mail(source, "bot-b", "four", "m5")
        mark = len(source.posts)
        got = self.read(box, source)
        self.assertEqual(self.names_since(source, mark), ["Email/changes", "Email/get"])
        self.assertLess(len(source.posts) - mark, full_cost)
        self.assertEqual(got, self.full(source))

    def test_every_kind_of_change_gives_the_list_a_full_read_gives_without_a_query(self):
        for label, step in self.steps():
            with self.subTest(label=label):
                source = self.fixture()
                box = adapter(source, **option(True))
                self.read(box, source)
                step(source)
                mark = len(source.posts)
                got = self.read(box, source)
                names = self.names_since(source, mark)
                self.assertEqual(got, self.full(source))
                self.assertNotIn("Email/query", names)
                self.assertEqual(names[0], "Email/changes")
                self.assertEqual(len(source.changes_asked), 1)

    def test_a_read_with_no_change_asks_for_the_changes_and_gives_the_same_list(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        first = self.read(box, source)
        mark = len(source.posts)
        second = self.read(box, source)
        names = self.names_since(source, mark)
        self.assertEqual(second, first)
        self.assertEqual(names[0], "Email/changes")
        self.assertNotIn("Email/query", names)

    def test_a_read_mark_changed_by_another_client_comes_through_the_changes_both_ways(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        first = self.seen_of(self.read(box, source))
        self.assertIs(first[message_id("m1")], False)
        self.assertIs(first[message_id("m8")], True)
        source.flag("j-m1", "$seen")
        source.flag("j-m8", "$seen", False)
        mark = len(source.posts)
        second = self.seen_of(self.read(box, source))
        self.assertNotIn("Email/query", self.names_since(source, mark))
        self.assertIs(second[message_id("m1")], True)
        self.assertIs(second[message_id("m8")], False)
        source.flag("j-m1", "$seen", False)
        third = self.seen_of(self.read(box, source))
        self.assertIs(third[message_id("m1")], False)

    def test_the_get_after_the_changes_asks_for_the_changed_ids_with_keywords_and_mailbox_ids(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        self.read(box, source)
        bot_mail(source, "bot-b", "four", "m5")
        self.read(box, source)
        entry = source.get_log[-1]
        self.assertEqual(entry["ids"], ["j-m5"])
        self.assertIn("keywords", entry["properties"])
        self.assertIn("mailboxIds", entry["properties"])

    def test_each_changes_request_starts_from_the_state_the_previous_one_ended_at(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        first_state = source.current()
        self.hint(box, first_state)
        box.messages()
        bot_mail(source, "bot-b", "a", "n1")
        gate_state = source.current()
        self.hint(box, gate_state)
        bot_mail(source, "bot-b", "b", "n2")
        mark = len(source.posts)
        box.messages()
        ended = source.current()
        self.assertNotEqual(ended, gate_state)
        bot_mail(source, "bot-b", "c", "n3")
        got = self.read(box, source)
        self.assertNotIn("Email/query", self.names_since(source, mark))
        self.assertEqual(source.changes_asked, [first_state, ended])
        self.assertEqual(got, self.full(source))

    def test_with_no_state_hint_ever_every_read_is_a_full_read(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        for number in range(3):
            mark = len(source.posts)
            got = box.messages()
            names = self.names_since(source, mark)
            self.assertIn("Email/query", names)
            self.assertNotIn("Email/changes", names)
            self.assertEqual(got, self.full(source))
            bot_mail(source, "bot-b", f"more {number}", f"n{number}")
        self.assertEqual(source.changes_asked, [])

    def test_the_first_hinted_read_after_unhinted_ones_is_full_and_the_next_is_incremental(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        box.messages()
        bot_mail(source, "bot-b", "a", "n1")
        mark = len(source.posts)
        got = self.read(box, source)
        self.assertIn("Email/query", self.names_since(source, mark))
        self.assertEqual(got, self.full(source))
        bot_mail(source, "bot-b", "b", "n2")
        mark = len(source.posts)
        got = self.read(box, source)
        self.assertEqual(self.names_since(source, mark), ["Email/changes", "Email/get"])
        self.assertEqual(got, self.full(source))

    def fallbacks(self):
        def many(source):
            for number in range(300):
                bot_mail(source, "bot-b", f"bulk {number}", f"bulk{number}")

        return (
            ("cannotCalculateChanges", lambda s: setattr(s, "changes_error", "cannotCalculateChanges"), lambda s: setattr(s, "changes_error", None)),
            ("another method error", lambda s: setattr(s, "changes_error", "serverFail"), lambda s: setattr(s, "changes_error", None)),
            ("more changes to come", lambda s: setattr(s, "more_changes", True), lambda s: setattr(s, "more_changes", False)),
            ("far more changed ids than a page", many, lambda s: None),
            ("a new state that is the number 5", lambda s: setattr(s, "changes_state", 5), lambda s: setattr(s, "changes_state", KEEP)),
            ("a new state that is null", lambda s: setattr(s, "changes_state", None), lambda s: setattr(s, "changes_state", KEEP)),
            ("a transport error on the changes request", lambda s: s.broken.update({"Email/changes": "down"}), lambda s: s.broken.clear()),
            ("an http failure on the changes request", lambda s: s.broken.update({"Email/changes": 503}), lambda s: s.broken.clear()),
        )

    def test_each_doubt_falls_back_to_a_full_read_and_the_next_hinted_read_is_incremental_again(self):
        for label, arrange, repair in self.fallbacks():
            with self.subTest(label=label):
                source = self.fixture()
                box = adapter(source, **option(True))
                self.read(box, source)
                arrange(source)
                bot_mail(source, "bot-b", "four", "m5")
                fallback_state = source.current()
                mark = len(source.posts)
                got = self.read(box, source)
                names = self.names_since(source, mark)
                self.assertEqual(names[0], "Email/changes")
                self.assertIn("Email/query", names)
                self.assertEqual(got, self.full(source))
                repair(source)
                bot_mail(source, "bot-b", "five", "m6")
                mark = len(source.posts)
                got = self.read(box, source)
                self.assertEqual(self.names_since(source, mark), ["Email/changes", "Email/get"])
                self.assertEqual(source.changes_asked[-1], fallback_state)
                self.assertEqual(got, self.full(source))

    def test_a_modest_number_of_changed_ids_stays_incremental(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        self.read(box, source)
        for number in range(20):
            bot_mail(source, "bot-b", f"bulk {number}", f"bulk{number}")
        mark = len(source.posts)
        got = self.read(box, source)
        self.assertEqual(self.names_since(source, mark), ["Email/changes", "Email/get"])
        self.assertEqual(got, self.full(source))

    def test_a_changed_id_the_server_no_longer_has_is_dropped_without_a_full_read(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        self.read(box, source)
        source.hide("j-m1")
        late = bot_mail(source, "bot-b", "gone again", "late")
        source.hide(late)
        bot_mail(source, "bot-b", "four", "m5")
        mark = len(source.posts)
        got = self.read(box, source)
        self.assertNotIn("Email/query", self.names_since(source, mark))
        self.assertEqual(got, self.full(source))
        self.assertNotIn(message_id("m1"), [message.id for message in got])
        self.assertIn(message_id("m5"), [message.id for message in got])

    def test_without_the_switch_no_read_ever_calls_changes(self):
        for label, options in (("by default", {}), ("explicitly off", option(False))):
            with self.subTest(label=label):
                source = self.fixture()
                box = adapter(source, **options)
                self.read(box, source)
                bot_mail(source, "bot-b", "four", "m5")
                source.flag("j-m1", "$seen")
                mark = len(source.posts)
                got = self.read(box, source)
                names = self.names_since(source, mark)
                self.assertNotIn("Email/changes", names)
                self.assertIn("Email/query", names)
                self.assertEqual(source.changes_asked, [])
                self.assertEqual(got, self.full(source))

    def test_a_message_that_came_in_an_incremental_read_can_be_marked_and_the_mark_comes_back(self):
        source = self.fixture()
        box = adapter(source, **option(True))
        self.read(box, source)
        bot_mail(source, "bot-b", "new", "n1")
        got = self.read(box, source)
        self.assertIs(self.seen_of(got)[message_id("n1")], False)
        self.mark(box, [message_id("n1")])
        self.assertEqual(source.keywords_of("j-n1"), {"$seen": True})
        mark = len(source.posts)
        got = self.read(box, source)
        self.assertNotIn("Email/query", self.names_since(source, mark))
        self.assertIs(self.seen_of(got)[message_id("n1")], True)
        self.assertEqual(got, self.full(source))

    def test_the_constructor_and_open_take_incremental_and_it_is_off_by_default(self):
        for target in (mail_gateway.CaptainMailbox, mail_gateway.CaptainMailbox.open):
            with self.subTest(target=target.__qualname__):
                parameter = inspect.signature(target).parameters.get("incremental")
                self.assertIsNotNone(parameter)
                self.assertIs(parameter.default, False)


class TieOrderTests(MailCase):
    def test_a_changed_message_keeps_its_place_among_messages_of_the_same_second(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "m1")
        bot_mail(source, "bot-b", "two", "m2")
        bot_mail(source, "bot-b", "three", "m3")
        for name in ("j-m2", "j-m3"):
            source.emails[name]["receivedAt"] = source.emails["j-m1"]["receivedAt"]
        box = adapter(source, **option(True))
        self.read(box, source)
        source.flag("j-m1", "$seen")
        got = self.read(box, source)
        self.assertEqual([message.id for message in got], [message.id for message in self.full(source)])
        self.assertEqual([message.id for message in got], [message_id("m1"), message_id("m2"), message_id("m3")])

    def test_a_new_message_of_the_same_second_goes_after_the_old_ones(self):
        source = JmapServer()
        bot_mail(source, "bot-b", "one", "m1")
        bot_mail(source, "bot-b", "two", "m2")
        source.emails["j-m2"]["receivedAt"] = source.emails["j-m1"]["receivedAt"]
        box = adapter(source, **option(True))
        self.read(box, source)
        bot_mail(source, "bot-b", "three", "m3")
        source.emails["j-m3"]["receivedAt"] = source.emails["j-m1"]["receivedAt"]
        got = self.read(box, source)
        self.assertEqual([message.id for message in got], [message_id("m1"), message_id("m2"), message_id("m3")])


class StubJmap:
    def __init__(self, reply):
        self.reply = reply

    def call(self, *calls):
        return [dict(self.reply) for _ in calls]


class StubMailbox:
    def __init__(self, reply):
        self.mailbox = types.SimpleNamespace(jmap=StubJmap(reply))
        self.noted = []

    def note_state(self, state):
        self.noted.append(state)


class StateGateHandoffTests(MailCase):
    def gate(self, reply):
        clock = Clock()
        stub = StubMailbox(reply)
        return stub, mailstate.StateGate(stub, mailstate.Budget(clock), clock)

    def test_a_refresh_is_handed_the_state_the_gate_read_before_it_starts(self):
        stub, gate = self.gate({"list": [], "state": "s17"})
        handed = []

        def refresh():
            handed.append(list(stub.noted))
            return {"ok": True}

        self.assertEqual(gate.run(refresh), {"ok": True})
        self.assertEqual(handed, [["s17"]])
        self.assertEqual(stub.noted, ["s17"])
        self.assertEqual(gate.token(), "s17")

    def test_each_new_state_is_handed_over_and_an_unchanged_one_starts_no_refresh(self):
        stub, gate = self.gate({"list": [], "state": "s17"})
        refreshes = []

        def refresh():
            refreshes.append(list(stub.noted))
            return {"ok": True}

        gate.run(refresh)
        stub.mailbox.jmap.reply = {"list": [], "state": "s18"}
        gate.run(refresh)
        self.assertIsNone(gate.run(refresh))
        self.assertEqual(refreshes, [["s17"], ["s17", "s18"]])
        self.assertEqual(set(stub.noted), {"s17", "s18"})

    def test_a_state_the_gate_cannot_read_hands_no_state_string(self):
        stub, gate = self.gate({"list": [], "state": 7})
        refreshes = []
        gate.run(lambda: refreshes.append(1) or {"ok": True})
        self.assertEqual(refreshes, [1])
        self.assertTrue(all(state is None for state in stub.noted))

    def ticking(self, count=2):
        clock = Clock()
        budget = mailstate.Budget(clock)
        source = JmapServer()
        for number in range(1, count + 1):
            bot_mail(source, "bot-b", f"bot says {number}", f"b{number}")
        env = RealEnv(self, source, budget=budget, **option(True))
        gate = mailstate.StateGate(env.box, budget, clock)
        updates = live.LiveUpdates(env.service, gate)
        clock.now += 61.0
        updates.check_once()
        return clock, source, env, updates

    def test_through_the_real_gate_a_new_message_costs_one_state_read_one_changes_and_one_get(self):
        clock, source, env, updates = self.ticking()
        bot_mail(source, "bot-b", "bot says 3", "b3")
        clock.now += 5.0
        mark = len(source.posts)
        updates.check_once()
        self.assertEqual(self.names_since(source, mark), ["Email/get", "Email/changes", "Email/get"])
        self.assertEqual([message["text"] for message in env.thread("bot-b")["messages"]], ["bot says 1", "bot says 2", "bot says 3"])

    def test_through_the_real_gate_a_read_mark_set_elsewhere_arrives_through_the_changes(self):
        clock, source, env, updates = self.ticking()
        self.assertEqual(env.first_unread(), message_id("b1"))
        source.flag("j-b1", "$seen")
        source.flag("j-b2", "$seen")
        clock.now += 5.0
        mark = len(source.posts)
        updates.check_once()
        self.assertEqual(self.names_since(source, mark), ["Email/get", "Email/changes", "Email/get"])
        self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
        self.assertIs(env.unread(), False)

    def test_through_the_real_gate_the_mark_the_captain_made_survives_the_next_tick(self):
        clock, source, env, updates = self.ticking()
        self.assertEqual(env.read_status("bot-b", message_id("b2"))[0], 200)
        clock.now += 5.0
        mark = len(source.posts)
        updates.check_once()
        self.assertNotIn("Email/query", self.names_since(source, mark))
        self.assertIsNone(env.thread("bot-b").get("firstUnread", "absent"))
        self.assertIs(env.unread(), False)
        self.assertEqual([source.keywords_of(name) for name in ("j-b1", "j-b2")], [{"$seen": True}, {"$seen": True}])


class ServerWiringTests(unittest.TestCase):
    def test_the_server_opens_the_mailbox_with_incremental_true_and_still_hands_over_the_budget(self):
        tree = ast.parse((PKG / "server.py").read_text(encoding="utf-8"))
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "open"
            and isinstance(node.func.value, ast.Attribute) and node.func.value.attr == "CaptainMailbox"
        ]
        self.assertEqual(len(calls), 1)
        keywords = {keyword.arg: ast.unparse(keyword.value) for keyword in calls[0].keywords}
        self.assertEqual(keywords.get("incremental"), "True")
        self.assertEqual(keywords.get("patient"), "budget.patient")


class NoCommentTests(unittest.TestCase):
    def test_this_file_has_no_comments_docstrings_or_em_dashes(self):
        source = Path(__file__).read_text(encoding="utf-8")
        comments = [
            token
            for token in tokenize.generate_tokens(io.StringIO(source).readline)
            if token.type == tokenize.COMMENT and token.start[0] > 1
        ]
        self.assertEqual(comments, [])
        documented = [
            node
            for node in ast.walk(ast.parse(source))
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and ast.get_docstring(node) is not None
        ]
        self.assertEqual(documented, [])
        self.assertNotIn("\u2014", source)
