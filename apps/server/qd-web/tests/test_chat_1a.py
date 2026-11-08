import ast
import contextlib
import copy
import inspect
import io
import json
import re
import sys
import time
import tokenize
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import application
import mail_gateway
import mailstate
import qd_jmap
from test_chat_server import ACCOUNT, STEWARD, Env, Mail, answer, request
from test_qd_web_budget import Clock, Wiring

SESSION = "https://jmap.invalid/session"
REPLY = re.compile(r"QD_CHAT_REPLY route=(list|thread|send) status=(\d{3}) error=(\S+) cause=(\S+) ms=(\d+)")


def minute(number):
    return (datetime(2026, 11, 7, 7, 0, tzinfo=timezone.utc) + timedelta(minutes=number)).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeMailServer:
    def __init__(self):
        self.emails = {}
        self.requests = []
        self.created = 0

    def add(self, box, sender, recipient, subject, body, identifier=None):
        self.created += 1
        identifier = identifier or f"e{self.created}"
        self.emails[identifier] = {
            "id": identifier,
            "messageId": [f"<{identifier}@qd.invalid>"],
            "from": [{"email": f"{sender}@qd.invalid"}],
            "to": [{"email": f"{recipient}@qd.invalid"}],
            "subject": subject,
            "receivedAt": minute(self.created),
            "textBody": [{"partId": "1"}],
            "bodyValues": {"1": {"value": body}},
            "mailboxIds": {box: True},
        }
        return identifier

    def move(self, identifier, box):
        self.emails[identifier]["mailboxIds"] = {box: True}

    def __call__(self, method, url, headers, body=None):
        if method == "GET":
            document = {"apiUrl": "https://jmap.invalid/api", "primaryAccounts": {"urn:ietf:params:jmap:mail": "a1"}}
            return 200, json.dumps(document).encode()
        calls = json.loads(body)["methodCalls"]
        self.requests.append([name for name, arguments, call_id in calls])
        responses = [
            [name, self.answer(name, arguments), call_id]
            for name, arguments, call_id in calls
        ]
        return 200, json.dumps({"methodResponses": responses}).encode()

    def answer(self, name, arguments):
        if name == "Identity/get":
            return {"list": [{"id": "identity", "email": f"{ACCOUNT}@qd.invalid"}]}
        if name == "Mailbox/get":
            return {"list": [{"id": role, "role": role} for role in ("inbox", "drafts", "sent")]}
        if name == "Email/query":
            selected = arguments["filter"]
            rows = list(self.emails.values())
            for condition in selected.get("conditions", [selected]):
                if "inMailbox" in condition:
                    rows = [row for row in rows if row["mailboxIds"].get(condition["inMailbox"])]
                if "header" in condition:
                    rows = [row for row in rows if condition["header"][1] in [value.strip("<>") for value in row["messageId"]]]
            ascending = arguments.get("sort", [{"isAscending": True}])[0]["isAscending"]
            rows.sort(key=lambda row: row["receivedAt"], reverse=not ascending)
            start = arguments.get("position", 0)
            return {"ids": [row["id"] for row in rows[start:start + arguments.get("limit", 256)]]}
        if name == "Email/get":
            properties = set(arguments.get("properties", [])) | {"id"}
            rows = [
                {key: copy.deepcopy(value) for key, value in self.emails[identifier].items() if key in properties}
                for identifier in arguments["ids"]
                if identifier in self.emails
            ]
            return {"list": rows}
        if name == "Email/set":
            row = arguments["create"]["m"]
            self.draft = self.add(
                "drafts",
                ACCOUNT,
                row["to"][0]["email"].partition("@")[0],
                row["subject"],
                row["bodyValues"]["b"]["value"],
            )
            self.emails[self.draft]["messageId"] = list(row["messageId"])
            self.emails[self.draft][f"header:{qd_jmap.WORDS_HEADER}:asText"] = row[f"header:{qd_jmap.WORDS_HEADER}:asText"]
            return {"created": {"m": {"id": self.draft}}}
        if name == "EmailSubmission/set":
            self.move(self.draft, "sent")
            return {"created": {"s": {"id": "submission", "undoStatus": "pending"}}}
        raise AssertionError(f"Unexpected mail operation: {name}")

    def sent_ids(self):
        return [identifier for identifier, row in self.emails.items() if row["mailboxIds"].get("sent")]


