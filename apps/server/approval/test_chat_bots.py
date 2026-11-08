from __future__ import annotations

import ast
import errno
import io
import itertools
import json
import os
import stat
import tempfile
import threading
import time
import tokenize
import unittest
from pathlib import Path
from unittest import mock

import approval_security
import chat_bots
import server
from test_server import FakeOidcConfig

NOW = 1_700_000_000
OLD = b'{"v":1,"at":1699999999,"bots":["old-bot"]}\n'
POLL_THREAD = "chat-bots-poll"


def document(names, at=NOW):
    return (
        json.dumps({"v": 1, "at": at, "bots": names}, separators=(",", ":"))
        .encode("ascii")
        + b"\n"
    )


def poll_threads():
    return [
        thread
        for thread in threading.enumerate()
        if thread.name == POLL_THREAD
    ]


class Clock:
    def __init__(self, now=NOW):
        self.now = now

    def __call__(self):
        return self.now


class Fetch:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        result = (
            self.results.pop(0) if len(self.results) > 1 else self.results[0]
        )
        if isinstance(result, BaseException):
            raise result
        return result


class Ticks:
    def __init__(self, count):
        self.count = count
        self.intervals = []
        self.threads = []

    def __call__(self, interval):
        self.intervals.append(interval)
        self.threads.append(threading.current_thread())
        return len(self.intervals) > self.count


class FaultyOs:
    def __init__(self, real, function, nth, failure):
        self._real = real
        self._function = function
        self._nth = nth
        self._failure = failure
        self._count = 0

    def __getattr__(self, attribute):
        value = getattr(self._real, attribute)
        if attribute != self._function:
            return value

        def call(*args, **kwargs):
            self._count += 1
            if self._count == self._nth:
                raise self._failure
            return value(*args, **kwargs)

        return call


class RecordingOs:
    def __init__(self, real):
        self._real = real
        self.opens = []

    def __getattr__(self, attribute):
        value = getattr(self._real, attribute)
        if attribute != "open":
            return value

        def call(*args, **kwargs):
            self.opens.append((args, kwargs))
            return value(*args, **kwargs)

        return call


def open_descriptors():
    return len(os.listdir("/proc/self/fd"))


def temp_name(token):
    return f".{chat_bots.FILE_NAME}.{token}.tmp"


class PublisherCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.counter = itertools.count()
        self.fresh()
        self.clock = Clock()
        self.log = io.StringIO()
        patcher = mock.patch.object(chat_bots.sys, "stderr", self.log)
        patcher.start()
        self.addCleanup(patcher.stop)

    def fresh(self):
        self.folder = self.base / f"captain-auth-{next(self.counter)}"
        self.folder.mkdir()
        self.folder.chmod(0o2770)
        self.target = self.folder / chat_bots.FILE_NAME
        return self.folder

    def make(self, fetch, **options):
        options.setdefault("clock", self.clock)
        publisher = chat_bots.ChatBotsPublisher(self.folder, fetch, **options)
        self.addCleanup(publisher.stop)
        return publisher

    def seed(self, content=OLD, mode=0o640):
        self.target.write_bytes(content)
        self.target.chmod(mode)

    def listing(self):
        return sorted(os.listdir(self.folder))

    def logged(self):
        value = self.log.getvalue()
        self.log.seek(0)
        self.log.truncate()
        return value


