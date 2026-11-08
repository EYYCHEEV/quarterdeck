from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from typing import Any, Protocol


class Refreshable(Protocol):
    def refresh(self) -> dict[str, Any]: ...

    def chat_list(self) -> list[dict[str, Any]]: ...


class LiveUpdates:
    interval_seconds = 5

    def __init__(self, service: Refreshable) -> None:
        self.service = service
        self.version = 0
        self._encoded = b""
        self._event = b'{"cards":true,"chats":true}'
        self._payload: dict[str, Any] = {}
        self._condition = threading.Condition()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def check_once(self) -> bool:
        payload = self.service.refresh()
        encoded = json.dumps(
            {
                "cards": payload,
                "chats": self.service.chat_list(),
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        with self._condition:
            if encoded == self._encoded:
                return False
            self._payload = payload
            self._encoded = encoded
            self.version += 1
            self._condition.notify_all()
        return True

    def snapshot(self) -> dict[str, Any]:
        with self._condition:
            return self._payload


    def events(self, *, after: int) -> Iterator[str]:
        if not isinstance(after, int) or isinstance(after, bool) or after < 0:
            raise ValueError("event cursor is invalid")
        cursor = after
        while True:
            with self._condition:
                while self.version <= cursor and not self._stop.is_set():
                    self._condition.wait()
                if self._stop.is_set():
                    return
                cursor = self.version
                data = self._event.decode("utf-8")
            yield f"id: {cursor}\nevent: refresh\ndata: {data}\n\n"

    def _run(self, wait_first: bool = False) -> None:
        if wait_first:
            self._stop.wait(self.interval_seconds)
        while not self._stop.is_set():
            try:
                self.check_once()
            except Exception:
                pass
            self._stop.wait(self.interval_seconds)

    def start(self) -> None:
        with self._condition:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
        try:
            self.check_once()
        except Exception:
            pass
        with self._condition:
            self._thread = threading.Thread(
                target=self._run,
                kwargs={"wait_first": True},
                name="quarterdeck-card-checker",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        thread = self._thread
        if thread is not None:
            thread.join()
        self._thread = None
