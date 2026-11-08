import ast
import io
import json
import sys
import tokenize
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import cards
import mail_gateway
import qd_jmap
import security
import test_chat_r3_mail as gateway
from checker_adapter import LaneAChecker
from r3_helpers import R3Env
from test_cards import FakeMail, FixtureChecker, card, message
from test_chat_server import ACCOUNT, BASE_TIME, STEWARD, answer, request

ET = ZoneInfo("America/New_York")
FIRST = datetime.fromtimestamp(BASE_TIME, ET).isoformat(timespec="seconds")
LATER = 300
SUBJECT = "ANSWER: repo-lead-1 A"
KEY = "answer:repo-lead-1:rev1:A:to-repo-lead"
PATH = "/captain/cards/repo-lead-1/answer"
BUSY = (503, {"error": "request unavailable"})
REGISTRY = {"format": 1, "steward": STEWARD, "captain": ACCOUNT, "projects": {"Repo": "repo-lead"}}
REAL_CARD_SUBJECT = "CARD: Choose a thing"
REAL_CARD_BODY = (
    '{"about":"We need one pick.","card":"repo-lead-1","category":["strategy"],"context":"Some context for the choice.",'
    '"id":"repo-lead-1","lane":"Launch","options":[{"cons":["rough"],"label":"A. First","pick":true,"pros":["fast"]},'
    '{"cons":["safe"],"label":"B. Second","pros":["slow"]}],"pick_why":"It is fast and good enough.","project":"Repo",'
    '"qd":"card/1","title":"Choose a thing"}'
)
MASKED_NOTE = "call 203.0.113.5 now"


def clock_text(seconds):
    return datetime.fromtimestamp(seconds, ET).strftime("%-I:%M %p")


def at_text(seconds):
    return datetime.fromtimestamp(seconds, ET).isoformat(timespec="seconds")


def answer_document(**changes):
    document = {"qd": "answer/1", "card": "repo-lead-1", "rev": 1, "pick": "A", "note": "Use the first", "at": FIRST}
    document.update(changes)
    return document


def encode(document):
    return json.dumps(document, separators=(",", ":"), sort_keys=True)


def answer_body(**changes):
    return encode(answer_document(**changes))


def creates(source):
    return sum(
        1
        for request_calls in source.posts
        for name, arguments, call_id in request_calls
        if name == "Email/set" and "create" in arguments
    )


def answers_sent(source):
    return [
        (row["to"][0]["email"].partition("@")[0], row["bodyValues"]["1"]["value"])
        for row in source.emails.values()
        if row["mailboxIds"].get("sent") and row["subject"].startswith("ANSWER: ")
    ]


def sent_row(source):
    [identifier] = [name for name, row in source.emails.items() if row["mailboxIds"].get("sent")]
    return source.emails[identifier]


class FlakyServer(gateway.JmapServer):
    def __init__(self):
        super().__init__()
        self.fail_to = None

    def answer(self, name, arguments):
        if self.fail_to is not None and name == "Email/set" and "create" in arguments:
            made = arguments["create"]["m"]
            if any(entry["email"].startswith(self.fail_to + "@") for entry in made["to"]):
                raise gateway.Unknown("serverFail")
        return super().answer(name, arguments)


def card_world(server=None, subject="CARD: Choose", body=None):
    source = server if server is not None else gateway.JmapServer()
    document = body if body is not None else json.dumps(card("repo-lead-1", "Repo", "Launch", "Choose"), separators=(",", ":"))
    source.add("inbox", "repo-lead", ACCOUNT, subject, document, "j-card", "card-1")
    return source


class AnswerEnv(R3Env):
    def __init__(self, case, source, checker=None):
        self.source = source
        self.box = gateway.adapter(source)
        super().__init__(case, checker=checker if checker is not None else FixtureChecker())

    def rewire(self, names=None):
        self.mail = self.box
        super().rewire(names)

    def answer_card(self, pick="A", note="Use the first", rev=1, **options):
        payload = {"rev": rev, "pick": pick, "note": note, "csrf": "csrf-now"}
        return answer(self.web.handle(request("POST", PATH, payload, **options)))


