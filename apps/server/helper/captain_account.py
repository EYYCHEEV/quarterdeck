from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any, BinaryIO, Callable

import management_transport
import stalwart_admin


KEY_PATH = Path("/run/quarterdeck-captain-mail/captain.key")
IDS_PATH = Path("/var/lib/quarterdeck-captain/captain-ids.json")
READBACK_PATH = Path("/var/lib/quarterdeck-captain/key-readback.json")
REGISTRY_PATH = Path("/var/lib/quarterdeck-captain/project-registry.json")
HELPER_RUNTIME_PATH = Path("/var/lib/quarterdeck-helper/runtime.json")
MAX_JSON_BYTES = 65_536
MAX_NAME_BYTES = 64
MAX_KEY_BYTES = 512
SERVER_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


class CaptainAccountRefused(RuntimeError):
    pass


def _refuse() -> CaptainAccountRefused:
    return CaptainAccountRefused("Captain account action refused")


def _clear(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)
        value.clear()


def _is_tty(stream: object) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, OSError):
        return False


def _private_directory(path: Path) -> None:
    try:
        metadata = path.stat(follow_symlinks=False)
    except OSError:
        raise _refuse() from None
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise _refuse()


def _private_file(path: Path) -> None:
    _private_directory(path.parent)
    try:
        metadata = path.stat(follow_symlinks=False)
    except OSError:
        raise _refuse() from None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise _refuse()


def _read_private_json(path: Path) -> dict[str, Any]:
    _private_directory(path.parent)
    descriptor: int | None = None
    content = bytearray()
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise _refuse()
        while len(content) <= MAX_JSON_BYTES:
            chunk = os.read(
                descriptor,
                min(4096, MAX_JSON_BYTES + 1 - len(content)),
            )
            if not chunk:
                break
            content.extend(chunk)
        if not content or len(content) > MAX_JSON_BYTES:
            raise _refuse()
        try:
            document = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise _refuse() from None
        if not isinstance(document, dict):
            raise _refuse()
        return document
    except CaptainAccountRefused:
        raise
    except OSError:
        raise _refuse() from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        _clear(content)


def _registry_name(path: Path) -> str:
    document = _read_private_json(path)
    if (
        set(document) != {"format", "steward", "captain", "projects"}
        or document.get("format") != 1
    ):
        raise _refuse()
    steward = document.get("steward")
    captain = document.get("captain")
    projects = document.get("projects")
    if (
        not isinstance(steward, str)
        or stalwart_admin.BOT_NAME.fullmatch(steward) is None
        or not isinstance(captain, str)
        or stalwart_admin.BOT_NAME.fullmatch(captain) is None
        or captain == steward
        or not isinstance(projects, dict)
        or any(
            not isinstance(project, str)
            or not project.strip()
            or "\n" in project
            or "\r" in project
            or not isinstance(lead, str)
            or stalwart_admin.BOT_NAME.fullmatch(lead) is None
            for project, lead in projects.items()
        )
    ):
        raise _refuse()
    return captain


def _must_be_absent(path: Path) -> None:
    _private_directory(path.parent)
    try:
        path.stat(follow_symlinks=False)
    except FileNotFoundError:
        return
    except OSError:
        raise _refuse() from None
    raise _refuse()


def _read_bounded(source: BinaryIO, limit: int) -> bytearray:
    content = bytearray()
    try:
        chunk = source.read(limit + 1)
        if not isinstance(chunk, bytes):
            raise _refuse()
        content.extend(chunk)
        if not content or len(content) > limit:
            raise _refuse()
        return content
    except Exception:
        _clear(content)
        raise


def _name(source: BinaryIO) -> str:
    content = _read_bounded(source, MAX_NAME_BYTES + 1)
    try:
        if content[-1] != 0x0A or b"\n" in content[:-1] or b"\r" in content:
            raise _refuse()
        try:
            value = bytes(content[:-1]).decode("ascii")
        except UnicodeDecodeError:
            raise _refuse() from None
        if stalwart_admin.BOT_NAME.fullmatch(value) is None:
            raise _refuse()
        return value
    finally:
        _clear(content)


