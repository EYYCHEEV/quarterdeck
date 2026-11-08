from __future__ import annotations

import json
import os
import re
import stat
import sys
import time
from collections.abc import Callable

NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
MAX_NAMES = 64
MAX_BYTES = 4096
REFUSED_LINE = "QD_CHAT_BOTS_REFUSED\n"
DOCUMENT_KEYS = frozenset({"v", "at", "bots"})
MAX_AGE_SECONDS = 90
MAX_AHEAD_SECONDS = 60


class _Refused(Exception):
    pass


def _object(pairs):
    keys = [key for key, value in pairs]
    if len(set(keys)) != len(keys):
        raise _Refused
    return dict(pairs)


def _constant(name):
    raise _Refused


def _names(document, now):
    if not isinstance(document, dict) or set(document) != DOCUMENT_KEYS:
        raise _Refused
    version = document["v"]
    if type(version) is not int or version != 1:
        raise _Refused
    stamp = document["at"]
    if type(stamp) is not int:
        raise _Refused
    age = now - stamp
    if age > MAX_AGE_SECONDS or -age > MAX_AHEAD_SECONDS:
        raise _Refused
    names = document["bots"]
    if not isinstance(names, list) or len(names) > MAX_NAMES:
        raise _Refused
    for name in names:
        if not isinstance(name, str) or NAME.fullmatch(name) is None:
            raise _Refused
    if len(set(names)) != len(names):
        raise _Refused
    return tuple(names)


class BotList:
    def __init__(self, path: str, clock: Callable[[], float] = time.time) -> None:
        if not isinstance(path, str) or not os.path.isabs(path) or "\0" in path:
            raise ValueError("chat bot file path is invalid")
        self._path = path
        self._clock = clock
        self._failed = False

    def _read(self) -> tuple[str, ...]:
        descriptor = os.open(
            self._path,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
        )
        try:
            info = os.fstat(descriptor)
            folder = os.stat(os.path.dirname(self._path))
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_size > MAX_BYTES
                or info.st_mode & 0o022
                or info.st_uid != folder.st_uid
            ):
                raise _Refused
            data = bytearray()
            while len(data) <= MAX_BYTES:
                chunk = os.read(descriptor, MAX_BYTES + 1 - len(data))
                if not chunk:
                    break
                data.extend(chunk)
        finally:
            os.close(descriptor)
        if len(data) > MAX_BYTES:
            raise _Refused
        document = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_object,
            parse_constant=_constant,
        )
        return _names(document, self._clock())

    def _note(self, failed: bool) -> None:
        if failed and not self._failed:
            try:
                sys.stderr.write(REFUSED_LINE)
                sys.stderr.flush()
            except Exception:
                pass
        self._failed = failed

    def __call__(self) -> tuple[str, ...]:
        try:
            names = self._read()
        except Exception:
            self._note(True)
            return ()
        self._note(False)
        return names
