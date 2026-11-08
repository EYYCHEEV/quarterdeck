from __future__ import annotations

import ast
import errno
import itertools
import json
import os
import stat
import tempfile
import tokenize
import unittest
from pathlib import Path
from unittest import mock

import approval_security
import chat_bots
import server
import test_chat_bots as base
import test_server

NOW = base.NOW
OLD = base.OLD
Fetch = base.Fetch
PUBLISHED = "QD_CHAT_BOTS_PUBLISHED\n"
FETCH_FAILED = "QD_CHAT_BOTS_FETCH_FAILED\n"
EMPTIED = "QD_CHAT_BOTS_EMPTIED\n"
WRITE_FAILED = "QD_CHAT_BOTS_WRITE_FAILED\n"
COPY_FAILED = "QD_CHAT_BOTS_COPY_WRITE_FAILED\n"
NOT_ROOT = unittest.skipIf(os.geteuid() == 0, "root ignores folder modes")


def document(names, at=NOW):
    return base.document(names, at)


class RenamedFoldersOs:
    def __init__(self, real):
        self._real = real
        self.folders = []

    def __getattr__(self, attribute):
        value = getattr(self._real, attribute)
        if attribute != "rename":
            return value

        def call(*args, **kwargs):
            descriptor = kwargs["dst_dir_fd"]
            self.folders.append(
                os.path.realpath(os.readlink(f"/proc/self/fd/{descriptor}"))
            )
            return value(*args, **kwargs)

        return call


class CopyCase(base.PublisherCase):
    def setUp(self):
        super().setUp()
        self.fresh_copy()

    def fresh_copy(self):
        self.copy_folder = self.base / f"chat-bots-copy-{next(self.counter)}"
        self.copy_folder.mkdir()
        self.copy_folder.chmod(0o2750)
        self.copy_target = self.copy_folder / chat_bots.FILE_NAME
        return self.copy_folder

    def make_copy(self, fetch, **options):
        options.setdefault("copy_folder", self.copy_folder)
        return self.make(fetch, **options)

    def seed_copy(self, content=OLD, mode=0o640):
        self.copy_target.write_bytes(content)
        self.copy_target.chmod(mode)

    def copy_listing(self):
        return sorted(os.listdir(self.copy_folder))