class SendAnswerTests(gateway.MailCase):
    def box(self):
        source = gateway.JmapServer()
        return source, gateway.adapter(source)

    def first(self, box):
        return box.send_answer("repo-lead", SUBJECT, answer_body(), KEY)

    def test_a_first_answer_is_sent_once_and_reports_no_earlier_time(self):
        source, box = self.box()
        self.assertIsNone(self.first(box))
        self.assertEqual(creates(source), 1)
        self.assertEqual(answers_sent(source), [("repo-lead", answer_body())])

    def test_the_same_words_again_is_a_plain_success_with_no_second_mail(self):
        source, box = self.box()
        self.first(box)
        self.assertIsNone(self.first(box))
        self.assertEqual(creates(source), 1)
        self.assertEqual(source.refused, [])

    def test_only_another_time_counts_as_sent_and_reports_the_first_time(self):
        source, box = self.box()
        self.first(box)
        again = box.send_answer("repo-lead", SUBJECT, answer_body(at=at_text(BASE_TIME + LATER)), KEY)
        self.assertEqual(again, FIRST)
        self.assertEqual(creates(source), 1)
        self.assertEqual(answers_sent(source), [("repo-lead", answer_body())])

    def test_the_first_time_is_given_back_exactly_as_it_was_written(self):
        source, box = self.box()
        box.send_answer("repo-lead", SUBJECT, answer_body(at="2024-11-06T01:56:00Z"), KEY)
        again = box.send_answer("repo-lead", SUBJECT, answer_body(at=FIRST), KEY)
        self.assertEqual(again, "2024-11-06T01:56:00Z")

    def test_a_repeat_of_a_repeat_still_reports_the_first_time_and_makes_nothing(self):
        source, box = self.box()
        self.first(box)
        for number in range(1, 4):
            self.assertEqual(box.send_answer("repo-lead", SUBJECT, answer_body(at=at_text(BASE_TIME + number * LATER)), KEY), FIRST)
        self.assertEqual(creates(source), 1)

    def test_anything_but_the_time_that_differs_keeps_the_refusal_and_the_first_mail(self):
        cases = {
            "another note": answer_document(note="Use the second"),
            "an empty note": answer_document(note=""),
            "another pick": answer_document(pick="B"),
            "another card": answer_document(card="repo-lead-2"),
            "another revision": answer_document(rev=2),
            "a revision of another type": answer_document(rev=True),
            "another format": answer_document(qd="answer/2"),
            "an extra field": {**answer_document(at=at_text(BASE_TIME + LATER)), "comment": "c"},
        }
        missing = answer_document(at=at_text(BASE_TIME + LATER))
        del missing["note"]
        cases["a missing field"] = missing
        for label, document in cases.items():
            with self.subTest(label=label):
                source, box = self.box()
                self.first(box)
                other = dict(document)
                if "at" in other and other["at"] == FIRST:
                    other["at"] = at_text(BASE_TIME + LATER)
                with self.assertRaises(qd_jmap.Refused):
                    box.send_answer("repo-lead", SUBJECT, encode(other), KEY)
                self.assertEqual(creates(source), 1)
                self.assertEqual(answers_sent(source), [("repo-lead", answer_body())])

    def test_a_body_that_is_not_an_answer_object_keeps_the_refusal(self):
        for label, body in (("text", "just words"), ("a list", "[1]"), ("a number", "5"), ("null", "null")):
            with self.subTest(label=label):
                source, box = self.box()
                self.first(box)
                with self.assertRaises(qd_jmap.Refused):
                    box.send_answer("repo-lead", SUBJECT, body, KEY)
                self.assertEqual(creates(source), 1)

    def test_a_kept_copy_that_differs_from_the_message_in_sender_recipient_subject_or_message_id_keeps_the_refusal(self):
        cases = {
            "another sender": lambda row: row.update({"from": [{"email": "bot-x@qd.invalid"}]}),
            "another recipient": lambda row: row.update({"to": [{"email": "bot-x@qd.invalid"}]}),
            "another subject": lambda row: row.update({"subject": "ANSWER: repo-lead-1 B"}),
            "another message id": lambda row: row.update({"messageId": ["other@qd.invalid", *row["messageId"]]}),
        }
        for label, change in cases.items():
            with self.subTest(label=label):
                source, box = self.box()
                self.first(box)
                change(sent_row(source))
                with self.assertRaises(qd_jmap.Refused):
                    box.send_answer("repo-lead", SUBJECT, answer_body(at=at_text(BASE_TIME + LATER)), KEY)
                self.assertEqual(creates(source), 1)

    def test_a_kept_body_that_is_not_a_usable_answer_keeps_the_refusal(self):
        cases = {
            "not json": "words",
            "a list": "[]",
            "an extra field": encode({**answer_document(), "comment": "c"}),
            "a missing field": encode({key: value for key, value in answer_document().items() if key != "note"}),
            "a time that is not text": encode(answer_document(at=5)),
            "a time with no offset": encode(answer_document(at="2024-11-05T20:56:00")),
            "a time that is not a time": encode(answer_document(at="later")),
            "another format": encode(answer_document(qd="answer/2")),
        }
        for label, kept in cases.items():
            with self.subTest(label=label):
                source, box = self.box()
                self.first(box)
                sent_row(source)["bodyValues"]["1"]["value"] = kept
                with self.assertRaises(qd_jmap.Refused):
                    box.send_answer("repo-lead", SUBJECT, answer_body(at=at_text(BASE_TIME + LATER)), KEY)
                self.assertEqual(creates(source), 1)

    def test_a_refusal_with_no_kept_copy_is_raised_as_it_was(self):
        source, box = self.box()
        with self.assertRaises(qd_jmap.Refused):
            box.send_answer("repo-lead", SUBJECT, answer_body(), "k" * 201)
        self.assertEqual(creates(source), 0)

    def test_a_refusal_that_is_not_about_the_key_is_raised_as_it_was(self):
        source, box = self.box()
        for recipient, subject in (("Not A Bot", SUBJECT), ("repo-lead", "two\nlines"), ("repo-lead", "   ")):
            with self.subTest(recipient=recipient, subject=subject):
                with self.assertRaises(qd_jmap.Refused):
                    box.send_answer(recipient, subject, answer_body(), KEY)
        self.assertEqual(creates(source), 0)

    def test_a_busy_send_line_passes_through_with_no_look_at_the_kept_copy(self):
        source, box = self.box()
        self.first(box)
        http = len(source.http)
        with mock.patch.object(mail_gateway._SEND_LINE, "take", side_effect=mail_gateway.SendBusy("busy")):
            with self.assertRaises(mail_gateway.SendBusy):
                box.send_answer("repo-lead", SUBJECT, answer_body(at=at_text(BASE_TIME + LATER)), KEY)
        self.assertEqual(len(source.http), http)

    def test_a_mail_failure_passes_through_with_no_look_at_the_kept_copy(self):
        source, box = self.box()
        source.broken["Email/set"] = 503
        with self.assertRaises(qd_jmap.MailFailed):
            box.send_answer("repo-lead", SUBJECT, answer_body(), KEY)
        self.assertEqual([name for name, arguments, call_id in source.posts[-1]], ["Email/set", "EmailSubmission/set"])

    def test_a_closed_mailbox_passes_through_with_no_request(self):
        source, box = self.box()
        self.first(box)
        box.close()
        http = len(source.http)
        with self.assertRaises(security.SecurityRefused):
            box.send_answer("repo-lead", SUBJECT, answer_body(at=at_text(BASE_TIME + LATER)), KEY)
        self.assertEqual(len(source.http), http)

    def test_the_kept_copy_look_costs_the_same_as_the_one_chat_makes(self):
        source, box = self.box()
        self.first(box)
        mark = len(source.posts)
        box.send_answer("repo-lead", SUBJECT, answer_body(at=at_text(BASE_TIME + LATER)), KEY)
        names = [name for request_calls in source.posts[mark:] for name, arguments, call_id in request_calls]
        self.assertEqual(names, ["Email/query", "Email/get", "Email/query", "Email/get"])
        self.assertEqual(creates(source), 1)


