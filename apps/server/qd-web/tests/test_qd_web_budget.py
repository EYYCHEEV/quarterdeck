import json
import sys
import threading
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import application
import approval_app
import approval_security
import cards
import live
import mail_gateway
import mailstate
import qd_jmap
from test_cards import FixtureChecker, card

NOW = 1_700_000_000.0
SESSION = "https://jmap.invalid/session"


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Stalwart:
    def __init__(self, clock):
        self.clock = clock
        self.calls = []
        self.state = 1
        self.refuse = None
        self.unreachable = False
        self.state_reply = "normal"
        self.inbox = [self.mail(f"i{n}", "bot-a", "account-user") for n in range(3)]
        self.sent = [self.mail(f"s{n}", "account-user", "bot-a") for n in range(2)]

    @staticmethod
    def mail(identifier, sender, recipient):
        return {
            "id": identifier,
            "messageId": [f"<{identifier}@qd.invalid>"],
            "from": [{"email": f"{sender}@qd.invalid"}],
            "to": [{"email": f"{recipient}@qd.invalid"}],
            "subject": f"hello {identifier}",
            "receivedAt": "2026-11-05T14:00:00Z",
            "textBody": [{"partId": "1"}],
            "bodyValues": {"1": {"value": "hi"}},
        }

    def change(self):
        self.state += 1
        self.inbox.append(self.mail(f"i{len(self.inbox)}", "bot-a", "account-user"))

    def add_card(self):
        entry = self.mail("c1", "repo-lead", "account-user")
        entry["subject"] = "CARD: Choose"
        entry["bodyValues"] = {"1": {"value": json.dumps(card("repo-lead-1", "Repo", "Launch", "Choose"), separators=(",", ":"))}}
        self.inbox.append(entry)
        self.state += 1

    def times(self):
        return [moment for moment, _ in self.calls]

    def __call__(self, method, url, headers, body=None):
        self.calls.append((self.clock(), method))
        if self.unreachable:
            raise OSError("down")
        if self.refuse is not None:
            return self.refuse, b""
        if method == "GET":
            document = {"apiUrl": "https://jmap.invalid/api", "primaryAccounts": {"urn:ietf:params:jmap:mail": "a1"}}
            return 200, json.dumps(document).encode()
        responses = []
        for name, args, call_id in json.loads(body)["methodCalls"]:
            responses.append([name, self.answer(name, args), call_id])
        return 200, json.dumps({"methodResponses": responses}).encode()

    def answer(self, name, args):
        if name == "Identity/get":
            return {"list": [{"id": "i1", "email": "account-user@qd.invalid"}]}
        if name == "Mailbox/get":
            return {"list": [{"id": "mb-in", "role": "inbox"}, {"id": "mb-dr", "role": "drafts"}, {"id": "mb-se", "role": "sent"}]}
        if name == "Email/query":
            folder = self.inbox if args["filter"]["inMailbox"] == "mb-in" else self.sent
            ids = [entry["id"] for entry in folder]
            return {"ids": ids[args.get("position", 0) : args.get("position", 0) + args.get("limit", 256)]}
        if args.get("ids") == []:
            return self.state_answer()
        wanted = set(args["ids"])
        return {"list": [entry for entry in self.inbox + self.sent if entry["id"] in wanted]}

    def state_answer(self):
        if self.state_reply == "missing":
            return {"list": []}
        if self.state_reply == "number":
            return {"list": [], "state": 7}
        if self.state_reply == "empty":
            return {"list": [], "state": ""}
        if self.state_reply == "long":
            return {"list": [], "state": "x" * 300}
        if self.state_reply == "control":
            return {"list": [], "state": "a\nb"}
        return {"list": [], "state": f"s{self.state}"}


def window_counts(times, start, end, span=60.0):
    found = []
    moment = start
    while moment <= end:
        found.append(sum(1 for value in times if moment - span < value <= moment))
        moment += 1.0
    return found


