import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CLIENT_HEIGHT = 300
ARTICLE_HEIGHT = 60
BUTTON_HEIGHT = 44
HARNESS = r"""
const fs = require("node:fs");
const vm = require("node:vm");

const scenario = JSON.parse(process.argv[2]);
const source = fs.readFileSync(process.argv[3], "utf8");
const CLIENT_HEIGHT = scenario.clientHeight;
const ARTICLE_HEIGHT = scenario.articleHeight;
const BUTTON_HEIGHT = scenario.buttonHeight;

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
    this.top = 0;
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
    this.top = Math.min(this.top, this.maxTop());
  }

  maxTop() {
    return Math.max(0, this.scrollHeight - this.clientHeight);
  }

  get clientHeight() {
    return CLIENT_HEIGHT;
  }

  get scrollHeight() {
    return this.children.reduce(
      (sum, child) => sum + (child.tag === "button" ? BUTTON_HEIGHT : ARTICLE_HEIGHT),
      0,
    );
  }

  get scrollTop() {
    return this.top;
  }

  set scrollTop(value) {
    this.top = Math.max(0, Math.min(value, this.maxTop()));
  }

  dispatch(name, event = {}) {
    return Promise.all((this.listeners[name] || []).map((listener) => listener(event)));
  }
}

function textOf(node) {
  if (node.className === "who") {
    return "";
  }
  if (node.text !== undefined) {
    return node.text;
  }
  return (node.textContent || "") + (node.children || []).map(textOf).join("");
}

const server = {threads: {}, notes: {}, issued: 0};

function reply(status, body) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}

async function fetchStub(url, options = {}) {
  const method = options.method || "GET";
  server.issued += 1;
  if (method === "GET" && url === "/captain/api/chats") {
    return reply(200, {
      chats: Object.keys(server.threads).map((id) => ({id})),
      csrf: `token-${server.issued}`,
    });
  }
  const bot = decodeURIComponent(url.split("with=")[1]);
  if (method === "GET") {
    const info = {id: bot};
    if (server.notes[bot]) {
      info.note = server.notes[bot];
    }
    return reply(200, {
      bot: info,
      messages: server.threads[bot],
      seenUpTo: null,
      writing: false,
      csrf: `token-${server.issued}`,
    });
  }
  const posted = JSON.parse(options.body);
  const message = {
    id: `sent-${server.threads[bot].length + 1}`,
    clientId: posted.requestId,
    from: "account",
    at: "now",
    text: posted.text,
  };
  server.threads[bot].push(message);
  return reply(200, {status: "sent", message, csrf: `token-${server.issued}`});
}

async function settle() {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function findButton(node, text) {
  if (node.tag === "button" && node.textContent === text) {
    return node;
  }
  for (const child of node.children || []) {
    const found = findButton(child, text);
    if (found) {
      return found;
    }
  }
  return null;
}

function seed(bot, count) {
  server.threads[bot] = [];
  for (let number = 1; number <= count; number += 1) {
    server.threads[bot].push({id: `id-${bot}-${number}`, from: "bot", text: `m${number}`, at: "t"});
  }
}

(async () => {
  const elements = {};
  for (const id of ["bot", "composer", "message", "reload", "status", "thread", "typing", "note", "newer", "freshness"]) {
    elements[id] = new Element(id);
  }
  elements.newer.hidden = true;
  const listeners = {};
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
      addEventListener(name, listener) {
        listeners[name] = listener;
      }
    },
    Option: class {
      constructor(text, value) {
        this.text = text;
        this.value = value;
      }
    },
    crypto: {randomUUID: () => `client-${++clients}`},
  };
  for (const [bot, count] of Object.entries(scenario.threads)) {
    seed(bot, count);
  }
  Object.assign(server.notes, scenario.notes || {});
  vm.createContext(context);
  vm.runInContext(source, context);
  await settle();

  const thread = elements.thread;

  function snapshot() {
    let offset = 0;
    const labels = [];
    const ys = {};
    for (const child of thread.children) {
      const label = child.tag === "button" ? child.textContent : textOf(child).replace(/Sent|Seen|Sending…|t$/g, "");
      labels.push(label);
      ys[label] = offset - thread.scrollTop;
      offset += child.tag === "button" ? BUTTON_HEIGHT : ARTICLE_HEIGHT;
    }
    return {
      labels,
      ys,
      scrollTop: thread.scrollTop,
      distance: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
      newerHidden: elements.newer.hidden,
      noteText: elements.note.textContent,
      noteHidden: elements.note.hidden,
    };
  }

  const shots = [];
  for (const step of scenario.steps) {
    if (step.op === "select") {
      elements.bot.value = step.bot;
      await elements.bot.dispatch("change");
    } else if (step.op === "scrollTo") {
      thread.scrollTop = step.top;
      await thread.dispatch("scroll");
    } else if (step.op === "distance") {
      thread.scrollTop = thread.scrollHeight - thread.clientHeight - step.pixels;
      await thread.dispatch("scroll");
    } else if (step.op === "arrive") {
      for (let number = 0; number < step.count; number += 1) {
        const next = server.threads[step.bot].length + 1;
        server.threads[step.bot].push({id: `id-${step.bot}-${next}`, from: "bot", text: `m${next}`, at: "t"});
      }
      await listeners.refresh({});
    } else if (step.op === "reload") {
      await elements.reload.dispatch("click");
    } else if (step.op === "click") {
      await findButton(thread, step.text).dispatch("click");
    } else if (step.op === "clickNewer") {
      await elements.newer.dispatch("click");
    } else if (step.op === "send") {
      elements.message.value = step.text;
      await elements.composer.dispatch("submit", {preventDefault() {}});
    }
    await settle();
    shots.push(snapshot());
  }
  console.log(JSON.stringify(shots));
})();
"""


