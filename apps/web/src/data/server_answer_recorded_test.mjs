import assert from "node:assert/strict";
import crypto from "node:crypto";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle() {
  const contents = ["api-client", "server-source"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createApiClient, createServerSource } = await bundle();

const DIR = new URL("./server-payloads/answer/recorded/", import.meta.url);
const raw = (name) => fs.readFileSync(new URL(name + ".json", DIR), "utf8");
const sample = (name) => JSON.parse(raw(name));
const SESSION_REFUSED = JSON.parse(fs.readFileSync(new URL("./server-payloads/recorded/error-403-session-refused.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-05T10:05:00-05:00");

const HASHES = {
  "answer-200-answer-to-a-withdrawn-card": "d9c64fb05f25acee3cd1aa541d8f26beffcf90bad1df0ad43f36d752bb549019",
  "answer-200-cant-decide": "1076cf1949795eda89b4890959d381d47aa32edd53ce52c586e79f5e330a48ae",
  "answer-200-letter-pick-with-note": "ee87560b989126c44a15bfc677ace3b10aba613afeff3d97c82fdfc796f412a3",
  "answer-200-none-empty-note": "9ab2c8f9c62e6e46afd8e67381a2d32d819a6a12b5b05e66e6222ec4b3f48246",
  "answer-200-older-revision-stale": "a0011c653be9da3ee27c5202806a05f0061bc0d648b64ae3760b0660671a10fa",
  "answer-200-second-answer-to-a-done-card": "59ec67ca00d1c73b9224f45dcd0dae58e4775a615c8ccc05e95734bddc00cde5",
  "answer-303-fresh-sign-in-needed": "dcd3a4cf6fcc2a92497e5fb80629477a6af76c7d792c059fe29e6c1faec142a8",
  "answer-400-extra-field": "3d41181cd5a1552623af41ef1cd4c1e7f3c2aa595642031640cea64869c385e0",
  "answer-400-id-not-shaped-like-a-card": "643fb241532925c50a9f4868c2dcf68750a8c2a8a4244c2e74275dc72a4475f2",
  "answer-400-note-too-long": "197ad22871c756f41c1c06c9166c50230d73484dea3eb4d240323896972c51cd",
  "answer-400-pick-not-on-revision": "83f1bbd6c9bf0820f28881c7e1d22e0e48cc116caf842a38769561d885ed1d4a",
  "answer-400-revision-does-not-exist": "51c7aaa8552284b22a82ca5cce40827bb6c59e8a424321ac67d54e4f9ca02be7",
  "answer-400-unknown-card": "f8d9fb0d163f4cdc023505b6ae2a0462bad4d3fb8ae9fdf4208852f35db4245f",
  "answer-400-wrong-content-type": "82566e0a99ce006817211635f0c08dadbd1dd967faadd8739af8eec66401c703",
  "answer-403-rate-limited-on-the-real-sign-in": "0609c52ddf6e41b87f182807cd93f6328d61c920d8094184a9b164ab91c347c2",
  "answer-403-used-csrf": "afc5370bbb632de2b6b0f36be83d7aed7e5b36a89d510f808f4eb4a3d0e7369d",
  "answer-429-rate-limited": "300a11e928893e9453060ea448a57580465969885cdfce55e7798e5c914a08ba",
  "answer-503-second-answer-same-pick": "941e214f69c57f215acbcdbb42f1eae12cf5b17905570dec57ff00201f55fd12",
  "answer-503-service-failure": "cff60dd16776c9c4dbd4c2f53fa6e11c06145fed846add90260a0b6686cf8236",
  "card-after-answer": "7ebb4e96306c7788b0a01d4658c3a6b16cde9065637f5e67660c7cd97bfbb68a",
  "card-after-second-answer": "75fbac6b41e36164cb7259b28571fb72c209edb41e4d5479735a7e0e4b0f8e66",
  "card-withdrawn-after-answer": "d42b691901f8434b43556390cfbac3d384c644af77e50fb09e2474817cd5beb3",
  "comment-200-same-text-again": "e1b6085a681ec63fa5f28cda8d3b1e419a98dd9bd1dd7c9bc86dca9ae95c66ed",
  "comment-200-same-text-new-request-id": "5a75f77d5251f1cad114f65a873709d0631bb60a94a499115803d6a96bb7d4a3",
  "comment-200-sent": "94f21161385c7799d86e0f6c856025c8e6185df2e703d25d61a813e5284fe0ac",
  "comment-400-empty-text": "e4b17525458942265cfaa740158f9f996e285b706b36b376e07f1d892b3a5d06",
  "list-after-answers": "b4de84999703f1bda72f9bb542c9a88613cfb755f0c77671d0eb2cf5b3bb7334",
};

const respond = (s) => {
  const headers = { "Content-Type": s.headers["Content-Type"] };
  for (const name of ["Location", "ETag"]) if (s.headers[name]) headers[name] = s.headers[name];
  return new Response(s.body === null ? null : JSON.stringify(s.body), { status: s.status, headers });
};

const listing = () => respond(sample("list-after-answers"));
const freshListing = (n) => {
  const s = sample("list-after-answers");
  return respond({ ...s, body: { ...s.body, csrf: "sample-csrf-fresh-" + n } });
};
const refused = () => respond(SESSION_REFUSED);
const failing = (status) => new Response(JSON.stringify({ error: "request unavailable" }), { status, headers: { "Content-Type": "application/json" } });

function scripted(...steps) {
  const calls = [];
  const queue = [...steps];
  const send = async (path, init) => {
    calls.push({ path, init });
    const next = queue.shift();
    const value = typeof next === "function" ? next() : next;
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, send };
}

const posts = (calls) => calls.filter((call) => call.init.method === "POST");
const idOf = (s) => s.request.path.split("/")[3];
const noteOf = (body) => (body.note === "<4001 characters>" ? "x".repeat(4001) : body.note);
const inputOf = (s) => ({ rev: s.request.body.rev, pick: s.request.body.pick, note: noteOf(s.request.body) });
const option = (letter) => ({ kind: "option", letter });

async function attempt(name, ...after) {
  const s = sample(name);
  const run = scripted(listing(), freshListing(1), respond(s), ...after);
  const client = createApiClient({ send: run.send });
  await client.cards();
  const outcome = await client.answer(idOf(s), inputOf(s)).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return { s, run, client, ...outcome };
}

test("the 27 recorded samples are in byte for byte: the list of files and each sha256 match the frozen SHA256SUMS", () => {
  assert.deepEqual(fs.readdirSync(DIR).sort(), Object.keys(HASHES).map((name) => name + ".json").sort());
  for (const [name, hash] of Object.entries(HASHES)) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(new URL(name + ".json", DIR))).digest("hex"), hash, name);
});

const ANSWER_SAMPLES = [
  ["answer-200-letter-pick-with-note", "ok"],
  ["answer-200-older-revision-stale", "ok"],
  ["answer-200-cant-decide", "ok"],
  ["answer-200-none-empty-note", "ok"],
  ["answer-200-second-answer-to-a-done-card", "ok"],
  ["answer-200-answer-to-a-withdrawn-card", "ok"],
  ["answer-503-second-answer-same-pick", "NotConfirmed"],
  ["answer-503-service-failure", "NotConfirmed"],
  ["answer-303-fresh-sign-in-needed", "FreshSignInRequired"],
  ["answer-400-unknown-card", "Refused"],
  ["answer-400-revision-does-not-exist", "Refused"],
  ["answer-400-pick-not-on-revision", "Refused"],
  ["answer-403-used-csrf", "SignInRequired"],
  ["answer-403-rate-limited-on-the-real-sign-in", "SignInRequired"],
  ["answer-429-rate-limited", "RateLimited"],
];

for (const [name, expected] of ANSWER_SAMPLES) {
  test("recorded " + name + ": the client sends what was recorded, and the answer comes back as " + expected, async () => {
    const { s, run, value, error } = await attempt(name, listing());
    const [post] = posts(run.calls);
    assert.equal(post.path, s.request.path);
    assert.equal(post.init.method, s.request.method);
    assert.equal(post.init.headers["Content-Type"], s.request.headers["Content-Type"]);
    const sent = JSON.parse(post.init.body);
    assert.deepEqual(Object.keys(sent), Object.keys(s.request.body));
    assert.deepEqual({ ...sent, csrf: null }, { ...s.request.body, csrf: null });
    assert.equal(sent.csrf, "sample-csrf-fresh-1");
    assert.equal(posts(run.calls).length, 1);
    if (expected === "ok") {
      assert.equal(error, undefined);
      assert.deepEqual(value, { message: s.body.message, stale: s.body.stale, rev: s.body.rev });
    } else {
      assert.equal(error?.name, expected);
    }
  });
}

test("recorded receipts name the picks in words and carry stale for an older revision", async () => {
  const messages = [];
  for (const name of ["answer-200-cant-decide", "answer-200-none-empty-note", "answer-200-older-revision-stale", "answer-200-letter-pick-with-note"]) {
    const { value } = await attempt(name);
    messages.push([value.message, value.stale]);
  }
  assert.deepEqual(messages.map(([message]) => message.includes("Can't decide")), [true, false, false, false]);
  assert.deepEqual(messages.map(([message]) => message.includes("None of these")), [false, true, false, false]);
  assert.deepEqual(messages.map(([, stale]) => stale), [false, false, true, false]);
});

for (const name of ["answer-303-fresh-sign-in-needed", "answer-400-unknown-card", "answer-400-revision-does-not-exist", "answer-400-pick-not-on-revision", "answer-503-service-failure", "answer-503-second-answer-same-pick"]) {
  test("recorded " + name + " spends its fresh token and gives no new one, so the next answer reads a fresh token first and then sends once with that one", async () => {
    const ok = sample("answer-200-letter-pick-with-note");
    const { client, run, error } = await attempt(name, freshListing(2), respond(ok));
    assert.ok(error);
    await client.answer(idOf(ok), inputOf(ok));
    assert.deepEqual(run.calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST"]);
    assert.equal("If-None-Match" in run.calls[1].init.headers, false);
    assert.equal("If-None-Match" in run.calls[3].init.headers, false);
    assert.equal(JSON.parse(posts(run.calls)[1].init.body).csrf, "sample-csrf-fresh-2");
  });
}

for (const name of ["answer-403-used-csrf", "answer-403-rate-limited-on-the-real-sign-in"]) {
  test("recorded " + name + ": SignInRequired after its fresh token read and exactly one POST, with no read after it; the token and freshness are dropped, so the next answer reads a fresh token first", async () => {
    const { run, client, error } = await attempt(name);
    assert.equal(error?.name, "SignInRequired");
    assert.deepEqual(run.calls.map((call) => call.init.method), ["GET", "GET", "POST"]);
    assert.equal(client.freshUntil(), null);
    const ok = sample("answer-200-letter-pick-with-note");
    const next = scripted(listing(), freshListing(1), respond(sample(name)), freshListing(2), respond(ok));
    const again = createApiClient({ send: next.send });
    await again.cards();
    await assert.rejects(again.answer(idOf(sample(name)), inputOf(sample(name))), { name: "SignInRequired" });
    await again.answer(idOf(ok), inputOf(ok));
    assert.deepEqual(next.calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST"]);
    assert.equal("If-None-Match" in next.calls[3].init.headers, false);
  });
}

test("recorded answer 429 is RateLimited after its fresh token read and exactly one POST, with no read after it", async () => {
  const { run, error } = await attempt("answer-429-rate-limited");
  assert.equal(error?.name, "RateLimited");
  assert.deepEqual(run.calls.map((call) => call.init.method), ["GET", "GET", "POST"]);
});

test("recorded 400s that the client cannot even send are refused before sending, and their recorded replies still map to Refused", async () => {
  const tooLong = sample("answer-400-note-too-long");
  const run = scripted(listing());
  const client = createApiClient({ send: run.send });
  await client.cards();
  await assert.rejects(client.answer(idOf(tooLong), inputOf(tooLong)), { name: "Refused" });
  assert.equal(posts(run.calls).length, 0);
  const badId = sample("answer-400-id-not-shaped-like-a-card");
  assert.equal(idOf(badId), "bad_id");
  await assert.rejects(client.answer(idOf(badId), inputOf(badId)), { name: "Refused" });
  assert.equal(run.calls.length, 1);
  const wrongType = sample("answer-400-wrong-content-type");
  const extra = sample("answer-400-extra-field");
  assert.notEqual(wrongType.request.headers["Content-Type"], "application/json");
  assert.equal(Object.keys(extra.request.body).length, 5);
  for (const name of ["answer-400-note-too-long", "answer-400-wrong-content-type", "answer-400-extra-field", "answer-400-id-not-shaped-like-a-card"]) {
    const s = sample(name);
    const replay = scripted(listing(), freshListing(1), respond(s));
    const again = createApiClient({ send: replay.send });
    await again.cards();
    await assert.rejects(again.answer("bot-a-3", { rev: 1, pick: "A", note: "" }), { name: "Refused" });
    assert.equal(posts(replay.calls).length, 1);
    const [post] = posts(replay.calls);
    assert.equal(post.init.headers["Content-Type"], "application/json");
    assert.equal(Object.keys(JSON.parse(post.init.body)).length, 4);
  }
});

const COMMENTS = [
  ["comment-200-sent", "ok"],
  ["comment-200-same-text-again", "ok"],
  ["comment-200-same-text-new-request-id", "ok"],
];

for (const [name] of COMMENTS) {
  test("recorded " + name + ": the client sends what was recorded and the comment resolves with nothing", async () => {
    const s = sample(name);
    const run = scripted(listing(), freshListing(1), respond(s));
    const client = createApiClient({ send: run.send });
    await client.cards();
    const result = await client.comment(idOf(s), { text: s.request.body.text, requestId: s.request.body.requestId });
    assert.equal(result, undefined);
    const [post] = posts(run.calls);
    assert.equal(post.path, s.request.path);
    assert.equal(post.init.headers["Content-Type"], "application/json");
    assert.deepEqual(Object.keys(JSON.parse(post.init.body)), Object.keys(s.request.body));
    assert.deepEqual({ ...JSON.parse(post.init.body), csrf: null }, { ...s.request.body, csrf: null });
  });
}

test("recorded comment 400 for empty text is refused before sending, and its recorded reply maps to Refused", async () => {
  const s = sample("comment-400-empty-text");
  const run = scripted(listing());
  const client = createApiClient({ send: run.send });
  await client.cards();
  await assert.rejects(client.comment(idOf(s), { text: s.request.body.text, requestId: s.request.body.requestId }), { name: "Refused" });
  assert.equal(posts(run.calls).length, 0);
  const replay = scripted(listing(), freshListing(1), respond(s));
  const again = createApiClient({ send: replay.send });
  await again.cards();
  await assert.rejects(again.comment(idOf(s), { text: "A real comment.", requestId: "req-9" }), { name: "Refused" });
  assert.equal(posts(replay.calls).length, 1);
});

test("a comment that the server answered 403 is SignInRequired after its fresh token read and exactly one POST, with no read after it", async () => {
  const s = sample("comment-200-sent");
  const run = scripted(listing(), freshListing(1), respond(sample("answer-403-used-csrf")));
  const client = createApiClient({ send: run.send });
  await client.cards();
  await assert.rejects(client.comment(idOf(s), { text: "hi", requestId: "r" }), { name: "SignInRequired" });
  assert.deepEqual(run.calls.map((call) => call.init.method), ["GET", "GET", "POST"]);
  assert.equal(client.freshUntil(), null);
});

test("the recorded follow-up cards read through card(): the answer is the last event, both answers are there in order, and a withdrawn card stays withdrawn", async () => {
  const read = async (name) => {
    const run = scripted(respond(sample(name)));
    return createApiClient({ send: run.send }).card(sample(name).body.card.id);
  };
  const first = await read("card-after-answer");
  assert.deepEqual([first.state, first.rev], ["done", 1]);
  assert.deepEqual(first.thread.at(-1), { kind: "answer", sender: first.thread.at(-1).sender, sent: first.thread.at(-1).sent, pick: "B", rev: 1, note: "Hold until Monday.", forComment: false });
  const second = await read("card-after-second-answer");
  assert.deepEqual(second.thread.filter((event) => event.kind === "answer").map((event) => [event.pick, event.note]), [["A", ""], ["B", "Changed my mind."]]);
  const withdrawn = await read("card-withdrawn-after-answer");
  assert.equal(withdrawn.state, "withdrawn");
  assert.deepEqual([withdrawn.thread.at(-1).kind, withdrawn.thread.at(-1).pick], ["answer", "A"]);
});

test("the recorded list after the answers reads as eight cards, with the stale answer, the withdrawn card's answer, and the token kept", async () => {
  const run = scripted(listing());
  const client = createApiClient({ send: run.send });
  const { cards, truncated } = await client.cards();
  assert.equal(truncated, false);
  assert.equal(cards.length, 8);
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  assert.deepEqual([byId["repo-lead-1"].state, byId["repo-lead-1"].rev, byId["repo-lead-1"].answer.pick], ["done", 2, "A"]);
  assert.deepEqual([byId["bot-b-2"].state, byId["bot-b-2"].answer.pick], ["withdrawn", "A"]);
  assert.equal(byId["bot-a-1"].answer.pick, "cant-decide");
  assert.equal(byId["bot-b-1"].answer.pick, "none");
  assert.equal(client.freshUntil(), 0);
});

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
    return value ?? failing(404);
  };
  const source = createServerSource(createApiClient({ send, openEvents: () => ({ addEventListener: () => undefined, close: () => undefined }) }), time.now, time.schedule);
  const heard = [];
  source.watch((failure) => heard.push(failure?.name));
  return { source, calls, heard, time, posts: () => calls.filter((call) => call.init.method === "POST"), cardGets: (id) => calls.filter((call) => call.init.method === "GET" && call.path === "/captain/cards/" + id).length };
}

test("the recorded list after the answers makes seven cards in the world, without the withdrawn one, with each answer as the app knows it", async () => {
  const { source } = serve({ "GET /captain/cards": [listing()] });
  const world = await source.load();
  const byId = Object.fromEntries(world.cards.map((card) => [card.id, card]));
  assert.equal(world.cards.length, 7);
  assert.equal("bot-b-2" in byId, false);
  assert.deepEqual([byId["bot-a-1"].answer.choice, byId["bot-b-1"].answer.choice, byId["repo-lead-2"].answer.choice], [{ kind: "cant-decide" }, { kind: "none" }, option("B")]);
  assert.equal(byId["repo-lead-1"].version, 2);
});

const SECOND = "POST /captain/cards/bot-a-2/answer";
const FIRST = "POST /captain/cards/repo-lead-2/answer";

test("a refused repeat (503) is checked by one GET of the card; the thread holds an earlier answer with another note, so it stays not confirmed, and no second POST goes out", async () => {
  const { source, posts: sent, cardGets } = serve({ "GET /captain/cards": [listing(), freshListing(1)], [SECOND]: [respond(sample("answer-503-second-answer-same-pick"))], "GET /captain/cards/bot-a-2": [respond(sample("card-after-second-answer"))] });
  await source.load();
  const request = sample("answer-503-second-answer-same-pick").request.body;
  await assert.rejects(source.answer("bot-a-2", { choice: option(request.pick), note: request.note, version: request.rev }), { name: "NotConfirmed" });
  assert.equal(sent().length, 1);
  assert.equal(cardGets("bot-a-2"), 1);
});

test("a 503 after the request left is found sent when the thread shows the same revision, pick and note: it comes back as the answer, with the thread event's time", async () => {
  const card = sample("card-after-answer");
  const event = card.body.thread.at(-1);
  const { source, posts: sent, cardGets } = serve({ "GET /captain/cards": [listing(), freshListing(1)], [FIRST]: [respond(sample("answer-503-service-failure"))], "GET /captain/cards/repo-lead-2": [respond(card)] });
  await source.load();
  const answer = await source.answer("repo-lead-2", { choice: option("B"), note: "Hold until Monday.", version: 1 });
  assert.deepEqual(answer, { choice: option("B"), at: event.sent, note: "Hold until Monday.", version: 1, waitingOn: null, outcome: null, stale: false });
  assert.equal(sent().length, 1);
  assert.equal(cardGets("repo-lead-2"), 1);
});

test("the same check finds the answer after a network failure and after a receipt that cannot be read, and marks it stale when the card has moved on", async () => {
  const card = sample("card-after-answer");
  const moved = { ...card, body: { ...card.body, rev: 2 } };
  for (const [reply, body] of [[() => new TypeError("Failed to fetch"), card], [() => new Response("Got it", { status: 200 }), moved]]) {
    const { source, posts: sent } = serve({ "GET /captain/cards": [listing(), freshListing(1)], [FIRST]: [reply], "GET /captain/cards/repo-lead-2": [respond(body)] });
    await source.load();
    const answer = await source.answer("repo-lead-2", { choice: option("B"), note: "Hold until Monday.", version: 1 });
    assert.equal(answer.stale, body.body.rev > 1);
    assert.equal(sent().length, 1);
  }
});

test("when the thread does not show the answer, or the card cannot be read, it stays not confirmed after one POST and one GET of the card", async () => {
  const card = sample("card-after-answer");
  for (const [reply, expected] of [[respond(card), "NotConfirmed"], [() => failing(503), "NotConfirmed"], [() => new TypeError("Failed to fetch"), "NotConfirmed"]]) {
    const { source, posts: sent, cardGets } = serve({ "GET /captain/cards": [listing(), freshListing(1)], [FIRST]: [respond(sample("answer-503-service-failure"))], "GET /captain/cards/repo-lead-2": [reply] });
    await source.load();
    await assert.rejects(source.answer("repo-lead-2", { choice: option("A"), note: "Hold until Monday.", version: 1 }), { name: expected });
    assert.equal(sent().length, 1);
    assert.equal(cardGets("repo-lead-2"), 1);
  }
});

test("when the check's GET is refused with a 403 the session has ended: the watchers are told, and the answer ends as SignInRequired", async () => {
  const { source, heard } = serve({ "GET /captain/cards": [listing(), freshListing(1)], [FIRST]: [respond(sample("answer-503-service-failure"))], "GET /captain/cards/repo-lead-2": [refused()] });
  await source.load();
  await assert.rejects(source.answer("repo-lead-2", { choice: option("B"), note: "Hold until Monday.", version: 1 }), { name: "SignInRequired" });
  assert.deepEqual(heard, [undefined, undefined, "SignInRequired"]);
});

test("a comment that is not confirmed does no card check, and a 303, a 400 or a 429 on an answer does none either", async () => {
  for (const [reply, expected] of [[respond(sample("answer-303-fresh-sign-in-needed")), "FreshSignInRequired"], [respond(sample("answer-400-unknown-card")), "Refused"], [respond(sample("answer-429-rate-limited")), "RateLimited"]]) {
    const { source, cardGets } = serve({ "GET /captain/cards": [listing(), freshListing(1)], [FIRST]: [reply] });
    await source.load();
    await assert.rejects(source.answer("repo-lead-2", { choice: option("B"), note: "", version: 1 }), { name: expected });
    assert.equal(cardGets("repo-lead-2"), 0);
  }
  const { source, cardGets, posts: sent } = serve({ "GET /captain/cards": [listing(), freshListing(1)], "POST /captain/cards/repo-lead-3/comments": [() => failing(503)] });
  await source.load();
  await assert.rejects(source.comment("repo-lead-3", { text: "hi", requestId: "r" }), { name: "NotConfirmed" });
  assert.equal(cardGets("repo-lead-3"), 0);
  assert.equal(sent().length, 1);
});

for (const name of ["answer-403-used-csrf", "answer-403-rate-limited-on-the-real-sign-in"]) {
  for (const probe of ["a list", "a refusal"]) {
    test("a recorded 403 (" + name + ") on an answer enters the one pause: watchers told once, nothing sent for 61 seconds, the answer is never resent, and the one list check ends in " + probe, async () => {
      const { source, heard, calls, posts: sent, time } = serve({ "GET /captain/cards": [listing(), freshListing(1), probe === "a list" ? listing() : refused(), listing()], [FIRST]: [respond(sample(name))] });
      await source.load();
      await assert.rejects(source.answer("repo-lead-2", { choice: option("B"), note: "Keep this note", version: 1 }), { name: "SignInRequired" });
      assert.deepEqual(heard, [undefined, undefined, "SignInRequired"]);
      assert.equal(source.freshUntil(), null);
      assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST"]);
      assert.equal(time.pending(), 1);
      await assert.rejects(source.answer("repo-lead-2", { choice: option("B"), note: "Keep this note", version: 1 }), { name: "SignInRequired" });
      await assert.rejects(source.comment("repo-lead-2", { text: "hi", requestId: "r" }), { name: "SignInRequired" });
      await assert.rejects(source.load(), { name: "SignInRequired" });
      assert.deepEqual(heard, [undefined, undefined, "SignInRequired"]);
      await time.advance(60_999);
      assert.equal(calls.length, 3);
      await time.advance(1);
      assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET"]);
      assert.equal("If-None-Match" in calls[3].init.headers, false);
      assert.equal(sent().length, 1);
      if (probe === "a list") {
        assert.deepEqual(heard, [undefined, undefined, "SignInRequired", undefined]);
        assert.equal(source.freshUntil(), 0);
        assert.equal(time.pending(), 1);
        const loading = source.load();
        await time.advance(5_000);
        await loading;
        assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "GET"]);
        assert.equal(sent().length, 1);
      } else {
        assert.deepEqual(heard, [undefined, undefined, "SignInRequired"]);
        assert.equal(time.pending(), 0);
        await time.advance(61_000);
        assert.equal(time.pending(), 0);
        await assert.rejects(source.load(), { name: "SignInRequired" });
        assert.equal(calls.length, 4);
      }
    });
  }
}