def _name_key_and_ids(
    source: BinaryIO,
) -> tuple[str, bytearray, str, str]:
    content = _read_bounded(
        source,
        MAX_NAME_BYTES + MAX_KEY_BYTES + 128 + 4,
    )
    key: bytearray | None = None
    try:
        if (
            content[-1] != 0x0A
            or content.count(0x0A) != 4
            or b"\r" in content
        ):
            raise _refuse()
        name_bytes, key_bytes, account_bytes, key_id_bytes, empty = (
            content.split(b"\n")
        )
        if empty:
            raise _refuse()
        try:
            name = bytes(name_bytes).decode("ascii")
            account_id = bytes(account_bytes).decode("ascii")
            key_id = bytes(key_id_bytes).decode("ascii")
        except UnicodeDecodeError:
            raise _refuse() from None
        key = bytearray(key_bytes)
        if (
            stalwart_admin.BOT_NAME.fullmatch(name) is None
            or stalwart_admin.API_KEY.fullmatch(key) is None
            or SERVER_ID.fullmatch(account_id) is None
            or SERVER_ID.fullmatch(key_id) is None
        ):
            raise _refuse()
        result = key
        key = None
        return name, result, account_id, key_id
    finally:
        _clear(key)
        _clear(content)


def _name_and_ids(source: BinaryIO) -> tuple[str, str, str]:
    content = _read_bounded(source, MAX_NAME_BYTES + 128 + 3)
    try:
        if (
            content[-1] != 0x0A
            or content.count(0x0A) != 3
            or b"\r" in content
        ):
            raise _refuse()
        name_bytes, account_bytes, key_id_bytes, empty = content.split(
            b"\n"
        )
        if empty:
            raise _refuse()
        try:
            name = bytes(name_bytes).decode("ascii")
            account_id = bytes(account_bytes).decode("ascii")
            key_id = bytes(key_id_bytes).decode("ascii")
        except UnicodeDecodeError:
            raise _refuse() from None
        if (
            stalwart_admin.BOT_NAME.fullmatch(name) is None
            or SERVER_ID.fullmatch(account_id) is None
            or SERVER_ID.fullmatch(key_id) is None
        ):
            raise _refuse()
        return name, account_id, key_id
    finally:
        _clear(content)


def _json_line(source: BinaryIO) -> dict[str, Any]:
    content = _read_bounded(source, MAX_JSON_BYTES)
    try:
        if content[-1] != 0x0A or b"\n" in content[:-1] or b"\r" in content:
            raise _refuse()
        try:
            document = json.loads(content[:-1])
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise _refuse() from None
        if not isinstance(document, dict):
            raise _refuse()
        return document
    finally:
        _clear(content)


def _emit(destination: BinaryIO, content: bytes | bytearray) -> None:
    offset = 0
    with memoryview(content) as view:
        while offset < len(content):
            written = destination.write(view[offset:])
            if not isinstance(written, int) or written <= 0:
                raise _refuse()
            offset += written
    destination.flush()


def _write_all(descriptor: int, content: bytearray) -> None:
    offset = 0
    with memoryview(content) as view:
        while offset < len(content):
            written = os.write(descriptor, view[offset:])
            if written <= 0:
                raise _refuse()
            offset += written


