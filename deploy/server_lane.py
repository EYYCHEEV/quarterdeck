import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import package_guard

REPOSITORY = Path(__file__).resolve().parents[1]
SERVER = REPOSITORY / "apps" / "server"
DEPLOY = REPOSITORY / "deploy"
NOTICES = REPOSITORY / "THIRD_PARTY_NOTICES.md"
PACKAGE_MANIFESTS = (
    DEPLOY / "qd-web" / "package-manifest.json",
    DEPLOY / "captain-app" / "package-manifest.json",
)

QD_WEB_SHARED = (
    (SERVER / "approval" / "approval_app.py", "approval_app.py"),
    (SERVER / "approval" / "approval_security.py", "approval_security.py"),
    (SERVER / "captain-app" / "auth_bridge.py", "auth_bridge.py"),
    (SERVER / "door" / "door_policy.py", "door_policy.py"),
    (SERVER / "shared" / "invite_prompt.py", "invite_prompt.py"),
    (SERVER / "cards" / "qd_cards.py", "qd_cards.py"),
    (SERVER / "mail" / "qd_jmap.py", "qd_jmap.py"),
)

APP_FOLDERS = (
    ("captain-app", (SERVER / "captain-app", DEPLOY / "captain-app")),
    ("golive/approval", (SERVER / "approval", DEPLOY / "approval")),
    ("golive/shared", (SERVER / "shared",)),
    ("golive/door", (SERVER / "door",)),
    ("golive/containers", (DEPLOY / "containers",)),
    ("golive/first_start", (DEPLOY / "first_start",)),
    ("golive/helper", (SERVER / "helper", DEPLOY / "helper")),
    ("golive/connect", (REPOSITORY / "golive" / "connect",)),
    ("golive/integration", (SERVER / "tests",)),
    ("qd-cards", (SERVER / "cards",)),
    ("signup", (REPOSITORY / "signup",)),
    ("qd-mail-stalwart", (REPOSITORY / "mail",)),
)

JOIN_SIGNUP_FILES = ("approval_service.py", "test_list_bots.py", "signup_flow.py")

QD_PACKAGE_FILES = (
    (SERVER / "captain-app" / "captain_auth.py", "package/captain-app/captain_auth.py"),
    (SERVER / "shared" / "invite_prompt.py", "package/golive/shared/invite_prompt.py"),
    (SERVER / "join" / "approval_service.py", "package/signup/approval_service.py"),
    (REPOSITORY / "signup" / "helper_contract.py", "package/signup/helper_contract.py"),
    (SERVER / "join" / "signup_flow.py", "package/signup/signup_flow.py"),
)

QD_TEMPLATE_FILES = (
    (DEPLOY / "approval-qd" / "compose.approval-qd.json", "compose.approval-qd.json"),
    (DEPLOY / "approval-qd" / "runtime-qd.template.json", "runtime-qd.template.json"),
)

SKIP_NAMES = {"__pycache__"}


def copy_directory(source, destination, skip_directories=()):
    destination.mkdir(parents=True, exist_ok=True)
    for entry in sorted(source.iterdir()):
        if entry.name in SKIP_NAMES or entry.name in skip_directories:
            continue
        target = destination / entry.name
        if entry.is_dir():
            copy_directory(entry, target)
        elif entry.is_file() and not entry.is_symlink():
            shutil.copyfile(entry, target)


def copy_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def assemble_qd_web(root):
    package = root / "qd-web"
    copy_directory(SERVER / "qd-web", package, skip_directories=("tests",))
    for source, name in QD_WEB_SHARED:
        copy_file(source, package / name)
    copy_directory(DEPLOY / "qd-web", package)
    if NOTICES.is_file():
        copy_file(NOTICES, package / "THIRD_PARTY_NOTICES.md")
    tests = SERVER / "qd-web" / "tests"
    copy_directory(tests, root / "tests")
    for name in ("mail_standins.py", "test_mail_api.py"):
        shutil.move(root / "tests" / name, root / name)


def assemble_app(root):
    for name, sources in APP_FOLDERS:
        for source in sources:
            copy_directory(source, root / name)
    for source in sorted((SERVER / "join").iterdir()):
        if not source.is_file():
            continue
        folder = "signup" if source.name in JOIN_SIGNUP_FILES else "golive/connect"
        copy_file(source, root / folder / source.name)
    copy_file(SERVER / "mail" / "qd_jmap.py", root / "qd-mail-stalwart" / "qd_jmap.py")
    copy_file(REPOSITORY / ".github" / "workflows" / "release.yml", root / ".github" / "workflows" / "release.yml")
    copy_file(REPOSITORY / "docs" / "internals" / "server-captain-app.md", root / "captain-app" / "README.md")
    if NOTICES.is_file():
        copy_file(NOTICES, root / "captain-app" / "THIRD_PARTY_NOTICES.md")


def assemble_approval_qd(root, app_root):
    for name in sorted(path.name for path in (SERVER / "approval-qd").iterdir() if path.is_file()):
        copy_file(SERVER / "approval-qd" / name, root / name)
    for source, name in QD_TEMPLATE_FILES:
        copy_file(source, root / name)
    for source, name in QD_PACKAGE_FILES:
        copy_file(source, root / name)
    copy_directory(SERVER / "approval", root / "package" / "golive" / "approval")
    copy_file(
        DEPLOY / "approval-qd" / "runtime-qd.template.json",
        root / "package" / "golive" / "approval" / "runtime-qd.template.json",
    )
    (root / "tmp").mkdir(exist_ok=True)


