from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

from door_policy import EXPECTED_PERMISSIONS


MAX_KEY_BYTES = 4096


class SecurityRefused(RuntimeError):
    pass


class SecretKey:
    __slots__ = ("_key",)

    def __init__(self, key: bytearray) -> None:
        self._key = key

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> "SecretKey":
        source = Path(path)
        parent = source.parent.stat(follow_symlinks=False)
        if (
            not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) != 0o700
        ):
            raise SecurityRefused("Captain key directory is unsafe")

        descriptor = os.open(
            source,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
        content = bytearray()
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1
            ):
                raise SecurityRefused("Captain key file is unsafe")
            content.extend(os.read(descriptor, MAX_KEY_BYTES + 2))
            if os.read(descriptor, 1):
                raise SecurityRefused("Captain key file is too large")
            if (
                len(content) < 2
                or len(content) > MAX_KEY_BYTES + 1
                or content[-1] != 0x0A
                or 0x0A in content[:-1]
                or any(not 0x21 <= octet <= 0x7E for octet in content[:-1])
            ):
                raise SecurityRefused(
                    "Captain key file must contain exactly one printable ASCII key and one newline"
                )
            key = bytearray(content[:-1])
            return cls(key)
        finally:
            content[:] = b"\x00" * len(content)
            content.clear()
            os.close(descriptor)

    def header(self) -> bytes:
        if not self._key:
            raise SecurityRefused("Captain key is cleared")
        return b"Bearer " + self._key

    def clear(self) -> None:
        self._key[:] = b"\x00" * len(self._key)
        self._key.clear()

    def __len__(self) -> int:
        return len(self._key)

    def __repr__(self) -> str:
        return "SecretKey(<hidden>)"

    __str__ = __repr__

    def __reduce__(self):
        raise TypeError("a Captain key cannot be copied out")


def expected_mail_permissions() -> frozenset[str]:
    return frozenset(EXPECTED_PERMISSIONS)


def verify_key_readback(readback: dict[str, Any], mailbox: str) -> None:
    permissions = readback.get("permissions")
    request_limit = readback.get("requestsPerMinute")
    if (
        not isinstance(mailbox, str)
        or not mailbox
        or readback.get("account") != mailbox
        or readback.get("mailbox") != mailbox
        or not isinstance(permissions, list)
        or any(not isinstance(value, str) for value in permissions)
        or set(permissions) != expected_mail_permissions()
        or readback.get("administrator") is not False
        or readback.get("impersonation") is not False
        or not isinstance(request_limit, int)
        or isinstance(request_limit, bool)
        or not 1 <= request_limit <= 120
    ):
        raise SecurityRefused("Captain mail key readback is not least privilege")