class SameBytesTests(CopyCase):
    def test_both_files_have_the_same_bytes_after_each_publish(self):
        publisher = self.make_copy(Fetch(["bot-a", "bot-b"], ["bot-b"], []))
        for step, names in enumerate((["bot-a", "bot-b"], ["bot-b"], [])):
            self.clock.now = NOW + 30 * step
            self.assertTrue(publisher.publish())
            expected = document(names, NOW + 30 * step)
            self.assertEqual(self.target.read_bytes(), expected)
            self.assertEqual(self.copy_target.read_bytes(), expected)
            for path in (self.target, self.copy_target):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            self.assertEqual(self.listing(), ["chat-bots.json"])
            self.assertEqual(self.copy_listing(), ["chat-bots.json"])
        self.assertEqual(self.logged(), PUBLISHED)

    def test_a_publish_reads_the_clock_once_so_both_files_carry_one_time(self):
        ticks = itertools.count(NOW)
        publisher = self.make_copy(
            Fetch(["bot-a"]), clock=lambda: next(ticks)
        )
        for step in range(2):
            self.assertTrue(publisher.publish())
            expected = document(["bot-a"], NOW + step)
            self.assertEqual(self.target.read_bytes(), expected)
            self.assertEqual(self.copy_target.read_bytes(), expected)

    def test_the_excluded_account_name_is_in_neither_file(self):
        publisher = self.make_copy(
            Fetch(["bot-a", "account-user"]),
            exclude=frozenset({"account-user"}),
        )
        self.assertTrue(publisher.publish())
        for path in (self.target, self.copy_target):
            self.assertEqual(path.read_bytes(), document(["bot-a"]))

    def test_the_main_folder_is_written_before_the_copy_folder(self):
        recorder = RenamedFoldersOs(os)
        publisher = self.make_copy(Fetch(["bot-a"]))
        with mock.patch.object(chat_bots, "os", recorder):
            self.assertTrue(publisher.publish())
        self.assertEqual(
            recorder.folders,
            [
                os.path.realpath(self.folder),
                os.path.realpath(self.copy_folder),
            ],
        )

    def test_each_folder_gets_the_same_exclusive_temp_file_and_rename(self):
        recorder = base.RecordingOs(os)
        publisher = self.make_copy(Fetch(["bot-a"]))
        with mock.patch.object(chat_bots, "os", recorder):
            publisher.publish()
        folders = [call for call in recorder.opens if "dir_fd" not in call[1]]
        temps = [call for call in recorder.opens if "dir_fd" in call[1]]
        self.assertEqual(len(folders), 2)
        self.assertEqual(len(temps), 2)
        for args, _ in folders:
            self.assertTrue(args[1] & os.O_DIRECTORY)
        names = [args[0] for args, _ in temps]
        self.assertEqual(len(set(names)), 2)
        for (args, kwargs), name in zip(temps, names):
            self.assertTrue(name.startswith(".chat-bots.json."))
            self.assertTrue(name.endswith(".tmp"))
            for required in (os.O_CREAT, os.O_EXCL, os.O_NOFOLLOW):
                self.assertTrue(args[1] & required)
            self.assertEqual(args[1] & os.O_ACCMODE, os.O_WRONLY)
            self.assertEqual(args[2], 0o600)

    def test_the_two_failure_empty_list_reaches_both_files(self):
        for label, failure in (
            ("none", None),
            ("exception", RuntimeError("canary-bot")),
        ):
            with self.subTest(failure=label):
                self.fresh()
                self.fresh_copy()
                publisher = self.make_copy(Fetch(["bot-a", "bot-b"], failure))
                self.clock.now = NOW
                publisher.publish()
                good = document(["bot-a", "bot-b"], NOW)
                self.assertEqual(self.copy_target.read_bytes(), good)
                self.clock.now = NOW + 30
                self.assertFalse(publisher.publish())
                self.assertEqual(self.target.read_bytes(), good)
                self.assertEqual(self.copy_target.read_bytes(), good)
                for step in (2, 3):
                    self.clock.now = NOW + 30 * step
                    self.assertTrue(publisher.publish())
                    expected = document([], NOW + 30 * step)
                    self.assertEqual(self.target.read_bytes(), expected)
                    self.assertEqual(self.copy_target.read_bytes(), expected)
                self.assertEqual(
                    self.logged(), PUBLISHED + FETCH_FAILED + EMPTIED
                )

    def test_one_failed_fetch_keeps_both_previous_files(self):
        self.seed()
        self.seed_copy()
        publisher = self.make_copy(Fetch(None))
        self.assertFalse(publisher.publish())
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual(self.copy_target.read_bytes(), OLD)
        self.assertEqual(self.listing(), ["chat-bots.json"])
        self.assertEqual(self.copy_listing(), ["chat-bots.json"])
        self.assertEqual(self.logged(), FETCH_FAILED)

    def test_the_poll_thread_writes_both_files(self):
        ticks = base.Ticks(1)
        publisher = self.make_copy(Fetch(["bot-a"]), wait=ticks)
        publisher.start()
        publisher.stop()
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.copy_target.read_bytes(), document(["bot-a"]))

    def test_the_copy_line_is_the_fixed_contract_value(self):
        self.assertEqual(
            chat_bots.COPY_WRITE_FAILED, "QD_CHAT_BOTS_COPY_WRITE_FAILED\n"
        )


