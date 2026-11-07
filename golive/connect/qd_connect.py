from __future__ import annotations

import base64
import hmac
import http.client
import json
import os
import re
import ssl
import stat
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit

import qd_jmap
from signup_flow import confirmation_mac


API_KEY = re.compile(rb"API_[A-Za-z0-9_-]{20,508}\Z")
INVITE = re.compile(rb"[A-Za-z0-9_-]{22}\Z")
BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
CODE = re.compile(r"[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}\Z")
MAX_API_KEY_BYTES = 512
MAX_CONFIG_BYTES = 65536
MAX_HTTP_BODY_BYTES = 8192
REQUEST_PATH = "/qd/join/request"
COLLECT_PATH = "/qd/join/collect"
CAPTAIN = "captain"
CHAT_SCHEMA = "chat/1"


class ConnectRefused(RuntimeError):
    pass


class KeyAdapter(Protocol):
    bot_name: str

    def save(self, value: bytearray) -> None: ...
    def read(self) -> bytearray: ...


class Joiner(Protocol):
    def request(
        self,
        bot_name: str,
        description: str,
        invite: bytearray,
    ) -> JoinRequest: ...
    def collect(self, request: JoinRequest) -> CollectedOffer: ...
    def confirm(
        self, request: JoinRequest, offer: CollectedOffer, proof: bytearray
    ) -> None: ...
    def create_invite(self, bot_name: str | None, key: bytearray) -> str: ...


def clear(value: bytearray) -> None:
    for index in range(len(value)):
        value[index] = 0
    del value[:]


def validate_api_key(value: bytearray) -> None:
    if len(value) > MAX_API_KEY_BYTES or API_KEY.fullmatch(value) is None:
        raise ConnectRefused("adapter did not return a Stalwart API key")


class JoinPending(ConnectRefused):
    pass


class MailRefused(ConnectRefused):
    RESEND = {
        "cli": "Send it with: printf '%s' \"your reply\" | qd --config CONFIG chat --resend-id ID",
        "mcp": "Send it with the qd_chat tool (text, resend_id).",
    }
    FLAG = {
        "cli": "Deliberate plain mail to captain: add --mail-to-captain.",
        "mcp": "Deliberate plain mail to captain: set mail_to_captain to true.",
    }

    def __init__(self, bot: str | None = None, *, empty_chat: bool = False) -> None:
        super().__init__("mail to captain refused")
        self.bot = bot if bot is not None else "<bot>"
        self.empty_chat = empty_chat

    def text(self, surface: str) -> str:
        if self.empty_chat:
            return "qd: refused: chat text is empty."
        shape = json.dumps(
            {"qd": CHAT_SCHEMA, "bot": self.bot, "text": "your reply"},
            separators=(",", ":"),
        )
        return "\n".join(
            [
                "qd: refused: mail to captain must be a chat message, or he never sees it.",
                self.RESEND[surface],
                f'That sends subject "CHAT: {self.bot}" and body {shape}.',
                f'Recipe: "Reply to the Captain" in the Quarterdeck README. {self.FLAG[surface]}',
            ]
        )


def _no_constant(name: str) -> None:
    raise ValueError(name)


def is_chat_message(bot: str, subject: Any, body: Any) -> bool:
    if subject != f"CHAT: {bot}" or not isinstance(body, str):
        return False
    try:
        document = json.loads(body, parse_constant=_no_constant)
    except (ValueError, RecursionError):
        return False
    if not isinstance(document, dict):
        return False
    text = document.get("text")
    return (
        document.get("qd") == CHAT_SCHEMA
        and document.get("bot") == bot
        and isinstance(text, str)
        and text.strip() != ""
    )


@dataclass(slots=True)
class JoinRequest:
    code: str
    bot_name: str
    pairing: bytearray

    def clear(self) -> None:
        clear(self.pairing)