def adapter(source, budget=None, **options):
    transport = source if budget is None else mailstate.MeteredTransport(source, budget)
    credential = qd_jmap.Credential(bytearray(b"stand-in"))
    jmap = qd_jmap.Jmap(SESSION, credential, transport)
    return mail_gateway.CaptainMailbox(
        qd_jmap.Mailbox(jmap), credential, account_name=ACCOUNT, oversight_bot=STEWARD, **options
    )


def patience_of(budget):
    if "patient" in inspect.signature(mail_gateway.CaptainMailbox).parameters:
        return {"patient": budget.patient}
    return {}


def captured():
    buffer = io.StringIO()
    return buffer, contextlib.redirect_stderr(buffer)


class ChatReplyLogTests(unittest.TestCase):
    def lines(self, text):
        return [line for line in text.splitlines() if line.startswith("QD_CHAT_REPLY")]

    def parsed(self, text):
        found = []
        for line in self.lines(text):
            match = REPLY.fullmatch(line)
            self.assertIsNotNone(match, line)
            found.append(match.groups()[:4])
        return found

    def test_every_answer_on_the_three_routes_has_one_line_with_route_status_error_and_cause(self):
        env = Env(self)
        env.refresh()
        output, redirect = captured()
        with redirect:
            env.get("/captain/api/chats")
            env.get("/captain/api/chat?bot=bot-b")
            env.send("bot-b", "Hello")
            env.get("/captain/api/chat?bot=nobody")
            env.send("bot-b", "")
            env.mail.fail = RuntimeError("boom")
            env.send("bot-b", "Again")
        self.assertEqual(
            self.parsed(output.getvalue()),
            [
                ("list", "200", "-", "-"),
                ("thread", "200", "-", "-"),
                ("send", "200", "-", "-"),
                ("thread", "422", "bot", "ChatBotRefused"),
                ("send", "400", "text", "ChatTextRefused"),
                ("send", "502", "mail", "RuntimeError"),
            ],
        )

    def test_a_signed_out_caller_is_logged_with_the_same_answers_as_before(self):
        env = Env(self)
        env.gate.refuse = application.AuthenticationRequired("x")
        output, redirect = captured()
        with redirect:
            statuses = [
                env.get("/captain/api/chats", token=None).status,
                env.get("/captain/api/chat?bot=bot-b", token=None).status,
                env.send("bot-b", "Hello", token=None).status,
            ]
        self.assertEqual(statuses, [401, 401, 401])
        self.assertEqual(
            self.parsed(output.getvalue()),
            [
                ("list", "401", "session", "AuthenticationRequired"),
                ("thread", "401", "session", "AuthenticationRequired"),
                ("send", "401", "session", "AuthenticationRequired"),
            ],
        )

    def test_the_rate_limit_and_a_refused_body_are_logged(self):
        env = Env(self)
        env.refresh()
        output, redirect = captured()
        with redirect:
            for number in range(11):
                env.send("bot-b", f"message {number}")
            env.web.handle(request("POST", "/captain/api/chat", body=b"not json", headers={"Content-Type": "application/json"}))
        found = self.parsed(output.getvalue())
        self.assertEqual(found[9], ("send", "200", "-", "-"))
        self.assertEqual(found[10], ("send", "429", "rate", "ChatRateLimited"))
        self.assertEqual(found[11][:3], ("send", "400", "request_refused"))

    def test_a_line_carries_no_message_text_client_id_cookie_token_or_address(self):
        env = Env(self)
        env.refresh()
        output, redirect = captured()
        with redirect:
            env.send("bot-b", "PRIVATE-WORDS-777", client_id="client-secret-555", token="cookie-secret-333")
            env.get("/captain/api/chat?bot=bot-b", token="cookie-secret-333")
            env.post({"bot": "bot-b", "text": "PRIVATE-WORDS-777", "clientId": "client-secret-555", "csrf": "csrf-secret-999"}, token="cookie-secret-333")
            env.mail.fail = RuntimeError("PRIVATE-WORDS-777 csrf-secret-999")
            env.send("bot-b", "PRIVATE-WORDS-777", client_id="client-secret-556", token="cookie-secret-333")
        text = output.getvalue()
        self.assertEqual(len(self.lines(text)), 4)
        for secret in ("PRIVATE-WORDS", "client-secret", "cookie-secret", "csrf-secret", "127.0.0.1", "bot-b", "csrf-now"):
            self.assertNotIn(secret, text)
        self.assertEqual(self.parsed(text)[3], ("send", "502", "mail", "RuntimeError"))

    def test_the_elapsed_time_is_whole_milliseconds_of_the_answer(self):
        class Slow(Mail):
            def send_chat(self, *arguments):
                time.sleep(0.15)
                return super().send_chat(*arguments)

        env = Env(self)
        env.service.mail = Slow()
        output, redirect = captured()
        with redirect:
            env.send("bot-b", "Hello")
            env.get("/captain/api/chats")
        send, listed = [REPLY.fullmatch(line) for line in self.lines(output.getvalue())]
        self.assertGreaterEqual(int(send.group(5)), 140)
        self.assertLess(int(send.group(5)), 3000)
        self.assertLess(int(listed.group(5)), 140)

    def test_the_cause_is_the_innermost_exception_of_the_chain(self):
        env = Env(self)
        env.refresh()

        class Cause(Mail):
            def send_chat(self, *arguments):
                try:
                    raise OSError("down")
                except OSError:
                    raise qd_jmap.MailFailed("could not reach") from None

        env.service.mail = Cause()
        output, redirect = captured()
        with redirect:
            self.assertEqual(env.send("bot-b", "Hello").status, 502)
        self.assertEqual(self.parsed(output.getvalue()), [("send", "502", "mail", "OSError")])

    def test_a_failing_log_sink_never_breaks_the_answer(self):
        env = Env(self)
        env.refresh()

        class Broken:
            def write(self, text):
                raise OSError("sink closed")

            def flush(self):
                raise OSError("sink closed")

        with contextlib.redirect_stderr(Broken()):
            self.assertEqual(env.get("/captain/api/chats").status, 200)