def assemble(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    assemble_qd_web(destination / "qd-web")
    assemble_app(destination / "app")
    assemble_approval_qd(destination / "approval-qd", destination / "app")
    package_guard.require(
        (destination / "qd-web" / "qd-web", destination / "app", destination / "approval-qd" / "package"),
        REPOSITORY,
        PACKAGE_MANIFESTS,
    )
    return destination


def suites(root):
    qd_web = root / "qd-web"
    app = root / "app"
    approval_qd = root / "approval-qd"

    def paths(base, *names):
        return ":".join(str(base / name) for name in names)

    discover = ["discover", "-s", ".", "-p", "test_*.py"]
    return {
        "qd-web": (qd_web, paths(qd_web, "qd-web", "."), ["discover", "-s", "tests", "-p", "test_*.py"]),
        "qd-web-mail": (qd_web, paths(qd_web, "qd-web", "."), ["test_mail_api"]),
        "captain-app": (
            app / "captain-app",
            paths(app, "captain-app", "qd-cards", "qd-mail-stalwart", "golive/approval", "golive/shared", "golive/door"),
            discover,
        ),
        "approval": (
            app / "golive" / "approval",
            paths(app, "golive/approval", "signup", "golive/shared", "captain-app", "qd-cards", "qd-mail-stalwart", "golive/door"),
            discover,
        ),
        "join": (
            app / "golive" / "connect",
            paths(app, "golive/connect", "signup", "qd-mail-stalwart", "golive/shared", "golive/helper", "golive/door", "captain-app"),
            discover,
        ),
        "signup-server": (
            app / "signup",
            paths(app, "signup"),
            ["test_list_bots"],
        ),
        "helper": (
            app / "golive" / "helper",
            paths(app, "golive/helper", "signup", "qd-mail-stalwart", "captain-app", "golive/door"),
            discover,
        ),
        "first-start": (
            app / "golive" / "first_start",
            paths(app, "golive/first_start", "golive/containers", "golive/door", "golive/helper"),
            discover,
        ),
        "containers": (
            app / "golive" / "containers",
            paths(app, "golive/containers", "signup"),
            discover,
        ),
        "door": (app / "golive" / "door", paths(app, "golive/door"), discover),
        "shared": (app / "golive" / "shared", paths(app, "golive/shared"), discover),
        "integration": (
            app / "golive" / "integration",
            paths(app, "golive/integration", "signup", "golive/approval", "captain-app"),
            discover,
        ),
        "approval-qd": (
            approval_qd,
            "",
            ["test_approval_qd", "test_deployment_qd", "test_origin_pin_fix1", "test_origin_pin_unset", "test_runtime_qd"],
        ),
        "api-mail-v1": (SERVER / "api" / "mail-v1", paths(qd_web, "qd-web", "."), discover),
        "package-guard": (DEPLOY, str(DEPLOY), ["test_package_guard"]),
    }


def environment(pythonpath, extra):
    allowed = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/nonexistent")}
    allowed["PYTHONDONTWRITEBYTECODE"] = "1"
    allowed["PYTHONHASHSEED"] = "0"
    if pythonpath:
        allowed["PYTHONPATH"] = pythonpath
    allowed.update(extra)
    return allowed


def run_suite(name, cwd, pythonpath, arguments, extra):
    result = subprocess.run(
        [sys.executable, "-B", "-m", "unittest", *arguments],
        cwd=cwd,
        env=environment(pythonpath, extra),
        capture_output=True,
        text=True,
    )
    combined = result.stdout + "\n" + result.stderr
    ran = re.findall(r"^Ran (\d+) tests? in", combined, re.M)
    verdict = re.findall(r"^(OK.*|FAILED.*)$", combined, re.M)
    print(name, "exit", result.returncode, "ran", ran[-1] if ran else "none", verdict[-1] if verdict else "no verdict", flush=True)
    failing = dict.fromkeys(re.findall(r"^(?:FAIL|ERROR): \S+ \(([\w.]+)\)", combined, re.M))
    for identifier in failing:
        print("  failing", identifier, flush=True)
    return result.returncode, combined


def run_all(root, args):
    table = suites(root)
    chosen = args.names or list(table)
    unknown = [name for name in chosen if name not in table]
    if unknown:
        print("unknown suite", ", ".join(unknown), file=sys.stderr)
        return 2
    extra = {
        "QD_SAMPLES": str(SERVER / "api" / "chat-v2" / "samples"),
        "QD_WEB": str(root / "qd-web"),
    }
    failed = 0
    for name in chosen:
        cwd, pythonpath, arguments = table[name]
        code, output = run_suite(name, cwd, pythonpath, arguments, extra)
        if args.log_directory:
            Path(args.log_directory).mkdir(parents=True, exist_ok=True)
            (Path(args.log_directory) / (name + ".log")).write_text(output, encoding="utf-8")
        if code:
            failed += 1
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--assemble-only", metavar="DIR")
    parser.add_argument("--tree", metavar="DIR")
    parser.add_argument("--log-directory", metavar="DIR")
    parser.add_argument("names", nargs="*")
    args = parser.parse_args(argv)
    if args.assemble_only:
        print(assemble(args.assemble_only))
        return 0
    if shutil.which("node", path=environment("", {})["PATH"]) is None:
        print("missing node: captain-app test_chat_bubbles, test_chat_chime, test_chat_page, test_chat_windowing require it")
        return 1
    if args.tree:
        return run_all(Path(args.tree), args)
    with tempfile.TemporaryDirectory(prefix="qd-server-lane-") as scratch:
        return run_all(assemble(Path(scratch) / "tree"), args)


if __name__ == "__main__":
    sys.exit(main())
