import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

const built = await esbuild.build({
  stdin: { contents: 'export * from "./src/data/api-client";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  define: { __QD_SOURCE__: '"server"', __QD_CHAT__: '"on"', "process.env.NODE_ENV": '"production"' },
});
const lib = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

const LISTING = JSON.parse(fs.readFileSync(new URL("./server-payloads/list-added.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-02T10:00:00-05:00");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const spin = async (turns = 30) => {
  for (let turn = 0; turn < turns; turn += 1) await tick();
};

function fakeClock() {
  let now = NOW;
  const jobs = new Set();
  return {
    pending: () => jobs.size,
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

const settle = (promise) => {
  const state = { done: false, value: undefined, error: undefined };
  promise.then((value) => { state.done = true; state.value = value; }, (error) => { state.done = true; state.error = error; });
  return state;
};

const aborted = () => new DOMException("aborted", "AbortError");

function served(answer) {
  const time = fakeClock();
  const calls = [];
  const send = async (path, init) => {
    calls.push({ method: init.method, path, signal: init.signal });
    return answer(init, calls.length);
  };
  return { time, calls, client: lib.createApiClient({ send, schedule: time.schedule }) };
}

const hang = (init) => new Promise((resolve, reject) => {
  init.signal?.addEventListener("abort", () => reject(aborted()));
});

const stall = (init) => new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener("abort", () => controller.error(aborted())); } }), { status: 200, headers: { "Content-Type": "application/json" } });

const READS = [
  ["the card list", (client) => client.cards(), "/captain/cards"],
  ["the automatic card list", (client) => client.cards(true), "/captain/cards"],
  ["a card read-back", (client) => client.card("alba-1"), "/captain/cards/alba-1"],
  ["the token read before an answer", (client) => client.answer("alba-1", { rev: 3, pick: "A", note: "" }), "/captain/cards"],
  ["the token read before a comment", (client) => client.comment("alba-1", { text: "hello", requestId: "request-1" }), "/captain/cards"],
  ["the token read before signing out", (client) => client.signOutToken(), "/captain/cards"],
  ["the Mail list", (client) => client.mailList(), "/captain/mail"],
  ["a Mail thread", (client) => client.mailThread("MT-103"), "/captain/mail/MT-103"],
  ["the chat list", (client) => client.chat.rows(false), "/captain/api/chats"],
  ["a chat thread", (client) => client.chat.thread("steward", undefined, false), "/captain/api/chat"],
  ["the chat messages after the newest held one", (client) => client.chat.newer("steward", "m3", true), "/captain/api/chat"],
  ["the token read before a chat send", (client) => client.chat.send("steward", { text: "hello", clientId: "client-1" }), "/captain/cards"],
  ["the token read before a mark-read", (client) => client.chat.read("steward", "m3"), "/captain/cards"],
  ["the token read before a file upload", (client) => client.chat.token(), "/captain/cards"],
];

for (const [label, read, path] of READS) {
  test(label + " that never answers is cut after twenty seconds and fails as The server is not answering.", async () => {
    const h = served(hang);
    const state = settle(read(h.client));
    await spin();
    assert.deepEqual(h.calls.map((call) => call.method + " " + call.path.split("?")[0]), ["GET " + path]);
    await h.time.advance(19_900);
    assert.equal(state.done, false, "still waiting just before twenty seconds");
    await h.time.advance(200);
    assert.equal(state.done, true, "cut at twenty seconds");
    assert.deepEqual([state.error?.name, state.error?.message], ["Unavailable", "The server is not answering."]);
    assert.equal(h.calls[0].signal?.aborted, true, "the request itself was aborted");
    assert.equal(h.calls.length, 1, "nothing else was sent");
  });
}

test("a read whose answer starts and then stalls is cut after twenty seconds too, with the same words", async () => {
  const h = served(stall);
  const state = settle(h.client.cards());
  await spin();
  await h.time.advance(19_900);
  assert.equal(state.done, false, "still waiting just before twenty seconds");
  await h.time.advance(200);
  assert.deepEqual([state.error?.name, state.error?.message], ["Unavailable", "The server is not answering."]);
});

test("a read that answers in time is never aborted and leaves no timer behind, with a full answer or with a 304", async () => {
  const h = served((init, count) => (count === 1 ? new Response(JSON.stringify({ ...LISTING, csrf: "token-1" }), { status: 200, headers: { "Content-Type": "application/json", ETag: '"list-1"' } }) : new Response(null, { status: 304, headers: { ETag: '"list-1"' } })));
  const first = await h.client.cards();
  assert.equal(h.time.pending(), 0, "no timer after a full answer");
  const second = await h.client.cards();
  assert.equal(second, first, "the 304 gives the held list");
  assert.equal(h.time.pending(), 0, "no timer after a 304");
  await h.time.advance(60_000);
  assert.deepEqual(h.calls.map((call) => call.signal?.aborted), [false, false]);
});
