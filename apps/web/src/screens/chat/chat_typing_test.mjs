import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as engines from "playwright";
import { chromeLaunchOptions } from "../../../tools/browser.mjs";
import { startAppServer } from "../../../tools/app-server.mjs";

const ENGINE = process.env.QD_ENGINE ?? "chromium";
const only = process.argv.slice(2);
const failed = [];
let passed = 0;

const build = spawnSync(process.execPath, ["tools/build-app.mjs", "--fixtures"], { stdio: "inherit" });
if (build.status) process.exit(build.status ?? 1);
const { server, origin } = await startAppServer();

const T = (p, id) => p.locator(`[data-testid="${id}"]`);
const frames = (p) => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

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

const cases = [];
const it = (name, size, run) => cases.push({ name: "[" + ENGINE + "] " + name, size, run });

for (const [label, width, height] of [["390 x 500", 390, 500], ["440 x 600", 440, 600]]) {
  it(`Chat on a phone with the keyboard up (${label}): typing letter by letter and new lines never shortens the page mid-key and keeps the newest message just above the composer in every frame`, { viewport: { width, height }, hasTouch: true, isMobile: true }, async (p) => {
    await p.addInitScript(counting);
    await p.goto(origin + "/chat/iris");
    await T(p, "chat-bot-message").first().waitFor();
    await T(p, "chat-input").tap();
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await frames(p);
    const [bottom, scrolled] = await p.evaluate(() => [Math.round(document.documentElement.scrollHeight - window.innerHeight - window.scrollY), Math.round(window.scrollY)]);
    assert.deepEqual([bottom, scrolled > 0], [0, true], "the chat can scroll, and starts at its bottom");
    const start = await p.evaluate(() => window.qdTake());
    await p.evaluate(() => {
      window.qdFrames = [];
      const step = () => {
        window.qdFrames.push(window.qdNow());
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const keys = [start];
    keys.push(...(await typeText(p, TYPED, "Enter")));
    const recorded = await p.evaluate(() => window.qdFrames.splice(0));
    console.log("     per key:\n" + keys.map((s) => "       " + row(s)).join("\n"));
    const moved = recorded.filter((s) => s.gap !== start.gap).map(row).filter((line, at, all) => line !== all[at - 1]);
    if (moved.length) console.log("     frames off the bottom:\n" + moved.map((line) => "       " + line).join("\n"));
    assert.equal(await T(p, "chat-input").inputValue(), TYPED);
    const letters = keys.slice(1).filter((s, at) => s.key !== "\n" && s.dock === keys[at].dock && s.y !== keys[at].y);
    assert.deepEqual(letters.map(row), [], "the page's scroll after each letter that adds no line");
    assert.deepEqual([...new Set(keys.map((s) => s.gap))], [start.gap], "the gap from the newest message to the composer after each key");
    assert.deepEqual([...new Set(recorded.map((s) => s.gap))], [start.gap], "the gap from the newest message to the composer in every frame");
    assert.deepEqual(dips(keys), [], "the page's height while the composer measures each key");
  });
}

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
    await T(p, "chat-send")[hit]();
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
    const context = await browser.newContext({ ...item.size, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
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

console.log(`chat typing (${ENGINE}): ${passed} of ${passed + failed.length} pass`);
process.exit(failed.length ? 1 : 0);
