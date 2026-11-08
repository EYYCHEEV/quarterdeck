from __future__ import annotations

import html
import ipaddress
import math
import re
import secrets
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from urllib.parse import parse_qs, urlencode, urlsplit
from zoneinfo import ZoneInfo

import approval_security
import invite_prompt


MAX_BODY_BYTES = 8192
LOGIN_PATH = "/captain/login"
CALLBACK_PATH = "/captain/oidc/callback"
PENDING_PATH = "/captain/pending"
CHAT_PATH = "/captain/chat"
APPROVE_PATH = "/captain/approve"
REFUSE_PATH = "/captain/refuse"
LOGOUT_PATH = "/captain/logout"
PASSWORD_SETTINGS_PATH = "/captain/settings/approval-password"
INVITE_CREATE_PATH = "/captain/invites/create"
INVITE_CANCEL_PATH = "/captain/invites/cancel"
LOGIN_COOKIE = "__Host-qd-login"
SIGN_IN_FAILED_TEXT = (
    "Sign-in did not finish. Open Safari itself, then sign in again and stay in one tab."
)
TOO_MANY_TRIES_TEXT = "Too many sign-in tries. Wait one hour, then sign in again."
EASTERN = ZoneInfo("America/New_York")


def _display_time(timestamp: float, now: float, *, expires: bool = False) -> str:
    try:
        local = datetime.fromtimestamp(timestamp, EASTERN)
    except (ValueError, OverflowError, OSError):
        raise approval_security.ApprovalRefused("approval time is invalid") from None
    clock = f"{local.hour % 12 or 12}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'} ET"
    seconds = max(0, timestamp - now if expires else now - timestamp)
    if seconds < 60:
        relative = "less than 1 min"
    elif seconds < 3600:
        relative = f"{int(seconds // 60)} min"
    elif seconds < 86400:
        relative = f"{int(seconds // 3600)} h"
    else:
        relative = f"{int(seconds // 86400)} d"
    if expires:
        return f"expires in {relative} ({clock}, {local.strftime('%b')} {local.day})"
    return f"{relative} ago ({clock})"


def _mobile_head(title: str, nonce: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<title>{title}</title><style nonce="{nonce}">'
        '*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;margin:16px}'
        'main{max-width:48rem;margin:auto;overflow-wrap:anywhere}'
        'ul{padding-left:24px}li{margin-bottom:24px}form{margin:12px 0}'
        'button,input,textarea{font:inherit;max-width:100%}'
        'button{min-height:44px;padding:8px 16px}input{min-height:44px}'
        'label{display:block}textarea{display:block;width:100%;height:24rem;padding:12px}'
        '</style></head>'
    )


class CaptainSignIn(Protocol):
    def login_redirect(self, next_path: str, *, request: Request | None = None) -> Response: ...
    def step_up_redirect(self, next_path: str, *, request: Request) -> Response: ...
    def oidc_callback(self, request: Request) -> Response: ...
    def require_captain(self, request: Request) -> object | None: ...
    def csrf_token(self, session: object) -> str: ...
    def check_csrf(self, session: object, form: object) -> bool: ...
    def logout_response(self, session: object, form: object) -> Response: ...
    def fresh_until(self, session: object) -> float: ...
    def record_use(self, session: object, request: Request) -> None: ...
    def devices(self, session: object) -> list[dict[str, object]]: ...
    def sign_out_device(self, session: object, device_id: int | None = None) -> bool: ...
    def signed_out_response(self) -> Response: ...


class ApprovalBackend(Protocol):
    def pending(self) -> list[dict[str, str | float]]: ...
    def invites(self) -> list[dict[str, str | float | None]]: ...

    def create_invite(
        self, bot_name: str | None
    ) -> dict[str, str | float | None]: ...

    def cancel_invite(self, invite_id: str) -> bool: ...
    def approve(self, code: str) -> bool: ...
    def refuse(self, code: str) -> bool: ...


@dataclass(slots=True)
class Request:
    method: str
    path: str
    headers: dict[str, str]
    body: bytearray
    peer: str


