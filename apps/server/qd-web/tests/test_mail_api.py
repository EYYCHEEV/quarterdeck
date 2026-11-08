import json
import os
import stat
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from urllib.parse import urlsplit

import mail_standins as standins

import application
import approval_security
import cards
import mail_api
import mail_gateway
import qd_jmap


class SignedOutGate:
    def authenticate(self, request):
        raise application.AuthenticationRequired("approval session required")


class MailCase(unittest.TestCase):
    def captain_for(self, server, transport=None):
        credential = qd_jmap.Credential(bytearray(standins.STAND_IN_KEY))
        mailbox = qd_jmap.Mailbox(qd_jmap.Jmap(standins.SESSION_URL, credential, transport or server))
        return mail_gateway.CaptainMailbox(
            mailbox, credential, account_name=standins.ACCOUNT_NAME, oversight_bot="bot-oversight"
        )

    def build(self, messages=(), *, gate=None, state=None, clock=None, mail_state=None, wrap=None):
        server = standins.StandInStalwart(messages)
        clock = clock or FakeClock()
        server.stamp = clock
        if state is None:
            folder = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
            self.addCleanup(folder.cleanup)
            state = Path(folder.name) / "mail-threads.sqlite3"
        api = mail_api.MailApi(
            self.captain_for(server, wrap(server) if wrap else None),
            gate or standins.real_gate(),
            clock=clock,
            mail_state_path=state,
            mail_state=mail_state or server.state,
        )
        return api, server

    @staticmethod
    def call(api, path, **options):
        reply = options.pop("reply", standins.SIGNED_IN_REPLY)
        connect_error = options.pop("connect_error", None)
        with standins.sign_in_service(reply, connect_error) as owner:
            response = api.handle(standins.get_request(path, **options), urlsplit(path).path)
        return response, owner

    def fetch(self, api, path, **options):
        return self.call(api, path, **options)

    def raised(self, api, path, error, **options):
        reply = options.pop("reply", standins.SIGNED_IN_REPLY)
        connect_error = options.pop("connect_error", None)
        with standins.sign_in_service(reply, connect_error) as owner:
            with self.assertRaises(error) as caught:
                api.handle(standins.get_request(path, **options), urlsplit(path).path)
        return caught.exception, owner

    @staticmethod
    def body_of(response):
        return json.loads(response.body)


class SessionRefusalTests(MailCase):
    def test_a_refused_session_raises_the_refusal_and_reads_no_mail(self):
        for path in ("/captain/mail", "/captain/mail/MT-1"):
            with self.subTest(path=path):
                api, server = self.build([standins.message(1)])
                _, owner = self.raised(api, path, approval_security.ApprovalRefused, reply=standins.REFUSAL_REPLY)
                self.assertEqual(owner.operations(), ["authenticate"])
                self.assertEqual(server.mail_calls(), [])

    def test_a_missing_cookie_raises_the_refusal_and_reads_no_mail(self):
        api, server = self.build([standins.message(1)])
        _, owner = self.raised(api, "/captain/mail", approval_security.ApprovalRefused, cookie=False)
        self.assertEqual(owner.opened, 0)
        self.assertEqual(server.mail_calls(), [])

    def test_an_unreachable_sign_in_service_raises_the_refusal_and_reads_no_mail(self):
        api, server = self.build([standins.message(1)])
        self.raised(api, "/captain/mail", approval_security.ApprovalRefused, connect_error=OSError("down"))
        self.assertEqual(server.mail_calls(), [])

    def test_the_in_process_sign_in_check_raises_authentication_required_and_reads_no_mail(self):
        api, server = self.build([standins.message(1)], gate=SignedOutGate())
        self.raised(api, "/captain/mail", application.AuthenticationRequired)
        self.assertEqual(server.mail_calls(), [])

    def test_a_bad_ref_with_a_refused_session_is_still_the_session_refusal(self):
        for path in ("/captain/mail/bad", "/captain/mail/MT-0"):
            with self.subTest(path=path):
                api, server = self.build([standins.message(1)])
                self.raised(api, path, approval_security.ApprovalRefused, reply=standins.REFUSAL_REPLY)
                self.assertEqual(server.mail_calls(), [])

    def test_the_session_is_checked_once_per_request(self):
        api, _ = self.build([standins.message(1)])
        _, owner = self.fetch(api, "/captain/mail")
        self.assertEqual(owner.operations(), ["authenticate"])


class SeamTests(MailCase):
    def test_the_state_folder_holds_one_private_file_after_a_request(self):
        folder = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(folder.cleanup)
        before = os.umask(0)
        self.addCleanup(os.umask, before)
        api, _ = self.build([standins.message(1)], state=Path(folder.name) / "mail-threads.sqlite3")
        self.fetch(api, "/captain/mail")
        files = sorted(item.name for item in Path(folder.name).iterdir())
        self.assertEqual(files, ["mail-threads.sqlite3"])
        self.assertEqual(stat.S_IMODE((Path(folder.name) / "mail-threads.sqlite3").stat().st_mode), 0o600)

    def test_the_constructor_needs_the_mail_state_keyword(self):
        folder = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(folder.cleanup)
        with self.assertRaises(TypeError):
            mail_api.MailApi(
                self.captain_for(standins.StandInStalwart([])),
                standins.real_gate(),
                clock=FakeClock(),
                mail_state_path=Path(folder.name) / "mail-threads.sqlite3",
            )

    def test_the_state_function_is_asked_once_per_call_before_any_mailbox_request(self):
        for path in ("/captain/mail", "/captain/mail/MT-1"):
            with self.subTest(path=path):
                held = []
                asked = []

                def mail_state():
                    asked.append(len(held[0].http))
                    return "same"

                api, server = self.build([standins.message(1)], mail_state=mail_state)
                held.append(server)
                start = len(server.http)
                self.fetch(api, path)
                self.assertEqual(asked, [start])
                self.assertGreater(len(server.http), start)

    def test_an_error_from_the_state_function_passes_through_and_reads_nothing(self):
        def broken():
            raise RuntimeError("no tick yet")

        api, server = self.build([standins.message(1)], mail_state=broken)
        before = len(server.http)
        self.raised(api, "/captain/mail", RuntimeError)
        self.assertEqual(len(server.http), before)

    def test_a_refused_session_does_not_ask_for_the_state(self):
        asked = []
        api, _ = self.build([standins.message(1)], gate=SignedOutGate(), mail_state=lambda: asked.append(1) or "same")
        self.raised(api, "/captain/mail", application.AuthenticationRequired)
        self.assertEqual(asked, [])

    def test_the_mail_server_sees_only_reads(self):
        clock = FakeClock()
        api, server = self.build([standins.message(1)], clock=clock)
        self.fetch(api, "/captain/mail")
        clock.advance(60)
        self.fetch(api, "/captain/mail")
        self.assertEqual(server.refused, [])
        self.assertLessEqual(set(server.method_names()), standins.READ_ONLY_METHODS)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def person(name):
    return {"name": "", "email": f"{name}@{standins.DOMAIN}"}


