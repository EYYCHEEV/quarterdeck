import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle() {
  const contents = ["api-client", "server-source"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createApiClient, createServerSource } = await bundle();

const text = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const LISTING = JSON.parse(text("list-added.json"));
const OPEN = JSON.parse(text("card-open.json"));
const CURRENT = text("answer/answer-200-current.json");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const REVS = { "alba-1": 3, "alba-2": 1, "kivo-3": 1 };

const json = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
        await tick();
      }
      now = target;
      await tick();
    },
  };
}

function serve({ postStatus = 200 } = {}) {
  const time = fakeClock();
  const calls = [];
  const streams = [];
  const bumped = new Map();
  let serial = 0;
  const etag = () => '"list-' + [...bumped.entries()].map(([id, rev]) => id + rev).join(".") + '"';
  const listBody = () => {
    const body = structuredClone(LISTING);
    for (const project of body.projects) for (const lane of project.lanes) for (const card of lane.cards) if (bumped.has(card.id)) card.rev = bumped.get(card.id);
    return body;
  };
  const send = async (path, init) => {
    const inm = init.headers?.["If-None-Match"] ?? null;
    calls.push({ method: init.method, path, at: time.now() - NOW });
    if (init.method === "POST") return postStatus === 200 ? json(CURRENT) : json("", postStatus);
    if (path === "/captain/cards") {
      serial += 1;
      if (inm === etag()) return new Response(null, { status: 304, headers: { ETag: inm } });
      return json(JSON.stringify({ ...listBody(), csrf: "token-" + serial }), 200, { ETag: etag() });
    }
    if (path === "/captain/mail") return json("{}", 404);
    const id = path.split("/")[3];
    return json(JSON.stringify({ ...OPEN, card: { ...OPEN.card, id }, rev: bumped.get(id) ?? REVS[id] }));
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
  let hidden = false;
  const watchers = new Set();
  const visibility = { hidden: () => hidden, watch: (run) => { watchers.add(run); return () => watchers.delete(run); } };
  const source = createServerSource(createApiClient({ send, openEvents }), time.now, time.schedule, undefined, visibility);
  const worlds = [];
  source.watch(() => undefined);
  return {
    source, calls, time, worlds,
    requests: (from = 0) => calls.slice(from).map((call) => call.method + " " + call.path),
    async boot() {
      worlds.push(await source.load());
      await tick();
      await tick();
      streams[0]?.open();
      await tick();
      await time.advance(5_000);
    },
    bump(id, rev) { bumped.set(id, rev); },
    hide() { hidden = true; for (const run of [...watchers]) run(); },
    show() { hidden = false; for (const run of [...watchers]) run(); },
    async moveOn() {
      streams[0].emit("refresh", '{"cards":true}');
      await time.advance(6_000);
    },
  };
}

const LIST = "GET /captain/cards";
const CARD = (id) => "GET /captain/cards/" + id;

test("two cards opened and both lists move to a newer revision: one card read goes out, for the card opened last", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  await h.source.openCard("alba-2");
  const from = h.calls.length;
  h.bump("alba-1", 4);
  h.bump("alba-2", 2);
  await h.moveOn();
  assert.deepEqual(h.requests(from), [LIST, CARD("alba-2")]);
});

test("after closeCard for the card on screen no card read goes out when the list moves on", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  h.source.closeCard("alba-1");
  const from = h.calls.length;
  h.bump("alba-1", 4);
  await h.moveOn();
  assert.deepEqual(h.requests(from), [LIST]);
});

test("closeCard for a card that is not the one on screen changes nothing: the card on screen is still read again", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  await h.source.openCard("alba-2");
  h.source.closeCard("alba-1");
  const from = h.calls.length;
  h.bump("alba-1", 4);
  h.bump("alba-2", 2);
  await h.moveOn();
  assert.deepEqual(h.requests(from), [LIST, CARD("alba-2")]);
});

test("a card that is not on screen is not read when the list is read again and says nothing new, and a 304 reads no card", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  await h.source.openCard("alba-2");
  h.source.closeCard("alba-2");
  const from = h.calls.length;
  await h.moveOn();
  await h.moveOn();
  assert.deepEqual(h.requests(from), [LIST, LIST]);
});

test("the card check after an answer that was not confirmed leaves the card on screen where it was", async () => {
  const h = serve({ postStatus: 503 });
  await h.boot();
  await h.source.openCard("alba-2");
  await assert.rejects(h.source.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "", version: 3 }), { name: "NotConfirmed" });
  const from = h.calls.length;
  h.bump("alba-1", 4);
  h.bump("alba-2", 2);
  await h.moveOn();
  assert.deepEqual(h.requests(from), [LIST, CARD("alba-2")]);
});

test("a kept read of a card that is not on screen is dropped when the list moves on: a stale answer is no longer checked against it, and opening the card reads it fresh", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  await h.source.openCard("alba-2");
  const moved = h.calls.length;
  h.bump("alba-1", 4);
  await h.moveOn();
  assert.deepEqual(h.requests(moved), [LIST]);
  const from = h.calls.length;
  await h.source.answer("alba-1", { choice: { kind: "option", letter: "D" }, note: "", version: 3 });
  assert.deepEqual(h.requests(from), [LIST, "POST /captain/cards/alba-1/answer"]);
  const after = h.calls.length;
  await h.source.openCard("alba-1");
  assert.deepEqual(h.requests(after), [CARD("alba-1")]);
});

test("the card on screen is still read again once for each newer revision, and not again for the same one", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  const from = h.calls.length;
  h.bump("alba-1", 4);
  await h.moveOn();
  await h.moveOn();
  assert.deepEqual(h.requests(from), [LIST, CARD("alba-1"), LIST]);
});

test("a card on screen in a hidden tab: a newer revision reads nothing until the tab returns, then reads the card once", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  h.hide();
  const from = h.calls.length;
  h.bump("alba-1", 4);
  await h.source.load();
  await h.time.advance(30_000);
  assert.deepEqual(h.requests(from), [LIST]);
  h.show();
  await h.time.advance(6_000);
  assert.deepEqual(h.requests(from), [LIST, LIST, CARD("alba-1")]);
  await h.time.advance(30_000);
  assert.equal(h.requests(from).filter((one) => one === CARD("alba-1")).length, 1);
});
