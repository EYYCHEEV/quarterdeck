from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import qd_jmap


class VerifyRefused(RuntimeError):
    pass


def _auth_refusal(error: Exception) -> bool:
    return str(error) in {"Stalwart answered HTTP 401", "Stalwart answered HTTP 403"}


def _credential(value: bytearray) -> qd_jmap.Credential:
    if not isinstance(value, bytearray):
        raise VerifyRefused("JMAP key proof refused")
    return qd_jmap.Credential(bytearray(value))


@dataclass
class OpenedClient:
    jmap: Any
    credential: Any

    def expect_refused(self) -> None:
        try:
            self.jmap.call(("Identity/get", {"ids": None}))
        except qd_jmap.MailFailed as error:
            if not _auth_refusal(error):
                raise VerifyRefused("open-client revocation proof refused") from error
        else:
            raise VerifyRefused("open client remained authorized")
        finally:
            self.credential.clear()


class JmapVerifier:
    def __init__(self, session_url: str, transport=None) -> None:
        self.session_url = qd_jmap.check_session_url(session_url)
        self.transport = transport if transport is not None else qd_jmap.HttpTransport()

    def expect_refused(self, token: bytearray) -> None:
        credential = _credential(token)
        try:
            qd_jmap.Jmap(self.session_url, credential, self.transport)
        except qd_jmap.MailFailed as error:
            if not _auth_refusal(error):
                raise VerifyRefused("inactive-key proof refused") from error
        else:
            raise VerifyRefused("inactive key was authorized")
        finally:
            credential.clear()

    def prove(self, token: bytearray) -> None:
        credential = _credential(token)
        try:
            jmap = qd_jmap.Jmap(self.session_url, credential, self.transport)
            identities, mailboxes = jmap.call(
                ("Identity/get", {"ids": None}),
                ("Mailbox/get", {"ids": None}),
            )
            identity_list = identities.get("list") if isinstance(identities, dict) else None
            mailbox_list = mailboxes.get("list") if isinstance(mailboxes, dict) else None
            roles = {
                value.get("role")
                for value in mailbox_list or []
                if isinstance(value, dict) and isinstance(value.get("role"), str)
            }
            if not isinstance(identity_list, list) or len(identity_list) != 1 or not {"inbox", "drafts", "sent"}.issubset(roles):
                raise VerifyRefused("active-key proof refused")
        except qd_jmap.MailFailed as error:
            raise VerifyRefused("active-key proof refused") from error
        finally:
            credential.clear()

    def open(self, token: bytearray) -> OpenedClient:
        credential = _credential(token)
        try:
            jmap = qd_jmap.Jmap(self.session_url, credential, self.transport)
            return OpenedClient(jmap, credential)
        except Exception:
            credential.clear()
            raise VerifyRefused("open-client setup refused")
