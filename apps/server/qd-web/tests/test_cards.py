import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

import cards
import live
from checker_adapter import CheckResult


class FakeMail:
    def __init__(self, messages=()):
        self.inbox = list(messages)
        self.sent = []

    def messages(self):
        return list(self.inbox)

    def send(self, recipient, subject, body, resend_key):
        self.sent.append((recipient, subject, body, resend_key))
        return f"sent-{len(self.sent)}"

    def send_chat(self, recipient, subject, body, resend_key):
        return self.send(recipient, subject, body, resend_key), json.loads(body)["fresh"]


class FixtureChecker:
    def __init__(self):
        self.calls = []
        self.build_calls = []
        self.registry = {
            "Repo": "repo-lead",
            "Fleet": "bot-a",
            "Beta": "bot-b",
            "New": "bot-d",
        }
        self.account_name = "account-user"
        self.oversight_bot = "bot-a"
        self.active_bots = frozenset(self.registry.values())
    def check(
        self,
        subject,
        body,
        *,
        sender,
        poster=None,
        base=None,
        current_rev=None,
    ):
        self.calls.append((subject, sender))
        try:
            document = json.loads(body)
        except ValueError:
            return CheckResult(None, ("body must be JSON",), False)
        kind = document.get("qd")
        errors = () if (
            kind in {
                "card/1",
                "update/1",
                "withdraw/1",
                "comment/1",
                "answer/1",
            }
            and document.get("valid", True)
        ) else ("card refused",)
        ownership_refused = False
        if not errors and kind == "card/1":
            if self.registry.get(document.get("project")) != sender:
                errors = ("project: owner",)
                ownership_refused = True
        if not errors and kind in {"update/1", "withdraw/1"}:
            if poster is None:
                errors = ("card: unknown-card",)
                ownership_refused = True
            elif sender not in {poster, self.oversight_bot}:
                errors = ("sender: owner",)
                ownership_refused = True
        if not errors and kind == "answer/1" and sender != self.account_name:
            errors = ("sender: owner",)
            ownership_refused = True
        merged = None
        if not errors and kind == "update/1":
            merged = {
                **base,
                **{
                    key: value
                    for key, value in document.items()
                    if key not in {"qd", "card", "rev"}
                },
            }
        return CheckResult(document, errors, ownership_refused, merged)

    def build_answers(
        self,
        card_id,
        revision,
        pick,
        note,
        at,
        poster,
    ):
        self.build_calls.append(("answer", card_id, revision, pick))
        body = json.dumps(
            {
                "qd": "answer/1",
                "card": card_id,
                "rev": revision,
                "pick": pick,
                "note": note,
                "at": at,
            },
            separators=(",", ":"),
        )
        recipients = [poster] + (
            [] if poster == self.oversight_bot else [self.oversight_bot]
        )
        return (
            [
                (
                    recipient,
                    f"ANSWER: {card_id} {pick}",
                    body,
                    (
                        f"answer:{card_id}:rev{revision}:{pick}:"
                        f"to-{recipient}"
                    ),
                )
                for recipient in recipients
            ],
            0,
            (),
        )

    def build_comment(self, card_id, text):
        self.build_calls.append(("comment", card_id, text))
        return (
            (
                f"COMMENT: {card_id}",
                json.dumps(
                    {
                        "qd": "comment/1",
                        "card": card_id,
                        "text": text,
                    },
                    separators=(",", ":"),
                ),
                f"comment:{card_id}:standin",
            ),
            (),
        )


def message(mail_id, sender, subject, document, sent="2026-11-02T10:00:00-05:00"):
    body = document if isinstance(document, str) else json.dumps(document, separators=(",", ":"))
    return cards.MailMessage(mail_id, sender, subject, body, sent)


def card(card_id, project, lane, title, **extra):
    return {
        "qd": "card/1",
        "id": card_id,
        "project": project,
        "lane": lane,
        "title": title,
        "options": [{"label": "A. First"}, {"label": "B. Second"}],
        **extra,
    }