class Wiring:
    def build(self, **budget_options):
        self.clock = Clock()
        self.stalwart = Stalwart(self.clock)
        self.budget = mailstate.Budget(self.clock, **budget_options)
        transport = mailstate.MeteredTransport(self.stalwart, self.budget)
        credential = qd_jmap.Credential(bytearray(b"stand-in"))
        jmap = qd_jmap.Jmap(SESSION, credential, transport)
        self.mailbox = mail_gateway.CaptainMailbox(
            qd_jmap.Mailbox(jmap), credential, account_name="account-user", oversight_bot="bot-a"
        )
        self.gate = mailstate.StateGate(self.mailbox, self.budget, self.clock)
        self.service = cards.CardService(self.mailbox, FixtureChecker())
        self.updates = live.LiveUpdates(self.service, self.gate)
        self.clock.now += 61.0
        self.stalwart.calls.clear()


class Recorder:
    def __init__(self):
        self.refreshes = 0
        self.fail = False
        self.payload = {"projects": [], "plainMail": []}

    def refresh(self):
        self.refreshes += 1
        if self.fail:
            raise RuntimeError("refresh failed")
        return self.payload

    def chat_list(self):
        return []


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.budget = mailstate.Budget(self.clock)

    def spend(self, count, background):
        for _ in range(count):
            if background:
                with self.budget.background():
                    self.budget.admit()
            else:
                self.budget.admit()

    def test_a_refusal_is_an_oserror_so_the_mail_client_reports_it_as_unreachable(self):
        self.assertTrue(issubclass(mailstate.BudgetRefused, OSError))

    def test_the_tick_is_held_to_thirty_six_requests_in_sixty_seconds(self):
        self.spend(36, True)
        with self.assertRaises(mailstate.BudgetRefused):
            self.spend(1, True)

    def test_his_own_actions_may_use_the_twenty_four_the_tick_cannot(self):
        self.spend(36, True)
        self.spend(24, False)
        with self.assertRaises(mailstate.BudgetRefused):
            self.spend(1, False)

    def test_nothing_exceeds_sixty_whoever_asks(self):
        self.spend(30, False)
        self.spend(6, True)
        self.spend(24, False)
        with self.assertRaises(mailstate.BudgetRefused):
            self.spend(1, False)
        with self.assertRaises(mailstate.BudgetRefused):
            self.spend(1, True)

    def test_the_window_slides(self):
        self.spend(36, True)
        self.clock.now += 59.0
        with self.assertRaises(mailstate.BudgetRefused):
            self.spend(1, True)
        self.clock.now += 1.5
        self.spend(36, True)

    def test_room_counts_down_for_the_tick(self):
        self.assertEqual(self.budget.room(), 36)
        self.spend(5, True)
        self.assertEqual(self.budget.room(), 31)
        self.spend(10, False)
        self.assertEqual(self.budget.room(), 21)

    def test_spent_counts_only_the_ticks_requests(self):
        self.spend(3, True)
        self.spend(4, False)
        self.assertEqual(self.budget.spent, 3)

    def test_only_the_thread_that_opened_the_tick_counts_as_the_tick(self):
        seen = []
        with self.budget.background():
            thread = threading.Thread(target=lambda: seen.append(self.budget.in_background()))
            thread.start()
            thread.join()
            self.assertTrue(self.budget.in_background())
        self.assertEqual(seen, [False])
        self.assertFalse(self.budget.in_background())

    def test_the_tick_flag_is_cleared_even_when_the_tick_fails(self):
        with self.assertRaises(RuntimeError):
            with self.budget.background():
                raise RuntimeError("x")
        self.assertFalse(self.budget.in_background())

    def test_a_refusal_from_the_server_pauses_every_request_for_ten_seconds(self):
        self.budget.admit()
        self.budget.settle(False)
        self.assertEqual(self.budget.room(), 0)
        self.clock.now += 9.9
        with self.assertRaises(mailstate.BudgetRefused):
            self.budget.admit()
        self.clock.now += 0.2
        self.budget.admit()

    def test_repeated_refusals_double_the_pause_up_to_sixty_seconds(self):
        pauses = []
        for _ in range(6):
            self.budget.admit()
            before = self.clock.now
            self.budget.settle(False)
            while True:
                try:
                    self.budget.admit()
                except mailstate.BudgetRefused:
                    self.clock.now += 1.0
                else:
                    break
            pauses.append(round(self.clock.now - before))
        self.assertEqual(pauses, [10, 20, 40, 60, 60, 60])

    def test_a_good_answer_clears_the_pause_and_the_doubling(self):
        for _ in range(2):
            self.budget.admit()
            self.budget.settle(False)
            self.clock.now += 61.0
        self.budget.admit()
        self.budget.settle(True)
        self.budget.admit()
        self.budget.settle(False)
        self.clock.now += 10.1
        self.budget.admit()

    def test_several_requests_failing_together_do_not_stretch_the_pause_further(self):
        for _ in range(4):
            self.budget.admit()
        for _ in range(4):
            self.budget.settle(False)
        self.clock.now += 10.1
        self.budget.admit()

    def test_room_is_zero_while_paused_and_returns_when_the_pause_ends(self):
        self.budget.admit()
        self.budget.settle(False)
        self.assertEqual(self.budget.room(), 0)
        self.clock.now += 10.1
        self.assertEqual(self.budget.room(), 35)

    def test_a_clock_that_reads_zero_is_not_a_pause(self):
        zero = Clock()
        zero.now = 0.0
        mailstate.Budget(zero).admit()

    def test_an_entry_exactly_sixty_seconds_old_has_left_the_window(self):
        self.spend(36, True)
        self.clock.now += 60.0
        self.spend(36, True)

    def test_nested_ticks_stay_the_tick_until_the_outer_one_ends(self):
        with self.budget.background():
            with self.budget.background():
                pass
            self.assertTrue(self.budget.in_background())
        self.assertFalse(self.budget.in_background())

    def test_room_is_never_negative(self):
        self.spend(55, False)
        self.assertEqual(self.budget.room(), 0)

    def test_the_limits_can_be_set(self):
        small = mailstate.Budget(self.clock, limit=5, background_limit=3)
        for _ in range(3):
            with small.background():
                small.admit()
        with self.assertRaises(mailstate.BudgetRefused):
            with small.background():
                small.admit()
        small.admit()
        small.admit()
        with self.assertRaises(mailstate.BudgetRefused):
            small.admit()


class MeteredTransportTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.budget = mailstate.Budget(self.clock)
        self.calls = []
        self.reply = (200, b"{}")
        self.raises = None
        self.transport = mailstate.MeteredTransport(self.inner, self.budget)

    def inner(self, method, url, headers, body=None):
        self.calls.append((method, url, dict(headers), body))
        if self.raises is not None:
            raise self.raises
        return self.reply

    def test_a_good_request_passes_through_unchanged(self):
        result = self.transport("POST", "https://x/api", {"A": "b"}, b"body")
        self.assertEqual(result, (200, b"{}"))
        self.assertEqual(self.calls, [("POST", "https://x/api", {"A": "b"}, b"body")])

    def test_the_body_defaults_to_none(self):
        self.transport("GET", "https://x/session", {})
        self.assertIsNone(self.calls[0][3])

    def test_every_status_but_200_pauses_the_next_request(self):
        for status in (401, 403, 404, 429, 500, 503):
            with self.subTest(status=status):
                clock = Clock()
                budget = mailstate.Budget(clock)
                transport = mailstate.MeteredTransport(lambda *a, status=status: (status, b""), budget)
                self.assertEqual(transport("GET", "u", {})[0], status)
                with self.assertRaises(mailstate.BudgetRefused):
                    transport("GET", "u", {})

    def test_a_paused_request_never_reaches_the_server(self):
        self.reply = (429, b"")
        self.transport("GET", "u", {})
        for _ in range(20):
            with self.assertRaises(mailstate.BudgetRefused):
                self.transport("GET", "u", {})
        self.assertEqual(len(self.calls), 1)

    def test_an_unreachable_server_pauses_and_the_error_is_passed_on(self):
        self.raises = OSError("down")
        with self.assertRaises(OSError) as caught:
            self.transport("GET", "u", {})
        self.assertNotIsInstance(caught.exception, mailstate.BudgetRefused)
        with self.assertRaises(mailstate.BudgetRefused):
            self.transport("GET", "u", {})
        self.assertEqual(len(self.calls), 1)

    def test_after_the_pause_a_good_answer_resumes_normal_service(self):
        self.reply = (503, b"")
        self.transport("GET", "u", {})
        self.reply = (200, b"{}")
        self.clock.now += 10.1
        self.assertEqual(self.transport("GET", "u", {}), (200, b"{}"))
        self.assertEqual(self.transport("GET", "u", {}), (200, b"{}"))

    def test_a_refused_request_is_not_counted_against_the_window(self):
        self.reply = (429, b"")
        self.transport("GET", "u", {})
        for _ in range(100):
            with self.assertRaises(mailstate.BudgetRefused):
                self.transport("GET", "u", {})
        self.clock.now += 10.1
        self.reply = (200, b"{}")
        for _ in range(58):
            self.transport("GET", "u", {})

    def test_the_mail_client_turns_a_refusal_into_its_own_failure(self):
        self.reply = (429, b"")
        self.budget.admit()
        self.budget.settle(False)
        jmap_error = None
        try:
            qd_jmap.Jmap(SESSION, qd_jmap.Credential(bytearray(b"x")), self.transport)
        except qd_jmap.MailFailed as error:
            jmap_error = str(error)
        self.assertIn("could not reach", jmap_error)


