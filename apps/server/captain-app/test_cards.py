import json
import unittest
from datetime import datetime, timezone

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


def message(mail_id, sender, subject, document):
    body = document if isinstance(document, str) else json.dumps(document, separators=(",", ":"))
    return cards.MailMessage(mail_id, sender, subject, body, "2026-11-02T10:00:00-05:00")


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
            self.assertEqual(set(row), {"id", "preview", "at", "last", "unread"})
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

if __name__ == "__main__":
    unittest.main(verbosity=2)
