import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as engines from "playwright";
import { chromeLaunchOptions } from "../../../tools/browser.mjs";
import { startAppServer } from "../../../tools/app-server.mjs";

const ENGINE = process.env.QD_ENGINE ?? "chromium";
const ENGINE_NOTICE = ENGINE === "webkit" ? 'Viewport argument key "interactive-widget" not recognized and ignored.' : null;
const only = process.argv.slice(2);
const failed = [];
let passed = 0;

const build = spawnSync(process.execPath, ["tools/build-app.mjs", "--fixtures"], { stdio: "inherit" });
if (build.status) process.exit(build.status ?? 1);
const { server, origin } = await startAppServer();

const T = (p, id) => p.locator(`[data-testid="${id}"]`);
const namesOf = (keys) => keys.evaluateAll((list) => list.map((el) => el.getAttribute("aria-label") ?? el.textContent.replace(/\s+/g, " ").trim()));
const frames = (p) => p.clock.runFor(50);
const sheetOf = (p) => p.locator('[data-pop="message-actions"]');
const barOf = (p) => T(p, "select-bar");
const PART = "Everything passed";

const TOUCH = [
  ["a phone (390 x 844)", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ["an iPad upright (744 x 1133)", { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }],
  ["an iPad sideways (1133 x 744)", { viewport: { width: 1133, height: 744 }, hasTouch: true, isMobile: true }],
];
const MAC = { viewport: { width: 1512, height: 982 } };

const recordCopies = () => {
  window.qdCopied = [];
  const writeText = async (text) => {
    window.qdCopied.push(text);
  };
  if (navigator.clipboard) Object.defineProperty(navigator.clipboard, "writeText", { value: writeText, configurable: true });
  else Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
};

const openIris = async (p, route = "/chat/iris") => {
  await p.addInitScript(recordCopies);
  await p.clock.install();
  await p.goto(origin + route);
  await T(p, "chat-bot-message").first().locator("[data-message-text]").waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  return { first: T(p, "chat-bot-message").first(), last: T(p, "chat-bot-message").last() };
};

const pressOn = (message) =>
  message.evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
  });

const hold = async (p, message) => {
  await pressOn(message);
  await p.clock.runFor(600);
};

const startSelect = async (p, message) => {
  await hold(p, message);
  const sheet = sheetOf(p);
  await sheet.waitFor();
  await sheet.getByRole("button", { name: "Select", exact: true }).tap();
  await sheet.waitFor({ state: "detached" });
  await frames(p);
};

const selectPart = async (message, phrase) => {
  let timer;
  const late = new Promise((done) => {
    timer = setTimeout(() => done("no selectionchange within 5 s"), 5000);
  });
  const seen = message
    .locator("[data-message-text]")
    .evaluate((root, text) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const changed = new Promise((done) => document.addEventListener("selectionchange", () => done(getSelection().toString() === text), { once: true }));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return changed;
      }
      return false;
    }, phrase)
    .catch((error) => String(error?.message ?? error));
  const result = await Promise.race([seen, late]);
  clearTimeout(timer);
  return result;
};

const stateOf = async (p, message, other) =>
  p.evaluate(
    ([row, next]) => {
      const flat = (text) => text.replace(/\s+/g, " ").trim();
      const style = (node) => {
        const computed = getComputedStyle(node);
        return computed.userSelect || computed.webkitUserSelect;
      };
      const text = row.querySelector("[data-message-text]");
      const selection = getSelection();
      const inside = !selection.isCollapsed && text.contains(selection.anchorNode) && text.contains(selection.focusNode);
      return {
        whole: inside && flat(selection.toString()) === flat(text.innerText),
        focused: document.activeElement === row,
        selectable: style(text) === "text",
        otherSelectable: style(next.querySelector("[data-message-text]")) === "text",
        thread: style(document.querySelector('[data-testid="chat-thread"]')),
        callout: CSS.supports("-webkit-touch-callout", "none") ? getComputedStyle(row).webkitTouchCallout : "not in this engine",
      };
    },
    [await message.elementHandle(), await other.elementHandle()],
  );

const selectedText = (p) => p.evaluate(() => getSelection().toString());

const ended = async (p, message, other, how) => {
  await barOf(p).waitFor({ state: "detached" });
  const now = await stateOf(p, message, other);
  assert.deepEqual([now.whole, now.selectable, now.otherSelectable, now.thread], [false, false, false, "none"], how + ": the selection, that message's text selectable, the next one's, and the thread's user-select");
  if (now.callout !== "not in this engine") assert.equal(now.callout, "none", how + ": that message's callout");
};

const cases = [];
const it = (name, size, run) => cases.push({ name: "[" + ENGINE + "] " + name, size, run });

