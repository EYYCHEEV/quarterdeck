from __future__ import annotations

import hmac
import re
import threading
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

import approval_app
import approval_security
import oidc

COOKIE_NAME = "__Host-qd-approval"
LOGIN_COOKIE = "__Host-qd-login"
DEVICE_COOKIE = "__Host-qd-device"
CALLBACK_PATH = "/captain/oidc/callback"
RETURN_PATH_PREFIXES = ("/captain/",)
CONNECTOR_AUTHORIZE_PATH = "/oauth/authorize"
CALLBACK_REQUIRED = frozenset({"code", "state"})
CALLBACK_OPTIONAL = frozenset({"scope", "authuser", "prompt", "hd", "iss"})
GoogleOidc = oidc.GoogleOidc
load_oidc_config = oidc.load_config
_OUTCOME_STAGES = {
    "unknown-state": "state-binding-unknown-state",
    "no-cookie": "state-binding-no-cookie",
    "cookie-mismatch": "state-binding-cookie-mismatch",
}
_LOGIN_TARGET = re.compile(r"__Host-qd-login(?:$|[^!#$%&'*+\-.^_`|~0-9A-Za-z])")


def _login_browser(request: approval_app.Request) -> str | None:
    values = []
    malformed = False
    for pair in approval_app.ApprovalApplication._cookie_pairs(
        approval_app.ApprovalApplication._cookie_text(request)
    ):
        name, separator, value = pair.partition("=")
        if _LOGIN_TARGET.match(name):
            malformed = malformed or name != LOGIN_COOKIE or not separator
            values.append(value)
    if malformed or len(values) > 1:
        return "malformed"
    return values[0] if values and values[0] else None


@dataclass(frozen=True, slots=True)
class CaptainSession:
    _owner: bytes
    _authority: object
    _token: str

    def __repr__(self) -> str:
        return "CaptainSession(<authorized>)"


@dataclass(frozen=True, slots=True, repr=False)
class LoginReturn:
    next_path: str
    expires: float
    started: float
    device_hash: bytes | None
    kind: str
    step_up: bool
    replace_owner: bytes | None


def _device_kind(request: approval_app.Request | None) -> str:
    agent = "" if request is None else approval_app.ApprovalApplication._headers(request).get("user-agent", "")
    for device in ("iPhone", "iPad", "Mac"):
        if device in agent and "Safari" in agent and "Chrome" not in agent:
            return f"{device} Safari"
    if "Firefox" in agent:
        return "Firefox"
    return "Chrome" if "Chrome" in agent else "Other browser"


class _CaptainAuthority:
    def __init__(
        self,
        state: approval_security.ApprovalState,
        authenticator: Any,
    ) -> None:
        if not all(
            callable(getattr(authenticator, name, None))
            for name in ("authorization_url", "exchange_code")
        ):
            raise approval_security.ApprovalRefused(
                "Captain OIDC authority is invalid"
            )
        self.state = state
        self.authenticator = authenticator
        self.marker = object()
        self._lock = threading.Lock()
        self._returns: dict[str, LoginReturn] = {}

    def begin(self, next_path: str, request: approval_app.Request | None = None, *, step_up: bool = False) -> approval_app.Response:
        now = self.state.clock()
        device_hash = None
        cookies = []
        replace_owner = None
        if request is not None:
            handle = approval_app.ApprovalApplication._cookie(request, DEVICE_COOKIE)
            device_hash = self.state.device_verifier(handle)
            if device_hash is None:
                handle = self.state._token()
                device_hash = self.state.device_verifier(handle)
                cookies.append(device_cookie(handle))
            if step_up:
                session = self.require(request)
                replace_owner = None if session is None else session._owner
        started = self.state.begin_oidc()
        parameters = {"state": started.state, "nonce": started.nonce, "challenge": started.challenge}
        if step_up:
            parameters["step_up"] = True
        location = self.authenticator.authorization_url(**parameters)
        with self._lock:
            self._returns = {state: record for state, record in self._returns.items() if record.expires > now}
            self._returns[started.state] = LoginReturn(next_path, now + approval_security.OIDC_LIFETIME, now, device_hash, _device_kind(request), step_up, replace_owner)
        cookies.append(
            f"{LOGIN_COOKIE}={started.browser}; Path=/; Secure; "
            f"HttpOnly; SameSite=Lax; Max-Age={approval_security.OIDC_LIFETIME}"
        )
        return approval_app.ApprovalApplication._redirect(location, cookies)

    def consume_return(self, state: str, browser: str | None, device_hash: bytes | None = None) -> LoginReturn:
        with self._lock:
            outcome = self.state.consume_oidc_outcome(state, browser)
            record = None if outcome == "no-cookie" else self._returns.pop(state, None)
        if outcome != "bound":
            stage = _OUTCOME_STAGES.get(outcome, "state-binding-unknown-state")
        elif record is None or record.expires <= self.state.clock():
            stage = "state-binding-no-return"
        elif (record.device_hash is None) != (device_hash is None) or (
            record.device_hash is not None and not hmac.compare_digest(record.device_hash, device_hash)
        ):
            stage = "state-binding-cookie-mismatch"
        else:
            return record
        raise approval_security.refusal("Captain Google sign-in state is invalid", stage)

    def require(self, request: approval_app.Request) -> CaptainSession | None:
        token = approval_app.ApprovalApplication._cookie(
            request,
            COOKIE_NAME,
        )
        if token is None:
            return None
        owner = self.state.authorize_session(token)
        if owner is None:
            return None
        return CaptainSession(owner, self.marker, token)

    def owner(
        self,
        session: CaptainSession,
        *,
        current: bool = False,
    ) -> bytes | None:
        if (
            not isinstance(session, CaptainSession)
            or session._authority is not self.marker
        ):
            return None
        if current:
            owner = self.state.authorize_session(session._token)
            if owner is None or not hmac.compare_digest(
                owner,
                session._owner,
            ):
                return None
        return session._owner