def _write_new(path: Path, content: bytearray) -> None:
    _private_directory(path.parent)
    old_umask = os.umask(0o077)
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_NOFOLLOW
            | os.O_CLOEXEC,
            0o600,
        )
    except OSError:
        raise _refuse() from None
    finally:
        os.umask(old_umask)
    try:
        _write_all(descriptor, content)
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise _refuse()
    except CaptainAccountRefused:
        raise
    except OSError:
        raise _refuse() from None
    finally:
        os.close(descriptor)
    parent = os.open(
        path.parent,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    try:
        os.fsync(parent)
    except OSError:
        raise _refuse() from None
    finally:
        os.close(parent)


def _stored_ids(path: Path, name: str) -> tuple[str, str]:
    document = _read_private_json(path)
    if (
        set(document)
        != {"format", "account", "accountId", "keyId"}
        or document.get("format") != 1
        or document.get("account") != name
    ):
        raise _refuse()
    account_id = document.get("accountId")
    key_id = document.get("keyId")
    if (
        not isinstance(account_id, str)
        or SERVER_ID.fullmatch(account_id) is None
        or not isinstance(key_id, str)
        or SERVER_ID.fullmatch(key_id) is None
    ):
        raise _refuse()
    return account_id, key_id


def _prepare(
    registry_path: Path,
    key_path: Path,
    ids_path: Path,
    readback_path: Path,
    *,
    name_only: bool,
) -> tuple[str, str | None, str | None]:
    name = _registry_name(registry_path)
    if name_only:
        _private_file(key_path)
        account_id, key_id = _stored_ids(ids_path, name)
        _must_be_absent(readback_path)
        return name, account_id, key_id
    _must_be_absent(key_path)
    _must_be_absent(ids_path)
    _must_be_absent(readback_path)
    return name, None, None


def _load_admin(runtime_path: Path) -> stalwart_admin.StalwartAdmin:
    runtime = _read_private_json(runtime_path)
    if (
        set(runtime)
        != {
            "format",
            "socket",
            "joinUid",
            "paths",
            "management",
            "mailDomain",
            "sessionUrl",
        }
        or runtime.get("format") != 1
        or not isinstance(runtime.get("paths"), dict)
        or set(runtime["paths"]) != {"ledger", "keys", "adminSecret"}
        or not isinstance(runtime.get("management"), dict)
        or set(runtime["management"]) != {"username", "address", "port"}
    ):
        raise _refuse()
    paths = runtime["paths"]
    management = runtime["management"]
    username = management.get("username")
    address = management.get("address")
    port = management.get("port")
    domain = runtime.get("mailDomain")
    admin_secret = paths.get("adminSecret")
    try:
        parsed_address = ipaddress.ip_address(address)
    except (TypeError, ValueError):
        raise _refuse() from None
    if (
        not isinstance(username, str)
        or not username
        or not isinstance(admin_secret, str)
        or not Path(admin_secret).is_absolute()
        or not isinstance(port, int)
        or isinstance(port, bool)
        or not 1024 <= port <= 65_535
        or not parsed_address.is_loopback
        or not isinstance(domain, str)
        or re.fullmatch(r"[A-Za-z0-9.-]{1,253}", domain) is None
    ):
        raise _refuse()
    secret_reader = management_transport.PrivateSecretFile(admin_secret)
    transport = management_transport.ManagementTransport(
        username,
        secret_reader,
        connection_factory=lambda: http.client.HTTPConnection(
            str(parsed_address),
            port,
            timeout=15,
        ),
    )
    return stalwart_admin.StalwartAdmin(transport, domain)




def _rate_limit(admin: Any) -> int:
    response = admin.transport.call(
        "x:Http/get",
        {
            "ids": ["singleton"],
            "properties": ["id", "rateLimitAuthenticated"],
        },
        "captain-rate-readback",
    )
    objects = response.get("list") if isinstance(response, dict) else None
    if (
        not isinstance(objects, list)
        or len(objects) != 1
        or not isinstance(objects[0], dict)
    ):
        raise _refuse()
    rate = objects[0].get("rateLimitAuthenticated")
    if not isinstance(rate, dict) or set(rate) != {"count", "period"}:
        raise _refuse()
    count = rate.get("count")
    if (
        not isinstance(count, int)
        or isinstance(count, bool)
        or not 1 <= count <= 120
        or rate.get("period") != 60_000
    ):
        raise _refuse()
    return count


def _live_readback(
    admin: Any,
    name: str,
    account_id: str,
    key_id: str,
    count: int,
) -> dict[str, Any]:
    account_response = admin.transport.call(
        "x:Account/get",
        {
            "ids": [account_id],
            "properties": ["id", "name", "roles", "permissions", "quotas", "encryptionAtRest"],
        },
        "captain-account-readback",
    )
    key_response = admin.transport.call(
        "x:ApiKey/get",
        {
            "accountId": account_id,
            "ids": [key_id],
            "properties": ["id", "description", "permissions", "allowedIps"],
        },
        "captain-key-readback",
    )
    accounts = (
        account_response.get("list")
        if isinstance(account_response, dict)
        else None
    )
    keys = (
        key_response.get("list")
        if isinstance(key_response, dict)
        else None
    )
    if (
        not isinstance(accounts, list)
        or len(accounts) != 1
        or not isinstance(accounts[0], dict)
        or not isinstance(keys, list)
        or len(keys) != 1
        or not isinstance(keys[0], dict)
    ):
        raise _refuse()
    account = accounts[0]
    key = keys[0]
    if (
        account.get("id") != account_id
        or account.get("name") != name
        or account.get("roles") != {"@type": "User"}
        or key.get("id") != key_id
    ):
        raise _refuse()
    account_permission_value = account.get("permissions")
    key_permission_value = key.get("permissions")
    if (
        not stalwart_admin._permissions_are(account_permission_value, True)
        or not stalwart_admin._key_permissions_are(key_permission_value, True)
    ):
        raise _refuse()
    account_permissions = stalwart_admin.members(
        account_permission_value.get("enabledPermissions")
    )
    key_permissions = stalwart_admin.members(
        key_permission_value.get("permissions")
    )
    expected = set(stalwart_admin.ALLOWED_PERMISSIONS)
    all_permissions = account_permissions | key_permissions
    forbidden = set(stalwart_admin.FORBIDDEN_PERMISSIONS)
    administrator = account.get("roles") != {"@type": "User"} or bool(
        all_permissions & {"admin", "administrator"}
    )
    impersonation = "impersonate" in all_permissions
    if (
        account_permissions != expected
        or key_permissions != expected
        or all_permissions & forbidden
        or any(permission.startswith("sys") for permission in all_permissions)
    ):
        raise _refuse()
    return {
        "account": name,
        "mailbox": name,
        "permissions": sorted(key_permissions),
        "administrator": administrator,
        "impersonation": impersonation,
        "requestsPerMinute": count,
    }


def _create(admin: Any, name: str, destination: BinaryIO) -> None:
    secret: bytearray | None = None
    payload: bytearray | None = None
    try:
        account_id = admin.create_account(name)
        key_id, secret = admin.create_key(account_id)
        if (
            not isinstance(account_id, str)
            or SERVER_ID.fullmatch(account_id) is None
            or not isinstance(key_id, str)
            or SERVER_ID.fullmatch(key_id) is None
        ):
            raise _refuse()
        admin.verify_account(account_id, name, False)
        admin.verify_key(account_id, key_id, False)
        if stalwart_admin.API_KEY.fullmatch(secret) is None:
            raise _refuse()
        payload = bytearray(name.encode("ascii") + b"\n")
        payload.extend(secret)
        payload.extend(
            f"\n{account_id}\n{key_id}\n".encode("ascii")
        )
        _emit(destination, payload)
    finally:
        _clear(payload)
        _clear(secret)


def _place(
    registry_path: Path,
    key_path: Path,
    ids_path: Path,
    source: BinaryIO,
) -> int:
    key: bytearray | None = None
    key_payload: bytearray | None = None
    ids_payload: bytearray | None = None
    try:
        name, key, account_id, key_id = _name_key_and_ids(source)
        if name != _registry_name(registry_path):
            raise _refuse()
        size = len(key)
        key_payload = bytearray(key)
        key_payload.extend(b"\n")
        ids_payload = bytearray(
            json.dumps(
                {
                    "format": 1,
                    "account": name,
                    "accountId": account_id,
                    "keyId": key_id,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            + b"\n"
        )
        _write_new(key_path, key_payload)
        _write_new(ids_path, ids_payload)
        return size
    finally:
        _clear(ids_payload)
        _clear(key_payload)
        _clear(key)


def _activate(
    admin: Any,
    name: str,
    account_id: str,
    key_id: str,
) -> dict[str, Any]:
    admin.verify_account(account_id, name, False)
    admin.verify_key(account_id, key_id, False)
    count = _rate_limit(admin)
    admin.activate_account(account_id)
    admin.activate_key(account_id, key_id)
    admin.verify_account(account_id, name, True)
    admin.verify_key(account_id, key_id, True)
    return _live_readback(admin, name, account_id, key_id, count)


def _readback(
    registry_path: Path,
    readback_path: Path,
    source: BinaryIO,
    verifier: Callable[[dict[str, Any], str], None] | None,
) -> None:
    document = _json_line(source)
    name = _registry_name(registry_path)
    if verifier is None:
        import security

        verifier = security.verify_key_readback
    try:
        verifier(document, name)
    except Exception:
        raise _refuse() from None
    try:
        serialized = json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
    except (TypeError, ValueError):
        raise _refuse() from None
    payload = bytearray(serialized)
    try:
        _write_new(readback_path, payload)
    finally:
        _clear(payload)


def _revoke(
    admin: Any,
    name: str,
    account_id: str,
    key_id: str,
) -> None:
    admin.verify_account(account_id, name, False)
    admin.verify_key(account_id, key_id, False)
    admin.revoke_key(account_id, key_id)


def run(
    mode: str,
    *,
    name_only: bool,
    key_path: Path = KEY_PATH,
    ids_path: Path = IDS_PATH,
    readback_path: Path = READBACK_PATH,
    registry_path: Path = REGISTRY_PATH,
    runtime_path: Path = HELPER_RUNTIME_PATH,
    stdin: BinaryIO,
    stdout: BinaryIO,
    stderr: BinaryIO,
    admin_factory: Callable[[Path], Any] | None = None,
    readback_verifier: Callable[[dict[str, Any], str], None] | None = None,
) -> int:
    try:
        if _is_tty(stdin) or _is_tty(stdout):
            raise _refuse()
        if mode not in {"prepare", "create", "place", "activate", "readback", "revoke"}:
            raise _refuse()
        if name_only and mode != "prepare":
            raise _refuse()
        factory = admin_factory or _load_admin
        if mode == "prepare":
            name, account_id, key_id = _prepare(
                Path(registry_path),
                Path(key_path),
                Path(ids_path),
                Path(readback_path),
                name_only=name_only,
            )
            payload = name + "\n"
            if name_only:
                payload += f"{account_id}\n{key_id}\n"
            _emit(stdout, payload.encode("ascii"))
        elif mode == "create":
            _create(factory(Path(runtime_path)), _name(stdin), stdout)
        elif mode == "place":
            size = _place(
                Path(registry_path),
                Path(key_path),
                Path(ids_path),
                stdin,
            )
            _emit(stdout, f"KEY_PLACED bytes={size}\n".encode("ascii"))
        elif mode == "activate":
            name, account_id, key_id = _name_and_ids(stdin)
            document = _activate(
                factory(Path(runtime_path)),
                name,
                account_id,
                key_id,
            )
            _emit(
                stdout,
                json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
                + b"\n",
            )
        elif mode == "readback":
            _readback(
                Path(registry_path),
                Path(readback_path),
                stdin,
                readback_verifier,
            )
            _emit(stdout, b"READBACK_WRITTEN\n")
        else:
            name, account_id, key_id = _name_and_ids(stdin)
            _revoke(
                factory(Path(runtime_path)),
                name,
                account_id,
                key_id,
            )
            _emit(stdout, b"KEY_REVOKED\n")
        return 0
    except Exception:
        try:
            _emit(stderr, b"CAPTAIN_ACCOUNT_REFUSED\n")
        except Exception:
            pass
        return 2


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    name_only = arguments == ["prepare", "--name-only"]
    if name_only:
        mode = "prepare"
    elif len(arguments) == 1:
        mode = arguments[0]
    else:
        return 2
    return run(
        mode,
        name_only=name_only,
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=sys.stderr.buffer,
    )


if __name__ == "__main__":
    raise SystemExit(main())
