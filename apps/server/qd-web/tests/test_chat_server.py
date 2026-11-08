import ast
import contextlib
import hashlib
import importlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import tokenize
import unittest
from unittest import mock
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

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
import qd_jmap
import server
import webapp

ET = ZoneInfo("America/New_York")
ACCOUNT = "account-user"
STEWARD = "bot-a"
COOKIE = "__Host-qd-approval"
INDEX = b'<!doctype html><html><head></head><body><div id="root"></div></body></html>'
FILES = {"index.html": INDEX, "app.js": b"export const a = 1;"}
BASE_TIME = 1_730_858_160.0
FIXED_LINE = "QD_CHAT_BOTS_REFUSED\n"


def without_replies(text):
    return "".join(line for line in text.splitlines(keepends=True) if not line.startswith("QD_CHAT_REPLY "))


def module(name):
    return importlib.import_module(name)


def clean(path):
    shutil.rmtree(path, ignore_errors=True)


def mail_id(key):
    return "qd." + hashlib.sha256(key.encode()).hexdigest()[:24] + "." + ACCOUNT + "@qd.invalid"


def stamp(minutes):
    return datetime.fromtimestamp(BASE_TIME + minutes * 60, ET).isoformat(timespec="seconds")


def sender_body(bot, text, client_id=None, fresh=False):
    document = {"qd": "chat/1", "bot": bot, "text": text}
    if client_id is not None:
        document["clientId"] = client_id
    if fresh is not None and client_id is not None:
        document["fresh"] = fresh
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False)


class Checker:
    account_name = ACCOUNT
    oversight_bot = STEWARD
    active_bots = frozenset({STEWARD, "bot-b", "bot-c"})

    def check(self, subject, body, *, sender, poster=None, base=None, current_rev=None):
        raise AssertionError("no card is expected here")

    def build_answers(self, *args):
        raise AssertionError("no card is expected here")

    def build_comment(self, *args):
        raise AssertionError("no card is expected here")


class Mail:
    def __init__(self):
        self.inbox = []
        self.stored = {}
        self.send_calls = []
        self.reads = 0
        self.fail = None
        self.minute = 0

    def messages(self):
        self.reads += 1
        return list(self.inbox)

    def send(self, recipient, subject, body, resend_key):
        raise AssertionError("a chat send must use send_chat")

    def send_chat(self, recipient, subject, body, resend_key):
        self.send_calls.append((recipient, subject, body, resend_key))
        if self.fail is not None:
            raise self.fail
        if resend_key in self.stored:
            return self.stored[resend_key], json.loads(body)["fresh"]
        identifier = mail_id(resend_key)
        self.stored[resend_key] = identifier
        self.minute += 1
        self.inbox.append(cards.MailMessage(identifier, ACCOUNT, subject, body, stamp(1000 + self.minute)))
        return identifier, json.loads(body)["fresh"]

    def bot_says(self, bot, text, minute, identifier=None, client_id=None):
        identifier = identifier or f"bot-{bot}-{minute}@qd.invalid"
        self.inbox.append(cards.MailMessage(identifier, bot, f"CHAT: {bot}", sender_body(bot, text, client_id, fresh=None), stamp(minute)))
        return identifier

    def captain_says(self, bot, text, minute, identifier=None, client_id=None):
        identifier = identifier or f"captain-{bot}-{minute}@qd.invalid"
        self.inbox.append(cards.MailMessage(identifier, ACCOUNT, f"CHAT: {bot}", sender_body(bot, text, client_id), stamp(minute)))
        return identifier

    def submissions(self):
        return len(self.stored)


class Grant:
    pass


class Gate:
    def __init__(self):
        self.refuse = None
        self.csrf_error = None
        self.calls = []
        self.csrf_seen = []

    def authenticate(self, request):
        self.calls.append(("authenticate", request.path))
        if self.refuse is not None:
            raise self.refuse
        return Grant()

    def authorize_post(self, request, csrf):
        self.calls.append(("authorize_post", request.path))
        self.csrf_seen.append(csrf)
        if self.refuse is not None:
            raise self.refuse
        if self.csrf_error is not None:
            raise self.csrf_error
        return Grant()

    def issue_csrf(self, owner):
        return "csrf-next"

    def fresh_until(self, owner):
        return 5000.0


def request(method, path, payload=None, *, token="session-one", headers=None, body=None):
    sent = {} if headers is None else dict(headers)
    if token is not None:
        sent.setdefault("Cookie", f"{COOKIE}={token}")
    data = bytearray(b"" if body is None else body)
    if payload is not None:
        data = bytearray(json.dumps(payload).encode("utf-8"))
        sent.setdefault("Content-Type", "application/json")
    return approval_app.Request(method, path, sent, data, "127.0.0.1")


def answer(response):
    return response.status, json.loads(response.body)


def write_bots(path, names, *, at=int(BASE_TIME), mode=0o640, text=None):
    document = {"v": 1, "bots": list(names)}
    if at is not None:
        document = {"v": 1, "at": at, "bots": list(names)}
    data = (json.dumps(document, separators=(",", ":")) + "\n") if text is None else text
    temp = str(path) + ".new"
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(data)
    os.chmod(temp, mode)
    os.replace(temp, path)


class Env:
    def __init__(self, case, bots=("bot-b", "bot-c"), notes=(), with_chat=True, configured=True):
        self.root = Path(tempfile.mkdtemp(prefix="qd-chat-"))
        case.addCleanup(clean, self.root)
        self.bots_path = self.root / "chat-bots.json"
        if bots is not None:
            write_bots(self.bots_path, bots)
        self.now = BASE_TIME
        self.mail = Mail()
        self.gate = Gate()
        source = module("bot_list").BotList(str(self.bots_path), clock=lambda: self.now) if configured else None
        self.service = cards.CardService(self.mail, Checker(), chat_bots=notes, bot_source=source)
        self.updates = live.LiveUpdates(self.service)
        self.cards_app = application.CardApplication(self.gate, self.service, self.updates, clock=lambda: self.now)
        site = self.root / "site"
        site.mkdir()
        for name, data in FILES.items():
            (site / name).write_bytes(data)
        self.chat = module("chat_api").ChatApi(self.gate, self.service, clock=lambda: self.now) if with_chat else None
        self.web = webapp.QdWeb(self.cards_app, bundle.Bundle.load(str(site)), chat=self.chat)
        self.counter = 0

    def refresh(self):
        self.service.refresh()

    def get(self, path, **options):
        return self.web.handle(request("GET", path, **options))

    def post(self, payload, **options):
        return self.web.handle(request("POST", "/captain/api/chat", payload, **options))

    def send(self, bot="bot-b", text="Hello", client_id=None, **options):
        self.counter += 1
        client_id = client_id or f"client-{self.counter}"
        return self.post({"bot": bot, "text": text, "clientId": client_id, "csrf": "csrf-now"}, **options)

    def row(self, bot):
        status, rows = answer(self.get("/captain/api/chats"))
        assert status == 200, rows
        return next((row for row in rows if row["bot"]["id"] == bot), None)


