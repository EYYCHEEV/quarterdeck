from __future__ import annotations

import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "golive" / "helper"
if str(HELPER) not in sys.path:
    sys.path.insert(0, str(HELPER))

import write_registry


class TtyInput(io.BytesIO):
    def isatty(self):
        return True


class RegistryWriterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.base.chmod(0o700)
        self.target = self.base / "project-registry.json"
        self.document = {
            "format": 1,
            "steward": "bot-a",
            "captain": "account-user",
            "projects": {
                "Project A": "bot-b",
                "Project New": "bot-d",
            },
        }

    def run_writer(self, document=None, *, source=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        if source is None:
            source = io.BytesIO(
                json.dumps(self.document if document is None else document).encode(
                    "utf-8"
                )
            )
        status = write_registry.run(
            target_path=self.target,
            stdin=source,
            stdout=stdout,
            stderr=stderr,
        )
        return status, stdout.getvalue(), stderr.getvalue()

    def test_writes_exact_stdin_registry_with_fourth_bot_and_private_metadata(self):
        status, stdout, stderr = self.run_writer()
        self.assertEqual((status, stdout, stderr), (0, "REGISTRY_WRITTEN\n", ""))
        self.assertEqual(
            json.loads(self.target.read_text(encoding="utf-8")),
            self.document,
        )
        metadata = self.target.stat()
        self.assertTrue(stat.S_ISREG(metadata.st_mode))
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
        self.assertEqual(metadata.st_uid, os.getuid())
        self.assertEqual(metadata.st_nlink, 1)

    def test_existing_target_is_refused_without_change(self):
        self.target.write_bytes(b"keep-me")
        self.target.chmod(0o600)
        status, stdout, stderr = self.run_writer()
        self.assertEqual(
            (status, stdout, stderr),
            (2, "", "REGISTRY_WRITE_REFUSED\n"),
        )
        self.assertEqual(self.target.read_bytes(), b"keep-me")

    def test_invalid_names_shape_and_empty_projects_are_refused(self):
        cases = (
            self.document | {"captain": "bad name"},
            self.document | {"captain": "bot-a"},
            self.document | {"projects": {"Project": "${registry:lead}"}},
            self.document | {"projects": {"\n": "bot-b"}},
            self.document | {"projects": {}},
            self.document | {"extra": True},
        )
        for document in cases:
            with self.subTest(document=document):
                status, stdout, stderr = self.run_writer(document)
                self.assertEqual(
                    (status, stdout, stderr),
                    (2, "", "REGISTRY_WRITE_REFUSED\n"),
                )
                self.assertFalse(self.target.exists())

    def test_stdin_is_bounded_and_tty_is_refused(self):
        for source in (
            io.BytesIO(b"x" * (write_registry.MAX_REGISTRY_BYTES + 1)),
            TtyInput(json.dumps(self.document).encode("utf-8")),
        ):
            with self.subTest(source=type(source).__name__):
                status, stdout, stderr = self.run_writer(source=source)
                self.assertEqual(
                    (status, stdout, stderr),
                    (2, "", "REGISTRY_WRITE_REFUSED\n"),
                )
                self.assertFalse(self.target.exists())

    def test_fsync_failure_leaves_partial_target(self):
        original_fsync = write_registry.os.fsync
        calls = 0

        def fail_first(descriptor):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("stand-in fsync failure")
            return original_fsync(descriptor)

        with mock.patch.object(
            write_registry.os,
            "fsync",
            side_effect=fail_first,
        ):
            status, stdout, stderr = self.run_writer()
        self.assertEqual(
            (status, stdout, stderr),
            (2, "", "REGISTRY_WRITE_REFUSED\n"),
        )
        self.assertTrue(self.target.exists())

    def test_fixed_path_and_source_have_no_pilot_names_or_secret_channels(self):
        self.assertEqual(
            write_registry.REGISTRY_PATH,
            Path("/var/lib/quarterdeck-captain/project-registry.json"),
        )
        source = Path(write_registry.__file__).read_text(encoding="utf-8").lower()
        for forbidden in (
            "iris",
            "fern",
            "dale",
            "os.environ",
            "logging",
            "template",
        ):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
