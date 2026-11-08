from __future__ import annotations

import contextlib
import io
import os
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode
from unittest.mock import patch

import approval_security
from test_oidc_state import Clock, TokenSource
import approval_app
import invite_prompt
import test_approval_app as page
from test_signin_support import production_sign_in


CSRF_LINE = re.compile(r"QD_CSRF_REFUSED reason=(malformed|unknown-or-used|expired)\n")
AUTH_LINE = re.compile(
    r"QD_AUTH_REFUSED reason=(no-session|idle-expired|absolute-expired|rate-session|rate-global)\n"
)


class CsrfPoolCase(unittest.TestCase):
    def setUp(self):
        logger = approval_security._AuthRefusalLog()
        replacement = patch.object(approval_security, "_auth_refusal_log", logger)
        replacement.start()
        self.addCleanup(replacement.stop)
        self.addCleanup(lambda: logger.timer.cancel() if logger.timer is not None else None)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.clock = Clock()
        self.state = approval_security.ApprovalState(
            self.base / "state.sqlite",
            bytes([91]) * 32,
            clock=self.clock,
            token_bytes=TokenSource(),
        )

    def session(self):
        token = self.state.start_identity_session("google-subject-1")
        self.assertIsNotNone(token)
        owner = self.state.authorize_session(token)
        self.assertIsNotNone(owner)
        return token, owner

    def captured(self, action):
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream):
            result = action()
        return result, stream.getvalue()

    def stored_tokens(self, owner):
        with self.state._connect() as database:
            return database.execute(
                "SELECT count(*) FROM csrf WHERE owner_hash = ?", (owner,)
            ).fetchone()[0]