class CardInboxTests(unittest.TestCase):
    def test_list_builds_projects_lanes_and_cards_and_routes_refusals(self):
        mail = FakeMail([
            message("m1", "repo-lead", "CARD: Choose", card("repo-lead-1", "Repo", "Launch", "Choose")),
            message("m2", "bot-a", "CARD: Fleet", card("bot-a-1", "Fleet", "Ops", "Fleet")),
            message("m3", "bot-x", "CARD: Wrong", card("bot-x-1", "Repo", "Launch", "Wrong")),
            message("m4", "repo-lead", "CARD: Broken", card("repo-lead-2", "Repo", "Launch", "Broken", valid=False)),
        ])
        service = cards.CardService(mail, FixtureChecker())

        listing = service.refresh()

        self.assertEqual(
            [(project["name"], [(lane["name"], [item["id"] for item in lane["cards"]]) for lane in project["lanes"]]) for project in listing["projects"]],
            [("Fleet", [("Ops", ["bot-a-1"])]), ("Repo", [("Launch", ["repo-lead-1"])])],
        )
        repo_card = listing["projects"][1]["lanes"][0]["cards"][0]
        self.assertEqual(
            repo_card,
            {
                "id": "repo-lead-1",
                "title": "Choose",
                "project": "Repo",
                "lane": "Launch",
                "due": None,
                "state": "open",
                "changed-at": "2026-11-02T10:00:00-05:00",
                "from": "repo-lead",
                "rev": 1,
                "answer": None,
                "waitsOn": None,
            },
        )
        self.assertEqual(listing["plainMail"], [{
            "id": "m4",
            "sender": "repo-lead",
            "subject": "CARD: Broken",
            "sent": "2026-11-02T10:00:00-05:00",
            "buttons": False,
            "errors": ["card refused"],
        }])
        self.assertEqual(mail.sent, [
            ("bot-a", "REFUSED CARD: bot-x-1", "project: owner", "refused:m3")
        ])
        self.assertNotIn("bot-x-1", json.dumps(listing))

    def test_answer_is_exactly_once_and_accepts_an_older_revision_with_a_flag(self):
        mail = FakeMail([
            message("m1", "repo-lead", "CARD: Choose", card("repo-lead-1", "Repo", "Launch", "Choose")),
            message("m2", "repo-lead", "UPDATE: repo-lead-1", {
                "qd": "update/1",
                "card": "repo-lead-1",
                "rev": 2,
                "title": "Choose again",
                "options": [{"label": "A. New first"}, {"label": "B. New second"}],
            }),
        ])
        checker = FixtureChecker()
        service = cards.CardService(mail, checker)
        service.refresh()
        now = datetime(2026, 11, 2, 18, 5, tzinfo=timezone.utc)

        receipt = service.answer("repo-lead-1", 1, "A", "Use the first", now=now)
        repeated = service.answer("repo-lead-1", 1, "A", "Use the first", now=now)

        self.assertEqual(receipt, repeated)
        self.assertEqual(receipt, {
            "message": "Got it: repo-lead-1 A at 1:05 PM ET",
            "stale": True,
            "rev": 1,
        })
        self.assertEqual([entry[0] for entry in mail.sent], ["repo-lead", "bot-a", "repo-lead", "bot-a"])
        self.assertEqual(
            [entry[1] for entry in mail.sent],
            ["ANSWER: repo-lead-1 A"] * 4,
        )
        bodies = [json.loads(entry[2]) for entry in mail.sent]
        self.assertEqual(bodies[0], {
            "qd": "answer/1",
            "card": "repo-lead-1",
            "rev": 1,
            "pick": "A",
            "note": "Use the first",
            "at": "2026-11-02T13:05:00-05:00",
        })
        self.assertEqual(bodies, [bodies[0]] * 4)
        self.assertEqual(
            [entry[3] for entry in mail.sent],
            [
                "answer:repo-lead-1:rev1:A:to-repo-lead",
                "answer:repo-lead-1:rev1:A:to-bot-a",
                "answer:repo-lead-1:rev1:A:to-repo-lead",
                "answer:repo-lead-1:rev1:A:to-bot-a",
            ],
        )
        self.assertEqual(
            [call for call in checker.calls if call[1] == "account-user"],
            [
                ("ANSWER: repo-lead-1 A", "account-user"),
                ("ANSWER: repo-lead-1 A", "account-user"),
            ],
        )
        with self.assertRaises(cards.CardRefused):
            service.answer("repo-lead-1", 1, "C", "", now=now)

    def test_one_card_returns_latest_revision_and_its_whole_thread(self):
        mail = FakeMail([
            message("m1", "repo-lead", "CARD: Choose", card("repo-lead-1", "Repo", "Launch", "Choose")),
            message("m2", "other-bot", "COMMENT: repo-lead-1", {
                "qd": "comment/1",
                "card": "repo-lead-1",
                "text": "Extra context",
            }),
            message("m3", "bot-a", "UPDATE: repo-lead-1", {
                "qd": "update/1",
                "card": "repo-lead-1",
                "rev": 2,
                "title": "Choose now",
            }),
            message("m4", "account-user", "ANSWER: repo-lead-1 A", {
                "qd": "answer/1",
                "card": "repo-lead-1",
                "rev": 1,
                "pick": "A",
                "note": "",
                "at": "2026-11-02T13:05:00-05:00",
            }),
            message("m5", "repo-lead", "WITHDRAW: repo-lead-1", {
                "qd": "withdraw/1",
                "card": "repo-lead-1",
                "why": "No longer needed",
            }),
        ])
        service = cards.CardService(mail, FixtureChecker())
        service.refresh()

        found = service.card("repo-lead-1")

        self.assertEqual(found["card"]["title"], "Choose now")
        self.assertEqual((found["rev"], found["state"]), (2, "withdrawn"))
        self.assertEqual(
            [(item["kind"], item["sender"]) for item in found["thread"]],
            [
                ("card", "repo-lead"),
                ("comment", "other-bot"),
                ("update", "bot-a"),
                ("answer", "account-user"),
                ("withdraw", "repo-lead"),
            ],
        )
        self.assertEqual(found["thread"][1]["document"]["text"], "Extra context")

    def test_comments_and_bot_chat_send_as_configured_account_with_stable_keys(self):
        mail = FakeMail([
            message("m1", "repo-lead", "CARD: Choose", card("repo-lead-1", "Repo", "Launch", "Choose")),
            message("m2", "bot-a", "CHAT: bot-a", {
                "qd": "chat/1",
                "bot": "bot-a",
                "text": "Ready?",
            }),
            message("m3", "account-user", "CHAT: bot-a", {
                "qd": "chat/1",
                "bot": "bot-a",
                "text": "Yes",
            }),
        ])
        checker = FixtureChecker()
        service = cards.CardService(mail, checker)
        service.refresh()

        service.comment("repo-lead-1", "One detail", "request-1")
        service.send_chat("bot-a", "Go ahead", "request-2")

        self.assertEqual(
            service.chat("bot-a"),
            {
                "bot": {"id": "bot-a"},
                "messages": [
                    {
                        "id": "m2",
                        "from": "bot",
                        "text": "Ready?",
                        "at": "2026-11-02T10:00:00-05:00",
                    },
                    {
                        "id": "m3",
                        "from": "account",
                        "text": "Yes",
                        "at": "2026-11-02T10:00:00-05:00",
                    },
                ],
                "seenUpTo": None,
                "writing": False,
            },
        )
        self.assertEqual([entry[0] for entry in mail.sent], ["repo-lead", "bot-a", "bot-a"])
        self.assertEqual(
            [entry[1] for entry in mail.sent],
            ["COMMENT: repo-lead-1", "COMMENT: repo-lead-1", "CHAT: bot-a"],
        )
        self.assertEqual(
            [entry[3] for entry in mail.sent],
            [
                "comment:repo-lead-1:standin:to-repo-lead",
                "comment:repo-lead-1:standin:to-bot-a",
                "chat:bot-a:request-2",
            ],
        )
        self.assertEqual(json.loads(mail.sent[0][2]), {
            "qd": "comment/1",
            "card": "repo-lead-1",
            "text": "One detail",
        })
        self.assertEqual(json.loads(mail.sent[2][2]), {
            "qd": "chat/1",
            "bot": "bot-a",
            "text": "Go ahead",
            "clientId": "request-2",
            "fresh": False,
        })
        self.assertIn(("COMMENT: repo-lead-1", "account-user"), checker.calls)

    def test_chat_list_contains_every_fresh_listed_bot(self):
        mail = FakeMail(
            [
                message(
                    "m4",
                    "bot-d",
                    "CHAT: bot-d",
                    {
                        "qd": "chat/1",
                        "bot": "bot-d",
                        "text": "Fourth bot online",
                    },
                )
            ]
        )
        service = cards.CardService(
            mail, FixtureChecker(),
            bot_source=lambda: {"bot-a", "bot-b", "bot-d", "repo-lead"},
        )
        service.refresh()

        rows = service.chat_list()

        self.assertEqual(
            [row["id"] for row in rows],
            ["bot-d", "bot-a", "bot-b", "repo-lead"],
        )
        fourth = rows[0]
        self.assertEqual(fourth["preview"], "Fourth bot online")
        self.assertEqual(
            fourth["at"],
            "2026-11-02T10:00:00-05:00",
        )
        self.assertFalse(fourth["unread"])


    def test_chat_uses_registry_accounts_and_accepts_a_new_fourth_bot(self):
        class ConfiguredChecker(FixtureChecker):
            account_name = "account-user"
            oversight_bot = "bot-a"
            active_bots = frozenset({"bot-a", "bot-b", "bot-d"})

        mail = FakeMail(
            [
                message(
                    "malformed",
                    "bot-d",
                    "CHAT: bot-d",
                    [],
                ),
                message(
                    "m1",
                    "bot-d",
                    "CHAT: bot-d",
                    {
                        "qd": "chat/1",
                        "bot": "bot-d",
                        "text": "Ready?",
                    },
                ),
                message(
                    "m2",
                    "account-user",
                    "CHAT: bot-d",
                    {
                        "qd": "chat/1",
                        "bot": "bot-d",
                        "text": "Yes",
                        "clientId": "request-3",
                    },
                ),
            ]
        )
        service = cards.CardService(mail, ConfiguredChecker(), bot_source=lambda: {"bot-d"})
        service.refresh()

        thread = service.chat("bot-d")
        self.assertEqual(thread["bot"], {"id": "bot-d"})
        self.assertIsNone(thread["seenUpTo"])
        self.assertFalse(thread["writing"])
        self.assertEqual(
            thread["messages"],
            [
                {
                    "id": "m1",
                    "from": "bot",
                    "text": "Ready?",
                    "at": "2026-11-02T10:00:00-05:00",
                },
                {
                    "id": "m2",
                    "clientId": "request-3",
                    "from": "account",
                    "text": "Yes",
                    "at": "2026-11-02T10:00:00-05:00",
                },
            ],
        )
        service.send_chat("bot-d", "Go ahead", "request-4")
        self.assertEqual(mail.sent[-1][0], "bot-d")
        self.assertEqual(
            json.loads(mail.sent[-1][2])["clientId"],
            "request-4",
        )
        with self.assertRaises(cards.CardRefused):
            service.chat("unknown-bot")

    def test_first_screen_listing_is_bounded_and_marks_omitted_mail(self):
        messages = [
            message(
                f"card-{number}",
                "repo-lead",
                f"CARD: Choice {number}",
                card(
                    f"repo-lead-{number}",
                    "Repo",
                    "Launch",
                    f"Choice {number}",
                ),
            )
            for number in range(1, 206)
        ]
        messages.extend(
            message(
                f"broken-{number}",
                "repo-lead",
                "CARD: Broken",
                "not-json-" + ("x" * 5000),
            )
            for number in range(25)
        )
        service = cards.CardService(
            FakeMail(messages),
            FixtureChecker(),
        )

        listing = service.refresh()

        shown_cards = sum(
            len(lane["cards"])
            for project in listing["projects"]
            for lane in project["lanes"]
        )
        self.assertEqual(shown_cards, cards.MAX_LIST_CARDS)
        self.assertEqual(
            len(listing["plainMail"]),
            cards.MAX_LIST_PLAIN_MAIL,
        )
        self.assertTrue(listing["truncated"])
        self.assertTrue(
            all(
                "body" not in item
                for item in listing["plainMail"]
            )
        )
        self.assertLess(len(json.dumps(listing).encode()), 64 * 1024)

    def test_failed_refresh_keeps_the_last_complete_card_index(self):
        class FailingMail(FakeMail):
            fail = False

            def messages(self):
                if self.fail:
                    raise RuntimeError("stand-in inbox failure")
                return super().messages()

        mail = FailingMail(
            [
                message(
                    "card-1",
                    "repo-lead",
                    "CARD: Choice",
                    card(
                        "repo-lead-1",
                        "Repo",
                        "Launch",
                        "Choice",
                    ),
                )
            ]
        )
        service = cards.CardService(
            mail,
            FixtureChecker(),
        )
        service.refresh()
        mail.fail = True

        with self.assertRaises(RuntimeError):
            service.refresh()

        self.assertEqual(
            service.card("repo-lead-1")["card"]["title"],
            "Choice",
        )

    def test_31_card_first_screen_payload_stays_under_eight_kib(self):
        service = cards.CardService(
            FakeMail([
                message(
                    f"card-{number}",
                    "repo-lead",
                    f"CARD: Choice {number}",
                    card(
                        f"repo-lead-{number}",
                        "Repo",
                        "Launch",
                        f"Choice {number}",
                        due="2026-11-03T09:00:00-05:00",
                    ),
                )
                for number in range(1, 32)
            ]),
            FixtureChecker(),
        )

        listing = service.refresh()
        encoded = json.dumps(
            listing,
            separators=(",", ":"),
        ).encode()

        self.assertLess(len(encoded), 8 * 1024)
        readme = (Path(__file__).resolve().parent.parent / "qd-web" / "README.md").read_text(encoding="utf-8")
        self.assertIn(f"is {len(encoded)} bytes uncompressed", readme)
        for project in listing["projects"]:
            for lane in project["lanes"]:
                for summary in lane["cards"]:
                    self.assertEqual(
                        set(summary),
                        {
                            "id",
                            "title",
                            "project",
                            "lane",
                            "due",
                            "state",
                            "changed-at",
                            "from",
                            "rev",
                            "answer",
                            "waitsOn",
                        },
                    )


