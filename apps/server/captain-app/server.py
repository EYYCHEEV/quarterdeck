from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import approval_app
import approval_security

import application
import auth_bridge
import cards
import chat_bot_list
import checker_adapter
import live
import mail_gateway


RUNTIME_KEYS = frozenset(
    {
        "format",
        "bindPort",
        "jmapSessionUrl",
        "keyPath",
        "keyReadbackPath",
        "registryPath",
        "authSocket",
    }
)
CHAT_BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
MAX_CHAT_BOTS = 16
MAX_CHAT_NOTE = 200


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    port: int
    session_url: str
    key_path: str
    readback_path: str
    registry_path: str
    auth_socket: str
    chat_bots: tuple[tuple[str, str | None], ...] = ()


def _chat_bots(value: object) -> tuple[tuple[str, str | None], ...]:
    if not isinstance(value, list) or len(value) > MAX_CHAT_BOTS:
        raise RuntimeError("Captain runtime configuration is invalid")
    bots: list[tuple[str, str | None]] = []
    for entry in value:
        if not isinstance(entry, dict) or not {"name"} <= set(entry) <= {"name", "note"}:
            raise RuntimeError("Captain runtime configuration is invalid")
        name = entry["name"]
        note = entry.get("note")
        if (
            not isinstance(name, str)
            or CHAT_BOT_NAME.fullmatch(name) is None
            or (
                "note" in entry
                and (not isinstance(note, str) or len(note) > MAX_CHAT_NOTE)
            )
        ):
            raise RuntimeError("Captain runtime configuration is invalid")
        bots.append((name, note))
    if len({name for name, _ in bots}) != len(bots):
        raise RuntimeError("Captain runtime configuration is invalid")
    return tuple(bots)


def load_runtime_config(path: str | os.PathLike[str]) -> RuntimeConfig:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("Captain runtime configuration is invalid") from None
    if (
        not isinstance(document, dict)
        or not RUNTIME_KEYS <= set(document) <= RUNTIME_KEYS | {"chatBots"}
        or document.get("format") != 1
        or document.get("bindPort") != 8080
    ):
        raise RuntimeError("Captain runtime configuration is invalid")
    values = [
        document["jmapSessionUrl"],
        document["keyPath"],
        document["keyReadbackPath"],
        document["registryPath"],
        document["authSocket"],
    ]
    if (
        any(
            not isinstance(value, str)
            or not value
            or "\0" in value
            for value in values
        )
        or not all(value.startswith("/") for value in values[1:])
    ):
        raise RuntimeError("Captain runtime configuration is invalid")
    chat_bots = _chat_bots(document["chatBots"]) if "chatBots" in document else ()
    return RuntimeConfig(8080, *values, chat_bots)


def _load_object(path: str) -> dict[str, Any]:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("Captain runtime input is invalid") from None
    if not isinstance(document, dict):
        raise RuntimeError("Captain runtime input is invalid")
    return document