class TokenPoolTests(CsrfPoolCase):
    def test_a_newer_token_does_not_kill_the_older_one_and_each_is_single_use(self):
        _, owner = self.session()
        first = self.state.issue_csrf(owner)
        second = self.state.issue_csrf(owner)

        self.assertTrue(self.state.consume_csrf(owner, first))
        self.assertFalse(self.captured(lambda: self.state.consume_csrf(owner, first))[0])
        self.assertTrue(self.state.consume_csrf(owner, second))
        self.assertFalse(self.captured(lambda: self.state.consume_csrf(owner, second))[0])

    def test_nine_tokens_leave_the_last_eight_and_refuse_the_first(self):
        _, owner = self.session()
        tokens = [self.state.issue_csrf(owner) for _ in range(9)]

        self.assertEqual(self.stored_tokens(owner), 8)
        refused, line = self.captured(lambda: self.state.consume_csrf(owner, tokens[0]))
        self.assertFalse(refused)
        self.assertEqual(line, "QD_CSRF_REFUSED reason=unknown-or-used\n")
        for token in tokens[1:]:
            self.assertTrue(self.state.consume_csrf(owner, token))
        self.assertEqual(self.stored_tokens(owner), 0)

    def test_the_pool_keeps_the_newest_eight_in_issue_order_across_many_issues(self):
        _, owner = self.session()
        tokens = [self.state.issue_csrf(owner) for _ in range(20)]

        self.assertEqual(self.stored_tokens(owner), 8)
        for token in tokens[:12]:
            self.assertFalse(self.captured(lambda: self.state.consume_csrf(owner, token))[0])
        for token in tokens[12:]:
            self.assertTrue(self.state.consume_csrf(owner, token))

    def test_using_a_token_frees_a_slot_without_touching_the_others(self):
        _, owner = self.session()
        tokens = [self.state.issue_csrf(owner) for _ in range(8)]
        self.assertTrue(self.state.consume_csrf(owner, tokens[3]))
        extra = self.state.issue_csrf(owner)

        self.assertEqual(self.stored_tokens(owner), 8)
        for index, token in enumerate(tokens):
            if index != 3:
                self.assertTrue(self.state.consume_csrf(owner, token))
        self.assertTrue(self.state.consume_csrf(owner, extra))

    def test_pools_of_two_sessions_do_not_evict_each_other(self):
        _, first_owner = self.session()
        _, second_owner = self.session()
        first = [self.state.issue_csrf(first_owner) for _ in range(8)]
        second = [self.state.issue_csrf(second_owner) for _ in range(8)]
        self.state.issue_csrf(first_owner)

        self.assertEqual(self.stored_tokens(first_owner), 8)
        self.assertEqual(self.stored_tokens(second_owner), 8)
        for token in second:
            self.assertTrue(self.state.consume_csrf(second_owner, token))
        self.assertFalse(self.captured(lambda: self.state.consume_csrf(first_owner, first[0]))[0])

    def test_a_token_is_bound_to_its_session_and_a_wrong_owner_does_not_burn_it(self):
        _, first_owner = self.session()
        _, second_owner = self.session()
        token = self.state.issue_csrf(first_owner)

        refused, line = self.captured(lambda: self.state.consume_csrf(second_owner, token))
        self.assertFalse(refused)
        self.assertEqual(line, "QD_CSRF_REFUSED reason=unknown-or-used\n")
        self.assertTrue(self.state.consume_csrf(first_owner, token))

    def test_a_token_lives_300_seconds_and_is_refused_from_then_on(self):
        _, owner = self.session()
        early = self.state.issue_csrf(owner)
        late = self.state.issue_csrf(owner)

        self.clock.value += approval_security.CSRF_LIFETIME - 1
        self.assertTrue(self.state.consume_csrf(owner, early))
        self.clock.value += 1
        refused, line = self.captured(lambda: self.state.consume_csrf(owner, late))
        self.assertFalse(refused)
        self.assertEqual(line, "QD_CSRF_REFUSED reason=expired\n")

    def test_a_token_issued_after_expiry_of_the_pool_works(self):
        _, owner = self.session()
        for _ in range(8):
            self.state.issue_csrf(owner)
        self.clock.value += 400
        fresh = self.state.issue_csrf(owner)

        self.assertTrue(self.state.consume_csrf(owner, fresh))

    def test_logout_still_removes_every_token_of_the_session(self):
        token, owner = self.session()
        tokens = [self.state.issue_csrf(owner) for _ in range(5)]
        self.state.revoke_session(owner)

        self.assertEqual(self.stored_tokens(owner), 0)
        for item in tokens:
            self.assertFalse(self.captured(lambda: self.state.consume_csrf(owner, item))[0])

    def test_issuing_for_an_unknown_session_is_still_refused(self):
        with self.assertRaises(approval_security.ApprovalRefused):
            self.state.issue_csrf(bytes([7]) * 32)


