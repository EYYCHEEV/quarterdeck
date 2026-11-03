import itertools
import json
from datetime import datetime, timedelta, timezone

DOMAIN = "example.test"
FORBIDDEN = {"EmailSubmission/get"}


class FakeStalwart:
    def __init__(self, bots):
        self.keys = {f"key-of-{bot}": bot for bot in bots}
        self.mail = {bot: {} for bot in bots}
        self.numbers = itertools.count(1)
        self.clock = datetime(2026, 11, 2, 2, 0, tzinfo=timezone.utc)
        self.requests = []
        self.down = False
        self.api_url = "/jmap/"
        self.last_implicit = {}
        self.not_yet_indexed = set()
        self.index_lag = False

    def key_of(self, bot):
        return f"key-of-{bot}"

    def __call__(self, method, url, headers, body=None):
        self.requests.append((method, url, dict(headers), body))
        if self.down:
            raise OSError("stand-in: Stalwart is down")
        authorization = headers.get("Authorization", "")
        if isinstance(authorization, bytes):
            authorization = authorization.decode("latin-1")
        scheme, _, key = authorization.partition(" ")
        bot = self.keys.get(key) if scheme == "Bearer" else None
        if bot is None:
            return 401, b""
        if method == "GET":
            return 200, json.dumps({"apiUrl": self.api_url,
                                    "primaryAccounts": {"urn:ietf:params:jmap:mail": bot}}).encode()
        request = json.loads(body)
        created, responses = {}, []
        for name, args, call_id in request["methodCalls"]:
            if args.get("accountId") != bot:
                responses.append(["error", {"type": "accountNotFound"}, call_id])
                continue
            handler = getattr(self, name.replace("/", "_"), None)
            if name in FORBIDDEN:
                responses.append(["error", {"type": "forbidden"}, call_id])
                continue
            if handler is None:
                responses.append(["error", {"type": "unknownMethod"}, call_id])
                continue
            responses.append([name, handler(bot, args, created), call_id])
            if name == "EmailSubmission/set" and args.get("onSuccessUpdateEmail"):
                responses.append(["Email/set", {"updated": self.last_implicit}, call_id])
        return 200, json.dumps({"methodResponses": responses}).encode()

    def tick(self):
        self.clock += timedelta(seconds=1)
        return self.clock.strftime("%Y-%m-%dT%H:%M:%SZ")

    def Identity_get(self, bot, args, created):
        return {"list": [{"id": f"identity-{bot}", "email": f"{bot}@{DOMAIN}"}]}

    def Mailbox_get(self, bot, args, created):
        return {"list": [{"id": f"{role}-{bot}", "role": role} for role in ("inbox", "drafts", "sent")]}

    def matches(self, email_id, email, flt):
        if "operator" in flt:
            return all(self.matches(email_id, email, c) for c in flt["conditions"])
        if not flt:
            return True
        if "inMailbox" in flt:
            return email["mailboxIds"].get(flt["inMailbox"], False)
        if "notKeyword" in flt:
            return not email.get("keywords", {}).get(flt["notKeyword"], False)
        if "header" in flt:
            name, value = flt["header"]
            return (name == "Message-ID" and value == email["messageId"][0]
                    and email_id not in self.not_yet_indexed)
        raise ValueError(f"stand-in has no filter {flt}")

    def Email_query(self, bot, args, created):
        ids = [i for i, e in sorted(self.mail[bot].items(), key=lambda item: (item[1]["receivedAt"], item[1]["n"]))
               if self.matches(i, e, args.get("filter", {}))]
        if not all(s.get("isAscending", True) for s in args.get("sort", [])):
            ids.reverse()
        if "anchor" in args:
            raise ValueError("the client no longer uses anchors")
        position = args.get("position", 0)
        return {"ids": ids[position:position + args.get("limit", len(ids))], "position": position}

    def Email_get(self, bot, args, created):
        found = []
        for i in args["ids"]:
            email = self.mail[bot].get(i)
            if email:
                found.append({p: email.get(p) for p in args["properties"]} | {"id": i})
        return {"list": found}

    def Email_set(self, bot, args, created):
        answer = {"created": {}, "updated": {}}
        for cid, new in args.get("create", {}).items():
            number = next(self.numbers)
            email_id = f"e{number}"
            self.mail[bot][email_id] = dict(new, n=number, receivedAt=self.tick())
            if self.index_lag:
                self.not_yet_indexed.add(email_id)
            created[f"#{cid}"] = email_id
            answer["created"][cid] = {"id": email_id}
        for email_id, patch in args.get("update", {}).items():
            email = self.mail[bot].get(email_id)
            if email is None:
                answer.setdefault("notUpdated", {})[email_id] = {"type": "notFound"}
                continue
            self.patch(email, patch)
            answer["updated"][email_id] = None
        return answer

    @staticmethod
    def patch(email, patch):
        for path, value in patch.items():
            field, _, key = path.partition("/")
            target = email.setdefault(field, {})
            if value is None:
                target.pop(key, None)
            else:
                target[key] = value

    def EmailSubmission_set(self, bot, args, created):
        answer = {"created": {}}
        self.last_implicit = {}
        for sid, submission in args.get("create", {}).items():
            email = self.mail[bot][created[submission["emailId"]]]
            sender = email["from"][0]["email"]
            address = email["to"][0]["email"]
            recipient, _, domain = address.partition("@")
            if sender != f"{bot}@{DOMAIN}":
                answer.setdefault("notCreated", {})[sid] = {"type": "forbiddenToSend"}
                continue
            if domain != DOMAIN:
                answer.setdefault("notCreated", {})[sid] = {"type": "forbiddenToSend"}
                continue
            number = next(self.numbers)
            if recipient in self.mail:
                copy = {k: v for k, v in email.items() if k not in ("mailboxIds", "keywords", "n", "receivedAt")}
                self.mail[recipient][f"e{number}"] = dict(copy, n=number, receivedAt=self.tick(),
                                                          mailboxIds={f"inbox-{recipient}": True}, keywords={})
                if self.index_lag:
                    self.not_yet_indexed.add(f"e{number}")
                undo = "pending"
            else:
                undo = "final"
            answer["created"][sid] = {"id": f"s{number}", "undoStatus": undo}
            update = args.get("onSuccessUpdateEmail", {}).get(f"#{sid}")
            if update:
                self.patch(email, update)
                self.last_implicit[created[submission["emailId"]]] = None
        return answer

    def deliver_copy(self, recipient, mail_id):
        original = next(e for e in self.mail[recipient].values() if e["messageId"] == [mail_id])
        number = next(self.numbers)
        self.mail[recipient][f"e{number}"] = dict(original, n=number, receivedAt=self.tick(), keywords={})
