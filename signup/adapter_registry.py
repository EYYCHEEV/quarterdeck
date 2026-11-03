from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

MAX_REGISTRY_BYTES = 65536
ENTRY_NAME = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}\Z")
BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
SAFE_ITEM = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}\Z")


class RegistryFailure(Exception):
    pass


@dataclass(frozen=True)
class AdapterTarget:
    adapter: str
    bot: str
    root: Path
    item: str
    pointer: Path


def _private_regular(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077
            or info.st_nlink != 1
        ):
            raise RegistryFailure()
        buffer = bytearray(MAX_REGISTRY_BYTES + 1)
        size = 0
        with memoryview(buffer) as view:
            while size <= MAX_REGISTRY_BYTES:
                got = os.readv(descriptor, [view[size:]])
                if not got:
                    break
                size += got
        if size > MAX_REGISTRY_BYTES:
            raise RegistryFailure()
        return bytes(buffer[:size])
    finally:
        os.close(descriptor)


def load_target(registry_path: str | os.PathLike[str], bot: str, entry: str) -> AdapterTarget:
    if not BOT_NAME.fullmatch(bot) or not ENTRY_NAME.fullmatch(entry):
        raise RegistryFailure()
    path = Path(os.path.abspath(os.fspath(registry_path)))
    try:
        value = json.loads(_private_regular(path))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise RegistryFailure() from None
    if not isinstance(value, dict) or set(value) != {"version", "entries"} or value["version"] != 1:
        raise RegistryFailure()
    entries = value["entries"]
    if not isinstance(entries, dict) or entry not in entries:
        raise RegistryFailure()
    target = entries[entry]
    if not isinstance(target, dict) or set(target) != {"adapter", "bot", "root", "item", "pointer"}:
        raise RegistryFailure()
    if target["adapter"] != "file-v1" or target["bot"] != bot:
        raise RegistryFailure()
    root_text = target["root"]
    item = target["item"]
    pointer_text = target["pointer"]
    if (
        not isinstance(root_text, str)
        or not isinstance(item, str)
        or not isinstance(pointer_text, str)
        or not SAFE_ITEM.fullmatch(item)
        or not os.path.isabs(root_text)
        or not os.path.isabs(pointer_text)
    ):
        raise RegistryFailure()
    root = Path(os.path.abspath(root_text))
    pointer = Path(os.path.abspath(pointer_text))
    if not ENTRY_NAME.fullmatch(pointer.name):
        raise RegistryFailure()
    return AdapterTarget("file-v1", bot, root, item, pointer)
