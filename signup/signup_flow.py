from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import stat
import time
from pathlib import Path
from typing import Callable

from helper_contract import (
    AccountHelper,
    ApprovedJoin,
    BotRecord,
    CollectTarget,
    HelperRefused,
    PreparedCollect,
    ReplacementCommitted,
)

PAIRING_BYTES = 32
PAIRING_LIFETIME = 600
CONFIRM_WINDOW = 600
CONFIRM_NONCE_BYTES = 32
INVITE_BYTES = 16
INVITE_ID_BYTES = 9
INVITE_HMAC_KEY_BYTES = 32
INVITE_LIFETIME = 24 * 60 * 60
BOT_INVITE_LIMIT = 5
BOT_INVITE_WINDOW = 60 * 60
MAX_OPEN_INVITES = 256
PUBLIC_FAILURE = "request could not be completed"
CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
INVITE_CODE = re.compile(rb"[A-Za-z0-9_-]{22}\Z")
INVITE_ID = re.compile(r"[A-Za-z0-9_-]{12}\Z")
TEMPLATE = "restricted-mail-v1"
MAX_OUTSTANDING_PER_BOT = 4
MAX_OUTSTANDING_TOTAL = 128
MAX_JOIN_ROWS = 1024
FAILURE_WINDOW = 60
FAILURE_LIMIT = 4
GLOBAL_FAILURE_LIMIT = 64


class PublicFailure(Exception):
    def __init__(self) -> None:
        super().__init__(PUBLIC_FAILURE)


def clear(value: bytearray) -> None:
    value[:] = b"\x00" * len(value)


def random_buffer(size: int) -> bytearray:
    value = bytearray(size)
    descriptor = os.open("/dev/urandom", os.O_RDONLY | os.O_CLOEXEC)
    offset = 0
    try:
        with memoryview(value) as view:
            while offset < size:
                got = os.readv(descriptor, [view[offset:]])
                if not got:
                    raise OSError("random source ended")
                offset += got
        return value
    except Exception:
        clear(value)
        raise
    finally:
        os.close(descriptor)

def _confirmation_message(
    nonce: bytes,
    approval_id: str,
    account_id: str,
    key_id: str,
) -> bytes:
    if not isinstance(nonce, bytes) or len(nonce) != CONFIRM_NONCE_BYTES:
        raise PublicFailure()
    fields = (approval_id, account_id, key_id)
    encoded = []
    for field in fields:
        if not isinstance(field, str):
            raise PublicFailure()
        value = field.encode("utf-8")
        if not value or len(value) > 65535:
            raise PublicFailure()
        encoded.append(len(value).to_bytes(2, "big") + value)
    return b"quarterdeck-collect-confirm-v1\0" + nonce + b"".join(encoded)


def confirmation_mac(
    credential: bytes | bytearray,
    nonce: bytes,
    approval_id: str,
    account_id: str,
    key_id: str,
) -> bytes:
    if not isinstance(credential, (bytes, bytearray)) or not credential:
        raise PublicFailure()
    return hmac.digest(
        credential,
        _confirmation_message(nonce, approval_id, account_id, key_id),
        "sha256",
    )


class BotIdentity:
    __slots__ = ("bot_name", "account_id")

    def __init__(self, bot_name: str, account_id: str) -> None:
        if (
            not isinstance(bot_name, str)
            or BOT_NAME.fullmatch(bot_name) is None
            or not isinstance(account_id, str)
            or not account_id
            or len(account_id) > 128
        ):
            raise PublicFailure()
        self.bot_name = bot_name
        self.account_id = account_id

    def __repr__(self) -> str:
        return (
            f"BotIdentity(bot_name={self.bot_name!r}, "
            f"account_id={self.account_id!r})"
        )


class InviteOffer:
    __slots__ = (
        "invite_id",
        "bot_name",
        "invited_by",
        "created_at",
        "expires_at",
        "_code",
        "closed",
    )
    cache_control = "no-store"

    def __init__(
        self,
        invite_id: str,
        bot_name: str | None,
        invited_by: str,
        created_at: float,
        expires_at: float,
        code: bytearray,
    ) -> None:
        if (
            not isinstance(invite_id, str)
            or INVITE_ID.fullmatch(invite_id) is None
            or (bot_name is not None and BOT_NAME.fullmatch(bot_name) is None)
            or not isinstance(invited_by, str)
            or not invited_by
            or len(invited_by) > 64
            or not isinstance(created_at, (int, float))
            or isinstance(created_at, bool)
            or not isinstance(expires_at, (int, float))
            or isinstance(expires_at, bool)
            or expires_at <= created_at
            or not isinstance(code, bytearray)
            or INVITE_CODE.fullmatch(code) is None
        ):
            raise PublicFailure()
        self.invite_id = invite_id
        self.bot_name = bot_name
        self.invited_by = invited_by
        self.created_at = float(created_at)
        self.expires_at = float(expires_at)
        self._code = code
        self.closed = False

    def take_code(self) -> bytearray:
        if self.closed:
            raise PublicFailure()
        code = self._code
        self._code = bytearray()
        self.closed = True
        return code

    def clear(self) -> None:
        clear(self._code)
        self._code.clear()
        self.closed = True

    def __repr__(self) -> str:
        return (
            f"InviteOffer(invite_id={self.invite_id!r}, "
            f"bot_name={self.bot_name!r}, invited_by={self.invited_by!r}, "
            f"created_at={self.created_at!r}, expires_at={self.expires_at!r}, "
            "code=<redacted>)"
        )