class ChatSetTests(unittest.TestCase):
    @staticmethod
    def chat_message(mail_id, sender, bot, text):
        return message(
            mail_id,
            sender,
            f"CHAT: {bot}",
            {"qd": "chat/1", "bot": bot, "text": text},
        )

    def test_fresh_listed_chat_bots_can_be_written_to(self):
        mail = FakeMail([self.chat_message("m1", "fern", "fern", "Hello from Fern")])
        service = cards.CardService(
            mail,
            FixtureChecker(),
            chat_bots=(("fern", None), ("dale", None)),
            bot_source=lambda: {"fern", "dale"},
        )
        service.refresh()

        ids = [row["id"] for row in service.chat_list()]

        self.assertIn("fern", ids)
        self.assertIn("dale", ids)
        self.assertEqual(
            sorted(ids),
            ["bot-a", "dale", "fern"],
        )
        self.assertEqual(service.chat("fern")["messages"][0]["text"], "Hello from Fern")
        service.send_chat("fern", "Hi Fern", "request-1")
        service.send_chat("dale", "Hi Dale", "request-2")
        self.assertEqual(
            [(item[0], item[1]) for item in mail.sent],
            [("fern", "CHAT: fern"), ("dale", "CHAT: dale")],
        )

    def test_an_unlisted_bot_is_still_refused_for_read_and_send(self):
        service = cards.CardService(
            FakeMail(),
            FixtureChecker(),
            chat_bots=(("fern", None),),
        )

        with self.assertRaises(cards.CardRefused):
            service.chat("stranger")
        with self.assertRaises(cards.CardRefused):
            service.send_chat("stranger", "Hi", "request-1")
        with self.assertRaises(cards.CardRefused):
            service.send_chat("dale", "Hi", "request-1")

    def test_without_a_fresh_source_only_the_oversight_bot_is_allowed(self):
        service = cards.CardService(FakeMail(), FixtureChecker())

        ids = [row["id"] for row in service.chat_list()]

        self.assertEqual(ids, ["bot-a"])
        with self.assertRaises(cards.CardRefused):
            service.chat("fern")

    def test_the_note_is_returned_only_for_the_bot_that_has_one(self):
        service = cards.CardService(
            FakeMail(),
            FixtureChecker(),
            chat_bots=(("fern", None), ("dale", "A short note")),
            bot_source=lambda: {"fern", "dale"},
        )

        self.assertEqual(service.chat("dale")["bot"], {"id": "dale", "note": "A short note"})
        self.assertEqual(service.chat("fern")["bot"], {"id": "fern"})
        self.assertEqual(service.chat("bot-a")["bot"], {"id": "bot-a"})

    def test_the_captains_own_account_name_cannot_be_a_chat_bot(self):
        with self.assertRaises(cards.CardRefused):
            cards.CardService(
                FakeMail(),
                FixtureChecker(),
                chat_bots=(("account-user", None),),
            )

    def test_card_logic_is_unchanged_by_the_chat_set(self):
        inbox = [
            message("m1", "repo-lead", "CARD: Choose", card("repo-lead-1", "Repo", "Launch", "Choose")),
            message("m2", "fern", "CARD: Wrong", card("fern-1", "Repo", "Launch", "Wrong")),
        ]
        plain_mail = FakeMail(list(inbox))
        named_mail = FakeMail(list(inbox))
        plain = cards.CardService(plain_mail, FixtureChecker())
        named = cards.CardService(
            named_mail,
            FixtureChecker(),
            chat_bots=(("fern", None), ("dale", None)),
        )

        self.assertEqual(named.refresh(), plain.refresh())
        self.assertEqual(named_mail.sent, plain_mail.sent)
        self.assertEqual(named.active_bots, plain.active_bots)
        self.assertNotIn("fern", named.active_bots)
        self.assertNotIn("dale", named.active_bots)


