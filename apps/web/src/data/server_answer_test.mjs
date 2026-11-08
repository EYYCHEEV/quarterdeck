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
const ADDED = text("list-added.json");
const OPEN = text("card-open.json");
const CURRENT = text("answer/answer-200-current.json");
const STALE = text("answer/answer-200-stale.json");
const COMMENT = text("answer/comment-200.json");
const REFUSED = text("answer/request-refused.json");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const ETAG = '"5f0c6d3a9b1e47d28c4a0e7b3f6d91a2c8e5b04d7a3f16c9e2b8d5a07c4f1e36"';
const FIRST_TOKEN = "sample-csrf-token-not-real";
const FRESH_TOKEN = "sample-csrf-fresh-1";

const json = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/json" } });
const list = () => new Response(ADDED, { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const fresh = (token = FRESH_TOKEN) => new Response(ADDED.replace(FIRST_TOKEN, token), { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const notModified = () => new Response(null, { status: 304, headers: { ETag: ETAG } });
const memory = () => {
  const held = new Map();
  return { held, getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, String(value)), removeItem: (key) => void held.set(key, null) };
};

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
        const job = [...jobs].filter((job) => job.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!job) break;
        now = job.at;
        jobs.delete(job);
        job.run();
        await tick();
      }
      now = target;
      await tick();
    },
    pending: () => jobs.size,
  };
}

function serve(routes) {
  const calls = [];
  const time = fakeClock();
  const queues = new Map(Object.entries(routes).map(([key, steps]) => [key, Array.isArray(steps) ? [...steps] : steps]));
  const send = async (path, init) => {
    calls.push({ path, init });
    const queued = queues.get(init.method + " " + path);
    const step = typeof queued === "function" ? queued : queued?.shift();
    const value = typeof step === "function" ? step() : step;
    if (value instanceof Error) throw value;
    return value ?? json(JSON.stringify({ error: "not found" }), 404);
  };
  const source = createServerSource(createApiClient({ send, openEvents: () => ({ addEventListener: () => undefined, close: () => undefined }) }), time.now, time.schedule);
  return { source, calls, time, posts: () => calls.filter((call) => call.init.method === "POST") };
}

const ANSWER = "POST /captain/cards/alba-1/answer";
const LIST = "GET /captain/cards";
const option = (letter) => ({ kind: "option", letter });

test("the app's answer goes out as rev, pick and note, and comes back as an Answer with the receipt's rev and no stale flag set", async () => {
  const { source, posts } = serve({ [LIST]: [list(), fresh()], [ANSWER]: [json(CURRENT)] });
  await source.load();
  const answer = await source.answer("alba-1", { choice: option("A"), note: "Yes.", version: 3 });
  assert.equal(posts().length, 1);
  assert.deepEqual(JSON.parse(posts()[0].init.body), { rev: 3, pick: "A", note: "Yes.", csrf: FRESH_TOKEN });
  assert.deepEqual(answer, { choice: option("A"), at: new Date(NOW).toISOString(), note: "Yes.", version: 3, waitingOn: null, outcome: null, stale: false });
});

test("an answer to an older revision carries the receipt's stale flag and rev", async () => {
  const { source } = serve({ [LIST]: [list(), fresh()], [ANSWER]: [json(STALE)] });
  await source.load();
  const answer = await source.answer("alba-1", { choice: option("B"), note: "", version: 2 });
  assert.deepEqual([answer.stale, answer.version], [true, 2]);
});

test("none and cant-decide go out as those words", async () => {
  const { source, posts } = serve({ [LIST]: [list(), fresh(), fresh()], [ANSWER]: [json(CURRENT), json(CURRENT)] });
  await source.load();
  await source.answer("alba-1", { choice: { kind: "none" }, note: "", version: 3 });
  await source.answer("alba-1", { choice: { kind: "cant-decide" }, note: "later", version: 3 });
  assert.deepEqual(posts().map((call) => JSON.parse(call.init.body).pick), ["none", "cant-decide"]);
});

test("approve and reject have no pick in the route: they are refused at once, nothing is sent for them, and a valid answer after them still goes out", async () => {
  const { source, posts, calls } = serve({ [LIST]: [list(), fresh()], [ANSWER]: [json(CURRENT)] });
  await source.load();
  for (const kind of ["approve", "reject"]) await assert.rejects(source.answer("alba-1", { choice: { kind }, note: "", version: 3 }), { name: "Refused" });
  assert.equal(posts().length, 0);
  assert.equal(calls.length, 1);
  await source.answer("alba-1", { choice: option("A"), note: "", version: 3 });
  assert.equal(posts().length, 1);
});

