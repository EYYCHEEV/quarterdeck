from __future__ import annotations

import json
import math
import socket
from dataclasses import dataclass
from typing import Any, Callable

import application
import approval_app
import approval_security


MAX_REPLY_BYTES = 8192


@dataclass(frozen=True, slots=True, repr=False)
class SessionGrant:
    csrf: str
    fresh_until: float = 0.0


class ApprovalAuthClient:
    def __init__(self, socket_path: str) -> None:
        if not isinstance(socket_path, str) or not socket_path.startswith("/"):
            raise approval_security.ApprovalRefused(
                "Captain auth socket path is invalid"
            )
        self.socket_path = socket_path

    def __call__(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = json.dumps(
            payload,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        if len(request) > MAX_REPLY_BYTES:
            raise approval_security.ApprovalRefused(
                "Captain auth request is too large"
            )
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(self.socket_path)
                client.sendall(request)
                answer = bytearray()
                while len(answer) <= MAX_REPLY_BYTES:
                    chunk = client.recv(
                        min(4096, MAX_REPLY_BYTES + 1 - len(answer))
                    )
                    if not chunk:
                        break
                    answer.extend(chunk)
        except OSError:
            raise approval_security.ApprovalRefused(
                "Captain auth service is unavailable"
            ) from None
        try:
            if len(answer) > MAX_REPLY_BYTES or not answer.endswith(b"\n"):
                raise ValueError
            document = json.loads(answer)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise approval_security.ApprovalRefused(
                "Captain auth response is invalid"
            ) from None
        finally:
            answer[:] = b"\x00" * len(answer)
            answer.clear()
        if (
            not isinstance(document, dict)
            or set(document) != {"ok", "csrf", "freshUntil", "freshRequired"}
            or not isinstance(document.get("ok"), bool)
            or not isinstance(document.get("csrf"), str)
            or not isinstance(document.get("freshRequired"), bool)
            or isinstance(document.get("freshUntil"), bool)
            or not isinstance(document.get("freshUntil"), (int, float))
            or not math.isfinite(document["freshUntil"])
            or document["freshUntil"] < 0
        ):
            raise approval_security.ApprovalRefused("Captain auth response is invalid")
        if document["ok"] is False:
            if document["csrf"] or document["freshUntil"] != 0:
                raise approval_security.ApprovalRefused("Captain auth response is invalid")
            if document["freshRequired"]:
                raise approval_security.FreshSignInRequired("Fresh sign-in is required")
            raise application.SessionRefused("Captain auth session was refused")
        if document["freshRequired"]:
            raise approval_security.ApprovalRefused("Captain auth response is invalid")
        return document


class SocketApprovalGate:
    def __init__(
        self,
        transport: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> None:
        self.transport = transport

    @staticmethod
    def _cookie(request: approval_app.Request) -> str:
        token = approval_app.ApprovalApplication._cookie(
            request,
            "__Host-qd-approval",
        )
        if token is None:
            raise application.SessionRefused(
                "approval session required"
            )
        return token

    @staticmethod
    def _request_facts(request: approval_app.Request) -> dict[str, Any]:
        return {
            "method": request.method,
            "path": request.path,
            "headers": {
                name: value
                for name, value in request.headers.items()
                if name.lower()
                in {
                    "origin",
                    "x-forwarded-for",
                    "x-forwarded-host",
                    "x-forwarded-proto",
                    "sec-fetch-dest",
                    "if-none-match",
                }
            },
            "peer": request.peer,
        }

    def authenticate(self, request: approval_app.Request) -> SessionGrant:
        answer = self.transport(
            {
                "operation": "authenticate",
                "session": self._cookie(request),
                "request": self._request_facts(request),
            }
        )
        return SessionGrant(answer["csrf"], answer["freshUntil"])

    def authorize_post(
        self,
        request: approval_app.Request,
        csrf: str,
    ) -> SessionGrant:
        answer = self.transport(
            {
                "operation": "authorize-post",
                "session": self._cookie(request),
                "csrf": csrf,
                "request": self._request_facts(request),
            }
        )
        return SessionGrant(answer["csrf"], answer["freshUntil"])

    @staticmethod
    def issue_csrf(grant: SessionGrant) -> str:
        if not isinstance(grant, SessionGrant):
            raise approval_security.ApprovalRefused(
                "Captain auth grant is invalid"
            )
        return grant.csrf

    @staticmethod
    def fresh_until(grant: SessionGrant) -> float:
        if not isinstance(grant, SessionGrant):
            raise approval_security.ApprovalRefused("Captain auth grant is invalid")
        return grant.fresh_until
