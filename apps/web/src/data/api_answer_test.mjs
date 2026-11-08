import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { createApiClient } = await loadTs("src/data/api-client.ts");

const text = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const LIST = text("list-fixed-only.json");
const CURRENT = text("answer/answer-200-current.json");
const STALE = text("answer/answer-200-stale.json");
const COMMENT = text("answer/comment-200.json");
const REFUSED = text("answer/request-refused.json");
const ETAG = '"5f0c6d3a9b1e47d28c4a0e7b3f6d91a2c8e5b04d7a3f16c9e2b8d5a07c4f1e36"';
const freshToken = (n) => "sample-csrf-fresh-" + n;

const listWith = (changes = {}) => new Response(JSON.stringify({ ...JSON.parse(LIST), ...changes }), { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const list = () => new Response(LIST, { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const json = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "application/json" } });
const notModified = () => new Response(null, { status: 304, headers: { ETag: ETAG } });
const fresh = (n) => listWith({ csrf: freshToken(n) });

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
const gets = (calls) => calls.filter((call) => call.init.method === "GET");
const ANSWER = { rev: 3, pick: "A", note: "Yes." };
const COMMENT_IN = { text: "Five fits the phone.", requestId: "req-1" };

async function ready(...steps) {
  const run = scripted(list(), ...steps);
  const client = createApiClient({ send: run.send });
  await client.cards();
  return { ...run, client };
}

test("an answer is one POST to the card's answer path on the same origin, never followed on a redirect, with the token from a fresh list read in the body", async () => {
  const { calls, client } = await ready(fresh(1), json(CURRENT));
  const receipt = await client.answer("alba-1", ANSWER);
  assert.equal(posts(calls).length, 1);
  const [post] = posts(calls);
  assert.equal(post.path, "/captain/cards/alba-1/answer");
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.credentials, "same-origin");
  assert.equal(post.init.redirect, "manual");
  assert.deepEqual(post.init.headers, { Accept: "application/json", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(post.init.body), { rev: 3, pick: "A", note: "Yes.", csrf: freshToken(1) });
  assert.deepEqual(receipt, { message: "Got it: alba-1 A at 9:05 AM ET", stale: false, rev: 3 });
});

test("the reads keep redirect error, and only the POSTs use manual", async () => {
  const { calls, client } = await ready(list(), json(CURRENT));
  await client.answer("alba-1", ANSWER);
  assert.deepEqual(gets(calls).map((call) => call.init.redirect), ["error", "error"]);
});

test("a valid card id goes into the path as it is, for an answer and for a comment", async () => {
  const { calls, client } = await ready(list(), json(CURRENT), list(), json(COMMENT));
  await client.answer("Bot-a-3", ANSWER);
  await client.comment("Bot-a-3", COMMENT_IN);
  assert.deepEqual(posts(calls).map((call) => call.path), ["/captain/cards/Bot-a-3/answer", "/captain/cards/Bot-a-3/comments"]);
});

test("an answer for an older revision comes back stale", async () => {
  const { client } = await ready(list(), json(STALE));
  const receipt = await client.answer("alba-1", { rev: 2, pick: "B", note: "" });
  assert.deepEqual([receipt.stale, receipt.rev], [true, 2]);
});

test("a token held from the list or from a receipt is never posted: each answer posts the token of the list read sent right before it", async () => {
  const { calls, client } = await ready(fresh(1), json(CURRENT), fresh(2), json(STALE));
  await client.answer("alba-1", ANSWER);
  await client.answer("alba-1", { rev: 2, pick: "B", note: "" });
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST"]);
  assert.deepEqual(posts(calls).map((call) => JSON.parse(call.init.body).csrf), [freshToken(1), freshToken(2)]);
});

test("a comment receipt's token and an answer receipt's token are never posted: each POST carries the token of the list read sent right before it", async () => {
  const { calls, client } = await ready(fresh(1), json(COMMENT), fresh(2), json(CURRENT), fresh(3), json(COMMENT));
  await client.comment("alba-1", COMMENT_IN);
  await client.answer("alba-1", ANSWER);
  await client.comment("alba-1", { text: "Again.", requestId: "req-2" });
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST", "GET", "POST"]);
  assert.deepEqual(posts(calls).map((call) => JSON.parse(call.init.body).csrf), [freshToken(1), freshToken(2), freshToken(3)]);
});

test("a token from a card read is not posted: the answer posts the token of the list read sent right before it", async () => {
  const card = JSON.parse(text("card-open.json"));
  const run = scripted(json(JSON.stringify({ ...card, csrf: "sample-csrf-from-card", freshUntil: 1793836800.9 })), fresh(1), json(CURRENT));
  const client = createApiClient({ send: run.send });
  await client.card("alba-1");
  assert.equal(client.freshUntil(), 1793836800.9);
  await client.answer("alba-1", ANSWER);
  assert.deepEqual(run.calls.map((call) => [call.init.method, call.path]), [["GET", "/captain/cards/alba-1"], ["GET", "/captain/cards"], ["POST", "/captain/cards/alba-1/answer"]]);
  assert.equal(JSON.parse(posts(run.calls)[0].init.body).csrf, freshToken(1));
});

test("after a POST that did not succeed, the next POST reads the list again without If-None-Match and uses that read's token", async () => {
  const { calls, client } = await ready(fresh(1), json(REFUSED, 400), fresh(2), json(CURRENT));
  await assert.rejects(client.answer("alba-1", ANSWER), { name: "Refused" });
  await client.answer("alba-1", ANSWER);
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST"]);
  assert.equal("If-None-Match" in calls[1].init.headers, false);
  assert.equal("If-None-Match" in calls[3].init.headers, false);
  assert.equal(JSON.parse(calls[4].init.body).csrf, freshToken(2));
});

test("with no token held the answer first reads the list, then sends once", async () => {
  const run = scripted(list(), json(CURRENT));
  const client = createApiClient({ send: run.send });
  await client.answer("alba-1", ANSWER);
  assert.deepEqual(run.calls.map((call) => [call.init.method, call.path]), [["GET", "/captain/cards"], ["POST", "/captain/cards/alba-1/answer"]]);
});

test("when the list gives no token nothing is sent and the answer is refused", async () => {
  const bare = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(LIST)).filter(([key]) => key !== "csrf" && key !== "freshUntil")));
  const run = scripted(json(bare));
  const client = createApiClient({ send: run.send });
  await assert.rejects(client.answer("alba-1", ANSWER), { name: "Refused" });
  assert.equal(posts(run.calls).length, 0);
});

