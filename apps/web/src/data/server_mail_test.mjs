import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

const built = await esbuild.build({ stdin: { contents: ["api-client", "server-source", "loader", "source"].map((name) => 'export * from "./src/data/' + name + '";').join("\n"), resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
const { createApiClient, createServerSource, createLoader } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

const payload = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const recorded = (name) => JSON.parse(payload("mail/" + name));
const CARDS = JSON.parse(payload("list-added.json"));
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const ALL = '{"cards":true,"chats":true,"mail":true}';
const THREAD_FILES = { "MT-1": "thread-with-attachments-and-refs.json", "MT-2": "thread-html-only.json", "MT-3": "thread-sent-and-received.json", "MT-4": "thread-cut-long-body.json", "MT-5": "thread-omitted-older-mails.json" };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const etagOf = (body) => '"' + createHash("sha256").update(JSON.stringify(body)).digest("hex") + '"';
const respond = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

function fakeTime() {
  let now = NOW;
  const jobs = new Set();
  return {
    now: () => now,
    schedule(run, delay) {
      assert.ok(Number.isFinite(delay) && delay >= 0, "finite nonnegative timer delay");
      const job = { at: now + delay, run };
      jobs.add(job);
      return () => jobs.delete(job);
    },
    pending: () => jobs.size,
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
      }
      now = target;
      await flush();
    },
  };
}

function harness() {
  const time = fakeTime();
  const traffic = [];
  const streams = [];
  const failures = [];
  const intent = new AsyncLocalStorage();
  const state = { cards: 200, list: { body: structuredClone(recorded("list-5-threads.json").body), etag: recorded("list-5-threads.json").headers.ETag }, threads: new Map(), failList: null, failThreads: new Map() };
  let firstList = true;
  let hidden = false;
  const shownWatchers = new Set();
  const visibility = { hidden: () => hidden, watch: (run) => { shownWatchers.add(run); return () => shownWatchers.delete(run); } };
  const record = (kind, path, explicit, headers) => {
    const item = { kind, path, explicit, at: time.now() - NOW, headers };
    traffic.push(item);
    return item;
  };
  const failure = (name) => {
    const file = recorded(name);
    return respond(file.status, file.body);
  };
  const send = async (path, init) => {
    const explicit = intent.getStore() !== undefined;
    if (path === "/captain/cards") {
      record("cards", path, firstList || explicit, init.headers);
      firstList = false;
      if (state.cards !== 200) return respond(state.cards, { error: "request unavailable" });
      return respond(200, { ...structuredClone(CARDS), csrf: "sample-token-not-real", freshUntil: 2_000_000_000 }, { ETag: '"cards-list"' });
    }
    if (path === "/captain/mail") {
      record("mail-list", path, explicit, init.headers);
      if (state.failList) return failure(state.failList);
      if (init.headers["If-None-Match"] === state.list.etag) return new Response(null, { status: 304, headers: { ETag: state.list.etag } });
      return respond(200, state.list.body, { ETag: state.list.etag });
    }
    const ref = path.replace("/captain/mail/", "");
    assert.ok(path.startsWith("/captain/mail/"), "only known paths are sent: " + path);
    record("mail-thread", path, explicit, init.headers);
    if (state.failThreads.has(ref)) return failure(state.failThreads.get(ref));
    const body = state.threads.get(ref) ?? recorded(THREAD_FILES[ref]).body;
    return respond(200, body);
  };
  const openEvents = (url) => {
    record("stream", url, false, {});
    const handlers = new Map();
    const stream = {
      url,
      readyState: 0,
      closed: 0,
      addEventListener: (name, run) => handlers.set(name, run),
      close() { this.closed += 1; this.readyState = 2; },
      emit(name, data) { handlers.get(name)?.({ data }); },
      open() { this.readyState = 1; this.emit("open"); },
      fail(status = 2) { this.readyState = status; this.emit("error"); },
    };
    streams.push(stream);
    return stream;
  };
  const client = createApiClient({ send, openEvents });
  const source = createServerSource(client, time.now, time.schedule, undefined, visibility);
  const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
  const stop = loader.subscribe(() => {});
  const stopFailures = source.watch((error) => { if (error) failures.push(error.name); });
  const of = (kind) => traffic.filter((item) => item.kind === kind);
  return {
    time, traffic, streams, failures, client, source, loader, state, of,
    explicit: (run) => intent.run("his action", run),
    async emit(data, count = 1) {
      for (let each = 0; each < count; each += 1) streams.at(-1).emit("refresh", data);
      await flush();
    },
    world: () => loader.snapshot().value,
    thread: (ref) => loader.snapshot().value?.mail.find((item) => item.ref === ref),
    setList(change) {
      const body = structuredClone(state.list.body);
      change(body);
      state.list = { body, etag: etagOf(body) };
    },
    setThread(ref, change) {
      const body = structuredClone(state.threads.get(ref) ?? recorded(THREAD_FILES[ref]).body);
      change(body);
      state.threads.set(ref, body);
    },
    async boot() {
      await flush();
      assert.ok(loader.snapshot().value?.cards.length, "the cards list is shown");
      streams.at(-1)?.open();
      await flush();
    },
    hide() { hidden = true; for (const run of [...shownWatchers]) run(); },
    show() { hidden = false; for (const run of [...shownWatchers]) run(); },
    stop() { stop(); stopFailures(); },
  };
}

const times = (items) => items.map((item) => item.at);

function assertBudget(h) {
  h.traffic.forEach((item, at) => {
    const spent = h.traffic.slice(0, at + 1).filter((prior) => prior.at > item.at - 60_000).length;
    assert.ok(spent <= 29, "rolling total of own requests is at most 29");
    if (!item.explicit) assert.ok(spent <= 21, "automatic work leaves eight credits for his actions");
    if (!item.explicit && ["cards", "mail-list", "mail-thread"].includes(item.kind)) {
      const before = h.traffic.slice(0, at).filter((prior) => ["cards", "mail-list", "mail-thread"].includes(prior.kind)).map((prior) => prior.at);
      if (before.length) assert.ok(item.at - Math.max(...before) >= 5_000, "an automatic read is at least five seconds after the previous read");
    }
  });
}

test("opening Mail reads the list at once, and the world holds the five threads in the server's order, placed through the cards list", async () => {
  const h = harness();
  try {
    await h.boot();
    h.setList((body) => { body.threads[1].project = "quarterdeck"; body.threads[1].lane = "Search"; });
    await h.explicit(() => h.source.openMailList());
    await flush();
    assert.deepEqual(times(h.of("mail-list")), [0]);
    assert.equal(h.time.now(), NOW);
    assert.deepEqual(h.world().mail.map((item) => item.ref), ["MT-5", "MT-4", "MT-3", "MT-2", "MT-1"]);
    const placed = h.thread("MT-4");
    assert.deepEqual([placed.projectId, placed.laneId], ["quarterdeck", "quarterdeck/Search"]);
    assert.deepEqual(h.of("cards").length, 1);
    assertBudget(h);
  } finally { h.stop(); }
});

test("a second open sends the held ETag and a 304 keeps the threads, with no timer advanced", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.explicit(() => h.source.openMailList());
    await flush();
    assert.equal("If-None-Match" in h.of("mail-list")[0].headers, false);
    assert.equal(h.of("mail-list")[1].headers["If-None-Match"], h.state.list.etag);
    assert.equal(h.world().mail.length, 5);
    assert.deepEqual(times(h.of("mail-list")), [0, 0]);
  } finally { h.stop(); }
});

