from __future__ import annotations

import json
import os
import re
import stat
import sys
from pathlib import Path

from adapter_registry import RegistryFailure, load_target

MAX_API_KEY_BYTES = 512
API_KEY = re.compile(rb"API_[A-Za-z0-9_-]{20,508}\Z")
SAFE_NAME = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}\Z")


class AdapterFailure(Exception):
    pass


def clear(value: bytearray) -> None:
    value[:] = b"\x00" * len(value)


def private_directory(path: Path) -> int:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(descriptor)
        raise AdapterFailure()
    return descriptor


def private_regular(info: os.stat_result) -> bool:
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.getuid()
        and stat.S_IMODE(info.st_mode) == 0o600
        and info.st_nlink == 1
    )


def validate_api_key(value: bytearray) -> None:
    if len(value) > MAX_API_KEY_BYTES or API_KEY.fullmatch(value) is None:
        raise AdapterFailure()


def read_bounded(descriptor: int, limit: int) -> bytearray:
    value = bytearray(limit + 1)
    size = 0
    try:
        with memoryview(value) as view:
            while size <= limit:
                got = os.readv(descriptor, [view[size:]])
                if not got:
                    break
                size += got
        if size > limit:
            raise AdapterFailure()
        del value[size:]
        return value
    except Exception:
        clear(value)
        raise


def write_all(descriptor: int, value: bytearray | bytes) -> None:
    offset = 0
    with memoryview(value) as view:
        while offset < len(value):
            written = os.write(descriptor, view[offset:])
            if written <= 0:
                raise AdapterFailure()
            offset += written


def save_pointer(pointer: Path, item: str) -> None:
    if not SAFE_NAME.fullmatch(pointer.name):
        raise AdapterFailure()
    parent_descriptor = private_directory(pointer.parent)
    try:
        descriptor = os.open(
            pointer.name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_descriptor,
        )
        try:
            body = bytearray(
                json.dumps({"adapter": "file-v1", "place": item}, separators=(",", ":"), sort_keys=True).encode("ascii")
                + b"\n"
            )
            try:
                write_all(descriptor, body)
            finally:
                clear(body)
            os.fsync(descriptor)
            if not private_regular(os.fstat(descriptor)):
                raise AdapterFailure()
        finally:
            os.close(descriptor)
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)


def load_pointer(pointer: Path, expected_item: str) -> None:
    if not SAFE_NAME.fullmatch(pointer.name):
        raise AdapterFailure()
    parent_descriptor = private_directory(pointer.parent)
    try:
        descriptor = os.open(pointer.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_descriptor)
        try:
            if not private_regular(os.fstat(descriptor)):
                raise AdapterFailure()
            body = read_bounded(descriptor, 1024)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_descriptor)
    try:
        pointer_value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AdapterFailure() from None
    finally:
        clear(body)
    if (
        not isinstance(pointer_value, dict)
        or set(pointer_value) != {"adapter", "place"}
        or pointer_value["adapter"] != "file-v1"
        or pointer_value["place"] != expected_item
    ):
        raise AdapterFailure()


def read_stdin_key() -> bytearray:
    key = read_bounded(sys.stdin.fileno(), MAX_API_KEY_BYTES)
    try:
        validate_api_key(key)
        return key
    except Exception:
        clear(key)
        raise


def save(root: Path, item: str, pointer: Path) -> None:
    if not SAFE_NAME.fullmatch(item):
        raise AdapterFailure()
    key = read_stdin_key()
    root_descriptor = -1
    created = False
    try:
        root_descriptor = private_directory(root)
        descriptor = os.open(
            item,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=root_descriptor,
        )
        created = True
        try:
            write_all(descriptor, key)
            os.fsync(descriptor)
            if not private_regular(os.fstat(descriptor)):
                raise AdapterFailure()
        finally:
            os.close(descriptor)
        os.fsync(root_descriptor)
        save_pointer(pointer, item)
    except Exception:
        if created and root_descriptor >= 0:
            try:
                os.unlink(item, dir_fd=root_descriptor)
                os.fsync(root_descriptor)
            except OSError:
                pass
        raise
    finally:
        if root_descriptor >= 0:
            os.close(root_descriptor)
        clear(key)


def read(root: Path, item: str, pointer: Path) -> None:
    load_pointer(pointer, item)
    root_descriptor = private_directory(root)
    try:
        descriptor = os.open(item, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_descriptor)
        try:
            before = os.fstat(descriptor)
            if not private_regular(before):
                raise AdapterFailure()
            key = read_bounded(descriptor, MAX_API_KEY_BYTES)
            after = os.fstat(descriptor)
            if not private_regular(after):
                clear(key)
                raise AdapterFailure()
            if (before.st_dev, before.st_ino, before.st_uid, before.st_mode, before.st_nlink) != (
                after.st_dev,
                after.st_ino,
                after.st_uid,
                after.st_mode,
                after.st_nlink,
            ):
                clear(key)
                raise AdapterFailure()
        finally:
            os.close(descriptor)
    finally:
        os.close(root_descriptor)
    try:
        validate_api_key(key)
        write_all(sys.stdout.fileno(), key)
    finally:
        clear(key)


def main() -> int:
    os.umask(0o077)
    if len(sys.argv) != 6 or sys.argv[1] not in {"save", "read"} or sys.argv[5] != "file-v1":
        return 2
    operation, registry_text, bot, entry = sys.argv[1:5]
    try:
        target = load_target(registry_text, bot, entry)
        if operation == "save":
            save(target.root, target.item, target.pointer)
        else:
            read(target.root, target.item, target.pointer)
    except (AdapterFailure, RegistryFailure, OSError):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
