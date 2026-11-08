from __future__ import annotations

import base64
import json
import os
import stat
from pathlib import Path
from typing import Protocol


MAX_SECRET_BYTES = 512
MAX_RESPONSE_BYTES = 1048576
USING = (
    "urn:ietf:params:jmap:core",
    "urn:stalwart:jmap",
)



class ManagementRefused(RuntimeError):
    pass


class SecretReader(Protocol):
    def read(self) -> bytearray: ...


def clear(value: bytearray | None) -> None:
    if value is not None:
        value[:] = b"\x00" * len(value)
        value.clear()


class PrivateSecretFile:
    def __init__(self, path: str) -> None:
        if not os.path.isabs(path):
            raise ManagementRefused("management credential source refused")
        self.path = Path(path)

    def read(self) -> bytearray:
        descriptor = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        value = bytearray(MAX_SECRET_BYTES + 1)
        size = 0
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1
            ):
                raise ManagementRefused("management credential source refused")
            with memoryview(value) as view:
                while size <= MAX_SECRET_BYTES:
                    amount = os.readv(descriptor, [view[size:]])
                    if not amount:
                        break
                    size += amount
            if size == 0 or size > MAX_SECRET_BYTES or any(not 0x21 <= byte <= 0x7E for byte in value[:size]):
                raise ManagementRefused("management credential source refused")
            del value[size:]
            return value
        except Exception:
            clear(value)
            raise
        finally:
            os.close(descriptor)


class ManagementTransport:
    def __init__(self, username: str, secret_reader: SecretReader, connection_factory) -> None:
        try:
            encoded_username = username.encode("ascii")
        except (AttributeError, UnicodeEncodeError) as error:
            raise ManagementRefused("management username refused") from error
        if not encoded_username or b":" in encoded_username or any(not 0x21 <= byte <= 0x7E for byte in encoded_username):
            raise ManagementRefused("management username refused")
        if not callable(connection_factory):
            raise ManagementRefused("management connection factory refused")
        self.username = encoded_username
        self.secret_reader = secret_reader
        self.connection_factory = connection_factory

    def call(self, method: str, arguments: dict, call_id: str) -> dict:
        if not all(isinstance(value, str) and value and len(value) <= 128 for value in (method, call_id)):
            raise ManagementRefused("management request refused")
        body = json.dumps(
            {
                "using": USING,
                "methodCalls": [[method, arguments, call_id]],
            },
            separators=(",", ":"),
        ).encode("utf-8")
        if len(body) > MAX_RESPONSE_BYTES:
            raise ManagementRefused("management request refused")

        secret = None
        combined = None
        connection = None
        try:
            secret = self.secret_reader.read()
            if not isinstance(secret, bytearray) or not secret:
                raise ManagementRefused("management credential source refused")
            combined = bytearray(self.username)
            combined.extend(b":")
            combined.extend(secret)
            authorization = b"Basic " + base64.b64encode(combined)
            connection = self.connection_factory()
            connection.request(
                "POST",
                "/jmap",
                body=body,
                headers={"Authorization": authorization, "Content-Type": "application/json"},
            )
            response = connection.getresponse()
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if response.status != 200 or len(payload) > MAX_RESPONSE_BYTES:
                raise ManagementRefused("management API refused the request")
            try:
                document = json.loads(payload)
            except (TypeError, ValueError) as error:
                raise ManagementRefused("management API refused the request") from error
            responses = document.get("methodResponses") if isinstance(document, dict) else None
            if (
                not isinstance(responses, list)
                or len(responses) != 1
                or not isinstance(responses[0], list)
                or len(responses[0]) != 3
                or responses[0][0] != method
                or responses[0][2] != call_id
                or not isinstance(responses[0][1], dict)
            ):
                raise ManagementRefused("management API refused the request")
            return responses[0][1]
        except ManagementRefused:
            raise
        except Exception as error:
            raise ManagementRefused("management API refused the request") from error
        finally:
            if connection is not None:
                connection.close()
            clear(combined)
            clear(secret)
