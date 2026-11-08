import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

const built = await esbuild.build({ stdin: { contents: ["api-client", "server-source", "loader", "source", "session"].map((name) => 'export * from "./src/data/' + name + '";').join("\n"), resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
const { createApiClient, createServerSource, createLoader, readSession, writeSession } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const payload = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const ADDED = JSON.parse(payload("list-added.json"));
const OPEN = JSON.parse(payload("card-open.json"));
const ANSWER = payload("answer/answer-200-current.json");
const COMMENT = payload("answer/comment-200.json");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const json = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ETag: '"freshness-list"' } });

function fakeTime() {
  let now = NOW;
  const jobs = new Set();
  let check = () => undefined;
  return {
    now: () => now,
    schedule(run, delay) {
      assert.ok(Number.isFinite(delay) && delay >= 0, "finite nonnegative timer delay");
      const job = { at: now + delay, run };
      jobs.add(job);
      return () => jobs.delete(job);
    },
    pending: () => jobs.size,
    check: (run) => { check = run; },
    async advance(delta) {
      const target = now + delta;
      let ran = 0;
      for (;;) {
        const next = [...jobs].filter((job) => job.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        assert.ok(++ran < 10_000, "scheduler must not spin on an expired deadline");
        now = next.at;
        jobs.delete(next);
        next.run();
        await flush();
        check();
      }
      now = target;
      await flush();
      check();
    },
  };
}

function harness(options = {}) {
  const time = fakeTime();
  const traffic = [];
  const streams = [];
  const pending = [];
  const failures = [];
  let generation = 0;
  let confirmation = -Infinity;
  let serial = 0;
  const intent = new AsyncLocalStorage();
  let firstList = true;
  let listReply = options.list ?? (() => 200);
  let postReply = () => 200;
  let cardReply = () => 200;
  let hidden = options.hidden ?? false;
  const shownWatchers = new Set();
  const visibility = { hidden: () => hidden, watch: (run) => { shownWatchers.add(run); return () => shownWatchers.delete(run); } };
  const record = (kind, cost, explicit) => {
    const item = { kind, cost, explicit, hidden, at: time.now() - NOW };
    traffic.push(item);
    return item;
  };
  const listBody = (title = "private g" + generation + " read " + serial) => {
    const body = structuredClone(ADDED);
    body.projects[0].lanes[0].cards[0].title = title;
    return { ...body, csrf: "sample-freshness-token-not-real", freshUntil: 2_000_000_000 };
  };
  const reply = (status, sent, epoch, body) => {
    if (epoch === generation) {
      if (status === 401 || status === 403) {
        generation += 1;
        confirmation = -Infinity;
      } else if (status === 200 || status === 304) confirmation = Math.max(confirmation, sent);
    }
    if (status === "network") throw new TypeError("offline");
    if (status === 304) return new Response(null, { status: 304, headers: { ETag: '"freshness-list"' } });
    return json(status === 200 ? body : { error: "request unavailable" }, status);
  };
  const send = async (path, init) => {
    serial += 1;
    const sent = time.now();
    const epoch = generation;
    const action = intent.getStore();
    if (init.method === "POST") {
      assert.equal(action, "post", "recovery never generates a POST");
      record("post", 2, true);
      return reply(postReply(), sent, epoch, path.endsWith("/comments") ? COMMENT : ANSWER);
    }
    if (path.startsWith("/captain/mail")) {
      record("mail", 1, false);
      return reply(503, sent, epoch, null);
    }
    if (path !== "/captain/cards") {
      record("card", 1, action === "card" || action === "post");
      return reply(cardReply(), sent, epoch, { ...OPEN, csrf: "sample-freshness-token-not-real", freshUntil: 2_000_000_000 });
    }
    const item = record("list", 1, firstList || action !== undefined);
    firstList = false;
    item.headers = init.headers;
    const next = listReply();
    const body = listBody();
    if (next === "hold") return new Promise((resolve, reject) => pending.push({ sent, epoch, body, resolve, reject }));
    return reply(next, sent, epoch, body);
  };
  const openEvents = (url) => {
    record("stream", 1, false);
    const handlers = new Map();
    const stream = {
      url,
      readyState: 0,
      closed: 0,
      addEventListener: (name, run) => handlers.set(name, run),
      close() { this.closed += 1; this.readyState = 2; },
      emit(name, data) { handlers.get(name)?.({ data }); },
      open() { this.readyState = 1; this.emit("open"); },
      fail(state = 2) { this.readyState = state; this.emit("error"); },
    };
    streams.push(stream);
    return stream;
  };
  const client = createApiClient({ send, openEvents });
  const source = createServerSource(client, time.now, time.schedule, undefined, visibility);
  const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
  const stop = loader.subscribe(() => {});
  const stopFailures = source.watch((error) => { if (error) failures.push(error.name); });
  const lists = () => traffic.filter((item) => item.kind === "list");
  const explicit = (kind, run) => intent.run(kind, run);
  return {
    time, streams, traffic, pending, failures, client, source, loader, lists,
    confirmation: () => confirmation,
    generation: () => generation,
    listReply: (run) => { listReply = run; },
    postReply: (run) => { postReply = run; },
    cardReply: (run) => { cardReply = run; },
    refresh() { explicit("list", loader.refresh); },
    watchLoader: (other) => explicit("list", () => other.subscribe(() => {})),
    card: () => explicit("card", () => source.openCard("alba-1")),
    creditCard: () => explicit("card", () => client.card("alba-1")),
    answer: () => explicit("post", () => source.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "Keep the draft", version: 3 })),
    comment: () => explicit("post", () => source.comment("alba-1", { text: "Keep the draft", requestId: "freshness-1" })),
    hide() { hidden = true; for (const run of [...shownWatchers]) run(); },
    show() { hidden = false; for (const run of [...shownWatchers]) run(); },
    hiddenSends: () => traffic.filter((item) => item.hidden && !item.explicit),
    complete(status = 200, title) {
      const held = pending.shift();
      assert.ok(held, "a delayed request exists");
      try { held.resolve(reply(status, held.sent, held.epoch, title ? listBody(title) : held.body)); }
      catch (error) { held.reject(error); }
    },
    stop() { stop(); stopFailures(); },
  };
}

