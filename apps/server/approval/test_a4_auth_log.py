from __future__ import annotations

import contextlib
import io
import unittest
import threading
from unittest.mock import patch

import approval_security
from test_csrf_pool import CsrfPoolCase


class CountedStream(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flushes = 0

    def flush(self):
        self.flushes += 1


class TimerStandIn:
    pending = []

    def __init__(self, delay, callback):
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.pending.append(self)

    def start(self):
        pass

    def cancel(self):
        pass


class AuthLogFloodTests(CsrfPoolCase):
    def test_1000_refusals_share_ten_lines_then_one_timed_summary_and_good_signins_work(self):
        stream = CountedStream()
        now = [1000.0]
        TimerStandIn.pending = []
        with patch.object(approval_security.time, 'monotonic', side_effect=lambda: now[0]), patch.object(threading, 'Timer', TimerStandIn):
            with contextlib.redirect_stderr(stream):
                for _ in range(1000):
                    self.assertIsNone(self.state.authorize_session('bad cookie'))
                self.assertEqual(len(stream.getvalue().splitlines()), 10)
                self.assertEqual(stream.flushes, 10)
                self.assertEqual(len(TimerStandIn.pending), 1)
                token = self.state.start_identity_session('google-subject-1')
                self.assertIsNotNone(self.state.authorize_session(token))
                now[0] = 1060.0
                TimerStandIn.pending[0].callback()
                self.assertEqual(stream.getvalue().splitlines()[-1], 'QD_AUTH_REFUSED_SUPPRESSED count=990')
                self.assertEqual(stream.flushes, 12)
                self.assertIsNone(self.state.authorize_session('still bad'))
                self.assertEqual(len(stream.getvalue().splitlines()), 13)

    def test_all_refusal_reasons_share_one_process_budget(self):
        stream = CountedStream()
        with patch.object(approval_security, '_auth_refusal_log', approval_security._AuthRefusalLog()) as logger:
            with patch.object(approval_security.threading, 'Timer', TimerStandIn), contextlib.redirect_stderr(stream):
                for index in range(1000):
                    approval_security.log_refusal_class('auth', approval_security.AUTH_REFUSAL_REASONS[index % 5])
                self.assertEqual(len(stream.getvalue().splitlines()), 10)
                self.assertEqual(stream.flushes, 10)
                self.assertEqual(logger.suppressed, 990)

    def test_invalid_vocabulary_stays_rejected(self):
        with self.assertRaises(ValueError):
            approval_security.log_refusal_class('auth', 'request-value')
