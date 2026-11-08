import copy
import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import packaging_plan


ROOT = Path(__file__).resolve().parent
WORK = ROOT.parent


class PackagingTests(unittest.TestCase):
    def test_sixth_container_is_private_confined_and_alone_holds_captain_key(self):
        diff = json.loads((ROOT / "compose-diff.json").read_text(encoding="utf-8"))
        base_path = WORK / "golive/containers/compose.template.json"
        self.assertEqual(
            packaging_plan._digest(base_path),
            packaging_plan.COMPOSE_BASE_SHA256,
        )
        base = json.loads(base_path.read_text(encoding="utf-8"))
        rendered = packaging_plan.render_compose_diff(base, diff)
        self.assertEqual(rendered, base)
        packaging_plan.validate_compose(rendered)

        services = rendered["services"]
        self.assertEqual(set(services), {"caddy", "stalwart", "join", "helper", "approval", "captain-app"})
        captain = services["captain-app"]
        self.assertNotIn("ports", captain)
        self.assertEqual(captain["networks"], {"service": {}})
        serialized = {name: json.dumps(service) for name, service in services.items()}
        holders = [name for name, text in serialized.items() if "captain-mail-key" in text]
        self.assertEqual(holders, ["captain-app"])
        self.assertNotIn("approval-secrets", serialized["captain-app"])
        self.assertNotIn("quarterdeck-admin", serialized["captain-app"])
        self.assertIn(
            "/opt/quarterdeck/captain-app",
            services["approval"]["environment"]["PYTHONPATH"],
        )
        self.assertIn(
            "${QD_PACKAGE}/captain-app:/opt/quarterdeck/captain-app:ro",
            services["approval"]["volumes"],
        )
        self.assertIn("captain-auth", serialized["approval"])
        self.assertIn("captain-auth", serialized["captain-app"])

    def test_door_diff_renders_only_the_exact_chat_first_routes(self):
        base = json.loads((WORK / "golive/door/door-policy.json").read_text(encoding="utf-8"))
        diff = json.loads((ROOT / "door-policy.diff.json").read_text(encoding="utf-8"))
        rendered = packaging_plan.render_door_diff(base, diff)
        packaging_plan.validate_caddy_fragment(rendered)

        self.assertEqual(rendered.count("reverse_proxy captain-app:8080"), 4)
        for path in (
            "/captain/chat",
            "/captain/assets/chat.css",
            "/captain/assets/chat.js",
            "/captain/api/chats",
            "/captain/api/chat",
            "/captain/events",
        ):
            self.assertIn(path, rendered)
        self.assertNotIn("/captain/cards", rendered)
        self.assertNotIn("path /*", rendered)
        self.assertIsNone(re.search(r":80(?![0-9])", rendered))
        self.assertIn("header_up X-Forwarded-For {remote_host}", rendered)

    def test_unsafe_container_and_door_mutations_are_refused(self):
        compose_diff = json.loads(
            (ROOT / "compose-diff.json").read_text(encoding="utf-8")
        )
        rendered = packaging_plan.render_compose_diff(
            json.loads(
                (WORK / "golive/containers/compose.template.json").read_text(
                    encoding="utf-8"
                )
            ),
            compose_diff,
        )
        mutations = []
        for change in (
            lambda document: document["services"]["captain-app"].update(
                ports=["8080:8080"]
            ),
            lambda document: document["services"]["approval"]["volumes"].append(
                "${QD_ROOT}/volumes/captain-mail-key:/run/copied-key:ro"
            ),
            lambda document: document["services"]["captain-app"]["volumes"].append(
                "${QD_ROOT}/volumes/approval-secrets:/run/approval-secrets:ro"
            ),
        ):
            candidate = copy.deepcopy(rendered)
            change(candidate)
            mutations.append(candidate)
        for candidate in mutations:
            with self.assertRaises(packaging_plan.PackageRefused):
                packaging_plan.validate_compose(candidate)

        base = json.loads(
            (WORK / "golive/door/door-policy.json").read_text(encoding="utf-8")
        )
        door_diff = json.loads(
            (ROOT / "door-policy.diff.json").read_text(encoding="utf-8")
        )
        for change in (
            lambda document: document.update(upstream="captain-app:80"),
            lambda document: document["routes"][0].update(paths=["/*"]),
            lambda document: document["routes"][0].update(
                methods=["GET", "POST", "PUT"]
            ),
        ):
            candidate = copy.deepcopy(door_diff)
            change(candidate)
            with self.assertRaises(packaging_plan.PackageRefused):
                packaging_plan.render_door_diff(base, candidate)

    def test_renderer_refuses_to_overwrite_existing_output(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            destination = Path(temporary) / "rendered.conf"
            destination.write_bytes(b"existing")

            with self.assertRaises(packaging_plan.PackageRefused):
                packaging_plan.write_new(destination, b"replacement")

            self.assertEqual(destination.read_bytes(), b"existing")

    def test_door_base_identity_is_the_public_synthetic_placeholder(self):
        expected = hashlib.sha256(b"quarterdeck-public-synthetic-door-base-v1").hexdigest()
        self.assertTrue(packaging_plan.DOOR_BASE_SHA256 == expected, "door base identity must be synthetic")

    def test_both_door_consumers_accept_the_synthetic_identity(self):
        expected = hashlib.sha256(b"quarterdeck-public-synthetic-door-base-v1").hexdigest()
        base = {"frontProxy": {"routes": [{} for _ in range(20)]}}
        diff = json.loads((ROOT / "door-policy.diff.json").read_text())
        diff["baseSha256"] = expected
        packaging_plan.render_door_diff(base, diff)
        document = json.loads((ROOT / "package-manifest.json").read_text())
        document["bases"]["doorPolicy"] = expected
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package-manifest.json"
            path.write_text(json.dumps(document))
            with mock.patch.object(packaging_plan, "_digest", side_effect=lambda file: document["files"][file.name]):
                packaging_plan.verify_manifest(path)

    def test_both_door_consumers_refuse_a_different_made_up_identity(self):
        wrong = hashlib.sha256(b"quarterdeck-rejected-door-base-v1").hexdigest()
        base = {"frontProxy": {"routes": [{} for _ in range(20)]}}
        diff = json.loads((ROOT / "door-policy.diff.json").read_text())
        diff["baseSha256"] = wrong
        with self.assertRaises(packaging_plan.PackageRefused):
            packaging_plan.render_door_diff(base, diff)
        document = json.loads((ROOT / "package-manifest.json").read_text())
        document["bases"]["doorPolicy"] = wrong
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package-manifest.json"
            path.write_text(json.dumps(document))
            with mock.patch.object(packaging_plan, "_digest", side_effect=lambda file: document["files"][file.name]):
                with self.assertRaises(packaging_plan.PackageRefused):
                    packaging_plan.verify_manifest(path)

    def test_package_manifest_matches_every_shipped_non_test_file(self):
        packaging_plan.verify_manifest(ROOT / "package-manifest.json")


if __name__ == "__main__":
    unittest.main(verbosity=2)