class FileFormatTests(PublisherCase):
    def test_writes_the_exact_bytes_with_mode_0640_and_no_temp_file(self):
        publisher = self.make(Fetch(["bot-a", "bot-b"]))
        self.assertTrue(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(),
            b'{"v":1,"at":1700000000,"bots":["bot-a","bot-b"]}\n',
        )
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)
        self.assertEqual(self.listing(), ["chat-bots.json"])

    def test_the_mode_is_0640_whatever_the_umask(self):
        for mask in (0o000, 0o077, 0o277):
            with self.subTest(mask=oct(mask)):
                self.fresh()
                previous = os.umask(mask)
                try:
                    self.make(Fetch(["bot-a"])).publish()
                finally:
                    os.umask(previous)
                self.assertEqual(
                    stat.S_IMODE(self.target.stat().st_mode), 0o640
                )

    def test_the_empty_list_is_written_in_the_same_shape(self):
        self.assertTrue(self.make(Fetch([])).publish())
        self.assertEqual(
            self.target.read_bytes(),
            b'{"v":1,"at":1700000000,"bots":[]}\n',
        )

    def test_names_keep_the_order_the_join_service_returned(self):
        self.make(Fetch(["zed", "alpha", "mid-1"])).publish()
        self.assertEqual(
            json.loads(self.target.read_bytes())["bots"],
            ["zed", "alpha", "mid-1"],
        )

    def test_a_removed_bot_is_dropped_at_the_next_publish(self):
        publisher = self.make(Fetch(["bot-a", "bot-b"], ["bot-a"]))
        publisher.publish()
        self.assertEqual(
            json.loads(self.target.read_bytes())["bots"], ["bot-a", "bot-b"]
        )
        self.clock.now = NOW + 30
        self.assertTrue(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(), document(["bot-a"], NOW + 30)
        )

    def test_the_time_is_an_integer_from_the_injected_clock(self):
        self.clock.now = 1_700_000_123.9
        self.make(Fetch(["bot-a"])).publish()
        content = self.target.read_bytes()
        self.assertEqual(
            content, b'{"v":1,"at":1700000123,"bots":["bot-a"]}\n'
        )
        value = json.loads(content)["at"]
        self.assertIs(type(value), int)

    def test_the_default_clock_is_the_wall_clock(self):
        publisher = chat_bots.ChatBotsPublisher(
            self.folder, Fetch(["bot-a"])
        )
        before = int(time.time())
        publisher.publish()
        after = int(time.time())
        written = json.loads(self.target.read_bytes())["at"]
        self.assertIs(type(written), int)
        self.assertTrue(before <= written <= after)

    def test_every_publish_rewrites_the_file_even_when_the_names_are_unchanged(self):
        publisher = self.make(Fetch(["bot-a"]))
        publisher.publish()
        self.clock.now = NOW + 30
        self.assertTrue(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(),
            b'{"v":1,"at":1700000030,"bots":["bot-a"]}\n',
        )
        self.clock.now = NOW + 60
        self.assertTrue(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(),
            b'{"v":1,"at":1700000060,"bots":["bot-a"]}\n',
        )

    def test_a_publish_in_the_same_second_still_repairs_a_changed_file(self):
        publisher = self.make(Fetch(["bot-a"]))
        publisher.publish()
        self.seed(b"tampered", 0o666)
        self.assertTrue(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(), document(["bot-a"])
        )
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)

    def test_sixty_four_names_and_a_32_character_name_are_published(self):
        names = [f"bot-{index}" for index in range(63)] + ["a" + "b" * 31]
        self.assertEqual(len(names), 64)
        self.assertTrue(self.make(Fetch(names)).publish())
        self.assertEqual(self.target.read_bytes(), document(names))
        self.assertLessEqual(len(self.target.read_bytes()), 4096)

    def test_hyphens_digits_and_single_letters_are_valid_names(self):
        names = ["a", "a0", "a-", "a-0-b", "z9"]
        self.assertTrue(self.make(Fetch(names)).publish())
        self.assertEqual(self.target.read_bytes(), document(names))