class SentAtOnceTests(unittest.TestCase):
    def thread(self, env, bot="bot-b"):
        with contextlib.redirect_stderr(io.StringIO()):
            status, body = answer(env.get(f"/captain/api/chat?bot={bot}"))
        self.assertEqual(status, 200, body)
        return body

    def test_a_thread_read_right_after_a_send_shows_the_message(self):
        env = Env(self)
        env.refresh()
        with contextlib.redirect_stderr(io.StringIO()):
            status, sent = answer(env.send("bot-b", "Fresh words", client_id="client-now"))
            body = self.thread(env)
        self.assertEqual(status, 200)
        self.assertEqual(
            body["messages"],
            [{"id": sent["id"], "from": "captain", "text": "Fresh words", "at": sent["at"], "refs": [], "clientId": "client-now", "quote": None, "files": []}],
        )

    def test_the_apps_look_up_by_client_id_finds_it_in_the_thread_and_the_row(self):
        env = Env(self)
        env.mail.bot_says("bot-b", "older", 5)
        env.refresh()
        with contextlib.redirect_stderr(io.StringIO()):
            status, sent = answer(env.send("bot-b", "Mine", client_id="client-find"))
        found = [message for message in self.thread(env)["messages"] if message.get("clientId") == "client-find"]
        self.assertEqual([message["id"] for message in found], [sent["id"]])
        self.assertEqual(env.row("bot-b")["last"], sent["id"])

    def test_the_real_refresh_replaces_it_and_no_duplicate_shows(self):
        env = Env(self)
        env.refresh()
        with contextlib.redirect_stderr(io.StringIO()):
            status, sent = answer(env.send("bot-b", "Once", client_id="client-once"))
        self.assertEqual(len(self.thread(env)["messages"]), 1)
        env.refresh()
        env.refresh()
        messages = self.thread(env)["messages"]
        self.assertEqual([message["id"] for message in messages], [sent["id"]])
        self.assertEqual(env.row("bot-b")["last"], sent["id"])
        self.assertEqual(self.thread(env)["older"], False)

    def test_a_refresh_that_started_before_the_send_does_not_drop_it(self):
        env = Env(self)
        env.refresh()
        stale = list(env.mail.inbox)
        with contextlib.redirect_stderr(io.StringIO()):
            status, sent = answer(env.send("bot-b", "Kept", client_id="client-kept"))
        real = env.mail.messages
        env.mail.messages = lambda: list(stale)
        env.refresh()
        self.assertEqual([message["id"] for message in self.thread(env)["messages"]], [sent["id"]])
        env.mail.messages = real
        env.refresh()
        self.assertEqual([message["id"] for message in self.thread(env)["messages"]], [sent["id"]])

    def test_a_retry_with_the_same_client_id_adds_one_message(self):
        env = Env(self)
        env.refresh()
        with contextlib.redirect_stderr(io.StringIO()):
            first = answer(env.send("bot-b", "Same", client_id="client-same"))[1]
            second = answer(env.send("bot-b", "Same", client_id="client-same"))[1]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.thread(env)["messages"]), 1)

    def test_a_message_the_refresh_already_lists_is_not_added_again(self):
        env = Env(self)
        env.refresh()
        with contextlib.redirect_stderr(io.StringIO()):
            status, sent = answer(env.send("bot-b", "Listed", client_id="client-listed"))
        env.refresh()
        env.service.keep_sent(sent["id"], "bot-b", "Listed", "client-listed", False, sent["at"])
        self.assertEqual(len(self.thread(env)["messages"]), 1)

    def test_through_the_real_mail_adapter_the_sent_message_shows_at_once_and_once_after_the_refresh(self):
        source = FakeMailServer()
        env = Env(self)
        env.service.mail = adapter(source)
        env.refresh()
        with contextlib.redirect_stderr(io.StringIO()):
            status, sent = answer(env.send("bot-b", "Through mail", client_id="client-mail"))
        self.assertEqual(status, 200)
        self.assertEqual([message["text"] for message in self.thread(env)["messages"]], ["Through mail"])
        env.refresh()
        messages = self.thread(env)["messages"]
        self.assertEqual([(message["id"], message["text"], message["clientId"]) for message in messages], [(sent["id"], "Through mail", "client-mail")])
        self.assertEqual(len(source.sent_ids()), 1)


