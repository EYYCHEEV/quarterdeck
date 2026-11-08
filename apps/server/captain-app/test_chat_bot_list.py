import contextlib
import io
import json
import os
import stat
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import cards
import chat_bot_list
from test_cards import FakeMail, FixtureChecker, message


FILE_NAME = "chat-bots.json"
LOG_LINE = "QD_CHAT_BOTS_INVALID\n"
NOW = 1_800_000_000


def document(*names, v=1, at=NOW):
    return (
        json.dumps({"v": v, "at": at, "bots": list(names)}, separators=(",", ":"))
        + "\n"
    )


def raw(v="1", at=str(NOW), bots='["fern"]', head="", tail=""):
    return f'{{{head}"v":{v},"at":{at},"bots":{bots}{tail}}}'.encode()


def padded(size):
    base = raw()
    return base + b" " * (size - len(base))


class FolderCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.path = self.folder / FILE_NAME
        self.now = [NOW]
        self.reader = chat_bot_list.ChatBotList(self.folder, clock=lambda: self.now[0])
        self.log = ""

    def publish(self, content, mode=0o640):
        data = content if isinstance(content, bytes) else content.encode()
        incoming = self.folder / "incoming"
        descriptor = os.open(incoming, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        os.chmod(incoming, mode)
        os.rename(incoming, self.path)

    def names(self):
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            result = self.reader.names()
        self.log = captured.getvalue()
        return result

    def names_without_blocking(self):
        result = []
        worker = threading.Thread(
            target=lambda: result.append(self.names()),
            daemon=True,
        )
        worker.start()
        worker.join(5)
        if worker.is_alive():
            release = os.open(self.path, os.O_WRONLY | os.O_NONBLOCK)
            os.close(release)
            worker.join(5)
            self.fail("the reader blocked on a fifo")
        return result[0]

    def owners(self, folder, regular):
        real = os.fstat

        def fstat(descriptor):
            info = real(descriptor)
            values = list(info)
            values[4] = folder if stat.S_ISDIR(info.st_mode) else regular
            return os.stat_result(tuple(values))

        return mock.patch.object(chat_bot_list.os, "fstat", side_effect=fstat)


class ChatBotListFileTests(FolderCase):
    def test_a_valid_file_gives_its_names(self):
        self.publish(document("fern", "dale"))

        self.assertEqual(self.names(), frozenset({"fern", "dale"}))
        self.assertIsInstance(self.names(), frozenset)
        self.assertEqual(self.log, "")

    def test_a_valid_empty_list_is_empty_and_not_logged(self):
        self.publish(document())

        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, "")

    def test_the_boundaries_are_accepted(self):
        full = [f"bot-{number}" for number in range(64)]
        longest = "a" + "b" * 31
        for label, content, expected in (
            ("64 names", document(*full), frozenset(full)),
            ("32 character name", document(longest), frozenset({longest})),
            ("one letter name", document("a"), frozenset({"a"})),
            ("digits and dashes", document("a1-2-3"), frozenset({"a1-2-3"})),
            ("4096 bytes", padded(4096), frozenset({"fern"})),
            ("no trailing newline", document("fern").strip(), frozenset({"fern"})),
        ):
            with self.subTest(label):
                self.publish(content)
                self.assertEqual(self.names(), expected)

    def test_every_invalid_shape_gives_the_empty_set(self):
        too_many = json.dumps([f"bot-{number}" for number in range(65)])
        invalid = {
            "empty file": b"",
            "not json": b"{",
            "not utf-8": raw(bots='["x"]').replace(b'"x"', b'"\xff"'),
            "byte order mark": b"\xef\xbb\xbf" + document("fern").encode(),
            "top level list": b"[]",
            "top level string": b'"fern"',
            "top level null": b"null",
            "duplicate v": raw(head='"v":1,'),
            "duplicate at": raw(head=f'"at":{NOW},'),
            "duplicate bots": raw(tail=',"bots":["fern"]'),
            "unknown key": raw(tail=',"extra":1'),
            "only unknown key": b'{"x":1}',
            "missing v": f'{{"at":{NOW},"bots":["fern"]}}'.encode(),
            "missing at": b'{"v":1,"bots":["fern"]}',
            "missing bots": f'{{"v":1,"at":{NOW}}}'.encode(),
            "v two": raw(v="2"),
            "v zero": raw(v="0"),
            "v null": raw(v="null"),
            "v true": raw(v="true"),
            "v float": raw(v="1.0"),
            "v exponent": raw(v="1e0"),
            "v string": raw(v='"1"'),
            "at true": raw(at="true"),
            "at null": raw(at="null"),
            "at float": raw(at=f"{NOW}.0"),
            "at exponent": raw(at="1.8e9"),
            "at string": raw(at=f'"{NOW}"'),
            "at list": raw(at=f"[{NOW}]"),
            "bots string": raw(bots='"fern"'),
            "bots object": raw(bots='{"fern":1}'),
            "bots null": raw(bots="null"),
            "bots number": raw(bots="1"),
            "empty name": raw(bots='[""]'),
            "uppercase name": raw(bots='["Fern"]'),
            "leading digit": raw(bots='["1fern"]'),
            "leading dash": raw(bots='["-fern"]'),
            "underscore": raw(bots='["fa_de"]'),
            "space": raw(bots='["fa de"]'),
            "33 characters": raw(bots=json.dumps(["a" * 33])),
            "non ascii name": raw(bots='["f\\u00e9de"]'),
            "trailing newline in name": raw(bots='["fern\\n"]'),
            "number name": raw(bots="[1]"),
            "null name": raw(bots="[null]"),
            "list name": raw(bots='[["fern"]]'),
            "good name beside a bad one": raw(bots='["fern","Dale"]'),
            "duplicate name": raw(bots='["fern","fern"]'),
            "65 names": raw(bots=too_many),
            "nan constant": raw(bots="[NaN]"),
            "nan at": raw(at="NaN"),
            "deep nesting": b"[" * 4000,
            "4097 bytes": padded(4097),
        }
        for label, content in invalid.items():
            with self.subTest(label):
                self.publish(content)
                self.assertEqual(self.names(), frozenset())

    def test_a_missing_file_gives_the_empty_set(self):
        self.assertEqual(self.names(), frozenset())

    def test_a_missing_or_non_folder_gives_the_empty_set(self):
        self.publish(document("fern"))
        for label, folder in (
            ("missing folder", self.folder / "absent"),
            ("a file instead of a folder", self.path),
        ):
            with self.subTest(label):
                reader = chat_bot_list.ChatBotList(folder, clock=lambda: NOW)
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(reader.names(), frozenset())

    def test_a_symlink_is_never_followed(self):
        target = self.folder / "elsewhere.json"
        target.write_text(document("fern"))
        os.chmod(target, 0o640)
        os.symlink(target, self.path)

        self.assertEqual(self.names(), frozenset())

    def test_a_dangling_symlink_gives_the_empty_set(self):
        os.symlink(self.folder / "nowhere.json", self.path)

        self.assertEqual(self.names(), frozenset())

    def test_a_directory_gives_the_empty_set(self):
        os.mkdir(self.path)

        self.assertEqual(self.names(), frozenset())

    def test_a_fifo_that_holds_valid_content_is_refused(self):
        os.mkfifo(self.path, 0o600)
        holder = os.open(self.path, os.O_RDONLY | os.O_NONBLOCK)
        self.addCleanup(os.close, holder)
        writer = os.open(self.path, os.O_WRONLY | os.O_NONBLOCK)
        os.write(writer, document("fern").encode())
        os.close(writer)

        self.assertEqual(self.names_without_blocking(), frozenset())

    def test_a_fifo_is_refused_without_blocking(self):
        os.mkfifo(self.path, 0o600)

        self.assertEqual(self.names_without_blocking(), frozenset())

    def test_a_parser_recursion_failure_gives_the_empty_set(self):
        self.publish(document("fern"))

        with mock.patch.object(chat_bot_list.json, "loads", side_effect=RecursionError):
            self.assertEqual(self.names(), frozenset())

    def test_short_reads_are_joined_and_the_size_cap_still_holds(self):
        real = os.read

        def short(descriptor, size):
            return real(descriptor, min(size, 1024))

        with mock.patch.object(chat_bot_list.os, "read", side_effect=short):
            for label, content, expected in (
                ("a small file", document("fern"), frozenset({"fern"})),
                ("4096 bytes", padded(4096), frozenset({"fern"})),
                ("4097 bytes", padded(4097), frozenset()),
            ):
                with self.subTest(label):
                    self.publish(content)
                    self.assertEqual(self.names(), expected)

    def test_a_file_owned_by_someone_other_than_the_folder_owner_is_refused(self):
        self.publish(document("fern"))
        owner = os.stat(self.folder).st_uid

        with self.owners(owner, owner + 1):
            self.assertEqual(self.names(), frozenset())
        with self.owners(owner + 1, owner):
            self.assertEqual(self.names(), frozenset())

    def test_the_file_owner_is_compared_with_the_folder_owner_not_the_reader(self):
        self.publish(document("fern"))
        other = os.getuid() + 100

        with self.owners(other, other):
            self.assertEqual(self.names(), frozenset({"fern"}))

    def test_group_or_other_writable_files_are_refused(self):
        for mode in (0o660, 0o620, 0o602, 0o606, 0o666, 0o664):
            with self.subTest(mode=oct(mode)):
                self.publish(document("fern"), mode=mode)
                self.assertEqual(self.names(), frozenset())

    def test_owner_read_modes_without_group_or_other_write_are_accepted(self):
        for mode in (0o400, 0o440, 0o600, 0o640, 0o644, 0o444):
            with self.subTest(mode=oct(mode)):
                self.publish(document("fern"), mode=mode)
                self.assertEqual(self.names(), frozenset({"fern"}))

    def test_the_file_is_read_fresh_on_every_call(self):
        self.publish(document("fern"))
        self.assertEqual(self.names(), frozenset({"fern"}))
        self.publish(document("fern", "dale"))
        self.assertEqual(self.names(), frozenset({"fern", "dale"}))
        self.publish(document())
        self.assertEqual(self.names(), frozenset())
        self.publish(document("dale"))
        self.assertEqual(self.names(), frozenset({"dale"}))

    def test_one_call_opens_the_file_once(self):
        self.publish(document("fern"))
        real = os.open
        opened = []

        def counting(path, *args, **kwargs):
            opened.append(path)
            return real(path, *args, **kwargs)

        with mock.patch.object(chat_bot_list.os, "open", side_effect=counting):
            self.names()

        self.assertEqual(opened.count(FILE_NAME), 1)

    def test_the_default_clock_is_the_wall_clock(self):
        self.publish(document("fern", at=int(time.time())))
        reader = chat_bot_list.ChatBotList(self.folder)

        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(reader.names(), frozenset({"fern"}))


