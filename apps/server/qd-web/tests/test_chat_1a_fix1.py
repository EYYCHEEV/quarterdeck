import contextlib
import io
import json
import sys
import threading
import time
import tokenize
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import mail_gateway
import mailstate
from test_chat_1a import FakeMailServer, adapter, patience_of
from test_chat_server import Env, answer
from test_qd_web_budget import Clock

LOOK = 5.0


def quiet():
    return contextlib.redirect_stderr(io.StringIO())


def pause(seconds):
    threading.Event().wait(seconds)


class CopyCapTests(unittest.TestCase):
    def read(self, env, query):
        status, body = answer(env.get(f"/captain/api/chat?{query}"))
        self.assertEqual(status, 200, body)
        return body

    def whole_thread(self, env, bot="bot-b"):
        collected = []
        query = f"bot={bot}"
        for _ in range(20):
            body = self.read(env, query)
            collected = [message["id"] for message in body["messages"]] + collected
            if not body["older"]:
                return collected
            query = f"bot={bot}&before={body['messages'][0]['id']}"
        self.fail("the thread never ended")

    def send_many(self, env, start, stop, bot="bot-b"):
        ids = []
        for number in range(start, stop):
            status, sent = answer(env.send(bot, f"Word {number}", client_id=f"client-{number}", token=f"session-{number}"))
            self.assertEqual(status, 200, sent)
            ids.append(sent["id"])
        return ids

    def test_sixty_five_sends_with_no_refresh_keep_only_the_newest_sixty_four_pending_rows(self):
        env = Env(self)
        older = env.mail.bot_says("bot-b", "an older bot message", 5)
        elsewhere = env.mail.bot_says("bot-c", "a message in another chat", 6)
        env.refresh()
        with quiet():
            sent = self.send_many(env, 0, 65)
            shown = self.whole_thread(env)
            other = self.whole_thread(env, "bot-c")
        self.assertEqual(shown, [older, *sent[1:]])
        self.assertNotIn(sent[0], shown)
        self.assertEqual(len(shown), 65)
        self.assertEqual(other, [elsewhere])

    def test_the_next_real_refresh_lists_every_row_once_and_leaves_no_duplicate(self):
        env = Env(self)
        older = env.mail.bot_says("bot-b", "an older bot message", 5)
        env.refresh()
        with quiet():
            sent = self.send_many(env, 0, 70)
            self.assertEqual(len(self.whole_thread(env)), 65)
            env.refresh()
            env.refresh()
            shown = self.whole_thread(env)
        self.assertEqual(shown, [older, *sent])
        self.assertEqual(len(set(shown)), 71)

    def test_the_cap_counts_only_pending_rows_so_listed_mail_stays_whole(self):
        env = Env(self)
        env.refresh()
        with quiet():
            first = self.send_many(env, 0, 40)
            env.refresh()
            more = self.send_many(env, 40, 110)
            before = self.whole_thread(env)
            env.refresh()
            after = self.whole_thread(env)
        self.assertEqual(before, [*first, *more[-64:]])
        self.assertEqual(after, [*first, *more])


class TrackedMail(FakeMailServer):
    def __init__(self):
        super().__init__()
        self.guard = threading.Lock()
        self.order = []
        self.first = {}
        self.hook = None
        self.clock = None
        self.tick = 0.0

    def __call__(self, method, url, headers, body=None):
        if method == "GET":
            return super().__call__(method, url, headers, body)
        names = [name for name, arguments, call_id in json.loads(body)["methodCalls"]]
        ident = threading.get_ident()
        with self.guard:
            self.order.append(ident)
            if self.clock is not None:
                self.first.setdefault(ident, self.clock.now)
        hook = self.hook
        if hook is not None:
            hook(names)
        if self.clock is not None:
            self.clock.now += self.tick
        pause(0.003)
        return super().__call__(method, url, headers, body)

    def runs(self):
        found = []
        for ident in self.order:
            if not found or found[-1] != ident:
                found.append(ident)
        return found

    def one_at_a_time(self):
        runs = self.runs()
        return len(runs) == len(set(runs))


def own_line(case):
    if hasattr(mail_gateway, "SendLine"):
        name, fresh = "_SEND_LINE", mail_gateway.SendLine(mail_gateway.SEND_WAITING)
    else:
        name, fresh = "_SEND_LOCK", threading.Lock()
    patcher = mock.patch.object(mail_gateway, name, fresh)
    patcher.start()
    case.addCleanup(patcher.stop)