class BudgetShareTests(unittest.TestCase):
    def test_the_background_cannot_take_more_than_sixty_minus_twenty_four(self):
        budget = mailstate.Budget(Clock())
        while True:
            try:
                with budget.background():
                    budget.admit()
            except mailstate.BudgetRefused:
                break
        left = 0
        while True:
            try:
                budget.admit()
            except mailstate.BudgetRefused:
                break
            left += 1
        self.assertGreaterEqual(left, 24)

    def test_background_at_full_load_still_leaves_room_for_four_sends_a_minute(self):
        clock = Clock()
        source = FakeMailServer()
        budget = mailstate.Budget(clock)
        env = Env(self)
        env.service.mail = adapter(source, budget, **patience_of(budget))
        clock.now += 61.0
        while True:
            try:
                with budget.background():
                    budget.admit()
            except mailstate.BudgetRefused:
                break
        with contextlib.redirect_stderr(io.StringIO()):
            statuses = [env.send("bot-b", f"Word {number}", client_id=f"client-{number}").status for number in range(4)]
        self.assertEqual(statuses, [200, 200, 200, 200])
        self.assertEqual(len(source.sent_ids()), 4)


class SendMeetsPauseTests(unittest.TestCase):
    def send_in_a_pause(self, pause):
        clock = Clock()
        source = FakeMailServer()
        budget = mailstate.Budget(clock, first_pause=pause)
        env = Env(self)
        env.service.mail = adapter(source, budget, **patience_of(budget))
        clock.now += 61.0
        budget.admit()
        budget.settle(False)
        naps = []

        def nap(seconds):
            naps.append(seconds)
            clock.now += seconds

        with mock.patch("time.sleep", nap), contextlib.redirect_stderr(io.StringIO()):
            response = env.send("bot-b", "Waiting words", client_id="client-wait")
        return response, naps, source

    def test_a_send_during_a_five_second_pause_waits_and_succeeds(self):
        response, naps, source = self.send_in_a_pause(5.0)
        self.assertEqual(response.status, 200)
        self.assertAlmostEqual(sum(naps), 5.0, places=3)
        self.assertEqual(len(source.sent_ids()), 1)

    def test_a_send_during_a_pause_of_exactly_eight_seconds_still_waits(self):
        response, naps, source = self.send_in_a_pause(8.0)
        self.assertEqual(response.status, 200)
        self.assertAlmostEqual(sum(naps), 8.0, places=3)

    def test_a_send_during_a_thirty_second_pause_fails_with_the_502_it_always_had(self):
        response, naps, source = self.send_in_a_pause(30.0)
        self.assertEqual(answer(response), (502, {"error": "mail"}))
        self.assertEqual(naps, [])
        self.assertEqual(source.sent_ids(), [])

    def test_a_pause_a_little_over_eight_seconds_fails_at_once(self):
        response, naps, source = self.send_in_a_pause(9.0)
        self.assertEqual(response.status, 502)
        self.assertEqual(naps, [])

    def test_only_a_send_waits_and_the_tick_and_other_requests_never_do(self):
        clock = Clock()
        budget = mailstate.Budget(clock, first_pause=5.0)
        budget.admit()
        budget.settle(False)
        naps = []

        def nap(seconds):
            naps.append(seconds)
            clock.now += seconds

        with mock.patch("time.sleep", nap):
            with self.assertRaises(mailstate.BudgetRefused):
                budget.admit()
            with self.assertRaises(mailstate.BudgetRefused):
                with budget.background():
                    budget.admit()
            with budget.patient(8.0):
                with self.assertRaises(mailstate.BudgetRefused):
                    with budget.background():
                        budget.admit()
            with self.assertRaises(mailstate.BudgetRefused):
                budget.admit()
        self.assertEqual(naps, [])

    def test_a_pause_that_is_renewed_while_waiting_is_not_waited_out_past_the_limit(self):
        clock = Clock()
        budget = mailstate.Budget(clock, first_pause=5.0)
        budget.admit()
        budget.settle(False)

        def nap(seconds):
            clock.now += seconds
            budget.admit()
            budget.settle(False)

        with mock.patch("time.sleep", nap):
            with self.assertRaises(mailstate.BudgetRefused):
                with budget.patient(8.0):
                    budget.admit()