class ListTests(MailCase):
    SUMMARY_FIELDS = ["ref", "subject", "project", "lane", "card", "bots", "lastAt", "count", "days"]

    def listing(self, messages, **options):
        api, server = self.build(messages, **options)
        response, _ = self.fetch(api, "/captain/mail")
        self.assertEqual(response.status, 200)
        return self.body_of(response), response, api, server

    def test_mail_is_grouped_into_threads_by_the_normalised_subject(self):
        body, _, _, _ = self.listing([
            standins.message(1, subject="Search limit"),
            standins.message(2, subject="Re:   search  LIMIT"),
            standins.message(3, subject="Fwd: RE: Fw:search limit"),
            standins.message(4, subject="Other topic"),
        ])
        self.assertEqual([item["ref"] for item in body["threads"]], ["MT-2", "MT-1"])
        first = body["threads"][1]
        self.assertEqual(first["subject"], "Search limit")
        self.assertEqual(first["count"], 3)
        self.assertEqual(body["threads"][0]["subject"], "Other topic")
        self.assertEqual(body["threads"][0]["count"], 1)

    def test_a_summary_has_exactly_the_documented_fields_and_empty_places(self):
        body, _, _, _ = self.listing([standins.message(1)])
        self.assertEqual(list(body), ["threads", "truncated", "csrf", "freshUntil"])
        summary = body["threads"][0]
        self.assertEqual(list(summary), self.SUMMARY_FIELDS)
        self.assertEqual((summary["project"], summary["lane"], summary["card"]), (None, None, None))
        self.assertIs(body["truncated"], False)

    def test_the_inbox_and_the_sent_folder_are_both_read(self):
        sent = standins.message(2, subject="Question", mailbox=standins.SENT, **{"from": person(standins.ACCOUNT_NAME), "to": [person("bot-b")]})
        body, _, _, _ = self.listing([standins.message(1, subject="Question"), sent])
        self.assertEqual(body["threads"][0]["count"], 2)
        self.assertEqual(body["threads"][0]["bots"], ["bot-a", "account-user", "bot-b"])

    def test_bots_are_in_first_appearance_order_from_then_to_oldest_first(self):
        body, _, _, _ = self.listing([
            standins.message(2, subject="Plan", **{"from": person("bot-b"), "to": [person("bot-c"), person("bot-a")]}),
            standins.message(1, subject="Plan"),
        ])
        self.assertEqual(body["threads"][0]["bots"], ["bot-a", "account-user", "bot-b", "bot-c"])

    def test_times_are_new_york_time_and_days_are_new_york_days_newest_first(self):
        body, _, _, _ = self.listing([
            standins.message(1, subject="Late", receivedAt="2026-11-05T04:30:00Z"),
            standins.message(2, subject="Late", receivedAt="2026-11-05T05:30:00Z"),
            standins.message(3, subject="Late", receivedAt="2026-11-05T15:00:00Z"),
        ])
        summary = body["threads"][0]
        self.assertEqual(summary["lastAt"], "2026-11-05T10:00:00-05:00")
        self.assertEqual(summary["days"], ["2026-11-05", "2026-11-04"])

    def test_days_stop_at_31_newest_first(self):
        messages = [
            standins.message(day, subject="Long", receivedAt=f"2026-{9 + (day - 1) // 30:02d}-{(day - 1) % 30 + 1:02d}T15:00:00Z")
            for day in range(1, 41)
        ]
        body, _, _, _ = self.listing(messages)
        days = body["threads"][0]["days"]
        self.assertEqual(len(days), 31)
        self.assertEqual(days, sorted(days, reverse=True))
        self.assertEqual(days[0], "2026-10-10")

    def test_threads_are_newest_first_and_a_tie_puts_the_higher_number_first(self):
        same = "2026-11-04T15:00:00Z"
        body, _, _, _ = self.listing([
            standins.message(1, subject="A", receivedAt=same),
            standins.message(2, subject="B", receivedAt=same),
            standins.message(3, subject="C", receivedAt="2026-11-04T16:00:00Z"),
            standins.message(4, subject="D", receivedAt="2026-11-04T14:00:00Z"),
        ])
        self.assertEqual([item["subject"] for item in body["threads"]], ["C", "B", "A", "D"])

    def test_card_protocol_and_chat_mail_is_not_mail_but_lookalikes_are(self):
        subjects = [
            "CARD: Pick a date",
            "UPDATE: bot-a-1",
            "ANSWER: bot-a-1 A",
            "COMMENT: bot-a-1",
            "WITHDRAW: bot-a-1",
            "CHAT: bot-a",
            "Re: CARD: Pick a date",
            "card: lower case",
            "CARD:no space",
            "ASK: a real question",
        ]
        body, _, _, _ = self.listing([standins.message(number, subject=text) for number, text in enumerate(subjects, start=1)])
        shown = sorted(item["subject"] for item in body["threads"])
        self.assertEqual(shown, sorted(["Re: CARD: Pick a date", "card: lower case", "CARD:no space", "ASK: a real question"]))

    def test_an_empty_mailbox_gives_an_empty_list(self):
        body, _, _, _ = self.listing([])
        self.assertEqual((body["threads"], body["truncated"]), ([], False))

    def test_the_list_stops_at_200_newest_threads_and_says_truncated(self):
        body, _, _, _ = self.listing([standins.message(number, subject=f"Topic {number}") for number in range(1, 206)])
        refs = [item["ref"] for item in body["threads"]]
        self.assertEqual(len(refs), 200)
        self.assertIs(body["truncated"], True)
        self.assertEqual(refs[0], "MT-205")
        self.assertEqual(refs[-1], "MT-6")

    def test_exactly_200_threads_are_not_truncated(self):
        body, _, _, _ = self.listing([standins.message(number, subject=f"Topic {number}") for number in range(1, 201)])
        self.assertEqual((len(body["threads"]), body["truncated"]), (200, False))

    def test_the_etag_is_the_sha256_of_the_threads_and_truncated(self):
        import hashlib

        body, response, _, _ = self.listing([standins.message(1)])
        core = json.dumps({"threads": body["threads"], "truncated": body["truncated"]}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        expected = '"' + hashlib.sha256(core.encode("utf-8")).hexdigest() + '"'
        self.assertEqual(dict(response.headers)["ETag"], expected)

    def test_the_same_etag_gets_an_empty_304_and_a_new_mail_changes_it(self):
        clock = FakeClock()
        body, response, api, server = self.listing([standins.message(1)], clock=clock)
        etag = dict(response.headers)["ETag"]
        again, owner = self.fetch(api, "/captain/mail", headers={"If-None-Match": etag})
        self.assertEqual(again.status, 304)
        self.assertEqual(again.body, b"")
        self.assertEqual(dict(again.headers)["ETag"], etag)
        self.assertEqual(dict(again.headers)["Content-Length"], "0")
        self.assertEqual(owner.operations(), ["authenticate"])
        server.messages.append(standins.message(2, subject="Newer"))
        clock.advance(60)
        changed, _ = self.fetch(api, "/captain/mail", headers={"If-None-Match": etag})
        self.assertEqual(changed.status, 200)
        self.assertNotEqual(dict(changed.headers)["ETag"], etag)



class ThreadTests(MailCase):
    THREAD_FIELDS = ["ref", "subject", "project", "lane", "card", "bots", "lastAt", "count", "omitted", "mails"]
    MAIL_FIELDS = ["ref", "from", "to", "cc", "at", "text", "cut", "refs", "attachments"]

    def thread(self, messages, ref="MT-1", **options):
        api, server = self.build(messages, **options)
        response, _ = self.fetch(api, f"/captain/mail/{ref}")
        self.assertEqual(response.status, 200)
        return self.body_of(response), response, api, server

    def test_a_thread_has_the_summary_fields_except_days_plus_omitted_and_mails(self):
        body, response, _, _ = self.thread([standins.message(1, subject="Plan"), standins.message(2, subject="Re: Plan")])
        self.assertEqual(list(body), ["thread", "csrf", "freshUntil"])
        thread = body["thread"]
        self.assertEqual(list(thread), self.THREAD_FIELDS)
        self.assertEqual((thread["ref"], thread["subject"], thread["count"], thread["omitted"]), ("MT-1", "Plan", 2, 0))
        self.assertEqual((thread["project"], thread["lane"], thread["card"]), (None, None, None))
        self.assertEqual(thread["bots"], ["bot-a", "account-user"])
        self.assertEqual(thread["lastAt"], "2026-11-04T09:02:00-05:00")
        headers = dict(response.headers)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("ETag", headers)

    def test_mails_are_oldest_first_with_arrival_codes_and_the_documented_fields(self):
        body, _, _, _ = self.thread([
            standins.message(2, subject="Re: Plan", **{"from": person("bot-b"), "to": [person("bot-a"), person("bot-c")]}),
            standins.message(1, subject="Plan"),
        ])
        first, second = body["thread"]["mails"]
        self.assertEqual(list(first), self.MAIL_FIELDS)
        self.assertEqual((first["ref"], first["from"], first["to"], first["cc"]), ("MT-1.1", "bot-a", ["account-user"], []))
        self.assertEqual(first["at"], "2026-11-04T09:01:00-05:00")
        self.assertEqual(first["text"], "Body of message 1.\nSecond line.")
        self.assertEqual((first["cut"], first["refs"], first["attachments"]), (False, [], []))
        self.assertEqual((second["ref"], second["from"], second["to"], second["cc"]), ("MT-1.2", "bot-b", ["bot-a", "bot-c"], []))

    def test_line_ends_are_normalised_to_newlines(self):
        body, _, _, _ = self.thread([standins.message(1, text="one\r\ntwo\rthree\nfour")])
        self.assertEqual(body["thread"]["mails"][0]["text"], "one\ntwo\nthree\nfour")

    def test_a_crlf_body_is_normalised_before_it_is_capped_or_scanned(self):
        text = "a\r\n" * 6000
        body, _, _, _ = self.thread([standins.message(1, text=text)])
        mail = body["thread"]["mails"][0]
        self.assertEqual(mail["text"], "a\n" * 6000)
        self.assertIs(mail["cut"], False)
        scanned, _, _, _ = self.thread([standins.message(1, text="AR-4\r\nAR-5\rPG-6")])
        self.assertEqual(scanned["thread"]["mails"][0]["refs"], ["AR-4", "AR-5", "PG-6"])

    def test_no_carriage_return_is_ever_sent(self):
        messages = [
            standins.message(1, subject="Mixed", text="x\r\ny\rz"),
            standins.message(2, subject="Mixed", text=None, html="<p>a\r\nb</p><p>c\rd</p>"),
        ]
        body, response, _, _ = self.thread(messages)
        self.assertNotIn(b"\\r", response.body)
        self.assertNotIn(b"\r", response.body)
        self.assertEqual([mail["text"] for mail in body["thread"]["mails"]], ["x\ny\nz", "a b\n\nc d"])

    def test_a_mail_with_no_body_has_empty_text(self):
        body, _, _, _ = self.thread([standins.message(1, text=None, html=None)])
        mail = body["thread"]["mails"][0]
        self.assertEqual((mail["text"], mail["cut"]), ("", False))

    def test_a_long_body_is_cut_at_16384_bytes_on_a_character_boundary(self):
        cases = [
            ("a" * 16384, "a" * 16384, False),
            ("a" * 16385, "a" * 16384, True),
            ("é" * 10000, "é" * 8192, True),
            ("€" * 6000, "€" * 5461, True),
        ]
        for text, expected, cut in cases:
            with self.subTest(size=len(text.encode("utf-8")), start=text[:1]):
                body, _, _, _ = self.thread([standins.message(1, text=text)])
                mail = body["thread"]["mails"][0]
                self.assertEqual(mail["text"], expected)
                self.assertIs(mail["cut"], cut)

    def test_an_html_only_message_is_shown_as_plain_text(self):
        html = (
            "<html><head><style>p { color: red }</style></head><body><p>Hello &amp; welcome</p>"
            "<script>alert(1)</script><div>Line two<br>Line three</div>"
            "<ul><li>One</li><li>Two</li></ul></body></html>"
        )
        body, _, _, _ = self.thread([standins.message(1, text=None, html=html)])
        self.assertEqual(body["thread"]["mails"][0]["text"], "Hello & welcome\n\nLine two\nLine three\nOne\nTwo")

    def test_html_links_and_images_show_only_their_words(self):
        html = "<p>See <a href='http://example.invalid/x'>the page</a>.<img src='x.png' alt='logo'></p>"
        body, _, _, _ = self.thread([standins.message(1, text=None, html=html)])
        self.assertEqual(body["thread"]["mails"][0]["text"], "See the page.")

    def test_a_paragraph_after_words_starts_on_a_new_blank_line(self):
        body, _, _, _ = self.thread([standins.message(1, text=None, html="intro<p>Body</p>after")])
        self.assertEqual(body["thread"]["mails"][0]["text"], "intro\n\nBody\n\nafter")

    def test_style_and_script_inside_the_body_show_no_text(self):
        html = "<p>a</p><style>p { color: red }</style><script>var x = 1;</script><p>b</p>"
        body, _, _, _ = self.thread([standins.message(1, text=None, html=html)])
        self.assertEqual(body["thread"]["mails"][0]["text"], "a\n\nb")

    def test_a_body_the_server_cut_is_marked_cut_even_when_little_text_is_left(self):
        html = "<p>start</p>" + "<span></span>" * 5000
        body, _, _, _ = self.thread([standins.message(1, text=None, html=html)])
        mail = body["thread"]["mails"][0]
        self.assertEqual((mail["text"], mail["cut"]), ("start", True))

    def test_a_long_html_body_is_cut_and_says_so(self):
        html = "<p>" + "word " * 8000 + "</p>"
        body, _, _, _ = self.thread([standins.message(1, text=None, html=html)])
        mail = body["thread"]["mails"][0]
        self.assertIs(mail["cut"], True)
        self.assertNotIn("<", mail["text"])
        self.assertLessEqual(len(mail["text"].encode("utf-8")), 16384)

    def test_the_plain_part_wins_when_a_message_has_both(self):
        body, _, _, _ = self.thread([standins.message(1, text="plain words", html="<p>html words</p>")])
        self.assertEqual(body["thread"]["mails"][0]["text"], "plain words")

    def test_refs_are_ar_codes_then_pg_codes_in_order_without_repeats(self):
        text = "See PG-3, AR-12 and AR-4, AR-12 again, PG-3 too. Not: MT-4.1 XAR-9 AR-0 AR-007 AR-5x PG-"
        body, _, _, _ = self.thread([standins.message(1, text=text)])
        self.assertEqual(body["thread"]["mails"][0]["refs"], ["AR-12", "AR-4", "PG-3"])

    def test_refs_come_only_from_the_text_that_is_returned(self):
        text = "x" * 16384 + " AR-9"
        body, _, _, _ = self.thread([standins.message(1, text=text)])
        mail = body["thread"]["mails"][0]
        self.assertEqual((mail["cut"], mail["refs"]), (True, []))

    def test_attachments_are_names_and_sizes_only(self):
        attachments = [
            {"name": "report.pdf", "size": 2048, "type": "application/pdf"},
            {"name": None, "size": 10},
            {"name": "a\r\nb\x00.txt", "size": 0},
        ]
        body, _, _, _ = self.thread([standins.message(1, attachments=attachments)])
        shown = body["thread"]["mails"][0]["attachments"]
        self.assertEqual(shown, [{"name": "report.pdf", "size": 2048}, {"name": "attachment", "size": 10}, {"name": "a b .txt", "size": 0}])
        self.assertEqual([list(item) for item in shown], [["name", "size"]] * 3)

    def test_a_mail_lists_at_most_50_attachments_and_255_name_characters(self):
        attachments = [{"name": "n" * 400, "size": number} for number in range(60)]
        body, _, _, _ = self.thread([standins.message(1, attachments=attachments)])
        shown = body["thread"]["mails"][0]["attachments"]
        self.assertEqual(len(shown), 50)
        self.assertEqual(len(shown[0]["name"]), 255)

    def test_a_thread_returns_the_newest_50_oldest_first_and_counts_the_rest_as_omitted(self):
        body, _, _, _ = self.thread([standins.message(number, subject="Long thread") for number in range(1, 61)])
        thread = body["thread"]
        self.assertEqual((thread["count"], thread["omitted"]), (60, 10))
        refs = [mail["ref"] for mail in thread["mails"]]
        self.assertEqual((refs[0], refs[-1], len(refs)), ("MT-1.11", "MT-1.60", 50))

    def test_the_whole_answer_stays_within_1_mib_by_dropping_the_oldest_mails(self):
        messages = [standins.message(number, subject="Heavy", text='"' * 16384) for number in range(1, 51)]
        body, response, _, _ = self.thread(messages)
        thread = body["thread"]
        self.assertLessEqual(len(response.body), 1_048_576)
        self.assertGreater(len(response.body), 1_000_000)
        self.assertEqual(thread["omitted"], thread["count"] - len(thread["mails"]))
        self.assertGreater(thread["omitted"], 0)
        self.assertEqual(thread["mails"][-1]["ref"], "MT-1.50")

    def test_the_answer_size_limit_is_exact_including_the_commas(self):
        def heavy(quotes):
            return [
                standins.message(number, subject="Heavy", text='"' * quotes[number - 1] + "a" * (16384 - quotes[number - 1]))
                for number in range(1, 51)
            ]

        body, response, _, _ = self.thread(heavy([4000] * 50))
        self.assertEqual(body["thread"]["omitted"], 0)
        extra = 1_048_576 - len(response.body)
        self.assertGreater(extra, 0)
        per, rest = divmod(extra, 50)
        body, response, _, _ = self.thread(heavy([4000 + per + (1 if index < rest else 0) for index in range(50)]))
        self.assertGreaterEqual(body["thread"]["omitted"], 1)
        self.assertLessEqual(len(response.body), 1_048_576)

    def test_a_path_outside_the_thread_prefix_is_refused(self):
        for path in ("MT-1", "/captain/mails/MT-1", "/captain/mail"):
            with self.subTest(path=path):
                with self.assertRaises(cards.CardRefused):
                    mail_api.thread_number(path)

    def test_a_well_formed_ref_that_names_no_thread_is_not_found(self):
        api, server = self.build([standins.message(1)])
        for ref in ("MT-2", "MT-999999999"):
            with self.subTest(ref=ref):
                self.raised(api, f"/captain/mail/{ref}", application.NotFound)

    def test_a_malformed_ref_is_refused(self):
        api, server = self.build([standins.message(1)])
        for ref in ("", "bad", "MT-", "MT-0", "MT-01", "mt-1", "MT-1.2", "MT-1234567890", "1", "MT--1", "MT-1 ", "MT-١"):
            with self.subTest(ref=ref):
                self.raised(api, f"/captain/mail/{ref}", cards.CardRefused)

    def test_card_protocol_mail_never_takes_a_thread_number(self):
        body, _, _, _ = self.thread([
            standins.message(1, subject="CARD: Pick a date"),
            standins.message(2, subject="ASK: Plan"),
        ])
        self.assertEqual(body["thread"]["subject"], "ASK: Plan")

    def test_a_thread_read_costs_one_body_fetch_of_the_returned_mails_only(self):
        api, server = self.build([standins.message(number, subject="Long thread") for number in range(1, 61)])
        self.fetch(api, "/captain/mail/MT-1")
        fetches = [args for name, args in server.mail_calls() if name == "Email/get" and "bodyValues" in args.get("properties", [])]
        self.assertEqual(len(fetches), 1)
        self.assertEqual(len(fetches[0]["ids"]), 50)


class OpenGate:
    def authenticate(self, request):
        return object()

    def issue_csrf(self, owner):
        return "csrf-stand-in"

    def fresh_until(self, owner):
        return 0.0


def refs_of(body):
    return [item["ref"] for item in body["threads"]]


class TableTests(MailCase):
    def state_path(self):
        folder = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(folder.cleanup)
        return Path(folder.name) / "mail-threads.sqlite3"

    def listing(self, api):
        response, _ = self.fetch(api, "/captain/mail")
        return self.body_of(response)

    def test_thread_numbers_survive_a_restart(self):
        state = self.state_path()
        messages = [standins.message(1, subject="Alpha"), standins.message(2, subject="Beta")]
        first = self.listing(self.build(messages, state=state)[0])
        second = self.listing(self.build(messages, state=state)[0])
        self.assertEqual(refs_of(first), ["MT-2", "MT-1"])
        self.assertEqual(second, first)

    def test_a_message_missing_from_the_mailbox_leaves_its_number_taken(self):
        state = self.state_path()
        self.listing(self.build([standins.message(1, subject="Alpha"), standins.message(2, subject="Beta")], state=state)[0])
        api, _ = self.build([standins.message(2, subject="Beta"), standins.message(3, subject="Gamma")], state=state)
        self.assertEqual(refs_of(self.listing(api)), ["MT-3", "MT-2"])
        self.raised(api, "/captain/mail/MT-1", application.NotFound)

    def test_a_new_thread_never_takes_a_lower_number_even_when_its_mail_is_older(self):
        state = self.state_path()
        self.listing(self.build([standins.message(5, subject="Beta")], state=state)[0])
        api, _ = self.build([standins.message(5, subject="Beta"), standins.message(1, subject="Alpha")], state=state)
        by_subject = {item["subject"]: item["ref"] for item in self.listing(api)["threads"]}
        self.assertEqual(by_subject, {"Beta": "MT-1", "Alpha": "MT-2"})

    def test_mail_codes_keep_their_arrival_number_when_an_earlier_mail_is_gone(self):
        state = self.state_path()
        three = [standins.message(number, subject="Plan") for number in (1, 2, 3)]
        self.listing(self.build(three, state=state)[0])
        api, _ = self.build([three[0], three[2]], state=state)
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        body = self.body_of(response)
        self.assertEqual([mail["ref"] for mail in body["thread"]["mails"]], ["MT-1.1", "MT-1.3"])
        self.assertEqual(body["thread"]["count"], 2)

    def test_numbers_follow_first_appearance_oldest_received_first_whatever_the_mailbox_order(self):
        messages = [
            standins.message(3, subject="Third", receivedAt="2026-11-04T16:00:00Z"),
            standins.message(1, subject="First", receivedAt="2026-11-04T14:00:00Z"),
            standins.message(2, subject="Second", receivedAt="2026-11-04T15:00:00Z"),
        ]
        body = self.listing(self.build(messages)[0])
        self.assertEqual({item["subject"]: item["ref"] for item in body["threads"]}, {"First": "MT-1", "Second": "MT-2", "Third": "MT-3"})

    def test_a_reply_that_names_a_message_joins_its_thread_whatever_its_subject(self):
        first = standins.message(1, subject="Alpha")
        reply = standins.message(2, subject="Something else", inReplyTo=[first["messageId"][0]])
        body = self.listing(self.build([first, reply])[0])
        self.assertEqual([(item["subject"], item["count"]) for item in body["threads"]], [("Alpha", 2)])

    def test_a_references_header_joins_a_thread_through_any_earlier_message(self):
        first = standins.message(1, subject="Alpha")
        second = standins.message(2, subject="Re: Alpha")
        reply = standins.message(3, subject="Unrelated", references=["msg-unknown@qd.invalid", second["messageId"][0]])
        body = self.listing(self.build([first, second, reply])[0])
        self.assertEqual([(item["subject"], item["count"]) for item in body["threads"]], [("Alpha", 3)])

    def test_a_references_header_joins_the_nearest_earlier_message_first(self):
        alpha = standins.message(1, subject="Alpha")
        beta = standins.message(2, subject="Beta")
        reply = standins.message(3, subject="Gamma", references=[alpha["messageId"][0], beta["messageId"][0]])
        body = self.listing(self.build([alpha, beta, reply])[0])
        self.assertEqual({item["subject"]: item["count"] for item in body["threads"]}, {"Alpha": 1, "Beta": 2})

    def test_the_reply_headers_beat_the_subject(self):
        alpha = standins.message(1, subject="Alpha")
        beta = standins.message(2, subject="Beta")
        reply = standins.message(3, subject="Beta", inReplyTo=[alpha["messageId"][0]])
        body = self.listing(self.build([alpha, beta, reply])[0])
        counts = {item["subject"]: item["count"] for item in body["threads"]}
        self.assertEqual(counts, {"Alpha": 2, "Beta": 1})

    def test_a_reply_naming_a_message_nobody_has_falls_back_to_the_subject(self):
        first = standins.message(1, subject="Alpha")
        reply = standins.message(2, subject="Re: Alpha", inReplyTo=["msg-unknown@qd.invalid"])
        body = self.listing(self.build([first, reply])[0])
        self.assertEqual([item["count"] for item in body["threads"]], [2])

    def test_a_deleted_message_still_anchors_a_reply_that_names_it(self):
        state = self.state_path()
        first = standins.message(1, subject="Alpha")
        self.listing(self.build([first], state=state)[0])
        reply = standins.message(2, subject="Unrelated", inReplyTo=[first["messageId"][0]])
        api, _ = self.build([reply], state=state)
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        mails = self.body_of(response)["thread"]["mails"]
        self.assertEqual([mail["ref"] for mail in mails], ["MT-1.2"])

    def test_a_message_in_two_folders_is_one_mail(self):
        inbox = standins.message(1, subject="Note to self")
        sent = standins.message(2, id=inbox["id"], subject="Note to self", mailbox=standins.SENT, messageId=inbox["messageId"])
        body = self.listing(self.build([inbox, sent])[0])
        self.assertEqual([item["count"] for item in body["threads"]], [1])

    def test_the_table_file_is_owner_only_and_a_symlink_is_refused(self):
        folder = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(folder.cleanup)
        target = Path(folder.name) / "elsewhere"
        target.write_bytes(b"")
        link = Path(folder.name) / "mail-threads.sqlite3"
        link.symlink_to(target)
        with self.assertRaises(RuntimeError):
            self.build([standins.message(1)], state=link)

    def test_a_table_path_in_a_missing_folder_stops_the_start(self):
        folder = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(folder.cleanup)
        with self.assertRaises(RuntimeError):
            self.build([standins.message(1)], state=Path(folder.name) / "missing" / "mail-threads.sqlite3")

    def test_a_failed_placement_rolls_back_every_number_and_the_next_read_starts_clean(self):
        import sqlite3

        state = self.state_path()
        api, _ = self.build([standins.message(1, subject="Alpha"), standins.message(2, subject="Beta")], clock=FakeClock(), state=state)
        original = mail_api.ThreadTable._place_one
        calls = []

        def failing(db, mail):
            calls.append(mail.subject)
            if len(calls) == 2:
                raise sqlite3.OperationalError("disk full")
            return original(db, mail)

        with unittest.mock.patch.object(mail_api.ThreadTable, "_place_one", staticmethod(failing)):
            self.raised(api, "/captain/mail", sqlite3.OperationalError)
        db = sqlite3.connect(state)
        self.addCleanup(db.close)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM mails").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM threads").fetchone()[0], 0)
        body = self.listing(api)
        self.assertEqual({item["subject"]: item["ref"] for item in body["threads"]}, {"Alpha": "MT-1", "Beta": "MT-2"})