class InvalidFetchTests(PublisherCase):
    INVALID = {
        "uppercase": ["Bot"],
        "digit first": ["1bot"],
        "hyphen first": ["-bot"],
        "empty name": [""],
        "33 characters": ["a" * 33],
        "underscore": ["bot_a"],
        "space": ["bot a"],
        "trailing newline": ["bot-a\n"],
        "non ascii": ["bot-\u00e9"],
        "number": [1],
        "none": [None],
        "bytes": [b"bot-a"],
        "bool": [True],
        "duplicate": ["bot-a", "bot-a"],
        "65 names": [f"bot-{index}" for index in range(65)],
        "string instead of list": "bot-a",
        "dict instead of list": {"bot-a": 1},
        "tuple instead of list": ("bot-a",),
        "good name next to a bad one": ["bot-a", "Bad"],
        "bad name after 63 good ones": [f"bot-{i}" for i in range(63)]
        + ["Bad"],
    }

    def test_an_invalid_value_is_a_failed_fetch_never_a_partial_publish(self):
        for label, value in self.INVALID.items():
            with self.subTest(case=label):
                self.fresh()
                self.seed()
                publisher = self.make(Fetch(value))
                self.assertFalse(publisher.publish())
                self.assertEqual(self.target.read_bytes(), OLD)
                self.assertEqual(self.listing(), ["chat-bots.json"])
                self.assertTrue(publisher.publish())
                self.assertEqual(
                    self.target.read_bytes(),
                    b'{"v":1,"at":1700000000,"bots":[]}\n',
                )

    def test_a_single_invalid_value_without_a_previous_file_publishes_nothing(self):
        self.assertFalse(self.make(Fetch(["Bad", "bot-a"])).publish())
        self.assertEqual(self.listing(), [])

    def test_the_size_limit_counts_the_whole_file_and_is_inclusive(self):
        exact = len(document(["bot-a"]))
        with mock.patch.object(chat_bots, "MAX_BYTES", exact):
            self.assertTrue(self.make(Fetch(["bot-a"])).publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.fresh()
        self.seed()
        with mock.patch.object(chat_bots, "MAX_BYTES", exact - 1):
            publisher = self.make(Fetch(["bot-a"]))
            self.assertFalse(publisher.publish())
            self.assertEqual(self.target.read_bytes(), OLD)
            self.assertTrue(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(),
            b'{"v":1,"at":1700000000,"bots":[]}\n',
        )

    def test_the_limits_are_the_contract_values(self):
        self.assertEqual(chat_bots.MAX_NAMES, 64)
        self.assertEqual(chat_bots.MAX_BYTES, 4096)
        self.assertEqual(chat_bots.FILE_NAME, "chat-bots.json")
        self.assertEqual(chat_bots.POLL_SECONDS, 30.0)


class FailedFetchTests(PublisherCase):
    def test_one_failed_fetch_keeps_the_previous_file(self):
        for label, failure in (
            ("none", None),
            ("exception", RuntimeError("canary-bot")),
            ("os error", OSError(errno.ECONNREFUSED, "canary-bot")),
        ):
            with self.subTest(failure=label):
                self.fresh()
                self.seed()
                publisher = self.make(Fetch(failure))
                self.assertFalse(publisher.publish())
                self.assertEqual(self.target.read_bytes(), OLD)
                self.assertEqual(self.listing(), ["chat-bots.json"])

    def test_two_failed_fetches_in_a_row_publish_the_empty_list_with_a_fresh_time(self):
        for label, failure in (
            ("none", None),
            ("exception", RuntimeError("canary-bot")),
        ):
            with self.subTest(failure=label):
                self.fresh()
                self.clock.now = NOW
                fetch = Fetch(["bot-a", "bot-b"], failure)
                publisher = self.make(fetch)
                publisher.publish()
                good = self.target.read_bytes()
                self.clock.now = NOW + 30
                self.assertFalse(publisher.publish())
                self.assertEqual(self.target.read_bytes(), good)
                self.clock.now = NOW + 60
                self.assertTrue(publisher.publish())
                self.assertEqual(
                    self.target.read_bytes(),
                    b'{"v":1,"at":1700000060,"bots":[]}\n',
                )
                self.clock.now = NOW + 90
                self.assertTrue(publisher.publish())
                self.assertEqual(
                    self.target.read_bytes(),
                    b'{"v":1,"at":1700000090,"bots":[]}\n',
                )
                self.assertEqual(self.listing(), ["chat-bots.json"])

    def test_a_mix_of_failure_kinds_counts_together(self):
        publisher = self.make(Fetch(["bot-a"], None, ["Bad"]))
        publisher.publish()
        publisher.publish()
        self.assertEqual(
            self.target.read_bytes(),
            document(["bot-a"]),
        )
        publisher.publish()
        self.assertEqual(
            self.target.read_bytes(),
            b'{"v":1,"at":1700000000,"bots":[]}\n',
        )

    def test_a_later_good_fetch_publishes_the_names_again(self):
        fetch = Fetch(["bot-a"], None, None, ["bot-a", "bot-c"])
        publisher = self.make(fetch)
        publisher.publish()
        publisher.publish()
        publisher.publish()
        self.assertEqual(
            json.loads(self.target.read_bytes())["bots"], []
        )
        self.clock.now = NOW + 90
        self.assertTrue(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(),
            document(["bot-a", "bot-c"], NOW + 90),
        )

    def test_a_good_fetch_resets_the_count_of_failures(self):
        fetch = Fetch(["bot-a"], None, ["bot-b"], None, ["bot-c"])
        publisher = self.make(fetch)
        for _ in range(4):
            publisher.publish()
        self.assertEqual(
            self.target.read_bytes(), document(["bot-b"])
        )

    def test_a_good_empty_list_is_a_good_fetch_not_a_failure(self):
        publisher = self.make(Fetch(None, [], None))
        publisher.publish()
        self.clock.now = NOW + 30
        self.assertTrue(publisher.publish())
        self.clock.now = NOW + 60
        self.assertFalse(publisher.publish())
        self.assertEqual(
            self.target.read_bytes(), document([], NOW + 30)
        )

    def test_a_failed_write_does_not_count_as_a_failed_fetch(self):
        publisher = self.make(Fetch(["bot-a"], ["bot-a"], None))
        self.assertTrue(publisher.publish())
        failure = OSError(errno.EIO, "injected")
        with mock.patch.object(
            chat_bots, "os", FaultyOs(os, "rename", 1, failure)
        ):
            self.assertFalse(publisher.publish())
        self.assertFalse(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))

    def test_without_a_previous_file_one_failed_fetch_publishes_nothing(self):
        self.assertFalse(self.make(Fetch(None)).publish())
        self.assertEqual(self.listing(), [])


