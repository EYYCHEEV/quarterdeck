import pathlib
import re
import unittest

from test_ci_changes import job_blocks, job_list, job_setting
from test_ci_tools import step_value, workflow_steps

WORKFLOWS = pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows"
RELEASE = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
BUILD = (WORKFLOWS / "release-build.yml").read_text(encoding="utf-8")
CI = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
LOCAL = "./.github/workflows/release-build.yml"
WHEEL = "quarterdeck_mcp-$VERSION-py3-none-any.whl"
WAKE = "quarterdeck-omp-wake-$VERSION.tar.gz"
WEB = "quarterdeck-web-$VERSION.tar"
SERVER = "quarterdeck-server-qd-web-$VERSION.tar.gz"
PARTS = (WHEEL, WAKE, WEB, SERVER)
ACTIONS = {
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
}
COMPARE = "Fail if the two builds differ"
WEB_FOLDER = '(cd "web-$n/apps/web" && '
WAKE_SCRIPT = "python3 tools/ci/wake_archive_check.py"
WAKE_TEST = "Test the extension from its unpacked archive"
CONFIRM = "Confirm the commit, the branch and the version"
ANCESTRY = 'git merge-base --is-ancestor "$COMMIT" origin/main'
BASE_CONFIRM = [
    "      - name: Confirm the commit, the branch and the version",
    "        run: |",
    "          set -eu",
    '          test "$(git rev-parse HEAD)" = "$COMMIT"',
    "          " + ANCESTRY,
    '          grep -Fq "\\"version\\": \\"$VERSION\\"" omp-quarterdeck/package.json',
    '          grep -Fxq "## $VERSION" CHANGELOG.md',
]
GRANTED = r"^  ([a-z-]+):\n(?:    .*\n)*?    permissions:\n((?:      .*\n)+)"
NEEDS = r"^  ([a-z-]+):\n(?:    .*\n)*?    needs: (.*)\n"
HELPER = pathlib.Path(__file__).resolve().with_name("safe_unpack.py")
SCRIPT = pathlib.Path(__file__).resolve().with_name("wake_archive_check.py")


def steps(text, job):
    return [step for step in workflow_steps(text) if step["job"] == job]


def named(text, job, name):
    found = [step for step in steps(text, job) if step_value(step, "name") == name]
    return found[0] if len(found) == 1 else None


def solid(step):
    return None if step is None else [line for line in step["lines"] if line.strip()]


def run_lines(step):
    return [] if step is None else (step_value(step, "run") or "").split("\n")


def job_lines(text, job):
    return [line for step in steps(text, job) for line in run_lines(step)]


def trigger_block(text):
    start = text.index("\non:\n") + len("\non:\n")
    return text[start:text.index("\n\n", start)]


def used_actions(text):
    return {line.split("uses:", 1)[1].strip() for line in text.splitlines() if line.strip().startswith(("uses:", "- uses:"))}


def inputs_given(block):
    return dict(line.split(": ", 1) for line in job_list(block, "with"))


def settings(step):
    lines = step["lines"]
    if "        with:" not in lines:
        return {}
    found = {}
    for line in lines[lines.index("        with:") + 1:]:
        if not line.startswith("          "):
            break
        key, _, value = line.strip().partition(":")
        found[key] = value.strip()
    return found


