import itertools
import json
import unittest
from unittest import mock

import qd_jmap
from fake_stalwart import FakeStalwart

OWN = "bot-a"
OTHER = "bot-b"
CAPTAIN = "captain"
SESSION = "http://127.0.0.1:18080/jmap/session"
SUBJECT = f"CHAT: {OWN}"


def chat(text, bot=OWN, **extra):
    return json.dumps({"qd": "chat/1", "bot": bot, "text": text, **extra})


class OwedTest(unittest.TestCase):
    def setUp(self):
        self.server = FakeStalwart([OWN, OTHER, CAPTAIN])
        self.keys = itertools.count(1)

    def mailbox(self, bot):
        credential = qd_jmap.Credential(bytearray(self.server.key_of(bot).encode()))
        return qd_jmap.Mailbox(qd_jmap.Jmap(SESSION, credential, self.server))

    def send(self, sender, recipient, subject, body):
        return self.mailbox(sender).send(recipient, subject, body, f"k{next(self.keys)}")

    def his(self, text="question", **extra):
        return self.send(CAPTAIN, OWN, SUBJECT, chat(text, **extra))

    def reply(self, text="answer"):
        return self.send(OWN, CAPTAIN, SUBJECT, chat(text))

    def owed_ids(self):
        return [entry["id"] for entry in self.mailbox(OWN).owed()]

    def restamp(self, mail_id, stamp):
        for email in self.server.mail[OWN].values():
            if email["messageId"] == [mail_id]:
                email["receivedAt"] = stamp

    def calls_since(self, count):
        calls = []
        for method, _, _, body in self.server.requests[count:]:
            if method == "POST":
                calls.extend((name, args) for name, args, _ in json.loads(body)["methodCalls"])
        return calls

    def add_unrelated_mail(self, count):
        mail = self.server.mail[OWN]
        for box, sender, recipient in (("inbox", OTHER, OWN), ("sent", OWN, OTHER)):
            for _ in range(count):
                number = next(self.server.numbers)
                mail[f"e{number}"] = {
                    "n": number, "receivedAt": self.server.tick(), "mailboxIds": {f"{box}-{OWN}": True},
                    "messageId": [f"bulk-{number}@example.test"], "subject": "Status",
                    "from": [{"email": f"{sender}@example.test"}], "to": [{"email": f"{recipient}@example.test"}],
                }

    def owed_read_work(self, expected):
        box = self.mailbox(OWN)
        before = len(self.server.requests)
        self.assertEqual([entry["id"] for entry in box.owed()], [expected])
        return sum(1 + len(args.get("ids", ())) for name, args in self.calls_since(before)
                   if name in ("Email/query", "Email/get"))

    def test_unrelated_mail_does_not_increase_owed_reads(self):
        first = self.his()
        self.add_unrelated_mail(1024)
        no_reply = self.owed_read_work(first)
        self.add_unrelated_mail(1024)
        no_reply_growth = self.owed_read_work(first) - no_reply

        self.reply()
        latest = self.his()
        self.add_unrelated_mail(1024)
        old_reply = self.owed_read_work(latest)
        self.add_unrelated_mail(1024)
        old_reply_growth = self.owed_read_work(latest) - old_reply
        self.assertLessEqual(max(no_reply_growth, old_reply_growth), 16)

    def test_an_unindexed_reply_counts_even_with_an_older_indexed_reply(self):
        self.reply("older")
        self.his("new question")
        self.server.index_lag = True
        self.reply("not yet indexed")
        self.server.index_lag = False
        self.send(OWN, OTHER, "Status", "newer unrelated mail")
        self.assertEqual(self.owed_ids(), [])

    def test_an_unindexed_new_chat_is_owed(self):
        self.reply()
        self.server.index_lag = True
        first = self.his()
        self.assertEqual(self.owed_ids(), [first])

    def test_his_chat_is_owed_until_the_bot_chats_back(self):
        first = self.his()
        self.assertEqual(self.owed_ids(), [first])
        self.reply()
        self.assertEqual(self.owed_ids(), [])

    def test_the_time_is_the_one_qd_wait_reports(self):
        self.his()
        box = self.mailbox(OWN)
        self.assertEqual(box.owed()[0]["sent"], box.pending()[0]["sent"])

    def test_a_reply_that_is_a_fraction_of_a_second_later_answers_the_chat(self):
        first, answer = self.his(), self.reply()
        self.restamp(first, "2026-11-20T09:00:00Z")
        self.restamp(answer, "2026-11-20T09:00:00.500Z")
        self.assertEqual(self.owed_ids(), [])

    def test_a_chat_that_is_a_fraction_of_a_second_later_than_the_reply_is_owed(self):
        answer, first = self.reply(), self.his()
        self.restamp(answer, "2026-11-20T09:00:00Z")
        self.restamp(first, "2026-11-20T09:00:00.500Z")
        self.assertEqual(self.owed_ids(), [first])

    def test_a_chat_in_the_same_second_as_the_reply_counts_as_answered(self):
        first, answer = self.his(), self.reply()
        self.restamp(first, "2026-11-20T09:00:00Z")
        self.restamp(answer, "2026-11-20T09:00:00Z")
        self.assertEqual(self.owed_ids(), [])

    def test_a_client_id_must_match_the_servers_rule(self):
        good = self.his(clientId="abc_DEF-123")
        self.his(clientId="has space")
        self.his(clientId="x" * 81)
        self.send(CAPTAIN, OWN, SUBJECT, json.dumps({"qd": "chat/1", "bot": OWN, "text": "q", "clientId": 7}))
        self.assertEqual(self.owed_ids(), [good])

    def test_empty_text_is_still_a_chat(self):
        first = self.his("")
        self.assertEqual(self.owed_ids(), [first])

    def test_a_late_second_copy_does_not_unanswer_a_chat(self):
        first = self.his()
        self.reply()
        self.server.deliver_copy(OWN, first)
        self.assertEqual(self.owed_ids(), [])

    def test_the_reply_is_found_behind_newer_mail_to_others(self):
        with mock.patch.object(qd_jmap, "PAGE", 2):
            self.his()
            self.reply()
            for number in range(3):
                self.send(OWN, OTHER, f"STATUS: {number}", "plain")
            self.assertEqual(self.owed_ids(), [])

    def test_it_stops_reading_the_inbox_at_the_newest_reply(self):
        with mock.patch.object(qd_jmap, "PAGE", 2):
            for number in range(5):
                self.his(f"old {number}")
            self.reply()
            newest = self.his("new")
            box = self.mailbox(OWN)
            before = len(self.server.requests)
            self.assertEqual([entry["id"] for entry in box.owed()], [newest])
            inbox_queries = [
                args for name, args in self.calls_since(before)
                if name == "Email/query" and args["filter"] == {"inMailbox": box.inbox_id}
            ]
            self.assertEqual(len(inbox_queries), 1)

    def test_it_reads_every_inbox_page_when_the_bot_never_replied(self):
        with mock.patch.object(qd_jmap, "PAGE", 2):
            first = [self.his(f"chat {number}") for number in range(5)]
            self.assertEqual(self.owed_ids(), first)

    def test_bodies_are_fetched_only_for_his_chats(self):
        self.send(OTHER, OWN, "Status", "plain words")
        box = self.mailbox(OWN)
        before = len(self.server.requests)
        self.assertEqual(box.owed(), [])
        fetched = [args for name, args in self.calls_since(before) if name == "Email/get" and "bodyValues" in args["properties"]]
        self.assertEqual(fetched, [])


if __name__ == "__main__":
    unittest.main()
