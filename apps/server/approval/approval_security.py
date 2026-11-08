from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import stat
import struct
import sys
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

SCRYPT_N = 1 << 14
SCRYPT_R = 8
SCRYPT_P = 1
MAX_SECRET_FILE_BYTES = 16_384


class ApprovalRefused(RuntimeError):
    pass


class ApprovalRateLimited(ApprovalRefused):
    pass


class FreshSignInRequired(ApprovalRefused):
    pass


REFUSAL_STAGES = (
    "shape",
    "state-binding-no-cookie",
    "state-binding-cookie-mismatch",
    "state-binding-unknown-state",
    "state-binding-no-return",
    "transport-tls",
    "response-metadata",
    "response-status",
    "claims",
    "session-policy",
    "gate",
    "unclassified",
)


def refusal(text: str, stage: str) -> ApprovalRefused:
    if stage not in REFUSAL_STAGES:
        raise ValueError("unknown refusal stage")
    error = ApprovalRefused(text)
    error.stage = stage
    return error


def refusal_stage(error: BaseException) -> str:
    stage = getattr(error, "stage", None)
    return stage if isinstance(stage, str) and stage in REFUSAL_STAGES else "unclassified"


def clear(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)
        value.clear()


def _private_directory(path: Path) -> None:
    metadata = path.stat(follow_symlinks=False)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise ApprovalRefused("approval secret storage is unsafe")


def _password_hash(password: bytearray, salt: bytes) -> bytes:
    return hashlib.scrypt(password, salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)


def _encode(value: bytes | bytearray) -> str:
    return base64.b64encode(value).decode("ascii")


def _decode(value: object, size: int) -> bytearray:
    if not isinstance(value, str):
        raise ApprovalRefused("approval enrollment is invalid")
    try:
        decoded = bytearray(base64.b64decode(value, validate=True))
    except (ValueError, TypeError):
        raise ApprovalRefused("approval enrollment is invalid") from None
    if len(decoded) != size:
        clear(decoded)
        raise ApprovalRefused("approval enrollment is invalid")
    return decoded


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise ApprovalRefused("approval enrollment write did not progress")
        offset += written


def write_enrollment(
    path: str | os.PathLike[str],
    password: bytearray,
    *,
    salt: bytes,
    totp_secret: bytes,
    session_key: bytes,
) -> None:
    destination = Path(path)
    try:
        if not isinstance(password, bytearray) or not password:
            raise ApprovalRefused("approval password is invalid")
        _private_directory(destination.parent)
        if len(salt) != 16 or len(totp_secret) != 20 or len(session_key) != 32:
            raise ApprovalRefused("approval entropy is invalid")
        verifier = _password_hash(password, salt)
        document = {
            "format": 1,
            "password": {
                "algorithm": "scrypt",
                "n": SCRYPT_N,
                "p": SCRYPT_P,
                "r": SCRYPT_R,
                "salt": _encode(salt),
                "verifier": _encode(verifier),
            },
            "sessionKey": _encode(session_key),
            "totp": {
                "algorithm": "SHA1",
                "digits": 6,
                "period": 30,
                "secret": _encode(totp_secret),
            },
        }
        content = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
        descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        try:
            _write_all(descriptor, content)
            os.fsync(descriptor)
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1
            ):
                raise ApprovalRefused("approval enrollment file is unsafe")
        finally:
            os.close(descriptor)
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        clear(password)


@dataclass(slots=True)
class Enrollment:
    salt: bytearray
    verifier: bytearray
    totp_secret: bytearray
    session_key: bytearray

    def verify_password(self, password: bytearray) -> bool:
        try:
            if not isinstance(password, bytearray):
                return False
            candidate = _password_hash(password, bytes(self.salt))
            return hmac.compare_digest(candidate, self.verifier)
        finally:
            if isinstance(password, bytearray):
                clear(password)

    def verify_login(
        self, password: bytearray, phone_code: str, *, now: float
    ) -> int | None:
        if (
            not isinstance(phone_code, str)
            or len(phone_code) != 6
            or not phone_code.isascii()
            or not phone_code.isdigit()
        ):
            clear(password)
            return None
        if not self.verify_password(password):
            return None
        current_step = int(now) // 30
        for step in (current_step - 1, current_step, current_step + 1):
            if step < 0:
                continue
            digest = hmac.new(
                self.totp_secret, struct.pack(">Q", step), hashlib.sha1
            ).digest()
            offset = digest[-1] & 0x0F
            value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFF_FFFF
            expected = f"{value % 1_000_000:06d}"
            if hmac.compare_digest(expected, phone_code):
                return step
        return None


def _read_private(path: Path) -> bytes:
    _private_directory(path.parent)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise ApprovalRefused("approval enrollment file is unsafe")
        chunks: list[bytes] = []
        remaining = MAX_SECRET_FILE_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        if len(content) > MAX_SECRET_FILE_BYTES:
            raise ApprovalRefused("approval enrollment file is too large")
        return content
    finally:
        os.close(descriptor)



