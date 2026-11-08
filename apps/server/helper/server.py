from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import stat
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import helper
import jmap_verifier
import management_transport
import stalwart_admin
from helper_contract import (
    ApprovedJoin,
    BotRecord,
    CollectTarget,
    PreparedCollect,
    ReplacementCommitted,
)

SOCKET_PATH = Path("/run/quarterdeck-control/helper.sock")
MAX_REQUEST_BYTES = 8192
MAX_RESPONSE_BYTES = 8192
RECEIPT = re.compile(r"[a-z][a-z0-9-]{0,31}-[0-9a-f]{32}\.key\Z")


class HelperServerRefused(RuntimeError):
    pass

@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    socket_path: str
    socket_group: int
    expected_uid: int
    ledger_path: str
    key_directory: str
    admin_secret_path: str
    admin_username: str
    management_address: str
    management_port: int
    mail_domain: str
    session_url: str


def load_runtime_config(path: str | os.PathLike[str]) -> RuntimeConfig:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise HelperServerRefused("helper runtime configuration refused") from None
    if (
        not isinstance(document, dict)
        or set(document)
        != {
            "format",
            "socket",
            "paths",
            "joinUid",
            "management",
            "mailDomain",
            "sessionUrl",
        }
        or document.get("format") != 1
        or not isinstance(document.get("socket"), dict)
        or set(document["socket"]) != {"path", "group"}
        or not isinstance(document.get("paths"), dict)
        or set(document["paths"]) != {"ledger", "keys", "adminSecret"}
        or not isinstance(document.get("management"), dict)
        or set(document["management"]) != {"username", "address", "port"}
    ):
        raise HelperServerRefused("helper runtime configuration refused")
    socket_config = document["socket"]
    paths = document["paths"]
    management = document["management"]
    string_values = (
        socket_config["path"],
        paths["ledger"],
        paths["keys"],
        paths["adminSecret"],
        management["username"],
        management["address"],
        document["mailDomain"],
        document["sessionUrl"],
    )
    socket_group = socket_config["group"]
    expected_uid = document["joinUid"]
    management_port = management["port"]
    try:
        management_address = ipaddress.ip_address(management["address"])
    except ValueError:
        raise HelperServerRefused("helper runtime configuration refused") from None
    if (
        any(
            not isinstance(value, str)
            or not value
            or "\0" in value
            for value in string_values
        )
        or any(
            not Path(value).is_absolute()
            for value in string_values[:4]
        )
        or any(
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 1 <= value <= 2_147_483_647
            for value in (socket_group, expected_uid)
        )
        or not isinstance(management_port, int)
        or isinstance(management_port, bool)
        or not 1024 <= management_port <= 65535
        or not management_address.is_loopback
        or re.fullmatch(r"[A-Za-z0-9.-]{1,253}", document["mailDomain"])
        is None
    ):
        raise HelperServerRefused("helper runtime configuration refused")
    return RuntimeConfig(
        socket_config["path"],
        socket_group,
        expected_uid,
        paths["ledger"],
        paths["keys"],
        paths["adminSecret"],
        management["username"],
        str(management_address),
        management_port,
        document["mailDomain"],
        document["sessionUrl"],
    )


def _clear(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)
        value.clear()


def _private_directory(path: Path) -> int:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        os.close(descriptor)
        raise HelperServerRefused("helper storage refused")
    return descriptor


def _write_all(descriptor: int, value: bytes | bytearray) -> None:
    offset = 0
    with memoryview(value) as view:
        while offset < len(value):
            written = os.write(descriptor, view[offset:])
            if written <= 0:
                raise HelperServerRefused("helper storage refused")
            offset += written


