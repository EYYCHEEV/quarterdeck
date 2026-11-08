from __future__ import annotations

import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

LIMIT = 60
BACKGROUND_LIMIT = 36
WINDOW_SECONDS = 60.0
FIRST_PAUSE_SECONDS = 10.0
LONGEST_PAUSE_SECONDS = 60.0
BLIND_SECONDS = 60.0
REFRESH_FLOOR = 8
STATE_MAX_CHARS = 128
MAIL_LINES_PER_MINUTE = 30


class MailLog:
    def __init__(
        self,
        clock: Callable[[], float],
        *,
        per_minute: int = MAIL_LINES_PER_MINUTE,
        window: float = WINDOW_SECONDS,
    ) -> None:
        self._clock = clock
        self._per_minute = per_minute
        self._window = window
        self._lock = threading.Lock()
        self._started: float | None = None
        self._written = 0
        self._dropped = 0

    def _roll(self, now: float) -> list[str]:
        if self._started is None or now - self._started < self._window:
            return []
        lines = (
            [f"QD_MAIL_LINES_SUPPRESSED count={self._dropped}"]
            if self._dropped
            else []
        )
        self._started = None
        self._written = 0
        self._dropped = 0
        return lines

    @staticmethod
    def _put(lines: list[str]) -> None:
        for line in lines:
            try:
                sys.stderr.write(line + "\n")
                sys.stderr.flush()
            except Exception:
                pass

    def write(self, line: str) -> None:
        with self._lock:
            now = self._clock()
            lines = self._roll(now)
            if self._started is None:
                self._started = now
            if self._written < self._per_minute:
                self._written += 1
                lines.append(line)
            else:
                self._dropped += 1
        self._put(lines)

    def flush(self) -> None:
        with self._lock:
            lines = self._roll(self._clock())
        self._put(lines)

    def refresh(self, milliseconds: int, requests: int) -> None:
        self.write(f"QD_MAIL_REFRESH ms={milliseconds} requests={requests}")

    def budget(self, refused: str, background: bool) -> None:
        flag = "true" if background else "false"
        self.write(f"QD_MAIL_BUDGET refused={refused} background={flag}")


class BudgetRefused(OSError):
    pass


class Window:
    def __init__(self, clock: Callable[[], float], seconds: float) -> None:
        self._clock = clock
        self.deadline = clock() + seconds

    def left(self) -> float:
        return max(0.0, self.deadline - self._clock())


class Budget:
    def __init__(
        self,
        clock: Callable[[], float],
        *,
        limit: int = LIMIT,
        background_limit: int = BACKGROUND_LIMIT,
        window: float = WINDOW_SECONDS,
        first_pause: float = FIRST_PAUSE_SECONDS,
        longest_pause: float = LONGEST_PAUSE_SECONDS,
        log: MailLog | None = None,
    ) -> None:
        self._clock = clock
        self._limit = limit
        self._background_limit = background_limit
        self._window = window
        self._first_pause = first_pause
        self._longest_pause = longest_pause
        self._stamps: deque[float] = deque()
        self._until = 0.0
        self._pause = 0.0
        self._lock = threading.Lock()
        self._local = threading.local()
        self.spent = 0
        self.log = MailLog(clock) if log is None else log

    @contextmanager
    def background(self) -> Iterator[None]:
        previous = getattr(self._local, "background", False)
        self._local.background = True
        try:
            yield
        finally:
            self._local.background = previous

    @contextmanager
    def patient(self, seconds: float) -> Iterator[Window]:
        previous = getattr(self._local, "window", None)
        window = Window(self._clock, seconds)
        self._local.window = window
        try:
            yield window
        finally:
            self._local.window = previous

    def in_background(self) -> bool:
        return getattr(self._local, "background", False)

    def _trim(self, now: float) -> None:
        cutoff = now - self._window
        while self._stamps and self._stamps[0] <= cutoff:
            self._stamps.popleft()

    def admit(self) -> None:
        background = self.in_background()
        window = None if background else getattr(self._local, "window", None)
        deadline = self._clock() if window is None else window.deadline
        while True:
            with self._lock:
                now = self._clock()
                wait = self._until - now
                refused = None
                if wait <= 0:
                    self._trim(now)
                    cap = self._background_limit if background else self._limit
                    if len(self._stamps) < cap:
                        self._stamps.append(now)
                        if background:
                            self.spent += 1
                        return
                    refused = "full"
                elif now + wait > deadline:
                    refused = "pause"
            if refused is None:
                time.sleep(wait)
                continue
            self.log.budget(refused, background)
            if refused == "pause":
                raise BudgetRefused("the mail server is being given a pause")
            raise BudgetRefused("the mail request budget for this minute is used")

    def settle(self, ok: bool) -> None:
        with self._lock:
            if ok:
                self._pause = 0.0
                return
            now = self._clock()
            if now < self._until:
                return
            self._pause = (
                self._first_pause
                if self._pause == 0.0
                else min(self._pause * 2, self._longest_pause)
            )
            self._until = now + self._pause

    def room(self) -> int:
        with self._lock:
            now = self._clock()
            if now < self._until:
                return 0
            self._trim(now)
            return max(0, self._background_limit - len(self._stamps))


class MeteredTransport:
    def __init__(self, inner: Callable[..., tuple[int, bytes]], budget: Budget) -> None:
        self._inner = inner
        self._budget = budget

    def __call__(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None = None,
    ) -> tuple[int, bytes]:
        self._budget.admit()
        try:
            status, data = self._inner(method, url, headers, body)
        except OSError:
            self._budget.settle(False)
            raise
        self._budget.settle(status == 200)
        return status, data


class StateGate:
    def __init__(
        self,
        mailbox: Any,
        budget: Budget,
        clock: Callable[[], float],
        *,
        blind_seconds: float = BLIND_SECONDS,
    ) -> None:
        self._mailbox = mailbox
        self._budget = budget
        self._clock = clock
        self._blind_seconds = blind_seconds
        self._token: str | None = None
        self._seen: str | None = None
        self._blind_at: float | None = None
        self._blinds = 0
        self._need = REFRESH_FLOOR

    def token(self) -> str | None:
        return self._token

    def _read(self) -> str | None:
        [answer] = self._mailbox.mailbox.jmap.call(("Email/get", {"ids": []}))
        state = answer.get("state")
        if (
            isinstance(state, str)
            and 0 < len(state) <= STATE_MAX_CHARS
            and state.isprintable()
        ):
            return state
        return None

    def run(self, refresh: Callable[[], dict[str, Any]]) -> dict[str, Any] | None:
        self._budget.log.flush()
        with self._budget.background():
            if self._budget.room() <= self._need:
                return None
            state = self._read()
            now = self._clock()
            if state is None:
                if (
                    self._blind_at is not None
                    and now - self._blind_at < self._blind_seconds
                ):
                    return None
                self._blinds += 1
                self._token = f"blind-{self._blinds}"
            else:
                self._token = state
                if state == self._seen:
                    return None
            started = self._budget.spent
            began = self._clock()
            self._mailbox.note_state(state)
            try:
                payload = refresh()
            finally:
                self._budget.log.refresh(
                    int((self._clock() - began) * 1000),
                    self._budget.spent - started,
                )
            self._need = max(REFRESH_FLOOR, self._budget.spent - started)
            if state is None:
                self._blind_at = now
            else:
                self._seen = state
            return payload
