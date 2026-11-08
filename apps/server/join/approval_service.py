from __future__ import annotations

import json
import os
import pwd
import socket
import stat
import struct
import sys
from pathlib import Path
from typing import Callable

from signup_flow import (
    BOT_NAME,
    INVITE_CODE,
    INVITE_HMAC_KEY_BYTES,
    INVITE_ID,
    JoinService,
    PublicFailure,
    clear,
)

APPROVER_ROLE = "qd-approver"
DATABASE_PATH = Path("/var/lib/quarterdeck/join/state.sqlite")
INVITE_HMAC_KEY_PATH = Path("/var/lib/quarterdeck/join/invite-hmac.key")
SOCKET_PATH = Path("/run/quarterdeck/approve.sock")
MAX_REQUEST_BYTES = 512
MAX_RESPONSE_BYTES = 8192
MAX_PENDING_RESULTS = 50
MAX_INVITE_RESULTS = 50
MAX_BOT_RESULTS = 64
SHARED_SOCKET_DIRECTORY_MODE = 0o2770
GROUP_CONNECTABLE_SOCKET_MODE = 0o660
SOCKET_MODE_ENV = "QD_APPROVAL_SOCKET_MODE"
SOCKET_GID_ENV = "QD_APPROVAL_SOCKET_GID"


def _send_response(connection: socket.socket, response: dict) -> None:
    encoded = bytearray(
        json.dumps(response, separators=(",", ":")).encode("ascii")
        + b"\n"
    )
    try:
        connection.sendall(encoded)
    finally:
        clear(encoded)
        encoded.clear()


def _send_result(connection: socket.socket, accepted: bool) -> None:
    _send_response(connection, {"ok": accepted})


def _peer_uid(connection: socket.socket) -> int:
    size = struct.calcsize("3i")
    _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size))
    return uid


def _receive_request(connection: socket.socket) -> bytearray | None:
    connection.settimeout(5)
    body = bytearray()
    while len(body) <= MAX_REQUEST_BYTES and b"\n" not in body:
        chunk = connection.recv(min(256, MAX_REQUEST_BYTES + 1 - len(body)))
        if not chunk:
            break
        body.extend(chunk)
    if len(body) > MAX_REQUEST_BYTES or not body.endswith(b"\n") or body.count(b"\n") != 1:
        return None
    return body


def _protected_directory(path: Path, expected_gid: int) -> None:
    info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_gid != expected_gid
        or stat.S_IMODE(info.st_mode) != SHARED_SOCKET_DIRECTORY_MODE
    ):
        raise PublicFailure()


def _load_invite_hmac_key(path: str | os.PathLike[str]) -> bytearray:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    value = bytearray(INVITE_HMAC_KEY_BYTES)
    offset = 0
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
            or info.st_size != INVITE_HMAC_KEY_BYTES
        ):
            raise PublicFailure()
        with memoryview(value) as view:
            while offset < INVITE_HMAC_KEY_BYTES:
                got = os.readv(descriptor, [view[offset:]])
                if not got:
                    break
                offset += got
        if offset != INVITE_HMAC_KEY_BYTES:
            raise PublicFailure()
        return value
    except Exception:
        clear(value)
        value.clear()
        raise
    finally:
        os.close(descriptor)


def _configured_socket_access() -> tuple[int, int]:
    try:
        socket_mode = int(os.environ[SOCKET_MODE_ENV], 8)
        socket_gid = int(os.environ[SOCKET_GID_ENV], 10)
    except (KeyError, ValueError):
        raise PublicFailure() from None
    return socket_mode, socket_gid


