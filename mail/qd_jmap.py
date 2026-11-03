import argparse
import hashlib
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

NOTHING_NEW, REFUSED, MAIL_FAILED = 1, 2, 3
CHECK_EVERY_SECONDS = 5
PAGE = 256
MAX_KEY_BYTES = 4096
MAX_ANSWER_BYTES = 16 * 1024 * 1024
HANDLED = "qd-handled"
WORDS_HEADER = "X-QD-Words"
BOT_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"]


class Refused(Exception):
    pass


class MailFailed(Exception):
    pass


class Credential:
    __slots__ = ("_key",)

    def __init__(self, key):
        self._key = key

    @classmethod
    def from_fd(cls, fd):
        buffer, size = bytearray(MAX_KEY_BYTES + 1), 0
        try:
            with memoryview(buffer) as view:
                while size <= MAX_KEY_BYTES and (got := os.readv(fd, [view[size:]])):
                    size += got
            if size > MAX_KEY_BYTES:
                raise Refused("the key on the key pipe is too long")
            start, end = 0, size
            while start < end and buffer[start] in b" \t\r\n":
                start += 1
            while end > start and buffer[end - 1] in b" \t\r\n":
                end -= 1
            if start == end or any(not 0x21 <= buffer[i] <= 0x7E for i in range(start, end)):
                raise Refused("the key pipe must carry exactly one key")
            return cls(buffer[start:end])
        finally:
            os.close(fd)
            buffer[:] = bytes(len(buffer))

    def header(self):
        return b"Bearer " + self._key

    def clear(self):
        self._key[:] = bytes(len(self._key))
        del self._key[:]

    def __repr__(self):
        return "Credential(<hidden>)"

    __str__ = __repr__

    def __reduce__(self):
        raise TypeError("a credential cannot be copied out")


def check_session_url(url):
    parts = urllib.parse.urlsplit(url)
    if parts.username is not None or parts.password is not None:
        raise Refused("the session URL must not carry user information")
    if parts.scheme == "https":
        return url
    try:
        loopback = parts.scheme == "http" and ipaddress.ip_address(parts.hostname or "").is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise Refused("the session URL must be HTTPS, or plain HTTP on a loopback address")
    return url


def origin(url):
    parts = urllib.parse.urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or {"https": 443, "http": 80}.get(parts.scheme)


def same_origin_api(session_url, api_url):
    parts = urllib.parse.urlsplit(api_url)
    if parts.username is not None or parts.password is not None or origin(api_url) != origin(session_url):
        raise MailFailed("Stalwart's session names an API on another origin; the key is not sent there")
    return api_url


class HttpTransport:
    def __init__(self):
        no_redirect = type("NoRedirect", (urllib.request.HTTPRedirectHandler,),
                           {"redirect_request": lambda *args, **kwargs: None})
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), no_redirect)

    def __call__(self, method, url, headers, body=None):
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=30) as answer:
                return answer.status, answer.read(MAX_ANSWER_BYTES + 1)
        except urllib.error.HTTPError as failure:
            return failure.code, b""


class Jmap:
    def __init__(self, session_url, credential, transport):
        self.transport = transport
        self.credential = credential
        session = self.fetch("GET", check_session_url(session_url))
        try:
            api_url = urllib.parse.urljoin(session_url, session["apiUrl"])
            self.account = session["primaryAccounts"]["urn:ietf:params:jmap:mail"]
        except (KeyError, TypeError):
            raise MailFailed("Stalwart's session has no mail account for this key") from None
        self.api_url = same_origin_api(session_url, api_url)

    def fetch(self, method, url, payload=None):
        headers = {"Accept": "application/json", "Authorization": self.credential.header()}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        try:
            status, data = self.transport(method, url, headers, body)
        except OSError as failure:
            raise MailFailed(f"could not reach Stalwart: {type(failure).__name__}") from None
        if len(data) > MAX_ANSWER_BYTES:
            raise MailFailed("Stalwart's answer was too large")
        if status != 200:
            raise MailFailed(f"Stalwart answered HTTP {status}")
        try:
            return json.loads(data)
        except ValueError:
            raise MailFailed("Stalwart's answer was not JSON") from None

    def call(self, *calls):
        answer = self.fetch("POST", self.api_url, {
            "using": USING,
            "methodCalls": [[name, {"accountId": self.account, **args}, f"c{n}"] for n, (name, args) in enumerate(calls)],
        })
        first = {}
        for name, args, call_id in answer.get("methodResponses", []):
            if name == "error":
                raise MailFailed(f"Stalwart refused a request: {args.get('type', 'unknown')}")
            first.setdefault(call_id, args)
        try:
            return [first[f"c{n}"] for n in range(len(calls))]
        except KeyError:
            raise MailFailed("Stalwart's answer is missing a method response") from None


