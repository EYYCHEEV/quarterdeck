from __future__ import annotations

import base64
import ipaddress
import json
import math
import os
import re
import socket
import sqlite3
import stat
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from helper_contract import (
    ApprovedJoin,
    BotRecord,
    CollectTarget,
    HelperRefused,
    PreparedCollect,
    ReplacementCommitted,
)
from signup_flow import (
    INVITE_HMAC_KEY_BYTES,
    BotIdentity,
    JoinService,
    PublicFailure,
    SignupService,
    clear,
)

import invite_prompt
import qd_jmap
import approval_service

MAX_BODY_BYTES = 4096
REQUEST_PATH = "/qd/join/request"
COLLECT_PATH = "/qd/join/collect"
BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
INVITE_PATH = "/qd/invite"
API_KEY = re.compile(rb"API_[A-Za-z0-9_-]{20,508}\Z")
MAX_API_KEY_BYTES = 512
CODE = re.compile(r"[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}\Z")
PUBLIC_BODY = "request could not be completed"
PAIRING_BYTES = 32
PROOF_BYTES = 32


class JoinRefused(RuntimeError):
    pass


class JoinRateLimited(JoinRefused):
    pass


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    bind_address: str
    bind_port: int
    database_path: str
    rates_path: str
    helper_socket: str
    approval_socket: str
    invite_key_path: str
    trusted_proxy: str
    public_origin: str
    session_url: str
    approver_uid: int
    approval_socket_mode: int
    approval_socket_gid: int
    release_artifact_url: str | None
    release_version: str | None
    release_sha256: str | None


