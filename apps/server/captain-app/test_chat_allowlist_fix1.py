import contextlib
import io

import cards
from test_cards import FakeMail, FixtureChecker, message
from test_chat_bot_list import FolderCase, NOW, document


class Checker(FixtureChecker):
    def __init__(self):
        super().__init__()
        self.oversight_bot = "iris"
        self.active_bots = frozenset({"iris", "project-lead"})


class FreshChatAllowlistTests(FolderCase):
    def setUp(self):
        super().setUp()
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))
        self.mail = FakeMail()
        self.service = cards.CardService(
            self.mail,
            Checker(),
            chat_bots=(("runtime-only", "Display note"),),
            bot_source=self.reader.names,
        )

    def refused_at_every_seam(self, name):
        with self.subTest(seam="dropdown", name=name):
            self.assertNotIn(name, [row["id"] for row in self.service.chat_list()])
        with self.subTest(seam="open", name=name):
            with self.assertRaises(cards.CardRefused):
                self.service.chat(name)
        with self.subTest(seam="send", name=name):
            before = len(self.mail.sent)
            with self.assertRaises(cards.CardRefused):
                self.service.send_chat(name, "Not allowed", "request-refused")
            self.assertEqual(len(self.mail.sent), before)

    def allowed_at_every_seam(self, name):
        with self.subTest(seam="dropdown", name=name):
            self.assertIn(name, [row["id"] for row in self.service.chat_list()])
        with self.subTest(seam="open", name=name):
            self.assertEqual(self.service.chat(name)["bot"]["id"], name)
        with self.subTest(seam="send", name=name):
            self.service.send_chat(name, "Allowed", "request-allowed")
            self.assertEqual(self.mail.sent[-1][0], name)

    def oversight_only(self):
        self.refused_at_every_seam("project-lead")
        self.refused_at_every_seam("runtime-only")
        self.refused_at_every_seam("fresh-bot")
        self.allowed_at_every_seam("iris")
        self.assertEqual([row["id"] for row in self.service.chat_list()], ["iris"])

    def test_registry_lead_absent_from_fresh_file_is_refused(self):
        self.publish(document("fresh-bot"))
        self.refused_at_every_seam("project-lead")

    def test_runtime_name_absent_from_fresh_file_is_refused(self):
        self.publish(document("fresh-bot"))
        self.refused_at_every_seam("runtime-only")

    def test_missing_file_leaves_only_iris(self):
        self.oversight_only()

    def test_invalid_file_leaves_only_iris(self):
        self.publish(b"{")
        self.oversight_only()

    def test_stale_91_seconds_leaves_only_iris(self):
        self.publish(document("fresh-bot", at=NOW - 91))
        self.oversight_only()

    def test_future_61_seconds_leaves_only_iris(self):
        self.publish(document("fresh-bot", at=NOW + 61))
        self.oversight_only()

    def test_age_90_seconds_is_allowed(self):
        self.publish(document("fresh-bot", at=NOW - 90))
        self.allowed_at_every_seam("fresh-bot")
        self.allowed_at_every_seam("iris")

    def test_future_60_seconds_is_allowed(self):
        self.publish(document("fresh-bot", at=NOW + 60))
        self.allowed_at_every_seam("fresh-bot")
        self.allowed_at_every_seam("iris")

    def test_captain_in_valid_file_is_refused(self):
        self.publish(document("account-user", "fresh-bot"))
        self.refused_at_every_seam("account-user")
        self.allowed_at_every_seam("iris")

    def test_iris_needs_no_file_entry(self):
        self.publish(document())
        self.allowed_at_every_seam("iris")

    def test_history_never_grants_a_name(self):
        self.publish(document("fresh-bot"))
        self.mail.inbox = [
            message("m1", "project-lead", "CHAT: project-lead", {
                "qd": "chat/1", "bot": "project-lead", "text": "Old chat",
            }),
        ]
        self.service.refresh()
        self.refused_at_every_seam("project-lead")

    def test_notes_only_describe_an_already_allowed_name(self):
        self.publish(document("runtime-only"))
        self.allowed_at_every_seam("runtime-only")
        self.assertEqual(self.service.chat("runtime-only")["bot"]["note"], "Display note")