test("a card that is not in the last list is not found, and nothing is sent", async () => {
  const { source, calls } = serve({ [LIST]: [list()] });
  await assert.rejects(source.answer("alba-1", { choice: option("A"), note: "", version: 3 }), { name: "NotFound" });
  await source.load();
  await assert.rejects(source.answer("nobody", { choice: option("A"), note: "", version: 3 }), { name: "NotFound" });
  await assert.rejects(source.answer("shelvorn-6", { choice: option("A"), note: "", version: 1 }), { name: "NotFound" });
  assert.deepEqual(calls.map((call) => call.init.method), ["GET"]);
});

test("when the card was opened, a letter that is not among that revision's options is refused, and an older revision is left to the server", async () => {
  const { source, posts } = serve({ [LIST]: [list(), fresh(), fresh()], "GET /captain/cards/alba-1": [json(OPEN)], [ANSWER]: [json(CURRENT), json(STALE)] });
  await source.load();
  await source.openCard("alba-1");
  await assert.rejects(source.answer("alba-1", { choice: option("D"), note: "", version: 3 }), { name: "Refused" });
  assert.equal(posts().length, 0);
  await source.answer("alba-1", { choice: option("C"), note: "", version: 3 });
  await source.answer("alba-1", { choice: option("D"), note: "", version: 2 });
  assert.deepEqual(posts().map((call) => JSON.parse(call.init.body).pick), ["C", "D"]);
});

test("a bad note or a bad rev is refused at once, nothing is sent for it, and the next valid answer reads a fresh token and posts that one, not the held one", async () => {
  const { source, posts, calls } = serve({ [LIST]: [list(), fresh()], [ANSWER]: [json(CURRENT)] });
  await source.load();
  await assert.rejects(source.answer("alba-1", { choice: option("A"), note: "x".repeat(4001), version: 3 }), { name: "Refused" });
  await assert.rejects(source.answer("alba-1", { choice: option("A"), note: "", version: 1.5 }), { name: "Refused" });
  assert.equal(posts().length, 0);
  assert.equal(calls.length, 1);
  await source.answer("alba-1", { choice: option("A"), note: "", version: 3 });
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST"]);
  assert.equal(JSON.parse(posts()[0].init.body).csrf, FRESH_TOKEN);
});

test("after an answer the next load is a 304 on the same list, and the card stays answered with the receipt's Answer while the other cards are as before", async () => {
  const { source, calls, time } = serve({ [LIST]: [list(), fresh(), notModified()], [ANSWER]: [json(CURRENT)] });
  const before = await source.load();
  const given = await source.answer("alba-1", { choice: option("A"), note: "", version: 3 });
  const loading = source.load();
  await time.advance(5_000);
  const after = await loading;
  assert.deepEqual(calls.map((call) => call.init.method + " " + call.path), [LIST, LIST, ANSWER, LIST]);
  assert.equal(calls[3].init.headers["If-None-Match"], ETAG);
  assert.deepEqual(after.cards.filter((card) => card.id !== "alba-1").map((card) => [card.id, card.answer]), before.cards.filter((card) => card.id !== "alba-1").map((card) => [card.id, card.answer]));
  assert.deepEqual(after.cards.find((card) => card.id === "alba-1").answer, given);
});

for (const [label, step, name] of [
  ["a 303", () => new Response(null, { status: 303, headers: { Location: "/captain/step-up?next=/captain/chat" } }), "FreshSignInRequired"],
  ["a 429", () => json("", 429), "RateLimited"],
  ["a 503", () => json("", 503), "NotConfirmed"],
  ["a network failure", () => new TypeError("Failed to fetch"), "NotConfirmed"],
  ["a 400", () => json(REFUSED, 400), "Refused"],
  ["a receipt that cannot be read", () => json("Got it"), "NotConfirmed"],
]) {
  test("an answer that meets " + label + " reaches the app as " + name + " after exactly one POST", async () => {
    const { source, posts } = serve({ [LIST]: [list(), fresh()], [ANSWER]: [step] });
    await source.load();
    await assert.rejects(source.answer("alba-1", { choice: option("A"), note: "", version: 3 }), { name });
    assert.equal(posts().length, 1);
  });
}


test("freshUntil is null before any read and follows the newest 200 after", async () => {
  const { source } = serve({ [LIST]: [list(), fresh()], [ANSWER]: [json(CURRENT)] });
  assert.equal(source.freshUntil(), null);
  await source.load();
  assert.equal(source.freshUntil(), 1793836800.25);
  await source.answer("alba-1", { choice: option("A"), note: "", version: 3 });
  assert.equal(source.freshUntil(), 1793836800.5);
});

const COMMENTS = "POST /captain/cards/alba-1/comments";

