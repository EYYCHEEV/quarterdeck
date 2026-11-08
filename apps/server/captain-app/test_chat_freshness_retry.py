from __future__ import annotations

import json
import unittest

import mail_gateway
import qd_jmap
from test_mail_gateway import FakeCredential, FakeMailbox, email


class DurableMailbox(FakeMailbox):
    domain = 'qd.invalid'

    def __init__(self):
        super().__init__('account-user', [], [])
        self.kept = None

    def send(self, recipient, subject, body, key):
        message_id = qd_jmap.message_id(self.bot, key, self.domain)
        if self.kept is not None:
            if self.kept['bodyValues']['body']['value'] != body:
                raise qd_jmap.Refused('changed words')
            return message_id
        self.sends.append((recipient, subject, body, key))
        self.kept = email('stored', message_id, self.bot, recipient, subject, body)
        self.jmap.sent.append(self.kept)
        return message_id

    def sent_copy(self, message_id):
        return ['stored'] if self.kept is not None and qd_jmap.first_id(self.kept) == message_id else []


class FreshnessRetryTests(unittest.TestCase):
    def test_retry_never_rewrites_or_upgrades_the_original_send_time_freshness(self):
        for first_fresh in (False, True):
            with self.subTest(first_fresh=first_fresh):
                mailbox = DurableMailbox()
                gateway = mail_gateway.CaptainMailbox(mailbox, FakeCredential(), account_name='account-user', oversight_bot='bot-a')
                original = {'qd': 'chat/1', 'bot': 'bot-a', 'text': 'Go ahead', 'clientId': 'same-id', 'fresh': first_fresh}
                first = gateway.send_chat('bot-a', 'CHAT: bot-a', json.dumps(original), 'chat:bot-a:same-id')
                retry = gateway.send_chat('bot-a', 'CHAT: bot-a', json.dumps({**original, 'fresh': not first_fresh}), 'chat:bot-a:same-id')
                self.assertEqual(retry, first)
                self.assertEqual(first[1], first_fresh)
                self.assertEqual(len(mailbox.sends), 1)
                self.assertEqual(json.loads(mailbox.kept['bodyValues']['body']['value'])['fresh'], first_fresh)
                with self.assertRaises(qd_jmap.Refused):
                    gateway.send_chat('bot-a', 'CHAT: bot-a', json.dumps({**original, 'text': 'Changed words', 'fresh': not first_fresh}), 'chat:bot-a:same-id')
