import base64
import contextlib
import io
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "helper"))
sys.path.insert(0, str(ROOT.parent / "containers"))

import layout
import management_transport
import bootstrap_launcher


TEMPORARY_STANDIN = "T" * 43
PERMANENT_STANDIN = "P" * 43


class FakeResponse:
    status = 200

    def __init__(self, username="admin@example.invalid"):
        self.username = username

    def read(self, _limit):
        return json.dumps(
            {
                "methodResponses": [
                    [
                        "x:Bootstrap/set",
                        {
                            "updated": {
                                "singleton": {
                                    "username": self.username,
                                    "secret": PERMANENT_STANDIN,
                                }
                            }
                        },
                        "bootstrap",
                    ]
                ]
            },
            separators=(",", ":"),
        ).encode("ascii")


class FakeConnection:
    def __init__(self, username="admin@example.invalid"):
        self.request_call = None
        self.closed = False
        self.username = username

    def request(self, method, path, *, body, headers):
        self.request_call = (method, path, body, headers)

    def getresponse(self):
        return FakeResponse(self.username)

    def close(self):
        self.closed = True


class FakeManagementResponse:
    status = 200

    def read(self, _limit):
        return b'{"methodResponses":[["Core/echo",{},"contract"]]}'


class FakeManagementConnection:
    def __init__(self):
        self.headers = None

    def request(self, method, path, *, body, headers):
        self.headers = headers

    def getresponse(self):
        return FakeManagementResponse()

    def close(self):
        pass


class PartialPipe:
    def __init__(self, *chunks):
        self.chunks = iter((*chunks, b""))

    def read(self, _size):
        raise AssertionError("full buffered read would wait for EOF")

    def read1(self, _size):
        return next(self.chunks)


class FakeProcess:
    def __init__(self):
        self.stdout = io.BytesIO(b"bootstrap starting\n")
        self.stderr = io.BytesIO(
            f"temporary administrator password: {TEMPORARY_STANDIN}\n".encode(
                "ascii"
            )
        )
        self.returncode = None
        self.signals = []

    def poll(self):
        return self.returncode

    def send_signal(self, value):
        self.signals.append(value)
        self.returncode = 0

    def wait(self, timeout):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("standin", timeout)
        return self.returncode

    def kill(self):
        self.returncode = -signal.SIGKILL