def message_id(sender, key, domain):
    digest = hashlib.sha256(f"{sender}\0{key}".encode()).hexdigest()[:32]
    return f"qd.{digest}.{sender}@{domain}"


def words_digest(recipient, subject, body):
    return hashlib.sha256(f"{recipient}\0{subject}\0{body}".encode()).hexdigest()


def normal_body(text):
    return text.replace("\r\n", "\n")


class Mailbox:
    def __init__(self, jmap):
        self.jmap = jmap
        identities, mailboxes = jmap.call(("Identity/get", {"ids": None}),
                                          ("Mailbox/get", {"ids": None, "properties": ["id", "role"]}))
        if len(identities.get("list", [])) != 1:
            raise MailFailed("this key must have exactly one sending identity")
        self.identity = identities["list"][0]["id"]
        self.address = identities["list"][0]["email"].lower()
        self.bot, _, self.domain = self.address.partition("@")
        roles = {box.get("role"): box["id"] for box in mailboxes.get("list", [])}
        try:
            self.inbox_id, self.drafts, self.sent = roles["inbox"], roles["drafts"], roles["sent"]
        except KeyError as missing:
            raise MailFailed(f"this account has no {missing.args[0]} mailbox") from None

    def sent_copy(self, mail_id):
        in_sent = {"inMailbox": self.sent}
        [found] = self.jmap.call(("Email/query", {"filter": {"operator": "AND", "conditions": [
            in_sent, {"header": ["Message-ID", mail_id]}]}, "limit": 1}))
        if found.get("ids"):
            return found["ids"]
        [recent] = self.jmap.call(("Email/query", {"filter": in_sent, "limit": PAGE,
                                                    "sort": [{"property": "receivedAt", "isAscending": False}]}))
        if not recent.get("ids"):
            return []
        [got] = self.jmap.call(("Email/get", {"ids": recent["ids"], "properties": ["id", "messageId"]}))
        return [m["id"] for m in got.get("list", []) if first_id(m) == mail_id][:1]

    def inbox(self, pending_only, properties):
        flt = {"inMailbox": self.inbox_id}
        if pending_only:
            flt = {"operator": "AND", "conditions": [flt, {"notKeyword": HANDLED}]}
        emails, position = [], 0
        while True:
            [found] = self.jmap.call(("Email/query", {"filter": flt, "position": position, "limit": PAGE,
                                                      "sort": [{"property": "receivedAt", "isAscending": True}]}))
            ids = found.get("ids", [])
            if ids:
                [got] = self.jmap.call(("Email/get", {"ids": ids, "properties": properties,
                                                      "fetchTextBodyValues": "bodyValues" in properties}))
                by_id = {m["id"]: m for m in got.get("list", [])}
                emails.extend(by_id[i] for i in ids if i in by_id)
            if len(ids) < PAGE:
                return emails
            position += len(ids)

    def send(self, recipient, subject, body, key):
        if not subject.strip() or "\n" in subject or "\r" in subject:
            raise Refused("the subject must be one non-empty line")
        if not BOT_NAME.fullmatch(recipient):
            raise Refused("the recipient must be a Quarterdeck bot name")
        if not key or len(key) > 200:
            raise Refused("the resend key must be 1 to 200 characters")
        body = normal_body(body)
        mail_id, words = message_id(self.bot, key, self.domain), words_digest(recipient, subject, body)
        kept = self.sent_copy(mail_id)
        if kept:
            [got] = self.jmap.call(("Email/get", {"ids": kept[:1], "properties": [f"header:{WORDS_HEADER}:asText"]}))
            if [m.get(f"header:{WORDS_HEADER}:asText", "").strip() for m in got.get("list", [])] != [words]:
                raise Refused(f"{self.bot} already sent message {mail_id} with key {key!r} and other words; "
                              "that message is kept")
            return mail_id
        made, submitted = self.jmap.call(
            ("Email/set", {"create": {"m": {
                "mailboxIds": {self.drafts: True},
                "keywords": {"$draft": True, "$seen": True},
                "from": [{"email": self.address}],
                "to": [{"email": f"{recipient}@{self.domain}"}],
                "subject": subject,
                "messageId": [mail_id],
                f"header:{WORDS_HEADER}:asText": words,
                "bodyValues": {"b": {"value": body}},
                "textBody": [{"partId": "b", "type": "text/plain"}],
            }}}),
            ("EmailSubmission/set", {
                "create": {"s": {"identityId": self.identity, "emailId": "#m"}},
                "onSuccessUpdateEmail": {"#s": {f"mailboxIds/{self.drafts}": None, f"mailboxIds/{self.sent}": True,
                                                "keywords/$draft": None}},
            }),
        )
        if "s" not in submitted.get("created", {}):
            reason = submitted.get("notCreated", {}).get("s", {}).get("type", "unknown")
            raise MailFailed(f"Stalwart did not accept the message for delivery: {reason}")
        if submitted["created"]["s"].get("undoStatus") == "final":
            self.unsend(made["created"]["m"]["id"])
            raise MailFailed("Stalwart refused the recipient and queued nothing; nothing was delivered")
        return mail_id

    def unsend(self, email_id):
        [moved] = self.jmap.call(("Email/set", {"update": {email_id: {
            f"mailboxIds/{self.sent}": None, f"mailboxIds/{self.drafts}": True, "keywords/$draft": True}}}))
        if email_id not in (moved.get("updated") or {}):
            raise MailFailed("Stalwart refused the recipient, and the refused copy could not be moved out of Sent; "
                             "a resend with this key would wrongly pass as sent")

    def pending(self, after=None):
        emails = self.inbox(True, ["id", "messageId", "from", "subject", "receivedAt", "textBody", "bodyValues"])
        if after is not None:
            ids = [first_id(e) for e in emails]
            if after in ids:
                emails = emails[ids.index(after) + 1:]
            else:
                cursor = next((e for e in self.inbox(False, ["id", "messageId", "receivedAt"])
                               if first_id(e) == after), None)
                if cursor is None:
                    raise Refused(f"{self.bot}'s inbox has no message {after}")
                emails = [e for e in emails if e["receivedAt"] >= cursor["receivedAt"]]
        seen, messages = set(), []
        for email in emails:
            mail_id = first_id(email)
            if not mail_id or mail_id in seen:
                continue
            seen.add(mail_id)
            parts = [email.get("bodyValues", {}).get(p["partId"], {}).get("value", "") for p in email.get("textBody", [])]
            messages.append({
                "id": mail_id,
                "sender": (email.get("from") or [{}])[0].get("email", "").partition("@")[0],
                "recipient": self.bot,
                "subject": email.get("subject", ""),
                "body": normal_body("".join(parts)),
                "sent": datetime.fromisoformat(email["receivedAt"].replace("Z", "+00:00")).astimezone()
                        .isoformat(timespec="seconds"),
            })
        return messages

    def ack(self, mail_id):
        copies = [e for e in self.inbox(False, ["id", "messageId", "keywords"]) if first_id(e) == mail_id]
        if not copies:
            raise Refused(f"{self.bot}'s inbox has no message {mail_id}")
        todo = [e["id"] for e in copies if not (e.get("keywords") or {}).get(HANDLED)]
        if not todo:
            return
        [done] = self.jmap.call(("Email/set", {"update": {c: {f"keywords/{HANDLED}": True} for c in todo}}))
        if set(done.get("updated") or {}) != set(todo):
            raise MailFailed("Stalwart did not mark every copy handled")