class ReleaseWorkflowTest(unittest.TestCase):
    def test_the_web_job_gets_node_with_the_same_two_steps_as_ci(self):
        for name in ("Fetch the pinned Node", "Put the pinned Node first on the path"):
            with self.subTest(step=name):
                theirs = named(CI, "web-build", name)
                self.assertIsNotNone(theirs)
                self.assertEqual(solid(named(BUILD, "build-web", name)), solid(theirs))
        wanted = [
            "Fetch the pinned Node",
            "Put the pinned Node first on the path",
            "Install the web dependencies from the lock file",
            "Verify registry signatures",
            "Build the web bundle twice with chat on",
        ]
        names = [step_value(step, "name") for step in steps(BUILD, "build-web")]
        self.assertEqual([name for name in names if name in wanted], wanted)

    def test_the_web_job_installs_checks_and_builds_with_exactly_server_and_chat(self):
        commands = ("npm ci --ignore-scripts", "npm audit signatures", "npm run build:app -- --server --chat")
        self.assertEqual(
            [line for line in job_lines(BUILD, "build-web") if "npm" in line],
            [WEB_FOLDER + command + ")" for command in commands],
        )
        elsewhere = [
            line for step in workflow_steps(BUILD) if step["job"] != "build-web"
            for line in step["lines"] if "npm" in line
        ] + [line for step in workflow_steps(RELEASE) for line in step["lines"] if "npm" in line]
        self.assertEqual(elsewhere, [])

    def test_the_web_bundle_is_packed_with_the_tar_options_of_ci(self):
        theirs = [line.strip() for line in CI.splitlines() if line.strip().startswith("tar ") and "server-chat.tar" in line]
        ours = [line for line in job_lines(BUILD, "build-web") if line.startswith("tar ")]
        self.assertEqual(len(theirs), 1)
        self.assertEqual(len(ours), 1)
        options, _, target = ours[0].partition(" -cf ")
        self.assertEqual(options, theirs[0].partition(" -cf ")[0])
        self.assertEqual(target, '"out-$n/' + WEB + '" -C "web-$n/apps/web/dist" .')

    def test_the_wake_archive_is_packed_and_tested_only_through_the_shared_script(self):
        lines = job_lines(BUILD, "build")
        self.assertEqual([line for line in lines if WAKE_SCRIPT in line], [
            WAKE_SCRIPT + ' pack "build-$n" "$VERSION" "out-$n"',
            WAKE_SCRIPT + ' test "out-1/' + WAKE + '" "$VERSION"',
        ])
        self.assertEqual(run_lines(named(BUILD, "build", WAKE_TEST)), [WAKE_SCRIPT + ' test "out-1/' + WAKE + '" "$VERSION"'])
        self.assertEqual([line for line in lines if re.search(r"omp-quarterdeck(?!/)", line)], [])
        self.assertEqual([line for line in lines if re.search(r"\bbun\b", line)], [])
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('"tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",', source)
        self.assertIn('f"s,^omp-quarterdeck,{name},"', source)
        self.assertIn('["gzip", "-n", "-9"]', source)

    def test_ci_runs_the_same_unpacked_archive_check_in_the_extension_job(self):
        step = named(CI, "extension", WAKE_TEST)
        self.assertIsNotNone(step)
        self.assertEqual(run_lines(step), [WAKE_SCRIPT + " check HEAD"])
        names = [step_value(each, "name") for each in steps(CI, "extension")]
        self.assertLess(names.index("Set up Bun"), names.index(WAKE_TEST))
        self.assertEqual([line for line in job_lines(CI, "extension") if "wake_archive_check" in line], [WAKE_SCRIPT + " check HEAD"])
        elsewhere = [
            line for each in workflow_steps(CI) if each["job"] != "extension"
            for line in each["lines"] if "wake_archive_check" in line
        ]
        self.assertEqual(elsewhere, [])

    def test_the_safe_unpack_helper_is_the_file_in_the_repository(self):
        self.assertTrue(HELPER.is_file())
        self.assertEqual(run_lines(named(BUILD, "build", "Write the safe unpack helper")), [
            'cp tools/ci/safe_unpack.py "$RUNNER_TEMP/safe_unpack.py"',
        ])
        writers = [
            line for line in job_lines(BUILD, "build")
            if "safe_unpack.py" in line and not line.startswith('python3 "$RUNNER_TEMP/safe_unpack.py" ')
        ]
        self.assertEqual(writers, ['cp tools/ci/safe_unpack.py "$RUNNER_TEMP/safe_unpack.py"'])

    def test_the_server_package_is_assembled_by_the_server_lane(self):
        lines = [line for line in job_lines(BUILD, "build") if "server_lane.py" in line]
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith('python3 -B "build-$n/deploy/server_lane.py" --assemble-only '), lines[0])

    def test_every_part_is_compared_between_the_two_builds(self):
        compared = [
            line for job in ("build-web", "build")
            for line in run_lines(named(BUILD, job, COMPARE)) if line.startswith("cmp ")
        ]
        self.assertEqual(sorted(compared), sorted(f'cmp "out-1/{part}" "out-2/{part}"' for part in PARTS))

    def test_the_draft_holds_exactly_the_four_parts_the_parts_list_and_the_sums(self):
        drafts = [step for step in steps(RELEASE, "draft") if "gh release create" in (step_value(step, "run") or "")]
        self.assertEqual(len(drafts), 1)
        attached = re.findall(r'release/([^"\s]+)', step_value(drafts[0], "run"))
        self.assertEqual(sorted(attached), sorted([*PARTS, "PARTS.json", "SHA256SUMS", "RELEASE-NOTES.md"]))
        check = "\n".join(run_lines(named(RELEASE, "draft", "Check that exactly one draft with exactly those files exists")))
        self.assertEqual(re.findall(r'--arg (\w+) "([^"]+)"', check), [
            ("tag", "v$VERSION"),
            ("title", "Quarterdeck v$VERSION"),
            ("wheel", WHEEL),
            ("archive", WAKE),
            ("web", WEB),
            ("server", SERVER),
        ])
        self.assertIn(".[0].name == $title", check)
        self.assertIn('([.[0].assets[].name] | sort) == ([$wheel, $archive, $web, $server, "PARTS.json", "SHA256SUMS"] | sort)', check)

    def test_the_tag_and_the_draft_are_named_quarterdeck_and_the_version(self):
        self.assertNotIn("bot tools", RELEASE)
        self.assertNotIn("bot tools", BUILD)
        self.assertEqual(RELEASE.count('-f message="Quarterdeck v$VERSION"'), 1)
        self.assertEqual(RELEASE.count('--title "Quarterdeck v$VERSION"'), 1)

    def test_every_action_is_one_of_the_four_pinned_ones_or_the_one_local_file(self):
        self.assertEqual(used_actions(BUILD), ACTIONS)
        self.assertLessEqual(used_actions(RELEASE), ACTIONS | {LOCAL})
        self.assertIn(LOCAL, used_actions(RELEASE))
        self.assertEqual(RELEASE.count(LOCAL), 1)
        self.assertNotIn("uses: ./", BUILD)

    def test_only_the_draft_job_may_write_and_only_it_gets_the_token(self):
        self.assertEqual(re.findall(r"^permissions:.*$", RELEASE, re.M), ["permissions: {}"])
        granted = dict(re.findall(GRANTED, RELEASE, re.M))
        self.assertEqual(granted, {
            "build": "      contents: read\n",
            "draft": "      contents: write\n",
        })
        self.assertEqual(RELEASE.count("permissions:"), 3)
        self.assertEqual(RELEASE.count("github.token"), 1)
        self.assertEqual(RELEASE.count("GH_TOKEN"), 1)
        self.assertGreater(RELEASE.index("GH_TOKEN"), RELEASE.index("\n  draft:\n"))

    def test_the_draft_job_is_still_the_only_writer_and_the_only_token_holder(self):
        blocks = job_blocks(RELEASE)
        self.assertEqual(list(blocks), ["build", "draft"])
        self.assertEqual([name for name, block in blocks.items() if "      contents: write" in block], ["draft"])
        self.assertEqual(
            [name for name, block in blocks.items() if any("GH_TOKEN" in line or "github.token" in line for line in block)],
            ["draft"],
        )
        self.assertEqual(job_list(blocks["build"], "permissions"), ["contents: read"])
        self.assertEqual(job_setting(blocks["draft"], "needs"), "build")

    def test_the_only_trigger_is_a_manual_run_and_no_secret_is_named(self):
        block = trigger_block(RELEASE)
        self.assertEqual([line for line in block.split("\n") if re.match(r"  \S", line)], ["  workflow_dispatch:"])
        self.assertEqual(re.findall(r"^      ([a-z-]+):$", block, re.M), ["version", "commit"])
        self.assertNotIn("workflow_call", RELEASE)
        self.assertNotIn("secrets.", RELEASE)
        self.assertNotIn("secrets[", RELEASE)

    def test_the_build_file_is_only_called_and_takes_exactly_three_inputs(self):
        block = trigger_block(BUILD)
        self.assertEqual([line for line in block.split("\n") if re.match(r"  \S", line)], ["  workflow_call:"])
        self.assertEqual(re.findall(r"^    \S.*$", block, re.M), ["    inputs:"])
        self.assertEqual(re.findall(r"^      ([a-z-]+):$", block, re.M), ["version", "commit", "check-only"])
        self.assertEqual(re.findall(r"^        required: (\w+)$", block, re.M), ["true", "true", "true"])
        self.assertEqual(re.findall(r"^        type: (\w+)$", block, re.M), ["string", "string", "boolean"])

    def test_the_build_file_has_no_write_right_no_token_no_secret_and_no_concurrency(self):
        for text in ("contents: write", "write-all", "github.token", "GH_TOKEN", "secrets", "concurrency"):
            with self.subTest(text=text):
                self.assertNotIn(text, BUILD)
        self.assertEqual(re.findall(r"^permissions:.*$", BUILD, re.M), ["permissions: {}"])
        self.assertEqual(dict(re.findall(GRANTED, BUILD, re.M)), {
            "build-web": "      contents: read\n",
            "build": "      contents: read\n",
        })
        self.assertEqual(BUILD.count("permissions:"), 3)
        self.assertEqual(re.findall(r"^env:", BUILD, re.M), [])

    def test_each_caller_names_the_one_build_file_and_says_whether_it_is_a_check(self):
        cases = (
            (RELEASE, "build", {"version": "${{ inputs.version }}", "commit": "${{ inputs.commit }}", "check-only": "false"}),
            (CI, "release-build", {"version": "${{ needs.changes.outputs.release-version }}", "commit": "${{ github.sha }}", "check-only": "true"}),
        )
        for text, job, wanted in cases:
            with self.subTest(job=job):
                blocks = job_blocks(text)
                self.assertEqual([name for name, block in blocks.items() if job_setting(block, "uses") == LOCAL], [job])
                self.assertEqual(text.count(LOCAL), 1)
                self.assertEqual(inputs_given(blocks[job]), wanted)

    def test_ci_runs_the_release_build_with_read_rights_and_qd_check_requires_it_to_succeed(self):
        blocks = job_blocks(CI)
        self.assertEqual(job_list(blocks["release-build"], "permissions"), ["contents: read"])
        self.assertEqual(job_setting(blocks["release-build"], "needs"), "changes")
        self.assertIn("- release-build", job_list(blocks["qd-check"], "needs"))
        self.assertIn("RELEASE_BUILD_RESULT: ${{ needs.release-build.result }}", job_list(blocks["qd-check"], "env"))
        lines = run_lines(named(CI, "qd-check", "Require every lane to pass"))
        self.assertTrue(lines[0].startswith("for result in "), lines[0])
        self.assertIn(' "$RELEASE_BUILD_RESULT"', lines[0])
        self.assertEqual(lines[1], 'test "$result" = success || exit 1')

    def test_the_confirm_steps_differ_from_the_base_text_in_exactly_the_ancestry_line(self):
        guarded = '          test "$CHECK_ONLY" = true || ' + ANCESTRY
        for job in ("build-web", "build"):
            with self.subTest(job=job):
                found = solid(named(BUILD, job, CONFIRM))
                self.assertIsNotNone(found)
                self.assertEqual(len(found), len(BASE_CONFIRM))
                self.assertEqual([(a, b) for a, b in zip(found, BASE_CONFIRM) if a != b], [(guarded, "          " + ANCESTRY)])
                self.assertEqual([line for line in job_lines(BUILD, job) if "is-ancestor" in line], [guarded.strip()])

    def test_the_check_only_flag_reaches_both_jobs_and_the_sums_are_printed(self):
        blocks = job_blocks(BUILD)
        for job in ("build-web", "build"):
            with self.subTest(job=job):
                self.assertEqual(job_list(blocks[job], "env"), [
                    "VERSION: ${{ inputs.version }}",
                    "COMMIT: ${{ inputs.commit }}",
                    "CHECK_ONLY: ${{ inputs.check-only }}",
                ])
        names = [step_value(step, "name") for step in steps(BUILD, "build")]
        after = names.index("Write the sums, the parts list and the release notes") + 1
        self.assertEqual(names[after], "Print the sums of the parts")
        self.assertEqual(run_lines(named(BUILD, "build", "Print the sums of the parts")), ['tee -a "$GITHUB_STEP_SUMMARY" < release/SHA256SUMS'])

    def test_both_build_jobs_start_from_the_same_checked_commit(self):
        for name in ("Check the inputs", "Checkout the named commit", CONFIRM):
            with self.subTest(step=name):
                first = solid(named(BUILD, "build-web", name))
                self.assertIsNotNone(first)
                self.assertEqual(first, solid(named(BUILD, "build", name)))

    def test_the_jobs_run_in_order_and_hand_files_on_as_artifacts(self):
        self.assertEqual(dict(re.findall(NEEDS, BUILD, re.M)), {"build": "build-web"})
        self.assertEqual(dict(re.findall(NEEDS, RELEASE, re.M)), {"draft": "build"})
        handed = [
            (step["job"], step_value(step, "uses").split("/")[1].split("@")[0], settings(step).get("name"), settings(step).get("path"))
            for text in (BUILD, RELEASE) for step in workflow_steps(text) if "-artifact@" in (step_value(step, "uses") or "")
        ]
        self.assertEqual(handed, [
            ("build-web", "upload-artifact", "web-bundle", "out-1/"),
            ("build", "download-artifact", "web-bundle", "web"),
            ("build", "upload-artifact", "release-files", "release/"),
            ("draft", "download-artifact", "release-files", "release"),
        ])


if __name__ == "__main__":
    unittest.main()