class CountingSource:
    def __init__(self, *names):
        self.names = set(names)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return frozenset(self.names)


class ChatSourceTests(unittest.TestCase):
    @staticmethod
    def chat_messages(count):
        bots = ["fern", "bot-a", "dale"]
        return [
            message(
                f"m{number}",
                bots[number % 3],
                f"CHAT: {bots[number % 3]}",
                {"qd": "chat/1", "bot": bots[number % 3], "text": f"Message {number}"},
            )
            for number in range(count)
        ]

    def test_a_bot_source_grants_names_but_registry_and_runtime_do_not(self):
        source = CountingSource("dale")
        service = cards.CardService(
            FakeMail(),
            FixtureChecker(),
            chat_bots=(("fern", None),),
            bot_source=source,
        )

        ids = sorted(row["id"] for row in service.chat_list())

        self.assertEqual(ids, ["bot-a", "dale"])

    def test_the_static_extras_do_not_grant_when_the_source_is_empty(self):
        service = cards.CardService(
            FakeMail(),
            FixtureChecker(),
            chat_bots=(("fern", None),),
            bot_source=CountingSource(),
        )

        ids = sorted(row["id"] for row in service.chat_list())

        self.assertEqual(ids, ["bot-a"])

    def test_every_public_chat_operation_reads_the_source_once(self):
        source = CountingSource("fern", "dale")
        mail = FakeMail(self.chat_messages(60))
        service = cards.CardService(mail, FixtureChecker(), bot_source=source)
        service.refresh()

        for label, call, args in (
            ("list", service.chat_list, ()),
            ("open", service.chat, ("fern",)),
            ("send", service.send_chat, ("fern", "Hi", "request-1")),
        ):
            with self.subTest(label):
                source.calls = 0
                call(*args)
                self.assertEqual(source.calls, 1)

    def test_the_source_is_read_again_by_each_operation(self):
        source = CountingSource("fern")
        service = cards.CardService(FakeMail(), FixtureChecker(), bot_source=source)

        service.chat_list()
        service.chat_list()
        service.chat("fern")
        service.send_chat("fern", "Hi", "request-1")

        self.assertEqual(source.calls, 4)

    def test_a_name_the_source_drops_is_refused_on_the_next_operation(self):
        source = CountingSource("fern", "dale")
        mail = FakeMail()
        service = cards.CardService(mail, FixtureChecker(), bot_source=source)
        service.send_chat("fern", "Hi", "request-1")

        source.names.discard("fern")

        with self.assertRaises(cards.CardRefused):
            service.send_chat("fern", "Hi", "request-2")
        with self.assertRaises(cards.CardRefused):
            service.chat("fern")
        self.assertNotIn("fern", [row["id"] for row in service.chat_list()])
        service.send_chat("dale", "Hi", "request-3")
        self.assertEqual([item[0] for item in mail.sent], ["fern", "dale"])

    def test_the_source_cannot_add_the_captains_account(self):
        service = cards.CardService(
            FakeMail(),
            FixtureChecker(),
            bot_source=CountingSource("account-user", "fern"),
        )

        ids = [row["id"] for row in service.chat_list()]

        self.assertNotIn("account-user", ids)
        self.assertIn("fern", ids)
        with self.assertRaises(cards.CardRefused):
            service.chat("account-user")
        with self.assertRaises(cards.CardRefused):
            service.send_chat("account-user", "Hi", "request-1")

    def test_the_oversight_bot_is_allowed_when_the_source_is_empty(self):
        mail = FakeMail()
        service = cards.CardService(mail, FixtureChecker(), bot_source=CountingSource())

        service.send_chat("bot-a", "Hi", "request-1")

        self.assertEqual(mail.sent[0][0], "bot-a")
        self.assertEqual(service.chat("bot-a")["bot"], {"id": "bot-a"})

    def test_without_a_source_only_oversight_is_allowed(self):
        service = cards.CardService(FakeMail(), FixtureChecker(), bot_source=None)

        ids = sorted(row["id"] for row in service.chat_list())

        self.assertEqual(ids, ["bot-a"])


