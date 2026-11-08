import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle() {
  const contents = ["api-client", "server-source", "loader"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createApiClient, createServerSource, createLoader } = await bundle();

const text = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const LISTING = JSON.parse(text("list-added.json"));
const OPEN = JSON.parse(text("card-open.json"));
const CURRENT = text("answer/answer-200-current.json");
const COMMENTED = text("answer/comment-200.json");
const REFUSED = text("answer/request-refused.json");
const MAIL = JSON.parse(text("mail/list-5-threads.json"));
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const IDS = ["alba-1", "alba-2", "kivo-3"];
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

function serve({ ui = false, capture = false } = {}) {
  const time = fakeClock();
  const calls = [];
  const streams = [];
  const answered = new Set();
  const worlds = [];
  const bumped = new Map();
  let serial = 0;
  let release = null;
  let hold = false;
  let landPost = null;
  let holdPost = false;
  let refuse = false;

  const cardsNow = () => {
    const body = structuredClone(LISTING);
    for (const project of body.projects) {
      for (const lane of project.lanes) {
        for (const card of lane.cards) {
          if (answered.has(card.id)) Object.assign(card, { state: "done", rev: (card.rev ?? 1) + 1, answer: { pick: "A", at: "2026-11-02T10:00:05-05:00" } });
          else if (bumped.has(card.id)) card.rev = bumped.get(card.id);
        }
      }
    }
    return body;
  };
  const etag = () => '"list-' + answered.size + "-" + [...bumped.values()].join(".") + '"';

  const send = async (path, init) => {
    const inm = init.headers?.["If-None-Match"] ?? null;
    calls.push({ method: init.method, path, at: time.now() - NOW, inm, csrf: init.body ? JSON.parse(init.body).csrf : null });
    if (init.method === "POST") {
      if (path.endsWith("/comments")) return json(COMMENTED);
      const id = path.split("/")[3];
      if (holdPost) {
        holdPost = false;
        return new Promise((done) => (landPost = () => { answered.add(id); done(json(CURRENT)); }));
      }
      answered.add(id);
      return json(CURRENT);
    }
    if (path === "/captain/cards") {
      serial += 1;
      if (refuse) {
        refuse = false;
        return json(REFUSED, 403);
      }
      if (inm !== null && hold) {
        hold = false;
        return new Promise((done) => (release = () => done(new Response(null, { status: 304, headers: { ETag: inm } }))));
      }
      if (inm === etag()) return new Response(null, { status: 304, headers: { ETag: inm } });
      calls.at(-1).gave = "token-" + serial;
      return json(JSON.stringify({ ...cardsNow(), csrf: "token-" + serial }), 200, { ETag: etag() });
    }
    if (path === "/captain/mail") return json(JSON.stringify(MAIL.body), MAIL.status, { ETag: MAIL.headers.ETag });
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
  const source = createServerSource(createApiClient({ send, openEvents }), time.now, time.schedule);
  const loader = ui ? createLoader(async () => ({ world: await source.load(), at: time.now() }), (notify) => source.watch(notify)) : null;
  loader?.subscribe(() => undefined);
  if (!ui) source.watch(capture ? () => { void source.load().then((world) => worlds.push(world), () => undefined); } : () => undefined);

  return {
    source, calls, time, streams, worlds, loader,
    requests: (from = 0) => calls.slice(from).map((call) => call.method + " " + call.path),
    async boot() {
      if (!ui) await source.load();
      await tick();
      await tick();
      streams[0]?.open();
      await tick();
      if (!ui) await time.advance(5_000);
    },
    answer: (id) => source.answer(id, { choice: { kind: "option", letter: "A" }, note: "", version: REVS[id] }),
    event: (data = '{"cards":true}') => streams[0].emit("refresh", data),
    bump: (id, rev) => bumped.set(id, rev),
    holdNextConditional: () => { hold = true; },
    releaseHeld: () => release?.(),
    holdNextPost: () => { holdPost = true; },
    landPost: () => landPost?.(),
    refuseNextList: () => { refuse = true; },
    finish: (id) => answered.add(id),
    credits: () => calls.filter((call) => call.at < 60_000).reduce((total, call) => total + (call.method === "POST" ? 2 : 1), 0) + streams.length,
    spent: (from = 0) => calls.slice(from).reduce((total, call) => total + (call.method === "POST" ? 2 : 1), 0),
  };
}

const LIST = "GET /captain/cards";
const POST = (id) => "POST /captain/cards/" + id + "/answer";
const CARD = (id) => "GET /captain/cards/" + id;

test("one answer makes exactly one list read and one POST: the token read is the list read, and the event for his own POST reads nothing", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  await h.answer("alba-1");
  h.event();
  await h.time.advance(9_000);
  assert.deepEqual(h.requests(from), [LIST, POST("alba-1")]);
});

test("the token read's list reaches the Queue: a card finished elsewhere leaves the waiting count with no list read besides the token's", async () => {
  const h = serve({ capture: true });
  await h.boot();
  const waiting = (world) => world.cards.filter((card) => card.answer === null).length;
  const before = waiting(h.worlds.at(-1));
  const from = h.calls.length;
  h.finish("kivo-3");
  await h.answer("alba-1");
  await tick();
  assert.deepEqual([waiting(h.worlds.at(-1)), h.requests(from)], [before - 2, [LIST, POST("alba-1")]]);
});

test("a list read in flight when he answers is never used for the token: the answer reads the list in full, posts that read's token, and the late read changes nothing", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  h.holdNextConditional();
  const checking = h.source.load();
  checking.catch(() => undefined);
  await tick();
  await h.answer("alba-1");
  h.releaseHeld();
  await checking;
  await h.time.advance(1_000);
  const sent = h.calls.slice(from);
  assert.deepEqual(sent.map((call) => [call.method, call.path, call.inm !== null]), [["GET", "/captain/cards", true], ["GET", "/captain/cards", false], ["POST", "/captain/cards/alba-1/answer", false]]);
  assert.equal(sent[2].csrf, sent[1].gave);
});

