import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
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
    this.attributes = {};
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

  setAttribute(name, value) {
    this.attributes[name] = String(value);
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

let clock = 1000000;
class FakeDate extends Date {
  static now() {
    return clock;
  }

  constructor(...values) {
    if (values.length) {
      super(...values);
    } else {
      super(clock);
    }
  }
}

const tones = [];
const contexts = [];
class FakeAudioContext {
  constructor() {
    this.state = "suspended";
    this.currentTime = 0;
    this.destination = {};
    contexts.push(this);
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  createBuffer() {
    return {};
  }

  createBufferSource() {
    return {connect() {}, start() {}};
  }

  createGain() {
    return {gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}, connect() {}};
  }

  createOscillator() {
    const tone = {
      type: "",
      frequency: {value: 0},
      connect() {},
      start() {
        tones.push({type: tone.type, frequency: tone.frequency.value});
      },
      stop() {},
    };
    return tone;
  }
}

const bots = {};
let issued = 0;
const gets = {};
const posts = [];

function seed(bot, messages) {
  bots[bot] = messages.map((message, index) => ({
    id: message.id || `${bot}-${index + 1}`,
    from: message.from,
    text: message.text || "text",
    at: message.at || `t${index + 1}`,
  }));
}

function reply(status, body) {
  return {ok: status >= 200 && status < 300, status, json: async () => body};
}

async function fetchStub(url, options = {}) {
  const method = options.method || "GET";
  if (scenario.failPeekFor && url.includes(`with=${scenario.failPeekFor.bot}`) && scenario.failPeekFor.times > 0) {
    scenario.failPeekFor.times -= 1;
    return reply(500, {error: "request refused"});
  }
  if (method === "GET" && url === "/captain/api/chats") {
    const rows = Object.keys(bots).sort().map((id) => {
      const last = bots[id][bots[id].length - 1];
      return {id, preview: last ? last.text : "", at: last ? last.at : "", ...(scenario.noLast ? {} : {last: last ? last.id : ""}), unread: false};
    });
    issued += 1;
    return reply(200, {chats: rows, csrf: `token-${issued}`, freshUntil: 0});
  }
  if (method === "GET") {
    const bot = decodeURIComponent(url.split("with=")[1]);
    gets[bot] = (gets[bot] || 0) + 1;
    issued += 1;
    return reply(200, {
      bot: {id: bot},
      messages: bots[bot].map((message) => ({...message})),
      seenUpTo: null,
      writing: false,
      csrf: `token-${issued}`,
      freshUntil: 0,
    });
  }
  const posted = JSON.parse(options.body);
  const bot = decodeURIComponent(url.split("with=")[1]);
  const message = {
    id: `${bot}-${bots[bot].length + 1}`,
    clientId: posted.requestId,
    from: "account",
    at: `t${bots[bot].length + 1}`,
    text: posted.text,
  };
  bots[bot].push(message);
  posts.push(bot);
  issued += 1;
  return reply(200, {status: "sent", message, csrf: `token-${issued}`, freshUntil: 0});
}

async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

(async () => {
  const elements = {};
  for (const id of ["bot", "composer", "message", "reload", "status", "thread", "typing", "note", "newer", "freshness", "sound", "alert"]) {
    elements[id] = new Element(id);
  }
  elements.alert.hidden = true;
  Object.assign(elements.thread, {scrollHeight: 0, scrollTop: 0, clientHeight: 0});
  const documentListeners = {};
  const eventListeners = {};
  const store = {...(scenario.storage || {})};
  const doc = {
    title: "Quarterdeck chat",
    hidden: false,
    getElementById: (id) => elements[id],
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element("fragment"),
    createTextNode: (text) => ({text}),
    addEventListener: (name, listener) => {
      (documentListeners[name] ||= []).push(listener);
    },
    removeEventListener: (name, listener) => {
      documentListeners[name] = (documentListeners[name] || []).filter((item) => item !== listener);
    },
  };
  const context = {
    document: doc,
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    Date: FakeDate,
    EventSource: class {
      addEventListener(name, listener) {
        (eventListeners[name] ||= []).push(listener);
      }
    },
    Option: class {
      constructor(text, value) {
        this.text = text;
        this.value = value;
      }
    },
    crypto: {randomUUID: () => `client-${clients++}`},
    localStorage: scenario.noStorage ? undefined : {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => {
        store[key] = String(value);
      },
    },
  };
  let clients = 1;
  if (scenario.audio !== false) {
    context.AudioContext = FakeAudioContext;
  }
  for (const [bot, messages] of Object.entries(scenario.bots)) {
    seed(bot, messages);
  }
  vm.createContext(context);
  vm.runInContext(source, context);
  await settle();

  function snapshot(label) {
    return {
      label,
      tones: tones.length,
      toneFrequencies: tones.map((tone) => tone.frequency),
      contexts: contexts.length,
      title: doc.title,
      alertText: elements.alert.textContent,
      alertHidden: elements.alert.hidden,
      soundText: elements.sound.textContent,
      soundPressed: elements.sound.attributes["aria-pressed"],
      stored: store["qd-chat-sound"] === undefined ? null : store["qd-chat-sound"],
      gets: {...gets},
      posts: posts.length,
      documentListeners: Object.fromEntries(Object.entries(documentListeners).map(([name, list]) => [name, list.length])),
      rows: elements.thread.children.map((row) => ({
        className: row.className,
        names: (row.children || []).filter((child) => child.className === "who").map((child) => child.textContent),
      })),
    };
  }

  const snapshots = [snapshot("start")];
  for (const [index, step] of scenario.steps.entries()) {
    if (step.op === "tap") {
      await Promise.all((documentListeners[step.event || "click"] || []).slice().map((listener) => listener({})));
    } else if (step.op === "select") {
      elements.bot.value = step.bot;
      await elements.bot.dispatch("change");
    } else if (step.op === "server") {
      bots[step.bot].push({
        id: step.id || `${step.bot}-${bots[step.bot].length + 1}`,
        from: step.from,
        text: step.text || "new",
        at: step.at || `t${bots[step.bot].length + 1}`,
      });
    } else if (step.op === "refresh") {
      await Promise.all((eventListeners.refresh || []).map((listener) => listener({})));
    } else if (step.op === "advance") {
      clock += step.ms;
    } else if (step.op === "click") {
      await elements[step.id].dispatch("click");
    } else if (step.op === "hidden") {
      doc.hidden = step.value;
      if (!step.value) {
        await Promise.all((documentListeners.visibilitychange || []).map((listener) => listener({})));
      }
    } else if (step.op === "send") {
      elements.message.value = step.text;
      await elements.composer.dispatch("submit", {preventDefault() {}});
    }
    await settle();
    snapshots.push(snapshot(step.label || `step-${index + 1}`));
  }
  console.log(JSON.stringify(snapshots));
})();
"""


def run(steps, bots, storage=None, source=ROOT / "chat.js", **options):
    scenario = {"steps": steps, "bots": bots, **options}
    if storage is not None:
        scenario["storage"] = storage
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


def talk(*items):
    return [{"from": sender} for sender in items]


def arrive(bot, sender="bot", **extra):
    return {"op": "server", "bot": bot, "from": sender, **extra}


REFRESH = {"op": "refresh"}
TAP = {"op": "tap"}


class ChimeTests(unittest.TestCase):
    def test_a_new_bot_message_in_the_open_chat_plays_one_chime_after_the_first_tap(self):
        snapshots = run(
            [
                {"op": "select", "bot": "bot-a", "label": "opened"},
                {**TAP, "label": "tapped"},
                arrive("bot-a"),
                {**REFRESH, "label": "arrived"},
            ],
            {"bot-a": talk("bot", "account", "bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["opened"]["tones"], 0)
        self.assertEqual(by_label["tapped"]["contexts"], 1)
        self.assertEqual(by_label["arrived"]["tones"], 1)
        self.assertEqual(by_label["arrived"]["toneFrequencies"], [880])
        self.assertEqual(by_label["arrived"]["gets"]["bot-a"], 2)

    def test_nothing_plays_for_messages_already_there_when_the_page_or_a_chat_opens(self):
        snapshots = run(
            [TAP, {"op": "select", "bot": "bot-a"}, {"op": "select", "bot": "bot-b"}, {"op": "select", "bot": "bot-a"}],
            {"bot-a": talk("bot", "bot"), "bot-b": talk("account", "bot")},
        )
        self.assertEqual([item["tones"] for item in snapshots], [0] * len(snapshots))
        self.assertEqual(snapshots[-1]["title"], "Quarterdeck chat")

    def test_his_own_messages_never_play_a_chime(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-a", "account"),
                {**REFRESH, "label": "other-device"},
                {"op": "send", "text": "hello", "label": "sent-here"},
                {**REFRESH, "label": "after-refresh"},
            ],
            {"bot-a": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        for label in ("other-device", "sent-here", "after-refresh"):
            self.assertEqual(by_label[label]["tones"], 0, label)
        self.assertEqual(by_label["sent-here"]["posts"], 1)

    def test_a_message_from_another_bot_is_found_from_the_chat_list(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                {**REFRESH, "label": "arrived"},
                {"op": "select", "bot": "bot-b", "label": "opened"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("account", "bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        arrived = by_label["arrived"]
        self.assertEqual(arrived["tones"], 1)
        self.assertFalse(arrived["alertHidden"])
        self.assertEqual(arrived["alertText"], "New message from bot-b")
        self.assertTrue(arrived["title"].startswith("\u25cf "))
        self.assertEqual(arrived["gets"]["bot-b"], 1)
        self.assertEqual(arrived["gets"]["bot-a"], 2)
        opened = by_label["opened"]
        self.assertTrue(opened["alertHidden"])
        self.assertEqual(opened["title"], "Quarterdeck chat")

    def test_another_bots_message_from_him_or_an_unchanged_list_never_plays(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", "account"),
                {**REFRESH, "label": "his-own"},
                {**REFRESH, "label": "unchanged"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["his-own"]["tones"], 0)
        self.assertTrue(by_label["his-own"]["alertHidden"])
        self.assertEqual(by_label["unchanged"]["gets"]["bot-b"], 1)

    def test_at_most_one_chime_every_five_seconds(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-a"),
                {**REFRESH, "label": "first"},
                {"op": "advance", "ms": 1000},
                arrive("bot-a"),
                {**REFRESH, "label": "one-second-later"},
                {"op": "advance", "ms": 3999},
                arrive("bot-a"),
                {**REFRESH, "label": "just-under-five"},
                {"op": "advance", "ms": 1},
                arrive("bot-a"),
                {**REFRESH, "label": "five-seconds"},
            ],
            {"bot-a": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["first"]["tones"], 1)
        self.assertEqual(by_label["one-second-later"]["tones"], 1)
        self.assertEqual(by_label["just-under-five"]["tones"], 1)
        self.assertEqual(by_label["five-seconds"]["tones"], 2)

    def test_two_bots_arriving_together_share_the_same_five_second_limit(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-a"),
                arrive("bot-b"),
                {**REFRESH, "label": "together"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        self.assertEqual(snapshots[-1]["tones"], 1)
        self.assertEqual(snapshots[-1]["alertText"], "New message from bot-b")

    def test_no_sound_before_the_first_tap_but_the_line_and_dot_still_show(self):
        snapshots = run(
            [
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                {**REFRESH, "label": "locked"},
                TAP,
                arrive("bot-b"),
                {**REFRESH, "label": "unlocked"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["locked"]["tones"], 0)
        self.assertEqual(by_label["locked"]["contexts"], 0)
        self.assertEqual(by_label["locked"]["alertText"], "New message from bot-b")
        self.assertEqual(by_label["unlocked"]["tones"], 1)

    def test_any_of_click_touch_or_key_unlocks_once_and_stops_listening(self):
        for event in ("click", "touchend", "keydown"):
            with self.subTest(event=event):
                snapshots = run([{**TAP, "event": event, "label": "tapped"}], {"bot-a": talk("bot")})
                tapped = snapshots[-1]
                self.assertEqual(tapped["contexts"], 1)
                for name in ("click", "touchend", "keydown"):
                    self.assertEqual(tapped["documentListeners"][name], 0)

    def test_the_sound_switch_silences_the_chime_and_is_remembered(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                {"op": "click", "id": "sound", "label": "switched-off"},
                arrive("bot-a"),
                {**REFRESH, "label": "silent"},
                {"op": "click", "id": "sound", "label": "switched-on"},
                {"op": "advance", "ms": 6000},
                arrive("bot-a"),
                {**REFRESH, "label": "audible"},
            ],
            {"bot-a": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["start"]["soundText"], "Sound on")
        self.assertEqual(by_label["switched-off"]["soundText"], "Sound off")
        self.assertEqual(by_label["switched-off"]["soundPressed"], "false")
        self.assertEqual(by_label["switched-off"]["stored"], "off")
        self.assertEqual(by_label["silent"]["tones"], 0)
        self.assertEqual(by_label["silent"]["alertText"], "")
        self.assertEqual(by_label["switched-on"]["stored"], "on")
        self.assertEqual(by_label["audible"]["tones"], 1)

    def test_a_stored_off_choice_is_read_when_the_page_opens(self):
        snapshots = run(
            [TAP, {"op": "select", "bot": "bot-a"}, arrive("bot-a"), {**REFRESH, "label": "quiet"}],
            {"bot-a": talk("bot")},
            storage={"qd-chat-sound": "off"},
        )
        self.assertEqual(snapshots[0]["soundText"], "Sound off")
        self.assertEqual(snapshots[0]["soundPressed"], "false")
        self.assertEqual(snapshots[-1]["tones"], 0)

    def test_a_device_without_storage_or_audio_still_loads_and_shows_the_line(self):
        snapshots = run(
            [{"op": "select", "bot": "bot-a"}, arrive("bot-b"), {**REFRESH, "label": "arrived"}, {"op": "click", "id": "sound"}],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
            noStorage=True,
            audio=False,
        )
        self.assertEqual(snapshots[0]["soundText"], "Sound on")
        self.assertEqual(snapshots[3]["alertText"], "New message from bot-b")
        self.assertEqual(snapshots[3]["tones"], 0)
        self.assertEqual(snapshots[-1]["soundText"], "Sound off")

    def test_a_hidden_page_keeps_a_dot_for_the_open_chat_until_it_is_shown_again(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                {"op": "hidden", "value": True},
                arrive("bot-a"),
                {**REFRESH, "label": "while-hidden"},
                {"op": "hidden", "value": False, "label": "shown-again"},
            ],
            {"bot-a": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["while-hidden"]["tones"], 1)
        self.assertTrue(by_label["while-hidden"]["title"].startswith("\u25cf "))
        self.assertEqual(by_label["shown-again"]["title"], "Quarterdeck chat")
        self.assertTrue(by_label["shown-again"]["alertHidden"])

    def test_the_open_chat_gets_a_chime_but_no_dot_while_it_is_on_screen(self):
        snapshots = run(
            [TAP, {"op": "select", "bot": "bot-a"}, arrive("bot-a"), {**REFRESH, "label": "arrived"}],
            {"bot-a": talk("bot")},
        )
        arrived = snapshots[-1]
        self.assertEqual(arrived["tones"], 1)
        self.assertEqual(arrived["title"], "Quarterdeck chat")
        self.assertTrue(arrived["alertHidden"])

    def test_the_line_names_the_newest_bot_and_tapping_it_opens_that_chat(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                {**REFRESH, "label": "b"},
                {"op": "advance", "ms": 6000},
                arrive("bot-c"),
                {**REFRESH, "label": "c"},
                {"op": "click", "id": "alert", "label": "tapped"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot"), "bot-c": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["b"]["alertText"], "New message from bot-b")
        self.assertEqual(by_label["c"]["alertText"], "New message from bot-c")
        self.assertEqual(by_label["tapped"]["alertText"], "New message from bot-b")
        self.assertEqual(by_label["tapped"]["gets"]["bot-c"], 2)

    def test_a_failed_look_at_another_chat_is_tried_again_on_the_next_refresh(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                {**REFRESH, "label": "failed"},
                {**REFRESH, "label": "retried"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
            failPeekFor={"bot": "bot-b", "times": 1},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["failed"]["tones"], 0)
        self.assertEqual(by_label["retried"]["tones"], 1)

    def test_a_bot_message_then_his_own_before_the_refresh_still_chimes_for_an_unopened_chat(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                arrive("bot-b", "account"),
                {**REFRESH, "label": "arrived"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        arrived = snapshots[-1]
        self.assertEqual(arrived["tones"], 1)
        self.assertEqual(arrived["alertText"], "New message from bot-b")
        self.assertFalse(arrived["alertHidden"])
        self.assertTrue(arrived["title"].startswith("\u25cf "))
        self.assertEqual(arrived["gets"]["bot-b"], 1)

    def test_two_bot_messages_then_his_own_in_an_unopened_chat_give_one_tone(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                arrive("bot-b"),
                arrive("bot-b", "account"),
                {**REFRESH, "label": "arrived"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        self.assertEqual(snapshots[-1]["tones"], 1)
        self.assertEqual(snapshots[-1]["alertText"], "New message from bot-b")

    def test_only_his_own_messages_in_an_unopened_chat_give_no_tone_and_no_line(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", "account"),
                arrive("bot-b", "account"),
                {**REFRESH, "label": "arrived"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        arrived = snapshots[-1]
        self.assertEqual(arrived["tones"], 0)
        self.assertTrue(arrived["alertHidden"])
        self.assertEqual(arrived["title"], "Quarterdeck chat")
        self.assertEqual(arrived["gets"]["bot-b"], 1)

    def test_a_failed_read_gives_nothing_and_keeps_the_bot_message_for_the_next_read(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                arrive("bot-b", "account"),
                {**REFRESH, "label": "failed"},
                {**REFRESH, "label": "retried"},
                {**REFRESH, "label": "again"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
            failPeekFor={"bot": "bot-b", "times": 1},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["failed"]["tones"], 0)
        self.assertTrue(by_label["failed"]["alertHidden"])
        self.assertEqual(by_label["retried"]["tones"], 1)
        self.assertEqual(by_label["retried"]["alertText"], "New message from bot-b")
        self.assertEqual(by_label["again"]["tones"], 1)
        self.assertEqual(by_label["again"]["gets"]["bot-b"], by_label["retried"]["gets"]["bot-b"])

    def test_a_chat_opened_earlier_also_finds_a_bot_message_before_his_own(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-b"},
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                arrive("bot-b", "account"),
                {**REFRESH, "label": "arrived"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        self.assertEqual(snapshots[-1]["tones"], 1)
        self.assertEqual(snapshots[-1]["alertText"], "New message from bot-b")

    def test_a_chat_with_nothing_new_after_a_read_stays_quiet_and_is_not_read_again(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                arrive("bot-b", "account"),
                {**REFRESH, "label": "first"},
                {**REFRESH, "label": "second"},
                {"op": "advance", "ms": 6000},
                arrive("bot-b", "account"),
                {**REFRESH, "label": "his-own-later"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["first"]["tones"], 1)
        self.assertEqual(by_label["second"]["tones"], 1)
        self.assertEqual(by_label["second"]["gets"]["bot-b"], 1)
        self.assertEqual(by_label["his-own-later"]["tones"], 1)

    def test_a_bot_message_with_the_same_time_as_the_last_one_seen_chimes_once(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", at="t1"),
                {**REFRESH, "label": "same-time"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        arrived = snapshots[-1]
        self.assertEqual(arrived["tones"], 1)
        self.assertEqual(arrived["alertText"], "New message from bot-b")
        self.assertFalse(arrived["alertHidden"])
        self.assertTrue(arrived["title"].startswith("\u25cf "))
        self.assertEqual(arrived["gets"].get("bot-b", 0), 1)

    def test_his_own_message_then_a_bot_message_in_the_same_second_still_chimes(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", "account", at="t7"),
                {**REFRESH, "label": "his-own"},
                arrive("bot-b", at="t7"),
                {**REFRESH, "label": "same-second"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["his-own"]["tones"], 0)
        self.assertTrue(by_label["his-own"]["alertHidden"])
        self.assertEqual(by_label["his-own"]["gets"]["bot-b"], 1)
        self.assertEqual(by_label["same-second"]["tones"], 1)
        self.assertEqual(by_label["same-second"]["alertText"], "New message from bot-b")
        self.assertEqual(by_label["same-second"]["gets"]["bot-b"], 2)

    def test_his_own_message_with_the_same_time_never_chimes(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", "account", at="t1"),
                {**REFRESH, "label": "his-own"},
                arrive("bot-b", "account", at="t1"),
                {**REFRESH, "label": "his-own-again"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        for label in ("his-own", "his-own-again"):
            self.assertEqual(by_label[label]["tones"], 0, label)
            self.assertTrue(by_label[label]["alertHidden"], label)
            self.assertEqual(by_label[label]["title"], "Quarterdeck chat", label)
        self.assertEqual(by_label["his-own-again"]["gets"]["bot-b"], 2)

    def test_same_time_bot_messages_keep_the_five_second_limit(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", at="t5"),
                {**REFRESH, "label": "first"},
                arrive("bot-b", at="t5"),
                {**REFRESH, "label": "second"},
                {"op": "advance", "ms": 4999},
                arrive("bot-b", at="t5"),
                {**REFRESH, "label": "just-under-five"},
                {"op": "advance", "ms": 1},
                arrive("bot-b", at="t5"),
                {**REFRESH, "label": "five-seconds"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual([by_label[label]["tones"] for label in ("first", "second", "just-under-five", "five-seconds")], [1, 1, 1, 2])
        self.assertEqual([by_label[label]["gets"]["bot-b"] for label in ("first", "second", "just-under-five", "five-seconds")], [1, 2, 3, 4])

    def test_an_unchanged_row_is_not_read_again_after_a_same_time_message(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", at="t1"),
                {**REFRESH, "label": "first"},
                {**REFRESH, "label": "second"},
                {**REFRESH, "label": "third"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        for label in ("first", "second", "third"):
            self.assertEqual(by_label[label]["gets"]["bot-b"], 1, label)
            self.assertEqual(by_label[label]["tones"], 1, label)

    def test_the_first_list_reads_no_chat_and_plays_nothing(self):
        snapshots = run(
            [TAP, {**REFRESH, "label": "unchanged"}],
            {"bot-a": talk("bot"), "bot-b": talk("account", "bot"), "bot-c": []},
        )
        for item in snapshots:
            self.assertEqual(item["tones"], 0)
            self.assertEqual(item["gets"], {})
            self.assertTrue(item["alertHidden"])
            self.assertEqual(item["title"], "Quarterdeck chat")

    def test_a_failed_read_of_a_same_time_message_is_tried_again_on_the_next_refresh(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b", at="t1"),
                {**REFRESH, "label": "failed"},
                {**REFRESH, "label": "retried"},
                {**REFRESH, "label": "again"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
            failPeekFor={"bot": "bot-b", "times": 1},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["failed"]["tones"], 0)
        self.assertTrue(by_label["failed"]["alertHidden"])
        self.assertEqual(by_label["retried"]["tones"], 1)
        self.assertEqual(by_label["again"]["tones"], 1)
        self.assertEqual(by_label["again"]["gets"]["bot-b"], by_label["retried"]["gets"]["bot-b"])

    def test_a_same_time_bot_message_in_the_open_chat_still_chimes_once(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-a", at="t1"),
                {**REFRESH, "label": "arrived"},
                {**REFRESH, "label": "unchanged"},
            ],
            {"bot-a": talk("bot")},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["arrived"]["tones"], 1)
        self.assertTrue(by_label["arrived"]["alertHidden"])
        self.assertEqual(by_label["unchanged"]["tones"], 1)

    def test_an_empty_chat_gets_no_peek_until_its_first_message(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                {**REFRESH, "label": "empty"},
                arrive("bot-c"),
                {**REFRESH, "label": "first-message"},
            ],
            {"bot-a": talk("bot"), "bot-c": []},
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["empty"]["gets"].get("bot-c", 0), 0)
        self.assertEqual(by_label["first-message"]["tones"], 1)
        self.assertEqual(by_label["first-message"]["gets"]["bot-c"], 1)

    def test_rows_without_last_still_trigger_a_read_on_a_changed_time(self):
        snapshots = run(
            [
                TAP,
                {"op": "select", "bot": "bot-a"},
                arrive("bot-b"),
                {**REFRESH, "label": "arrived"},
                {**REFRESH, "label": "unchanged"},
            ],
            {"bot-a": talk("bot"), "bot-b": talk("bot")},
            noLast=True,
        )
        by_label = {item["label"]: item for item in snapshots}
        self.assertEqual(by_label["arrived"]["tones"], 1)
        self.assertEqual(by_label["arrived"]["gets"]["bot-b"], 1)
        self.assertEqual(by_label["unchanged"]["gets"]["bot-b"], 1)

    def test_the_chime_is_made_in_the_page_with_no_file_and_no_outside_code(self):
        source = (ROOT / "chat.js").read_text(encoding="utf-8")
        self.assertNotRegex(source, r"new Audio\(|\.mp3|\.wav|\.ogg|https?://|import\s|importScripts|<audio")
        self.assertIn("createOscillator", source)
        page = (ROOT / "chat.html").read_text(encoding="utf-8")
        self.assertNotRegex(page, r"<audio|<source|<style|style=|\son[a-z]+=")
        self.assertEqual(re.findall(r"<script[^>]*>", page), ['<script src="/captain/assets/chat.js" defer>'])


if __name__ == "__main__":
    unittest.main(verbosity=2)
