import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { readJson, writeJson, removeJson } = await loadTs("src/platform/storage.ts");

function withStorage(value, run) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (value === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else delete globalThis.localStorage;
  }
}

const memory = (initial = {}) => {
  const held = { ...initial };
  return { held, getItem: (key) => held[key] ?? null, setItem: (key, text) => void (held[key] = String(text)), removeItem: (key) => void (held[key] = undefined) };
};

test("a value written under a key is read back as the same value", () => {
  const store = memory();
  withStorage(store, () => {
    writeJson("qd.k", { appearance: "dark", n: [1, 2] });
    assert.deepEqual(readJson("qd.k"), { appearance: "dark", n: [1, 2] });
  });
  assert.equal(store.held["qd.k"], '{"appearance":"dark","n":[1,2]}');
});

test("a key nobody wrote reads as null", () => {
  withStorage(memory(), () => assert.equal(readJson("qd.missing"), null));
});

test("text that is not JSON reads as null and does not throw", () => {
  withStorage(memory({ "qd.k": "{not json" }), () => assert.equal(readJson("qd.k"), null));
});

test("storage that throws on a read reads as null", () => {
  const store = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
  withStorage(store, () => assert.equal(readJson("qd.k"), null));
});

test("storage that throws on a write does not throw", () => {
  const store = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  withStorage(store, () => assert.doesNotThrow(() => writeJson("qd.k", { a: 1 })));
});

test("with no storage at all a read is null and a write does not throw", () => {
  withStorage(undefined, () => {
    assert.equal(readJson("qd.k"), null);
    assert.doesNotThrow(() => writeJson("qd.k", 1));
  });
});

test("a removed key reads as null afterwards and other keys stay", () => {
  const store = memory({ "qd.k": "1", "qd.other": "2" });
  withStorage(store, () => {
    removeJson("qd.k");
    assert.equal(readJson("qd.k"), null);
    assert.equal(readJson("qd.other"), 2);
  });
});

test("removing a key nobody wrote does nothing", () => {
  withStorage(memory(), () => assert.doesNotThrow(() => removeJson("qd.missing")));
});

test("storage that throws on a remove does not throw", () => {
  const store = { getItem: () => null, setItem: () => undefined, removeItem: () => { throw new Error("blocked"); } };
  withStorage(store, () => assert.doesNotThrow(() => removeJson("qd.k")));
});

test("with no storage at all a remove does not throw", () => {
  withStorage(undefined, () => assert.doesNotThrow(() => removeJson("qd.k")));
});