class AnswerRouteTests(gateway.MailCase):
    def world(self, server=None, checker=None, subject="CARD: Choose", body=None):
        source = card_world(server, subject, body)
        env = AnswerEnv(self, source, checker)
        env.refresh()
        return source, env

    def kinds(self, env):
        env.refresh()
        return [item["kind"] for item in env.service.card("repo-lead-1")["thread"]]

    def test_answering_twice_is_200_both_times_with_the_first_time_and_one_mail_per_recipient(self):
        source, env = self.world()
        first = env.answer_card()
        env.now += LATER
        made = creates(source)
        second = env.answer_card()
        self.assertEqual(first[0], 200)
        self.assertEqual(second[0], 200)
        self.assertEqual(first, second)
        self.assertEqual(first[1]["message"], f"Got it: repo-lead-1 A at {clock_text(BASE_TIME)} ET")
        self.assertEqual(sorted(recipient for recipient, body in answers_sent(source)), [STEWARD, "repo-lead"])
        self.assertEqual({json.loads(body)["at"] for recipient, body in answers_sent(source)}, {FIRST})
        self.assertEqual(creates(source), made)

    def test_the_card_thread_shows_one_answer_after_two_answers(self):
        source, env = self.world()
        env.answer_card()
        env.now += LATER
        env.answer_card()
        self.assertEqual(self.kinds(env).count("answer"), 1)

    def test_ten_repeats_all_answer_200_with_the_first_time_and_make_no_mail(self):
        source, env = self.world()
        first = env.answer_card()
        made = creates(source)
        for number in range(1, 11):
            env.now += LATER
            self.assertEqual(env.answer_card(), first)
        self.assertEqual(creates(source), made)
        self.assertEqual(len(answers_sent(source)), 2)

    def test_a_partial_earlier_send_is_completed_by_the_repeat(self):
        source, env = self.world(FlakyServer())
        source.fail_to = STEWARD
        self.assertEqual(env.answer_card(), BUSY)
        self.assertEqual([recipient for recipient, body in answers_sent(source)], ["repo-lead"])
        source.fail_to = None
        env.now += LATER
        repeated = env.answer_card()
        self.assertEqual(repeated[0], 200)
        self.assertEqual(repeated[1]["message"], f"Got it: repo-lead-1 A at {clock_text(BASE_TIME)} ET")
        sent = answers_sent(source)
        self.assertEqual(sorted(recipient for recipient, body in sent), [STEWARD, "repo-lead"])
        self.assertEqual({json.loads(body)["at"] for recipient, body in sent}, {FIRST})
        self.assertEqual(len({body for recipient, body in sent}), 1)

    def test_a_partial_earlier_send_shows_one_answer_in_the_card_thread(self):
        source, env = self.world(FlakyServer())
        source.fail_to = STEWARD
        env.answer_card()
        source.fail_to = None
        env.now += LATER
        env.answer_card()
        self.assertEqual(self.kinds(env).count("answer"), 1)

    def test_a_third_try_after_a_completed_partial_makes_no_mail(self):
        source, env = self.world(FlakyServer())
        source.fail_to = STEWARD
        env.answer_card()
        source.fail_to = None
        env.now += LATER
        env.answer_card()
        made = creates(source)
        env.now += LATER
        third = env.answer_card()
        self.assertEqual(third[0], 200)
        self.assertEqual(third[1]["message"], f"Got it: repo-lead-1 A at {clock_text(BASE_TIME)} ET")
        self.assertEqual(creates(source), made)
        self.assertEqual(len(answers_sent(source)), 2)

    def test_a_first_attempt_that_sent_nothing_does_not_make_the_next_one_a_repeat(self):
        source, env = self.world(FlakyServer())
        source.fail_to = "repo-lead"
        self.assertEqual(env.answer_card(), BUSY)
        self.assertEqual(answers_sent(source), [])
        source.fail_to = None
        env.now += LATER
        second = env.answer_card()
        self.assertEqual(second[0], 200)
        self.assertEqual(second[1]["message"], f"Got it: repo-lead-1 A at {clock_text(BASE_TIME + LATER)} ET")
        self.assertEqual({json.loads(body)["at"] for recipient, body in answers_sent(source)}, {at_text(BASE_TIME + LATER)})

    def test_another_note_on_the_same_pick_keeps_todays_answer_and_sends_nothing(self):
        source, env = self.world()
        self.assertEqual(env.answer_card(note="Use the first")[0], 200)
        sent = answers_sent(source)
        made = creates(source)
        env.now += LATER
        self.assertEqual(env.answer_card(note="Use the second"), BUSY)
        self.assertEqual(answers_sent(source), sent)
        self.assertEqual(creates(source), made)

    def test_another_pick_is_a_new_answer_with_its_own_time(self):
        source, env = self.world()
        env.answer_card(pick="A")
        env.now += LATER
        second = env.answer_card(pick="B")
        self.assertEqual(second[0], 200)
        self.assertEqual(second[1]["message"], f"Got it: repo-lead-1 B at {clock_text(BASE_TIME + LATER)} ET")
        picks = sorted((recipient, json.loads(body)["pick"]) for recipient, body in answers_sent(source))
        self.assertEqual(picks, [(STEWARD, "A"), (STEWARD, "B"), ("repo-lead", "A"), ("repo-lead", "B")])

    def test_a_busy_send_line_on_a_repeat_stays_503_and_makes_no_mail_request(self):
        source, env = self.world()
        env.answer_card()
        env.now += LATER
        http = len(source.http)
        with mock.patch.object(mail_gateway._SEND_LINE, "take", side_effect=mail_gateway.SendBusy("busy")):
            self.assertEqual(env.answer_card(), BUSY)
        self.assertEqual(len(source.http), http)

    def test_a_card_that_is_not_open_is_still_400_and_sends_nothing(self):
        source, env = self.world()
        before = len(source.http)
        response = answer(env.web.handle(request("POST", "/captain/cards/repo-lead-9/answer", {"rev": 1, "pick": "A", "note": "n", "csrf": "csrf-now"})))
        self.assertEqual(response, (400, {"error": "request refused"}))
        self.assertEqual(len(source.http), before)