test("when the list cannot be read first, the answer fails as the read did and nothing is sent", async () => {
  const run = scripted(new TypeError("offline"));
  const client = createApiClient({ send: run.send });
  await assert.rejects(client.answer("alba-1", ANSWER), { name: "Unavailable" });
  assert.equal(posts(run.calls).length, 0);
  const signedOut = scripted(json(JSON.stringify({ error: "sign in required" }), 401));
  await assert.rejects(createApiClient({ send: signedOut.send }).answer("alba-1", ANSWER), { name: "SignInRequired" });
  assert.equal(posts(signedOut.calls).length, 0);
});

test("freshUntil is null until a 200 gives one, follows the newest 200 except the read made before a POST, survives a failed POST, and is dropped on a sign-in failure", async () => {
  const read = () => listWith({ freshUntil: 1793836900 });
  const run = scripted(list(), read(), json("", 503), read(), json(CURRENT), read(), json(JSON.stringify({ error: "sign in required" }), 401));
  const client = createApiClient({ send: run.send });
  assert.equal(client.freshUntil(), null);
  await client.cards();
  assert.equal(client.freshUntil(), 1793836800.25);
  await assert.rejects(client.answer("alba-1", ANSWER), { name: "NotConfirmed" });
  assert.equal(client.freshUntil(), 1793836800.25);
  await client.answer("alba-1", ANSWER);
  assert.equal(client.freshUntil(), 1793836800.5);
  await assert.rejects(client.answer("alba-1", ANSWER), { name: "SignInRequired" });
  assert.equal(client.freshUntil(), null);
});