class StateGateTests(Wiring, unittest.TestCase):
    def setUp(self):
        self.build()
        self.recorder = Recorder()

    def run_gate(self):
        return self.gate.run(self.recorder.refresh)

    def test_before_any_tick_there_is_no_state(self):
        self.assertIsNone(self.gate.token())

    def test_the_first_tick_reads_the_state_and_refreshes(self):
        self.assertEqual(self.run_gate(), self.recorder.payload)
        self.assertEqual((self.recorder.refreshes, self.gate.token()), (1, "s1"))

    def test_a_tick_with_nothing_new_costs_one_request_and_no_refresh(self):
        self.run_gate()
        self.stalwart.calls.clear()
        self.assertIsNone(self.run_gate())
        self.assertEqual((len(self.stalwart.calls), self.recorder.refreshes), (1, 1))

    def test_the_state_read_is_an_email_get_with_no_ids(self):
        sent = []
        original = self.stalwart.answer

        def spy(name, args):
            sent.append((name, args))
            return original(name, args)

        self.stalwart.answer = spy
        self.run_gate()
        self.assertEqual(sent[0], ("Email/get", {"accountId": "a1", "ids": []}))

    def test_a_changed_state_refreshes_again(self):
        self.run_gate()
        self.stalwart.change()
        self.assertIsNotNone(self.run_gate())
        self.assertEqual((self.recorder.refreshes, self.gate.token()), (2, "s2"))

    def test_a_refresh_that_fails_leaves_the_old_state_so_the_next_tick_retries(self):
        self.recorder.fail = True
        with self.assertRaises(RuntimeError):
            self.run_gate()
        self.recorder.fail = False
        self.assertIsNotNone(self.run_gate())
        self.assertEqual(self.recorder.refreshes, 2)

    def test_a_refusal_on_the_state_read_is_raised_and_the_token_stays(self):
        self.run_gate()
        self.stalwart.change()
        self.stalwart.refuse = 429
        with self.assertRaises(qd_jmap.MailFailed):
            self.run_gate()
        self.assertEqual((self.gate.token(), self.recorder.refreshes), ("s1", 1))

    def test_the_tick_defers_without_a_request_when_eight_slots_or_fewer_are_free(self):
        for _ in range(28):
            with self.budget.background():
                self.budget.admit()
        self.stalwart.calls.clear()
        self.assertIsNone(self.run_gate())
        self.assertEqual((self.stalwart.calls, self.recorder.refreshes), ([], 0))

    def test_the_tick_defers_while_the_server_is_being_given_a_pause(self):
        self.stalwart.refuse = 503
        with self.assertRaises(qd_jmap.MailFailed):
            self.run_gate()
        self.stalwart.calls.clear()
        self.stalwart.refuse = None
        self.assertIsNone(self.run_gate())
        self.assertEqual(self.stalwart.calls, [])

    def test_a_dear_refresh_raises_the_room_the_tick_wants_before_it_starts(self):
        class Costly(Recorder):
            def refresh(inner):
                for _ in range(20):
                    self.mailbox.mailbox.jmap.call(("Email/get", {"ids": ["i0"]}))
                return super().refresh()

        costly = Costly()
        self.gate.run(costly.refresh)
        self.stalwart.change()
        self.clock.now += 61.0
        for _ in range(30):
            with self.budget.background():
                self.budget.admit()
        self.stalwart.calls.clear()
        self.assertIsNone(self.gate.run(costly.refresh))
        self.assertEqual(self.stalwart.calls, [])

    def test_the_tick_goes_ahead_with_nine_slots_free(self):
        for _ in range(27):
            with self.budget.background():
                self.budget.admit()
        self.assertIsNotNone(self.run_gate())

    def test_the_state_read_counts_as_the_ticks_and_not_as_his_own(self):
        self.run_gate()
        self.assertEqual(self.budget.spent, 1)

    def test_a_missing_or_odd_state_makes_the_gate_blind_but_working(self):
        for reply in ("missing", "number", "empty", "long", "control"):
            with self.subTest(reply=reply):
                self.build()
                self.stalwart.state_reply = reply
                recorder = Recorder()
                self.assertIsNotNone(self.gate.run(recorder.refresh))
                self.assertEqual(self.gate.token(), "blind-1")

    def test_a_blind_gate_refreshes_once_a_minute_with_a_new_token_each_time(self):
        self.stalwart.state_reply = "missing"
        self.run_gate()
        for _ in range(11):
            self.clock.now += 5.0
            self.assertIsNone(self.run_gate())
        self.clock.now += 5.0
        self.assertIsNotNone(self.run_gate())
        self.assertEqual((self.recorder.refreshes, self.gate.token()), (2, "blind-2"))

    def test_a_state_of_one_to_one_hundred_twenty_eight_characters_is_used_and_a_longer_one_is_not(self):
        for length, blind in ((1, False), (128, False), (129, True)):
            with self.subTest(length=length):
                self.build()
                self.stalwart.state_answer = lambda length=length: {"list": [], "state": "s" * length}
                self.gate.run(Recorder().refresh)
                self.assertEqual(self.gate.token().startswith("blind-"), blind)

    def test_a_gate_that_was_blind_follows_the_state_once_the_server_gives_one(self):
        self.stalwart.state_reply = "missing"
        self.run_gate()
        self.stalwart.state_reply = "normal"
        self.clock.now += 5.0
        self.assertIsNotNone(self.run_gate())
        self.assertEqual(self.gate.token(), "s1")
        self.clock.now += 5.0
        self.assertIsNone(self.run_gate())


