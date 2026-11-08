import json
import unittest

import live


class ChangingCards:
    def __init__(self):
        self.calls = 0
        self.value = 1
        self.chat_value = 1

    def refresh(self):
        self.calls += 1
        return {"value": self.value}

    def chat_list(self):
        return [
            {
                "id": "bot-a",
                "preview": f"message-{self.chat_value}",
            }
        ]


class OneFailure:
    def __init__(self):
        self.calls = 0

    def refresh(self):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("transient stand-in failure")
        return {"value": self.calls}

    @staticmethod
    def chat_list():
        return []


class TwoLoops:
    def __init__(self):
        self.checks = 0
        self.waits = []

    def is_set(self):
        self.checks += 1
        return self.checks > 2

    def wait(self, seconds):
        self.waits.append(seconds)


class LiveUpdateTests(unittest.TestCase):
    def test_one_five_second_checker_feeds_every_sse_tab(self):
        cards = ChangingCards()
        updates = live.LiveUpdates(cards)
        self.assertEqual(updates.interval_seconds, 5)

        updates.check_once()
        first_tab = updates.events(after=0)
        second_tab = updates.events(after=0)
        first = next(first_tab)
        second = next(second_tab)
        self.assertEqual(first, second)
        self.assertIn("event: refresh\n", first)
        self.assertEqual(
            json.loads(first.split("data: ", 1)[1]),
            {"cards": True, "chats": True},
        )
        self.assertEqual(cards.calls, 1)

        cards.value = 2
        updates.check_once()
        self.assertEqual(next(first_tab), next(second_tab))
        self.assertEqual(cards.calls, 2)

        updates.check_once()
        self.assertEqual(cards.calls, 3)
        self.assertEqual(updates.version, 2)


    def test_chat_change_emits_one_shared_refresh_invalidation(self):
        cards = ChangingCards()
        updates = live.LiveUpdates(cards)
        updates.check_once()

        cards.chat_value = 2
        updates.check_once()

        self.assertEqual(updates.version, 2)
        event = next(updates.events(after=1))
        self.assertIn("event: refresh\n", event)
        self.assertEqual(
            json.loads(event.split("data: ", 1)[1]),
            {"cards": True, "chats": True},
        )
        self.assertEqual(updates.snapshot(), {"value": 1})

    def test_checker_keeps_the_last_good_state_after_a_transient_failure(self):
        cards = OneFailure()
        updates = live.LiveUpdates(cards)
        stop = TwoLoops()
        updates._stop = stop

        updates._run()

        self.assertEqual(cards.calls, 2)
        self.assertEqual(stop.waits, [5, 5])
        self.assertEqual(updates.version, 1)
        self.assertEqual(
            json.loads(updates._encoded),
            {"cards": {"value": 2}, "chats": []},
        )

if __name__ == "__main__":
    unittest.main(verbosity=2)
