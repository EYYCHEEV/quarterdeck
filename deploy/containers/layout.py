from __future__ import annotations

import copy
import ipaddress
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


IMAGE_KEYS = {"stalwart-source", "python-source", "caddy-source", "stalwart-runtime"}
RUNTIME_COPY_PATHS = {
    "door/door-policy.json",
    "door/door_policy.py",
    "first_start/bootstrap_launcher.py",
    "first_start/first_start.py",
    "first_start/normal_launcher.py",
    "first_start/password_file.py",
    "first_start/recovery_launcher.py",
}
DIGEST_REFERENCE = re.compile(r"^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:([0-9a-f]{64})$")
IMAGE_TOKEN = re.compile(r"^\$\{image:([a-z0-9-]+)\}$")
DEPLOYMENT_TOKEN = re.compile(r"^\$\{deployment:([a-z-]+)\}$")
HELPER_TOKEN = re.compile(r"^\$\{helper:([a-z-]+)\}$")
UNRESOLVED_TOKEN = re.compile(r"\$\{([^{}]+)\}")


class LayoutError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise LayoutError(f"unsafe container layout: {message}")


def validate_manifest(manifest: dict[str, Any]) -> dict[str, str]:
    _require(manifest.get("format") == 1, "image manifest format")
    images = manifest.get("images")
    _require(isinstance(images, dict) and set(images) == IMAGE_KEYS, "image manifest entries")
    expected = {
        "stalwart-source": ("docker.io/stalwartlabs/stalwart", "v1.0.1"),
        "python-source": ("docker.io/library/python", "3.14.0-slim-trixie"),
        "caddy-source": ("docker.io/library/caddy", "2.11.7-alpine"),
        "stalwart-runtime": ("local/quarterdeck-stalwart", "v1"),
    }
    result: dict[str, str] = {}
    for name, (repository, version) in expected.items():
        entry = images[name]
        _require(isinstance(entry, dict), f"image entry {name}")
        _require(entry.get("repository") == repository, f"image repository {name}")
        _require(entry.get("version") == version, f"image version {name}")
        reference = entry.get("reference")
        _require(isinstance(reference, str), f"unset image digest {name}")
        match = DIGEST_REFERENCE.fullmatch(reference)
        _require(match is not None and set(match.group(1)) != {"0"}, f"immutable image digest {name}")
        if name != "stalwart-runtime":
            _require(reference.startswith(repository + "@sha256:"), f"source image repository {name}")
        result[name] = reference

    runtime = images["stalwart-runtime"]
    _require(
        set(runtime)
        == {
            "repository",
            "version",
            "reference",
            "configDigest",
            "diffIds",
            "copySha256",
        },
        "runtime image identity fields",
    )
    _require(
        runtime["reference"].startswith("sha256:"),
        "runtime image manifest reference",
    )
    config_digest = runtime["configDigest"]
    config_match = (
        DIGEST_REFERENCE.fullmatch(config_digest)
        if isinstance(config_digest, str)
        else None
    )
    _require(
        config_match is not None
        and config_digest.startswith("sha256:")
        and set(config_match.group(1)) != {"0"},
        "runtime image config digest",
    )
    diff_ids = runtime["diffIds"]
    _require(
        isinstance(diff_ids, list)
        and len(diff_ids) == 15
        and len(set(diff_ids)) == 15
        and all(
            isinstance(value, str)
            and DIGEST_REFERENCE.fullmatch(value) is not None
            for value in diff_ids
        ),
        "runtime image diff ids",
    )
    copy_hashes = runtime["copySha256"]
    _require(
        isinstance(copy_hashes, dict)
        and set(copy_hashes) == RUNTIME_COPY_PATHS
        and all(
            isinstance(value, str)
            and re.fullmatch(r"[0-9a-f]{64}", value) is not None
            and set(value) != {"0"}
            for value in copy_hashes.values()
        ),
        "runtime image copied file hashes",
    )
    return result

