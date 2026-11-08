import contextlib
import hashlib
import sqlite3
import tempfile
from pathlib import Path

import application
import mail_api
import mail_standins as standins
import mailstate
import qd_jmap
from test_mail_api import FakeClock, MailCase


class WindowServer(standins.StandInStalwart):
    def __init__(self, inbox, sent):
        super().__init__()
        self.counts = {standins.INBOX: inbox, standins.SENT: sent}
        self.version = 0

    def state(self):
        return str((self.counts[standins.INBOX], self.counts[standins.SENT], self.version))

    def query(self, args):
        folder = args['filter']['inMailbox']
        count = self.counts[folder]
        position = args.get('position', 0)
        limit = args.get('limit', 256)
        prefix = 'i' if folder == standins.INBOX else 's'
        descending = not args['sort'][0].get('isAscending', True)
        indexes = range(count, 0, -1) if descending else range(1, count + 1)
        return {'ids': [prefix + str(index) for index in indexes[position:position + limit]], 'position': position, 'total': count}

    def get(self, args):
        rows = []
        for jmap_id in args.get('ids', []):
            index = int(jmap_id[1:])
            folder = standins.INBOX if jmap_id[0] == 'i' else standins.SENT
            if 1 <= index <= self.counts[folder]:
                message = standins.message(index, id=jmap_id, mailbox=folder, subject='Window', messageId=[jmap_id + '@qd.invalid'])
                rows.append(self.view(message, args.get('properties', ['id']), args.get('fetchTextBodyValues', False), args.get('maxBodyValueBytes')))
        return {'list': rows, 'notFound': [], 'state': self.state()}


class WindowTests(MailCase):
    def build_window(self, inbox, sent, *, preload=0):
        server = WindowServer(inbox, sent)
        clock = FakeClock()
        server.stamp = clock
        budget = mailstate.Budget(clock)
        captain = self.captain_for(server, mailstate.MeteredTransport(server, budget))
        clock.advance(61)
        for _ in range(preload):
            budget.admit()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        api = mail_api.MailApi(captain, standins.real_gate(), clock=clock, mail_state_path=Path(temporary.name) / 'threads.sqlite3', mail_state=server.state)
        return api, server, clock, budget

    def completed(self, api, clock):
        response = None
        refusals = 0
        for attempt in range(2):
            try:
                response, _ = self.fetch(api, '/captain/mail')
                break
            except qd_jmap.MailFailed:
                refusals += 1
                clock.advance(61)
        self.assertIsNotNone(response, 'the first window did not finish within two budget windows')
        self.assertEqual(response.status, 200)
        return response, refusals

    def test_4201_50000_and_200000_mailboxes_finish_within_two_calls(self):
        for inbox, sent in ((4201, 0), (50000, 50000), (200000, 200000)):
            with self.subTest(inbox=inbox, sent=sent):
                api, server, clock, _ = self.build_window(inbox, sent)
                response, _ = self.completed(api, clock)
                body = self.body_of(response)
                self.assertEqual(body['threads'][0]['count'], min(inbox, 2048) + min(sent, 2048))
                queries = [args for name, args in server.mail_calls() if name == 'Email/query']
                self.assertLessEqual(len(queries), 16)
                for args in queries:
                    self.assertEqual(args['limit'], 256)
                    self.assertFalse(args['sort'][0]['isAscending'])
                    self.assertLess(args['position'], 2048)
                fetched = [item for name, args in server.mail_calls() if name == 'Email/get' for item in args['ids']]
                self.assertEqual(len(fetched), min(inbox, 2048) + min(sent, 2048))
                self.assertNotIn('Warning', dict(response.headers))
                self.assertFalse(body['truncated'])

    def test_id_pages_and_details_survive_a_mid_sync_budget_refusal(self):
        for preload in (55, 20):
            with self.subTest(preload=preload):
                api, server, clock, _ = self.build_window(200000, 200000, preload=preload)
                self.raised(api, '/captain/mail', qd_jmap.MailFailed)
                self.assertEqual(api.service.table.subjects(), {})
                before = list(server.mail_calls())
                self.assertTrue(before)
                clock.advance(61)
                response, _ = self.fetch(api, '/captain/mail')
                self.assertEqual(self.body_of(response)['threads'][0]['count'], 4096)
                queries = [(args['filter']['inMailbox'], args.get('position', 0)) for name, args in server.mail_calls() if name == 'Email/query']
                self.assertEqual(len(queries), 16)
                self.assertEqual(len(set(queries)), len(queries))
                fetched = [item for name, args in server.mail_calls() if name == 'Email/get' for item in args['ids']]
                self.assertEqual(len(fetched), 4096)
                self.assertEqual(len(set(fetched)), 4096)
                if preload == 20:
                    self.assertTrue(any(name == 'Email/get' for name, _ in before))
                self.assertEqual(self.body_of(response)['threads'][0]['ref'], 'MT-1')
                clock.advance(61)
                thread, _ = self.fetch(api, '/captain/mail/MT-1')
                self.assertEqual([item['ref'] for item in self.body_of(thread)['thread']['mails']], ['MT-1.' + str(index) for index in range(4047, 4097)])

    def test_steady_quick_read_is_one_request_and_window_sweep_at_most_sixteen(self):
        api, server, clock, _ = self.build_window(200000, 200000)
        self.completed(api, clock)
        clock.advance(61)
        server.version += 1
        before = len(server.http)
        self.fetch(api, '/captain/mail')
        self.assertEqual(len(server.http) - before, 1)
        clock.advance(600)
        before = len(server.http)
        self.fetch(api, '/captain/mail')
        self.assertEqual(len(server.http) - before, 16)

    def test_window_clipping_keeps_the_existing_body_and_headers(self):
        for count in (2047, 2048, 2049):
            with self.subTest(count=count):
                api, _, clock, _ = self.build_window(count, 0)
                response, _ = self.completed(api, clock)
                body = self.body_of(response)
                self.assertEqual(set(body), {'threads', 'truncated', 'csrf', 'freshUntil'})
                self.assertFalse(body['truncated'])
                self.assertNotIn('Warning', dict(response.headers))
                cached, _ = self.fetch(api, '/captain/mail', headers={'If-None-Match': dict(response.headers)['ETag']})
                self.assertEqual(cached.status, 304)
                self.assertNotIn('Warning', dict(cached.headers))


    def test_new_arrivals_push_old_mails_out_of_each_folder_window(self):
        api, server, clock, _ = self.build_window(200000, 200000)
        original = server.get

        def with_border(args):
            answer = original(args)
            for item in answer['list']:
                if item['id'] in ('i197953', 's197953') and 'subject' in item:
                    item['subject'] = 'Window border'
            return answer

        server.get = with_border
        first, _ = self.completed(api, clock)
        border = next(item['ref'] for item in self.body_of(first)['threads'] if item['subject'] == 'Window border')
        clock.advance(61)
        server.counts[standins.INBOX] += 1
        server.counts[standins.SENT] += 1
        before = len(server.http)
        response, _ = self.fetch(api, '/captain/mail')
        threads = self.body_of(response)['threads']
        self.assertEqual(sum(item['count'] for item in threads), 4096)
        self.assertEqual(len(server.http) - before, 2)
        self.assertNotIn(border, [item['ref'] for item in threads])
        self.raised(api, '/captain/mail/' + border, application.NotFound)