class ChatBotListFreshnessTests(FolderCase):
    def test_the_age_boundaries_are_exact(self):
        for label, age, expected in (
            ("new", 0, frozenset({"fern"})),
            ("30 seconds old", 30, frozenset({"fern"})),
            ("89 seconds old", 89, frozenset({"fern"})),
            ("exactly 90 seconds old", 90, frozenset({"fern"})),
            ("91 seconds old", 91, frozenset()),
            ("an hour old", 3600, frozenset()),
            ("60 seconds ahead", -60, frozenset({"fern"})),
            ("61 seconds ahead", -61, frozenset()),
            ("a day ahead", -86400, frozenset()),
        ):
            with self.subTest(label):
                self.publish(document("fern", at=NOW - age))
                self.assertEqual(self.names(), expected)

    def test_a_stale_file_with_valid_names_gives_the_empty_set(self):
        self.publish(document("fern", "dale", at=NOW - 91))

        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)

    def test_a_boolean_is_never_taken_as_a_time(self):
        for label, value, instant in (("true", "true", 1), ("false", "false", 0)):
            with self.subTest(label):
                reader = chat_bot_list.ChatBotList(self.folder, clock=lambda: instant)
                self.publish(raw(at=value))
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(reader.names(), frozenset())

    def test_a_future_file_with_valid_names_gives_the_empty_set(self):
        self.publish(document("fern", "dale", at=NOW + 61))

        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)

    def test_the_age_is_judged_against_the_clock_on_every_call(self):
        self.publish(document("fern"))

        self.assertEqual(self.names(), frozenset({"fern"}))
        self.now[0] = NOW + 90
        self.assertEqual(self.names(), frozenset({"fern"}))
        self.now[0] = NOW + 91
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)
        self.now[0] = NOW + 5000
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, "")

    def test_the_future_limit_is_judged_against_the_clock_on_every_call(self):
        self.publish(document("fern", at=NOW + 3600))
        self.now[0] = NOW + 3540
        self.assertEqual(self.names(), frozenset({"fern"}))
        self.now[0] = NOW + 3539
        self.assertEqual(self.names(), frozenset())

    def test_a_fresh_publish_recovers_after_a_stale_one(self):
        self.publish(document("fern"))
        self.now[0] = NOW + 91
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)

        self.publish(document("fern", at=NOW + 91))
        self.assertEqual(self.names(), frozenset({"fern"}))
        self.assertEqual(self.log, "")

        self.now[0] = NOW + 182
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)

    def test_a_rewrite_with_the_same_names_keeps_the_file_fresh(self):
        for step in range(1, 6):
            self.now[0] = NOW + step * 30
            self.publish(document("fern", at=self.now[0]))
            self.assertEqual(self.names(), frozenset({"fern"}))
            self.assertEqual(self.log, "")


