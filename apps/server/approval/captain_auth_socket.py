from __future__ import annotations

import json
import os
import socket
import stat
import struct
import threading
from pathlib import Path
from typing import Any

import approval_app
import approval_security


MAX_REQUEST_BYTES = 8192
SOCKET_DIRECTORY_MODE = 0o2770
SOCKET_MODE = 0o660
_ALLOWED_HEADERS = {
    "origin",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "sec-fetch-dest",
    "if-none-match",
}


def _clear(value: bytearray) -> None:
    value[:] = b"\x00" * len(value)
    value.clear()


def _peer_uid(connection: socket.socket) -> int:
    size = struct.calcsize("3i")
    _, uid, _ = struct.unpack(
        "3i",
        connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size),
    )
    return uid


def _receive(connection: socket.socket) -> bytearray:
    connection.settimeout(5)
    body = bytearray()
    while len(body) <= MAX_REQUEST_BYTES and b"\n" not in body:
        chunk = connection.recv(
            min(4096, MAX_REQUEST_BYTES + 1 - len(body))
        )
        if not chunk:
            break
        body.extend(chunk)
    if (
        not body
        or len(body) > MAX_REQUEST_BYTES
        or not body.endswith(b"\n")
        or body.count(b"\n") != 1
    ):
        _clear(body)
        raise approval_security.ApprovalRefused(
            "Captain auth request was refused"
        )
    return body


def _send(connection: socket.socket, accepted: bool, csrf: str = "", fresh_until: float = 0.0, fresh_required: bool = False) -> None:
    payload = bytearray(
        json.dumps(
            {"ok": accepted, "csrf": csrf, "freshUntil": fresh_until, "freshRequired": fresh_required},
            separators=(",", ":"),
        ).encode("ascii")
        + b"\n"
    )
    try:
        connection.sendall(payload)
    finally:
        _clear(payload)