async function boot(h) {
  await flush();
  assert.ok(h.loader.snapshot().value?.cards.length, "first list is visible");
  h.streams.at(-1)?.open();
  await flush();
}

const budgetChecks = new WeakMap();

function assertBudget(h) {
  const checked = budgetChecks.get(h) ?? { at: 0, listAt: null };
  for (; checked.at < h.traffic.length; checked.at += 1) {
    const item = h.traffic[checked.at];
    const spent = h.traffic.slice(0, checked.at + 1).filter((prior) => prior.at > item.at - 60_000).reduce((sum, prior) => sum + prior.cost, 0);
    assert.ok(spent <= 29, "own rolling session-check total <=29");
    if (!item.explicit) {
      assert.ok(spent <= 21, "automatic work leaves eight credits for explicit actions");
      if (item.kind !== "list" && spent - item.cost === 20 && checked.listAt !== null && item.at - checked.listAt >= 45_000) assert.fail("freshness must precede other automatic work when credit is tight");
    }
    if (item.kind === "list") {
      if (!item.explicit && checked.listAt !== null) assert.ok(item.at - checked.listAt >= 5_000, "automatic list sends at least five seconds after the prior list");
      checked.listAt = item.at;
    }
  }
  budgetChecks.set(h, checked);
  assert.ok(h.time.pending() <= 1, "one source scheduler timer");
}