class CacheTests(MailCase):
    def setUp(self):
        self.clock = FakeClock()

    def read(self, api):
        response, _ = self.fetch(api, "/captain/mail")
        self.assertEqual(response.status, 200)
        return self.body_of(response)

    def test_a_read_with_the_same_state_makes_no_list_request_and_a_thread_costs_its_body_fetch(self):
        api, server = self.build([standins.message(1)], clock=self.clock)
        self.read(api)
        seen = len(server.http)
        self.clock.advance(4.9)
        self.read(api)
        self.fetch(api, "/captain/mail/MT-1")
        self.assertEqual(len(server.http), seen + 1)

    def test_after_five_seconds_with_the_same_state_no_request_is_made(self):
        api, server = self.build([standins.message(1)], clock=self.clock)
        self.read(api)
        polled = len(server.http)
        self.clock.advance(5)
        self.read(api)
        self.assertEqual(len(server.http), polled)

    def test_new_mail_is_fetched_by_its_id_and_nothing_else_is_fetched_again(self):
        api, server = self.build([standins.message(1)], clock=self.clock)
        self.read(api)
        server.messages.append(standins.message(2, subject="Newer"))
        before = len(server.calls)
        self.clock.advance(5)
        body = self.read(api)
        fetches = [args for name, args in server.calls[before:] if name == "Email/get"]
        self.assertEqual([args["ids"] for args in fetches], [["e002"]])
        self.assertEqual(len(body["threads"]), 2)

    def test_card_mail_is_fetched_once_and_then_ignored(self):
        api, server = self.build([standins.message(1, subject="CARD: Pick")], clock=self.clock)
        self.read(api)
        server.messages.append(standins.message(2, subject="Fine"))
        self.clock.advance(5)
        self.read(api)
        fetched = [args["ids"] for name, args in server.calls if name == "Email/get"]
        self.assertEqual(fetched, [["e001"], ["e002"]])

    def test_the_first_read_pages_the_whole_mailbox_and_fetches_in_batches(self):
        messages = [standins.message(number, subject=f"Topic {number}") for number in range(1, 601)]
        api, server = self.build(messages, clock=self.clock)
        self.read(api)
        queries = [args for name, args in server.calls if name == "Email/query"]
        self.assertEqual([args["position"] for args in queries], [0, 256, 512, 0])
        fetches = [len(args["ids"]) for name, args in server.calls if name == "Email/get"]
        self.assertEqual(fetches, [mail_api.FETCH_BATCH] * 6)

    def test_a_full_sweep_every_ten_minutes_forgets_mail_that_was_deleted(self):
        api, server = self.build([standins.message(1, subject="Alpha"), standins.message(2, subject="Beta")], clock=self.clock)
        self.assertEqual(len(self.read(api)["threads"]), 2)
        server.messages.pop()
        self.clock.advance(60)
        self.assertEqual(len(self.read(api)["threads"]), 2)
        self.clock.advance(mail_api.FULL_SWEEP_SECONDS)
        self.assertEqual(len(self.read(api)["threads"]), 1)

    def test_a_burst_of_new_mail_larger_than_the_quick_page_is_all_found(self):
        api, server = self.build([standins.message(1, subject="Old")], clock=self.clock)
        self.read(api)
        server.messages.extend(standins.message(number, subject=f"Burst {number}") for number in range(2, 2 + mail_api.QUICK_PAGE + 6))
        self.clock.advance(5)
        self.assertEqual(len(self.read(api)["threads"]), 1 + mail_api.QUICK_PAGE + 6)

    def test_a_failed_read_is_not_cached_and_the_next_request_tries_again(self):
        api, server = self.build([standins.message(1)], clock=self.clock)
        server.unreachable = True
        self.raised(api, "/captain/mail", qd_jmap.MailFailed)
        server.unreachable = False
        self.assertEqual(len(self.read(api)["threads"]), 1)

    def test_a_mailbox_beyond_the_window_is_bounded_not_refused(self):
        api, server = self.build([standins.message(number, subject=f"Topic {number}") for number in range(1, 2051)], clock=self.clock)
        body = self.read(api)
        self.assertEqual((len(body["threads"]), body["truncated"]), (200, True))
        queries = [args for name, args in server.calls if name == "Email/query"]
        self.assertEqual([args["position"] for args in queries], list(range(0, 2048, 256)) + [0])
        fetched = [item for name, args in server.calls if name == "Email/get" for item in args["ids"]]
        self.assertEqual(len(fetched), 2048)

    def test_the_mail_server_sees_only_reads_even_after_failures_and_retries(self):
        api, server = self.build([standins.message(1)], clock=self.clock)
        server.unreachable = True
        self.raised(api, "/captain/mail", qd_jmap.MailFailed)
        server.unreachable = False
        self.read(api)
        self.fetch(api, "/captain/mail/MT-1")
        self.assertEqual(server.refused, [])

    def test_the_mailbox_key_is_never_in_an_answer_or_an_error(self):
        api, server = self.build([standins.message(1)], clock=self.clock)
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        self.assertNotIn(standins.STAND_IN_KEY, response.body)
        server.messages.append(standins.message(2, subject="Fine"))
        server.key = b"changed"
        self.clock.advance(5)
        caught, _ = self.raised(api, "/captain/mail", qd_jmap.MailFailed)
        self.assertNotIn(standins.STAND_IN_KEY.decode(), str(caught))

    def test_concurrent_reads_all_succeed_and_agree(self):
        import threading

        messages = [standins.message(number, subject=f"Topic {number % 7}") for number in range(1, 41)]
        api, _ = self.build(messages, gate=OpenGate(), clock=self.clock)
        results, failures = [], []

        def work(path):
            try:
                results.append((path, api.handle(standins.get_request(path), path).body))
            except Exception as error:
                failures.append(error)

        threads = [threading.Thread(target=work, args=(path,)) for path in ["/captain/mail", "/captain/mail/MT-1"] * 8]
        for item in threads:
            item.start()
        for item in threads:
            item.join()
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 16)
        for path in ("/captain/mail", "/captain/mail/MT-1"):
            self.assertEqual(len({body for asked, body in results if asked == path}), 1)


