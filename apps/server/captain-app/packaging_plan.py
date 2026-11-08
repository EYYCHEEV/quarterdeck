from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any


COMPOSE_BASE_SHA256 = "be691bfa8a494db59d68a9b061e54c5a1ac344c3cf3d072e8d3c310a8ef7d781"
DOOR_BASE_SHA256 = "68268d758de155bcdab2800a3bee179e645dd98426604d2916d5010ee1aaeb1b"
BASE_SERVICES = {
    "caddy",
    "stalwart",
    "join",
    "helper",
    "approval",
    "captain-app",
}
ROUTES = [
    {
        "matcher": "captain_chat_page",
        "methods": ["GET"],
        "paths": [
            "/captain/chat",
            "/captain/assets/chat.css",
            "/captain/assets/chat.js",
        ],
    },
    {
        "matcher": "captain_chat_list",
        "methods": ["GET"],
        "paths": ["/captain/api/chats"],
    },
    {
        "matcher": "captain_chat_thread",
        "methods": ["GET", "POST"],
        "paths": ["/captain/api/chat"],
        "maxBody": "16KB",
    },
    {
        "matcher": "captain_chat_events",
        "methods": ["GET"],
        "paths": ["/captain/events"],
    },
]
SHIPPED_FILES = {
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "application.py",
    "auth_bridge.py",
    "captain_auth.py",
    "cards.py",
    "chat.css",
    "chat.html",
    "chat.js",
    "chat_bot_list.py",
    "checker_adapter.py",
    "compose-diff.json",
    "door-policy.diff.json",
    "live.py",
    "mail_gateway.py",
    "packaging_plan.py",
    "runtime-config.template.json",
    "security.py",
    "server.py",
}