class PeriodicRecovery:
    def __init__(
        self,
        signup: SignupService,
        *,
        interval: float = 60.0,
        stop_event: threading.Event | None = None,
    ) -> None:
        if interval <= 0:
            raise JoinRefused("join recovery schedule refused")
        self.signup = signup
        self.interval = interval
        self.stop_event = (
            stop_event if stop_event is not None else threading.Event()
        )
        self.failure: Exception | None = None
        self._thread: threading.Thread | None = None

    def _run(self, on_failure: Callable[[], None]) -> None:
        while not self.stop_event.wait(self.interval):
            try:
                self.signup.recover_unfinished(False)
            except Exception as error:
                self.failure = error
                on_failure()
                return

    def start(self, on_failure: Callable[[], None]) -> None:
        if self._thread is not None:
            raise JoinRefused("join recovery schedule refused")
        self._thread = threading.Thread(
            target=self._run,
            args=(on_failure,),
            name="quarterdeck-deadline-recovery",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def join(self, timeout: float | None = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)


def load_runtime_config(path: str | os.PathLike[str]) -> RuntimeConfig:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise JoinRefused("join runtime configuration refused") from None
    if (
        not isinstance(document, dict)
        or set(document)
        != {
            "format",
            "bind",
            "paths",
            "trustedProxy",
            "publicOrigin",
            "sessionUrl",
            "approverUid",
            "approvalSocketAccess",
            "release",
        }
        or document.get("format") != 1
        or not isinstance(document.get("bind"), dict)
        or set(document["bind"]) != {"address", "port"}
        or not isinstance(document.get("paths"), dict)
        or set(document["paths"])
        != {
            "database",
            "rates",
            "helperSocket",
            "approvalSocket",
            "inviteKey",
        }
        or not isinstance(document.get("approvalSocketAccess"), dict)
        or set(document["approvalSocketAccess"]) != {"mode", "gid"}
        or not isinstance(document.get("release"), dict)
        or set(document["release"])
        != {"artifactUrl", "version", "sha256"}
    ):
        raise JoinRefused("join runtime configuration refused")
    port = document["bind"]["port"]
    approver_uid = document["approverUid"]
    approval_access = document["approvalSocketAccess"]
    approval_socket_gid = approval_access["gid"]
    paths = document["paths"]
    values = (
        document["bind"]["address"],
        paths["database"],
        paths["rates"],
        paths["helperSocket"],
        paths["approvalSocket"],
        paths["inviteKey"],
        document["trustedProxy"],
        document["publicOrigin"],
        document["sessionUrl"],
    )
    release_values = (
        document["release"]["artifactUrl"],
        document["release"]["version"],
        document["release"]["sha256"],
    )
    release_is_unpublished = all(value is None for value in release_values)
    release_is_pinned = all(
        isinstance(value, str)
        and bool(value)
        and "\0" not in value
        and "${" not in value
        for value in release_values
    )
    if (
        any(
            not isinstance(value, str)
            or not value
            or "\0" in value
            for value in values
        )
        or not (release_is_unpublished or release_is_pinned)
        or not isinstance(port, int)
        or isinstance(port, bool)
        or not 1 <= port <= 65535
        or not isinstance(approver_uid, int)
        or isinstance(approver_uid, bool)
        or not 1 <= approver_uid <= 2_147_483_647
        or approval_access["mode"] != "0660"
        or not isinstance(approval_socket_gid, int)
        or isinstance(approval_socket_gid, bool)
        or not 0 <= approval_socket_gid <= 2_147_483_647
        or any(
            not Path(value).is_absolute()
            for value in values[1:6]
        )
    ):
        raise JoinRefused("join runtime configuration refused")
    return RuntimeConfig(
        values[0],
        port,
        values[1],
        values[2],
        values[3],
        values[4],
        values[5],
        values[6],
        values[7],
        values[8],
        approver_uid,
        0o660,
        approval_socket_gid,
        release_values[0],
        release_values[1],
        release_values[2],
    )


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
            raise JoinRefused("join invite key refused")
        with memoryview(value) as view:
            while offset < INVITE_HMAC_KEY_BYTES:
                amount = os.readv(descriptor, [view[offset:]])
                if not amount:
                    break
                offset += amount
        if offset != INVITE_HMAC_KEY_BYTES:
            raise JoinRefused("join invite key refused")
        return value
    except Exception:
        clear_buffer(value)
        raise
    finally:
        os.close(descriptor)


class BotInviteAuthenticator:
    def __init__(self, session_url: str, *, transport=None) -> None:
        try:
            self.session_url = qd_jmap.check_session_url(session_url)
        except qd_jmap.Refused as error:
            raise JoinRefused("bot invite authentication refused") from error
        self.transport = (
            transport if transport is not None else qd_jmap.HttpTransport()
        )

    def authenticate(self, key: bytearray) -> BotIdentity:
        credential = None
        try:
            if (
                not isinstance(key, bytearray)
                or len(key) > MAX_API_KEY_BYTES
                or API_KEY.fullmatch(key) is None
            ):
                raise JoinRefused("bot invite authentication refused")
            credential = qd_jmap.Credential(key)
            jmap = qd_jmap.Jmap(
                self.session_url,
                credential,
                self.transport,
            )
            mailbox = qd_jmap.Mailbox(jmap)
            return BotIdentity(mailbox.bot, jmap.account)
        except (qd_jmap.Refused, qd_jmap.MailFailed, PublicFailure) as error:
            raise JoinRefused("bot invite authentication refused") from error
        finally:
            if credential is not None:
                credential.clear()
            else:
                clear_buffer(key)




class HelperSocketClient:
    def __init__(
        self,
        path: str | os.PathLike[str],
        *,
        connector: Callable[[], socket.socket] | None = None,
    ) -> None:
        self.path = Path(path)
        if not self.path.is_absolute():
            raise HelperRefused("helper action refused")
        self.connector = connector

    def _connect(self) -> socket.socket:
        if self.connector is not None:
            return self.connector()
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            connection.settimeout(5)
            connection.connect(str(self.path))
            return connection
        except Exception:
            connection.close()
            raise

    @staticmethod
    def _receive_header(connection: socket.socket) -> tuple[dict, bytearray]:
        received = bytearray()
        chunk = bytearray(1024)
        header = bytearray()
        remainder = bytearray()
        try:
            while b"\n" not in received:
                amount = connection.recv_into(chunk)
                if amount <= 0:
                    raise HelperRefused("helper action refused")
                received.extend(memoryview(chunk)[:amount])
                chunk[:amount] = b"\x00" * amount
                newline = received.find(b"\n")
                if newline < 0 and len(received) > 8192:
                    raise HelperRefused("helper action refused")
            newline = received.find(b"\n")
            if newline > 8192 or received[:newline].find(b"\n") >= 0:
                raise HelperRefused("helper action refused")
            header.extend(received[:newline])
            remainder.extend(received[newline + 1 :])
            value = json.loads(header)
            if not isinstance(value, dict):
                raise HelperRefused("helper action refused")
            return value, remainder
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            clear_buffer(remainder)
            raise HelperRefused("helper action refused") from error
        finally:
            clear_buffer(received)
            clear_buffer(chunk)
            clear_buffer(header)

    @staticmethod
    def _read_exact(
        connection: socket.socket, initial: bytearray, amount: int
    ) -> bytearray:
        if not 24 <= amount <= 512 or len(initial) > amount:
            clear_buffer(initial)
            raise HelperRefused("helper action refused")
        chunk = bytearray(min(1024, amount))
        try:
            while len(initial) < amount:
                count = connection.recv_into(
                    memoryview(chunk)[: min(len(chunk), amount - len(initial))]
                )
                if count <= 0:
                    raise HelperRefused("helper action refused")
                initial.extend(memoryview(chunk)[:count])
                chunk[:count] = b"\x00" * count
            return initial
        except Exception:
            clear_buffer(initial)
            raise
        finally:
            clear_buffer(chunk)

    def _exchange(
        self, request: dict, *, with_credential: bool = False
    ) -> tuple[dict, bytearray]:
        connection = self._connect()
        encoded = bytearray()
        try:
            connection.settimeout(5)
            encoded.extend(json.dumps(request, separators=(",", ":")).encode("ascii"))
            encoded.append(0x0A)
            if len(encoded) > 8192:
                raise HelperRefused("helper action refused")
            connection.sendall(encoded)
            response, remainder = self._receive_header(connection)
            if response == {"ok": False}:
                clear_buffer(remainder)
                raise HelperRefused("helper action refused")
            if response.get("ok") is not True:
                clear_buffer(remainder)
                raise HelperRefused("helper action refused")
            if with_credential:
                amount = response.get("credentialBytes")
                if not isinstance(amount, int) or isinstance(amount, bool):
                    clear_buffer(remainder)
                    raise HelperRefused("helper action refused")
                remainder = self._read_exact(connection, remainder, amount)
            return response, remainder
        except HelperRefused:
            raise
        except Exception as error:
            raise HelperRefused("helper action refused") from error
        finally:
            clear_buffer(encoded)
            connection.close()

    @staticmethod
    def _target(value: object) -> CollectTarget:
        if not isinstance(value, dict) or set(value) != {
            "botName",
            "accountId",
            "keyId",
            "helperReceipt",
        }:
            raise HelperRefused("helper action refused")
        return CollectTarget(
            value["botName"], value["accountId"], value["keyId"], value["helperReceipt"]
        )

    @staticmethod
    def _record(value: object) -> BotRecord:
        if not isinstance(value, dict) or set(value) != {
            "botName",
            "accountId",
            "keyId",
            "adapterReceipt",
        }:
            raise HelperRefused("helper action refused")
        return BotRecord(
            value["botName"], value["accountId"], value["keyId"], value["adapterReceipt"]
        )

    @staticmethod
    def _target_json(target: CollectTarget) -> dict[str, str]:
        return {
            "botName": target.bot_name,
            "accountId": target.account_id,
            "keyId": target.key_id,
            "helperReceipt": target.helper_receipt,
        }

    @staticmethod
    def _record_json(record: BotRecord) -> dict[str, str]:
        return {
            "botName": record.bot_name,
            "accountId": record.account_id,
            "keyId": record.key_id,
            "adapterReceipt": record.adapter_receipt,
        }

    def prepare_collect(self, join: ApprovedJoin) -> PreparedCollect:
        if not isinstance(join, ApprovedJoin):
            raise HelperRefused("helper action refused")
        response, credential = self._exchange(
            {
                "action": "prepare",
                "approvalId": join.approval_id,
                "botName": join.bot_name,
            },
            with_credential=True,
        )
        try:
            if set(response) != {"ok", "target", "credentialBytes"}:
                raise HelperRefused("helper action refused")
            amount = response["credentialBytes"]
            if not isinstance(amount, int) or isinstance(amount, bool):
                raise HelperRefused("helper action refused")
            if len(credential) != amount:
                raise HelperRefused("helper action refused")
            prepared = PreparedCollect(self._target(response["target"]), credential)
            credential = bytearray()
            return prepared
        finally:
            clear_buffer(credential)

    def activate_collect(self, target: CollectTarget) -> BotRecord:
        response, remainder = self._exchange(
            {"action": "activate", "target": self._target_json(target)}
        )
        try:
            if remainder or set(response) != {"ok", "record"}:
                raise HelperRefused("helper action refused")
            return self._record(response["record"])
        finally:
            clear_buffer(remainder)

    def rollback_collect(self, target: CollectTarget) -> None:
        response, remainder = self._exchange(
            {"action": "rollback", "target": self._target_json(target)}
        )
        try:
            if remainder or response != {"ok": True}:
                raise HelperRefused("helper action refused")
        finally:
            clear_buffer(remainder)

    def replace(self, record: BotRecord) -> BotRecord:
        response, remainder = self._exchange(
            {"action": "replace", "record": self._record_json(record)}
        )
        try:
            if remainder:
                raise HelperRefused("helper action refused")
            if set(response) == {"ok", "replacementCommitted", "record"}:
                if response["replacementCommitted"] is not True:
                    raise HelperRefused("helper action refused")
                raise ReplacementCommitted(self._record(response["record"]))
            if set(response) != {"ok", "record"}:
                raise HelperRefused("helper action refused")
            return self._record(response["record"])
        finally:
            clear_buffer(remainder)

    def cancel(self, record: BotRecord) -> None:
        response, remainder = self._exchange(
            {"action": "cancel", "record": self._record_json(record)}
        )
        try:
            if remainder or response != {"ok": True}:
                raise HelperRefused("helper action refused")
        finally:
            clear_buffer(remainder)

def clear_buffer(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)
        value.clear()


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exception_type, exception, traceback):
        try:
            return super().__exit__(exception_type, exception, traceback)
        finally:
            self.close()