class HostileMailTests(MailCase):
    def listing(self, messages):
        api, _ = self.build(messages)
        response, _ = self.fetch(api, "/captain/mail")
        self.assertEqual(response.status, 200)
        return self.body_of(response)["threads"]

    def test_a_lone_surrogate_in_a_subject_or_body_does_not_break_the_list_or_the_thread(self):
        messages = [standins.message(1, subject="bad \ud800 subject", text="bad \udfff body", attachments=[{"name": "x\ud800.txt", "size": 1}])]
        api, _ = self.build(messages)
        listing, _ = self.fetch(api, "/captain/mail")
        thread, _ = self.fetch(api, "/captain/mail/MT-1")
        self.assertEqual(self.body_of(listing)["threads"][0]["subject"], "bad \ufffd subject")
        mail = self.body_of(thread)["thread"]["mails"][0]
        self.assertEqual(mail["text"], "bad \ufffd body")
        self.assertEqual(mail["attachments"][0]["name"], "x\ufffd.txt")

    def test_an_empty_or_blank_subject_gets_a_stand_in_title_and_one_thread(self):
        shown = self.listing([standins.message(1, subject=""), standins.message(2, subject="   "), standins.message(3, subject="Re:")])
        self.assertEqual([(item["subject"], item["count"]) for item in shown], [("(no subject)", 3)])

    def test_a_subject_is_one_line_and_at_most_200_characters(self):
        shown = self.listing([standins.message(1, subject="line one\nline two\t\x00end"), standins.message(2, subject="x" * 500)])
        subjects = {item["subject"] for item in shown}
        self.assertEqual(subjects, {"line one line two end", "x" * 200})

    def test_a_mail_to_more_than_20_people_shows_20_names(self):
        crowd = [person(f"bot-{number:02d}") for number in range(30)]
        api, _ = self.build([standins.message(1, to=crowd)])
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        mail = self.body_of(response)["thread"]["mails"][0]
        self.assertEqual(mail["to"], [f"bot-{number:02d}" for number in range(20)])

    def test_a_mail_with_no_sender_or_no_recipient_still_shows(self):
        api, _ = self.build([standins.message(1, **{"from": {"name": "", "email": ""}, "to": []})])
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        mail = self.body_of(response)["thread"]["mails"][0]
        self.assertEqual((mail["from"], mail["to"]), ("unknown", ["account-user"]))

    def test_an_account_name_is_one_non_empty_line_whatever_the_address_holds(self):
        crowd = [{"name": "", "email": "line\none\x00two@qd.invalid"}, {"name": "", "email": "\n\x07@qd.invalid"}, person("bot-ok")]
        api, _ = self.build([standins.message(1, **{"from": {"name": "", "email": " \tspaced  name \x1b@qd.invalid"}, "to": crowd})])
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        mail = self.body_of(response)["thread"]["mails"][0]
        self.assertEqual(mail["from"], "spaced name")
        self.assertEqual(mail["to"], ["line one two", "bot-ok"])
        listing, _ = self.fetch(api, "/captain/mail")
        self.assertEqual(self.body_of(listing)["threads"][0]["bots"], ["spaced name", "line one two", "bot-ok"])

    def test_a_name_is_cut_at_255_characters(self):
        api, _ = self.build([standins.message(1, **{"from": {"name": "", "email": "n" * 400 + "@qd.invalid"}})])
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        self.assertEqual(self.body_of(response)["thread"]["mails"][0]["from"], "n" * 255)

    def test_a_thread_names_at_most_50_bots_in_first_appearance_order(self):
        messages = [standins.message(number, subject="Crowd", **{"from": person(f"sender-{number:03d}")}) for number in range(1, 61)]
        api, _ = self.build(messages)
        listing, _ = self.fetch(api, "/captain/mail")
        thread, _ = self.fetch(api, "/captain/mail/MT-1")
        bots = self.body_of(listing)["threads"][0]["bots"]
        self.assertEqual(len(bots), 50)
        self.assertEqual(bots[:3], ["sender-001", "account-user", "sender-002"])
        self.assertEqual(self.body_of(thread)["thread"]["bots"], bots)

    def test_a_name_never_ends_in_a_space_after_the_cut(self):
        api, _ = self.build([standins.message(1, **{"from": {"name": "", "email": "a" * 254 + " bcd@qd.invalid"}})])
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        self.assertEqual(self.body_of(response)["thread"]["mails"][0]["from"], "a" * 254)

    def test_a_mail_with_no_time_is_skipped_and_the_rest_still_show(self):
        shown = self.listing([standins.message(1, subject="Broken", receivedAt="not a time"), standins.message(2, subject="Fine")])
        self.assertEqual([item["subject"] for item in shown], ["Fine"])

    def test_a_time_without_a_zone_is_skipped_like_an_unreadable_one(self):
        shown = self.listing([standins.message(1, subject="Floating", receivedAt="2026-11-04T14:00:00"), standins.message(2, subject="Fine")])
        self.assertEqual([item["subject"] for item in shown], ["Fine"])

    def test_edge_spaces_and_the_delete_character_never_reach_a_subject(self):
        shown = self.listing([standins.message(1, subject="  padded\x7f title \x1b  ")])
        self.assertEqual(shown[0]["subject"], "padded title")

    def test_an_empty_message_id_is_no_message_id(self):
        shown = self.listing([standins.message(1, subject="Alpha", messageId=[""]), standins.message(2, subject="Beta", messageId=[""])])
        self.assertEqual(sorted((item["subject"], item["count"]) for item in shown), [("Alpha", 1), ("Beta", 1)])

    def test_an_unreadable_mail_is_not_fetched_again_on_every_check(self):
        clock = FakeClock()
        api, server = self.build([standins.message(1, subject="Broken", receivedAt="not a time"), standins.message(2, subject="Fine")], clock=clock)
        self.fetch(api, "/captain/mail")
        server.messages.append(standins.message(3, subject="Later"))
        clock.advance(5)
        self.fetch(api, "/captain/mail")
        fetched = [sorted(args["ids"]) for name, args in server.calls if name == "Email/get"]
        self.assertEqual(fetched, [["e001", "e002"], ["e003"]])

    def test_a_mail_with_no_message_id_still_gets_a_stable_place(self):
        state_folder = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(state_folder.cleanup)
        state = Path(state_folder.name) / "mail-threads.sqlite3"
        messages = [standins.message(1, subject="Alpha", messageId=[]), standins.message(2, subject="Re: Alpha", messageId=[])]
        first, _ = self.build(messages, state=state)
        again, _ = self.build(messages, state=state)
        one, _ = self.fetch(first, "/captain/mail/MT-1")
        two, _ = self.fetch(again, "/captain/mail/MT-1")
        self.assertEqual([mail["ref"] for mail in self.body_of(one)["thread"]["mails"]], ["MT-1.1", "MT-1.2"])
        self.assertEqual(self.body_of(one), self.body_of(two))

    def test_a_message_that_vanishes_before_its_body_is_read_is_left_out_and_counted(self):
        api, server = self.build([standins.message(1, subject="Plan"), standins.message(2, subject="Plan")], clock=FakeClock())
        self.fetch(api, "/captain/mail")
        original = server.get

        def losing(args):
            answer = original(args)
            answer["list"] = [item for item in answer["list"] if item["id"] != "e001"]
            return answer

        server.get = losing
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        thread = self.body_of(response)["thread"]
        self.assertEqual([mail["ref"] for mail in thread["mails"]], ["MT-1.2"])
        self.assertEqual((thread["count"], thread["omitted"]), (2, 1))

    def test_a_mail_server_error_answer_is_raised_not_shown(self):
        api, server = self.build([standins.message(1)], clock=FakeClock())
        server.answer = lambda name, args, call_id: ["error", {"type": "serverFail"}, call_id]
        self.raised(api, "/captain/mail", qd_jmap.MailFailed)

    def test_odd_json_types_from_the_mail_server_never_break_a_thread(self):
        weird = standins.message(1, subject="Odd")
        api, server = self.build([weird], clock=FakeClock())
        original = server.view

        def odd(item, wanted, with_values, cap):
            view = original(item, wanted, with_values, cap)
            if "textBody" in view:
                view["textBody"] = ["junk", {"partId": 5}, {"partId": "1", "type": None}, None]
                view["attachments"] = ["junk", {"name": 7, "size": True}, {"name": "ok", "size": -3}, None]
                view["bodyValues"] = {"1": {"value": 12}}
            return view

        server.view = odd
        response, _ = self.fetch(api, "/captain/mail/MT-1")
        mail = self.body_of(response)["thread"]["mails"][0]
        self.assertEqual(mail["text"], "")
        self.assertEqual(mail["attachments"], [{"name": "attachment", "size": 0}, {"name": "ok", "size": 0}])


