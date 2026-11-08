from __future__ import annotations

import base64
import copy
import hashlib
import http.client
import json
import os
import ipaddress
import stat
import sys
from pathlib import Path
from typing import Any

DOOR_DIRECTORY = Path(__file__).resolve().parents[1] / "door"
if str(DOOR_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(DOOR_DIRECTORY))

import door_policy
import recovery_launcher


SINGLETONS = (
    "Http",
    "Security",
    "Email",
    "Jmap",
    "Asn",
    "SpamSettings",
    "MtaStageRcpt",
    "MtaStageAuth",
    "MtaStageData",
)
REPLACED_COLLECTIONS = ("EventTracingLevel", "SieveSystemScript", "NetworkListener")
UPDATED_COLLECTIONS = ("Application",)
COLLECTIONS = REPLACED_COLLECTIONS + UPDATED_COLLECTIONS
OBJECTS = SINGLETONS + COLLECTIONS + ("Domain",)
MAX_RESPONSE_BYTES = 1_048_576


class FirstStartError(RuntimeError):
    pass


def _clear(value: bytearray) -> None:
    for index in range(len(value)):
        value[index] = 0


def _without_id(value: dict[str, Any]) -> dict[str, Any]:
    return {key: copy.deepcopy(item) for key, item in value.items() if key != "id"}