test("what fails the local checks sends nothing, not even a read of the list", async () => {
  const bad = [
    { rev: 3, pick: "approve", note: "" },
    { rev: 3, pick: "a", note: "" },
    { rev: 3, pick: "A", note: "x".repeat(4001) },
    { rev: 1.5, pick: "A", note: "" },
    { rev: 3, pick: "A", note: 4 },
  ];
  for (const input of bad) {
    const run = scripted();
    await assert.rejects(createApiClient({ send: run.send }).answer("alba-1", input), { name: "Refused" });
    assert.equal(run.calls.length, 0);
  }
  for (const input of [{ text: "", requestId: "r" }, { text: "x", requestId: "bad id" }, { text: "x".repeat(4001), requestId: "r" }]) {
    const run = scripted();
    await assert.rejects(createApiClient({ send: run.send }).comment("alba-1", input), { name: "Refused" });
    assert.equal(run.calls.length, 0);
  }
});

const BAD_IDS = ["..", ".", "a/b", "a\\b", "\\a", "a%2Fb", "a?b", "a#b", "", "a".repeat(65), "é", "-a", "a b", "bad_id"];

for (const id of BAD_IDS) {
  test("a forbidden id is refused for an answer and for a comment, and nothing is sent, not even the list read: " + JSON.stringify(id), async () => {
    for (const act of [(client) => client.answer(id, ANSWER), (client) => client.comment(id, COMMENT_IN)]) {
      const bare = scripted();
      await assert.rejects(act(createApiClient({ send: bare.send })), { name: "Refused" });
      assert.equal(bare.calls.length, 0);
      const held = await ready(json(CURRENT));
      const before = held.calls.length;
      await assert.rejects(act(held.client), { name: "Refused" });
      assert.equal(held.calls.length, before);
    }
  });
}

const opaque = () => {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  return response;
};

for (const [label, step, name] of [
  ["a 303 to the step-up with an empty body", () => new Response(null, { status: 303, headers: { Location: "/captain/step-up?next=/captain/chat" } }), "FreshSignInRequired"],
  ["an opaque redirect, which is what a browser gives for a redirect it was told not to follow", opaque, "FreshSignInRequired"],
  ["a 302", () => new Response(null, { status: 302, headers: { Location: "/somewhere" } }), "NotConfirmed"],
  ["a 400", () => json(REFUSED, 400), "Refused"],
  ["a 401", () => json(JSON.stringify({ error: "sign in required" }), 401), "SignInRequired"],
  ["a 403", () => json(REFUSED, 403), "SignInRequired"],
  ["a 404", () => json("", 404), "NotFound"],
  ["a 405", () => json("", 405), "Refused"],
  ["a 413", () => json("too big", 413), "Refused"],
  ["a 429", () => json("<p>slow down</p>", 429), "RateLimited"],
  ["a 500", () => json("oops", 500), "NotConfirmed"],
  ["a 503", () => json("<p>later</p>", 503), "NotConfirmed"],
  ["a 201", () => json("{}", 201), "NotConfirmed"],
  ["a thrown network error", () => new TypeError("Failed to fetch"), "NotConfirmed"],
]) {
  test("an answer that meets " + label + " comes back as " + name + ", with exactly one POST and no retry", async () => {
    const { calls, client } = await ready(list(), step);
    await assert.rejects(client.answer("alba-1", ANSWER), { name });
    assert.equal(posts(calls).length, 1);
    assert.equal(calls.length, 3);
  });
}