class ChatRowMarkerTests(unittest.TestCase):
    @staticmethod
    def chat(mail_id, sender, bot, text="Hi", body=None):
        return message(
            mail_id,
            sender,
            f"CHAT: {bot}",
            body if body is not None else {"qd": "chat/1", "bot": bot, "text": text},
        )

    @staticmethod
    def rows(service):
        return {row["id"]: row for row in service.chat_list()}

    def test_every_row_has_exactly_the_five_keys_and_last_is_a_string(self):
        mail = FakeMail([self.chat("m1", "bot-d", "bot-d")])
        service = cards.CardService(
            mail, FixtureChecker(), bot_source=lambda: {"bot-d"},
        )
        service.refresh()

        for row in service.chat_list():
            self.assertEqual(set(row), {"id", "preview", "at", "last", "unread", "rev"})
            self.assertIsInstance(row["last"], str)

    def test_last_is_the_id_of_the_newest_message_and_empty_for_a_chat_with_none(self):
        mail = FakeMail(
            [
                self.chat("m1", "bot-d", "bot-d", "Ready?"),
                self.chat("m2", "account-user", "bot-d", "Yes"),
                self.chat("m3", "bot-a", "bot-a", "Hello"),
            ]
        )
        service = cards.CardService(
            mail, FixtureChecker(),
            bot_source=lambda: {"bot-a", "bot-b", "bot-d", "repo-lead"},
        )
        service.refresh()

        rows = self.rows(service)

        self.assertEqual(rows["bot-d"]["last"], "m2")
        self.assertEqual(rows["bot-a"]["last"], "m3")
        self.assertEqual(rows["bot-b"]["last"], "")
        self.assertEqual(rows["repo-lead"]["last"], "")

    def test_a_new_message_with_the_same_time_and_text_moves_last_but_not_the_other_keys(self):
        mail = FakeMail([self.chat("m1", "bot-d", "bot-d", "Same")])
        service = cards.CardService(mail, FixtureChecker(), bot_source=lambda: {"bot-d"})
        service.refresh()
        before = self.rows(service)["bot-d"]

        mail.inbox.append(self.chat("m2", "bot-d", "bot-d", "Same"))
        service.refresh()
        after = self.rows(service)["bot-d"]

        self.assertEqual((before["at"], before["preview"]), (after["at"], after["preview"]))
        self.assertEqual((before["last"], after["last"]), ("m1", "m2"))

    def test_messages_the_chat_would_not_show_never_move_last(self):
        mail = FakeMail(
            [
                self.chat("m1", "bot-d", "bot-d"),
                self.chat("m2", "bot-d", "bot-d", body=[]),
                self.chat("m3", "stranger", "bot-d"),
                self.chat("m4", "bot-d", "bot-d", body={"qd": "chat/1", "bot": "bot-a", "text": "Wrong bot"}),
            ]
        )
        service = cards.CardService(mail, FixtureChecker(), bot_source=lambda: {"bot-d"})
        service.refresh()

        self.assertEqual(self.rows(service)["bot-d"]["last"], "m1")

    def test_a_file_bot_row_carries_last_too(self):
        mail = FakeMail([self.chat("m1", "fern", "fern")])
        service = cards.CardService(mail, FixtureChecker(), bot_source=lambda: {"fern", "dale"})
        service.refresh()

        rows = self.rows(service)

        self.assertEqual((rows["fern"]["last"], rows["dale"]["last"]), ("m1", ""))

    def test_the_live_check_sees_a_same_time_message_and_nothing_else(self):
        mail = FakeMail([self.chat("m1", "bot-d", "bot-d", "Same")])
        service = cards.CardService(mail, FixtureChecker(), bot_source=lambda: {"bot-d"})
        updates = live.LiveUpdates(service)

        self.assertTrue(updates.check_once())
        self.assertFalse(updates.check_once())
        mail.inbox.append(self.chat("m2", "bot-d", "bot-d", "Same"))
        self.assertTrue(updates.check_once())
        self.assertFalse(updates.check_once())