def load_enrollment(path: str | os.PathLike[str]) -> Enrollment:
    try:
        document = json.loads(_read_private(Path(path)))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ApprovalRefused("approval enrollment is invalid") from None
    if not isinstance(document, dict) or set(document) != {"format", "password", "sessionKey", "totp"}:
        raise ApprovalRefused("approval enrollment is invalid")
    password = document.get("password")
    totp = document.get("totp")
    if (
        document.get("format") != 1
        or not isinstance(password, dict)
        or password.get("algorithm") != "scrypt"
        or password.get("n") != SCRYPT_N
        or password.get("r") != SCRYPT_R
        or password.get("p") != SCRYPT_P
        or not isinstance(totp, dict)
        or totp.get("algorithm") != "SHA1"
        or totp.get("digits") != 6
        or totp.get("period") != 30
    ):
        raise ApprovalRefused("approval enrollment is invalid")
    decoded: list[bytearray] = []
    try:
        decoded.append(_decode(password.get("salt"), 16))
        decoded.append(_decode(password.get("verifier"), 32))
        decoded.append(_decode(totp.get("secret"), 20))
        decoded.append(_decode(document.get("sessionKey"), 32))
        return Enrollment(
            salt=decoded[0],
            verifier=decoded[1],
            totp_secret=decoded[2],
            session_key=decoded[3],
        )
    except ApprovalRefused:
        for value in decoded:
            clear(value)
        raise


TOKEN = re.compile(r"[A-Za-z0-9_-]{40,128}\Z")
PREAUTH_LIFETIME = 300
OIDC_LIFETIME = 900
SESSION_IDLE = 7 * 86400
SESSION_ABSOLUTE = 30 * 86400
CSRF_LIFETIME = 300
MAX_PREAUTH = 32
MAX_OIDC_STATES = 32
MAX_SESSIONS = 8
LOGIN_WINDOW = 900
LOGIN_CALLER_LIMIT = 5
LOGIN_GLOBAL_LIMIT = 20
CALLER_BAN = 3600
GLOBAL_CLOSE = 900
AUTH_WINDOW = 60
AUTH_SESSION_LIMIT = 30
AUTH_GLOBAL_LIMIT = 120
MAX_CSRF_PER_SESSION = 8
CSRF_REFUSAL_REASONS = ("malformed", "unknown-or-used", "expired")
AUTH_REFUSAL_REASONS = (
    "no-session",
    "idle-expired",
    "absolute-expired",
    "rate-session",
    "rate-global",
)
REFUSAL_LINES = {
    "csrf": ("QD_CSRF_REFUSED", CSRF_REFUSAL_REASONS),
    "auth": ("QD_AUTH_REFUSED", AUTH_REFUSAL_REASONS),
}


class _AuthRefusalLog:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.events: deque[float] = deque()
        self.suppressed = 0
        self.timer: threading.Timer | None = None

    def write(self, reason: str) -> None:
        with self.lock:
            now = time.monotonic()
            while self.events and self.events[0] <= now - 60:
                self.events.popleft()
            if len(self.events) < 10:
                self.events.append(now)
                _write_refusal_line(f"QD_AUTH_REFUSED reason={reason}\n")
                return
            self.suppressed += 1
            if self.timer is None:
                self.timer = threading.Timer(60, self.flush_summary)
                self.timer.daemon = True
                self.timer.start()

    def flush_summary(self) -> None:
        with self.lock:
            count = self.suppressed
            self.suppressed = 0
            self.timer = None
            if count:
                _write_refusal_line(f"QD_AUTH_REFUSED_SUPPRESSED count={count}\n")


_auth_refusal_log = _AuthRefusalLog()


def _write_refusal_line(line: str) -> None:
    try:
        sys.stderr.write(line)
        sys.stderr.flush()
    except Exception:
        return


def log_refusal_class(kind: str, reason: str) -> None:
    if kind not in REFUSAL_LINES or reason not in REFUSAL_LINES[kind][1]:
        raise ValueError("refusal class is not fixed")
    try:
        if kind == "auth":
            _auth_refusal_log.write(reason)
        else:
            _write_refusal_line(f"{REFUSAL_LINES[kind][0]} reason={reason}\n")
    except Exception:
        return


@dataclass(frozen=True, slots=True)
class OidcMaterial:
    nonce: str
    verifier: str
    challenge: str


@dataclass(frozen=True, slots=True)
class OidcStart:
    state: str
    browser: str
    nonce: str
    verifier: str
    challenge: str


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exception_type, exception, traceback):
        try:
            return super().__exit__(exception_type, exception, traceback)
        finally:
            self.close()


@dataclass(frozen=True, slots=True, repr=False)
class BrowserSession:
    token: str
    device_handle: str
    fresh_until: float


