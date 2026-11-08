from __future__ import annotations

import argparse
import gzip
import json
import os
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import approval_app
import approval_security

import application
import auth_bridge
import bot_list
import bundle
import cards
import chat_api
import checker_adapter
import live
import mail_gateway
import mailstate
import mounts
import qd_jmap
import webapp


DEFAULT_BUNDLE_DIR = "/opt/quarterdeck/qd-web/static"
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
OPTIONAL_KEYS = frozenset({"bundleDir", "mailStatePath", "chatBotsPath", "botNames"})


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    port: int
    session_url: str
    key_path: str
    readback_path: str
    registry_path: str
    auth_socket: str
    bundle_dir: str = DEFAULT_BUNDLE_DIR
    mail_state_path: str | None = None
    chat_bots_path: str | None = None
    bot_names: tuple[tuple[str, str], ...] = ()


def load_runtime_config(path: str | os.PathLike[str]) -> RuntimeConfig:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("Captain runtime configuration is invalid") from None
    if (
        not isinstance(document, dict)
        or not RUNTIME_KEYS <= set(document) <= RUNTIME_KEYS | OPTIONAL_KEYS
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
    optional = [
        document.get("bundleDir", DEFAULT_BUNDLE_DIR),
        document.get("mailStatePath", "/"),
        document.get("chatBotsPath", "/"),
    ]
    if (
        any(
            not isinstance(value, str)
            or not value
            or "\0" in value
            for value in values + optional
        )
        or not all(value.startswith("/") for value in values[1:] + optional)
    ):
        raise RuntimeError("Captain runtime configuration is invalid")
    try:
        names = tuple(sorted(cards.check_bot_names(document.get("botNames", {})).items()))
    except ValueError:
        raise RuntimeError("Captain runtime configuration is invalid") from None
    return RuntimeConfig(
        8080,
        *values,
        optional[0],
        document.get("mailStatePath"),
        document.get("chatBotsPath"),
        names,
    )


def _load_object(path: str) -> dict[str, Any]:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("Captain runtime input is invalid") from None
    if not isinstance(document, dict):
        raise RuntimeError("Captain runtime input is invalid")
    return document


class Handler(BaseHTTPRequestHandler):
    application: webapp.QdWeb

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
        except Exception as error:
            self._send(application.CardApplication._failure(error))
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
            if self.application.is_events(request):
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
    do_HEAD = _handle

    def __getattr__(self, name: str):
        if name.startswith("do_"):
            return self._handle
        raise AttributeError(name)


def handler_for(app: webapp.QdWeb) -> type[Handler]:
    return type("BoundCaptainHandler", (Handler,), {"application": app})


class PrivateServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def serve(
    app: webapp.QdWeb,
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


def assemble(
    config: RuntimeConfig,
    *,
    mailbox: mail_gateway.CaptainMailbox,
    checker: Any,
    gate: application.SessionGate,
    state: live.StateReader,
    clock=time.time,
) -> tuple[webapp.QdWeb, live.LiveUpdates]:
    site = bundle.Bundle.load(config.bundle_dir)
    bot_source = (
        None
        if config.chat_bots_path is None
        else bot_list.BotList(config.chat_bots_path)
    )
    service = cards.CardService(
        mailbox,
        checker,
        bot_source=bot_source,
        bot_names=dict(config.bot_names),
    )
    mail = mounts.load_mail(
        mailbox,
        gate,
        clock,
        config.mail_state_path,
        state.token,
    )
    updates = live.LiveUpdates(service, state)
    cards_app = application.CardApplication(
        gate,
        service,
        updates,
        clock=clock,
    )
    chat = chat_api.ChatApi(gate, service, clock=clock)
    return webapp.QdWeb(cards_app, site, mail=mail, chat=chat), updates


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="qd-web")
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    config = load_runtime_config(args.config)
    registry = _load_object(config.registry_path)
    readback = _load_object(config.readback_path)
    checker = checker_adapter.LaneAChecker(registry)
    budget = mailstate.Budget(time.monotonic)
    mailbox = mail_gateway.CaptainMailbox.open(
        config.session_url,
        config.key_path,
        readback,
        account_name=checker.account_name,
        oversight_bot=checker.oversight_bot,
        transport=mailstate.MeteredTransport(qd_jmap.HttpTransport(), budget),
        incremental=True,
        patient=budget.patient,
    )
    try:
        gate = auth_bridge.SocketApprovalGate(
            auth_bridge.ApprovalAuthClient(config.auth_socket)
        )
        app, updates = assemble(
            config,
            mailbox=mailbox,
            checker=checker,
            gate=gate,
            state=mailstate.StateGate(mailbox, budget, time.monotonic),
        )
        serve(app, updates, mailbox, config.port)
    except Exception:
        mailbox.close()
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