class JoinHandle:
    __slots__ = ("code", "bot_name", "_pairing", "closed")

    def __init__(self, code: str, bot_name: str, pairing: bytearray):
        self.code = code
        self.bot_name = bot_name
        self._pairing = pairing
        self.closed = False

    def take_pairing(self) -> bytearray:
        if self.closed:
            raise PublicFailure()
        pairing = self._pairing
        self._pairing = bytearray()
        self.closed = True
        return pairing

    def clear(self) -> None:
        clear(self._pairing)
        self._pairing.clear()
        self.closed = True

    def __repr__(self) -> str:
        return f"JoinHandle(code={self.code!r}, bot_name={self.bot_name!r}, pairing=<redacted>)"

class CollectOffer:
    __slots__ = (
        "approval_id",
        "bot_name",
        "account_id",
        "key_id",
        "nonce",
        "deadline",
        "_credential",
        "closed",
    )
    cache_control = "no-store"

    def __init__(
        self,
        approval_id: str,
        target: CollectTarget,
        nonce: bytes,
        deadline: float,
        credential: bytearray,
    ) -> None:
        if (
            not isinstance(target, CollectTarget)
            or not isinstance(nonce, bytes)
            or len(nonce) != CONFIRM_NONCE_BYTES
            or not isinstance(deadline, (int, float))
            or isinstance(deadline, bool)
            or not isinstance(credential, bytearray)
        ):
            raise PublicFailure()
        self.approval_id = approval_id
        self.bot_name = target.bot_name
        self.account_id = target.account_id
        self.key_id = target.key_id
        self.nonce = nonce
        self.deadline = float(deadline)
        self._credential = credential
        self.closed = False

    def take_credential(self) -> bytearray:
        if self.closed:
            raise PublicFailure()
        credential = self._credential
        self._credential = bytearray()
        self.closed = True
        return credential

    def clear(self) -> None:
        clear(self._credential)
        self._credential.clear()
        self.closed = True

    def __repr__(self) -> str:
        return (
            f"CollectOffer(approval_id={self.approval_id!r}, bot_name={self.bot_name!r}, "
            f"account_id={self.account_id!r}, key_id={self.key_id!r}, "
            f"nonce={self.nonce.hex()!r}, deadline={self.deadline!r}, credential=<redacted>)"
        )


class ConnectedBot:
    __slots__ = ("bot_name", "account_id", "key_id", "adapter_receipt")

    def __init__(self, record: BotRecord):
        if not isinstance(record, BotRecord):
            raise PublicFailure()
        self.bot_name = record.bot_name
        self.account_id = record.account_id
        self.key_id = record.key_id
        self.adapter_receipt = record.adapter_receipt

    def as_record(self) -> BotRecord:
        return BotRecord(self.bot_name, self.account_id, self.key_id, self.adapter_receipt)

    def __repr__(self) -> str:
        return (
            f"ConnectedBot(bot_name={self.bot_name!r}, account_id={self.account_id!r}, "
            f"key_id={self.key_id!r}, adapter_receipt={self.adapter_receipt!r})"
        )


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exception_type, exception, traceback):
        try:
            return super().__exit__(exception_type, exception, traceback)
        finally:
            self.close()