class RealCheckerTests(gateway.MailCase):
    def world(self, server=None):
        source = card_world(server, REAL_CARD_SUBJECT, REAL_CARD_BODY)
        holder = {}
        checker = LaneAChecker(REGISTRY, clock=lambda: datetime.fromtimestamp(holder["env"].now, timezone.utc))
        env = AnswerEnv(self, source, checker)
        holder["env"] = env
        env.refresh()
        return source, env

    def test_answering_twice_is_200_both_times_with_the_first_time_and_one_mail_per_recipient(self):
        source, env = self.world()
        first = env.answer_card()
        env.now += LATER
        made = creates(source)
        second = env.answer_card()
        self.assertEqual((first[0], second[0]), (200, 200))
        self.assertEqual(first, second)
        self.assertEqual(first[1]["message"], f"Got it: repo-lead-1 A at {clock_text(BASE_TIME)} ET")
        self.assertEqual(sorted(recipient for recipient, body in answers_sent(source)), [STEWARD, "repo-lead"])
        self.assertEqual({json.loads(body)["at"] for recipient, body in answers_sent(source)}, {FIRST})
        self.assertEqual(creates(source), made)

    def test_the_two_mails_of_one_answer_have_the_same_words_and_the_thread_shows_one_answer(self):
        source, env = self.world()
        env.answer_card()
        env.now += LATER
        env.answer_card()
        self.assertEqual(len({body for recipient, body in answers_sent(source)}), 1)
        env.refresh()
        kinds = [item["kind"] for item in env.service.card("repo-lead-1")["thread"]]
        self.assertEqual(kinds.count("answer"), 1)

    def test_a_partial_earlier_send_is_completed_with_the_words_of_the_first_mail(self):
        source, env = self.world(FlakyServer())
        source.fail_to = STEWARD
        self.assertEqual(env.answer_card(), BUSY)
        source.fail_to = None
        env.now += LATER
        repeated = env.answer_card()
        self.assertEqual(repeated[0], 200)
        self.assertEqual(repeated[1]["message"], f"Got it: repo-lead-1 A at {clock_text(BASE_TIME)} ET")
        sent = dict(answers_sent(source))
        self.assertEqual(sorted(sent), [STEWARD, "repo-lead"])
        self.assertEqual(sent[STEWARD], sent["repo-lead"])
        self.assertEqual(json.loads(sent[STEWARD])["at"], FIRST)

    def test_a_note_the_checker_masks_is_compared_as_masked_and_still_counts_as_a_repeat(self):
        source, env = self.world()
        first = env.answer_card(note=MASKED_NOTE)
        self.assertEqual(first[0], 200)
        self.assertEqual({json.loads(body)["note"] for recipient, body in answers_sent(source)}, {"call [masked] now"})
        env.now += LATER
        made = creates(source)
        second = env.answer_card(note=MASKED_NOTE)
        self.assertEqual(second, first)
        self.assertEqual(creates(source), made)

    def test_another_note_keeps_todays_answer_with_the_real_checker(self):
        source, env = self.world()
        self.assertEqual(env.answer_card(note="Use the first")[0], 200)
        sent = answers_sent(source)
        env.now += LATER
        self.assertEqual(env.answer_card(note="Use the second"), BUSY)
        self.assertEqual(answers_sent(source), sent)

    def test_a_note_that_differs_only_after_masking_is_the_same_answer(self):
        source, env = self.world()
        first = env.answer_card(note="call 203.0.113.5 now")
        env.now += LATER
        second = env.answer_card(note="call 203.0.113.77 now")
        self.assertEqual((first[0], second[0]), (200, 200))
        self.assertEqual(second, first)