class AtomicWriteTests(PublisherCase):
    STEPS = (
        ("folder-open", "open", 1, False),
        ("temp-create", "open", 2, False),
        ("write", "write", 1, False),
        ("file-fsync", "fsync", 1, False),
        ("fchmod", "fchmod", 1, False),
        ("rename", "rename", 1, False),
        ("folder-fsync", "fsync", 2, True),
    )

    def test_a_failure_at_any_step_never_leaves_a_partial_or_temporary_file(self):
        for label, function, nth, replaced in self.STEPS:
            for failure_type in (OSError, RuntimeError):
                for previous in (OLD, None):
                    with self.subTest(
                        step=label,
                        failure=failure_type.__name__,
                        previous=previous is not None,
                    ):
                        self.fresh()
                        if previous is not None:
                            self.seed(previous)
                        publisher = self.make(Fetch(["bot-a"]))
                        failure = failure_type(errno.EIO, "injected")
                        descriptors = open_descriptors()
                        with mock.patch.object(
                            chat_bots,
                            "os",
                            FaultyOs(os, function, nth, failure),
                        ):
                            self.assertFalse(publisher.publish())
                        self.assertEqual(open_descriptors(), descriptors)
                        if replaced:
                            self.assertEqual(
                                self.target.read_bytes(), document(["bot-a"])
                            )
                            self.assertEqual(self.listing(), ["chat-bots.json"])
                        elif previous is not None:
                            self.assertEqual(self.target.read_bytes(), previous)
                            self.assertEqual(self.listing(), ["chat-bots.json"])
                        else:
                            self.assertEqual(self.listing(), [])
                        self.assertEqual(
                            self.logged(), "QD_CHAT_BOTS_WRITE_FAILED\n"
                        )

    def test_the_publisher_recovers_after_a_failed_write(self):
        self.seed()
        publisher = self.make(Fetch(["bot-a"]))
        failure = OSError(errno.ENOSPC, "injected")
        with mock.patch.object(
            chat_bots, "os", FaultyOs(os, "write", 1, failure)
        ):
            self.assertFalse(publisher.publish())
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.listing(), ["chat-bots.json"])

    def test_a_missing_folder_is_a_failed_write_not_a_crash(self):
        missing = self.base / "missing"
        publisher = chat_bots.ChatBotsPublisher(
            missing, Fetch(["bot-a"]), clock=self.clock
        )
        self.assertFalse(publisher.publish())
        self.assertFalse(missing.exists())
        self.assertEqual(self.logged(), "QD_CHAT_BOTS_WRITE_FAILED\n")

    def test_the_temp_file_is_created_exclusively_in_the_folder_and_is_unique(self):
        recorder = RecordingOs(os)
        publisher = self.make(Fetch(["bot-a"]))
        with mock.patch.object(chat_bots, "os", recorder):
            publisher.publish()
            publisher.publish()
        temps = [call for call in recorder.opens if "dir_fd" in call[1]]
        self.assertEqual(len(temps), 2)
        names = [args[0] for args, _ in temps]
        self.assertEqual(len(set(names)), 2)
        for (args, kwargs), name in zip(temps, names):
            self.assertTrue(name.startswith(".chat-bots.json."))
            self.assertTrue(name.endswith(".tmp"))
            self.assertNotIn("/", name)
            flags = args[1]
            for required in (os.O_CREAT, os.O_EXCL, os.O_NOFOLLOW):
                self.assertTrue(flags & required)
            self.assertEqual(flags & os.O_ACCMODE, os.O_WRONLY)
            self.assertEqual(args[2], 0o600)
            self.assertIsInstance(kwargs["dir_fd"], int)

    def test_a_symlinked_temp_name_is_refused_and_left_alone(self):
        victim = self.base / "victim"
        victim.write_bytes(b"victim")
        self.seed()
        link = self.folder / temp_name("feedfacecafebeef")
        os.symlink(victim, link)
        publisher = self.make(Fetch(["bot-a"]))
        with mock.patch.object(
            chat_bots.secrets, "token_hex", return_value="feedfacecafebeef"
        ):
            self.assertFalse(publisher.publish())
        self.assertEqual(victim.read_bytes(), b"victim")
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), str(victim))
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual(
            self.listing(), sorted(["chat-bots.json", link.name])
        )

    def test_a_dangling_symlinked_temp_name_is_not_created_through(self):
        victim = self.base / "not-yet"
        link = self.folder / temp_name("feedfacecafebeef")
        os.symlink(victim, link)
        publisher = self.make(Fetch(["bot-a"]))
        with mock.patch.object(
            chat_bots.secrets, "token_hex", return_value="feedfacecafebeef"
        ):
            self.assertFalse(publisher.publish())
        self.assertFalse(victim.exists())
        self.assertTrue(link.is_symlink())
        self.assertFalse(self.target.exists())

    def test_an_existing_file_at_the_temp_name_is_not_written_or_removed(self):
        self.seed()
        other = self.folder / temp_name("feedfacecafebeef")
        other.write_bytes(b"someone else")
        publisher = self.make(Fetch(["bot-a"]))
        with mock.patch.object(
            chat_bots.secrets, "token_hex", return_value="feedfacecafebeef"
        ):
            self.assertFalse(publisher.publish())
        self.assertEqual(other.read_bytes(), b"someone else")
        self.assertEqual(self.target.read_bytes(), OLD)

    def test_a_symlinked_target_is_replaced_by_rename_and_not_written_through(self):
        victim = self.base / "victim"
        victim.write_bytes(b"victim")
        os.symlink(victim, self.target)
        self.assertTrue(self.make(Fetch(["bot-a"])).publish())
        self.assertFalse(self.target.is_symlink())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(victim.read_bytes(), b"victim")
        self.assertEqual(self.listing(), ["chat-bots.json"])

    def test_a_dangling_symlinked_target_is_replaced(self):
        os.symlink(self.base / "not-yet", self.target)
        self.assertTrue(self.make(Fetch(["bot-a"])).publish())
        self.assertFalse(self.target.is_symlink())
        self.assertFalse((self.base / "not-yet").exists())

    def test_a_pre_existing_loose_file_is_replaced_with_mode_0640(self):
        self.seed(b"junk" * 2000, 0o666)
        self.assertTrue(self.make(Fetch(["bot-a"])).publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)

    def test_a_pre_existing_pipe_is_replaced_without_being_opened(self):
        os.mkfifo(self.target)
        self.assertTrue(self.make(Fetch(["bot-a"])).publish())
        self.assertTrue(stat.S_ISREG(self.target.lstat().st_mode))
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))

    def test_a_directory_at_the_target_is_a_failed_write_and_is_left_alone(self):
        self.target.mkdir()
        (self.target / "kept").write_bytes(b"kept")
        self.assertFalse(self.make(Fetch(["bot-a"])).publish())
        self.assertTrue(self.target.is_dir())
        self.assertEqual((self.target / "kept").read_bytes(), b"kept")
        self.assertEqual(self.listing(), ["chat-bots.json"])
        self.assertEqual(self.logged(), "QD_CHAT_BOTS_WRITE_FAILED\n")