class JoinRateState:
    def __init__(
        self,
        path: str | os.PathLike[str],
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = Path(path)
        self.clock = clock
        self._private_directory(self.path.parent)
        self._prepare_file()
        with self._connect() as database:
            database.executescript(
                """
                CREATE TABLE IF NOT EXISTS event (
                    kind TEXT NOT NULL,
                    caller TEXT NOT NULL,
                    bot TEXT NOT NULL,
                    happened REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS event_time ON event(happened);
                CREATE TABLE IF NOT EXISTS caller_ban (
                    caller TEXT PRIMARY KEY,
                    expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pending (
                    bot TEXT PRIMARY KEY,
                    code TEXT UNIQUE,
                    expires REAL NOT NULL
                );
                """
            )

    @staticmethod
    def _private_directory(path: Path) -> None:
        info = path.stat(follow_symlinks=False)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise JoinRefused("join rate storage refused")

    def _prepare_file(self) -> None:
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
                raise JoinRefused("join rate storage refused")
        finally:
            os.close(descriptor)

    def _connect(self) -> sqlite3.Connection:
        database = sqlite3.connect(
            self.path,
            isolation_level=None,
            timeout=5,
            factory=_ClosingConnection,
        )
        database.row_factory = sqlite3.Row
        database.execute("PRAGMA journal_mode = DELETE")
        database.execute("PRAGMA synchronous = FULL")
        return database

    @staticmethod
    def _count(
        database: sqlite3.Connection,
        kind: str,
        since: float,
        field: str | None = None,
        value: str | None = None,
    ) -> int:
        if field is None:
            row = database.execute(
                "SELECT count(*) AS amount FROM event WHERE kind = ? AND happened >= ?",
                (kind, since),
            ).fetchone()
        else:
            if field not in {"caller", "bot"}:
                raise JoinRefused("join limit refused")
            row = database.execute(
                f"SELECT count(*) AS amount FROM event WHERE kind = ? AND happened >= ? AND {field} = ?",
                (kind, since, value),
            ).fetchone()
        return int(row["amount"])

    def _begin(self, database: sqlite3.Connection, now: float) -> None:
        database.execute("BEGIN IMMEDIATE")
        database.execute("DELETE FROM event WHERE happened < ?", (now - 3600,))
        database.execute("DELETE FROM caller_ban WHERE expires <= ?", (now,))
        database.execute("DELETE FROM pending WHERE expires <= ?", (now,))

    def start_request(self, caller: str, bot: str) -> None:
        now = self.clock()
        with self._connect() as database:
            self._begin(database, now)
            if database.execute(
                "SELECT 1 FROM caller_ban WHERE caller = ?", (caller,)
            ).fetchone() is not None:
                database.execute("ROLLBACK")
                raise JoinRateLimited("join request limited")
            limited = (
                self._count(database, "request", now - 600, "caller", caller) >= 6
                or self._count(database, "request", now - 3600, "bot", bot) >= 2
                or self._count(database, "request", now - 3600) >= 60
            )
            occupied = database.execute(
                "SELECT 1 FROM pending WHERE bot = ?", (bot,)
            ).fetchone() is not None
            pending_count = database.execute(
                "SELECT count(*) AS amount FROM pending"
            ).fetchone()["amount"]
            if limited:
                database.execute(
                    "INSERT INTO caller_ban (caller, expires) VALUES (?, ?) "
                    "ON CONFLICT(caller) DO UPDATE SET expires = excluded.expires",
                    (caller, now + 3600),
                )
                database.execute("COMMIT")
                raise JoinRateLimited("join request limited")
            if occupied or pending_count >= 100:
                database.execute("ROLLBACK")
                raise JoinRateLimited("join request limited")
            database.execute(
                "INSERT INTO event (kind, caller, bot, happened) VALUES ('request', ?, ?, ?)",
                (caller, bot, now),
            )
            database.execute(
                "INSERT INTO pending (bot, code, expires) VALUES (?, NULL, ?)",
                (bot, now + 600),
            )
            database.execute("COMMIT")

    def complete_request(self, bot: str, code: str) -> None:
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            changed = database.execute(
                "UPDATE pending SET code = ? WHERE bot = ? AND code IS NULL",
                (code, bot),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise JoinRefused("join request reservation refused")
            database.execute("COMMIT")

    def abandon_request(self, bot: str) -> None:
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            database.execute("DELETE FROM pending WHERE bot = ? AND code IS NULL", (bot,))
            database.execute("COMMIT")

    def collected(self, bot: str, code: str) -> None:
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            database.execute("DELETE FROM pending WHERE bot = ? AND code = ?", (bot, code))
            database.execute("COMMIT")

    def allow_exchange(self, caller: str, bot: str) -> None:
        now = self.clock()
        with self._connect() as database:
            self._begin(database, now)
            if database.execute(
                "SELECT 1 FROM caller_ban WHERE caller = ?", (caller,)
            ).fetchone() is not None:
                database.execute("ROLLBACK")
                raise JoinRateLimited("join exchange limited")
            limited = (
                self._count(database, "exchange", now - 60, "caller", caller) >= 30
                or self._count(database, "exchange", now - 60, "bot", bot) >= 30
                or self._count(database, "exchange", now - 60) >= 300
            )
            if limited:
                database.execute(
                    "INSERT INTO caller_ban (caller, expires) VALUES (?, ?) "
                    "ON CONFLICT(caller) DO UPDATE SET expires = excluded.expires",
                    (caller, now + 3600),
                )
                database.execute("COMMIT")
                raise JoinRateLimited("join exchange limited")
            database.execute(
                "INSERT INTO event (kind, caller, bot, happened) VALUES ('exchange', ?, ?, ?)",
                (caller, bot, now),
            )
            database.execute("COMMIT")


@dataclass(slots=True)
class Request:
    method: str
    path: str
    headers: dict[str, str]
    body: bytearray
    peer: str


@dataclass(slots=True)
class Response:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytearray

    def clear(self) -> None:
        clear_buffer(self.body)


class JoinApplication:
    def __init__(
        self,
        signup: SignupService,
        rates: JoinRateState,
        *,
        trusted_proxy: str,
        public_origin: str,
        invites=None,
        invite_authenticator=None,
        release: invite_prompt.ReleaseConfig | None = None,
    ) -> None:
        configured = (
            invites is not None,
            invite_authenticator is not None,
            release is not None,
        )
        if any(configured) and (
            not all(configured)
            or not isinstance(release, invite_prompt.ReleaseConfig)
        ):
            raise JoinRefused("bot invite route refused")
        self.invites = invites
        self.invite_authenticator = invite_authenticator
        self.release = release
        self.signup = signup
        self.rates = rates
        self.trusted_proxy = str(ipaddress.ip_address(trusted_proxy))
        parsed_origin = urlsplit(public_origin)
        if (
            parsed_origin.scheme != "https"
            or not parsed_origin.hostname
            or parsed_origin.path
            or parsed_origin.query
            or parsed_origin.fragment
            or parsed_origin.username is not None
            or parsed_origin.password is not None
            or parsed_origin.port not in {None, 443}
        ):
            raise JoinRefused("join origin refused")
        self.public_origin = public_origin
        self.forwarded_host = parsed_origin.hostname

    @staticmethod
    def _headers(request: Request) -> dict[str, str]:
        return {name.lower(): value for name, value in request.headers.items()}

    def _caller(self, request: Request) -> str:
        headers = self._headers(request)
        try:
            peer = str(ipaddress.ip_address(request.peer))
        except ValueError:
            raise JoinRefused("join proxy refused") from None
        if peer != self.trusted_proxy:
            raise JoinRefused("join proxy refused")
        if (
            headers.get("x-forwarded-proto") != "https"
            or headers.get("x-forwarded-host") != self.forwarded_host
        ):
            raise JoinRefused("join forwarding refused")
        forwarded = headers.get("x-forwarded-for", "")
        if not forwarded or "," in forwarded:
            raise JoinRefused("join caller refused")
        try:
            return str(ipaddress.ip_address(forwarded))
        except ValueError:
            raise JoinRefused("join caller refused") from None

    @staticmethod
    def _document(request: Request) -> dict:
        headers = JoinApplication._headers(request)
        if (
            headers.get("content-type") != "application/json"
            or len(request.body) > MAX_BODY_BYTES
        ):
            raise JoinRefused("join body refused")
        try:
            value = json.loads(request.body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise JoinRefused("join body refused") from None
        if not isinstance(value, dict):
            raise JoinRefused("join body refused")
        return value

    @staticmethod
    def _b64(value: object, size: int) -> bytearray:
        if not isinstance(value, str) or len(value) > 1024:
            raise JoinRefused("join value refused")
        try:
            decoded = bytearray(base64.b64decode(value, validate=True))
        except (ValueError, TypeError):
            raise JoinRefused("join value refused") from None
        if len(decoded) != size:
            clear_buffer(decoded)
            raise JoinRefused("join value refused")
        return decoded

    @staticmethod
    def _response(status: int, value: dict, *, no_store: bool = False) -> Response:
        body = bytearray(json.dumps(value, separators=(",", ":")).encode("ascii"))
        headers = [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(body))),
            ("X-Content-Type-Options", "nosniff"),
        ]
        if no_store:
            headers.append(("Cache-Control", "no-store"))
        return Response(status, tuple(headers), body)

    @staticmethod
    def _failure(status: int) -> Response:
        return JoinApplication._response(status, {"error": PUBLIC_BODY}, no_store=True)

    @staticmethod
    def _bearer(request: Request) -> bytearray:
        value = JoinApplication._headers(request).get("authorization")
        key = bytearray()
        try:
            if (
                not isinstance(value, str)
                or not value.startswith("Bearer ")
                or not value.isascii()
            ):
                raise JoinRefused("bot invite authentication refused")
            key.extend(value[7:].encode("ascii"))
            if len(key) > MAX_API_KEY_BYTES or API_KEY.fullmatch(key) is None:
                raise JoinRefused("bot invite authentication refused")
            result = key
            key = bytearray()
            return result
        finally:
            clear_buffer(key)

    def _bot_invite(
        self,
        caller: str,
        request: Request,
        document: dict,
    ) -> Response:
        if (
            self.invites is None
            or self.invite_authenticator is None
            or self.release is None
            or set(document) not in (set(), {"botName"})
        ):
            raise JoinRefused("bot invite route refused")
        bot_name = document.get("botName")
        if bot_name is not None and (
            not isinstance(bot_name, str)
            or BOT_NAME.fullmatch(bot_name) is None
        ):
            raise JoinRefused("bot invite route refused")
        self.rates.allow_exchange(caller, "invite-auth")
        key = self._bearer(request)
        offer = None
        code = bytearray()
        try:
            identity = self.invite_authenticator.authenticate(key)
            if not isinstance(identity, BotIdentity):
                raise JoinRefused("bot invite authentication refused")
            offer = self.invites.create_bot_invite(identity, bot_name)
            code = offer.take_code()
            prompt = invite_prompt.build_prompt(self.release, code)
            code = bytearray()
            return self._response(200, {"prompt": prompt}, no_store=True)
        except PublicFailure:
            raise JoinRefused("bot invite route refused") from None
        finally:
            clear_buffer(key)
            clear_buffer(code)
            if offer is not None:
                offer.clear()

    def _request_join(self, caller: str, document: dict) -> Response:
        bot = document.get("bot")
        description = document.get("description")
        if (
            not isinstance(bot, str)
            or BOT_NAME.fullmatch(bot) is None
            or not isinstance(description, str)
            or not 1 <= len(description) <= 160
            or any(ord(character) < 0x20 for character in description)
        ):
            raise JoinRefused("join request refused")
        self.rates.start_request(caller, bot)
        handle = None
        pairing = None
        invite = bytearray()
        try:
            if set(document) != {"invite", "bot", "description"}:
                raise JoinRefused("join request refused")
            invite_value = document["invite"]
            if (
                not isinstance(invite_value, str)
                or not invite_value.isascii()
                or not 1 <= len(invite_value) <= 128
            ):
                raise JoinRefused("join request refused")
            invite.extend(invite_value.encode("ascii"))
            handle = self.signup.start_join(invite, bot, description)
            pairing = handle.take_pairing()
            self.rates.complete_request(bot, handle.code)
            return self._response(
                200,
                {
                    "code": handle.code,
                    "bot": handle.bot_name,
                    "pairing": base64.b64encode(pairing).decode("ascii"),
                },
                no_store=True,
            )
        except Exception:
            self.rates.abandon_request(bot)
            raise
        finally:
            if handle is not None:
                handle.clear()
            clear_buffer(pairing)
            clear_buffer(invite)

    def _collect(self, caller: str, document: dict) -> Response:
        phase = document.get("phase")
        fields = {"phase", "code", "bot", "pairing"}
        if phase == "confirm":
            fields.add("proof")
        if phase not in {"collect", "confirm"} or set(document) != fields:
            raise JoinRefused("join exchange refused")
        code = document["code"]
        bot = document["bot"]
        if (
            not isinstance(code, str)
            or CODE.fullmatch(code) is None
            or not isinstance(bot, str)
            or BOT_NAME.fullmatch(bot) is None
        ):
            raise JoinRefused("join exchange refused")
        self.rates.allow_exchange(caller, bot)
        pairing = self._b64(document["pairing"], PAIRING_BYTES)
        credential = None
        offer = None
        proof = None
        try:
            if phase == "confirm":
                proof = self._b64(document["proof"], PROOF_BYTES)
                connected = self.signup.confirm(code, bot, pairing, proof)
                return self._response(200, {"ok": True, "bot": connected.bot_name}, no_store=True)

            offer = self.signup.collect(code, bot, pairing)
            credential = offer.take_credential()
            header = bytearray(
                json.dumps(
                    {
                        "code": offer.approval_id,
                        "bot": offer.bot_name,
                        "accountId": offer.account_id,
                        "keyId": offer.key_id,
                        "nonce": base64.b64encode(offer.nonce).decode("ascii"),
                        "deadline": offer.deadline,
                        "credentialBytes": len(credential),
                    },
                    separators=(",", ":"),
                ).encode("ascii")
                + b"\n"
            )
            header.extend(credential)
            self.rates.collected(bot, code)
            return Response(
                200,
                (
                    ("Content-Type", "application/vnd.quarterdeck.collect-v1"),
                    ("Content-Length", str(len(header))),
                    ("Cache-Control", "no-store"),
                    ("X-Content-Type-Options", "nosniff"),
                ),
                header,
            )
        except PublicFailure:
            raise JoinRefused("join exchange refused") from None
        finally:
            clear(pairing)
            pairing.clear()
            clear_buffer(proof)
            clear_buffer(credential)
            if offer is not None:
                offer.clear()

    def handle(self, request: Request) -> Response:
        try:
            caller = self._caller(request)
            if request.method != "POST":
                return self._failure(405)
            document = self._document(request)
            if request.path == REQUEST_PATH:
                return self._request_join(caller, document)
            if request.path == INVITE_PATH:
                return self._bot_invite(caller, request, document)
            if request.path == COLLECT_PATH:
                return self._collect(caller, document)
            return self._failure(404)
        except JoinRateLimited:
            return self._failure(429)
        except (JoinRefused, PublicFailure, OSError, sqlite3.Error):
            return self._failure(403)
        except Exception:
            return self._failure(503)
        finally:
            clear_buffer(request.body)


class PublicJoinHttpHandler(BaseHTTPRequestHandler):
    application: JoinApplication

    def log_message(self, format, *args):
        return

    def _body(self) -> bytearray:
        if self.headers.get("Transfer-Encoding") is not None:
            raise ValueError("join request framing refused")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            raise ValueError("join content length refused")
        raw_length = lengths[0]
        if not raw_length.isascii() or not raw_length.isdigit():
            raise ValueError("join content length refused")
        length = int(raw_length)
        if length > MAX_BODY_BYTES:
            raise ValueError("join request body refused")
        for name in (
            "Authorization",
            "Content-Type",
            "X-Forwarded-For",
            "X-Forwarded-Proto",
            "X-Forwarded-Host",
        ):
            if len(self.headers.get_all(name, [])) > 1:
                raise ValueError("join request header refused")
        self.connection.settimeout(5.0)
        body = bytearray(length)
        offset = 0
        with memoryview(body) as view:
            while offset < length:
                amount = self.rfile.readinto(view[offset:])
                if not amount:
                    clear_buffer(body)
                    raise ValueError("join request body refused")
                offset += amount
        return body

    def do_POST(self) -> None:
        body = bytearray()
        response = None
        try:
            body = self._body()
            response = self.application.handle(
                Request(
                    self.command,
                    self.path,
                    {
                        name: value
                        for name, value in self.headers.items()
                    },
                    body,
                    self.client_address[0],
                )
            )
        except Exception:
            clear_buffer(body)
            response = JoinApplication._failure(400)
        try:
            self.send_response_only(response.status)
            for name, value in response.headers:
                self.send_header(name, value)
            self.end_headers()
            if response.body:
                self.wfile.write(response.body)
        finally:
            response.clear()


def handler_for(
    application: JoinApplication,
) -> type[PublicJoinHttpHandler]:
    return type(
        "BoundPublicJoinHttpHandler",
        (PublicJoinHttpHandler,),
        {"application": application},
    )


def serve(
    application: JoinApplication,
    bind_address: str,
    bind_port: int,
    recovery: PeriodicRecovery,
) -> None:
    server = ThreadingHTTPServer(
        (bind_address, bind_port),
        handler_for(application),
    )
    server.daemon_threads = True
    recovery.start(server.shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        recovery.stop()
        recovery.join(5)
        server.server_close()
    if recovery.failure is not None:
        raise JoinRefused("join recovery schedule failed")


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "--config":
        return 2
    invite_key: bytearray | None = None
    try:
        runtime = load_runtime_config(sys.argv[2])
        invite_key = _load_invite_hmac_key(runtime.invite_key_path)
        joins = JoinService(
            runtime.database_path,
            invite_hmac_key=invite_key,
        )
        clear_buffer(invite_key)
        invite_key = None
        signup = SignupService(
            joins,
            HelperSocketClient(runtime.helper_socket),
        )
        if signup.recover_unfinished(True) != 0:
            raise JoinRefused("join recovery refused")
        rates = JoinRateState(runtime.rates_path)
        approval = approval_service.ApprovalService(
            joins,
            runtime.approval_socket,
            runtime.approver_uid,
            lambda uid: (
                approval_service.APPROVER_ROLE
                if uid == runtime.approver_uid
                else ""
            ),
            socket_mode=runtime.approval_socket_mode,
            socket_gid=runtime.approval_socket_gid,
        )
        threading.Thread(
            target=approval.serve_forever,
            name="quarterdeck-approval-socket",
            daemon=True,
        ).start()
        application = JoinApplication(
            signup,
            rates,
            trusted_proxy=runtime.trusted_proxy,
            public_origin=runtime.public_origin,
            invites=joins,
            invite_authenticator=BotInviteAuthenticator(
                runtime.session_url
            ),
            release=invite_prompt.ReleaseConfig(
                runtime.release_artifact_url,
                runtime.release_version,
                runtime.release_sha256,
                runtime.public_origin,
            ),
        )
        serve(
            application,
            runtime.bind_address,
            runtime.bind_port,
            PeriodicRecovery(signup),
        )
        return 0
    except Exception:
        return 2
    finally:
        if invite_key is not None:
            clear_buffer(invite_key)


if __name__ == "__main__":
    raise SystemExit(main())