DEVICE_KINDS = ("iPhone Safari", "iPad Safari", "Mac Safari", "Chrome", "Firefox", "Other browser")
SESSION_END_REASONS = ("signed-out", "idle", "overall", "device-replaced", "everywhere", "cap")
STEP_UP_PATH = "/captain/step-up"
DEVICES_PATH = "/captain/settings/devices"
DEVICE_SIGNOUT_PATH = DEVICES_PATH + "/sign-out"
EVERYWHERE_PATH = DEVICES_PATH + "/sign-out-everywhere"
SIGNED_OUT_PATH = "/captain/signed-out"
_PAGE_ACTIVITY = frozenset({"/captain/pending", "/captain/chat", DEVICES_PATH})
_POST_ACTIVITY = frozenset({
    "/captain/api/chat", "/captain/approve", "/captain/refuse",
    "/captain/invites/create", "/captain/invites/cancel",
    "/captain/settings/approval-password", DEVICE_SIGNOUT_PATH, EVERYWHERE_PATH,
})
_FRESH_POSTS = _POST_ACTIVITY - {"/captain/api/chat", DEVICE_SIGNOUT_PATH}
_CARD_ACTION = re.compile(r"/captain/cards/[A-Za-z0-9][A-Za-z0-9-]{0,63}/(answer|comments)")


def requires_fresh(method: str, path: str) -> bool:
    if method != "POST":
        return False
    path = urlsplit(path).path
    card = _CARD_ACTION.fullmatch(path)
    return path in _FRESH_POSTS or (card is not None and card[1] == "answer")


def activity_allowed(method: str, path: str, headers: dict[str, str]) -> bool:
    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        return False
    if method == "POST":
        return parsed.path in _POST_ACTIVITY or _CARD_ACTION.fullmatch(parsed.path) is not None
    lowered = {name.lower(): value for name, value in headers.items()}
    return (
        method == "GET" and parsed.path in _PAGE_ACTIVITY
        and lowered.get("sec-fetch-dest") == "document"
        and "if-none-match" not in lowered
    )


def _session_event(reason: str | None = None) -> None:
    if reason is None:
        _write_refusal_line("QD_SESSION_START\n")
    elif reason in SESSION_END_REASONS:
        _write_refusal_line(f"QD_SESSION_END reason={reason}\n")
    else:
        raise ValueError("session end reason is not fixed")