class CopyFailureTests(CopyCase):
    COPY_STEPS = (
        ("folder-open", "open", 3, False),
        ("temp-create", "open", 4, False),
        ("write", "write", 2, False),
        ("file-fsync", "fsync", 3, False),
        ("fchmod", "fchmod", 2, False),
        ("rename", "rename", 2, False),
        ("folder-fsync", "fsync", 4, True),
    )

    def test_a_missing_copy_folder_leaves_the_main_file_right(self):
        missing = self.base / "missing"
        publisher = self.make_copy(Fetch(["bot-a"]), copy_folder=missing)
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.listing(), ["chat-bots.json"])
        self.assertFalse(missing.exists())
        self.assertEqual(self.logged(), PUBLISHED + COPY_FAILED)

    @NOT_ROOT
    def test_an_unwritable_copy_folder_is_left_untouched(self):
        self.seed_copy()
        self.copy_folder.chmod(0o500)
        self.addCleanup(self.copy_folder.chmod, 0o700)
        publisher = self.make_copy(Fetch(["bot-a"]))
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.copy_target.read_bytes(), OLD)
        self.assertEqual(self.copy_listing(), ["chat-bots.json"])
        self.assertEqual(self.logged(), PUBLISHED + COPY_FAILED)

    def test_a_symlinked_copy_folder_is_refused_without_touching_its_target(self):
        for previous in (None, OLD):
            with self.subTest(existing_file=previous is not None):
                self.fresh()
                real = self.base / f"real-copy-{next(self.counter)}"
                real.mkdir()
                expected = {}
                if previous is not None:
                    expected = {"chat-bots.json": previous, "kept": b"kept"}
                    for name, content in expected.items():
                        (real / name).write_bytes(content)
                link = self.base / f"copy-link-{next(self.counter)}"
                os.symlink(real, link)
                publisher = self.make_copy(Fetch(["bot-a"]), copy_folder=link)
                for step in range(2):
                    self.clock.now = NOW + 30 * step
                    self.assertTrue(publisher.publish())
                    self.assertEqual(
                        self.target.read_bytes(), document(["bot-a"], self.clock.now)
                    )
                    self.assertEqual(self.listing(), ["chat-bots.json"])
                    self.assertEqual(sorted(os.listdir(real)), sorted(expected))
                    for name, content in expected.items():
                        self.assertEqual((real / name).read_bytes(), content)
                    self.assertTrue(link.is_symlink())
                    self.assertEqual(
                        self.logged(), PUBLISHED + COPY_FAILED if step == 0 else ""
                    )

    def test_a_symlinked_main_folder_still_publishes_to_the_main_and_copy(self):
        self.seed()
        link = self.base / "main-link"
        os.symlink(self.folder, link)
        publisher = chat_bots.ChatBotsPublisher(
            link, Fetch(["bot-a"]), clock=self.clock, copy_folder=self.copy_folder
        )
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.copy_target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.listing(), ["chat-bots.json"])
        self.assertEqual(self.copy_listing(), ["chat-bots.json"])
        self.assertTrue(link.is_symlink())
        self.assertEqual(self.logged(), PUBLISHED)

    def test_a_dangling_symlink_as_the_copy_folder_is_a_failed_copy(self):
        nowhere = self.base / "nowhere"
        link = self.base / "copy-link"
        os.symlink(nowhere, link)
        publisher = self.make_copy(Fetch(["bot-a"]), copy_folder=link)
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertFalse(nowhere.exists())
        self.assertTrue(link.is_symlink())
        self.assertEqual(self.logged(), PUBLISHED + COPY_FAILED)

    def test_a_symlink_to_a_file_as_the_copy_folder_is_a_failed_copy(self):
        victim = self.base / "victim"
        victim.write_bytes(b"victim")
        link = self.base / "copy-link"
        os.symlink(victim, link)
        publisher = self.make_copy(Fetch(["bot-a"]), copy_folder=link)
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(victim.read_bytes(), b"victim")
        self.assertEqual(self.logged(), PUBLISHED + COPY_FAILED)

    def test_a_copy_target_that_is_a_symlink_is_replaced_by_rename_only(self):
        victim = self.base / "victim"
        victim.write_bytes(b"victim")
        os.symlink(victim, self.copy_target)
        publisher = self.make_copy(Fetch(["bot-a"]))
        self.assertTrue(publisher.publish())
        self.assertFalse(self.copy_target.is_symlink())
        self.assertEqual(self.copy_target.read_bytes(), document(["bot-a"]))
        self.assertEqual(victim.read_bytes(), b"victim")
        self.assertEqual(self.copy_listing(), ["chat-bots.json"])
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.logged(), PUBLISHED)

    def test_a_dangling_symlink_as_the_copy_target_is_replaced_by_rename_only(self):
        nowhere = self.base / "not-yet"
        os.symlink(nowhere, self.copy_target)
        publisher = self.make_copy(Fetch(["bot-a"]))
        self.assertTrue(publisher.publish())
        self.assertFalse(self.copy_target.is_symlink())
        self.assertFalse(nowhere.exists())
        self.assertEqual(self.copy_target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.logged(), PUBLISHED)

    def test_a_folder_at_the_copy_target_is_left_alone(self):
        self.copy_target.mkdir()
        (self.copy_target / "kept").write_bytes(b"kept")
        publisher = self.make_copy(Fetch(["bot-a"]))
        self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))
        self.assertTrue(self.copy_target.is_dir())
        self.assertEqual((self.copy_target / "kept").read_bytes(), b"kept")
        self.assertEqual(self.copy_listing(), ["chat-bots.json"])
        self.assertEqual(self.logged(), PUBLISHED + COPY_FAILED)

    def test_a_failure_at_any_copy_step_leaves_the_main_file_right_and_no_temporary_file(self):
        for label, function, nth, replaced in self.COPY_STEPS:
            for failure_type in (OSError, RuntimeError):
                for previous in (OLD, None):
                    with self.subTest(
                        step=label,
                        failure=failure_type.__name__,
                        previous=previous is not None,
                    ):
                        self.fresh()
                        self.fresh_copy()
                        if previous is not None:
                            self.seed_copy(previous)
                        publisher = self.make_copy(Fetch(["bot-a"]))
                        failure = failure_type(errno.EIO, "injected")
                        descriptors = base.open_descriptors()
                        with mock.patch.object(
                            chat_bots,
                            "os",
                            base.FaultyOs(os, function, nth, failure),
                        ):
                            self.assertTrue(publisher.publish())
                        self.assertEqual(base.open_descriptors(), descriptors)
                        self.assertEqual(
                            self.target.read_bytes(), document(["bot-a"])
                        )
                        self.assertEqual(self.listing(), ["chat-bots.json"])
                        if replaced:
                            self.assertEqual(
                                self.copy_target.read_bytes(),
                                document(["bot-a"]),
                            )
                            self.assertEqual(
                                self.copy_listing(), ["chat-bots.json"]
                            )
                        elif previous is not None:
                            self.assertEqual(
                                self.copy_target.read_bytes(), previous
                            )
                            self.assertEqual(
                                self.copy_listing(), ["chat-bots.json"]
                            )
                        else:
                            self.assertEqual(self.copy_listing(), [])
                        self.assertEqual(self.logged(), PUBLISHED + COPY_FAILED)

    def test_the_copy_publisher_recovers_after_a_failed_copy_write(self):
        self.seed_copy()
        publisher = self.make_copy(Fetch(["bot-a"]))
        failure = OSError(errno.ENOSPC, "injected")
        with mock.patch.object(
            chat_bots, "os", base.FaultyOs(os, "write", 2, failure)
        ):
            self.assertTrue(publisher.publish())
        self.assertEqual(self.copy_target.read_bytes(), OLD)
        self.assertTrue(publisher.publish())
        self.assertEqual(self.copy_target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.copy_listing(), ["chat-bots.json"])

    @NOT_ROOT
    def test_the_copy_line_is_logged_once_per_change_of_outcome(self):
        later = self.base / "later"
        publisher = self.make_copy(Fetch(["bot-a"]), copy_folder=later)
        lines = []
        for _ in range(3):
            publisher.publish()
            lines.append(self.logged())
        later.mkdir()
        later.chmod(0o2750)
        self.addCleanup(later.chmod, 0o700)
        publisher.publish()
        lines.append(self.logged())
        self.assertEqual(
            (later / "chat-bots.json").read_bytes(), document(["bot-a"])
        )
        later.chmod(0o500)
        publisher.publish()
        lines.append(self.logged())
        later.chmod(0o700)
        publisher.publish()
        lines.append(self.logged())
        self.assertEqual(
            lines, [PUBLISHED + COPY_FAILED, "", "", "", COPY_FAILED, ""]
        )

    def test_a_failing_copy_never_changes_the_main_file_or_its_log_lines(self):
        results = (
            ["bot-a"],
            ["bot-a", "bot-b"],
            RuntimeError("canary-bot"),
            None,
            None,
            ["bot-c"],
        )

        def run(folder, **options):
            publisher = chat_bots.ChatBotsPublisher(
                folder, Fetch(*results), clock=self.clock, **options
            )
            seen = []
            for step in range(len(results)):
                self.clock.now = NOW + 30 * step
                publisher.publish()
                target = folder / chat_bots.FILE_NAME
                content = target.read_bytes() if target.exists() else None
                seen.append((content, self.logged()))
            return seen

        plain = run(self.folder)
        failing = run(self.fresh(), copy_folder=self.base / "missing")
        self.assertEqual(
            [content for content, _ in failing],
            [content for content, _ in plain],
        )
        self.assertEqual(
            [line for _, line in plain],
            [PUBLISHED, "", FETCH_FAILED, EMPTIED, "", PUBLISHED],
        )
        self.assertEqual(
            [line for _, line in failing],
            [PUBLISHED + COPY_FAILED, "", FETCH_FAILED, EMPTIED, "", PUBLISHED],
        )

    def test_a_failed_main_write_does_not_stop_the_copy_write(self):
        self.seed()
        publisher = self.make_copy(Fetch(["bot-a"]))
        failure = OSError(errno.EIO, "injected")
        with mock.patch.object(
            chat_bots, "os", base.FaultyOs(os, "rename", 1, failure)
        ):
            self.assertFalse(publisher.publish())
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual(self.listing(), ["chat-bots.json"])
        self.assertEqual(self.copy_target.read_bytes(), document(["bot-a"]))
        self.assertEqual(self.copy_listing(), ["chat-bots.json"])
        self.assertEqual(self.logged(), WRITE_FAILED)

    def test_both_writes_failing_logs_each_fixed_line_once(self):
        publisher = self.make_copy(
            Fetch(["bot-a"]), copy_folder=self.base / "missing"
        )
        failure = OSError(errno.EIO, "canary-bot " + str(self.folder))
        for _ in range(2):
            with mock.patch.object(
                chat_bots, "os", base.FaultyOs(os, "rename", 1, failure)
            ):
                self.assertFalse(publisher.publish())
        lines = self.logged().splitlines(keepends=True)
        self.assertEqual(sorted(lines), sorted([COPY_FAILED, WRITE_FAILED]))
        self.assertEqual(self.listing(), [])

    def test_a_broken_log_channel_never_breaks_a_copy_publish(self):
        class BrokenStream:
            def write(self, text):
                raise OSError(errno.EPIPE, "closed")

            def flush(self):
                raise OSError(errno.EPIPE, "closed")

        publisher = self.make_copy(
            Fetch(["bot-a"]), copy_folder=self.base / "missing"
        )
        with mock.patch.object(chat_bots.sys, "stderr", BrokenStream()):
            self.assertTrue(publisher.publish())
        self.assertEqual(self.target.read_bytes(), document(["bot-a"]))


