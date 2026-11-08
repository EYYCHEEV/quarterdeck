import unittest

import mail_gateway


class FakeCredential:
    def __init__(self):
        self.cleared = False

    def clear(self):
        self.cleared = True


class FakeJmap:
    def __init__(self, sent):
        self.sent = sent

    def call(self, call):
        name, arguments = call
        if name == "Email/query":
            return [{"ids": [item["id"] for item in self.sent]}]
        if name == "Email/get":
            ids = set(arguments["ids"])
            return [{"list": [item for item in self.sent if item["id"] in ids]}]
        raise AssertionError(name)


class FakeMailbox:
    sent = "sent"

    def __init__(self, bot, inbox, sent):
        self.bot = bot
        self.jmap = FakeJmap(sent)
        self._inbox = inbox
        self.sends = []

    def inbox(self, pending_only, properties):
        self.inbox_call = (pending_only, properties)
        return list(self._inbox)

    def send(self, recipient, subject, body, key):
        self.sends.append((recipient, subject, body, key))
        return "message-id"


def email(email_id, message_id, sender, recipient, subject, body):
    return {
        "id": email_id,
        "messageId": [message_id],
        "from": [{"email": f"{sender}@qd.invalid"}],
        "to": [{"email": f"{recipient}@qd.invalid"}],
        "subject": subject,
        "receivedAt": "2026-11-02T18:05:00Z",
        "textBody": [{"partId": "body"}],
        "bodyValues": {"body": {"value": body}},
    }


class MailGatewayTests(unittest.TestCase):
    def test_mailbox_reads_inbox_and_one_sent_copy_and_never_accepts_a_from_field(self):
        answer = '{"qd":"answer/1","card":"repo-lead-1","rev":1,"pick":"A","note":"","at":"x"}'
        mailbox = FakeMailbox(
            "account-user",
            [email("i1", "card-1", "bot-b", "account-user", "CARD: Choose", "{}")],
            [
                email("s1", "answer-poster", "account-user", "bot-b", "ANSWER: bot-b-1 A", answer),
                email("s2", "answer-copy", "account-user", "bot-a", "ANSWER: bot-b-1 A", answer),
            ],
        )
        credential = FakeCredential()
        gateway = mail_gateway.CaptainMailbox(
            mailbox,
            credential,
            account_name="account-user",
            oversight_bot="bot-a",
        )

        messages = gateway.messages()

        self.assertEqual(
            [(item.id, item.sender, item.subject) for item in messages],
            [
                ("card-1", "bot-b", "CARD: Choose"),
                ("answer-poster", "account-user", "ANSWER: bot-b-1 A"),
            ],
        )
        self.assertEqual(
            gateway.send("bot-b", "ANSWER: bot-b-1 A", answer, "stable-key"),
            "message-id",
        )
        self.assertEqual(
            mailbox.sends,
            [("bot-b", "ANSWER: bot-b-1 A", answer, "stable-key")],
        )
        with self.assertRaises(TypeError):
            gateway.send("bot-b", "subject", "body", "key", sender="bot-a")
        gateway.close()
        self.assertTrue(credential.cleared)


if __name__ == "__main__":
    unittest.main(verbosity=2)