class IdentityTests(MailCase):
    def test_two_jmap_mails_with_one_message_id_keep_both_bodies_and_arrivals(self):
        first = standins.message(1, subject='Plan', text='original body')
        second = standins.message(2, subject='Plan', messageId=first['messageId'], text='replacement body', **{'from': {'email': 'hostile-bot@qd.invalid'}})
        api, _ = self.build([first, second])
        response, _ = self.fetch(api, '/captain/mail/MT-1')
        thread = self.body_of(response)['thread']
        self.assertEqual(thread['count'], 2)
        self.assertEqual([(item['ref'], item['text']) for item in thread['mails']], [('MT-1.1', 'original body'), ('MT-1.2', 'replacement body')])
        self.assertEqual([item['from'] for item in thread['mails']], ['bot-a', 'hostile-bot'])

    def test_an_own_message_id_match_never_joins_other_subjects(self):
        first = standins.message(1, subject='Alpha')
        second = standins.message(2, subject='Beta', messageId=first['messageId'])
        api, _ = self.build([first, second])
        response, _ = self.fetch(api, '/captain/mail')
        self.assertEqual({item['subject']: (item['ref'], item['count']) for item in self.body_of(response)['threads']}, {'Alpha': ('MT-1', 1), 'Beta': ('MT-2', 1)})

    def test_a_reply_skips_an_ambiguous_message_id_after_restart(self):
        for header in ('inReplyTo', 'references'):
            with self.subTest(header=header):
                temporary = tempfile.TemporaryDirectory()
                self.addCleanup(temporary.cleanup)
                state = Path(temporary.name) / 'threads.sqlite3'
                first = standins.message(1, id='z-original', subject='Alpha')
                second = standins.message(2, id='a-later', subject='Beta', messageId=first['messageId'])
                api, _ = self.build([first, second], state=state)
                self.fetch(api, '/captain/mail')
                reply = standins.message(3, subject='Unrelated', **{header: first['messageId']})
                again, _ = self.build([second, reply], state=state)
                response, _ = self.fetch(again, '/captain/mail')
                self.assertEqual({item['subject']: (item['ref'], item['count']) for item in self.body_of(response)['threads']}, {'Unrelated': ('MT-3', 1), 'Beta': ('MT-2', 1)})
                self.raised(again, '/captain/mail/MT-1', application.NotFound)
                thread, _ = self.fetch(again, '/captain/mail/MT-3')
                self.assertEqual([item['ref'] for item in self.body_of(thread)['thread']['mails']], ['MT-3.1'])

    def test_old_layout_is_refused_without_migrating_or_changing_the_state(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        state = Path(temporary.name) / 'threads.sqlite3'
        with contextlib.closing(sqlite3.connect(state)) as db:
            db.executescript('CREATE TABLE threads(n INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL UNIQUE,subject TEXT NOT NULL); CREATE TABLE mails(message_key TEXT PRIMARY KEY,n INTEGER NOT NULL,k INTEGER NOT NULL,UNIQUE(n,k));')
        before = hashlib.sha256(state.read_bytes()).hexdigest()
        with self.assertRaisesRegex(RuntimeError, 'layout.*fresh|fresh.*layout'):
            self.build([standins.message(1)], state=state)
        self.assertEqual(hashlib.sha256(state.read_bytes()).hexdigest(), before)
