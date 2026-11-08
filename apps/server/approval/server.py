from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import approval_app
import captain_auth
import captain_auth_socket
import approval_security
import approval_service
import chat_bots
import oidc
import invite_prompt


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    bind_address: str
    bind_port: int
    oidc_path: str
    state_path: str
    socket_path: str
    captain_auth_socket_path: str
    captain_auth_peer_uid: int
    captain_auth_socket_mode: int
    captain_auth_socket_gid: int
    trusted_proxy: str
    public_origin: str
    release_artifact_url: str | None
    release_version: str | None
    release_sha256: str | None
    chat_bots_copy_folder: str | None = None
    oidc_redirect_uri: str | None = None


RUNTIME_KEYS = frozenset(
    {
        "format",
        "bind",
        "paths",
        "captainAuth",
        "trustedProxy",
        "publicOrigin",
        "release",
    }
)
COPY_FOLDER_KEY = "chatBotsCopyFolder"
REDIRECT_KEY = "oidcRedirectUri"
ORIGIN_PIN_ENVIRONMENT = "QD_ORIGIN_PIN"


def _absolute_path(value: object) -> bool:
    return (
        isinstance(value, str) and "\0" not in value and os.path.isabs(value)
    )


def load_runtime_config(path: str | os.PathLike[str]) -> RuntimeConfig:
    pinned_origin = os.environ.get(ORIGIN_PIN_ENVIRONMENT)
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise approval_security.ApprovalRefused(
            "approval runtime configuration is invalid"
        ) from None
    if (
        not isinstance(document, dict)
        or not RUNTIME_KEYS <= set(document) <= RUNTIME_KEYS | {COPY_FOLDER_KEY, REDIRECT_KEY}
        or document.get("format") != 1
        or not isinstance(document.get("bind"), dict)
        or set(document["bind"]) != {"address", "port"}
        or not isinstance(document.get("paths"), dict)
        or set(document["paths"])
        != {"oidc", "state", "socket", "captainAuthSocket"}
        or not isinstance(document.get("captainAuth"), dict)
        or set(document["captainAuth"])
        != {"peerUid", "socketMode", "socketGid"}
        or not isinstance(document.get("release"), dict)
        or set(document["release"])
        != {"artifactUrl", "version", "sha256"}
    ):
        raise approval_security.ApprovalRefused(
            "approval runtime configuration is invalid"
        )
    values = (
        document["bind"]["address"],
        document["paths"]["oidc"],
        document["paths"]["state"],
        document["paths"]["socket"],
        document["paths"]["captainAuthSocket"],
        document["trustedProxy"],
        document["publicOrigin"],
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
    port = document["bind"]["port"]
    captain_auth_access = document["captainAuth"]
    try:
        captain_auth_mode = int(captain_auth_access["socketMode"], 8)
    except (TypeError, ValueError):
        raise approval_security.ApprovalRefused(
            "approval runtime configuration is invalid"
        ) from None
    if (
        any(
            not isinstance(value, str)
            or not value
            or "\0" in value
            for value in values
        )
        or not (release_is_unpublished or release_is_pinned)
        or (
            REDIRECT_KEY in document
            and (
                pinned_origin is None
                or document["publicOrigin"] != pinned_origin
                or document["oidcRedirectUri"]
                != pinned_origin + "/captain/oidc/callback"
            )
        )
        or not isinstance(port, int)
        or isinstance(port, bool)
        or not 1 <= port <= 65535
        or not isinstance(captain_auth_access["peerUid"], int)
        or isinstance(captain_auth_access["peerUid"], bool)
        or not 0 <= captain_auth_access["peerUid"] <= 2_147_483_647
        or captain_auth_mode != captain_auth_socket.SOCKET_MODE
        or not isinstance(captain_auth_access["socketGid"], int)
        or isinstance(captain_auth_access["socketGid"], bool)
        or not 0 <= captain_auth_access["socketGid"] <= 2_147_483_647
        or (
            COPY_FOLDER_KEY in document
            and not _absolute_path(document[COPY_FOLDER_KEY])
        )
    ):
        raise approval_security.ApprovalRefused(
            "approval runtime configuration is invalid"
        )
    return RuntimeConfig(
        values[0],
        port,
        values[1],
        values[2],
        values[3],
        values[4],
        captain_auth_access["peerUid"],
        captain_auth_mode,
        captain_auth_access["socketGid"],
        values[5],
        values[6],
        release_values[0],
        release_values[1],
        release_values[2],
        document.get(COPY_FOLDER_KEY),
        document.get(REDIRECT_KEY),
    )


class ApprovalSocketBackend:
    def __init__(
        self,
        socket_path: str | os.PathLike[str],
        chat_bots_folder: str | os.PathLike[str] | None = None,
        chat_bots_copy_folder: str | os.PathLike[str] | None = None,
    ) -> None:
        self.socket_path = os.fspath(socket_path)
        self.publisher = (
            None
            if chat_bots_folder is None
            else chat_bots.ChatBotsPublisher(
                chat_bots_folder,
                self.bots,
                copy_folder=chat_bots_copy_folder,
            )
        )

    def bots(self) -> list[str] | None:
        return approval_service.request_bots(self.socket_path)

    def pending(self) -> list[dict[str, str | float]]:
        pending = approval_service.request_pending(self.socket_path)
        if pending is None:
            raise approval_security.ApprovalRefused(
                "approval backend request refused"
            )
        return pending

    def invites(self) -> list[dict[str, str | float | None]]:
        invites = approval_service.request_invites(self.socket_path)
        if invites is None:
            raise approval_security.ApprovalRefused(
                "approval backend request refused"
            )
        return invites

    def create_invite(
        self, bot_name: str | None
    ) -> dict[str, str | float | None]:
        invite = approval_service.request_invite_creation(
            self.socket_path, bot_name
        )
        if invite is None:
            raise approval_security.ApprovalRefused(
                "approval backend request refused"
            )
        return invite

    def cancel_invite(self, invite_id: str) -> bool:
        if not approval_service.request_invite_cancellation(
            self.socket_path, invite_id
        ):
            raise approval_security.ApprovalRefused(
                "approval backend request refused"
            )
        return True

    def approve(self, code: str) -> bool:
        if not approval_service.request_approval(self.socket_path, code):
            raise approval_security.ApprovalRefused(
                "approval backend request refused"
            )
        if self.publisher is not None:
            self.publisher.publish()
        return True

    def refuse(self, code: str) -> bool:
        if not approval_service.request_refusal(self.socket_path, code):
            raise approval_security.ApprovalRefused(
                "approval backend request refused"
            )
        return True


class Handler(BaseHTTPRequestHandler):
    application: approval_app.ApprovalApplication

    def log_message(self, format, *args):
        return

    def _body(self) -> bytearray:
        transfer_encoding = self.headers.get("Transfer-Encoding")
        lengths = self.headers.get_all("Content-Length", [])
        if transfer_encoding is not None or len(lengths) > 1:
            raise ValueError("request framing is refused")
        raw_length = lengths[0] if lengths else "0"
        if not raw_length.isascii() or not raw_length.isdigit():
            raise ValueError("content length is invalid")
        length = int(raw_length)
        if length > approval_app.MAX_BODY_BYTES:
            raise ValueError("request body is too large")
        self.connection.settimeout(5.0)
        body = bytearray(length)
        offset = 0
        with memoryview(body) as view:
            while offset < length:
                amount = self.rfile.readinto(view[offset:])
                if not amount:
                    approval_security.clear(body)
                    raise ValueError("request body ended early")
                offset += amount
        return body

    def _handle(self) -> None:
        body = bytearray()
        try:
            body = self._body()
            request = approval_app.Request(
                self.command,
                self.path,
                {name: value for name, value in self.headers.items()},
                body,
                self.client_address[0],
            )
            response = self.application.handle(request)
        except Exception:
            body[:] = b"\x00" * len(body)
            body.clear()
            headers = approval_app.ApprovalApplication._security_headers(
                "text/plain; charset=utf-8"
            )
            headers.append(("Content-Length", "0"))
            response = approval_app.Response(400, tuple(headers), b"")
        self.send_response_only(response.status)
        for name, value in response.headers:
            self.send_header(name, value)
        self.end_headers()
        if response.body:
            self.wfile.write(response.body)

    do_GET = _handle
    do_POST = _handle


def handler_for(application: approval_app.ApprovalApplication) -> type[Handler]:
    return type("BoundApprovalHandler", (Handler,), {"application": application})


def serve(
    application: approval_app.ApprovalApplication,
    auth_service: captain_auth_socket.CaptainAuthSocketService,
    bind_address: str,
    bind_port: int,
    publisher: chat_bots.ChatBotsPublisher | None = None,
) -> None:
    server = ThreadingHTTPServer(
        (bind_address, bind_port), handler_for(application)
    )
    server.daemon_threads = True
    if publisher is not None:
        publisher.publish()
    auth_service.start()
    try:
        if publisher is not None:
            publisher.start()
        server.serve_forever(poll_interval=0.5)
    finally:
        if publisher is not None:
            publisher.stop()
        server.server_close()
        auth_service.close()


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "--config":
        return 2
    oidc_config: oidc.OidcConfig | None = None
    provider: oidc.GoogleOidc | None = None
    try:
        runtime = load_runtime_config(sys.argv[2])
        oidc_config = oidc.load_config(runtime.oidc_path)
        state = approval_security.ApprovalState(
            runtime.state_path, bytes(oidc_config.session_key)
        )
        provider = oidc.GoogleOidc(
            client_id=oidc_config.client_id,
            client_secret=bytearray(oidc_config.client_secret),
            allowed_email=oidc_config.allowed_email,
            redirect_uri=runtime.oidc_redirect_uri or oidc_config.redirect_uri,
        )
        captain_auth.install(state, provider)
        backend = ApprovalSocketBackend(
            runtime.socket_path,
            Path(runtime.captain_auth_socket_path).parent,
            runtime.chat_bots_copy_folder,
        )
        application = approval_app.ApprovalApplication(
            state,
            captain_auth,
            backend,
            invite_prompt.ReleaseConfig(
                runtime.release_artifact_url,
                runtime.release_version,
                runtime.release_sha256,
                runtime.public_origin,
            ),
            trusted_proxy=runtime.trusted_proxy,
            public_origin=runtime.public_origin,
        )
        auth_service = captain_auth_socket.CaptainAuthSocketService(
            captain_auth,
            application,
            runtime.captain_auth_socket_path,
            expected_uid=runtime.captain_auth_peer_uid,
            socket_mode=runtime.captain_auth_socket_mode,
            socket_gid=runtime.captain_auth_socket_gid,
        )
        serve(
            application,
            auth_service,
            runtime.bind_address,
            runtime.bind_port,
            publisher=backend.publisher,
        )
        return 0
    except Exception:
        return 2
    finally:
        if provider is not None:
            provider.clear()
        if oidc_config is not None:
            oidc_config.clear()


if __name__ == "__main__":
    raise SystemExit(main())
