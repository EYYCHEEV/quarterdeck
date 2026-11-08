import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { copyText } = await loadTs("src/platform/copy.ts");

function setGlobal(name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  };
}

async function inBrowser({ clipboard, execCommand }, run) {
  const log = [];
  class Element {
    focus() {
      log.push("focus " + (this.name ?? "field"));
    }
  }
  const page = new Element();
  page.name = "page";
  const document = {
    activeElement: page,
    body: { appendChild: (field) => log.push("append " + field.value) },
    createElement: () => {
      const field = new Element();
      Object.assign(field, { style: {}, setAttribute: () => undefined, select: () => log.push("select"), setSelectionRange: () => undefined, remove: () => log.push("remove") });
      return field;
    },
  };
  if (execCommand) document.execCommand = (command) => (log.push("exec " + command), execCommand());
  const restore = [
    setGlobal("document", document),
    setGlobal("HTMLElement", Element),
    setGlobal("navigator", clipboard ? { clipboard: { writeText: async (text) => (log.push("clipboard " + text), clipboard()) } } : {}),
  ];
  try {
    return { result: await run(), log };
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

test("the clipboard takes the text and nothing else is touched", async () => {
  const { result, log } = await inBrowser({ clipboard: () => undefined, execCommand: () => true }, () => copyText("ghp_x"));
  assert.equal(result, true);
  assert.deepEqual(log, ["clipboard ghp_x"]);
});

test("when the clipboard refuses, the selection fallback copies and puts focus back", async () => {
  const { result, log } = await inBrowser({ clipboard: () => Promise.reject(new Error("refused")), execCommand: () => true }, () => copyText("hello"));
  assert.equal(result, true);
  assert.deepEqual(log, ["clipboard hello", "append hello", "focus field", "select", "exec copy", "remove", "focus page"]);
});

test("with no clipboard at all the selection fallback copies", async () => {
  const { result, log } = await inBrowser({ execCommand: () => true }, () => copyText("hello"));
  assert.equal(result, true);
  assert.deepEqual(log, ["append hello", "focus field", "select", "exec copy", "remove", "focus page"]);
});

test("when the clipboard refuses and the fallback fails too, the answer is false", async () => {
  const { result } = await inBrowser({ clipboard: () => Promise.reject(new Error("refused")), execCommand: () => false }, () => copyText("hello"));
  assert.equal(result, false);
});

test("with neither a clipboard nor execCommand the answer is false and nothing is added to the page", async () => {
  const { result, log } = await inBrowser({}, () => copyText("hello"));
  assert.equal(result, false);
  assert.deepEqual(log, []);
});

test("empty text is never copied", async () => {
  const { result, log } = await inBrowser({ clipboard: () => undefined, execCommand: () => true }, () => copyText(""));
  assert.equal(result, false);
  assert.deepEqual(log, []);
});
