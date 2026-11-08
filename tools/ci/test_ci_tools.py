import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
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
        self.assertEqual(sorted(pins), ["chrome-headless-shell", "gitleaks", "node"])
        for name, pin in pins.items():
            self.assertEqual(len(pin["sha256"]), 64, name)
            self.assertTrue(pin["url"].startswith("https://"), name)


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
        original = WORKFLOW.read_text(encoding="utf-8")
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
        original = ci_with_selftest_env(WORKFLOW.read_text(encoding="utf-8"))
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


if __name__ == "__main__":
    unittest.main()