class AccountNameTests(PublisherCase):
    def test_the_captain_account_name_never_appears_in_the_file(self):
        publisher = self.make(
            Fetch(["bot-a", "account-user", "bot-b"]),
            exclude=frozenset({"account-user"}),
        )
        self.assertTrue(publisher.publish())
        content = self.target.read_bytes()
        self.assertEqual(content, document(["bot-a", "bot-b"]))
        self.assertNotIn(b"account-user", content)

    def test_a_list_holding_only_the_account_name_publishes_the_empty_list(self):
        publisher = self.make(
            Fetch(["account-user"]), exclude=frozenset({"account-user"})
        )
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document([]))

    def test_without_an_account_name_every_valid_name_is_published(self):
        self.make(Fetch(["account-user"])).publish()
        self.assertEqual(self.target.read_bytes(), document(["account-user"]))


class LogTests(PublisherCase):
    def test_lines_are_fixed_and_written_only_when_the_outcome_changes(self):
        fetch = Fetch(
            ["canary-bot"],
            ["canary-bot"],
            RuntimeError("canary-bot"),
            None,
            None,
            ["canary-bot"],
        )
        publisher = self.make(fetch)
        expected = [
            "QD_CHAT_BOTS_PUBLISHED\n",
            "",
            "QD_CHAT_BOTS_FETCH_FAILED\n",
            "QD_CHAT_BOTS_EMPTIED\n",
            "",
            "QD_CHAT_BOTS_PUBLISHED\n",
        ]
        for line in expected:
            publisher.publish()
            self.assertEqual(self.logged(), line)

    def test_a_failed_write_logs_one_fixed_line_without_the_path_or_names(self):
        publisher = self.make(Fetch(["canary-bot"]))
        failure = OSError(errno.EIO, "canary-bot " + str(self.folder))
        with mock.patch.object(
            chat_bots, "os", FaultyOs(os, "rename", 1, failure)
        ):
            publisher.publish()
        with mock.patch.object(
            chat_bots, "os", FaultyOs(os, "rename", 1, failure)
        ):
            publisher.publish()
        self.assertEqual(self.logged(), "QD_CHAT_BOTS_WRITE_FAILED\n")
        publisher.publish()
        self.assertEqual(self.logged(), "QD_CHAT_BOTS_PUBLISHED\n")

    def test_nothing_else_is_ever_written_to_the_log(self):
        fetch = Fetch(
            ["canary-bot"], RuntimeError("canary-bot"), ["Canary"], None
        )
        publisher = self.make(fetch)
        for _ in range(4):
            publisher.publish()
        lines = self.logged().splitlines(keepends=True)
        self.assertTrue(lines)
        self.assertLessEqual(
            set(lines),
            {
                "QD_CHAT_BOTS_PUBLISHED\n",
                "QD_CHAT_BOTS_FETCH_FAILED\n",
                "QD_CHAT_BOTS_EMPTIED\n",
                "QD_CHAT_BOTS_WRITE_FAILED\n",
            },
        )

    def test_a_broken_log_channel_never_breaks_a_publish(self):
        class BrokenStream:
            def write(self, text):
                raise OSError(errno.EPIPE, "closed")

            def flush(self):
                raise OSError(errno.EPIPE, "closed")

        publisher = self.make(Fetch(["bot-a"], None, None))
        with mock.patch.object(chat_bots.sys, "stderr", BrokenStream()):
            self.assertTrue(publisher.publish())
            self.assertFalse(publisher.publish())
            self.assertTrue(publisher.publish())
        self.assertEqual(
            json.loads(self.target.read_bytes())["bots"], []
        )