test("209: first list is sent at 0 ms with free credits and no timer advanced", async () => {
  const h = harness();
  try {
    assert.deepEqual(h.lists().map((item) => item.at), [0]);
    assert.equal(h.time.now(), NOW);
    await flush();
    assert.ok(h.loader.snapshot().value);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: a free-credit card arrival starts its list check with no timer advanced", async (t) => {
  const h = harness();
  try {
    await boot(h);
    await h.card();
    await flush();
    t.diagnostic(JSON.stringify({ at: h.time.now() - NOW, sends: h.traffic.map(({ kind, at, cost }) => ({ kind, at, cost })) }));
    assert.deepEqual(h.lists().map((item) => item.at), [0, 0]);
    assert.equal(h.time.now(), NOW);
    assert.equal(h.loader.snapshot().value.cards[0].options.length, 3);
  } finally { h.stop(); }
});

test("209: free-credit Retry starts immediately and joins an in-flight list without a second send", async () => {
  const h = harness();
  try {
    await boot(h);
    h.listReply(() => "hold");
    h.refresh();
    await flush();
    assert.deepEqual(h.lists().map((item) => item.at), [0, 0]);
    h.refresh();
    await flush();
    assert.deepEqual(h.lists().map((item) => item.at), [0, 0]);
    h.complete(200);
    await flush();
    assert.equal(h.time.now(), NOW);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: a terminal stream gets one replacement, then its refused list enters the one auth pause", async () => {
  const h = harness();
  try {
    await boot(h);
    h.streams[0].fail(2);
    await h.time.advance(5_000);
    assert.equal(h.streams.length, 2);
    assert.equal(h.streams[0].closed, 1);
    h.streams[1].open();
    h.listReply(() => 403);
    h.streams[1].fail(2);
    await h.time.advance(5_000);
    assert.equal(h.loader.snapshot().value, null);
    assert.equal(h.loader.snapshot().signIn, true);
    assert.deepEqual(h.failures, ["SignInRequired"]);
    assert.equal(h.time.pending(), 1);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: disconnected checks back off by 5, 10, 20, 40 then 45 seconds without duplicate-error resets", async () => {
  const h = harness();
  try {
    await boot(h);
    h.listReply(() => 503);
    h.streams[0].fail(2);
    h.streams[0].fail(2);
    await h.time.advance(165_000);
    assert.deepEqual(h.lists().map((item) => item.at), [0, 5_000, 15_000, 35_000, 75_000, 120_000, 165_000]);
    assert.equal(h.loader.snapshot().value, null);
    assert.equal(h.loader.snapshot().signIn, undefined);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: an open quiet stream still checks the list every 45 seconds", async () => {
  const h = harness();
  try {
    await boot(h);
    await h.time.advance(90_000);
    assert.deepEqual(h.lists().map((item) => item.at), [0, 45_000, 90_000]);
    assert.equal(h.streams.length, 1);
    assertBudget(h);
  } finally { h.stop(); }
});

for (const status of [503, "network"]) {
  test("209: " + status + " inside the bound keeps data, expiry hides it without sign-in, and fresh 200 drops old detail", async () => {
    const h = harness();
    try {
      await boot(h);
      await h.card();
      await flush();
      const before = h.loader.snapshot().value;
      assert.equal(before.cards[0].options.length, 3);
      h.listReply(() => status);
      h.streams[0].fail(0);
      await h.time.advance(60_999);
      assert.equal(h.loader.snapshot().value, before);
      await h.time.advance(1);
      assert.equal(h.loader.snapshot().value, null);
      assert.equal(h.loader.snapshot().signIn, undefined);
      assert.equal(h.loader.snapshot().unconfirmed, true);
      assert.ok(h.failures.includes("SessionUnconfirmed"));
      h.listReply(() => 200);
      await h.time.advance(14_000);
      assert.ok(h.loader.snapshot().value?.cards.length);
      assert.equal(h.loader.snapshot().value.cards[0].options.length, 0);
      assert.equal(h.loader.snapshot().unconfirmed, undefined);
      assert.equal("If-None-Match" in h.lists().at(-1).headers, false);
      assertBudget(h);
    } finally { h.stop(); }
  });
}

test("209: confirmation ages from send, and a pending later check cannot delay the deadline", async () => {
  const h = harness();
  try {
    await boot(h);
    h.listReply(() => "hold");
    await h.time.advance(45_000);
    assert.equal(h.pending.length, 1);
    await h.time.advance(15_000);
    h.complete(200, "Confirmed from the send at 45 seconds");
    await flush();
    assert.ok(h.loader.snapshot().value);
    await h.time.advance(45_999);
    assert.ok(h.loader.snapshot().value);
    await h.time.advance(1);
    assert.equal(h.loader.snapshot().value, null);
    assert.equal(h.loader.snapshot().unconfirmed, true);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: an initial list answered more than 61 seconds after send cannot expose its private body", async () => {
  const h = harness({ list: () => "hold" });
  try {
    await flush();
    assert.equal(h.pending.length, 1);
    await h.time.advance(61_001);
    h.complete(200, "An over-age private response");
    await flush();
    assert.equal(h.loader.snapshot().value, null);
    assert.equal(h.loader.snapshot().signIn, undefined);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: 304 confirms at send time but cannot rebuild a purged hidden listing", async () => {
  const h = harness();
  try {
    await boot(h);
    h.listReply(() => 304);
    await h.time.advance(45_000);
    assert.ok(h.loader.snapshot().value);
    h.listReply(() => "hold");
    await h.time.advance(61_000);
    assert.equal(h.loader.snapshot().value, null);
    h.complete(304);
    await flush();
    assert.equal(h.loader.snapshot().value, null);
    const beforeRecovery = h.lists().length;
    h.listReply(() => 200);
    await h.time.advance(45_000);
    assert.ok(h.loader.snapshot().value);
    assert.equal("If-None-Match" in h.lists()[beforeRecovery].headers, false);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: automatic event bursts merge at five seconds and multiple loaders and Retry join the in-flight list", async () => {
  const h = harness();
  const second = createLoader(() => h.source.load(), (notify) => h.source.watch(notify));
  let stopSecond = () => undefined;
  try {
    await boot(h);
    h.listReply(() => "hold");
    for (let at = 0; at < 50; at += 1) h.streams[0].emit("refresh", '{"cards":true}');
    await h.time.advance(4_999);
    assert.equal(h.lists().length, 1);
    await h.time.advance(1);
    stopSecond = second.subscribe(() => {});
    h.refresh();
    assert.deepEqual(h.lists().map((item) => item.at), [0, 5_000]);
    h.complete(200);
    await flush();
    assert.ok(second.snapshot().value?.cards.length);
    assertBudget(h);
  } finally { stopSecond(); h.stop(); }
});

test("209: the comment's token read is its own GET and never joins the admitted list, and the refused comment is never replayed", async () => {
  const h = harness();
  try {
    await boot(h);
    h.postReply(() => 503);
    await assert.rejects(h.comment(), { name: "NotConfirmed" });
    h.postReply(() => 200);
    const sending = h.comment();
    h.refresh();
    h.streams[0].emit("refresh", '{"cards":true}');
    await flush();
    await sending;
    assert.deepEqual(h.traffic.map((item) => item.kind), ["list", "stream", "list", "post", "list", "list", "post"]);
    assert.deepEqual(h.lists().map((item) => item.at), [0, 0, 0, 0]);
    assert.equal(h.traffic.filter((item) => item.kind === "post").length, 2);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: automatic traffic preserves eight credits and freshness precedes reconnect when credit returns", async () => {
  const h = harness();
  try {
    await boot(h);
    for (let at = 0; at < 19; at += 1) await h.creditCard();
    await flush();
    h.streams[0].fail(0);
    await h.time.advance(5_000);
    assert.equal(h.lists().length, 1, "automatic list cannot spend the explicit-action reserve");
    await h.answer();
    assert.deepEqual(h.traffic.slice(-2).map((item) => [item.kind, item.cost, item.explicit]), [["list", 1, true], ["post", 2, true]], "the answer's token read costs one explicit credit and the post two");
    h.refresh();
    await flush();
    assert.equal(h.lists().length, 3, "explicit Retry may use the reserve after the token read");
    await h.time.advance(55_000);
    const returning = h.traffic.filter((item) => item.at === 60_000);
    assert.equal(returning[0]?.kind, "list", "freshness before automatic reconnect");
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: an explicit action with no credit is RateLimited locally, never queued for later", async () => {
  const h = harness();
  try {
    await boot(h);
    for (let at = 0; at < 27; at += 1) await h.creditCard();
    await assert.rejects(h.answer(), { name: "RateLimited" });
    await assert.rejects(h.comment(), { name: "RateLimited" });
    assert.equal(h.traffic.filter((item) => item.kind === "post").length, 0);
    await h.time.advance(60_000);
    assert.equal(h.traffic.filter((item) => item.kind === "post").length, 0);
    assertBudget(h);
  } finally { h.stop(); }
});

test("263: limited says whether the app's own cap would refuse an explicit read: no after page open, yes once the explicit credits are used, no again a minute later", async () => {
  const h = harness();
  try {
    await boot(h);
    assert.equal(h.source.limited(), false);
    for (let at = 0; at < 27; at += 1) await h.creditCard();
    assert.equal(h.source.limited(), true);
    await assert.rejects(h.card(), { name: "RateLimited" });
    assert.equal(h.source.limited(), true);
    await h.time.advance(60_000);
    assert.equal(h.source.limited(), false);
  } finally { h.stop(); }
});

test("209: a held auth probe refusing after manual recovery still clears the fresh private view", async () => {
  const h = harness();
  try {
    await boot(h);
    h.listReply(() => 403);
    h.refresh();
    await h.time.advance(5_000);
    h.listReply(() => "hold");
    await h.time.advance(61_000);
    assert.equal(h.pending.length, 1);
    h.listReply(() => 200);
    h.source.signIn();
    h.refresh();
    await h.time.advance(5_000);
    assert.ok(h.loader.snapshot().value);
    h.complete(401);
    await flush();
    assert.equal(h.loader.snapshot().value, null);
    assert.equal(h.loader.snapshot().signIn, true);
    assert.equal(h.time.pending(), 1);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: an over-age successful auth probe keeps the sign-in pause without another probe", async () => {
  const h = harness();
  try {
    await boot(h);
    h.listReply(() => 403);
    h.refresh();
    await flush();
    h.listReply(() => "hold");
    await h.time.advance(61_000);
    await h.time.advance(61_001);
    h.complete(200);
    await flush();
    assert.equal(h.loader.snapshot().value, null);
    assert.equal(h.loader.snapshot().signIn, true);
    assert.equal(h.loader.snapshot().unconfirmed, undefined);
    assert.equal(h.source.freshUntil(), null);
    assert.equal(h.time.pending(), 0);
    const count = h.lists().length;
    await h.time.advance(122_000);
    assert.equal(h.lists().length, count);
    assertBudget(h);
  } finally { h.stop(); }
});

test("209: resubscribing a cached loader hides expired data before its new list can answer", async () => {
  const h = harness();
  const loader = createLoader(() => h.source.load(), (notify) => h.source.watch(notify));
  let stop = () => undefined;
  try {
    await boot(h);
    stop = h.watchLoader(loader);
    await h.time.advance(5_000);
    assert.ok(loader.snapshot().value);
    stop();
    h.stop();
    h.listReply(() => "hold");
    await h.time.advance(61_001);
    stop = h.watchLoader(loader);
    assert.equal(loader.snapshot().value, null);
    assert.equal(loader.snapshot().unconfirmed, true);
    await flush();
    assert.equal(h.pending.length, 1);
    assertBudget(h);
  } finally { stop(); h.stop(); }
});

test("209: property sequences preserve freshness, list spacing, rolling reserve and one scheduler", async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const local = new Map([["qd.settings", '{"appearance":"dark"}']]);
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)), removeItem: (key) => local.delete(key) }, configurable: true });
  try {
    for (let seed = 1; seed <= 100; seed += 1) {
      let random = seed;
      const next = (max) => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) % max; };
      const draft = { text: "Keep local draft " + seed, quote: null, files: [] };
      writeSession("chat.draft.alba", draft);
      const h = harness();
      const trace = [];
      const statuses = [200, 304, 401, 403, 503, "network", "hold"];
      let kept;
      const check = () => {
        const state = h.loader.snapshot();
        if (state.value) assert.ok(h.time.now() - h.confirmation() <= 61_000, "visible private data requires a recent actual server confirmation: " + JSON.stringify({ at: h.time.now() - NOW, confirmation: h.confirmation() - NOW, generation: h.generation(), pending: h.pending.map(({ sent, epoch }) => [sent - NOW, epoch]), traffic: h.traffic.slice(-10) }));
        assertBudget(h);
        if (kept) assert.deepEqual(local, kept);
        assert.equal(readSession("chat.draft.alba", null), h.generation() === 0 ? draft : null, "private drafts stay only until an observed authentication exit, never across recovery");
      };
      h.time.check(check);
      try {
        await boot(h);
        h.source.markSeen("alba-1");
        kept = new Map(local);
        for (let at = 0; at < 200; at += 1) {
          const action = next(10);
          trace.push([h.time.now() - NOW, action]);
          if (action === 0) h.streams.at(-1)?.open();
          else if (action === 1) h.streams.at(-1)?.fail(next(2) === 0 ? 0 : 2);
          else if (action === 2) h.streams.at(-1)?.emit("refresh", '{"cards":true}');
          else if (action === 3) h.refresh();
          else if (action === 4) h.listReply(() => statuses[next(statuses.length)]);
          else if (action === 5 && h.pending.length) h.complete(statuses[next(6)]);
          else if (action === 6) { h.source.signIn(); h.refresh(); }
          else if (action === 8) {
            for (let read = 0, count = 1 + next(8); read < count; read += 1) await h.card().catch(() => undefined);
          } else if (action === 9) {
            h.postReply(() => next(3) === 0 ? 503 : 200);
            void h.comment().catch(() => undefined);
          } else await h.time.advance(next(75_001));
          await flush();
          check();
        }
      } catch (error) {
        throw new Error("seed=" + seed + " trace=" + JSON.stringify(trace), { cause: error });
      } finally { h.stop(); }
    }
  } finally {
    Object.defineProperty(globalThis, "localStorage", before ?? { value: undefined, configurable: true });
  }
});

test("3591: a hidden tab sends no automatic list, card, Mail or stream request for five minutes, and hiding closes the stream once", async () => {
  const h = harness();
  try {
    await boot(h);
    await h.time.advance(1_000);
    h.hide();
    await h.time.advance(300_000);
    assert.deepEqual(h.hiddenSends().map(({ kind, at }) => [kind, at]), [], "automatic sends while hidden");
    assert.equal(h.streams[0].closed, 1, "hiding closes the stream once");
    assert.equal(h.streams.length, 1, "no new stream while hidden");
    assertBudget(h);
  } finally { h.stop(); }
});

for (const status of [200, 304]) {
  test("3591: on return one list read goes at once, answered " + status + ", then one stream, then the next list 45 seconds later", async () => {
    const h = harness();
    try {
      await boot(h);
      await h.time.advance(10_000);
      h.hide();
      await h.time.advance(30_000);
      const before = h.traffic.length;
      h.listReply(() => status);
      h.show();
      await flush();
      assert.deepEqual(h.traffic.slice(before).map(({ kind, at }) => [kind, at]), [["list", 40_000], ["stream", 40_000]], "the read on return, then the stream");
      h.streams.at(-1).open();
      await flush();
      await h.time.advance(45_000);
      assert.deepEqual(h.lists().slice(-2).map((item) => item.at), [40_000, 85_000], "the schedule resumes");
      assert.ok(h.loader.snapshot().value?.cards.length, "the data stays on screen");
      assertBudget(h);
    } finally { h.stop(); }
  });
}

test("3591: his own answer and Retry still send while the tab is hidden", async () => {
  const h = harness();
  try {
    await boot(h);
    h.hide();
    await h.time.advance(10_000);
    await h.answer();
    h.refresh();
    await flush();
    assert.deepEqual(h.traffic.filter((item) => item.hidden && item.explicit).map(({ kind, explicit }) => [kind, explicit]), [["list", true], ["post", true], ["list", true]], "the answer's token read and post, then Retry");
    assertBudget(h);
  } finally { h.stop(); }
});

test("3591: past the 61-second bound a hidden tab sends nothing and signs nothing out, its private data leaves quietly, and the read on return brings it back without Retry", async () => {
  const h = harness();
  try {
    await boot(h);
    await h.card();
    await flush();
    assert.equal(h.loader.snapshot().value.cards[0].options.length, 3);
    h.hide();
    await h.time.advance(60_999);
    assert.ok(h.loader.snapshot().value, "inside the bound the data stays");
    await h.time.advance(1);
    const away = h.loader.snapshot();
    assert.deepEqual([away.value, away.failed, away.signIn, away.unconfirmed, away.quiet], [null, false, undefined, true, true], "at the bound the data goes, quietly: shown as loading, not signed out and not the hidden state");
    await h.time.advance(240_000);
    assert.deepEqual(h.hiddenSends().map(({ kind, at }) => [kind, at]), [], "automatic sends while hidden");
    const still = h.loader.snapshot();
    assert.deepEqual([still.value, still.failed, still.signIn, still.quiet, h.failures.includes("SignInRequired")], [null, false, undefined, true, false], "still quiet while hidden: no sign-in and no hidden state");
    const before = h.lists().length;
    h.show();
    await flush();
    assert.equal(h.lists().length, before + 1, "one read on return");
    assert.equal("If-None-Match" in h.lists().at(-1).headers, false, "no ETag from before the data left");
    const back = h.loader.snapshot();
    assert.ok(back.value?.cards.length, "the data is back without Retry");
    assert.deepEqual([back.failed, back.unconfirmed, back.quiet, back.value.cards[0].options.length], [false, undefined, undefined, 0], "a fresh list only; the old card detail stays dropped");
    assertBudget(h);
  } finally { h.stop(); }
});

for (const status of [503, "network", 403]) {
  test("3591: when the read on return fails with " + status + " the screen shows " + (status === 403 ? "sign-in" : "the 209 hidden state, and Retry brings the data back"), async () => {
    const h = harness();
    try {
      await boot(h);
      h.hide();
      await h.time.advance(61_000);
      h.listReply(() => status);
      h.show();
      await flush();
      const state = h.loader.snapshot();
      if (status === 403) assert.deepEqual([state.value, state.signIn], [null, true], "signed out");
      else {
        assert.deepEqual([state.value, state.unconfirmed, state.quiet], [null, true, undefined], "the 209 hidden state, not the quiet one");
        h.listReply(() => 200);
        h.refresh();
        await flush();
        assert.ok(h.loader.snapshot().value?.cards.length, "Retry brings the data back");
      }
      assertBudget(h);
    } finally { h.stop(); }
  });
}

test("3591: the auth probe after a 403 waits while hidden and runs once on return when it is due", async () => {
  const h = harness();
  try {
    await boot(h);
    h.listReply(() => 403);
    h.refresh();
    await flush();
    assert.equal(h.loader.snapshot().signIn, true);
    h.hide();
    const before = h.lists().length;
    await h.time.advance(120_000);
    assert.equal(h.lists().length, before, "no probe while hidden");
    h.listReply(() => 200);
    h.show();
    await flush();
    assert.equal(h.lists().length, before + 1, "one probe at once on return");
    assert.ok(h.loader.snapshot().value?.cards.length, "its 200 resumes the session");
    assertBudget(h);
  } finally { h.stop(); }
});

test("3591: hiding and showing three times inside five seconds sends one list, five seconds after the last, and one new stream", async () => {
  const h = harness();
  try {
    await boot(h);
    for (let flip = 0; flip < 3; flip += 1) {
      await h.time.advance(1_000);
      h.hide();
      await h.time.advance(500);
      h.show();
      await flush();
    }
    await h.time.advance(5_000);
    assert.deepEqual(h.lists().map((item) => item.at), [0, 5_000], "one list on return, spaced");
    assert.equal(h.streams.length, 2, "one new stream");
    assertBudget(h);
  } finally { h.stop(); }
});

test("3591: property sequences with hide and show keep every 209 rule and send nothing automatic while hidden", async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const local = new Map([["qd.settings", '{"appearance":"dark"}']]);
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, String(value)), removeItem: (key) => local.delete(key) }, configurable: true });
  try {
    for (let seed = 1; seed <= 100; seed += 1) {
      let random = seed;
      const next = (max) => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) % max; };
      const h = harness();
      const trace = [];
      const statuses = [200, 304, 401, 403, 503, "network", "hold"];
      const check = () => {
        const state = h.loader.snapshot();
        if (state.value) assert.ok(h.time.now() - h.confirmation() <= 61_000, "visible private data requires a recent actual server confirmation");
        assert.deepEqual(h.hiddenSends().map(({ kind, at }) => [kind, at]), [], "no automatic send while hidden");
        assertBudget(h);
      };
      h.time.check(check);
      try {
        await boot(h);
        for (let at = 0; at < 200; at += 1) {
          const action = next(12);
          trace.push([h.time.now() - NOW, action]);
          if (action === 0) h.streams.at(-1)?.open();
          else if (action === 1) h.streams.at(-1)?.fail(next(2) === 0 ? 0 : 2);
          else if (action === 2) h.streams.at(-1)?.emit("refresh", '{"cards":true}');
          else if (action === 3) h.refresh();
          else if (action === 4) h.listReply(() => statuses[next(statuses.length)]);
          else if (action === 5 && h.pending.length) h.complete(statuses[next(6)]);
          else if (action === 6) { h.source.signIn(); h.refresh(); }
          else if (action === 8) {
            for (let read = 0, count = 1 + next(8); read < count; read += 1) await h.card().catch(() => undefined);
          } else if (action === 9) {
            h.postReply(() => next(3) === 0 ? 503 : 200);
            void h.comment().catch(() => undefined);
          } else if (action === 10) h.hide();
          else if (action === 11) h.show();
          else await h.time.advance(next(75_001));
          await flush();
          check();
        }
      } catch (error) {
        throw new Error("seed=" + seed + " trace=" + JSON.stringify(trace), { cause: error });
      } finally { h.stop(); }
    }
  } finally {
    Object.defineProperty(globalThis, "localStorage", before ?? { value: undefined, configurable: true });
  }
});
