import json
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FAILURE_LINE = "Message was not sent. Retry when ready."
HARNESS = r"""
const fs = require("node:fs");
const vm = require("node:vm");

const scenario = JSON.parse(process.argv[2]);
const source = fs.readFileSync(process.argv[3], "utf8");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.type = "";
    this.classList = {
      add: (name) => {
        this.className = `${this.className} ${name}`.trim();
      },
    };
  }

  addEventListener(name, listener) {
    (this.listeners[name] ||= []).push(listener);
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  dispatch(name, event = {}) {
    return Promise.all((this.listeners[name] || []).map((listener) => listener(event)));
  }
}

const server = {valid: null, issued: 0, requests: [], accepted: [], failures: 0};

function issue() {
  server.issued += 1;
  server.valid = `token-${server.issued}`;
  return server.valid;
}

function reply(status, body) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}

async function fetchStub(url, options = {}) {
  const method = options.method || "GET";
  const posted = method === "POST" ? JSON.parse(options.body) : null;
  const entry = {
    method,
    url,
    csrf: posted ? posted.csrf : null,
    requestId: posted ? posted.requestId : null,
    status: null,
    issued: null,
  };
  server.requests.push(entry);
  if (server.requests.length > 40) {
    throw new TypeError("runaway requests");
  }
  const sent = server.requests.filter((item) => item.method === "POST").length;
  let answer;
  if (method === "GET" && url === "/captain/api/chats") {
    entry.issued = issue();
    answer = reply(200, {chats: [{id: "bot-d"}], csrf: entry.issued});
  } else if (method === "GET") {
    if (scenario.threadRefusedAfterPost && sent > 0) {
      answer = reply(403, {error: "request refused"});
    } else {
      entry.issued = issue();
      answer = reply(200, {
        bot: {id: "bot-d"},
        messages: server.accepted,
        seenUpTo: null,
        writing: false,
        csrf: entry.issued,
      });
    }
  } else if (scenario.post === "network") {
    throw new TypeError("network down");
  } else if (typeof scenario.post === "number") {
    answer = reply(scenario.post, {error: "request refused"});
  } else if (posted.csrf !== server.valid) {
    answer = reply(403, {error: "request refused"});
  } else {
    const message = {
      id: `message-${server.accepted.length + 1}`,
      clientId: posted.requestId,
      from: "account",
      at: "now",
      text: posted.text,
    };
    server.accepted.push(message);
    entry.issued = issue();
    answer = reply(200, {status: "sent", message, csrf: entry.issued});
  }
  entry.status = answer.status;
  return answer;
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function findRetry(node) {
  if (node.tag === "button" && node.textContent === "Retry") {
    return node;
  }
  for (const child of node.children || []) {
    const found = findRetry(child);
    if (found) {
      return found;
    }
  }
  return null;
}

(async () => {
  const elements = {};
  for (const id of ["bot", "composer", "message", "reload", "status", "thread", "typing", "note", "newer", "freshness"]) {
    elements[id] = new Element(id);
  }
  const statuses = [];
  let statusText = "";
  Object.defineProperty(elements.status, "textContent", {
    get: () => statusText,
    set: (value) => {
      statusText = value;
      statuses.push(value);
    },
  });
  let clients = 0;
  const context = {
    document: {
      getElementById: (id) => elements[id],
      createElement: (tag) => new Element(tag),
      createDocumentFragment: () => new Element("fragment"),
      createTextNode: (text) => ({text}),
    },
    fetch: fetchStub,
    setTimeout, clearTimeout,
    EventSource: class {
      addEventListener() {}
    },
    Option: class {
      constructor(text, value) {
        this.text = text;
        this.value = value;
      }
    },
    crypto: {randomUUID: () => `client-${++clients}`},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await settle();
  elements.bot.value = "bot-d";
  await elements.bot.dispatch("change");
  await settle();
  if (scenario.staleFirstToken) {
    issue();
  }
  elements.message.value = "hello";
  await elements.composer.dispatch("submit", {preventDefault() {}});
  await settle();
  if (scenario.clickRetry) {
    await findRetry(elements.thread).dispatch("click");
    await settle();
  }
  console.log(JSON.stringify({
    requests: server.requests,
    accepted: server.accepted,
    statuses,
    rows: elements.thread.children.map((row) => row.className),
    retryButton: findRetry(elements.thread) !== null,
  }));
})();
"""


