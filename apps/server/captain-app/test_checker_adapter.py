import json
import unittest
from dataclasses import dataclass
from types import SimpleNamespace

import checker_adapter


REGISTRY = {
    "format": 1,
    "steward": "bot-a",
    "captain": "account-user",
    "projects": {
        "Fleet": "bot-a",
        "Repo": "bot-b",
        "New": "bot-d",
    },
}


@dataclass(frozen=True)
class Refusal:
    field: str
    rule: str

    def __str__(self):
        return f"{self.field}: {self.rule}"


class Registry:
    @classmethod
    def from_json(cls, document):
        if document != REGISTRY:
            raise ValueError("bad registry")
        instance = cls()
        instance.projects = dict(document["projects"])
        instance.steward = document["steward"]
        instance.captain = document["captain"]
        return instance


class FakeLaneA:
    Registry = Registry

    def __init__(self):
        self.calls = []

    def check_mail(self, subject, body, **facts):
        self.calls.append((subject, body, facts))
        document = json.loads(body)
        refusals = []
        if facts["sender"] == "wrong-bot":
            refusals.append(Refusal("project", "owner"))
        kind = document["qd"].removesuffix("/1")
        return SimpleNamespace(
            refusals=refusals,
            kind=kind,
            ok=not refusals,
        )

    @staticmethod
    def merge_update(base, update):
        return {**base, **update}
    @staticmethod
    def build_answers(
        card,
        rev,
        pick,
        *,
        note,
        at,
        poster,
        registry,
        now,
    ):
        body = json.dumps({
            "qd": "answer/1",
            "card": card,
            "rev": rev,
            "pick": pick,
            "note": note,
            "at": at,
        })
        recipients = [poster] + (
            [registry.steward] if registry.steward != poster else []
        )
        return (
            [
                (
                    recipient,
                    SimpleNamespace(
                        subject=f"ANSWER: {card} {pick}",
                        body=body,
                        resend_key=(
                            f"answer:{card}:rev{rev}:{pick}:to-{recipient}"
                        ),
                    ),
                )
                for recipient in recipients
            ],
            0,
        )

    @staticmethod
    def build_mail(kind, payload, *, now):
        return SimpleNamespace(
            subject=f"COMMENT: {payload['card']}",
            body=json.dumps({"qd": "comment/1", **payload}),
            resend_key=f"comment:{payload['card']}:standin",
        )


class CheckerAdapterTests(unittest.TestCase):
    def test_registry_and_update_merge_are_owned_by_lane_a(self):
        lane_a = FakeLaneA()
        checker = checker_adapter.LaneAChecker(
            REGISTRY,
            module=lane_a,
        )
        base = {"id": "repo-lead-1", "title": "Old"}
        body = json.dumps({
            "qd": "update/1",
            "card": "repo-lead-1",
            "rev": 2,
            "title": "New",
        })

        result = checker.check(
            "UPDATE: repo-lead-1",
            body,
            sender="repo-lead",
            poster="repo-lead",
            base=base,
            current_rev=1,
        )

        self.assertEqual(checker.project_leads, REGISTRY["projects"])
        self.assertEqual(checker.account_name, "account-user")
        self.assertEqual(checker.oversight_bot, "bot-a")
        self.assertEqual(
            checker.active_bots,
            frozenset({"bot-a", "bot-b", "bot-d"}),
        )
        self.assertNotIn("qd", result.merged)
        self.assertNotIn("card", result.merged)
        self.assertNotIn("rev", result.merged)
        self.assertEqual(result.errors, ())
        self.assertEqual(result.merged["title"], "New")
        self.assertIsInstance(lane_a.calls[0][2]["registry"], Registry)

    def test_lane_a_ownership_refusal_is_hidden_from_the_captain(self):
        checker = checker_adapter.LaneAChecker(
            REGISTRY,
            module=FakeLaneA(),
        )
        result = checker.check(
            "CARD: Wrong",
            json.dumps({"qd": "card/1", "id": "wrong-bot-1"}),
            sender="wrong-bot",
        )

        self.assertTrue(result.ownership_refused)
        self.assertEqual(result.errors, ("project: owner",))

    def test_actual_lane_a_checker_accepts_only_a_known_card_comment(self):
        import qd_cards

        checker = checker_adapter.LaneAChecker(
            REGISTRY,
            module=qd_cards,
        )
        body = json.dumps({
            "qd": "comment/1",
            "card": "repo-lead-1",
            "text": "Looks good.",
        })

        known = checker.check(
            "COMMENT: repo-lead-1",
            body,
            sender="other-bot",
            poster="repo-lead",
        )
        unknown = checker.check(
            "COMMENT: repo-lead-1",
            body,
            sender="other-bot",
        )

        self.assertEqual(known.errors, ())
        self.assertTrue(unknown.ownership_refused)
        self.assertTrue(
            any("Quarterdeck does not have" in error for error in unknown.errors)
        )
        answers, hits, errors = checker.build_answers(
            "repo-lead-1",
            1,
            "A",
            "",
            "2026-11-02T10:00:00-05:00",
            "repo-lead",
        )
        self.assertEqual((hits, errors), (0, ()))
        self.assertEqual(
            [mail[3] for mail in answers],
            [
                "answer:repo-lead-1:rev1:A:to-repo-lead",
                "answer:repo-lead-1:rev1:A:to-bot-a",
            ],
        )
        comment, errors = checker.build_comment(
            "repo-lead-1",
            "One detail.",
        )
        self.assertEqual(errors, ())
        self.assertEqual(comment[0], "COMMENT: repo-lead-1")
        self.assertTrue(comment[2].startswith("comment:repo-lead-1:"))

    def test_invalid_registry_is_refused_by_lane_a(self):
        with self.assertRaises(RuntimeError):
            checker_adapter.LaneAChecker(
                {"Repo": "repo-lead"},
                module=FakeLaneA(),
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