class ConcurrencyTests(PublisherCase):
    def test_two_publishes_never_run_at_the_same_time(self):
        entered = threading.Event()
        release = threading.Event()
        calls = []

        def fetch():
            calls.append(1)
            if len(calls) == 1:
                entered.set()
                release.wait(5)
            return ["bot-a"]

        publisher = self.make(fetch)
        first = threading.Thread(target=publisher.publish)
        first.start()
        self.assertTrue(entered.wait(5))
        second = threading.Thread(target=publisher.publish)
        second.start()
        second.join(0.3)
        self.assertTrue(second.is_alive())
        self.assertEqual(len(calls), 1)
        release.set()
        first.join(5)
        second.join(5)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))


class PollThreadTests(PublisherCase):
    def test_the_thread_publishes_after_each_wait_on_the_interval(self):
        ticks = Ticks(2)

        def fetch():
            self.clock.now += 30
            return ["bot-a"]

        publisher = self.make(fetch, wait=ticks)
        publisher.start()
        publisher.stop()
        self.assertEqual(ticks.intervals, [30.0, 30.0, 30.0])
        self.assertEqual(
            self.target.read_bytes(), document(["bot-a"], NOW + 60)
        )
        self.assertEqual(self.listing(), ["chat-bots.json"])

    def test_the_interval_can_be_set(self):
        ticks = Ticks(0)
        publisher = self.make(Fetch(["bot-a"]), wait=ticks, interval=7.5)
        publisher.start()
        publisher.stop()
        self.assertEqual(ticks.intervals, [7.5])
        self.assertFalse(self.target.exists())

    def test_the_thread_is_one_named_daemon_thread(self):
        ticks = Ticks(1)
        publisher = self.make(Fetch(["bot-a"]), wait=ticks)
        publisher.start()
        publisher.stop()
        self.assertEqual(len(set(ticks.threads)), 1)
        thread = ticks.threads[0]
        self.assertTrue(thread.daemon)
        self.assertEqual(thread.name, POLL_THREAD)
        self.assertIsNot(thread, threading.main_thread())

    def test_the_thread_survives_failures_and_exceptions(self):
        fetch = Fetch(
            RuntimeError("canary-bot"),
            ["bot-a"],
            OSError(errno.ECONNREFUSED, "canary-bot"),
            ["bot-b"],
        )
        ticks = Ticks(4)
        publisher = self.make(fetch, wait=ticks)
        publisher.start()
        publisher.stop()
        self.assertEqual(fetch.calls, 4)
        self.assertEqual(self.target.read_bytes(), document(["bot-b"]))

    def test_the_thread_survives_a_write_exception(self):
        fetch = Fetch(["bot-a"])
        ticks = Ticks(2)
        publisher = self.make(fetch, wait=ticks)
        failure = RuntimeError("injected")
        with mock.patch.object(
            chat_bots, "os", FaultyOs(os, "fsync", 1, failure)
        ):
            publisher.start()
            publisher.stop()
        self.assertEqual(fetch.calls, 2)
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))

    def test_stop_ends_a_sleeping_thread_at_once_and_is_repeatable(self):
        fetch = Fetch(["bot-a"])
        publisher = self.make(fetch, interval=3600.0)
        self.assertEqual(poll_threads(), [])
        publisher.start()
        running = poll_threads()
        self.assertEqual(len(running), 1)
        self.assertTrue(running[0].daemon)
        publisher.stop()
        self.assertFalse(running[0].is_alive())
        self.assertEqual(poll_threads(), [])
        publisher.stop()
        self.assertEqual(fetch.calls, 0)
        self.assertFalse(self.target.exists())

    def test_stop_before_start_is_harmless(self):
        self.make(Fetch(["bot-a"])).stop()
        self.assertEqual(poll_threads(), [])


class BackendCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.folder = self.base / "captain-auth"
        self.folder.mkdir()
        self.folder.chmod(0o2770)
        self.target = self.folder / "chat-bots.json"
        self.log = io.StringIO()
        patcher = mock.patch.object(chat_bots.sys, "stderr", self.log)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def patched(name, **options):
        return mock.patch.object(server.approval_service, name, **options)

    def written(self):
        return json.loads(self.target.read_bytes())