class BootstrapLauncherTests(unittest.TestCase):
    def test_capture_consumes_partial_pipe_reads_without_waiting_for_eof(self):
        buffer = bytearray()
        overflow = bootstrap_launcher.threading.Event()
        bootstrap_launcher._capture(
            PartialPipe(b"first", b"-second"),
            buffer,
            bootstrap_launcher.threading.Lock(),
            overflow,
        )
        self.assertEqual(buffer, b"first-second")
        self.assertFalse(overflow.is_set())

    def test_one_service_keeps_credentials_out_of_metadata_and_logs(self):
        request = {
            "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
            "methodCalls": [
                [
                    "x:Bootstrap/set",
                    {
                        "update": {
                            "singleton": {
                                "requestTlsCertificate": False,
                                "generateDkimKeys": False,
                            }
                        }
                    },
                    "bootstrap",
                ]
            ],
        }
        policy = json.loads(
            (ROOT.parent / "door" / "door-policy.json").read_text(
                encoding="utf-8"
            )
        )
        helper_runtime = layout.render_configuration(
            json.loads(
                (
                    ROOT.parent / "helper" / "runtime-config.template.json"
                ).read_text(encoding="utf-8")
            ),
            policy,
        )
        expected_username = helper_runtime["management"]["username"]
        self.assertEqual(
            helper_runtime["paths"]["adminSecret"],
            "/run/quarterdeck-admin/credential",
        )
        process = FakeProcess()
        process_call = {}
        connection = FakeConnection(expected_username)

        def process_factory(args, **kwargs):
            process_call["args"] = args
            process_call["kwargs"] = kwargs
            return process

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request_path = root / "bootstrap-request.json"
            request_path.write_text(
                json.dumps(request, separators=(",", ":")), encoding="ascii"
            )
            admin_directory = root / "helper-admin"
            admin_directory.mkdir(mode=0o700)
            admin_path = admin_directory / "credential"
            output = io.StringIO()
            errors = io.StringIO()

            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                bootstrap_launcher.run(
                    str(request_path),
                    str(admin_path),
                    expected_username,
                    18080,
                    ["/usr/local/bin/stalwart", "--config", "/etc/stalwart/config.json"],
                    process_factory=process_factory,
                    connection_factory=lambda _host, _port, timeout: connection,
                    listener_probe=lambda _port: process.poll() is None,
                )

            metadata = admin_path.lstat()
            self.assertTrue(stat.S_ISREG(metadata.st_mode))
            self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
            self.assertEqual(metadata.st_uid, os.getuid())
            self.assertEqual(metadata.st_nlink, 1)
            self.assertEqual(
                admin_path.read_bytes(),
                PERMANENT_STANDIN.encode("ascii"),
            )
            self.assertEqual(
                {path.name for path in admin_directory.iterdir()}, {"credential"}
            )
            reader = management_transport.PrivateSecretFile(str(admin_path))
            readback = reader.read()
            self.assertEqual(readback, bytearray(PERMANENT_STANDIN, "ascii"))
            management_transport.clear(readback)
            management_connection = FakeManagementConnection()
            management = management_transport.ManagementTransport(
                expected_username,
                reader,
                connection_factory=lambda: management_connection,
            )
            self.assertEqual(
                management.call("Core/echo", {}, "contract"),
                {},
            )
            decoded = base64.b64decode(
                management_connection.headers["Authorization"].removeprefix(
                    b"Basic "
                )
            )
            self.assertEqual(
                decoded,
                (
                    expected_username + ":" + PERMANENT_STANDIN
                ).encode("ascii"),
            )

        args = process_call["args"]
        kwargs = process_call["kwargs"]
        metadata_text = repr((args, kwargs.get("env")))
        self.assertNotIn(TEMPORARY_STANDIN, metadata_text)
        self.assertNotIn(PERMANENT_STANDIN, metadata_text)
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(kwargs["stderr"], subprocess.PIPE)
        self.assertEqual(
            set(kwargs["env"]),
            {
                "PATH",
                "SSL_CERT_FILE",
                "STALWART_RECOVERY_MODE_PORT",
                "STALWART_RECOVERY_MODE_LOG_LEVEL",
            },
        )
        self.assertEqual(process.signals, [signal.SIGTERM])
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")

        method, path, body, headers = connection.request_call
        self.assertEqual((method, path), ("POST", "/jmap"))
        self.assertEqual(json.loads(body), request)
        self.assertIn("Authorization", headers)
        self.assertNotIn(TEMPORARY_STANDIN, repr(headers))
        self.assertNotIn(PERMANENT_STANDIN, repr(headers))
        self.assertTrue(connection.closed)

    def test_username_mismatch_stops_after_preserving_the_raw_secret(self):
        request = {
            "methodCalls": [
                [
                    "x:Bootstrap/set",
                    {
                        "update": {
                            "singleton": {
                                "requestTlsCertificate": False,
                                "generateDkimKeys": False,
                            }
                        }
                    },
                    "bootstrap",
                ]
            ]
        }
        process = FakeProcess()
        connection = FakeConnection("unexpected-admin")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request_path = root / "bootstrap-request.json"
            request_path.write_text(
                json.dumps(request, separators=(",", ":")), encoding="ascii"
            )
            admin_directory = root / "helper-admin"
            admin_directory.mkdir(mode=0o700)
            admin_path = admin_directory / "credential"

            with self.assertRaisesRegex(
                bootstrap_launcher.BootstrapError,
                "administrator username mismatch",
            ):
                bootstrap_launcher.run(
                    str(request_path),
                    str(admin_path),
                    "quarterdeck-admin",
                    18080,
                    [
                        "/usr/local/bin/stalwart",
                        "--config",
                        "/etc/stalwart/config.json",
                    ],
                    process_factory=lambda _args, **_kwargs: process,
                    connection_factory=lambda _host, _port, timeout: connection,
                    listener_probe=lambda _port: process.poll() is None,
                )

            self.assertEqual(
                admin_path.read_bytes(),
                PERMANENT_STANDIN.encode("ascii"),
            )
            self.assertEqual(process.signals, [signal.SIGTERM])


if __name__ == "__main__":
    unittest.main(verbosity=2)
