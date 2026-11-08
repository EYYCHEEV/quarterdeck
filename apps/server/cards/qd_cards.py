from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType

MAX_BODY_BYTES = 64 * 1024
MAX_DEPTH = 8
BUDGET = {
    "title": 70, "about": 200, "context_lines": 3, "options_min": 2, "options_max": 4, "label": 120,
    "pick_why": 300, "you_do": 400, "skip": 300, "art_lines": 8, "art_cols": 44, "command_blocks": 12,
    "note_art_cols": 60, "withdraw_why": 300,
}
CATEGORIES = ("design", "strategy", "high-risk", "try-it", "your-hands")
KINDS = ("decision", "action", "fyi")
DOORS = ("one-way", "two-way")
LETTERS = ("A", "B", "C", "D")
PICKS = LETTERS + ("cant-decide", "none")
EXTRA_CHOICES = ("Can't decide: I need more info", "None of these: other feedback")
CARD_FIELDS = ("id", "project", "lane", "title", "about", "context", "ascii", "options", "pick_why", "you_do", "skip",
               "due", "door", "category", "kind", "words", "learn", "commands", "principles", "note")
OPTION_FIELDS = ("label", "pick", "does", "cost", "risk", "undo", "pros", "cons", "tradeoff", "why")
OPTION_TEXT = ("does", "cost", "risk", "undo", "tradeoff", "why")
TEXT_FIELDS = ("project", "lane", "title", "about", "context", "ascii", "pick_why", "you_do", "skip", "note")
REQUIRED_TEXT = ("project", "title", "about", "context")
FIXED_ON_UPDATE = ("id", "project")
NEVER_REMOVED = ("title", "about", "context", "category")
PREFIX = {"card": "CARD", "update": "UPDATE", "withdraw": "WITHDRAW", "comment": "COMMENT", "answer": "ANSWER"}
FORMAT = {kind: f"{kind}/1" for kind in PREFIX}
BODY_FIELDS = {
    "update": ("qd", "card", "rev"),
    "withdraw": ("qd", "card", "why"),
    "comment": ("qd", "card", "id", "text", "options", "pick_why"),
    "answer": ("qd", "card", "comment", "rev", "pick", "note", "at"),
}
BOT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
CARD_ID = re.compile(r"Q[1-9][0-9]{0,8}|(?P<bot>[a-z][a-z0-9-]{0,31})-[1-9][0-9]{0,8}")
MAX_ID = 32
FORM_ID = re.compile(r"[A-Za-z0-9_-]{1,32}")

RULES = {
    "json": "The body is not one UTF-8 JSON object: bad UTF-8, not JSON, a field twice, NaN, or nested too deep.",
    "size": "The body is over 64 KB.",
    "subject": "The subject is not one line that starts CARD:, UPDATE:, WITHDRAW:, COMMENT: or ANSWER: and agrees with the body.",
    "format": "The body's qd is not the format for the subject's kind (card/1, update/1, withdraw/1, comment/1, answer/1).",
    "card-field": "A card/1 body's card is not its id.",
    "guard": "Text that looks like an address or a key (IPv4, IPv6, key blocks, tokens, 32+ hex, long base64-like runs), anywhere in the body. The reason never repeats the text.",
    "unknown-field": "A field the contract does not know; counted, never named.",
    "shape": "A field of the wrong type, for example text where a list belongs, or null in a card.",
    "missing": "A required field is missing or blank.",
    "one-line": "A field that must be one line has a line break.",
    "budget": "Over its length budget (title 70, about 200, context 3 lines, label 120, pick_why 300, you_do 400, skip 300, withdraw why 300), counted as card-lint counts.",
    "options-count": "Not 2 to 4 options.",
    "one-pick": "Not exactly one option with pick true.",
    "label-letter": "An option label does not start \"A. \", \"B. \", \"C. \" or \"D. \", each letter once.",
    "extra-choice": "An option repeats a choice every card already has (Can't decide, None of these).",
    "category": "category is not a list of one or two different values from design, strategy, high-risk, try-it, your-hands.",
    "principles": "principles is not {follows, departs} as text.",
    "design-principles": "A design card without principles.follows and principles.departs.",
    "kind": "kind is not decision, action or fyi.",
    "fyi-options": "An FYI card with options or a pick_why (it has no buttons).",
    "action-commands": "An action card without a command block.",
    "commands-count": "More than 12 command blocks.",
    "door": "door is not one-way or two-way.",
    "due-format": "due is not a date and time with its offset.",
    "no-answer-line": "A card with a due whose skip does not say what happens with no answer by the due.",
    "learn-link": "A learn link that is not one of our pages or an official https source without tracking parameters.",
    "art-lines": "The picture is over 8 lines.",
    "art-cols": "The picture is over 44 columns.",
    "note-art-cols": "A picture in the long note is over 60 columns.",
    "long-dash": "A long dash on the face (use a comma or a full stop).",
    "hex-on-face": "A hash or key-like string of 12 or more hex characters on the face.",
    "clock-time": "A clock time typed into the title or about (the one-liners; the long note keeps its times, as the old full pages did).",
    "internal-code": "A word on the face that reads like an internal name (machine, ticket, file, worker or tool name).",
    "id-shape": "A card id that is not Q<n> or <bot>-<n> of at most 32 characters, or a comment id that is not 1 to 32 letters, digits, - or _.",
    "id-width": "A comment id too wide for its badge in the iPhone (390) layout, which holds 232 px (card-lint's measured widths).",
    "id-owner": "The id does not start with the sender's bot name, or a Q number not from the registry's steward.",
    "owner": "The sender may not send this kind of mail on this card or project (1A registry).",
    "unknown-card": "The mail names a card Quarterdeck does not have.",
    "rev": "rev is not the right revision number.",
    "fixed": "An UPDATE tries to change id or project.",
    "pick": "pick is not A, B, C, D, cant-decide or none.",
    "at-format": "at is not a date and time with its offset.",
    "at-ahead": "at is more than 2 minutes ahead of the clock.",
    "mail-refused": "The mail server refused the send: most often this card and revision were sent before with other words, so send an UPDATE with the next rev.",
}


