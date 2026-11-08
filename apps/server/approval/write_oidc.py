from __future__ import annotations

import hmac
import json
import os
import stat
import sys
from pathlib import Path
from typing import BinaryIO, Callable, TextIO

import oidc


CONFIG_PATH = Path("/var/lib/quarterdeck-approval/oidc.json")
RUNTIME_PATH = Path("/var/lib/quarterdeck-approval/runtime.json")
PUBLIC_PATH = Path(__file__).with_name("oidc-public.json")
MAX_EMAIL_BYTES = 254
MAX_JSON_BYTES = 65_536
CONFIG_KEYS = {
    "format",
    "clientId",
    "clientSecret",
    "allowedEmail",
    "redirectUri",
    "sessionKeyHex",
}


class OidcWriterRefused(RuntimeError):
    pass


def _refuse() -> OidcWriterRefused:
    return OidcWriterRefused("OIDC configuration refused")


def _clear(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)
        value.clear()


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


def _read_json(path: Path, *, private: bool) -> dict[str, object]:
    content = bytearray()
    descriptor: int | None = None
    try:
        if private:
            _private_directory(path.parent)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or (
                private
                and (
                    metadata.st_uid != os.getuid()
                    or stat.S_IMODE(metadata.st_mode) != 0o600
                )
            )
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
    except OidcWriterRefused:
        raise
    except OSError:
        raise _refuse() from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        _clear(content)


def _runtime_redirect(
    path: Path,
    config_path: Path,
    pinned_redirect: str,
) -> str:
    document = _read_json(path, private=True)
    paths = document.get("paths")
    origin = document.get("publicOrigin")
    if (
        document.get("format") != 1
        or not isinstance(paths, dict)
        or paths.get("oidc") != str(config_path)
        or not isinstance(origin, str)
        or not origin
    ):
        raise _refuse()
    redirect = origin + "/captain/oidc/callback"
    if not hmac.compare_digest(redirect, pinned_redirect):
        raise _refuse()
    return redirect


def _public_config(path: Path) -> tuple[str, str]:
    document = _read_json(path, private=False)
    if (
        set(document) != {"format", "clientId", "redirectUri"}
        or document.get("format") != 1
    ):
        raise _refuse()
    client_id = document.get("clientId")
    redirect = document.get("redirectUri")
    if (
        not isinstance(client_id, str)
        or oidc.SAFE_CLIENT_ID.fullmatch(client_id) is None
        or not isinstance(redirect, str)
        or not redirect
        or any(ord(character) < 0x20 or ord(character) > 0x7E for character in redirect)
    ):
        raise _refuse()
    return client_id, redirect


def _one_email(source: BinaryIO) -> str:
    content = bytearray()
    try:
        chunk = source.read(MAX_EMAIL_BYTES + 2)
        if not isinstance(chunk, bytes):
            raise _refuse()
        content.extend(chunk)
        if not content or len(content) > MAX_EMAIL_BYTES + 1 or b"\r" in content:
            raise _refuse()
        if content[-1] == 0x0A:
            email_bytes = content[:-1]
        else:
            email_bytes = content
        if (
            not 1 <= len(email_bytes) <= MAX_EMAIL_BYTES
            or b"\n" in email_bytes
        ):
            raise _refuse()
        try:
            email = bytes(email_bytes).decode("ascii")
        except UnicodeDecodeError:
            raise _refuse() from None
        if oidc.SAFE_EMAIL.fullmatch(email) is None:
            raise _refuse()
        return email
    finally:
        _clear(content)


def _payload(
    client_id: str,
    email: str,
    redirect: str,
    session_key: bytearray,
) -> bytearray:
    if len(session_key) != 32:
        raise _refuse()
    session_hex = bytearray(session_key.hex().encode("ascii"))
    payload = bytearray()
    try:
        payload.extend(b'{\n  "format": 1,\n  "clientId": ')
        payload.extend(json.dumps(client_id).encode("ascii"))
        payload.extend(b',\n  "clientSecret": "",\n  "allowedEmail": ')
        payload.extend(json.dumps(email).encode("ascii"))
        payload.extend(b',\n  "redirectUri": ')
        payload.extend(json.dumps(redirect).encode("ascii"))
        payload.extend(b',\n  "sessionKeyHex": "')
        payload.extend(session_hex)
        payload.extend(b'"\n}\n')
        result = payload
        payload = bytearray()
        return result
    except (UnicodeEncodeError, ValueError):
        raise _refuse() from None
    finally:
        _clear(session_hex)
        _clear(payload)


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
    descriptor: int | None = None
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
    except OidcWriterRefused:
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


def write_config(
    config_path: Path,
    runtime_path: Path,
    public_path: Path,
    source: BinaryIO,
    random_bytes: Callable[[int], bytes],
) -> None:
    session_key: bytearray | None = None
    payload: bytearray | None = None
    try:
        email = _one_email(source)
        client_id, pinned_redirect = _public_config(public_path)
        redirect = _runtime_redirect(
            runtime_path,
            config_path,
            pinned_redirect,
        )
        generated = random_bytes(32)
        if not isinstance(generated, bytes):
            raise _refuse()
        session_key = bytearray(generated)
        payload = _payload(client_id, email, redirect, session_key)
        _write_new(config_path, payload)
    finally:
        _clear(payload)
        _clear(session_key)


def check_email(config_path: Path, source: BinaryIO) -> bool:
    email = _one_email(source)
    document = _read_json(config_path, private=True)
    if (
        set(document) != CONFIG_KEYS
        or document.get("format") != 1
        or any(
            not isinstance(document.get(name), str)
            for name in CONFIG_KEYS - {"format"}
        )
    ):
        raise _refuse()
    allowed = document["allowedEmail"]
    return hmac.compare_digest(email, allowed)


def _is_tty(stream: object) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, OSError):
        return False


def run(
    mode: str,
    *,
    config_path: Path = CONFIG_PATH,
    runtime_path: Path = RUNTIME_PATH,
    public_path: Path = PUBLIC_PATH,
    stdin: BinaryIO,
    stdout: TextIO,
    stderr: TextIO,
    random_bytes: Callable[[int], bytes] = os.urandom,
) -> int:
    try:
        if mode not in {"write", "check-email"} or _is_tty(stdin):
            raise _refuse()
        if mode == "write":
            write_config(
                Path(config_path),
                Path(runtime_path),
                Path(public_path),
                stdin,
                random_bytes,
            )
            stdout.write("OIDC_CONFIG_WRITTEN\n")
        else:
            matches = check_email(Path(config_path), stdin)
            stdout.write("EMAIL_MATCH\n" if matches else "EMAIL_MISMATCH\n")
        return 0
    except Exception:
        stderr.write("OIDC_CONFIG_REFUSED\n")
        return 2


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments == []:
        mode = "write"
    elif arguments == ["check-email"]:
        mode = "check-email"
    else:
        return 2
    return run(
        mode,
        stdin=sys.stdin.buffer,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )


if __name__ == "__main__":
    raise SystemExit(main())
