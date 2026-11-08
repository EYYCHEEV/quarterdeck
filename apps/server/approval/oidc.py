from __future__ import annotations

import base64
import hmac
import http.client
import json
import os
import re
import ssl
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, urlsplit

import approval_security

AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_HOST = "oauth2.googleapis.com"
TOKEN_PATH = "/token"
ISSUER = "https://accounts.google.com"
ID_TOKEN_ISSUERS = frozenset({ISSUER, "accounts.google.com"})
MAX_RESPONSE_BYTES = 8192
REPEATABLE_RESPONSE_HEADERS = frozenset({"vary"})
SAFE_CLIENT_ID = re.compile(r"[A-Za-z0-9._:-]{1,512}\Z")
SAFE_SUBJECT = re.compile(r"[^\x00-\x1f\x7f]{1,255}\Z")
SAFE_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\Z")


def _clear(value: bytearray | None) -> None:
    approval_security.clear(value)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_part(value: str) -> dict[str, Any]:
    if not isinstance(value, str) or not 1 <= len(value) <= 6144:
        raise approval_security.refusal("Google sign-in token is invalid", "claims")
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.b64decode(value + padding, altchars=b"-_", validate=True)
        document = json.loads(decoded)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        raise approval_security.refusal("Google sign-in token is invalid", "claims") from None
    if not isinstance(document, dict):
        raise approval_security.refusal("Google sign-in token is invalid", "claims")
    return document


class GoogleTokenTransport:
    def exchange(
        self, body: bytearray
    ) -> tuple[int, dict[str, str], bytearray]:
        connection = http.client.HTTPSConnection(
            TOKEN_HOST,
            443,
            timeout=15,
            context=ssl.create_default_context(),
        )
        try:
            connection.request(
                "POST",
                TOKEN_PATH,
                body=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
            )
            response = connection.getresponse()
            headers: dict[str, str] = {}
            for name, value in response.getheaders():
                lower = name.lower()
                if lower in headers:
                    if lower not in REPEATABLE_RESPONSE_HEADERS:
                        raise approval_security.refusal(
                            "Google sign-in response is invalid", "response-metadata"
                        )
                    headers[lower] += ", " + value
                    continue
                headers[lower] = value
            content = bytearray(response.read(MAX_RESPONSE_BYTES + 1))
            if len(content) > MAX_RESPONSE_BYTES:
                _clear(content)
                raise approval_security.refusal(
                    "Google sign-in response is invalid", "response-metadata"
                )
            return response.status, headers, content
        except approval_security.ApprovalRefused:
            raise
        except Exception as error:
            raise approval_security.refusal(
                "Google sign-in exchange failed", "transport-tls"
            ) from error
        finally:
            connection.close()


@dataclass(frozen=True, slots=True, repr=False)
class FreshIdentity:
    subject: str
    signed_in_at: float


