import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import application
import mail_gateway
import mailstate
from test_chat_1a import FakeMailServer, adapter, patience_of
from test_chat_1a_fix1 import Rig, pause, quiet
from test_chat_server import answer

STEP = 0.08


def window(seconds=8.0):
    return mailstate.Window(time.monotonic, seconds)


class Taker(threading.Thread):
    def __init__(self, line, label, chat, order, seconds=8.0, stay=0.0):
        super().__init__(daemon=True)
        self.line = line
        self.label = label
        self.chat = chat
        self.order = order
        self.seconds = seconds
        self.stay = stay
        self.error = None
        self.finished = threading.Event()

    def run(self):
        try:
            self.line.take(window(self.seconds), self.chat)
        except mail_gateway.SendBusy as error:
            self.error = error
            self.finished.set()
            return
        try:
            self.order.append(self.label)
            if self.stay:
                pause(self.stay)
        finally:
            self.line.release()
            self.finished.set()


class LineCase(unittest.TestCase):
    def setUp(self):
        self.line = mail_gateway.SendLine(mail_gateway.SEND_WAITING)
        self.order = []
        self.takers = []
        self.held = False

    def tearDown(self):
        if self.held:
            self.line.release()
            self.held = False
        for taker in self.takers:
            taker.join(timeout=5)

    def hold(self):
        self.line.take(window(60.0), False)
        self.held = True

    def release(self):
        self.held = False
        self.line.release()

    def arrive(self, label, chat, seconds=8.0, stay=0.0):
        taker = Taker(self.line, label, chat, self.order, seconds, stay)
        self.takers.append(taker)
        taker.start()
        pause(STEP)
        return taker

    def finish(self):
        for taker in self.takers:
            self.assertTrue(taker.finished.wait(5), taker.label)


class PlacesTests(LineCase):
    def test_the_constants_are_four_waiting_places_with_one_kept_for_chat(self):
        self.assertEqual((mail_gateway.SEND_WAITING, mail_gateway.SEND_KEPT), (4, 1))

    def test_four_card_sends_behind_one_active_leave_a_place_for_a_chat_and_the_fourth_card_is_refused(self):
        self.hold()
        cards = [self.arrive(f"card-{number}", False) for number in range(1, 5)]
        self.assertTrue(cards[3].finished.is_set())
        self.assertIsInstance(cards[3].error, mail_gateway.SendBusy)
        self.assertEqual([card.finished.is_set() for card in cards[:3]], [False] * 3)
        chat = self.arrive("chat", True)
        self.assertFalse(chat.finished.is_set())
        self.assertIsNone(chat.error)
        self.release()
        self.finish()
        self.assertEqual(self.order, ["chat", "card-1", "card-2", "card-3"])

    def test_cards_wait_three_at_most_and_the_fourth_is_refused_at_once(self):
        self.hold()
        cards = [self.arrive(f"card-{number}", False) for number in range(1, 5)]
        self.assertEqual([card.error is None for card in cards], [True, True, True, False])
        self.assertEqual(str(cards[3].error), "too many sends are waiting")
        self.release()
        self.finish()
        self.assertEqual(self.order, ["card-1", "card-2", "card-3"])

    def test_chats_wait_four_at_most_and_the_fifth_is_refused_at_once(self):
        self.hold()
        chats = [self.arrive(f"chat-{number}", True) for number in range(1, 6)]
        self.assertEqual([chat.error is None for chat in chats], [True] * 4 + [False])
        self.assertEqual(str(chats[4].error), "too many sends are waiting")
        self.release()
        self.finish()
        self.assertEqual(self.order, ["chat-1", "chat-2", "chat-3", "chat-4"])

    def test_the_four_places_are_shared_so_waiting_cards_leave_fewer_for_chats(self):
        self.hold()
        self.arrive("card-1", False)
        self.arrive("card-2", False)
        self.arrive("card-3", False)
        first = self.arrive("chat-1", True)
        second = self.arrive("chat-2", True)
        self.assertIsNone(first.error)
        self.assertIsInstance(second.error, mail_gateway.SendBusy)
        self.release()
        self.finish()
        self.assertEqual(self.order, ["chat-1", "card-1", "card-2", "card-3"])

    def test_the_line_is_idle_for_a_send_with_nobody_ahead_for_either_kind(self):
        for chat in (True, False):
            with self.subTest(chat=chat):
                taker = self.arrive("one", chat)
                self.assertTrue(taker.finished.wait(2))
                self.assertIsNone(taker.error)
        self.assertEqual(self.order, ["one", "one"])