_authority: _CaptainAuthority | None = None


def install(
    state: approval_security.ApprovalState,
    authenticator: Any,
) -> None:
    global _authority
    if _authority is not None or not isinstance(
        state,
        approval_security.ApprovalState,
    ):
        raise approval_security.ApprovalRefused(
            "Captain sign-in authority is invalid"
        )
    _authority = _CaptainAuthority(state, authenticator)


def _installed() -> _CaptainAuthority:
    if _authority is None:
        raise approval_security.ApprovalRefused(
            "Captain sign-in authority is unavailable"
        )
    return _authority


def require_captain(
    request: approval_app.Request,
) -> CaptainSession | None:
    if not isinstance(request, approval_app.Request):
        return None
    return _installed().require(request)

def _return_path(next_path: str) -> str:
    if (
        not isinstance(next_path, str)
        or not 1 <= len(next_path) <= 2048
        or "\\" in next_path
        or any(
            not 0x20 <= ord(character) <= 0x7E
            for character in next_path
        )
    ):
        raise approval_security.ApprovalRefused(
            "Captain login return path is invalid"
        )
    parsed = urlsplit(next_path)
    encoded_path = parsed.path.lower()
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or not parsed.path.startswith("/")
        or parsed.path.startswith("//")
        or "%2f" in encoded_path
        or "%5c" in encoded_path
        or not (
            parsed.path.startswith(RETURN_PATH_PREFIXES)
            or parsed.path == CONNECTOR_AUTHORIZE_PATH
        )
    ):
        raise approval_security.ApprovalRefused(
            "Captain login return path is invalid"
        )
    return next_path


def login_redirect(next_path: str, *, request: approval_app.Request | None = None) -> approval_app.Response:
    return _installed().begin(_return_path(next_path), request)


def step_up_redirect(next_path: str, *, request: approval_app.Request) -> approval_app.Response:
    if next_path not in {approval_app.CHAT_PATH, approval_app.PENDING_PATH, approval_security.DEVICES_PATH, "/captain/cards"}:
        raise approval_security.ApprovalRefused("fresh sign-in return is invalid")
    return _installed().begin(_return_path(next_path), request, step_up=True)