class CaptainAuthSocketService:
    def __init__(
        self,
        sign_in: approval_app.CaptainSignIn,
        application: approval_app.ApprovalApplication,
        socket_path: str | os.PathLike[str],
        *,
        expected_uid: int,
        socket_mode: int,
        socket_gid: int,
    ) -> None:
        if (
            not isinstance(application, approval_app.ApprovalApplication)
            or sign_in is not application.sign_in
            or not isinstance(expected_uid, int)
            or isinstance(expected_uid, bool)
            or not 0 <= expected_uid <= 2_147_483_647
            or socket_mode != SOCKET_MODE
            or not isinstance(socket_gid, int)
            or isinstance(socket_gid, bool)
            or not 0 <= socket_gid <= 2_147_483_647
        ):
            raise approval_security.ApprovalRefused(
                "Captain auth configuration was refused"
            )
        self.sign_in = sign_in
        self.application = application
        self.socket_path = Path(socket_path)
        self.expected_uid = expected_uid
        self.socket_mode = socket_mode
        self.socket_gid = socket_gid
        self._listener: socket.socket | None = None
        self._stop: threading.Event | None = None
        self._thread: threading.Thread | None = None

    def _protected_directory(self) -> None:
        try:
            metadata = self.socket_path.parent.stat(follow_symlinks=False)
        except OSError:
            raise approval_security.ApprovalRefused(
                "Captain auth socket storage was refused"
            ) from None
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_gid != self.socket_gid
            or stat.S_IMODE(metadata.st_mode) != SOCKET_DIRECTORY_MODE
        ):
            raise approval_security.ApprovalRefused(
                "Captain auth socket storage was refused"
            )

    def listener(self) -> socket.socket:
        self._protected_directory()
        if self.socket_path.exists() or self.socket_path.is_symlink():
            raise approval_security.ApprovalRefused(
                "Captain auth socket path was refused"
            )
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bound = False
        try:
            listener.bind(str(self.socket_path))
            bound = True
            os.chown(
                self.socket_path,
                -1,
                self.socket_gid,
                follow_symlinks=False,
            )
            os.chmod(self.socket_path, self.socket_mode)
            metadata = self.socket_path.stat(follow_symlinks=False)
            if (
                not stat.S_ISSOCK(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or metadata.st_gid != self.socket_gid
                or stat.S_IMODE(metadata.st_mode) != self.socket_mode
            ):
                raise approval_security.ApprovalRefused(
                    "Captain auth socket path was refused"
                )
            listener.listen(16)
            return listener
        except Exception:
            listener.close()
            if bound:
                try:
                    self.socket_path.unlink()
                except FileNotFoundError:
                    pass
            raise

    @staticmethod
    def _request(document: dict[str, Any]) -> approval_app.Request:
        facts = document.get("request")
        if (
            not isinstance(facts, dict)
            or set(facts) != {"method", "path", "headers", "peer"}
            or not isinstance(facts.get("method"), str)
            or not isinstance(facts.get("path"), str)
            or not isinstance(facts.get("headers"), dict)
            or not isinstance(facts.get("peer"), str)
            or any(
                not isinstance(name, str) or not isinstance(value, str)
                for name, value in facts["headers"].items()
            )
        ):
            raise approval_security.ApprovalRefused(
                "Captain auth request was refused"
            )
        headers: dict[str, str] = {}
        lowered: set[str] = set()
        for name, value in facts["headers"].items():
            lower = name.lower()
            if lower not in _ALLOWED_HEADERS or lower in lowered:
                raise approval_security.ApprovalRefused(
                    "Captain auth request was refused"
                )
            lowered.add(lower)
            headers[name] = value
        session = document.get("session")
        if (
            not isinstance(session, str)
            or approval_security.TOKEN.fullmatch(session) is None
        ):
            raise approval_security.ApprovalRefused(
                "Captain auth request was refused"
            )
        headers["Cookie"] = f"__Host-qd-approval={session}"
        return approval_app.Request(
            facts["method"],
            facts["path"],
            headers,
            bytearray(),
            facts["peer"],
        )

    def _authorize(self, document: dict[str, Any]) -> tuple[str, float]:
        if not isinstance(document, dict):
            raise approval_security.ApprovalRefused(
                "Captain auth request was refused"
            )
        operation = document.get("operation")
        expected = (
            {"operation", "session", "request"}
            if operation == "authenticate"
            else {"operation", "session", "csrf", "request"}
        )
        if set(document) != expected:
            raise approval_security.ApprovalRefused(
                "Captain auth request was refused"
            )
        request = self._request(document)
        self.application._caller(request)
        if operation == "authenticate":
            if request.method != "GET":
                raise approval_security.ApprovalRefused(
                    "Captain auth request was refused"
                )
            session = self.sign_in.require_captain(request)
        elif operation == "authorize-post":
            if request.method != "POST":
                raise approval_security.ApprovalRefused(
                    "Captain auth request was refused"
                )
            self.application._origin(request)
            session = self.sign_in.require_captain(request)
            if session is None or not self.sign_in.check_csrf(
                session,
                {"csrf": document.get("csrf")},
            ):
                raise approval_security.ApprovalRefused(
                    "Captain auth request was refused"
                )
        else:
            raise approval_security.ApprovalRefused(
                "Captain auth request was refused"
            )
        if session is None:
            raise approval_security.ApprovalRefused(
                "Captain auth request was refused"
            )
        fresh_until = self.sign_in.fresh_until(session)
        if approval_security.requires_fresh(request.method, request.path) and fresh_until <= self.application.state.clock():
            raise approval_security.FreshSignInRequired("Fresh sign-in is required")
        self.sign_in.record_use(session, request)
        return self.sign_in.csrf_token(session), fresh_until

    def _handle(self, connection: socket.socket) -> None:
        body = bytearray()
        try:
            if _peer_uid(connection) != self.expected_uid:
                raise approval_security.ApprovalRefused(
                    "Captain auth peer was refused"
                )
            body = _receive(connection)
            try:
                document = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise approval_security.ApprovalRefused(
                    "Captain auth request was refused"
                ) from None
            csrf, fresh_until = self._authorize(document)
            _send(connection, True, csrf, fresh_until)
        except approval_security.FreshSignInRequired:
            try:
                _send(connection, False, fresh_required=True)
            except OSError:
                pass
        except Exception:
            try:
                _send(connection, False)
            except OSError:
                pass
        finally:
            _clear(body)

    def serve_once(self, ready: threading.Event | None = None) -> None:
        listener = self.listener()
        try:
            if ready is not None:
                ready.set()
            connection, _ = listener.accept()
            with connection:
                self._handle(connection)
        finally:
            listener.close()
            try:
                self.socket_path.unlink()
            except FileNotFoundError:
                pass

    def _serve(self) -> None:
        assert self._listener is not None
        assert self._stop is not None
        self._listener.settimeout(0.5)
        while not self._stop.is_set():
            try:
                connection, _ = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with connection:
                self._handle(connection)

    def start(self) -> None:
        if self._thread is not None:
            raise approval_security.ApprovalRefused(
                "Captain auth service was refused"
            )
        self._listener = self.listener()
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._serve,
            name="captain-auth-socket",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        listener, thread, stop = self._listener, self._thread, self._stop
        self._listener = None
        self._thread = None
        self._stop = None
        if stop is not None:
            stop.set()
        if listener is not None:
            listener.close()
        if thread is not None:
            thread.join(5)
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
