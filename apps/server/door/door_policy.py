from __future__ import annotations

import ipaddress
import json
import os
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


class PolicyError(ValueError):
    pass


EXPECTED_ROUTES = [
    {
        "matcher": "jmap_discovery",
        "methods": ["GET"],
        "path": "/.well-known/jmap",
        "upstream": "stalwart",
        "reason": "JMAP discovery redirects to the authenticated session resource",
    },
    {
        "matcher": "jmap_session",
        "methods": ["GET"],
        "path": "/jmap/session",
        "upstream": "stalwart",
        "reason": "The bot client reads its authenticated JMAP session and same-origin API URL",
    },
    {
        "matcher": "jmap_api",
        "methods": ["POST"],
        "path": "/jmap/",
        "upstream": "stalwart",
        "reason": "The bot client sends all mailbox and submission method calls here",
    },
    {
        "matcher": "join_request",
        "methods": ["POST"],
        "path": "/qd/join/request",
        "upstream": "join",
        "maxBody": "4KB",
        "reason": "A bot creates one bounded public join request",
    },
    {
        "matcher": "join_collect",
        "methods": ["POST"],
        "path": "/qd/join/collect",
        "upstream": "join",
        "maxBody": "4KB",
        "reason": "An approved bot collects its one-use join result",
    },
    {
        "matcher": "bot_invite",
        "methods": ["POST"],
        "path": "/qd/invite",
        "upstream": "join",
        "maxBody": "4KB",
        "reason": "An active bot creates one rate-limited invite with its own mail key",
    },
    {
        "matcher": "captain_step_up",
        "methods": ["GET"],
        "path": "/captain/step-up",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain starts a fresh browser-bound Google sign-in",
    },
    {
        "matcher": "captain_devices",
        "methods": ["GET"],
        "path": "/captain/settings/devices",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain reads coarse signed-in device details",
    },
    {
        "matcher": "captain_device_signout",
        "methods": ["POST"],
        "path": "/captain/settings/devices/sign-out",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain signs out one device with session-owned CSRF",
    },
    {
        "matcher": "captain_everywhere_signout",
        "methods": ["POST"],
        "path": "/captain/settings/devices/sign-out-everywhere",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The freshly signed-in Captain ends every browser session",
    },
    {
        "matcher": "captain_signed_out",
        "methods": ["GET"],
        "path": "/captain/signed-out",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The signed-out page offers an explicit Sign in button",
    },
    {
        "matcher": "captain_login",
        "methods": ["GET"],
        "path": "/captain/login",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain starts browser-bound Google sign-in",
    },
    {
        "matcher": "captain_oidc_callback",
        "methods": ["GET"],
        "path": "/captain/oidc/callback",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "Google returns the one-use authorization code to its bound browser",
    },
    {
        "matcher": "captain_pending",
        "methods": ["GET"],
        "path": "/captain/pending",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain lists pending joins after Google sign-in",
    },
    {
        "matcher": "captain_invite_create",
        "methods": ["POST"],
        "path": "/captain/invites/create",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain creates one bot invite after Google sign-in",
    },
    {
        "matcher": "captain_invite_cancel",
        "methods": ["POST"],
        "path": "/captain/invites/cancel",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain cancels one unused bot invite",
    },
    {
        "matcher": "captain_approve",
        "methods": ["POST"],
        "path": "/captain/approve",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain approves one pending join",
    },
    {
        "matcher": "captain_refuse",
        "methods": ["POST"],
        "path": "/captain/refuse",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain refuses one pending join",
    },
    {
        "matcher": "captain_approval_password",
        "methods": ["POST"],
        "path": "/captain/settings/approval-password",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain changes the optional per-approval password setting",
    },
    {
        "matcher": "captain_logout",
        "methods": ["POST"],
        "path": "/captain/logout",
        "upstream": "approval",
        "maxBody": "8KB",
        "reason": "The Captain destroys the current browser session",
    },
]
EXPECTED_CHAT_ROUTES = [
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

EXPECTED_CHAT_BLOCK = {
    "format": 1,
    "default": "off",
    "upstream": "captain-app:8080",
    "routes": EXPECTED_CHAT_ROUTES,
}

EXPECTED_FRONT_PROXY = {
    "image": "docker.io/library/caddy:2.11.7-alpine",
    "publishedPorts": [443],
    "port80": False,
    "certificate": {
        "holder": "caddy",
        "challenge": "tls-alpn-01",
        "disableHttpChallenge": True,
        "automaticRedirects": False,
        "renewalFailureAlert": True,
    },
    "stalwartProxy": {"protocol": "proxy-v2"},
    "applicationForwarding": {
        "header": "X-Forwarded-For",
        "source": "remote-host",
        "rejectUntrustedForwarding": True,
    },
    "routes": EXPECTED_ROUTES,
}

EXPECTED_LISTENERS = [
    {
        "name": "jmap-private",
        "scope": "private-caddy",
        "endpoint": "stalwart",
        "protocol": "http",
        "useTls": False,
        "implicitTls": False,
        "maxConnections": 128,
    },
    {
        "name": "admin-loopback",
        "scope": "loopback",
        "endpoint": "admin",
        "protocol": "http",
        "useTls": False,
        "implicitTls": False,
        "maxConnections": 8,
    },
]

EXPECTED_PERMISSIONS = {
    "authenticate",
    "emailReceive",
    "emailSend",
    "jmapEmailCreate",
    "jmapEmailGet",
    "jmapEmailQuery",
    "jmapEmailSubmissionCreate",
    "jmapEmailUpdate",
    "jmapIdentityGet",
    "jmapMailboxGet",
}

EXPECTED_ALLOWED_ENDPOINTS = {
    "match": {
        "0": {
            "if": (
                "listener == 'jmap-private' && ((method == 'GET' && "
                "(path == '/.well-known/jmap' || path == '/jmap/session')) || "
                "(method == 'POST' && path == '/jmap/'))"
            ),
            "then": "200",
        },
        "1": {"if": "listener == 'admin-loopback'", "then": "200"},
    },
    "else": "404",
}

EXPECTED_SINGLETONS = {
    "Http": {
        "rateLimitAuthenticated": {"count": 120, "period": 60000},
        "rateLimitAnonymous": {"count": 20, "period": 60000},
        "allowedEndpoints": EXPECTED_ALLOWED_ENDPOINTS,
        "enableHsts": False,
        "usePermissiveCors": False,
    },
    "Security": {
        "authBanRate": {"count": 5, "period": 900000},
        "authBanPeriod": 900000,
        "abuseBanRate": {"count": 10, "period": 3600000},
        "abuseBanPeriod": 900000,
        "loiterBanRate": {"count": 10, "period": 3600000},
        "loiterBanPeriod": 900000,
        "scanBanRate": {"count": 5, "period": 3600000},
        "scanBanPeriod": 3600000,
    },
    "Email": {
        "maxAttachmentSize": 1,
        "maxMessageSize": 262144,
        "maxMessages": 10000,
        "maxMailboxes": 8,
        "maxIdentities": 1,
        "maxSubmissions": 1000,
        "maxPublicKeys": 1,
    },
    "Jmap": {
        "maxConcurrentRequests": 2,
        "maxConcurrentUploads": 1,
        "maxRequestSize": 1048576,
        "maxUploadSize": 1048576,
        "maxUploadCount": 1,
        "uploadQuota": 1,
        "maxMethodCalls": 8,
        "maxSetObjects": 16,
        "maxGetResults": 256,
        "maxQueryResults": 256,
        "maxChangesResults": 256,
        "maxSnippetResults": 1,
    },
    "Asn": {
        "@type": "Resource",
        "asnUrls": {},
        "geoUrls": {},
    },
    "SpamSettings": {
        "enable": False,
        "spamFilterRulesUrl": "file:///msd-absent/spam-filter-rules.json.gz",
    },
    "MtaStageRcpt": {
        "allowRelaying": {"match": {}, "else": "false"},
        "maxRecipients": {"match": {}, "else": "1"},
        "maxFailures": {"match": {}, "else": "3"},
        "waitOnFail": {"match": {}, "else": "1s"},
    },
    "MtaStageAuth": {"mustMatchSender": {"match": {}, "else": "true"}},
    "MtaStageData": {"script": {"match": {}, "else": "'quarterdeck-from-match-v1'"}},
}

EXPECTED_WEB_UI = {
    "resourceUrl": "file:///msd-absent/webui.zip",
    "autoUpdateInterval": 86400000,
    "unpackDirectory": "/tmp/msd-webui",
    "enable": False,
}

EXPECTED_SCRIPT = {
    "name": "quarterdeck-from-match-v1",
    "description": "Require one From address matching the verified envelope sender",
    "isActive": True,
    "contents": (
        'require ["variables", "envelope", "reject", "relational", "comparator-i;ascii-numeric"];\n'
        "\n"
        'if not address :count "eq" :comparator "i;ascii-numeric" "from" "1" {\n'
        '    reject "550 5.7.1 Exactly one From address is required.";\n'
        "}\n"
        "\n"
        'if not address :all :comparator "i;unicode-casemap" :is "from" "${envelope.from}" {\n'
        '    reject "550 5.7.1 The From address must match the authenticated sender.";\n'
        "}"
    ),
}

EXPECTED_DOMAIN_POLICY = {
    "allowRelaying": False,
    "catchAllAddress": None,
    "subAddressing": {"@type": "Disabled"},
}

EXPECTED_QUOTAS = {
    "maxDiskQuota": 268435456,
    "maxEmails": 10000,
    "maxMailboxes": 8,
    "maxEmailIdentities": 1,
    "maxEmailSubmissions": 1000,
    "maxApiKeys": 2,
    "maxAppPasswords": 0,
    "maxPublicKeys": 0,
}

EXPECTED_SERVICE_LIMITS = {
    "joinRequest": {
        "perCaller": {"count": 6, "period": 600000},
        "perBot": {"count": 2, "period": 3600000},
        "global": {"count": 60, "period": 3600000},
        "outstandingPerBot": 1,
        "outstandingGlobal": 100,
        "expiresAfter": 600000,
    },
    "joinCollect": {
        "perCaller": {"count": 30, "period": 60000},
        "perBot": {"count": 30, "period": 60000},
        "global": {"count": 300, "period": 60000},
    },
    "botInvite": {
        "authenticationPerCaller": {
            "count": 30,
            "period": 60000,
            "ban": 3600000,
        },
        "activeBot": {"count": 5, "period": 3600000},
        "globalAuthentication": {"count": 300, "period": 60000},
    },
    "approval": {
        "failedLoginPerCaller": {"count": 5, "period": 900000, "ban": 3600000},
        "failedLoginGlobal": {"count": 20, "period": 900000, "close": 900000},
        "authenticatedPerSession": {"count": 30, "period": 60000},
        "authenticatedGlobal": {"count": 120, "period": 60000},
        "idleSession": 900000,
        "absoluteSession": 3600000,
    },
}


def load_policy(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise PolicyError("door policy must be a JSON object")
    return value

def load_chat_block(path: str | Path) -> dict[str, Any]:
    block = load_policy(path)
    _require(block == EXPECTED_CHAT_BLOCK, "chat route block")
    return block


def _require(condition: bool, field: str) -> None:
    if not condition:
        raise PolicyError(f"unsafe or incomplete door policy: {field}")

def _domain_name(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 253:
        return False
    labels = value.split(".")
    return bool(labels) and all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        is not None
        for label in labels
    )


def _endpoint(policy: dict[str, Any], name: str) -> dict[str, Any]:
    return policy["deployment"]["endpoints"][name]


def endpoint_address(policy: dict[str, Any], name: str) -> str:
    endpoint = _endpoint(policy, name)
    return f"{endpoint['address']}:{endpoint['port']}"


def trusted_caddy_network(policy: dict[str, Any]) -> str:
    return f"{_endpoint(policy, 'caddy')['address']}/32"

def normalized_network_map(value: Any) -> dict[str, bool] | None:
    if not isinstance(value, dict) or any(enabled is not True for enabled in value.values()):
        return None
    try:
        return {
            str(ipaddress.ip_network(network, strict=False)): True
            for network in value
        }
    except (TypeError, ValueError):
        return None


def listener_settings(
    policy: dict[str, Any],
    listener: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": listener["name"],
        "bind": {endpoint_address(policy, listener["endpoint"]): True},
        "protocol": listener["protocol"],
        "useTls": listener["useTls"],
        "implicitTls": listener["implicitTls"],
        "maxConnections": listener["maxConnections"],
        "overrideProxyTrustedNetworks": (
            {trusted_caddy_network(policy): True}
            if listener["scope"] == "private-caddy"
            else {}
        ),
    }


def _validate_deployment(policy: dict[str, Any]) -> None:
    deployment = policy.get("deployment")
    _require(
        isinstance(deployment, dict)
        and set(deployment) == {"serviceNetwork", "endpoints"},
        "deployment",
    )
    try:
        network = ipaddress.ip_network(
            deployment["serviceNetwork"],
            strict=True,
        )
    except (KeyError, TypeError, ValueError):
        raise PolicyError("unsafe or incomplete door policy: deployment") from None
    _require(
        network.version == 4
        and network.is_private
        and not network.is_loopback
        and network.prefixlen <= 30,
        "deployment.serviceNetwork",
    )
    endpoints = deployment.get("endpoints")
    _require(
        isinstance(endpoints, dict)
        and set(endpoints)
        == {"caddy", "stalwart", "join", "approval", "admin"},
        "deployment.endpoints",
    )
    service_addresses = []
    for name in ("caddy", "stalwart", "join", "approval"):
        endpoint = endpoints[name]
        _require(
            isinstance(endpoint, dict)
            and set(endpoint) == {"address", "port"},
            f"deployment.endpoints.{name}",
        )
        try:
            address = ipaddress.ip_address(endpoint["address"])
        except (KeyError, TypeError, ValueError):
            raise PolicyError(
                f"unsafe or incomplete door policy: deployment.endpoints.{name}"
            ) from None
        port = endpoint["port"]
        _require(
            address.version == 4
            and address in network
            and address not in {network.network_address, network.broadcast_address}
            and isinstance(port, int)
            and not isinstance(port, bool)
            and 1024 <= port <= 65535,
            f"deployment.endpoints.{name}",
        )
        service_addresses.append(address)
    _require(
        len(set(service_addresses)) == len(service_addresses),
        "deployment service addresses",
    )
    admin = endpoints["admin"]
    _require(
        isinstance(admin, dict) and set(admin) == {"address", "port"},
        "deployment.endpoints.admin",
    )
    try:
        admin_address = ipaddress.ip_address(admin["address"])
    except (KeyError, TypeError, ValueError):
        raise PolicyError(
            "unsafe or incomplete door policy: deployment.endpoints.admin"
        ) from None
    _require(
        admin_address.is_loopback
        and isinstance(admin["port"], int)
        and not isinstance(admin["port"], bool)
        and 1024 <= admin["port"] <= 65535,
        "deployment.endpoints.admin",
    )



def validate_policy(policy: dict[str, Any]) -> dict[str, int]:
    _require(
        set(policy)
        == {
            "version",
            "hostname",
            "publicUrl",
            "mailDomain",
            "deployment",
            "bootstrap",
            "frontProxy",
            "listeners",
            "singletons",
            "senderPolicy",
            "localDomainPolicy",
            "eventLevels",
            "webUi",
            "botApiKey",
            "accountQuotas",
            "serviceLimits",
            "dns",
        },
        "top-level fields",
    )
    _require(policy.get("version") == 3, "version")
    hostname = policy.get("hostname")
    mail_domain = policy.get("mailDomain")
    _require(
        _domain_name(hostname)
        and _domain_name(mail_domain)
        and (
            hostname == mail_domain
            or hostname.endswith(f".{mail_domain}")
        ),
        "hostname and mailDomain",
    )
    public_url = policy.get("publicUrl")
    parsed = urlsplit(public_url) if isinstance(public_url, str) else None
    _require(
        parsed is not None
        and parsed.scheme == "https"
        and parsed.netloc == hostname
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
        and public_url == f"https://{hostname}",
        "publicUrl",
    )
    _validate_deployment(policy)
    _require(
        policy.get("bootstrap")
        == {
            "requestTlsCertificate": False,
            "certificateHolder": "caddy",
            "generateDkimKeys": False,
        },
        "bootstrap",
    )
    _require(policy.get("frontProxy") == EXPECTED_FRONT_PROXY, "frontProxy")
    _require(policy.get("listeners") == EXPECTED_LISTENERS, "listeners")
    _require(policy.get("singletons") == EXPECTED_SINGLETONS, "singletons")
    _require(policy.get("senderPolicy") == {"systemScript": EXPECTED_SCRIPT}, "senderPolicy")
    _require(policy.get("localDomainPolicy") == EXPECTED_DOMAIN_POLICY, "localDomainPolicy")
    _require(policy.get("eventLevels") == [{"event": "auth.failed", "level": "info"}], "eventLevels")
    _require(policy.get("webUi") == EXPECTED_WEB_UI, "webUi")

    bot_key = policy.get("botApiKey")
    _require(isinstance(bot_key, dict), "botApiKey")
    permissions = bot_key.get("permissions")
    _require(isinstance(permissions, list) and set(permissions) == EXPECTED_PERMISSIONS, "botApiKey.permissions")
    _require(len(permissions) == len(EXPECTED_PERMISSIONS), "botApiKey.permissions duplicates")
    _require(bot_key.get("permissionsType") == "Replace", "botApiKey.permissionsType")
    forbidden = set(bot_key.get("forbidden", []))
    _require(
        forbidden
        == {"admin", "administrator", "fetchAnyBlob", "impersonate", "unlimitedRequests", "unlimitedUploads"},
        "botApiKey.forbidden",
    )
    _require(bot_key.get("forbiddenPrefixes") == ["sys"], "botApiKey.forbiddenPrefixes")
    _require(not any(name in forbidden or name.startswith("sys") for name in permissions), "botApiKey scope")

    _require(policy.get("accountQuotas") == EXPECTED_QUOTAS, "accountQuotas")
    _require(policy.get("serviceLimits") == EXPECTED_SERVICE_LIMITS, "serviceLimits")
    _require(policy.get("dns") == {"publishMx": False}, "dns")

    return {
        "stalwart_listeners": 2,
        "caddy_public_https": 1,
        "stalwart_public": 0,
        "bot_permissions": len(permissions),
        "public_routes": len(EXPECTED_ROUTES),
    }


def build_management_calls(
    policy: dict[str, Any],
    *,
    current_listener_ids: Iterable[str],
    current_event_ids: Iterable[str],
    current_script_ids: Iterable[str],
    current_application_ids: Iterable[str],
    domain_id: str,
) -> list[tuple[str, dict[str, Any], str]]:
    validate_policy(policy)
    _require(isinstance(domain_id, str) and bool(domain_id), "domain id")
    application_ids = sorted(current_application_ids)
    _require(bool(application_ids), "application ids")
    calls: list[tuple[str, dict[str, Any], str]] = []
    for name in EXPECTED_SINGLETONS:
        calls.append((f"x:{name}/set", {"update": {"singleton": policy["singletons"][name]}}, f"set-{name}"))

    calls.append(
        (
            "x:EventTracingLevel/set",
            {
                "create": {"auth-failed-info": policy["eventLevels"][0]},
                "destroy": sorted(current_event_ids),
            },
            "set-event-levels",
        )
    )
    calls.append(
        (
            "x:SieveSystemScript/set",
            {
                "create": {"from-match": policy["senderPolicy"]["systemScript"]},
                "destroy": sorted(current_script_ids),
            },
            "set-sender-script",
        )
    )
    calls.append(
        (
            "x:Domain/set",
            {"update": {domain_id: policy["localDomainPolicy"]}},
            "set-local-domain",
        )
    )

    calls.append(
        (
            "x:Application/set",
            {
                "update": {
                    application_id: dict(policy["webUi"])
                    for application_id in application_ids
                },
            },
            "set-web-ui",
        )
    )
    listeners = {
        listener["name"]: listener_settings(policy, listener)
        for listener in policy["listeners"]
    }
    calls.append(
        (
            "x:NetworkListener/set",
            {"create": listeners, "destroy": sorted(current_listener_ids)},
            "set-listeners",
        )
    )
    return calls


def build_caddyfile(
    policy: dict[str, Any],
    *,
    chat_block: dict[str, Any] | None = None,
    enable_chat: bool = False,
) -> str:
    validate_policy(policy)
    if chat_block is not None:
        _require(chat_block == EXPECTED_CHAT_BLOCK, "chat route block")
    _require(not enable_chat or chat_block is not None, "chat route enablement")
    proxy = policy["frontProxy"]
    upstreams = {
        name: endpoint_address(policy, name)
        for name in ("stalwart", "join", "approval")
    }
    lines = [
        "{",
        "    auto_https disable_redirects",
        "}",
        "",
        f"https://{policy['hostname']}:{_endpoint(policy, 'caddy')['port']} {{",
        "    tls {",
        "        issuer acme {",
        "            disable_http_challenge",
        "        }",
        "    }",
        '    header Strict-Transport-Security "max-age=31536000; includeSubDomains"',
        "",
        "    route {",
    ]
    for route in proxy["routes"]:
        lines.extend(
            [
                f"        @{route['matcher']} {{",
                f"            method {' '.join(route['methods'])}",
                f"            path {route['path']}",
                "        }",
                f"        handle @{route['matcher']} {{",
            ]
        )
        if "maxBody" in route:
            lines.extend(
                [
                    "            request_body {",
                    f"                max_size {route['maxBody']}",
                    "            }",
                ]
            )
        lines.append(f"            reverse_proxy {upstreams[route['upstream']]} {{")
        if route["upstream"] == "stalwart":
            lines.extend(
                [
                    "                transport http {",
                    "                    proxy_protocol v2",
                    "                }",
                ]
            )
        else:
            lines.extend(
                [
                    "                header_up X-Forwarded-For {remote_host}",
                    "                header_up X-Forwarded-Proto https",
                    f"                header_up X-Forwarded-Host {policy['hostname']}",
                ]
            )
        lines.extend(["            }", "        }", ""])
    if enable_chat:
        assert chat_block is not None
        for route in chat_block["routes"]:
            lines.extend(
                [
                    f"        @{route['matcher']} {{",
                    f"            method {' '.join(route['methods'])}",
                    f"            path {' '.join(route['paths'])}",
                    "        }",
                    f"        handle @{route['matcher']} {{",
                ]
            )
            if "maxBody" in route:
                lines.extend(
                    [
                        "            request_body {",
                        f"                max_size {route['maxBody']}",
                        "            }",
                    ]
                )
            lines.extend(
                [
                    f"            reverse_proxy {chat_block['upstream']} {{",
                    "                header_up X-Forwarded-For {remote_host}",
                    "                header_up X-Forwarded-Proto https",
                    f"                header_up X-Forwarded-Host {policy['hostname']}",
                    "            }",
                    "        }",
                    "",
                ]
            )

    known_paths = list(
        dict.fromkeys(
            [
                *(route["path"] for route in proxy["routes"]),
                *(
                    path
                    for route in (
                        chat_block["routes"]
                        if enable_chat and chat_block is not None
                        else []
                    )
                    for path in route["paths"]
                ),
            ]
        )
    )
    lines.extend(
        [
            "        @known_public_path {",
            f"            path {' '.join(known_paths)}",
            "        }",
            "        respond @known_public_path 405",
            "        respond 404",
            "    }",
            "}",
            "",
        ]
    )
    return "\n".join(lines)


def verify_readback(
    policy: dict[str, Any],
    readback: dict[str, Any],
) -> None:
    validate_policy(policy)
    for name, expected in policy["singletons"].items():
        actual = readback.get(name)
        _require(
            isinstance(actual, dict)
            and all(actual.get(field) == value for field, value in expected.items()),
            f"readback {name}",
        )

    events = readback.get("EventTracingLevel")
    _require(isinstance(events, list) and len(events) == 1, "readback EventTracingLevel")
    _require(
        {field: events[0].get(field) for field in ("event", "level")} == policy["eventLevels"][0],
        "readback EventTracingLevel",
    )

    scripts = readback.get("SieveSystemScript")
    _require(isinstance(scripts, list) and len(scripts) == 1, "readback SieveSystemScript")
    _require(
        {field: scripts[0].get(field) for field in EXPECTED_SCRIPT} == EXPECTED_SCRIPT,
        "readback SieveSystemScript",
    )

    domain = readback.get("Domain")
    _require(isinstance(domain, dict) and domain.get("name") == policy["mailDomain"], "readback Domain")
    _require(
        {field: domain.get(field) for field in EXPECTED_DOMAIN_POLICY} == EXPECTED_DOMAIN_POLICY,
        "readback Domain",
    )

    applications = readback.get("Application")
    _require(
        isinstance(applications, list)
        and bool(applications)
        and all(
            all(item.get(field) == value for field, value in policy["webUi"].items())
            for item in applications
        ),
        "readback Application",
    )

    expected_listeners = [
        listener_settings(policy, listener)
        for listener in policy["listeners"]
    ]
    listeners = readback.get("NetworkListener")
    _require(isinstance(listeners, list) and len(listeners) == 2, "readback NetworkListener")
    fields = (
        "name",
        "bind",
        "protocol",
        "useTls",
        "implicitTls",
        "maxConnections",
        "overrideProxyTrustedNetworks",
    )
    projected = [
        {
            field: (
                normalized_network_map(listener.get(field))
                if field == "overrideProxyTrustedNetworks"
                else listener.get(field)
            )
            for field in fields
        }
        for listener in listeners
    ]
    normalized_expected = [
        {
            **listener,
            "overrideProxyTrustedNetworks": normalized_network_map(
                listener["overrideProxyTrustedNetworks"]
            ),
        }
        for listener in expected_listeners
    ]
    _require(
        sorted(projected, key=lambda listener: listener["name"])
        == sorted(normalized_expected, key=lambda listener: listener["name"]),
        "readback NetworkListener",
    )


def write_caddyfile(
    policy_path: str | Path,
    output_path: str | Path,
    *,
    enable_chat: bool = False,
    chat_block_path: str | Path | None = None,
) -> None:
    policy_source = Path(policy_path)
    block_source = (
        Path(chat_block_path)
        if chat_block_path is not None
        else policy_source.parent / "chat-route-block.json"
    )
    block = load_chat_block(block_source)
    content = build_caddyfile(
        load_policy(policy_source),
        chat_block=block,
        enable_chat=enable_chat,
    ).encode("utf-8")
    descriptor = os.open(
        output_path,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | os.O_NOFOLLOW
        | os.O_CLOEXEC,
        0o600,
    )
    try:
        offset = 0
        while offset < len(content):
            written = os.write(descriptor, content[offset:])
            if written <= 0:
                raise PolicyError("Caddyfile write did not progress")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 2:
        write_caddyfile(args[0], args[1])
    elif len(args) == 4 and args[2] == "--enable-chat":
        write_caddyfile(
            args[0],
            args[1],
            enable_chat=True,
            chat_block_path=args[3],
        )
    else:
        raise PolicyError(
            "expected POLICY OUTPUT [--enable-chat CHAT_BLOCK]"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("Caddyfile render refused safely\n")
        raise SystemExit(1)