@dataclass(slots=True)
class CollectedOffer:
    approval_id: str
    bot_name: str
    account_id: str
    key_id: str
    nonce: bytes
    deadline: float
    credential: bytearray

    def clear(self) -> None:
        clear(self.credential)


def _https_origin(value: str) -> tuple[str, int]:
    if not isinstance(value, str):
        raise ConnectRefused("join origin is invalid")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in {None, 443}
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ConnectRefused("join origin is invalid")
    return parsed.hostname, parsed.port or 443


class HttpsPostTransport:
    def __init__(self, origin: str) -> None:
        self.host, self.port = _https_origin(origin)

    def post(
        self,
        path: str,
        document: dict[str, Any],
        *,
        bearer: bytearray | None = None,
    ) -> tuple[int, dict[str, str], bytearray]:
        body = bytearray(
            json.dumps(document, separators=(",", ":")).encode("ascii")
        )
        headers: dict[str, str | bytes] = {
            "Content-Type": "application/json",
            "Accept": "application/json, application/vnd.quarterdeck.collect-v1",
        }
        if bearer is not None:
            validate_api_key(bearer)
            headers["Authorization"] = b"Bearer " + bytes(bearer)
        connection = http.client.HTTPSConnection(
            self.host,
            self.port,
            timeout=15,
            context=ssl.create_default_context(),
        )
        try:
            connection.request(
                "POST",
                path,
                body=body,
                headers=headers,
            )
            response = connection.getresponse()
            response_headers: dict[str, str] = {}
            for name, value in response.getheaders():
                lower = name.lower()
                if lower in response_headers:
                    raise ConnectRefused("join response is invalid")
                response_headers[lower] = value
            received = bytearray(response.read(MAX_HTTP_BODY_BYTES + 1))
            if len(received) > MAX_HTTP_BODY_BYTES:
                clear(received)
                raise ConnectRefused("join response is invalid")
            return response.status, response_headers, received
        except ConnectRefused:
            raise
        except Exception as error:
            raise ConnectRefused("join request failed") from error
        finally:
            clear(body)
            connection.close()


