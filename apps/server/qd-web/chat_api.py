from __future__ import annotations

import hashlib
import json
import re
import sys
import threading
import time
from collections import OrderedDict, deque
from datetime import datetime
from typing import Any, Callable
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

import application
import approval_app
import approval_security
import cards

ET = ZoneInfo("America/New_York")
COOKIE = "__Host-qd-approval"
CHATS_PATH = "/captain/api/chats"
CHAT_PATH = "/captain/api/chat"
READ_PATH = "/captain/api/chat/read"
SEND_FIELDS = {"bot", "text", "clientId", "csrf"}
SEND_OPTIONAL = frozenset({"quote"})
READ_FIELDS = {"bot", "upTo", "csrf"}
THREAD_FIELDS = {"bot", "before", "after"}
BEFORE = re.compile(r"[\x21-\x7e]{1,256}")
SEND_LIMIT = 10
SEND_WINDOW = 60.0
READ_LIMIT = 30
READ_WINDOW = 60.0
READ_BODY = 4096
REMEMBERED = 256
ROUTES = {
    ("GET", CHATS_PATH): "list",
    ("GET", CHAT_PATH): "thread",
    ("POST", CHAT_PATH): "send",
    ("POST", READ_PATH): "read",
}
ERROR_CODE = re.compile(r"[A-Za-z0-9 _-]{1,40}")
CHAIN_LIMIT = 8


class ChatRateLimited(RuntimeError):
    pass


class ChatMailFailed(RuntimeError):
    pass


