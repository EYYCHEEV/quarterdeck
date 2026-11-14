import pathlib
import re
import unittest

from test_ci_tools import step_value, workflow_steps

WORKFLOWS = pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows"
RELEASE = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
CI = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
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
                self.assertEqual(solid(named(RELEASE, "build-web", name)), solid(theirs))
        wanted = [
            "Fetch the pinned Node",
            "Put the pinned Node first on the path",
            "Install the web dependencies from the lock file",
            "Verify registry signatures",
            "Build the web bundle twice with chat on",
        ]
        names = [step_value(step, "name") for step in steps(RELEASE, "build-web")]
        self.assertEqual([name for name in names if name in wanted], wanted)

    def test_the_web_job_installs_checks_and_builds_with_exactly_server_and_chat(self):
        commands = ("npm ci --ignore-scripts", "npm audit signatures", "npm run build:app -- --server --chat")
        self.assertEqual(
            [line for line in job_lines(RELEASE, "build-web") if "npm" in line],
            [WEB_FOLDER + command + ")" for command in commands],
        )
        elsewhere = [
            line for step in workflow_steps(RELEASE) if step["job"] != "build-web"
            for line in step["lines"] if "npm" in line
        ]
        self.assertEqual(elsewhere, [])

    def test_the_web_bundle_is_packed_with_the_tar_options_of_ci(self):
        theirs = [line.strip() for line in CI.splitlines() if line.strip().startswith("tar ") and "server-chat.tar" in line]
        ours = [line for line in job_lines(RELEASE, "build-web") if line.startswith("tar ")]
        self.assertEqual(len(theirs), 1)
        self.assertEqual(len(ours), 1)
        options, _, target = ours[0].partition(" -cf ")
        self.assertEqual(options, theirs[0].partition(" -cf ")[0])
        self.assertEqual(target, '"out-$n/' + WEB + '" -C "web-$n/apps/web/dist" .')

    def test_the_server_package_is_assembled_by_the_server_lane(self):
        lines = [line for line in job_lines(RELEASE, "build") if "server_lane.py" in line]
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith('python3 -B "build-$n/deploy/server_lane.py" --assemble-only '), lines[0])

    def test_every_part_is_compared_between_the_two_builds(self):
        compared = [
            line for job in ("build-web", "build")
            for line in run_lines(named(RELEASE, job, COMPARE)) if line.startswith("cmp ")
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
        self.assertEqual(RELEASE.count('-f message="Quarterdeck v$VERSION"'), 1)
        self.assertEqual(RELEASE.count('--title "Quarterdeck v$VERSION"'), 1)

    def test_every_action_is_one_of_the_four_pinned_ones(self):
        used = {line.split("uses:", 1)[1].strip() for line in RELEASE.splitlines() if line.strip().startswith(("uses:", "- uses:"))}
        self.assertEqual(used, ACTIONS)

    def test_only_the_draft_job_may_write_and_only_it_gets_the_token(self):
        self.assertEqual(re.findall(r"^permissions:.*$", RELEASE, re.M), ["permissions: {}"])
        granted = dict(re.findall(r"^  ([a-z-]+):\n(?:    .*\n)*?    permissions:\n((?:      .*\n)+)", RELEASE, re.M))
        self.assertEqual(granted, {
            "build-web": "      contents: read\n",
            "build": "      contents: read\n",
            "draft": "      contents: write\n",
        })
        self.assertEqual(RELEASE.count("permissions:"), 4)
        self.assertEqual(RELEASE.count("github.token"), 1)
        self.assertEqual(RELEASE.count("GH_TOKEN"), 1)
        self.assertGreater(RELEASE.index("GH_TOKEN"), RELEASE.index("\n  draft:\n"))

    def test_the_only_trigger_is_a_manual_run_and_no_secret_is_named(self):
        start = RELEASE.index("\non:\n") + len("\non:\n")
        block = RELEASE[start:RELEASE.index("\n\n", start)]
        self.assertEqual([line for line in block.split("\n") if re.match(r"  \S", line)], ["  workflow_dispatch:"])
        self.assertNotIn("secrets.", RELEASE)
        self.assertNotIn("secrets[", RELEASE)

    def test_both_build_jobs_start_from_the_same_checked_commit(self):
        for name in ("Check the inputs", "Checkout the named commit", "Confirm the commit, the branch and the version"):
            with self.subTest(step=name):
                first = solid(named(RELEASE, "build-web", name))
                self.assertIsNotNone(first)
                self.assertEqual(first, solid(named(RELEASE, "build", name)))

    def test_the_jobs_run_in_order_and_hand_files_on_as_artifacts(self):
        needs = dict(re.findall(r"^  ([a-z-]+):\n(?:    .*\n)*?    needs: (.*)\n", RELEASE, re.M))
        self.assertEqual(needs, {"build": "build-web", "draft": "build"})
        handed = [
            (step["job"], step_value(step, "uses").split("/")[1].split("@")[0], settings(step).get("name"), settings(step).get("path"))
            for step in workflow_steps(RELEASE) if "-artifact@" in (step_value(step, "uses") or "")
        ]
        self.assertEqual(handed, [
            ("build-web", "upload-artifact", "web-bundle", "out-1/"),
            ("build", "download-artifact", "web-bundle", "web"),
            ("build", "upload-artifact", "release-files", "release/"),
            ("draft", "download-artifact", "release-files", "release"),
        ])


if __name__ == "__main__":
    unittest.main()