test("two opens of the list in flight share one request, and so do two opens of one thread", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => Promise.all([h.source.openMailList(), h.source.openMailList()]));
    assert.equal(h.of("mail-list").length, 1);
    await h.explicit(() => Promise.all([h.source.openMailThread("MT-1"), h.source.openMailThread("MT-1")]));
    assert.equal(h.of("mail-thread").length, 1);
  } finally { h.stop(); }
});

test("opening a thread reads it at once: the mails, the left-out count of MT-5 and its first mail MT-5.11, and attachments kept out", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.explicit(() => h.source.openMailThread("MT-5"));
    await h.explicit(() => h.source.openMailThread("MT-1"));
    await flush();
    assert.deepEqual(h.of("mail-thread").map((item) => item.path), ["/captain/mail/MT-5", "/captain/mail/MT-1"]);
    assert.equal(h.time.now(), NOW);
    const long = h.thread("MT-5");
    assert.deepEqual([long.mails.length, long.omitted, long.summary.count, long.mails[0].ref], [50, 10, 60, "MT-5.11"]);
    const small = h.thread("MT-1");
    assert.deepEqual([small.mails.length, small.omitted], [4, 0]);
    assert.equal("attachments" in small.mails[1], false);
    assert.equal("omitted" in h.thread("MT-3"), false);
  } finally { h.stop(); }
});