@dataclass(frozen=True)
class Refusal:
    field: str
    rule: str
    what: str
    quote: str | None = None

    def public(self) -> str:
        return f"{self.field}: {self.what}"

    def __str__(self) -> str:
        return self.public() + (f' (found "{self.quote}")' if self.quote is not None else "")


class CardRefused(Exception):
    def __init__(self, refusals):
        self.refusals = list(refusals)
        super().__init__("; ".join(str(r) for r in self.refusals))


class RegistryError(ValueError):
    pass


@dataclass
class Parsed:
    kind: str | None
    card: str | None
    obj: dict | None
    refusals: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.refusals


@dataclass(frozen=True)
class Mail:
    kind: str
    subject: str
    body: str
    card: str
    resend_key: str


def jslen(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


_V4 = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
_V6 = re.compile(r"(?<![\w:.])[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?![\w:])")
_B64_RUN = re.compile(r"[A-Za-z0-9+/_=-]{40,}")
_GUARD = (
    ("IPv4 address", _V4),
    ("private key block", re.compile(r"-----BEGIN")),
    ("sk- key", re.compile(r"\bsk-[A-Za-z0-9]")),
    ("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]|github_pat_[A-Za-z0-9])")),
    ("Slack token", re.compile(r"\bxox[abeprs]-[A-Za-z0-9]")),
    ("AWS key id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("long hex run", re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])")),
)
MASK = "[masked]"


def guard_hit(text: str) -> str | None:
    for name, pattern in _GUARD:
        if pattern.search(text):
            return name
    for m in _V6.finditer(text):
        token = m.group(0).rstrip(".")
        if token == "::":
            continue
        try:
            ipaddress.IPv6Address(token)
        except ValueError:
            continue
        return "IPv6 address"
    for m in _B64_RUN.finditer(text):
        run = m.group(0)
        if any(c.isupper() for c in run) and any(c.islower() for c in run) and any(c.isdigit() for c in run):
            return "long base64-like run"
    return None


def mask_guarded(text: str) -> tuple[str, int]:
    words = text.split(" ")
    hits = 0
    for i, word in enumerate(words):
        if word and guard_hit(word):
            words[i] = MASK
            hits += 1
    out = " ".join(words)
    if guard_hit(out):
        return MASK, hits + 1
    return out, hits


def _walk(node, path=""):
    if isinstance(node, dict):
        for key, value in node.items():
            yield (f"{path}.<key>" if path else "<key>"), key
            yield from _walk(value, f"{path}.{key}" if path else str(key))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from _walk(value, f"{path}[{i}]")
    elif isinstance(node, str):
        yield path, node


def guard_refusals(obj, skip=()) -> list[Refusal]:
    out = []
    for path, text in _walk(obj):
        if path in skip:
            continue
        name = guard_hit(text)
        if name:
            out.append(Refusal(path or "body", "guard",
                               f"refused by the address and key guard ({name}); take it out. This reason never repeats the text"))
    return out


_CODE_PATTERNS = [re.compile(p, re.ASCII) for p in (
    r"\b[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]*\d[A-Za-z0-9-]*\b",
    r"\b[A-Za-z]+\d+[A-Za-z0-9]*-[A-Za-z0-9-]+\b",
    r"\b[A-Z]{1,3}\d{1,3}\b",
    r"\b[A-Za-z]+-(?:lead|bot|worker|agent|reviewer|scout)\b",
    r"\b[\w-]+\.(?:json|py|js|mjs|md|sh|service|ya?ml|toml|txt|log|conf|html|css|sql)\b",
    r"\b[a-z]+(?:_[a-z0-9]+)+\b",
    r"(?<![\w/])~?/[\w.-]+(?:/[\w.-]+)+",
)]
_LONG_DASH = re.compile("[\u2014\u2013]")
_HEX_ON_FACE = re.compile(r"\b[0-9a-f]{12,}\b", re.IGNORECASE | re.ASCII)
_CLOCK = re.compile(r"\b\d{1,2}:[0-5]\d(?!\d)(?:\s*(?:AM|PM|am|pm))?", re.ASCII)
_NO_ANSWER = re.compile(r"\bno answer by (?:the )?due\b", re.IGNORECASE)
_LABEL = re.compile(r"([A-Z])\.\s")
ISO_WITH_OFFSET = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})")
CARD_LINK_ORIGIN_ENVIRONMENT = "QD_CARD_LINK_ORIGIN"
CARD_LINK_ORIGIN = re.compile(r"http://[A-Za-z0-9.-]+")
CARD_LINK_TAIL = r":87[89][0-9](?:/[A-Za-z0-9._~%/?#=&+,;:@!$*()-]*)?"
LEARN_LINK = re.compile(r"https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~%/?#=&+,;:@!$*()-]*)?")
TRACKING = re.compile(r"[?&](?:utm_[A-Za-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|yclid)=")


def card_link_ok(url) -> bool:
    origin = os.environ.get(CARD_LINK_ORIGIN_ENVIRONMENT, "")
    if not isinstance(url, str) or not CARD_LINK_ORIGIN.fullmatch(origin):
        return False
    return re.fullmatch(re.escape(origin) + CARD_LINK_TAIL, url) is not None