def first_id(email):
    return (email.get("messageId") or [None])[0]


def wait(mailbox, after, timeout, clock=time.monotonic, sleep=time.sleep):
    deadline = None if timeout is None else clock() + timeout
    while True:
        found = mailbox.pending(after)
        if found or (deadline is not None and clock() >= deadline):
            return found
        sleep(CHECK_EVERY_SECONDS)


def main(argv=None, transport=None):
    parser = argparse.ArgumentParser(prog="qd_jmap.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session", required=True, help="Stalwart's JMAP session URL")
    parser.add_argument("--key-fd", type=int, required=True, help="file descriptor carrying the bot's key")
    commands = parser.add_subparsers(dest="command", required=True)
    sending = commands.add_parser("send", help="send one message; the body is read from stdin")
    sending.add_argument("--to", required=True)
    sending.add_argument("--subject", required=True)
    sending.add_argument("--key", required=True)
    waiting = commands.add_parser("wait", help="wait for pending messages after the cursor")
    waiting.add_argument("--after", help="the cursor: the last message id already seen")
    waiting.add_argument("--timeout", type=float, help="seconds to wait; without it, wait until a message comes")
    acking = commands.add_parser("ack", help="mark one message handled")
    acking.add_argument("id")
    args = parser.parse_args(argv)
    credential = None
    try:
        credential = Credential.from_fd(args.key_fd)
        mailbox = Mailbox(Jmap(args.session, credential, transport or HttpTransport()))
        if args.command == "send":
            print(mailbox.send(args.to, args.subject, sys.stdin.read(), args.key), flush=True)
        elif args.command == "wait":
            found = wait(mailbox, args.after, args.timeout)
            for message in found:
                print(json.dumps(message, ensure_ascii=False), flush=True)
            return 0 if found else NOTHING_NEW
        else:
            mailbox.ack(args.id)
        return 0
    except Refused as refusal:
        print(f"qd-jmap: refused, nothing changed: {refusal}", file=sys.stderr)
        return REFUSED
    except MailFailed as failure:
        print(f"qd-jmap: {failure}", file=sys.stderr)
        return MAIL_FAILED
    finally:
        if credential is not None:
            credential.clear()


if __name__ == "__main__":
    sys.exit(main())
