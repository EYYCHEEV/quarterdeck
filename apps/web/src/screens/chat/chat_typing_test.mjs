import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as engines from "playwright";
import { chromeLaunchOptions } from "../../../tools/browser.mjs";
import { startAppServer } from "../../../tools/app-server.mjs";

const ENGINE = process.env.QD_ENGINE ?? "chromium";
const EXPECT = process.env.QD_EXPECT ?? "";
const ROWS = Boolean(process.env.QD_ROWS);
const PROBE = fileURLToPath(new URL("./typing_probe.js", import.meta.url));
const WEBKIT_VIEWPORT_LINE = 'Viewport argument key "interactive-widget" not recognized and ignored.';
const only = process.argv.slice(2);
const failed = [];
let passed = 0;

if (EXPECT !== "" && EXPECT !== "shrink") {
  console.log("QD_EXPECT is either unset or shrink, not " + JSON.stringify(EXPECT));
  process.exit(1);
}

const build = spawnSync(process.execPath, ["tools/build-app.mjs", "--fixtures"], { stdio: "inherit" });
if (build.status) process.exit(build.status ?? 1);
const { server, origin } = await startAppServer();

const T = (p, id) => p.locator(`[data-testid="${id}"]`);
const frames = (p) => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const settled = (p) => p.evaluate(() => window.qdProbe.settled());
const phone = (width, height) => ({ viewport: { width, height }, hasTouch: true, isMobile: true });

const counting = () => {
  window.qdScrolls = 0;
  for (const [owner, name] of [[Element.prototype, "scrollIntoView"], [window, "scrollTo"], [window, "scrollBy"]]) {
    const real = owner[name];
    owner[name] = function (...args) {
      window.qdScrolls += 1;
      return real.apply(this, args);
    };
  }
  const height = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight").get;
  window.qdLow = Infinity;
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get() {
      const value = height.call(this);
      if (this instanceof HTMLTextAreaElement) window.qdLow = Math.min(window.qdLow, height.call(document.documentElement));
      return value;
    },
  });
  window.qdNow = () => {
    const newest = [...document.querySelectorAll('[data-testid="chat-thread"] > li')].at(-1).getBoundingClientRect();
    const dock = document.querySelector(".chat-composer-dock").getBoundingClientRect();
    const view = window.visualViewport;
    return {
      key: window.qdKey ?? "",
      y: Math.round(window.scrollY),
      newest: Math.round(newest.top),
      gap: Math.round(dock.top - newest.bottom),
      dock: Math.round(dock.height),
      vh: Math.round(view.height),
      vtop: Math.round(view.offsetTop),
      ih: window.innerHeight,
      sh: document.documentElement.scrollHeight,
      ours: window.qdScrolls,
    };
  };
  window.qdTake = () => {
    const now = { ...window.qdNow(), low: window.qdLow === Infinity ? null : window.qdLow };
    window.qdLow = Infinity;
    return now;
  };
};

const row = (s) => [JSON.stringify(s.key), "y " + s.y, "newest " + s.newest, "gap " + s.gap, "dock " + s.dock, "vv " + s.vh + "@" + s.vtop, "inner " + s.ih, "page " + s.sh, ...(s.low === undefined ? [] : ["page while measured " + s.low]), "ours " + s.ours].join("  ");

const TYPED = "First line\nSecond line\nand the third";

const press = async (p, key, label = key) => {
  await p.evaluate((name) => (window.qdKey = name), label);
  await p.keyboard.press(key);
  await frames(p);
  return p.evaluate(() => window.qdTake());
};

const typeText = async (p, text, newline) => {
  const keys = [];
  for (const ch of text) {
    if (ch === "\n") {
      keys.push(await press(p, newline, ch));
      continue;
    }
    await p.evaluate((name) => (window.qdKey = name), ch);
    await p.keyboard.type(ch);
    await frames(p);
    keys.push(await p.evaluate(() => window.qdTake()));
  }
  return keys;
};

const dips = (keys) => keys.slice(1).filter((s, at) => s.low !== null && s.low < Math.min(s.sh, keys[at].sh)).map(row);

