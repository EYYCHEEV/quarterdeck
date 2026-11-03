from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import file_v1_adapter

ROOT = Path(__file__).resolve().parent
ADAPTER = ROOT / "file_v1_adapter.py"
API_SHORT = bytearray(b"API_" + b"A" * 20)
API_LONG = bytearray(b"API_" + b"B" * 508)


class AdapterSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.keys = self.base / "keys"
        self.join = self.base / "join"
        self.keys.mkdir(mode=0o700)
        self.join.mkdir(mode=0o700)
        self.registry = self.base / "adapters.json"
        entries = {
            "a-short": self.entry("bot-a", "a-short.apikey", "a-short.pointer"),
            "a-long": self.entry("bot-a", "a-long.apikey", "a-long.pointer"),
            "a-invalid": self.entry("bot-a", "a-invalid.apikey", "a-invalid.pointer"),
            "b-store": self.entry("bot-b", "b-store.apikey", "b-store.pointer"),
        }
        self.registry.write_text(json.dumps({"version": 1, "entries": entries}, separators=(",", ":")) + "\n")
        os.chmod(self.registry, 0o600)

    def tearDown(self):
        self.temporary.cleanup()

    def entry(self, bot, item, pointer):
        return {
            "adapter": "file-v1",
            "bot": bot,
            "root": str(self.keys),
            "item": item,
            "pointer": str(self.join / pointer),
        }

    def command(self, operation, bot, entry, key=None, timeout=5):
        return subprocess.run(
            [sys.executable, str(ADAPTER), operation, str(self.registry), bot, entry, "file-v1"],
            input=key,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"},
            cwd=ROOT,
            timeout=timeout,
            check=False,
        )

    def test_file_v1_round_trips_bounded_variable_length_stalwart_api_keys(self):
        for entry, expected in (("a-short", API_SHORT), ("a-long", API_LONG)):
            saved = self.command("save", "bot-a", entry, bytearray(expected))
            self.assertEqual((saved.returncode, saved.stdout, saved.stderr), (0, b"", b""))
            read = self.command("read", "bot-a", entry)
            self.assertEqual(read.returncode, 0)
            self.assertEqual(bytearray(read.stdout), expected)
            self.assertEqual(read.stderr, b"")

    def test_file_v1_refuses_too_long_and_wrong_format_before_writing(self):
        too_long = bytearray(b"API_" + b"A" * file_v1_adapter.MAX_API_KEY_BYTES)
        wrong = bytearray(b"NOT_" + b"A" * 20)
        for value in (too_long, wrong):
            refused = self.command("save", "bot-a", "a-invalid", value)
            self.assertNotEqual(refused.returncode, 0)
            self.assertEqual((refused.stdout, refused.stderr), (b"", b""))
            self.assertFalse((self.keys / "a-invalid.apikey").exists())

    def test_registry_refuses_cross_bot_unknown_entry_and_raw_paths(self):
        for bot, entry in (("bot-a", "b-store"), ("bot-a", "unknown"), ("bot-a", str(self.keys))):
            refused = self.command("save", bot, entry, bytearray(API_SHORT))
            self.assertNotEqual(refused.returncode, 0)
            self.assertEqual((refused.stdout, refused.stderr), (b"", b""))

    def test_read_refuses_oversized_file_before_any_output_is_emitted(self):
        item = self.keys / "a-invalid.apikey"
        item.write_bytes(b"API_" + b"A" * file_v1_adapter.MAX_API_KEY_BYTES)
        os.chmod(item, 0o600)
        pointer = self.join / "a-invalid.pointer"
        pointer.write_text('{"adapter":"file-v1","place":"a-invalid.apikey"}\n')
        os.chmod(pointer, 0o600)
        refused = self.command("read", "bot-a", "a-invalid")
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual((refused.stdout, refused.stderr), (b"", b""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
