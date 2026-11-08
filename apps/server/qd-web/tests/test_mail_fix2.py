import itertools
import tempfile
from pathlib import Path

from test_mail_api import FakeClock, MailCase
import mail_standins as standins


class AmbiguousHintTests(MailCase):
    def listing(self, api):
        response, _ = self.fetch(api, '/captain/mail')
        self.assertEqual(response.status, 200)
        return self.body_of(response)['threads']

    def reply_threads(self, api, marker='real reply'):
        subjects = []
        for summary in self.listing(api):
            response, _ = self.fetch(api, '/captain/mail/' + summary['ref'])
            for message in self.body_of(response)['thread']['mails']:
                if message['text'] == marker:
                    subjects.append(summary['subject'])
        return subjects

    def test_reviewer_pre_seed_reply_joins_the_real_mail_not_the_hostile_seed(self):
        shared = ['shared-message@qd.invalid']
        hostile = standins.message(1, subject='Hostile seed', messageId=shared, text='hostile seed')
        real = standins.message(2, subject='Real mail', messageId=shared, text='real mail')
        reply = standins.message(3, subject='Re: Real mail', inReplyTo=shared, text='real reply')
        api, _ = self.build([hostile, real, reply])
        summaries = self.listing(api)
        self.assertEqual({item['subject']: (item['ref'], item['count']) for item in summaries}, {'Hostile seed': ('MT-1', 1), 'Real mail': ('MT-2', 2)})
        response, _ = self.fetch(api, '/captain/mail/MT-2')
        self.assertEqual([(mail['ref'], mail['text']) for mail in self.body_of(response)['thread']['mails']], [('MT-2.1', 'real mail'), ('MT-2.2', 'real reply')])

    def test_exactly_one_stored_match_still_joins_that_thread(self):
        anchor = standins.message(1, subject='Unique anchor')
        reply = standins.message(2, subject='Different subject', inReplyTo=anchor['messageId'], text='real reply')
        api, _ = self.build([anchor, reply])
        self.assertEqual(self.reply_threads(api), ['Unique anchor'])
        self.assertEqual([(item['subject'], item['count']) for item in self.listing(api)], [('Unique anchor', 2)])

    def test_ambiguous_hint_falls_through_in_the_existing_hint_order(self):
        shared = ['shared-message@qd.invalid']
        for header in ('inReplyTo', 'references'):
            with self.subTest(header=header):
                hostile = standins.message(1, subject='Hostile seed', messageId=shared)
                real = standins.message(2, subject='Real mail', messageId=shared)
                first = standins.message(3, subject='First unique')
                second = standins.message(4, subject='Second unique')
                fields = {'inReplyTo': [*shared, *first['messageId']], 'references': second['messageId']}
                wanted = 'First unique'
                if header == 'references':
                    fields = {'references': [*first['messageId'], *second['messageId'], *shared]}
                    wanted = 'Second unique'
                reply = standins.message(5, subject='No subject match', text='real reply', **fields)
                api, _ = self.build([hostile, real, first, second, reply])
                self.assertEqual(self.reply_threads(api), [wanted])

    def test_two_stored_mails_in_one_thread_are_still_an_ambiguous_hint(self):
        shared = ['shared-message@qd.invalid']
        first = standins.message(1, subject='Shared hostile thread', messageId=shared)
        second = standins.message(2, subject='Shared hostile thread', messageId=shared)
        reply = standins.message(3, subject='Independent subject', inReplyTo=shared, text='real reply')
        api, _ = self.build([first, second, reply])
        self.assertEqual(self.reply_threads(api), ['Independent subject'])
        self.assertEqual({item['subject']: item['count'] for item in self.listing(api)}, {'Shared hostile thread': 2, 'Independent subject': 1})

    def test_already_placed_mails_do_not_move_when_the_hint_later_becomes_ambiguous(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        state = Path(temporary.name) / 'threads.sqlite3'
        clock = FakeClock()
        shared = ['shared-message@qd.invalid']
        real = standins.message(1, subject='Real mail', messageId=shared, text='real mail')
        reply = standins.message(2, subject='Other subject', inReplyTo=shared, text='real reply')
        api, server = self.build([real, reply], state=state, clock=clock)
        before, _ = self.fetch(api, '/captain/mail/MT-1')
        placed = [(item['ref'], item['text']) for item in self.body_of(before)['thread']['mails']]
        self.assertEqual(placed, [('MT-1.1', 'real mail'), ('MT-1.2', 'real reply')])
        server.messages.append(standins.message(3, subject='Later duplicate', messageId=shared))
        self.listing(api)
        after, _ = self.fetch(api, '/captain/mail/MT-1')
        self.assertEqual([(item['ref'], item['text']) for item in self.body_of(after)['thread']['mails']], placed)
        restarted, _ = self.build(server.messages, state=state)
        again, _ = self.fetch(restarted, '/captain/mail/MT-1')
        self.assertEqual([(item['ref'], item['text']) for item in self.body_of(again)['thread']['mails']], placed)

    def test_many_arrival_orders_never_use_an_ambiguous_hint(self):
        cases = 0
        shared = 'shared-message@qd.invalid'
        for hostile_count, same_thread in ((1, False), (2, False), (2, True)):
            names = tuple('hostile-' + str(index) for index in range(hostile_count)) + ('real',)
            for order in itertools.permutations(names):
                for header, long_list, next_hint in itertools.product(('inReplyTo', 'references'), (False, True), (False, True)):
                    cases += 1
                    with self.subTest(order=order, header=header, long_list=long_list, next_hint=next_hint, same_thread=same_thread):
                        api, server = self.build([])
                        if next_hint:
                            server.messages.append(standins.message(100, subject='Next unique anchor', messageId=['next-unique@qd.invalid']))
                            self.listing(api)
                        for name in order:
                            if name == 'real':
                                message = standins.message(10, subject='Real topic', messageId=[shared])
                            else:
                                number = int(name.rsplit('-', 1)[1])
                                subject = 'Hostile topic' if same_thread else 'Hostile topic ' + str(number)
                                message = standins.message(number + 1, subject=subject, messageId=[shared])
                            server.messages.append(message)
                            self.listing(api)
                        hints = [f'missing-{index}@qd.invalid' for index in range(256)] if long_list else []
                        hints.append(shared)
                        if next_hint:
                            hints.append('next-unique@qd.invalid')
                        if header == 'references':
                            hints.reverse()
                        server.messages.append(standins.message(1000, subject='Re: Real topic', text='real reply', **{header: hints}))
                        wanted = 'Next unique anchor' if next_hint else 'Real topic'
                        self.assertEqual(self.reply_threads(api), [wanted])
                        self.assertEqual(sum(item['count'] for item in self.listing(api)), hostile_count + 2 + int(next_hint))
        print('ARRIVAL_ORDER_CASES=' + str(cases) + ' seed_orders=14 headers=2 long_hint_variants=2 fallthrough_modes=2')
        self.assertEqual(cases, 112)