class NoKeyTests(base.PublisherCase):
    def test_without_the_key_the_bytes_the_log_and_the_file_calls_are_todays(self):
        for label, options in (("omitted", {}), ("none", {"copy_folder": None})):
            with self.subTest(copy_folder=label):
                folder = self.fresh()
                recorder = base.RecordingOs(os)
                results = (
                    ["canary-bot"],
                    ["canary-bot"],
                    RuntimeError("canary-bot"),
                    None,
                    None,
                    ["canary-bot"],
                )
                publisher = self.make(Fetch(*results), **options)
                expected_lines = [
                    PUBLISHED,
                    "",
                    FETCH_FAILED,
                    EMPTIED,
                    "",
                    PUBLISHED,
                ]
                expected_bytes = [
                    document(["canary-bot"], NOW),
                    document(["canary-bot"], NOW + 30),
                    document(["canary-bot"], NOW + 30),
                    document([], NOW + 90),
                    document([], NOW + 120),
                    document(["canary-bot"], NOW + 150),
                ]
                with mock.patch.object(chat_bots, "os", recorder):
                    for step in range(len(results)):
                        self.clock.now = NOW + 30 * step
                        publisher.publish()
                        self.assertEqual(self.logged(), expected_lines[step])
                        self.assertEqual(
                            self.target.read_bytes(), expected_bytes[step]
                        )
                self.assertEqual(len(recorder.opens), 10)
                self.assertEqual(sorted(os.listdir(folder)), ["chat-bots.json"])
                self.assertEqual(
                    sorted(
                        name
                        for name in os.listdir(self.base)
                        if name.startswith("chat-bots")
                    ),
                    [],
                )


