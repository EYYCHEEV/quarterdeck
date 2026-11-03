import contextlib
import io
import json
import os
import sys
import time
import unittest
from unittest import mock

import qd_jmap
from fake_stalwart import FakeStalwart

LIVE_SESSION = os.environ.get("QD_JMAP_SESSION")
LIVE = LIVE_SESSION is not None
DOOR = os.environ.get("QD_JMAP_DOOR") == "1"


def read_live_keys():
    keys = {}
    for entry in os.environ.get("QD_JMAP_KEY_FDS", "").split(","):
        bot, _, fd = entry.partition(":")
        if bot:
            with os.fdopen(int(fd), "rb") as pipe:
                keys[bot] = pipe.read(qd_jmap.MAX_KEY_BYTES + 1).strip().decode("ascii")
    return keys


LIVE_KEYS = read_live_keys() if LIVE else {}
RUN = time.strftime("%Y%m%d%H%M%S")


class LiveStalwart:
    def __init__(self):
        self.transport = qd_jmap.HttpTransport()

    def key_of(self, bot):
        return LIVE_KEYS[bot]


def stand_in_only(test):
    return unittest.skipIf(LIVE, "uses stand-in internals")(test)


class QdJmapTest(unittest.TestCase):
    BOT_A, BOT_B, BOT_C = ("qd-test-a", "qd-test-b", "qd-test-c") if LIVE else ("bot-a", "bot-b", "bot-c")
    SESSION = LIVE_SESSION or "http://127.0.0.1:18080/jmap/session"

    def setUp(self):
        if LIVE:
            self.server = LiveStalwart()
            self.transport = self.server.transport
            for bot in (self.BOT_A, self.BOT_B, self.BOT_C):
                for message in self.pending(bot):
                    self.assertEqual(self.run_mail(bot, "ack", message["id"])[0], 0)
        else:
            self.server = FakeStalwart([self.BOT_A, self.BOT_B, self.BOT_C])
            self.transport = self.server

    def k(self, key):
        return f"{RUN}-{self._testMethodName}-{key}" if LIVE else key

    def run_mail(self, bot, *args, body="", key=None, session=None):
        read_end, write_end = os.pipe()
        os.write(write_end, (key if key is not None else self.server.key_of(bot)).encode())
        os.close(write_end)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(sys, "stdin", io.StringIO(body)), mock.patch.object(qd_jmap.time, "sleep"):
            code = qd_jmap.main(["--session", session or self.SESSION, "--key-fd", str(read_end), *args],
                                transport=self.transport)
        return code, out.getvalue(), err.getvalue()

    def try_send(self, sender, recipient, subject, body, key):
        return self.run_mail(sender, "send", "--to", recipient, "--subject", subject, "--key", self.k(key), body=body)

    def send(self, sender, recipient, subject, body, key):
        code, out, err = self.try_send(sender, recipient, subject, body, key)
        self.assertEqual(code, 0, err)
        mail_id = out.strip()
        if LIVE:
            self.wait_delivered(recipient, mail_id)
        return mail_id

    def wait_delivered(self, recipient, mail_id, seconds=15):
        deadline = time.monotonic() + seconds
        while mail_id not in self.ids(recipient):
            self.assertLess(time.monotonic(), deadline, f"{mail_id} never reached {recipient}")
            time.sleep(0.2)

    def pending(self, bot, *args):
        code, out, err = self.run_mail(bot, "wait", "--timeout", "0", *args)
        self.assertIn(code, (0, qd_jmap.NOTHING_NEW), err)
        return [json.loads(line) for line in out.splitlines()]

    def ids(self, bot, *args):
        return [m["id"] for m in self.pending(bot, *args)]

    def test_wait_gives_the_pending_messages_after_the_cursor_oldest_first(self):
        first = self.send(self.BOT_A, self.BOT_B, "STATUS: one", "1", "k1")
        second = self.send(self.BOT_C, self.BOT_B, "STATUS: two", "2", "k2")
        third = self.send(self.BOT_A, self.BOT_B, "STATUS: three", "3\n", "k3")
        found = self.pending(self.BOT_B)
        self.assertEqual([m["id"] for m in found], [first, second, third])
        self.assertEqual([(m["sender"], m["recipient"], m["subject"], m["body"]) for m in found][1:],
                         [(self.BOT_C, self.BOT_B, "STATUS: two", "2"), (self.BOT_A, self.BOT_B, "STATUS: three", "3\n")])
        self.assertEqual(self.ids(self.BOT_B, "--after", first), [second, third])

    def test_each_message_carries_the_time_stalwart_kept_it_in_local_time(self):
        with mock.patch.dict(os.environ, {"TZ": "UTC"}):
            time.tzset()
            self.addCleanup(time.tzset)
            self.send(self.BOT_A, self.BOT_B, "STATUS: when", "1", "k1")
            [message] = self.pending(self.BOT_B)
        self.assertEqual(message["sent"][-6:], "+00:00")

    def test_a_wait_with_nothing_new_ends_at_its_timeout_with_nothing(self):
        newest = self.send(self.BOT_A, self.BOT_B, "STATUS: only", "1", "k1")
        code, out, _ = self.run_mail(self.BOT_B, "wait", "--after", newest, "--timeout", "0")
        self.assertEqual((code, out), (qd_jmap.NOTHING_NEW, ""))

    def test_a_wait_keeps_checking_until_a_message_comes(self):
        calls = []

        class Box:
            def pending(self, after):
                calls.append(after)
                return [{"id": "x"}] if len(calls) == 3 else []

        self.assertEqual(qd_jmap.wait(Box(), "c", None, sleep=lambda s: None), [{"id": "x"}])
        self.assertEqual(calls, ["c", "c", "c"])

    def test_a_long_wait_stays_well_under_stalwarts_per_account_request_limit(self):
        slept = []

        class Box:
            def pending(self, after):
                return []

        now = [0.0]

        def sleep(seconds):
            slept.append(seconds)
            now[0] += seconds

        qd_jmap.wait(Box(), "c", 300, clock=lambda: now[0], sleep=sleep)
        checks_per_minute = 60 / min(slept)
        self.assertLessEqual(checks_per_minute * 2, 30)

    def test_a_cursor_that_is_not_in_the_inbox_is_refused(self):
        code, _, err = self.run_mail(self.BOT_B, "wait", "--after", "qd.nothing.bot-a", "--timeout", "0")
        self.assertEqual(code, qd_jmap.REFUSED, err)

    def test_an_acknowledged_message_is_never_delivered_again_and_twice_changes_nothing(self):
        first = self.send(self.BOT_A, self.BOT_B, "ASK: one", "1", "k1")
        second = self.send(self.BOT_A, self.BOT_B, "ASK: two", "2", "k2")
        self.assertEqual(self.run_mail(self.BOT_B, "ack", first)[0], 0)
        self.assertEqual(self.run_mail(self.BOT_B, "ack", first)[0], 0)
        self.assertEqual(self.ids(self.BOT_B), [second])
        self.assertEqual(self.ids(self.BOT_B, "--after", first), [second])

    def test_a_message_not_yet_acknowledged_is_delivered_again(self):
        sent = self.send(self.BOT_A, self.BOT_B, "ASK: handle me", "please", "k1")
        self.assertEqual(self.ids(self.BOT_B), [sent])
        self.assertEqual(self.ids(self.BOT_B), [sent])

    def test_a_resend_with_the_same_key_and_words_is_stored_once(self):
        first = self.send(self.BOT_A, self.BOT_B, "DONE: task 1", "green", "k1")
        self.assertEqual(self.send(self.BOT_A, self.BOT_B, "DONE: task 1", "green", "k1"), first)
        self.assertEqual(self.ids(self.BOT_B), [first])

    def test_a_resend_with_the_same_key_and_other_words_is_refused_and_the_first_kept(self):
        first = self.send(self.BOT_A, self.BOT_B, "DONE: task 1", "green", "k1")
        for to, subject, body in ((self.BOT_B, "DONE: task 1", "red"), (self.BOT_B, "DONE: task 2", "green"),
                                  (self.BOT_C, "DONE: task 1", "green")):
            with self.subTest(to=to, subject=subject, body=body):
                code, out, _ = self.try_send(self.BOT_A, to, subject, body, "k1")
                self.assertEqual((code, out), (qd_jmap.REFUSED, ""))
        self.assertEqual([(m["id"], m["body"]) for m in self.pending(self.BOT_B)], [(first, "green")])
        self.assertEqual(self.pending(self.BOT_C), [])

    def test_resend_keys_belong_to_their_sender(self):
        from_bot_a = self.send(self.BOT_A, self.BOT_B, "STATUS: bot-a", "1", "status-1")
        from_bot_c = self.send(self.BOT_C, self.BOT_B, "STATUS: bot-c", "2", "status-1")
        self.assertNotEqual(from_bot_a, from_bot_c)
        self.assertEqual(self.ids(self.BOT_B), [from_bot_a, from_bot_c])

    @stand_in_only
    def test_two_copies_of_one_message_show_once_and_one_ack_handles_both(self):
        sent = self.send(self.BOT_A, self.BOT_B, "ASK: raced", "1", "k1")
        self.server.deliver_copy(self.BOT_B, sent)
        self.assertEqual(self.ids(self.BOT_B), [sent])
        self.assertEqual(self.run_mail(self.BOT_B, "ack", sent)[0], 0)
        self.assertEqual(self.pending(self.BOT_B), [])

    def test_a_bot_reads_and_acknowledges_only_its_own_inbox(self):
        for_bot_b = self.send(self.BOT_A, self.BOT_B, "ASK: for bot-b", "1", "k1")
        self.assertEqual(self.pending(self.BOT_C), [])
        code, _, err = self.run_mail(self.BOT_C, "ack", for_bot_b)
        self.assertEqual(code, qd_jmap.REFUSED, err)
        self.assertEqual(self.ids(self.BOT_B), [for_bot_b])

    def test_the_sender_is_the_key_owner_and_cannot_be_named(self):
        sent = self.send(self.BOT_C, self.BOT_B, "STATUS: who", "1", "k1")
        [message] = self.pending(self.BOT_B)
        self.assertEqual((message["id"], message["sender"]), (sent, self.BOT_C))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as no_such_option:
            self.run_mail(self.BOT_C, "send", "--as", self.BOT_A, "--to", self.BOT_B, "--subject", "x", "--key", "k2")
        self.assertEqual(no_such_option.exception.code, 2)

    def test_a_subject_must_be_one_line_and_a_recipient_a_bot_name(self):
        for to, subject in ((self.BOT_B, "ASK: two\nlines"), (self.BOT_B, " "), ("someone@outside.example.test", "ASK: out")):
            with self.subTest(to=to, subject=subject):
                code, out, _ = self.try_send(self.BOT_A, to, subject, "", "k1")
                self.assertEqual((code, out), (qd_jmap.REFUSED, ""))
        self.assertEqual(self.pending(self.BOT_B), [])

    @stand_in_only
    def test_a_resend_is_recognised_before_the_search_index_catches_up(self):
        self.server.index_lag = True
        first = self.send(self.BOT_A, self.BOT_B, "DONE: task 1", "green", "k1")
        self.assertEqual(self.send(self.BOT_A, self.BOT_B, "DONE: task 1", "green", "k1"), first)
        code, out, _ = self.try_send(self.BOT_A, self.BOT_B, "DONE: task 1", "red", "k1")
        self.assertEqual((code, out), (qd_jmap.REFUSED, ""))
        self.assertEqual([(m["id"], m["body"]) for m in self.pending(self.BOT_B)], [(first, "green")])

    @stand_in_only
    def test_ack_and_the_cursor_work_before_the_search_index_catches_up(self):
        self.server.index_lag = True
        first = self.send(self.BOT_A, self.BOT_B, "ASK: one", "1", "k1")
        second = self.send(self.BOT_A, self.BOT_B, "ASK: two", "2", "k2")
        self.assertEqual(self.ids(self.BOT_B, "--after", first), [second])
        self.assertEqual(self.run_mail(self.BOT_B, "ack", first)[0], 0)
        self.assertEqual(self.run_mail(self.BOT_B, "ack", first)[0], 0)
        self.assertEqual(self.ids(self.BOT_B), [second])
        self.assertEqual(self.ids(self.BOT_B, "--after", first), [second])
        self.assertEqual(self.run_mail(self.BOT_B, "ack", "qd.none.x@example.test")[0], qd_jmap.REFUSED)

    @stand_in_only
    def test_pending_mail_past_a_page_of_handled_mail_is_still_found(self):
        with mock.patch.object(qd_jmap, "PAGE", 2):
            sent = [self.send(self.BOT_A, self.BOT_B, f"ASK: {n}", str(n), f"k{n}") for n in range(5)]
            for mail_id in sent[:4]:
                self.assertEqual(self.run_mail(self.BOT_B, "ack", mail_id)[0], 0)
            self.assertEqual(self.ids(self.BOT_B), [sent[4]])
            self.assertEqual(self.ids(self.BOT_B, "--after", sent[1]), [sent[4]])

    def test_a_recipient_stalwart_will_not_deliver_to_fails_loudly_and_nothing_is_delivered(self):
        code, out, err = self.try_send(self.BOT_A, "nobody", "ASK: anyone?", "", "k1")
        if LIVE and not DOOR:
            print(f"OBSERVED unknown-local-recipient: exit {code}, id given {bool(out.strip())} "
                  "(the internal-only rule is a server door setting)")
            return
        self.assertEqual((code, out), (qd_jmap.MAIL_FAILED, ""), err)
        self.assertIn("nothing was delivered", err)
        again, out, err = self.try_send(self.BOT_A, "nobody", "ASK: anyone?", "", "k1")
        self.assertEqual((again, out), (qd_jmap.MAIL_FAILED, ""), "a resend of a refused message must not pass as sent")
        if LIVE:
            time.sleep(2)
        for bot in (self.BOT_A, self.BOT_B, self.BOT_C):
            self.assertEqual(self.pending(bot), [], bot)

    @unittest.skipUnless(LIVE, "needs the real Stalwart")
    def test_live_one_bot_cannot_read_another_bots_account(self):
        bot_a, bot_b = (qd_jmap.Credential(bytearray(self.server.key_of(b).encode())) for b in (self.BOT_A, self.BOT_B))
        try:
            bot_b_account = qd_jmap.Jmap(self.SESSION, bot_b, self.transport).account
            as_bot_a = qd_jmap.Jmap(self.SESSION, bot_a, self.transport)
            self.assertNotEqual(as_bot_a.account, bot_b_account)
            for call in (("Email/query", {"accountId": bot_b_account, "filter": {}}),
                         ("Mailbox/get", {"accountId": bot_b_account, "ids": None})):
                with self.subTest(method=call[0]):
                    self.assertRaises(qd_jmap.MailFailed, as_bot_a.call, call)
        finally:
            bot_a.clear()
            bot_b.clear()

    def test_a_bot_cannot_send_with_another_bots_address(self):
        bot_a = qd_jmap.Credential(bytearray(self.server.key_of(self.BOT_A).encode()))
        try:
            box = qd_jmap.Mailbox(qd_jmap.Jmap(self.SESSION, bot_a, self.transport))
            _, submitted = box.jmap.call(
                ("Email/set", {"create": {"m": {
                    "mailboxIds": {box.drafts: True}, "keywords": {"$draft": True},
                    "from": [{"email": f"{self.BOT_B}@{box.domain}"}], "to": [{"email": f"{self.BOT_C}@{box.domain}"}],
                    "subject": "forged", "messageId": [f"forged.{RUN}@{box.domain}"],
                    "bodyValues": {"b": {"value": "x"}}, "textBody": [{"partId": "b", "type": "text/plain"}]}}}),
                ("EmailSubmission/set", {"create": {"s": {"identityId": box.identity, "emailId": "#m"}}}))
            refused = "s" not in submitted.get("created", {})
            reason = submitted.get("notCreated", {}).get("s", {}).get("type", "")
        except qd_jmap.MailFailed as failure:
            refused, reason = True, str(failure)
        finally:
            bot_a.clear()
        if LIVE and not DOOR:
            print(f"OBSERVED send-as-another-bot: refused {refused} {reason} (sender enforcement is a server door setting)")
            return
        self.assertTrue(refused, "Stalwart accepted mail sent with another bot's address")
        self.assertEqual(self.pending(self.BOT_C), [])

    def test_a_wrong_key_or_an_unreachable_stalwart_fails_loudly(self):
        code, out, err = self.run_mail(self.BOT_A, "wait", "--timeout", "0", key="not-a-key")
        self.assertEqual((code, out), (qd_jmap.MAIL_FAILED, ""))
        self.assertIn("401", err)
        if LIVE:
            code, out, _ = self.run_mail(self.BOT_A, "wait", "--timeout", "0", session="http://127.0.0.1:1/jmap/session")
        else:
            self.server.down = True
            code, out, _ = self.run_mail(self.BOT_A, "wait", "--timeout", "0")
        self.assertEqual((code, out), (qd_jmap.MAIL_FAILED, ""))

    def test_the_key_goes_only_in_the_authorization_header_and_never_in_output(self):
        secret = self.server.key_of(self.BOT_A)
        self.send(self.BOT_A, self.BOT_B, "STATUS: k", "1", "k1")
        results = [self.run_mail(self.BOT_A, "wait", "--timeout", "0"),
                   self.try_send(self.BOT_A, "nobody", "x", "", "k2"),
                   self.run_mail(self.BOT_A, "ack", "qd.none.x"),
                   self.run_mail(self.BOT_A, "wait", "--timeout", "0", session="http://127.0.0.1:1/jmap/session")]
        for _, out, err in results:
            self.assertNotIn(secret, out + err)
        for method, url, headers, body in getattr(self.server, "requests", []):
            self.assertNotIn(secret, url + (body or b"").decode())
            self.assertNotIn(secret, json.dumps({k: v for k, v in headers.items() if k != "Authorization"}))

    def test_the_key_pipe_must_carry_exactly_one_key(self):
        for key in ("", "a\nb", "x" * 5000):
            with self.subTest(length=len(key)):
                code, _, _ = self.run_mail(self.BOT_A, "wait", "--timeout", "0", key=key)
                self.assertEqual(code, qd_jmap.REFUSED)

    def test_the_session_must_be_https_unless_it_is_loopback(self):
        for url, allowed in (("https://mail.example.test/jmap/session", True), ("http://127.0.0.1:18080/x", True),
                             ("http://[::1]:18080/x", True), ("http://mail.example.test/jmap/session", False),
                             ("http://10.0.0.1/x", False), ("ftp://127.0.0.1/x", False)):
            with self.subTest(url=url):
                if allowed:
                    self.assertEqual(qd_jmap.check_session_url(url), url)
                else:
                    self.assertRaises(qd_jmap.Refused, qd_jmap.check_session_url, url)