class MailLineTests(Wiring, unittest.TestCase):
    def setUp(self):
        self.build()

    def slow(self):
        original = self.stalwart.answer

        def timed(name, args):
            self.clock.now += 0.25
            return original(name, args)

        self.stalwart.answer = timed

    def test_a_refresh_logs_its_time_and_request_count(self):
        self.slow()
        output, redirect = captured()
        with redirect:
            self.updates.check_once()
        self.assertEqual(output.getvalue().splitlines(), ["QD_MAIL_REFRESH ms=1000 requests=4"])

    def test_an_unchanged_state_logs_nothing(self):
        self.updates.check_once()
        output, redirect = captured()
        with redirect:
            self.updates.check_once()
            self.updates.check_once()
        self.assertEqual(output.getvalue(), "")

    def test_a_refresh_that_fails_is_still_logged(self):
        self.slow()
        self.stalwart.state_reply = "missing"

        def failing():
            self.mailbox.mailbox.jmap.call(("Email/get", {"ids": ["i0"]}))
            raise RuntimeError("refresh failed")

        self.service.refresh = failing
        output, redirect = captured()
        with redirect:
            with self.assertRaises(RuntimeError):
                self.updates.check_once()
        self.assertEqual(output.getvalue().splitlines(), ["QD_MAIL_REFRESH ms=250 requests=1"])

    def test_a_refusal_names_the_reason_and_who_asked(self):
        budget = mailstate.Budget(Clock())
        output, redirect = captured()
        with redirect:
            for _ in range(60):
                budget.admit()
            with self.assertRaises(mailstate.BudgetRefused):
                budget.admit()
            with self.assertRaises(mailstate.BudgetRefused):
                with budget.background():
                    budget.admit()
            paused = mailstate.Budget(Clock())
            paused.admit()
            paused.settle(False)
            with self.assertRaises(mailstate.BudgetRefused):
                paused.admit()
            with self.assertRaises(mailstate.BudgetRefused):
                with paused.background():
                    paused.admit()
        self.assertEqual(
            output.getvalue().splitlines(),
            [
                "QD_MAIL_BUDGET refused=full background=false",
                "QD_MAIL_BUDGET refused=full background=true",
                "QD_MAIL_BUDGET refused=pause background=false",
                "QD_MAIL_BUDGET refused=pause background=true",
            ],
        )

    def test_the_background_cap_is_a_full_refusal_for_the_background(self):
        budget = mailstate.Budget(Clock())
        output, redirect = captured()
        with redirect:
            while True:
                try:
                    with budget.background():
                        budget.admit()
                except mailstate.BudgetRefused:
                    break
        self.assertEqual(output.getvalue().splitlines(), ["QD_MAIL_BUDGET refused=full background=true"])

    def test_at_most_thirty_lines_a_minute_then_one_suppressed_line_on_the_next_refusal(self):
        clock = Clock()
        budget = mailstate.Budget(clock)
        output, redirect = captured()
        with redirect:
            budget.admit()
            budget.settle(False)
            for _ in range(40):
                with self.assertRaises(mailstate.BudgetRefused):
                    budget.admit()
        lines = output.getvalue().splitlines()
        self.assertEqual(lines, ["QD_MAIL_BUDGET refused=pause background=false"] * 30)
        clock.now += 61.0
        output, redirect = captured()
        with redirect:
            budget.admit()
            budget.settle(False)
            with self.assertRaises(mailstate.BudgetRefused):
                budget.admit()
        self.assertEqual(
            output.getvalue().splitlines(),
            ["QD_MAIL_LINES_SUPPRESSED count=10", "QD_MAIL_BUDGET refused=pause background=false"],
        )

    def test_the_suppressed_line_also_comes_from_a_quiet_tick(self):
        output, redirect = captured()
        with redirect:
            for _ in range(35):
                self.budget.log.budget("pause", False)
            self.clock.now += 61.0
            self.updates.check_once()
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 30 + 1 + 1)
        self.assertEqual(lines[30], "QD_MAIL_LINES_SUPPRESSED count=5")
        self.assertTrue(lines[31].startswith("QD_MAIL_REFRESH "))

    def test_the_two_kinds_share_the_cap_of_thirty(self):
        output, redirect = captured()
        with redirect:
            for _ in range(20):
                self.budget.log.budget("full", True)
            for _ in range(20):
                self.budget.log.refresh(1, 4)
            self.clock.now += 61.0
            self.budget.log.flush()
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 31)
        self.assertEqual(sum(line.startswith("QD_MAIL_BUDGET") for line in lines), 20)
        self.assertEqual(sum(line.startswith("QD_MAIL_REFRESH") for line in lines), 10)
        self.assertEqual(lines[-1], "QD_MAIL_LINES_SUPPRESSED count=10")

    def test_a_minute_with_no_excess_logs_no_suppressed_line(self):
        output, redirect = captured()
        with redirect:
            for _ in range(30):
                self.budget.log.budget("pause", False)
            self.clock.now += 61.0
            self.budget.log.flush()
            self.budget.log.flush()
        self.assertEqual(len(output.getvalue().splitlines()), 30)
        self.assertNotIn("SUPPRESSED", output.getvalue())

    def test_the_lines_carry_only_the_fixed_words_and_numbers(self):
        output, redirect = captured()
        with redirect:
            self.updates.check_once()
            self.budget.log.budget("pause", True)
        for line in output.getvalue().splitlines():
            self.assertRegex(line, r"\AQD_MAIL_(REFRESH ms=\d+ requests=\d+|BUDGET refused=(pause|full) background=(true|false))\Z")


class ServerWiringTests(unittest.TestCase):
    def test_the_server_hands_the_budget_to_sends(self):
        tree = ast.parse((PKG / "server.py").read_text(encoding="utf-8"))
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "open"
            and isinstance(node.func.value, ast.Attribute) and node.func.value.attr == "CaptainMailbox"
        ]
        self.assertEqual(len(calls), 1)
        keywords = {keyword.arg: ast.unparse(keyword.value) for keyword in calls[0].keywords}
        self.assertEqual(keywords["patient"], "budget.patient")


class NoCommentTests(unittest.TestCase):
    def test_the_changed_modules_and_this_file_have_no_comments(self):
        for path in [PKG / name for name in ("cards.py", "chat_api.py", "live.py", "mail_gateway.py", "mailstate.py", "server.py")] + [Path(__file__)]:
            source = path.read_text(encoding="utf-8")
            comments = [
                token
                for token in tokenize.generate_tokens(io.StringIO(source).readline)
                if token.type == tokenize.COMMENT and token.start[0] > 1
            ]
            with self.subTest(name=path.name):
                self.assertEqual(comments, [])
