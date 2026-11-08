from __future__ import annotations

import base64
import getpass
import hmac
import os
import sys
from pathlib import Path
from urllib.parse import quote, urlencode

import approval_security


SECRET_PATH = Path("/var/lib/quarterdeck-approval/secrets.json")


def main() -> int:
    if len(sys.argv) != 1:
        return 2
    os.umask(0o077)
    password: bytearray | None = None
    confirmation: bytearray | None = None
    totp_secret: bytearray | None = None
    session_key: bytearray | None = None
    try:
        password = bytearray(getpass.getpass("Captain approval password: ").encode("utf-8"))
        confirmation = bytearray(getpass.getpass("Confirm password: ").encode("utf-8"))
        if not 16 <= len(password) <= 256 or not hmac.compare_digest(password, confirmation):
            return 2
        salt = os.urandom(16)
        totp_secret = bytearray(os.urandom(20))
        session_key = bytearray(os.urandom(32))
        approval_security.write_enrollment(
            SECRET_PATH,
            password,
            salt=salt,
            totp_secret=totp_secret,
            session_key=session_key,
        )
        encoded_secret = base64.b32encode(totp_secret).decode("ascii").rstrip("=")
        label = quote("Quarterdeck:Captain", safe="")
        query = urlencode(
            {
                "secret": encoded_secret,
                "issuer": "Quarterdeck",
                "algorithm": "SHA1",
                "digits": "6",
                "period": "30",
            }
        )
        print(f"otpauth://totp/{label}?{query}", flush=True)
        print("Enrollment stored. Add the account to the Captain's phone now.", flush=True)
        return 0
    except (
        EOFError,
        KeyboardInterrupt,
        OSError,
        UnicodeError,
        approval_security.ApprovalRefused,
    ):
        return 2
    finally:
        approval_security.clear(password)
        approval_security.clear(confirmation)
        approval_security.clear(totp_secret)
        approval_security.clear(session_key)


if __name__ == "__main__":
    raise SystemExit(main())
