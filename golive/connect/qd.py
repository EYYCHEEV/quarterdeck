from __future__ import annotations

import argparse
import json
import sys

import qd_connect


PUBLIC_FAILURE = "qd: request could not be completed"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="qd")
    result.add_argument("--config", required=True)
    commands = result.add_subparsers(dest="command", required=True)

    join = commands.add_parser("join")
    join.add_argument("--description", required=True)

    send = commands.add_parser("send")
    send.add_argument("--to", required=True)
    send.add_argument("--subject", required=True)
    send.add_argument("--resend-id", required=True)
    send.add_argument("--mail-to-captain", action="store_true")

    chat = commands.add_parser("chat")
    chat.add_argument("--resend-id", required=True)

    wait = commands.add_parser("wait")
    wait.add_argument("--after")
    wait.add_argument("--timeout", type=float)

    ack = commands.add_parser("ack")
    ack.add_argument("id")
    return result


def main(
    argv: list[str] | None = None,
    *,
    service: qd_connect.ConnectService | None = None,
) -> int:
    args = parser().parse_args(argv)
    try:
        client = (
            service
            if service is not None
            else qd_connect.service_from_config(args.config)
        )
        if args.command == "join":
            invite = bytearray()
            try:
                source = getattr(sys.stdin, "buffer", sys.stdin)
                received = source.read(129)
                if isinstance(received, str):
                    received = received.encode("ascii")
                invite.extend(received)
                if len(invite) > 128:
                    raise qd_connect.ConnectRefused("join invite is invalid")
                if invite.endswith(b"\n"):
                    del invite[-1:]
                if invite.endswith(b"\r"):
                    del invite[-1:]
                if qd_connect.INVITE.fullmatch(invite) is None:
                    raise qd_connect.ConnectRefused("join invite is invalid")
                result = client.join(args.description, invite)
                print(result["code"], flush=True)
            finally:
                qd_connect.clear(invite)
        elif args.command == "send":
            print(
                client.send(
                    args.to,
                    args.subject,
                    sys.stdin.read(),
                    args.resend_id,
                    mail_to_captain=args.mail_to_captain,
                ),
                flush=True,
            )
        elif args.command == "chat":
            print(client.chat(sys.stdin.read(), args.resend_id), flush=True)
        elif args.command == "wait":
            for message in client.wait(args.after, args.timeout):
                print(
                    json.dumps(
                        message,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    flush=True,
                )
        else:
            client.ack(args.id)
        return 0
    except qd_connect.MailRefused as refusal:
        print(refusal.text("cli"), file=sys.stderr)
        return 2
    except Exception:
        print(PUBLIC_FAILURE, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