class ChatApi:
    def __init__(
        self,
        sessions: application.SessionGate,
        service: cards.CardService,
        *,
        clock: Callable[[], float],
    ) -> None:
        self.sessions = sessions
        self.service = service
        self.clock = clock
        self._lock = threading.Lock()
        self._sends: dict[bytes, deque[float]] = {}
        self._reads: dict[bytes, deque[float]] = {}
        self._sent: OrderedDict[tuple[str, str], tuple[str, str, str]] = OrderedDict()

    @staticmethod
    def _response(status: int, payload: Any) -> approval_app.Response:
        return application.CardApplication._response(status, payload)

    @staticmethod
    def _failure(error: Exception) -> approval_app.Response:
        if isinstance(error, (application.AuthenticationRequired, application.SessionRefused)):
            return ChatApi._response(401, {"error": "session"})
        if isinstance(error, (approval_security.ApprovalRateLimited, ChatRateLimited)):
            return ChatApi._response(429, {"error": "rate"})
        if isinstance(error, cards.ChatBotRefused):
            return ChatApi._response(422, {"error": "bot"})
        if isinstance(error, cards.ChatTextRefused):
            return ChatApi._response(400, {"error": "text"})
        if isinstance(error, cards.ChatQuoteRefused):
            return ChatApi._response(422, {"error": "quote"})
        if isinstance(error, cards.ChatReadRefused):
            return ChatApi._response(422, {"error": "read"})
        if isinstance(error, cards.ChatCursorRefused):
            return ChatApi._response(409, {"error": "cursor"})
        if isinstance(error, ChatMailFailed):
            return ChatApi._response(502, {"error": "mail"})
        return application.CardApplication._failure(error)

    @staticmethod
    def _root(error: BaseException) -> str:
        for _ in range(CHAIN_LIMIT):
            inner = error.__cause__ or error.__context__
            if inner is None:
                break
            error = inner
        return type(error).__name__

    @staticmethod
    def _code(response: approval_app.Response) -> str:
        if response.status < 400:
            return "-"
        try:
            code = json.loads(response.body).get("error")
        except Exception:
            return "-"
        if isinstance(code, str) and ERROR_CODE.fullmatch(code) is not None:
            return code.replace(" ", "_")
        return "-"

    @staticmethod
    def _log(
        route: str,
        response: approval_app.Response,
        cause: str,
        started: float,
    ) -> None:
        milliseconds = int((time.monotonic() - started) * 1000)
        line = (
            f"QD_CHAT_REPLY route={route} status={response.status} "
            f"error={ChatApi._code(response)} cause={cause} ms={milliseconds}\n"
        )
        try:
            sys.stderr.write(line)
            sys.stderr.flush()
        except Exception:
            pass

    def _dispatch(self, request: approval_app.Request, path: str) -> approval_app.Response:
        if request.method == "GET" and path == CHATS_PATH:
            return self._chats(request)
        if request.method == "GET" and path == CHAT_PATH:
            return self._thread(request)
        if request.method == "POST" and path == CHAT_PATH:
            return self._send(request)
        if request.method == "POST" and path == READ_PATH:
            return self._read(request)
        raise application.NotFound("chat route is unknown")

    def handle(self, request: approval_app.Request, path: str) -> approval_app.Response:
        route = ROUTES.get((request.method, path))
        started = time.monotonic()
        cause = "-"
        try:
            response = self._dispatch(request, path)
        except Exception as error:
            cause = self._root(error)
            response = self._failure(error)
        finally:
            approval_security.clear(request.body)
        if route is not None:
            self._log(route, response, cause, started)
        return response

    def _chats(self, request: approval_app.Request) -> approval_app.Response:
        self.sessions.authenticate(request)
        if urlsplit(request.path).query:
            raise cards.CardRefused("chat query is invalid")
        return self._response(200, self.service.chat_rows())

    def _thread(self, request: approval_app.Request) -> approval_app.Response:
        self.sessions.authenticate(request)
        try:
            pairs = parse_qsl(
                urlsplit(request.path).query,
                keep_blank_values=True,
                strict_parsing=True,
                max_num_fields=len(THREAD_FIELDS),
            )
        except ValueError:
            raise cards.CardRefused("chat query is invalid") from None
        names = [name for name, value in pairs]
        if (
            len(set(names)) != len(names)
            or not set(names) <= THREAD_FIELDS
            or "bot" not in names
            or ("before" in names and "after" in names)
        ):
            raise cards.CardRefused("chat query is invalid")
        fields = dict(pairs)
        for name in ("before", "after"):
            value = fields.get(name)
            if value is not None and BEFORE.fullmatch(value) is None:
                raise cards.CardRefused("chat cursor is invalid")
        return self._response(
            200,
            self.service.chat_thread(fields["bot"], fields.get("before"), fields.get("after")),
        )

    def _take(
        self,
        request: approval_app.Request,
        windows: dict[bytes, deque[float]],
        limit: int,
        span: float,
    ) -> None:
        token = approval_app.ApprovalApplication._cookie(request, COOKIE) or ""
        key = hashlib.sha256(token.encode("utf-8", "replace")).digest()
        now = self.clock()
        with self._lock:
            for stale in [
                other
                for other, window in windows.items()
                if not window or window[-1] <= now - span
            ]:
                del windows[stale]
            window = windows.setdefault(key, deque())
            while window and window[0] <= now - span:
                window.popleft()
            if len(window) >= limit:
                raise ChatRateLimited("chat rate limit reached")
            window.append(now)

    def _stamp(self) -> str:
        return datetime.fromtimestamp(self.clock(), ET).isoformat(timespec="seconds")

    def _settled(
        self,
        bot: str,
        client_id: str,
        identifier: str,
        text: str,
        fresh: bool,
        quote: Any = None,
    ) -> tuple[str, str]:
        with self._lock:
            kept = self._sent.get((bot, client_id))
            if kept is not None and kept[0] == identifier:
                self._sent.move_to_end((bot, client_id))
                return kept[1], kept[2]
        known = self.service.chat_sent(bot, identifier)
        if known is not None:
            at, text = known["at"], known["text"]
        else:
            at = self._stamp()
            self.service.keep_sent(identifier, bot, text, client_id, fresh, at, quote)
        with self._lock:
            self._sent[(bot, client_id)] = (identifier, at, text)
            self._sent.move_to_end((bot, client_id))
            while len(self._sent) > REMEMBERED:
                self._sent.popitem(last=False)
        return at, text

    def _send(self, request: approval_app.Request) -> approval_app.Response:
        if urlsplit(request.path).query:
            raise cards.CardRefused("chat query is invalid")
        payload = application.CardApplication._json(request, SEND_FIELDS, SEND_OPTIONAL)
        csrf = payload["csrf"]
        if not isinstance(csrf, str):
            raise cards.CardRefused("chat csrf is invalid")
        owner = self.sessions.authorize_post(request, csrf)
        bot, client_id = self.service.check_chat_send(
            payload["bot"],
            payload["text"],
            payload["clientId"],
        )
        quote = payload.get("quote")
        if "quote" in payload:
            self.service.check_chat_quote(bot, quote)
        self._take(request, self._sends, SEND_LIMIT, SEND_WINDOW)
        try:
            identifier, fresh = self.service.send_chat(bot, payload["text"], client_id, quote=quote)
        except (cards.CardRefused, approval_security.ApprovalRefused):
            raise
        except Exception:
            raise ChatMailFailed("chat mail was not sent") from None
        at, text = self._settled(bot, client_id, identifier, payload["text"], fresh, quote)
        return self._response(
            200,
            {
                "id": identifier,
                "from": "captain",
                "text": text,
                "at": at,
                "refs": [],
                "clientId": client_id,
                "uploadVerdicts": [],
                "csrf": self.sessions.issue_csrf(owner),
                "freshUntil": self.sessions.fresh_until(owner),
            },
        )

    def _read(self, request: approval_app.Request) -> approval_app.Response:
        if urlsplit(request.path).query or len(request.body) > READ_BODY:
            raise cards.CardRefused("chat request is invalid")
        payload = application.CardApplication._json(request, READ_FIELDS)
        csrf = payload["csrf"]
        if not isinstance(csrf, str):
            raise cards.CardRefused("chat csrf is invalid")
        owner = self.sessions.authorize_post(request, csrf)
        bot, up_to = self.service.check_chat_read(payload["bot"], payload["upTo"])
        self._take(request, self._reads, READ_LIMIT, READ_WINDOW)
        try:
            self.service.mark_chat_read(bot, up_to)
        except (cards.CardRefused, approval_security.ApprovalRefused):
            raise
        except Exception:
            raise ChatMailFailed("chat mark was not made") from None
        return self._response(
            200,
            {
                "csrf": self.sessions.issue_csrf(owner),
                "freshUntil": self.sessions.fresh_until(owner),
            },
        )