class PackageRefused(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PackageRefused(f"Captain package refused: {message}")


def render_compose_diff(
    base: dict[str, Any],
    diff: dict[str, Any],
) -> dict[str, Any]:
    _require(
        isinstance(base, dict)
        and isinstance(base.get("services"), dict)
        and set(base["services"]) == BASE_SERVICES,
        "compose baseline",
    )
    _require(
        isinstance(diff, dict)
        and set(diff) == {
            "format",
            "baseSha256",
            "integratedService",
            "integratedApproval",
        }
        and diff.get("format") == 2
        and diff.get("baseSha256") == COMPOSE_BASE_SHA256,
        "compose reconciliation header",
    )
    integration = diff["integratedService"]
    approval_integration = diff["integratedApproval"]
    _require(
        isinstance(integration, dict)
        and set(integration) == {
            "name",
            "imageFromService",
            "definition",
        }
        and integration.get("name") == "captain-app"
        and integration.get("imageFromService") == "approval"
        and isinstance(integration.get("definition"), dict),
        "integrated Captain service",
    )
    _require(
        approval_integration
        == {
            "name": "approval",
            "groupAdd": "2701",
            "authVolume": "${QD_ROOT}/volumes/captain-auth:/run/quarterdeck-captain-auth:rw",
            "sourceVolume": "${QD_PACKAGE}/captain-app:/opt/quarterdeck/captain-app:ro",
            "pythonPathPrefix": "/opt/quarterdeck/captain-app",
        },
        "integrated approval sign-in owner",
    )
    rendered = copy.deepcopy(base)
    expected_captain = copy.deepcopy(integration["definition"])
    expected_captain["image"] = rendered["services"]["approval"]["image"]
    _require(
        rendered["services"]["captain-app"] == expected_captain,
        "current Captain service",
    )
    approval = rendered["services"]["approval"]
    python_paths = approval.get("environment", {}).get(
        "PYTHONPATH",
        "",
    ).split(":")
    _require(
        approval.get("group_add", []).count(
            approval_integration["groupAdd"]
        )
        == 1
        and approval.get("volumes", []).count(
            approval_integration["authVolume"]
        )
        == 1
        and approval.get("volumes", []).count(
            approval_integration["sourceVolume"]
        )
        == 1
        and python_paths
        and python_paths[0] == approval_integration["pythonPathPrefix"]
        and python_paths.count(
            approval_integration["pythonPathPrefix"]
        )
        == 1,
        "current approval integration",
    )
    validate_compose(rendered)
    return rendered


def _targets(service: dict[str, Any]) -> set[str]:
    targets = set()
    for volume in service.get("volumes", []):
        _require(
            isinstance(volume, str) and volume.count(":") >= 2,
            "volume declaration",
        )
        _, target, mode = volume.rsplit(":", 2)
        _require(target.startswith("/") and mode in {"ro", "rw"}, "volume target")
        targets.add(target)
    return targets


def validate_compose(document: dict[str, Any]) -> None:
    services = document.get("services")
    _require(
        isinstance(services, dict)
        and set(services) == BASE_SERVICES,
        "six services",
    )
    captain = services["captain-app"]
    _require(captain.get("image") == services["approval"].get("image"), "pinned Python image source")
    _require(captain.get("user") == "2700:2700", "Captain service user")
    _require(captain.get("group_add") == ["2701"], "Captain auth group")
    _require(captain.get("read_only") is True, "read-only root")
    _require(captain.get("cap_drop") == ["ALL"], "dropped capabilities")
    _require("no-new-privileges:true" in captain.get("security_opt", []), "no new privileges")
    _require(captain.get("networks") == {"service": {}}, "private service network")
    _require("ports" not in captain, "no Captain port")
    _require(captain.get("pids_limit") == 96, "process bound")
    _require(captain.get("mem_limit") == captain.get("memswap_limit") == "384m", "memory bound")
    _require(captain.get("cpus") == "0.75", "CPU bound")
    _require(
        captain.get("ulimits", {}).get("nofile") == {"soft": 1024, "hard": 1024},
        "file bound",
    )
    _require(
        all(
            all(flag in entry for flag in ("nosuid", "nodev", "noexec"))
            for entry in captain.get("tmpfs", [])
        ),
        "safe temporary files",
    )
    serialized = {
        name: json.dumps(service, sort_keys=True)
        for name, service in services.items()
    }
    _require(
        [name for name, value in serialized.items() if "captain-mail-key" in value]
        == ["captain-app"],
        "single Captain key owner",
    )
    _require("approval-secrets" not in serialized["captain-app"], "no approval secrets")
    _require("quarterdeck-admin" not in serialized["captain-app"], "no administrator credential")
    _require("docker.sock" not in serialized["captain-app"], "no Docker socket")
    captain_targets = _targets(captain)
    approval_targets = _targets(services["approval"])
    _require(
        "/run/quarterdeck-captain-mail" in captain_targets
        and "/run/quarterdeck-captain-auth" in captain_targets & approval_targets,
        "isolated key and shared auth socket",
    )
    _require(
        services["approval"].get("group_add") == ["2501", "2701"],
        "approval auth group",
    )
    _require(
        "/opt/quarterdeck/captain-app" in approval_targets
        and services["approval"]
        .get("environment", {})
        .get("PYTHONPATH", "")
        .startswith("/opt/quarterdeck/captain-app:"),
        "approval imports Captain sign-in owner",
    )
    for name, service in services.items():
        if name != "caddy":
            _require("ports" not in service, f"private {name}")


def render_door_diff(
    base: dict[str, Any],
    diff: dict[str, Any],
) -> str:
    _require(
        isinstance(base, dict)
        and isinstance(base.get("frontProxy", {}).get("routes"), list)
        and len(base["frontProxy"]["routes"]) == 20,
        "door baseline",
    )
    _require(
        diff
        == {
            "format": 1,
            "baseSha256": DOOR_BASE_SHA256,
            "upstream": "captain-app:8080",
            "routes": ROUTES,
        },
        "door diff",
    )
    lines = ["# Quarterdeck chat-first route diff"]
    for route in ROUTES:
        lines.extend(
            [
                f"@{route['matcher']} {{",
                f"    method {' '.join(route['methods'])}",
                f"    path {' '.join(route['paths'])}",
                "}",
                f"handle @{route['matcher']} {{",
            ]
        )
        if "maxBody" in route:
            lines.extend(
                [
                    "    request_body {",
                    f"        max_size {route['maxBody']}",
                    "    }",
                ]
            )
        lines.extend(
            [
                "    reverse_proxy captain-app:8080 {",
                "        header_up X-Forwarded-For {remote_host}",
                "        header_up X-Forwarded-Proto https",
                "        header_up X-Forwarded-Host {host}",
                "    }",
                "}",
                "",
            ]
        )
    rendered = "\n".join(lines)
    validate_caddy_fragment(rendered)
    return rendered


def validate_caddy_fragment(fragment: str) -> None:
    _require(isinstance(fragment, str), "Caddy fragment type")
    _require(
        fragment.count("reverse_proxy captain-app:8080") == len(ROUTES),
        "exact upstream route count",
    )
    _require(
        "path /*" not in fragment
        and re.search(r":80(?![0-9])", fragment) is None,
        "bounded HTTPS routes",
    )
    _require(
        fragment.count("header_up X-Forwarded-For {remote_host}") == len(ROUTES),
        "real caller forwarding",
    )
    for route in ROUTES:
        _require(f"@{route['matcher']} {{" in fragment, f"matcher {route['matcher']}")
        for path in route["paths"]:
            _require(path in fragment, f"path {path}")
    matchers = set(re.findall(r"(?m)^@([a-z_]+) \{$", fragment))
    _require(matchers == {route["matcher"] for route in ROUTES}, "exact route set")


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
        and document.get("bases")
        == {
            "compose": COMPOSE_BASE_SHA256,
            "doorPolicy": DOOR_BASE_SHA256,
        }
        and isinstance(document.get("files"), dict)
        and set(document["files"]) == SHIPPED_FILES
        and all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None for value in document["files"].values()),
        "manifest shape",
    )


def verify_manifest(path: Path) -> None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PackageRefused("Captain package refused: manifest unavailable") from None
    validate_manifest_document(document)
    for name, expected in document["files"].items():
        _require(_digest(path.parent / name) == expected, f"manifest hash {name}")


def write_new(path: Path, content: bytes) -> None:
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
    except OSError:
        raise PackageRefused(
            "Captain package refused: output is unavailable"
        ) from None
    try:
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise PackageRefused(
                    "Captain package refused: output write stalled"
                )
            offset += written
        os.fsync(descriptor)
    except OSError:
        raise PackageRefused(
            "Captain package refused: output write failed"
        ) from None
    finally:
        os.close(descriptor)
