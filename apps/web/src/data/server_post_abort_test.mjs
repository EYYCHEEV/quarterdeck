import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

const contents = ["api-client", "server-source"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
const lib = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

const payload = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const LISTING = JSON.parse(payload("list-added.json"));
const OPEN = JSON.parse(payload("card-open.json"));
const ANSWER = payload("answer/answer-200-current.json");
const COMMENT = payload("answer/comment-200.json");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");

const json = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const spin = async (turns = 30) => {
  for (let turn = 0; turn < turns; turn += 1) await tick();
};

const TOKEN = "GET /captain/cards";
const CARD = "GET /captain/cards/alba-1";
const POST = "POST /captain/cards/alba-1/answer";
const COMMENT_POST = "POST /captain/cards/alba-1/comments";

function fakeClock() {
  let now = NOW;
  const jobs = new Set();
  return {
    now: () => now,
    schedule(run, delay) {
      const job = { run, at: now + delay };
      jobs.add(job);
      return () => jobs.delete(job);
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const job = [...jobs].filter((one) => one.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!job) break;
        now = job.at;
        jobs.delete(job);
        job.run();
        await spin(5);
      }
      now = target;
      await spin(5);
    },
  };
}

const hang = (init) => new Promise((resolve, reject) => {
  init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
});

const settle = (promise) => {
  const state = { done: false, value: undefined, error: undefined };
  promise.then((value) => { state.done = true; state.value = value; }, (error) => { state.done = true; state.error = error; });
  return state;
};

function serve(post) {
  const time = fakeClock();
  const calls = [];
  const streams = [];
  const recorded = [];
  let serial = 0;
  let hidden = false;
  const watchers = new Set();
  const visibility = { hidden: () => hidden, watch: (run) => { watchers.add(run); return () => watchers.delete(run); } };
  const server = {
    record() {
      recorded.push({ id: "mail-9" + recorded.length, kind: "answer", sender: "captain", sent: "2026-11-02T10:00:00-05:00", document: { qd: "answer/1", card: "alba-1", rev: 3, pick: "A", note: "Keep the draft", at: "2026-11-02T10:00:00-05:00" } });
    },
    recorded,
  };
  const send = async (path, init) => {
    calls.push({ method: init.method, path, signal: init.signal, at: time.now() - NOW });
    if (init.method === "POST") return post ? post(path, init, server, calls.filter((call) => call.method === "POST").length) : json(path.endsWith("/comments") ? COMMENT : ANSWER);
    if (path === "/captain/cards") {
      serial += 1;
      return json({ ...structuredClone(LISTING), csrf: "token-" + serial, freshUntil: 2_000_000_000 }, 200, { ETag: '"list-' + serial + '"' });
    }
    if (path === "/captain/cards/alba-1") return json({ ...structuredClone(OPEN), thread: [...OPEN.thread, ...recorded], csrf: "token-card", freshUntil: 2_000_000_000 });
    return json("{}", 404);
  };
  const openEvents = () => {
    const handlers = new Map();
    const stream = {
      readyState: 0,
      addEventListener: (name, run) => handlers.set(name, run),
      close() {},
      emit(name, data) { handlers.get(name)?.({ data }); },
      open() { this.readyState = 1; this.emit("open"); },
    };
    streams.push(stream);
    return stream;
  };
  const client = lib.createApiClient({ send, openEvents, schedule: time.schedule });
  const source = lib.createServerSource(client, time.now, time.schedule, undefined, visibility);
  source.watch(() => undefined);
  return {
    source, client, calls, time, streams, server,
    requests: (from = 0) => calls.slice(from).filter((call) => !call.path.startsWith("/captain/mail")).map((call) => call.method + " " + call.path),
    lists: (from = 0) => calls.slice(from).filter((call) => call.method === "GET" && call.path === "/captain/cards").length,
    credits: (from = 0) => calls.slice(from).reduce((total, call) => total + (call.method === "POST" ? 2 : 1), 0),
    hide() { hidden = true; for (const run of [...watchers]) run(); },
    show() { hidden = false; for (const run of [...watchers]) run(); },
    async boot() {
      await source.load();
      await spin();
      streams[0]?.open();
      await spin();
      await time.advance(5_000);
    },
    async refresh(lists) {
      streams.at(-1).emit("refresh", JSON.stringify(lists));
      await spin();
    },
    answer: () => source.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "Keep the draft", version: 3 }),
    comment: () => source.comment("alba-1", { text: "Keep the draft", requestId: "abort-1" }),
    async until(reached) {
      for (let turn = 0; turn < 60 && !reached(); turn += 1) await tick();
      assert.ok(reached(), "the request never reached the expected step");
    },
  };
}

test("a hung answer POST is aborted after twenty seconds and the answer reads back as timed out, a kind of not confirmed that still checks the card", async () => {
  const h = serve((path, init) => hang(init));
  await h.boot();
  const from = h.calls.length;
  const outcome = settle(h.answer());
  await h.until(() => h.calls.at(-1).method === "POST");
  await h.time.advance(19_000);
  assert.equal(outcome.done, false);
  assert.deepEqual(h.requests(from), [TOKEN, POST]);
  await h.time.advance(2_000);
  await spin();
  assert.equal(outcome.done, true, "the POST was never aborted");
  assert.equal(outcome.error?.name, "TimedOut");
  assert.deepEqual(h.requests(from), [TOKEN, POST, CARD]);
});