class Handler(BaseHTTPRequestHandler):
    application: application.CardApplication

    def log_message(self, format, *args):
        return

    def _body(self) -> bytearray:
        transfer = self.headers.get("Transfer-Encoding")
        lengths = self.headers.get_all("Content-Length", [])
        if transfer is not None or len(lengths) > 1:
            raise ValueError("request framing is refused")
        raw = lengths[0] if lengths else "0"
        if not raw.isascii() or not raw.isdigit():
            raise ValueError("content length is invalid")
        length = int(raw)
        if length > application.MAX_BODY_BYTES:
            raise ValueError("request body is too large")
        self.connection.settimeout(5)
        body = bytearray(length)
        offset = 0
        with memoryview(body) as view:
            while offset < length:
                amount = self.rfile.readinto(view[offset:])
                if not amount:
                    body[:] = b"\x00" * len(body)
                    body.clear()
                    raise ValueError("request body ended early")
                offset += amount
        return body

    def _request(self, body: bytearray) -> approval_app.Request:
        return approval_app.Request(
            self.command,
            self.path,
            {name: value for name, value in self.headers.items()},
            body,
            self.client_address[0],
        )

    def _accepts_gzip(self) -> bool:
        qualities: dict[str, float] = {}
        for entry in self.headers.get("Accept-Encoding", "").split(","):
            name, separator, parameters = entry.strip().partition(";")
            name = name.strip().lower()
            if not name:
                continue
            quality = 1.0
            if separator:
                for parameter in parameters.split(";"):
                    key, equals, value = parameter.strip().partition("=")
                    if equals and key.lower() == "q":
                        try:
                            quality = float(value)
                        except ValueError:
                            quality = 0.0
            if not 0.0 <= quality <= 1.0:
                quality = 0.0
            qualities[name] = quality
        if "gzip" in qualities:
            return qualities["gzip"] > 0
        return qualities.get("*", 0.0) > 0

    def _send(self, response: approval_app.Response) -> None:
        body = response.body
        headers = list(response.headers)
        content_type = next(
            (
                value.lower()
                for name, value in headers
                if name.lower() == "content-type"
            ),
            "",
        )
        if (
            body
            and content_type.startswith("application/json")
            and self._accepts_gzip()
        ):
            body = gzip.compress(body, compresslevel=6, mtime=0)
            vary = [
                token.strip()
                for name, value in headers
                if name.lower() == "vary"
                for token in value.split(",")
                if token.strip()
            ]
            if "accept-encoding" not in {
                token.lower()
                for token in vary
            }:
                vary.append("Accept-Encoding")
            headers = [
                (name, value)
                for name, value in headers
                if name.lower()
                not in {"content-encoding", "content-length", "vary"}
            ]
            headers.extend(
                (
                    ("Content-Encoding", "gzip"),
                    ("Vary", ", ".join(vary)),
                    ("Content-Length", str(len(body))),
                )
            )

        self.send_response_only(response.status)
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _handle_events(self, request: approval_app.Request) -> None:
        try:
            response = self.application.open_events(
                request,
                last_event_id=self.headers.get("Last-Event-ID"),
            )
        except application.AuthenticationRequired:
            failure = application.CardApplication._response(
                401,
                {"error": "sign in required"},
            )
        except approval_security.ApprovalRateLimited:
            failure = application.CardApplication._response(
                429,
                {"error": "request refused"},
            )
        except approval_security.ApprovalRefused:
            failure = application.CardApplication._response(
                403,
                {"error": "request refused"},
            )
        except cards.CardRefused:
            failure = application.CardApplication._response(
                400,
                {"error": "request refused"},
            )
        except Exception:
            failure = application.CardApplication._response(
                503,
                {"error": "request unavailable"},
            )
        else:
            failure = None
        if failure is not None:
            self._send(failure)
            return
        self.send_response_only(response.status)
        for name, value in response.headers:
            self.send_header(name, value)
        self.end_headers()
        try:
            for event in response.events:
                self.wfile.write(event.encode("utf-8"))
                self.wfile.flush()
        except Exception:
            return

    def _handle(self) -> None:
        body = bytearray()
        try:
            body = self._body()
            request = self._request(body)
            if self.command == "GET" and self.path == "/captain/events":
                self._handle_events(request)
                return
            self._send(self.application.handle(request))
        except Exception:
            body[:] = b"\x00" * len(body)
            body.clear()
            self._send(
                application.CardApplication._response(
                    400,
                    {"error": "request refused"},
                )
            )

    do_GET = _handle
    do_POST = _handle


def handler_for(app: application.CardApplication) -> type[Handler]:
    return type("BoundCaptainHandler", (Handler,), {"application": app})


class PrivateServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def serve(
    app: application.CardApplication,
    updates: live.LiveUpdates,
    mailbox: mail_gateway.CaptainMailbox,
    port: int,
) -> None:
    server = PrivateServer(("", port), handler_for(app))
    try:
        updates.start()
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        updates.stop()
        mailbox.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="captain-app")
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    config = load_runtime_config(args.config)
    registry = _load_object(config.registry_path)
    readback = _load_object(config.readback_path)
    checker = checker_adapter.LaneAChecker(registry)
    mailbox = mail_gateway.CaptainMailbox.open(
        config.session_url,
        config.key_path,
        readback,
        account_name=checker.account_name,
        oversight_bot=checker.oversight_bot,
    )
    try:
        service = cards.CardService(
            mailbox,
            checker,
            bot_source=chat_bot_list.ChatBotList(
                os.path.dirname(config.auth_socket)
            ).names,
        )
        updates = live.LiveUpdates(service)
        gate = auth_bridge.SocketApprovalGate(
            auth_bridge.ApprovalAuthClient(config.auth_socket)
        )
        app = application.CardApplication(
            gate,
            service,
            updates,
            clock=time.time,
        )
        serve(app, updates, mailbox, config.port)
    except Exception:
        mailbox.close()
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