test("nothing of a wrong type for rev or pick is ever sent, at the client or through the source", async () => {
  const wrongRev = ["1", [1], { n: 1 }, null, undefined, 1.5, NaN, true];
  const wrongPick = [["A"], { letter: "A" }, 1, null, undefined, true, "a", ""];
  const run = scripted(listing());
  const client = createApiClient({ send: run.send });
  await client.cards();
  for (const rev of wrongRev) await assert.rejects(client.answer("repo-lead-2", { rev, pick: "B", note: "" }), { name: "Refused" });
  for (const pick of wrongPick) await assert.rejects(client.answer("repo-lead-2", { rev: 1, pick, note: "" }), { name: "Refused" });
  assert.equal(posts(run.calls).length, 0);
  assert.equal(run.calls.length, 1);
  const { source, calls, posts: sent } = serve({ "GET /captain/cards": [listing()], [FIRST]: [respond(sample("answer-200-letter-pick-with-note"))] });
  await source.load();
  for (const version of wrongRev) await assert.rejects(source.answer("repo-lead-2", { choice: option("B"), note: "", version }), { name: "Refused" });
  for (const letter of wrongPick) await assert.rejects(source.answer("repo-lead-2", { choice: option(letter), note: "", version: 1 }), { name: "Refused" });
  for (const note of [5, null, undefined, ["x"], { x: 1 }]) await assert.rejects(source.answer("repo-lead-2", { choice: option("B"), note, version: 1 }), { name: "Refused" });
  assert.equal(sent().length, 0);
  assert.equal(calls.length, 1);
});