class TicketTests(LineCase):
    def test_two_chats_queued_in_a_known_order_run_in_that_order_while_new_card_and_chat_calls_arrive(self):
        self.hold()
        self.arrive("chat-a", True, stay=0.4)
        self.arrive("chat-b", True)
        self.arrive("card-1", False)
        self.release()
        pause(0.15)
        late_chat = self.arrive("chat-c", True)
        late_card = self.arrive("card-2", False)
        self.assertIsNone(late_chat.error)
        self.assertIsInstance(late_card.error, mail_gateway.SendBusy)
        self.finish()
        self.assertEqual(self.order, ["chat-a", "chat-b", "chat-c", "card-1"])

    def test_chats_run_in_ticket_order_not_in_the_order_the_waiters_wake(self):
        for round_number in range(4):
            with self.subTest(round=round_number):
                self.setUp()
                self.hold()
                for label in ("chat-1", "chat-2", "chat-3", "chat-4"):
                    self.arrive(label, True)
                self.release()
                self.finish()
                self.assertEqual(self.order, ["chat-1", "chat-2", "chat-3", "chat-4"])
                self.tearDown()

    def test_a_chat_goes_before_cards_that_arrived_earlier_and_cards_keep_their_own_order(self):
        self.hold()
        self.arrive("card-1", False)
        self.arrive("card-2", False)
        self.arrive("chat-1", True)
        self.release()
        self.finish()
        self.assertEqual(self.order, ["chat-1", "card-1", "card-2"])

    def test_a_send_arriving_just_after_a_release_does_not_jump_the_waiting_ones(self):
        for round_number in range(6):
            with self.subTest(round=round_number):
                self.setUp()
                self.hold()
                self.arrive("chat-1", True)
                self.arrive("card-1", False)
                self.release()
                self.line.take(window(5.0), False)
                self.order.append("main")
                self.line.release()
                self.finish()
                self.assertEqual(self.order, ["chat-1", "card-1", "main"])
                self.tearDown()