const ready = async (p, mode, tapFirst) => {
  await p.addInitScript({ path: PROBE });
  await p.goto(origin + "/chat/iris");
  await T(p, "chat-bot-message").first().waitFor();
  assert.equal(await p.evaluate(() => window.qdProbe.draft()), true, "the two-line draft is in the box");
  if (tapFirst) await T(p, "chat-input").tap();
  await p.evaluate(() => window.qdProbe.toEnd());
  await settled(p);
  if (mode === "reading") {
    const place = await p.evaluate(() => window.qdProbe.upBy(400));
    assert.ok(place.top > 0 && place.top < place.max - 100, `scrolled up into older messages (${place.top} of ${place.max})`);
    await settled(p);
  }
  if (!tapFirst) await T(p, "chat-input").tap();
  await settled(p);
  return p.evaluate((next) => window.qdProbe.start(next), mode);
};

const typeKeys = async (p, keys) => {
  for (const key of keys) {
    if (key === "\n") await p.keyboard.press("Enter");
    else await p.keyboard.type(key);
    await settled(p);
    await p.evaluate((name) => window.qdProbe.take(name), key);
  }
};

const verdict = async (p) => {
  await typeKeys(p, await p.evaluate(() => window.qdProbe.KEYS));
  const result = await p.evaluate(() => window.qdProbe.verdict());
  console.log("     " + JSON.stringify(result.env));
  if (ROWS) console.log(result.rows.map((line) => "       " + line).join("\n"));
  return result;
};

const judge = ({ fails }) => {
  const lines = fails.map((f) => f.line);
  if (EXPECT === "shrink") {
    assert.ok(
      fails.some((f) => f.rule === "shrink"),
      "the planted shrink was not seen: " + (lines.join("; ") || "no fail at all"),
    );
    console.log("     red on the shrink rule, as planted: " + fails.find((f) => f.rule === "shrink").line);
    return;
  }
  assert.deepEqual(lines.slice(0, 20), [], `the shared probe's jumps (${lines.length})`);
};

const hold = async (p, message) => {
  await message.evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
  });
  const sheet = p.locator('[data-pop="message-actions"]');
  await sheet.waitFor();
  return sheet;
};

const cases = [];
const it = (name, size, run, probe = false) => cases.push({ name: "[" + ENGINE + "] " + name, size, run, probe });

for (const [label, width, height] of [
  ["390 x 500, the keyboard's height taken off", 390, 500],
  ["440 x 600, the keyboard's height taken off", 440, 600],
  ["390 x 844", 390, 844],
]) {
  it(
    `Chat on a phone (${label}), at the end of the chat: typing 40 keys and a Return after a two-line draft keeps the newest message just above the composer and the composer's bottom still in every painted frame, and nothing gets shorter while the box measures`,
    phone(width, height),
    async (p) => {
      await ready(p, "end", true);
      judge(await verdict(p));
    },
    true,
  );
  for (const [order, tapFirst] of [
    ["the box tapped, then scrolled up", true],
    ["scrolled up, then the box tapped", false],
  ])
    it(
      `Chat on a phone (${label}), ${order} to read older messages: typing 40 keys and a Return after a two-line draft never moves the message being read in any painted frame, and nothing gets shorter while the box measures`,
      phone(width, height),
      async (p) => {
        await ready(p, "reading", tapFirst);
        judge(await verdict(p));
      },
      true,
    );
}

it("Chat on a phone (390 x 500): with a chat open the window never scrolls; letters, a Return, a quote in the composer and Send all leave it still, and the sent message ends just above the composer", phone(390, 500), async (p) => {
  await ready(p, "end", true);
  for (const key of [..."Hello", "\n", ..."there"]) {
    if (key === "\n") await p.keyboard.press("Enter");
    else await p.keyboard.type(key);
    await settled(p);
    await p.evaluate((name) => window.qdProbe.take(name), key);
  }
  const sheet = await hold(p, T(p, "chat-bot-message").last());
  await sheet.getByRole("button", { name: "Reply" }).tap();
  await T(p, "chat-quote").waitFor();
  await settled(p);
  await p.evaluate(() => window.qdProbe.take("a quote in the composer"));
  await T(p, "chat-send").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="chat-input"]').value === "");
  await settled(p);
  const sent = await p.evaluate(() => window.qdProbe.take("Send"));
  const seen = (await p.evaluate(() => window.qdProbe.records())).flatMap((record) => [...record.frames, record]);
  assert.deepEqual([...new Set(seen.map((s) => s.y))], [0], "the window's scroll, in every painted frame and after every step");
  assert.ok(sent.newest <= sent.top + 1, `the sent message ends above the composer (message bottom ${sent.newest}, composer top ${sent.top})`);
});

