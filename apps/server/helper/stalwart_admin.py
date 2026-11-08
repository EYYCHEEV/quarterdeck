from __future__ import annotations

import copy
import re
from typing import Any, Protocol


BOT_NAME = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}\Z")
API_KEY = re.compile(rb"API_[A-Za-z0-9_-]{20,508}\Z")
ALLOWED_PERMISSIONS = (
    "authenticate",
    "emailReceive",
    "emailSend",
    "jmapEmailCreate",
    "jmapEmailGet",
    "jmapEmailQuery",
    "jmapEmailSubmissionCreate",
    "jmapEmailUpdate",
    "jmapIdentityGet",
    "jmapMailboxGet",
)
FORBIDDEN_PERMISSIONS = frozenset(
    {
        "admin",
        "administrator",
        "fetchAnyBlob",
        "impersonate",
        "unlimitedRequests",
        "unlimitedUploads",
    }
)
ACCOUNT_QUOTAS = {
    "maxDiskQuota": 268435456,
    "maxEmails": 10000,
    "maxMailboxes": 8,
    "maxEmailIdentities": 1,
    "maxEmailSubmissions": 1000,
    "maxApiKeys": 2,
    "maxAppPasswords": 0,
    "maxPublicKeys": 0,
}
EMPTY_PERMISSIONS = {
    "@type": "Replace",
    "enabledPermissions": {},
    "disabledPermissions": {},
}
ACTIVE_PERMISSIONS = {
    "@type": "Replace",
    "enabledPermissions": {permission: True for permission in ALLOWED_PERMISSIONS},
    "disabledPermissions": {},
}
EMPTY_KEY_PERMISSIONS = {
    "@type": "Replace",
    "permissions": {},
}
ACTIVE_KEY_PERMISSIONS = {
    "@type": "Replace",
    "permissions": {permission: True for permission in ALLOWED_PERMISSIONS},
}



class AdminRefused(RuntimeError):
    pass


class Transport(Protocol):
    def call(self, method: str, arguments: dict[str, Any], call_id: str) -> dict[str, Any]: ...


def members(value: object) -> set[str]:
    if isinstance(value, dict):
        return {key for key, enabled in value.items() if isinstance(key, str) and enabled is True}
    if isinstance(value, list):
        return {value for value in value if isinstance(value, str)}
    return set()


def _require(condition: bool) -> None:
    if not condition:
        raise AdminRefused("Stalwart administrator action refused")


def _permissions_are(value: object, active: bool) -> bool:
    if (
        not isinstance(value, dict)
        or set(value) != {"@type", "enabledPermissions", "disabledPermissions"}
        or value.get("@type") != "Replace"
    ):
        return False
    enabled = members(value.get("enabledPermissions"))
    disabled = members(value.get("disabledPermissions"))
    expected = set(ALLOWED_PERMISSIONS) if active else set()
    return (
        enabled == expected
        and not disabled
        and not enabled.intersection(FORBIDDEN_PERMISSIONS)
        and not any(permission.startswith("sys") for permission in enabled)
    )


def _key_permissions_are(value: object, active: bool) -> bool:
    if (
        not isinstance(value, dict)
        or set(value) != {"@type", "permissions"}
        or value.get("@type") != "Replace"
    ):
        return False
    enabled = members(value.get("permissions"))
    expected = set(ALLOWED_PERMISSIONS) if active else set()
    return (
        enabled == expected
        and not enabled.intersection(FORBIDDEN_PERMISSIONS)
        and not any(permission.startswith("sys") for permission in enabled)
    )


def _found_by_id(
    response: dict[str, Any],
    identifier: str,
) -> dict[str, Any] | None:
    values = response.get("list")
    not_found = response.get("notFound", [])
    _require(
        isinstance(values, list)
        and isinstance(not_found, list)
        and len(values) <= 1
    )
    if values:
        _require(
            not not_found
            and isinstance(values[0], dict)
            and values[0].get("id") == identifier
        )
        return values[0]
    _require(not_found == [identifier])
    return None


