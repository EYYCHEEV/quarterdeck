import contextlib
import dataclasses
import io
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "qd-web"
sys.path.insert(0, str(PKG))

import application
import bundle
import cards
import live
import webapp
from test_chat_server import ACCOUNT, STEWARD, Checker, Env, Mail, answer, module, request, stamp

REPLY = re.compile(r"QD_CHAT_REPLY route=(list|thread|send|read) status=(\d{3}) error=(\S+) cause=(\S+) ms=(\d+)")
CARRIES = "mail_ids" in {field.name for field in dataclasses.fields(cards.MailMessage)}
READ_PATH = "/captain/api/chat/read"


def chat_body(bot, text, *, quote=None, client_id=None, fresh=None):
    document = {"qd": "chat/1", "bot": bot, "text": text}
    if client_id is not None:
        document["clientId"] = client_id
        if fresh is not None:
            document["fresh"] = fresh
    if quote is not None:
        document["quote"] = quote
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False)


def note_body(bot, up_to):
    return json.dumps({"qd": "chat-seen/1", "bot": bot, "upTo": up_to}, separators=(",", ":"))


class CardChecker(Checker):
    def check(self, subject, body, *, sender, poster=None, base=None, current_rev=None):
        return json.loads(body), ()


class R3Mail(Mail):
    def __init__(self):
        super().__init__()
        self.marked = []
        self.mark_error = None

    def put(self, sender, subject, body, minute, identifier, seen=True):
        extra = (seen, (identifier,)) if CARRIES else () if seen else (False,)
        self.inbox.append(cards.MailMessage(identifier, sender, subject, body, stamp(minute), *extra))
        return identifier

    def bot_says(self, bot, text, minute, identifier=None, client_id=None, *, seen=True, quote=None, sender=None):
        identifier = identifier or f"bot-{bot}-{minute}@qd.invalid"
        body = chat_body(bot, text, quote=quote, client_id=client_id)
        return self.put(sender or bot, f"CHAT: {bot}", body, minute, identifier, seen)

    def captain_says(self, bot, text, minute, identifier=None, client_id=None, *, quote=None):
        identifier = identifier or f"captain-{bot}-{minute}@qd.invalid"
        body = chat_body(bot, text, quote=quote, client_id=client_id, fresh=False)
        return self.put(ACCOUNT, f"CHAT: {bot}", body, minute, identifier, True)

    def note(self, bot, up_to, minute, identifier=None, *, sender=None, seen=False, body=None):
        identifier = identifier or f"note-{bot}-{minute}@qd.invalid"
        return self.put(sender or bot, f"CHAT: {bot}", body if body is not None else note_body(bot, up_to), minute, identifier, seen)

    def card(self, card_id, minute, *, title="A card", revisions=1):
        document = {"id": card_id, "project": "project-one", "lane": "lane-one", "title": title}
        self.put("bot-b", f"CARD: {title}", json.dumps(document), minute, f"card-{card_id}-1@qd.invalid")
        for revision in range(2, revisions + 1):
            update = {"card": card_id, "rev": revision, "title": title}
            self.put("bot-b", f"UPDATE: {card_id}", json.dumps(update), minute + revision, f"card-{card_id}-{revision}@qd.invalid")

    def mark_seen(self, ids):
        if self.mark_error is not None:
            raise self.mark_error
        self.marked.append(list(ids))
        wanted = set(ids)
        self.inbox = [dataclasses.replace(message, seen=True) if message.id in wanted else message for message in self.inbox]

    def set_seen(self, identifier, seen):
        self.inbox = [dataclasses.replace(message, seen=seen) if message.id == identifier else message for message in self.inbox]


class R3Env(Env):
    def __init__(self, case, bots=("bot-b", "bot-c"), notes=(), names=None, checker=None):
        super().__init__(case, bots=bots, notes=notes)
        self.mail = R3Mail()
        self.checker = checker if checker is not None else Checker()
        self.notes = notes
        self.rewire(names)

    def rewire(self, names=None):
        source = module("bot_list").BotList(str(self.bots_path), clock=lambda: self.now)
        options = {} if names is None else {"bot_names": names}
        self.service = cards.CardService(self.mail, self.checker, chat_bots=self.notes, bot_source=source, **options)
        self.updates = live.LiveUpdates(self.service)
        self.cards_app = application.CardApplication(self.gate, self.service, self.updates, clock=lambda: self.now)
        self.chat = module("chat_api").ChatApi(self.gate, self.service, clock=lambda: self.now)
        self.web = webapp.QdWeb(self.cards_app, bundle.Bundle.load(str(self.root / "site")), chat=self.chat)

    def rows(self):
        status, rows = answer(self.get("/captain/api/chats"))
        assert status == 200, rows
        return rows

    def thread(self, bot="bot-b", query=None):
        status, body = answer(self.get("/captain/api/chat?" + (query if query is not None else f"bot={bot}")))
        assert status == 200, (status, body)
        return body

    def thread_status(self, query):
        return answer(self.get("/captain/api/chat?" + query))

    def read(self, bot="bot-b", up_to=None, **options):
        payload = {"bot": bot, "upTo": up_to, "csrf": "csrf-now"}
        payload.update(options.pop("payload", {}))
        return self.web.handle(request("POST", READ_PATH, payload, **options))

    def read_status(self, bot="bot-b", up_to=None, **options):
        return answer(self.read(bot, up_to, **options))

    def send_with(self, bot, text, *, token=None, **fields):
        self.counter += 1
        payload = {"bot": bot, "text": text, "clientId": fields.pop("client_id", f"client-{self.counter}"), "csrf": "csrf-now"}
        payload.update(fields)
        return self.post(payload, token=token if token is not None else f"session-{self.counter}")


def captured():
    buffer = io.StringIO()
    return buffer, contextlib.redirect_stderr(buffer)


def lines_of(buffer):
    return [line for line in buffer.getvalue().splitlines() if line.startswith("QD_CHAT_REPLY")]
