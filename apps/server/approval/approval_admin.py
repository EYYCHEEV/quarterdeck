from __future__ import annotations

import argparse
import os
import sqlite3
import stat
from contextlib import closing
import time
from pathlib import Path
from typing import Callable, Sequence


RESET_SUMMARY = "Approval password reset by server operator"


def _private_state_descriptor(path: Path) -> int:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        os.close(descriptor)
        raise ValueError("approval state must be an owned regular file with mode 0600")
    return descriptor


def reset_approval_password(
    state_path: str | os.PathLike[str],
    *,
    clock: Callable[[], float] = time.time,
) -> None:
    path = Path(state_path)
    descriptor = _private_state_descriptor(path)
    try:
        opened = os.fstat(descriptor)
        current = path.stat(follow_symlinks=False)
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("approval state changed while it was opened")
        with closing(
            sqlite3.connect(path, isolation_level=None, timeout=5)
        ) as database:
            database.execute("PRAGMA synchronous = FULL")
            database.execute("BEGIN EXCLUSIVE")
            row = database.execute(
                "SELECT 1 FROM approval_password WHERE singleton = 1"
            ).fetchone()
            if row is None:
                database.execute("ROLLBACK")
                raise ValueError("approval password is not enabled")
            database.execute("DELETE FROM approval_password WHERE singleton = 1")
            database.execute(
                "INSERT INTO activity (happened, summary) VALUES (?, ?)",
                (clock(), RESET_SUMMARY),
            )
            database.execute("COMMIT")
    finally:
        os.close(descriptor)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run approval-only recovery operations while the service is stopped."
    )
    subcommands = parser.add_subparsers(dest="action", required=True)
    reset = subcommands.add_parser(
        "reset-approval-password",
        help="disable a forgotten optional approval password",
    )
    reset.add_argument("--state", required=True, type=Path)
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    options = _parser().parse_args(arguments)
    if options.action == "reset-approval-password":
        reset_approval_password(options.state)
        return 0
    raise AssertionError("unreachable approval administration action")


if __name__ == "__main__":
    raise SystemExit(main())
