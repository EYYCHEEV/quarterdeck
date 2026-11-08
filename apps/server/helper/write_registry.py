from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import BinaryIO, TextIO

import stalwart_admin


REGISTRY_PATH = Path("/var/lib/quarterdeck-captain/project-registry.json")
MAX_REGISTRY_BYTES = 65_536


class RegistryWriterRefused(RuntimeError):
    pass


def _refuse() -> RegistryWriterRefused:
    return RegistryWriterRefused("registry write refused")


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


def _is_tty(stream: object) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, OSError):
        return False


def _read_registry(source: BinaryIO) -> dict[str, object]:
    content = bytearray()
    try:
        chunk = source.read(MAX_REGISTRY_BYTES + 1)
        if not isinstance(chunk, bytes):
            raise _refuse()
        content.extend(chunk)
        if not content or len(content) > MAX_REGISTRY_BYTES:
            raise _refuse()
        try:
            document = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise _refuse() from None
        if not isinstance(document, dict):
            raise _refuse()
        return document
    finally:
        _clear(content)


def _validate(document: dict[str, object]) -> None:
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
        or steward == captain
        or not isinstance(projects, dict)
        or not projects
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
    except RegistryWriterRefused:
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


def write_registry(target_path: Path, source: BinaryIO) -> None:
    document = _read_registry(source)
    _validate(document)
    try:
        serialized = (
            json.dumps(document, indent=2, sort_keys=True).encode("utf-8")
            + b"\n"
        )
    except (TypeError, ValueError):
        raise _refuse() from None
    payload = bytearray(serialized)
    try:
        _write_new(target_path, payload)
    finally:
        _clear(payload)


def run(
    *,
    target_path: Path = REGISTRY_PATH,
    stdin: BinaryIO,
    stdout: TextIO,
    stderr: TextIO,
) -> int:
    try:
        if _is_tty(stdin):
            raise _refuse()
        write_registry(Path(target_path), stdin)
        stdout.write("REGISTRY_WRITTEN\n")
        return 0
    except Exception:
        stderr.write("REGISTRY_WRITE_REFUSED\n")
        return 2


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments:
        return 2
    return run(
        stdin=sys.stdin.buffer,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )


if __name__ == "__main__":
    raise SystemExit(main())