class GoogleOidc:
    def __init__(
        self,
        *,
        client_id: str,
        client_secret: bytearray,
        allowed_email: str,
        redirect_uri: str,
        transport: Any | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if (
            not isinstance(client_id, str)
            or SAFE_CLIENT_ID.fullmatch(client_id) is None
            or not isinstance(client_secret, bytearray)
            or not 1 <= len(client_secret) <= 1024
            or not isinstance(allowed_email, str)
            or SAFE_EMAIL.fullmatch(allowed_email) is None
            or not isinstance(redirect_uri, str)
        ):
            raise approval_security.ApprovalRefused(
                "Google sign-in configuration is invalid"
            )
        parsed_redirect = urlsplit(redirect_uri)
        if (
            parsed_redirect.scheme != "https"
            or not parsed_redirect.hostname
            or parsed_redirect.path != "/captain/oidc/callback"
            or parsed_redirect.query
            or parsed_redirect.fragment
            or parsed_redirect.username is not None
            or parsed_redirect.password is not None
            or parsed_redirect.port not in {None, 443}
        ):
            raise approval_security.ApprovalRefused(
                "Google sign-in configuration is invalid"
            )
        self.client_id = client_id
        self.client_secret = client_secret
        self.allowed_email = allowed_email
        self.redirect_uri = redirect_uri
        self.transport = transport if transport is not None else GoogleTokenTransport()
        self.clock = clock

    def clear(self) -> None:
        _clear(self.client_secret)

    def authorization_url(self, *, state: str, nonce: str, challenge: str, step_up: bool = False) -> str:
        for value in (state, nonce, challenge):
            if not isinstance(value, str) or approval_security.TOKEN.fullmatch(value) is None:
                raise approval_security.ApprovalRefused(
                    "Google sign-in request is invalid"
                )
        query = urlencode(
            {
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "response_type": "code",
                "scope": "openid email",
                "state": state,
                "nonce": nonce,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "prompt": "select_account",
            }
        )
        return f"{AUTHORIZATION_ENDPOINT}?{query}"

    def _claims(self, id_token: object, nonce: str, *, auth_started: float) -> FreshIdentity:
        if not isinstance(id_token, str) or len(id_token) > 16_384:
            raise approval_security.refusal("Google sign-in token is invalid", "claims")
        parts = id_token.split(".")
        if len(parts) != 3 or not parts[2]:
            raise approval_security.refusal("Google sign-in token is invalid", "claims")
        header = _decode_part(parts[0])
        claims = _decode_part(parts[1])
        if header.get("alg") != "RS256" or header.get("typ") not in {None, "JWT"}:
            raise approval_security.refusal("Google sign-in token is invalid", "claims")
        audience = claims.get("aud")
        if isinstance(audience, str):
            audience_ok = hmac.compare_digest(audience, self.client_id)
        elif isinstance(audience, list) and all(isinstance(item, str) for item in audience):
            audience_ok = self.client_id in audience
            if len(audience) > 1:
                audience_ok = audience_ok and claims.get("azp") == self.client_id
        else:
            audience_ok = False
        if claims.get("azp") is not None and claims.get("azp") != self.client_id:
            audience_ok = False
        now = self.clock()
        expires = claims.get("exp")
        issued = claims.get("iat")
        valid_time = (
            isinstance(expires, (int, float))
            and not isinstance(expires, bool)
            and isinstance(issued, (int, float))
            and not isinstance(issued, bool)
            and expires > now
            and now - 600 <= issued <= now + 60
            and isinstance(auth_started, (int, float))
            and not isinstance(auth_started, bool)
            and 0 <= auth_started <= now
            and issued >= auth_started - 60
        )
        claim_nonce = claims.get("nonce")
        email = claims.get("email")
        subject = claims.get("sub")
        if (
            not isinstance(claims.get("iss"), str)
            or claims.get("iss") not in ID_TOKEN_ISSUERS
            or not audience_ok
            or not valid_time
            or not isinstance(claim_nonce, str)
            or not hmac.compare_digest(claim_nonce, nonce)
            or not isinstance(email, str)
            or not hmac.compare_digest(email, self.allowed_email)
            or claims.get("email_verified") is not True
            or not isinstance(subject, str)
            or SAFE_SUBJECT.fullmatch(subject) is None
        ):
            raise approval_security.refusal("Google sign-in was refused", "claims")
        return FreshIdentity(subject, float(min(issued, now)))

    def exchange_code(self, code: str, verifier: str, nonce: str, *, auth_started: float) -> FreshIdentity:
        if (
            not isinstance(code, str)
            or not 1 <= len(code) <= 4096
            or any(ord(character) < 0x20 for character in code)
            or not isinstance(verifier, str)
            or approval_security.TOKEN.fullmatch(verifier) is None
            or not isinstance(nonce, str)
            or approval_security.TOKEN.fullmatch(nonce) is None
        ):
            raise approval_security.refusal("Google sign-in request is invalid", "shape")
        body = bytearray(
            urlencode(
                {
                    "code": code,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret.decode("utf-8"),
                    "redirect_uri": self.redirect_uri,
                    "grant_type": "authorization_code",
                    "code_verifier": verifier,
                }
            ).encode("utf-8")
        )
        response = bytearray()
        try:
            value = self.transport.exchange(body)
            if (
                not isinstance(value, tuple)
                or len(value) != 3
                or not isinstance(value[0], int)
                or isinstance(value[0], bool)
                or not isinstance(value[1], dict)
                or any(
                    not isinstance(name, str) or not isinstance(item, str)
                    for name, item in value[1].items()
                )
                or not isinstance(value[2], bytearray)
            ):
                raise approval_security.refusal(
                    "Google sign-in response is invalid", "response-metadata"
                )
            status, headers, response = value
            lowered = {name.lower(): item for name, item in headers.items()}
            if status != 200:
                raise approval_security.refusal(
                    "Google sign-in response is invalid", "response-status"
                )
            if (
                not lowered.get("content-type", "").lower().startswith(
                    "application/json"
                )
                or "no-store"
                not in {
                    directive.strip().lower()
                    for directive in lowered.get("cache-control", "").split(",")
                }
                or len(response) > MAX_RESPONSE_BYTES
            ):
                raise approval_security.refusal(
                    "Google sign-in response is invalid", "response-metadata"
                )
            try:
                document = json.loads(response)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise approval_security.refusal(
                    "Google sign-in response is invalid", "response-metadata"
                ) from None
            if not isinstance(document, dict) or not isinstance(
                document.get("id_token"), str
            ):
                raise approval_security.refusal(
                    "Google sign-in response is invalid", "response-metadata"
                )
            return self._claims(document["id_token"], nonce, auth_started=auth_started)
        finally:
            _clear(body)
            _clear(response)


@dataclass(slots=True)
class OidcConfig:
    client_id: str
    client_secret: bytearray
    allowed_email: str
    redirect_uri: str
    session_key: bytearray

    def clear(self) -> None:
        _clear(self.client_secret)
        _clear(self.session_key)


def load_config(path: str | os.PathLike[str]) -> OidcConfig:
    source = Path(path)
    approval_security._private_directory(source.parent)
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise approval_security.ApprovalRefused(
                "Google sign-in configuration is unsafe"
            )
        content = os.read(descriptor, 16_385)
        if len(content) > 16_384:
            raise approval_security.ApprovalRefused(
                "Google sign-in configuration is invalid"
            )
    finally:
        os.close(descriptor)
    try:
        document = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise approval_security.ApprovalRefused(
            "Google sign-in configuration is invalid"
        ) from None
    if (
        not isinstance(document, dict)
        or set(document)
        != {
            "format",
            "clientId",
            "clientSecret",
            "allowedEmail",
            "redirectUri",
            "sessionKeyHex",
        }
        or document.get("format") != 1
        or any(
            not isinstance(document.get(name), str)
            for name in (
                "clientId",
                "clientSecret",
                "allowedEmail",
                "redirectUri",
                "sessionKeyHex",
            )
        )
    ):
        raise approval_security.ApprovalRefused(
            "Google sign-in configuration is invalid"
        )
    secret = bytearray(document["clientSecret"].encode("utf-8"))
    session_key = bytearray()
    try:
        try:
            session_key = bytearray.fromhex(document["sessionKeyHex"])
        except ValueError:
            raise approval_security.ApprovalRefused(
                "Google sign-in configuration is invalid"
            ) from None
        if len(session_key) != 32:
            raise approval_security.ApprovalRefused(
                "Google sign-in configuration is invalid"
            )
        config = OidcConfig(
            document["clientId"],
            secret,
            document["allowedEmail"],
            document["redirectUri"],
            session_key,
        )
        GoogleOidc(
            client_id=config.client_id,
            client_secret=bytearray(config.client_secret),
            allowed_email=config.allowed_email,
            redirect_uri=config.redirect_uri,
        ).clear()
        secret = bytearray()
        session_key = bytearray()
        return config
    finally:
        _clear(secret)
        _clear(session_key)
