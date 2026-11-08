import importlib.util
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import tarfile
import zipfile
import unittest
from pathlib import Path
from unittest import mock

import package_guard
import server_lane

DEPLOY = Path(__file__).resolve().parent
REPOSITORY = DEPLOY.parent

PUBLIC_FLOW = b"public flow\n"
SERVER_FLOW = b"public flow\nserver method\n"
PUBLIC_JMAP = b"public jmap\n"
SERVER_JMAP = b"server jmap\n"


def put(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


class GuardCase(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="qd-package-guard-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)
        self.repository = self.scratch / "repository"
        put(self.repository / "signup" / "signup_flow.py", PUBLIC_FLOW)
        put(self.repository / "apps" / "server" / "join" / "signup_flow.py", SERVER_FLOW)
        put(self.repository / "mail" / "qd_jmap.py", PUBLIC_JMAP)
        put(self.repository / "apps" / "server" / "mail" / "qd_jmap.py", SERVER_JMAP)
        self.package = self.scratch / "package"
        put(self.package / "signup" / "signup_flow.py", SERVER_FLOW)
        put(self.package / "qd-mail-stalwart" / "qd_jmap.py", SERVER_JMAP)
        put(self.package / "signup" / "other.py", b"other\n")

    def check(self):
        return package_guard.check_package(self.package, self.repository)

    def assertRefused(self, fragment):
        problems = self.check()
        self.assertTrue(any(fragment in line for line in problems), problems)


class PackageContentTests(GuardCase):
    def test_a_package_with_the_server_copies_is_clean(self):
        self.assertEqual(self.check(), [])

    def test_the_public_signup_flow_is_refused(self):
        put(self.package / "signup" / "signup_flow.py", PUBLIC_FLOW)
        self.assertRefused("public copy of signup_flow.py: signup/signup_flow.py")

    def test_the_public_qd_jmap_is_refused(self):
        put(self.package / "qd-mail-stalwart" / "qd_jmap.py", PUBLIC_JMAP)
        self.assertRefused("public copy of qd_jmap.py: qd-mail-stalwart/qd_jmap.py")

    def test_a_public_copy_under_a_fake_name_or_extension_is_refused(self):
        for name in ("signup_flow.png", "notes.txt", "flow", "signup_flow.py.bak", ".hidden"):
            with self.subTest(name=name):
                put(self.package / "extra" / name, PUBLIC_FLOW)
                self.assertRefused("public copy of signup_flow.py: extra/" + name)
                (self.package / "extra" / name).unlink()

    def test_a_public_copy_deep_in_the_package_is_refused(self):
        put(self.package / "a" / "b" / "c" / "d" / "copy.dat", PUBLIC_JMAP)
        self.assertRefused("public copy of qd_jmap.py: a/b/c/d/copy.dat")

    def test_a_module_name_with_other_bytes_is_refused(self):
        put(self.package / "signup" / "signup_flow.py", b"something else\n")
        self.assertRefused("not the server copy of signup_flow.py: signup/signup_flow.py")
        put(self.package / "elsewhere" / "qd_jmap.py", b"something else\n")
        self.assertRefused("not the server copy of qd_jmap.py: elsewhere/qd_jmap.py")

    def test_a_server_copy_under_any_name_is_not_refused(self):
        put(self.package / "extra" / "copy.txt", SERVER_FLOW)
        self.assertEqual(self.check(), [])

    def test_a_deleted_server_copy_cannot_allow_a_renamed_public_copy(self):
        (self.repository / "apps" / "server" / "join" / "signup_flow.py").unlink()
        public = (REPOSITORY / "signup" / "signup_flow.py").read_bytes()
        put(self.repository / "signup" / "signup_flow.py", public)
        put(self.package / "extra" / "renamed.txt", public)
        self.assertRefused("missing server copy: signup_flow.py")


class ArchiveTests(GuardCase):
    def test_zip_with_renamed_public_signup_member_is_refused(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("renamed/payload.txt", (REPOSITORY / "signup" / "signup_flow.py").read_bytes())
        put(self.package / "payload.bin", buffer.getvalue())
        self.assertRefused("archive: payload.bin")

    def test_tar_gzip_with_renamed_public_signup_member_is_refused(self):
        data = (REPOSITORY / "signup" / "signup_flow.py").read_bytes()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            member = tarfile.TarInfo("renamed/payload.txt")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        put(self.package / "payload.data", buffer.getvalue())
        self.assertRefused("archive: payload.data")

    def test_zip_named_txt_is_refused_even_without_a_guarded_member(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("ordinary.txt", "ordinary")
        put(self.package / "ordinary.txt", buffer.getvalue())
        self.assertRefused("archive: ordinary.txt")

    def test_archive_signatures_are_refused_regardless_of_name(self):
        signatures = {
            "zip": b"PK\x03\x04",
            "zip-empty": b"PK\x05\x06",
            "zip-spanned": b"PK\x07\x08",
            "gzip": b"\x1f\x8b",
            "bzip2": b"BZh",
            "xz": b"\xfd7zXZ\x00",
            "zstd": b"\x28\xb5\x2f\xfd",
            "zstd-skippable": b"\x50\x2a\x4d\x18",
            "7z": b"7z\xbc\xaf\x27\x1c",
            "rar4": b"Rar!\x1a\x07\x00",
            "rar5": b"Rar!\x1a\x07\x01\x00",
            "tar": b"\x00" * 257 + b"ustar\x00",
            "ar": b"!<arch>\n",
            "ar-thin": b"!<thin>\n",
        }
        for kind, header in signatures.items():
            with self.subTest(kind=kind):
                put(self.package / "ordinary.dat", header + b"\x00" * 512)
                self.assertRefused("archive: ordinary.dat")

    def test_ordinary_text_is_not_an_archive(self):
        put(self.package / "ordinary.dat", b"PK is not a zip header\n")
        self.assertEqual(self.check(), [])


class HostileFileTests(GuardCase):
    def test_a_link_named_like_the_module_is_refused(self):
        (self.package / "signup" / "signup_flow.py").unlink()
        os.symlink(self.repository / "signup" / "signup_flow.py", self.package / "signup" / "signup_flow.py")
        self.assertRefused("link: signup/signup_flow.py")

    def test_a_link_to_a_server_copy_is_refused(self):
        os.symlink(self.repository / "apps" / "server" / "join" / "signup_flow.py", self.package / "signup" / "second.py")
        self.assertRefused("link: signup/second.py")

    def test_a_dangling_link_is_refused(self):
        os.symlink(self.scratch / "nothing", self.package / "dangling")
        self.assertRefused("link: dangling")

    def test_a_linked_folder_is_refused_and_not_followed(self):
        os.symlink(self.repository / "signup", self.package / "linked")
        problems = self.check()
        self.assertIn("link: linked", problems)
        self.assertFalse(any("linked/signup_flow.py" in line for line in problems), problems)

    def test_a_linked_package_root_is_refused(self):
        root = self.scratch / "root-link"
        os.symlink(self.package, root)
        problems = package_guard.check_package(root, self.repository)
        self.assertIn("package root is not a real folder", problems)

    def test_a_missing_package_root_is_refused(self):
        problems = package_guard.check_package(self.scratch / "absent", self.repository)
        self.assertIn("missing package folder", problems)

    def test_a_file_as_the_package_root_is_refused(self):
        put(self.scratch / "plain-file", b"x\n")
        problems = package_guard.check_package(self.scratch / "plain-file", self.repository)
        self.assertIn("package root is not a real folder", problems)

    def test_a_special_file_is_refused_without_being_opened(self):
        os.mkfifo(self.package / "pipe")
        completed = subprocess.run(
            [sys.executable, "-B", str(DEPLOY / "package_guard.py"), str(self.package)],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        self.assertIn("special file: pipe", completed.stdout)

    def test_a_socket_file_is_refused_in_process(self):
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        listener.bind(str(self.package / "signup" / "flow.sock"))
        self.assertRefused("special file: signup/flow.sock")


class ManifestAndRetirementTests(GuardCase):
    def manifest(self, name, document):
        path = self.scratch / name
        put(path, json.dumps(document).encode("utf-8"))
        return path

    def test_a_manifest_that_lists_a_public_digest_is_refused(self):
        public = package_guard.digest(self.repository / "mail" / "qd_jmap.py")
        document = json.loads((DEPLOY / "qd-web" / "package-manifest.json").read_text())
        document["files"]["qd_jmap.py"] = public
        path = self.manifest("manifest.json", document)
        problems = package_guard.check_manifest(path, self.repository)
        self.assertEqual(problems, ["public copy of qd_jmap.py listed in manifest.json"])

    def test_a_manifest_that_lists_the_server_digest_is_clean(self):
        server = package_guard.digest(self.repository / "apps" / "server" / "mail" / "qd_jmap.py")
        document = json.loads((DEPLOY / "qd-web" / "package-manifest.json").read_text())
        document["files"]["qd_jmap.py"] = server
        path = self.manifest("manifest.json", document)
        self.assertEqual(package_guard.check_manifest(path, self.repository), [])

    def test_a_manifest_that_is_missing_or_not_json_is_refused(self):
        self.assertTrue(package_guard.check_manifest(self.scratch / "absent.json", self.repository))
        put(self.scratch / "bad.json", b"not json\n")
        self.assertTrue(package_guard.check_manifest(self.scratch / "bad.json", self.repository))

    def test_equal_copies_are_reported_so_the_check_is_retired_with_them(self):
        put(self.repository / "apps" / "server" / "join" / "signup_flow.py", PUBLIC_FLOW)
        self.assertRefused("the server copy equals the public copy")

    def test_a_missing_server_copy_is_refused(self):
        (self.repository / "apps" / "server" / "join" / "signup_flow.py").unlink()
        put(self.package / "signup" / "signup_flow.py", PUBLIC_FLOW)
        self.assertRefused("missing server copy: signup_flow.py")

    def test_retirement_requires_explicit_removal_of_the_guarded_row(self):
        (self.repository / "apps" / "server" / "join" / "signup_flow.py").unlink()
        put(self.package / "signup" / "signup_flow.py", PUBLIC_FLOW)
        remaining = tuple(row for row in package_guard.GUARDED if row[0] != "signup_flow.py")
        with mock.patch.object(package_guard, "GUARDED", remaining):
            self.assertEqual(self.check(), [])

    def test_require_stops_the_build_with_a_refusal_for_each_problem(self):
        put(self.package / "signup" / "signup_flow.py", PUBLIC_FLOW)
        with self.assertRaises(SystemExit) as stopped:
            package_guard.require((self.package,), self.repository)
        self.assertEqual(stopped.exception.code, 1)

    def test_require_passes_a_clean_package(self):
        package_guard.require((self.package,), self.repository)


class ManifestDigestTests(GuardCase):
    manifest = ManifestAndRetirementTests.manifest

    def assert_digest_refused(self, document):
        path = self.manifest("manifest.json", document)
        problems = package_guard.check_manifest(path, self.repository)
        self.assertIn("public copy of qd_jmap.py listed in manifest.json", problems)

    def test_guarded_digest_in_a_json_key_is_refused(self):
        public = package_guard.digest(self.repository / "mail" / "qd_jmap.py")
        self.assert_digest_refused({public: "ordinary"})

    def test_guarded_digest_after_a_prefix_is_refused(self):
        public = package_guard.digest(self.repository / "mail" / "qd_jmap.py")
        self.assert_digest_refused({"files": {"ordinary": "sha256:prefix-" + public}})

    def test_uppercase_guarded_digest_is_refused(self):
        public = package_guard.digest(self.repository / "mail" / "qd_jmap.py")
        self.assert_digest_refused({"files": {"ordinary": public.upper()}})

    def test_prefixed_uppercase_guarded_digest_in_a_nested_key_is_refused(self):
        public = package_guard.digest(self.repository / "mail" / "qd_jmap.py")
        self.assert_digest_refused({"nested": [{"prefix-" + public.upper(): "ordinary"}]})

    def test_guarded_digest_inside_a_longer_hex_run_is_refused(self):
        public = package_guard.digest(self.repository / "mail" / "qd_jmap.py")
        self.assert_digest_refused({"files": {"ordinary": "deadbeef" + public + "cafe"}})


class ManifestSchemaTests(GuardCase):
    manifest = ManifestAndRetirementTests.manifest

    def document(self, service="qd-web"):
        return json.loads((DEPLOY / service / "package-manifest.json").read_text())

    def assert_schema_refused(self, document):
        path = self.manifest("manifest.json", document)
        self.assertIn("manifest schema refused: manifest.json", package_guard.check_manifest(path, self.repository))

    def validator(self, service):
        name = "package_plan.py" if service == "qd-web" else "packaging_plan.py"
        spec = importlib.util.spec_from_file_location("schema_under_test", REPOSITORY / "apps" / "server" / service / name)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_both_current_manifest_schemas_are_accepted(self):
        for service in ("qd-web", "captain-app"):
            self.assertEqual(package_guard.check_manifest(DEPLOY / service / "package-manifest.json", self.repository), [])

    def test_manifest_paths_cannot_select_the_other_service_schema(self):
        for service, other in (("qd-web", "captain-app"), ("captain-app", "qd-web")):
            path = self.scratch / service / "package-manifest.json"
            put(path, json.dumps(self.document(other)).encode())
            self.assertIn("manifest schema refused: package-manifest.json", package_guard.check_manifest(path, self.repository))

    def test_unknown_keys_are_refused_at_every_manifest_object(self):
        for service in ("qd-web", "captain-app"):
            for container in ("root", "bases", "files"):
                with self.subTest(service=service, container=container):
                    document = self.document(service)
                    target = document if container == "root" else document[container]
                    target["unknown-field"] = "a" * 64 if container == "files" else "ordinary"
                    self.assert_schema_refused(document)

    def test_declared_manifest_fields_reject_wrong_types(self):
        for service in ("qd-web", "captain-app"):
            for key, value in (("format", True), ("format", "1"), ("bases", []), ("files", [])):
                with self.subTest(service=service, key=key, kind=type(value).__name__):
                    document = self.document(service)
                    document[key] = value
                    self.assert_schema_refused(document)
            document = self.document(service)
            first = next(iter(document["files"]))
            document["files"][first] = ["a" * 64]
            self.assert_schema_refused(document)

    def test_app_record_list_is_refused(self):
        document = self.document()
        document["bases"]["appRecord"] = ["a" * 64]
        self.assert_schema_refused(document)

    def test_uppercase_app_record_is_refused(self):
        document = self.document()
        document["bases"]["appRecord"] = "A" * 64
        self.assert_schema_refused(document)

    def test_short_app_record_is_refused(self):
        document = self.document()
        document["bases"]["appRecord"] = "a" * 63
        self.assert_schema_refused(document)

    def test_service_verifier_rejects_each_bad_app_record(self):
        module = self.validator("qd-web")
        for value in (["a" * 64], "A" * 64, "a" * 63):
            with self.subTest(kind=type(value).__name__):
                document = self.document()
                expected = document["files"].copy()
                document["bases"]["appRecord"] = value
                path = self.manifest("manifest.json", document)
                with mock.patch.object(module, "_digest", side_effect=lambda path: expected[path.name]):
                    with self.assertRaises(module.PackageRefused):
                        module.verify_manifest(path)

    def test_both_service_verifiers_reject_boolean_format(self):
        for service in ("qd-web", "captain-app"):
            module = self.validator(service)
            document = self.document(service)
            expected = document["files"].copy()
            document["format"] = True
            path = self.manifest("manifest.json", document)
            with mock.patch.object(module, "_digest", side_effect=lambda path: expected[path.name]):
                with self.assertRaises(module.PackageRefused):
                    module.verify_manifest(path)


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="qd-package-guard-cli-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)

    def run_guard(self, *arguments):
        return subprocess.run(
            [sys.executable, "-B", str(DEPLOY / "package_guard.py"), *arguments],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_the_server_copies_of_the_repository_pass(self):
        package = self.scratch / "package"
        shutil.copyfile(REPOSITORY / "apps" / "server" / "join" / "signup_flow.py", package_path(package / "signup" / "signup_flow.py"))
        shutil.copyfile(REPOSITORY / "apps" / "server" / "mail" / "qd_jmap.py", package_path(package / "qd-mail-stalwart" / "qd_jmap.py"))
        completed = self.run_guard(str(package))
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("package guard: clean", completed.stdout)

    def test_the_public_copies_of_the_repository_are_refused(self):
        package = self.scratch / "package"
        shutil.copyfile(REPOSITORY / "signup" / "signup_flow.py", package_path(package / "signup" / "signup_flow.py"))
        shutil.copyfile(REPOSITORY / "mail" / "qd_jmap.py", package_path(package / "qd-mail-stalwart" / "qd_jmap.py"))
        completed = self.run_guard(str(package))
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        self.assertIn("public copy of signup_flow.py", completed.stdout)
        self.assertIn("public copy of qd_jmap.py", completed.stdout)

    def test_no_argument_is_a_usage_error(self):
        self.assertEqual(self.run_guard().returncode, 2)


def package_path(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


class LaneBuildTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="qd-package-guard-lane-"))
        self.addCleanup(shutil.rmtree, self.scratch, True)

    def test_the_lane_packages_hold_the_server_copies(self):
        root = server_lane.assemble(self.scratch / "tree")
        server_flow = package_guard.digest(REPOSITORY / "apps" / "server" / "join" / "signup_flow.py")
        server_jmap = package_guard.digest(REPOSITORY / "apps" / "server" / "mail" / "qd_jmap.py")
        self.assertEqual(package_guard.digest(root / "app" / "signup" / "signup_flow.py"), server_flow)
        self.assertEqual(package_guard.digest(root / "approval-qd" / "package" / "signup" / "signup_flow.py"), server_flow)
        self.assertEqual(package_guard.digest(root / "app" / "qd-mail-stalwart" / "qd_jmap.py"), server_jmap)
        self.assertEqual(package_guard.digest(root / "qd-web" / "qd-web" / "qd_jmap.py"), server_jmap)

    def test_the_repository_package_manifests_list_no_public_copy(self):
        for manifest in server_lane.PACKAGE_MANIFESTS:
            with self.subTest(manifest=manifest.parent.name):
                self.assertEqual(package_guard.check_manifest(manifest, REPOSITORY), [])

    def test_the_lane_build_fails_when_the_join_copy_is_not_overlaid(self):
        without = tuple(name for name in server_lane.JOIN_SIGNUP_FILES if name != "signup_flow.py")
        with mock.patch.object(server_lane, "JOIN_SIGNUP_FILES", without):
            with self.assertRaises(SystemExit):
                server_lane.assemble(self.scratch / "tree")

    def test_the_lane_build_fails_when_a_package_takes_the_public_signup_flow(self):
        public = REPOSITORY / "signup" / "signup_flow.py"
        files = tuple(
            (public if name == "package/signup/signup_flow.py" else source, name)
            for source, name in server_lane.QD_PACKAGE_FILES
        )
        with mock.patch.object(server_lane, "QD_PACKAGE_FILES", files):
            with self.assertRaises(SystemExit):
                server_lane.assemble(self.scratch / "tree")

    def test_the_lane_build_fails_when_the_web_package_takes_the_public_qd_jmap(self):
        public = REPOSITORY / "mail" / "qd_jmap.py"
        shared = tuple((public if name == "qd_jmap.py" else source, name) for source, name in server_lane.QD_WEB_SHARED)
        with mock.patch.object(server_lane, "QD_WEB_SHARED", shared):
            with self.assertRaises(SystemExit):
                server_lane.assemble(self.scratch / "tree")


if __name__ == "__main__":
    unittest.main()
