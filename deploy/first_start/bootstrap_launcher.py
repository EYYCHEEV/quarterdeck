from __future__ import annotations

import base64
import http.client
import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Sequence


MAX_OUTPUT_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 1_048_576
MAX_SECRET_BYTES = 512
READY_TIMEOUT_SECONDS = 30
STOP_TIMEOUT_SECONDS = 30
CLOSED_TIMEOUT_SECONDS = 5
PASSWORD = re.compile(br"password:\s*([A-Za-z0-9_-]{16,128})\b")
LOOPBACK = "127.0.0.1"


class BootstrapError(RuntimeError):
    pass


def _clear(value: bytearray) -> None:
    for index in range(len(value)):
        value[index] = 0


def _write_all(descriptor: int, value: bytearray) -> None:
    offset = 0
    while offset < len(value):
        written = os.write(descriptor, value[offset:])
        if written <= 0:
            raise BootstrapError("private credential write did not progress")
        offset += written


def _child_environment(port: int) -> dict[str, str]:
    if not 1024 <= port <= 65535:
        raise BootstrapError("bootstrap port is outside the unprivileged range")
    return {
        "PATH": "/usr/bin:/usr/sbin",
        "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
        "STALWART_RECOVERY_MODE_PORT": str(port),
        "STALWART_RECOVERY_MODE_LOG_LEVEL": "info",
    }


def _read_request(path: str) -> bytes:
    if not os.path.isabs(path):
        raise BootstrapError("bootstrap request path must be absolute")
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise BootstrapError("bootstrap request path is unsafe")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        body = os.read(descriptor, MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES or os.read(descriptor, 1):
            raise BootstrapError("bootstrap request exceeds its size bound")
    finally:
        os.close(descriptor)
    try:
        request = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BootstrapError("bootstrap request is invalid") from error
    calls = request.get("methodCalls") if isinstance(request, dict) else None
    if not isinstance(calls, list) or len(calls) != 1:
        raise BootstrapError("bootstrap request method is invalid")
    call = calls[0]
    if not isinstance(call, list) or len(call) != 3:
        raise BootstrapError("bootstrap request method is invalid")
    method, arguments, call_id = call
    settings = (
        arguments.get("update", {}).get("singleton")
        if isinstance(arguments, dict)
        else None
    )
    if (
        method != "x:Bootstrap/set"
        or call_id != "bootstrap"
        or not isinstance(settings, dict)
        or settings.get("requestTlsCertificate") is not False
        or settings.get("generateDkimKeys") is not False
    ):
        raise BootstrapError("bootstrap request policy is invalid")
    lowered = body.lower()
    if any(marker in lowered for marker in (b"password", b"secret", b"api_")):
        raise BootstrapError("bootstrap request contains a credential field")
    return body


def _capture(
    pipe: Any,
    buffer: bytearray,
    lock: threading.Lock,
    overflow: threading.Event,
) -> None:
    while chunk := pipe.read1(4096):
        with lock:
            remaining = MAX_OUTPUT_BYTES - len(buffer)
            if remaining > 0:
                buffer.extend(chunk[:remaining])
            if len(chunk) > remaining:
                overflow.set()


def _default_listener_probe(port: int) -> bool:
    try:
        connection = socket.create_connection((LOOPBACK, port), timeout=0.2)
    except OSError:
        return False
    connection.close()
    return True


def _wait_ready(
    process: Any,
    stderr_buffer: bytearray,
    lock: threading.Lock,
    overflow: threading.Event,
    port: int,
    listener_probe: Callable[[int], bool],
) -> bytearray:
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise BootstrapError("bootstrap child exited before readiness")
        if overflow.is_set():
            raise BootstrapError("bootstrap child output exceeded its size bound")
        with lock:
            match = PASSWORD.search(bytes(stderr_buffer))
        if match is not None and listener_probe(port):
            return bytearray(match.group(1))
        time.sleep(0.05)
    raise BootstrapError("bootstrap readiness timed out")


def _bootstrap_request(
    body: bytes,
    temporary_password: bytearray,
    port: int,
    connection_factory: Callable[..., Any],
) -> tuple[str, bytearray]:
    credential = bytearray(b"admin:")
    credential.extend(temporary_password)
    encoded = bytearray(base64.b64encode(credential))
    _clear(credential)
    authorization = "Basic " + encoded.decode("ascii")
    _clear(encoded)
    connection = connection_factory(LOOPBACK, port, timeout=15)
    try:
        connection.request(
            "POST",
            "/jmap",
            body=body,
            headers={
                "Authorization": authorization,
                "Content-Type": "application/json",
            },
        )
        response = connection.getresponse()
        payload = response.read(MAX_RESPONSE_BYTES + 1)
        status = response.status
    finally:
        authorization = ""
        connection.close()
    if status != 200 or len(payload) > MAX_RESPONSE_BYTES:
        raise BootstrapError("bootstrap API refused the request")
    try:
        parsed = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BootstrapError("bootstrap API response is invalid") from error
    calls = parsed.get("methodResponses") if isinstance(parsed, dict) else None
    if not isinstance(calls, list) or len(calls) != 1:
        raise BootstrapError("bootstrap API response is invalid")
    method, result, call_id = calls[0]
    account = (
        result.get("updated", {}).get("singleton")
        if isinstance(result, dict)
        else None
    )
    username = account.get("username") if isinstance(account, dict) else None
    secret = account.get("secret") if isinstance(account, dict) else None
    if (
        method != "x:Bootstrap/set"
        or call_id != "bootstrap"
        or result.get("notUpdated")
        or not isinstance(username, str)
        or not username
        or not isinstance(secret, str)
        or not secret
    ):
        raise BootstrapError("bootstrap API did not return one administrator")
    try:
        secret_bytes = bytearray(secret.encode("ascii"))
    except UnicodeEncodeError as error:
        raise BootstrapError("bootstrap administrator is invalid") from error
    if (
        len(secret_bytes) > MAX_SECRET_BYTES
        or any(not 0x21 <= byte <= 0x7E for byte in secret_bytes)
    ):
        _clear(secret_bytes)
        raise BootstrapError("bootstrap administrator is invalid")
    return username, secret_bytes


def _write_administrator(path: str, secret: bytearray) -> None:
    if not os.path.isabs(path):
        raise BootstrapError("administrator path must be absolute")
    parent = os.path.dirname(path)
    directory = os.lstat(parent)
    if (
        not stat.S_ISDIR(directory.st_mode)
        or stat.S_IMODE(directory.st_mode) != 0o700
        or directory.st_uid != os.getuid()
    ):
        raise BootstrapError("helper-only administrator directory is unsafe")
    if (
        not secret
        or len(secret) > MAX_SECRET_BYTES
        or any(not 0x21 <= byte <= 0x7E for byte in secret)
    ):
        raise BootstrapError("bootstrap administrator is invalid")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        _write_all(descriptor, secret)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    parent_descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)
    metadata = os.lstat(path)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
    ):
        raise BootstrapError("administrator file metadata is unsafe")