class ScriptedMail(FakeMail):
    def __init__(self, messages, script):
        super().__init__(messages)
        self.script = list(script)
        self.asked = []

    def send_answer(self, recipient, subject, body, resend_key):
        self.asked.append((recipient, subject, json.loads(body)["at"], resend_key))
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


class SecondBuildRefused(FixtureChecker):
    errors = ("the rebuilt answer is refused",)

    def build_answers(self, card_id, revision, pick, note, at, poster):
        if self.build_calls:
            self.build_calls.append(("answer", card_id, revision, pick))
            return [], 0, self.errors
        return super().build_answers(card_id, revision, pick, note, at, poster)


class SecondBuildEmpty(SecondBuildRefused):
    errors = ()


class ServiceTests(unittest.TestCase):
    NOW = datetime(2024, 11, 6, 2, 1, tzinfo=timezone.utc)
    EARLY = "2024-11-05T20:56:00-05:00"
    LATE = "2024-11-05T20:58:30-05:00"

    def world(self, script, checker=None, poster="repo-lead"):
        mail = ScriptedMail([message("m1", poster, "CARD: Choose", card("repo-lead-1", "Repo" if poster == "repo-lead" else "Fleet", "Launch", "Choose"))], script)
        checker = checker if checker is not None else FixtureChecker()
        service = cards.CardService(mail, checker)
        service.refresh()
        return mail, checker, service

    def answered(self, service):
        return service.answer("repo-lead-1", 1, "A", "Use the first", now=self.NOW)

    def test_no_repeat_sends_every_mail_with_this_requests_time_and_builds_once(self):
        mail, checker, service = self.world([None, None])
        receipt = self.answered(service)
        self.assertEqual(receipt["message"], "Got it: repo-lead-1 A at 9:01 PM ET")
        self.assertEqual([(entry[0], entry[2]) for entry in mail.asked], [("repo-lead", "2024-11-05T21:01:00-05:00"), ("bot-a", "2024-11-05T21:01:00-05:00")])
        self.assertEqual(len([call for call in checker.build_calls if call[0] == "answer"]), 1)

    def test_the_mails_go_to_the_poster_then_the_steward_with_their_own_keys(self):
        mail, checker, service = self.world([None, None])
        self.answered(service)
        self.assertEqual(
            [(entry[0], entry[1], entry[3]) for entry in mail.asked],
            [
                ("repo-lead", "ANSWER: repo-lead-1 A", "answer:repo-lead-1:rev1:A:to-repo-lead"),
                ("bot-a", "ANSWER: repo-lead-1 A", "answer:repo-lead-1:rev1:A:to-bot-a"),
            ],
        )

    def test_a_repeat_at_the_poster_shows_the_first_time_and_rebuilds_the_missing_mail_with_it(self):
        mail, checker, service = self.world([self.EARLY, None])
        receipt = self.answered(service)
        self.assertEqual(receipt["message"], "Got it: repo-lead-1 A at 8:56 PM ET")
        self.assertEqual([entry[2] for entry in mail.asked], ["2024-11-05T21:01:00-05:00", self.EARLY])
        self.assertEqual(len([call for call in checker.build_calls if call[0] == "answer"]), 2)

    def test_the_rebuilt_mail_is_checked_again_before_it_is_sent(self):
        mail, checker, service = self.world([self.EARLY, None])
        checker.calls.clear()
        self.answered(service)
        self.assertEqual(len([call for call in checker.calls if call[1] == "account-user"]), 2)

    def test_a_repeat_at_every_recipient_makes_no_rebuild_the_second_time_and_shows_the_first_time(self):
        mail, checker, service = self.world([self.EARLY, self.EARLY])
        receipt = self.answered(service)
        self.assertEqual(receipt["message"], "Got it: repo-lead-1 A at 8:56 PM ET")
        self.assertEqual([entry[2] for entry in mail.asked], ["2024-11-05T21:01:00-05:00", self.EARLY])
        self.assertEqual(len([call for call in checker.build_calls if call[0] == "answer"]), 2)

    def test_when_the_kept_times_differ_the_earliest_is_shown(self):
        for script in ([self.EARLY, self.LATE], [self.LATE, self.EARLY]):
            with self.subTest(script=script):
                mail, checker, service = self.world(script)
                self.assertEqual(self.answered(service)["message"], "Got it: repo-lead-1 A at 8:56 PM ET")

    def test_a_repeat_that_is_not_earlier_than_the_one_found_changes_nothing(self):
        mail, checker, service = self.world([self.EARLY, self.LATE])
        self.assertEqual(self.answered(service)["message"], "Got it: repo-lead-1 A at 8:56 PM ET")
        self.assertEqual(len([call for call in checker.build_calls if call[0] == "answer"]), 2)

    def test_a_poster_who_is_the_steward_gets_one_mail_and_a_repeat_shows_the_first_time(self):
        mail, checker, service = self.world([self.EARLY], poster="bot-a")
        receipt = self.answered(service)
        self.assertEqual(receipt["message"], "Got it: repo-lead-1 A at 8:56 PM ET")
        self.assertEqual([entry[0] for entry in mail.asked], ["bot-a"])
        self.assertEqual(len([call for call in checker.build_calls if call[0] == "answer"]), 1)

    def test_an_error_from_the_first_recipient_passes_through_and_the_second_is_not_tried(self):
        failure = OSError("down")
        mail, checker, service = self.world([failure, None])
        with self.assertRaises(OSError) as caught:
            self.answered(service)
        self.assertIs(caught.exception, failure)
        self.assertEqual([entry[0] for entry in mail.asked], ["repo-lead"])

    def test_an_error_from_the_second_recipient_passes_through(self):
        failure = qd_jmap.Refused("other words")
        mail, checker, service = self.world([None, failure])
        with self.assertRaises(qd_jmap.Refused) as caught:
            self.answered(service)
        self.assertIs(caught.exception, failure)

    def test_a_rebuild_the_checker_refuses_is_a_card_refusal_and_the_second_mail_is_not_sent(self):
        mail, checker, service = self.world([self.EARLY, None], checker=SecondBuildRefused())
        with self.assertRaises(cards.CardRefused):
            self.answered(service)
        self.assertEqual([entry[0] for entry in mail.asked], ["repo-lead"])

    def test_a_rebuild_that_loses_a_recipient_is_a_card_refusal_and_nothing_more_is_sent(self):
        mail, checker, service = self.world([self.EARLY, None], checker=SecondBuildEmpty())
        with self.assertRaises(cards.CardRefused):
            self.answered(service)
        self.assertEqual([entry[0] for entry in mail.asked], ["repo-lead"])

    def test_an_unusable_first_time_is_not_trusted(self):
        for kept in ("later", "2024-11-05T20:56:00", 5):
            with self.subTest(kept=kept):
                mail, checker, service = self.world([kept, None])
                with self.assertRaises((ValueError, TypeError, cards.CardRefused)):
                    self.answered(service)

    def test_the_receipt_keeps_its_other_fields(self):
        mail, checker, service = self.world([self.EARLY, None])
        receipt = self.answered(service)
        self.assertEqual({key: receipt[key] for key in ("stale", "rev")}, {"stale": False, "rev": 1})
        self.assertEqual(set(receipt), {"message", "stale", "rev"})


class NoCommentsTests(unittest.TestCase):
    def test_this_file_has_no_comments_or_docstrings(self):
        source = Path(__file__).read_text(encoding="utf-8")
        comments = [token for token in tokenize.generate_tokens(io.StringIO(source).readline) if token.type == tokenize.COMMENT]
        self.assertEqual(comments, [])
        tree = ast.parse(source)
        docs = [node for node in ast.walk(tree) if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef)) and ast.get_docstring(node)]
        self.assertEqual(docs, [])
        self.assertNotIn("\u2014", source)
        self.assertNotIn("\u2013", source)
