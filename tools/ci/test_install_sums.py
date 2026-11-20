import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


GUIDE = Path(__file__).resolve().parents[2] / "omp-quarterdeck" / "INSTALL.md"
ARCHIVE = "quarterdeck-omp-wake-X.Y.Z.tar.gz"
WHEEL = "quarterdeck_mcp-X.Y.Z-py3-none-any.whl"
SIGNATURE = ARCHIVE + ".sig"
LOOKALIKE = "old-" + ARCHIVE
MARKER = "omp-quarterdeck/UNPACKED"


def guide_block(heading):
    lines = GUIDE.read_text(encoding="utf-8").splitlines()
    start = lines.index(heading) + 1
    for index in range(start, len(lines)):
        if lines[index].startswith("## "):
            break
        if lines[index] == "```sh":
            return "\n".join(lines[index + 1:lines.index("```", index + 1)]) + "\n"
    raise AssertionError(f"No shell block under {heading}")


def archive_bytes(content):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        marker = tarfile.TarInfo(MARKER)
        marker.size = len(content)
        archive.addfile(marker, io.BytesIO(content))
    return buffer.getvalue()


def checksum_entry(data, filename):
    return f"{hashlib.sha256(data).hexdigest()}  {filename}\n"


class InstallSumsTest(unittest.TestCase):
    def check_block(self, heading, checksum_tool):
        if shutil.which(checksum_tool) is None:
            if checksum_tool == "shasum" and os.environ.get("QD_REQUIRE_SHASUM") == "1":
                self.fail("shasum is required but not installed")
            self.skipTest(f"{checksum_tool} is not installed")

        block = guide_block(heading)
        shells = [(name, shutil.which(name)) for name in ("sh", "bash", "zsh")]
        self.assertTrue(any(path for _, path in shells), "no supported shell is installed")

        good = archive_bytes(b"release\n")
        altered = archive_bytes(b"altered\n")
        lookalike = archive_bytes(b"lookalike\n")
        signature = b"signature\n"
        wheel = b"wheel\n"
        wheel_entry = checksum_entry(wheel, WHEEL)
        archive_entry = checksum_entry(good, ARCHIVE)
        cases = {
            "good": (good, checksum_entry(b"unrelated wheel digest\n", WHEEL) + archive_entry),
            "altered": (altered, wheel_entry + archive_entry),
            "missing": (good, wheel_entry),
            "wrong-target": (good, wheel_entry + checksum_entry(signature, SIGNATURE)),
            "lookalike": (good, wheel_entry + checksum_entry(lookalike, LOOKALIKE)),
            "duplicate": (good, wheel_entry + archive_entry * 2),
            "duplicate-mixed": (good, wheel_entry + archive_entry + checksum_entry(altered, ARCHIVE)),
        }

        for shell, path in shells:
            if path is None:
                continue
            for case, (archive, manifest) in cases.items():
                with self.subTest(shell=shell, case=case), tempfile.TemporaryDirectory() as directory:
                    folder = Path(directory)
                    (folder / ARCHIVE).write_bytes(archive)
                    (folder / WHEEL).write_bytes(wheel)
                    (folder / SIGNATURE).write_bytes(signature)
                    (folder / LOOKALIKE).write_bytes(lookalike)
                    (folder / "SHA256SUMS").write_text(manifest, encoding="utf-8")
                    result = subprocess.run(
                        [path, "-s"], cwd=folder,
                        input=block + 'guide_status=$?\nprintf "shell still open\\n"\n[ "$guide_status" -eq 0 ]\n',
                        env={"HOME": directory, "PATH": os.environ.get("PATH", os.defpath), "LC_ALL": "C"},
                        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15,
                    )
                    output = result.stdout
                    self.assertIn("shell still open\n", output)
                    if case == "good":
                        self.assertEqual(result.returncode, 0, output)
                        self.assertIn(f"{ARCHIVE}: OK\n", output)
                        self.assertEqual((folder / MARKER).read_bytes(), b"release\n", output)
                    else:
                        self.assertFalse((folder / "omp-quarterdeck").exists(), output)
                        self.assertNotEqual(result.returncode, 0, output)

    def test_linux_install_block(self):
        self.check_block("## Get the files", "sha256sum")

    def test_macos_install_block(self):
        self.check_block("## macOS", "shasum")


if __name__ == "__main__":
    unittest.main()