class SocketBackendBotTests(BackendCase):
    def test_the_join_client_provides_request_bots(self):
        self.assertTrue(
            callable(getattr(server.approval_service, "request_bots", None))
        )

    def test_bots_asks_the_join_service_over_the_approval_socket(self):
        with self.patched("request_bots", return_value=["bot-a"]) as asked:
            backend = server.ApprovalSocketBackend("approve.sock")
            self.assertEqual(backend.bots(), ["bot-a"])
        asked.assert_called_once_with("approve.sock")

    def test_bots_passes_a_failed_answer_through_as_none(self):
        with self.patched("request_bots", return_value=None):
            backend = server.ApprovalSocketBackend("approve.sock")
            self.assertIsNone(backend.bots())

    def test_an_approve_success_publishes_after_the_approval_went_through(self):
        calls = []

        def approve(path, code):
            calls.append(("approve", path, code))
            return True

        def bots(path):
            calls.append(("bots", path))
            return ["bot-a", "bot-b"]

        before = int(time.time())
        with (
            self.patched("request_approval", side_effect=approve),
            self.patched("request_bots", side_effect=bots),
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", self.folder
            )
            self.assertTrue(backend.approve("ABCDEFGH"))
        self.assertEqual(
            calls,
            [
                ("approve", "approve.sock", "ABCDEFGH"),
                ("bots", "approve.sock"),
            ],
        )
        written = self.written()
        self.assertEqual(list(written), ["v", "at", "bots"])
        self.assertEqual(written["bots"], ["bot-a", "bot-b"])
        self.assertTrue(before <= written["at"] <= int(time.time()))

    def test_an_approve_refusal_publishes_nothing(self):
        with (
            self.patched("request_approval", return_value=False),
            self.patched("request_bots", return_value=["bot-a"]) as asked,
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", self.folder
            )
            with self.assertRaises(approval_security.ApprovalRefused):
                backend.approve("ABCDEFGH")
        asked.assert_not_called()
        self.assertFalse(self.target.exists())

    def test_a_refuse_action_publishes_nothing(self):
        with (
            self.patched("request_refusal", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]) as asked,
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", self.folder
            )
            self.assertTrue(backend.refuse("ABCDEFGH"))
        asked.assert_not_called()
        self.assertFalse(self.target.exists())

    def test_the_other_reviewed_actions_publish_nothing(self):
        with (
            self.patched("request_pending", return_value=[]),
            self.patched("request_invites", return_value=[]),
            self.patched(
                "request_invite_creation", return_value={"inviteId": "x"}
            ),
            self.patched("request_invite_cancellation", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]) as asked,
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", self.folder
            )
            backend.pending()
            backend.invites()
            backend.create_invite("bot-b")
            backend.cancel_invite("AAAAAAAAAAAA")
        asked.assert_not_called()
        self.assertFalse(self.target.exists())

    def test_an_approve_success_still_succeeds_when_the_publish_cannot_happen(self):
        for label, bots in (
            ("none", {"return_value": None}),
            ("exception", {"side_effect": RuntimeError("canary-bot")}),
        ):
            with self.subTest(join=label):
                with (
                    self.patched("request_approval", return_value=True),
                    self.patched("request_bots", **bots),
                ):
                    backend = server.ApprovalSocketBackend(
                        "approve.sock", self.folder
                    )
                    self.assertTrue(backend.approve("ABCDEFGH"))
        missing = self.base / "missing"
        with (
            self.patched("request_approval", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]),
        ):
            backend = server.ApprovalSocketBackend("approve.sock", missing)
            self.assertTrue(backend.approve("ABCDEFGH"))
        self.assertFalse(self.target.exists())

    def test_the_backend_without_a_folder_never_publishes(self):
        with (
            self.patched("request_approval", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]) as asked,
        ):
            backend = server.ApprovalSocketBackend("approve.sock")
            self.assertTrue(backend.approve("ABCDEFGH"))
        asked.assert_not_called()
        self.assertEqual(os.listdir(self.folder), [])


class FakeAuthService:
    def __init__(self, events):
        self.events = events

    def start(self):
        self.events.append("auth-start")

    def close(self):
        self.events.append("auth-close")


def fake_http_server(events, on_serve):
    class FakeHttpServer:
        daemon_threads = False

        def __init__(self, address, handler):
            events.append(("bind", address))

        def serve_forever(self, poll_interval):
            events.append(("serve", on_serve()))

        def server_close(self):
            events.append("close")

    return FakeHttpServer


def refuse_to_serve():
    raise RuntimeError("down")