test("opening a thread before the list was read reads the list first, then the thread, both at once", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailThread("MT-3"));
    assert.deepEqual(h.traffic.filter((item) => item.kind.startsWith("mail")).map((item) => [item.kind, item.at]), [["mail-list", 0], ["mail-thread", 0]]);
    assert.equal(h.thread("MT-3").mails.length, 3);
  } finally { h.stop(); }
});

test("a ref the list does not hold is NotFound with no request, and a thread the server says 404 for is NotFound too", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    for (const ref of ["MT-99", "not a ref", "MT-1/../x", ""]) await assert.rejects(h.explicit(() => h.source.openMailThread(ref)), { name: "NotFound" }, ref);
    assert.equal(h.of("mail-thread").length, 0);
    h.state.failThreads.set("MT-2", "error-404-no-thread.json");
    await assert.rejects(h.explicit(() => h.source.openMailThread("MT-2")), { name: "NotFound" });
    assert.equal(h.of("mail-thread").length, 1);
  } finally { h.stop(); }
});

test("a list refetch keeps the read mails and the left-out count and renews only the summary", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.explicit(() => h.source.openMailThread("MT-5"));
    h.setList((body) => { const one = body.threads.find((item) => item.ref === "MT-5"); one.count = 61; one.lastAt = "2026-11-05T09:00:00-05:00"; });
    await h.explicit(() => h.source.openMailList());
    await flush();
    const long = h.thread("MT-5");
    assert.deepEqual([long.summary.count, long.summary.lastAt, long.omitted, long.mails.length, long.mails[0].ref], [61, "2026-11-05T09:00:00-05:00", 10, 50, "MT-5.11"]);
  } finally { h.stop(); }
});

test("an event with mail true reads the Mail list only while Mail is on screen, five seconds after the previous read, after the cards list", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(2_000);
    await h.emit(ALL);
    await h.time.advance(2_999);
    assert.deepEqual(times(h.of("cards")), [0]);
    assert.deepEqual(times(h.of("mail-list")), [0]);
    await h.time.advance(1);
    assert.deepEqual(times(h.of("cards")), [0, 5_000]);
    await h.time.advance(4_999);
    assert.deepEqual(times(h.of("mail-list")), [0]);
    await h.time.advance(1);
    assert.deepEqual(times(h.of("mail-list")), [0, 10_000]);
    assertBudget(h);
  } finally { h.stop(); }
});

test("two events in a row make one Mail read", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(1_000);
    await h.emit(ALL, 2);
    await h.time.advance(20_000);
    assert.deepEqual(times(h.of("mail-list")), [0, 10_000]);
    assertBudget(h);
  } finally { h.stop(); }
});

test("a cards-only event reads no Mail, and neither does an event with mail false or no mail key", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(1_000);
    for (const data of ['{"cards":true,"chats":true,"mail":false}', '{"cards":true,"chats":true}']) {
      await h.emit(data);
      await h.time.advance(20_000);
    }
    assert.deepEqual(times(h.of("mail-list")), [0]);
    assert.ok(h.of("cards").length >= 3);
  } finally { h.stop(); }
});

test("an event reads no Mail once the list and every thread were closed", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.explicit(() => h.source.openMailThread("MT-1"));
    h.source.closeMailThread("MT-1");
    h.source.closeMailList();
    h.source.closeMailThread("MT-77");
    await h.time.advance(1_000);
    await h.emit(ALL);
    await h.time.advance(30_000);
    assert.deepEqual(times(h.of("mail-list")), [0]);
    assert.equal(h.of("mail-thread").length, 1);
    assert.ok(h.of("cards").length >= 2);
  } finally { h.stop(); }
});

test("a thread on screen is enough for an event to read the list, and the thread follows when the list says it changed", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.explicit(() => h.source.openMailThread("MT-1"));
    h.source.closeMailList();
    h.setList((body) => { const one = body.threads.find((item) => item.ref === "MT-1"); one.count = 5; one.lastAt = "2026-11-05T09:00:00-05:00"; });
    h.setThread("MT-1", (body) => {
      const last = body.thread.mails.at(-1);
      body.thread.mails.push({ ...structuredClone(last), ref: "MT-1.5", text: "A fifth mail." });
      body.thread.count = 5;
      body.thread.lastAt = "2026-11-05T09:00:00-05:00";
    });
    await h.time.advance(1_000);
    await h.emit(ALL);
    await h.time.advance(30_000);
    assert.deepEqual(times(h.of("mail-list")), [0, 10_000]);
    assert.deepEqual(times(h.of("mail-thread")), [0, 15_000]);
    const open = h.thread("MT-1");
    assert.deepEqual([open.mails.length, open.summary.count, open.omitted], [5, 5, 0]);
    await h.emit(ALL);
    await h.time.advance(60_000);
    assert.equal(h.of("mail-thread").length, 2);
    assertBudget(h);
  } finally { h.stop(); }
});

