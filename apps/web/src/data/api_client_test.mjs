import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { createApiClient, SignInRequired, NotFound, Unavailable } = await loadTs("src/data/api-client.ts");

const payload = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const FIXED = payload("list-fixed-only.json");
const ADDED = payload("list-added.json");
const ETAG = '"5f0c6d3a9b1e47d28c4a0e7b3f6d91a2c8e5b04d7a3f16c9e2b8d5a07c4f1e36"';
const OTHER_ETAG = '"a3c1e9f07b5d2846c0e8a1f3b7d95c24e6a08b1d3f7c5e92a4b6d08c1e3f5a79"';

const answering = (...responses) => {
  const calls = [];
  const queue = [...responses];
  const send = async (path, init) => {
    calls.push({ path, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, send };
};

const list = (body = FIXED, etag = ETAG) => new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", ETag: etag } });
const failure = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const notModified = (etag = ETAG) => new Response(null, { status: 304, headers: { ETag: etag } });

function withGlobal(name, value, run) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const restore = () => Object.defineProperty(globalThis, name, before ?? { value: undefined, configurable: true, writable: true });
  return Promise.resolve(run()).finally(restore);
}

test("the list is asked for by GET at /captain/cards on the same origin with the session cookie, and no If-None-Match the first time", async () => {
  const { calls, send } = answering(list());
  await createApiClient({ send }).cards();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/captain/cards");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal("If-None-Match" in calls[0].init.headers, false);
});

test("with no transport given it calls the browser's fetch", async () => {
  const seen = [];
  await withGlobal("fetch", async (path, init) => (seen.push([path, init.method]), list()), async () => {
    const listing = await createApiClient().cards();
    assert.equal(listing.cards.length, 10);
  });
  assert.deepEqual(seen, [["/captain/cards", "GET"]]);
});

test("the nested projects, lanes and cards come back as one list in the server's order, with changed-at as changedAt", async () => {
  const { send } = answering(list());
  const { cards } = await createApiClient({ send }).cards();
  assert.deepEqual(
    cards.map((card) => card.id),
    ["alba-1", "alba-2", "kivo-3", "alba-9", "kivo-10", "shelvorn-4", "shelvorn-5", "shelvorn-6", "shelvorn-7", "kivo-8"],
  );
  assert.deepEqual(cards[0], {
    id: "alba-1",
    title: "How many results should each Search group show?",
    project: "quarterdeck",
    lane: "Search",
    due: "2026-11-03T17:00:00-05:00",
    state: "open",
    changedAt: "2026-11-02T09:40:00-05:00",
  });
  assert.equal(cards[1].due, null);
  assert.deepEqual(cards.map((card) => card.state), ["open", "open", "open", "done", "done", "open", "done", "withdrawn", "open", "open"]);
});

test("the added fields come through when the server sends them and are absent when it does not", async () => {
  const { send } = answering(list(ADDED));
  const { cards } = await createApiClient({ send }).cards();
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  assert.deepEqual([byId["alba-1"].from, byId["alba-1"].rev, byId["alba-1"].answer, byId["alba-1"].waitsOn], ["alba", 3, null, null]);
  assert.deepEqual(byId["shelvorn-5"].answer, { pick: "A", at: "2026-11-02T09:00:00-05:00" });
  assert.equal(byId["shelvorn-5"].waitsOn, "shelvorn");
  assert.equal(byId["kivo-10"].answer.pick, "cant-decide");
  const fixed = await createApiClient({ send: answering(list()).send }).cards();
  assert.deepEqual(Object.keys(fixed.cards[0]).sort(), ["changedAt", "due", "id", "lane", "project", "state", "title"]);
});

test("the truncated flag comes through, and csrf, freshUntil and the plain mail are left out", async () => {
  const body = JSON.stringify({ ...JSON.parse(FIXED), truncated: true });
  const listing = await createApiClient({ send: answering(list(body)).send }).cards();
  assert.deepEqual(Object.keys(listing).sort(), ["cards", "truncated"]);
  assert.equal(listing.truncated, true);
  assert.equal((await createApiClient({ send: answering(list()).send }).cards()).truncated, false);
});

test("the ETag is sent back exactly as it came, and an empty 304 answers with the same list", async () => {
  const { calls, send } = answering(list(), notModified());
  const client = createApiClient({ send });
  const first = await client.cards();
  const second = await client.cards();
  assert.equal(calls[1].init.headers["If-None-Match"], ETAG);
  assert.equal(second, first);
});

test("a new 200 replaces the held list and its ETag", async () => {
  const changed = JSON.stringify({ ...JSON.parse(FIXED), projects: JSON.parse(FIXED).projects.slice(1) });
  const { calls, send } = answering(list(), list(changed, OTHER_ETAG), notModified(OTHER_ETAG));
  const client = createApiClient({ send });
  await client.cards();
  const second = await client.cards();
  assert.deepEqual(second.cards.map((card) => card.id), ["shelvorn-7", "kivo-8"]);
  const third = await client.cards();
  assert.equal(calls[2].init.headers["If-None-Match"], OTHER_ETAG);
  assert.equal(third, second);
});

test("a 200 without an ETag leaves the next ask unconditional", async () => {
  const bare = new Response(FIXED, { status: 200, headers: { "Content-Type": "application/json" } });
  const { calls, send } = answering(bare, list());
  const client = createApiClient({ send });
  await client.cards();
  await client.cards();
  assert.equal("If-None-Match" in calls[1].init.headers, false);
});

test("a 304 when no list is held is refused", async () => {
  await assert.rejects(createApiClient({ send: answering(notModified()).send }).cards(), { name: "Refused" });
});

for (const [status, error] of [
  [401, "sign in required"],
  [403, "request refused"],
]) {
  test("a " + status + " means sign in again, and the next ask forgets the old ETag", async () => {
    const { calls, send } = answering(list(), failure(status, error), list());
    const client = createApiClient({ send });
    await client.cards();
    await assert.rejects(client.cards(), (thrown) => thrown instanceof SignInRequired && thrown.name === "SignInRequired" && thrown.message === "sign in again");
    await client.cards();
    assert.equal(calls[1].init.headers["If-None-Match"], ETAG);
    assert.equal("If-None-Match" in calls[2].init.headers, false);
  });
}

for (const [status, error, name] of [
  [400, "request refused", "Refused"],
  [405, "method not allowed", "Refused"],
  [429, "request refused", "Refused"],
  [404, "not found", "NotFound"],
  [503, "request unavailable", "Unavailable"],
  [500, "request unavailable", "Unavailable"],
  [502, "request unavailable", "Unavailable"],
]) {
  test("a " + status + " is " + name + ", and only a 401 or a 403 is sign in again", async () => {
    const client = createApiClient({ send: answering(failure(status, error)).send });
    await assert.rejects(client.cards(), (thrown) => thrown.name === name && !(thrown instanceof SignInRequired));
  });
}

test("the three failures named here are the classes the module exports", async () => {
  await assert.rejects(createApiClient({ send: answering(failure(404, "not found")).send }).cards(), (thrown) => thrown instanceof NotFound);
  await assert.rejects(createApiClient({ send: answering(failure(503, "request unavailable")).send }).cards(), (thrown) => thrown instanceof Unavailable);
});

test("a transport that throws is unavailable", async () => {
  await assert.rejects(createApiClient({ send: answering(new TypeError("Failed to fetch")).send }).cards(), (thrown) => thrown instanceof Unavailable);
});

const broken = (change) => {
  const body = JSON.parse(ADDED);
  change(body);
  return JSON.stringify(body);
};
const firstCard = (body) => body.projects[0].lanes[0].cards[0];

for (const [what, body] of [
  ["a body that is not JSON", "<html>sign in</html>"],
  ["a body that is not an object", "[]"],
  ["projects that are not a list", JSON.stringify({ projects: {}, truncated: false })],
  ["a missing truncated flag", broken((body) => void (body.truncated = undefined))],
  ["a card with no title", broken((body) => void (firstCard(body).title = undefined))],
  ["a card with no id", broken((body) => void (firstCard(body).id = "")) ],
  ["a state the server does not use", broken((body) => void (firstCard(body).state = "paused"))],
  ["a due that is not a time or null", broken((body) => void (firstCard(body).due = 5))],
  ["a changed-at that is not text", broken((body) => void (firstCard(body)["changed-at"] = null))],
  ["a rev that is not a whole number", broken((body) => void (firstCard(body).rev = "3"))],
  ["an answer with no pick", broken((body) => void (firstCard(body).answer = { at: "2026-11-02T09:00:00-05:00" }))],
  ["a from that is not text", broken((body) => void (firstCard(body).from = 7))],
]) {
  test("a 200 with " + what + " is refused, not shown", async () => {
    await assert.rejects(createApiClient({ send: answering(list(body)).send }).cards(), { name: "Refused" });
  });
}

function fakeStream(address) {
  const stream = {
    address,
    closed: 0,
    handlers: new Map(),
    addEventListener: (name, handler) => stream.handlers.set(name, handler),
    close: () => void (stream.closed += 1),
  };
  return stream;
}

test("a refresh event refetches through the caller, an event for chats only does not, and stop closes the stream", () => {
  const streams = [];
  const client = createApiClient({ send: answering().send, openEvents: (address) => (streams.push(fakeStream(address)), streams[0]) });
  let refreshes = 0;
  const stop = client.refreshes(() => (refreshes += 1));
  assert.equal(streams[0].address, "/captain/events");
  const refresh = streams[0].handlers.get("refresh");
  refresh({ data: '{"cards":true,"chats":true}' });
  assert.equal(refreshes, 1);
  refresh({ data: '{"cards":false,"chats":true}' });
  assert.equal(refreshes, 1);
  refresh({ data: "not json" });
  assert.equal(refreshes, 2);
  assert.equal(streams[0].closed, 0);
  stop();
  assert.equal(streams[0].closed, 1);
});

test("two listeners share one stream, each hears every refresh, the stream closes when the last one stops, and stopping twice is harmless", () => {
  const streams = [];
  const client = createApiClient({ send: answering().send, openEvents: (address) => (streams.push(fakeStream(address)), streams.at(-1)) });
  const heard = [0, 0];
  const stopFirst = client.refreshes(() => (heard[0] += 1));
  const stopSecond = client.refreshes(() => (heard[1] += 1));
  assert.equal(streams.length, 1);
  streams[0].handlers.get("refresh")({ data: "{}" });
  assert.deepEqual(heard, [1, 1]);
  stopFirst();
  stopFirst();
  streams[0].handlers.get("refresh")({ data: "{}" });
  assert.deepEqual(heard, [1, 2]);
  assert.equal(streams[0].closed, 0);
  stopSecond();
  stopSecond();
  assert.equal(streams[0].closed, 1);
  client.refreshes(() => undefined);
  assert.equal(streams.length, 2);
});

test("a terminal native error discards the client handle and permits one replacement", () => {
  const streams = [];
  const states = [];
  const client = createApiClient({ send: answering().send, openEvents: (url) => { const stream = fakeStream(url); streams.push(stream); return stream; } });
  const stop = client.refreshes(() => {}, undefined, (state) => states.push(state));
  streams[0].readyState = 2;
  streams[0].handlers.get("error")({});
  assert.deepEqual(states, ["closed"]);
  assert.equal(streams[0].closed, 1);
  stop();
  const stopNext = client.refreshes(() => {}, undefined, (state) => states.push(state));
  assert.equal(streams.length, 2);
  streams[0].handlers.get("error")({});
  assert.deepEqual(states, ["closed"]);
  stopNext();
  assert.equal(streams[1].closed, 1);
});

const OPEN = payload("card-open.json");
const ANSWERED = payload("card-answered.json");
const WITHDRAWN = payload("card-withdrawn.json");
const one = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

test("one card is asked for by GET at /captain/cards/<id> on the same origin with the session cookie", async () => {
  const { calls, send } = answering(one(OPEN), one(OPEN));
  const client = createApiClient({ send });
  await client.card("alba-1");
  await client.card("A" + "-".repeat(63));
  assert.deepEqual(calls.map((call) => call.path), ["/captain/cards/alba-1", "/captain/cards/A" + "-".repeat(63)]);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal("If-None-Match" in calls[0].init.headers, false);
});

test("an open card comes back with its card document, rev, state and the thread read into typed events, and no csrf or freshUntil", async () => {
  const read = await createApiClient({ send: answering(one(OPEN)).send }).card("alba-1");
  assert.deepEqual(Object.keys(read).sort(), ["card", "rev", "state", "thread"]);
  assert.deepEqual(read.card, JSON.parse(OPEN).card);
  assert.equal(read.rev, 3);
  assert.equal(read.state, "open");
  assert.deepEqual(read.thread, [
    { kind: "card", sender: "alba", sent: "2026-11-02T08:30:00-05:00" },
    { kind: "update", sender: "alba", sent: "2026-11-02T09:00:00-05:00" },
    { kind: "comment", sender: "kivo", sent: "2026-11-02T09:05:00-05:00" },
    { kind: "update", sender: "alba", sent: "2026-11-02T09:40:00-05:00" },
  ]);
});

test("an answered card's answers carry the pick, rev, note and whether they answer a comment", async () => {
  const read = await createApiClient({ send: answering(one(ANSWERED)).send }).card("shelvorn-5");
  assert.equal(read.state, "done");
  assert.deepEqual(read.thread.slice(2), [
    { kind: "answer", sender: "captain", sent: "2026-11-02T08:50:00-05:00", pick: "B", rev: 2, note: null, forComment: true },
    { kind: "answer", sender: "captain", sent: "2026-11-02T09:00:00-05:00", pick: "A", rev: 2, note: "Yes, Storage is its own section.", forComment: false },
  ]);
});

test("a withdrawn card comes back as withdrawn with its withdraw event", async () => {
  const read = await createApiClient({ send: answering(one(WITHDRAWN)).send }).card("shelvorn-6");
  assert.equal(read.state, "withdrawn");
  assert.deepEqual(read.thread.map((event) => event.kind), ["card", "withdraw"]);
});

for (const [status, error, name] of [
  [401, "sign in required", "SignInRequired"],
  [403, "request refused", "SignInRequired"],
  [400, "request refused", "Refused"],
  [429, "request refused", "Refused"],
  [404, "not found", "NotFound"],
  [503, "request unavailable", "Unavailable"],
]) {
  test("a " + status + " on one card is " + name, async () => {
    await assert.rejects(createApiClient({ send: answering(failure(status, error)).send }).card("alba-1"), { name });
  });
}

for (const status of [401, 403]) {
  test("a " + status + " on one card also makes the next list ask unconditional", async () => {
    const { calls, send } = answering(list(), failure(status, "sign in required"), list());
    const client = createApiClient({ send });
    await client.cards();
    await assert.rejects(client.card("alba-1"), (error) => error instanceof SignInRequired);
    await client.cards();
    assert.equal("If-None-Match" in calls[2].init.headers, false);
  });
}

test("a card read that fails in transport is unavailable", async () => {
  await assert.rejects(createApiClient({ send: answering(new TypeError("Failed to fetch")).send }).card("alba-1"), (error) => error instanceof Unavailable);
});

const changed = (change) => {
  const body = JSON.parse(ANSWERED);
  change(body);
  return JSON.stringify(body);
};

for (const [what, body] of [
  ["a body that is not JSON", "<html>sign in</html>"],
  ["a body that is not an object", "[]"],
  ["no card document", changed((body) => void (body.card = undefined))],
  ["a card with no title", changed((body) => void (body.card.title = undefined))],
  ["a card with no project", changed((body) => void (body.card.project = ""))],
  ["a card with no context", changed((body) => void (body.card.context = undefined))],
  ["a category that is not a list", changed((body) => void (body.card.category = "design"))],
  ["a rev that is not a whole number", changed((body) => void (body.rev = 1.5))],
  ["a state the server does not use", changed((body) => void (body.state = "paused"))],
  ["a thread that is not a list", changed((body) => void (body.thread = {}))],
  ["an event of a kind the server does not use", changed((body) => void (body.thread[0].kind = "edit"))],
  ["an event with no sender", changed((body) => void (body.thread[0].sender = undefined))],
  ["an answer with no pick", changed((body) => void (body.thread[3].document.pick = undefined))],
  ["an answer with a rev that is not a whole number", changed((body) => void (body.thread[3].document.rev = "2"))],
  ["an answer note that is not text", changed((body) => void (body.thread[3].document.note = 4))],
]) {
  test("a 200 with " + what + " on one card is refused, not shown", async () => {
    await assert.rejects(createApiClient({ send: answering(one(body)).send }).card("shelvorn-5"), { name: "Refused" });
  });
}

const JSON_LIMIT = 1_048_576;

for (const target of ["list", "card"]) {
  for (const length of [undefined, "1"]) {
    test("a 50 MiB " + target + " stream with Content-Length " + length + " is cancelled within 1 MiB plus one chunk", async () => {
      const chunk = new Uint8Array(65_536).fill(32);
      let bytes = 0;
      let cancelled = false;
      const body = new ReadableStream({
        pull(controller) {
          if (bytes >= 50 * 1024 * 1024) return controller.close();
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const headers = length === undefined ? {} : { "Content-Length": length };
      const { calls, send } = answering(new Response(body, { status: 200, headers }));
      const client = createApiClient({ send });
      await assert.rejects(target === "list" ? client.cards() : client.card("alba-1"), { name: "Refused" });
      assert.ok(bytes <= JSON_LIMIT + chunk.byteLength, "read " + bytes + " bytes");
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
      assert.equal(calls[0].init.redirect, "error");
      assert.equal(calls[0].init.credentials, "same-origin");
    });
  }
}

for (const [target, base] of [["list", ADDED], ["card", OPEN]]) {
  test("the " + target + " byte budget accepts exactly 1 MiB and refuses a valid multibyte JSON answer over it", async () => {
    const exact = base + " ".repeat(JSON_LIMIT - Buffer.byteLength(base));
    const client = createApiClient({ send: answering(new Response(exact)).send });
    await (target === "list" ? client.cards() : client.card("alba-1"));
    const body = JSON.stringify({ ...JSON.parse(base), padding: "é".repeat(JSON_LIMIT / 2) });
    assert.ok(body.length < JSON_LIMIT);
    assert.ok(Buffer.byteLength(body) > JSON_LIMIT);
    const over = createApiClient({ send: answering(new Response(body)).send });
    await assert.rejects(target === "list" ? over.cards() : over.card("alba-1"), { name: "Refused" });
  });
}

function counted(cards, mails) {
  const body = JSON.parse(ADDED);
  const card = firstCard(body);
  body.projects = [
    { lanes: [{ cards: Array.from({ length: Math.min(cards, 100) }, (_, i) => ({ ...card, id: "first-" + i })) }] },
    { lanes: [{ cards: Array.from({ length: Math.max(cards - 100, 0) }, (_, i) => ({ ...card, id: "second-" + i })) }] },
  ];
  body.plainMail = Array.from({ length: mails }, () => ({}));
  return JSON.stringify(body);
}

test("200 cards across projects and lanes and 20 plain mails are accepted", async () => {
  const result = await createApiClient({ send: answering(list(counted(200, 20))).send }).cards();
  assert.equal(result.cards.length, 200);
});

for (const [cards, mails] of [[201, 20], [200, 21]]) {
  test(cards + " cards and " + mails + " plain mails are refused as one whole answer", async () => {
    await assert.rejects(createApiClient({ send: answering(list(counted(cards, mails))).send }).cards(), { name: "Refused" });
  });
}

for (const [key, value] of [
  ...["about", "context", "ascii", "skip", "due", "pick_why", "you_do", "note", "lane", "card"].map((key) => [key, 7]),
  ["qd", "card/2"], ["door", "other"], ["kind", "other"],
  ["category", []], ["category", ["design", "strategy", "high-risk"]], ["category", [7]], ["category", ["other"]],
  ["words", {}], ["words", [["one"]]], ["words", [["one", 2]]],
  ["learn", {}], ["learn", [{ label: "read", url: 7 }]], ["learn", [{ url: "https://example.com" }]],
  ["commands", {}], ["commands", [{ where: 7, run: "test" }]], ["commands", [{ where: "here" }]],
  ["principles", {}], ["principles", { follows: "yes", departs: 7 }],
  ["options", [{}]], ["options", [{ label: "one" }]], ["options", Array.from({ length: 5 }, () => ({ label: "many" }))],
  ...["does", "cost", "risk", "undo", "tradeoff", "why"].map((key) => ["options", [{ label: "one", [key]: 7 }, { label: "two" }]]),
  ["options", [{ label: "one", pick: "yes" }, { label: "two" }]],
  ["options", [{ label: "one", pros: [7] }, { label: "two" }]],
  ["options", [{ label: "one", cons: "none" }, { label: "two" }]],
]) {
  test("a one-card v1 field with wrong type or shape is refused: " + key + " " + JSON.stringify(value), async () => {
    const body = changed((body) => { body.card[key] = value; });
    await assert.rejects(createApiClient({ send: answering(one(body)).send }).card("shelvorn-5"), { name: "Refused" });
  });
}

test("an old in-flight list cannot restore its ETag after a one-card authentication failure", async () => {
  let finish;
  const calls = [];
  const client = createApiClient({ send: async (path, init) => {
    calls.push({ path, init });
    if (calls.length === 1) return new Promise((resolve) => { finish = resolve; });
    return path === "/captain/cards" ? list() : failure(401, "sign in required");
  } });
  const pending = client.cards();
  await assert.rejects(client.card("alba-1"), (error) => error instanceof SignInRequired);
  finish(list());
  await assert.rejects(pending, (error) => error instanceof SignInRequired);
  await client.cards();
  assert.equal("If-None-Match" in calls[2].init.headers, false);
});

for (const due of [null, "not a time", "2026-11-02", "2026-99-99T00:00:00Z"]) {
  test("one-card due must be an optional v1 date-time string, not " + JSON.stringify(due), async () => {
    await assert.rejects(createApiClient({ send: answering(one(changed((body) => { body.card.due = due; }))).send }).card("shelvorn-5"), { name: "Refused" });
  });
}

for (const id of ["..", ".", "a/b", "a\\b", "\\a", "a%2Fb", "a?b", "a#b", "", "a".repeat(65), "é", "-a", "a b"]) {
  test("a forbidden one-card id is refused before any send: " + JSON.stringify(id), async () => {
    const { calls, send } = answering(one(OPEN));
    const client = createApiClient({ send });
    let failure;
    try { await client.card(id); } catch (error) { failure = error; }
    assert.equal(calls.length, 0);
    assert.equal(failure?.name, "Refused");
  });

  test("a forbidden listed id refuses the entire list: " + JSON.stringify(id), async () => {
    const malformed = broken((body) => { firstCard(body).id = id; });
    await assert.rejects(createApiClient({ send: answering(list(malformed)).send }).cards(), { name: "Refused" });
  });
}

const recorded = (name) => {
  const file = JSON.parse(payload("mail/" + name));
  const headers = { ...file.headers };
  delete headers["Content-Length"];
  return new Response(file.body === null ? null : JSON.stringify(file.body), { status: file.status, headers });
};
const MAIL_ETAG = JSON.parse(payload("mail/list-5-threads.json")).headers.ETag;
const MAIL_ERRORS = [["error-400-bad-ref.json", "Refused"], ["error-401-sign-in-required.json", "SignInRequired"], ["error-403-session-refused.json", "SignInRequired"], ["error-404-no-thread.json", "NotFound"], ["error-503-request-unavailable.json", "Unavailable"]];

test("the Mail list is read by GET at /captain/mail on the same origin with the session cookie, no If-None-Match the first time, threads in the server's order", async () => {
  const { calls, send } = answering(recorded("list-5-threads.json"));
  const listing = await createApiClient({ send }).mailList();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/captain/mail");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal("If-None-Match" in calls[0].init.headers, false);
  assert.deepEqual(listing.threads.map((thread) => thread.ref), ["MT-5", "MT-4", "MT-3", "MT-2", "MT-1"]);
});

test("the second Mail list read sends the held ETag and a 304 returns the held list; a changed list replaces it and its ETag", async () => {
  const { calls, send } = answering(recorded("list-5-threads.json"), recorded("list-not-modified-304.json"), recorded("list-empty.json"), recorded("list-empty.json"));
  const client = createApiClient({ send });
  const first = await client.mailList();
  const second = await client.mailList();
  assert.equal(calls[1].init.headers["If-None-Match"], MAIL_ETAG);
  assert.deepEqual(second, first);
  const third = await client.mailList();
  assert.deepEqual(third, { threads: [], truncated: false });
  await client.mailList();
  assert.equal(calls[3].init.headers["If-None-Match"], JSON.parse(payload("mail/list-empty.json")).headers.ETag);
  assert.notEqual(calls[3].init.headers["If-None-Match"], MAIL_ETAG);
});

test("a Mail thread is read by GET at /captain/mail/<ref> and keeps its left-out count; its answer holds no ETag", async () => {
  const { calls, send } = answering(recorded("thread-omitted-older-mails.json"), recorded("thread-omitted-older-mails.json"));
  const client = createApiClient({ send });
  const read = await client.mailThread("MT-5");
  assert.equal(calls[0].path, "/captain/mail/MT-5");
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual([read.mails.length, read.omitted, read.mails[0].ref], [50, 10, "MT-5.11"]);
  await client.mailThread("MT-5");
  assert.equal("If-None-Match" in calls[1].init.headers, false);
});

test("a Mail read does not take the token or the freshness time from its answer, as the OpenAPI says to ignore them when only reading", async () => {
  const { send } = answering(recorded("list-5-threads.json"), recorded("thread-html-only.json"));
  const client = createApiClient({ send });
  await client.mailList();
  await client.mailThread("MT-2");
  assert.equal(client.freshUntil(), null);
});

for (const ref of ["", "MT-0", "MT-01", "mt-1", "MT-1.2", "MT-1234567890", "../x", "MT-1/..", "MT-1?x", "MT-1#x", "MT-1 ", "PG-1", "a%2Fb"]) {
  test("a Mail ref that is not a thread code is refused before any send: " + JSON.stringify(ref), async () => {
    const { calls, send } = answering(recorded("thread-html-only.json"));
    let failure;
    try { await createApiClient({ send }).mailThread(ref); } catch (error) { failure = error; }
    assert.equal(calls.length, 0);
    assert.equal(failure?.name, "Refused");
  });
}

for (const [file, name] of MAIL_ERRORS) {
  test("the recorded " + file + " reads as " + name + " on the list and on a thread, as the cards errors do", async () => {
    const { send } = answering(recorded(file), recorded(file));
    const client = createApiClient({ send });
    await assert.rejects(client.mailList(), { name });
    await assert.rejects(client.mailThread("MT-1"), { name });
  });
}

test("a Mail answer that is not the contract's is refused as unreadable", async () => {
  const wrong = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  await assert.rejects(createApiClient({ send: answering(wrong({})).send }).mailList(), { name: "Refused" });
  await assert.rejects(createApiClient({ send: answering(wrong({ thread: {} })).send }).mailThread("MT-1"), { name: "Refused" });
  await assert.rejects(createApiClient({ send: answering(new Response("not json", { status: 200 })).send }).mailList(), { name: "Refused" });
});

test("a 401 or 403 on Mail, and discard, drop the held Mail list so no If-None-Match is sent after", async () => {
  const { calls, send } = answering(recorded("list-5-threads.json"), recorded("error-403-session-refused.json"), recorded("list-5-threads.json"), recorded("list-5-threads.json"), recorded("list-5-threads.json"));
  const client = createApiClient({ send });
  await client.mailList();
  await assert.rejects(client.mailList(), { name: "SignInRequired" });
  await client.mailList();
  assert.equal("If-None-Match" in calls[2].init.headers, false);
  await client.mailList();
  assert.equal(calls[3].init.headers["If-None-Match"], MAIL_ETAG);
  client.discard();
  await client.mailList();
  assert.equal("If-None-Match" in calls[4].init.headers, false);
});

test("Mail reads go through the session hook as their own kind, automatic or not", async () => {
  const { send } = answering(recorded("list-5-threads.json"), recorded("thread-html-only.json"));
  const client = createApiClient({ send });
  const kinds = [];
  client.bindSession({ request: (meta, perform) => (kinds.push(meta), perform()) });
  await client.mailList(true);
  await client.mailThread("MT-2");
  assert.deepEqual(kinds, [{ kind: "mail", automatic: true }, { kind: "mail", automatic: false }]);
});

test("a refresh event names the lists it is for: cards, mail, both or neither, and unreadable data is for both", () => {
  const streams = [];
  const client = createApiClient({ send: answering().send, openEvents: (address) => (streams.push(fakeStream(address)), streams[0]) });
  const heard = [];
  client.refreshes((lists) => heard.push(lists));
  const refresh = streams[0].handlers.get("refresh");
  refresh({ data: '{"cards":true,"chats":true,"mail":true}' });
  refresh({ data: '{"cards":true,"chats":true}' });
  refresh({ data: '{"cards":false,"chats":true,"mail":true}' });
  refresh({ data: '{"cards":false,"chats":true,"mail":false}' });
  refresh({ data: '{"cards":false,"chats":true}' });
  refresh({ data: "not json" });
  assert.deepEqual(heard, [{ cards: true, mail: true }, { cards: true, mail: false }, { cards: false, mail: true }, { cards: true, mail: true }]);
});