class StalwartAdmin:
    def __init__(self, transport: Transport, domain_name: str) -> None:
        _require(isinstance(domain_name, str) and domain_name and len(domain_name) <= 253)
        self.transport = transport
        self.domain_name = domain_name
        self._domain: str | None = None
        self._sequence = 0

    def _call(self, method: str, arguments: dict[str, Any], stem: str) -> dict[str, Any]:
        self._sequence += 1
        response = self.transport.call(method, arguments, f"{stem}-{self._sequence}")
        _require(isinstance(response, dict))
        return response

    def _domain_id(self) -> str:
        if self._domain is None:
            response = self._call("x:Domain/query", {"filter": {"name": self.domain_name}}, "domain-query")
            ids = response.get("ids")
            _require(isinstance(ids, list) and len(ids) == 1 and isinstance(ids[0], str) and bool(ids[0]))
            self._domain = ids[0]
        return self._domain

    def _account(self, account_id: str) -> dict[str, Any] | None:
        response = self._call(
            "x:Account/get",
            {
                "ids": [account_id],
                "properties": ["id", "name", "roles", "permissions", "quotas", "encryptionAtRest"],
            },
            "account-get",
        )
        return _found_by_id(response, account_id)

    def _key(self, account_id: str, key_id: str) -> dict[str, Any] | None:
        response = self._call(
            "x:ApiKey/get",
            {
                "accountId": account_id,
                "ids": [key_id],
                "properties": ["id", "description", "permissions", "allowedIps"],
            },
            "api-key-get",
        )
        return _found_by_id(response, key_id)

    @staticmethod
    def _changed(response: dict[str, Any], field: str, identifier: str) -> None:
        values = response.get(field)
        if isinstance(values, dict):
            changed = set(values)
        elif isinstance(values, list):
            changed = set(values)
        else:
            changed = set()
        _require(changed == {identifier})
        failure_field = {"created": "notCreated", "updated": "notUpdated", "destroyed": "notDestroyed"}[field]
        _require(not response.get(failure_field))

    def create_account(self, bot_name: str) -> str:
        _require(isinstance(bot_name, str) and BOT_NAME.fullmatch(bot_name) is not None)
        existing = self._call("x:Account/query", {"filter": {"name": bot_name}}, "account-query")
        _require(existing.get("ids") == [])
        value = {
            "@type": "User",
            "name": bot_name,
            "domainId": self._domain_id(),
            "description": "Quarterdeck restricted bot account",
            "credentials": {},
            "aliases": {},
            "memberGroupIds": {},
            "roles": {"@type": "User"},
            "permissions": copy.deepcopy(EMPTY_PERMISSIONS),
            "quotas": copy.deepcopy(ACCOUNT_QUOTAS),
            "encryptionAtRest": {"@type": "Disabled"},
        }
        response = self._call("x:Account/set", {"create": {"account": value}}, "account-create")
        created = response.get("created")
        _require(isinstance(created, dict) and set(created) == {"account"})
        record = created.get("account")
        _require(isinstance(record, dict) and isinstance(record.get("id"), str) and bool(record["id"]))
        _require(not response.get("notCreated"))
        return record["id"]

    def verify_account(self, account_id: str, bot_name: str, active: bool) -> None:
        value = self._account(account_id)
        _require(value is not None)
        _require(value.get("name") == bot_name)
        _require(value.get("roles") == {"@type": "User"})
        _require(_permissions_are(value.get("permissions"), active))
        _require(value.get("quotas") == ACCOUNT_QUOTAS)
        _require(value.get("encryptionAtRest") == {"@type": "Disabled"})
    def account_exists(self, account_id: str) -> bool:
        return self._account(account_id) is not None


    def destroy_account(self, account_id: str) -> None:
        _require(self._account(account_id) is not None)
        response = self._call(
            "x:Account/set",
            {"destroy": [account_id]},
            "account-destroy",
        )
        self._changed(response, "destroyed", account_id)
        _require(self._account(account_id) is None)

    def create_key(self, account_id: str) -> tuple[str, bytearray]:
        response = self._call(
            "x:ApiKey/set",
            {
                "accountId": account_id,
                "create": {
                    "key": {
                        "description": "Quarterdeck restricted bot credential",
                        "permissions": copy.deepcopy(EMPTY_KEY_PERMISSIONS),
                        "allowedIps": {},
                    }
                },
            },
            "api-key-create",
        )
        created = response.get("created")
        _require(isinstance(created, dict) and set(created) == {"key"} and not response.get("notCreated"))
        record = created.get("key")
        _require(isinstance(record, dict))
        key_id = record.get("id")
        secret = record.get("secret")
        _require(isinstance(key_id, str) and bool(key_id) and isinstance(secret, str))
        try:
            token = bytearray(secret.encode("ascii"))
        except (UnicodeEncodeError, ValueError) as error:
            self.force_revoke_key(account_id, key_id)
            raise AdminRefused("Stalwart administrator action refused") from error
        record["secret"] = ""
        secret = ""
        if API_KEY.fullmatch(token) is None:
            token[:] = b"\x00" * len(token)
            token.clear()
            self.force_revoke_key(account_id, key_id)
            raise AdminRefused("Stalwart administrator action refused")
        return key_id, token

    def verify_key(self, account_id: str, key_id: str, active: bool) -> None:
        value = self._key(account_id, key_id)
        _require(value is not None)
        _require(value.get("allowedIps") == {})
        _require(_key_permissions_are(value.get("permissions"), active))

    def _update_account_permissions(self, account_id: str, permissions: dict[str, Any], stem: str) -> None:
        response = self._call(
            "x:Account/set",
            {"update": {account_id: {"permissions": copy.deepcopy(permissions)}}},
            stem,
        )
        self._changed(response, "updated", account_id)

    def activate_account(self, account_id: str) -> None:
        self._update_account_permissions(account_id, ACTIVE_PERMISSIONS, "account-activate")

    def deactivate_account(self, account_id: str) -> None:
        self._update_account_permissions(account_id, EMPTY_PERMISSIONS, "account-deactivate")

    def _update_key_permissions(self, account_id: str, key_id: str, permissions: dict[str, Any], stem: str) -> None:
        response = self._call(
            "x:ApiKey/set",
            {
                "accountId": account_id,
                "update": {key_id: {"permissions": copy.deepcopy(permissions)}},
            },
            stem,
        )
        self._changed(response, "updated", key_id)

    def activate_key(self, account_id: str, key_id: str) -> None:
        self._update_key_permissions(
            account_id,
            key_id,
            ACTIVE_KEY_PERMISSIONS,
            "api-key-activate",
        )

    def revoke_key(self, account_id: str, key_id: str) -> None:
        _require(self._key(account_id, key_id) is not None)
        response = self._call(
            "x:ApiKey/set",
            {"accountId": account_id, "destroy": [key_id]},
            "api-key-revoke",
        )
        self._changed(response, "destroyed", key_id)
        _require(self._key(account_id, key_id) is None)

    def force_revoke_key(self, account_id: str, key_id: str) -> None:
        self.revoke_key(account_id, key_id)