test("the body of a 303, 429, 503 or any other non-200 answer is never read", async () => {
  for (const status of [303, 400, 401, 403, 404, 405, 429, 500, 503]) {
    const response = json("not read", status);
    const { client } = await ready(list(), () => response);
    await assert.rejects(client.answer("alba-1", ANSWER));
    assert.equal(response.bodyUsed, false, String(status));
  }
});

test("a 200 whose receipt cannot be read is not confirmed, because the answer may be out; it is sent once", async () => {
  const big = JSON.stringify({ ...JSON.parse(CURRENT), message: "x".repeat(5000) });
  const bare = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(CURRENT)).filter(([key]) => key !== "rev")));
  for (const body of ["Got it", "[]", bare, big, ""]) {
    const { calls, client } = await ready(list(), json(body));
    await assert.rejects(client.answer("alba-1", ANSWER), { name: "NotConfirmed" });
    assert.equal(posts(calls).length, 1);
  }
});

test("a receipt with an extra field is read, and the extra field is not passed on", async () => {
  const { client } = await ready(list(), json(JSON.stringify({ ...JSON.parse(CURRENT), later: { a: 1 } })));
  assert.deepEqual(Object.keys(await client.answer("alba-1", ANSWER)).sort(), ["message", "rev", "stale"]);
});

for (const status of [401, 403]) {
  const body = status === 401 ? JSON.stringify({ error: "sign in required" }) : REFUSED;
  test("a " + status + " on a POST drops the token, the held list and its ETag, and sends no read after it", async () => {
    for (const act of [(client) => client.answer("alba-1", ANSWER), (client) => client.comment("alba-1", COMMENT_IN)]) {
      const { calls, client } = await ready(list(), json(body, status), list());
      await assert.rejects(act(client), { name: "SignInRequired" });
      assert.equal(client.freshUntil(), null);
      assert.equal(calls.length, 3);
      await client.cards();
      assert.equal("If-None-Match" in calls[3].init.headers, false);
    }
  });
}

test("a 200 is returned even when another read saw a sign-in failure while the POST was in flight, and its freshUntil is not kept", async () => {
  let release = () => undefined;
  const waiting = new Promise((resolve) => (release = resolve));
  let sent = () => undefined;
  const posting = new Promise((resolve) => (sent = resolve));
  const { calls, client } = await ready(list(), () => { sent(); return waiting; }, json(JSON.stringify({ error: "sign in required" }), 401), list(), json(CURRENT));
  const answering = client.answer("alba-1", ANSWER);
  await posting;
  await assert.rejects(client.cards(), { name: "SignInRequired" });
  release(json(CURRENT));
  const receipt = await answering;
  assert.equal(receipt.rev, 3);
  assert.equal(client.freshUntil(), null);
  await client.answer("alba-1", ANSWER);
  const last = calls.slice(-2);
  assert.deepEqual(last.map((call) => call.init.method), ["GET", "POST"]);
  assert.equal("If-None-Match" in last[0].init.headers, false);
});

test("an answer's token read takes over the held list: the next read is conditional on the token read's ETag and a 304 returns the token read's list", async () => {
  const other = new Response(LIST, { status: 200, headers: { "Content-Type": "application/json", ETag: '"other-etag"' } });
  const run = scripted(list(), other, json(CURRENT), notModified());
  const client = createApiClient({ send: run.send });
  const before = await client.cards();
  await client.answer("alba-1", ANSWER);
  const after = await client.cards();
  assert.equal(run.calls[3].init.headers["If-None-Match"], '"other-etag"');
  assert.deepEqual(after, before);
});