class LiveGateTests(unittest.TestCase):
    class Gate:
        def __init__(self):
            self.payload = None
            self.value = "one"
            self.error = None
            self.ran = 0

        def run(self, refresh):
            self.ran += 1
            if self.error is not None:
                raise self.error
            return None if self.payload is None else refresh()

        def token(self):
            return self.value

    def setUp(self):
        self.gate = self.Gate()
        self.service = Recorder()
        self.updates = live.LiveUpdates(self.service, self.gate)

    def test_a_tick_the_gate_skips_publishes_nothing_and_reads_nothing_more(self):
        self.assertIs(self.updates.check_once(), False)
        self.assertEqual((self.service.refreshes, self.updates.version), (0, 0))

    def test_a_tick_the_gate_allows_publishes_with_the_mail_state_in_the_change_key(self):
        self.gate.payload = True
        self.assertTrue(self.updates.check_once())
        self.assertIn(b'"mail":"one"', self.updates._encoded)

    def test_a_new_mail_state_alone_sends_an_event(self):
        self.gate.payload = True
        self.updates.check_once()
        self.gate.value = "two"
        self.assertTrue(self.updates.check_once())
        self.assertEqual(self.updates.version, 2)

    def test_the_same_state_and_cards_send_nothing(self):
        self.gate.payload = True
        self.updates.check_once()
        self.assertFalse(self.updates.check_once())
        self.assertEqual(self.updates.version, 1)

    def test_a_failure_from_the_gate_is_raised_and_nothing_is_published(self):
        self.gate.payload = True
        self.updates.check_once()
        self.gate.error = qd_jmap.MailFailed("refused")
        with self.assertRaises(qd_jmap.MailFailed):
            self.updates.check_once()
        self.assertEqual(self.updates.version, 1)

    def test_the_event_text_stays_fixed(self):
        self.gate.payload = True
        self.updates.check_once()
        stream = self.updates.events(after=0)
        box = []
        worker = threading.Thread(target=lambda: box.append(next(stream)), daemon=True)
        worker.start()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(box, ['id: 1\nevent: refresh\ndata: {"cards":true,"chats":true,"mail":true}\n\n'])

    def test_without_a_gate_every_tick_refreshes_as_the_frozen_app_did(self):
        plain = live.LiveUpdates(self.service)
        plain.check_once()
        plain.check_once()
        self.assertEqual(self.service.refreshes, 2)
        self.assertNotIn(b"mail", plain._encoded)


