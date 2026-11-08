from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from urllib.parse import urlsplit


VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[a-z0-9.-]+)?\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
INVITE = re.compile(rb"[A-Za-z0-9_-]{22}\Z")
ARTIFACT = re.compile(r"[A-Za-z0-9._-]{1,160}\.whl\Z")


def clear(value: bytearray) -> None:
    value[:] = b"\x00" * len(value)
    value.clear()


def _https_url(value: str, *, origin_only: bool) -> tuple[str, str]:
    if not isinstance(value, str):
        raise ValueError("invite prompt URL is invalid")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in {None, 443}
        or parsed.query
        or parsed.fragment
        or (origin_only and parsed.path not in {"", "/"})
    ):
        raise ValueError("invite prompt URL is invalid")
    return parsed.path, parsed.hostname


@dataclass(frozen=True, slots=True)
class ReleaseConfig:
    artifact_url: str | None
    version: str | None
    sha256: str | None
    join_address: str

    def __post_init__(self) -> None:
        _https_url(self.join_address, origin_only=True)
        release_values = (self.artifact_url, self.version, self.sha256)
        if all(value is None for value in release_values):
            return
        if not all(isinstance(value, str) for value in release_values):
            raise ValueError("invite prompt release is not pinned")
        path, _ = _https_url(self.artifact_url, origin_only=False)
        artifact = path.rsplit("/", 1)[-1]
        if (
            VERSION.fullmatch(self.version) is None
            or SHA256.fullmatch(self.sha256) is None
            or ARTIFACT.fullmatch(artifact) is None
            or self.version not in artifact
        ):
            raise ValueError("invite prompt release is not pinned")

    @property
    def published(self) -> bool:
        return self.artifact_url is not None

    @property
    def artifact_name(self) -> str:
        if self.artifact_url is None:
            raise ValueError("invite prompt release is not published")
        return urlsplit(self.artifact_url).path.rsplit("/", 1)[-1]


def build_prompt(release: ReleaseConfig, invite_code: bytearray) -> str:
    if not isinstance(release, ReleaseConfig) or not isinstance(
        invite_code, bytearray
    ):
        if isinstance(invite_code, bytearray):
            clear(invite_code)
        raise ValueError("invite prompt input is invalid")
    try:
        if INVITE.fullmatch(invite_code) is None:
            raise ValueError("invite prompt code is invalid")
        code = invite_code.decode("ascii")
        address = release.join_address.rstrip("/")
        tool_input = json.dumps(
            {
                "description": "Invited to Quarterdeck",
                "invite": code,
            },
            separators=(",", ":"),
        )
        if release.published:
            artifact = shlex.quote(release.artifact_name)
            url = shlex.quote(release.artifact_url)
            digest = shlex.quote(release.sha256)
            step_one = (
                f"Step 1: install Quarterdeck QD MCP {release.version} from its pinned public release.\n"
                f"curl --proto '=https' --tlsv1.2 --fail --location --output {artifact} {url} && "
                f"printf '%s  %s\\n' {digest} {artifact} | sha256sum --check --strict && "
                f"python3 -m pip install --no-deps ./{artifact}"
            )
        else:
            step_one = (
                "Step 1: this Quarterdeck has no public QD MCP release yet. "
                "Use the Quarterdeck client your operator installed for you; "
                "if you do not have it, stop and ask your operator."
            )
        return (
            "Key commandment: keep your own Quarterdeck key safe in a file named quarterdeck-key-<your bot name> that only you may read. Never use, read, copy or ask for another bot's key, even on a shared computer.\n\n"
            f"{step_one}\n\n"
            f"Step 2: configure {address} in QD_CONFIG and add Quarterdeck as an MCP "
            "server over stdio. The server command contains no invite.\n"
            "Command: qd-mcp --config \"${QD_CONFIG:?set QD_CONFIG}\"\n\n"
            "Step 3: call the `qd_join` MCP tool with this tool input over stdio "
            f"(not a shell command or process argument):\n{tool_input}\n\n"
            "Residual: this one-use, short-lived invite is present in the agent "
            "conversation until the tool consumes it, and joining still requires "
            "the Captain's approval."
        )
    finally:
        clear(invite_code)
