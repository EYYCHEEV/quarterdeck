from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any


SERVICE_USER = "2700:2700"
AUTH_GROUP = "2711"
SHIPPED_FILES = frozenset(
    {
        "README.md",
        "THIRD_PARTY_NOTICES.md",
        "application.py",
        "approval_app.py",
        "approval_security.py",
        "auth_bridge.py",
        "bot_list.py",
        "bundle.py",
        "cards.py",
        "chat_api.py",
        "checker_adapter.py",
        "compose-fragment.json",
        "door_policy.py",
        "invite_prompt.py",
        "live.py",
        "mail_gateway.py",
        "mailstate.py",
        "mounts.py",
        "package_plan.py",
        "qd_cards.py",
        "qd_jmap.py",
        "runtime-config.template.json",
        "security.py",
        "server.py",
        "webapp.py",
    }
)
OPTIONAL_FILES = frozenset({"mail_api.py"})
VOLUMES = (
    "${QD_PACKAGE}/qd-web:/opt/quarterdeck/qd-web:ro",
    "${QD_ROOT}/qd-web-config:/etc/quarterdeck-qd-web:ro",
    "${QD_ROOT}/secrets/captain-mail-key:/run/quarterdeck-captain-mail:ro",
    "${QD_ROOT}/volumes/captain-state:/var/lib/quarterdeck-captain:ro",
    "${QD_ROOT}/volumes/qd-web-state:/var/lib/quarterdeck-qd-web:rw",
    "${QD_ROOT}/volumes/qd-auth:/run/quarterdeck-qd-auth:ro",
)
COMMAND = [
    "python3",
    "/opt/quarterdeck/qd-web/server.py",
    "--config",
    "/etc/quarterdeck-qd-web/runtime.json",
]
ENVIRONMENT = {
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUNBUFFERED": "1",
    "PYTHONPATH": "/opt/quarterdeck/qd-web",
}
EXCEPTIONS = [
    {
        "service": "qd-web",
        "sharesUserWith": "captain-app",
        "user": SERVICE_USER,
        "reason": "the mailbox key reader accepts only a key owned by the running user",
    }
]
FORBIDDEN_TEXT = (
    "docker.sock",
    "approval-secrets",
    "quarterdeck-admin",
    "qd-approval",
    "google",
    "oidc",
)
FORBIDDEN_KEYS = frozenset(
    {
        "ports",
        "network_mode",
        "privileged",
        "pid",
        "ipc",
        "devices",
        "cap_add",
        "sysctls",
        "userns_mode",
        "extra_hosts",
        "dns",
    }
)


class PackageRefused(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PackageRefused(f"qd-web package refused: {message}")


def validate_fragment(document: dict[str, Any]) -> None:
    _require(
        isinstance(document, dict)
        and set(document) == {"format", "service", "exceptions"}
        and document.get("format") == 1
        and document.get("exceptions") == EXCEPTIONS,
        "fragment shape",
    )
    service = document["service"]
    _require(
        isinstance(service, dict)
        and set(service) == {"name", "imageFromService", "definition"}
        and service.get("name") == "qd-web"
        and service.get("imageFromService") == "approval"
        and isinstance(service.get("definition"), dict),
        "service shape",
    )
    definition = service["definition"]
    _require(definition.get("user") == SERVICE_USER, "service user")
    _require(definition.get("group_add") == [AUTH_GROUP], "auth socket group")
    _require(definition.get("read_only") is True, "read-only root")
    _require(definition.get("cap_drop") == ["ALL"], "dropped capabilities")
    _require(
        definition.get("security_opt") == ["no-new-privileges:true"],
        "no new privileges",
    )
    _require(definition.get("init") is True, "init process")
    _require(definition.get("networks") == {"service": {}}, "private service network")
    _require(not FORBIDDEN_KEYS & set(definition), "no published port or host access")
    _require(definition.get("working_dir") == "/opt/quarterdeck/qd-web", "working folder")
    _require(definition.get("command") == COMMAND, "command")
    _require(definition.get("environment") == ENVIRONMENT, "environment")
    _require(list(definition.get("volumes", [])) == list(VOLUMES), "exact mounts")
    _require(
        [entry for entry in VOLUMES if entry.endswith(":rw")]
        == ["${QD_ROOT}/volumes/qd-web-state:/var/lib/quarterdeck-qd-web:rw"],
        "one writable mount",
    )
    _require(definition.get("pids_limit") == 96, "process bound")
    _require(
        definition.get("mem_limit") == definition.get("memswap_limit") == "384m",
        "memory bound",
    )
    _require(definition.get("cpus") == "0.75", "CPU bound")
    _require(
        definition.get("ulimits") == {"nofile": {"soft": 1024, "hard": 1024}},
        "file bound",
    )
    tmpfs = definition.get("tmpfs")
    _require(
        isinstance(tmpfs, list)
        and tmpfs
        and all(
            all(flag in entry for flag in ("nosuid", "nodev", "noexec"))
            for entry in tmpfs
        ),
        "safe temporary files",
    )
    _require(definition.get("restart") == "unless-stopped", "restart policy")
    serialized = json.dumps(document, sort_keys=True).lower()
    for text in FORBIDDEN_TEXT:
        _require(text not in serialized, f"no {text}")


def _digest(path: Path) -> str:
    metadata = path.stat(follow_symlinks=False)
    _require(
        stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1,
        f"manifest file {path.name}",
    )
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest_document(document: Any) -> None:
    _require(
        isinstance(document, dict)
        and set(document) == {"format", "bases", "files"}
        and type(document.get("format")) is int
        and document["format"] == 1
        and isinstance(document.get("bases"), dict)
        and set(document["bases"]) == {"appRecord"}
        and isinstance(document["bases"]["appRecord"], str)
        and re.fullmatch(r"[0-9a-f]{64}", document["bases"]["appRecord"]) is not None
        and isinstance(document.get("files"), dict)
        and SHIPPED_FILES <= set(document["files"]) <= SHIPPED_FILES | OPTIONAL_FILES
        and all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None for value in document["files"].values()),
        "manifest shape",
    )


def verify_manifest(path: Path) -> None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PackageRefused("qd-web package refused: manifest unavailable") from None
    validate_manifest_document(document)
    for name, expected in document["files"].items():
        _require(_digest(path.parent / name) == expected, f"manifest hash {name}")


def write_new(path: Path, content: bytes) -> None:
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
        )
    except OSError:
        raise PackageRefused("qd-web package refused: output is unavailable") from None
    try:
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise PackageRefused("qd-web package refused: output write stalled")
            offset += written
        os.fsync(descriptor)
    except OSError:
        raise PackageRefused("qd-web package refused: output write failed") from None
    finally:
        os.close(descriptor)


def render_manifest(folder: Path, app_record: Path) -> bytes:
    present = {
        name
        for name in SHIPPED_FILES | OPTIONAL_FILES
        if (folder / name).exists() or (folder / name).is_symlink()
    }
    _require(SHIPPED_FILES <= present, "shipped files are missing")
    document = {
        "format": 1,
        "bases": {"appRecord": _digest(app_record)},
        "files": {name: _digest(folder / name) for name in sorted(present)},
    }
    return (json.dumps(document, indent=2) + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="qd-web-package")
    parser.add_argument("--folder", required=True)
    parser.add_argument("--app-record", required=True)
    parser.add_argument("--write")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args(argv)
    folder = Path(args.folder)
    if args.write:
        write_new(Path(args.write), render_manifest(folder, Path(args.app_record)))
    if args.verify:
        verify_manifest(folder / "package-manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
