from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import os
import re
import stat
import sys
import zipfile
from pathlib import Path


PINS = {
    "golive/connect/qd.py": "7e418dad9dd02a3016e19182af242e13300b847a71350706280f7c507ecfa020",
    "golive/connect/qd_connect.py": "8c149eb3f5f70d33d71e0db7cb8042446b1c7bbd315163b9a2d1fbfd8470e2ce",
    "golive/connect/qd_mcp.py": "0c3fc170530b8c0f378237c6ce6d93d2af08d74ad0e4a1b551f925d73c0e3f8a",
    "mail/qd_jmap.py": "dae5a8b1a3e0d8bfb67736ccd99b005af29d216641da5e0a674954ecccc4f6be",
    "signup/signup_flow.py": "39075e208e70f39f7d460e40677f0c2af7b6caced30490adc80a94e149a882ec",
    "signup/helper_contract.py": "15b688cbcfde84bbbd0418fc5ac8606ab3a92acb651fa9bec0d9716cf8a55c1f",
    "signup/adapter_registry.py": "26dd59aebc5f1ee1e35e934e87bfccd4c4b5e2cf3397a38d050f1ef5839a4265",
    "signup/file_v1_adapter.py": "a6ea5a3c979c7477cea4f109f58b18809117b310065eca8ce8fb01ee46f845f6",
}
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
TIMESTAMP = (1980, 1, 1, 0, 0, 0)
FILE_MODE = stat.S_IFREG | 0o644


class BuildRefused(RuntimeError):
    pass


def hashed(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest())
    return "sha256=" + encoded.rstrip(b"=").decode("ascii")


def zip_info(name: str) -> zipfile.ZipInfo:
    information = zipfile.ZipInfo(name, TIMESTAMP)
    information.create_system = 3
    information.compress_type = zipfile.ZIP_STORED
    information.external_attr = FILE_MODE << 16
    return information


def source_payloads(source_root: Path) -> dict[str, bytes]:
    payloads = {}
    for relative, expected in PINS.items():
        try:
            data = (source_root / relative).read_bytes()
        except OSError as error:
            raise BuildRefused("accepted client file is unavailable") from error
        if hashlib.sha256(data).hexdigest() != expected:
            raise BuildRefused("accepted client hash mismatch")
        module = Path(relative).name
        if module in payloads:
            raise BuildRefused("accepted client module name is duplicated")
        payloads[module] = data
    return payloads


def metadata_payloads(version: str) -> dict[str, bytes]:
    dist_info = f"quarterdeck_mcp-{version}.dist-info"
    return {
        f"{dist_info}/METADATA": (
            "Metadata-Version: 2.4\n"
            "Name: quarterdeck-mcp\n"
            f"Version: {version}\n"
            "Summary: Quarterdeck QD MCP and connect client\n"
            "Requires-Python: >=3.11\n"
            "\n"
        ).encode("utf-8"),
        f"{dist_info}/WHEEL": (
            "Wheel-Version: 1.0\n"
            "Generator: quarterdeck-reproducible-wheel\n"
            "Root-Is-Purelib: true\n"
            "Tag: py3-none-any\n"
            "\n"
        ).encode("utf-8"),
        f"{dist_info}/entry_points.txt": (
            "[console_scripts]\n"
            "qd = qd:main\n"
            "qd-file-v1 = file_v1_adapter:main\n"
            "qd-mcp = qd_mcp:main\n"
        ).encode("utf-8"),
    }


def record_payload(payloads: dict[str, bytes], record_name: str) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    for name, data in payloads.items():
        writer.writerow((name, hashed(data), len(data)))
    writer.writerow((record_name, "", ""))
    return output.getvalue().encode("utf-8")


def build(source_root: Path, version: str, output: Path) -> Path:
    if VERSION.fullmatch(version) is None:
        raise BuildRefused("wheel version is invalid")
    if not output.is_dir():
        raise BuildRefused("wheel output directory is unavailable")
    payloads = source_payloads(source_root)
    payloads.update(metadata_payloads(version))
    dist_info = f"quarterdeck_mcp-{version}.dist-info"
    record_name = f"{dist_info}/RECORD"
    payloads[record_name] = record_payload(payloads, record_name)
    wheel = output / f"quarterdeck_mcp-{version}-py3-none-any.whl"
    if wheel.exists():
        raise BuildRefused("wheel output already exists")
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in payloads.items():
            archive.writestr(zip_info(name), data)
    try:
        descriptor = os.open(
            wheel,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
            0o644,
        )
        with os.fdopen(descriptor, "wb") as target:
            target.write(archive_bytes.getbuffer())
    except OSError as error:
        raise BuildRefused("wheel output could not be written") from error
    return wheel


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="build_wheel.py")
    result.add_argument("--source-root", required=True, type=Path)
    result.add_argument("--version", required=True)
    result.add_argument("--output", required=True, type=Path)
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    try:
        wheel = build(
            arguments.source_root,
            arguments.version,
            arguments.output,
        )
    except BuildRefused as error:
        print(str(error), file=sys.stderr)
        return 2
    print(wheel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
