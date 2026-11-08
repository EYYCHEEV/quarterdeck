from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from typing import Any
from urllib.parse import urlsplit


DEFAULT_POLICY = "/opt/quarterdeck/door-policy.json"
DEFAULT_MARKER = "/var/lib/quarterdeck/first-start.json"
DEFAULT_ACTIVE_PASSWORD = "/run/quarterdeck/recovery-password"


class NormalStartRefused(RuntimeError):
    pass


def read_bounded(path: str, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        value = os.read(descriptor, limit + 1)
        if len(value) > limit or os.read(descriptor, 1):
            raise NormalStartRefused("required first-start file exceeds its size bound")
        return value
    finally:
        os.close(descriptor)


def _load_marker(path: str) -> dict[str, Any]:
    metadata = os.lstat(path)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
    ):
        raise NormalStartRefused("first-start marker metadata is unsafe")
    try:
        marker = json.loads(read_bounded(path, 16_384))
    except (TypeError, ValueError) as exc:
        raise NormalStartRefused("first-start marker is invalid") from exc
    if not isinstance(marker, dict):
        raise NormalStartRefused("first-start marker is invalid")
    return marker


def launch(
    executable: str,
    arguments: list[str],
    *,
    policy_path: str = DEFAULT_POLICY,
    marker_path: str = DEFAULT_MARKER,
    active_password_path: str = DEFAULT_ACTIVE_PASSWORD,
) -> None:
    if any(name.startswith("STALWART_RECOVERY_") for name in os.environ):
        raise NormalStartRefused("normal start inherited a recovery setting")
    if os.path.lexists(active_password_path):
        raise NormalStartRefused("active recovery password still exists")
    if not os.path.isabs(executable):
        raise NormalStartRefused("normal executable path must be absolute")

    marker = _load_marker(marker_path)
    policy = read_bounded(policy_path, 1_048_576)
    expected_digest = hashlib.sha256(policy).hexdigest()
    if (
        marker.get("format") != 1
        or marker.get("policySha256") != expected_digest
        or marker.get("readbackVerified") is not True
        or marker.get("recoveryPasswordRetired") is not True
    ):
        raise NormalStartRefused("first-start marker does not authorize normal start")
    try:
        configuration = json.loads(policy)
    except (TypeError, ValueError):
        raise NormalStartRefused("door policy is invalid") from None
    hostname = (
        configuration.get("hostname")
        if isinstance(configuration, dict)
        else None
    )
    public_url = (
        configuration.get("publicUrl")
        if isinstance(configuration, dict)
        else None
    )
    parsed = urlsplit(public_url) if isinstance(public_url, str) else None
    if (
        not isinstance(hostname, str)
        or not hostname
        or parsed is None
        or parsed.scheme != "https"
        or parsed.netloc != hostname
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or public_url != f"https://{hostname}"
    ):
        raise NormalStartRefused("door policy public URL is invalid")


    environment = {
        "PATH": "/usr/bin:/usr/sbin",
        "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
        "STALWART_PUBLIC_URL": public_url,
    }
    os.execve(executable, [executable, *arguments], environment)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        raise NormalStartRefused("normal executable is required")
    launch(args[0], args[1:])
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("normal start refused safely\n")
        raise SystemExit(1)