it("Chat on a phone (390 x 500), at the end of the chat: the thread list is what scrolls, and it keeps its end in view after every one of 40 keys and a Return after a two-line draft", phone(390, 500), async (p) => {
  const start = await ready(p, "end", true);
  assert.equal(start.scroller, "list", "the part that scrolls in a chat (the thread list, not the window)");
  const result = await verdict(p);
  const records = await p.evaluate(() => window.qdProbe.records());
  assert.deepEqual(
    records.filter((record) => record.end > 1).map((record) => JSON.stringify(record.key) + " " + record.end),
    [],
    "the thread list's distance from its end after each key",
  );
  judge(result);
});

for (const [label, size, newline, hit] of [
  ["a phone (390 x 844)", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, "Enter", "tap"],
  ["the Mac (1512 x 982)", { viewport: { width: 1512, height: 982 } }, "Shift+Enter", "click"],
]) {
  it(`Chat on ${label}: after three lines, deleting back to one line and sending each bring the message box back to its one-line height, and the page never dips while it measures`, size, async (p) => {
    await p.addInitScript(counting);
    await p.goto(origin + "/chat/iris");
    await T(p, "chat-bot-message").first().waitFor();
    const box = T(p, "chat-input");
    await box[hit]();
    await frames(p);
    const tall = () => box.evaluate((el) => el.getBoundingClientRect().height);
    const empty = await tall();
    const keys = [await p.evaluate(() => window.qdTake())];
    keys.push(...(await typeText(p, TYPED, newline)));
    const three = await tall();
    for (let left = TYPED.length - "First line".length; left > 0; left--) keys.push(await press(p, "Backspace"));
    assert.equal(await box.inputValue(), "First line");
    const deleted = await tall();
    keys.push(...(await typeText(p, TYPED.slice("First line".length), newline)));
    const again = await tall();
    await p.evaluate(() => (window.qdKey = "Send"));
    if (ENGINE === "webkit" && hit === "tap") console.log("     Send pressed by click: Playwright's WebKit gives no click for a tap on a button that cancels pointerdown");
    await T(p, "chat-send")[ENGINE === "webkit" ? "click" : hit]();
    await p.waitForFunction(() => document.querySelector('[data-testid="chat-input"]').value === "");
    await frames(p);
    keys.push(await p.evaluate(() => window.qdTake()));
    const sent = await tall();
    const shape = await box.evaluate((el) => [getComputedStyle(el.parentElement).display, getComputedStyle(el.closest("form")).display].join(" in "));
    console.log(`     box height: empty ${empty}, three lines ${three}, back to one line ${deleted}, three lines again ${again}, after Send ${sent}; row ${shape}`);
    console.log("     per key:\n" + keys.map((s) => "       " + row(s)).join("\n"));
    assert.deepEqual([three > empty + 20, again > empty + 20], [true, true], "three lines make the box taller");
    assert.deepEqual([Math.abs(deleted - empty) <= 1, Math.abs(sent - empty) <= 1], [true, true], `the box back at its empty height (${empty}) after deleting to one line (${deleted}) and after Send (${sent})`);
    assert.deepEqual(dips(keys), [], "the page's height while the composer measures each key");
  });
}

const browser = await engines[ENGINE].launch(ENGINE === "chromium" ? chromeLaunchOptions({ args: ["--no-sandbox"] }) : {});
try {
  for (const item of cases) {
    if (only.length && !only.some((part) => item.name.includes(part))) continue;
    if (EXPECT && !item.probe) continue;
    const context = await browser.newContext({ ...item.size, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && !(ENGINE === "webkit" && message.text() === WEBKIT_VIEWPORT_LINE) && errors.push(message.text()));
    try {
      await item.run(page);
      assert.deepEqual(errors, [], "console errors");
      passed += 1;
      console.log("ok   " + item.name);
    } catch (error) {
      failed.push(item.name);
      console.log("FAIL " + item.name + "\n     " + String(error?.message ?? error).split("\n").slice(0, 40).join("\n     "));
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(`chat typing (${ENGINE}${EXPECT ? ", the planted shrink expected" : ""}): ${passed} of ${passed + failed.length} pass`);
process.exit(failed.length ? 1 : 0);