for (const [label, size] of TOUCH) {
  it(`Chat on ${label}: a hold opens Reply, Copy and Select; Select selects that message's whole text with focus on it, only that message becomes selectable, and a bar above the box offers Reply, Copy and Done`, size, async (p) => {
    const { first, last } = await openIris(p);
    await hold(p, first);
    const sheet = sheetOf(p);
    await sheet.waitFor();
    assert.deepEqual(await namesOf(sheet.getByRole("button")), ["Done", "Reply", "Copy", "Select"], "the menu's buttons in order");
    const row = await sheet.getByRole("button", { name: "Select", exact: true }).evaluate((el) => [el.querySelector("svg") !== null, el.getBoundingClientRect().height >= 48]);
    assert.deepEqual(row, [true, true], "Select has an icon and is at least 48 px tall");
    await sheet.getByRole("button", { name: "Select", exact: true }).tap();
    await sheet.waitFor({ state: "detached" });
    await frames(p);
    const now = await stateOf(p, first, last);
    assert.deepEqual([now.whole, now.focused], [true, true], "the whole text selected and the focus on that message, together after the menu is gone");
    assert.deepEqual([now.selectable, now.otherSelectable, now.thread], [true, false, "none"], "that message's text selectable, the next one's not, and the thread's user-select");
    if (now.callout !== "not in this engine") assert.equal(now.callout, "default", "that message's callout while selecting");
    const bar = barOf(p);
    await bar.waitFor();
    assert.deepEqual([await bar.getAttribute("role"), await bar.getAttribute("aria-label")], ["toolbar", "Selected text"], "the bar's role and name");
    assert.deepEqual(await namesOf(bar.getByRole("button")), ["Reply", "Copy", "Done"], "the bar's buttons in order");
    assert.deepEqual(await bar.getByRole("button").evaluateAll((list) => list.map((el) => el.getBoundingClientRect().height >= 44)), [true, true, true], "each bar button at least 44 px tall");
    assert.equal(await bar.evaluate((el) => el.closest(".chat-composer-dock") !== null), true, "the bar sits in the dock above the box");
  });

  it(`Chat on ${label}: when the message box had focus before the hold, Select still leaves the whole text selected and the focus on that message`, size, async (p) => {
    const { first, last } = await openIris(p);
    await T(p, "chat-input").tap();
    assert.equal(await T(p, "chat-input").evaluate((el) => el === document.activeElement), true, "the box has focus first");
    await startSelect(p, first);
    const now = await stateOf(p, first, last);
    assert.deepEqual([now.whole, now.focused], [true, true], "the whole text selected and the focus on that message, together after the menu is gone");
    await barOf(p).waitFor();
  });

  for (const [how, clear] of [["with the part still selected", false], ["after the selection was cleared before the tap", true]]) {
    it(`Chat on ${label}: Copy in the bar copies only the selected part ${how}, says Copied, then selecting ends`, size, async (p) => {
      const { first, last } = await openIris(p);
      await startSelect(p, first);
      assert.equal(await selectPart(first, PART), true, "the part is in the message");
      await frames(p);
      if (clear) {
        await p.evaluate(() => getSelection().removeAllRanges());
        await frames(p);
        assert.equal(await selectedText(p), "", "nothing selected before the tap");
      }
      await barOf(p).getByRole("button", { name: "Copy", exact: true }).tap();
      await barOf(p).getByRole("button", { name: "Copied", exact: true }).waitFor();
      assert.deepEqual(await p.evaluate(() => window.qdCopied), [PART], "what Copy put on the clipboard");
      await p.clock.runFor(800);
      await ended(p, first, last, "after Copy");
    });

    it(`Chat on ${label}: Reply in the bar quotes only the selected part ${how}, puts the focus in the box, and selecting ends`, size, async (p) => {
      const { first, last } = await openIris(p);
      await startSelect(p, first);
      assert.equal(await selectPart(first, PART), true, "the part is in the message");
      await frames(p);
      if (clear) {
        await p.evaluate(() => getSelection().removeAllRanges());
        await frames(p);
        assert.equal(await selectedText(p), "", "nothing selected before the tap");
      }
      await barOf(p).getByRole("button", { name: "Reply", exact: true }).tap();
      await T(p, "chat-quote").locator('[data-testid="chat-quote-text"]').getByText(PART, { exact: true }).waitFor();
      await frames(p);
      assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "chat-input", "the focus after Reply");
      await ended(p, first, last, "after Reply");
    });
  }

  it(`Chat on ${label}: while selecting, a hold on that message opens no menu and lets the browser's own menu through, and the other messages keep both as before`, size, async (p) => {
    const { first, last } = await openIris(p);
    await startSelect(p, first);
    await hold(p, first);
    assert.equal(await sheetOf(p).count(), 0, "a menu after holding the message being selected");
    const cancelled = (message) =>
      message.evaluate((row) => {
        const box = row.getBoundingClientRect();
        row.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        row.querySelector("[data-message-text]").dispatchEvent(event);
        row.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }));
        return event.defaultPrevented;
      });
    assert.deepEqual([await cancelled(first), await cancelled(last)], [false, true], "the context menu cancelled on the message being selected, and on another message");
    await p.clock.runFor(600);
    assert.equal(await sheetOf(p).count(), 0, "a menu after a touch that lifted early");
    await barOf(p).waitFor();
    const now = await stateOf(p, first, last);
    assert.deepEqual([now.whole, now.selectable], [true, true], "still selecting the whole text");
  });

  it(`Chat on ${label}: selecting ends with Done, a tap on another message, a tap in the message box, or a hold on another message, but not with a scroll and not with Escape; then the message is unselectable again and a hold opens the menu`, size, async (p) => {
    const { first, last } = await openIris(p);
    await startSelect(p, first);
    await p.evaluate(() => window.scrollBy(0, -120));
    await frames(p);
    await barOf(p).waitFor();
    assert.deepEqual((await stateOf(p, first, last)).whole, true, "the whole text still selected after a scroll");
    await p.keyboard.press("Escape");
    await frames(p);
    assert.deepEqual([await barOf(p).count(), (await stateOf(p, first, last)).whole], [1, true], "the bar and the whole text still selected after Escape");
    const enders = [
      ["Done", () => barOf(p).getByRole("button", { name: "Done", exact: true }).tap()],
      ["a tap on another message", () => last.tap({ position: { x: 8, y: 8 } })],
      ["a tap in the message box", () => T(p, "chat-input").tap()],
      [
        "a hold on another message",
        async () => {
          await hold(p, last);
          await sheetOf(p).waitFor();
        },
      ],
    ];
    for (const [at, [how, end]] of enders.entries()) {
      if (at > 0) await startSelect(p, first);
      await barOf(p).waitFor();
      await end();
      await frames(p);
      await ended(p, first, last, how);
    }
    assert.deepEqual(await namesOf(sheetOf(p).getByRole("button")), ["Done", "Reply", "Copy", "Select"], "the other message's menu");
    await sheetOf(p).getByRole("button", { name: "Done", exact: true }).tap();
    await sheetOf(p).waitFor({ state: "detached" });
    await hold(p, first);
    await sheetOf(p).waitFor();
    assert.deepEqual(await namesOf(sheetOf(p).getByRole("button")), ["Done", "Reply", "Copy", "Select"], "the menu after selecting ended");
  });
}

