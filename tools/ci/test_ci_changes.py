import hashlib
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

from test_ci_tools import HERE, WORKFLOW, load_module, step_value, without_path_map, workflow_steps

WEB_JOBS = ("web-static", "web-build", "web-browser", "web-design", "web-design-selftest")
APP_JOBS = ("app-static", "app-build", "app-browser")
GATED_JOBS = WEB_JOBS + APP_JOBS
UNGATED_JOBS = ("python", "server", "extension", "no-comments", "leaks")
MAIN_JOBS = ("changes", *UNGATED_JOBS, *GATED_JOBS, "pr-title", "qd-check")
MAIN_WORKFLOW_BLOB = "c639e234756c0b8222d0064fd46493ac425c246a"
BASE_FILES = {
    "apps/web/package.json": "{}\n",
    "apps/web/src/a.ts": "export const a = 1;\n",
    "apps/quarterdeck/package.json": "{}\n",
    "apps/quarterdeck/web/src/b.ts": "export const b = 1;\n",
    "docs/notes.md": "notes\n",
}


def only(jobs):
    return {job: "true" if job in jobs else "false" for job in GATED_JOBS}


def env_name(job):
    return job.upper().replace("-", "_")


def observe_notes(skipped):
    return ["ci-changes: observe mode, the path map skips no job", "ci-changes: the path map would have skipped: " + (", ".join(skipped) or "none")]


def git_env(**extra):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "ci",
        "GIT_AUTHOR_EMAIL": "ci@example.test",
        "GIT_COMMITTER_NAME": "ci",
        "GIT_COMMITTER_EMAIL": "ci@example.test",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    env.update(extra)
    return env


def git(root, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, env=git_env())


