import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { watchEvents } = await loadTs("src/platform/events.ts");

function fakeStream(url) {
  const stream = {
    url,
    closed: 0,
    listeners: new Map(),
    addEventListener: (name, listener) => stream.listeners.set(name, [...(stream.listeners.get(name) ?? []), listener]),
    close: () => void (stream.closed += 1),
    emit: (name, event) => (stream.listeners.get(name) ?? []).forEach((listener) => listener(event)),
  };
  return stream;
}

function withGlobal(name, value, run) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, name, before ?? { value: undefined, configurable: true, writable: true });
  }
}

test("it opens the address and hands the data of each named event to the listener as text", () => {
  const seen = [];
  const streams = [];
  watchEvents("/captain/events", "refresh", (data) => seen.push(data), (url) => (streams.push(fakeStream(url)), streams[0]));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, "/captain/events");
  streams[0].emit("refresh", { data: '{"cards":true}' });
  streams[0].emit("refresh", { data: 7 });
  assert.deepEqual(seen, ['{"cards":true}', "7"]);
});

test("an event with another name is not handed on", () => {
  const seen = [];
  const stream = fakeStream("/x");
  watchEvents("/x", "refresh", (data) => seen.push(data), () => stream);
  stream.emit("message", { data: "no" });
  assert.deepEqual(seen, []);
});

test("the returned stop closes the stream", () => {
  const stream = fakeStream("/x");
  const stop = watchEvents("/x", "refresh", () => undefined, () => stream);
  assert.equal(stream.closed, 0);
  stop();
  assert.equal(stream.closed, 1);
});

test("with no opener given it uses the browser's EventSource on the same address", () => {
  const made = [];
  class FakeEventSource {
    constructor(url) {
      made.push(this);
      this.url = url;
      this.listeners = [];
      this.closed = false;
    }
    addEventListener(name, listener) {
      this.listeners.push([name, listener]);
    }
    close() {
      this.closed = true;
    }
  }
  withGlobal("EventSource", FakeEventSource, () => {
    const seen = [];
    const stop = watchEvents("/captain/events", "refresh", (data) => seen.push(data));
    assert.equal(made.length, 1);
    assert.equal(made[0].url, "/captain/events");
    made[0].listeners[0][1]({ data: "x" });
    assert.deepEqual([made[0].listeners[0][0], seen], ["refresh", ["x"]]);
    stop();
    assert.equal(made[0].closed, true);
  });
});

test("an error is handed on without claiming an HTTP status", () => {
  const stream = fakeStream("/captain/events");
  const seen = [];
  watchEvents("/captain/events", "refresh", () => undefined, () => stream, (...args) => seen.push(args));
  stream.emit("error", { status: 401, data: "not a status contract" });
  assert.deepEqual(seen, [[]]);
});

test("native readyState separates open, reconnecting and terminal closure, and stopped callbacks do nothing", () => {
  const stream = fakeStream("/captain/events");
  const states = [];
  const data = [];
  let errors = 0;
  const stop = watchEvents("/captain/events", "refresh", (value) => data.push(value), () => stream, () => { errors += 1; }, (state) => states.push(state));
  stream.emit("open", {});
  stream.readyState = 0;
  stream.emit("error", {});
  stream.readyState = 2;
  stream.emit("error", {});
  assert.deepEqual(states, ["open", "reconnecting", "closed"]);
  assert.equal(errors, 2);
  stop();
  stop();
  stream.emit("open", {});
  stream.emit("error", {});
  stream.emit("refresh", { data: "late" });
  assert.deepEqual(states, ["open", "reconnecting", "closed"]);
  assert.equal(errors, 2);
  assert.deepEqual(data, []);
  assert.equal(stream.closed, 1);
});
