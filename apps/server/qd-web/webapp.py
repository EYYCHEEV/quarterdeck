from __future__ import annotations

import re
from typing import Protocol
from urllib.parse import urlsplit

import application
import approval_app
import approval_security
import bundle
import cards


PRINTABLE = re.compile(r"[\x21-\x7e]+")
CARD_PATH = re.compile(r"/captain/cards/[^/]+")
CARD_POST_PATH = re.compile(r"/captain/cards/[^/]+/(?:answer|comments)")
MAIL_PATH = re.compile(r"/captain/mail(?:/[^/]+)?")
MAIL_SEGMENT = re.compile(r"[\x21-\x7e]{1,128}")
EVENTS_PATH = "/captain/events"
MAIL_PREFIX = "/captain/mail/"
CHATS_PATH = "/captain/api/chats"
CHAT_PATH = "/captain/api/chat"
CHAT_READ_PATH = "/captain/api/chat/read"


class MailRoutes(Protocol):
    def handle(self, request: approval_app.Request, path: str) -> approval_app.Response: ...


class ChatRoutes(Protocol):
    def handle(self, request: approval_app.Request, path: str) -> approval_app.Response: ...


class QdWeb:
    def __init__(
        self,
        cards_app: application.CardApplication,
        site: bundle.Bundle,
        *,
        mail: MailRoutes | None = None,
        chat: ChatRoutes | None = None,
    ) -> None:
        self._cards = cards_app
        self._site = site
        self._mail = mail
        self._chat = chat

    def _route(self, path: str) -> tuple[str, str] | None:
        if path == "/captain/cards":
            return "cards", "GET"
        if path == EVENTS_PATH:
            return "events", "GET"
        if path == application.CHAT_PAGE_PATH:
            return "chat", "GET"
        if self._chat is not None and path == CHATS_PATH:
            return "chat-api", "GET"
        if self._chat is not None and path == CHAT_PATH:
            return "chat-api", "GET, POST"
        if self._chat is not None and path == CHAT_READ_PATH:
            return "chat-api", "POST"
        if self._mail is not None and MAIL_PATH.fullmatch(path) is not None:
            return "mail", "GET"
        if CARD_POST_PATH.fullmatch(path) is not None:
            return "card-post", "POST"
        if CARD_PATH.fullmatch(path) is not None:
            return "card", "GET"
        if self._site.has(path):
            return "static", "GET, HEAD"
        return None

    def is_events(self, request: approval_app.Request) -> bool:
        return request.method == "GET" and urlsplit(request.path).path == EVENTS_PATH

    def open_events(
        self,
        request: approval_app.Request,
        *,
        last_event_id: str | None,
    ) -> application.StreamResponse:
        return self._cards.open_events(request, last_event_id=last_event_id)

    def _mail_answer(self, request: approval_app.Request, path: str) -> approval_app.Response:
        if path != "/captain/mail" and MAIL_SEGMENT.fullmatch(path.removeprefix(MAIL_PREFIX)) is None:
            raise cards.CardRefused("mail reference is invalid")
        return self._mail.handle(request, path)

    def handle(self, request: approval_app.Request) -> approval_app.Response:
        try:
            if PRINTABLE.fullmatch(request.path) is None:
                raise cards.CardRefused("request path is invalid")
            parsed = urlsplit(request.path)
            if parsed.scheme or parsed.netloc or parsed.fragment:
                raise application.NotFound("request path is unknown")
            route = self._route(parsed.path)
            if route is None:
                raise application.NotFound("request path is unknown")
            kind, allowed = route
            if request.method not in allowed.split(", "):
                return application.CardApplication._response(
                    405,
                    {"error": "method not allowed"},
                    (("Allow", allowed),),
                )
            if kind == "chat":
                return application.CardApplication._sign_in_redirect("/")
            if kind == "static":
                return self._site.serve(request)
            if kind == "chat-api":
                return self._chat.handle(request, parsed.path)
            if parsed.query:
                raise cards.CardRefused("card query is invalid")
            if kind == "events":
                raise application.NotFound("events are served by the stream")
            if kind == "mail":
                return self._mail_answer(request, parsed.path)
            return self._cards.handle(request)
        except Exception as error:
            return application.CardApplication._failure(error)
        finally:
            approval_security.clear(request.body)
