import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { enterSends } = await loadTs("src/platform/keyboard.ts");

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