class RuntimeKeyTests(unittest.TestCase):
    RELEASE = {"artifactUrl": None, "version": None, "sha256": None}

    def document(self, **extra):
        document = test_server.ApprovalServerTests.runtime_document(self.RELEASE)
        document.update(extra)
        return document

    def load(self, **extra):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.json"
            path.write_text(json.dumps(self.document(**extra)), encoding="utf-8")
            return server.load_runtime_config(path)

    def test_the_key_is_optional_and_absent_means_no_copy(self):
        self.assertIsNone(self.load().chat_bots_copy_folder)

    def test_an_absolute_path_is_accepted_as_it_is(self):
        for value in (
            "/run/quarterdeck-chat-bots",
            "/a",
            "/a/b/c",
            "/with space/x",
        ):
            with self.subTest(value=value):
                runtime = self.load(chatBotsCopyFolder=value)
                self.assertEqual(runtime.chat_bots_copy_folder, value)

    def test_every_other_value_is_refused_at_start(self):
        invalid = {
            "empty": "",
            "relative": "chat-bots-copy",
            "dot relative": "./chat-bots-copy",
            "parent relative": "../chat-bots-copy",
            "home": "~/chat-bots-copy",
            "leading space": " /run/quarterdeck-chat-bots",
            "null": None,
            "number": 7,
            "true": True,
            "list": ["/run/quarterdeck-chat-bots"],
            "object": {"path": "/run/quarterdeck-chat-bots"},
            "nul byte": "/run/quarterdeck\0chat-bots",
        }
        for label, value in invalid.items():
            with self.subTest(value=label):
                with self.assertRaises(approval_security.ApprovalRefused):
                    self.load(chatBotsCopyFolder=value)

    def test_other_unknown_keys_are_still_refused_with_the_key_present(self):
        for extra in (
            {"chatBotsCopyFolder": "/run/x", "other": 1},
            {"chatBotsFolder": "/run/x"},
            {"chatBotsCopy": "/run/x"},
        ):
            with self.subTest(extra=sorted(extra)):
                with self.assertRaises(approval_security.ApprovalRefused):
                    self.load(**extra)

    def test_the_key_is_not_accepted_inside_another_section(self):
        document = self.document()
        document["paths"]["chatBotsCopyFolder"] = "/run/x"
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaises(approval_security.ApprovalRefused):
                server.load_runtime_config(path)

    def test_main_refuses_to_start_on_a_bad_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.json"
            path.write_text(
                json.dumps(self.document(chatBotsCopyFolder="relative")),
                encoding="utf-8",
            )
            with (
                mock.patch.object(
                    server.sys, "argv", ["server.py", "--config", str(path)]
                ),
                mock.patch.object(server, "serve") as serve,
                mock.patch.object(server.oidc, "load_config") as loaded,
            ):
                self.assertEqual(server.main(), 2)
        serve.assert_not_called()
        loaded.assert_not_called()