it("Chat on a phone (390 x 844): a new reply from the bot while selecting keeps the selection and the bar", TOUCH[0][1], async (p) => {
  const { first, last } = await openIris(p, "/chat/iris?chatfx=CF-1");
  await startSelect(p, first);
  await p.clock.runFor(730_000);
  await T(p, "chat-bot-message").filter({ hasText: "Picked A on c1." }).waitFor();
  await frames(p);
  await barOf(p).waitFor();
  const now = await stateOf(p, first, last);
  assert.deepEqual([now.whole, now.selectable], [true, true], "the whole text still selected, and still selectable");
});

it("Chat on the Mac (1512 x 982): nothing changes; hover offers Reply and Copy, no Select shows anywhere, a right-click keeps the browser's menu, and a mouse selection still offers Reply", MAC, async (p) => {
  const { first } = await openIris(p);
  await first.hover();
  assert.deepEqual(await namesOf(T(p, "message-actions").getByRole("button")), ["Reply", "Copy"], "hover actions");
  const right = await first.evaluate((row) => {
    row.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 2, bubbles: true }));
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    row.querySelector("[data-message-text]").dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(right, false, "the context menu cancelled after a right-click");
  await p.clock.runFor(600);
  assert.deepEqual([await sheetOf(p).count(), await p.getByRole("button", { name: "Select", exact: true }).count()], [0, 0], "a menu and a Select button after a mouse press");
  assert.equal(await selectPart(first, PART), true, "the part is in the message");
  await T(p, "selection-quote").waitFor();
  assert.equal(await barOf(p).count(), 0, "the touch bar on the Mac");
});

const browser = await engines[ENGINE].launch(ENGINE === "chromium" ? chromeLaunchOptions({ args: ["--no-sandbox"] }) : {});
try {
  for (const item of cases) {
    if (only.length && !only.some((part) => item.name.includes(part))) continue;
    const context = await browser.newContext({ ...item.size, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && message.text() !== ENGINE_NOTICE && errors.push(message.text()));
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

console.log(`chat select (${ENGINE}): ${passed} of ${passed + failed.length} pass`);
process.exit(failed.length ? 1 : 0);