class ExistingChecksTests(LineCase):
    def test_one_send_is_active_at_a_time_across_both_kinds(self):
        inside = []
        worst = []
        guard = threading.Lock()

        def work(chat):
            try:
                self.line.take(window(8.0), chat)
            except mail_gateway.SendBusy:
                return
            try:
                with guard:
                    inside.append(1)
                    worst.append(len(inside))
                pause(0.01)
            finally:
                with guard:
                    inside.pop()
                self.line.release()

        threads = [threading.Thread(target=work, args=(number % 2 == 0,), daemon=True) for number in range(14)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.assertTrue(worst)
        self.assertEqual(max(worst), 1)

    def test_a_waiter_that_runs_out_of_its_time_is_refused_leaves_the_queue_and_frees_its_place(self):
        self.hold()
        short = self.arrive("short", True, seconds=0.2)
        self.assertTrue(short.finished.wait(2))
        self.assertEqual(str(short.error), "the send waited for its whole time")
        chats = [self.arrive(f"chat-{number}", True) for number in range(1, 6)]
        self.assertEqual([chat.error is None for chat in chats], [True] * 4 + [False])
        self.release()
        self.finish()
        self.assertEqual(self.order, ["chat-1", "chat-2", "chat-3", "chat-4"])

    def test_a_card_that_runs_out_of_its_time_frees_its_place_too(self):
        self.hold()
        short = self.arrive("short", False, seconds=0.2)
        self.assertTrue(short.finished.wait(2))
        self.assertIsInstance(short.error, mail_gateway.SendBusy)
        cards = [self.arrive(f"card-{number}", False) for number in range(1, 5)]
        self.assertEqual([card.error is None for card in cards], [True, True, True, False])
        self.release()
        self.finish()

    def test_a_send_that_arrives_with_no_time_left_is_refused_and_does_not_take_the_line(self):
        for chat in (True, False):
            with self.subTest(chat=chat):
                with self.assertRaises(mail_gateway.SendBusy):
                    self.line.take(window(0.0), chat)
                self.line.take(window(1.0), chat)
                self.line.release()

    def test_a_waiter_that_reaches_the_head_with_no_time_left_is_refused_and_the_line_goes_on(self):
        self.hold()
        short = self.arrive("short", True, seconds=0.15)
        later = self.arrive("later", True)
        pause(0.3)
        self.assertIsInstance(short.error, mail_gateway.SendBusy)
        self.assertFalse(later.finished.is_set())
        self.release()
        self.finish()
        self.assertEqual(self.order, ["later"])

    def test_the_refusals_are_the_fixed_class_with_fixed_words(self):
        self.assertTrue(issubclass(mail_gateway.SendBusy, OSError))
        self.hold()
        for number in range(1, 5):
            self.arrive(f"chat-{number}", True)
        refused = self.arrive("fifth", True)
        self.assertEqual((type(refused.error), str(refused.error)), (mail_gateway.SendBusy, "too many sends are waiting"))
        self.release()
        self.finish()

    def test_a_card_refusal_is_the_usual_503_and_a_chat_refusal_the_usual_502_cause(self):
        error = mail_gateway.SendBusy("too many sends are waiting")
        self.assertEqual(application.CardApplication._failure(error).status, 503)


class GatewayKindTests(unittest.TestCase):
    def test_send_takes_the_line_as_a_card_and_send_chat_takes_it_as_a_chat(self):
        calls = []

        class Recording(mail_gateway.SendLine):
            def take(self, window, chat=False):
                calls.append(chat)
                super().take(window, chat)

        rig = Rig(self)
        line = Recording(mail_gateway.SEND_WAITING)
        with mock.patch.object(mail_gateway, "_SEND_LINE", line), quiet():
            box = rig.env.service.mail
            box.send("bot-b", "COMMENT: Q1", "Words", "card-key-1")
            rig.env.send("bot-b", "Words", client_id="client-kind", token="session-kind")
        self.assertEqual(calls, [False, True])


class MixedLoadTests(unittest.TestCase):
    def card_send(self, rig, key, outcomes):
        def work():
            rig_ident[key] = threading.get_ident()
            try:
                outcomes[key] = rig.env.service.mail.send("bot-b", f"COMMENT: {key}", f"Words {key}", f"card-{key}")
            except Exception as error:
                outcomes[key] = error

        rig_ident = rig.idents
        thread = threading.Thread(target=work, daemon=True)
        rig.threads.append(thread)
        thread.start()
        pause(STEP)
        return thread

    def hold(self, rig):
        line = mail_gateway._SEND_LINE
        line.take(window(60.0), False)
        released = []

        def release():
            if not released:
                released.append(True)
                line.release()

        self.addCleanup(release)
        return release

    def test_with_one_sender_active_and_four_card_sends_trying_a_chat_still_gets_a_place_and_goes_first(self):
        rig = Rig(self)
        release = self.hold(rig)
        outcomes = {}
        with quiet():
            for key in ("k1", "k2", "k3", "k4"):
                self.card_send(rig, key, outcomes)
            self.assertIsInstance(outcomes["k4"], mail_gateway.SendBusy)
            self.assertEqual(sorted(outcomes), ["k4"])
            rig.start("chat")
            pause(0.2)
            self.assertNotIn("chat", rig.results)
            release()
            rig.join()
            for thread in rig.threads:
                thread.join(timeout=10)
        self.assertEqual(rig.results["chat"].status, 200)
        self.assertTrue(all(isinstance(outcomes[key], str) for key in ("k1", "k2", "k3")))
        self.assertEqual(application.CardApplication._failure(outcomes["k4"]).status, 503)
        self.assertEqual(rig.source.runs(), [rig.idents[key] for key in ("chat", "k1", "k2", "k3")])
        self.assertTrue(rig.source.one_at_a_time())

    def test_two_chats_queued_in_a_known_order_reach_mail_in_that_order_with_cards_in_between(self):
        rig = Rig(self)
        release = self.hold(rig)
        outcomes = {}
        with quiet():
            rig.start("a")
            pause(STEP)
            self.card_send(rig, "k1", outcomes)
            rig.start("b")
            pause(STEP)
            rig.start("c")
            pause(STEP)
            release()
            rig.join()
            for thread in rig.threads:
                thread.join(timeout=10)
        self.assertEqual(sorted(rig.statuses().values()), [200, 200, 200])
        self.assertEqual(rig.source.runs(), [rig.idents[key] for key in ("a", "b", "c", "k1")])

    def test_a_refused_chat_is_502_mail_with_the_fixed_cause_and_the_line_works_again_after(self):
        import contextlib
        import io

        rig = Rig(self)
        release = self.hold(rig)
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            for key in ("a", "b", "c", "d"):
                rig.start(key)
                pause(STEP)
            refused = rig.env.send("bot-b", "Words e", client_id="client-e", token="session-e")
            self.assertEqual(answer(refused), (502, {"error": "mail"}))
            release()
            rig.join()
            again = rig.env.send("bot-b", "Words f", client_id="client-f", token="session-f")
        self.assertEqual(again.status, 200)
        self.assertIn("error=mail cause=SendBusy", output.getvalue())


if __name__ == "__main__":
    unittest.main()