@dataclass(frozen=True, slots=True)
class Response:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes


class ApprovalApplication:
    def __init__(
        self,
        state: approval_security.ApprovalState,
        sign_in: CaptainSignIn,
        backend: ApprovalBackend,
        release: invite_prompt.ReleaseConfig,
        *,
        trusted_proxy: str,
        public_origin: str,
    ) -> None:
        self.state = state
        self.sign_in = sign_in
        self.backend = backend
        if not isinstance(release, invite_prompt.ReleaseConfig):
            raise approval_security.ApprovalRefused(
                "approval release configuration is invalid"
            )
        self.release = release
        if (
            not isinstance(trusted_proxy, str)
            or not trusted_proxy
            or "," in trusted_proxy
            or any(ord(character) < 0x20 for character in trusted_proxy)
        ):
            raise approval_security.ApprovalRefused("approval proxy is invalid")
        parsed_origin = urlsplit(public_origin)
        if (
            parsed_origin.scheme != "https"
            or not parsed_origin.hostname
            or parsed_origin.path
            or parsed_origin.query
            or parsed_origin.fragment
            or parsed_origin.username is not None
            or parsed_origin.password is not None
            or parsed_origin.port not in {None, 443}
        ):
            raise approval_security.ApprovalRefused("approval origin is invalid")
        self.trusted_proxy = trusted_proxy
        self.public_origin = public_origin
        self.forwarded_host = parsed_origin.hostname

    @staticmethod
    def _headers(request: Request) -> dict[str, str]:
        return {name.lower(): value for name, value in request.headers.items()}

    def _caller(self, request: Request) -> str:
        headers = self._headers(request)
        if request.peer != self.trusted_proxy:
            raise approval_security.ApprovalRefused("approval proxy is untrusted")
        if (
            headers.get("x-forwarded-proto") != "https"
            or headers.get("x-forwarded-host") != self.forwarded_host
        ):
            raise approval_security.ApprovalRefused("approval forwarding is invalid")
        forwarded = headers.get("x-forwarded-for", "")
        if (
            not forwarded
            or len(forwarded) > 255
            or "," in forwarded
            or not forwarded.isascii()
            or any(ord(character) < 0x21 for character in forwarded)
        ):
            raise approval_security.ApprovalRefused("approval caller is invalid")
        try:
            ipaddress.ip_address(forwarded)
        except ValueError:
            raise approval_security.ApprovalRefused(
                "approval caller is invalid"
            ) from None
        return forwarded

    @staticmethod
    def _cookie_text(request: Request) -> str:
        raw = ApprovalApplication._headers(request).get("cookie")
        return raw if isinstance(raw, str) else ""

    @staticmethod
    def _cookie_pairs(text: str) -> list[str]:
        return [pair for pair in (part.strip() for part in text.split(";")) if pair]

    @staticmethod
    def _cookie(request: Request, name: str) -> str | None:
        found = []
        for pair in ApprovalApplication._cookie_pairs(
            ApprovalApplication._cookie_text(request)
        ):
            key, separator, value = pair.partition("=")
            if key == name:
                found.append(value if separator else "")
            elif key.startswith(name) and key[len(name)] not in "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz":
                return None
        return found[0] if len(found) == 1 and found[0] else None

    @staticmethod
    def _cookie_facts(request: Request) -> str:
        text = ApprovalApplication._cookie_text(request)
        pairs = ApprovalApplication._cookie_pairs(text)
        named = any(pair.startswith(f"{LOGIN_COOKIE}=") for pair in pairs)
        count = len(pairs)
        bucket = "0" if count == 0 else "1" if count == 1 else "2-5" if count <= 5 else "6+"
        return (
            f"cookie_header={'yes' if text.strip() else 'no'} "
            f"login_name_in_header={'yes' if named else 'no'} "
            f"cookies={bucket}"
        )

    @staticmethod
    def _form(request: Request, fields: set[str]) -> dict[str, str]:
        headers = ApprovalApplication._headers(request)
        if headers.get("content-type") != "application/x-www-form-urlencoded" or len(request.body) > MAX_BODY_BYTES:
            raise approval_security.ApprovalRefused("approval form is invalid")
        try:
            parsed = parse_qs(bytes(request.body).decode("utf-8"), strict_parsing=True, keep_blank_values=True)
        except (UnicodeDecodeError, ValueError):
            raise approval_security.ApprovalRefused("approval form is invalid") from None
        if set(parsed) != fields or any(len(values) != 1 for values in parsed.values()):
            raise approval_security.ApprovalRefused("approval form is invalid")
        return {name: values[0] for name, values in parsed.items()}

    def _origin(self, request: Request) -> None:
        if self._headers(request).get("origin") != self.public_origin:
            raise approval_security.ApprovalRefused("approval origin is invalid")

    @staticmethod
    def _security_headers(content_type: str = "text/html; charset=utf-8") -> list[tuple[str, str]]:
        return [
            ("Content-Type", content_type),
            ("Cache-Control", "no-store"),
            ("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"),
            ("Referrer-Policy", "strict-origin"),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
        ]

    @staticmethod
    def _response(status: int, body: str, extra: list[tuple[str, str]] | None = None, *, style_nonce: str | None = None) -> Response:
        encoded = body.encode("utf-8")
        headers = ApprovalApplication._security_headers()
        if style_nonce is not None:
            headers = [
                (name, value + f"; style-src 'nonce-{style_nonce}'")
                if name == "Content-Security-Policy" else (name, value)
                for name, value in headers
            ]
        if extra:
            headers.extend(extra)
        headers.append(("Content-Length", str(len(encoded))))
        return Response(status, tuple(headers), encoded)

    @staticmethod
    def _redirect(location: str, cookies: list[str]) -> Response:
        headers = ApprovalApplication._security_headers("text/plain; charset=utf-8")
        headers.append(("Location", location))
        headers.extend(("Set-Cookie", value) for value in cookies)
        headers.append(("Content-Length", "0"))
        return Response(303, tuple(headers), b"")

    @staticmethod
    def _clear_login_cookie() -> str:
        return f"{LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"

    @staticmethod
    def _refusal_page(
        status: int, extra: list[tuple[str, str]] | None = None
    ) -> Response:
        if status == 429:
            content = f"<p>{TOO_MANY_TRIES_TEXT}</p>"
        else:
            content = (
                f"<p>{SIGN_IN_FAILED_TEXT}</p>"
                f"<p><a href=\"{LOGIN_PATH}\">Sign in again</a></p>"
            )
        page = (
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<title>Sign-in</title></head><body><main>{content}</main></body></html>"
        )
        return ApprovalApplication._response(status, page, extra)

    def _login_refused(self, caller: str) -> Response:
        blocked = self.state.record_login_failure(caller)
        return self._refusal_page(
            429 if blocked else 401,
            [("Set-Cookie", self._clear_login_cookie())],
        )

    def _login_start(self, request: Request, caller: str) -> Response:
        if not self.state.login_allowed(caller):
            return self._refusal_page(429)
        return self.sign_in.login_redirect(CHAT_PATH, request=request)

    def _fresh(self, session: object, next_path: str = PENDING_PATH) -> Response | None:
        if self.sign_in.fresh_until(session) > self.state.clock():
            return None
        return self._redirect(approval_security.STEP_UP_PATH + "?" + urlencode({"next": next_path}), [])

    def _step_up(self, request: Request, caller: str, query: str) -> Response:
        if not self.state.login_allowed(caller):
            return self._refusal_page(429)
        try:
            values = parse_qs(query, strict_parsing=True, keep_blank_values=True) if query else {"next": [CHAT_PATH]}
        except ValueError:
            raise approval_security.ApprovalRefused("fresh sign-in return is invalid") from None
        if set(values) != {"next"} or len(values["next"]) != 1:
            raise approval_security.ApprovalRefused("fresh sign-in return is invalid")
        return self.sign_in.step_up_redirect(values["next"][0], request=request)

    @staticmethod
    def _log_refusal(stage: str, facts: str = "") -> None:
        sys.stderr.write(f"QD_SIGNIN_REFUSED stage={stage} {facts}\n" if facts else f"QD_SIGNIN_REFUSED stage={stage}\n")
        sys.stderr.flush()

    def _callback(self, request: Request, caller: str) -> Response:
        if not self.state.login_allowed(caller):
            self._log_refusal("gate")
            return self._refusal_page(
                429,
                [("Set-Cookie", self._clear_login_cookie())],
            )
        try:
            return self.sign_in.oidc_callback(request)
        except approval_security.ApprovalRefused as error:
            stage = approval_security.refusal_stage(error)
            facts = self._cookie_facts(request) if stage.startswith("state-binding-") else ""
            self._log_refusal(stage, facts)
            return self._login_refused(caller)


    def _session(self, request: Request) -> object | None:
        return self.sign_in.require_captain(request)

    def _pending(self, request: Request) -> Response:
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        csrf = self.sign_in.csrf_token(session)
        pending = self.backend.pending()
        invites = self.backend.invites()
        if (
            not isinstance(pending, list)
            or len(pending) > 100
            or not isinstance(invites, list)
            or len(invites) > 50
        ):
            raise approval_security.ApprovalRefused(
                "approval backend response is invalid"
            )
        password_required = self.state.approval_password_required()
        now = self.state.clock()
        rows = []
        password_field = (
            "<label>Approval password "
            "<input type=\"password\" name=\"approvalPassword\" "
            "autocomplete=\"current-password\" required></label>"
            if password_required
            else ""
        )
        for item in pending:
            if (
                not isinstance(item, dict)
                or set(item)
                != {"code", "botName", "requestedAt", "invitedBy"}
            ):
                raise approval_security.ApprovalRefused(
                    "approval backend response is invalid"
                )
            code = item["code"]
            bot = item["botName"]
            requested_at = item["requestedAt"]
            invited_by = item["invitedBy"]
            if (
                not isinstance(code, str)
                or re.fullmatch(
                    r"[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}", code
                )
                is None
                or not isinstance(bot, str)
                or re.fullmatch(r"[a-z][a-z0-9-]{0,31}", bot) is None
                or not isinstance(requested_at, (int, float))
                or isinstance(requested_at, bool)
                or not math.isfinite(requested_at)
                or requested_at < 0
                or not isinstance(invited_by, str)
                or not 1 <= len(invited_by) <= 64
                or any(ord(character) < 0x20 for character in invited_by)
            ):
                raise approval_security.ApprovalRefused(
                    "approval backend response is invalid"
                )
            rows.append(
                "<li>"
                f"<strong>{html.escape(bot)}</strong> wants to join, "
                f"invited by {html.escape(invited_by)}, "
                f"code {html.escape(code)}, "
                f"requested {_display_time(requested_at, now)} "
                f"<form method=\"post\" action=\"{APPROVE_PATH}\">"
                f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
                f"<input type=\"hidden\" name=\"code\" value=\"{html.escape(code)}\">"
                f"{password_field}"
                "<button type=\"submit\">Approve</button></form>"
                f"<form method=\"post\" action=\"{REFUSE_PATH}\">"
                f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
                f"<input type=\"hidden\" name=\"code\" value=\"{html.escape(code)}\">"
                "<button type=\"submit\">Refuse</button></form></li>"
            )
        invite_rows = []
        for item in invites:
            if (
                not isinstance(item, dict)
                or set(item)
                != {
                    "inviteId",
                    "botName",
                    "invitedBy",
                    "createdAt",
                    "expiresAt",
                }
            ):
                raise approval_security.ApprovalRefused(
                    "approval backend response is invalid"
                )
            invite_id = item["inviteId"]
            bot_name = item["botName"]
            invited_by = item["invitedBy"]
            created_at = item["createdAt"]
            expires_at = item["expiresAt"]
            if (
                not isinstance(invite_id, str)
                or re.fullmatch(r"[A-Za-z0-9_-]{12}", invite_id) is None
                or (
                    bot_name is not None
                    and (
                        not isinstance(bot_name, str)
                        or re.fullmatch(r"[a-z][a-z0-9-]{0,31}", bot_name)
                        is None
                    )
                )
                or not isinstance(invited_by, str)
                or not 1 <= len(invited_by) <= 64
                or any(ord(character) < 0x20 for character in invited_by)
                or not isinstance(created_at, (int, float))
                or isinstance(created_at, bool)
                or not math.isfinite(created_at)
                or not isinstance(expires_at, (int, float))
                or isinstance(expires_at, bool)
                or not math.isfinite(expires_at)
                or expires_at <= created_at
            ):
                raise approval_security.ApprovalRefused(
                    "approval backend response is invalid"
                )
            target = bot_name if bot_name is not None else "any bot"
            invite_rows.append(
                "<li>"
                f"Invite for {html.escape(target)}, "
                f"created by {html.escape(invited_by)}, "
                f"{_display_time(expires_at, now, expires=True)}"
                f"<form method=\"post\" action=\"{INVITE_CANCEL_PATH}\">"
                f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
                f"<input type=\"hidden\" name=\"inviteId\" "
                f"value=\"{html.escape(invite_id)}\">"
                "<button type=\"submit\">Cancel invite</button></form></li>"
            )
        activity = "".join(
            "<li>"
            f"{html.escape(item['summary'])}, {_display_time(item['happened'], now)}"
            "</li>"
            for item in self.state.recent_activity()
        )
        if password_required:
            password_settings = (
                f"<form method=\"post\" action=\"{PASSWORD_SETTINGS_PATH}\">"
                f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
                "<input type=\"hidden\" name=\"action\" value=\"change\">"
                "<label>Current password <input type=\"password\" "
                "name=\"currentPassword\" required></label>"
                "<label>New password <input type=\"password\" "
                "name=\"newPassword\" required></label>"
                "<button type=\"submit\">Change approval password</button></form>"
                f"<form method=\"post\" action=\"{PASSWORD_SETTINGS_PATH}\">"
                f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
                "<input type=\"hidden\" name=\"action\" value=\"disable\">"
                "<input type=\"hidden\" name=\"newPassword\" value=\"\">"
                "<label>Current password <input type=\"password\" "
                "name=\"currentPassword\" required></label>"
                "<button type=\"submit\">Stop asking for a password</button></form>"
            )
        else:
            password_settings = (
                f"<form method=\"post\" action=\"{PASSWORD_SETTINGS_PATH}\">"
                f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
                "<input type=\"hidden\" name=\"action\" value=\"enable\">"
                "<input type=\"hidden\" name=\"currentPassword\" value=\"\">"
                "<label>New password <input type=\"password\" "
                "name=\"newPassword\" required></label>"
                "<button type=\"submit\">Ask for a password to approve a bot</button></form>"
            )
        nonce = secrets.token_urlsafe(18)
        page = (
            _mobile_head("Pending joins", nonce)
            + "<body><main><h1>Pending joins</h1>"
            "<p>These actions require you to have signed in with Google in the last 15 minutes.</p>"
            f"<p><a href=\"{CHAT_PATH}\">Chat</a></p><ul>"
            + "".join(rows)
            + "</ul><h2>Add bot</h2>"
            f"<form method=\"post\" action=\"{INVITE_CREATE_PATH}\">"
            f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
            "<label>Bot name, optional <input name=\"botName\" "
            "pattern=\"[a-z][a-z0-9-]{0,31}\"></label>"
            "<button type=\"submit\">Add bot</button></form>"
            "<h2>Open invites</h2><ul>"
            + "".join(invite_rows)
            + f"</ul><h2>Settings</h2><p><a href=\"{approval_security.DEVICES_PATH}\">Devices</a></p><h3>Approval setting</h3>"
            + password_settings
            + "<h2>Approve and refuse history</h2><ul>"
            + activity
            + "</ul>"
            f"<form method=\"post\" action=\"{LOGOUT_PATH}\">"
            f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
            "<button type=\"submit\">Sign out</button></form></main></body></html>"
        )
        self.sign_in.record_use(session, request)
        return self._response(200, page, style_nonce=nonce)

    def _invite_create(self, request: Request) -> Response:
        self._origin(request)
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        values = self._form(request, {"botName", "csrf"})
        if not self.sign_in.check_csrf(session, values):
            raise approval_security.ApprovalRefused("approval csrf is invalid")
        fresh = self._fresh(session)
        if fresh is not None:
            return fresh
        bot_name = values["botName"] or None
        if bot_name is not None and re.fullmatch(
            r"[a-z][a-z0-9-]{0,31}", bot_name
        ) is None:
            raise approval_security.ApprovalRefused(
                "approval invite is invalid"
            )
        created = self.backend.create_invite(bot_name)
        if (
            not isinstance(created, dict)
            or set(created)
            != {
                "inviteId",
                "code",
                "botName",
                "invitedBy",
                "createdAt",
                "expiresAt",
            }
            or created.get("botName") != bot_name
            or created.get("invitedBy") != "Captain"
            or not isinstance(created.get("code"), str)
        ):
            raise approval_security.ApprovalRefused(
                "approval backend response is invalid"
            )
        code = bytearray(created["code"].encode("ascii"))
        prompt = invite_prompt.build_prompt(self.release, code)
        self.state.record_activity(
            f"Invite created for {bot_name if bot_name is not None else 'any bot'}"
        )
        nonce = secrets.token_urlsafe(18)
        escaped_prompt = html.escape(prompt)
        page = (
            _mobile_head("Bot invite", nonce)
            + "<body><main>"
            "<h1>Copy this bot invite now</h1>"
            "<p>The invite code is shown once.</p>"
            f"<textarea id=\"invite-prompt\" readonly>{escaped_prompt}</textarea>"
            "<button id=\"copy-invite\" type=\"button\">Copy</button>"
            f"<script nonce=\"{nonce}\">"
            "document.getElementById('copy-invite').addEventListener('click',()=>"
            "navigator.clipboard.writeText(document.getElementById('invite-prompt').value));"
            "</script>"
            f"<p><a href=\"{PENDING_PATH}\">Return to pending joins</a></p>"
            "</main></body></html>"
        )
        encoded = page.encode("utf-8")
        headers = self._security_headers()
        headers = [
            (
                name,
                (
                    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; "
                    f"base-uri 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'"
                )
                if name == "Content-Security-Policy"
                else value,
            )
            for name, value in headers
        ]
        headers.append(("Content-Length", str(len(encoded))))
        self.sign_in.record_use(session, request)
        return Response(200, tuple(headers), encoded)

    def _invite_cancel(self, request: Request) -> Response:
        self._origin(request)
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        values = self._form(request, {"inviteId", "csrf"})
        if not self.sign_in.check_csrf(session, values):
            raise approval_security.ApprovalRefused("approval csrf is invalid")
        fresh = self._fresh(session)
        if fresh is not None:
            return fresh
        invite_id = values["inviteId"]
        if (
            re.fullmatch(r"[A-Za-z0-9_-]{12}", invite_id) is None
            or self.backend.cancel_invite(invite_id) is not True
        ):
            raise approval_security.ApprovalRefused(
                "approval invite was refused"
            )
        self.state.record_activity("Open invite cancelled")
        self.sign_in.record_use(session, request)
        return self._redirect(PENDING_PATH, [])

    def _action(self, request: Request, action: str, caller: str) -> Response:
        self._origin(request)
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        password_required = (
            action == "approve" and self.state.approval_password_required()
        )
        fields = {"code", "csrf"}
        if password_required:
            fields.add("approvalPassword")
        values = self._form(request, fields)
        if not self.sign_in.check_csrf(session, values):
            raise approval_security.ApprovalRefused("approval csrf is invalid")
        fresh = self._fresh(session)
        if fresh is not None:
            return fresh
        code = values["code"]
        if re.fullmatch(r"[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}", code) is None:
            raise approval_security.ApprovalRefused("approval code is invalid")
        if password_required:
            if not self.state.login_allowed(caller):
                raise approval_security.ApprovalRateLimited(
                    "approval password is rate limited"
                )
            password = bytearray(values["approvalPassword"].encode("utf-8"))
            if not self.state.verify_approval_password(password):
                blocked = self.state.record_login_failure(caller)
                if blocked:
                    raise approval_security.ApprovalRateLimited(
                        "approval password is rate limited"
                    )
                raise approval_security.ApprovalRefused(
                    "approval password was refused"
                )
        accepted = (
            self.backend.approve(code)
            if action == "approve"
            else self.backend.refuse(code)
        )
        if accepted is not True:
            raise approval_security.ApprovalRefused("approval action was refused")
        self.state.record_activity(
            f"{'Approved' if action == 'approve' else 'Refused'} {code}"
        )
        self.sign_in.record_use(session, request)
        return self._redirect(PENDING_PATH, [])

    def _password_settings(
        self, request: Request, caller: str
    ) -> Response:
        self._origin(request)
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        if not self.state.login_allowed(caller):
            raise approval_security.ApprovalRateLimited(
                "approval password setting is rate limited"
            )
        values = self._form(
            request,
            {"action", "currentPassword", "newPassword", "csrf"},
        )
        if not self.sign_in.check_csrf(session, values):
            raise approval_security.ApprovalRefused("approval csrf is invalid")
        fresh = self._fresh(session)
        if fresh is not None:
            return fresh
        action = values["action"]
        current = bytearray(values["currentPassword"].encode("utf-8"))
        replacement = bytearray(values["newPassword"].encode("utf-8"))
        current_value: bytearray | None = current
        replacement_value: bytearray | None = replacement
        try:
            if action == "enable" and not current and replacement:
                current_value = None
                self.state.change_approval_password(
                    None, replacement_value, enabled=True
                )
            elif action == "change" and current and replacement:
                self.state.change_approval_password(
                    current_value, replacement_value, enabled=True
                )
            elif action == "disable" and current and not replacement:
                replacement_value = None
                self.state.change_approval_password(
                    current_value, None, enabled=False
                )
            else:
                raise approval_security.ApprovalRefused(
                    "approval password setting is invalid"
                )
        except approval_security.ApprovalRefused:
            blocked = self.state.record_login_failure(caller)
            if blocked:
                raise approval_security.ApprovalRateLimited(
                    "approval password setting is rate limited"
                ) from None
            raise
        finally:
            approval_security.clear(current)
            approval_security.clear(replacement)
        self.sign_in.record_use(session, request)
        return self._redirect(PENDING_PATH, [])

    def _logout(self, request: Request) -> Response:
        self._origin(request)
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        values = self._form(request, {"csrf"})
        return self.sign_in.logout_response(session, values)

    def _devices(self, request: Request) -> Response:
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        csrf = self.sign_in.csrf_token(session)
        now = self.state.clock()
        rows = []
        for device in self.sign_in.devices(session):
            current = " <strong>This device</strong>" if device["current"] else ""
            rows.append(
                f"<li><strong>{html.escape(device['kind'])}</strong>{current}"
                f"<p>Signed in {_display_time(device['signedIn'], now)}<br>"
                f"Last used {_display_time(device['lastUsed'], now)}</p>"
                f"<form method=\"post\" action=\"{approval_security.DEVICE_SIGNOUT_PATH}\">"
                f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
                f"<input type=\"hidden\" name=\"deviceId\" value=\"{device['id']}\">"
                "<button type=\"submit\">Sign out</button></form></li>"
            )
        nonce = secrets.token_urlsafe(18)
        page = (
            _mobile_head("Devices", nonce) + "<body><main><h1>Devices</h1>"
            "<p>Signing out another device or everywhere requires you to have signed in with Google in the last 15 minutes.</p>"
            f"<p><a href=\"{PENDING_PATH}\">Settings</a> · <a href=\"{CHAT_PATH}\">Chat</a></p><ul>"
            + "".join(rows)
            + f"</ul><form method=\"post\" action=\"{approval_security.EVERYWHERE_PATH}\">"
            f"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
            "<button type=\"submit\">Sign out everywhere</button></form></main></body></html>"
        )
        self.sign_in.record_use(session, request)
        return self._response(200, page, style_nonce=nonce)

    def _device_end(self, request: Request, *, everywhere: bool) -> Response:
        self._origin(request)
        session = self._session(request)
        if session is None:
            return self._redirect(LOGIN_PATH, [])
        values = self._form(request, {"csrf"} if everywhere else {"csrf", "deviceId"})
        device_id = None
        if not everywhere:
            if re.fullmatch(r"[1-9][0-9]{0,17}", values["deviceId"]) is None:
                raise approval_security.ApprovalRefused("Captain device is invalid")
            device_id = int(values["deviceId"])
            if any(device["current"] and device["id"] == device_id for device in self.sign_in.devices(session)):
                return self.sign_in.logout_response(session, values)
        if not self.sign_in.check_csrf(session, values):
            raise approval_security.ApprovalRefused("approval csrf is invalid")
        fresh = self._fresh(session, approval_security.DEVICES_PATH)
        if fresh is not None:
            return fresh
        if not self.sign_in.sign_out_device(session, device_id):
            raise approval_security.ApprovalRefused("Captain device is invalid")
        if everywhere:
            return self.sign_in.signed_out_response()
        self.sign_in.record_use(session, request)
        return self._redirect(approval_security.DEVICES_PATH, [])

    def _signed_out(self) -> Response:
        nonce = secrets.token_urlsafe(18)
        page = (
            _mobile_head("Signed out", nonce)
            + "<body><main><h1>You are signed out</h1>"
            f"<form method=\"get\" action=\"{LOGIN_PATH}\"><button type=\"submit\">Sign in</button></form>"
            "</main></body></html>"
        )
        return self._response(200, page, style_nonce=nonce)

    def handle(self, request: Request) -> Response:
        try:
            caller = self._caller(request)
            parsed = urlsplit(request.path)
            if parsed.scheme or parsed.netloc or parsed.fragment:
                return self._response(404, "Not found")
            path = parsed.path
            if request.method == "GET" and path == LOGIN_PATH and not parsed.query:
                return self._login_start(request, caller)
            if request.method == "GET" and path == CALLBACK_PATH:
                return self._callback(request, caller)
            if request.method == "GET" and path == approval_security.STEP_UP_PATH:
                return self._step_up(request, caller, parsed.query)
            if parsed.query:
                return self._response(404, "Not found")
            if request.method == "GET" and path == approval_security.SIGNED_OUT_PATH:
                return self._signed_out()
            if request.method == "GET" and path == approval_security.DEVICES_PATH:
                return self._devices(request)
            if request.method == "POST" and path == approval_security.DEVICE_SIGNOUT_PATH:
                return self._device_end(request, everywhere=False)
            if request.method == "POST" and path == approval_security.EVERYWHERE_PATH:
                return self._device_end(request, everywhere=True)
            if request.method == "GET" and path == PENDING_PATH:
                return self._pending(request)
            if request.method == "POST" and path == APPROVE_PATH:
                return self._action(request, "approve", caller)
            if request.method == "POST" and path == REFUSE_PATH:
                return self._action(request, "refuse", caller)
            if request.method == "POST" and path == INVITE_CREATE_PATH:
                return self._invite_create(request)
            if request.method == "POST" and path == INVITE_CANCEL_PATH:
                return self._invite_cancel(request)
            if request.method == "POST" and path == PASSWORD_SETTINGS_PATH:
                return self._password_settings(request, caller)
            if request.method == "POST" and path == LOGOUT_PATH:
                return self._logout(request)
            return self._response(404, "Not found")
        except approval_security.ApprovalRateLimited:
            return self._refusal_page(429)
        except approval_security.ApprovalRefused:
            return self._response(403, "Request refused")
        except Exception:
            return self._response(503, "Request unavailable")
        finally:
            approval_security.clear(request.body)