class OriginAndCredentialTest(unittest.TestCase):
    SESSION = "https://mail.example.test/jmap/session"

    def setUp(self):
        self.server = FakeStalwart(["bot-a", "bot-b"])

    def run_mail(self, *args, session=None):
        read_end, write_end = os.pipe()
        os.write(write_end, self.server.key_of("bot-a").encode())
        os.close(write_end)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(qd_jmap.time, "sleep"):
            code = qd_jmap.main(["--session", session or self.SESSION, "--key-fd", str(read_end), *args],
                                transport=self.server)
        return code, out.getvalue(), err.getvalue()

    def test_an_api_url_on_another_origin_is_refused_before_any_second_request(self):
        for session, api in ((self.SESSION, "https://elsewhere.example.test/jmap/"),
                             (self.SESSION, "https://mail.example.test:8443/jmap/"),
                             (self.SESSION, "https://someone@mail.example.test/jmap/"),
                             (self.SESSION, "http://127.0.0.1/jmap/"),
                             (self.SESSION, "http://mail.example.test/jmap/"),
                             ("http://127.0.0.1:18080/jmap/session", "http://127.0.0.1:18081/jmap/"),
                             ("http://127.0.0.1:18080/jmap/session", "http://[::1]:18080/jmap/")):
            with self.subTest(session=session, api=api):
                self.server.requests.clear()
                self.server.api_url = api
                code, out, err = self.run_mail("wait", "--timeout", "0", session=session)
                self.assertEqual((code, out), (qd_jmap.MAIL_FAILED, ""), err)
                self.assertEqual(len(self.server.requests), 1)

    def test_an_api_url_on_the_same_origin_is_used(self):
        for api in ("/jmap/", "https://mail.example.test/jmap/", "https://mail.example.test:443/jmap/"):
            with self.subTest(api=api):
                self.server.api_url = api
                self.assertEqual(self.run_mail("wait", "--timeout", "0")[0], qd_jmap.NOTHING_NEW)

    def test_a_session_url_with_user_info_is_refused_before_any_request(self):
        code, _, _ = self.run_mail("wait", "--timeout", "0", session="https://u:p@mail.example.test/jmap/session")
        self.assertEqual(code, qd_jmap.REFUSED)
        self.assertEqual(self.server.requests, [])

    def test_a_credential_never_prints_and_is_cleared(self):
        secret = self.server.key_of("bot-a")
        read_end, write_end = os.pipe()
        os.write(write_end, secret.encode())
        os.close(write_end)
        credential = qd_jmap.Credential.from_fd(read_end)
        jmap = qd_jmap.Jmap("http://127.0.0.1:18080/jmap/session", credential, self.server)
        for text in (repr(credential), str(credential), f"{credential}", repr(jmap), repr(vars(jmap))):
            self.assertNotIn(secret, text)
        credential.clear()
        self.assertEqual(credential.header(), b"Bearer ")

    def test_main_clears_the_credential_on_success_and_on_failure(self):
        made = []
        real = qd_jmap.Credential.from_fd

        def keep(fd):
            made.append(real(fd))
            return made[-1]

        with mock.patch.object(qd_jmap.Credential, "from_fd", side_effect=keep):
            self.assertEqual(self.run_mail("wait", "--timeout", "0")[0], qd_jmap.NOTHING_NEW)
            self.server.down = True
            self.assertEqual(self.run_mail("wait", "--timeout", "0")[0], qd_jmap.MAIL_FAILED)
        self.assertEqual([c.header() for c in made], [b"Bearer ", b"Bearer "])


if __name__ == "__main__":
    unittest.main()
