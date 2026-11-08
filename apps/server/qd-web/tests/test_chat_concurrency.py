import copy
import threading
import unittest
from types import SimpleNamespace

import mail_gateway
import qd_jmap
from test_chat_server import ACCOUNT, BASE_TIME, STEWARD, Env, answer


class ConcurrentSentMail:
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
            return {"list": [{"id": "identity", "email": f"{ACCOUNT}@qd.invalid"}]}
        if name == "Mailbox/get":
            return {"list": [{"id": role, "role": role} for role in ("inbox", "drafts", "sent")]}
        if name == "Email/query":
            selected = arguments["filter"]
            conditions = selected.get("conditions", [selected])
            rows = list(self.messages.values())
            for condition in conditions:
                if "inMailbox" in condition:
                    rows = [row for row in rows if row["mailboxIds"].get(condition["inMailbox"])]
                if "header" in condition:
                    rows = [row for row in rows if condition["header"][1] in row["messageId"]]
            return {"ids": [row["id"] for row in rows[:arguments.get("limit", 256)]]}
        if name == "Email/get":
            properties = arguments.get("properties", [])
            return {"list": [
                {key: copy.deepcopy(value) for key, value in self.messages[identifier].items()
                 if key in properties or key == "bodyValues" and arguments.get("fetchTextBodyValues")}
                for identifier in arguments["ids"] if identifier in self.messages
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


class ChatConcurrencyTests(unittest.TestCase):
    def concurrent_posts(self, client_ids, separate_adapters=False):
        stand_in = ConcurrentSentMail()
        env = Env(self)
        credential = SimpleNamespace(clear=lambda: None)

        def adapter():
            return mail_gateway.CaptainMailbox(
                qd_jmap.Mailbox(stand_in), credential,
                account_name=ACCOUNT, oversight_bot=STEWARD,
            )

        env.service.mail = adapter()
        environments = [env, env]
        if separate_adapters:
            other = Env(self)
            other.service.mail = adapter()
            environments[1] = other
        for environment in environments:
            environment.chat.clock = lambda: BASE_TIME + (9 if not separate_adapters and threading.current_thread().name == "send-1" else 0)
        start = threading.Barrier(3)
        results = [None, None]
        failures = []

        def send(index):
            try:
                start.wait(timeout=5)
                results[index] = answer(environments[index].post({
                    "bot": "bot-b", "text": "Same words", "clientId": client_ids[index], "csrf": "csrf-now",
                }))
            except BaseException as error:
                failures.append(error)

        workers = [threading.Thread(target=send, args=(index,), name=f"send-{index}", daemon=True) for index in range(2)]
        for worker in workers:
            worker.start()
        try:
            start.wait(timeout=5)
            for worker in workers:
                worker.join(timeout=10)
            self.assertFalse(any(worker.is_alive() for worker in workers), "Concurrent chat posts did not finish")
            self.assertEqual(failures, [])
            self.assertEqual([result[0] for result in results], [200, 200])
            return stand_in, [result[1] for result in results]
        finally:
            stand_in.absent_lookups.abort()
            start.abort()
            for worker in workers:
                worker.join(timeout=5)

    def test_two_posts_for_one_bot_and_client_id_create_and_submit_one_mail(self):
        mail, answers = self.concurrent_posts(("same-client", "same-client"))
        self.assertEqual((mail.creates, mail.submissions), (1, 1), f"Absent Sent lookups overlapped: {mail.overlapped}")
        self.assertEqual(answers[0]["id"], answers[1]["id"])
        self.assertEqual(answers[0]["at"], answers[1]["at"])

    def test_two_different_client_ids_each_create_and_submit_their_mail(self):
        mail, answers = self.concurrent_posts(("first-client", "second-client"))
        self.assertEqual((mail.creates, mail.submissions), (2, 2))
        self.assertNotEqual(answers[0]["id"], answers[1]["id"])
        self.assertEqual({answer["clientId"] for answer in answers}, {"first-client", "second-client"})

    def test_two_mail_adapters_in_one_process_still_submit_one_same_key_mail(self):
        mail, answers = self.concurrent_posts(("same-client", "same-client"), separate_adapters=True)
        self.assertEqual((mail.creates, mail.submissions), (1, 1), f"Absent Sent lookups overlapped: {mail.overlapped}")
        self.assertEqual(answers[0]["id"], answers[1]["id"])
        self.assertEqual(answers[0]["at"], answers[1]["at"])