class ChatBotListLogTests(FolderCase):
    def test_turning_invalid_logs_one_fixed_line_once_per_change(self):
        self.publish(document("fern"))
        self.assertEqual(self.names(), frozenset({"fern"}))
        self.assertEqual(self.log, "")

        self.publish(b"{")
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)
        for _ in range(3):
            self.assertEqual(self.names(), frozenset())
            self.assertEqual(self.log, "")

        self.publish(document("fern"))
        self.assertEqual(self.names(), frozenset({"fern"}))
        self.assertEqual(self.log, "")

        self.publish(b"{")
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)

    def test_a_different_invalid_shape_in_a_row_does_not_log_again(self):
        self.publish(b"{")
        self.names()
        self.assertEqual(self.log, LOG_LINE)

        self.publish(document("Fern"))
        self.names()
        self.assertEqual(self.log, "")

    def test_a_first_call_on_a_missing_file_logs_once(self):
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, LOG_LINE)
        self.assertEqual(self.names(), frozenset())
        self.assertEqual(self.log, "")

    def test_the_line_never_holds_names_or_paths(self):
        self.publish(raw(bots='["secretname","Bad"]'))

        self.names()

        self.assertEqual(self.log, LOG_LINE)
        self.assertNotIn("secretname", self.log)
        self.assertNotIn(str(self.folder), self.log)

    def test_a_broken_error_stream_does_not_break_the_reader(self):
        class Broken:
            def write(self, text):
                raise OSError("stand-in")

            def flush(self):
                raise OSError("stand-in")

        with contextlib.redirect_stderr(Broken()):
            self.assertEqual(self.reader.names(), frozenset())