class PrivateKeyAdapter:
    def __init__(self, root: str | os.PathLike[str], *, token_hex=secrets.token_hex) -> None:
        self.root = Path(root)
        self.token_hex = token_hex
        descriptor = _private_directory(self.root)
        os.close(descriptor)

    def save(self, bot_name: str, token: bytearray) -> str:
        if (
            not isinstance(bot_name, str)
            or re.fullmatch(r"[a-z][a-z0-9-]{0,31}", bot_name) is None
            or not helper._valid_api_key(token)
        ):
            raise HelperServerRefused("helper key adapter refused")
        receipt = f"{bot_name}-{self.token_hex(16)}.key"
        if RECEIPT.fullmatch(receipt) is None:
            raise HelperServerRefused("helper key adapter refused")
        directory = _private_directory(self.root)
        try:
            descriptor = os.open(
                receipt,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=directory,
            )
            try:
                _write_all(descriptor, token)
                os.fsync(descriptor)
                info = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_nlink != 1
                ):
                    raise HelperServerRefused("helper key adapter refused")
            finally:
                os.close(descriptor)
            os.fsync(directory)
            return receipt
        except Exception:
            try:
                os.unlink(receipt, dir_fd=directory)
                os.fsync(directory)
            except OSError:
                pass
            raise
        finally:
            os.close(directory)

    def read(self, receipt: str) -> bytearray:
        if not isinstance(receipt, str) or RECEIPT.fullmatch(receipt) is None:
            raise HelperServerRefused("helper key adapter refused")
        directory = _private_directory(self.root)
        value = bytearray(helper.API_KEY_MAX_LENGTH + 1)
        size = 0
        try:
            descriptor = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
            try:
                before = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or before.st_uid != os.getuid()
                    or stat.S_IMODE(before.st_mode) != 0o600
                    or before.st_nlink != 1
                ):
                    raise HelperServerRefused("helper key adapter refused")
                with memoryview(value) as view:
                    while size <= helper.API_KEY_MAX_LENGTH:
                        amount = os.readv(descriptor, [view[size:]])
                        if not amount:
                            break
                        size += amount
                after = os.fstat(descriptor)
                if (
                    size > helper.API_KEY_MAX_LENGTH
                    or (before.st_dev, before.st_ino, before.st_uid, before.st_mode, before.st_nlink)
                    != (after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_nlink)
                ):
                    raise HelperServerRefused("helper key adapter refused")
            finally:
                os.close(descriptor)
            del value[size:]
            if not helper._valid_api_key(value):
                raise HelperServerRefused("helper key adapter refused")
            return value
        except Exception:
            _clear(value)
            raise
        finally:
            os.close(directory)

    def retire(self, receipt: str, reason: str) -> None:
        if (
            not isinstance(receipt, str)
            or RECEIPT.fullmatch(receipt) is None
            or not isinstance(reason, str)
            or not reason
        ):
            raise HelperServerRefused("helper key adapter refused")
        directory = _private_directory(self.root)
        try:
            try:
                os.unlink(receipt, dir_fd=directory)
            except FileNotFoundError:
                return
            os.fsync(directory)
        finally:
            os.close(directory)


class TargetLedger(Protocol):
    def store(self, target: CollectTarget) -> None: ...
    def contains(self, target: CollectTarget) -> bool: ...
    def remove(self, target: CollectTarget) -> None: ...
    def pending(self) -> list[CollectTarget]: ...


class MemoryLedger:
    def __init__(self) -> None:
        self.targets: dict[str, CollectTarget] = {}

    def store(self, target: CollectTarget) -> None:
        if target.helper_receipt in self.targets:
            raise HelperServerRefused("helper target refused")
        self.targets[target.helper_receipt] = target

    def contains(self, target: CollectTarget) -> bool:
        return self.targets.get(target.helper_receipt) == target

    def remove(self, target: CollectTarget) -> None:
        self.targets.pop(target.helper_receipt, None)

    def pending(self) -> list[CollectTarget]:
        return list(self.targets.values())


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exception_type, exception, traceback):
        try:
            return super().__exit__(exception_type, exception, traceback)
        finally:
            self.close()


class PreparedLedger:
    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        directory = _private_directory(self.path.parent)
        os.close(directory)
        try:
            descriptor = os.open(
                self.path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
            )
        except FileExistsError:
            descriptor = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1
            ):
                raise HelperServerRefused("helper target ledger refused")
        finally:
            os.close(descriptor)
        with self._connect() as database:
            database.execute(
                "CREATE TABLE IF NOT EXISTS prepared ("
                "helper_receipt TEXT PRIMARY KEY, bot_name TEXT NOT NULL, "
                "account_id TEXT NOT NULL, key_id TEXT NOT NULL)"
            )

    def _connect(self) -> sqlite3.Connection:
        database = sqlite3.connect(
            self.path, isolation_level=None, timeout=5, factory=_ClosingConnection
        )
        database.row_factory = sqlite3.Row
        database.execute("PRAGMA journal_mode = DELETE")
        database.execute("PRAGMA synchronous = FULL")
        return database

    def store(self, target: CollectTarget) -> None:
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            database.execute(
                "INSERT INTO prepared (helper_receipt, bot_name, account_id, key_id) VALUES (?, ?, ?, ?)",
                (target.helper_receipt, target.bot_name, target.account_id, target.key_id),
            )
            database.execute("COMMIT")

    def contains(self, target: CollectTarget) -> bool:
        with self._connect() as database:
            row = database.execute(
                "SELECT bot_name, account_id, key_id FROM prepared WHERE helper_receipt = ?",
                (target.helper_receipt,),
            ).fetchone()
        return row is not None and tuple(row) == (
            target.bot_name,
            target.account_id,
            target.key_id,
        )

    def remove(self, target: CollectTarget) -> None:
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            database.execute(
                "DELETE FROM prepared WHERE helper_receipt = ? AND bot_name = ? AND account_id = ? AND key_id = ?",
                (target.helper_receipt, target.bot_name, target.account_id, target.key_id),
            )
            database.execute("COMMIT")

    def pending(self) -> list[CollectTarget]:
        with self._connect() as database:
            rows = database.execute(
                "SELECT bot_name, account_id, key_id, helper_receipt FROM prepared ORDER BY helper_receipt"
            ).fetchall()
        return [CollectTarget(*tuple(row)) for row in rows]