class Measured(Wiring, unittest.TestCase):
    def setUp(self):
        self.build()

    def tick(self):
        before = len(self.stalwart.calls)
        try:
            self.updates.check_once()
        except Exception:
            pass
        spent = len(self.stalwart.calls) - before
        self.clock.now += 5.0
        return spent

    def mail_reads(self, count):
        for _ in range(count):
            try:
                self.mailbox.mailbox.jmap.call(("Email/query", {"filter": {"inMailbox": "mb-in"}, "limit": 64}))
            except Exception:
                pass

    def test_the_cards_refresh_counts_as_the_ticks_too(self):
        self.tick()
        self.assertEqual(self.budget.spent, 5)

    def test_idle_the_tick_spends_one_request_each_five_seconds_twelve_a_minute(self):
        first = self.tick()
        self.assertEqual(first, 5)
        spent = [self.tick() for _ in range(36)]
        self.assertEqual(set(spent), {1})
        times = self.stalwart.times()
        counts = window_counts(times, times[-1] - 120.0, times[-1])
        self.assertEqual(max(counts), 12)

    def test_idle_the_shared_state_text_stays_put_so_a_reader_that_rebuilds_on_change_reads_once(self):
        self.tick()
        reads = 0
        last = None
        for _ in range(24):
            self.tick()
            token = self.gate.token()
            if token != last:
                last = token
                reads += 1
        self.assertEqual(reads, 1)

    def test_busy_every_tick_sees_a_change_and_the_total_never_passes_sixty_a_minute(self):
        for _ in range(72):
            self.stalwart.change()
            self.tick()
            self.mail_reads(3)
        times = self.stalwart.times()
        counts = window_counts(times, times[0] + 60.0, times[-1])
        self.assertLessEqual(max(counts), 60)
        self.assertGreater(max(counts), 40)

    def test_busy_the_tick_alone_never_passes_forty_eight_a_minute(self):
        spent = []
        for _ in range(72):
            self.stalwart.change()
            spent.append(self.tick())
        self.assertLessEqual(max(sum(spent[index : index + 12]) for index in range(len(spent) - 11)), 48)
        self.assertGreater(sum(spent), 100)

    def test_busy_his_own_actions_still_get_through(self):
        for _ in range(24):
            self.stalwart.change()
            self.tick()
        used = sum(1 for moment in self.stalwart.times() if moment > self.clock.now - 60.0)
        self.assertLessEqual(used, 48)
        for _ in range(12):
            self.mailbox.mailbox.jmap.call(("Email/query", {"filter": {"inMailbox": "mb-in"}, "limit": 1}))

    def test_a_refusing_mail_server_is_asked_four_times_in_two_minutes_not_every_tick(self):
        self.stalwart.refuse = 429
        for _ in range(24):
            self.tick()
        self.assertEqual([round(value - 1061.0) for value in self.stalwart.times()], [0, 10, 30, 70])

    def test_a_refusal_gives_the_client_a_503_and_never_a_retry_loop(self):
        self.updates.check_once()
        self.stalwart.refuse = 503
        app = application.CardApplication(Gate(), self.service, self.updates, clock=lambda: NOW)
        self.stalwart.calls.clear()
        results = []
        for _ in range(10):
            try:
                self.mailbox.send("bot-a", "ANSWER: x", "{}", "key")
            except Exception as error:
                results.append(type(error).__name__)
        self.assertEqual(len(self.stalwart.calls), 1)
        self.assertEqual(results, ["MailFailed"] * 10)
        self.assertEqual(app._failure(qd_jmap.MailFailed("x")).status, 503)
        self.assertEqual(app._failure(mailstate.BudgetRefused("x")).status, 503)

    def test_after_the_server_recovers_the_ticks_return_to_one_request_each(self):
        self.stalwart.refuse = 429
        for _ in range(3):
            self.tick()
        self.stalwart.refuse = None
        self.clock.now += 70.0
        self.tick()
        self.stalwart.calls.clear()
        spent = [self.tick() for _ in range(12)]
        self.assertEqual(set(spent), {1})

    def test_an_unreachable_server_is_asked_once_then_left_alone_for_the_pause(self):
        self.stalwart.unreachable = True
        for _ in range(2):
            self.tick()
        self.assertEqual(len(self.stalwart.calls), 1)