class ServeTests(BackendCase):
    def publisher(self, fetch=None, **options):
        options.setdefault("interval", 3600.0)
        publisher = chat_bots.ChatBotsPublisher(
            self.folder, fetch or Fetch(["bot-a"]), **options
        )
        self.addCleanup(publisher.stop)
        return publisher

    def serve(self, events, on_serve, **options):
        with mock.patch.object(
            server, "ThreadingHTTPServer", fake_http_server(events, on_serve)
        ):
            server.serve(
                object(),
                FakeAuthService(events),
                "service.internal",
                19091,
                **options,
            )

    def test_serve_publishes_once_before_serving_and_polls_while_serving(self):
        events = []
        self.serve(
            events,
            lambda: (self.target.exists(), len(poll_threads())),
            publisher=self.publisher(),
        )
        self.assertIn(("serve", (True, 1)), events)
        self.assertEqual(self.written()["bots"], ["bot-a"])
        self.assertEqual(events[0], ("bind", ("service.internal", 19091)))
        self.assertEqual(events[-2:], ["close", "auth-close"])
        self.assertEqual(poll_threads(), [])

    def test_serve_stops_the_poll_thread_when_serving_fails(self):
        events = []
        with self.assertRaises(RuntimeError):
            self.serve(events, refuse_to_serve, publisher=self.publisher())
        self.assertEqual(events[-2:], ["close", "auth-close"])
        self.assertEqual(poll_threads(), [])

    def test_serve_keeps_publishing_from_the_poll_thread_while_serving(self):
        events = []
        calls = []
        second = threading.Event()

        def fetch():
            calls.append(1)
            if len(calls) == 2:
                second.set()
            return ["bot-a"]

        ticks = Ticks(1)
        self.serve(
            events,
            lambda: second.wait(5),
            publisher=self.publisher(fetch, wait=ticks, interval=30.0),
        )
        self.assertIn(("serve", True), events)
        self.assertEqual(len(calls), 2)
        self.assertEqual(ticks.intervals[:1], [30.0])

    def test_serve_without_a_publisher_serves_and_starts_no_thread(self):
        events = []
        self.serve(
            events,
            lambda: (self.target.exists(), len(poll_threads())),
        )
        self.assertIn(("serve", (False, 0)), events)
        self.assertFalse(self.target.exists())


class MainWiringTests(BackendCase):
    def test_main_hands_serve_a_publisher_for_the_auth_socket_folder(self):
        oidc_config = FakeOidcConfig()
        runtime = server.RuntimeConfig(
            bind_address="service.internal",
            bind_port=19091,
            oidc_path="oidc.json",
            state_path="state.sqlite",
            socket_path="approve.sock",
            captain_auth_socket_path=str(self.folder / "auth.sock"),
            captain_auth_peer_uid=2700,
            captain_auth_socket_mode=0o660,
            captain_auth_socket_gid=2701,
            trusted_proxy="proxy.internal",
            public_origin="https://approval.example.invalid",
            release_artifact_url="https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
            release_version="1.2.3",
            release_sha256="ab" * 32,
        )
        with (
            mock.patch.object(
                server.sys, "argv", ["server.py", "--config", "runtime.json"]
            ),
            mock.patch.object(
                server, "load_runtime_config", return_value=runtime
            ),
            mock.patch.object(
                server.oidc, "load_config", return_value=oidc_config
            ),
            mock.patch.object(
                server.approval_security,
                "ApprovalState",
                return_value=object(),
            ),
            mock.patch.object(server.captain_auth, "install"),
            mock.patch.object(server, "serve") as serve,
        ):
            self.assertEqual(server.main(), 0)
        self.assertEqual(os.listdir(self.folder), [])
        application, auth_service, address, port = serve.call_args.args
        self.assertEqual(set(serve.call_args.kwargs), {"publisher"})
        publisher = serve.call_args.kwargs["publisher"]
        self.assertIsInstance(publisher, chat_bots.ChatBotsPublisher)
        self.assertIs(application.backend.publisher, publisher)
        with self.patched("request_bots", return_value=["bot-a"]) as asked:
            self.assertTrue(publisher.publish())
        asked.assert_called_once_with("approve.sock")
        self.assertEqual(self.written()["bots"], ["bot-a"])
        self.assertEqual(os.listdir(self.folder), ["chat-bots.json"])


class NoCommentsTests(unittest.TestCase):
    @staticmethod
    def sources():
        return (
            Path(chat_bots.__file__),
            Path(__file__),
        )

    def test_no_comments_in_the_new_code(self):
        for path in self.sources():
            with self.subTest(path=path.name):
                with path.open("rb") as handle:
                    tokens = list(tokenize.tokenize(handle.readline))
                comments = [
                    token.string
                    for token in tokens
                    if token.type == tokenize.COMMENT
                    and not token.string.startswith("#!")
                ]
                self.assertEqual(comments, [])

    def test_no_docstrings_in_the_new_code(self):
        for path in self.sources():
            with self.subTest(path=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if isinstance(
                        node,
                        (
                            ast.Module,
                            ast.ClassDef,
                            ast.FunctionDef,
                            ast.AsyncFunctionDef,
                        ),
                    ):
                        self.assertIsNone(ast.get_docstring(node))


if __name__ == "__main__":
    unittest.main(verbosity=2)
