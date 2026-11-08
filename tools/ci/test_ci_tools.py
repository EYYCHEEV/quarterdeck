import contextlib
import hashlib
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import tomllib
import unittest
import zipfile
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
HASH = chr(35)


def load_module(name):
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), str(HERE / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def git(root, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


class TempRepo:
    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)
        git(self.root, "init", "-q")
        return self

    def __exit__(self, *exc):
        self.directory.cleanup()

    def add(self, name, content, mode="w"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if mode == "wb":
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
        git(self.root, "add", name)
        return path

    def link(self, name, target):
        path = self.root / name
        os.symlink(target, path)
        git(self.root, "add", name)


class NoCommentsTest(unittest.TestCase):
    def run_check(self, repo):
        env = {**os.environ, "NO_COMMENTS_ROOT": str(repo.root)}
        return subprocess.run([sys.executable, str(HERE / "no-comments")], capture_output=True, text=True, env=env)

    def test_clean_files_pass(self):
        with TempRepo() as repo:
            repo.add("a.py", "x = 1\n")
            repo.add("b.yml", "key: \"value " + HASH + " kept in quotes\"\n")
            repo.add("c.sh", HASH + "!/bin/sh\necho \"$" + HASH + "\"\n")
            repo.add("d.css", "a { content: \"/* kept */\"; }\n")
            result = self.run_check(repo)
            self.assertEqual(result.returncode, 0, result.stdout)

    def test_python_comment_and_docstring_fail(self):
        with TempRepo() as repo:
            repo.add("a.py", "x = 1  " + HASH + " why\n")
            repo.add("b.py", "def f():\n    \"\"\"words\"\"\"\n    return 1\n")
            result = self.run_check(repo)
            self.assertEqual(result.returncode, 1)
            self.assertIn("a.py:1 comment", result.stdout)
            self.assertIn("b.py:2 docstring", result.stdout)
            self.assertNotIn("why", result.stdout)

    def test_yaml_shell_style_html_and_typescript_comments_fail(self):
        with TempRepo() as repo:
            repo.add("a.yml", HASH + " note\nkey: value\n")
            repo.add("b.yml", "key: value " + HASH + " note\n")
            repo.add("c.sh", HASH + "!/bin/sh\n" + HASH + " note\n")
            repo.add("d.css", "a { color: red; } /* note */\n")
            repo.add("e.html", "<p>x</p><!-- note -->\n")
            repo.add("f.ts", "const a = 1;\n// note\n")
            result = self.run_check(repo)
            self.assertEqual(result.returncode, 1)
            for expected in ("a.yml:1", "b.yml:1", "c.sh:2", "d.css:1", "e.html:1", "f.ts:2"):
                self.assertIn(expected, result.stdout)

    def test_a_script_with_a_python_shebang_is_checked_as_python(self):
        with TempRepo() as repo:
            repo.add("tool", HASH + "!/usr/bin/env python3\nx = 1  " + HASH + " note\n")
            result = self.run_check(repo)
            self.assertEqual(result.returncode, 1)
            self.assertIn("tool:2 comment", result.stdout)


class FileKindsTest(unittest.TestCase):
    def run_check(self, repo):
        env = {**os.environ, "FILE_KINDS_ROOT": str(repo.root)}
        return subprocess.run([sys.executable, str(HERE / "file-kinds")], capture_output=True, text=True, env=env)

    def test_text_files_and_listed_binaries_pass(self):
        with TempRepo() as repo:
            blob = b"\x89PNG\x00data"
            repo.add("a.txt", "hello\n")
            repo.add("pic.png", blob, "wb")
            repo.add("tools/ci/binaries.txt", hashlib.sha256(blob).hexdigest() + "  pic.png\n")
            result = self.run_check(repo)
            self.assertEqual(result.returncode, 0, result.stdout)

    def test_symlink_unlisted_binary_changed_binary_and_stale_entry_fail(self):
        with TempRepo() as repo:
            repo.add("a.txt", "hello\n")
            repo.link("link", "a.txt")
            repo.add("loose.bin", b"\x00\x01", "wb")
            repo.add("changed.bin", b"\x00\x02", "wb")
            lines = [hashlib.sha256(b"other").hexdigest() + "  changed.bin", hashlib.sha256(b"x").hexdigest() + "  gone.bin"]
            repo.add("tools/ci/binaries.txt", "\n".join(lines) + "\n")
            result = self.run_check(repo)
            self.assertEqual(result.returncode, 1)
            for expected in ("link special-or-symlink", "loose.bin binary-not-listed", "changed.bin binary-hash-differs", "gone.bin binaries-list-entry-without-binary"):
                self.assertIn(expected, result.stdout)


def tar_gz(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            bundle.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def zip_bytes(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, data in files.items():
            bundle.writestr(name, data)
    return buffer.getvalue()


def pin_for(archive, **extra):
    script = b"#!/bin/sh\necho v1.2.3\n"
    pin = {
        "version": "1.2.3",
        "url": "https://example.test/tool.tar.gz",
        "format": "tar.gz",
        "bytes": len(archive),
        "sha256": hashlib.sha256(archive).hexdigest(),
        "extract_dir": ".",
        "binary": "tool/bin/tool",
        "binary_sha256": hashlib.sha256(script).hexdigest(),
        "version_args": ["--version"],
        "version_output": "v1.2.3",
    }
    pin.update(extra)
    return pin


class FetchPinnedTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module("fetch-pinned")
        self.script = b"#!/bin/sh\necho v1.2.3\n"
        self.archive = tar_gz({"tool/bin/tool": self.script})
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = mock.patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def serve(self, *payloads):
        queue = list(payloads)

        def opener(url):
            item = queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return io.BytesIO(item)

        return mock.patch.object(self.module, "open_url", opener)

    def run_main(self, pin):
        pins = pathlib.Path(self.temp.name) / "pins.json"
        pins.write_text(json.dumps({"tool": pin}), encoding="utf-8")
        with mock.patch.object(self.module, "PINS_FILE", pins):
            return self.module.main(["fetch-pinned", "tool"])

    def test_a_matching_download_is_unpacked_and_verified(self):
        with self.serve(self.archive):
            self.assertEqual(self.run_main(pin_for(self.archive)), 0)
        self.assertTrue((pathlib.Path(self.temp.name) / "pinned" / "tool" / "bin" / "tool").is_file())

    def test_one_failed_attempt_is_retried_once(self):
        with self.serve(OSError("reset"), self.archive):
            self.assertEqual(self.run_main(pin_for(self.archive)), 0)

    def test_two_failed_attempts_fail_the_job(self):
        with self.serve(OSError("reset"), OSError("reset")):
            self.assertEqual(self.run_main(pin_for(self.archive)), 1)

    def test_a_wrong_archive_hash_fails_and_never_falls_back(self):
        other = tar_gz({"tool/bin/tool": b"#!/bin/sh\necho v9\n"})
        with self.serve(other, other):
            self.assertEqual(self.run_main(pin_for(self.archive)), 1)
        self.assertFalse((pathlib.Path(self.temp.name) / "pinned" / "tool" / "bin" / "tool").exists())

    def test_a_wrong_size_fails(self):
        with self.serve(self.archive, self.archive):
            self.assertEqual(self.run_main(pin_for(self.archive, bytes=len(self.archive) + 1)), 1)

    def test_a_wrong_binary_hash_fails(self):
        with self.serve(self.archive):
            self.assertEqual(self.run_main(pin_for(self.archive, binary_sha256="0" * 64)), 1)

    def test_a_wrong_version_output_fails(self):
        with self.serve(self.archive):
            self.assertEqual(self.run_main(pin_for(self.archive, version_output="v9.9.9")), 1)

    def test_a_member_that_leaves_the_target_folder_fails(self):
        evil = tar_gz({"../escape": b"x"})
        with self.serve(evil):
            self.assertEqual(self.run_main(pin_for(evil)), 1)
        self.assertFalse((pathlib.Path(self.temp.name) / "escape").exists())

    def test_a_zip_member_that_leaves_the_target_folder_fails(self):
        evil = zip_bytes({"../escape": b"x"})
        with self.serve(evil):
            self.assertEqual(self.run_main(pin_for(evil, format="zip")), 1)

    def test_an_unknown_name_is_a_usage_error(self):
        self.assertEqual(self.module.main(["fetch-pinned", "nothing-like-this"]), 2)

    def test_the_committed_pins_name_every_check(self):
        pins = json.loads((HERE / "pins.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(pins), ["chrome-headless-shell", "gitleaks", "node", "node-darwin-arm64"])
        for name, pin in pins.items():
            self.assertEqual(len(pin["sha256"]), 64, name)
            self.assertTrue(pin["url"].startswith("https://"), name)

    def test_the_darwin_node_pin_is_exact_and_shares_the_linux_pin_version(self):
        pins = json.loads((HERE / "pins.json").read_text(encoding="utf-8"))
        self.assertEqual(pins["node-darwin-arm64"], {
            "version": "22.21.0",
            "platform": "darwin-arm64",
            "url": "https://nodejs.org/dist/v22.21.0/node-v22.21.0-darwin-arm64.tar.xz",
            "format": "tar.xz",
            "bytes": 25587028,
            "sha256": "54b884588727c9833cad6e4b902f922128b8da136ba845e76e878b0d2d08c8f4",
            "extract_dir": ".",
            "binary": "node-v22.21.0-darwin-arm64/bin/node",
            "binary_sha256": None,
            "version_args": ["--version"],
            "version_output": "v22.21.0",
        })
        self.assertEqual(pins["node-darwin-arm64"]["version"], pins["node"]["version"])


WORKFLOW = HERE.parent.parent / ".github" / "workflows" / "ci.yml"
UPLOAD_ACTION = "actions/upload-artifact@"
PICTURE_ONLY_REFUSAL = "! -name '*.png'"


def workflow_steps(text):
    steps = []
    job = None
    step = None
    in_jobs = False
    for line in text.split("\n"):
        if line == "jobs:":
            in_jobs = True
            continue
        if not in_jobs:
            continue
        job_line = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if job_line:
            job = job_line.group(1)
            step = None
            continue
        if line.startswith("      - "):
            step = {"job": job, "lines": []}
            steps.append(step)
        if step is not None:
            step["lines"].append(line)
    return steps


def step_value(step, key):
    pattern = re.compile(r"^( *)(- )?" + re.escape(key) + r":[ ]*(.*)$")
    lines = step["lines"]
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if not match:
            continue
        value = match.group(3).strip()
        if value not in ("|", ">"):
            return value
        indent = len(match.group(1)) + (2 if match.group(2) else 0)
        block = []
        for follow in lines[index + 1:]:
            if follow.strip() and len(follow) - len(follow.lstrip(" ")) <= indent:
                break
            block.append(follow.strip())
        return "\n".join(part for part in block if part)
    return None


class MoveB2Test(unittest.TestCase):
    def test_server_uses_the_same_pinned_node_steps_before_the_lane(self):
        steps = workflow_steps(WORKFLOW.read_text(encoding="utf-8"))
        server = [step for step in steps if step["job"] == "server"]
        self.assertEqual([step_value(step, "name") for step in server], [
            "Checkout",
            "Fetch the pinned Node",
            "Put the pinned Node first on the path",
            "Server suites, one process each",
        ])
        web = [step for step in steps if step["job"] == "web-static"]
        for index in (1, 2):
            self.assertEqual(server[index]["lines"], web[index]["lines"])
        self.assertEqual(step_value(server[1], "run"), "python3 tools/ci/fetch-pinned node")
        self.assertEqual(step_value(server[2], "run"), 'echo "$RUNNER_TEMP/pinned/node-v22.21.0-linux-x64/bin" >> "$GITHUB_PATH"')
        self.assertEqual(step_value(server[3], "run"), "python3 deploy/server_lane.py")

    def test_missing_node_exits_with_one_line_before_running_any_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            suite = root / "app" / "captain-app"
            suite.mkdir(parents=True)
            marker = root / "suite-ran"
            (suite / "test_probe.py").write_text(
                "from pathlib import Path\n"
                + "Path(" + repr(str(marker)) + ").write_text('ran')\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, "-B", str(HERE.parent.parent / "deploy" / "server_lane.py"), "--tree", str(root), "captain-app"],
                env={"PATH": str(root / "no-programs"), "HOME": str(root), "PYTHONDONTWRITEBYTECODE": "1"},
                capture_output=True, text=True, timeout=10,
            )
            self.assertFalse(marker.exists(), "a suite ran without node")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, "")
            self.assertEqual(result.stdout, "missing node: captain-app test_chat_bubbles, test_chat_chime, test_chat_page, test_chat_windowing require it\n")

    def test_scan_exceptions_cover_only_the_six_exact_digest_fields(self):
        path = HERE / "gitleaks.toml"
        self.assertTrue(path.is_file())
        config = tomllib.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(set(config), {"extend", "allowlists"})
        self.assertEqual(config["extend"], {"useDefault": True})
        expected = {
            r"^deploy/captain-app/package-manifest\.json$": ("auth_bridge.py", "captain_auth.py"),
            r"^deploy/qd-web/package-manifest\.json$": ("auth_bridge.py", "chat_api.py", "mail_api.py"),
            r"^deploy/containers/test_layout\.py$": ("first_start/password_file.py",),
        }
        self.assertEqual(len(config["allowlists"]), 3)
        seen = set()
        for block in config["allowlists"]:
            self.assertEqual(set(block), {"description", "targetRules", "condition", "paths", "regexTarget", "regexes"})
            self.assertIsInstance(block["description"], str)
            self.assertTrue(block["description"].strip())
            self.assertEqual(block["targetRules"], ["generic-api-key"])
            self.assertEqual(block["condition"], "AND")
            self.assertEqual(block["regexTarget"], "line")
            self.assertEqual(len(block["paths"]), 1)
            path_pattern = block["paths"][0]
            self.assertIn(path_pattern, expected)
            self.assertNotIn(path_pattern, seen)
            seen.add(path_pattern)
            fields = expected[path_pattern]
            self.assertEqual(block["regexes"], [
                r'^\n?    "' + re.escape(field) + '": "[0-9a-f]{64}",?$'
                for field in fields
            ])
            for field, pattern in zip(fields, block["regexes"]):
                line = '    "' + field + '": "' + "a" * 64 + '"'
                for ending in ("", ","):
                    self.assertIsNotNone(re.fullmatch(pattern, line + ending))
                for value in ("a" * 63, "a" * 65, "A" * 64, "g" * 64):
                    self.assertIsNone(re.fullmatch(pattern, '    "' + field + '": "' + value + '",'))
                for changed in (" " + line, line + " ", line.replace(field, "other_password.py")):
                    self.assertIsNone(re.fullmatch(pattern, changed))
        self.assertEqual(seen, set(expected))

    def test_six_real_fields_match_gitleaks_line_shapes_and_fail_closed(self):
        config = tomllib.loads((HERE / "gitleaks.toml").read_text(encoding="utf-8"))
        fields = {
            "deploy/captain-app/package-manifest.json": ("auth_bridge.py", "captain_auth.py"),
            "deploy/qd-web/package-manifest.json": ("auth_bridge.py", "chat_api.py", "mail_api.py"),
            "deploy/containers/test_layout.py": ("first_start/password_file.py",),
        }
        for filename, names in fields.items():
            block = next(block for block in config["allowlists"] if re.fullmatch(block["paths"][0], filename))
            lines = (HERE.parent.parent / filename).read_bytes().decode("utf-8").split("\n")
            self.assertEqual(len(block["regexes"]), len(names))
            for name, pattern in zip(names, block["regexes"]):
                line = next(line for line in lines if line.startswith('    "' + name + '": "'))
                value = line.split('"')[3]
                for shape, target in (("bare", line), ("mid-fragment", "\n" + line)):
                    with self.subTest(file=filename, field=name, shape=shape):
                        self.assertTrue(re.fullmatch(pattern, target) is not None)
                invalid = {
                    "two leading newlines": "\n\n" + line,
                    "space before newline": " \n" + line,
                    "tab before newline": "\t\n" + line,
                    "trailing newline": line + "\n",
                    "trailing carriage return": line + "\r",
                    "63-character value": line.replace(value, value[:-1], 1),
                    "65-character value": line.replace(value, value + "0", 1),
                    "uppercase hex value": line.replace(value, value.upper(), 1),
                    "five spaces without newline": " " + line,
                }
                for shape, target in invalid.items():
                    with self.subTest(file=filename, field=name, shape=shape):
                        self.assertTrue(re.fullmatch(pattern, target) is None)

    def test_both_public_scan_commands_load_the_explicit_configuration(self):
        steps = workflow_steps(WORKFLOW.read_text(encoding="utf-8"))
        commands = [
            line.strip()
            for step in steps if step["job"] == "leaks"
            for line in step["lines"] if line.strip().startswith('"$gitleaks" ')
        ]
        self.assertEqual(len(commands), 2)
        self.assertTrue(commands[0].startswith('"$gitleaks" dir '))
        self.assertTrue(commands[1].startswith('"$gitleaks" git '))
        for command in commands:
            self.assertEqual(command.count("--config tools/ci/gitleaks.toml"), 1)

    def test_both_public_scan_commands_reject_inline_markers_and_pass_a_missing_ignore_path(self):
        steps = workflow_steps(WORKFLOW.read_text(encoding="utf-8"))
        commands = [
            line.strip()
            for step in steps if step["job"] == "leaks"
            for line in step["lines"] if line.strip().startswith('"$gitleaks" ')
        ]
        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertEqual(command.split().count("--ignore-gitleaks-allow"), 1)
            self.assertEqual(command.count('--gitleaks-ignore-path "$RUNNER_TEMP/no-gitleaksignore"'), 1)

    def test_root_ignore_refusal_is_exact_and_precedes_scanning(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        steps = [step for step in workflow_steps(text) if step["job"] == "leaks"]
        self.assertFalse(any(step_value(step, "name") == "Refuse a gitleaks ignore file" for step in steps))
        scans = [step for step in steps if step_value(step, "name") == "Scan the checkout and the new commits"]
        self.assertEqual(len(scans), 1)
        scan = scans[0]
        self.assertEqual(scan["lines"][2:6], [
            "          if [ -e .gitleaksignore ] || [ -L .gitleaksignore ]; then",
            '            echo "::error file=.gitleaksignore::gitleaks always reads this file, so this repository keeps none. Remove it."',
            "            exit 1",
            "          fi",
        ])
        self.assertEqual(
            [step for step in steps if any(line.strip().startswith('"$gitleaks" ') for line in step["lines"])],
            [scan],
        )
        restored = without_ignore_refusal(text)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            without_ignore_refusal(restored)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            without_ignore_refusal(text + "\n".join(scan["lines"][:6]) + "\n")

    def test_root_ignore_refusal_handles_files_links_and_directories(self):
        scans = [
            step for step in workflow_steps(WORKFLOW.read_text(encoding="utf-8"))
            if step["job"] == "leaks" and step_value(step, "name") == "Scan the checkout and the new commits"
        ]
        self.assertEqual(len(scans), 1)
        run_text = "\n".join(line[10:] for line in scans[0]["lines"][2:6])
        self.assertTrue(run_text.startswith("if [ -e .gitleaksignore ]"))
        for kind, expected in (("absent", 0), ("file", 1), ("symlink", 1), ("dangling", 1), ("directory", 1)):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                ignore = root / ".gitleaksignore"
                if kind == "file":
                    ignore.touch()
                elif kind == "symlink":
                    target = root / "target"
                    target.touch()
                    ignore.symlink_to(target)
                elif kind == "dangling":
                    ignore.symlink_to(root / "missing")
                elif kind == "directory":
                    ignore.mkdir()
                result = subprocess.run(["bash", "-c", run_text], cwd=root, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, expected)
                self.assertEqual(result.stderr, "")

    def test_scan_refuses_an_ignore_file_created_after_an_earlier_guard(self):
        scans = [
            step for step in workflow_steps(WORKFLOW.read_text(encoding="utf-8"))
            if step["job"] == "leaks" and step_value(step, "name") == "Scan the checkout and the new commits"
        ]
        self.assertEqual(len(scans), 1)
        run_text = "\n".join(line[10:] for line in scans[0]["lines"][2:]) + "\n"
        for present in (True, False):
            with self.subTest(ignore_present=present), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                checkout = root / "checkout"
                checkout.mkdir()
                runner_temp = root / "runner"
                scanner = runner_temp / "pinned" / "gitleaks" / "gitleaks"
                scanner.parent.mkdir(parents=True)
                scanner.write_text(HASH + '!/bin/bash\n: > "$SCAN_MARKER"\n', encoding="utf-8")
                scanner.chmod(0o755)
                marker = root / "scanner-ran"
                if present:
                    (checkout / ".gitleaksignore").touch()
                environment = dict(os.environ, RUNNER_TEMP=str(runner_temp), EVENT="pull_request", BASE="base", HEAD="head", SCAN_MARKER=str(marker))
                result = subprocess.run(["bash", "-c", run_text], cwd=checkout, env=environment, capture_output=True, text=True, timeout=10)
                if present:
                    self.assertFalse(marker.exists())
                    self.assertEqual(result.returncode, 1)
                else:
                    self.assertTrue(marker.exists())


class HistoricalScanReconstructionTest(unittest.TestCase):
    OPTIONS = (
        "--config tools/ci/gitleaks.toml",
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path",
    )

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")
        self.digest = hashlib.sha256(without_scan_config(self.text).encode()).digest()
        self.commands = [
            line for line in self.text.splitlines(keepends=True)
            if line.startswith('          "$gitleaks" ')
        ]
        self.assertEqual(len(self.commands), 2)

    def assert_not_erased(self, changed):
        try:
            result = without_scan_config(changed)
        except ValueError:
            return
        self.assertTrue(
            hashlib.sha256(result.encode()).digest() != self.digest,
            "historical reconstruction erased a guarded workflow mutation",
        )

    def test_fetch_main_option_injection_is_not_erased(self):
        line = "      - name: Fetch main for the design comparison"
        self.assertEqual(self.text.count(line), 1)
        self.assert_not_erased(self.text.replace(line, line + " " + self.OPTIONS[0], 1))

    def test_refusal_step_option_injection_is_not_erased(self):
        line = "        id: refuse"
        self.assertEqual(self.text.count(line), 1)
        self.assert_not_erased(self.text.replace(line, line + " " + self.OPTIONS[0], 1))

    def test_png_upload_condition_option_injection_is_not_erased(self):
        line = "        if: failure() && steps.refuse.outcome == 'success'"
        self.assertEqual(self.text.count(line), 1)
        self.assert_not_erased(self.text.replace(line, line + " " + self.OPTIONS[0], 1))

    def test_moved_config_in_each_scan_command_is_not_erased(self):
        for command in self.commands:
            with self.subTest(mode=command.split()[1]):
                moved = command.replace(" " + self.OPTIONS[0], "", 1).replace(
                    '"$gitleaks" ', '"$gitleaks" ' + self.OPTIONS[0] + " ", 1,
                )
                self.assert_not_erased(self.text.replace(command, moved, 1))

    def test_each_non_option_byte_in_both_commands_stays_guarded(self):
        for command in self.commands:
            masked = command
            for option in self.OPTIONS:
                masked = masked.replace(option, "\0" * len(option), 1)
            for index, character in enumerate(masked):
                if character == "\0":
                    continue
                with self.subTest(mode=command.split()[1], byte=index):
                    changed = command[:index] + ("Y" if character == "X" else "X") + command[index + 1:]
                    self.assert_not_erased(self.text.replace(command, changed, 1))

    def test_each_scan_command_requires_exactly_one_full_line(self):
        for command in self.commands:
            for count in (0, 2):
                with self.subTest(mode=command.split()[1], count=count):
                    changed = self.text.replace(command, command * count, 1)
                    with self.assertRaisesRegex(ValueError, "exactly one"):
                        without_scan_config(changed)

    def test_leftover_option_text_is_rejected_anywhere(self):
        for option in self.OPTIONS:
            with self.subTest(option=option):
                with self.assertRaisesRegex(ValueError, "unexpected scan option"):
                    without_scan_config(self.text + option + "\n")


def upload_problems(text):
    problems = []
    refusals = set()
    uploads = 0
    for step in workflow_steps(text):
        job = step["job"]
        step_id = step_value(step, "id")
        if step_id and PICTURE_ONLY_REFUSAL in (step_value(step, "run") or ""):
            refusals.add((job, step_id))
        if not (step_value(step, "uses") or "").startswith(UPLOAD_ACTION):
            continue
        uploads += 1
        guard = re.search(r"steps\.([A-Za-z0-9_-]+)\.outcome == 'success'", step_value(step, "if") or "")
        if not guard or (job, guard.group(1)) not in refusals:
            problems.append(job + ": an upload can run without a successful refusal step before it")
        paths = [part for part in (step_value(step, "path") or "").split("\n") if part]
        if not paths or any(not part.endswith(".png") for part in paths):
            problems.append(job + ": an upload path is not limited to pictures")
    if not uploads:
        problems.append("no upload step was found, so nothing was checked")
    return problems


def workflow_sample(refusal_id, condition, path):
    lines = ["jobs:", "  web-design:", "    steps:", "      - name: Refuse any failure file that is not a picture"]
    if refusal_id:
        lines.append("        id: " + refusal_id)
    lines += [
        "        if: failure()",
        "        run: |",
        "          test -z \"$(find out -type f ! -name '*.png' -print -quit)\"",
        "",
        "      - name: Keep the failure pictures",
        "        if: " + condition,
        "        uses: " + UPLOAD_ACTION + "0" * 40,
        "        with:",
        "          name: failed",
        "          path: " + path,
    ]
    return "\n".join(lines) + "\n"


class WorkflowUploadTest(unittest.TestCase):
    GOOD_IF = "failure() && steps.refuse.outcome == 'success'"
    GOOD_PATH = "apps/web/design-check/failed/**/*.png"

    def test_the_committed_workflow_uploads_only_pictures_and_only_after_the_refusal_step_passed(self):
        self.assertEqual(upload_problems(WORKFLOW.read_text(encoding="utf-8")), [])

    def test_a_guarded_upload_of_pictures_has_no_problem(self):
        self.assertEqual(upload_problems(workflow_sample("refuse", self.GOOD_IF, self.GOOD_PATH)), [])

    def test_an_upload_that_runs_on_any_failure_and_takes_the_whole_folder_is_caught(self):
        problems = upload_problems(workflow_sample(None, "failure()", "apps/web/design-check/failed"))
        self.assertEqual(len(problems), 2)

    def test_a_guard_that_names_no_refusal_step_is_caught(self):
        problems = upload_problems(workflow_sample("refuse", "failure() && steps.other.outcome == 'success'", self.GOOD_PATH))
        self.assertEqual(problems, ["web-design: an upload can run without a successful refusal step before it"])

    def test_a_path_that_is_not_limited_to_pictures_is_caught(self):
        problems = upload_problems(workflow_sample("refuse", self.GOOD_IF, "apps/web/design-check/failed/**"))
        self.assertEqual(problems, ["web-design: an upload path is not limited to pictures"])

    def test_a_second_unguarded_upload_in_another_job_is_caught(self):
        second = "  other:\n    steps:\n      - uses: " + UPLOAD_ACTION + "0" * 40 + "\n        with:\n          path: shot.png\n"
        problems = upload_problems(workflow_sample("refuse", self.GOOD_IF, self.GOOD_PATH) + second)
        self.assertEqual(problems, ["other: an upload can run without a successful refusal step before it"])


class WorkflowRefusalTest(unittest.TestCase):
    PNG = bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
        "0000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082"
    )

    def setUp(self):
        refusals = [
            step for step in workflow_steps(WORKFLOW.read_text(encoding="utf-8"))
            if step["job"] == "web-design" and step_value(step, "id") == "refuse"
        ]
        self.assertEqual(len(refusals), 1)
        lines = refusals[0]["lines"]
        start = lines.index("        run: |") + 1
        run_lines = []
        for line in lines[start:]:
            if line.strip() and not line.startswith("          "):
                break
            run_lines.append(line[10:])
        self.script = "\n".join(run_lines).rstrip("\n") + "\n"
        self.assertTrue(self.script.strip())
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = pathlib.Path(directory.name)
        self.failed = self.root / "apps/web/design-check/failed"
        self.failed.parent.mkdir(parents=True)

    def run_refusal(self):
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", self.script],
            cwd=self.root, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.stdout, "")
        return result.returncode

    def test_a_symbolic_link_to_an_outside_file_fails(self):
        outside = self.root / "outside.png"
        outside.write_bytes(self.PNG)
        self.failed.mkdir()
        (self.failed / "leak.png").symlink_to(outside)
        self.assertNotEqual(self.run_refusal(), 0)

    def test_a_symbolic_link_to_a_directory_fails(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "picture.png").write_bytes(self.PNG)
        self.failed.mkdir()
        (self.failed / "linked-directory").symlink_to(outside, target_is_directory=True)
        self.assertNotEqual(self.run_refusal(), 0)

    def test_a_symbolic_link_as_the_failure_folder_fails(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "picture.png").write_bytes(self.PNG)
        self.failed.symlink_to(outside, target_is_directory=True)
        self.assertNotEqual(self.run_refusal(), 0)

    def test_a_dangling_symbolic_link_fails(self):
        self.failed.mkdir()
        (self.failed / "broken.png").symlink_to(self.root / "missing")
        self.assertNotEqual(self.run_refusal(), 0)

    def test_a_png_name_without_the_png_signature_fails(self):
        self.failed.mkdir()
        (self.failed / ".png").write_bytes(b"not a picture\n")
        self.assertNotEqual(self.run_refusal(), 0)

    def test_a_non_png_file_fails(self):
        self.failed.mkdir()
        (self.failed / "picture.txt").write_bytes(self.PNG)
        self.assertNotEqual(self.run_refusal(), 0)

    def test_a_special_file_fails(self):
        self.failed.mkdir()
        os.mkfifo(self.failed / "pipe.png")
        self.assertNotEqual(self.run_refusal(), 0)

    def test_a_regular_file_as_the_failure_folder_fails(self):
        self.failed.write_bytes(self.PNG)
        self.assertNotEqual(self.run_refusal(), 0)

    def test_real_png_files_in_nested_folders_pass(self):
        nested = self.failed / "nested folder" / "more.png"
        nested.mkdir(parents=True)
        (self.failed / "picture.png").write_bytes(self.PNG)
        (nested / "picture\nwith spaces.png").write_bytes(self.PNG)
        self.assertEqual(self.run_refusal(), 0)

    def test_an_empty_failure_folder_passes(self):
        self.failed.mkdir()
        self.assertEqual(self.run_refusal(), 0)

    def test_a_missing_failure_folder_passes(self):
        self.assertEqual(self.run_refusal(), 0)


class WorkflowMainFetchTest(unittest.TestCase):
    def test_main_fetch_is_shallow_tagless_and_only_after_web_design_checkout(self):
        steps = workflow_steps(WORKFLOW.read_text(encoding="utf-8"))
        fetches = [step for step in steps if re.search(r"\bgit\b.*\bfetch\b", step_value(step, "run") or "")]
        self.assertEqual(len(fetches), 1)
        fetch = fetches[0]
        self.assertEqual(fetch["job"], "web-design")
        command = step_value(fetch, "run").split()
        self.assertEqual(command[:3], ["git", "-c", "credential.helper="])
        self.assertCountEqual(command[3:], ["fetch", "--no-tags", "--depth=1", "origin", "main:refs/remotes/origin/main"])
        checkout = steps[steps.index(fetch) - 1]
        self.assertEqual(checkout["job"], "web-design")
        self.assertTrue((step_value(checkout, "uses") or "").startswith("actions/checkout@"))
        self.assertEqual(step_value(checkout, "persist-credentials"), "false")


class WorkflowContextsTest(unittest.TestCase):
    def check(self, text):
        with TempRepo() as repo:
            repo.add(".github/workflows/sample.yml", text)
            return subprocess.run(
                [sys.executable, "-B", str(HERE / "workflow-contexts"), str(repo.root)],
                capture_output=True, text=True, timeout=10,
            )

    def workflow(self, job="", step="        run: echo ok\n"):
        return "on: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n" + job + "    steps:\n      - name: Check\n" + step

    def test_runner_in_a_job_env_fails(self):
        result = self.check(self.workflow("    env:\n      BROWSER: ${{ runner.temp }}\n"))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, ".github/workflows/sample.yml:6: context runner not allowed in jobs.*.env\n")

    def test_runner_in_a_step_env_passes(self):
        result = self.check(self.workflow(step="        env:\n          BROWSER: ${{ runner.temp }}\n        run: echo ok\n"))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_env_in_a_job_if_fails(self):
        result = self.check(self.workflow("    if: env.ENABLED == 'yes'\n"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("context env not allowed in jobs.*.if", result.stdout)

    def test_secrets_in_a_step_if_fails(self):
        result = self.check(self.workflow(step="        if: ${{ secrets.TEST_ONLY != '' }}\n        run: echo ok\n"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("context secrets not allowed in jobs.*.steps.*.if", result.stdout)
        self.assertNotIn("TEST_ONLY", result.stdout)

    def test_hashfiles_in_a_job_env_fails(self):
        result = self.check(self.workflow("    env:\n      DIGEST: ${{ hashFiles('*.txt') }}\n"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("function hashFiles not allowed in jobs.*.env", result.stdout)

    def test_status_functions_outside_if_fail(self):
        for function in ("always", "success", "failure", "cancelled"):
            with self.subTest(function=function):
                result = self.check(self.workflow(step="        env:\n          FLAG: ${{ " + function + "() }}\n        run: echo ok\n"))
                self.assertEqual(result.returncode, 1)
                self.assertIn("function " + function + " not allowed in jobs.*.steps.*.env", result.stdout)

    def test_status_functions_in_if_and_hashfiles_in_a_step_pass(self):
        result = self.check(self.workflow(
            "    if: always() && !cancelled()\n",
            "        if: success() || failure()\n        env:\n          DIGEST: ${{ hashFiles('*.txt') }}\n        run: echo ok\n",
        ))
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_unknown_job_key_fails(self):
        result = self.check(self.workflow("    typo: true\n"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown job key typo", result.stdout)

    def test_unknown_workflow_and_step_keys_fail(self):
        result = self.check("typo: true\n" + self.workflow(step="        typo: true\n        run: echo ok\n"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(result.stdout.splitlines()), 2)
        self.assertIn("unknown workflow key typo", result.stdout)
        self.assertIn("unknown step key typo", result.stdout)

    def test_flow_style_mappings_are_refused(self):
        for job in (
            "    env: {BROWSER: '${{ runner.temp }}'}\n",
            "    env: {BROWSER: safe}\n",
            "    env: &settings {BROWSER: safe}\n",
            "    runs-on: [{group: test}]\n",
        ):
            with self.subTest(job=job):
                result = self.check(self.workflow(job))
                self.assertEqual(result.returncode, 1)
                self.assertIn("unsupported flow-style mapping", result.stdout)

    def test_empty_mappings_flow_lists_and_shell_braces_pass(self):
        result = self.check("permissions: {}\n" + self.workflow(
            "    needs: [build, test]\n",
            "        run: echo ${HOME} '{}'\n",
        ))
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_quoted_and_block_if_expressions_are_checked(self):
        for condition in ("'env.ENABLED'", '"env.ENABLED"', ">\n      env.ENABLED"):
            with self.subTest(condition=condition):
                result = self.check(self.workflow("    if: " + condition + "\n"))
                self.assertEqual(result.returncode, 1)
                self.assertIn("context env not allowed in jobs.*.if", result.stdout)

    def test_all_expressions_and_bare_contexts_are_checked(self):
        result = self.check(self.workflow("    env:\n      A: ${{ runner.temp }} ${{ env.OTHER }}\n      B: ${{ runner['temp'] }}\n      C: ${{ toJSON(runner) }}\n"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(result.stdout.splitlines()), 4)
        self.assertEqual(result.stdout.count("context runner"), 3)
        self.assertEqual(result.stdout.count("context env"), 1)

    def test_quoted_expression_words_and_property_names_are_not_contexts(self):
        result = self.check(self.workflow(
            "    env:\n      A: ${{ format('runner }} env '' failure() hashFiles()', github.runner) }}\n",
            "        run: |\n          echo 'env: ${{ runner.temp }}'\n          echo '${{ github.env }}'\n",
        ))
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        quoted = self.check(self.workflow("    env:\n      A: '${{ format(''runner }} env failure()'', github.ref) }}'\n"))
        self.assertEqual((quoted.returncode, quoted.stdout), (0, ""))

    def test_multiline_expressions_are_checked(self):
        result = self.check(self.workflow("    env:\n      A: >-\n        ${{\n          runner.temp\n        }}\n"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("context runner not allowed in jobs.*.env", result.stdout)

    def test_context_table_workflow_and_job_boundaries(self):
        cases = (
            ("run-name: ${{ inputs.label }}\n", "", 0),
            ("run-name: ${{ runner.name }}\n", "", 1),
            ("concurrency:\n  group: ${{ vars.group }}\n", "", 0),
            ("concurrency:\n  group: ${{ needs.build.result }}\n", "", 1),
            ("env:\n  A: ${{ secrets.TEST_ONLY }}\n", "", 0),
            ("env:\n  A: ${{ env.OTHER }}\n", "", 1),
            ("", "    name: ${{ matrix.name }}\n", 0),
            ("", "    runs-on: ${{ runner.os }}\n", 1),
            ("", "    strategy:\n      matrix:\n        value: ${{ needs.build.outputs.value }}\n", 0),
            ("", "    strategy:\n      matrix:\n        value: ${{ matrix.value }}\n", 1),
            ("", "    timeout-minutes: ${{ vars.timeout }}\n", 0),
            ("", "    concurrency:\n      group: ${{ env.GROUP }}\n", 1),
            ("", "    continue-on-error: ${{ matrix.experimental }}\n", 0),
            ("", "    defaults:\n      run:\n        working-directory: ${{ env.WORK }}\n", 0),
            ("", "    defaults:\n      run:\n        shell: ${{ runner.os }}\n", 1),
            ("", "    environment:\n      url: ${{ steps.deploy.outputs.url }}\n", 0),
            ("", "    environment:\n      name: ${{ steps.deploy.outputs.name }}\n", 1),
            ("", "    outputs:\n      A: ${{ steps.build.outputs.value }}\n", 0),
            ("", "    container:\n      env:\n        A: ${{ runner.os }}\n", 0),
            ("", "    container:\n      credentials:\n        password: ${{ secrets.TEST_ONLY }}\n", 0),
            ("", "    container:\n      image: ${{ env.IMAGE }}\n", 1),
            ("", "    services:\n      db:\n        env:\n          A: ${{ runner.os }}\n", 0),
            ("", "    services:\n      db:\n        credentials:\n          password: ${{ runner.os }}\n", 1),
            ("", "    with:\n      A: ${{ inputs.label }}\n", 0),
            ("", "    with:\n      A: ${{ secrets.TEST_ONLY }}\n", 1),
        )
        for prefix, job, code in cases:
            with self.subTest(prefix=prefix, job=job):
                result = self.check(prefix + self.workflow(job))
                self.assertEqual(result.returncode, code, result.stdout + result.stderr)

    def test_context_table_step_boundaries(self):
        for key in ("env", "with", "run", "name", "working-directory", "timeout-minutes", "continue-on-error"):
            value = "\n          A: ${{ runner.os }}" if key in {"env", "with"} else " ${{ runner.os }}"
            with self.subTest(key=key):
                result = self.check(self.workflow(step="        " + key + ":" + value + "\n"))
                self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_the_original_ci_has_exactly_the_three_reported_findings(self):
        original = without_ignore_refusal(without_scan_config(without_server_lane(without_ios_lane(WORKFLOW.read_text(encoding="utf-8")))))
        original = original.replace(
            "      - name: Fetch main for the design comparison\n"
            "        run: git -c credential.helper= fetch --no-tags --depth=1 origin main:refs/remotes/origin/main\n\n",
            "",
        )
        original = ci_with_selftest_env(original)
        point = (
            '      - name: Point QD_CHROME at the pinned browser\n'
            '        run: echo "QD_CHROME=$RUNNER_TEMP/pinned/chrome-headless-shell-linux64/chrome-headless-shell" >> "$GITHUB_ENV"\n\n'
        )
        original = original.replace(point, "")
        browser = "      QD_CHROME: ${{ runner.temp }}/pinned/chrome-headless-shell-linux64/chrome-headless-shell\n"
        for job in ("web-browser", "web-design", "web-design-selftest"):
            start = original.index("  " + job + ":\n")
            env = original.index("    env:\n", start) + len("    env:\n")
            if not original.startswith(browser, env):
                original = original[:env] + browser + original[env:]
        self.assertEqual(hashlib.sha256(original.encode()).hexdigest(), "e87d3d473b475f7f36541b87d086b7b9e6dd3ad8a9f1b24b00cae2b09530012b")
        result = self.check(original)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines(), [
            ".github/workflows/sample.yml:" + str(line) + ": context runner not allowed in jobs.*.env"
            for line in (258, 301, 362)
        ])

    def test_the_real_workflows_pass_the_cli(self):
        result = subprocess.run(
            [sys.executable, "-B", str(HERE / "workflow-contexts"), str(HERE.parent.parent)],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_release_workflow_passes(self):
        result = self.check(WORKFLOW.with_name("release.yml").read_text(encoding="utf-8"))
        self.assertEqual((result.returncode, result.stdout), (0, ""))


def ci_with_selftest_env(source):
    start = source.index("  web-design-selftest:\n")
    steps = source.index("    steps:\n", start)
    if "    env:\n" not in source[start:steps]:
        source = source[:steps] + "    env:\n" + source[steps:]
    return source


def without_ios_lane(source):
    first = "  ios-typing-26:\n"
    if first not in source:
        return source
    source = source[:source.index(first)] + source[source.index("  pr-title:\n"):]
    for name in ("ios-typing-26", "ios-typing-27"):
        source = source.replace("      - " + name + "\n", "")
        source = source.replace("      " + name.upper().replace("-", "_") + "_RESULT: ${{ needs." + name + ".result }}\n", "")
    return source.replace(' "$IOS_TYPING_26_RESULT" "$IOS_TYPING_27_RESULT"', "")


def without_ignore_refusal(text):
    header = "      - name: Scan the checkout and the new commits\n        run: |\n"
    guarded = (
        header
        + "          if [ -e .gitleaksignore ] || [ -L .gitleaksignore ]; then\n"
        '            echo "::error file=.gitleaksignore::gitleaks always reads this file, so this repository keeps none. Remove it."\n'
        "            exit 1\n"
        "          fi\n"
    )
    count = text.count(guarded)
    if count != 1:
        raise ValueError(f"expected exactly one root ignore refusal step; found {count}")
    return text.replace(guarded, header, 1)


def without_scan_config(text):
    lines = text.splitlines(keepends=True)
    for mode, current, prior in (
        (
            "dir",
            '          "$gitleaks" dir --redact --no-banner --config tools/ci/gitleaks.toml --ignore-gitleaks-allow --gitleaks-ignore-path "$RUNNER_TEMP/no-gitleaksignore" --report-format json --report-path "$RUNNER_TEMP/leaks-dir.json" --exit-code 0 .\n',
            '          "$gitleaks" dir --redact --no-banner --report-format json --report-path "$RUNNER_TEMP/leaks-dir.json" --exit-code 0 .\n',
        ),
        (
            "git",
            '          "$gitleaks" git --redact --no-banner --config tools/ci/gitleaks.toml --ignore-gitleaks-allow --gitleaks-ignore-path "$RUNNER_TEMP/no-gitleaksignore" --report-format json --report-path "$RUNNER_TEMP/leaks-git.json" --exit-code 0 --log-opts="$range" .\n',
            '          "$gitleaks" git --redact --no-banner --report-format json --report-path "$RUNNER_TEMP/leaks-git.json" --exit-code 0 --log-opts="$range" .\n',
        ),
    ):
        count = lines.count(current)
        if count != 1:
            raise ValueError(f"expected exactly one {mode} scan command line; found {count}")
        lines[lines.index(current)] = prior
    result = "".join(lines)
    for option in ("--config tools/ci/gitleaks.toml", "--ignore-gitleaks-allow", "--gitleaks-ignore-path"):
        if option in result:
            raise ValueError("unexpected scan option outside the two scan commands: " + option)
    return result


def without_server_lane(text):
    start = text.find("  server:\n")
    if start < 0:
        return text
    text = text[:start] + text[text.index("  extension:\n", start):]
    for old, new in (
        ("      - python\n      - server\n      - extension\n", "      - python\n      - extension\n"),
        ("      SERVER_RESULT: ${{ needs.server.result }}\n", ""),
        ('"$PYTHON_RESULT" "$SERVER_RESULT" "$EXTENSION_RESULT"', '"$PYTHON_RESULT" "$EXTENSION_RESULT"'),
    ):
        text = text.replace(old, new)
    return text


class WorkflowNullValuesTest(unittest.TestCase):
    check = WorkflowContextsTest.check
    workflow = WorkflowContextsTest.workflow

    def test_an_empty_job_env_fails(self):
        result = self.check(self.workflow("    env:\n"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, ".github/workflows/sample.yml:5: null value not allowed in jobs.*.env\n")

    def test_an_empty_step_with_fails(self):
        result = self.check(self.workflow(step="        with:\n        run: echo ok\n"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, ".github/workflows/sample.yml:7: null value not allowed in jobs.*.steps.*.with\n")

    def test_an_event_without_a_value_passes(self):
        result = self.check(self.workflow().replace("on: push\n", "on:\n  pull_request:\n"))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_the_r1_workflow_has_exactly_one_null_finding(self):
        original = ci_with_selftest_env(without_ignore_refusal(without_scan_config(without_server_lane(without_ios_lane(WORKFLOW.read_text(encoding="utf-8"))))))
        original = original.replace(
            "      - name: Fetch main for the design comparison\n"
            "        run: git -c credential.helper= fetch --no-tags --depth=1 origin main:refs/remotes/origin/main\n\n",
            "",
        )
        point = (
            '      - name: Point QD_CHROME at the pinned browser\n'
            '        run: echo "QD_CHROME=$RUNNER_TEMP/pinned/chrome-headless-shell-linux64/chrome-headless-shell" >> "$GITHUB_ENV"\n\n'
        )
        fetch = "      - name: Fetch the pinned Node and browser\n        run: python3 tools/ci/fetch-pinned node chrome-headless-shell\n\n"
        browser = "      QD_CHROME: ${{ runner.temp }}/pinned/chrome-headless-shell-linux64/chrome-headless-shell\n"
        original = original.replace(point, "")
        for job in ("web-browser", "web-design", "web-design-selftest"):
            start = original.index("  " + job + ":\n")
            env = original.index("    env:\n", start) + len("    env:\n")
            if not original.startswith(browser, env):
                original = original[:env] + browser + original[env:]
        self.assertEqual(hashlib.sha256(original.encode()).hexdigest(), "e87d3d473b475f7f36541b87d086b7b9e6dd3ad8a9f1b24b00cae2b09530012b")
        r1 = original.replace(browser, "").replace(fetch, fetch + point)
        self.assertEqual(hashlib.sha256(r1.encode()).hexdigest(), "b958268cffb696c6efbaa8413414bfca1593f54a0053874b2a47ba38e3bcf6b5")
        result = self.check(r1)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, ".github/workflows/sample.yml:365: null value not allowed in jobs.*.env\n")

    def test_null_values_are_rejected_at_each_required_container_key(self):
        workflow_keys = ("env", "defaults", "jobs", "permissions")
        job_keys = ("env", "defaults", "outputs", "strategy", "services", "container", "permissions", "steps", "with", "secrets", "needs")
        for key in workflow_keys:
            with self.subTest(level="workflow", key=key):
                result = self.check("on: push\n" + key + ":\n")
                self.assertEqual(result.returncode, 1)
                self.assertIn("null value not allowed in " + key, result.stdout)
        for key in job_keys:
            with self.subTest(level="job", key=key):
                result = self.check("on: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    " + key + ":\n")
                self.assertEqual(result.returncode, 1)
                self.assertIn("null value not allowed in jobs.*." + key, result.stdout)
        for key in ("env", "with"):
            with self.subTest(level="step", key=key):
                result = self.check(self.workflow(step="        " + key + ":\n        run: echo ok\n"))
                self.assertEqual(result.returncode, 1)
                self.assertIn("null value not allowed in jobs.*.steps.*." + key, result.stdout)

    def test_explicit_null_values_fail_and_present_values_pass(self):
        for value in ("null", "Null", "NULL", "~"):
            with self.subTest(value=value):
                result = self.check(self.workflow("    env: " + value + "\n"))
                self.assertEqual(result.returncode, 1)
                self.assertIn("null value not allowed in jobs.*.env", result.stdout)
        for job in ("    env: {}\n", "    env:\n\n      VALUE: safe\n", "    needs: build\n", "    needs:\n      - build\n"):
            with self.subTest(job=job):
                result = self.check(self.workflow(job))
                self.assertEqual((result.returncode, result.stdout), (0, ""))


class WorkflowYamlFilesTest(unittest.TestCase):
    workflow = WorkflowContextsTest.workflow
    BAD_JOB = "    env:\n      BROWSER: ${{ runner.temp }}\n"

    def check(self, files):
        with TempRepo() as repo:
            for name, content in files.items():
                repo.add(".github/workflows/" + name, content)
            return subprocess.run(
                [sys.executable, "-B", str(HERE / "workflow-contexts"), str(repo.root)],
                capture_output=True, text=True, timeout=10,
            )

    def test_a_yaml_workflow_with_an_invalid_context_fails(self):
        result = self.check({"sample.yaml": self.workflow(self.BAD_JOB)})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, ".github/workflows/sample.yaml:6: context runner not allowed in jobs.*.env\n")
        self.assertEqual(result.stderr, "")

    def test_yml_and_yaml_findings_share_one_sorted_path_order(self):
        bad = self.workflow(self.BAD_JOB)
        result = self.check({"z.yml": bad, "a.yaml": bad})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, (
            ".github/workflows/a.yaml:6: context runner not allowed in jobs.*.env\n"
            ".github/workflows/z.yml:6: context runner not allowed in jobs.*.env\n"
        ))
        self.assertEqual(result.stderr, "")

    def test_a_clean_yaml_workflow_passes(self):
        clean = self.workflow(step="        env:\n          BROWSER: ${{ runner.temp }}\n        run: echo ok\n")
        result = self.check({"sample.yaml": clean})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_only_regular_workflow_files_directly_in_the_folder_are_scanned(self):
        bad = self.workflow(self.BAD_JOB)
        result = self.check({
            "folder.yml/nested.yml": bad,
            "folder.yaml/nested.yaml": bad,
            "ignored.txt": bad,
        })
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))


IOS_JOBS = {
    "ios-typing-26": {"label": "macos-26", "runtime": "26"},
    "ios-typing-27": {"label": "xcode-27", "runtime": "27.0"},
}
CHECKOUT_USES = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
DRIVER = "node apps/web/src/screens/chat/chat_typing_ios.mjs"
TOOL = "python3 tools/ci/ios_simulator.py"
PATCH = "src/screens/chat/pre-367.patch"
WRITE_PREFERENCE = 'xcrun simctl spawn "$QD_UDID" defaults write com.apple.WebInspector RemoteAutomationEnabled -bool YES'


def job_block(source, job):
    lines = source.split("\n")
    if "  " + job + ":" not in lines:
        raise AssertionError("the workflow has no job " + job)
    start = lines.index("  " + job + ":")
    end = start + 1
    while end < len(lines) and not re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[end]):
        end += 1
    return "\n".join(lines[start:end]) + "\n"


def job_keys(block):
    return dict(re.findall(r"^    ([a-z-]+):[ ]*(.*)$", block, re.M))


def job_steps(source, job):
    return [step for step in workflow_steps(source) if step["job"] == job]


def step_text(step):
    return "\n".join(step["lines"])


def step_with(steps, text, key="run"):
    found = []
    for index, step in enumerate(steps):
        haystack = step_text(step) if key is None else (step_value(step, key) or "")
        if text in haystack:
            found.append(index)
    if len(found) != 1:
        raise AssertionError(str(len(found)) + " steps contain " + repr(text))
    return found[0]


class IosLaneWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.source = WORKFLOW.read_text(encoding="utf-8")

    def jobs(self):
        for job, spec in IOS_JOBS.items():
            yield job, spec, job_block(self.source, job), job_steps(self.source, job)

    def test_each_job_runs_on_its_image_behind_the_web_gate_with_its_runtime_and_model(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                keys = job_keys(block)
                self.assertEqual(keys["runs-on"], spec["label"])
                self.assertEqual(keys["needs"], "changes")
                self.assertEqual(keys["if"], "needs.changes.outputs.web == 'true'")
                self.assertEqual(keys["timeout-minutes"], "40")
                self.assertIn('      IOS_RUNTIME: "' + spec["runtime"] + '"\n', block)
                self.assertIn("      IOS_MODEL: iPhone 17\n", block)

    def test_each_job_only_reads_the_checkout_and_has_no_secret_and_no_upload(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                lines = block.split("\n")
                granted = []
                for line in lines[lines.index("    permissions:") + 1:]:
                    if not line.startswith("      "):
                        break
                    granted.append(line.strip())
                self.assertEqual(granted, ["contents: read"])
                self.assertEqual([step_value(step, "uses") for step in steps if step_value(step, "uses")], [CHECKOUT_USES])
                self.assertIn("persist-credentials: false", step_text(steps[0]))
                self.assertNotIn("upload", block.lower())
                self.assertNotIn("secrets", block)

    def test_each_job_gets_the_pinned_darwin_node_first_and_installs_from_the_lock_file(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                fetch = step_with(steps, "python3 tools/ci/fetch-pinned node-darwin-arm64")
                path = step_with(steps, 'echo "$RUNNER_TEMP/pinned/node-v22.21.0-darwin-arm64/bin" >> "$GITHUB_PATH"')
                install = step_with(steps, "npm ci --ignore-scripts")
                self.assertLess(fetch, path)
                self.assertLess(path, install)
                self.assertEqual(step_value(steps[install], "working-directory"), "apps/web")
                self.assertLess(install, step_with(steps, "sw_vers"))

    def test_each_job_records_the_versions_and_the_chosen_simulator_in_the_summary(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                versions = step_value(steps[step_with(steps, "sw_vers")], "run")
                for word in ("xcodebuild -version", "safaridriver --version", "GITHUB_STEP_SUMMARY"):
                    self.assertIn(word, versions)
                pick = step_value(steps[step_with(steps, "xcrun simctl list -j devices available")], "run")
                self.assertIn(TOOL + ' pick "$IOS_RUNTIME" "$IOS_MODEL"', pick)
                self.assertIn("GITHUB_ENV", pick)
                self.assertIn("GITHUB_STEP_SUMMARY", pick)
                self.assertNotIn("simctl create", block)

    def test_each_job_writes_the_preference_before_the_boot_and_waits_for_the_boot(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                boot = step_value(steps[step_with(steps, 'xcrun simctl bootstatus "$QD_UDID" -b')], "run")
                first_boot = boot.index('xcrun simctl boot "$QD_UDID"')
                self.assertLess(boot.index("ConnectHardwareKeyboard -bool NO"), first_boot)
                self.assertLess(boot.index(WRITE_PREFERENCE), first_boot)
                self.assertIn("Remote Automation is not on in the simulator", boot)
                self.assertGreater(boot.rindex('xcrun simctl boot "$QD_UDID"'), boot.index("simctl shutdown"))

    def test_each_job_enables_and_starts_safaridriver_on_a_loopback_port(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                run = step_value(steps[step_with(steps, "sudo safaridriver --enable")], "run")
                self.assertLess(run.index("sudo safaridriver --enable"), run.index('safaridriver --port "$driver_port"'))
                self.assertIn("QD_WEBDRIVER=" + "http://127.0.0.1:$driver_port", run)
                self.assertNotIn("0.0.0.0", block)

    def test_each_job_serves_the_fixture_build_on_a_loopback_port(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                serve = steps[step_with(steps, 'PORT="$app_port" node tools/serve-app.mjs')]
                run = step_value(serve, "run")
                self.assertEqual(step_value(serve, "working-directory"), "apps/web")
                self.assertLess(run.index("node tools/build-app.mjs --fixtures"), run.index("node tools/serve-app.mjs"))
                self.assertIn("QD_ORIGIN=http://127.0.0.1:$app_port", run)

    def test_the_preflight_comes_before_the_plain_run_and_the_planted_run_is_last(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                order = [
                    step_with(steps, 'xcrun simctl bootstatus "$QD_UDID" -b'),
                    step_with(steps, 'safaridriver --port "$driver_port"'),
                    step_with(steps, TOOL + ' session "$QD_WEBDRIVER" "$QD_UDID"'),
                    step_with(steps, 'PORT="$app_port" node tools/serve-app.mjs'),
                    next(index for index, step in enumerate(steps) if step_value(step, "run") == DRIVER),
                    step_with(steps, "git archive HEAD:apps/web"),
                    step_with(steps, 'QD_ORIGIN="$QD_PLANTED_ORIGIN" ' + DRIVER),
                ]
                self.assertEqual(order, sorted(order))
                self.assertEqual(len(set(order)), len(order))
                self.assertEqual(order[-1], len(steps) - 1)

    def test_only_the_planted_run_expects_a_shrink(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                self.assertEqual(block.count("QD_EXPECT"), 1)
                planted = steps[step_with(steps, "QD_EXPECT: shrink", None)]
                self.assertEqual(step_value(planted, "run"), 'QD_ORIGIN="$QD_PLANTED_ORIGIN" ' + DRIVER)

    def test_the_planted_copy_is_made_checked_applied_built_and_served_in_that_order(self):
        for job, spec, block, steps in self.jobs():
            with self.subTest(job=job):
                run = step_value(steps[step_with(steps, "git archive HEAD:apps/web")], "run")
                wanted = [
                    "git archive HEAD:apps/web | tar -x -f - -C",
                    'ln -s "$GITHUB_WORKSPACE/apps/web/node_modules"',
                    "git apply --check " + PATCH,
                    "git apply " + PATCH,
                    "node tools/build-app.mjs --fixtures",
                    "node tools/serve-app.mjs",
                    "QD_PLANTED_ORIGIN=http://127.0.0.1:$planted_port",
                ]
                places = [run.index(part) for part in wanted]
                self.assertEqual(places, sorted(places))

    def test_the_run_scripts_parse_in_bash_and_avoid_bash_4_features(self):
        for job, spec, block, steps in self.jobs():
            for step in steps:
                run = step_value(step, "run")
                if not run:
                    continue
                with self.subTest(job=job, step=step_value(step, "name")):
                    parsed = subprocess.run(["bash", "-n"], input=run + "\n", capture_output=True, text=True)
                    self.assertEqual((parsed.returncode, parsed.stderr), (0, ""))
                    for word in ("mapfile", "readarray", "declare -A", "|&", "<<<"):
                        self.assertNotIn(word, run)

    def test_qd_check_waits_for_both_jobs_and_requires_their_results(self):
        block = job_block(self.source, "qd-check")
        needs = re.findall(r"^      - (\S+)$", block.split("    runs-on:")[0], re.M)
        env = block.split("    env:\n")[1].split("    steps:\n")[0]
        script = block.split("run: |\n")[1]
        for job in IOS_JOBS:
            with self.subTest(job=job):
                self.assertIn(job, needs)
                variable = job.upper().replace("-", "_") + "_RESULT"
                self.assertIn("      " + variable + ": ${{ needs." + job + ".result }}\n", env)
                self.assertIn('"$' + variable + '"', script)
        loop = next(line for line in script.split("\n") if '"$IOS_TYPING_26_RESULT"' in line)
        self.assertIn('"$WEB_DESIGN_SELFTEST_RESULT" "$IOS_TYPING_26_RESULT" "$IOS_TYPING_27_RESULT"; do', loop)
        self.assertLess(script.index("expected=success"), script.index(loop.strip()))

    def test_the_ci_page_names_the_lane_the_preference_and_the_phone_check(self):
        page = (HERE.parent.parent / "docs" / "operations" / "CI.md").read_text(encoding="utf-8")
        for word in ("ios-typing-26", "ios-typing-27", "macos-26", "xcode-27", "Remote Automation", "Home Screen", "pre-367.patch"):
            with self.subTest(word=word):
                self.assertIn(word, page)


def simulator_device(udid, name, available=True):
    return {"udid": udid, "name": name, "isAvailable": available, "state": "Shutdown"}


RUNTIME = "com.apple.CoreSimulator.SimRuntime."
SIMULATORS = {"devices": {
    RUNTIME + "iOS-18-6": [simulator_device("old-17", "iPhone 17")],
    RUNTIME + "iOS-26-2": [simulator_device("udid-26-2", "iPhone 17")],
    RUNTIME + "iOS-26-4": [simulator_device("udid-26-4", "iPhone 17")],
    RUNTIME + "iOS-26-5": [simulator_device("udid-26-5-pro", "iPhone 17 Pro"), simulator_device("udid-26-5", "iPhone 17")],
    RUNTIME + "iOS-27-0": [simulator_device("udid-27-0", "iPhone 17"), simulator_device("udid-27-0-air", "iPhone Air")],
    RUNTIME + "iOS-27-1": [simulator_device("udid-27-1", "iPhone Duo")],
    RUNTIME + "watchOS-26-5": [simulator_device("watch", "iPhone 17")],
}}


class StandInDriver(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        return None

    def answer(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.answer(*self.server.replies["GET"])

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.server.seen.append(("POST", self.path, json.loads(self.rfile.read(length))))
        self.answer(*self.server.replies["POST"])

    def do_DELETE(self):
        self.server.seen.append(("DELETE", self.path, None))
        self.answer(*self.server.replies["DELETE"])


class StandIn:
    def __init__(self, **replies):
        self.replies = {"GET": (404, {}), "POST": (200, {}), "DELETE": (200, {"value": None}), **replies}

    def __enter__(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StandInDriver)
        self.server.replies = self.replies
        self.server.seen = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_address[1])
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def closed_url():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return "http://127.0.0.1:" + str(probe.getsockname()[1])


class IosSimulatorToolTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module("ios_simulator.py")

    def run_tool(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.module.main(["ios_simulator.py", *args])
        return code, out.getvalue(), err.getvalue()

    def test_the_newest_ready_runtime_of_a_major_version_is_chosen(self):
        self.assertEqual(self.module.pick(SIMULATORS, "26", "iPhone 17"), ("udid-26-5", "26.5"))

    def test_a_full_version_is_an_exact_match(self):
        self.assertEqual(self.module.pick(SIMULATORS, "27.0", "iPhone 17"), ("udid-27-0", "27.0"))
        self.assertEqual(self.module.pick(SIMULATORS, "26.4", "iPhone 17"), ("udid-26-4", "26.4"))
        self.assertIsNone(self.module.pick(SIMULATORS, "27.1", "iPhone 17"))

    def test_a_runtime_without_the_model_is_skipped_for_an_older_one_of_the_same_major_version(self):
        self.assertEqual(self.module.pick(SIMULATORS, "27", "iPhone 17"), ("udid-27-0", "27.0"))

    def test_the_model_name_must_match_exactly(self):
        self.assertEqual(self.module.pick(SIMULATORS, "26", "iPhone 17 Pro"), ("udid-26-5-pro", "26.5"))
        self.assertIsNone(self.module.pick(SIMULATORS, "27", "iPhone 17 Pro"))

    def test_other_platforms_and_other_majors_are_never_chosen(self):
        self.assertIsNone(self.module.pick(SIMULATORS, "28", "iPhone 17"))
        self.assertIsNone(self.module.pick({"devices": {RUNTIME + "watchOS-26-5": [simulator_device("w", "iPhone 17")]}}, "26", "iPhone 17"))

    def test_a_device_that_is_not_available_is_skipped(self):
        listing = {"devices": {RUNTIME + "iOS-26-5": [simulator_device("gone", "iPhone 17", False)], RUNTIME + "iOS-26-4": [simulator_device("here", "iPhone 17")]}}
        self.assertEqual(self.module.pick(listing, "26", "iPhone 17"), ("here", "26.4"))

    def test_two_matching_devices_resolve_to_the_lowest_udid(self):
        listing = {"devices": {RUNTIME + "iOS-26-5": [simulator_device("b-two", "iPhone 17"), simulator_device("a-one", "iPhone 17")]}}
        self.assertEqual(self.module.pick(listing, "26", "iPhone 17"), ("a-one", "26.5"))

    def test_the_command_prints_environment_lines_and_nothing_else(self):
        shown = subprocess.run(
            [sys.executable, "-B", str(HERE / "ios_simulator.py"), "pick", "26", "iPhone 17"],
            input=json.dumps(SIMULATORS), capture_output=True, text=True, timeout=30,
        )
        self.assertEqual((shown.returncode, shown.stdout, shown.stderr), (0, "QD_UDID=udid-26-5\nQD_RUNTIME=26.5\n", ""))

    def test_no_match_and_an_unreadable_list_each_fail_with_one_plain_line(self):
        none = subprocess.run(
            [sys.executable, "-B", str(HERE / "ios_simulator.py"), "pick", "27.1", "iPhone 17"],
            input=json.dumps(SIMULATORS), capture_output=True, text=True, timeout=30,
        )
        self.assertEqual((none.returncode, none.stdout, none.stderr), (1, "", "iOS typing lane: no ready iOS 27.1 simulator named iPhone 17\n"))
        unreadable = subprocess.run(
            [sys.executable, "-B", str(HERE / "ios_simulator.py"), "pick", "26", "iPhone 17"],
            input="not json", capture_output=True, text=True, timeout=30,
        )
        self.assertEqual((unreadable.returncode, unreadable.stdout, unreadable.stderr), (1, "", "iOS typing lane: the simulator list could not be read\n"))

    def test_a_free_port_can_be_bound_straight_away(self):
        code, out, err = self.run_tool("port")
        self.assertEqual((code, err), (0, ""))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", int(out)))

    def test_any_http_answer_counts_as_up(self):
        with StandIn() as server:
            code, out, err = self.run_tool("wait", "the app server", server.url + "/", "5")
        self.assertEqual((code, err), (0, ""))

    def test_a_port_nothing_answers_on_fails_with_one_plain_line(self):
        code, out, err = self.run_tool("wait", "safaridriver", closed_url() + "/status", "0.3")
        self.assertEqual((code, out, err), (1, "", "iOS typing lane: safaridriver did not answer within 0.3 seconds\n"))

    def test_a_session_is_created_with_the_three_capabilities_and_deleted(self):
        reply = (200, {"value": {"sessionId": "abc", "capabilities": {}}})
        with StandIn(POST=reply) as server:
            code, out, err = self.run_tool("session", server.url, "udid-26-5")
            seen = server.server.seen
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(len(out.splitlines()), 1)
        capabilities = {"platformName": "iOS", "safari:useSimulator": True, "safari:deviceUDID": "udid-26-5"}
        self.assertEqual(seen, [("POST", "/session", {"capabilities": {"alwaysMatch": capabilities}}), ("DELETE", "/session/abc", None)])

    def test_a_refusal_that_names_remote_automation_says_so_in_one_line(self):
        reply = (500, {"value": {"error": "session not created", "message": "Could not create a session: Remote Automation is disabled"}})
        with StandIn(POST=reply) as server:
            code, out, err = self.run_tool("session", server.url, "udid-26-5")
            seen = server.server.seen
        self.assertEqual((code, out, err), (1, "", "iOS typing lane: Remote Automation is not on in the simulator\n"))
        self.assertEqual([entry[0] for entry in seen], ["POST"])

    def test_any_other_refusal_names_the_error_and_the_message_in_one_line(self):
        reply = (500, {"value": {"error": "session not created", "message": "boom"}})
        with StandIn(POST=reply) as server:
            code, out, err = self.run_tool("session", server.url, "udid-26-5")
        self.assertEqual((code, out, err), (1, "", "iOS typing lane: safaridriver refused the session (session not created): boom\n"))

    def test_a_session_that_cannot_be_closed_fails(self):
        with StandIn(POST=(200, {"value": {"sessionId": "abc"}}), DELETE=(500, {"value": {"error": "unknown error"}})) as server:
            code, out, err = self.run_tool("session", server.url, "udid-26-5")
        self.assertEqual((code, out, err), (1, "", "iOS typing lane: safaridriver could not close the preflight session\n"))

    def test_a_driver_that_does_not_answer_fails_in_one_line(self):
        code, out, err = self.run_tool("session", closed_url(), "udid-26-5")
        self.assertEqual((code, out, err), (1, "", "iOS typing lane: safaridriver did not answer the session request\n"))

    def test_a_wrong_command_is_a_usage_error(self):
        self.assertEqual(self.run_tool("nothing")[0], 2)
        self.assertEqual(self.run_tool("pick", "26")[0], 2)


if __name__ == "__main__":
    unittest.main()
