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
const STALE = text("answer/answer-200-stale.json");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const ETAG = '"5f0c6d3a9b1e47d28c4a0e7b3f6d91a2c8e5b04d7a3f16c9e2b8d5a07c4f1e36"';
const FIRST_TOKEN = "sample-csrf-token-not-real";
const FRESH_TOKEN = "sample-csrf-fresh-1";
const REFUSED = text("answer/request-refused.json");

const json = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/json" } });
const edited = (changes) => {
  const body = structuredClone(LISTING);
  for (const project of body.projects) for (const lane of project.lanes) for (const card of lane.cards) if (changes[card.id]) Object.assign(card, changes[card.id]);
  return body;
};
const listing = (changes = {}) => new Response(JSON.stringify(edited(changes)), { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const fresh = () => new Response(JSON.stringify(edited({})).replace(FIRST_TOKEN, FRESH_TOKEN), { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const notModified = () => new Response(null, { status: 304, headers: { ETag: ETAG } });

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
  const queues = new Map(Object.entries(routes).map(([key, steps]) => [key, [...steps]]));
  const send = async (path, init) => {
    calls.push({ path, init });
    const step = queues.get(init.method + " " + path)?.shift();
    const value = typeof step === "function" ? step() : step;
    if (value instanceof Error) throw value;
    return value ?? json(JSON.stringify({ error: "not found" }), 404);
  };
  const source = createServerSource(createApiClient({ send, openEvents: () => ({ addEventListener: () => undefined, close: () => undefined }) }), time.now, time.schedule);
  const worlds = [];
  source.watch((failure) => {
    if (!failure) void source.load().then((world) => worlds.push(world), () => undefined);
  });
  return { source, calls, time, worlds };
}

const LIST = "GET /captain/cards";
const ANSWER = "POST /captain/cards/alba-1/answer";
const ANSWER_TWO = "POST /captain/cards/alba-2/answer";
const option = (letter) => ({ kind: "option", letter });
const waiting = (world) => world.cards.filter((card) => card.answer === null).length;
const find = (world, id) => world.cards.find((card) => card.id === id);
const requests = (calls) => calls.map((call) => call.init.method + " " + call.path);
const answerOne = (source, version = 3) => source.answer("alba-1", { choice: option("A"), note: "Yes.", version });

async function later(time, source) {
  const loading = source.load();
  loading.catch(() => undefined);
  await time.advance(5_000);
  return loading;
}

test("Got it takes the card out of the waiting count at once, with no request beyond the answer's own, and the world holds the Answer the receipt gave", async () => {
  const { source, calls, worlds } = serve({ [LIST]: [listing(), fresh()], [ANSWER]: [json(CURRENT)] });
  const before = await source.load();
  await tick();
  const heard = worlds.length;
  const given = await answerOne(source);
  await tick();
  assert.equal(worlds.length, heard + 2, "the token list and the answer each publish a world");
  assert.equal(waiting(worlds.at(-1)), waiting(before) - 1);
  assert.deepEqual(find(worlds.at(-1), "alba-1").answer, given);
  assert.deepEqual(requests(calls), [LIST, LIST, ANSWER]);
});

test("a list read that comes back 304 keeps the card answered", async () => {
  const { source, calls, time } = serve({ [LIST]: [listing(), fresh(), notModified()], [ANSWER]: [json(CURRENT)] });
  const before = await source.load();
  const given = await answerOne(source);
  const after = await later(time, source);
  assert.equal(calls[3].init.headers["If-None-Match"], ETAG);
  assert.equal(waiting(after), waiting(before) - 1);
  assert.deepEqual(find(after, "alba-1").answer, given);
});

test("a list read that is a 200 without the answer yet, the card still open at the same revision, keeps the card answered", async () => {
  const { source, time } = serve({ [LIST]: [listing(), fresh(), listing()], [ANSWER]: [json(CURRENT)] });
  const before = await source.load();
  await answerOne(source);
  const after = await later(time, source);
  assert.equal(waiting(after), waiting(before) - 1);
  assert.notEqual(find(after, "alba-1").answer, null);
});

test("a list read that shows the card done takes over: the list's own answer is shown, and the mark is gone", async () => {
  const done = { state: "done", answer: { pick: "A", at: "2026-11-02T10:00:05-05:00" } };
  const { source, time } = serve({ [LIST]: [listing(), fresh(), listing({ "alba-1": done }), listing()], [ANSWER]: [json(CURRENT)] });
  const before = await source.load();
  await answerOne(source);
  const taken = await later(time, source);
  assert.deepEqual(find(taken, "alba-1").answer, { choice: option("A"), at: "2026-11-02T10:00:05-05:00", note: "", version: 3, waitingOn: null, outcome: null });
  assert.equal(waiting(taken), waiting(before) - 1);
  const reopened = await later(time, source);
  assert.equal(find(reopened, "alba-1").answer, null, "no mark is left to hold it answered");
  assert.equal(waiting(reopened), waiting(before));
});

test("a list read that shows the card open at a newer revision drops the mark: it is waiting again", async () => {
  const { source, time } = serve({ [LIST]: [listing(), fresh(), listing({ "alba-1": { rev: 4 } })], [ANSWER]: [json(CURRENT)] });
  const before = await source.load();
  await answerOne(source);
  const after = await later(time, source);
  assert.equal(find(after, "alba-1").answer, null);
  assert.equal(waiting(after), waiting(before));
});

test("an answer to an older revision keeps the mark: the receipt's older revision does not make the list's newer one look like a change after it", async () => {
  const { source, time } = serve({ [LIST]: [listing(), fresh(), listing()], [ANSWER]: [json(STALE)] });
  const before = await source.load();
  const given = await answerOne(source, 2);
  assert.equal(given.stale, true);
  const after = await later(time, source);
  assert.equal(waiting(after), waiting(before) - 1);
  assert.notEqual(find(after, "alba-1").answer, null);
});

test("an answer found sent by the card check (an ambiguous POST) takes the card out of the count too", async () => {
  const card = structuredClone(OPEN);
  card.thread.push({ id: "mail-110", kind: "answer", sender: "captain", sent: "2026-11-02T10:00:03-05:00", document: { qd: "answer/1", card: "alba-1", rev: 3, pick: "A", note: "Yes.", at: "2026-11-02T10:00:03-05:00" } });
  const { source, worlds } = serve({ [LIST]: [listing(), fresh()], [ANSWER]: [json("", 503)], "GET /captain/cards/alba-1": [json(JSON.stringify(card))] });
  const before = await source.load();
  await tick();
  const given = await answerOne(source);
  await tick();
  assert.equal(given.at, "2026-11-02T10:00:03-05:00");
  assert.equal(waiting(worlds.at(-1)), waiting(before) - 1);
  assert.deepEqual(find(worlds.at(-1), "alba-1").answer, given);
});

test("two answered cards each keep their own mark", async () => {
  const { source, time } = serve({ [LIST]: [listing(), fresh(), fresh(), notModified()], [ANSWER]: [json(CURRENT)], [ANSWER_TWO]: [json(CURRENT)] });
  const before = await source.load();
  await answerOne(source);
  await source.answer("alba-2", { choice: option("A"), note: "", version: 1 });
  const after = await later(time, source);
  assert.equal(waiting(after), waiting(before) - 2);
  assert.deepEqual([find(after, "alba-1").answer === null, find(after, "alba-2").answer === null], [false, false]);
});

test("a session end clears the mark: after signing in again the list's card is waiting, as the list says", async () => {
  const { source, time } = serve({ [LIST]: [listing(), fresh(), json(REFUSED, 403), listing()], [ANSWER]: [json(CURRENT)] });
  const before = await source.load();
  await answerOne(source);
  const ended = assert.rejects(later(time, source), { name: "SignInRequired" });
  await ended;
  source.signIn();
  const again = await later(time, source);
  assert.equal(find(again, "alba-1").answer, null);
  assert.equal(waiting(again), waiting(before));
});

test("an answer whose receipt comes back after a session end leaves no mark", async () => {
  let release = () => undefined;
  const waitingReceipt = new Promise((resolve) => (release = resolve));
  const { source, time } = serve({ [LIST]: [listing(), fresh(), json(REFUSED, 403), listing()], [ANSWER]: [() => waitingReceipt] });
  const before = await source.load();
  const answering = answerOne(source);
  await tick();
  const ended = assert.rejects(later(time, source), { name: "SignInRequired" });
  await ended;
  release(json(CURRENT));
  await answering.catch(() => undefined);
  source.signIn();
  const again = await later(time, source);
  assert.equal(find(again, "alba-1").answer, null);
  assert.equal(waiting(again), waiting(before));
});