test("a hung answer POST that the server did record resolves as sent after the abort", async () => {
  const h = serve((path, init, server) => {
    server.record();
    return hang(init);
  });
  await h.boot();
  const from = h.calls.length;
  const outcome = settle(h.answer());
  await h.until(() => h.calls.at(-1).method === "POST");
  await h.time.advance(21_000);
  await spin();
  assert.equal(outcome.done, true, "the POST was never aborted");
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value.note, "Keep the draft");
  assert.deepEqual(h.requests(from), [TOKEN, POST, CARD]);
});

test("a hung comment POST is aborted after twenty seconds and is not confirmed", async () => {
  const h = serve((path, init) => hang(init));
  await h.boot();
  const from = h.calls.length;
  const outcome = settle(h.comment());
  await h.until(() => h.calls.at(-1).method === "POST");
  await h.time.advance(19_000);
  assert.equal(outcome.done, false);
  await h.time.advance(2_000);
  await spin();
  assert.equal(outcome.done, true, "the POST was never aborted");
  assert.equal(outcome.error?.name, "NotConfirmed");
  assert.deepEqual(h.requests(from), [TOKEN, COMMENT_POST]);
});

test("posting is back to zero after the abort, so a cards event held during the hung POST reads the list once the abort lands", async () => {
  const h = serve((path, init) => hang(init));
  await h.boot();
  const from = h.calls.length;
  const outcome = settle(h.answer());
  await h.until(() => h.calls.at(-1).method === "POST");
  await h.time.advance(5_000);
  await h.refresh({ cards: true, mail: false });
  await h.time.advance(10_000);
  assert.equal(h.lists(from), 1, "only the token read until the POST ends");
  await h.time.advance(6_000);
  await spin();
  assert.equal(outcome.done, true, "the POST was never aborted");
  await h.time.advance(10_000);
  await h.time.advance(10_000);
  assert.equal(h.lists(from), 2, "the held event's list read ran after the abort");
});

test("a POST in flight when the tab is hidden is aborted at twenty seconds, and the read that was held waits for the return", async () => {
  const h = serve((path, init) => hang(init));
  await h.boot();
  const from = h.calls.length;
  const outcome = settle(h.answer());
  await h.until(() => h.calls.at(-1).method === "POST");
  await h.time.advance(2_000);
  await h.refresh({ cards: true, mail: false });
  h.hide();
  await h.time.advance(21_000);
  await spin();
  assert.equal(outcome.done, true, "the POST was never aborted while hidden");
  assert.equal(outcome.error?.name, "TimedOut");
  assert.equal(h.lists(from), 1, "no automatic list read while hidden");
  h.show();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.equal(h.lists(from), 2, "one list read after the return");
});

test("an aborted POST keeps its two credits: the next try costs three more", async () => {
  const h = serve((path, init, server, number) => (number === 1 ? hang(init) : json(ANSWER)));
  await h.boot();
  const from = h.calls.length;
  const first = settle(h.answer());
  await h.until(() => h.calls.at(-1).method === "POST");
  await h.time.advance(21_000);
  await spin();
  assert.equal(first.done, true, "the POST was never aborted");
  assert.equal(h.credits(from), 4);
  const second = settle(h.answer());
  await spin();
  assert.equal(second.done, true);
  assert.equal(second.error, undefined);
  assert.deepEqual(h.requests(from), [TOKEN, POST, CARD, TOKEN, POST]);
  assert.equal(h.credits(from), 7);
  let allowed = 0;
  for (;;) {
    try {
      await h.client.card("alba-1");
      allowed += 1;
    } catch (error) {
      assert.equal(error.name, "RateLimited");
      break;
    }
    assert.ok(allowed < 40, "the meter never limited");
  }
  assert.equal(h.credits(0) + h.streams.length, 29);
});

test("an answer that comes back in time is not aborted later and leaves no timer", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  await h.answer();
  assert.deepEqual(h.requests(from), [TOKEN, POST]);
  const post = h.calls.find((call) => call.method === "POST");
  await h.time.advance(60_000);
  assert.ok(!post.signal?.aborted, "an answer that came back was aborted later");
});

test("an aborted answer that the server records late: Try again meets the server's refusal of the same pick, reads the card back and shows sent, with one recorded effect", async () => {
  const h = serve((path, init, server, number) => {
    if (number === 1) return hang(init);
    if (server.recorded.length > 0) return json({ error: "request unavailable" }, 503);
    server.record();
    return json(ANSWER);
  });
  await h.boot();
  const first = settle(h.answer());
  await h.until(() => h.calls.at(-1).method === "POST");
  await h.time.advance(21_000);
  await spin();
  assert.equal(first.done, true, "the POST was never aborted");
  assert.equal(first.error?.name, "TimedOut");
  assert.equal(h.server.recorded.length, 0);
  h.server.record();
  const second = settle(h.answer());
  await spin();
  assert.equal(second.done, true);
  assert.equal(second.error, undefined);
  assert.equal(second.value.note, "Keep the draft");
  assert.equal(h.server.recorded.length, 1);
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 2);
});