class ChatRowTests(unittest.TestCase):
    def test_rows_are_newest_first_and_empty_bots_come_last(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "newer from b", 30)
        env.mail.captain_says(STEWARD, "older to the steward", 10)
        env.refresh()
        status, rows = answer(env.get("/captain/api/chats"))
        self.assertEqual(status, 200)
        self.assertEqual([row["bot"]["id"] for row in rows], ["bot-b", STEWARD, "bot-c"])
        self.assertEqual({key: value for key, value in rows[2].items() if key != "rev"}, {"bot": {"id": "bot-c", "name": "Bot C"}, "preview": "", "at": "", "last": "", "unread": False})

    def test_a_row_has_exactly_these_fields_and_last_is_the_newest_message_id(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "one", 10, identifier="first@qd.invalid")
        env.mail.captain_says("bot-b", "two", 20, identifier="second@qd.invalid")
        env.refresh()
        row = env.row("bot-b")
        self.assertEqual(set(row), {"bot", "preview", "at", "last", "unread", "rev"})
        self.assertEqual((row["last"], row["preview"], row["at"], row["unread"]), ("second@qd.invalid", "two", stamp(20), False))

    def test_a_preview_is_at_most_160_characters(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "x" * 300, 10)
        env.refresh()
        self.assertEqual(env.row("bot-b")["preview"], "x" * 160)

    def test_last_is_empty_for_a_bot_with_no_messages(self):
        env = Env(self)
        env.refresh()
        row = env.row("bot-c")
        self.assertEqual((row["last"], row["preview"], row["at"]), ("", "", ""))

    def test_a_note_is_in_the_bot_only_when_it_has_one(self):
        env = Env(self, notes=(("bot-b", "Builds things"),))
        env.refresh()
        self.assertEqual(env.row("bot-b")["bot"], {"id": "bot-b", "name": "Bot B", "note": "Builds things"})
        self.assertEqual(env.row("bot-c")["bot"], {"id": "bot-c", "name": "Bot C"})

    def test_the_account_is_never_listed_even_when_the_file_names_it(self):
        env = Env(self, bots=("bot-b", ACCOUNT))
        env.refresh()
        status, rows = answer(env.get("/captain/api/chats"))
        self.assertEqual(sorted(row["bot"]["id"] for row in rows), [STEWARD, "bot-b"])

    def test_after_a_post_and_a_refresh_the_row_last_equals_the_post_id(self):
        env = Env(self)
        env.refresh()
        status, sent = answer(env.send("bot-b", "Hello there"))
        self.assertEqual(status, 200)
        env.refresh()
        status, thread = answer(env.get("/captain/api/chat?bot=bot-b"))
        self.assertEqual(thread["messages"][-1]["id"], sent["id"])
        self.assertEqual(env.row("bot-b")["last"], sent["id"])

    def test_a_query_on_the_list_route_is_refused(self):
        env = Env(self)
        env.refresh()
        self.assertEqual(answer(env.get("/captain/api/chats?bot=bot-b")), (400, {"error": "request refused"}))


class ChatThreadTests(unittest.TestCase):
    def fill(self, env, count, bot="bot-b"):
        ids = []
        for number in range(count):
            identifier = f"m{number:03d}@qd.invalid"
            if number % 2:
                env.mail.captain_says(bot, f"text {number}", number, identifier=identifier, client_id=f"c{number}")
            else:
                env.mail.bot_says(bot, f"text {number}", number, identifier=identifier)
            ids.append(identifier)
        env.refresh()
        return ids

    def thread(self, env, query):
        status, body = answer(env.get("/captain/api/chat?" + query))
        self.assertEqual(status, 200, body)
        return body

    def test_the_newest_fifteen_come_oldest_first_with_older_true(self):
        env = Env(self)
        ids = self.fill(env, 20)
        body = self.thread(env, "bot=bot-b")
        self.assertEqual([m["id"] for m in body["messages"]], ids[5:])
        self.assertIs(body["older"], True)

    def test_fifteen_or_fewer_messages_have_older_false(self):
        env = Env(self)
        ids = self.fill(env, 15)
        body = self.thread(env, "bot=bot-b")
        self.assertEqual([m["id"] for m in body["messages"]], ids)
        self.assertIs(body["older"], False)

    def test_sixteen_messages_have_older_true_and_one_in_the_next_page(self):
        env = Env(self)
        ids = self.fill(env, 16)
        body = self.thread(env, "bot=bot-b")
        self.assertEqual([m["id"] for m in body["messages"]], ids[1:])
        self.assertIs(body["older"], True)
        older = self.thread(env, "bot=bot-b&before=" + ids[1])
        self.assertEqual([m["id"] for m in older["messages"]], ids[:1])
        self.assertIs(older["older"], False)

    def test_before_gives_the_fifteen_before_it_oldest_first(self):
        env = Env(self)
        ids = self.fill(env, 40)
        body = self.thread(env, "bot=bot-b&before=" + ids[30])
        self.assertEqual([m["id"] for m in body["messages"]], ids[15:30])
        self.assertIs(body["older"], True)
        body = self.thread(env, "bot=bot-b&before=" + ids[15])
        self.assertEqual([m["id"] for m in body["messages"]], ids[0:15])
        self.assertIs(body["older"], False)
        body = self.thread(env, "bot=bot-b&before=" + ids[0])
        self.assertEqual(body["messages"], [])
        self.assertIs(body["older"], False)

    def test_a_before_id_is_url_decoded(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "one", 1, identifier="a+b@qd.invalid")
        env.mail.bot_says("bot-b", "two", 2, identifier="c@qd.invalid")
        env.refresh()
        body = self.thread(env, "bot=bot-b&before=c%40qd.invalid")
        self.assertEqual([m["id"] for m in body["messages"]], ["a+b@qd.invalid"])

    def test_a_thread_has_exactly_these_fields(self):
        env = Env(self)
        self.fill(env, 3)
        body = self.thread(env, "bot=bot-b")
        self.assertEqual(set(body), {"bot", "rev", "features", "messages", "seenUpTo", "seenAt", "working", "firstUnread", "older"})
        self.assertEqual((body["bot"], body["seenUpTo"], body["seenAt"], body["working"]), ({"id": "bot-b", "name": "Bot B"}, "m001@qd.invalid", stamp(2), None))

    def test_a_message_has_exactly_id_from_text_at_refs_and_a_client_id_only_when_the_mail_had_one(self):
        env = Env(self)
        self.fill(env, 2)
        first, second = self.thread(env, "bot=bot-b")["messages"]
        self.assertEqual(first, {"id": "m000@qd.invalid", "from": "bot", "text": "text 0", "at": stamp(0), "refs": [], "quote": None, "files": []})
        self.assertEqual(second, {"id": "m001@qd.invalid", "from": "captain", "text": "text 1", "at": stamp(1), "refs": [], "clientId": "c1", "quote": None, "files": []})

    def test_account_is_mapped_to_captain_and_the_fresh_flag_is_never_sent(self):
        env = Env(self)
        env.mail.captain_says("bot-b", "mine", 1, client_id="abc")
        env.refresh()
        message = self.thread(env, "bot=bot-b")["messages"][0]
        self.assertEqual(message["from"], "captain")
        self.assertNotIn("fresh", message)
        self.assertNotIn("account", json.dumps(message))

    def test_message_ids_are_the_same_on_every_read(self):
        env = Env(self)
        self.fill(env, 5)
        first = [m["id"] for m in self.thread(env, "bot=bot-b")["messages"]]
        env.refresh()
        second = [m["id"] for m in self.thread(env, "bot=bot-b")["messages"]]
        self.assertEqual(first, second)

    def test_bot_text_is_returned_as_text_and_never_changed(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "<script>alert(1)</script> & \u00e9", 1)
        env.refresh()
        self.assertEqual(self.thread(env, "bot=bot-b")["messages"][0]["text"], "<script>alert(1)</script> & \u00e9")

    def test_an_unknown_bot_is_422_bot(self):
        env = Env(self)
        env.refresh()
        for query in ("bot=nobody", "bot=" + ACCOUNT, "bot=BOT-B", "bot="):
            with self.subTest(query=query):
                self.assertEqual(answer(env.get("/captain/api/chat?" + query)), (422, {"error": "bot"}))

    def test_a_malformed_query_is_400(self):
        env = Env(self)
        self.fill(env, 3)
        cases = ("", "before=m000@qd.invalid", "bot=bot-b&bot=bot-c", "bot=bot-b&extra=1", "bot=bot-b&before=", "bot=bot-b&before=nothing-like-it", "bot=bot-b&before=m000@qd.invalid&before=m001@qd.invalid", "bot")
        for query in cases:
            with self.subTest(query=query):
                self.assertEqual(answer(env.get("/captain/api/chat?" + query)), (400, {"error": "request refused"}))

    def test_a_before_id_of_another_bots_message_is_400(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "b", 1, identifier="b1@qd.invalid")
        env.mail.bot_says("bot-c", "c", 2, identifier="c1@qd.invalid")
        env.refresh()
        self.assertEqual(answer(env.get("/captain/api/chat?bot=bot-b&before=c1@qd.invalid")), (400, {"error": "request refused"}))

    def test_a_bot_with_no_messages_has_an_empty_thread(self):
        env = Env(self)
        env.refresh()
        body = self.thread(env, "bot=bot-c")
        self.assertEqual((body["messages"], body["older"]), ([], False))

    def test_other_bots_messages_are_not_in_a_thread(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "b", 1)
        env.mail.bot_says("bot-c", "c", 2)
        env.refresh()
        self.assertEqual([m["text"] for m in self.thread(env, "bot=bot-b")["messages"]], ["b"])


