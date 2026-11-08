import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { enterSends, watchKeyboard } = await loadTs("src/platform/keyboard.ts");

const key = (over = {}) => ({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, keyCode: 13, ...over });

for (const [name, event, keyboardUp, sends] of [
  ["Return sends when no on-screen keyboard is up", key(), false, true],
  ["Return starts a new line while the on-screen keyboard is up", key(), true, false],
  ["Shift+Return starts a new line", key({ shiftKey: true }), false, false],
  ["Option+Return starts a new line, as Shift+Return does", key({ altKey: true }), false, false],
  ["Cmd+Return sends, even with the on-screen keyboard up", key({ metaKey: true }), true, true],
  ["Ctrl+Return sends", key({ ctrlKey: true }), false, true],
  ["an Enter inside an IME composition sends nothing", key({ isComposing: true }), false, false],
  ["the Enter that ends an IME composition (keyCode 229) sends nothing", key({ keyCode: 229 }), false, false],
  ["Cmd+Return that ends an IME composition sends nothing", key({ keyCode: 229, metaKey: true }), false, false],
  ["other keys never send", key({ key: "a", keyCode: 65 }), false, false],
]) {
  test(name, () => assert.equal(enterSends(event, keyboardUp), sends));
}

const BODY = { tagName: "BODY" };
const BOX = { tagName: "TEXTAREA" };

const screen = ({ coarse = true, width = 744, height = 1133, viewport = true } = {}) => {
  const listeners = new Set();
  const visual = { width, height, scale: 1, addEventListener: (_, run) => listeners.add(run), removeEventListener: (_, run) => listeners.delete(run) };
  const win = { innerHeight: height, visualViewport: viewport ? visual : null, matchMedia: () => ({ matches: coarse }), document: { activeElement: BODY } };
  return {
    win,
    listeners,
    focus: () => (win.document.activeElement = BOX),
    blur: () => (win.document.activeElement = BODY),
    resize: (next) => {
      Object.assign(visual, next);
      for (const run of [...listeners]) run();
    },
  };
};

test("a fine pointer (the Mac) never reads the on-screen keyboard as up, even after a 320 px drop", () => {
  const s = screen({ coarse: false });
  const watch = watchKeyboard(s.win);
  s.focus();
  s.resize({ height: 813 });
  assert.equal(watch.up(), false);
});

test("on a touch screen, a 320 px drop at the same width while typing reads up", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  s.focus();
  s.resize({ height: 813 });
  assert.equal(watch.up(), true);
});

test("when the page itself shrinks with the keyboard (resizes-content), a 320 px drop still reads up", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  s.focus();
  s.win.innerHeight = 813;
  s.resize({ height: 813 });
  assert.equal(watch.up(), true);
});

test("typing with no drop (a hardware keyboard) reads down", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  s.focus();
  assert.equal(watch.up(), false);
});

test("a 60 px drop (a hardware keyboard's shortcut bar) reads down", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  s.focus();
  s.resize({ height: 1073 });
  assert.equal(watch.up(), false);
});

test("turned sideways while typing, with no height yet seen at the new width, it reads up (the safe side)", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  s.focus();
  s.resize({ width: 1133, height: 424 });
  assert.equal(watch.up(), true);
});

test("after the box lets go at the new width, the full height counts, and typing again with no drop reads down", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  s.focus();
  s.resize({ width: 1133, height: 424 });
  s.blur();
  s.resize({ height: 744 });
  s.focus();
  assert.equal(watch.up(), false);
});

test("heights seen while typing never count as the full height", () => {
  const s = screen({ width: 1133, height: 744 });
  const watch = watchKeyboard(s.win);
  s.focus();
  s.resize({ width: 744, height: 813 });
  s.resize({ height: 700 });
  assert.equal(watch.up(), true);
});

test("pinch zoom with no keyboard reads down", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  s.focus();
  s.resize({ width: 372, height: 566.5, scale: 2 });
  assert.equal(watch.up(), false);
});

test("a touch screen with no visualViewport reads up (the safe side)", () => {
  const s = screen({ viewport: false });
  assert.equal(watchKeyboard(s.win).up(), true);
});

test("stop takes the resize listener away", () => {
  const s = screen();
  const watch = watchKeyboard(s.win);
  assert.equal(s.listeners.size, 1);
  watch.stop();
  assert.equal(s.listeners.size, 0);
});