class PublicJoinClient:
    def __init__(self, origin: str, *, transport: Any | None = None) -> None:
        _https_origin(origin)
        self.transport = (
            transport if transport is not None else HttpsPostTransport(origin)
        )

    @staticmethod
    def _response(
        value: object,
    ) -> tuple[int, dict[str, str], bytearray]:
        if (
            not isinstance(value, tuple)
            or len(value) != 3
            or not isinstance(value[0], int)
            or isinstance(value[0], bool)
            or not isinstance(value[1], dict)
            or any(
                not isinstance(name, str) or not isinstance(item, str)
                for name, item in value[1].items()
            )
            or not isinstance(value[2], bytearray)
            or len(value[2]) > MAX_HTTP_BODY_BYTES
        ):
            if isinstance(value, tuple) and len(value) == 3 and isinstance(value[2], bytearray):
                clear(value[2])
            raise ConnectRefused("join response is invalid")
        headers = {name.lower(): item for name, item in value[1].items()}
        if headers.get("cache-control") != "no-store":
            clear(value[2])
            raise ConnectRefused("join response is invalid")
        return value[0], headers, value[2]

    def _post(
        self,
        path: str,
        document: dict[str, Any],
        *,
        bearer: bytearray | None = None,
    ) -> tuple[int, dict[str, str], bytearray]:
        try:
            if bearer is None:
                result = self.transport.post(path, document)
            else:
                result = self.transport.post(path, document, bearer=bearer)
            return self._response(result)
        except ConnectRefused:
            raise
        except Exception as error:
            raise ConnectRefused("join request failed") from error

    @staticmethod
    def _json(body: bytearray) -> dict[str, Any]:
        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ConnectRefused("join response is invalid") from None
        if not isinstance(value, dict):
            raise ConnectRefused("join response is invalid")
        return value

    @staticmethod
    def _decoded(value: object, size: int) -> bytearray:
        if not isinstance(value, str) or len(value) > 1024:
            raise ConnectRefused("join response is invalid")
        try:
            decoded = bytearray(base64.b64decode(value, validate=True))
        except (ValueError, TypeError):
            raise ConnectRefused("join response is invalid") from None
        if len(decoded) != size:
            clear(decoded)
            raise ConnectRefused("join response is invalid")
        return decoded

    def request(
        self,
        bot_name: str,
        description: str,
        invite: bytearray,
    ) -> JoinRequest:
        body = bytearray()
        pairing = bytearray()
        try:
            if not isinstance(invite, bytearray) or INVITE.fullmatch(invite) is None:
                raise ConnectRefused("join invite is invalid")
            status, headers, body = self._post(
                REQUEST_PATH,
                {
                    "invite": invite.decode("ascii"),
                    "bot": bot_name,
                    "description": description,
                },
            )
            if (
                status != 200
                or headers.get("content-type") != "application/json"
            ):
                raise ConnectRefused("join request was refused")
            document = self._json(body)
            if set(document) != {"code", "bot", "pairing"}:
                raise ConnectRefused("join response is invalid")
            code = document["code"]
            bot = document["bot"]
            if (
                not isinstance(code, str)
                or CODE.fullmatch(code) is None
                or bot != bot_name
                or not isinstance(bot, str)
                or BOT_NAME.fullmatch(bot) is None
            ):
                raise ConnectRefused("join response is invalid")
            pairing = self._decoded(document["pairing"], 32)
            result = JoinRequest(code, bot, pairing)
            pairing = bytearray()
            return result
        finally:
            clear(invite)
            clear(pairing)
            clear(body)

    def create_invite(
        self,
        bot_name: str | None,
        key: bytearray,
    ) -> str:
        body = bytearray()
        try:
            if bot_name is not None and (
                not isinstance(bot_name, str)
                or BOT_NAME.fullmatch(bot_name) is None
            ):
                raise ConnectRefused("invite target is invalid")
            validate_api_key(key)
            document = {} if bot_name is None else {"botName": bot_name}
            status, headers, body = self._post(
                "/qd/invite",
                document,
                bearer=key,
            )
            if (
                status != 200
                or headers.get("content-type") != "application/json"
            ):
                raise ConnectRefused("invite request was refused")
            response = self._json(body)
            if (
                set(response) != {"prompt"}
                or not isinstance(response["prompt"], str)
                or not 1 <= len(response["prompt"]) <= MAX_HTTP_BODY_BYTES
            ):
                raise ConnectRefused("invite response is invalid")
            return response["prompt"]
        finally:
            clear(key)
            clear(body)

    def collect(self, request: JoinRequest) -> CollectedOffer:
        status, headers, body = self._post(
            COLLECT_PATH,
            {
                "phase": "collect",
                "code": request.code,
                "bot": request.bot_name,
                "pairing": base64.b64encode(request.pairing).decode("ascii"),
            },
        )
        nonce = bytearray()
        credential = bytearray()
        header = bytearray()
        try:
            if status == 403:
                raise JoinPending("join approval is pending")
            if (
                status != 200
                or headers.get("content-type")
                != "application/vnd.quarterdeck.collect-v1"
                or body.count(b"\n") != 1
            ):
                raise ConnectRefused("join collection was refused")
            newline = body.find(b"\n")
            header.extend(body[:newline])
            credential.extend(body[newline + 1 :])
            document = self._json(header)
            if set(document) != {
                "code",
                "bot",
                "accountId",
                "keyId",
                "nonce",
                "deadline",
                "credentialBytes",
            }:
                raise ConnectRefused("join response is invalid")
            if (
                document["code"] != request.code
                or document["bot"] != request.bot_name
                or not isinstance(document["accountId"], str)
                or not document["accountId"]
                or not isinstance(document["keyId"], str)
                or not document["keyId"]
                or not isinstance(document["deadline"], (int, float))
                or isinstance(document["deadline"], bool)
                or not isinstance(document["credentialBytes"], int)
                or isinstance(document["credentialBytes"], bool)
                or document["credentialBytes"] != len(credential)
            ):
                raise ConnectRefused("join response is invalid")
            validate_api_key(credential)
            nonce = self._decoded(document["nonce"], 32)
            result = CollectedOffer(
                request.code,
                request.bot_name,
                document["accountId"],
                document["keyId"],
                bytes(nonce),
                float(document["deadline"]),
                credential,
            )
            credential = bytearray()
            return result
        finally:
            clear(header)
            clear(nonce)
            clear(credential)
            clear(body)

    def confirm(
        self, request: JoinRequest, offer: CollectedOffer, proof: bytearray
    ) -> None:
        status, headers, body = self._post(
            COLLECT_PATH,
            {
                "phase": "confirm",
                "code": request.code,
                "bot": request.bot_name,
                "pairing": base64.b64encode(request.pairing).decode("ascii"),
                "proof": base64.b64encode(proof).decode("ascii"),
            },
        )
        try:
            if status != 200 or headers.get("content-type") != "application/json":
                raise ConnectRefused("join confirmation was refused")
            if self._json(body) != {"ok": True, "bot": request.bot_name}:
                raise ConnectRefused("join response is invalid")
        finally:
            clear(body)