def write(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def job_blocks(text):
    blocks = {}
    current = None
    in_jobs = False
    for line in text.split("\n"):
        if line == "jobs:":
            in_jobs = True
            continue
        if not in_jobs:
            continue
        head = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if head:
            current = blocks.setdefault(head.group(1), [])
        elif current is not None:
            current.append(line)
    return blocks


def job_setting(block, key):
    start = "    " + key + ": "
    found = [line[len(start):] for line in block if line.startswith(start)]
    return found[0] if len(found) == 1 else None


def job_list(block, key):
    head = "    " + key + ":"
    if head not in block:
        return []
    found = []
    for line in block[block.index(head) + 1:]:
        if not line.startswith("      "):
            break
        found.append(line[6:])
    return found


class PathMapRulesTest(unittest.TestCase):
    def setUp(self):
        self.jobs_for = load_module("ci-changes").jobs_for

    def assert_jobs(self, jobs, *paths):
        for path in paths:
            self.assertEqual(tuple(self.jobs_for(path)), tuple(jobs), path)

    def test_a_file_in_an_app_folder_turns_on_the_jobs_of_that_app_only(self):
        self.assert_jobs(WEB_JOBS, "apps/web/package.json", "apps/web/src/shell/main.tsx", "apps/web/tools/build-app.mjs", "apps/web/README.md")
        self.assert_jobs(APP_JOBS, "apps/quarterdeck/package.json", "apps/quarterdeck/web/src/main.tsx", "apps/quarterdeck/packages/contracts/src/chat.ts", "apps/quarterdeck/standin/src/server.ts")

    def test_the_folders_the_web_app_reads_outside_its_own_turn_on_every_web_job(self):
        self.assert_jobs(WEB_JOBS, "licenses/IBM-PLEX-SANS-OFL-1.1.txt", "deploy/qd-web/package-manifest.json", "deploy/captain-app/package-manifest.json")

    def test_the_server_folder_the_new_app_reads_turns_on_every_new_app_job(self):
        self.assert_jobs(APP_JOBS, "apps/server/qd-web/bundle.py", "apps/server/approval/rules.py", "apps/server/shared/paths.py")

    def test_the_workflow_folder_and_the_ci_tools_turn_on_every_job(self):
        self.assert_jobs(GATED_JOBS, ".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/CODEOWNERS", "tools/ci/pins.json", "tools/ci/fetch-pinned", "tools/ci/ci-changes")

    def test_a_lockfile_anywhere_turns_on_every_job(self):
        self.assert_jobs(GATED_JOBS, "apps/web/package-lock.json", "apps/quarterdeck/package-lock.json", "omp-quarterdeck/bun.lock", "omp-quarterdeck/bun.lockb", "signup/uv.lock", "deploy/npm-shrinkwrap.json", "docs/pnpm-lock.yaml")

    def test_a_python_lockfile_anywhere_turns_on_every_job(self):
        self.assert_jobs(GATED_JOBS, "signup/pylock.toml", "pylock.toml", "apps/server/pylock.dev.toml", "qd-client-wheel/pylock.build.toml")

    def test_a_file_at_the_top_of_the_repository_turns_on_every_job(self):
        self.assert_jobs(GATED_JOBS, ".gitignore", ".editorconfig", "THIRD_PARTY_NOTICES.md", "README.md", "package.json")

    def test_a_file_the_gated_jobs_do_not_read_turns_on_none_of_them(self):
        self.assert_jobs(
            (),
            "docs/operations/CI.md",
            "signup/signup_flow.py",
            "mail/qd_jmap.py",
            "golive/connect/client.py",
            "qd-client-wheel/build.py",
            "omp-quarterdeck/src/wake.ts",
            "deploy/server_lane.py",
            "deploy/containers/test_layout.py",
            "apps/web-old/src/a.ts",
            "apps/quarterdeck-old/web/src/a.ts",
            "apps/serverless/a.py",
            "tools/ci-old/pins.json",
            "docs/.github/workflows/ci.yml",
            "docs/package-lock.json.md",
            "docs/pylock-notes.toml",
            "signup/pylock.toml.txt",
        )


class PathMapToolTest(unittest.TestCase):
    def folder(self, files):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = pathlib.Path(directory.name).resolve() / "checkout"
        root.mkdir()
        for name, content in files.items():
            write(root, name, content)
        return root

    def pull_request(self, change, base=BASE_FILES):
        root = self.folder(base)
        git(root, "init", "-q")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "base")
        git(root, "checkout", "-q", "-b", "change")
        change(root)
        git(root, "add", "-A")
        git(root, "commit", "-q", "--allow-empty", "-m", "change")
        git(root, "checkout", "-q", "-")
        git(root, "merge", "-q", "--no-ff", "-m", "merge", "change")
        return root

    def shallow_copy(self, source, depth):
        target = source.parent / ("depth-" + str(depth))
        subprocess.run(
            ["git", "clone", "-q", "--depth", str(depth), source.as_uri(), str(target)],
            check=True, capture_output=True, env=git_env(),
        )
        return target

    def run_tool(self, root, event, path=None, mode="enforce"):
        output = root.parent / "github-output"
        summary = root.parent / "github-step-summary"
        env = git_env(CI_CHANGES_ROOT=str(root), EVENT=event, GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(summary), GIT_CEILING_DIRECTORIES=str(root.parent))
        env.pop("CI_CHANGES_MODE", None)
        if mode is not None:
            env["CI_CHANGES_MODE"] = mode
        if path is not None:
            env["PATH"] = path
        result = subprocess.run([sys.executable, "-B", str(HERE / "ci-changes")], capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        written = output.read_text(encoding="utf-8")
        output.unlink()
        noted = summary.read_text(encoding="utf-8") if summary.exists() else ""
        summary.unlink(missing_ok=True)
        return result.stdout, dict(line.split("=", 1) for line in written.splitlines()), noted

    def gates(self, root, event, path=None):
        return self.run_tool(root, event, path)[1]

    def observed(self, root, event, skipped):
        printed, found, noted = self.run_tool(root, event, mode=None)
        notes = observe_notes(skipped)
        self.assertEqual(printed.splitlines()[1:3], notes)
        self.assertEqual(noted, "".join(note + "\n\n" for note in notes))
        return found

    def test_a_push_turns_on_every_gate(self):
        self.assertEqual(self.gates(self.folder(BASE_FILES), "push"), only(GATED_JOBS))

    def test_a_pull_request_turns_on_only_the_jobs_of_the_app_that_reads_its_files(self):
        for name, jobs in (
            ("apps/web/src/a.ts", WEB_JOBS),
            ("licenses/NEW.txt", WEB_JOBS),
            ("deploy/qd-web/package-manifest.json", WEB_JOBS),
            ("deploy/captain-app/package-manifest.json", WEB_JOBS),
            ("apps/quarterdeck/web/src/b.ts", APP_JOBS),
            ("apps/server/qd-web/bundle.py", APP_JOBS),
        ):
            root = self.pull_request(lambda root: write(root, name, "changed\n"))
            self.assertEqual(self.gates(root, "pull_request"), only(jobs), name)
        both = self.pull_request(lambda root: (write(root, "licenses/NEW.txt", "text\n"), write(root, "apps/server/qd-web/bundle.py", "x = 1\n")))
        self.assertEqual(self.gates(both, "pull_request"), only(GATED_JOBS))

    def test_a_pull_request_outside_the_map_turns_on_no_gate(self):
        root = self.pull_request(lambda root: write(root, "docs/notes.md", "more notes\n"))
        self.assertEqual(self.gates(root, "pull_request"), only(()))

    def test_with_no_mode_every_job_of_a_present_app_runs_and_the_map_names_what_it_would_skip(self):
        for name, skipped in (("docs/notes.md", GATED_JOBS), ("apps/web/src/a.ts", APP_JOBS), ("apps/quarterdeck/web/src/b.ts", WEB_JOBS), ("tools/ci/pins.json", ())):
            root = self.pull_request(lambda root: write(root, name, "changed\n"))
            self.assertEqual(self.observed(root, "pull_request", skipped), only(GATED_JOBS), name)
        self.assertEqual(self.observed(self.folder(BASE_FILES), "push", ()), only(GATED_JOBS))

    def test_a_pull_request_that_touches_a_shared_file_turns_on_every_gate(self):
        for name in (".github/workflows/ci.yml", "tools/ci/pins.json", "apps/web/package-lock.json", ".gitignore"):
            root = self.pull_request(lambda root: write(root, name, "changed\n"))
            self.assertEqual(self.gates(root, "pull_request"), only(GATED_JOBS), name)

    def test_a_pull_request_that_changes_only_a_python_lockfile_turns_on_every_gate(self):
        for name in ("signup/pylock.toml", "pylock.toml", "apps/server/pylock.dev.toml"):
            root = self.pull_request(lambda root: write(root, name, "changed\n"))
            self.assertEqual(self.gates(root, "pull_request"), only(GATED_JOBS), name)

    def test_a_file_moved_out_of_an_app_folder_still_turns_on_the_jobs_of_that_app(self):
        def move(root):
            (root / "apps/web/src/a.ts").rename(root / "docs/a.ts")

        self.assertEqual(self.gates(self.pull_request(move), "pull_request"), only(WEB_JOBS))

    def test_an_absent_app_keeps_its_gates_off_whatever_changed(self):
        base = {name: content for name, content in BASE_FILES.items() if name != "apps/quarterdeck/package.json"}
        self.assertEqual(self.gates(self.folder(base), "push"), only(WEB_JOBS))
        self.assertEqual(self.gates(self.folder(base), "workflow_dispatch"), only(WEB_JOBS))
        root = self.pull_request(lambda root: write(root, "apps/quarterdeck/web/src/b.ts", "export const b = 2;\n"), base)
        self.assertEqual(self.gates(root, "pull_request"), only(()))
        shared = self.pull_request(lambda root: write(root, "tools/ci/pins.json", "{}\n"), base)
        self.assertEqual(self.gates(shared, "pull_request"), only(WEB_JOBS))

    def test_an_absent_app_keeps_its_gates_off_in_observe_mode_and_is_not_named(self):
        base = {name: content for name, content in BASE_FILES.items() if name != "apps/quarterdeck/package.json"}
        root = self.pull_request(lambda root: write(root, "docs/notes.md", "more notes\n"), base)
        self.assertEqual(self.observed(root, "pull_request", WEB_JOBS), only(WEB_JOBS))
        self.assertEqual(self.observed(self.folder(base), "push", ()), only(WEB_JOBS))

    def test_every_case_where_the_change_cannot_be_read_turns_on_every_gate(self):
        every = only(GATED_JOBS)
        plain = self.folder(BASE_FILES)
        self.assertEqual(self.gates(plain, "workflow_dispatch"), every, "an event the tool does not know")
        self.assertEqual(self.gates(plain, ""), every, "no event name")
        self.assertEqual(self.gates(plain, "pull_request"), every, "a folder that is not a git checkout")
        line = self.folder(BASE_FILES)
        git(line, "init", "-q")
        git(line, "add", "-A")
        git(line, "commit", "-q", "-m", "base")
        self.assertEqual(self.gates(line, "pull_request"), every, "a commit with no parent")
        write(line, "docs/notes.md", "more notes\n")
        git(line, "add", "-A")
        git(line, "commit", "-q", "-m", "change")
        self.assertEqual(self.gates(line, "pull_request"), every, "a commit with one parent")
        self.assertEqual(self.gates(self.pull_request(lambda root: None), "pull_request"), every, "a merge that changes no file")
        merged = self.pull_request(lambda root: write(root, "docs/notes.md", "more notes\n"))
        self.assertEqual(self.gates(self.shallow_copy(merged, 1), "pull_request"), every, "a checkout without the parents")
        empty = merged.parent / "no-programs"
        empty.mkdir()
        self.assertEqual(self.gates(merged, "pull_request", path=str(empty)), every, "git cannot be started")

    def test_a_checkout_two_commits_deep_is_enough_to_read_the_change(self):
        merged = self.pull_request(lambda root: write(root, "apps/web/src/a.ts", "export const a = 2;\n"))
        self.assertEqual(self.gates(self.shallow_copy(merged, 2), "pull_request"), only(WEB_JOBS))

    def test_any_mode_but_the_exact_word_enforce_is_observe_mode(self):
        root = self.pull_request(lambda root: write(root, "docs/notes.md", "more notes\n"))
        for mode in ("Enforce", "ENFORCE", "enforce ", " enforce", "enforced", "yes", "true", "1", "observe", ""):
            self.assertEqual(self.run_tool(root, "pull_request", mode=mode)[1], only(GATED_JOBS), repr(mode))
        self.assertEqual(self.gates(root, "pull_request"), only(()))

    def test_the_log_names_the_gates_and_never_a_changed_file(self):
        root = self.pull_request(lambda root: write(root, "docs/line one\n::error::made up", "x\n"))
        printed, found, noted = self.run_tool(root, "pull_request")
        self.assertEqual(found, only(()))
        self.assertEqual(printed.splitlines(), ["ci-changes: read 1 changed file(s)"] + [job + "=false" for job in GATED_JOBS])
        self.assertEqual(noted, "")
        printed, found, noted = self.run_tool(root, "pull_request", mode=None)
        notes = observe_notes(GATED_JOBS)
        self.assertEqual(found, only(GATED_JOBS))
        self.assertEqual(printed.splitlines(), ["ci-changes: read 1 changed file(s)"] + notes + [job + "=true" for job in GATED_JOBS])
        self.assertEqual(noted, "".join(note + "\n\n" for note in notes))


class PathMapWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")
        self.blocks = job_blocks(self.text)

    def verdict(self, script, **changed):
        env = {"PATH": os.environ.get("PATH", "")}
        for name in ("CHANGES", "PYTHON", "SERVER", "EXTENSION", "COMMENTS", "LEAKS"):
            env[name + "_RESULT"] = "success"
        for job in GATED_JOBS:
            env[env_name(job) + "_GATE"] = "true"
            env[env_name(job) + "_RESULT"] = "success"
        env.update(changed)
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
            env=env, capture_output=True, text=True, timeout=10,
        )
        return result.returncode

    def test_every_job_on_main_is_still_there(self):
        self.assertEqual(tuple(self.blocks), MAIN_JOBS)

    def test_with_the_path_map_taken_out_the_workflow_is_the_file_on_main_byte_for_byte(self):
        self.assertIn("python3 tools/ci/ci-changes", self.text)
        data = without_path_map(self.text).encode("utf-8")
        blob = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
        self.assertEqual(blob, MAIN_WORKFLOW_BLOB)

    def test_each_gated_job_waits_for_the_map_and_reads_its_own_gate(self):
        for job in GATED_JOBS:
            self.assertEqual(job_setting(self.blocks[job], "needs"), "changes", job)
            self.assertEqual(job_setting(self.blocks[job], "if"), "needs.changes.outputs." + job + " == 'true'", job)

    def test_the_map_job_hands_out_one_gate_for_each_gated_job_and_nothing_else(self):
        self.assertEqual(
            job_list(self.blocks["changes"], "outputs"),
            [job + ": ${{ steps.gates.outputs." + job + " }}" for job in GATED_JOBS],
        )

    def test_the_map_job_reads_the_change_from_a_safe_checkout_two_commits_deep(self):
        steps = [step for step in workflow_steps(self.text) if step["job"] == "changes"]
        self.assertEqual([step_value(step, "name") for step in steps], ["Checkout", "Choose the jobs this change needs"])
        self.assertTrue(step_value(steps[0], "uses").startswith("actions/checkout@"))
        self.assertEqual(step_value(steps[0], "fetch-depth"), "2")
        self.assertEqual(step_value(steps[0], "persist-credentials"), "false")
        self.assertEqual(step_value(steps[1], "id"), "gates")
        self.assertEqual(step_value(steps[1], "EVENT"), "${{ github.event_name }}")
        self.assertEqual(step_value(steps[1], "run"), "python3 tools/ci/ci-changes")
        self.assertEqual(job_list(self.blocks["changes"], "permissions"), ["contents: read"])

    def test_the_jobs_outside_the_map_are_never_gated(self):
        for job in UNGATED_JOBS:
            self.assertEqual([line for line in self.blocks[job] if line.startswith(("    if:", "    needs:"))], [], job)
        self.assertEqual(job_setting(self.blocks["pr-title"], "if"), "github.event_name == 'pull_request'")
        self.assertIsNone(job_setting(self.blocks["pr-title"], "needs"))
        start = self.text.index("\non:\n") + 1
        self.assertEqual(self.text[start:self.text.index("\n\n", start)], "on:\n  pull_request:\n  push:\n    branches:\n      - main")

    def test_qd_check_always_runs_and_still_needs_every_job_but_pr_title(self):
        check = self.blocks["qd-check"]
        self.assertEqual(job_setting(check, "if"), "always()")
        self.assertEqual(job_list(check, "needs"), ["- " + job for job in MAIN_JOBS if job not in ("pr-title", "qd-check")])

    def test_qd_check_reads_every_gate_and_pairs_it_with_the_result_of_its_own_job(self):
        check = self.blocks["qd-check"]
        env = job_list(check, "env")
        for job in GATED_JOBS:
            self.assertIn(env_name(job) + "_GATE: ${{ needs.changes.outputs." + job + " }}", env)
            self.assertIn(env_name(job) + "_RESULT: ${{ needs." + job + ".result }}", env)
        self.assertEqual(
            [line.strip() for line in check if line.strip().startswith("pair ")],
            ["pair " + job + ' "$' + env_name(job) + '_GATE" "$' + env_name(job) + '_RESULT" || exit 1' for job in GATED_JOBS],
        )

    def test_qd_check_passes_only_when_every_job_matches_its_gate(self):
        steps = [
            step for step in workflow_steps(self.text)
            if step["job"] == "qd-check" and step_value(step, "name") == "Require every lane to pass"
        ]
        self.assertEqual(len(steps), 1)
        lines = steps[0]["lines"]
        script = "\n".join(line[10:] for line in lines[lines.index("        run: |") + 1:]).rstrip("\n") + "\n"
        self.assertEqual(self.verdict(script), 0)
        for job in GATED_JOBS:
            gate = env_name(job) + "_GATE"
            result = env_name(job) + "_RESULT"
            self.assertEqual(self.verdict(script, **{gate: "false", result: "skipped"}), 0, job)
            for wrong in (
                {gate: "true", result: "skipped"},
                {gate: "true", result: "failure"},
                {gate: "true", result: "cancelled"},
                {gate: "false", result: "success"},
                {gate: "false", result: "failure"},
                {gate: "", result: "skipped"},
                {gate: "", result: "success"},
                {gate: "TRUE", result: "success"},
            ):
                self.assertEqual(self.verdict(script, **wrong), 1, (job, wrong))
        for name in ("CHANGES", "PYTHON", "SERVER", "EXTENSION", "COMMENTS", "LEAKS"):
            for wrong in ("failure", "cancelled", "skipped", ""):
                self.assertEqual(self.verdict(script, **{name + "_RESULT": wrong}), 1, (name, wrong))


if __name__ == "__main__":
    unittest.main()