class Gate:
    def authenticate(self, request):
        return "owner"

    def authorize_post(self, request, csrf):
        return "owner"

    def issue_csrf(self, owner):
        return "next"

    def fresh_until(self, owner):
        return NOW + 600


def post(path, payload):
    return approval_app.Request("POST", path, {"Content-Type": "application/json"}, bytearray(json.dumps(payload).encode("utf-8")), "127.0.0.1")


def get(path):
    return approval_app.Request("GET", path, {}, bytearray(), "127.0.0.1")


class ClientTests(Wiring, unittest.TestCase):
    def setUp(self):
        self.build()
        self.stalwart.add_card()
        self.app = application.CardApplication(Gate(), self.service, self.updates, clock=lambda: NOW)
        self.updates.check_once()
        self.clock.now += 5.0
        self.stalwart.calls.clear()

    def answer(self):
        return self.app.handle(post("/captain/cards/repo-lead-1/answer", {"rev": 1, "pick": "A", "note": "", "csrf": "t"}))

    def test_the_card_the_tick_read_is_in_the_list(self):
        body = json.loads(self.app.handle(get("/captain/cards")).body)
        self.assertEqual(body["projects"][0]["lanes"][0]["cards"][0]["id"], "repo-lead-1")

    def test_opening_the_cards_screen_costs_no_mail_request(self):
        for _ in range(20):
            self.assertEqual(self.app.handle(get("/captain/cards")).status, 200)
            self.assertEqual(self.app.handle(get("/captain/cards/repo-lead-1")).status, 200)
        self.assertEqual(self.stalwart.calls, [])

    def test_a_refusing_server_gives_the_client_a_503_after_one_request_and_none_after(self):
        for refusal in (429, 500, 503):
            with self.subTest(refusal=refusal):
                self.setUp()
                self.stalwart.refuse = refusal
                first = self.answer()
                self.assertEqual((first.status, json.loads(first.body)), (503, {"error": "request unavailable"}))
                self.assertEqual(len(self.stalwart.calls), 1)
                for _ in range(10):
                    self.assertEqual(self.answer().status, 503)
                self.assertEqual(len(self.stalwart.calls), 1)

    def test_an_unreachable_server_gives_the_client_a_503_after_one_request_and_none_after(self):
        self.stalwart.unreachable = True
        self.assertEqual(self.answer().status, 503)
        self.assertEqual(self.answer().status, 503)
        self.assertEqual(len(self.stalwart.calls), 1)

    def test_the_next_request_after_the_pause_reaches_the_server_again(self):
        self.stalwart.refuse = 503
        self.answer()
        self.clock.now += 10.1
        self.answer()
        self.assertEqual(len(self.stalwart.calls), 2)


if __name__ == "__main__":
    unittest.main()