class FileV1Adapter:
    def __init__(
        self,
        executable: str,
        registry: str,
        bot: str,
        entry: str,
    ) -> None:
        if (
            not os.path.isabs(executable)
            or not os.path.isabs(registry)
            or BOT_NAME.fullmatch(bot) is None
            or re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,63}", entry) is None
        ):
            raise ConnectRefused("file-v1 configuration is invalid")
        self.executable = executable
        self.registry = registry
        self.bot_name = bot
        self.entry = entry

    def invocation(self, operation: str) -> tuple[list[str], dict[str, str], str]:
        if operation not in {"save", "read"}:
            raise ConnectRefused("file-v1 operation is invalid")
        return (
            [
                self.executable,
                operation,
                self.registry,
                self.bot_name,
                self.entry,
                "file-v1",
            ],
            {"PATH": "/usr/bin:/usr/sbin", "PYTHONDONTWRITEBYTECODE": "1"},
            "/",
        )

    @staticmethod
    def _wait(process: subprocess.Popen) -> int:
        try:
            return process.wait(timeout=15)
        except subprocess.TimeoutExpired as error:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            raise ConnectRefused("file-v1 timed out") from error

    def save(self, value: bytearray) -> None:
        validate_api_key(value)
        argv, environment, cwd = self.invocation("save")
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            cwd=cwd,
            close_fds=True,
            start_new_session=True,
        )
        try:
            if process.stdin is None:
                raise ConnectRefused("file-v1 did not create a private input pipe")
            offset = 0
            with memoryview(value) as view:
                while offset < len(value):
                    written = os.write(process.stdin.fileno(), view[offset:])
                    if written <= 0:
                        raise ConnectRefused("file-v1 refused the save")
                    offset += written
            process.stdin.close()
            if self._wait(process) != 0:
                raise ConnectRefused("file-v1 refused the save")
        except Exception:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            raise
        finally:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()

    def read(self) -> bytearray:
        argv, environment, cwd = self.invocation("read")
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
            cwd=cwd,
            close_fds=True,
            start_new_session=True,
        )
        key = bytearray(MAX_API_KEY_BYTES + 1)
        size = 0
        try:
            if process.stdout is None:
                raise ConnectRefused("file-v1 did not create a private output pipe")
            with memoryview(key) as view:
                while size <= MAX_API_KEY_BYTES:
                    got = os.readv(process.stdout.fileno(), [view[size:]])
                    if not got:
                        break
                    size += got
            process.stdout.close()
            if self._wait(process) != 0 or size > MAX_API_KEY_BYTES:
                raise ConnectRefused("file-v1 refused the read")
            del key[size:]
            validate_api_key(key)
            return key
        except Exception:
            clear(key)
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            raise
        finally:
            if process.stdout is not None and not process.stdout.closed:
                process.stdout.close()


