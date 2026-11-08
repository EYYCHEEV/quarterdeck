import unittest
from pathlib import Path

from test_chat_chime import run, talk


ROOT = Path(__file__).resolve().parent


class BubbleLabelTests(unittest.TestCase):
    def rows(self, senders, **options):
        snapshots = run([{"op": "select", "bot": "bot-a", "label": "opened"}], {"bot-a": talk(*senders)}, **options)
        return snapshots[-1]["rows"]

    def test_the_bots_name_sits_on_the_first_message_of_each_bot_run_only(self):
        rows = self.rows(["bot", "bot", "account", "bot", "account", "account", "bot", "bot", "bot"])
        self.assertEqual(
            [row["names"] for row in rows],
            [["bot-a"], [], [], ["bot-a"], [], [], ["bot-a"], [], []],
        )

    def test_his_messages_never_carry_a_name_and_keep_the_existing_classes(self):
        rows = self.rows(["account", "bot", "account"])
        self.assertEqual([row["className"] for row in rows], ["message account", "message bot", "message account"])
        self.assertEqual([row["names"] for row in rows], [[], ["bot-a"], []])

    def test_a_pending_message_is_his_and_has_no_name(self):
        snapshots = run(
            [{"op": "select", "bot": "bot-a"}, {"op": "send", "text": "hello", "label": "sent"}],
            {"bot-a": talk("bot")},
        )
        rows = snapshots[-1]["rows"]
        self.assertEqual([row["className"] for row in rows], ["message bot", "message account"])
        self.assertEqual([row["names"] for row in rows], [["bot-a"], []])

    def test_a_run_cut_by_show_older_still_names_its_first_visible_message(self):
        rows = self.rows(["bot"] * 20)
        self.assertEqual(len(rows), 16)
        self.assertEqual(rows[0]["className"], "older")
        self.assertEqual(rows[1]["names"], ["bot-a"])
        self.assertEqual(sum(1 for row in rows if row["names"]), 1)

    def test_the_two_bubble_kinds_use_the_filled_styles_the_plan_asks_for(self):
        css = (ROOT / "chat.css").read_text(encoding="utf-8")
        account = css[css.index(".message.account {"):].split("}")[0]
        bot = css[css.index(".message.bot {"):].split("}")[0]
        self.assertIn("background: var(--mine-bg)", account)
        self.assertIn("border-bottom-right-radius", account)
        self.assertIn("align-self: end", account)
        self.assertIn("background: var(--bot-bg)", bot)
        self.assertIn("border-bottom-left-radius", bot)
        self.assertIn("align-self: start", bot)
        self.assertIn("max-width: 80%", css)
        self.assertNotIn("max-width: 95%", css)


if __name__ == "__main__":
    unittest.main(verbosity=2)
