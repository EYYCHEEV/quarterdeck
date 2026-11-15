import copy
import json
import threading
import unittest

import mail_gateway
import qd_jmap


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


class SentAfterSubmitMail:
    def __init__(self):
        self.messages = {}
        self.creates = 0
        self.submissions = 0
        self.state_lock = threading.Lock()
        self.absent_lookups = threading.Barrier(2)
        self.overlapped = False

    def call(self, *calls):
        with self.state_lock:
            replies = [self.reply(name, arguments) for name, arguments in calls]
            absent = any(
                name == "Email/query"
                and arguments.get("filter") == {"inMailbox": "sent"}
                and not reply["ids"]
                for (name, arguments), reply in zip(calls, replies)
            )
        if absent:
            try:
                self.absent_lookups.wait(timeout=2)
                self.overlapped = True
            except threading.BrokenBarrierError:
                pass
        return replies

    def reply(self, name, arguments):
        if name == "Identity/get":
            return {"list": [{"id": "identity", "email": "account-user@qd.invalid"}]}
        if name == "Mailbox/get":
            return {"list": [{"id": role, "role": role} for role in ("inbox", "drafts", "sent")]}
        if name == "Email/query":
            selected = arguments["filter"]
            rows = list(self.messages.values())
            for condition in selected.get("conditions", [selected]):
                if "inMailbox" in condition:
                    rows = [row for row in rows if row["mailboxIds"].get(condition["inMailbox"])]
                if "header" in condition:
                    rows = [row for row in rows if condition["header"][1] in row["messageId"]]
            return {"ids": [row["id"] for row in rows[:arguments.get("limit", 256)]]}
        if name == "Email/get":
            properties = arguments.get("properties", [])
            return {"list": [
                {
                    key: copy.deepcopy(value)
                    for key, value in self.messages[identifier].items()
                    if key in properties or key == "bodyValues" and arguments.get("fetchTextBodyValues")
                }
                for identifier in arguments["ids"]
                if identifier in self.messages
            ]}
        if name == "Email/set":
            self.creates += 1
            identifier = f"email-{self.creates}"
            row = copy.deepcopy(arguments["create"]["m"])
            row.update(id=identifier, receivedAt="2026-11-06T07:00:00Z")
            self.messages[identifier] = row
            self.draft = identifier
            return {"created": {"m": {"id": identifier}}}
        if name == "EmailSubmission/set":
            self.submissions += 1
            self.messages[self.draft]["mailboxIds"] = {"sent": True}
            return {"created": {"s": {"id": f"submission-{self.submissions}", "undoStatus": "pending"}}}
        raise AssertionError(f"Unexpected mail operation: {name}")


class SendsTogetherTests(unittest.TestCase):
    def together(self, client_ids):
        mail = SentAfterSubmitMail()
        gateway = mail_gateway.CaptainMailbox(
            qd_jmap.Mailbox(mail),
            FakeCredential(),
            account_name="account-user",
            oversight_bot="bot-a",
        )
        start = threading.Barrier(3)
        results = [None, None]
        failures = []

        def send(index):
            body = json.dumps({
                "qd": "chat/1",
                "bot": "bot-b",
                "text": "Same words",
                "clientId": client_ids[index],
                "fresh": False,
            })
            try:
                start.wait(timeout=5)
                results[index] = gateway.send_chat("bot-b", "CHAT: bot-b", body, f"chat:bot-b:{client_ids[index]}")
            except BaseException as error:
                failures.append(error)

        workers = [threading.Thread(target=send, args=(index,), daemon=True) for index in range(2)]
        for worker in workers:
            worker.start()
        try:
            start.wait(timeout=5)
            for worker in workers:
                worker.join(timeout=10)
            self.assertFalse(any(worker.is_alive() for worker in workers), "the two sends did not finish")
            self.assertEqual(failures, [])
            return mail, results
        finally:
            mail.absent_lookups.abort()
            start.abort()
            for worker in workers:
                worker.join(timeout=5)

    def test_two_sends_with_one_client_id_arriving_together_make_one_mail(self):
        mail, results = self.together(("same-client", "same-client"))
        self.assertEqual(
            (mail.creates, mail.submissions),
            (1, 1),
            f"both sends saw no Sent copy at the same time: {mail.overlapped}",
        )
        wanted = qd_jmap.message_id("account-user", "chat:bot-b:same-client", "qd.invalid")
        self.assertEqual(results, [(wanted, False), (wanted, False)])

    def test_two_different_client_ids_arriving_together_each_make_their_mail(self):
        mail, results = self.together(("first-client", "second-client"))
        self.assertEqual((mail.creates, mail.submissions), (2, 2))
        self.assertEqual(
            [result[0] for result in results],
            [
                qd_jmap.message_id("account-user", "chat:bot-b:first-client", "qd.invalid"),
                qd_jmap.message_id("account-user", "chat:bot-b:second-client", "qd.invalid"),
            ],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