class RemovingChecker(FixtureChecker):
    def check(self, subject, body, **facts):
        result = super().check(subject, body, **facts)
        if result.merged is None:
            return result
        removed = {key: value for key, value in result.merged.items() if value is not None}
        return CheckResult(result.document, result.errors, result.ownership_refused, removed)


class CardSummaryFieldTests(unittest.TestCase):
    CARD_SENT = "2026-11-02T10:00:00-05:00"
    UPDATE_SENT = "2026-11-02T11:00:00-05:00"
    ANSWER_SENT = "2026-11-02T13:05:30-05:00"
    ANSWER_AT = "2026-11-02T13:05:00-05:00"
    LATER_SENT = "2026-11-02T13:10:30-05:00"
    LATER_AT = "2026-11-02T13:10:00-05:00"
    WITHDRAW_SENT = "2026-11-02T14:00:00-05:00"
    KEYS = {
        "id", "title", "project", "lane", "due", "state", "changed-at",
        "from", "rev", "answer", "waitsOn",
    }

    def posted(self, mail_id="m1", card_id="repo-lead-1", project="Repo", lane="Launch", sender="repo-lead"):
        return message(mail_id, sender, "CARD: Choose", card(card_id, project, lane, "Choose"), self.CARD_SENT)

    def update(self, mail_id, revision, sent, sender="bot-a", title="Choose again", card_id="repo-lead-1", **changes):
        return message(mail_id, sender, f"UPDATE: {card_id}", {
            "qd": "update/1", "card": card_id, "rev": revision, "title": title, **changes,
        }, sent)

    def answered(self, mail_id, pick, at, sent, sender="account-user", valid=True, card_id="repo-lead-1"):
        return message(mail_id, sender, f"ANSWER: {card_id} {pick}", {
            "qd": "answer/1", "card": card_id, "rev": 1, "pick": pick, "note": "", "at": at, "valid": valid,
        }, sent)

    def withdrawn(self, mail_id, sent, card_id="repo-lead-1", sender="repo-lead"):
        return message(mail_id, sender, f"WITHDRAW: {card_id}", {
            "qd": "withdraw/1", "card": card_id, "why": "No longer needed",
        }, sent)

    def listing(self, *messages):
        service = cards.CardService(FakeMail(list(messages)), FixtureChecker())
        listing = service.refresh()
        return {
            item["id"]: item
            for project in listing["projects"]
            for lane in project["lanes"]
            for item in lane["cards"]
        }

    def serve(self, *messages, checker=None):
        service = cards.CardService(FakeMail(list(messages)), checker or FixtureChecker())
        return service, service.refresh()

    @staticmethod
    def grouping(listing):
        return [
            (project["name"], [(lane["name"], [item["id"] for item in lane["cards"]]) for lane in project["lanes"]])
            for project in listing["projects"]
        ]

    def expected(self, **changes):
        return {
            "id": "repo-lead-1",
            "title": "Choose",
            "project": "Repo",
            "lane": "Launch",
            "due": None,
            "state": "open",
            "changed-at": self.CARD_SENT,
            "from": "repo-lead",
            "rev": 1,
            "answer": None,
            "waitsOn": None,
            **changes,
        }

    def test_a_card_an_update_moved_is_listed_only_under_its_new_lane(self):
        service, listing = self.serve(self.posted(), self.update("m2", 2, self.UPDATE_SENT, lane="Review"))
        self.assertEqual(self.grouping(listing), [("Repo", [("Review", ["repo-lead-1"])])])
        summary = listing["projects"][0]["lanes"][0]["cards"][0]
        self.assertEqual(
            summary,
            self.expected(title="Choose again", lane="Review", rev=2, **{"changed-at": self.UPDATE_SENT}),
        )
        self.assertEqual(service.card("repo-lead-1")["card"]["lane"], summary["lane"])

    def test_a_moved_card_joins_the_cards_already_in_the_new_lane_and_leaves_the_old_lane_alone(self):
        _, listing = self.serve(
            self.posted("m1", "repo-lead-1", lane="Launch"),
            self.posted("m2", "repo-lead-2", lane="Launch"),
            self.posted("m3", "repo-lead-3", lane="Review"),
            self.update("m4", 2, self.UPDATE_SENT, card_id="repo-lead-2", lane="Review"),
        )
        self.assertEqual(
            self.grouping(listing),
            [("Repo", [("Launch", ["repo-lead-1"]), ("Review", ["repo-lead-2", "repo-lead-3"])])],
        )
        for project in listing["projects"]:
            for lane in project["lanes"]:
                for item in lane["cards"]:
                    self.assertEqual(item["lane"], lane["name"])

    def test_a_card_moved_twice_and_a_card_moved_back_follow_the_latest_lane(self):
        _, listing = self.serve(
            self.posted("m1", "repo-lead-1", lane="Launch"),
            self.update("m2", 2, self.UPDATE_SENT, card_id="repo-lead-1", lane="Review"),
            self.update("m3", 3, self.ANSWER_SENT, card_id="repo-lead-1", lane="Ship"),
            self.posted("m4", "repo-lead-4", lane="Launch"),
            self.update("m5", 2, self.UPDATE_SENT, card_id="repo-lead-4", lane="Review"),
            self.update("m6", 3, self.ANSWER_SENT, card_id="repo-lead-4", lane="Launch"),
        )
        self.assertEqual(self.grouping(listing), [("Repo", [("Launch", ["repo-lead-4"]), ("Ship", ["repo-lead-1"])])])

    def test_an_update_that_names_no_lane_keeps_the_lane_it_has_now(self):
        _, listing = self.serve(
            self.posted(),
            self.update("m2", 2, self.UPDATE_SENT, lane="Review"),
            self.update("m3", 3, self.ANSWER_SENT, title="Third"),
        )
        self.assertEqual(self.grouping(listing), [("Repo", [("Review", ["repo-lead-1"])])])

    def test_an_update_that_blanks_or_removes_the_lane_keeps_the_last_lane(self):
        for checker in (FixtureChecker, RemovingChecker):
            for value in (None, ""):
                with self.subTest(checker=checker.__name__, lane=value):
                    service, listing = self.serve(
                        self.posted(),
                        self.update("m2", 2, self.UPDATE_SENT, lane="Review"),
                        self.update("m3", 3, self.ANSWER_SENT, lane=value),
                        checker=checker(),
                    )
                    self.assertEqual(self.grouping(listing), [("Repo", [("Review", ["repo-lead-1"])])])
                    self.assertEqual(listing["projects"][0]["lanes"][0]["cards"][0]["lane"], "Review")
                    self.assertEqual(service.card("repo-lead-1")["rev"], 3)

    def test_a_refused_update_does_not_move_the_card(self):
        _, listing = self.serve(
            self.posted(),
            self.update("m2", 2, self.UPDATE_SENT, sender="bot-x", lane="Review"),
        )
        self.assertEqual(self.grouping(listing), [("Repo", [("Launch", ["repo-lead-1"])])])

    def test_an_update_never_moves_a_card_to_another_project(self):
        service, listing = self.serve(self.posted(), self.update("m2", 2, self.UPDATE_SENT, project="Fleet", lane="Review"))
        self.assertEqual(self.grouping(listing), [("Repo", [("Review", ["repo-lead-1"])])])
        self.assertEqual(listing["projects"][0]["lanes"][0]["cards"][0]["project"], "Repo")

    def test_every_summary_field_an_update_can_change_agrees_with_the_one_card_view(self):
        due = "2026-11-03T09:00:00-05:00"
        steps = (
            {"lane": "Review", "due": due, "skip": "If no answer by due: nothing"},
            {"title": "Third", "due": None},
            {"lane": "Ship"},
        )
        for checker in (FixtureChecker, RemovingChecker):
            with self.subTest(checker=checker.__name__):
                messages = [self.posted()]
                for number, changes in enumerate(steps, start=2):
                    messages.append(self.update(f"m{number}", number, self.UPDATE_SENT, **changes))
                    service, listing = self.serve(*messages, checker=checker())
                    summary = listing["projects"][0]["lanes"][0]["cards"][0]
                    found = service.card("repo-lead-1")
                    for key in ("title", "lane", "due", "project"):
                        self.assertEqual(summary[key], found["card"].get(key), (number, key))
                    self.assertEqual(summary["rev"], found["rev"])
                    self.assertEqual(summary["state"], found["state"])

    def test_an_open_card_has_every_field_and_no_answer_and_waits_on_nobody(self):
        self.assertEqual(self.listing(self.posted())["repo-lead-1"], self.expected())

    def test_every_summary_has_exactly_the_documented_fields_with_the_documented_types(self):
        found = self.listing(
            self.posted("m1"),
            self.posted("m2", "bot-a-1", "Fleet", "Ops", "bot-a"),
            self.posted("m3", "repo-lead-3"),
            self.answered("m4", "A", self.ANSWER_AT, self.ANSWER_SENT, card_id="repo-lead-3"),
            self.posted("m5", "repo-lead-5"),
            self.withdrawn("m6", self.WITHDRAW_SENT, card_id="repo-lead-5"),
        )
        self.assertEqual(set(found), {"repo-lead-1", "bot-a-1", "repo-lead-3", "repo-lead-5"})
        for item in found.values():
            with self.subTest(card=item["id"]):
                self.assertEqual(set(item), self.KEYS)
                self.assertIs(type(item["from"]), str)
                self.assertIs(type(item["rev"]), int)
                self.assertIn(item["state"], {"open", "done", "withdrawn"})
                self.assertTrue(item["answer"] is None or (set(item["answer"]) == {"pick", "at"}))
                self.assertTrue(item["waitsOn"] is None or type(item["waitsOn"]) is str)

    def test_from_is_the_poster_and_stays_the_poster_when_someone_else_updates(self):
        found = self.listing(
            self.posted("m1", "bot-a-1", "Fleet", "Ops", "bot-a"),
            self.posted("m2"),
            self.update("m3", 2, self.UPDATE_SENT, sender="bot-a"),
        )
        self.assertEqual(found["bot-a-1"]["from"], "bot-a")
        self.assertEqual(found["repo-lead-1"]["from"], "repo-lead")

    def test_an_update_bumps_rev_each_time_and_changes_nothing_else_it_should_not(self):
        once = self.listing(self.posted(), self.update("m2", 2, self.UPDATE_SENT))
        self.assertEqual(
            once["repo-lead-1"],
            self.expected(title="Choose again", rev=2, **{"changed-at": self.UPDATE_SENT}),
        )
        twice = self.listing(
            self.posted(),
            self.update("m2", 2, self.UPDATE_SENT),
            self.update("m3", 3, self.ANSWER_SENT, title="Third"),
        )
        self.assertEqual(
            twice["repo-lead-1"],
            self.expected(title="Third", rev=3, **{"changed-at": self.ANSWER_SENT}),
        )

    def test_an_update_that_is_refused_does_not_bump_rev(self):
        found = self.listing(
            self.posted(),
            self.update("m2", 2, self.UPDATE_SENT, sender="bot-x"),
            self.update("m3", 2, self.UPDATE_SENT, card_id="repo-lead-404"),
        )
        self.assertEqual(found["repo-lead-1"], self.expected())

    def test_an_answer_sets_answer_and_done_and_waits_on_the_poster(self):
        for pick in ("A", "B", "cant-decide", "none"):
            with self.subTest(pick=pick):
                found = self.listing(self.posted(), self.answered("m2", pick, self.ANSWER_AT, self.ANSWER_SENT))
                self.assertEqual(
                    found["repo-lead-1"],
                    self.expected(
                        state="done",
                        answer={"pick": pick, "at": self.ANSWER_AT},
                        waitsOn="repo-lead",
                        **{"changed-at": self.ANSWER_SENT},
                    ),
                )

    def test_the_answer_is_the_latest_valid_one(self):
        found = self.listing(
            self.posted(),
            self.answered("m2", "A", self.ANSWER_AT, self.ANSWER_SENT),
            self.answered("m3", "cant-decide", self.LATER_AT, self.LATER_SENT),
        )
        self.assertEqual(
            found["repo-lead-1"],
            self.expected(
                state="done",
                answer={"pick": "cant-decide", "at": self.LATER_AT},
                waitsOn="repo-lead",
                **{"changed-at": self.LATER_SENT},
            ),
        )

    def test_an_invalid_answer_never_becomes_the_answer(self):
        refused_sender = self.answered("m2", "A", self.ANSWER_AT, self.ANSWER_SENT, sender="bot-x")
        broken_body = self.answered("m2", "A", self.ANSWER_AT, self.ANSWER_SENT, valid=False)
        for name, bad in (("not-the-captain", refused_sender), ("refused-by-the-checker", broken_body)):
            with self.subTest(case=name, valid_before=False):
                found = self.listing(self.posted(), bad)
                self.assertEqual(found["repo-lead-1"], self.expected())
            with self.subTest(case=name, valid_before=True):
                good = self.answered("m3", "B", self.LATER_AT, self.LATER_SENT)
                found = self.listing(self.posted(), good, bad)
                self.assertEqual(
                    found["repo-lead-1"],
                    self.expected(
                        state="done",
                        answer={"pick": "B", "at": self.LATER_AT},
                        waitsOn="repo-lead",
                        **{"changed-at": self.LATER_SENT},
                    ),
                )

    def test_a_comment_after_the_answer_keeps_the_answer_and_the_wait(self):
        found = self.listing(
            self.posted(),
            self.answered("m2", "A", self.ANSWER_AT, self.ANSWER_SENT),
            message("m3", "other-bot", "COMMENT: repo-lead-1", {
                "qd": "comment/1", "card": "repo-lead-1", "text": "More",
            }, self.LATER_SENT),
        )
        self.assertEqual(
            found["repo-lead-1"],
            self.expected(
                state="done",
                answer={"pick": "A", "at": self.ANSWER_AT},
                waitsOn="repo-lead",
                **{"changed-at": self.LATER_SENT},
            ),
        )

    def test_a_withdrawn_card_keeps_state_withdrawn_and_waits_on_nobody(self):
        found = self.listing(self.posted(), self.withdrawn("m2", self.WITHDRAW_SENT))
        self.assertEqual(
            found["repo-lead-1"],
            self.expected(state="withdrawn", **{"changed-at": self.WITHDRAW_SENT}),
        )

    def test_a_card_answered_and_then_withdrawn_is_withdrawn_and_waits_on_nobody(self):
        found = self.listing(
            self.posted(),
            self.answered("m2", "A", self.ANSWER_AT, self.ANSWER_SENT),
            self.withdrawn("m3", self.WITHDRAW_SENT),
        )
        self.assertEqual(
            found["repo-lead-1"],
            self.expected(
                state="withdrawn",
                answer={"pick": "A", "at": self.ANSWER_AT},
                **{"changed-at": self.WITHDRAW_SENT},
            ),
        )

    def test_a_withdrawn_card_stays_withdrawn_when_an_answer_arrives_after(self):
        found = self.listing(
            self.posted(),
            self.withdrawn("m2", self.UPDATE_SENT),
            self.answered("m3", "A", self.ANSWER_AT, self.ANSWER_SENT),
        )
        self.assertEqual(
            found["repo-lead-1"],
            self.expected(
                state="withdrawn",
                answer={"pick": "A", "at": self.ANSWER_AT},
                **{"changed-at": self.ANSWER_SENT},
            ),
        )
        self.assertEqual(
            cards.CardService(
                FakeMail([
                    self.posted(),
                    self.withdrawn("m2", self.UPDATE_SENT),
                    self.answered("m3", "A", self.ANSWER_AT, self.ANSWER_SENT),
                ]),
                FixtureChecker(),
            ).refresh()["truncated"],
            False,
        )

    def test_waits_on_names_each_posters_own_done_card_only(self):
        found = self.listing(
            self.posted("m1", "repo-lead-1"),
            self.posted("m2", "bot-a-1", "Fleet", "Ops", "bot-a"),
            self.posted("m3", "bot-a-3", "Fleet", "Ops", "bot-a"),
            self.posted("m4", "repo-lead-4"),
            self.answered("m5", "A", self.ANSWER_AT, self.ANSWER_SENT, card_id="repo-lead-1"),
            self.answered("m6", "B", self.LATER_AT, self.LATER_SENT, card_id="bot-a-3"),
            self.withdrawn("m7", self.WITHDRAW_SENT, card_id="repo-lead-4"),
        )
        self.assertEqual(
            {card_id: (item["state"], item["from"], item["waitsOn"]) for card_id, item in found.items()},
            {
                "repo-lead-1": ("done", "repo-lead", "repo-lead"),
                "bot-a-1": ("open", "bot-a", None),
                "bot-a-3": ("done", "bot-a", "bot-a"),
                "repo-lead-4": ("withdrawn", "repo-lead", None),
            },
        )

    def test_the_one_card_view_is_unchanged_by_the_new_summary_fields(self):
        service = cards.CardService(
            FakeMail([self.posted(), self.update("m2", 2, self.UPDATE_SENT)]),
            FixtureChecker(),
        )
        service.refresh()
        self.assertEqual(set(service.card("repo-lead-1")), {"card", "rev", "state", "thread"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