class BackendCopyTests(base.BackendCase):
    def setUp(self):
        super().setUp()
        self.copy = self.base / "chat-bots-copy"
        self.copy.mkdir()
        self.copy.chmod(0o2750)
        self.copy_target = self.copy / "chat-bots.json"

    def test_an_approve_success_writes_both_folders(self):
        calls = []

        def bots(path):
            calls.append(path)
            return ["bot-a", "bot-b"]

        with (
            self.patched("request_approval", return_value=True),
            self.patched("request_bots", side_effect=bots),
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", self.folder, self.copy
            )
            self.assertTrue(backend.approve("ABCDEFGH"))
        self.assertEqual(calls, ["approve.sock"])
        self.assertEqual(self.written()["bots"], ["bot-a", "bot-b"])
        self.assertEqual(
            self.copy_target.read_bytes(), self.target.read_bytes()
        )
        self.assertEqual(os.listdir(self.copy), ["chat-bots.json"])

    def test_an_approve_success_still_succeeds_when_the_copy_cannot_be_written(self):
        with (
            self.patched("request_approval", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]),
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", self.folder, self.base / "missing"
            )
            self.assertTrue(backend.approve("ABCDEFGH"))
        self.assertEqual(self.written()["bots"], ["bot-a"])
        self.assertEqual(self.log.getvalue(), PUBLISHED + COPY_FAILED)

    def test_the_other_reviewed_actions_write_neither_folder(self):
        with (
            self.patched("request_pending", return_value=[]),
            self.patched("request_invites", return_value=[]),
            self.patched("request_refusal", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]) as asked,
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", self.folder, self.copy
            )
            backend.pending()
            backend.invites()
            backend.refuse("ABCDEFGH")
        asked.assert_not_called()
        self.assertEqual(os.listdir(self.folder), [])
        self.assertEqual(os.listdir(self.copy), [])

    def test_without_a_copy_folder_only_the_main_folder_is_written(self):
        with (
            self.patched("request_approval", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]),
        ):
            backend = server.ApprovalSocketBackend("approve.sock", self.folder)
            self.assertTrue(backend.approve("ABCDEFGH"))
        self.assertEqual(os.listdir(self.folder), ["chat-bots.json"])
        self.assertEqual(os.listdir(self.copy), [])
        self.assertEqual(self.log.getvalue(), PUBLISHED)

    def test_a_copy_folder_without_a_main_folder_publishes_nothing(self):
        with (
            self.patched("request_approval", return_value=True),
            self.patched("request_bots", return_value=["bot-a"]) as asked,
        ):
            backend = server.ApprovalSocketBackend(
                "approve.sock", None, self.copy
            )
            self.assertTrue(backend.approve("ABCDEFGH"))
        asked.assert_not_called()
        self.assertEqual(os.listdir(self.copy), [])