test("three quick answers, an event after each POST, stay at three requests each: the card read, one list read and the POST", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  for (const id of IDS) {
    await h.source.openCard(id);
    await h.answer(id);
    h.event();
  }
  await h.time.advance(9_000);
  assert.deepEqual(h.requests(from), IDS.flatMap((id) => [CARD(id), LIST, POST(id)]));
});

test("one trailing list read runs ten seconds after his last POST, and none before", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  await h.answer("alba-1");
  h.event();
  await h.time.advance(9_999);
  assert.deepEqual(h.requests(from), [LIST, POST("alba-1")]);
  await h.time.advance(1);
  assert.deepEqual(h.requests(from), [LIST, POST("alba-1"), LIST]);
  await h.time.advance(30_000);
  assert.deepEqual(h.requests(from), [LIST, POST("alba-1"), LIST]);
});

test("the answered card is not read again for its revision bump, and another card's bump still is", async () => {
  const h = serve();
  await h.boot();
  await h.source.openCard("alba-1");
  await h.source.openCard("alba-2");
  const from = h.calls.length;
  await h.answer("alba-1");
  h.bump("alba-2", 2);
  h.event();
  await h.time.advance(10_000);
  const sent = h.requests(from);
  assert.equal(sent.includes(CARD("alba-1")), false, "the answered card is read again");
  assert.equal(sent.filter((request) => request === CARD("alba-2")).length, 1, "the other card's bump is read once");
});

test("an event from another bot more than ten seconds after his POST still reads the list at once", async () => {
  const h = serve();
  await h.boot();
  await h.answer("alba-1");
  await h.time.advance(11_000);
  const from = h.calls.length;
  h.event();
  await tick();
  assert.deepEqual(h.requests(from), [LIST]);
});

test("an event that arrives while his POST is still in flight counts as his own: no list read for it, and one trailing read ten seconds after the POST lands", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  h.holdNextPost();
  const sending = h.answer("alba-1");
  await tick();
  h.event();
  await h.time.advance(7_000);
  assert.deepEqual(h.requests(from), [LIST, POST("alba-1")]);
  h.landPost();
  await sending;
  await h.time.advance(9_999);
  assert.deepEqual(h.requests(from), [LIST, POST("alba-1")]);
  await h.time.advance(1);
  assert.deepEqual(h.requests(from), [LIST, POST("alba-1"), LIST]);
});

