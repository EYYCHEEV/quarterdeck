from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Protocol
from urllib.parse import urlencode, urlsplit

import approval_app
import approval_security
import cards


MAX_BODY_BYTES = 16_384
CARD_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}")
CHAT_PAGE_PATH = "/captain/chat"


class AuthenticationRequired(RuntimeError):
    pass


class SessionRefused(approval_security.ApprovalRefused):
    pass


class NotFound(RuntimeError):
    pass


class SessionGate(Protocol):
    def authenticate(self, request: approval_app.Request) -> object: ...

    def authorize_post(
        self,
        request: approval_app.Request,
        csrf: str,
    ) -> object: ...

    def issue_csrf(self, owner: object) -> str: ...

    def fresh_until(self, owner: object) -> float: ...


class EventSource(Protocol):
    def events(self, *, after: int) -> Iterator[str]: ...

    def snapshot(self) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class StreamResponse:
    status: int
    headers: tuple[tuple[str, str], ...]
    events: Iterator[str]


def etag_matches(request: approval_app.Request, etag: str) -> bool:
    headers = {
        name.lower(): value
        for name, value in request.headers.items()
    }
    return headers.get("if-none-match") == etag


class ApprovalGate:
    def __init__(self, approval: approval_app.ApprovalApplication) -> None:
        self.approval = approval

    def authenticate(self, request: approval_app.Request) -> bytes:
        self.approval._caller(request)
        token = approval_app.ApprovalApplication._cookie(
            request,
            "__Host-qd-approval",
        )
        if token is None:
            raise AuthenticationRequired("approval session required")
        owner = self.approval.state.authorize_session(token)
        if owner is None:
            raise AuthenticationRequired("approval session required")
        if request.method == "GET" and approval_security.activity_allowed(request.method, request.path, request.headers):
            if not self.approval.state.touch_session(owner):
                raise AuthenticationRequired("approval session required")
        return owner

    def authorize_post(
        self,
        request: approval_app.Request,
        csrf: str,
    ) -> bytes:
        self.approval._origin(request)
        owner = self.authenticate(request)
        if not self.approval.state.consume_csrf(owner, csrf):
            raise approval_security.ApprovalRefused("card csrf is invalid")
        if approval_security.requires_fresh(request.method, request.path) and self.fresh_until(owner) <= self.approval.state.clock():
            raise approval_security.FreshSignInRequired("Fresh sign-in is required")
        if approval_security.activity_allowed(request.method, request.path, request.headers):
            if not self.approval.state.touch_session(owner):
                raise AuthenticationRequired("approval session required")
        return owner

    def issue_csrf(self, owner: bytes) -> str:
        return self.approval.state.issue_csrf(owner)

    def fresh_until(self, owner: bytes) -> float:
        return self.approval.state.fresh_until(owner)