test("a comment goes out as text and requestId, and resolves with nothing", async () => {
  const { source, posts } = serve({ [LIST]: [list(), fresh()], [COMMENTS]: [json(COMMENT)] });
  await source.load();
  const result = await source.comment("alba-1", { text: "Five fits the phone.", requestId: "req-1" });
  assert.equal(result, undefined);
  assert.deepEqual(JSON.parse(posts()[0].init.body), { text: "Five fits the phone.", requestId: "req-1", csrf: FRESH_TOKEN });
});
for (const kind of ["answer", "comment"]) {
  for (const status of [401, 403]) {
    for (const recovered of [false, true]) {
      test("229: a held " + kind + " 200 after another channel's " + status + " rejects" + (recovered ? " even after fresh recovery" : " while signed out"), async () => {
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        let started;
        const sent = new Promise((resolve) => { started = resolve; });
        let expired = false;
        const { source } = serve({ [LIST]: () => expired ? json(REFUSED, status) : list(), [kind === "answer" ? ANSWER : COMMENTS]: [() => { started(); return held; }] });
        await source.load();
        const sending = (kind === "answer"
          ? source.answer("alba-1", { choice: option("A"), note: "Old private answer", version: 3 })
          : source.comment("alba-1", { text: "Old private comment", requestId: "old-request" })
        ).then((value) => ({ value }), (error) => ({ error }));
        await sent;
        expired = true;
        await assert.rejects(source.load(), { name: "SignInRequired" });
        expired = false;
        if (recovered) {
          source.signIn();
          await source.load();
        }
        release(json(kind === "answer" ? CURRENT : COMMENT));
        const outcome = await sending;
        assert.equal(outcome.error?.name, "SignInRequired", "a reply from an ended generation cannot report success");
      });
    }
  }
}

for (const status of [401, 403]) {
  test("229: an old ambiguous POST after " + status + " cannot start answer read-back in a recovered session", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let started;
    const sent = new Promise((resolve) => { started = resolve; });
    let expired = false;
    const { source, calls } = serve({ [LIST]: () => expired ? json(REFUSED, status) : list(), [ANSWER]: [() => { started(); return held; }], "GET /captain/cards/alba-1": [json(OPEN)] });
    await source.load();
    const sending = source.answer("alba-1", { choice: option("A"), note: "", version: 3 }).then((value) => ({ value }), (error) => ({ error }));
    await sent;
    expired = true;
    await assert.rejects(source.load(), { name: "SignInRequired" });
    expired = false;
    source.signIn();
    await source.load();
    release(json("", 503));
    const outcome = await sending;
    assert.equal(outcome.error?.name, "SignInRequired");
    assert.equal(calls.filter((call) => call.path === "/captain/cards/alba-1").length, 0, "the ended operation starts no read-back in the new session");
  });

  test("229: answer read-back returning after " + status + " rejects the old generation even after recovery", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let started;
    const reading = new Promise((resolve) => { started = resolve; });
    let expired = false;
    const { source } = serve({
      [LIST]: () => expired ? json(REFUSED, status) : list(),
      [ANSWER]: [json("", 503)],
      "GET /captain/cards/alba-1": [() => { started(); return held; }],
    });
    await source.load();
    const sending = source.answer("alba-1", { choice: option("A"), note: "", version: 3 }).then((value) => ({ value }), (error) => ({ error }));
    await reading;
    expired = true;
    await assert.rejects(source.load(), { name: "SignInRequired" });
    expired = false;
    source.signIn();
    await source.load();
    release(json("", 503));
    const outcome = await sending;
    assert.equal(outcome.error?.name, "SignInRequired", "the reconciliation await cannot fall back to the old NotConfirmed error");
  });
}


test("a comment on a card that is not in the last list is not found, a bad one is refused, and nothing is sent", async () => {
  const { source, posts } = serve({ [LIST]: [list()], [COMMENTS]: [json(COMMENT)] });
  await assert.rejects(source.comment("alba-1", { text: "hi", requestId: "r" }), { name: "NotFound" });
  await source.load();
  await assert.rejects(source.comment("nobody", { text: "hi", requestId: "r" }), { name: "NotFound" });
  await assert.rejects(source.comment("alba-1", { text: "", requestId: "r" }), { name: "Refused" });
  await assert.rejects(source.comment("alba-1", { text: "hi", requestId: "bad id" }), { name: "Refused" });
  assert.equal(posts().length, 0);
});

test("a comment that meets a 503 is not confirmed, after exactly one POST", async () => {
  const { source, posts } = serve({ [LIST]: [list(), fresh()], [COMMENTS]: [json("", 503)] });
  await source.load();
  await assert.rejects(source.comment("alba-1", { text: "hi", requestId: "r" }), { name: "NotConfirmed" });
  assert.equal(posts().length, 1);
});

const answerIt = (source) => source.answer("alba-1", { choice: option("A"), note: "Keep this note", version: 3 });
const commentIt = (source) => source.comment("alba-1", { text: "Keep this comment", requestId: "req-1" });
const SENDS = [["an answer", ANSWER, answerIt], ["a comment", COMMENTS, commentIt]];
const methods = (calls) => calls.map((call) => call.init.method);