test("a comment follows the same rule: its token read is the list read and the event for it reads nothing", async () => {
  const h = serve({ capture: true });
  await h.boot();
  const waiting = (world) => world.cards.filter((card) => card.answer === null).length;
  const before = waiting(h.worlds.at(-1));
  const from = h.calls.length;
  h.finish("kivo-3");
  await h.source.comment("alba-1", { text: "Five fits the phone.", requestId: "req-1" });
  h.event();
  await h.time.advance(9_000);
  assert.deepEqual([waiting(h.worlds.at(-1)), h.requests(from)], [before - 1, [LIST, "POST /captain/cards/alba-1/comments"]]);
});

test("a session end clears the stale mark: after signing in again no trailing read follows for it", async () => {
  const h = serve();
  await h.boot();
  await h.answer("alba-1");
  h.event();
  h.refuseNextList();
  await assert.rejects(h.source.load(), { name: "SignInRequired" });
  h.source.signIn();
  await h.source.load();
  const from = h.calls.length;
  await h.time.advance(11_000);
  assert.deepEqual(h.requests(from).filter((request) => request === LIST), []);
});

test("three answers, a Mail open and the page's own reads cost at most 17 credits in one minute", async (t) => {
  const h = serve({ ui: true });
  await h.boot();
  await h.source.openCard("alba-1");
  await tick();
  await h.time.advance(2_000);
  await h.source.openMailList();
  await h.time.advance(2_000);
  for (const [index, id] of IDS.entries()) {
    await h.answer(id);
    h.event();
    await h.time.advance(2_000);
    if (IDS[index + 1]) {
      await h.source.openCard(IDS[index + 1]);
      await tick();
      await h.time.advance(2_000);
    }
  }
  await h.time.advance(14_000);
  t.diagnostic("credits in the first minute: " + h.credits() + " (" + h.calls.length + " requests, " + h.streams.length + " stream open): " + h.calls.map((call) => call.method + " " + call.path.replace("/captain/", "") + " @" + call.at / 1000).join(", "));
  assert.ok(h.credits() <= 17, "credits " + h.credits());
});

async function pageWithCardOpen(h) {
  await h.boot();
  await h.source.openCard("alba-1");
  await tick();
  await h.time.advance(6_000);
}

test("the card opened right after his answer makes no list read of its own: the token list, the POST and the card read are 3 requests and 4 credits", async () => {
  const h = serve({ ui: true });
  await pageWithCardOpen(h);
  const from = h.calls.length;
  await h.answer("alba-1");
  h.event();
  await h.source.openCard("alba-2");
  await tick();
  await h.time.advance(2_000);
  assert.deepEqual([h.requests(from), h.spent(from)], [[LIST, POST("alba-1"), CARD("alba-2")], 4]);
});

test("a card opened more than ten seconds after his POST still reads the list", async () => {
  const h = serve({ ui: true });
  await pageWithCardOpen(h);
  await h.answer("alba-1");
  h.event();
  await h.time.advance(10_500);
  const from = h.calls.length;
  await h.source.openCard("alba-2");
  await tick();
  assert.deepEqual(h.requests(from), [CARD("alba-2"), LIST]);
});

test("a card opened right after the page's first list, with no answer of his, still checks the list", async () => {
  const h = serve({ ui: true });
  await h.boot();
  await h.source.openCard("alba-1");
  await tick();
  assert.deepEqual(h.requests(), [LIST, CARD("alba-1"), LIST]);
});

test("after a session end a card open and a load send nothing", async () => {
  const h = serve({ ui: true });
  await pageWithCardOpen(h);
  await h.answer("alba-1");
  h.refuseNextList();
  await assert.rejects(h.source.load(), { name: "SignInRequired" });
  const from = h.calls.length;
  await assert.rejects(h.source.openCard("alba-2"), { name: "NotFound" });
  await assert.rejects(h.source.load(), { name: "SignInRequired" });
  assert.deepEqual(h.requests(from), []);
});

test("a card opened right after his answer still publishes a newer world after its read settles, which is what the Task Card screen waits for", async () => {
  const h = serve({ ui: true });
  await pageWithCardOpen(h);
  await h.answer("alba-1");
  let seenAtSettle = null;
  await h.source.openCard("alba-2").then(() => { seenAtSettle = h.loader.snapshot().value.world; });
  await tick();
  assert.notEqual(seenAtSettle, null);
  assert.notEqual(h.loader.snapshot().value.world, seenAtSettle);
});