def deployment_values(policy: dict[str, Any]) -> dict[str, Any]:
    deployment = policy.get("deployment")
    _require(
        isinstance(deployment, dict)
        and set(deployment) == {"serviceNetwork", "endpoints"},
        "deployment configuration",
    )
    endpoints = deployment["endpoints"]
    _require(
        isinstance(endpoints, dict)
        and set(endpoints)
        == {"caddy", "stalwart", "join", "approval", "admin"},
        "deployment endpoints",
    )
    try:
        network = ipaddress.ip_network(
            deployment["serviceNetwork"],
            strict=True,
        )
        addresses = {
            name: ipaddress.ip_address(endpoints[name]["address"])
            for name in endpoints
        }
    except (KeyError, TypeError, ValueError):
        raise LayoutError(
            "unsafe container layout: deployment configuration"
        ) from None
    ports = {name: endpoints[name].get("port") for name in endpoints}
    _require(
        network.version == 4
        and network.is_private
        and not network.is_loopback
        and all(
            addresses[name] in network
            for name in ("caddy", "stalwart", "join", "approval")
        )
        and len(
            {
                addresses[name]
                for name in ("caddy", "stalwart", "join", "approval")
            }
        )
        == 4
        and addresses["admin"].is_loopback
        and all(
            isinstance(port, int)
            and not isinstance(port, bool)
            and 1024 <= port <= 65535
            for port in ports.values()
        ),
        "deployment network",
    )
    hostname = policy.get("hostname")
    public_origin = policy.get("publicUrl")
    mail_domain = policy.get("mailDomain")
    published = policy.get("frontProxy", {}).get("publishedPorts")
    _require(
        isinstance(hostname, str)
        and bool(hostname)
        and public_origin == f"https://{hostname}"
        and isinstance(mail_domain, str)
        and bool(mail_domain)
        and published == [443],
        "deployment public origin",
    )
    values: dict[str, Any] = {
        "hostname": hostname,
        "public-origin": public_origin,
        "mail-domain": mail_domain,
        "admin-username": f"admin@{mail_domain}",
        "service-network": str(network),
        "jmap-session-url": f"{public_origin}/.well-known/jmap",
        "caddy-port-mapping": f"443:{ports['caddy']}/tcp",
    }
    for name in endpoints:
        values[f"{name}-address"] = str(addresses[name])
        values[f"{name}-port"] = ports[name]
    return values


def _configuration_tokens(value: Any):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _configuration_tokens(key)
            yield from _configuration_tokens(item)
    elif isinstance(value, list):
        for item in value:
            yield from _configuration_tokens(item)
    elif isinstance(value, str):
        yield from UNRESOLVED_TOKEN.findall(value)


def render_configuration(
    template: Any,
    policy: dict[str, Any],
    *,
    allowed_tokens: frozenset[str] = frozenset(),
) -> Any:
    deployment = deployment_values(policy)

    def replace(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: replace(item) for key, item in value.items()}
        if isinstance(value, list):
            return [replace(item) for item in value]
        if isinstance(value, str):
            match = DEPLOYMENT_TOKEN.fullmatch(value)
            if match:
                _require(
                    match.group(1) in deployment,
                    "unknown deployment token",
                )
                return deployment[match.group(1)]
        return copy.deepcopy(value)

    rendered = replace(template)
    _require(
        set(_configuration_tokens(rendered)) <= allowed_tokens,
        "unresolved configuration token",
    )
    return rendered


def helper_bootstrap_values(runtime: Any) -> dict[str, str]:
    _require(isinstance(runtime, dict), "helper runtime configuration")
    paths = runtime.get("paths")
    management = runtime.get("management")
    secret_path = (
        paths.get("adminSecret") if isinstance(paths, dict) else None
    )
    username = (
        management.get("username")
        if isinstance(management, dict)
        else None
    )
    _require(
        isinstance(secret_path, str)
        and secret_path == "/run/quarterdeck-admin/credential",
        "helper administrator path",
    )
    _require(
        isinstance(username, str)
        and 1 <= len(username) <= 128
        and ":" not in username
        and all(0x21 <= ord(character) <= 0x7E for character in username),
        "helper management username",
    )
    return {
        "admin-secret": secret_path,
        "management-username": username,
    }