class ApprovalService:
    def __init__(
        self,
        service: JoinService,
        socket_path: str | os.PathLike[str],
        expected_uid: int,
        actor_for_uid: Callable[[int], str],
        *,
        socket_mode: int,
        socket_gid: int,
    ) -> None:
        if (
            not isinstance(socket_mode, int)
            or isinstance(socket_mode, bool)
            or socket_mode != GROUP_CONNECTABLE_SOCKET_MODE
            or not isinstance(socket_gid, int)
            or isinstance(socket_gid, bool)
            or not 0 <= socket_gid <= 2_147_483_647
        ):
            raise PublicFailure()
        self.service = service
        self.socket_path = Path(socket_path)
        self.expected_uid = expected_uid
        self.actor_for_uid = actor_for_uid
        self.socket_mode = socket_mode
        self.socket_gid = socket_gid

    def _handle(self, connection: socket.socket) -> None:
        try:
            uid = _peer_uid(connection)
            if uid != self.expected_uid:
                _send_result(connection, False)
                return
            body = _receive_request(connection)
            if body is None:
                _send_result(connection, False)
                return
            try:
                request = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                _send_result(connection, False)
                return
            if not isinstance(request, dict):
                _send_result(connection, False)
                return
            actor = self.actor_for_uid(uid)
            if actor != APPROVER_ROLE:
                _send_result(connection, False)
                return
            action = request.get("action")
            try:
                if action == "pending" and set(request) == {"action"}:
                    pending = self.service._pending_verified(
                        actor,
                        MAX_PENDING_RESULTS,
                    )
                    _send_response(
                        connection,
                        {"ok": True, "pending": pending},
                    )
                    return
                if action == "listInvites" and set(request) == {"action"}:
                    invites = self.service._list_invites_verified(
                        actor,
                        MAX_INVITE_RESULTS,
                    )
                    _send_response(
                        connection,
                        {"ok": True, "invites": invites},
                    )
                    return
                if action == "listBots" and set(request) == {"action"}:
                    bots = self.service.active_bot_names()
                    if len(bots) > MAX_BOT_RESULTS:
                        _send_result(connection, False)
                        return
                    _send_response(
                        connection,
                        {"ok": True, "bots": bots},
                    )
                    return
                if action == "createInvite" and set(request) in (
                    {"action"},
                    {"action", "botName"},
                ):
                    bot_name = request.get("botName")
                    if (
                        bot_name is not None
                        and (
                            not isinstance(bot_name, str)
                            or BOT_NAME.fullmatch(bot_name) is None
                        )
                    ):
                        _send_result(connection, False)
                        return
                    offer = self.service._create_invite_verified(
                        actor,
                        bot_name,
                    )
                    code = offer.take_code()
                    try:
                        _send_response(
                            connection,
                            {
                                "ok": True,
                                "invite": {
                                    "inviteId": offer.invite_id,
                                    "code": code.decode("ascii"),
                                    "botName": offer.bot_name,
                                    "invitedBy": offer.invited_by,
                                    "createdAt": offer.created_at,
                                    "expiresAt": offer.expires_at,
                                },
                            },
                        )
                    finally:
                        clear(code)
                        code.clear()
                        offer.clear()
                    return
                if (
                    action == "cancelInvite"
                    and set(request) == {"action", "inviteId"}
                ):
                    invite_id = request["inviteId"]
                    if (
                        not isinstance(invite_id, str)
                        or INVITE_ID.fullmatch(invite_id) is None
                    ):
                        _send_result(connection, False)
                        return
                    self.service._cancel_invite_verified(invite_id, actor)
                    _send_result(connection, True)
                    return
                if (
                    action not in {"approve", "refuse"}
                    or set(request) != {"action", "code"}
                ):
                    _send_result(connection, False)
                    return
                code = request["code"]
                if not isinstance(code, str) or len(code) != 8:
                    _send_result(connection, False)
                    return
                if action == "approve":
                    self.service._approve_verified(code, actor)
                else:
                    self.service._refuse_verified(code, actor)
            except PublicFailure:
                _send_result(connection, False)
                return
            _send_result(connection, True)
        except (OSError, ValueError, PublicFailure):
            try:
                _send_result(connection, False)
            except OSError:
                pass

    def _listener(self) -> socket.socket:
        _protected_directory(self.socket_path.parent, self.socket_gid)
        if self.socket_path.exists() or self.socket_path.is_symlink():
            raise PublicFailure()
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
            info = self.socket_path.lstat()
            if (
                not stat.S_ISSOCK(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_gid != self.socket_gid
                or stat.S_IMODE(info.st_mode) != self.socket_mode
            ):
                raise PublicFailure()
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

    def serve_once(self, ready=None) -> None:
        listener = self._listener()
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

    def serve_forever(self) -> None:
        listener = self._listener()
        try:
            while True:
                connection, _ = listener.accept()
                with connection:
                    self._handle(connection)
        finally:
            listener.close()
            try:
                self.socket_path.unlink()
            except FileNotFoundError:
                pass


def _request(
    socket_path: str | os.PathLike[str],
    request: dict,
) -> dict | None:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    response = bytearray()
    try:
        client.settimeout(5)
        client.connect(os.fspath(socket_path))
        encoded = bytearray(
            json.dumps(request, separators=(",", ":")).encode("ascii")
            + b"\n"
        )
        try:
            client.sendall(encoded)
        finally:
            clear(encoded)
            encoded.clear()
        while len(response) <= MAX_RESPONSE_BYTES:
            chunk = client.recv(
                min(4096, MAX_RESPONSE_BYTES + 1 - len(response))
            )
            if not chunk:
                return None
            response.extend(chunk)
            if b"\n" in chunk:
                break
        if (
            len(response) > MAX_RESPONSE_BYTES
            or not response.endswith(b"\n")
            or response.count(b"\n") != 1
        ):
            return None
        try:
            parsed = json.loads(response)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return parsed if isinstance(parsed, dict) else None
    except (OSError, ValueError):
        return None
    finally:
        client.close()
        clear(response)
        response.clear()


def request_pending(
    socket_path: str | os.PathLike[str],
) -> list[dict[str, str | float]] | None:
    response = _request(socket_path, {"action": "pending"})
    if (
        not isinstance(response, dict)
        or set(response) != {"ok", "pending"}
        or response.get("ok") is not True
    ):
        return None
    pending = response.get("pending")
    if not isinstance(pending, list) or len(pending) > MAX_PENDING_RESULTS:
        return None
    for item in pending:
        if (
            not isinstance(item, dict)
            or set(item)
            != {"botName", "code", "requestedAt", "invitedBy"}
            or not isinstance(item["botName"], str)
            or BOT_NAME.fullmatch(item["botName"]) is None
            or not isinstance(item["code"], str)
            or len(item["code"]) != 8
            or not isinstance(item["requestedAt"], (int, float))
            or isinstance(item["requestedAt"], bool)
            or not isinstance(item["invitedBy"], str)
            or not item["invitedBy"]
            or len(item["invitedBy"]) > 64
        ):
            return None
    return pending


def request_invites(
    socket_path: str | os.PathLike[str],
) -> list[dict[str, str | float | None]] | None:
    response = _request(socket_path, {"action": "listInvites"})
    if (
        not isinstance(response, dict)
        or set(response) != {"ok", "invites"}
        or response.get("ok") is not True
    ):
        return None
    invites = response.get("invites")
    if not isinstance(invites, list) or len(invites) > MAX_INVITE_RESULTS:
        return None
    expected = {
        "inviteId",
        "botName",
        "invitedBy",
        "createdAt",
        "expiresAt",
    }
    for item in invites:
        if (
            not isinstance(item, dict)
            or set(item) != expected
            or not isinstance(item["inviteId"], str)
            or INVITE_ID.fullmatch(item["inviteId"]) is None
            or (
                item["botName"] is not None
                and (
                    not isinstance(item["botName"], str)
                    or BOT_NAME.fullmatch(item["botName"]) is None
                )
            )
            or not isinstance(item["invitedBy"], str)
            or not item["invitedBy"]
            or len(item["invitedBy"]) > 64
            or not isinstance(item["createdAt"], (int, float))
            or isinstance(item["createdAt"], bool)
            or not isinstance(item["expiresAt"], (int, float))
            or isinstance(item["expiresAt"], bool)
            or item["expiresAt"] <= item["createdAt"]
        ):
            return None
    return invites


def request_bots(
    socket_path: str | os.PathLike[str],
) -> list[str] | None:
    response = _request(socket_path, {"action": "listBots"})
    if (
        not isinstance(response, dict)
        or set(response) != {"ok", "bots"}
        or response.get("ok") is not True
    ):
        return None
    bots = response.get("bots")
    if not isinstance(bots, list) or len(bots) > MAX_BOT_RESULTS:
        return None
    for name in bots:
        if not isinstance(name, str) or BOT_NAME.fullmatch(name) is None:
            return None
    if len(set(bots)) != len(bots):
        return None
    return bots


def request_invite_creation(
    socket_path: str | os.PathLike[str],
    bot_name: str | None,
) -> dict[str, str | float | None] | None:
    if (
        bot_name is not None
        and (
            not isinstance(bot_name, str)
            or BOT_NAME.fullmatch(bot_name) is None
        )
    ):
        return None
    request = {"action": "createInvite"}
    if bot_name is not None:
        request["botName"] = bot_name
    response = _request(socket_path, request)
    if (
        not isinstance(response, dict)
        or set(response) != {"ok", "invite"}
        or response.get("ok") is not True
    ):
        return None
    invite = response.get("invite")
    expected = {
        "inviteId",
        "code",
        "botName",
        "invitedBy",
        "createdAt",
        "expiresAt",
    }
    if (
        not isinstance(invite, dict)
        or set(invite) != expected
        or not isinstance(invite["inviteId"], str)
        or INVITE_ID.fullmatch(invite["inviteId"]) is None
        or not isinstance(invite["code"], str)
        or not invite["code"].isascii()
        or INVITE_CODE.fullmatch(invite["code"].encode("ascii")) is None
        or (
            invite["botName"] is not None
            and (
                not isinstance(invite["botName"], str)
                or BOT_NAME.fullmatch(invite["botName"]) is None
            )
        )
        or invite["invitedBy"] != "Captain"
        or not isinstance(invite["createdAt"], (int, float))
        or isinstance(invite["createdAt"], bool)
        or not isinstance(invite["expiresAt"], (int, float))
        or isinstance(invite["expiresAt"], bool)
        or invite["expiresAt"] <= invite["createdAt"]
    ):
        return None
    return invite


def request_invite_cancellation(
    socket_path: str | os.PathLike[str],
    invite_id: str,
) -> bool:
    if (
        not isinstance(invite_id, str)
        or INVITE_ID.fullmatch(invite_id) is None
    ):
        return False
    return _request(
        socket_path,
        {"action": "cancelInvite", "inviteId": invite_id},
    ) == {"ok": True}


def _request_decision(socket_path: str | os.PathLike[str], action: str, code: str) -> bool:
    if action not in {"approve", "refuse"} or not isinstance(code, str) or len(code) != 8:
        return False
    return _request(socket_path, {"action": action, "code": code}) == {"ok": True}


def request_approval(socket_path: str | os.PathLike[str], code: str) -> bool:
    return _request_decision(socket_path, "approve", code)


def request_refusal(socket_path: str | os.PathLike[str], code: str) -> bool:
    return _request_decision(socket_path, "refuse", code)


def main() -> int:
    if len(sys.argv) != 1:
        return 2
    invite_hmac_key: bytearray | None = None
    try:
        role = pwd.getpwnam(APPROVER_ROLE)
        socket_mode, socket_gid = _configured_socket_access()
        invite_hmac_key = _load_invite_hmac_key(INVITE_HMAC_KEY_PATH)
        service = JoinService(
            DATABASE_PATH,
            invite_hmac_key=invite_hmac_key,
        )
        ApprovalService(
            service,
            SOCKET_PATH,
            role.pw_uid,
            lambda uid: pwd.getpwuid(uid).pw_name,
            socket_mode=socket_mode,
            socket_gid=socket_gid,
        ).serve_forever()
    except (KeyError, OSError, PublicFailure):
        return 2
    finally:
        if invite_hmac_key is not None:
            clear(invite_hmac_key)
            invite_hmac_key.clear()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