def _require_list(value: Any, name: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise FirstStartError(f"management readback for {name} is invalid")
    return copy.deepcopy(value)


def capture_state(client: Any) -> dict[str, list[dict[str, Any]]]:
    state: dict[str, list[dict[str, Any]]] = {}
    for name in OBJECTS:
        result = client.call(
            f"x:{name}/get",
            (
                {
                    "ids": ["singleton"],
                    "properties": ["id", *door_policy.EXPECTED_SINGLETONS[name]],
                }
                if name in SINGLETONS
                else {}
            ),
            f"snapshot-{name}",
        )
        if not isinstance(result, dict):
            raise FirstStartError(f"management readback for {name} is invalid")
        objects = _require_list(result.get("list"), name)
        if name in SINGLETONS and len(objects) != 1:
            raise FirstStartError(f"management readback for {name} is not a singleton")
        state[name] = objects
    return state


def _semantic_state(state: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    projected: dict[str, list[dict[str, Any]]] = {}
    for name, objects in state.items():
        values = [_without_id(item) for item in objects]
        projected[name] = sorted(values, key=lambda value: json.dumps(value, sort_keys=True, separators=(",", ":")))
    return projected


def _ids(objects: list[dict[str, Any]], name: str) -> list[str]:
    result = []
    for item in objects:
        object_id = item.get("id")
        if not isinstance(object_id, str) or not object_id:
            raise FirstStartError(f"management readback for {name} has no object id")
        result.append(object_id)
    return result


def _checked_set(client: Any, method: str, arguments: dict[str, Any], call_id: str) -> None:
    result = client.call(method, arguments, call_id)
    if not isinstance(result, dict):
        raise FirstStartError("management write returned an invalid result")
    if any(result.get(name) for name in ("notUpdated", "notCreated", "notDestroyed")):
        raise FirstStartError("management write rejected the exact settings")


def _find_domain(
    objects: list[dict[str, Any]],
    domain_name: str,
) -> dict[str, Any]:
    matches = [item for item in objects if item.get("name") == domain_name]
    if len(matches) != 1:
        raise FirstStartError("management readback does not contain exactly one mail domain")
    return matches[0]


def restore_state(
    client: Any,
    snapshot: dict[str, list[dict[str, Any]]],
    domain_name: str,
) -> None:
    for name in SINGLETONS:
        _checked_set(
            client,
            f"x:{name}/set",
            {"update": {"singleton": _without_id(snapshot[name][0])}},
            f"rollback-{name}",
        )
    for name in REPLACED_COLLECTIONS:
        current = capture_collection(client, name)
        arguments: dict[str, Any] = {
            "create": {
                f"restore-{index}": _without_id(item)
                for index, item in enumerate(snapshot[name])
            },
            "destroy": _ids(current, name),
        }
        _checked_set(client, f"x:{name}/set", arguments, f"rollback-{name}")
    for name in UPDATED_COLLECTIONS:
        updates = {
            item_id: _without_id(item)
            for item_id, item in zip(_ids(snapshot[name], name), snapshot[name])
        }
        if updates:
            _checked_set(
                client,
                f"x:{name}/set",
                {"update": updates},
                f"rollback-{name}",
            )
    previous_domain = _find_domain(snapshot["Domain"], domain_name)
    _checked_set(
        client,
        "x:Domain/set",
        {"update": {_ids([previous_domain], "Domain")[0]: _without_id(previous_domain)}},
        "rollback-Domain",
    )


def capture_collection(client: Any, name: str) -> list[dict[str, Any]]:
    result = client.call(f"x:{name}/get", {}, f"rollback-read-{name}")
    if not isinstance(result, dict):
        raise FirstStartError(f"management readback for {name} is invalid")
    return _require_list(result.get("list"), name)


def _verification_view(
    state: dict[str, list[dict[str, Any]]],
    domain_name: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in SINGLETONS:
        result[name] = _without_id(state[name][0])
    for name in COLLECTIONS:
        result[name] = [_without_id(item) for item in state[name]]
    result["Domain"] = _without_id(_find_domain(state["Domain"], domain_name))
    return result


def verify_installed(client: Any, policy: dict[str, Any]) -> None:
    state = capture_state(client)
    door_policy.verify_readback(
        policy,
        _verification_view(state, policy["mailDomain"]),
    )




def apply_policy(client: Any, policy: dict[str, Any]) -> dict[str, Any]:
    snapshot = capture_state(client)
    try:
        domain = _find_domain(snapshot["Domain"], policy["mailDomain"])
        calls = door_policy.build_management_calls(
            policy,
            current_listener_ids=_ids(
                snapshot["NetworkListener"],
                "NetworkListener",
            ),
            current_event_ids=_ids(
                snapshot["EventTracingLevel"],
                "EventTracingLevel",
            ),
            current_script_ids=_ids(
                snapshot["SieveSystemScript"],
                "SieveSystemScript",
            ),
            current_application_ids=_ids(
                snapshot["Application"],
                "Application",
            ),
            domain_id=_ids([domain], "Domain")[0],
        )
        for method, arguments, call_id in calls:
            _checked_set(client, method, arguments, call_id)
        verify_installed(client, policy)
    except Exception as original:
        try:
            restore_state(client, snapshot, policy["mailDomain"])
            restored = capture_state(client)
            if _semantic_state(restored) != _semantic_state(snapshot):
                raise FirstStartError("rollback readback differs from the previous settings")
        except Exception as rollback_error:
            raise FirstStartError("configuration failed and rollback was incomplete") from rollback_error
        raise FirstStartError("configuration failed; previous settings were restored") from original

    canonical = json.dumps(policy, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "format": 1,
        "managementWrites": len(calls),
        "policyCanonicalSha256": hashlib.sha256(canonical).hexdigest(),
        "readbackVerified": True,
    }


class RecoveryManagement:
    def __init__(self, password: bytearray, port: int = 18080):
        if not 1024 <= port <= 65535:
            raise FirstStartError("recovery port is outside the unprivileged range")
        self._password = password
        self._port = port

    def close(self) -> None:
        _clear(self._password)

    def call(self, method: str, arguments: dict[str, Any], call_id: str) -> dict[str, Any]:
        credential = bytearray(b"qd-recovery:")
        credential.extend(self._password)
        encoded = bytearray(base64.b64encode(credential))
        _clear(credential)
        authorization = "Basic " + encoded.decode("ascii")
        _clear(encoded)
        body = json.dumps(
            {
                "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
                "methodCalls": [[method, arguments, call_id]],
            },
            separators=(",", ":"),
        ).encode("utf-8")
        connection = http.client.HTTPConnection(str(ipaddress.IPv4Address(2_130_706_433)), self._port, timeout=15)
        try:
            connection.request(
                "POST",
                "/jmap",
                body=body,
                headers={"Authorization": authorization, "Content-Type": "application/json"},
            )
            response = connection.getresponse()
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
        finally:
            authorization = ""
            connection.close()
        if status != 200 or len(payload) > MAX_RESPONSE_BYTES:
            raise FirstStartError("management request failed")
        try:
            parsed = json.loads(payload)
        except (TypeError, ValueError) as exc:
            raise FirstStartError("management response is invalid") from exc
        responses = parsed.get("methodResponses") if isinstance(parsed, dict) else None
        if (
            not isinstance(responses, list)
            or len(responses) != 1
            or not isinstance(responses[0], list)
            or len(responses[0]) != 3
            or responses[0][0] != method
            or responses[0][2] != call_id
            or not isinstance(responses[0][1], dict)
        ):
            raise FirstStartError("management response did not match the request")
        return responses[0][1]


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise FirstStartError("evidence write did not progress")
        offset += written


def write_marker(path: str, policy_path: str, proof: dict[str, Any]) -> None:
    policy_bytes = Path(policy_path).read_bytes()
    marker = {
        "format": 1,
        "managementWrites": proof["managementWrites"],
        "policyCanonicalSha256": proof["policyCanonicalSha256"],
        "policySha256": hashlib.sha256(policy_bytes).hexdigest(),
        "readbackVerified": True,
        "recoveryPasswordRetired": True,
    }
    content = (json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        _write_all(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def retire_password(active_path: str, retired_path: str) -> None:
    if os.path.lexists(retired_path):
        raise FirstStartError("retired recovery path already exists")
    metadata = os.lstat(active_path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise FirstStartError("active recovery password file is unsafe")
    os.rename(active_path, retired_path)
    for directory_path in {os.path.dirname(active_path), os.path.dirname(retired_path)}:
        descriptor = os.open(directory_path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 5:
        raise FirstStartError("expected absolute POLICY PASSWORD RETIRED MARKER paths and PORT")
    policy_path, password_path, retired_path, marker_path, port_text = args
    if any(not os.path.isabs(value) for value in (policy_path, password_path, retired_path, marker_path)):
        raise FirstStartError("first-start file paths must be absolute")
    policy = door_policy.load_policy(policy_path)
    password = recovery_launcher.read_private_password(password_path)
    client = RecoveryManagement(password, int(port_text, 10))
    try:
        proof = apply_policy(client, policy)
        write_marker(marker_path, policy_path, proof)
        retire_password(password_path, retired_path)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("first-start configuration failed safely\n")
        raise SystemExit(1)