class ConnectService:
    def __init__(
        self,
        session_url: str,
        adapter: KeyAdapter,
        joiner: Joiner | None,
        transport: Any | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        self.session_url = qd_jmap.check_session_url(session_url)
        self.adapter = adapter
        self.joiner = joiner
        self.transport = transport
        self.clock = clock
        self.sleeper = sleeper

    def join(
        self,
        description: str,
        invite: bytearray,
    ) -> dict[str, Any]:
        started: JoinRequest | None = None
        offer: CollectedOffer | None = None
        readback = bytearray()
        proof = bytearray()
        try:
            bot_name = getattr(self.adapter, "bot_name", None)
            if (
                self.joiner is None
                or not isinstance(bot_name, str)
                or BOT_NAME.fullmatch(bot_name) is None
                or not isinstance(invite, bytearray)
                or INVITE.fullmatch(invite) is None
            ):
                raise ConnectRefused("join route is not configured")
            started = self.joiner.request(bot_name, description, invite)
            if (
                not isinstance(started, JoinRequest)
                or started.bot_name != bot_name
                or CODE.fullmatch(started.code) is None
                or not isinstance(started.pairing, bytearray)
                or len(started.pairing) != 32
            ):
                raise ConnectRefused("join route returned an invalid result")
            deadline = self.clock() + 600
            while True:
                try:
                    offer = self.joiner.collect(started)
                    break
                except JoinPending:
                    remaining = deadline - self.clock()
                    if remaining <= 0:
                        raise ConnectRefused("join approval timed out") from None
                    self.sleeper(min(16, remaining))
            if (
                not isinstance(offer, CollectedOffer)
                or offer.approval_id != started.code
                or offer.bot_name != bot_name
                or not isinstance(offer.credential, bytearray)
            ):
                raise ConnectRefused("join route returned an invalid result")
            validate_api_key(offer.credential)
            self.adapter.save(offer.credential)
            readback = self.adapter.read()
            if not isinstance(readback, bytearray):
                raise ConnectRefused("adapter did not return a mutable Stalwart API key")
            validate_api_key(readback)
            if not hmac.compare_digest(readback, offer.credential):
                raise ConnectRefused("adapter readback did not match the saved key")
            proof.extend(
                confirmation_mac(
                    readback,
                    offer.nonce,
                    offer.approval_id,
                    offer.account_id,
                    offer.key_id,
                )
            )
            self.joiner.confirm(started, offer, proof)
            return {"code": started.code, "bot": bot_name, "status": "active"}
        finally:
            clear(invite)
            clear(readback)
            clear(proof)
            if offer is not None:
                offer.clear()
            if started is not None:
                started.clear()

    def create_invite(self, bot_name: str | None = None) -> str:
        if self.joiner is None:
            raise ConnectRefused("invite route is not configured")
        key = self.adapter.read()
        try:
            if not isinstance(key, bytearray):
                raise ConnectRefused(
                    "adapter did not return a mutable Stalwart API key"
                )
            validate_api_key(key)
            prompt = self.joiner.create_invite(bot_name, key)
            if not isinstance(prompt, str) or not prompt:
                raise ConnectRefused("invite route returned an invalid result")
            return prompt
        finally:
            if isinstance(key, bytearray):
                clear(key)

    def _mail(self, operation):
        key = self.adapter.read()
        credential = None
        try:
            if not isinstance(key, bytearray):
                raise ConnectRefused("adapter did not return a mutable Stalwart API key")
            validate_api_key(key)
            credential = qd_jmap.Credential(key)
            jmap = qd_jmap.Jmap(
                self.session_url,
                credential,
                self.transport if self.transport is not None else qd_jmap.HttpTransport(),
            )
            mailbox = qd_jmap.Mailbox(jmap)
            return operation(mailbox)
        finally:
            if credential is not None:
                credential.clear()
            elif isinstance(key, bytearray):
                clear(key)

    def _own_bot(self) -> str | None:
        bot = getattr(self.adapter, "bot_name", None)
        if isinstance(bot, str) and BOT_NAME.fullmatch(bot) is not None:
            return bot
        return None

    def send(
        self,
        recipient: str,
        subject: str,
        body: str,
        resend_id: str,
        *,
        mail_to_captain: bool = False,
    ) -> str:
        if recipient == CAPTAIN and mail_to_captain is not True:
            bot = self._own_bot()
            if bot is None or not is_chat_message(bot, subject, body):
                raise MailRefused(bot)
        return self._mail(lambda mailbox: mailbox.send(recipient, subject, body, resend_id))

    def chat(self, text: str, resend_id: str) -> str:
        bot = self._own_bot()
        if bot is None:
            raise MailRefused()
        text = text.rstrip()
        if not text:
            raise MailRefused(bot, empty_chat=True)
        body = json.dumps({"qd": CHAT_SCHEMA, "bot": bot, "text": text}, ensure_ascii=False)
        return self.send(CAPTAIN, f"CHAT: {bot}", body, resend_id)

    def wait(self, after: str | None, timeout: float | None) -> list[dict[str, Any]]:
        return self._mail(lambda mailbox: qd_jmap.wait(mailbox, after, timeout))

    def ack(self, message_id: str) -> None:
        self._mail(lambda mailbox: mailbox.ack(message_id))


def _read_private_config(path: Path) -> bytes:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
    except OSError as error:
        raise ConnectRefused("connect configuration is invalid") from error
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.geteuid()
            or stat.S_IMODE(details.st_mode) & 0o077
            or details.st_nlink != 1
        ):
            raise ConnectRefused("connect configuration is invalid")
        content = bytearray()
        while len(content) <= MAX_CONFIG_BYTES:
            chunk = os.read(
                descriptor,
                min(8192, MAX_CONFIG_BYTES + 1 - len(content)),
            )
            if not chunk:
                break
            content.extend(chunk)
    except OSError as error:
        raise ConnectRefused("connect configuration is invalid") from error
    finally:
        os.close(descriptor)
    if len(content) > MAX_CONFIG_BYTES:
        raise ConnectRefused("connect configuration is invalid")
    return bytes(content)