class StateTests(MailCase):
    def setUp(self):
        self.clock = FakeClock()
        self.text = ["one"]

    def build_with_text(self, messages):
        return self.build(messages, clock=self.clock, mail_state=lambda: self.text[0])

    def read(self, api, path="/captain/mail"):
        response, _ = self.fetch(api, path)
        self.assertEqual(response.status, 200)
        return self.body_of(response)

    @staticmethod
    def body_fetches(server):
        return [args for name, args in server.calls if name == "Email/get" and "bodyValues" in args.get("properties", [])]

    def test_the_same_state_means_no_mailbox_request_however_long_it_lasts(self):
        api, server = self.build_with_text([standins.message(1)])
        self.read(api)
        seen = len(server.http)
        for _ in range(5):
            self.clock.advance(7)
            self.read(api)
        self.assertEqual(len(server.http), seen)

    def test_a_changed_state_refreshes_at_once_with_no_five_second_wait(self):
        api, server = self.build_with_text([standins.message(1, subject="Old")])
        self.read(api)
        server.messages.append(standins.message(2, subject="Newer"))
        self.text[0] = "two"
        self.assertEqual(len(self.read(api)["threads"]), 2)
        seen = len(server.http)
        self.read(api)
        self.assertEqual(len(server.http), seen)

    def test_a_change_during_the_sync_is_caught_by_the_next_call(self):
        held, start = [], []

        def text():
            return "after" if len(held[0].http) > start[0] else "before"

        api, server = self.build([standins.message(1)], clock=self.clock, mail_state=text)
        held.append(server)
        start.append(len(server.http))
        self.read(api)
        seen = len(server.http)
        self.read(api)
        self.assertGreater(len(server.http), seen)
        again = len(server.http)
        self.read(api)
        self.assertEqual(len(server.http), again)

    def test_a_failed_sync_keeps_the_old_state_and_makes_one_try_only(self):
        api, server = self.build_with_text([standins.message(1)])
        self.read(api)
        server.messages.append(standins.message(2, subject="Newer"))
        self.text[0] = "two"
        server.refuse_with = 429
        before = len(server.http)
        self.raised(api, "/captain/mail", qd_jmap.MailFailed)
        self.assertEqual(len(server.http), before + 1)
        server.refuse_with = 0
        self.assertEqual(len(self.read(api)["threads"]), 2)
        settled = len(server.http)
        self.read(api)
        self.assertEqual(len(server.http), settled)

    def test_an_unreachable_mailbox_is_one_try_per_call_and_never_a_loop(self):
        api, server = self.build_with_text([standins.message(1)])
        server.unreachable = True
        before = len(server.http)
        for tries in (1, 2, 3):
            self.raised(api, "/captain/mail", qd_jmap.MailFailed)
            self.assertEqual(len(server.http), before + tries)

    def test_a_failure_while_reading_a_thread_passes_through_and_the_next_call_tries_again(self):
        api, server = self.build_with_text([standins.message(1)])
        self.read(api)
        server.refuse_with = 429
        before = len(server.http)
        self.raised(api, "/captain/mail/MT-1", qd_jmap.MailFailed)
        self.assertEqual(len(server.http), before + 1)
        server.refuse_with = 0
        self.assertEqual(self.read(api, "/captain/mail/MT-1")["thread"]["count"], 1)

    def test_a_missing_state_syncs_but_no_more_than_once_every_five_seconds(self):
        api, server = self.build([standins.message(1)], clock=self.clock, mail_state=lambda: None)
        self.read(api)
        seen = len(server.http)
        self.clock.advance(4.9)
        self.read(api)
        self.assertEqual(len(server.http), seen)
        self.clock.advance(0.1)
        self.read(api)
        self.assertGreater(len(server.http), seen)

    def test_the_first_state_text_after_a_missing_one_syncs_again_once(self):
        self.text[0] = None
        api, server = self.build_with_text([standins.message(1)])
        self.read(api)
        seen = len(server.http)
        self.text[0] = "one"
        self.read(api)
        self.assertGreater(len(server.http), seen)
        settled = len(server.http)
        self.read(api)
        self.assertEqual(len(server.http), settled)

    def test_an_overdue_full_sweep_runs_even_when_the_state_has_not_changed(self):
        api, server = self.build(
            [standins.message(1, subject="Alpha"), standins.message(2, subject="Beta")],
            clock=self.clock,
            mail_state=lambda: "same",
        )
        self.assertEqual(len(self.read(api)["threads"]), 2)
        server.messages.pop()
        self.clock.advance(mail_api.FULL_SWEEP_SECONDS - 1)
        self.assertEqual(len(self.read(api)["threads"]), 2)
        self.clock.advance(1)
        self.assertEqual(len(self.read(api)["threads"]), 1)

    def test_a_thread_is_fetched_once_while_its_mail_is_the_same(self):
        api, server = self.build_with_text([standins.message(1, subject="Plan"), standins.message(2, subject="Plan")])
        first = self.read(api, "/captain/mail/MT-1")
        self.assertEqual(len(self.body_fetches(server)), 1)
        second = self.read(api, "/captain/mail/MT-1")
        self.assertEqual(len(self.body_fetches(server)), 1)
        self.assertEqual(first["thread"], second["thread"])

    def test_only_the_new_mail_of_a_thread_is_fetched_after_a_change(self):
        api, server = self.build_with_text([standins.message(1, subject="Plan")])
        self.read(api, "/captain/mail/MT-1")
        server.messages.append(standins.message(2, subject="Re: Plan"))
        self.text[0] = "two"
        thread = self.read(api, "/captain/mail/MT-1")["thread"]
        self.assertEqual([mail["ref"] for mail in thread["mails"]], ["MT-1.1", "MT-1.2"])
        self.assertEqual([args["ids"] for args in self.body_fetches(server)], [["e001"], ["e002"]])

    def test_the_body_cache_is_bounded_and_drops_the_least_recently_read_mail(self):
        messages = [standins.message(number, subject=f"Topic {number}") for number in (1, 2, 3)]
        with unittest.mock.patch.object(mail_api, "BODY_CACHE", 2):
            api, server = self.build_with_text(messages)
            for path in ("/captain/mail/MT-1", "/captain/mail/MT-2", "/captain/mail/MT-1", "/captain/mail/MT-3", "/captain/mail/MT-1"):
                self.read(api, path)
            self.assertEqual(len(self.body_fetches(server)), 3)
            self.read(api, "/captain/mail/MT-2")
            self.assertEqual(len(self.body_fetches(server)), 4)

    def test_a_thread_read_waits_for_a_sync_that_is_in_progress(self):
        import threading
        import time

        entered, release, armed = threading.Event(), threading.Event(), []

        def wrap(server):
            def gated(method, url, headers, body=None):
                if armed and method == "POST" and not entered.is_set():
                    entered.set()
                    release.wait(10)
                return server(method, url, headers, body)

            return gated

        api, server = self.build([standins.message(1)], gate=OpenGate(), wrap=wrap)
        armed.append(True)
        seen = len(server.http)
        answers = []

        def ask(path):
            answers.append(api.handle(standins.get_request(path), path).status)

        first = threading.Thread(target=ask, args=("/captain/mail",))
        first.start()
        self.assertTrue(entered.wait(5))
        second = threading.Thread(target=ask, args=("/captain/mail/MT-1",))
        second.start()
        time.sleep(0.3)
        self.assertEqual(len(server.http), seen)
        release.set()
        first.join(10)
        second.join(10)
        self.assertEqual(sorted(answers), [200, 200])