def oidc_callback(request: approval_app.Request) -> approval_app.Response:
    if not isinstance(request, approval_app.Request):
        raise approval_security.refusal(
            "Captain Google sign-in callback is invalid", "shape"
        )
    parsed = urlsplit(request.path)
    try:
        values = parse_qs(
            parsed.query,
            strict_parsing=True,
            keep_blank_values=True,
        )
    except ValueError:
        values = {}
    authority = _installed()
    device_hash = authority.state.device_verifier(approval_app.ApprovalApplication._cookie(request, DEVICE_COOKIE))
    browser = _login_browser(request)
    state_values = parse_qs(parsed.query).get("state", [])
    if (
        request.method != "GET"
        or parsed.path != CALLBACK_PATH
        or parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or not CALLBACK_REQUIRED <= set(values)
        or not set(values) <= CALLBACK_REQUIRED | CALLBACK_OPTIONAL
        or any(len(items) != 1 or not items[0] for items in values.values())
        or ("iss" in values and values["iss"][0] != oidc.ISSUER)
    ):
        if len(state_values) == 1:
            try:
                authority.consume_return(state_values[0], browser, device_hash)
            except approval_security.ApprovalRefused:
                pass
        raise approval_security.refusal(
            "Captain Google sign-in callback is invalid", "shape"
        )
    code = values["code"][0]
    state = values["state"][0]
    material = authority.state.oidc_material(state)
    record = authority.consume_return(state, browser, device_hash)
    identity = authority.authenticator.exchange_code(code, material.verifier, material.nonce, auth_started=record.started)
    if not isinstance(identity, oidc.FreshIdentity):
        raise approval_security.refusal("Captain Google sign-in was refused", "claims")
    session = authority.state.start_browser_session(identity.subject, device_hash=record.device_hash, kind=record.kind, fresh_from=identity.signed_in_at, replace_owner=record.replace_owner)
    if session is None:
        raise approval_security.refusal(
            "Captain Google sign-in was refused", "session-policy"
        )
    return approval_app.ApprovalApplication._redirect(
        _return_path(record.next_path),
        [
            f"{LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; "
            "SameSite=Lax; Max-Age=0",
            session_cookie(session.token),
            device_cookie(session.device_handle),
        ],
    )

def device_cookie(handle: str) -> str:
    if not isinstance(handle, str) or len(handle) != 43 or approval_security.TOKEN.fullmatch(handle) is None:
        raise approval_security.ApprovalRefused("Captain device handle is invalid")
    return f"{DEVICE_COOKIE}={handle}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={approval_security.SESSION_ABSOLUTE}"



def session_cookie(token: str) -> str:
    if (
        not isinstance(token, str)
        or approval_security.TOKEN.fullmatch(token) is None
    ):
        raise approval_security.ApprovalRefused(
            "Captain session token is invalid"
        )
    return (
        f"{COOKIE_NAME}={token}; Path=/; Secure; HttpOnly; "
        f"SameSite=Lax; Max-Age={approval_security.SESSION_ABSOLUTE}"
    )


def csrf_token(session: CaptainSession) -> str:
    authority = _installed()
    owner = authority.owner(session)
    if owner is None:
        raise approval_security.ApprovalRefused(
            "Captain session is invalid"
        )
    return authority.state.issue_csrf(owner)


def check_csrf(session: CaptainSession, form: Any) -> bool:
    authority = _installed()
    owner = authority.owner(session, current=True)
    if owner is None or not isinstance(form, dict):
        return False
    token = form.get("csrf")
    if not isinstance(token, str):
        return False
    return authority.state.consume_csrf(owner, token)


def logout_response(
    session: CaptainSession,
    form: Any,
) -> approval_app.Response:
    authority = _installed()
    if not check_csrf(session, form):
        raise approval_security.ApprovalRefused(
            "Captain logout CSRF is invalid"
        )
    owner = authority.owner(session)
    if owner is None:
        raise approval_security.ApprovalRefused(
            "Captain session is invalid"
        )
    authority.state.revoke_session(owner)
    return signed_out_response()


def signed_out_response() -> approval_app.Response:
    response = approval_app.ApprovalApplication._redirect(
        "/captain/signed-out",
        [
            f"{COOKIE_NAME}=; Path=/; Secure; HttpOnly; "
            "SameSite=Lax; Max-Age=0",
            f"{DEVICE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        ],
    )
    headers = list(response.headers)
    headers.append(("Clear-Site-Data", '"storage"'))
    return approval_app.Response(
        response.status,
        tuple(headers),
        response.body,
    )


def fresh_until(session: CaptainSession) -> float:
    authority = _installed()
    owner = authority.owner(session)
    if owner is None:
        raise approval_security.ApprovalRefused("Captain session is invalid")
    return authority.state.fresh_until(owner)


def record_use(session: CaptainSession, request: approval_app.Request) -> None:
    authority = _installed()
    owner = authority.owner(session)
    if owner is None:
        raise approval_security.ApprovalRefused("Captain session is invalid")
    if approval_security.activity_allowed(request.method, request.path, request.headers):
        if not authority.state.touch_session(owner):
            raise approval_security.ApprovalRefused("Captain session is invalid")


def devices(session: CaptainSession) -> list[dict[str, object]]:
    authority = _installed()
    owner = authority.owner(session)
    if owner is None:
        raise approval_security.ApprovalRefused("Captain session is invalid")
    return authority.state.devices(owner)


def sign_out_device(session: CaptainSession, device_id: int | None = None) -> bool:
    authority = _installed()
    owner = authority.owner(session)
    if owner is None:
        raise approval_security.ApprovalRefused("Captain session is invalid")
    return authority.state.revoke_device(owner, device_id)