def load_config(path: str | os.PathLike[str]) -> dict[str, Any]:
    try:
        document = json.loads(_read_private_config(Path(path)))
    except (UnicodeDecodeError, ValueError) as error:
        raise ConnectRefused("connect configuration is invalid") from error
    if (
        not isinstance(document, dict)
        or set(document) != {"format", "session", "join", "adapter"}
        or document.get("format") != 1
        or not isinstance(document.get("session"), str)
        or not isinstance(document.get("join"), str)
    ):
        raise ConnectRefused("connect configuration is invalid")
    adapter = document.get("adapter")
    if (
        not isinstance(adapter, dict)
        or set(adapter) != {"name", "executable", "registry", "bot", "entry"}
        or adapter.get("name") != "file-v1"
        or any(not isinstance(value, str) for value in adapter.values())
    ):
        raise ConnectRefused("connect adapter configuration is invalid")
    qd_jmap.check_session_url(document["session"])
    PublicJoinClient(document["join"])
    FileV1Adapter(
        adapter["executable"],
        adapter["registry"],
        adapter["bot"],
        adapter["entry"],
    )
    return document


def service_from_config(
    path: str | os.PathLike[str],
    *,
    joiner: Joiner | None = None,
    transport: Any | None = None,
) -> ConnectService:
    document = load_config(path)
    adapter = document["adapter"]
    return ConnectService(
        document["session"],
        FileV1Adapter(
            adapter["executable"],
            adapter["registry"],
            adapter["bot"],
            adapter["entry"],
        ),
        joiner if joiner is not None else PublicJoinClient(document["join"]),
        transport,
    )
