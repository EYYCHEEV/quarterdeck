from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import parse_qs, urlencode, urlsplit

import approval_app
import approval_security
import cards


MAX_BODY_BYTES = 16_384
CARD_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,63}")
CHAT_PATH = "/captain/api/chat"
CHATS_PATH = "/captain/api/chats"
CHAT_PAGE_PATH = "/captain/chat"
LOGIN_PATH = "/captain/login"
HTML_MEDIA_TYPES = frozenset({"text/html", "application/xhtml+xml"})
QUALITY = re.compile(r"0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?")
STATIC_ROUTES = {
    CHAT_PAGE_PATH: ("chat.html", "text/html; charset=utf-8"),
    "/captain/assets/chat.js": (
        "chat.js",
        "text/javascript; charset=utf-8",
    ),
    "/captain/assets/chat.css": (
        "chat.css",
        "text/css; charset=utf-8",
    ),
}
ASSET_PATHS = frozenset({"/captain/assets/chat.js", "/captain/assets/chat.css"})
ASSET_LINKS = ("/captain/assets/chat.css", "/captain/assets/chat.js")
IMMUTABLE_CACHE = "private, max-age=31536000, immutable"
STATIC_SECURITY_HEADERS = (
    (
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; "
        "style-src 'self'; connect-src 'self'; "
        "form-action 'self'; frame-ancestors 'none'; "
        "base-uri 'none'",
    ),
    ("Referrer-Policy", "no-referrer"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
)


class AuthenticationRequired(RuntimeError):
    pass


class SessionRefused(approval_security.ApprovalRefused):
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
        assets_dir: Path | None = None,
    ) -> None:
        self.sessions = sessions
        self.service = service
        self.updates = updates
        self.clock = clock
        root = Path(__file__).parent if assets_dir is None else Path(assets_dir)
        page = (root / "chat.html").read_bytes()
        self._assets = {
            path: (root / filename).read_bytes()
            for path, (filename, _type) in STATIC_ROUTES.items()
            if path in ASSET_PATHS
        }
        self._marks = {
            path: hashlib.sha256(body).hexdigest()[:12]
            for path, body in self._assets.items()
        }
        for link in ASSET_LINKS:
            token = link.encode("ascii")
            if page.count(token) != 1:
                raise RuntimeError("chat page links are invalid")
            page = page.replace(
                token,
                token + b"?v=" + self._marks[link].encode("ascii"),
            )
        self._page = page
        self._page_etag = f'"{hashlib.sha256(page).hexdigest()}"'

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
    def _json(request: approval_app.Request, fields: set[str]) -> dict[str, Any]:
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
        if not isinstance(payload, dict) or set(payload) != fields:
            raise cards.CardRefused("card request fields are invalid")
        return payload

    @staticmethod
    def _asks_for_html(request: approval_app.Request) -> bool:
        headers = {
            name.lower(): value
            for name, value in request.headers.items()
        }
        for entry in headers.get("accept", "").split(","):
            media, _, parameters = entry.partition(";")
            if media.strip().lower() not in HTML_MEDIA_TYPES:
                continue
            quality = "1"
            for parameter in parameters.split(";"):
                name, equals, value = parameter.partition("=")
                if equals and name.strip().lower() == "q":
                    quality = value.strip()
            if QUALITY.fullmatch(quality) is not None and float(quality) > 0:
                return True
        return False

    @staticmethod
    def _sign_in_redirect(location: str = LOGIN_PATH) -> approval_app.Response:
        headers = approval_app.ApprovalApplication._security_headers(
            "text/plain; charset=utf-8"
        )
        headers.append(("Location", location))
        headers.append(("Content-Length", "0"))
        return approval_app.Response(303, tuple(headers), b"")

    @staticmethod
    def _sign_in_refused() -> approval_app.Response:
        return approval_app.ApprovalApplication._response(
            401,
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            "<title>Sign-in</title></head><body><main>"
            "<p>Your sign-in has ended or could not be checked.</p>"
            '<p><a href="/captain/login">Sign in again</a></p>'
            "</main></body></html>",
        )

    @staticmethod
    def _etag_matches(request: approval_app.Request, etag: str) -> bool:
        offered = next(
            (
                value
                for name, value in request.headers.items()
                if name.lower() == "if-none-match"
            ),
            "",
        )
        return etag in {
            item.strip().removeprefix("W/") for item in offered.split(",")
        }

    def _asset_cache(self, path: str, query: str) -> str:
        try:
            values = parse_qs(query, strict_parsing=True, keep_blank_values=True)
        except ValueError:
            return "no-cache"
        if values == {"v": [self._marks[path]]}:
            return IMMUTABLE_CACHE
        return "no-cache"

    def _static(
        self,
        request: approval_app.Request,
        path: str,
        query: str,
    ) -> approval_app.Response:
        _filename, content_type = STATIC_ROUTES[path]
        if path == CHAT_PAGE_PATH:
            body = self._page
            validators = (("ETag", self._page_etag),)
            cache = "no-cache"
        else:
            body = self._assets[path]
            validators = ()
            cache = self._asset_cache(path, query)
        status = 200
        if path == CHAT_PAGE_PATH and self._etag_matches(request, self._page_etag):
            status = 304
            body = b""
        headers = (
            ("Content-Type", content_type),
            ("Cache-Control", cache),
            *validators,
            *STATIC_SECURITY_HEADERS,
            ("Content-Length", str(len(body))),
        )
        return approval_app.Response(status, headers, body)

    def _get(
        self,
        request: approval_app.Request,
        path: str,
        chat_bot: str | None,
        query: str = "",
    ) -> approval_app.Response:
        html_chat = path == CHAT_PAGE_PATH and self._asks_for_html(request)
        if html_chat:
            cookie_text = approval_app.ApprovalApplication._cookie_text(request)
            cookie_present = any(
                pair.partition("=")[0] == "__Host-qd-approval"
                for pair in approval_app.ApprovalApplication._cookie_pairs(cookie_text)
            )
            if not cookie_present:
                return self._sign_in_redirect()
        try:
            owner = self.sessions.authenticate(request)
        except (AuthenticationRequired, SessionRefused):
            if html_chat:
                return self._sign_in_refused()
            raise
        if path in STATIC_ROUTES:
            return self._static(request, path, query)
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
            headers = {
                name.lower(): value
                for name, value in request.headers.items()
            }
            if headers.get("if-none-match") == etag:
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
        elif path == CHATS_PATH:
            payload = {"chats": self.service.chat_list()}
        elif path == CHAT_PATH and chat_bot is not None:
            payload = self.service.chat(chat_bot)
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
        chat_bot: str | None,
    ) -> approval_app.Response:
        answer = re.fullmatch(
            r"/captain/cards/([A-Za-z0-9][A-Za-z0-9-]{0,63})/answer",
            path,
        )
        comment = re.fullmatch(
            r"/captain/cards/([A-Za-z0-9][A-Za-z0-9-]{0,63})/comments",
            path,
        )
        chat = path == CHAT_PATH and chat_bot is not None
        if answer is not None:
            payload = self._json(
                request,
                {"rev", "pick", "note", "csrf"},
            )
        elif comment is not None or chat is not None:
            payload = self._json(
                request,
                {"text", "requestId", "csrf"},
            )
        else:
            return self._response(404, {"error": "not found"})
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
            message_id, fresh = self.service.send_chat(
                chat_bot,
                payload["text"],
                payload["requestId"],
                fresh=self.sessions.fresh_until(owner) > self.clock(),
            )
            result = {
                "status": "sent",
                "message": {
                    "id": message_id,
                    "clientId": payload["requestId"],
                    "from": "account",
                    "at": datetime.fromtimestamp(
                        self.clock(),
                        timezone.utc,
                    ).isoformat(timespec="seconds"),
                    "text": payload["text"],
                    "fresh": fresh,
                },
            }
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
    def _chat_target(path: str, query: str) -> str | None:
        if path != CHAT_PATH:
            if query and path not in ASSET_PATHS:
                raise cards.CardRefused("card query is invalid")
            return None
        try:
            values = parse_qs(
                query,
                strict_parsing=True,
                keep_blank_values=True,
            )
        except ValueError:
            raise cards.CardRefused("chat target is invalid") from None
        if (
            set(values) != {"with"}
            or len(values["with"]) != 1
            or CARD_ID.fullmatch(values["with"][0]) is None
        ):
            raise cards.CardRefused("chat target is invalid")
        return values["with"][0]

    def handle(self, request: approval_app.Request) -> approval_app.Response:
        try:
            parsed = urlsplit(request.path)
            if parsed.scheme or parsed.netloc or parsed.fragment:
                return self._response(404, {"error": "not found"})
            chat_bot = self._chat_target(parsed.path, parsed.query)
            if request.method == "GET":
                return self._get(request, parsed.path, chat_bot, parsed.query)
            if request.method == "POST":
                return self._post(request, parsed.path, chat_bot)
            return self._response(405, {"error": "method not allowed"})
        except AuthenticationRequired:
            return self._response(401, {"error": "sign in required"})
        except approval_security.ApprovalRateLimited:
            return self._response(429, {"error": "request refused"})
        except approval_security.FreshSignInRequired:
            return self._sign_in_redirect(approval_security.STEP_UP_PATH + "?" + urlencode({"next": CHAT_PAGE_PATH}))
        except approval_security.ApprovalRefused:
            return self._response(403, {"error": "request refused"})
        except cards.CardRefused:
            return self._response(400, {"error": "request refused"})
        except Exception:
            return self._response(503, {"error": "request unavailable"})
        finally:
            approval_security.clear(request.body)