test("a comment is one POST to the card's comments path with exactly text, requestId and the token, and it resolves with nothing", async () => {
  const { calls, client } = await ready(fresh(1), json(COMMENT));
  const result = await client.comment("alba-1", COMMENT_IN);
  assert.equal(result, undefined);
  const [post] = posts(calls);
  assert.equal(post.path, "/captain/cards/alba-1/comments");
  assert.equal(post.init.redirect, "manual");
  assert.equal(post.init.credentials, "same-origin");
  assert.deepEqual(post.init.headers, { Accept: "application/json", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(post.init.body), { text: "Five fits the phone.", requestId: "req-1", csrf: freshToken(1) });
});

for (const [label, step, name] of [
  ["a 400", () => json(REFUSED, 400), "Refused"],
  ["a 403", () => json(REFUSED, 403), "SignInRequired"],
  ["a 429", () => json("", 429), "RateLimited"],
  ["a 503", () => json("", 503), "NotConfirmed"],
  ["a thrown network error", () => new TypeError("Failed to fetch"), "NotConfirmed"],
  ["a 200 that is not a receipt", () => json(JSON.stringify({ status: "queued", csrf: "t", freshUntil: 1 })), "NotConfirmed"],
]) {
  test("a comment that meets " + label + " comes back as " + name + ", with exactly one POST and no retry", async () => {
    const { calls, client } = await ready(list(), step);
    await assert.rejects(client.comment("alba-1", COMMENT_IN), { name });
    assert.equal(posts(calls).length, 1);
    assert.equal(calls.length, 3);
  });
}

test("the same comment sent twice is two POSTs only when the caller asks twice, each with the token of the list read sent right before it", async () => {
  const { calls, client } = await ready(fresh(1), json(COMMENT), fresh(2), json(COMMENT));
  await client.comment("alba-1", COMMENT_IN);
  await client.comment("alba-1", COMMENT_IN);
  assert.deepEqual(posts(calls).map((call) => JSON.parse(call.init.body).csrf), [freshToken(1), freshToken(2)]);
});

for (const [label, step, name] of [
  ["a 400", () => json(REFUSED, 400), "Refused"],
  ["a 401", () => json(JSON.stringify({ error: "sign in required" }), 401), "SignInRequired"],
  ["a 403", () => json(REFUSED, 403), "SignInRequired"],
  ["a 404", () => json("", 404), "NotFound"],
  ["a 405", () => json("", 405), "Refused"],
  ["a 429", () => json("", 429), "Refused"],
  ["a 500", () => json("", 500), "Unavailable"],
  ["a 503", () => json("", 503), "Unavailable"],
  ["a thrown network error", () => new TypeError("Failed to fetch"), "Unavailable"],
]) {
  test("when the read of the list before an answer or a comment meets " + label + ", it fails as " + name + " and no POST is sent", async () => {
    for (const act of [(client) => client.answer("alba-1", ANSWER), (client) => client.comment("alba-1", COMMENT_IN)]) {
      const { calls, client } = await ready(step);
      await assert.rejects(act(client), { name });
      assert.equal(posts(calls).length, 0);
      assert.equal(calls.length, 2);
    }
  });
}

test("when the read before a POST gives no token, the token held from the earlier list is not used: nothing is sent and the answer and the comment are refused", async () => {
  for (const act of [(client) => client.answer("alba-1", ANSWER), (client) => client.comment("alba-1", COMMENT_IN)]) {
    const { calls, client } = await ready(listWith({ csrf: undefined }));
    await assert.rejects(act(client), { name: "Refused" });
    assert.equal(posts(calls).length, 0);
    assert.equal(calls.length, 2);
  }
});

test("the read before a POST goes to the session as his own token read, and the POST as his own post", async () => {
  const run = scripted(fresh(1), json(CURRENT));
  const client = createApiClient({ send: run.send });
  const seen = [];
  client.bindSession({ request: (meta, perform) => { seen.push(meta); return perform(); }, prepare: async () => undefined });
  await client.answer("alba-1", ANSWER);
  assert.deepEqual(seen, [{ kind: "token", automatic: false }, { kind: "post", automatic: false }]);
});