class MainCopyWiringTests(base.BackendCase):
    def runtime(self, **options):
        return server.RuntimeConfig(
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
            release_artifact_url=None,
            release_version=None,
            release_sha256=None,
            **options,
        )

    def run_main(self, runtime):
        with (
            mock.patch.object(
                server.sys, "argv", ["server.py", "--config", "runtime.json"]
            ),
            mock.patch.object(
                server, "load_runtime_config", return_value=runtime
            ),
            mock.patch.object(
                server.oidc,
                "load_config",
                return_value=test_server.FakeOidcConfig(),
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
        self.assertEqual(set(serve.call_args.kwargs), {"publisher"})
        return serve.call_args.kwargs["publisher"]

    def test_main_hands_serve_a_publisher_that_writes_both_folders(self):
        copy = self.base / "chat-bots-copy"
        copy.mkdir()
        copy.chmod(0o2750)
        publisher = self.run_main(
            self.runtime(chat_bots_copy_folder=str(copy))
        )
        self.assertEqual(os.listdir(copy), [])
        with self.patched("request_bots", return_value=["bot-a"]):
            self.assertTrue(publisher.publish())
        self.assertEqual(self.written()["bots"], ["bot-a"])
        self.assertEqual(
            (copy / "chat-bots.json").read_bytes(), self.target.read_bytes()
        )
        self.assertEqual(os.listdir(copy), ["chat-bots.json"])

    def test_main_without_the_key_writes_only_the_main_folder(self):
        publisher = self.run_main(self.runtime())
        with self.patched("request_bots", return_value=["bot-a"]):
            self.assertTrue(publisher.publish())
        self.assertEqual(self.written()["bots"], ["bot-a"])
        self.assertEqual(os.listdir(self.base), ["captain-auth"])
        self.assertEqual(os.listdir(self.folder), ["chat-bots.json"])


class NoCommentsTests(unittest.TestCase):
    @staticmethod
    def sources(*extra):
        return (Path(chat_bots.__file__), Path(__file__), *extra)

    def test_no_comments_in_the_changed_code(self):
        for path in self.sources(Path(server.__file__)):
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