test("a changed thread that is not on screen is not read again, and a thread that stays different is read once, not in a loop", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.explicit(() => h.source.openMailThread("MT-1"));
    await h.explicit(() => h.source.openMailThread("MT-2"));
    h.source.closeMailThread("MT-2");
    h.setList((body) => { for (const one of body.threads.filter((item) => item.ref === "MT-1" || item.ref === "MT-2")) one.count += 1; });
    await h.time.advance(1_000);
    await h.emit(ALL);
    await h.time.advance(30_000);
    await h.emit(ALL);
    await h.time.advance(60_000);
    h.setList((body) => { body.threads.find((item) => item.ref === "MT-1").count += 1; });
    await h.emit(ALL);
    await h.time.advance(60_000);
    const paths = h.of("mail-thread").map((item) => item.path);
    assert.equal(paths.filter((path) => path.endsWith("MT-2")).length, 1);
    assert.equal(paths.filter((path) => path.endsWith("MT-1")).length, 3);
    assertBudget(h);
  } finally { h.stop(); }
});

test("an interactive Mail list read in between satisfies the waiting event refresh", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(1_000);
    await h.emit(ALL);
    await h.time.advance(2_000);
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(30_000);
    assert.deepEqual(times(h.of("mail-list")), [0, 3_000]);
  } finally { h.stop(); }
});

test("after the first cards list one automatic Mail list read is made, five seconds later, once per session, even with Mail never opened", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.time.advance(4_999);
    assert.equal(h.of("mail-list").length, 0);
    await h.time.advance(1);
    assert.deepEqual(times(h.of("mail-list")), [5_000]);
    assert.equal(h.of("mail-list")[0].explicit, false);
    await h.time.advance(120_000);
    assert.equal(h.of("mail-list").length, 1);
    await h.explicit(() => h.source.openMailList());
    assert.equal(h.world().mail.length, 5);
    assertBudget(h);
  } finally { h.stop(); }
});

test("an open of Mail before that read satisfies it, so no automatic Mail list read follows", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(30_000);
    assert.equal(h.of("mail-list").length, 1);
  } finally { h.stop(); }
});

test("a 401 or 403 on a Mail list or thread read ends the session, drops the Mail data, and the next open after sign-in sends no held ETag", async () => {
  for (const [file, where] of [["error-401-sign-in-required.json", "list"], ["error-403-session-refused.json", "list"], ["error-401-sign-in-required.json", "thread"], ["error-403-session-refused.json", "thread"]]) {
    const h = harness();
    try {
      await h.boot();
      await h.explicit(() => h.source.openMailList());
      await h.explicit(() => h.source.openMailThread("MT-1"));
      if (where === "list") h.state.failList = file;
      else h.state.failThreads.set("MT-2", file);
      await assert.rejects(h.explicit(() => (where === "list" ? h.source.openMailList() : h.source.openMailThread("MT-2"))), { name: "SignInRequired" }, file + where);
      await flush();
      assert.equal(h.loader.snapshot().signIn, true);
      assert.equal(h.loader.snapshot().value, null);
      assert.deepEqual(h.failures, ["SignInRequired"]);
      const reads = h.traffic.length;
      await assert.rejects(h.source.openMailList(), { name: "SignInRequired" });
      await assert.rejects(h.source.openMailThread("MT-1"), { name: "SignInRequired" });
      assert.equal(h.traffic.length, reads);
      h.state.failList = null;
      h.state.failThreads.clear();
      h.source.signIn();
      h.loader.refresh();
      await flush();
      await h.explicit(() => h.source.openMailList());
      assert.equal("If-None-Match" in h.of("mail-list").at(-1).headers, false);
      assert.equal(h.thread("MT-1").mails.length, 0);
    } finally { h.stop(); }
  }
});

