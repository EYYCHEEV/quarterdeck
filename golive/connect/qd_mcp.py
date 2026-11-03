from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import qd_connect


PROTOCOL_VERSION = "2025-06-18"
PUBLIC_FAILURE = "request could not be completed"


TOOLS = [
    {
        "name": "qd_join",
        "description": "Request owner approval to join Quarterdeck.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "invite": {"type": "string"},
            },
            "required": ["description", "invite"],
            "additionalProperties": False,
        },
    },
    {
        "name": "qd_create_invite",
        "description": "Create a one-use Quarterdeck invite as this active bot.",
        "inputSchema": {
            "type": "object",
            "properties": {"bot": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "qd_send",
        "description": "Send one Quarterdeck message.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "resend_id": {"type": "string"},
            },
            "required": ["to", "subject", "body", "resend_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "qd_wait",
        "description": "Wait for pending Quarterdeck messages.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "after": {"type": ["string", "null"]},
                "timeout": {"type": ["number", "null"], "minimum": 0},
            },
            "required": ["after", "timeout"],
            "additionalProperties": False,
        },
    },
    {
        "name": "qd_ack",
        "description": "Mark one Quarterdeck message handled.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
]


def _text(value: Any) -> list[dict[str, str]]:
    if isinstance(value, str):
        rendered = value
    else:
        rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return [{"type": "text", "text": rendered}]


def _exact(arguments: Any, fields: set[str]) -> dict[str, Any]:
    if not isinstance(arguments, dict) or set(arguments) != fields:
        raise qd_connect.ConnectRefused("tool arguments are invalid")
    return arguments


class Server:
    def __init__(self, service: qd_connect.ConnectService):
        self.service = service

    def _tool(self, name: str, arguments: Any) -> Any:
        if name == "qd_join":
            values = _exact(
                arguments,
                {"description", "invite"},
            )
            invite_value = values["invite"]
            invite = bytearray()
            try:
                if (
                    not isinstance(invite_value, str)
                    or not invite_value.isascii()
                ):
                    raise qd_connect.ConnectRefused(
                        "tool invite is invalid"
                    )
                invite.extend(invite_value.encode("ascii"))
                if qd_connect.INVITE.fullmatch(invite) is None:
                    raise qd_connect.ConnectRefused(
                        "tool invite is invalid"
                    )
                return self.service.join(
                    values["description"],
                    invite,
                )
            finally:
                qd_connect.clear(invite)
        if name == "qd_create_invite":
            if (
                not isinstance(arguments, dict)
                or set(arguments) not in (set(), {"bot"})
            ):
                raise qd_connect.ConnectRefused(
                    "tool arguments are invalid"
                )
            bot = arguments.get("bot")
            if bot is not None and (
                not isinstance(bot, str)
                or qd_connect.BOT_NAME.fullmatch(bot) is None
            ):
                raise qd_connect.ConnectRefused(
                    "tool arguments are invalid"
                )
            return self.service.create_invite(bot)
        if name == "qd_send":
            values = _exact(
                arguments,
                {"to", "subject", "body", "resend_id"},
            )
            return self.service.send(
                values["to"],
                values["subject"],
                values["body"],
                values["resend_id"],
            )
        if name == "qd_wait":
            values = _exact(arguments, {"after", "timeout"})
            return self.service.wait(values["after"], values["timeout"])
        if name == "qd_ack":
            values = _exact(arguments, {"id"})
            self.service.ack(values["id"])
            return "acknowledged"
        raise qd_connect.ConnectRefused("unknown tool")

    def handle(self, request: Any) -> dict[str, Any] | None:
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
        request_id = request.get("id")
        method = request["method"]
        if request_id is None and method.startswith("notifications/"):
            return None
        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "quarterdeck", "version": "1"},
                },
            }
        if method == "ping":
            return {"jsonrpc": "2.0", "id": request_id, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
        if method != "tools/call":
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method not found"}}
        params = request.get("params")
        try:
            if not isinstance(params, dict) or set(params) != {"name", "arguments"}:
                raise qd_connect.ConnectRefused("tool request is invalid")
            value = self._tool(params["name"], params["arguments"])
            return {"jsonrpc": "2.0", "id": request_id, "result": {"content": _text(value)}}
        except Exception:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"content": _text(PUBLIC_FAILURE), "isError": True},
            }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="qd-mcp")
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    try:
        service = qd_connect.service_from_config(args.config)
    except Exception:
        print(f"qd-mcp: {PUBLIC_FAILURE}", file=sys.stderr)
        return 2
    server = Server(service)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = server.handle(request)
        except Exception:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": "request failed"}}
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
