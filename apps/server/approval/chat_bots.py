from __future__ import annotations

import json
import os
import re
import secrets
import sys
import threading
import time
from collections.abc import Callable, Iterable
from typing import Any

FILE_NAME = "chat-bots.json"
FILE_MODE = 0o640
TEMP_MODE = 0o600
MAX_NAMES = 64
MAX_BYTES = 4096
POLL_SECONDS = 30.0
POLL_THREAD_NAME = "chat-bots-poll"
FAILURES_BEFORE_EMPTY = 2
NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")

PUBLISHED = "QD_CHAT_BOTS_PUBLISHED\n"
FETCH_FAILED = "QD_CHAT_BOTS_FETCH_FAILED\n"
EMPTIED = "QD_CHAT_BOTS_EMPTIED\n"
WRITE_FAILED = "QD_CHAT_BOTS_WRITE_FAILED\n"
COPY_WRITE_FAILED = "QD_CHAT_BOTS_COPY_WRITE_FAILED\n"


def _checked(fetched: Any) -> list[str] | None:
    if not isinstance(fetched, list) or len(fetched) > MAX_NAMES:
        return None
    for name in fetched:
        if not isinstance(name, str) or NAME.fullmatch(name) is None:
            return None
    if len(set(fetched)) != len(fetched):
        return None
    return fetched


def _discard(name: str, directory: int) -> None:
    try:
        os.unlink(name, dir_fd=directory)
    except OSError:
        pass


def _announce(line: str) -> None:
    try:
        sys.stderr.write(line)
        sys.stderr.flush()
    except Exception:
        return


class ChatBotsPublisher:
    def __init__(
        self,
        folder: str | os.PathLike[str],
        fetch: Callable[[], list[str] | None],
        *,
        clock: Callable[[], float] = time.time,
        wait: Callable[[float], bool] | None = None,
        exclude: Iterable[str] = frozenset(),
        interval: float = POLL_SECONDS,
        copy_folder: str | os.PathLike[str] | None = None,
    ) -> None:
        self._folder = os.fspath(folder)
        self._copy_folder = (
            None if copy_folder is None else os.fspath(copy_folder)
        )
        self._fetch = fetch
        self._clock = clock
        self._wait = wait
        self._exclude = frozenset(exclude)
        self._interval = interval
        self._lock = threading.Lock()
        self._failures = 0
        self._outcome: str | None = None
        self._copy_outcome: str | None = None
        self._stop: threading.Event | None = None
        self._thread: threading.Thread | None = None

    def _encode(self, names: list[str]) -> bytes:
        return (
            json.dumps(
                {"v": 1, "at": int(self._clock()), "bots": names},
                separators=(",", ":"),
            ).encode("ascii")
            + b"\n"
        )

    def _snapshot(self) -> bytes | None:
        try:
            names = _checked(self._fetch())
        except Exception:
            return None
        if names is None:
            return None
        payload = self._encode([n for n in names if n not in self._exclude])
        return payload if len(payload) <= MAX_BYTES else None

    def _note(self, line: str) -> None:
        if line == self._outcome:
            return
        self._outcome = line
        _announce(line)

    def _note_copy(self, line: str | None) -> None:
        if line == self._copy_outcome:
            return
        self._copy_outcome = line
        if line is not None:
            _announce(line)

    def _write(
        self, folder: str, payload: bytes, *, directory_flags: int = 0
    ) -> None:
        directory = os.open(
            folder, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | directory_flags
        )
        created: str | None = None
        try:
            name = f".{FILE_NAME}.{secrets.token_hex(8)}.tmp"
            descriptor = os.open(
                name,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | os.O_NOFOLLOW
                | os.O_CLOEXEC,
                TEMP_MODE,
                dir_fd=directory,
            )
            created = name
            try:
                view = memoryview(payload)
                while view:
                    view = view[os.write(descriptor, view) :]
                os.fsync(descriptor)
                os.fchmod(descriptor, FILE_MODE)
            finally:
                os.close(descriptor)
            os.rename(
                name, FILE_NAME, src_dir_fd=directory, dst_dir_fd=directory
            )
            created = None
            os.fsync(directory)
        finally:
            if created is not None:
                _discard(created, directory)
            os.close(directory)

    def _write_copy(self, payload: bytes) -> None:
        if self._copy_folder is None:
            return
        try:
            self._write(self._copy_folder, payload, directory_flags=os.O_NOFOLLOW)
        except Exception:
            self._note_copy(COPY_WRITE_FAILED)
        else:
            self._note_copy(None)

    def _publish(self) -> bool:
        payload = self._snapshot()
        if payload is None:
            self._failures += 1
            if self._failures < FAILURES_BEFORE_EMPTY:
                self._note(FETCH_FAILED)
                return False
            payload = self._encode([])
            outcome = EMPTIED
        else:
            self._failures = 0
            outcome = PUBLISHED
        try:
            self._write(self._folder, payload)
            self._note(outcome)
        finally:
            self._write_copy(payload)
        return True

    def publish(self) -> bool:
        with self._lock:
            try:
                return self._publish()
            except Exception:
                self._note(WRITE_FAILED)
                return False

    def _run(self, wait: Callable[[float], bool]) -> None:
        while not wait(self._interval):
            self.publish()

    def start(self) -> None:
        stop = threading.Event()
        thread = threading.Thread(
            target=self._run,
            args=(self._wait or stop.wait,),
            name=POLL_THREAD_NAME,
            daemon=True,
        )
        self._stop = stop
        self._thread = thread
        thread.start()

    def stop(self) -> None:
        stop, thread = self._stop, self._thread
        self._stop = None
        self._thread = None
        if stop is not None:
            stop.set()
        if thread is not None:
            thread.join(5)