class CardApplication:
    def __init__(
        self,
        sessions: SessionGate,
        service: cards.CardService,
        updates: EventSource,
        *,
        clock: Callable[[], float],
    ) -> None:
        self.sessions = sessions
        self.service = service
        self.updates = updates
        self.clock = clock

    @staticmethod
    def _response(
        status: int,
        payload: dict[str, Any],
        extra_headers: tuple[tuple[str, str], ...] = (),
    ) -> approval_app.Response:
        body = json.dumps(
            payload,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        headers = approval_app.ApprovalApplication._security_headers(
            "application/json; charset=utf-8"
        )
        headers.extend(extra_headers)
        headers.append(("Content-Length", str(len(body))))
        return approval_app.Response(status, tuple(headers), body)

    @staticmethod
    def _json(
        request: approval_app.Request,
        fields: set[str],
        optional: frozenset[str] = frozenset(),
    ) -> dict[str, Any]:
        headers = {
            name.lower(): value
            for name, value in request.headers.items()
        }
        if (
            headers.get("content-type") != "application/json"
            or len(request.body) > MAX_BODY_BYTES
        ):
            raise cards.CardRefused("card request body is invalid")
        try:
            payload = json.loads(bytes(request.body))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise cards.CardRefused("card request body is invalid") from None
        if not isinstance(payload, dict) or not fields <= set(payload) <= fields | optional:
            raise cards.CardRefused("card request fields are invalid")
        return payload

    @staticmethod
    def _sign_in_redirect(location: str) -> approval_app.Response:
        headers = approval_app.ApprovalApplication._security_headers(
            "text/plain; charset=utf-8"
        )
        headers.append(("Location", location))
        headers.append(("Content-Length", "0"))
        return approval_app.Response(303, tuple(headers), b"")

    def _get(
        self,
        request: approval_app.Request,
        path: str,
    ) -> approval_app.Response:
        owner = self.sessions.authenticate(request)
        etag = None
        if path == "/captain/cards":
            payload = self.updates.snapshot()
            encoded = json.dumps(
                payload,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
            etag = f'"{hashlib.sha256(encoded).hexdigest()}"'
            if etag_matches(request, etag):
                response_headers = (
                    *approval_app.ApprovalApplication._security_headers(
                        "application/json; charset=utf-8"
                    ),
                    ("ETag", etag),
                    ("Content-Length", "0"),
                )
                return approval_app.Response(
                    304,
                    response_headers,
                    b"",
                )
        elif path.startswith("/captain/cards/"):
            card_id = path.removeprefix("/captain/cards/")
            if CARD_ID.fullmatch(card_id) is None:
                return self._response(404, {"error": "not found"})
            payload = self.service.card(card_id)
        else:
            return self._response(404, {"error": "not found"})
        payload = dict(payload)
        payload["csrf"] = self.sessions.issue_csrf(owner)
        payload["freshUntil"] = self.sessions.fresh_until(owner)
        extra_headers = (("ETag", etag),) if etag is not None else ()
        return self._response(200, payload, extra_headers)


    def _post(
        self,
        request: approval_app.Request,
        path: str,
    ) -> approval_app.Response:
        answer = re.fullmatch(
            r"/captain/cards/([A-Za-z0-9][A-Za-z0-9-]{0,63})/answer",
            path,
        )
        comment = re.fullmatch(
            r"/captain/cards/([A-Za-z0-9][A-Za-z0-9-]{0,63})/comments",
            path,
        )
        if answer is not None:
            payload = self._json(
                request,
                {"rev", "pick", "note", "csrf"},
            )
        else:
            payload = self._json(
                request,
                {"text", "requestId", "csrf"},
            )
        csrf = payload["csrf"]
        if not isinstance(csrf, str):
            raise cards.CardRefused("card csrf is invalid")
        owner = self.sessions.authorize_post(request, csrf)
        if answer is not None:
            result = self.service.answer(
                answer.group(1),
                payload["rev"],
                payload["pick"],
                payload["note"],
                now=datetime.fromtimestamp(self.clock(), timezone.utc),
            )
        elif comment is not None:
            self.service.comment(
                comment.group(1),
                payload["text"],
                payload["requestId"],
            )
            result = {"status": "sent"}
        else:
            raise cards.CardRefused("card route is invalid")
        result = dict(result)
        result["csrf"] = self.sessions.issue_csrf(owner)
        result["freshUntil"] = self.sessions.fresh_until(owner)
        return self._response(200, result)


    def open_events(
        self,
        request: approval_app.Request,
        *,
        last_event_id: str | None,
    ) -> StreamResponse:
        if (
            request.method != "GET"
            or request.path != "/captain/events"
        ):
            raise cards.CardRefused("event request is invalid")
        self.sessions.authenticate(request)
        if last_event_id in {None, ""}:
            after = 0
        elif (
            not isinstance(last_event_id, str)
            or not last_event_id.isascii()
            or not last_event_id.isdigit()
        ):
            raise cards.CardRefused("event cursor is invalid")
        else:
            after = int(last_event_id)
        headers = approval_app.ApprovalApplication._security_headers(
            "text/event-stream; charset=utf-8"
        )
        headers.extend(
            [
                ("Connection", "keep-alive"),
                ("X-Accel-Buffering", "no"),
            ]
        )
        return StreamResponse(
            200,
            tuple(headers),
            self.updates.events(after=after),
        )

    @staticmethod
    def _failure(error: Exception) -> approval_app.Response:
        if isinstance(error, AuthenticationRequired):
            return CardApplication._response(401, {"error": "sign in required"})
        if isinstance(error, NotFound):
            return CardApplication._response(404, {"error": "not found"})
        if isinstance(error, approval_security.ApprovalRateLimited):
            return CardApplication._response(429, {"error": "request refused"})
        if isinstance(error, approval_security.FreshSignInRequired):
            return CardApplication._sign_in_redirect(approval_security.STEP_UP_PATH + "?" + urlencode({"next": CHAT_PAGE_PATH}))
        if isinstance(error, approval_security.ApprovalRefused):
            return CardApplication._response(403, {"error": "request refused"})
        if isinstance(error, cards.CardRefused):
            return CardApplication._response(400, {"error": "request refused"})
        return CardApplication._response(503, {"error": "request unavailable"})

    def handle(self, request: approval_app.Request) -> approval_app.Response:
        try:
            parsed = urlsplit(request.path)
            if parsed.scheme or parsed.netloc or parsed.fragment:
                return self._response(404, {"error": "not found"})
            if parsed.query:
                raise cards.CardRefused("card query is invalid")
            if request.method == "GET":
                return self._get(request, parsed.path)
            if request.method == "POST":
                return self._post(request, parsed.path)
            return self._response(405, {"error": "method not allowed"})
        except Exception as error:
            return self._failure(error)
        finally:
            approval_security.clear(request.body)
