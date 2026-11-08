from __future__ import annotations

import os
import stat
import sys


USERNAME = "qd-recovery"
MAX_PASSWORD_BYTES = 128
MIN_PASSWORD_BYTES = 43


def clear(value: bytearray) -> None:
    for index in range(len(value)):
        value[index] = 0


def read_private_password(path: str) -> bytearray:
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError("recovery password path is not a regular file")
    if stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_uid != os.getuid() or metadata.st_nlink != 1:
        raise RuntimeError("recovery password file metadata is unsafe")

    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        data = bytearray(os.read(descriptor, MAX_PASSWORD_BYTES + 1))
        if os.read(descriptor, 1):
            raise RuntimeError("recovery password file exceeds its size bound")
    finally:
        os.close(descriptor)

    if data.endswith(b"\n"):
        data.pop()
    if not (MIN_PASSWORD_BYTES <= len(data) <= MAX_PASSWORD_BYTES):
        clear(data)
        raise RuntimeError("recovery password file has an invalid length")
    if b":" in data or any(byte <= 32 or byte > 126 for byte in data):
        clear(data)
        raise RuntimeError("recovery password file has invalid content")
    return data


def child_environment(password: bytearray, port: int) -> dict[str, str]:
    if not 1024 <= port <= 65535:
        raise RuntimeError("recovery port is outside the unprivileged range")
    value = password.decode("ascii")
    return {
        "PATH": "/usr/bin:/usr/sbin",
        "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
        "STALWART_RECOVERY_MODE": "1",
        "STALWART_RECOVERY_MODE_PORT": str(port),
        "STALWART_RECOVERY_MODE_LOG_LEVEL": "info",
        "STALWART_RECOVERY_ADMIN": f"{USERNAME}:{value}",
    }


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 4 or args[2] != "--":
        raise RuntimeError("expected PASSWORD_FILE PORT -- PROGRAM [ARG ...]")
    password_path, port_text, _, *program = args
    if not program or not os.path.isabs(password_path) or not os.path.isabs(program[0]):
        raise RuntimeError("recovery launcher paths must be absolute")

    password = read_private_password(password_path)
    try:
        environment = child_environment(password, int(port_text, 10))
        clear(password)
        os.execve(program[0], program, environment)
    finally:
        clear(password)
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("recovery launcher failed safely\n")
        raise SystemExit(1)