def run_steps(threads, steps, notes=None):
    scenario = {
        "threads": threads,
        "steps": steps,
        "notes": notes or {},
        "clientHeight": CLIENT_HEIGHT,
        "articleHeight": ARTICLE_HEIGHT,
        "buttonHeight": BUTTON_HEIGHT,
    }
    completed = subprocess.run(
        ["node", "-", json.dumps(scenario), str(ROOT / "chat.js")],
        input=HARNESS,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


def articles(shot):
    return [label for label in shot["labels"] if label != "Show older"]


class WindowingTests(unittest.TestCase):
    def test_an_open_thread_shows_the_newest_fifteen_with_a_show_older_button(self):
        [shot] = run_steps({"iris": 40}, [{"op": "select", "bot": "iris"}])

        self.assertEqual(shot["labels"][0], "Show older")
        self.assertEqual(articles(shot), [f"m{number}" for number in range(26, 41)])
        self.assertEqual(shot["distance"], 0)

    def test_a_thread_of_fifteen_or_fewer_has_no_show_older_button(self):
        for count in (0, 1, 15):
            with self.subTest(count=count):
                [shot] = run_steps({"iris": count}, [{"op": "select", "bot": "iris"}])

                self.assertNotIn("Show older", shot["labels"])
                self.assertEqual(len(shot["labels"]), count)

    def test_show_older_reveals_fifteen_more_per_tap_until_all_are_shown(self):
        _, first, second, third = run_steps(
            {"iris": 40},
            [
                {"op": "select", "bot": "iris"},
                {"op": "click", "text": "Show older"},
                {"op": "click", "text": "Show older"},
                {"op": "reload"},
            ],
        )

        self.assertEqual(len(articles(first)), 30)
        self.assertEqual(articles(first)[0], "m11")
        self.assertIn("Show older", first["labels"])
        self.assertEqual(articles(second), [f"m{number}" for number in range(1, 41)])
        self.assertNotIn("Show older", second["labels"])
        self.assertEqual(articles(third), articles(second))

    def test_show_older_keeps_the_message_being_read_where_it_was(self):
        _, scrolled, after = run_steps(
            {"iris": 40},
            [
                {"op": "select", "bot": "iris"},
                {"op": "scrollTo", "top": 0},
                {"op": "click", "text": "Show older"},
            ],
        )

        self.assertEqual(scrolled["ys"]["m26"], BUTTON_HEIGHT)
        self.assertEqual(after["ys"]["m26"], scrolled["ys"]["m26"])

    def test_show_older_keeps_place_when_the_reader_is_part_way_down(self):
        _, scrolled, after = run_steps(
            {"iris": 40},
            [
                {"op": "select", "bot": "iris"},
                {"op": "scrollTo", "top": 200},
                {"op": "click", "text": "Show older"},
            ],
        )

        self.assertEqual(after["ys"]["m27"], scrolled["ys"]["m27"])


class ScrollRuleTests(unittest.TestCase):
    def test_new_messages_keep_a_reader_at_the_bottom_when_already_at_the_bottom(self):
        _, shot = run_steps(
            {"iris": 20},
            [{"op": "select", "bot": "iris"}, {"op": "arrive", "bot": "iris", "count": 3}],
        )

        self.assertEqual(shot["distance"], 0)
        self.assertEqual(articles(shot)[-1], "m23")
        self.assertTrue(shot["newerHidden"])

    def test_within_120_pixels_of_the_bottom_still_follows_new_messages(self):
        _, near, shot = run_steps(
            {"iris": 20},
            [
                {"op": "select", "bot": "iris"},
                {"op": "distance", "pixels": 120},
                {"op": "arrive", "bot": "iris", "count": 2},
            ],
        )

        self.assertEqual(near["distance"], 120)
        self.assertEqual(shot["distance"], 0)
        self.assertTrue(shot["newerHidden"])

    def test_scrolled_up_keeps_place_and_shows_the_new_messages_button(self):
        _, scrolled, shot = run_steps(
            {"iris": 20},
            [
                {"op": "select", "bot": "iris"},
                {"op": "distance", "pixels": 121},
                {"op": "arrive", "bot": "iris", "count": 2},
            ],
        )

        self.assertEqual(scrolled["distance"], 121)
        self.assertFalse(shot["newerHidden"])
        self.assertEqual(shot["scrollTop"], scrolled["scrollTop"])
        self.assertEqual(shot["ys"]["m10"], scrolled["ys"]["m10"])
        self.assertEqual(articles(shot)[0], articles(scrolled)[0])

    def test_the_new_messages_button_jumps_to_the_bottom_and_hides(self):
        *_, shot = run_steps(
            {"iris": 20},
            [
                {"op": "select", "bot": "iris"},
                {"op": "scrollTo", "top": 0},
                {"op": "arrive", "bot": "iris", "count": 1},
                {"op": "clickNewer"},
            ],
        )

        self.assertEqual(shot["distance"], 0)
        self.assertTrue(shot["newerHidden"])

    def test_scrolling_back_near_the_bottom_hides_the_new_messages_button(self):
        *_, shot = run_steps(
            {"iris": 20},
            [
                {"op": "select", "bot": "iris"},
                {"op": "scrollTo", "top": 0},
                {"op": "arrive", "bot": "iris", "count": 1},
                {"op": "distance", "pixels": 50},
            ],
        )

        self.assertTrue(shot["newerHidden"])

    def test_a_refresh_with_nothing_new_keeps_the_place_and_shows_no_button(self):
        _, scrolled, shot = run_steps(
            {"iris": 20},
            [
                {"op": "select", "bot": "iris"},
                {"op": "scrollTo", "top": 0},
                {"op": "reload"},
            ],
        )

        self.assertEqual(shot["scrollTop"], scrolled["scrollTop"])
        self.assertTrue(shot["newerHidden"])

    def test_sending_scrolls_to_the_bottom_even_when_scrolled_up(self):
        *_, shot = run_steps(
            {"iris": 20},
            [
                {"op": "select", "bot": "iris"},
                {"op": "scrollTo", "top": 0},
                {"op": "send", "text": "hello"},
            ],
        )

        self.assertEqual(shot["distance"], 0)
        self.assertEqual(articles(shot)[-1], "hello")

    def test_switching_chats_opens_the_new_thread_at_the_bottom_with_a_fresh_window(self):
        _, _, _, other, back = run_steps(
            {"iris": 40, "fern": 30},
            [
                {"op": "select", "bot": "iris"},
                {"op": "click", "text": "Show older"},
                {"op": "scrollTo", "top": 0},
                {"op": "select", "bot": "fern"},
                {"op": "select", "bot": "iris"},
            ],
        )

        self.assertEqual(other["distance"], 0)
        self.assertEqual(articles(other), [f"m{number}" for number in range(16, 31)])
        self.assertEqual(back["distance"], 0)
        self.assertEqual(len(articles(back)), 15)


class NoteTests(unittest.TestCase):
    def test_a_note_is_shown_as_plain_text_under_the_header(self):
        text = "<b>Approve</b> each mail & wait"
        _, shot = run_steps(
            {"iris": 3, "fern": 3},
            [{"op": "select", "bot": "iris"}, {"op": "select", "bot": "fern"}],
            notes={"fern": text},
        )

        self.assertEqual(shot["noteText"], text)
        self.assertFalse(shot["noteHidden"])

    def test_no_note_hides_the_note_line_and_a_switch_clears_it(self):
        first, second = run_steps(
            {"iris": 3, "fern": 3},
            [{"op": "select", "bot": "fern"}, {"op": "select", "bot": "iris"}],
            notes={"fern": "Only for fern"},
        )

        self.assertFalse(first["noteHidden"])
        self.assertTrue(second["noteHidden"])
        self.assertEqual(second["noteText"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