for (const [label, route, send] of SENDS) {
  for (const status of [401, 403]) {
    test(label + " that meets a " + status + " ends the session at once: the watchers are told once, nothing else is sent, and the next load waits for the check or an explicit sign-in", async () => {
      const { source, calls, time } = serve({ [LIST]: [list(), fresh(), list()], [route]: [json(REFUSED, status)] });
      const heard = [];
      source.watch((failure) => heard.push(failure?.name));
      await source.load();
      await assert.rejects(send(source), { name: "SignInRequired" });
      assert.deepEqual(heard, [undefined, undefined, "SignInRequired"]);
      assert.equal(source.freshUntil(), null);
      assert.deepEqual(methods(calls), ["GET", "GET", "POST"]);
      assert.equal(time.pending(), 1);
      await assert.rejects(source.load(), { name: "SignInRequired" });
      assert.equal(calls.length, 3);
      source.signIn();
      assert.equal(time.pending(), 0);
      const loading = source.load();
      await time.advance(5_000);
      await loading;
      assert.equal("If-None-Match" in calls.at(-1).init.headers, false);
    });
  }
}

for (const status of [401, 403]) {
  test("while the session is ended after a " + status + ", an answer and a comment send nothing and say SignInRequired; the check sends nothing of theirs; he sends the answer once himself afterwards", async () => {
    const { source, calls, time, posts } = serve({ [LIST]: [list(), fresh(), list(), fresh()], [ANSWER]: [json(REFUSED, status), json(CURRENT)], [COMMENTS]: [json(COMMENT)] });
    const heard = [];
    source.watch((failure) => heard.push(failure?.name));
    await source.load();
    await assert.rejects(answerIt(source), { name: "SignInRequired" });
    for (const send of [answerIt, commentIt]) await assert.rejects(send(source), { name: "SignInRequired" });
    assert.equal(calls.length, 3);
    assert.deepEqual(heard, [undefined, undefined, "SignInRequired"]);
    await time.advance(61_000);
    assert.deepEqual(methods(calls), ["GET", "GET", "POST", "GET"]);
    assert.equal(posts().length, 1);
    await answerIt(source);
    assert.deepEqual(methods(calls), ["GET", "GET", "POST", "GET", "GET", "POST"]);
    assert.equal(posts().length, 2);
  });
}

test("a 303 on an answer or a comment is a step-up: the watchers report no failure, nothing is paused and no auth probe is added", async () => {
  const step = () => new Response(null, { status: 303, headers: { Location: "/captain/step-up?next=/captain/chat" } });
  for (const [, route, send] of SENDS) {
    const { source, calls, time } = serve({ [LIST]: [list(), fresh(), list()], [route]: [step] });
    const heard = [];
    source.watch((failure) => heard.push(failure?.name));
    await source.load();
    const pending = time.pending();
    await assert.rejects(send(source), { name: "FreshSignInRequired" });
    assert.deepEqual(heard, [undefined, undefined]);
    assert.equal(time.pending(), pending);
    const loading = source.load();
    await time.advance(5_000);
    await loading;
    assert.equal(calls.length, 4);
  }
});

test("answering and commenting write nothing to storage, so the token and the sign-in freshness stay in memory", async () => {
  const store = memory();
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
  try {
    const { source } = serve({ [LIST]: [list(), fresh(), fresh()], [ANSWER]: [json(CURRENT)], [COMMENTS]: [json(COMMENT)] });
    await source.load();
    await source.answer("alba-1", { choice: option("A"), note: "", version: 3 });
    await source.comment("alba-1", { text: "hi", requestId: "r" });
    assert.equal(store.held.size, 0);
  } finally {
    Object.defineProperty(globalThis, "localStorage", before ?? { value: undefined, configurable: true, writable: true });
  }
});

async function appCode(source) {
  const built = await esbuild.build({
    entryPoints: ["src/shell/main.tsx"],
    bundle: true,
    write: false,
    outdir: "bundle",
    splitting: true,
    chunkNames: "chunk-[hash]",
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    minify: true,
    legalComments: "none",
    loader: { ".html": "text" },
    define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: "false", __QD_SOURCE__: JSON.stringify(source), "process.env.NODE_ENV": '"production"' },
  });
  return built.outputFiles.filter((file) => file.path.endsWith(".js")).map((file) => file.text).join("\n");
}

test("a normal build carries none of the answer client, and a server build carries it", async () => {
  const normal = await appCode("example");
  const server = await appCode("server");
  for (const mark of ["/answer", "/comments", "csrf", "freshUntil", "opaqueredirect"]) {
    assert.equal(normal.includes(mark), false, "normal build holds " + mark);
    assert.equal(server.includes(mark), true, "server build lacks " + mark);
  }
});