test("a Mail 200 confirms the session at its send time, so the data stays 61 seconds after it and is hidden after that", async () => {
  const h = harness();
  try {
    await h.boot();
    h.state.cards = 503;
    await h.time.advance(40_000);
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(30_000);
    assert.ok(h.world(), "still shown at 70 seconds, 30 after the Mail read");
    assert.equal(h.failures.includes("SessionUnconfirmed"), false);
    await h.time.advance(31_001);
    assert.ok(h.failures.includes("SessionUnconfirmed"), "hidden once 61 seconds pass with no confirmation");
    assert.equal(h.world(), null);
    await assert.rejects(h.explicit(() => h.source.openMailList()), { name: "SessionUnconfirmed" });
    await assert.rejects(h.explicit(() => h.source.openMailThread("MT-1")), { name: "SessionUnconfirmed" });
  } finally { h.stop(); }
});

test("a failed Mail list rejects its own open and leaves the Queue's data and the watchers alone", async () => {
  const h = harness();
  try {
    await h.boot();
    h.state.failList = "error-503-request-unavailable.json";
    await assert.rejects(h.explicit(() => h.source.openMailList()), { name: "Unavailable" });
    await flush();
    assert.ok(h.world().cards.length > 0);
    assert.deepEqual(h.failures, []);
    h.state.failList = "error-400-bad-ref.json";
    await assert.rejects(h.explicit(() => h.source.openMailList()), { name: "Refused" });
    h.state.failList = null;
    await h.explicit(() => h.source.openMailList());
    assert.equal(h.world().mail.length, 5);
  } finally { h.stop(); }
});

test("a failed automatic Mail read is dropped without a message, and the next event reads again", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    h.state.failList = "error-503-request-unavailable.json";
    await h.time.advance(1_000);
    await h.emit(ALL);
    await h.time.advance(30_000);
    assert.equal(h.of("mail-list").length, 2);
    assert.equal(h.failures.includes("Unavailable"), false);
    assert.equal(h.world().mail.length, 5);
    h.state.failList = null;
    await h.emit(ALL);
    await h.time.advance(30_000);
    assert.equal(h.of("mail-list").length, 3);
  } finally { h.stop(); }
});

test("his Mail actions stop at the 29th credit of the minute with RateLimited, and a flood of events never takes automatic work above 21", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    let refused = null;
    for (let round = 0; round < 40 && !refused; round += 1) {
      try { await h.explicit(() => h.source.openMailThread("MT-1")); } catch (error) { refused = error; }
    }
    assert.equal(refused?.name, "RateLimited");
    assert.equal(h.traffic.length, 29);
    assertBudget(h);
    await h.time.advance(61_000);
    for (let round = 0; round < 60; round += 1) {
      await h.emit(ALL);
      await h.time.advance(3_000);
    }
    assertBudget(h);
  } finally { h.stop(); }
});

test("the Mail members are there on a server source, and closing what was never opened does nothing", async () => {
  const h = harness();
  try {
    for (const name of ["openMailList", "closeMailList", "openMailThread", "closeMailThread"]) assert.equal(typeof h.source[name], "function", name);
    h.source.closeMailList();
    h.source.closeMailThread("MT-1");
    assert.equal(h.traffic.filter((item) => item.kind.startsWith("mail")).length, 0);
  } finally { h.stop(); }
});

test("3591: with Mail on screen a hidden tab sends no Mail read, and on return the Mail list is read five seconds after the cards list", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.explicit(() => h.source.openMailList());
    await h.time.advance(10_000);
    const from = h.traffic.length;
    h.hide();
    await h.time.advance(30_000);
    assert.deepEqual(h.traffic.slice(from), [], "nothing sent while hidden");
    h.show();
    await flush();
    await h.time.advance(10_000);
    assert.deepEqual(h.traffic.slice(from).map(({ kind, at }) => [kind, at]), [["cards", 40_000], ["stream", 40_000], ["mail-list", 45_000]]);
    assertBudget(h);
  } finally { h.stop(); }
});

test("3591: a Mail read an event asked for waits while the tab is hidden and goes once on return, five seconds after the cards list", async () => {
  const h = harness();
  try {
    await h.boot();
    await h.time.advance(8_000);
    await h.explicit(() => h.source.openMailList());
    await h.emit('{"cards":false,"chats":false,"mail":true}');
    await h.time.advance(2_000);
    const from = h.traffic.length;
    h.hide();
    await h.time.advance(30_000);
    assert.deepEqual(h.traffic.slice(from), [], "the waiting Mail read is not sent while hidden");
    h.show();
    await flush();
    await h.time.advance(10_000);
    assert.deepEqual(h.traffic.slice(from).map(({ kind, at }) => [kind, at]), [["cards", 40_000], ["stream", 40_000], ["mail-list", 45_000]]);
    assertBudget(h);
  } finally { h.stop(); }
});