def run_chat(scenario, source=ROOT / "chat.js"):
    completed = subprocess.run(
        ["node", "-", json.dumps(scenario), str(source)],
        input=HARNESS,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


def kinds(outcome):
    return [
        (item["method"], item["status"])
        for item in outcome["requests"]
    ]


def posts(outcome):
    return [item for item in outcome["requests"] if item["method"] == "POST"]


class ChatSendRetryTests(unittest.TestCase):
    def test_accepted_token_sends_once_with_no_refresh(self):
        outcome = run_chat({"post": "token"})

        self.assertEqual(
            kinds(outcome),
            [("GET", 200), ("GET", 200), ("POST", 200)],
        )
        self.assertEqual(outcome["statuses"][-1], "Sent")
        self.assertNotIn(FAILURE_LINE, outcome["statuses"])

    def test_refused_first_token_is_replaced_and_the_same_message_is_resent(self):
        outcome = run_chat({"post": "token", "staleFirstToken": True})

        self.assertEqual(
            kinds(outcome),
            [
                ("GET", 200),
                ("GET", 200),
                ("POST", 403),
                ("GET", 200),
                ("POST", 200),
            ],
        )
        first, second = posts(outcome)
        refresh = outcome["requests"][3]
        self.assertEqual(first["requestId"], second["requestId"])
        self.assertNotEqual(first["csrf"], second["csrf"])
        self.assertEqual(second["csrf"], refresh["issued"])
        self.assertEqual(
            [item["clientId"] for item in outcome["accepted"]],
            [first["requestId"]],
        )
        self.assertNotIn(FAILURE_LINE, outcome["statuses"])
        self.assertEqual(outcome["statuses"][-1], "Sent")
        self.assertFalse(outcome["retryButton"])
        self.assertTrue(
            all("failed" not in row for row in outcome["rows"])
        )

    def test_failure_line_shows_only_after_exactly_one_resend_is_also_refused(self):
        outcome = run_chat({"post": 403})

        self.assertEqual(
            kinds(outcome),
            [
                ("GET", 200),
                ("GET", 200),
                ("POST", 403),
                ("GET", 200),
                ("POST", 403),
                ("GET", 200),
            ],
        )
        first, second = posts(outcome)
        self.assertEqual(first["requestId"], second["requestId"])
        self.assertEqual(
            outcome["requests"][3]["issued"],
            second["csrf"],
        )
        self.assertEqual(outcome["accepted"], [])
        self.assertEqual(outcome["statuses"].count(FAILURE_LINE), 1)
        self.assertEqual(outcome["statuses"][-1], FAILURE_LINE)
        self.assertTrue(outcome["retryButton"])
        self.assertIn("failed", outcome["rows"][-1])

    def test_the_retry_button_starts_one_new_send_with_one_more_resend(self):
        outcome = run_chat({"post": 403, "clickRetry": True})

        self.assertEqual(
            [item["method"] for item in outcome["requests"]],
            ["GET", "GET"] + ["POST", "GET"] * 4,
        )
        self.assertEqual(
            len({item["requestId"] for item in posts(outcome)}),
            1,
        )
        self.assertEqual(outcome["statuses"][-1], FAILURE_LINE)

    def test_failures_other_than_403_are_not_resent(self):
        for failure in (500, 401, 404, 429, 503, "network"):
            with self.subTest(failure=failure):
                outcome = run_chat({"post": failure})

                self.assertEqual(
                    [item["method"] for item in outcome["requests"]],
                    ["GET", "GET", "POST", "GET"],
                )
                self.assertEqual(len(posts(outcome)), 1)
                self.assertEqual(outcome["statuses"][-1], FAILURE_LINE)
                self.assertTrue(outcome["retryButton"])

    def test_no_resend_when_the_fresh_token_cannot_be_fetched(self):
        outcome = run_chat({"post": 403, "threadRefusedAfterPost": True})

        self.assertEqual(
            kinds(outcome),
            [("GET", 200), ("GET", 200), ("POST", 403), ("GET", 403)],
        )
        self.assertEqual(len(posts(outcome)), 1)
        self.assertEqual(outcome["statuses"][-1], FAILURE_LINE)
        self.assertTrue(outcome["retryButton"])


class AnchorCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.anchors = []
        self.scripts = []
        self.inline_styles = 0
        self._open = None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._open = [attrs, ""]
        if tag == "script":
            self.scripts.append(dict(attrs))
        if tag == "style" or any(name == "style" for name, value in attrs):
            self.inline_styles += 1

    def handle_data(self, data):
        if self._open is not None:
            self._open[1] += data

    def handle_endtag(self, tag):
        if tag == "a" and self._open is not None:
            self.anchors.append(tuple(self._open))
            self._open = None


class ChatPageLinkTests(unittest.TestCase):
    def test_chat_page_has_a_plain_pending_joins_link(self):
        page = AnchorCollector()
        page.feed((ROOT / "chat.html").read_text(encoding="utf-8"))

        self.assertEqual(
            page.anchors,
            [([("href", "/captain/pending")], "Pending joins"), ([("href", "/captain/step-up?next=%2Fcaptain%2Fchat")], "Sign in again")],
        )
        self.assertEqual(
            page.scripts,
            [{"src": "/captain/assets/chat.js", "defer": None}],
        )
        self.assertEqual(page.inline_styles, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