def learn_link_ok(url) -> bool:
    return isinstance(url, str) and (card_link_ok(url)
                                     or (bool(LEARN_LINK.fullmatch(url)) and not TRACKING.search(url)))


def _iso_ok(value) -> bool:
    if not isinstance(value, str) or not ISO_WITH_OFFSET.fullmatch(value):
        return False
    try:
        return datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        return False


def minutes_ahead(at: str, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    ahead = (datetime.fromisoformat(at) - now).total_seconds() * 1000
    return math.ceil(ahead / 60000) if ahead > 2 * 60000 else 0


def _option_list(c) -> list:
    opts = c.get("options")
    return [o for o in opts if isinstance(o, dict)] if isinstance(opts, list) else []


def codes_on(c: dict) -> list[tuple[str, str]]:
    parts = [("title", c.get("title")), ("ascii", c.get("ascii")), ("you_do", c.get("you_do")), ("skip", c.get("skip"))]
    for i, o in enumerate(c.get("options") if isinstance(c.get("options"), list) else []):
        if isinstance(o, dict):
            parts += [(f"options[{i}].{k}", o.get(k)) for k in ("label", "risk", "undo")]
    seen, out = set(), []
    for where, value in parts:
        if not isinstance(value, str):
            continue
        for pattern in _CODE_PATTERNS:
            for m in pattern.finditer(value):
                if m.group(0) not in seen:
                    seen.add(m.group(0))
                    out.append((where, m.group(0)))
    return out


def _face_text(c: dict, extra=()) -> list[tuple[str, str]]:
    parts = [(k, c.get(k)) for k in ("title", "about", "context", "pick_why", "you_do", "skip")]
    for i, o in enumerate(c.get("options") if isinstance(c.get("options"), list) else []):
        if isinstance(o, dict):
            parts += [(f"options[{i}].{k}", o.get(k)) for k in ("label",) + OPTION_TEXT]
            for k in ("pros", "cons"):
                if isinstance(o.get(k), list):
                    parts += [(f"options[{i}].{k}[{j}]", v) for j, v in enumerate(o[k])]
    if isinstance(c.get("words"), list):
        for i, pair in enumerate(c["words"]):
            if isinstance(pair, list):
                parts += [(f"words[{i}][{j}]", v) for j, v in enumerate(pair)]
    if isinstance(c.get("principles"), dict):
        parts += [(f"principles.{k}", c["principles"].get(k)) for k in ("follows", "departs")]
    parts += list(extra)
    return [(f, v) for f, v in parts if isinstance(v, str)]


def wide_pictures(note: str) -> list[tuple[int, int, int]]:
    lines = note.replace("\r\n", "\n").split("\n")
    out, n, i = [], 0, 0
    while i < len(lines):
        if lines[i].startswith("```"):
            n += 1
            widest, at = 0, 0
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                if len(lines[i]) > widest:
                    widest, at = len(lines[i]), i + 1
                i += 1
            if widest > BUDGET["note_art_cols"]:
                out.append((n, widest, at))
        i += 1
    return out


def _face_rules(add, parts, *, clock=(), codes=()):
    for where, text in parts:
        if _LONG_DASH.search(text):
            add(where, "long-dash", "has a long dash (use a comma or a full stop)")
        if _HEX_ON_FACE.search(text):
            add(where, "hex-on-face", "has a hash or key-like string (12 or more hex characters); leave it off the face")
    for where, text in clock:
        if isinstance(text, str) and (hit := _CLOCK.search(text)):
            add(where, "clock-time", 'has a typed clock time; say "today" or put the time in "due"', hit.group(0))
    for where, word in codes:
        add(where, "internal-code", "reads like an internal name; say it in plain words and keep exact names in "
                                    "the commands or the note", word)


def _options_rules(add, c, *, need_count):
    if "options" in c and not isinstance(c["options"], list):
        add("options", "shape", "must be a list of 2 to 4 options")
        return
    raw = c.get("options") or []
    for i, o in enumerate(raw):
        if not isinstance(o, dict):
            add(f"options[{i}]", "shape", "must be an object with label, pick and the option fields")
    opts = _option_list(c)
    if need_count:
        if not BUDGET["options_min"] <= len(raw) <= BUDGET["options_max"]:
            add("options", "options-count", f"{len(raw)} options (need 2 to 4)")
        if sum(1 for o in opts if o.get("pick") is True) != 1:
            add("options", "one-pick", "needs exactly one option marked as the pick (pick: true)")
    letters = set()
    for i, o in enumerate(raw):
        if not isinstance(o, dict):
            continue
        where = f"options[{i}]"
        unknown = len(set(o) - set(OPTION_FIELDS))
        if unknown:
            add(where, "unknown-field", f"has {unknown} field{'s' if unknown != 1 else ''} an option does not know "
                                        f"(it takes {', '.join(OPTION_FIELDS)})")
        label = o.get("label")
        if "label" not in o or (isinstance(label, str) and not label.strip()):
            add(f"{where}.label", "missing", 'missing: the option in one line, starting "A. "')
        elif not isinstance(label, str):
            add(f"{where}.label", "shape", "must be text")
        else:
            if jslen(label) > BUDGET["label"]:
                add(f"{where}.label", "budget", f"{jslen(label)} characters (budget {BUDGET['label']})")
            if "\n" in label or "\r" in label:
                add(f"{where}.label", "one-line", "must be one line")
            if label in EXTRA_CHOICES:
                add(f"{where}.label", "extra-choice", "repeats a choice every card already has (Can't decide, None of these)")
            m = _LABEL.match(label)
            if not m or m.group(1) not in LETTERS or m.group(1) in letters:
                add(f"{where}.label", "label-letter", 'should start "A. ", "B. ", "C. " or "D. ", each letter once')
            else:
                letters.add(m.group(1))
        if "pick" in o and not isinstance(o["pick"], bool):
            add(f"{where}.pick", "shape", "must be true or false")
        for key in OPTION_TEXT:
            if key in o and not isinstance(o[key], str):
                add(f"{where}.{key}", "shape", "must be text")
        for key in ("pros", "cons"):
            if key in o and not (isinstance(o[key], list) and all(isinstance(s, str) for s in o[key])):
                add(f"{where}.{key}", "shape", 'must be a list of short lines, like ["one", "two"]')


def _pick_why_rule(add, c, *, required):
    if "pick_why" in c:
        why = c["pick_why"]
        if isinstance(why, str):
            if not why.strip():
                add("pick_why", "missing", "missing: the reason behind the pick, in one or two lines")
            elif jslen(why) > BUDGET["pick_why"]:
                add("pick_why", "budget", f"{jslen(why)} characters (budget {BUDGET['pick_why']})")
    elif required:
        add("pick_why", "missing", "missing: the reason behind the pick, in one or two lines")


def _card_rules(c: dict, *, partial: bool) -> list[Refusal]:
    out: list[Refusal] = []

    def add(where, rule, what, quote=None):
        out.append(Refusal(where, rule, what, quote))

    def has(*keys):
        return all(k in c for k in keys)

    if not partial:
        unknown = len(set(c) - set(CARD_FIELDS) - {"qd", "card"})
        if unknown:
            add("card", "unknown-field", f"has {unknown} field{'s' if unknown != 1 else ''} a card does not know "
                                         f"(it takes {', '.join(CARD_FIELDS)})")
    for key, value in c.items():
        if value is None and key in CARD_FIELDS:
            add(key, "shape", "is null: leave the field out instead")
    c = {k: v for k, v in c.items() if v is not None}
    text = {k: c[k] for k in TEXT_FIELDS if isinstance(c.get(k), str)}
    for k in TEXT_FIELDS:
        if k in c and c[k] is not None and k not in text:
            add(k, "shape", "must be text")

    if "id" in c:
        cid = c["id"]
        if not (isinstance(cid, str) and len(cid) <= MAX_ID and CARD_ID.fullmatch(cid)):
            add("id", "id-shape", "must be Q<n> (cards from the old page) or <bot>-<n> like bot-a-12: at most 32 "
                                  "characters, n from 1 with no leading zero")
    elif not partial:
        add("id", "missing", "missing: the card id, <bot>-<n> like bot-a-12")

    for k in REQUIRED_TEXT:
        if (k in text and not text[k].strip()) or (k not in c and not partial):
            add(k, "missing", {
                "project": "missing: the plain project name",
                "title": "missing: the ask in one line",
                "about": "missing: one line saying what the project is",
                "context": "missing: where it stands, in 1 to 3 lines",
            }[k])
    if "title" in text:
        if jslen(text["title"]) > BUDGET["title"]:
            add("title", "budget", f"{jslen(text['title'])} characters (budget {BUDGET['title']})")
        if "\n" in text["title"] or "\r" in text["title"]:
            add("title", "one-line", "must be one line (it is the mail subject)")
    for k in ("project", "lane"):
        if k in text and ("\n" in text[k] or "\r" in text[k]):
            add(k, "one-line", "must be one line")
    if "about" in text:
        if "\n" in text["about"].strip():
            add("about", "one-line", "must be one line")
        if jslen(text["about"]) > BUDGET["about"]:
            add("about", "budget", f"{jslen(text['about'])} characters (budget {BUDGET['about']})")
    if "context" in text:
        lines = [line for line in text["context"].split("\n") if line.strip()]
        if len(lines) > BUDGET["context_lines"]:
            add("context", "budget", f"{len(lines)} lines (budget {BUDGET['context_lines']})")

    kind = c.get("kind", "decision")
    if "kind" in c and kind not in KINDS:
        add("kind", "kind", "must be decision, action or fyi")
        kind = "decision"
    if kind == "fyi" and (not partial or "kind" in c):
        if c.get("options") not in (None, []) or ("options" in c and not partial):
            add("options", "fyi-options", "an FYI card has no options (no buttons); leave options out")
        if "pick_why" in c:
            add("pick_why", "fyi-options", "an FYI card has no pick, so no pick_why")
        _options_rules(add, c, need_count=False)
    else:
        _options_rules(add, c, need_count=not partial or "options" in c)
        _pick_why_rule(add, c, required=not partial)

    if "category" in c:
        cats = c["category"]
        if isinstance(cats, list) and not cats:
            add("category", "missing", f"missing: a list of one or two of {', '.join(CATEGORIES)}")
        elif not (isinstance(cats, list) and len(cats) <= 2 and all(isinstance(x, str) for x in cats)
                  and len(set(cats)) == len(cats) and all(x in CATEGORIES for x in cats)):
            add("category", "category", f"must be a list of one or two different values from {', '.join(CATEGORIES)}")
    elif not partial:
        add("category", "missing", f"missing: a list of one or two of {', '.join(CATEGORIES)}")
    pr = c.get("principles")
    principles_ok = isinstance(pr, dict) and set(pr) == {"follows", "departs"} and all(isinstance(v, str) for v in pr.values())
    if "principles" in c and pr is not None and not principles_ok:
        add("principles", "principles", "must be {follows, departs}, two lines of text")
    if (has("category", "principles") or (not partial and "category" in c)) and isinstance(c.get("category"), list) \
            and "design" in c["category"] and not (principles_ok and pr["follows"].strip() and pr["departs"].strip()):
        add("principles", "design-principles", "a design card needs principles.follows and principles.departs: which "
                                               "pstack and Pocock principles it follows, and where it departs")

    for k in ("you_do", "skip"):
        if k in text and jslen(text[k]) > BUDGET[k]:
            add(k, "budget", f"{jslen(text[k])} characters (budget {BUDGET[k]})")
    if "due" in c and c["due"] is not None and not _iso_ok(c["due"]):
        add("due", "due-format", "must be a date and time with its offset, like 2026-10-24T19:00:00-04:00")
    if (has("due", "skip") or (not partial and "due" in c)) and isinstance(c.get("due"), str) and c["due"].strip() \
            and not _NO_ANSWER.search(c.get("skip") if isinstance(c.get("skip"), str) else ""):
        add("skip", "no-answer-line", 'has a due but does not say what happens if no answer comes by then: add it to '
                                      'skip, like "If no answer by due: ..."')
    if "door" in c and c["door"] is not None and c["door"] not in DOORS:
        add("door", "door", "must be one-way or two-way")

    if "words" in c and c["words"] is not None and not (
            isinstance(c["words"], list) and all(isinstance(w, list) and len(w) == 2 and all(isinstance(s, str) for s in w)
                                                 for w in c["words"])):
        add("words", "shape", "must be a list of [term, meaning] pairs")
    if "learn" in c and c["learn"] is not None:
        if not isinstance(c["learn"], list):
            add("learn", "shape", "must be a list of {label, url}")
        else:
            for i, x in enumerate(c["learn"]):
                if not isinstance(x, dict):
                    add(f"learn[{i}]", "shape", "must be {label, url}")
                    continue
                if set(x) - {"label", "url"}:
                    add(f"learn[{i}]", "unknown-field", "has a field a link does not know (it takes label, url)")
                if not (isinstance(x.get("label"), str) and x["label"].strip()):
                    add(f"learn[{i}].label", "missing", "missing: the link's words")
                if not learn_link_ok(x.get("url")):
                    add(f"learn[{i}].url", "learn-link", f"link {i + 1} must be one of our pages or an official https "
                                                         "source without tracking parameters")
    if "ascii" in text and text["ascii"].strip():
        lines = re.sub(r"\s+\Z", "", text["ascii"]).split("\n")
        art = [line for line in lines if len(lines) > 1 or line.strip()]
        if len(art) > BUDGET["art_lines"]:
            add("ascii", "art-lines", f"{len(art)} lines (budget {BUDGET['art_lines']})")
        widest = max(jslen(line) for line in art)
        if widest > BUDGET["art_cols"]:
            add("ascii", "art-cols", f"{widest} columns wide (budget {BUDGET['art_cols']})")
    if "commands" in c and c["commands"] is not None:
        cmds = c["commands"]
        if not isinstance(cmds, list):
            add("commands", "shape", "must be a list of {where, run} blocks")
        else:
            if len(cmds) > BUDGET["command_blocks"]:
                add("commands", "commands-count", f"{len(cmds)} blocks (budget {BUDGET['command_blocks']})")
            for i, b in enumerate(cmds):
                if not isinstance(b, dict):
                    add(f"commands[{i}]", "shape", "must be {where, run}")
                    continue
                if set(b) - {"where", "run"}:
                    add(f"commands[{i}]", "unknown-field", "has a field a command block does not know (it takes where, run)")
                for k, what in (("where", 'missing: where to run it, like "On the dev server"'), ("run", "missing: the command to run")):
                    if not isinstance(b.get(k), str) and k in b:
                        add(f"commands[{i}].{k}", "shape", "must be text")
                    elif not (b.get(k) or "").strip():
                        add(f"commands[{i}].{k}", "missing", what)
    if kind == "action" and (not partial or has("kind", "commands")):
        cmds = c.get("commands") if isinstance(c.get("commands"), list) else []
        if not any(isinstance(b, dict) and isinstance(b.get("run"), str) and b["run"].strip() for b in cmds):
            add("commands", "action-commands", "an Action card needs at least one command block")
    if "note" in text:
        for n, widest, at in wide_pictures(text["note"]):
            add("note", "note-art-cols", f"picture {n} is {widest} columns wide at line {at} "
                                         f"(budget {BUDGET['note_art_cols']}, so it fits a phone)")

    _face_rules(add, _face_text(c), clock=[(k, c.get(k)) for k in ("title", "about")], codes=codes_on(c))
    return out


def _depth_ok(obj) -> bool:
    stack = [(obj, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_DEPTH:
            return False
        if isinstance(node, dict):
            stack.extend((v, depth + 1) for v in node.values())
        elif isinstance(node, list):
            stack.extend((v, depth + 1) for v in node)
    return True


def check_card(c: dict, *, partial: bool = False) -> list[Refusal]:
    if not isinstance(c, dict):
        return [Refusal("card", "shape", "must be one JSON object")]
    if not _depth_ok(c):
        return [Refusal("card", "json", f"is nested more than {MAX_DEPTH} levels deep")]
    return guard_refusals(c) or _card_rules(c, partial=partial)


def merge_update(base: dict, changed: dict) -> dict:
    merged = {k: v for k, v in base.items() if k not in ("qd", "card", "rev")}
    for key, value in changed.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


class _Duplicate(ValueError):
    pass


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise _Duplicate("a field appears twice")
        out[key] = value
    return out


def _no_constants(name):
    raise ValueError("NaN and Infinity are not JSON")


def _load(body) -> tuple[dict | None, list[Refusal]]:
    if isinstance(body, str):
        try:
            raw = body.encode("utf-8")
        except UnicodeEncodeError:
            return None, [Refusal("body", "json", "must be UTF-8 text")]
    elif isinstance(body, (bytes, bytearray)):
        raw = bytes(body)
    else:
        return None, [Refusal("body", "json", "must be one UTF-8 JSON object")]
    if len(raw) > MAX_BODY_BYTES:
        return None, [Refusal("body", "size", f"is {len(raw)} bytes; the most is {MAX_BODY_BYTES} (64 KB), so move detail out")]
    try:
        obj = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_no_constants)
    except UnicodeDecodeError:
        return None, [Refusal("body", "json", "must be UTF-8 text")]
    except json.JSONDecodeError as err:
        return None, [Refusal("body", "json", f"must be one JSON object ({err.msg} at line {err.lineno} column {err.colno})")]
    except (ValueError, RecursionError) as err:
        return None, [Refusal("body", "json", f"must be one JSON object ({err if isinstance(err, _Duplicate) or 'NaN' in str(err) else 'it could not be read'})")]
    if not isinstance(obj, dict):
        return None, [Refusal("body", "json", "must be one JSON object, not a list or a single value")]
    if not _depth_ok(obj):
        return None, [Refusal("body", "json", f"is nested more than {MAX_DEPTH} levels deep")]
    return obj, []


def _kind_of(subject):
    if not isinstance(subject, str) or "\n" in subject or "\r" in subject:
        return None, None
    for kind, prefix in PREFIX.items():
        if subject.startswith(prefix + ": "):
            return kind, subject[len(prefix) + 2:]
    return None, None


def _card_ref(add, obj):
    cid = obj.get("card")
    if cid is None:
        add("card", "missing", "missing: the id of the card this mail is about")
    elif not (isinstance(cid, str) and len(cid) <= MAX_ID and CARD_ID.fullmatch(cid)):
        add("card", "id-shape", "must be a card id: Q<n> or <bot>-<n>")
    return cid if isinstance(cid, str) else None


def _unknown_body_fields(add, kind, obj, allowed):
    unknown = len(set(obj) - set(allowed))
    if unknown:
        add(kind, "unknown-field", f"has {unknown} field{'s' if unknown != 1 else ''} a {kind} mail does not know "
                                   f"(it takes {', '.join(allowed)})")


def id_px_over(item_id: str) -> int:
    px = {
        **{d: 12.77 for d in "0123456789"}, "-": 7.22, "_": 8.9,
        "A": 14.32, "B": 14.09, "C": 13.53, "D": 15.43, "E": 12.52, "F": 12.52, "G": 15.25, "H": 15.56, "I": 6.37,
        "J": 6.37, "K": 14.34, "L": 11.61, "M": 18.69, "N": 15.56, "O": 15.83, "P": 13.51, "Q": 15.83, "R": 14.24,
        "S": 12.41, "T": 12.93, "U": 15.07, "V": 14.32, "W": 20.83, "X": 14.26, "Y": 13.33, "Z": 13.35,
        "a": 12.36, "b": 13.17, "c": 10.74, "d": 13.17, "e": 12.43, "f": 7.02, "g": 13.17, "h": 13.09, "i": 5.79,
        "j": 5.79, "k": 12.16, "l": 5.79, "m": 19.62, "n": 13.09, "o": 12.6, "p": 13.17, "q": 13.17, "r": 8.76,
        "s": 10.78, "t": 8.47, "u": 13.09, "v": 11.9, "w": 17.28, "x": 11.77, "y": 11.9, "z": 10.52,
    }
    width = 29
    for ch in item_id:
        width += px.get(ch, px["W"])
    return math.ceil(width - 232) if width > 232 else 0


def _comment_id_rule(add, where, value, *, width):
    if not (isinstance(value, str) and FORM_ID.fullmatch(value)):
        add(where, "id-shape", "must be up to 32 letters, digits, - or _, like Q77-2")
    elif width and (over := id_px_over(value)):
        add(where, "id-width", f"is about {over} px too wide for the iPhone (390) layout, which holds 232 px; "
                               "shorten it, like MAC-TIMES-3B")


def _rev_rule(add, obj, least):
    rev = obj.get("rev")
    if not (isinstance(rev, int) and not isinstance(rev, bool) and rev >= least):
        add("rev", "rev", "must be the next revision number: 2 for the first update, then 3, and so on" if least == 2
            else "must be the revision he answered, 1 or more")


def parse_mail(subject, body, *, now: datetime | None = None) -> Parsed:
    kind, rest = _kind_of(subject)
    if kind is None:
        return Parsed(None, None, None, [Refusal("subject", "subject", "must be one line starting CARD:, UPDATE:, "
                                                                        "WITHDRAW:, COMMENT: or ANSWER: and a space")])
    obj, refused = _load(body)
    if refused:
        return Parsed(kind, None, None, refused)
    guarded = guard_refusals(obj, skip=("note",) if kind == "answer" else ())
    if guarded:
        return Parsed(kind, None, obj, guarded)
    if obj.get("qd") != FORMAT[kind]:
        return Parsed(kind, None, obj, [Refusal("qd", "format", f'must be "{FORMAT[kind]}" for a {PREFIX[kind]}: mail')])
    out: list[Refusal] = []

    def add(where, rule, what, quote=None):
        out.append(Refusal(where, rule, what, quote))

    if kind == "card":
        card_id = obj.get("id") if isinstance(obj.get("id"), str) else None
        out.extend(_card_rules({k: v for k, v in obj.items() if k not in ("qd", "card")}, partial=False))
        if "card" in obj and obj["card"] != obj.get("id") or "card" not in obj:
            add("card", "card-field", "must equal id: every mail names its card in card")
        if rest != obj.get("title"):
            add("subject", "subject", "must be CARD: and the card's title, exactly")
    else:
        card_id = _card_ref(add, obj)
        if kind != "card" and rest != (f"{card_id} {obj.get('pick')}" if kind == "answer" else card_id):
            add("subject", "subject", f"must be {PREFIX[kind]}: and the card id" + (" and the pick" if kind == "answer" else ""))
        if kind == "update":
            fixed = [k for k in FIXED_ON_UPDATE if k in obj]
            for k in fixed:
                add(k, "fixed", "cannot change in an UPDATE; withdraw the card and post a new one instead")
            _unknown_body_fields(add, "update", {k: v for k, v in obj.items() if k not in FIXED_ON_UPDATE},
                                 BODY_FIELDS["update"] + tuple(k for k in CARD_FIELDS if k not in FIXED_ON_UPDATE))
            _rev_rule(add, obj, 2)
            changed = {k: v for k, v in obj.items() if k in CARD_FIELDS and k not in FIXED_ON_UPDATE}
            if not changed:
                add("update", "missing", "has no changed fields: give each field that changes, or null to remove one")
            for k, v in changed.items():
                if v is None and k in NEVER_REMOVED:
                    add(k, "missing", "cannot be removed: every card has one")
            out.extend(_card_rules({k: v for k, v in changed.items() if v is not None}, partial=True))
        elif kind == "withdraw":
            _unknown_body_fields(add, "withdraw", obj, BODY_FIELDS["withdraw"])
            why = obj.get("why")
            if not isinstance(why, str) and why is not None:
                add("why", "shape", "must be text")
            elif not (why or "").strip():
                add("why", "missing", "missing: one line on why the card is withdrawn")
            elif jslen(why) > BUDGET["withdraw_why"]:
                add("why", "budget", f"{jslen(why)} characters (budget {BUDGET['withdraw_why']})")
            _face_rules(add, [("why", why)] if isinstance(why, str) else [])
        elif kind == "comment":
            _unknown_body_fields(add, "comment", obj, BODY_FIELDS["comment"])
            text = obj.get("text")
            if not isinstance(text, str) and text is not None:
                add("text", "shape", "must be plain text")
            elif not (text or "").strip():
                add("text", "missing", "missing: plain words (line breaks allowed); with options, say what the choice is")
            small = {k: obj[k] for k in ("options", "pick_why") if k in obj}
            if "options" in small:
                _options_rules(add, small, need_count=True)
                _pick_why_rule(add, small, required=True)
                if "id" not in obj:
                    add("id", "missing", "is needed with options: the name his pick goes back with, up to 32 letters, "
                                         "digits, - or _, like Q77-2")
            elif "pick_why" in small:
                _pick_why_rule(add, small, required=False)
            if "id" in obj:
                _comment_id_rule(add, "id", obj["id"], width=True)
            _face_rules(add, _face_text(small, extra=[("text", text)]), codes=codes_on(small))
        elif kind == "answer":
            _unknown_body_fields(add, "answer", obj, BODY_FIELDS["answer"])
            _rev_rule(add, obj, 1)
            if obj.get("pick") not in PICKS:
                add("pick", "pick", "must be A, B, C, D, cant-decide or none")
            if "note" in obj and not isinstance(obj["note"], str):
                add("note", "shape", "must be text")
            if "comment" in obj:
                _comment_id_rule(add, "comment", obj["comment"], width=False)
            at = obj.get("at")
            if not _iso_ok(at):
                add("at", "at-format", "must be the date and time he answered, with its offset")
            elif ahead := minutes_ahead(at, now):
                add("at", "at-ahead", f"is {ahead} min ahead of the clock; use the time it is sent")
    return Parsed(kind, card_id, obj, out)


def check_mail(subject, body, *, sender: str | None = None, registry: "Registry | None" = None,
               poster: str | None = None, base: dict | None = None, current_rev: int | None = None,
               now: datetime | None = None) -> Parsed:
    parsed = parse_mail(subject, body, now=now)
    if parsed.kind is None or parsed.obj is None or any(r.rule in ("json", "size", "guard", "format") for r in parsed.refusals):
        return parsed
    kind, obj, out = parsed.kind, parsed.obj, list(parsed.refusals)

    def add(where, rule, what):
        if (where, rule) not in {(r.field, r.rule) for r in out}:
            out.append(Refusal(where, rule, what))

    if kind == "update":
        rev = obj.get("rev")
        if current_rev is not None and isinstance(rev, int) and rev != current_rev + 1:
            add("rev", "rev", f"must be {current_rev + 1}: the card is at rev {current_rev}")
        if base is not None:
            changed = {k: v for k, v in obj.items() if k in CARD_FIELDS and k not in FIXED_ON_UPDATE}
            for r in _card_rules(merge_update(base, changed), partial=False):
                add(r.field, r.rule, r.what)
    server = registry is not None
    steward = registry.steward if server else None
    if sender is not None:
        if kind == "card":
            cid = obj.get("id")
            m = CARD_ID.fullmatch(cid) if isinstance(cid, str) else None
            if m and m.group("bot") is None and sender != steward:
                add("id", "id-owner", f"Q numbers are kept for cards imported from the old page; post yours as {sender}-<n>")
            elif m and m.group("bot") is not None and m.group("bot") != sender:
                add("id", "id-owner", f"must start with your bot name: {sender}-<n>")
            if server and sender != steward:
                lead = registry.lead_of(obj.get("project"))
                if lead is None:
                    add("project", "owner", "is not in the Quarterdeck registry; ask for it to be added, or ask the "
                                            "steward bot to post the card")
                elif lead != sender:
                    add("project", "owner", "is led by another bot; only a project's lead bot (or the steward bot) posts "
                                            "cards into it")
        elif kind in ("update", "withdraw"):
            if server and poster is None:
                add("card", "unknown-card", "names a card Quarterdeck does not have")
            elif poster is not None and sender not in (poster, steward):
                add("card", "owner", "only the bot that posted the card, or the steward bot, may change or withdraw it")
        elif kind == "comment":
            if server and poster is None:
                add("card", "unknown-card", "names a card Quarterdeck does not have")
        elif kind == "answer":
            if not server or sender != registry.captain:
                add("card", "owner", "only the Captain's account sends answers")
            elif poster is None:
                add("card", "unknown-card", "names a card Quarterdeck does not have")
    return Parsed(kind, parsed.card, obj, out)


def resend_key(kind: str, obj: dict) -> str:
    if kind == "card":
        return f"card:{obj['id']}:rev1"
    if kind == "update":
        return f"update:{obj['card']}:rev{obj['rev']}"
    if kind == "withdraw":
        return f"withdraw:{obj['card']}"
    if kind == "comment":
        if isinstance(obj.get("id"), str):
            return f"comment:{obj['card']}:{obj['id']}"
        return f"comment:{obj['card']}:{hashlib.sha256(canonical(obj).encode()).hexdigest()[:16]}"
    raise ValueError(f"no resend key for {kind}")


BOT_KINDS = ("card", "update", "withdraw", "comment")


def build_mail(kind: str, payload: dict, *, now: datetime | None = None) -> Mail:
    if kind == "answer":
        raise CardRefused([Refusal("qd", "owner", "only the Captain's account sends answers")])
    if kind not in BOT_KINDS:
        raise CardRefused([Refusal("qd", "format", "the kind must be card, update, withdraw or comment")])
    if not isinstance(payload, dict):
        raise CardRefused([Refusal("body", "json", "must be one JSON object")])
    obj = dict(payload)
    if obj.setdefault("qd", FORMAT[kind]) != FORMAT[kind]:
        raise CardRefused([Refusal("qd", "format", f'must be "{FORMAT[kind]}" for a {PREFIX[kind]}: mail')])
    if kind == "card":
        obj.setdefault("card", obj.get("id"))
        title = obj.get("title")
        subject = "CARD: " + " ".join((title if isinstance(title, str) else "").splitlines())
    else:
        subject = f"{PREFIX[kind]}: " + " ".join(str(obj.get("card")).splitlines())
    try:
        body = canonical(obj)
    except (TypeError, ValueError):
        raise CardRefused([Refusal("body", "json", "must hold only JSON values (text, numbers, true, false, lists, objects)")]) from None
    parsed = parse_mail(subject, body, now=now)
    if parsed.refusals:
        raise CardRefused(parsed.refusals)
    return Mail(kind, subject, body, parsed.card, resend_key(kind, obj))


def build_answers(card: str, rev: int, pick: str, *, comment: str | None = None, note: str = "", at: str, poster: str,
                  registry: "Registry", now: datetime | None = None) -> tuple[list[tuple[str, Mail]], int]:
    if not isinstance(poster, str) or not BOT_NAME.fullmatch(poster):
        raise ValueError("poster must be a bot name")
    masked, hits = mask_guarded(note) if note else ("", 0)
    obj = {"qd": FORMAT["answer"], "card": card, "rev": rev, "pick": pick, "note": masked, "at": at}
    if comment is not None:
        obj["comment"] = comment
    subject = f"ANSWER: {card} {pick}"
    body = canonical(obj)
    parsed = parse_mail(subject, body, now=now)
    if parsed.refusals:
        raise CardRefused(parsed.refusals)
    recipients = [poster] + ([registry.steward] if registry.steward != poster else [])
    named = f"{card}:{comment}" if comment is not None else card
    return [(to, Mail("answer", subject, body, card, f"answer:{named}:rev{rev}:{pick}:to-{to}")) for to in recipients], hits


class Registry:
    __slots__ = ("steward", "captain", "projects")

    def __init__(self, *, steward: str, captain: str, projects: dict):
        for who in (steward, captain):
            if not (isinstance(who, str) and BOT_NAME.fullmatch(who)):
                raise RegistryError("steward and captain must be account names")
        if steward == captain:
            raise RegistryError("steward and captain must be two accounts")
        if not isinstance(projects, dict):
            raise RegistryError("projects must map each project to its lead bot")
        for name, lead in projects.items():
            if not (isinstance(name, str) and name.strip() and "\n" not in name and "\r" not in name):
                raise RegistryError("each project name must be one non-empty line")
            if not (isinstance(lead, str) and BOT_NAME.fullmatch(lead)):
                raise RegistryError("each project's lead must be a bot name")
        self.steward, self.captain, self.projects = steward, captain, MappingProxyType(dict(projects))

    @classmethod
    def from_json(cls, doc) -> "Registry":
        if not (isinstance(doc, dict) and set(doc) == {"format", "steward", "captain", "projects"} and doc["format"] == 1):
            raise RegistryError("the registry must be {format: 1, steward, captain, projects}")
        return cls(steward=doc["steward"], captain=doc["captain"], projects=doc["projects"])

    @classmethod
    def load(cls, path) -> "Registry":
        try:
            doc = json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=_pairs)
        except (OSError, ValueError) as err:
            raise RegistryError(f"the registry file could not be read ({type(err).__name__})") from None
        return cls.from_json(doc)

    def lead_of(self, project):
        return self.projects.get(project) if isinstance(project, str) else None