class FileBackedChatSetTests(FolderCase):
    def setUp(self):
        super().setUp()
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def build(self, messages=()):
        mail = FakeMail(list(messages))
        service = cards.CardService(
            mail,
            FixtureChecker(),
            bot_source=self.reader.names,
        )
        service.refresh()
        return service, mail

    def ids(self, service):
        return sorted(row["id"] for row in service.chat_list())

    def refused(self, call, *args):
        with self.assertRaises(cards.CardRefused):
            call(*args)

    def test_joined_bots_in_the_file_join_the_list_and_can_be_written_to(self):
        self.publish(document("fern", "dale"))
        service, mail = self.build()

        self.assertEqual(self.ids(service), ["bot-a", "dale", "fern"])
        service.send_chat("fern", "Hi Fern", "request-1")
        service.send_chat("dale", "Hi Dale", "request-2")
        self.assertEqual(
            [(item[0], item[1]) for item in mail.sent],
            [("fern", "CHAT: fern"), ("dale", "CHAT: dale")],
        )
        self.assertEqual(service.chat("fern")["bot"], {"id": "fern"})

    def test_a_bot_added_to_the_file_appears_on_the_next_call_without_a_restart(self):
        self.publish(document("fern"))
        service, mail = self.build()
        self.assertNotIn("dale", self.ids(service))
        self.refused(service.send_chat, "dale", "Hi", "request-1")
        self.refused(service.chat, "dale")

        self.publish(document("fern", "dale"))

        self.assertIn("dale", self.ids(service))
        service.send_chat("dale", "Hi", "request-2")
        self.assertEqual(mail.sent[-1][0], "dale")
        self.assertEqual(service.chat("dale")["bot"], {"id": "dale"})

    def test_the_next_publish_drops_a_removed_name_from_the_list_and_from_sends(self):
        self.publish(document("fern", "dale"))
        service, mail = self.build()
        service.send_chat("fern", "Before", "request-1")

        self.now[0] = NOW + 30
        self.publish(document("dale", at=self.now[0]))

        self.assertEqual(self.ids(service), ["bot-a", "dale"])
        self.refused(service.send_chat, "fern", "After", "request-2")
        self.refused(service.chat, "fern")
        service.send_chat("dale", "Still here", "request-3")
        self.assertEqual([item[0] for item in mail.sent], ["fern", "dale"])

    def test_a_file_that_stops_being_refreshed_refuses_every_file_bot_after_90_seconds(self):
        self.publish(document("fern", "dale"))
        service, mail = self.build()

        self.now[0] = NOW + 90
        self.assertEqual(self.ids(service), ["bot-a", "dale", "fern"])
        service.send_chat("fern", "Edge", "request-1")

        self.now[0] = NOW + 91
        self.assertEqual(self.ids(service), ["bot-a"])
        self.refused(service.send_chat, "fern", "After", "request-2")
        self.refused(service.send_chat, "dale", "After", "request-3")
        self.refused(service.chat, "fern")
        self.refused(service.send_chat, "repo-lead", "Registry bots do not stay", "request-4")
        self.refused(service.chat, "repo-lead")
        self.assertEqual([item[0] for item in mail.sent], ["fern"])

    def test_a_future_dated_file_offers_the_oversight_bot_only(self):
        self.publish(document("fern", at=NOW + 61))
        service, mail = self.build()

        self.assertEqual(self.ids(service), ["bot-a"])
        self.refused(service.send_chat, "fern", "Hi", "request-1")
        self.assertEqual(mail.sent, [])

    def test_a_file_that_turns_invalid_gives_the_oversight_bot_only(self):
        def empty_file():
            self.publish(b"")

        def garbage():
            self.publish(b"{")

        def moved_away():
            os.rename(self.path, self.folder / "moved-away.json")

        def writable():
            self.publish(document("fern"), mode=0o666)

        def symlinked():
            target = self.folder / "elsewhere.json"
            target.write_text(document("fern"))
            os.chmod(target, 0o640)
            os.symlink(target, self.folder / "linked")
            os.rename(self.folder / "linked", self.path)

        for label, fail in (
            ("an empty file", empty_file),
            ("an invalid file", garbage),
            ("a missing file", moved_away),
            ("a writable file", writable),
            ("a symlink", symlinked),
        ):
            with self.subTest(label):
                self.publish(document("fern"))
                service, mail = self.build()
                service.send_chat("fern", "Before", "request-1")
                self.assertIn("fern", self.ids(service))

                fail()

                sent = len(mail.sent)
                self.assertEqual(self.ids(service), ["bot-a"])
                self.refused(service.send_chat, "fern", "After", "request-2")
                self.refused(service.chat, "fern")
                self.assertEqual(len(mail.sent), sent)

    def test_an_unreadable_file_offers_the_oversight_bot_only(self):
        service, mail = self.build()

        self.assertEqual(self.ids(service), ["bot-a"])
        self.refused(service.send_chat, "fern", "Hi", "request-1")
        self.refused(service.send_chat, "dale", "Hi", "request-2")
        self.refused(service.chat, "fern")
        service.send_chat("bot-a", "Hi", "request-3")
        self.assertEqual([item[0] for item in mail.sent], ["bot-a"])

    def test_an_invalid_file_never_grants_any_name_it_holds(self):
        self.publish(raw(bots='["fern","dale"]', tail=',"extra":true'))
        service, mail = self.build()

        self.assertEqual(self.ids(service), ["bot-a"])
        self.refused(service.send_chat, "fern", "Hi", "request-1")
        self.refused(service.send_chat, "dale", "Hi", "request-2")
        self.assertEqual(mail.sent, [])

    def test_each_operation_opens_the_file_once_however_many_messages_there_are(self):
        self.publish(document("fern", "dale"))
        messages = [
            message(
                f"m{number}",
                "fern" if number % 2 else "bot-a",
                f"CHAT: {'fern' if number % 2 else 'bot-a'}",
                {
                    "qd": "chat/1",
                    "bot": "fern" if number % 2 else "bot-a",
                    "text": f"Message {number}",
                },
            )
            for number in range(40)
        ]
        service, _ = self.build(messages)
        real = os.open
        opened = []

        def counting(path, *args, **kwargs):
            opened.append(path)
            return real(path, *args, **kwargs)

        operations = (
            ("list", service.chat_list, ()),
            ("open", service.chat, ("fern",)),
            ("send", service.send_chat, ("fern", "Hi", "request-1")),
        )
        for label, call, args in operations:
            with self.subTest(label):
                opened.clear()
                with mock.patch.object(chat_bot_list.os, "open", side_effect=counting):
                    call(*args)
                self.assertEqual(opened.count(FILE_NAME), 1)

    def test_the_captains_account_name_is_never_in_the_set(self):
        self.publish(document("account-user", "fern"))
        service, mail = self.build()

        self.assertEqual(self.ids(service), ["bot-a", "fern"])
        self.refused(service.chat, "account-user")
        self.refused(service.send_chat, "account-user", "Hi", "request-1")
        self.assertEqual(mail.sent, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
