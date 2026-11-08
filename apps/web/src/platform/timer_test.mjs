import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { schedule } = await loadTs("src/platform/timer.ts");

test("the platform schedules the callback once at its delay and cancels that exact timer", () => {
  const before = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const calls = [];
  const timer = {};
  const run = () => undefined;
  globalThis.setTimeout = (callback, delay) => { calls.push([callback, delay]); return timer; };
  globalThis.clearTimeout = (held) => calls.push(held);
  try {
    const cancel = schedule(run, 61_000);
    assert.deepEqual(calls, [[run, 61_000]]);
    cancel();
    assert.equal(calls[1], timer);
  } finally {
    Object.assign(globalThis, before);
  }
});