class CsrfRefusalLineTests(CsrfPoolCase):
    def test_every_csrf_reason_logs_its_own_fixed_line(self):
        _, owner = self.session()
        used = self.state.issue_csrf(owner)
        self.assertTrue(self.state.consume_csrf(owner, used))
        stale = self.state.issue_csrf(owner)
        self.clock.value += approval_security.CSRF_LIFETIME + 1
        cases = (
            ("malformed", "short"),
            ("malformed", ""),
            ("malformed", "!" * 50),
            ("unknown-or-used", "u" * 43),
            ("unknown-or-used", used),
            ("expired", stale),
        )
        for reason, token in cases:
            with self.subTest(reason=reason, token=token[:4]):
                refused, line = self.captured(lambda: self.state.consume_csrf(owner, token))
                self.assertFalse(refused)
                self.assertEqual(line, f"QD_CSRF_REFUSED reason={reason}\n")

    def test_an_expired_token_is_remembered_for_one_more_lifetime_then_forgotten(self):
        _, owner = self.session()
        token = self.state.issue_csrf(owner)

        self.clock.value += 2 * approval_security.CSRF_LIFETIME - 1
        self.assertEqual(
            self.captured(lambda: self.state.consume_csrf(owner, token))[1],
            "QD_CSRF_REFUSED reason=expired\n",
        )
        self.clock.value += 2
        self.assertEqual(
            self.captured(lambda: self.state.consume_csrf(owner, token))[1],
            "QD_CSRF_REFUSED reason=unknown-or-used\n",
        )

    def test_a_refused_call_logs_exactly_one_line_and_an_accepted_call_logs_none(self):
        _, owner = self.session()
        token = self.state.issue_csrf(owner)

        accepted, quiet = self.captured(lambda: self.state.consume_csrf(owner, token))
        self.assertTrue(accepted)
        self.assertEqual(quiet, "")
        refused, line = self.captured(lambda: self.state.consume_csrf(owner, token))
        self.assertFalse(refused)
        self.assertEqual(len(line.splitlines()), 1)
        self.assertRegex(line, CSRF_LINE)

    def test_no_csrf_line_holds_a_token_a_hash_or_an_owner(self):
        _, owner = self.session()
        secret = "QDCANARYCSRF" + "x" * 31
        token = self.state.issue_csrf(owner)
        self.assertTrue(self.state.consume_csrf(owner, token))
        token_hash = self.state._digest(b"csrf", token)
        lines = [
            self.captured(lambda: self.state.consume_csrf(owner, value))[1]
            for value in (secret, token, "bad token")
        ]
        for line in lines:
            self.assertRegex(line, CSRF_LINE)
            for forbidden in (secret, token, owner.hex(), token_hash.hex()):
                self.assertNotIn(forbidden, line)

    def test_the_line_writer_accepts_only_the_fixed_reasons(self):
        for kind, reason in (("csrf", "a-token-value"), ("auth", "idle"), ("other", "malformed")):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                approval_security.log_refusal_class(kind, reason)


class AuthRefusalLineTests(CsrfPoolCase):
    def test_unknown_and_malformed_session_tokens_log_no_session(self):
        for token in ("u" * 43, "short", "", "!" * 50):
            with self.subTest(token=token[:4]):
                result, line = self.captured(lambda: self.state.authorize_session(token))
                self.assertIsNone(result)
                self.assertEqual(line, "QD_AUTH_REFUSED reason=no-session\n")

    def test_an_idle_session_logs_idle_expired(self):
        token, _ = self.session()
        self.clock.value += approval_security.SESSION_IDLE + 1

        result, line = self.captured(lambda: self.state.authorize_session(token))
        self.assertIsNone(result)
        self.assertEqual(line, "QD_SESSION_END reason=idle\nQD_AUTH_REFUSED reason=idle-expired\n")

    def test_thirty_day_overall_limit_logs_absolute_expired_even_when_active(self):
        token, owner = self.session()
        for _ in range(4):
            self.clock.value += 6 * 86400
            self.assertTrue(self.state.touch_session(owner))
            self.assertIsNotNone(self.state.authorize_session(token))
        self.clock.value += 6 * 86400

        result, line = self.captured(lambda: self.state.authorize_session(token))
        self.assertIsNone(result)
        self.assertEqual(line, "QD_SESSION_END reason=overall\nQD_AUTH_REFUSED reason=absolute-expired\n")

    def test_expiry_is_committed_and_logged_once_then_becomes_no_session(self):
        token, _ = self.session()
        self.clock.value += approval_security.SESSION_IDLE + 1
        lines = [self.captured(lambda: self.state.authorize_session(token))[1] for _ in range(2)]

        self.assertEqual(lines, ["QD_SESSION_END reason=idle\nQD_AUTH_REFUSED reason=idle-expired\n", "QD_AUTH_REFUSED reason=no-session\n"])

    def test_the_session_rate_limit_logs_rate_session_once_per_refusal(self):
        token, _ = self.session()
        for _ in range(approval_security.AUTH_SESSION_LIMIT - 1):
            self.assertIsNotNone(self.state.authorize_session(token))

        first = io.StringIO()
        with contextlib.redirect_stderr(first), self.assertRaises(approval_security.ApprovalRateLimited):
            self.state.authorize_session(token)
        self.assertEqual(first.getvalue(), "QD_AUTH_REFUSED reason=rate-session\n")
        second = io.StringIO()
        with contextlib.redirect_stderr(second), self.assertRaises(approval_security.ApprovalRateLimited):
            self.state.authorize_session(token)
        self.assertEqual(second.getvalue(), "QD_AUTH_REFUSED reason=rate-session\n")

    def test_the_global_rate_limit_logs_rate_global(self):
        sessions = []
        for _ in range(approval_security.MAX_SESSIONS):
            token = self.state.start_identity_session("google-subject-1")
            self.assertIsNotNone(token)
            sessions.append(token)
        calls = 0
        for token in sessions:
            for _ in range(approval_security.AUTH_SESSION_LIMIT - 5):
                if calls >= approval_security.AUTH_GLOBAL_LIMIT:
                    break
                self.assertIsNotNone(self.state.authorize_session(token))
                calls += 1
        self.assertEqual(calls, approval_security.AUTH_GLOBAL_LIMIT)

        stream = io.StringIO()
        with contextlib.redirect_stderr(stream), self.assertRaises(approval_security.ApprovalRateLimited):
            self.state.authorize_session(sessions[-1])
        self.assertEqual(stream.getvalue(), "QD_AUTH_REFUSED reason=rate-global\n")

    def test_an_accepted_authorization_logs_nothing_and_a_refusal_holds_no_value(self):
        token, owner = self.session()
        accepted, quiet = self.captured(lambda: self.state.authorize_session(token))
        self.assertEqual(accepted, owner)
        self.assertEqual(quiet, "")
        secret = "QDCANARYSESSION" + "y" * 28
        _, line = self.captured(lambda: self.state.authorize_session(secret))
        self.assertRegex(line, AUTH_LINE)
        for forbidden in (secret, token, owner.hex()):
            self.assertNotIn(forbidden, line)