def render(
    template: Any,
    manifest: dict[str, Any],
    policy: dict[str, Any],
    *,
    helper_runtime: Any | None = None,
) -> Any:
    images = validate_manifest(manifest)
    helper = (
        helper_bootstrap_values(helper_runtime)
        if helper_runtime is not None
        else None
    )
    deferred_tokens = frozenset(
        {"QD_ROOT", "QD_PACKAGE", "QD_EGRESS_SUBNET", "QD_CARD_LINK_ORIGIN"}
        | {f"image:{name}" for name in IMAGE_KEYS}
        | {"helper:admin-secret", "helper:management-username"}
    )
    configured = render_configuration(
        template,
        policy,
        allowed_tokens=deferred_tokens,
    )

    def replace_images(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: replace_images(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [replace_images(item) for item in value]
        if isinstance(value, str):
            match = IMAGE_TOKEN.fullmatch(value)
            if match:
                _require(
                    match.group(1) in images,
                    "unknown image token",
                )
                return images[match.group(1)]
            match = HELPER_TOKEN.fullmatch(value)
            if match:
                _require(
                    helper is not None and match.group(1) in helper,
                    "unknown helper token",
                )
                return helper[match.group(1)]
        return copy.deepcopy(value)

    rendered = replace_images(configured)
    _require(
        set(_configuration_tokens(rendered)) <= {"QD_ROOT", "QD_PACKAGE", "QD_EGRESS_SUBNET", "QD_CARD_LINK_ORIGIN"},
        "unresolved configuration token",
    )
    return rendered


def _volume_targets(service: dict[str, Any]) -> set[str]:
    volumes = service.get("volumes")
    _require(isinstance(volumes, list), "service volume list")
    targets = set()
    for volume in volumes:
        _require(isinstance(volume, str) and volume.count(":") >= 2, "long bind volume syntax")
        source, target, mode = volume.rsplit(":", 2)
        _require(source.startswith("${QD_ROOT}/") or source.startswith("${QD_PACKAGE}/"), "bounded bind source")
        _require(target.startswith("/"), "absolute bind target")
        _require(mode in {"ro", "rw"}, "explicit bind mode")
        _require(target not in targets, "duplicate bind target")
        targets.add(target)
    return targets


def _validate_service(
    name: str,
    service: dict[str, Any],
    *,
    disabled_logs: bool = False,
    allow_net_bind_service: bool = False,
) -> None:
    image = service.get("image")
    _require(isinstance(image, str) and DIGEST_REFERENCE.fullmatch(image) is not None, f"digest image for {name}")
    user = service.get("user")
    _require(isinstance(user, str) and re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", user) is not None, f"unprivileged user for {name}")
    _require(service.get("read_only") is True, f"read-only root for {name}")
    _require(service.get("cap_drop") == ["ALL"], f"dropped capabilities for {name}")
    if "cap_add" in service:
        _require(
            allow_net_bind_service
            and service["cap_add"] == ["NET_BIND_SERVICE"],
            f"added capabilities for {name}",
        )
    _require("no-new-privileges:true" in service.get("security_opt", []), f"no-new-privileges for {name}")
    _require(service.get("privileged") is not True, f"privileged mode for {name}")
    _require(service.get("pid") != "host" and service.get("ipc") != "host", f"host namespace for {name}")
    _require(service.get("network_mode") != "host", f"host network for {name}")
    _require(isinstance(service.get("pids_limit"), int) and 1 <= service["pids_limit"] <= 256, f"process limit for {name}")
    _require(isinstance(service.get("mem_limit"), str), f"memory limit for {name}")
    _require(service.get("memswap_limit") == service.get("mem_limit"), f"swap limit for {name}")
    _require(service.get("cpus") is not None, f"CPU limit for {name}")
    nofile = service.get("ulimits", {}).get("nofile", {})
    _require(
        isinstance(nofile.get("soft"), int)
        and isinstance(nofile.get("hard"), int)
        and 1 <= nofile["soft"] <= nofile["hard"] <= 4096,
        f"file limit for {name}",
    )
    tmpfs = service.get("tmpfs")
    _require(isinstance(tmpfs, list) and tmpfs and all("noexec" in item and "nodev" in item and "nosuid" in item for item in tmpfs), f"private temporary files for {name}")
    logging = service.get("logging")
    if disabled_logs:
        _require(logging == {"driver": "none"}, f"disabled logs for {name}")
    else:
        _require(
            isinstance(logging, dict)
            and logging.get("driver") == "json-file"
            and set(logging.get("options", {})) == {"max-size", "max-file"},
            f"bounded logs for {name}",
        )
    environment = service.get("environment", {})
    _require(isinstance(environment, dict), f"fixed environment for {name}")
    _require(not any(key.startswith("STALWART_RECOVERY_") for key in environment), f"recovery environment for {name}")
    _volume_targets(service)
    _require("docker.sock" not in json.dumps(service), f"Docker socket for {name}")


def validate_normal(
    document: dict[str, Any],
    policy: dict[str, Any],
) -> None:
    _require(document.get("name") == "quarterdeck", "normal project name")
    services = document.get("services")
    service_names = {
        "caddy",
        "stalwart",
        "join",
        "helper",
        "approval",
        "captain-app",
    }
    _require(
        isinstance(services, dict) and set(services) == service_names,
        "normal services",
    )
    for name, service in services.items():
        _require(isinstance(service, dict), f"service object {name}")
        _validate_service(
            name,
            service,
            allow_net_bind_service=name == "caddy",
        )

    deployment = deployment_values(policy)
    _require(
        len({service["user"] for service in services.values()}) == 6,
        "separate service users",
    )
    _require(
        services["captain-app"].get("user") == "2700:2700",
        "Captain service user",
    )
    _require(
        services["caddy"].get("ports")
        == [deployment["caddy-port-mapping"]],
        "single public TLS mapping",
    )
    for name in service_names - {"caddy"}:
        _require("ports" not in services[name], f"no published port for {name}")

    expected_networks = {
        "caddy": {
            "edge": {},
            "service": {"ipv4_address": deployment["caddy-address"]},
        },
        "stalwart": {
            "service": {
                "ipv4_address": deployment["stalwart-address"],
            }
        },
        "join": {
            "service": {"ipv4_address": deployment["join-address"]}
        },
        "approval": {
            "service": {
                "ipv4_address": deployment["approval-address"],
            },
            "egress": {},
        },
        "captain-app": {"service": {}},
    }
    for name, networks in expected_networks.items():
        _require(
            services[name].get("networks") == networks,
            f"fixed private address for {name}",
        )
    _require(services["helper"].get("network_mode") == "service:stalwart", "helper loopback administration")
    _require("networks" not in services["helper"], "helper has one network namespace")

    _require(services["join"].get("group_add") == ["2400", "2501"], "join socket groups")
    _require(services["helper"].get("group_add") == ["2400"], "helper control group")
    _require(
        services["approval"].get("group_add") == ["2501", "2701"],
        "approval socket groups",
    )
    _require(
        services["captain-app"].get("group_add") == ["2701"],
        "Captain auth group",
    )
    _require(
        "group_add" not in services["caddy"],
        "Caddy group isolation",
    )
    _require(
        "group_add" not in services["stalwart"],
        "Stalwart group isolation",
    )

    networks = document.get("networks")
    _require(
        networks
        == {
            "edge": {
                "driver": "bridge",
                "driver_opts": {
                    "com.docker.network.bridge.name": "qd-edge0"
                },
            },
            "service": {
                "driver": "bridge",
                "driver_opts": {
                    "com.docker.network.bridge.name": "qd-svc0"
                },
                "internal": True,
                "ipam": {
                    "config": [
                        {"subnet": deployment["service-network"]}
                    ]
                },
            },
            "egress": {
                "driver": "bridge",
                "driver_opts": {
                    "com.docker.network.bridge.name": "qd-egress0"
                },
                "ipam": {
                    "config": [
                        {"subnet": "${QD_EGRESS_SUBNET}"}
                    ]
                },
            },
        },
        "exact edge, private, and approval-egress networks",
    )

    targets = {name: _volume_targets(service) for name, service in services.items()}
    _require("/etc/caddy/Caddyfile" in targets["caddy"], "Caddy configuration")
    _require({"/data", "/config"} <= targets["caddy"], "Caddy certificate state")
    _require("/var/lib/stalwart" in targets["stalwart"], "Stalwart data owner")
    _require(
        "/var/lib/stalwart" not in set().union(*(targets[name] for name in service_names - {"stalwart"})),
        "Stalwart data isolation",
    )
    _require("/run/quarterdeck-admin" in targets["helper"], "helper administrator mount")
    _require(
        "/run/quarterdeck-admin" not in set().union(*(targets[name] for name in service_names - {"helper"})),
        "administrator isolation",
    )
    _require("/var/lib/quarterdeck-join" in targets["join"], "join state owner")
    _require("/var/lib/quarterdeck-helper" in targets["helper"], "helper state owner")
    _require("/var/lib/quarterdeck-approval" in targets["approval"], "approval secret owner")
    _require(
        "/var/lib/quarterdeck-approval"
        not in set().union(*(targets[name] for name in service_names - {"approval"})),
        "approval secret isolation",
    )
    _require(
        "/run/quarterdeck-control" in targets["join"] & targets["helper"],
        "private helper control socket",
    )
    _require(
        "/run/quarterdeck-approval" in targets["join"] & targets["approval"],
        "private approval socket",
    )
    _require(
        "/run/quarterdeck-captain-auth"
        in targets["approval"] & targets["captain-app"],
        "private Captain auth socket",
    )
    _require(
        "/run/quarterdeck-captain-mail" in targets["captain-app"],
        "Captain mail key owner",
    )
    _require(
        "/run/quarterdeck-captain-mail"
        not in set().union(
            *(targets[name] for name in service_names - {"captain-app"})
        ),
        "Captain mail key isolation",
    )
    _require(
        "/var/lib/quarterdeck-captain" in targets["captain-app"],
        "Captain application state owner",
    )
    _require(
        "/var/lib/quarterdeck-approval" not in targets["captain-app"],
        "Captain approval-secret isolation",
    )
    _require(
        "/run/quarterdeck-admin" not in targets["captain-app"],
        "Captain administrator isolation",
    )
    _require(
        "/opt/quarterdeck/captain-app"
        in targets["approval"] & targets["captain-app"],
        "shared Captain sign-in contract",
    )
    _require(
        "/opt/quarterdeck/qd-cards" in targets["captain-app"],
        "Captain card contract",
    )
    _require(
        "/opt/quarterdeck/qd-mail-stalwart" in targets["captain-app"],
        "Captain JMAP adapter",
    )
    contract_consumers = {"join", "helper", "approval"}
    for name in contract_consumers:
        _require(
            "/opt/quarterdeck/signup" in targets[name],
            f"shared signup contract for {name}",
        )
    _require(
        services["helper"].get("environment", {}).get("PYTHONPATH")
        == "/opt/quarterdeck/signup:/opt/quarterdeck/qd-mail-stalwart",
        "helper import paths",
    )
    _require(
        services["join"].get("environment", {}).get("PYTHONPATH")
        == (
            "/opt/quarterdeck/signup:/opt/quarterdeck/shared:"
            "/opt/quarterdeck/qd-mail-stalwart"
        ),
        "join import paths",
    )
    _require(
        services["approval"].get("environment", {}).get("PYTHONPATH")
        == (
            "/opt/quarterdeck/captain-app:/opt/quarterdeck/signup:"
            "/opt/quarterdeck/shared"
        ),
        "approval import paths",
    )
    _require(
        services["captain-app"].get("environment", {}).get("PYTHONPATH")
        == (
            "/opt/quarterdeck/captain-app:/opt/quarterdeck/qd-cards:"
            "/opt/quarterdeck/qd-mail-stalwart:/opt/quarterdeck/approval:"
            "/opt/quarterdeck/shared:/opt/quarterdeck/door"
        ),
        "Captain import paths",
    )
    _require(
        services["captain-app"].get("environment", {}).get("QD_CARD_LINK_ORIGIN")
        == "${QD_CARD_LINK_ORIGIN}",
        "Captain card link origin",
    )
    _require(
        "/opt/quarterdeck/shared"
        in targets["join"] & targets["approval"],
        "shared invite prompt package",
    )
    _require(
        "/opt/quarterdeck/qd-mail-stalwart"
        in targets["join"] & targets["helper"],
        "JMAP package consumers",
    )
    _require(
        "/opt/quarterdeck/signup"
        not in set().union(
            *(targets[name] for name in service_names - contract_consumers)
        ),
        "signup package exposure",
    )

def validate_step13(document: dict[str, Any]) -> None:
    _require(document.get("name") == "quarterdeck", "step 13 project name")
    services = document.get("services")
    service_names = {
        "write-oidc",
        "place-google-secret",
        "write-registry",
        "captain-account",
        "captain-account-admin",
    }
    _require(
        isinstance(services, dict) and set(services) == service_names,
        "step 13 services",
    )
    for name, service in services.items():
        _require(isinstance(service, dict), f"service object {name}")
        _validate_service(name, service, disabled_logs=True)
        _require(
            "ports" not in service and "networks" not in service,
            f"unpublished step 13 service {name}",
        )
        _require(
            service.get("restart") == "no",
            f"one-shot restart policy {name}",
        )
        _require(
            service.get("pids_limit") == 32
            and service.get("mem_limit") == "128m"
            and service.get("memswap_limit") == "128m"
            and service.get("cpus") == "0.25"
            and service.get("ulimits")
            == {"nofile": {"soft": 256, "hard": 256}}
            and service.get("tmpfs")
            == ["/tmp:rw,nosuid,nodev,noexec,size=8m"],
            f"one-shot limits {name}",
        )

    _require(
        {name: service["user"] for name, service in services.items()}
        == {
            "write-oidc": "2500:2500",
            "place-google-secret": "2500:2500",
            "write-registry": "2700:2700",
            "captain-account": "2700:2700",
            "captain-account-admin": "2200:2200",
        },
        "step 13 identities",
    )
    _require(
        {
            name: service.get("network_mode")
            for name, service in services.items()
        }
        == {
            "write-oidc": "none",
            "place-google-secret": "none",
            "write-registry": "none",
            "captain-account": "none",
            "captain-account-admin": "service:stalwart",
        },
        "step 13 network isolation",
    )
    _require(
        services["captain-account-admin"].get("depends_on")
        == {"stalwart": {"condition": "service_started"}},
        "Captain account administrator dependency",
    )
    for name in service_names - {"captain-account-admin"}:
        _require(
            "depends_on" not in services[name],
            f"offline one-shot dependency {name}",
        )

    _require(
        {
            name: service.get("entrypoint")
            for name, service in services.items()
        }
        == {
            "write-oidc": [
                "python3",
                "/opt/quarterdeck/approval/write_oidc.py",
            ],
            "place-google-secret": [
                "python3",
                "/opt/quarterdeck/approval/place_google_secret.py",
            ],
            "write-registry": [
                "python3",
                "/opt/quarterdeck/helper/write_registry.py",
            ],
            "captain-account": [
                "python3",
                "/opt/quarterdeck/helper/captain_account.py",
            ],
            "captain-account-admin": [
                "python3",
                "/opt/quarterdeck/helper/captain_account.py",
            ],
        },
        "step 13 entrypoints",
    )
    _require(
        {
            name: service.get("working_dir")
            for name, service in services.items()
        }
        == {
            "write-oidc": "/opt/quarterdeck/approval",
            "place-google-secret": "/opt/quarterdeck/approval",
            "write-registry": "/opt/quarterdeck/helper",
            "captain-account": "/opt/quarterdeck/helper",
            "captain-account-admin": "/opt/quarterdeck/helper",
        },
        "step 13 working directories",
    )
    base_environment = {
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
    }
    for name in service_names - {"captain-account"}:
        _require(
            services[name].get("environment") == base_environment,
            f"step 13 environment {name}",
        )
    _require(
        services["captain-account"].get("environment")
        == {
            **base_environment,
            "PYTHONPATH": (
                "/opt/quarterdeck/captain-app:/opt/quarterdeck/door"
            ),
        },
        "Captain account import paths",
    )

    expected_volumes = {
        "write-oidc": {
            "${QD_PACKAGE}/golive/approval:"
            "/opt/quarterdeck/approval:ro",
            "${QD_ROOT}/secrets/approval-secrets:"
            "/var/lib/quarterdeck-approval:rw",
        },
        "place-google-secret": {
            "${QD_PACKAGE}/golive/approval:"
            "/opt/quarterdeck/approval:ro",
            "${QD_ROOT}/secrets/approval-secrets:"
            "/var/lib/quarterdeck-approval:rw",
        },
        "write-registry": {
            "${QD_PACKAGE}/golive/helper:/opt/quarterdeck/helper:ro",
            "${QD_ROOT}/volumes/captain-state:"
            "/var/lib/quarterdeck-captain:rw",
        },
        "captain-account": {
            "${QD_PACKAGE}/golive/helper:/opt/quarterdeck/helper:ro",
            "${QD_PACKAGE}/captain-app:/opt/quarterdeck/captain-app:ro",
            "${QD_PACKAGE}/golive/door:/opt/quarterdeck/door:ro",
            "${QD_ROOT}/secrets/captain-mail-key:"
            "/run/quarterdeck-captain-mail:rw",
            "${QD_ROOT}/volumes/captain-state:"
            "/var/lib/quarterdeck-captain:rw",
        },
        "captain-account-admin": {
            "${QD_PACKAGE}/golive/helper:/opt/quarterdeck/helper:ro",
            "${QD_ROOT}/volumes/helper-state:"
            "/var/lib/quarterdeck-helper:ro",
            "${QD_ROOT}/secrets/helper-admin:"
            "/run/quarterdeck-admin:ro",
        },
    }
    for name, expected in expected_volumes.items():
        _require(
            set(services[name].get("volumes", [])) == expected,
            f"step 13 mounts {name}",
        )


def validate_first_start(
    document: dict[str, Any],
    helper_runtime: Any,
) -> None:
    _require(document.get("name") == "quarterdeck-first-start", "first-start project name")
    services = document.get("services")
    _require(
        isinstance(services, dict)
        and set(services)
        == {
            "stalwart-bootstrap",
            "stalwart-recovery",
            "first-start-configurator",
        },
        "first-start services",
    )
    for name, service in services.items():
        _require(isinstance(service, dict), f"service object {name}")
        _validate_service(
            name,
            service,
            disabled_logs=name == "stalwart-bootstrap",
        )
        _require("ports" not in service and "networks" not in service, f"unpublished first-start service {name}")
        _require(service.get("restart") == "no", f"one-shot restart policy {name}")

    helper = helper_bootstrap_values(helper_runtime)
    bootstrap = services["stalwart-bootstrap"]
    recovery = services["stalwart-recovery"]
    configurator = services["first-start-configurator"]
    _require(bootstrap.get("network_mode") == "none", "bootstrap network isolation")
    _require(recovery.get("network_mode") == "none", "recovery network isolation")
    _require(configurator.get("network_mode") == "service:stalwart-recovery", "configurator recovery namespace")
    _require(
        bootstrap.get("entrypoint")
        == ["python3", "/opt/quarterdeck/bootstrap_launcher.py"],
        "bootstrap launcher",
    )
    _require(
        bootstrap.get("command")
        == [
            "/run/quarterdeck-bootstrap/bootstrap-request.json",
            helper["admin-secret"],
            helper["management-username"],
            "18080",
            "--",
            "/usr/local/bin/stalwart",
            "--config",
            "/etc/stalwart/config.json",
        ],
        "bootstrap command",
    )
    _require("environment" not in bootstrap, "bootstrap environment")
    _require(recovery.get("entrypoint") == ["python3", "/opt/quarterdeck/recovery_launcher.py"], "recovery launcher")
    _require(configurator.get("entrypoint") == ["python3", "/opt/quarterdeck/first_start.py"], "settings configurator")
    _require("STALWART_RECOVERY_" not in json.dumps(document), "no recovery setting in compose")
    bootstrap_targets = _volume_targets(bootstrap)
    recovery_targets = _volume_targets(recovery)
    configurator_targets = _volume_targets(configurator)
    _require(
        {
            "/run/quarterdeck-bootstrap/bootstrap-request.json",
            "/run/quarterdeck-admin",
            "/etc/stalwart",
            "/var/lib/stalwart",
            "/var/log/stalwart",
        }
        <= bootstrap_targets,
        "bootstrap mounts",
    )
    _require(
        "/run/quarterdeck-admin"
        not in recovery_targets | configurator_targets,
        "helper administrator isolation",
    )
    _require("/run/quarterdeck" in recovery_targets & configurator_targets, "shared recovery file mount")
    _require("/var/lib/stalwart" in recovery_targets and "/var/lib/stalwart" not in configurator_targets, "data isolation during first start")
    _require("/var/lib/quarterdeck" in configurator_targets, "first-start marker owner")


def _write_new(path: str, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise LayoutError("compose output write did not progress")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 4 and args[0] == "configuration":
        _, policy_path, template_path, output_path = args
        policy = json.loads(
            Path(policy_path).read_text(encoding="utf-8")
        )
        template = json.loads(
            Path(template_path).read_text(encoding="utf-8")
        )
        document = render_configuration(template, policy)
    elif len(args) == 5 and args[0] in {"normal", "step13"}:
        mode, manifest_path, policy_path, template_path, output_path = args
        manifest = json.loads(
            Path(manifest_path).read_text(encoding="utf-8")
        )
        policy = json.loads(
            Path(policy_path).read_text(encoding="utf-8")
        )
        template = json.loads(
            Path(template_path).read_text(encoding="utf-8")
        )
        document = render(template, manifest, policy)
        if mode == "normal":
            validate_normal(document, policy)
        else:
            validate_step13(document)
    elif len(args) == 6 and args[0] == "first-start":
        (
            _,
            manifest_path,
            policy_path,
            template_path,
            helper_runtime_path,
            output_path,
        ) = args
        manifest = json.loads(
            Path(manifest_path).read_text(encoding="utf-8")
        )
        policy = json.loads(
            Path(policy_path).read_text(encoding="utf-8")
        )
        template = json.loads(
            Path(template_path).read_text(encoding="utf-8")
        )
        helper_runtime = json.loads(
            Path(helper_runtime_path).read_text(encoding="utf-8")
        )
        document = render(
            template,
            manifest,
            policy,
            helper_runtime=helper_runtime,
        )
        validate_first_start(document, helper_runtime)
    else:
        raise LayoutError(
            "expected configuration POLICY TEMPLATE OUTPUT, "
            "normal or step13 MANIFEST POLICY TEMPLATE OUTPUT, or "
            "first-start MANIFEST POLICY TEMPLATE HELPER_RUNTIME OUTPUT"
        )
    content = (
        json.dumps(document, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    _write_new(output_path, content)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("container layout refused safely\n")
        raise SystemExit(1)