class Rig:
    def __init__(self, case, first_pause=LOOK):
        own_line(case)
        self.clock = Clock()
        self.source = TrackedMail()
        self.budget = mailstate.Budget(self.clock, first_pause=first_pause)
        self.env = Env(case)
        self.env.service.mail = adapter(self.source, self.budget, **patience_of(self.budget))
        self.source.order = []
        self.clock.now += 61.0
        self.results = {}
        self.naps = []
        self.threads = []
        self.arrived = {}
        self.idents = {}
        case.addCleanup(self.join)

    def join(self):
        for thread in self.threads:
            thread.join(timeout=15)

    def start(self, key):
        def work():
            self.idents[key] = threading.get_ident()
            self.arrived[key] = self.clock.now
            self.results[key] = self.env.send("bot-b", f"Words {key}", client_id=f"client-{key}", token=f"session-{key}")

        thread = threading.Thread(target=work, daemon=True)
        self.threads.append(thread)
        thread.start()
        return thread

    def statuses(self):
        return {key: response.status for key, response in self.results.items()}

    def pause_now(self):
        self.budget.admit()
        self.budget.settle(False)


class OneDeadlineTests(unittest.TestCase):
    def held(self, rig):
        release = threading.Event()
        napping = threading.Event()
        self.addCleanup(release.set)

        def nap(seconds):
            rig.naps.append(seconds)
            napping.set()
            release.wait(10)
            rig.clock.now += seconds

        return release, napping, nap

    def test_one_send_held_in_a_pause_with_six_behind_it_lets_four_wait_and_refuses_two(self):
        rig = Rig(self)
        rig.pause_now()
        release, napping, nap = self.held(rig)
        output = io.StringIO()
        with mock.patch("time.sleep", nap), contextlib.redirect_stderr(output):
            rig.start("a")
            self.assertTrue(napping.wait(5))
            for key in "bcdefg":
                rig.start(key)
            for _ in range(300):
                if len(rig.results) >= 2:
                    break
                pause(0.01)
            refused = dict(rig.results)
            self.assertEqual(len(refused), 2, "the sends past the fourth waiting one are refused at once")
            self.assertEqual([answer(response) for response in refused.values()], [(502, {"error": "mail"})] * 2)
            self.assertEqual(rig.source.order, [], "nothing reaches mail while the first send is in its pause")
            release.set()
            rig.join()
        self.assertEqual(sorted(rig.statuses().values()), [200] * 5 + [502] * 2)
        self.assertEqual(len(rig.source.sent_ids()), 5)
        self.assertTrue(rig.source.one_at_a_time(), rig.source.runs())
        self.assertEqual(rig.naps, [LOOK])
        replies = [line for line in output.getvalue().splitlines() if line.startswith("QD_CHAT_REPLY") and "status=502" in line]
        self.assertEqual(len(replies), 2)
        for line in replies:
            self.assertIn("error=mail cause=SendBusy", line)

    def test_no_send_spends_more_than_eight_seconds_in_admission_and_pause_together(self):
        rig = Rig(self)
        rig.source.clock = rig.clock
        rig.source.tick = 0.5
        rig.pause_now()
        release, napping, nap = self.held(rig)
        with mock.patch("time.sleep", nap), quiet():
            rig.start("a")
            self.assertTrue(napping.wait(5))
            for key in "bcdef":
                rig.start(key)
            pause(0.3)
            release.set()
            rig.join()
        self.assertEqual(len(rig.results), 6)
        reached = 0
        for key, response in rig.results.items():
            ident = rig.idents[key]
            if ident in rig.source.first:
                reached += 1
                self.assertLessEqual(rig.source.first[ident] - rig.arrived[key], 8.0, key)
            else:
                self.assertEqual(response.status, 502, key)
        self.assertGreaterEqual(reached, 1)
        self.assertTrue(rig.source.one_at_a_time(), rig.source.runs())

    def behind_a_slow_send(self, rig, seconds, then):
        reached = threading.Event()
        go = threading.Event()
        self.addCleanup(go.set)
        spent = []

        def hook(names):
            if "EmailSubmission/set" in names and not spent:
                spent.append(True)
                reached.set()
                go.wait(10)
                rig.clock.now += seconds
                then()

        rig.source.hook = hook

        def nap(slept):
            rig.naps.append(slept)
            rig.clock.now += slept

        with mock.patch("time.sleep", nap), quiet():
            rig.start("a")
            self.assertTrue(reached.wait(5))
            rig.start("b")
            pause(0.3)
            go.set()
            rig.join()

    def test_a_send_behind_a_slow_one_cannot_wait_out_a_pause_longer_than_what_is_left_of_its_eight_seconds(self):
        rig = Rig(self, first_pause=5.0)
        self.behind_a_slow_send(rig, 6.0, lambda: rig.budget.settle(False))
        self.assertEqual(rig.statuses(), {"a": 200, "b": 502})
        self.assertEqual(answer(rig.results["b"]), (502, {"error": "mail"}))
        self.assertEqual(rig.naps, [])
        self.assertEqual(len(rig.source.sent_ids()), 1)

    def test_a_send_behind_a_slow_one_still_waits_a_pause_that_fits_in_what_is_left(self):
        rig = Rig(self, first_pause=1.5)
        self.behind_a_slow_send(rig, 6.0, lambda: rig.budget.settle(False))
        self.assertEqual(rig.statuses(), {"a": 200, "b": 200})
        self.assertAlmostEqual(sum(rig.naps), 1.5, places=3)
        self.assertEqual(len(rig.source.sent_ids()), 2)

    def test_a_send_that_has_waited_for_the_lock_longer_than_eight_seconds_is_refused_with_no_pause_at_all(self):
        rig = Rig(self)
        self.behind_a_slow_send(rig, 9.0, lambda: None)
        self.assertEqual(rig.statuses(), {"a": 200, "b": 502})
        self.assertEqual(rig.naps, [])
        self.assertEqual(len(rig.source.sent_ids()), 1)

    def test_one_deadline_covers_every_request_of_a_send_not_eight_seconds_for_each(self):
        rig = Rig(self)
        rig.pause_now()
        seen = []

        def hook(names):
            seen.append(names)
            if len(seen) == 2:
                rig.budget.settle(False)

        rig.source.hook = hook

        def nap(seconds):
            rig.naps.append(seconds)
            rig.clock.now += seconds

        with mock.patch("time.sleep", nap), quiet():
            response = rig.env.send("bot-b", "Words", client_id="client-one", token="session-one")
        self.assertEqual(answer(response), (502, {"error": "mail"}))
        self.assertLessEqual(sum(rig.naps), 8.0)
        self.assertEqual(rig.source.sent_ids(), [])

    def test_two_ordinary_sends_at_once_give_their_usual_answers_one_after_the_other(self):
        rig = Rig(self)
        with quiet():
            rig.start("a")
            rig.start("b")
            rig.join()
        self.assertEqual(rig.statuses(), {"a": 200, "b": 200})
        self.assertEqual(len(rig.source.sent_ids()), 2)
        self.assertTrue(rig.source.one_at_a_time(), rig.source.runs())
        ids = {answer(response)[1]["id"] for response in rig.results.values()}
        self.assertEqual(len(ids), 2)

    def test_a_send_waiting_for_the_line_is_refused_when_its_own_time_runs_out(self):
        own_line(self)
        source = TrackedMail()
        budget = mailstate.Budget(time.monotonic)
        env = Env(self)
        env.service.mail = adapter(source, budget, **patience_of(budget))
        held = threading.Event()
        go = threading.Event()
        self.addCleanup(go.set)
        spent = []
        results = {}
        threads = []

        def hook(names):
            if not spent:
                spent.append(True)
                held.set()
                go.wait(10)

        source.hook = hook

        def start(key):
            def work():
                results[key] = env.send("bot-b", f"Words {key}", client_id=f"client-{key}", token=f"session-{key}")

            thread = threading.Thread(target=work, daemon=True)
            threads.append(thread)
            thread.start()

        with mock.patch.object(mail_gateway, "SEND_WAIT_SECONDS", 0.4), quiet():
            start("a")
            self.assertTrue(held.wait(5))
            began = time.monotonic()
            start("b")
            for _ in range(200):
                if "b" in results:
                    break
                pause(0.01)
            waited = time.monotonic() - began
            self.assertIn("b", results)
            self.assertEqual(answer(results["b"]), (502, {"error": "mail"}))
            self.assertLess(waited, 3.0)
            self.assertNotIn("a", results)
            go.set()
            for thread in threads:
                thread.join(timeout=15)
        self.assertEqual(results["a"].status, 200)
        self.assertEqual(len(source.sent_ids()), 1)

    def test_the_waiting_count_comes_back_down_so_later_sends_are_still_served(self):
        rig = Rig(self)
        with quiet():
            for number in range(8):
                rig.start(f"first-{number}")
                rig.start(f"second-{number}")
                rig.join()
                rig.clock.now += 30.0
        self.assertEqual(set(rig.statuses().values()), {200})
        self.assertEqual(len(rig.results), 16)
        self.assertEqual(len(rig.source.sent_ids()), 16)

    def test_a_send_that_fails_gives_the_line_back(self):
        rig = Rig(self, first_pause=0.0)
        failing = []

        def hook(names):
            if not failing:
                failing.append(True)
                raise OSError("down")

        rig.source.hook = hook
        with mock.patch.object(mail_gateway, "SEND_WAIT_SECONDS", 0.5), quiet():
            first = rig.env.send("bot-b", "One", client_id="client-one", token="session-one")
            second = rig.env.send("bot-b", "Two", client_id="client-two", token="session-two")
        self.assertEqual(answer(first), (502, {"error": "mail"}))
        self.assertEqual(second.status, 200)
        self.assertEqual(len(rig.source.sent_ids()), 1)


class NoCommentTests(unittest.TestCase):
    def test_this_file_has_no_comments(self):
        source = Path(__file__).read_text(encoding="utf-8")
        comments = [
            token
            for token in tokenize.generate_tokens(io.StringIO(source).readline)
            if token.type == tokenize.COMMENT and token.start[0] > 1
        ]
        self.assertEqual(comments, [])