class WriteFails(io.StringIO):
    def write(self, text):
        raise OSError("write failed")


class FlushFails(io.StringIO):
    def flush(self):
        raise OSError("flush failed")


def broken_streams():
    closed = io.StringIO()
    closed.close()
    return (("write-fails", WriteFails()), ("flush-fails", FlushFails()), ("closed", closed), ("missing", None))


class BestEffortLogTests(CsrfPoolCase):
    def test_the_writer_never_raises_for_a_broken_stream_but_still_checks_its_vocabulary(self):
        for name, stream in broken_streams():
            with self.subTest(stream=name), contextlib.redirect_stderr(stream):
                self.assertIsNone(approval_security.log_refusal_class("csrf", "malformed"))
                self.assertIsNone(approval_security.log_refusal_class("auth", "rate-global"))
                with self.assertRaises(ValueError):
                    approval_security.log_refusal_class("csrf", "a-token-value")
                with self.assertRaises(ValueError):
                    approval_security.log_refusal_class("other", "malformed")

    def test_session_refusals_keep_their_answer_when_the_log_stream_is_broken(self):
        expired, _ = self.session()
        self.clock.value += approval_security.SESSION_IDLE + 1
        for name, stream in broken_streams():
            with self.subTest(stream=name), contextlib.redirect_stderr(stream):
                self.assertIsNone(self.state.authorize_session("u" * 43))
                self.assertIsNone(self.state.authorize_session("short"))
                self.assertIsNone(self.state.authorize_session(expired))

    def test_rate_refusals_keep_their_answer_when_the_log_stream_is_broken(self):
        token, _ = self.session()
        for _ in range(approval_security.AUTH_SESSION_LIMIT - 1):
            self.assertIsNotNone(self.state.authorize_session(token))
        for name, stream in broken_streams():
            with self.subTest(stream=name), contextlib.redirect_stderr(stream):
                with self.assertRaises(approval_security.ApprovalRateLimited):
                    self.state.authorize_session(token)

    def test_the_global_rate_refusal_keeps_its_answer_when_the_log_stream_is_broken(self):
        sessions = [
            self.state.start_identity_session("google-subject-1")
            for _ in range(approval_security.MAX_SESSIONS)
        ]
        calls = 0
        for token in sessions:
            for _ in range(approval_security.AUTH_SESSION_LIMIT - 5):
                if calls < approval_security.AUTH_GLOBAL_LIMIT:
                    self.assertIsNotNone(self.state.authorize_session(token))
                    calls += 1
        for name, stream in broken_streams():
            with self.subTest(stream=name), contextlib.redirect_stderr(stream):
                with self.assertRaises(approval_security.ApprovalRateLimited):
                    self.state.authorize_session(sessions[-1])

    def test_form_token_refusals_keep_their_answer_when_the_log_stream_is_broken(self):
        _, owner = self.session()
        used = self.state.issue_csrf(owner)
        self.assertTrue(self.state.consume_csrf(owner, used))
        stale = self.state.issue_csrf(owner)
        self.clock.value += approval_security.CSRF_LIFETIME + 1
        for name, stream in broken_streams():
            with self.subTest(stream=name), contextlib.redirect_stderr(stream):
                for token in ("short", "", "u" * 43, used, stale):
                    self.assertFalse(self.state.consume_csrf(owner, token))

    def test_accepted_calls_are_untouched_by_a_broken_log_stream(self):
        token, owner = self.session()
        csrf = self.state.issue_csrf(owner)
        with contextlib.redirect_stderr(WriteFails()):
            self.assertEqual(self.state.authorize_session(token), owner)
            self.assertTrue(self.state.consume_csrf(owner, csrf))


class BrokenLogAnswerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        os.chmod(base, 0o700)
        self.clock = Clock()
        self.state = approval_security.ApprovalState(
            base / "state.sqlite",
            bytes([92]) * 32,
            clock=self.clock,
            token_bytes=TokenSource(),
        )
        self.app = approval_app.ApprovalApplication(
            self.state,
            production_sign_in(self.state, page.FakeAuthenticator()),
            page.FakeBackend(),
            invite_prompt.ReleaseConfig(
                "https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
                "1.2.3",
                "ab" * 32,
                "https://approval.example.invalid",
            ),
            trusted_proxy="proxy.internal",
            public_origin="https://approval.example.invalid",
        )

    def answer(self, stream, make):
        with contextlib.redirect_stderr(stream):
            response = self.app.handle(make())
        return response.status, tuple(response.headers), bytes(response.body)

    def test_a_refused_session_cookie_gets_the_same_page_answer_with_a_broken_stream(self):
        cookie = "__Host-qd-approval=" + "z" * 43
        make = lambda: page.ApprovalApplicationTests.request("GET", "/captain/pending", cookie=cookie)
        healthy = self.answer(io.StringIO(), make)
        self.assertEqual(healthy[0], 303)
        for name, stream in broken_streams():
            with self.subTest(stream=name):
                self.assertEqual(self.answer(stream, make), healthy)

    def test_a_refused_form_token_gets_the_same_answer_with_a_broken_stream(self):
        session = self.state.start_identity_session("captain-subject")
        cookie = f"__Host-qd-approval={session}"
        body = urlencode({"code": "ABCDEFGH", "csrf": "z" * 43}).encode("ascii")
        make = lambda: page.ApprovalApplicationTests.request(
            "POST", "/captain/approve", body=body, cookie=cookie, origin="https://approval.example.invalid"
        )
        healthy = self.answer(io.StringIO(), make)
        self.assertEqual(healthy[0], 403)
        for name, stream in broken_streams():
            with self.subTest(stream=name):
                self.assertEqual(self.answer(stream, make), healthy)


if __name__ == "__main__":
    unittest.main(verbosity=2)
