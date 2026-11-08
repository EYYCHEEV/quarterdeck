from __future__ import annotations

import json
import os
import re
import stat
import sys
import threading
import time
from collections.abc import Callable
from typing import Any


FILE_NAME = "chat-bots.json"
MAX_BYTES = 4096
MAX_BOTS = 64
MAX_AGE_SECONDS = 90
MAX_AHEAD_SECONDS = 60
KEYS = frozenset({"v", "at", "bots"})
BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
INVALID_LINE = "QD_CHAT_BOTS_INVALID\n"
OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
FOLDER_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate key")
    return dict(pairs)


def _refuse_constant(_: str) -> None:
    raise ValueError("constant")


def _read_capped(descriptor: int) -> bytes:
    data = b""
    while len(data) <= MAX_BYTES:
        chunk = os.read(descriptor, MAX_BYTES + 1 - len(data))
        if not chunk:
            break
        data += chunk
    return data


def _trusted(info: os.stat_result, owner: int) -> bool:
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == owner
        and not info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
    )


def _parse(data: bytes) -> tuple[int, frozenset[str]] | None:
    if len(data) > MAX_BYTES:
        return None
    try:
        document = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_unique_keys,
            parse_constant=_refuse_constant,
        )
    except (ValueError, RecursionError):
        return None
    if not isinstance(document, dict) or set(document) != KEYS:
        return None
    version = document["v"]
    stamp = document["at"]
    bots = document["bots"]
    if (
        type(version) is not int
        or version != 1
        or type(stamp) is not int
        or not isinstance(bots, list)
        or len(bots) > MAX_BOTS
        or any(
            not isinstance(name, str) or BOT_NAME.fullmatch(name) is None
            for name in bots
        )
    ):
        return None
    names = frozenset(bots)
    if len(names) != len(bots):
        return None
    return stamp, names


def _log_invalid() -> None:
    try:
        sys.stderr.write(INVALID_LINE)
        sys.stderr.flush()
    except Exception:
        return


class ChatBotList:
    def __init__(
        self,
        folder: str | os.PathLike[str],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._folder = os.fspath(folder)
        self._clock = clock
        self._lock = threading.Lock()
        self._valid = True

    def names(self) -> frozenset[str]:
        names = self._load()
        with self._lock:
            turned_invalid = self._valid and names is None
            self._valid = names is not None
        if turned_invalid:
            _log_invalid()
        return frozenset() if names is None else names

    def _load(self) -> frozenset[str] | None:
        parsed = self._read()
        if parsed is None:
            return None
        stamp, names = parsed
        age = self._clock() - stamp
        if age > MAX_AGE_SECONDS or -age > MAX_AHEAD_SECONDS:
            return None
        return names

    def _read(self) -> tuple[int, frozenset[str]] | None:
        try:
            folder = os.open(self._folder, FOLDER_FLAGS)
        except OSError:
            return None
        try:
            owner = os.fstat(folder).st_uid
            descriptor = os.open(FILE_NAME, OPEN_FLAGS, dir_fd=folder)
            try:
                if not _trusted(os.fstat(descriptor), owner):
                    return None
                data = _read_capped(descriptor)
            finally:
                os.close(descriptor)
        except OSError:
            return None
        finally:
            os.close(folder)
        return _parse(data)