class ChatSendTests(unittest.TestCase):
    def test_the_answer_is_one_flat_object_with_the_message_and_the_new_csrf(self):
        env = Env(self)
        env.refresh()
        status, body = answer(env.send("bot-b", "Hello there", client_id="client-aaa"))
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"id", "from", "text", "at", "refs", "clientId", "uploadVerdicts", "csrf", "freshUntil"})
        self.assertEqual(body["id"], mail_id("chat:bot-b:client-aaa"))
        self.assertEqual((body["from"], body["text"], body["clientId"]), ("captain", "Hello there", "client-aaa"))
        self.assertEqual((body["refs"], body["uploadVerdicts"]), ([], []))
        self.assertEqual((body["csrf"], body["freshUntil"]), ("csrf-next", 5000.0))
        self.assertEqual(body["at"], datetime.fromtimestamp(BASE_TIME, ET).isoformat(timespec="seconds"))

    def test_the_mail_is_one_chat_one_message_with_the_exact_subject_body_and_resend_key(self):
        env = Env(self)
        env.refresh()
        env.send("bot-b", "H\u00e9llo \"q\"", client_id="client-aaa")
        expected_body = '{"qd":"chat/1","bot":"bot-b","text":"H\u00e9llo \\"q\\"","clientId":"client-aaa","fresh":false}'
        self.assertEqual(env.mail.send_calls, [("bot-b", "CHAT: bot-b", expected_body, "chat:bot-b:client-aaa")])

    def test_the_csrf_of_the_body_is_what_the_gate_checks(self):
        env = Env(self)
        env.refresh()
        env.post({"bot": "bot-b", "text": "x", "clientId": "c1", "csrf": "the-one"})
        self.assertEqual(env.gate.csrf_seen, ["the-one"])

    def test_a_repeated_post_with_the_same_client_id_is_the_same_message_and_one_mail(self):
        env = Env(self)
        env.refresh()
        env.now = BASE_TIME
        first = answer(env.send("bot-b", "Same words", client_id="client-aaa"))
        env.now = BASE_TIME + 9
        second = answer(env.send("bot-b", "Same words", client_id="client-aaa"))
        self.assertEqual(first[0], 200)
        self.assertEqual(second[0], 200)
        for name in ("id", "from", "text", "at", "refs", "clientId", "uploadVerdicts"):
            self.assertEqual(first[1][name], second[1][name], name)
        self.assertEqual(env.mail.submissions(), 1)
        env.refresh()
        self.assertEqual(len([m for m in answer(env.get("/captain/api/chat?bot=bot-b"))[1]["messages"] if m["text"] == "Same words"]), 1)

    def test_a_repeat_after_the_server_forgot_it_still_gives_the_same_id_and_one_mail(self):
        env = Env(self)
        env.refresh()
        first = answer(env.send("bot-b", "Same words", client_id="client-aaa"))
        env.refresh()
        env.chat = module("chat_api").ChatApi(env.gate, env.service, clock=lambda: env.now)
        env.web = webapp.QdWeb(env.cards_app, env.web._site, chat=env.chat)
        env.now = BASE_TIME + 30
        second = answer(env.send("bot-b", "Same words", client_id="client-aaa"))
        self.assertEqual(first[1]["id"], second[1]["id"])
        self.assertEqual(env.mail.submissions(), 1)

    def test_the_same_client_id_for_another_bot_is_another_message(self):
        env = Env(self)
        env.refresh()
        first = answer(env.send("bot-b", "Hi", client_id="client-aaa"))
        second = answer(env.send("bot-c", "Hi", client_id="client-aaa"))
        self.assertNotEqual(first[1]["id"], second[1]["id"])
        self.assertEqual(env.mail.submissions(), 2)

    def test_a_send_to_the_steward_works_with_no_bot_file_at_all(self):
        env = Env(self, bots=None)
        env.refresh()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(answer(env.send(STEWARD, "Hi"))[0], 200)

    def test_text_of_exactly_4000_characters_is_sent_and_one_more_is_refused(self):
        env = Env(self)
        env.refresh()
        self.assertEqual(answer(env.send("bot-b", "x" * 4000))[0], 200)
        self.assertEqual(answer(env.send("bot-b", "x" * 4001)), (400, {"error": "text"}))
        self.assertEqual(env.mail.submissions(), 1)

    def test_text_that_is_empty_or_not_a_string_is_400_text_and_sends_nothing(self):
        env = Env(self)
        env.refresh()
        for text in ("", None, 5, ["a"], {"a": 1}, True):
            with self.subTest(text=text):
                self.assertEqual(answer(env.post({"bot": "bot-b", "text": text, "clientId": "c1", "csrf": "t"})), (400, {"error": "text"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_a_bot_that_is_not_listed_is_422_bot_and_sends_nothing(self):
        env = Env(self)
        env.refresh()
        for bot in ("nobody", ACCOUNT, "", None, 7, "BOT-B"):
            with self.subTest(bot=bot):
                self.assertEqual(answer(env.post({"bot": bot, "text": "Hi", "clientId": "c1", "csrf": "t"})), (422, {"error": "bot"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_a_bad_client_id_or_body_is_400_request_refused_and_sends_nothing(self):
        env = Env(self)
        env.refresh()
        good = {"bot": "bot-b", "text": "Hi", "clientId": "c1", "csrf": "t"}
        cases = [
            dict(good, clientId=""),
            dict(good, clientId="x" * 81),
            dict(good, clientId="has space"),
            dict(good, clientId=None),
            dict(good, clientId=5),
            {key: value for key, value in good.items() if key != "csrf"},
            {key: value for key, value in good.items() if key != "clientId"},
            dict(good, extra=1),
            dict(good, csrf=5),
        ]
        for number, payload in enumerate(cases):
            with self.subTest(case=number):
                self.assertEqual(answer(env.post(payload)), (400, {"error": "request refused"}))
        self.assertEqual(answer(env.post(None, body=b"not json", headers={"Content-Type": "application/json"})), (400, {"error": "request refused"}))
        self.assertEqual(answer(env.post(None, body=json.dumps(good).encode(), headers={"Content-Type": "text/plain"})), (400, {"error": "request refused"}))
        self.assertEqual(answer(env.post(None, body=json.dumps([good]).encode(), headers={"Content-Type": "application/json"})), (400, {"error": "request refused"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_a_client_id_of_80_valid_characters_is_sent(self):
        env = Env(self)
        env.refresh()
        self.assertEqual(answer(env.send("bot-b", "Hi", client_id="A_b-9" * 16))[0], 200)

    def test_a_body_over_16_kib_is_refused_and_exactly_16_kib_is_read(self):
        env = Env(self)
        env.refresh()
        payload = {"bot": "bot-b", "text": "Hi", "clientId": "c1", "csrf": "t"}
        data = json.dumps(payload).encode()
        limit = application.MAX_BODY_BYTES
        self.assertEqual(limit, 16384)
        exact = data + b" " * (limit - len(data))
        over = data + b" " * (limit + 1 - len(data))
        self.assertEqual(answer(env.post(None, body=over, headers={"Content-Type": "application/json"})), (400, {"error": "request refused"}))
        self.assertEqual(answer(env.post(None, body=exact, headers={"Content-Type": "application/json"}))[0], 200)

    def test_a_mail_server_refusal_is_502_mail(self):
        env = Env(self)
        env.refresh()
        for failure in (qd_jmap.Refused("no"), qd_jmap.MailFailed("down"), OSError("gone"), RuntimeError("odd")):
            with self.subTest(failure=type(failure).__name__):
                env.mail.fail = failure
                self.assertEqual(answer(env.send("bot-b", "Hi")), (502, {"error": "mail"}))
        env.mail.fail = None
        self.assertEqual(answer(env.send("bot-b", "Hi"))[0], 200)

    def test_a_failed_send_is_not_remembered_as_sent(self):
        env = Env(self)
        env.refresh()
        env.mail.fail = OSError("gone")
        self.assertEqual(answer(env.send("bot-b", "Hi", client_id="client-aaa"))[0], 502)
        env.mail.fail = None
        status, body = answer(env.send("bot-b", "Hi", client_id="client-aaa"))
        self.assertEqual((status, body["id"]), (200, mail_id("chat:bot-b:client-aaa")))

    def test_a_send_makes_no_mail_server_read(self):
        env = Env(self)
        env.refresh()
        reads = env.mail.reads
        env.send("bot-b", "Hi")
        self.assertEqual(env.mail.reads, reads)

    def test_a_chat_post_needs_no_fresh_sign_in(self):
        self.assertFalse(approval_security.requires_fresh("POST", "/captain/api/chat"))
        self.assertTrue(approval_security.requires_fresh("POST", "/captain/approve"))
        env = Env(self)
        env.refresh()
        self.assertEqual(answer(env.send("bot-b", "Hi"))[0], 200)


class ChatRefusalTests(unittest.TestCase):
    def cases(self, env):
        env.refresh()
        out = {}
        out["bot"] = env.post({"bot": "nobody", "text": "Hi", "clientId": "c1", "csrf": "t"})
        out["text"] = env.post({"bot": "bot-b", "text": "", "clientId": "c2", "csrf": "t"})
        env.mail.fail = OSError("gone")
        out["mail"] = env.send("bot-b", "Hi")
        env.mail.fail = None
        env.gate.refuse = application.SessionRefused("approval session required")
        out["session"] = env.send("bot-b", "Hi")
        env.gate.refuse = application.AuthenticationRequired("approval session required")
        out["session-required"] = env.send("bot-b", "Hi")
        env.gate.refuse = approval_security.ApprovalRateLimited("approval session rate limit")
        out["shared-limit"] = env.send("bot-b", "Hi")
        env.gate.refuse = None
        for number in range(10):
            env.send("bot-c", f"fill {number}", token="session-rate")
        out["rate"] = env.send("bot-c", "one too many", token="session-rate")
        return out

    def test_each_chat_refusal_has_its_status_and_error_word(self):
        out = self.cases(Env(self))
        got = {name: answer(response) for name, response in out.items()}
        self.assertEqual(got["bot"], (422, {"error": "bot"}))
        self.assertEqual(got["text"], (400, {"error": "text"}))
        self.assertEqual(got["mail"], (502, {"error": "mail"}))
        self.assertEqual(got["session"], (401, {"error": "session"}))
        self.assertEqual(got["session-required"], (401, {"error": "session"}))
        self.assertEqual(got["shared-limit"], (429, {"error": "rate"}))
        self.assertEqual(got["rate"], (429, {"error": "rate"}))

    def test_no_chat_refusal_uses_403(self):
        out = self.cases(Env(self))
        self.assertEqual({name: response.status for name, response in out.items() if response.status == 403}, {})

    def test_a_refusal_from_the_session_checks_other_than_a_signed_out_one_is_403_as_for_cards(self):
        env = Env(self)
        env.refresh()
        env.gate.csrf_error = approval_security.ApprovalRefused("card csrf is invalid")
        self.assertEqual(answer(env.send("bot-b", "Hi")), (403, {"error": "request refused"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_a_signed_out_read_is_401_session_and_reads_nothing(self):
        env = Env(self)
        env.refresh()
        env.gate.refuse = application.SessionRefused("approval session required")
        for path in ("/captain/api/chats", "/captain/api/chat?bot=bot-b"):
            with self.subTest(path=path):
                self.assertEqual(answer(env.get(path)), (401, {"error": "session"}))

    def test_a_gate_refusal_stops_the_send_before_the_bot_and_the_text_are_looked_at(self):
        env = Env(self)
        env.refresh()
        env.gate.refuse = application.SessionRefused("approval session required")
        self.assertEqual(answer(env.post({"bot": "nobody", "text": "", "clientId": "c1", "csrf": "t"}))[0], 401)
        self.assertEqual(env.mail.send_calls, [])

    def test_the_shared_session_limit_on_a_read_is_429_rate(self):
        env = Env(self)
        env.refresh()
        env.gate.refuse = approval_security.ApprovalRateLimited("approval session rate limit")
        self.assertEqual(answer(env.get("/captain/api/chats")), (429, {"error": "rate"}))

    def test_methods_other_than_the_two_are_405_with_allow(self):
        env = Env(self)
        env.refresh()
        cases = (("POST", "/captain/api/chats", "GET"), ("PUT", "/captain/api/chat", "GET, POST"), ("DELETE", "/captain/api/chat", "GET, POST"), ("HEAD", "/captain/api/chat", "GET, POST"), ("HEAD", "/captain/api/chats", "GET"))
        for method, path, allowed in cases:
            with self.subTest(method=method, path=path):
                response = env.web.handle(request(method, path))
                self.assertEqual(response.status, 405)
                self.assertEqual(dict(response.headers)["Allow"], allowed)

    def test_a_post_to_the_thread_with_a_query_is_refused(self):
        env = Env(self)
        env.refresh()
        response = env.web.handle(request("POST", "/captain/api/chat?bot=bot-b", {"bot": "bot-b", "text": "Hi", "clientId": "c1", "csrf": "t"}))
        self.assertEqual(answer(response), (400, {"error": "request refused"}))
        self.assertEqual(env.mail.send_calls, [])

    def test_the_body_is_cleared_after_every_outcome(self):
        env = Env(self)
        env.refresh()
        good = {"bot": "bot-b", "text": "Hi", "clientId": "c1", "csrf": "t"}
        for payload in (good, dict(good, bot="nobody"), dict(good, text="")):
            case = request("POST", "/captain/api/chat", payload)
            env.web.handle(case)
            self.assertEqual(len(case.body), 0)

    def test_the_chat_routes_are_404_when_chat_is_not_wired(self):
        env = Env(self, with_chat=False)
        env.refresh()
        for method, path in (("GET", "/captain/api/chats"), ("GET", "/captain/api/chat?bot=bot-b"), ("POST", "/captain/api/chat")):
            with self.subTest(path=path):
                self.assertEqual(env.web.handle(request(method, path)).status, 404)

    def test_chat_answers_carry_the_security_headers_and_json_type(self):
        env = Env(self)
        env.refresh()
        response = env.get("/captain/api/chats")
        headers = dict(response.headers)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")


class ChatRateTests(unittest.TestCase):
    def test_ten_sends_a_minute_are_accepted_and_the_eleventh_is_429_rate(self):
        env = Env(self)
        env.refresh()
        statuses = []
        for number in range(11):
            statuses.append(env.send("bot-b", f"m{number}").status)
        self.assertEqual(statuses, [200] * 10 + [429])
        self.assertEqual(env.mail.submissions(), 10)

    def test_the_window_is_sixty_seconds(self):
        env = Env(self)
        env.refresh()
        for number in range(10):
            env.now = BASE_TIME + number
            self.assertEqual(env.send("bot-b", f"m{number}").status, 200)
        env.now = BASE_TIME + 59
        self.assertEqual(env.send("bot-b", "late").status, 429)
        env.now = BASE_TIME + 60.5
        self.assertEqual(env.send("bot-b", "ok").status, 200)

    def test_the_limit_is_per_session(self):
        env = Env(self)
        env.refresh()
        for number in range(10):
            self.assertEqual(env.send("bot-b", f"m{number}", token="session-one").status, 200)
        self.assertEqual(env.send("bot-b", "x", token="session-one").status, 429)
        self.assertEqual(env.send("bot-b", "y", token="session-two").status, 200)

    def test_refused_sends_do_not_count(self):
        env = Env(self)
        env.refresh()
        for number in range(30):
            env.post({"bot": "nobody", "text": "Hi", "clientId": f"c{number}", "csrf": "t"})
            env.post({"bot": "bot-b", "text": "", "clientId": f"d{number}", "csrf": "t"})
        for number in range(10):
            self.assertEqual(env.send("bot-b", f"m{number}").status, 200)

    def test_a_mail_failure_still_counts_as_an_attempt(self):
        env = Env(self)
        env.refresh()
        env.mail.fail = OSError("gone")
        for number in range(10):
            self.assertEqual(env.send("bot-b", f"m{number}").status, 502)
        env.mail.fail = None
        self.assertEqual(env.send("bot-b", "x").status, 429)

    def test_reads_are_not_limited_by_the_send_limit(self):
        env = Env(self)
        env.refresh()
        for number in range(10):
            env.send("bot-b", f"m{number}")
        self.assertEqual(env.get("/captain/api/chats").status, 200)
        self.assertEqual(env.get("/captain/api/chat?bot=bot-b").status, 200)


class BotListTests(unittest.TestCase):
    def setUp(self):
        self.now = BASE_TIME

    def source(self, names=("bot-b",), **options):
        root = Path(tempfile.mkdtemp(prefix="qd-bots-"))
        self.addCleanup(clean, root)
        path = root / "chat-bots.json"
        if names is not None:
            write_bots(path, names, **options)
        return path, module("bot_list").BotList(str(path), clock=lambda: self.now)

    def names(self, source):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            return list(source()), errors.getvalue()

    def test_a_valid_file_gives_its_names_in_order(self):
        path, source = self.source(("bot-c", "bot-b", "a"))
        self.assertEqual(self.names(source), (["bot-c", "bot-b", "a"], ""))

    def test_the_file_must_carry_the_publishers_at_key(self):
        path, source = self.source(("bot-b",), at=None)
        self.assertEqual(self.names(source), ([], FIXED_LINE))
        path, source = self.source(("bot-b",))
        self.assertEqual(self.names(source), (["bot-b"], ""))

    def test_an_at_that_is_90_seconds_old_is_accepted_and_91_is_not(self):
        for age, good in ((0, True), (89, True), (90, True), (91, False), (3600, False)):
            with self.subTest(age=age):
                path, source = self.source(("bot-b",), at=int(BASE_TIME) - age)
                expected = (["bot-b"], "") if good else ([], FIXED_LINE)
                self.assertEqual(self.names(source), expected)

    def test_an_at_that_is_60_seconds_ahead_is_accepted_and_61_is_not(self):
        for ahead, good in ((1, True), (59, True), (60, True), (61, False), (3600, False)):
            with self.subTest(ahead=ahead):
                path, source = self.source(("bot-b",), at=int(BASE_TIME) + ahead)
                expected = (["bot-b"], "") if good else ([], FIXED_LINE)
                self.assertEqual(self.names(source), expected)

    def test_a_fraction_of_a_second_past_either_limit_is_refused(self):
        path, source = self.source(("bot-b",), at=int(BASE_TIME) - 90)
        self.now = BASE_TIME + 0.5
        self.assertEqual(self.names(source), ([], FIXED_LINE))
        self.now = BASE_TIME
        self.assertEqual(self.names(source), (["bot-b"], ""))
        path, source = self.source(("bot-b",), at=int(BASE_TIME) + 60)
        self.now = BASE_TIME - 0.5
        self.assertEqual(self.names(source), ([], FIXED_LINE))
        self.now = BASE_TIME
        self.assertEqual(self.names(source), (["bot-b"], ""))

    def test_an_at_that_is_not_a_whole_number_is_refused(self):
        for value in ("true", "false", "null", "1730858160.0", "1.7308581599e9", '"1730858160"', "[1730858160]", "-1"):
            with self.subTest(at=value):
                path, source = self.source(("bot-b",), text='{"v":1,"at":' + value + ',"bots":["bot-b"]}\n')
                self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_the_clock_is_read_on_every_call(self):
        path, source = self.source(("bot-b",))
        self.assertEqual(self.names(source), (["bot-b"], ""))
        self.now = BASE_TIME + 91
        self.assertEqual(self.names(source), ([], FIXED_LINE))
        self.now = BASE_TIME + 91
        self.assertEqual(self.names(source), ([], ""))
        self.now = BASE_TIME + 10
        self.assertEqual(self.names(source), (["bot-b"], ""))

    def test_an_empty_list_is_valid_and_quiet(self):
        path, source = self.source(())
        self.assertEqual(self.names(source), ([], ""))

    def test_sixty_four_names_are_valid_and_sixty_five_are_not(self):
        names = [f"bot-{number:02d}" for number in range(64)]
        path, source = self.source(names)
        self.assertEqual(self.names(source), (names, ""))
        path, source = self.source(names + ["bot-64"])
        self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_a_name_must_follow_the_grammar(self):
        good = ["a", "a0", "bot-b", "a" + "b" * 31]
        for name in good:
            with self.subTest(good=name):
                path, source = self.source((name,))
                self.assertEqual(self.names(source), ([name], ""))
        bad = ["", "A", "Bot", "1bot", "-bot", "a" + "b" * 32, "bot b", "bot_b", "bot.b", "b\u00e9t", "bot\n", " bot"]
        for name in bad:
            with self.subTest(bad=name):
                path, source = self.source(("bot-b", name))
                self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_a_duplicate_name_is_refused(self):
        path, source = self.source(("bot-b", "bot-c", "bot-b"))
        self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_a_name_that_is_not_a_string_is_refused(self):
        for item in (1, None, True, ["bot-b"], {"a": 1}):
            with self.subTest(item=item):
                path, source = self.source(("bot-b", item))
                self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_the_size_limit_is_4096_bytes(self):
        body = '{"v":1,"at":%d,"bots":["bot-b"]}' % int(BASE_TIME)
        path, source = self.source(text=body + " " * (4096 - len(body)))
        self.assertEqual(self.names(source), (["bot-b"], ""))
        path, source = self.source(text=body + " " * (4097 - len(body)))
        self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_bad_documents_are_refused(self):
        at = '"at":%d' % int(BASE_TIME)
        cases = {
            "not json": "no json here\n",
            "empty": "",
            "array": '["bot-b"]\n',
            "no v": '{%s,"bots":["bot-b"]}\n' % at,
            "v is 2": '{"v":2,%s,"bots":["bot-b"]}\n' % at,
            "v is a string": '{"v":"1",%s,"bots":["bot-b"]}\n' % at,
            "v is true": '{"v":true,%s,"bots":["bot-b"]}\n' % at,
            "v is 1.0": '{"v":1.0,%s,"bots":["bot-b"]}\n' % at,
            "no bots": '{"v":1,%s}\n' % at,
            "bots is a string": '{"v":1,%s,"bots":"bot-b"}\n' % at,
            "bots is an object": '{"v":1,%s,"bots":{"a":"b"}}\n' % at,
            "unknown key": '{"v":1,%s,"bots":["bot-b"],"extra":1}\n' % at,
            "duplicate key": '{"v":1,%s,"bots":["bot-b"],"bots":["bot-c"]}\n' % at,
            "duplicate v": '{"v":1,"v":1,%s,"bots":["bot-b"]}\n' % at,
            "duplicate at": '{"v":1,%s,%s,"bots":["bot-b"]}\n' % (at, at),
            "no at": '{"v":1,"bots":["bot-b"]}\n',
            "at is a string": '{"v":1,"at":"now","bots":["bot-b"]}\n',
            "at is true": '{"v":1,"at":true,"bots":["bot-b"]}\n',
            "at is negative": '{"v":1,"at":-1,"bots":["bot-b"]}\n',
            "trailing text": '{"v":1,%s,"bots":["bot-b"]} extra\n' % at,
            "two documents": '{"v":1,%s,"bots":["bot-b"]}\n{"v":1,%s,"bots":["bot-c"]}\n' % (at, at),
            "nan": '{"v":1,"at":NaN,"bots":["bot-b"]}\n',
            "bad utf-8": None,
        }
        for label, text in cases.items():
            with self.subTest(label=label):
                path, source = self.source(text=text if text is not None else "x")
                if text is None:
                    path.write_bytes(b'{"v":1,"at":%d,"bots":["bot-b\xff"]}\n' % int(BASE_TIME))
                    os.chmod(path, 0o640)
                self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_a_missing_file_fails_closed_with_one_fixed_line(self):
        path, source = self.source(None)
        self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_the_fixed_line_is_written_once_for_one_run_of_failures(self):
        path, source = self.source(None)
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            for number in range(5):
                self.assertEqual(list(source()), [])
        self.assertEqual(errors.getvalue(), FIXED_LINE)

    def test_a_failure_after_a_failure_is_not_logged_again_but_one_after_a_recovery_is(self):
        path, source = self.source(None)
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            list(source())
            write_bots(path, ("bot-b",))
            self.assertEqual(list(source()), ["bot-b"])
            os.unlink(path)
            list(source())
        self.assertEqual(errors.getvalue(), FIXED_LINE + FIXED_LINE)

    def test_there_is_no_last_good_copy(self):
        path, source = self.source(("bot-b",))
        self.assertEqual(self.names(source), (["bot-b"], ""))
        write_bots(path, ("bot-b", "BAD"))
        self.assertEqual(self.names(source), ([], FIXED_LINE))
        os.unlink(path)
        self.assertEqual(self.names(source), ([], ""))
        write_bots(path, ("bot-c",))
        self.assertEqual(self.names(source), (["bot-c"], ""))

    def test_the_file_is_read_again_on_every_call(self):
        path, source = self.source(("bot-b",))
        for names in (("bot-b",), ("bot-c",), ("bot-d", "bot-e")):
            write_bots(path, names)
            self.assertEqual(self.names(source)[0], list(names))

    def test_a_symbolic_link_is_refused(self):
        path, source = self.source(("bot-b",))
        target = path.with_name("elsewhere.json")
        os.replace(path, target)
        os.symlink(target, path)
        self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_a_folder_is_refused(self):
        path, source = self.source(None)
        os.mkdir(path)
        self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_a_named_pipe_is_refused_without_blocking(self):
        path, source = self.source(None)
        os.mkfifo(path)
        result = []
        worker = threading.Thread(target=lambda: result.append(self.names(source)), daemon=True)
        worker.start()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [([], FIXED_LINE)])

    def test_a_named_pipe_that_holds_a_valid_list_is_still_refused(self):
        path, source = self.source(None)
        os.mkfifo(path, 0o640)
        keeper = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        self.addCleanup(os.close, keeper)
        writer = os.open(path, os.O_WRONLY)
        os.write(writer, b'{"v":1,"at":%d,"bots":["bot-b"]}\n' % int(BASE_TIME))
        os.close(writer)
        self.assertEqual(self.names(source), ([], FIXED_LINE))

    def test_a_file_not_owned_like_its_folder_is_refused(self):
        path, source = self.source(("bot-b",))
        folder = str(path.parent)
        real = os.stat

        def other_owner(target, *args, **kwargs):
            result = real(target, *args, **kwargs)
            if str(target) != folder:
                return result
            values = list(result)
            values[4] = result.st_uid + 1
            return os.stat_result(values)

        with mock.patch.object(os, "stat", other_owner):
            self.assertEqual(self.names(source), ([], FIXED_LINE))
        self.assertEqual(self.names(source), (["bot-b"], ""))

    def test_a_file_others_can_write_is_refused_and_readable_modes_are_fine(self):
        for mode, good in ((0o640, True), (0o644, True), (0o600, True), (0o440, True), (0o660, False), (0o664, False), (0o646, False), (0o620, False), (0o602, False)):
            with self.subTest(mode=oct(mode)):
                path, source = self.source(("bot-b",), mode=mode)
                expected = (["bot-b"], "") if good else ([], FIXED_LINE)
                self.assertEqual(self.names(source), expected)

    def test_a_relative_or_empty_path_is_refused_at_start(self):
        bot_list = module("bot_list")
        for path in ("", "chat-bots.json", None, 5):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    bot_list.BotList(path)


class BotCheckInTheServiceTests(unittest.TestCase):
    def test_a_list_is_checked_each_time_and_a_bad_file_leaves_the_steward_only(self):
        env = Env(self)
        env.refresh()
        self.assertEqual(sorted(r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]), [STEWARD, "bot-b", "bot-c"])
        write_bots(env.bots_path, ("bot-b", "BAD"))
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            self.assertEqual([r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]], [STEWARD])
        self.assertEqual(without_replies(errors.getvalue()), FIXED_LINE)
        write_bots(env.bots_path, ("bot-b",))
        self.assertEqual(sorted(r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]), [STEWARD, "bot-b"])

    def test_a_send_is_checked_against_the_file_as_it_is_now(self):
        env = Env(self)
        env.refresh()
        self.assertEqual(env.send("bot-b", "first").status, 200)
        write_bots(env.bots_path, ("bot-c",))
        self.assertEqual(answer(env.send("bot-b", "second")), (422, {"error": "bot"}))
        os.unlink(env.bots_path)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(answer(env.send("bot-c", "third")), (422, {"error": "bot"}))
            self.assertEqual(env.send(STEWARD, "fourth").status, 200)
        self.assertEqual(len(env.mail.send_calls), 2)

    def test_a_thread_read_is_checked_against_the_file_as_it_is_now(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "hi", 1)
        env.refresh()
        self.assertEqual(env.get("/captain/api/chat?bot=bot-b").status, 200)
        write_bots(env.bots_path, ("bot-c",))
        self.assertEqual(answer(env.get("/captain/api/chat?bot=bot-b")), (422, {"error": "bot"}))

    def test_an_invalid_file_never_opens_the_list_to_anything_in_the_mail(self):
        env = Env(self)
        env.mail.bot_says("bot-x", "i am not listed", 1)
        env.refresh()
        write_bots(env.bots_path, ("bot-b", "bot-b"))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual([r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]], [STEWARD])
            self.assertEqual(answer(env.get("/captain/api/chat?bot=bot-x"))[0], 422)

    def test_no_configured_file_means_the_steward_only(self):
        env = Env(self, configured=False)
        env.refresh()
        self.assertEqual([r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]], [STEWARD])
        self.assertEqual(answer(env.send("bot-b", "Hi")), (422, {"error": "bot"}))

    def test_reads_of_chat_cost_no_mail_server_reads(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "hi", 1)
        env.refresh()
        reads = env.mail.reads
        for number in range(20):
            env.get("/captain/api/chats")
            env.get("/captain/api/chat?bot=bot-b")
        self.assertEqual(env.mail.reads, reads)

    def test_a_file_that_turns_stale_between_two_reads_leaves_the_steward_only_for_the_list_the_thread_and_the_send(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "hi", 1)
        env.refresh()
        self.assertEqual(sorted(r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]), [STEWARD, "bot-b", "bot-c"])
        self.assertEqual(env.send("bot-b", "before").status, 200)
        env.now = BASE_TIME + 91
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            self.assertEqual([r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]], [STEWARD])
            self.assertEqual(answer(env.get("/captain/api/chat?bot=bot-b")), (422, {"error": "bot"}))
            self.assertEqual(answer(env.send("bot-b", "after")), (422, {"error": "bot"}))
            self.assertEqual(env.send(STEWARD, "to the steward").status, 200)
        self.assertEqual(without_replies(errors.getvalue()), FIXED_LINE)
        self.assertEqual(len(env.mail.send_calls), 2)
        write_bots(env.bots_path, ("bot-b", "bot-c"), at=int(env.now))
        self.assertEqual(sorted(r["bot"]["id"] for r in answer(env.get("/captain/api/chats"))[1]), [STEWARD, "bot-b", "bot-c"])


class StubService:
    def __init__(self):
        self.cards = {"projects": [], "plainMail": [], "truncated": False}
        self.chats = []

    def refresh(self):
        return dict(self.cards)

    def chat_list(self):
        return list(self.chats)


class StubState:
    def __init__(self):
        self.token_value = "t1"

    def run(self, refresh):
        return refresh()

    def token(self):
        return self.token_value


def event_data(text):
    return json.loads(text.split("data: ", 1)[1].split("\n", 1)[0])


class EventsFlagTests(unittest.TestCase):
    def build(self, state=None):
        self.service = StubService()
        self.updates = live.LiveUpdates(self.service, state)
        self.updates.check_once()
        return self.updates

    def next_event(self, after):
        return next(self.updates.events(after=after))

    def test_the_first_event_has_every_flag_true(self):
        self.build()
        text = self.next_event(0)
        self.assertEqual(text, 'id: 1\nevent: refresh\ndata: {"cards":true,"chats":true,"mail":true}\n\n')

    def test_a_cards_only_change_says_chats_false_and_leaves_cards_and_mail_true(self):
        self.build()
        self.service.cards = {"projects": [{"name": "x"}], "plainMail": [], "truncated": False}
        self.assertTrue(self.updates.check_once())
        text = self.next_event(1)
        self.assertEqual(text, 'id: 2\nevent: refresh\ndata: {"cards":true,"chats":false,"mail":true}\n\n')

    def test_a_chat_change_says_chats_true(self):
        self.build()
        self.service.chats = [{"id": "bot-b", "preview": "hi", "at": "t", "last": "m1", "unread": False}]
        self.assertTrue(self.updates.check_once())
        self.assertEqual(event_data(self.next_event(1)), {"cards": True, "chats": True, "mail": True})

    def test_a_mail_only_change_says_chats_false(self):
        state = StubState()
        self.build(state)
        state.token_value = "t2"
        self.assertTrue(self.updates.check_once())
        self.assertEqual(event_data(self.next_event(1)), {"cards": True, "chats": False, "mail": True})

    def test_an_idle_minute_sends_no_event_and_no_chats_true(self):
        self.build()
        for tick in range(12):
            self.assertFalse(self.updates.check_once())
        self.assertEqual(self.updates.version, 1)
        self.service.cards = {"projects": [{"name": "y"}], "plainMail": [], "truncated": False}
        self.updates.check_once()
        self.assertEqual(event_data(self.next_event(1))["chats"], False)

    def test_a_chat_change_inside_merged_updates_is_still_reported(self):
        self.build()
        self.service.cards = {"projects": [{"name": "a"}], "plainMail": [], "truncated": False}
        self.updates.check_once()
        self.service.chats = [{"id": "bot-b", "preview": "hi", "at": "t", "last": "m1", "unread": False}]
        self.updates.check_once()
        self.service.cards = {"projects": [{"name": "b"}], "plainMail": [], "truncated": False}
        self.updates.check_once()
        self.assertEqual(self.updates.version, 4)
        self.assertEqual(event_data(self.next_event(1))["chats"], True)
        self.assertEqual(event_data(self.next_event(2))["chats"], True)
        self.assertEqual(event_data(self.next_event(3))["chats"], False)

    def test_a_stream_that_joined_after_the_chat_change_is_told_false_for_later_card_changes(self):
        self.build()
        self.service.chats = [{"id": "bot-b", "preview": "hi", "at": "t", "last": "m1", "unread": False}]
        self.updates.check_once()
        self.service.cards = {"projects": [{"name": "b"}], "plainMail": [], "truncated": False}
        self.updates.check_once()
        self.assertEqual(event_data(self.next_event(2))["chats"], False)

    def test_a_new_stream_without_a_cursor_is_told_everything_changed(self):
        self.build()
        self.service.cards = {"projects": [{"name": "a"}], "plainMail": [], "truncated": False}
        self.updates.check_once()
        self.assertEqual(event_data(self.next_event(0)), {"cards": True, "chats": True, "mail": True})

    def test_the_event_line_keeps_its_key_order_and_form(self):
        self.build()
        self.service.cards = {"projects": [{"name": "a"}], "plainMail": [], "truncated": False}
        self.updates.check_once()
        self.assertIn('data: {"cards":true,"chats":false,"mail":true}\n', self.next_event(1))

    def test_a_real_service_says_chats_true_for_a_new_bot_message_and_nothing_for_unrelated_mail(self):
        env = Env(self)
        env.updates.check_once()
        before = env.updates.version
        env.mail.bot_says("bot-b", "hello", 5)
        self.assertTrue(env.updates.check_once())
        self.assertEqual(event_data(next(env.updates.events(after=before)))["chats"], True)
        self.assertFalse(env.updates.check_once())
        env.mail.inbox.append(cards.MailMessage("odd@qd.invalid", "bot-b", "hello", "plain mail", stamp(9)))
        env.updates.check_once()
        self.assertEqual(env.updates.version, before + 1)


class RuntimeKeyTests(unittest.TestCase):
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

    def test_the_chat_bots_path_is_optional_and_off_by_default(self):
        self.assertIsNone(server.load_runtime_config(self.config()).chat_bots_path)

    def test_an_absolute_chat_bots_path_is_read(self):
        config = server.load_runtime_config(self.config(chatBotsPath="/run/quarterdeck-captain-auth/chat-bots.json"))
        self.assertEqual(config.chat_bots_path, "/run/quarterdeck-captain-auth/chat-bots.json")

    def test_a_bad_chat_bots_path_refuses_the_whole_config(self):
        for value in ("", "relative.json", 5, None, ["/a"], "/a\0b"):
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    server.load_runtime_config(self.config(chatBotsPath=value))

    def test_the_runtime_config_still_has_the_old_positional_shape(self):
        config = server.RuntimeConfig(8080, "https://jmap.invalid/session", "/k", "/r", "/g", "/a", "/site", "/state")
        self.assertIsNone(config.chat_bots_path)


class AssembleTests(unittest.TestCase):
    def test_assemble_routes_chat_and_reads_the_configured_file(self):
        root = Path(tempfile.mkdtemp(prefix="qd-assemble-"))
        self.addCleanup(clean, root)
        site = root / "site"
        site.mkdir()
        for name, data in FILES.items():
            (site / name).write_bytes(data)
        bots = root / "chat-bots.json"
        write_bots(bots, ("bot-b",), at=int(time.time()))
        mail = Mail()
        mail.bot_says("bot-b", "hello", 3)
        config = server.RuntimeConfig(8080, "https://jmap.invalid/session", "/k", "/r", "/g", "/a", str(site), None, str(bots))
        gate = Gate()

        class State:
            def run(self, refresh):
                return refresh()

            def token(self):
                return "t"

        with mock.patch.dict(sys.modules, {"mail_api": None}):
            app, updates = server.assemble(config, mailbox=mail, checker=Checker(), gate=gate, state=State(), clock=lambda: BASE_TIME)
        updates.check_once()
        status, rows = answer(app.handle(request("GET", "/captain/api/chats")))
        self.assertEqual((status, sorted(row["bot"]["id"] for row in rows)), (200, [STEWARD, "bot-b"]))
        status, body = answer(app.handle(request("POST", "/captain/api/chat", {"bot": "bot-b", "text": "Hi", "clientId": "c1", "csrf": "t"})))
        self.assertEqual((status, body["from"]), (200, "captain"))

    def test_assemble_without_a_file_offers_the_steward_only(self):
        root = Path(tempfile.mkdtemp(prefix="qd-assemble-"))
        self.addCleanup(clean, root)
        site = root / "site"
        site.mkdir()
        for name, data in FILES.items():
            (site / name).write_bytes(data)
        config = server.RuntimeConfig(8080, "https://jmap.invalid/session", "/k", "/r", "/g", "/a", str(site), None)

        class State:
            def run(self, refresh):
                return refresh()

            def token(self):
                return "t"

        with mock.patch.dict(sys.modules, {"mail_api": None}):
            app, updates = server.assemble(config, mailbox=Mail(), checker=Checker(), gate=Gate(), state=State(), clock=lambda: BASE_TIME)
        updates.check_once()
        self.assertEqual([row["bot"]["id"] for row in answer(app.handle(request("GET", "/captain/api/chats")))[1]], [STEWARD])


class NoCommentsTests(unittest.TestCase):
    NEW = ("chat_api.py", "bot_list.py", "test_chat_server.py")

    def test_new_files_have_no_comments_or_docstrings(self):
        for name in self.NEW:
            path = PKG / name if name != "test_chat_server.py" else HERE / name
            with self.subTest(name=name):
                source = path.read_text(encoding="utf-8")
                comments = [token for token in tokenize.generate_tokens(io.StringIO(source).readline) if token.type == tokenize.COMMENT]
                self.assertEqual(comments, [])
                tree = ast.parse(source)
                docs = [node for node in ast.walk(tree) if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and ast.get_docstring(node) is not None]
                self.assertEqual(docs, [])


if __name__ == "__main__":
    unittest.main()