class JoinService:
    def __init__(
        self,
        path: str | os.PathLike[str],
        clock: Callable[[], float] = time.time,
        *,
        invite_hmac_key: bytes | bytearray,
    ) -> None:
        if (
            not isinstance(invite_hmac_key, (bytes, bytearray))
            or len(invite_hmac_key) != INVITE_HMAC_KEY_BYTES
        ):
            raise PublicFailure()
        self.path = Path(path)
        self.clock = clock
        self._invite_hmac_key = bytes(invite_hmac_key)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        self._prepare_database_file()
        self._initialize()

    def _prepare_database_file(self) -> None:
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(descriptor)
            info = self.path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
        ):
            raise PublicFailure()

    def _connect(self) -> sqlite3.Connection:
        database = sqlite3.connect(
            self.path,
            isolation_level=None,
            timeout=5,
            factory=_ClosingConnection,
        )
        try:
            database.row_factory = sqlite3.Row
            database.execute("PRAGMA foreign_keys = ON")
            database.execute("PRAGMA synchronous = FULL")
            return database
        except Exception:
            database.close()
            raise

    def _initialize(self) -> None:
        with self._connect() as database:
            database.executescript(
                """
                PRAGMA journal_mode = DELETE;
                CREATE TABLE IF NOT EXISTS invite (
                    invite_id TEXT PRIMARY KEY,
                    code_hash BLOB UNIQUE NOT NULL CHECK (length(code_hash) = 32),
                    inviter_name TEXT NOT NULL,
                    bot_name TEXT,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    consumed_at REAL,
                    cancelled_at REAL,
                    CHECK (consumed_at IS NULL OR cancelled_at IS NULL)
                );
                CREATE INDEX IF NOT EXISTS open_invite
                    ON invite(expires_at, consumed_at, cancelled_at);
                CREATE TABLE IF NOT EXISTS join_request (
                    code TEXT PRIMARY KEY,
                    bot_name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    invite_id TEXT,
                    invited_by TEXT NOT NULL DEFAULT 'Owner',
                    template TEXT NOT NULL,
                    pairing_hash BLOB NOT NULL CHECK (length(pairing_hash) = 32),
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
                    refused INTEGER NOT NULL DEFAULT 0 CHECK (refused IN (0, 1)),
                    consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
                );
                CREATE INDEX IF NOT EXISTS outstanding_join_by_bot
                    ON join_request(bot_name, consumed, expires_at);
                CREATE TABLE IF NOT EXISTS helper_record (
                    bot_name TEXT PRIMARY KEY,
                    account_id TEXT,
                    key_id TEXT,
                    adapter_receipt TEXT,
                    state TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'cancelled')),
                    CHECK (
                        (state = 'provisioning' AND account_id IS NULL AND key_id IS NULL AND adapter_receipt IS NULL)
                        OR
                        (state != 'provisioning' AND account_id IS NOT NULL AND key_id IS NOT NULL AND adapter_receipt IS NOT NULL)
                    )
                );
                CREATE TABLE IF NOT EXISTS bot_invite_event (
                    bot_name TEXT NOT NULL,
                    happened_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS bot_invite_event_time
                    ON bot_invite_event(bot_name, happened_at);
                CREATE TABLE IF NOT EXISTS collect_record (
                    approval_id TEXT PRIMARY KEY,
                    bot_name TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    helper_receipt TEXT NOT NULL,
                    nonce BLOB NOT NULL CHECK (length(nonce) = 32),
                    expected_mac BLOB NOT NULL CHECK (length(expected_mac) = 32),
                    deadline REAL NOT NULL,
                    state TEXT NOT NULL CHECK (
                        state IN ('awaiting-confirmation', 'activating', 'active', 'revoking', 'revoked')
                    )
                );
                CREATE INDEX IF NOT EXISTS collect_recovery
                    ON collect_record(state, deadline);
                CREATE TABLE IF NOT EXISTS failure_event (
                    bucket TEXT NOT NULL,
                    happened_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS recent_failure ON failure_event(happened_at, bucket);
                CREATE TABLE IF NOT EXISTS audit (
                    happened_at REAL NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    bot_name TEXT,
                    result TEXT NOT NULL
                );
                """
            )
            columns = {
                row["name"] for row in database.execute("PRAGMA table_info(join_request)")
            }
            if "refused" not in columns:
                database.execute(
                    "ALTER TABLE join_request ADD COLUMN refused INTEGER NOT NULL DEFAULT 0 "
                    "CHECK (refused IN (0, 1))"
                )
            if "invite_id" not in columns:
                database.execute(
                    "ALTER TABLE join_request ADD COLUMN invite_id TEXT"
                )
            if "invited_by" not in columns:
                database.execute(
                    "ALTER TABLE join_request ADD COLUMN invited_by TEXT "
                    "NOT NULL DEFAULT 'Owner'"
                )

    @staticmethod
    def _pairing_hash(bot_name: str, pairing: bytes | bytearray) -> bytes:
        digest = hashlib.sha256()
        digest.update(b"pairing-v1\0")
        digest.update(TEMPLATE.encode("ascii"))
        digest.update(b"\0")
        digest.update(bot_name.encode("ascii"))
        digest.update(b"\0")
        digest.update(pairing)
        return digest.digest()


    def _audit(self, database: sqlite3.Connection, actor: str, action: str, bot_name: str | None, result: str) -> None:
        database.execute(
            "INSERT INTO audit (happened_at, actor, action, bot_name, result) VALUES (?, ?, ?, ?, ?)",
            (self.clock(), actor, action, bot_name, result),
        )

    def _prune_failures(self, database: sqlite3.Connection, now: float) -> None:
        database.execute("DELETE FROM failure_event WHERE happened_at < ?", (now - FAILURE_WINDOW,))

    def _failure_counts(self, database: sqlite3.Connection, now: float, bucket: str) -> tuple[int, int]:
        self._prune_failures(database, now)
        per_bucket = int(database.execute("SELECT count(*) FROM failure_event WHERE bucket = ?", (bucket,)).fetchone()[0])
        global_count = int(database.execute("SELECT count(*) FROM failure_event").fetchone()[0])
        return per_bucket, global_count

    def _fail(self, database: sqlite3.Connection, bucket: str, actor: str, action: str, bot_name: str | None) -> None:
        now = self.clock()
        per_bucket, global_count = self._failure_counts(database, now, bucket)
        database.execute("INSERT INTO failure_event (bucket, happened_at) VALUES (?, ?)", (bucket, now))
        limited = per_bucket >= FAILURE_LIMIT or global_count >= GLOBAL_FAILURE_LIMIT
        self._audit(database, actor, action, bot_name, "rate-limited" if limited else "refused")
        database.execute("COMMIT")
        raise PublicFailure()

    @staticmethod
    def _begin(database: sqlite3.Connection) -> None:
        database.execute("BEGIN IMMEDIATE")

    @staticmethod
    def _bucket(bot_name: str) -> str:
        return f"bot:{bot_name}" if BOT_NAME.fullmatch(bot_name) else "bot:invalid"

    def _prune_join_rows(self, database: sqlite3.Connection, now: float) -> None:
        database.execute(
            "DELETE FROM join_request "
            "WHERE (consumed = 1 OR expires_at < ?) "
            "AND code NOT IN ("
            "SELECT approval_id FROM collect_record "
            "WHERE state IN ('awaiting-confirmation', 'activating', 'revoking')"
            ")",
            (now,),
        )

    @staticmethod
    def _random_urlsafe(size: int) -> bytearray:
        raw = random_buffer(size)
        try:
            return bytearray(base64.urlsafe_b64encode(raw).rstrip(b"="))
        finally:
            clear(raw)
            raw.clear()

    def _invite_hash(self, code: bytes | bytearray) -> bytes:
        if (
            not isinstance(code, (bytes, bytearray))
            or INVITE_CODE.fullmatch(code) is None
        ):
            raise PublicFailure()
        digest = hmac.new(self._invite_hmac_key, digestmod="sha256")
        digest.update(b"quarterdeck-invite-v1\0")
        digest.update(code)
        return digest.digest()

    def _insert_invite(
        self,
        database: sqlite3.Connection,
        now: float,
        inviter_name: str,
        bot_name: str | None,
    ) -> InviteOffer:
        if (
            not isinstance(inviter_name, str)
            or (
                inviter_name != "Owner"
                and BOT_NAME.fullmatch(inviter_name) is None
            )
            or (
                bot_name is not None
                and (
                    not isinstance(bot_name, str)
                    or BOT_NAME.fullmatch(bot_name) is None
                )
            )
        ):
            raise PublicFailure()
        database.execute(
            "DELETE FROM invite "
            "WHERE expires_at < ? AND consumed_at IS NULL AND cancelled_at IS NULL",
            (now,),
        )
        open_count = int(
            database.execute(
                "SELECT count(*) FROM invite "
                "WHERE expires_at >= ? AND consumed_at IS NULL "
                "AND cancelled_at IS NULL",
                (now,),
            ).fetchone()[0]
        )
        if open_count >= MAX_OPEN_INVITES:
            raise PublicFailure()
        for _ in range(16):
            code = self._random_urlsafe(INVITE_BYTES)
            invite_id_buffer: bytearray | None = None
            try:
                invite_id_buffer = self._random_urlsafe(INVITE_ID_BYTES)
                invite_id = invite_id_buffer.decode("ascii")
                database.execute(
                    "INSERT INTO invite "
                    "(invite_id, code_hash, inviter_name, bot_name, "
                    "created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        invite_id,
                        self._invite_hash(code),
                        inviter_name,
                        bot_name,
                        now,
                        now + INVITE_LIFETIME,
                    ),
                )
                return InviteOffer(
                    invite_id,
                    bot_name,
                    inviter_name,
                    now,
                    now + INVITE_LIFETIME,
                    code,
                )
            except sqlite3.IntegrityError:
                clear(code)
                code.clear()
            except Exception:
                clear(code)
                code.clear()
                raise
            finally:
                if invite_id_buffer is not None:
                    clear(invite_id_buffer)
                    invite_id_buffer.clear()
        raise PublicFailure()

    def _create_invite_verified(
        self,
        actor: str,
        bot_name: str | None,
    ) -> InviteOffer:
        if not self._valid_actor(actor):
            raise PublicFailure()
        offer: InviteOffer | None = None
        with self._connect() as database:
            try:
                self._begin(database)
                offer = self._insert_invite(
                    database,
                    self.clock(),
                    "Owner",
                    bot_name,
                )
                self._audit(
                    database,
                    actor,
                    "invite-create",
                    bot_name,
                    "created",
                )
                database.execute("COMMIT")
                return offer
            except Exception:
                if database.in_transaction:
                    database.execute("ROLLBACK")
                if offer is not None:
                    offer.clear()
                raise

    def _list_invites_verified(
        self,
        actor: str,
        limit: int,
    ) -> list[dict[str, str | float | None]]:
        if (
            not self._valid_actor(actor)
            or not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 50
        ):
            raise PublicFailure()
        now = self.clock()
        with self._connect() as database:
            self._begin(database)
            rows = database.execute(
                "SELECT invite_id, bot_name, inviter_name, created_at, expires_at "
                "FROM invite WHERE expires_at >= ? AND consumed_at IS NULL "
                "AND cancelled_at IS NULL ORDER BY created_at, invite_id LIMIT ?",
                (now, limit),
            ).fetchall()
            self._audit(database, actor, "invite-list", None, "listed")
            database.execute("COMMIT")
        return [
            {
                "inviteId": row["invite_id"],
                "botName": row["bot_name"],
                "invitedBy": row["inviter_name"],
                "createdAt": row["created_at"],
                "expiresAt": row["expires_at"],
            }
            for row in rows
        ]

    def _cancel_invite_verified(self, invite_id: str, actor: str) -> None:
        if (
            not self._valid_actor(actor)
            or not isinstance(invite_id, str)
            or INVITE_ID.fullmatch(invite_id) is None
        ):
            raise PublicFailure()
        now = self.clock()
        with self._connect() as database:
            self._begin(database)
            row = database.execute(
                "SELECT bot_name FROM invite "
                "WHERE invite_id = ? AND expires_at >= ? "
                "AND consumed_at IS NULL AND cancelled_at IS NULL",
                (invite_id, now),
            ).fetchone()
            if row is None:
                self._reject_decision(database, actor, "invite-cancel")
            changed = database.execute(
                "UPDATE invite SET cancelled_at = ? WHERE invite_id = ? "
                "AND consumed_at IS NULL AND cancelled_at IS NULL",
                (now, invite_id),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._audit(
                database,
                actor,
                "invite-cancel",
                row["bot_name"],
                "cancelled",
            )
            database.execute("COMMIT")

    def create_bot_invite(
        self,
        identity: BotIdentity,
        bot_name: str | None,
    ) -> InviteOffer:
        if not isinstance(identity, BotIdentity):
            raise PublicFailure()
        now = self.clock()
        offer: InviteOffer | None = None
        with self._connect() as database:
            try:
                self._begin(database)
                authorized = database.execute(
                    "SELECT 1 FROM helper_record "
                    "WHERE bot_name = ? AND account_id = ? "
                    "AND state = 'active'",
                    (identity.bot_name, identity.account_id),
                ).fetchone()
                if authorized is None:
                    database.execute("ROLLBACK")
                    raise PublicFailure()
                database.execute(
                    "DELETE FROM bot_invite_event WHERE happened_at < ?",
                    (now - BOT_INVITE_WINDOW,),
                )
                count = int(
                    database.execute(
                        "SELECT count(*) FROM bot_invite_event "
                        "WHERE bot_name = ? AND happened_at >= ?",
                        (identity.bot_name, now - BOT_INVITE_WINDOW),
                    ).fetchone()[0]
                )
                if count >= BOT_INVITE_LIMIT:
                    database.execute("ROLLBACK")
                    raise PublicFailure()
                offer = self._insert_invite(
                    database,
                    now,
                    identity.bot_name,
                    bot_name,
                )
                database.execute(
                    "INSERT INTO bot_invite_event "
                    "(bot_name, happened_at) VALUES (?, ?)",
                    (identity.bot_name, now),
                )
                self._audit(
                    database,
                    identity.bot_name,
                    "invite-create",
                    bot_name,
                    "created",
                )
                database.execute("COMMIT")
                return offer
            except Exception:
                if database.in_transaction:
                    database.execute("ROLLBACK")
                if offer is not None:
                    offer.clear()
                raise

    def request_join(
        self,
        invite_code: bytes | bytearray,
        bot_name: str,
        description: str,
        pairing: bytes | bytearray,
    ) -> str:
        if (
            not BOT_NAME.fullmatch(bot_name)
            or not isinstance(description, str)
            or not 1 <= len(description) <= 160
            or not isinstance(pairing, (bytes, bytearray))
            or len(pairing) < 16
        ):
            raise PublicFailure()
        if any(
            ord(character) < 32 or ord(character) == 127
            for character in description
        ):
            raise PublicFailure()
        invite_hash = self._invite_hash(invite_code)
        now = self.clock()
        pairing_hash = self._pairing_hash(bot_name, pairing)
        with self._connect() as database:
            self._begin(database)
            invite = database.execute(
                "SELECT invite_id, inviter_name, bot_name FROM invite "
                "WHERE code_hash = ? AND expires_at >= ? "
                "AND consumed_at IS NULL AND cancelled_at IS NULL",
                (invite_hash, now),
            ).fetchone()
            if (
                invite is None
                or (
                    invite["bot_name"] is not None
                    and invite["bot_name"] != bot_name
                )
            ):
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._prune_join_rows(database, now)
            total = int(
                database.execute(
                    "SELECT count(*) FROM join_request"
                ).fetchone()[0]
            )
            outstanding = int(
                database.execute(
                    "SELECT count(*) FROM join_request "
                    "WHERE consumed = 0 AND expires_at >= ?",
                    (now,),
                ).fetchone()[0]
            )
            per_bot = int(
                database.execute(
                    "SELECT count(*) FROM join_request "
                    "WHERE bot_name = ? AND consumed = 0 AND expires_at >= ?",
                    (bot_name, now),
                ).fetchone()[0]
            )
            if (
                total >= MAX_JOIN_ROWS
                or outstanding >= MAX_OUTSTANDING_TOTAL
                or per_bot >= MAX_OUTSTANDING_PER_BOT
            ):
                self._fail(
                    database,
                    self._bucket(bot_name),
                    bot_name,
                    "join-request",
                    bot_name,
                )
            for _ in range(16):
                code = "".join(
                    secrets.choice(CODE_ALPHABET) for _ in range(8)
                )
                try:
                    consumed = database.execute(
                        "UPDATE invite SET consumed_at = ? "
                        "WHERE invite_id = ? AND consumed_at IS NULL "
                        "AND cancelled_at IS NULL",
                        (now, invite["invite_id"]),
                    ).rowcount
                    if consumed != 1:
                        database.execute("ROLLBACK")
                        raise PublicFailure()
                    database.execute(
                        "INSERT INTO join_request "
                        "(code, bot_name, description, invite_id, invited_by, "
                        "template, pairing_hash, created_at, expires_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            code,
                            bot_name,
                            description,
                            invite["invite_id"],
                            invite["inviter_name"],
                            TEMPLATE,
                            pairing_hash,
                            now,
                            now + PAIRING_LIFETIME,
                        ),
                    )
                    break
                except sqlite3.IntegrityError:
                    database.execute(
                        "UPDATE invite SET consumed_at = NULL "
                        "WHERE invite_id = ? AND consumed_at = ?",
                        (invite["invite_id"], now),
                    )
                    continue
            else:
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._audit(
                database,
                bot_name,
                "join-request",
                bot_name,
                "accepted",
            )
            database.execute("COMMIT")
        return code

    @staticmethod
    def _valid_actor(actor: str) -> bool:
        return isinstance(actor, str) and 1 <= len(actor) <= 64

    def _reject_decision(
        self,
        database: sqlite3.Connection,
        actor: str,
        action: str,
    ) -> None:
        self._audit(database, actor, action, None, "rejected")
        database.execute("COMMIT")
        raise PublicFailure()

    def _pending_verified(self, actor: str, limit: int) -> list[dict[str, str | float]]:
        if not self._valid_actor(actor) or not isinstance(limit, int) or not 1 <= limit <= 50:
            raise PublicFailure()
        now = self.clock()
        with self._connect() as database:
            self._begin(database)
            rows = database.execute(
                "SELECT code, bot_name, created_at, invited_by FROM join_request "
                "WHERE approved = 0 AND refused = 0 AND consumed = 0 "
                "AND expires_at >= ? ORDER BY created_at, code LIMIT ?",
                (now, limit),
            ).fetchall()
            self._audit(database, actor, "pending", None, "listed")
            database.execute("COMMIT")
        return [
            {
                "botName": row["bot_name"],
                "code": row["code"],
                "requestedAt": row["created_at"],
                "invitedBy": row["invited_by"],
            }
            for row in rows
        ]

    def _approve_verified(self, code: str, actor: str) -> None:
        if not self._valid_actor(actor):
            raise PublicFailure()
        now = self.clock()
        with self._connect() as database:
            self._begin(database)
            row = database.execute(
                "SELECT bot_name FROM join_request "
                "WHERE code = ? AND approved = 0 AND refused = 0 AND consumed = 0 AND expires_at >= ?",
                (code, now),
            ).fetchone()
            if row is None:
                self._reject_decision(database, actor, "approve")
            database.execute("UPDATE join_request SET approved = 1 WHERE code = ?", (code,))
            self._audit(database, actor, "approve", row["bot_name"], "approved")
            database.execute("COMMIT")

    def _refuse_verified(self, code: str, actor: str) -> None:
        if not self._valid_actor(actor):
            raise PublicFailure()
        now = self.clock()
        with self._connect() as database:
            self._begin(database)
            row = database.execute(
                "SELECT bot_name FROM join_request "
                "WHERE code = ? AND approved = 0 AND refused = 0 AND consumed = 0 AND expires_at >= ?",
                (code, now),
            ).fetchone()
            if row is None:
                self._reject_decision(database, actor, "refuse")
            database.execute("UPDATE join_request SET refused = 1 WHERE code = ?", (code,))
            self._audit(database, actor, "refuse", row["bot_name"], "refused")
            database.execute("COMMIT")

    def _pairing_matches(
        self,
        row: sqlite3.Row | None,
        bot_name: str,
        pairing: bytes | bytearray,
    ) -> bool:
        return (
            isinstance(bot_name, str)
            and BOT_NAME.fullmatch(bot_name) is not None
            and isinstance(pairing, (bytes, bytearray))
            and len(pairing) >= 16
            and row is not None
            and row["bot_name"] == bot_name
            and row["template"] == TEMPLATE
            and hmac.compare_digest(
                row["pairing_hash"],
                self._pairing_hash(bot_name, pairing),
            )
        )

    def claim_approved(self, code: str, bot_name: str, pairing: bytes | bytearray) -> ApprovedJoin:
        now = self.clock()
        bucket = self._bucket(bot_name)
        with self._connect() as database:
            pairing_row = database.execute(
                "SELECT bot_name, template, pairing_hash FROM join_request WHERE code = ?",
                (code,),
            ).fetchone()
            if not self._pairing_matches(pairing_row, bot_name, pairing):
                raise PublicFailure()
            self._begin(database)
            per_bucket, global_count = self._failure_counts(database, now, bucket)
            if per_bucket >= FAILURE_LIMIT or global_count >= GLOBAL_FAILURE_LIMIT:
                self._fail(database, bucket, bot_name, "collect", bot_name)
            row = database.execute("SELECT * FROM join_request WHERE code = ?", (code,)).fetchone()
            valid = (
                self._pairing_matches(row, bot_name, pairing)
                and row["approved"] == 1
                and row["consumed"] == 0
                and row["refused"] == 0
                and row["expires_at"] >= now
                and database.execute(
                    "SELECT 1 FROM helper_record WHERE bot_name = ? AND state != 'cancelled'",
                    (bot_name,),
                ).fetchone()
                is None
            )
            if not valid:
                self._fail(database, bucket, bot_name, "collect", bot_name)
            changed = database.execute(
                "UPDATE join_request SET consumed = 1 WHERE code = ? AND consumed = 0",
                (code,),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            database.execute(
                "DELETE FROM helper_record WHERE bot_name = ? AND state = 'cancelled'",
                (bot_name,),
            )
            database.execute(
                "INSERT INTO helper_record (bot_name, state) VALUES (?, 'provisioning')",
                (bot_name,),
            )
            self._audit(database, bot_name, "collect", bot_name, "claimed-for-helper")
            database.execute("COMMIT")
        return ApprovedJoin(code, bot_name)

    def abandon_provision(self, bot_name: str) -> None:
        with self._connect() as database:
            self._begin(database)
            changed = database.execute(
                "DELETE FROM helper_record WHERE bot_name = ? AND state = 'provisioning'", (bot_name,)
            ).rowcount
            if changed:
                self._audit(database, bot_name, "helper-provision", bot_name, "refused")
            database.execute("COMMIT")

    @staticmethod
    def _target_from_row(row: sqlite3.Row) -> CollectTarget:
        return CollectTarget(
            row["bot_name"],
            row["account_id"],
            row["key_id"],
            row["helper_receipt"],
        )

    def record_collect(
        self,
        approval_id: str,
        target: CollectTarget,
        nonce: bytes,
        expected_mac: bytes,
        deadline: float,
    ) -> None:
        if (
            not isinstance(target, CollectTarget)
            or not isinstance(nonce, bytes)
            or len(nonce) != CONFIRM_NONCE_BYTES
            or not isinstance(expected_mac, bytes)
            or len(expected_mac) != hashlib.sha256().digest_size
            or not isinstance(deadline, (int, float))
            or isinstance(deadline, bool)
            or deadline <= self.clock()
        ):
            raise PublicFailure()
        with self._connect() as database:
            self._begin(database)
            provisioning = database.execute(
                "SELECT 1 FROM helper_record WHERE bot_name = ? AND state = 'provisioning'",
                (target.bot_name,),
            ).fetchone()
            join = database.execute(
                "SELECT 1 FROM join_request WHERE code = ? AND bot_name = ? AND consumed = 1",
                (approval_id, target.bot_name),
            ).fetchone()
            if provisioning is None or join is None:
                database.execute("ROLLBACK")
                raise PublicFailure()
            database.execute(
                "INSERT INTO collect_record "
                "(approval_id, bot_name, account_id, key_id, helper_receipt, nonce, expected_mac, deadline, state) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-confirmation')",
                (
                    approval_id,
                    target.bot_name,
                    target.account_id,
                    target.key_id,
                    target.helper_receipt,
                    nonce,
                    expected_mac,
                    float(deadline),
                ),
            )
            self._audit(database, "account-helper", "collect", target.bot_name, "offered")
            database.execute("COMMIT")

    def start_confirmation(
        self,
        approval_id: str,
        bot_name: str,
        pairing: bytes | bytearray,
        proof: bytes | bytearray,
    ) -> tuple[CollectTarget, bool]:
        now = self.clock()
        bucket = self._bucket(bot_name)
        with self._connect() as database:
            pairing_row = database.execute(
                "SELECT bot_name, template, pairing_hash FROM join_request WHERE code = ?",
                (approval_id,),
            ).fetchone()
            if not self._pairing_matches(pairing_row, bot_name, pairing):
                raise PublicFailure()
            self._begin(database)
            row = database.execute(
                "SELECT * FROM collect_record "
                "WHERE approval_id = ? AND bot_name = ? AND state = 'awaiting-confirmation'",
                (approval_id, bot_name),
            ).fetchone()
            if row is None:
                self._fail(database, bucket, bot_name, "confirm", bot_name)
            valid_proof = (
                isinstance(proof, (bytes, bytearray))
                and len(proof) == hashlib.sha256().digest_size
                and hmac.compare_digest(row["expected_mac"], proof)
            )
            activate = row["deadline"] >= now and valid_proof
            state = "activating" if activate else "revoking"
            result = "proof-accepted" if activate else ("expired" if row["deadline"] < now else "wrong-mac")
            changed = database.execute(
                "UPDATE collect_record SET state = ? "
                "WHERE approval_id = ? AND state = 'awaiting-confirmation'",
                (state, approval_id),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._audit(database, bot_name, "confirm", bot_name, result)
            database.execute("COMMIT")
        return self._target_from_row(row), activate

    def mark_collect_revoking(self, target: CollectTarget, result: str) -> None:
        with self._connect() as database:
            self._begin(database)
            changed = database.execute(
                "UPDATE collect_record SET state = 'revoking' "
                "WHERE bot_name = ? AND account_id = ? AND key_id = ? "
                "AND helper_receipt = ? AND state IN ('awaiting-confirmation', 'activating')",
                (
                    target.bot_name,
                    target.account_id,
                    target.key_id,
                    target.helper_receipt,
                ),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._audit(database, "account-helper", "collect-rollback", target.bot_name, result)
            database.execute("COMMIT")

    def confirm_activation(self, target: CollectTarget, record: BotRecord) -> None:
        if (
            record.bot_name != target.bot_name
            or record.account_id != target.account_id
            or record.key_id != target.key_id
            or record.adapter_receipt != target.helper_receipt
        ):
            raise PublicFailure()
        with self._connect() as database:
            self._begin(database)
            collect_changed = database.execute(
                "UPDATE collect_record SET state = 'active' "
                "WHERE bot_name = ? AND account_id = ? AND key_id = ? "
                "AND helper_receipt = ? AND state = 'activating'",
                (
                    target.bot_name,
                    target.account_id,
                    target.key_id,
                    target.helper_receipt,
                ),
            ).rowcount
            helper_changed = database.execute(
                "UPDATE helper_record SET account_id = ?, key_id = ?, adapter_receipt = ?, state = 'active' "
                "WHERE bot_name = ? AND state = 'provisioning'",
                (
                    record.account_id,
                    record.key_id,
                    record.adapter_receipt,
                    record.bot_name,
                ),
            ).rowcount
            if collect_changed != 1 or helper_changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._audit(database, "account-helper", "collect-activate", record.bot_name, "active")
            database.execute("COMMIT")

    def confirm_rollback(self, target: CollectTarget) -> None:
        with self._connect() as database:
            self._begin(database)
            changed = database.execute(
                "UPDATE collect_record SET state = 'revoked' "
                "WHERE bot_name = ? AND account_id = ? AND key_id = ? "
                "AND helper_receipt = ? AND state = 'revoking'",
                (
                    target.bot_name,
                    target.account_id,
                    target.key_id,
                    target.helper_receipt,
                ),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            database.execute(
                "DELETE FROM helper_record WHERE bot_name = ? AND state = 'provisioning'",
                (target.bot_name,),
            )
            self._audit(database, "account-helper", "collect-rollback", target.bot_name, "revoked")
            database.execute("COMMIT")

    def claim_recoveries(self, startup: bool) -> list[CollectTarget]:
        now = self.clock()
        with self._connect() as database:
            self._begin(database)
            if startup:
                rows = database.execute(
                    "SELECT * FROM collect_record "
                    "WHERE state IN ('awaiting-confirmation', 'activating', 'revoking') "
                    "ORDER BY deadline, approval_id"
                ).fetchall()
            else:
                rows = database.execute(
                    "SELECT * FROM collect_record "
                    "WHERE state = 'revoking' "
                    "OR (state IN ('awaiting-confirmation', 'activating') AND deadline < ?) "
                    "ORDER BY deadline, approval_id",
                    (now,),
                ).fetchall()
            for row in rows:
                database.execute(
                    "UPDATE collect_record SET state = 'revoking' WHERE approval_id = ?",
                    (row["approval_id"],),
                )
                self._audit(
                    database,
                    "account-helper",
                    "collect-recovery",
                    row["bot_name"],
                    (
                        "startup"
                        if startup
                        else ("retry" if row["state"] == "revoking" else "expired")
                    ),
                )
            database.execute("COMMIT")
        return [self._target_from_row(row) for row in rows]

    def confirm_replacement(self, old: BotRecord, new: BotRecord) -> None:
        if (
            new.bot_name != old.bot_name
            or new.account_id != old.account_id
            or new.key_id == old.key_id
            or new.adapter_receipt == old.adapter_receipt
        ):
            raise PublicFailure()
        with self._connect() as database:
            self._begin(database)
            changed = database.execute(
                "UPDATE helper_record SET key_id = ?, adapter_receipt = ? "
                "WHERE bot_name = ? AND account_id = ? AND key_id = ? AND adapter_receipt = ? AND state = 'active'",
                (
                    new.key_id,
                    new.adapter_receipt,
                    old.bot_name,
                    old.account_id,
                    old.key_id,
                    old.adapter_receipt,
                ),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._audit(database, "account-helper", "replace", old.bot_name, "active-old-revoked")
            database.execute("COMMIT")

    def confirm_cancel(self, record: BotRecord) -> None:
        with self._connect() as database:
            self._begin(database)
            changed = database.execute(
                "UPDATE helper_record SET state = 'cancelled' "
                "WHERE bot_name = ? AND account_id = ? AND key_id = ? AND adapter_receipt = ? AND state = 'active'",
                (record.bot_name, record.account_id, record.key_id, record.adapter_receipt),
            ).rowcount
            if changed != 1:
                database.execute("ROLLBACK")
                raise PublicFailure()
            self._audit(database, "account-helper", "cancel", record.bot_name, "cancelled")
            database.execute("COMMIT")

    def safe_account_state(self, bot_name: str) -> dict[str, str | bool]:
        with self._connect() as database:
            row = database.execute(
                "SELECT state FROM helper_record WHERE bot_name = ?", (bot_name,)
            ).fetchone()
        return {
            "exists": row is not None,
            "enabled": row is not None and row["state"] == "active",
            "state": row["state"] if row is not None else "absent",
        }

    def safe_failure_counts(self) -> dict[str, int]:
        with self._connect() as database:
            rows = database.execute(
                "SELECT result, count(*) AS amount FROM audit WHERE result IN ('refused', 'rate-limited') GROUP BY result"
            )
            counts = {row["result"]: row["amount"] for row in rows}
        return {"refused": counts.get("refused", 0), "rate_limited": counts.get("rate-limited", 0)}


class SignupService:
    def __init__(self, joins: JoinService, helper: AccountHelper) -> None:
        self.joins = joins
        self.helper = helper

    def start_join(
        self,
        invite_code: bytearray,
        bot_name: str,
        description: str,
    ) -> JoinHandle:
        if not isinstance(invite_code, bytearray):
            raise PublicFailure()
        pairing: bytearray | None = None
        try:
            pairing = random_buffer(PAIRING_BYTES)
            code = self.joins.request_join(
                invite_code,
                bot_name,
                description,
                pairing,
            )
            handle = JoinHandle(code, bot_name, pairing)
            pairing = None
            return handle
        finally:
            if pairing is not None:
                clear(pairing)
                pairing.clear()
            clear(invite_code)
            invite_code.clear()

    @staticmethod
    def _record(value: object, bot_name: str) -> BotRecord:
        if not isinstance(value, BotRecord) or value.bot_name != bot_name:
            raise HelperRefused("helper action refused")
        return value

    @staticmethod
    def _prepared(value: object, bot_name: str) -> PreparedCollect:
        if (
            not isinstance(value, PreparedCollect)
            or value.target.bot_name != bot_name
        ):
            raise HelperRefused("helper action refused")
        return value

    def collect(
        self,
        approval_id: str,
        bot_name: str,
        pairing: bytes | bytearray,
    ) -> CollectOffer:
        claimed = False
        prepared: PreparedCollect | None = None
        target: CollectTarget | None = None
        credential: bytearray | None = None
        nonce_buffer: bytearray | None = None
        try:
            join = self.joins.claim_approved(approval_id, bot_name, pairing)
            claimed = True
            prepared = self._prepared(self.helper.prepare_collect(join), bot_name)
            target = prepared.target
            credential = prepared.take_credential()
            nonce_buffer = random_buffer(CONFIRM_NONCE_BYTES)
            nonce = bytes(nonce_buffer)
            deadline = self.joins.clock() + CONFIRM_WINDOW
            expected_mac = confirmation_mac(
                credential,
                nonce,
                approval_id,
                target.account_id,
                target.key_id,
            )
            offer = CollectOffer(
                approval_id,
                target,
                nonce,
                deadline,
                credential,
            )
            self.joins.record_collect(
                approval_id,
                target,
                nonce,
                expected_mac,
                deadline,
            )
            credential = None
            return offer
        except Exception:
            if target is not None:
                try:
                    self.helper.rollback_collect(target)
                except Exception:
                    pass
            if claimed:
                try:
                    self.joins.abandon_provision(bot_name)
                except Exception:
                    pass
            raise PublicFailure() from None
        finally:
            if credential is not None:
                clear(credential)
                credential.clear()
            if nonce_buffer is not None:
                clear(nonce_buffer)
                nonce_buffer.clear()
            if prepared is not None:
                prepared.clear()

    def _rollback_collect(self, target: CollectTarget) -> None:
        self.helper.rollback_collect(target)
        self.joins.confirm_rollback(target)

    def confirm(
        self,
        approval_id: str,
        bot_name: str,
        pairing: bytes | bytearray,
        proof: bytes | bytearray,
    ) -> ConnectedBot:
        try:
            target, activate = self.joins.start_confirmation(
                approval_id,
                bot_name,
                pairing,
                proof,
            )
        except Exception:
            raise PublicFailure() from None
        if not activate:
            try:
                self._rollback_collect(target)
            except Exception:
                pass
            raise PublicFailure()
        try:
            record = self._record(self.helper.activate_collect(target), bot_name)
            self.joins.confirm_activation(target, record)
            return ConnectedBot(record)
        except Exception:
            try:
                self.joins.mark_collect_revoking(target, "activation-refused")
            except Exception:
                pass
            try:
                self._rollback_collect(target)
            except Exception:
                pass
            raise PublicFailure() from None

    def recover_unfinished(self, startup: bool) -> int:
        targets = self.joins.claim_recoveries(startup)
        failures = 0
        for target in targets:
            try:
                self._rollback_collect(target)
            except Exception:
                failures += 1
        if failures:
            raise PublicFailure()
        return len(targets)

    def replace(self, bot: ConnectedBot) -> ConnectedBot:
        old = bot.as_record()
        try:
            replacement = self._record(self.helper.replace(old), old.bot_name)
        except ReplacementCommitted as error:
            replacement = self._record(error.record, old.bot_name)
            try:
                self.joins.confirm_replacement(old, replacement)
            except Exception:
                pass
            raise ReplacementCommitted(replacement) from None
        except Exception:
            raise PublicFailure() from None
        try:
            self.joins.confirm_replacement(old, replacement)
        except Exception:
            raise ReplacementCommitted(replacement) from None
        return ConnectedBot(replacement)

    def cancel(self, bot: ConnectedBot) -> None:
        record = bot.as_record()
        try:
            self.helper.cancel(record)
        except Exception:
            raise PublicFailure() from None
        self.joins.confirm_cancel(record)