class RateTests(MailCase):
    @staticmethod
    def peak(times):
        peak, start = 0, 0
        for end, moment in enumerate(times):
            while moment - times[start] >= 60:
                start += 1
            peak = max(peak, end - start + 1)
        return peak

    def read(self, api, path="/captain/mail"):
        response, _ = self.fetch(api, path)
        self.assertEqual(response.status, 200)

    def test_a_reader_every_second_with_nothing_changing_costs_no_request(self):
        clock = FakeClock()
        api, server = self.build([standins.message(number, subject=f"Topic {number}") for number in range(1, 11)], clock=clock)
        self.read(api)
        self.read(api, "/captain/mail/MT-1")
        seen = len(server.http)
        for _ in range(300):
            clock.advance(1)
            self.read(api)
            self.read(api, "/captain/mail/MT-1")
        self.assertEqual(len(server.http), seen)

    def test_new_mail_every_five_seconds_and_a_reader_every_second_stay_under_sixty_a_minute(self):
        clock = FakeClock()
        api, server = self.build([standins.message(number, subject=f"Topic {number}") for number in range(1, 11)], clock=clock)
        self.read(api)
        started = len(server.times)
        number = 10
        for second in range(1, 301):
            clock.advance(1)
            if second % 5 == 0:
                number += 1
                server.messages.append(standins.message(number, subject=f"Topic {second % 10 + 1}"))
            self.read(api)
            self.read(api, f"/captain/mail/MT-{second % 10 + 1}")
        self.assertGreater(len(server.times) - started, 60)
        self.assertLessEqual(self.peak(server.times[started:]), 60)


if __name__ == "__main__":
    unittest.main()