def _stop_cleanly(process: Any) -> None:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
    try:
        return_code = process.wait(timeout=STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.wait(timeout=5)
        raise BootstrapError("bootstrap child did not stop cleanly") from error
    if return_code != 0:
        raise BootstrapError("bootstrap child did not stop cleanly")


def _wait_closed(port: int, listener_probe: Callable[[int], bool]) -> None:
    deadline = time.monotonic() + CLOSED_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not listener_probe(port):
            return
        time.sleep(0.05)
    raise BootstrapError("bootstrap listener remained open")


def run(
    request_path: str,
    administrator_path: str,
    expected_username: str,
    port: int,
    program: Sequence[str],
    *,
    process_factory: Callable[..., Any] = subprocess.Popen,
    connection_factory: Callable[..., Any] = http.client.HTTPConnection,
    listener_probe: Callable[[int], bool] = _default_listener_probe,
) -> None:
    if not program or not os.path.isabs(program[0]):
        raise BootstrapError("bootstrap program path must be absolute")
    try:
        encoded_username = expected_username.encode("ascii")
    except (AttributeError, UnicodeEncodeError) as error:
        raise BootstrapError("expected administrator username is invalid") from error
    if (
        not encoded_username
        or b":" in encoded_username
        or any(not 0x21 <= byte <= 0x7E for byte in encoded_username)
    ):
        raise BootstrapError("expected administrator username is invalid")
    body = _read_request(request_path)
    environment = _child_environment(port)
    process = process_factory(
        list(program),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    stdout_buffer = bytearray()
    stderr_buffer = bytearray()
    lock = threading.Lock()
    overflow = threading.Event()
    threads = [
        threading.Thread(
            target=_capture,
            args=(process.stdout, stdout_buffer, lock, overflow),
            daemon=True,
        ),
        threading.Thread(
            target=_capture,
            args=(process.stderr, stderr_buffer, lock, overflow),
            daemon=True,
        ),
    ]
    for thread in threads:
        thread.start()

    temporary_password = bytearray()
    permanent_secret = bytearray()
    stopped = False
    try:
        temporary_password = _wait_ready(
            process,
            stderr_buffer,
            lock,
            overflow,
            port,
            listener_probe,
        )
        username, permanent_secret = _bootstrap_request(
            body,
            temporary_password,
            port,
            connection_factory,
        )
        _clear(temporary_password)
        _write_administrator(administrator_path, permanent_secret)
        _clear(permanent_secret)
        if username != expected_username:
            raise BootstrapError("administrator username mismatch")
        _stop_cleanly(process)
        stopped = True
        for thread in threads:
            thread.join(timeout=2)
        _wait_closed(port, listener_probe)
        if overflow.is_set():
            raise BootstrapError("bootstrap child output exceeded its size bound")
    finally:
        _clear(temporary_password)
        _clear(permanent_secret)
        if not stopped and process.poll() is None:
            try:
                _stop_cleanly(process)
            except BootstrapError:
                pass
        for thread in threads:
            thread.join(timeout=2)
        _clear(stdout_buffer)
        _clear(stderr_buffer)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 7 or args[4] != "--":
        raise BootstrapError(
            "expected REQUEST ADMIN_FILE USERNAME PORT -- PROGRAM [ARG ...]"
        )
    request_path, administrator_path, username, port_text, _, *program = args
    run(
        request_path,
        administrator_path,
        username,
        int(port_text, 10),
        program,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("bootstrap launcher failed safely\n")
        raise SystemExit(1)