def recover_prepared(account_helper: helper.ThreeActionHelper, ledger: TargetLedger) -> int:
    targets = ledger.pending()
    for target in targets:
        account_helper.rollback_collect(target)
        ledger.remove(target)
    return len(targets)


def _peer_uid(connection: socket.socket) -> int:
    size = struct.calcsize("3i")
    _, uid, _ = struct.unpack(
        "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size)
    )
    return uid


def _receive_request(connection: socket.socket) -> dict | None:
    connection.settimeout(5)
    body = bytearray()
    try:
        while len(body) <= MAX_REQUEST_BYTES and b"\n" not in body:
            chunk = connection.recv(min(1024, MAX_REQUEST_BYTES + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        if (
            len(body) > MAX_REQUEST_BYTES
            or not body.endswith(b"\n")
            or body.count(b"\n") != 1
        ):
            return None
        parsed = json.loads(body)
        return parsed if isinstance(parsed, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        _clear(body)


def _send_json(connection: socket.socket, value: dict) -> None:
    encoded = json.dumps(value, separators=(",", ":")).encode("ascii") + b"\n"
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise HelperServerRefused("helper response refused")
    connection.sendall(encoded)


def _target(value: object) -> CollectTarget:
    if not isinstance(value, dict) or set(value) != {
        "botName", "accountId", "keyId", "helperReceipt"
    }:
        raise HelperServerRefused("helper request refused")
    return CollectTarget(
        value["botName"], value["accountId"], value["keyId"], value["helperReceipt"]
    )


def _record(value: object) -> BotRecord:
    if not isinstance(value, dict) or set(value) != {
        "botName", "accountId", "keyId", "adapterReceipt"
    }:
        raise HelperServerRefused("helper request refused")
    return BotRecord(
        value["botName"], value["accountId"], value["keyId"], value["adapterReceipt"]
    )


def _target_json(target: CollectTarget) -> dict[str, str]:
    return {
        "botName": target.bot_name,
        "accountId": target.account_id,
        "keyId": target.key_id,
        "helperReceipt": target.helper_receipt,
    }


def _record_json(record: BotRecord) -> dict[str, str]:
    return {
        "botName": record.bot_name,
        "accountId": record.account_id,
        "keyId": record.key_id,
        "adapterReceipt": record.adapter_receipt,
    }


class HelperSocketHandler:
    def __init__(
        self,
        account_helper: helper.ThreeActionHelper,
        expected_uid: int,
        ledger: TargetLedger | None = None,
    ) -> None:
        self.account_helper = account_helper
        self.expected_uid = expected_uid
        self.ledger = ledger if ledger is not None else MemoryLedger()

    def handle(self, connection: socket.socket) -> None:
        prepared: PreparedCollect | None = None
        credential: bytearray | None = None
        stored_target: CollectTarget | None = None
        try:
            if _peer_uid(connection) != self.expected_uid:
                _send_json(connection, {"ok": False})
                return
            request = _receive_request(connection)
            if request is None:
                raise HelperServerRefused("helper request refused")
            action = request.get("action")
            if action == "prepare" and set(request) == {"action", "approvalId", "botName"}:
                prepared = self.account_helper.prepare_collect(
                    ApprovedJoin(request["approvalId"], request["botName"])
                )
                stored_target = prepared.target
                credential = prepared.take_credential()
                self.ledger.store(stored_target)
                _send_json(
                    connection,
                    {
                        "ok": True,
                        "target": _target_json(stored_target),
                        "credentialBytes": len(credential),
                    },
                )
                connection.sendall(memoryview(credential))
                return
            if action in {"activate", "rollback"} and set(request) == {"action", "target"}:
                target = _target(request["target"])
                if action == "activate":
                    if not self.ledger.contains(target):
                        raise HelperServerRefused("helper target refused")
                    record = self.account_helper.activate_collect(target)
                    self.ledger.remove(target)
                    _send_json(connection, {"ok": True, "record": _record_json(record)})
                else:
                    self.account_helper.rollback_collect(target)
                    self.ledger.remove(target)
                    _send_json(connection, {"ok": True})
                return
            if action in {"replace", "cancel"} and set(request) == {"action", "record"}:
                record = _record(request["record"])
                if action == "replace":
                    replacement = self.account_helper.replace(record)
                    _send_json(connection, {"ok": True, "record": _record_json(replacement)})
                else:
                    self.account_helper.cancel(record)
                    _send_json(connection, {"ok": True})
                return
            raise HelperServerRefused("helper request refused")
        except ReplacementCommitted as error:
            try:
                _send_json(
                    connection,
                    {
                        "ok": True,
                        "replacementCommitted": True,
                        "record": _record_json(error.record),
                    },
                )
            except Exception:
                pass
        except Exception:
            if stored_target is not None:
                try:
                    self.account_helper.rollback_collect(stored_target)
                    self.ledger.remove(stored_target)
                except Exception:
                    pass
            try:
                _send_json(connection, {"ok": False})
            except Exception:
                pass
        finally:
            if prepared is not None:
                prepared.clear()
            _clear(credential)

def _prepare_socket_path(path: Path, socket_group: int) -> None:
    if not path.is_absolute():
        raise HelperServerRefused("helper socket path refused")
    parent = os.lstat(path.parent)
    if (
        not stat.S_ISDIR(parent.st_mode)
        or stat.S_IMODE(parent.st_mode) != 0o2770
        or parent.st_gid != socket_group
        or socket_group not in {os.getgid(), *os.getgroups()}
    ):
        raise HelperServerRefused("helper socket directory refused")
    try:
        existing = os.lstat(path)
    except FileNotFoundError:
        return
    if (
        not stat.S_ISSOCK(existing.st_mode)
        or existing.st_uid != os.getuid()
        or existing.st_gid != socket_group
        or stat.S_IMODE(existing.st_mode) != 0o660
    ):
        raise HelperServerRefused("helper socket path refused")
    os.unlink(path)


def serve(
    handler: HelperSocketHandler,
    socket_path: str,
    socket_group: int,
) -> None:
    path = Path(socket_path)
    _prepare_socket_path(path, socket_group)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(socket_path)
        os.chmod(socket_path, 0o660)
        created = os.lstat(socket_path)
        if (
            not stat.S_ISSOCK(created.st_mode)
            or created.st_uid != os.getuid()
            or created.st_gid != socket_group
            or stat.S_IMODE(created.st_mode) != 0o660
        ):
            raise HelperServerRefused("helper socket bind refused")
        listener.listen(16)
        while True:
            connection, _ = listener.accept()
            with connection:
                handler.handle(connection)
    finally:
        listener.close()
        try:
            current = os.lstat(path)
            if (
                stat.S_ISSOCK(current.st_mode)
                and current.st_uid == os.getuid()
                and current.st_gid == socket_group
            ):
                os.unlink(path)
        except FileNotFoundError:
            pass


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2 or args[0] != "--config":
        return 2
    try:
        runtime = load_runtime_config(args[1])
        secret_reader = management_transport.PrivateSecretFile(
            runtime.admin_secret_path
        )
        management = management_transport.ManagementTransport(
            runtime.admin_username,
            secret_reader,
            connection_factory=lambda: http.client.HTTPConnection(
                runtime.management_address,
                runtime.management_port,
                timeout=15,
            ),
        )
        account_helper = helper.ThreeActionHelper(
            stalwart_admin.StalwartAdmin(management, runtime.mail_domain),
            PrivateKeyAdapter(runtime.key_directory),
            jmap_verifier.JmapVerifier(runtime.session_url),
        )
        ledger = PreparedLedger(runtime.ledger_path)
        recover_prepared(account_helper, ledger)
        serve(
            HelperSocketHandler(
                account_helper,
                runtime.expected_uid,
                ledger,
            ),
            runtime.socket_path,
            runtime.socket_group,
        )
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