class ApprovalState:
    def __init__(
        self,
        path: str | os.PathLike[str],
        session_key: bytes | bytearray,
        *,
        clock: Callable[[], float] = time.time,
        token_bytes: Callable[[int], bytes] = os.urandom,
    ) -> None:
        self.path = Path(path)
        self.clock = clock
        self.token_bytes = token_bytes
        if not isinstance(session_key, (bytes, bytearray)) or len(session_key) != 32:
            raise ApprovalRefused("approval session key is invalid")
        self.session_key = bytes(session_key)
        _private_directory(self.path.parent)
        self._prepare_database()
        self._initialize()

    def _prepare_database(self) -> None:
        try:
            descriptor = os.open(
                self.path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
            )
        except FileExistsError:
            descriptor = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1
            ):
                raise ApprovalRefused("approval session state is unsafe")
        finally:
            os.close(descriptor)

    def _connect(self) -> sqlite3.Connection:
        database = sqlite3.connect(
            self.path,
            isolation_level=None,
            timeout=5,
            factory=_ClosingConnection,
        )
        try:
            database.row_factory = sqlite3.Row
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
                CREATE TABLE IF NOT EXISTS preauth (
                    token_hash BLOB PRIMARY KEY,
                    expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS oidc_state (
                    state_hash BLOB PRIMARY KEY,
                    browser_hash BLOB NOT NULL,
                    expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS session (
                    token_hash BLOB PRIMARY KEY,
                    created REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    fresh_until REAL NOT NULL DEFAULT 0,
                    device_id INTEGER
                );
                CREATE TABLE IF NOT EXISTS csrf (
                    token_hash BLOB PRIMARY KEY,
                    owner_hash BLOB NOT NULL,
                    expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS used_totp (
                    step INTEGER PRIMARY KEY,
                    expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS login_failure (
                    caller_hash BLOB NOT NULL,
                    happened REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS login_failure_time ON login_failure(happened);
                CREATE TABLE IF NOT EXISTS caller_ban (
                    caller_hash BLOB PRIMARY KEY,
                    expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS global_gate (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    login_closed_until REAL NOT NULL
                );
                INSERT OR IGNORE INTO global_gate (singleton, login_closed_until) VALUES (1, 0);
                CREATE TABLE IF NOT EXISTS auth_event (
                    session_hash BLOB NOT NULL,
                    happened REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS auth_event_time ON auth_event(happened);
                CREATE TABLE IF NOT EXISTS approval_password (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    salt BLOB NOT NULL CHECK (length(salt) = 16),
                    verifier BLOB NOT NULL CHECK (length(verifier) = 32)
                );
                CREATE TABLE IF NOT EXISTS identity (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    subject TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS device (
                    device_id INTEGER PRIMARY KEY,
                    account_id INTEGER NOT NULL CHECK (account_id = 1),
                    handle_hash BLOB NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS activity (
                    happened REAL NOT NULL,
                    summary TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS activity_time ON activity(happened);
                """
            )
            columns = {row["name"] for row in database.execute("PRAGMA table_info(session)")}
            ended = 0
            database.execute("BEGIN IMMEDIATE")
            if "fresh_until" not in columns or "device_id" not in columns:
                ended = database.execute("SELECT count(*) FROM session").fetchone()[0]
                database.execute("DELETE FROM csrf")
                database.execute("DELETE FROM auth_event")
                database.execute("DELETE FROM session")
                if "fresh_until" not in columns:
                    database.execute("ALTER TABLE session ADD COLUMN fresh_until REAL NOT NULL DEFAULT 0")
                if "device_id" not in columns:
                    database.execute("ALTER TABLE session ADD COLUMN device_id INTEGER")
            database.execute("CREATE UNIQUE INDEX IF NOT EXISTS session_device ON session(device_id) WHERE device_id IS NOT NULL")
            database.execute("COMMIT")
        for _ in range(ended):
            _session_event("signed-out")

    def _digest(self, label: bytes, token: str) -> bytes:
        if TOKEN.fullmatch(token) is None:
            raise ApprovalRefused("approval token is invalid")
        return hmac.new(self.session_key, label + b"\0" + token.encode("ascii"), hashlib.sha256).digest()

    def _token(self) -> str:
        raw = self.token_bytes(32)
        if not isinstance(raw, bytes) or len(raw) != 32:
            raise ApprovalRefused("approval token source failed")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def oidc_material(self, state: str) -> OidcMaterial:
        if TOKEN.fullmatch(state) is None:
            raise refusal("Google sign-in state is invalid", "state-binding-unknown-state")
        encoded = state.encode("ascii")
        nonce = base64.urlsafe_b64encode(
            hmac.new(
                self.session_key, b"oidc-nonce\0" + encoded, hashlib.sha256
            ).digest()
        ).decode("ascii").rstrip("=")
        verifier = base64.urlsafe_b64encode(
            hmac.new(
                self.session_key, b"oidc-verifier\0" + encoded, hashlib.sha256
            ).digest()
        ).decode("ascii").rstrip("=")
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("ascii")).digest()
        ).decode("ascii").rstrip("=")
        return OidcMaterial(nonce, verifier, challenge)

    def begin_oidc(self) -> OidcStart:
        now = self.clock()
        state = self._token()
        browser = self._token()
        material = self.oidc_material(state)
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            if (
                database.execute("SELECT count(*) FROM oidc_state").fetchone()[0]
                >= MAX_OIDC_STATES
            ):
                database.execute("ROLLBACK")
                raise ApprovalRefused("Google sign-in capacity reached")
            database.execute(
                "INSERT INTO oidc_state (state_hash, browser_hash, expires) "
                "VALUES (?, ?, ?)",
                (
                    self._digest(b"oidc-state", state),
                    self._digest(b"oidc-browser", browser),
                    now + OIDC_LIFETIME,
                ),
            )
            database.execute("COMMIT")
        return OidcStart(
            state,
            browser,
            material.nonce,
            material.verifier,
            material.challenge,
        )

    def consume_oidc(self, state: str, browser: str | None) -> bool:
        return self.consume_oidc_outcome(state, browser) == "bound"

    def consume_oidc_outcome(self, state: str, browser: str | None) -> str:
        if not isinstance(browser, str) or not browser:
            return "no-cookie"
        now = self.clock()
        try:
            state_hash = self._digest(b"oidc-state", state)
        except ApprovalRefused:
            return "unknown-state"
        browser_hash = None
        if isinstance(browser, str):
            try:
                browser_hash = self._digest(b"oidc-browser", browser)
            except ApprovalRefused:
                pass
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            row = database.execute(
                "SELECT browser_hash FROM oidc_state "
                "WHERE state_hash = ? AND expires > ?",
                (state_hash, now),
            ).fetchone()
            database.execute(
                "DELETE FROM oidc_state WHERE state_hash = ?",
                (state_hash,),
            )
            database.execute("COMMIT")
        if row is None:
            return "unknown-state"
        if browser_hash is None or not hmac.compare_digest(
            bytes(row["browser_hash"]), browser_hash
        ):
            return "cookie-mismatch"
        return "bound"

    def _prune(self, database: sqlite3.Connection, now: float) -> None:
        database.execute("DELETE FROM preauth WHERE expires <= ?", (now,))
        database.execute("DELETE FROM oidc_state WHERE expires <= ?", (now,))
        database.execute("DELETE FROM csrf WHERE expires <= ?", (now - CSRF_LIFETIME,))
        database.execute("DELETE FROM used_totp WHERE expires <= ?", (now,))
        database.execute("DELETE FROM login_failure WHERE happened <= ?", (now - LOGIN_WINDOW,))
        database.execute("DELETE FROM caller_ban WHERE expires <= ?", (now,))
        database.execute("DELETE FROM auth_event WHERE happened <= ?", (now - AUTH_WINDOW,))

    def new_preauth(self) -> tuple[str, str]:
        now = self.clock()
        preauth = self._token()
        csrf = self._token()
        owner_hash = self._digest(b"preauth", preauth)
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            if database.execute("SELECT count(*) FROM preauth").fetchone()[0] >= MAX_PREAUTH:
                database.execute("ROLLBACK")
                raise ApprovalRefused("approval preauth capacity reached")
            database.execute(
                "INSERT INTO preauth (token_hash, expires) VALUES (?, ?)",
                (owner_hash, now + PREAUTH_LIFETIME),
            )
            database.execute(
                "INSERT INTO csrf (token_hash, owner_hash, expires) VALUES (?, ?, ?)",
                (self._digest(b"csrf", csrf), owner_hash, now + CSRF_LIFETIME),
            )
            database.execute("COMMIT")
        return preauth, csrf

    def consume_preauth(self, preauth: str, csrf: str) -> bool:
        now = self.clock()
        try:
            owner_hash = self._digest(b"preauth", preauth)
            csrf_hash = self._digest(b"csrf", csrf)
        except ApprovalRefused:
            return False
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            preauth_removed = database.execute(
                "DELETE FROM preauth WHERE token_hash = ? AND expires > ?",
                (owner_hash, now),
            ).rowcount
            csrf_removed = database.execute(
                "DELETE FROM csrf WHERE token_hash = ? AND owner_hash = ? AND expires > ?",
                (csrf_hash, owner_hash, now),
            ).rowcount
            if preauth_removed != 1 or csrf_removed != 1:
                database.execute("ROLLBACK")
                return False
            database.execute("COMMIT")
        return True

    def _caller_hash(self, caller: str) -> bytes:
        try:
            encoded = caller.encode("ascii")
        except (AttributeError, UnicodeEncodeError):
            raise ApprovalRefused("approval caller is invalid") from None
        return hmac.new(self.session_key, b"caller\0" + encoded, hashlib.sha256).digest()

    def login_allowed(self, caller: str) -> bool:
        now = self.clock()
        caller_hash = self._caller_hash(caller)
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            closed = database.execute(
                "SELECT login_closed_until FROM global_gate WHERE singleton = 1"
            ).fetchone()[0]
            banned = database.execute(
                "SELECT 1 FROM caller_ban WHERE caller_hash = ? AND expires > ?",
                (caller_hash, now),
            ).fetchone()
            database.execute("COMMIT")
        return closed <= now and banned is None

    def record_login_failure(self, caller: str) -> bool:
        now = self.clock()
        caller_hash = self._caller_hash(caller)
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            database.execute(
                "INSERT INTO login_failure (caller_hash, happened) VALUES (?, ?)",
                (caller_hash, now),
            )
            caller_count = database.execute(
                "SELECT count(*) FROM login_failure WHERE caller_hash = ?",
                (caller_hash,),
            ).fetchone()[0]
            global_count = database.execute("SELECT count(*) FROM login_failure").fetchone()[0]
            if caller_count >= LOGIN_CALLER_LIMIT:
                database.execute(
                    "INSERT INTO caller_ban (caller_hash, expires) VALUES (?, ?) "
                    "ON CONFLICT(caller_hash) DO UPDATE SET expires = excluded.expires",
                    (caller_hash, now + CALLER_BAN),
                )
            if global_count >= LOGIN_GLOBAL_LIMIT:
                database.execute(
                    "UPDATE global_gate SET login_closed_until = ? WHERE singleton = 1",
                    (now + GLOBAL_CLOSE,),
                )
            database.execute("COMMIT")
        return caller_count >= LOGIN_CALLER_LIMIT or global_count >= LOGIN_GLOBAL_LIMIT


    def start_identity_session(self, subject: str) -> str | None:
        session = self.start_browser_session(subject, device_hash=None, kind="Other browser", fresh_from=None)
        return None if session is None else session.token

    def device_verifier(self, handle: str | None) -> bytes | None:
        if not isinstance(handle, str) or len(handle) != 43 or TOKEN.fullmatch(handle) is None:
            return None
        try:
            decoded = base64.urlsafe_b64decode(handle + "=")
        except ValueError:
            return None
        if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != handle:
            return None
        return self._digest(b"device", handle)

    @staticmethod
    def _end_rows(database: sqlite3.Connection, rows: list[sqlite3.Row], *, keep_device: bool = False) -> None:
        for row in rows:
            database.execute("DELETE FROM csrf WHERE owner_hash = ?", (row["token_hash"],))
            database.execute("DELETE FROM auth_event WHERE session_hash = ?", (row["token_hash"],))
            database.execute("DELETE FROM session WHERE token_hash = ?", (row["token_hash"],))
            if not keep_device and row["device_id"] is not None:
                database.execute("DELETE FROM device WHERE device_id = ? AND account_id = 1", (row["device_id"],))

    def _expire_sessions(self, database: sqlite3.Connection, now: float) -> list[str]:
        rows = database.execute(
            "SELECT token_hash, device_id, created, last_seen FROM session "
            "WHERE created + ? <= ? OR last_seen + ? <= ?",
            (SESSION_ABSOLUTE, now, SESSION_IDLE, now),
        ).fetchall()
        reasons = ["overall" if row["created"] + SESSION_ABSOLUTE <= now else "idle" for row in rows]
        self._end_rows(database, rows)
        return reasons

    def start_browser_session(
        self, subject: str, *, device_hash: bytes | None, kind: str, fresh_from: float | None, replace_owner: bytes | None = None
    ) -> BrowserSession | None:
        now = self.clock()
        if (
            not isinstance(subject, str)
            or not 1 <= len(subject) <= 255
            or any(ord(character) < 0x20 for character in subject)
            or kind not in DEVICE_KINDS
            or (device_hash is not None and (not isinstance(device_hash, bytes) or len(device_hash) != 32))
            or (fresh_from is not None and (isinstance(fresh_from, bool) or not isinstance(fresh_from, (int, float)) or not 0 <= fresh_from <= now))
            or (replace_owner is not None and (not isinstance(replace_owner, bytes) or len(replace_owner) != 32 or fresh_from is None))
        ):
            return None
        token = self._token()
        token_hash = self._digest(b"session", token)
        handle = self._token()
        handle_hash = self.device_verifier(handle)
        fresh_until = 0.0 if fresh_from is None else fresh_from + 900
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            identity = database.execute("SELECT subject FROM identity WHERE singleton = 1").fetchone()
            if identity is not None and identity["subject"] != subject:
                database.execute("ROLLBACK")
                return None
            old_session = None
            if replace_owner is not None:
                old_session = database.execute(
                    "SELECT token_hash, device_id FROM session WHERE token_hash = ? AND created + ? > ? AND last_seen + ? > ?",
                    (replace_owner, SESSION_ABSOLUTE, now, SESSION_IDLE, now),
                ).fetchone()
                if old_session is None:
                    database.execute("ROLLBACK")
                    return None
            ended = self._expire_sessions(database, now)
            self._prune(database, now)
            if identity is None:
                database.execute("INSERT INTO identity (singleton, subject) VALUES (1, ?)", (subject,))
                database.execute("INSERT INTO activity (happened, summary) VALUES (?, ?)", (now, "Google identity pinned"))
            device = database.execute("SELECT device_id FROM device WHERE account_id = 1 AND handle_hash = ?", (device_hash,)).fetchone()
            if old_session is not None and (device is None or old_session["device_id"] != device["device_id"]):
                self._end_rows(database, [old_session])
                ended.append("device-replaced")
            if device is not None:
                device_id = device["device_id"]
                rows = database.execute("SELECT token_hash, device_id FROM session WHERE device_id = ?", (device_id,)).fetchall()
                self._end_rows(database, rows, keep_device=True)
                ended.extend("device-replaced" for _ in rows)
                database.execute("UPDATE device SET handle_hash = ?, kind = ?, created = ? WHERE device_id = ? AND account_id = 1", (handle_hash, kind, now, device_id))
            else:
                while database.execute("SELECT count(*) FROM session").fetchone()[0] >= MAX_SESSIONS:
                    row = database.execute("SELECT token_hash, device_id FROM session ORDER BY last_seen, created, rowid LIMIT 1").fetchone()
                    self._end_rows(database, [row])
                    ended.append("cap")
                device_id = database.execute("INSERT INTO device (account_id, handle_hash, kind, created) VALUES (1, ?, ?, ?)", (handle_hash, kind, now)).lastrowid
            database.execute(
                "INSERT INTO session (token_hash, created, last_seen, fresh_until, device_id) VALUES (?, ?, ?, ?, ?)",
                (token_hash, now, now, fresh_until, device_id),
            )
            database.execute("COMMIT")
        for reason in ended:
            _session_event(reason)
        _session_event()
        return BrowserSession(token, handle, fresh_until)

    def fresh_until(self, owner_hash: bytes) -> float:
        now = self.clock()
        with self._connect() as database:
            row = database.execute(
                "SELECT fresh_until FROM session WHERE token_hash = ? AND created + ? > ? AND last_seen + ? > ?",
                (owner_hash, SESSION_ABSOLUTE, now, SESSION_IDLE, now),
            ).fetchone()
        return 0.0 if row is None else float(row["fresh_until"])

    def devices(self, owner_hash: bytes) -> list[dict[str, object]]:
        now = self.clock()
        with self._connect() as database:
            owner = database.execute(
                "SELECT device_id FROM session WHERE token_hash = ? AND created + ? > ? AND last_seen + ? > ?",
                (owner_hash, SESSION_ABSOLUTE, now, SESSION_IDLE, now),
            ).fetchone()
            if owner is None:
                raise ApprovalRefused("Captain session is invalid")
            rows = database.execute(
                "SELECT d.device_id, d.kind, s.created, s.last_seen FROM device d JOIN session s USING(device_id) "
                "WHERE d.account_id = 1 AND s.created + ? > ? AND s.last_seen + ? > ? ORDER BY s.last_seen DESC, d.device_id",
                (SESSION_ABSOLUTE, now, SESSION_IDLE, now),
            ).fetchall()
        return [
            {"id": row["device_id"], "kind": row["kind"], "signedIn": row["created"], "lastUsed": row["last_seen"], "current": row["device_id"] == owner["device_id"]}
            for row in rows
        ]

    @staticmethod
    def _session_refusal(seen: sqlite3.Row | None, now: float) -> str:
        if seen is None:
            return "no-session"
        if seen["created"] + SESSION_ABSOLUTE <= now:
            return "absolute-expired"
        if seen["last_seen"] + SESSION_IDLE <= now:
            return "idle-expired"
        return "no-session"

    def authorize_session(self, token: str) -> bytes | None:
        now = self.clock()
        try:
            token_hash = self._digest(b"session", token)
        except ApprovalRefused:
            log_refusal_class("auth", "no-session")
            return None
        reason = None
        limited = False
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            seen = database.execute(
                "SELECT created, last_seen FROM session WHERE token_hash = ?", (token_hash,)
            ).fetchone()
            ended = self._expire_sessions(database, now)
            self._prune(database, now)
            if database.execute("SELECT 1 FROM session WHERE token_hash = ?", (token_hash,)).fetchone() is None:
                reason = self._session_refusal(seen, now)
            else:
                session_count = database.execute("SELECT count(*) FROM auth_event WHERE session_hash = ?", (token_hash,)).fetchone()[0]
                global_count = database.execute("SELECT count(*) FROM auth_event").fetchone()[0]
                if session_count >= AUTH_SESSION_LIMIT or global_count >= AUTH_GLOBAL_LIMIT:
                    reason = "rate-session" if session_count >= AUTH_SESSION_LIMIT else "rate-global"
                    limited = True
                else:
                    database.execute("INSERT INTO auth_event (session_hash, happened) VALUES (?, ?)", (token_hash, now))
            database.execute("COMMIT")
        for end_reason in ended:
            _session_event(end_reason)
        if reason is not None:
            log_refusal_class("auth", reason)
            if limited:
                raise ApprovalRateLimited("approval session rate limit")
            return None
        return token_hash

    def touch_session(self, owner_hash: bytes) -> bool:
        now = self.clock()
        with self._connect() as database:
            return database.execute(
                "UPDATE session SET last_seen = max(last_seen, ?) WHERE token_hash = ? "
                "AND created + ? > ? AND last_seen + ? > ?",
                (now, owner_hash, SESSION_ABSOLUTE, now, SESSION_IDLE, now),
            ).rowcount == 1

    def issue_csrf(self, owner_hash: bytes) -> str:
        now = self.clock()
        csrf = self._token()
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            if database.execute("SELECT 1 FROM session WHERE token_hash = ?", (owner_hash,)).fetchone() is None:
                database.execute("ROLLBACK")
                raise ApprovalRefused("approval session is invalid")
            database.execute(
                "INSERT INTO csrf (token_hash, owner_hash, expires) VALUES (?, ?, ?)",
                (self._digest(b"csrf", csrf), owner_hash, now + CSRF_LIFETIME),
            )
            database.execute(
                "DELETE FROM csrf WHERE owner_hash = ? AND rowid NOT IN "
                "(SELECT rowid FROM csrf WHERE owner_hash = ? ORDER BY rowid DESC LIMIT ?)",
                (owner_hash, owner_hash, MAX_CSRF_PER_SESSION),
            )
            database.execute("COMMIT")
        return csrf

    def consume_csrf(self, owner_hash: bytes, csrf: str) -> bool:
        now = self.clock()
        try:
            csrf_hash = self._digest(b"csrf", csrf)
        except ApprovalRefused:
            log_refusal_class("csrf", "malformed")
            return False
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            self._prune(database, now)
            removed = database.execute(
                "DELETE FROM csrf WHERE token_hash = ? AND owner_hash = ? AND expires > ?",
                (csrf_hash, owner_hash, now),
            ).rowcount
            remembered = None
            if removed != 1:
                remembered = database.execute(
                    "SELECT expires FROM csrf WHERE token_hash = ? AND owner_hash = ?",
                    (csrf_hash, owner_hash),
                ).fetchone()
            database.execute("COMMIT")
        if removed != 1:
            log_refusal_class("csrf", "unknown-or-used" if remembered is None else "expired")
        return removed == 1

    def approval_password_required(self) -> bool:
        with self._connect() as database:
            return (
                database.execute(
                    "SELECT 1 FROM approval_password WHERE singleton = 1"
                ).fetchone()
                is not None
            )

    @staticmethod
    def _valid_approval_password(value: object) -> bool:
        return isinstance(value, bytearray) and 1 <= len(value) <= 1024

    def verify_approval_password(self, password: bytearray) -> bool:
        try:
            if not self._valid_approval_password(password):
                return False
            with self._connect() as database:
                row = database.execute(
                    "SELECT salt, verifier FROM approval_password WHERE singleton = 1"
                ).fetchone()
            if row is None:
                return False
            candidate = _password_hash(password, bytes(row["salt"]))
            return hmac.compare_digest(candidate, bytes(row["verifier"]))
        finally:
            if isinstance(password, bytearray):
                clear(password)

    def change_approval_password(
        self,
        current: bytearray | None,
        replacement: bytearray | None,
        *,
        enabled: bool,
    ) -> None:
        if not isinstance(enabled, bool):
            clear(current)
            clear(replacement)
            raise ApprovalRefused("approval password setting is invalid")
        try:
            with self._connect() as database:
                database.execute("BEGIN IMMEDIATE")
                row = database.execute(
                    "SELECT salt, verifier FROM approval_password WHERE singleton = 1"
                ).fetchone()
                if row is not None:
                    if not self._valid_approval_password(current):
                        database.execute("ROLLBACK")
                        raise ApprovalRefused("approval password was refused")
                    candidate = _password_hash(current, bytes(row["salt"]))
                    if not hmac.compare_digest(candidate, bytes(row["verifier"])):
                        database.execute("ROLLBACK")
                        raise ApprovalRefused("approval password was refused")
                if enabled:
                    if not self._valid_approval_password(replacement):
                        database.execute("ROLLBACK")
                        raise ApprovalRefused("approval password setting is invalid")
                    salt = self.token_bytes(16)
                    if not isinstance(salt, bytes) or len(salt) != 16:
                        database.execute("ROLLBACK")
                        raise ApprovalRefused("approval token source failed")
                    verifier = _password_hash(replacement, salt)
                    database.execute(
                        "INSERT INTO approval_password (singleton, salt, verifier) "
                        "VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET "
                        "salt = excluded.salt, verifier = excluded.verifier",
                        (salt, verifier),
                    )
                    summary = (
                        "Approval password changed"
                        if row is not None
                        else "Approval password required"
                    )
                else:
                    if row is None:
                        database.execute("ROLLBACK")
                        raise ApprovalRefused("approval password setting is invalid")
                    database.execute(
                        "DELETE FROM approval_password WHERE singleton = 1"
                    )
                    summary = "Approval password not required"
                database.execute(
                    "INSERT INTO activity (happened, summary) VALUES (?, ?)",
                    (self.clock(), summary),
                )
                database.execute("COMMIT")
        finally:
            clear(current)
            clear(replacement)

    def record_activity(self, summary: str) -> None:
        if (
            not isinstance(summary, str)
            or not 1 <= len(summary) <= 256
            or any(ord(character) < 0x20 for character in summary)
        ):
            raise ApprovalRefused("approval activity is invalid")
        with self._connect() as database:
            database.execute(
                "INSERT INTO activity (happened, summary) VALUES (?, ?)",
                (self.clock(), summary),
            )

    def recent_activity(self, limit: int = 100) -> list[dict[str, str | float]]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ApprovalRefused("approval activity limit is invalid")
        with self._connect() as database:
            rows = database.execute(
                "SELECT happened, summary FROM activity "
                "ORDER BY happened DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {"happened": float(row["happened"]), "summary": row["summary"]}
            for row in rows
        ]

    def revoke_session(self, token_hash: bytes) -> None:
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            rows = database.execute("SELECT token_hash, device_id FROM session WHERE token_hash = ?", (token_hash,)).fetchall()
            self._end_rows(database, rows)
            database.execute("COMMIT")
        for _ in rows:
            _session_event("signed-out")

    def revoke_device(self, owner_hash: bytes, device_id: int | None = None) -> bool:
        if device_id is not None and (isinstance(device_id, bool) or not isinstance(device_id, int) or device_id < 1):
            return False
        now = self.clock()
        with self._connect() as database:
            database.execute("BEGIN IMMEDIATE")
            owner = database.execute(
                "SELECT device_id, fresh_until FROM session WHERE token_hash = ? AND created + ? > ? AND last_seen + ? > ?",
                (owner_hash, SESSION_ABSOLUTE, now, SESSION_IDLE, now),
            ).fetchone()
            if owner is None or ((device_id is None or device_id != owner["device_id"]) and owner["fresh_until"] <= now):
                database.execute("ROLLBACK")
                return False
            if device_id is None:
                rows = database.execute("SELECT token_hash, device_id FROM session").fetchall()
            else:
                rows = database.execute("SELECT s.token_hash, s.device_id FROM session s JOIN device d USING(device_id) WHERE d.account_id = 1 AND s.device_id = ?", (device_id,)).fetchall()
            self._end_rows(database, rows)
            database.execute("COMMIT")
        for _ in rows:
            _session_event("everywhere" if device_id is None else "signed-out")
        return bool(rows)
