from __future__ import annotations

import base64
import csv
import hashlib
import io
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = ROOT.parent
BUILDER = ROOT / "build_wheel.py"
VERSION = "0.1.2"
WHEEL_NAME = f"quarterdeck_mcp-{VERSION}-py3-none-any.whl"
PINS = {
    "golive/connect/qd.py": "2a2771b90b0ce427c14b47763b551bf103c0124a0031a50a72e9bc1d28432a01",
    "golive/connect/qd_connect.py": "c3511aa290b2046a1c765b7337ab788ee23e2e70def7bce0472da7005fa71cf0",
    "golive/connect/qd_mcp.py": "22524b67ed0aa3efc8857a0b74227f3f19d89631244a8eeb01f6f1709559a3a8",
    "mail/qd_jmap.py": "79a582a60ed67eea4ef1240364b3c4ab9b365639c9a9c460a3f08bdf1269ce8f",
    "signup/signup_flow.py": "286ca5d749e98a82bd8a73545393ffe506b265887ff923f272905e6cd87a6bab",
    "signup/helper_contract.py": "15b688cbcfde84bbbd0418fc5ac8606ab3a92acb651fa9bec0d9716cf8a55c1f",
    "signup/adapter_registry.py": "26dd59aebc5f1ee1e35e934e87bfccd4c4b5e2cf3397a38d050f1ef5839a4265",
    "signup/file_v1_adapter.py": "a6ea5a3c979c7477cea4f109f58b18809117b310065eca8ce8fb01ee46f845f6",
}
MODULES = {Path(name).name for name in PINS}
DIST_INFO = f"quarterdeck_mcp-{VERSION}.dist-info"
METADATA = {
    f"{DIST_INFO}/METADATA",
    f"{DIST_INFO}/WHEEL",
    f"{DIST_INFO}/entry_points.txt",
    f"{DIST_INFO}/RECORD",
}


def digest(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest())
    return "sha256=" + encoded.rstrip(b"=").decode("ascii")


class WheelTests(unittest.TestCase):
    def run_builder(self, source: Path, output: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--source-root",
                str(source),
                "--version",
                VERSION,
                "--output",
                str(output),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_build_is_reproducible_and_contains_only_pinned_client_modules(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()

            first_run = self.run_builder(SOURCE_ROOT, first)
            second_run = self.run_builder(SOURCE_ROOT, second)

            self.assertEqual(first_run.returncode, 0, first_run.stderr)
            self.assertEqual(second_run.returncode, 0, second_run.stderr)
            first_wheel = first / WHEEL_NAME
            second_wheel = second / WHEEL_NAME
            self.assertEqual(first_wheel.read_bytes(), second_wheel.read_bytes())

            with zipfile.ZipFile(first_wheel) as archive:
                names = archive.namelist()
                self.assertEqual(set(names), MODULES | METADATA)
                self.assertEqual(len(names), len(set(names)))
                for information in archive.infolist():
                    self.assertEqual(information.date_time, (1980, 1, 1, 0, 0, 0))
                    self.assertEqual(information.compress_type, zipfile.ZIP_STORED)
                    self.assertEqual(information.external_attr >> 16, 0o100644)
                for source_name, expected in PINS.items():
                    module = Path(source_name).name
                    self.assertEqual(
                        hashlib.sha256(archive.read(module)).hexdigest(),
                        expected,
                    )
                metadata = archive.read(f"{DIST_INFO}/METADATA").decode("utf-8")
                self.assertIn("Name: quarterdeck-mcp\n", metadata)
                self.assertIn(f"Version: {VERSION}\n", metadata)
                self.assertIn("Requires-Python: >=3.11\n", metadata)
                wheel = archive.read(f"{DIST_INFO}/WHEEL").decode("utf-8")
                self.assertIn("Root-Is-Purelib: true\n", wheel)
                self.assertIn("Tag: py3-none-any\n", wheel)
                entry_points = archive.read(
                    f"{DIST_INFO}/entry_points.txt"
                ).decode("utf-8")
                self.assertEqual(
                    entry_points,
                    "[console_scripts]\n"
                    "qd = qd:main\n"
                    "qd-file-v1 = file_v1_adapter:main\n"
                    "qd-mcp = qd_mcp:main\n",
                )
                rows = list(
                    csv.reader(
                        io.StringIO(
                            archive.read(f"{DIST_INFO}/RECORD").decode("utf-8")
                        )
                    )
                )
                self.assertEqual({row[0] for row in rows}, set(names))
                for name, recorded_digest, recorded_size in rows:
                    if name == f"{DIST_INFO}/RECORD":
                        self.assertEqual((recorded_digest, recorded_size), ("", ""))
                    else:
                        data = archive.read(name)
                        self.assertEqual(recorded_digest, digest(data))
                        self.assertEqual(recorded_size, str(len(data)))

    def test_build_refuses_a_client_file_outside_the_accepted_pins(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            output = root / "output"
            output.mkdir()
            for name in PINS:
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((SOURCE_ROOT / name).read_bytes())
            with (source / "golive/connect/qd.py").open("ab") as target:
                target.write(b"\n")

            result = self.run_builder(source, output)

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((output / WHEEL_NAME).exists())
            self.assertIn("accepted client hash mismatch", result.stderr)
            self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
