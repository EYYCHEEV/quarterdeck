import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle() {
  const contents = ["api-client", "server-source", "session"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createApiClient, createServerSource, readSession, writeSession } = await bundle();

const text = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const LIST = JSON.parse(text("list-added.json"));
const ANSWERED = text("answer/answer-200-current.json");
const COMMENTED = text("answer/comment-200.json");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const ETAG = '"5f0c6d3a9b1e47d28c4a0e7b3f6d91a2c8e5b04d7a3f16c9e2b8d5a07c4f1e36"';
const DRAFT = "chat.draft.iris";

const listed = (csrf) => () => new Response(JSON.stringify(csrf === null ? Object.fromEntries(Object.entries(LIST).filter(([key]) => key !== "csrf")) : { ...LIST, csrf }), { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const unchanged = () => new Response(null, { status: 304, headers: { ETag: ETAG } });
const json = (body) => () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

function serve(...steps) {
  const calls = [];
  const queue = [...steps];
  const send = (path, init) => {
    calls.push([init.method, path, init.headers?.["If-None-Match"] ?? null, init.body ? JSON.parse(init.body).csrf : null]);
    const step = queue.shift();
    return Promise.resolve(step ? step() : new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
  };
  return { calls, client: createApiClient({ send, openEvents: () => ({ addEventListener: () => undefined, close: () => undefined }) }) };
}

async function afterEightUnchangedReads(...more) {
  const served = serve(listed("token-from-the-first-list"), ...Array(8).fill(unchanged), ...more);
  for (let read = 0; read < 9; read += 1) await served.client.cards();
  return served;
}

const FRESH_READ = ["GET", "/captain/cards", null, null];

test("after a list and 8 unchanged reads, an answer posts the token of a full list read sent right before it, with no If-None-Match, and posts once", async () => {
  const { client, calls } = await afterEightUnchangedReads(listed("fresh-token"), json(ANSWERED));
  await client.answer("alba-1", { rev: 3, pick: "A", note: "" });
  assert.deepEqual(calls.slice(9), [FRESH_READ, ["POST", "/captain/cards/alba-1/answer", null, "fresh-token"]]);
});

test("after a list and 8 unchanged reads, a comment posts the token of a full list read sent right before it, and posts once", async () => {
  const { client, calls } = await afterEightUnchangedReads(listed("fresh-token"), json(COMMENTED));
  await client.comment("alba-1", { text: "Five fits the phone.", requestId: "req-1" });
  assert.deepEqual(calls.slice(9), [FRESH_READ, ["POST", "/captain/cards/alba-1/comments", null, "fresh-token"]]);
});

test("after a list and 8 unchanged reads, the Sign out token comes from a full list read made for it", async () => {
  const { client, calls } = await afterEightUnchangedReads(listed("fresh-token"));
  assert.equal(await client.signOutToken(), "fresh-token");
  assert.deepEqual(calls.slice(9), [FRESH_READ]);
});

test("a token read gives its token to one POST only: the next answer reads again", async () => {
  const { client, calls } = serve(listed("first"), listed("second"), json(ANSWERED), listed("third"), json(ANSWERED));
  await client.cards();
  await client.answer("alba-1", { rev: 3, pick: "A", note: "" });
  await client.answer("alba-1", { rev: 3, pick: "B", note: "" });
  assert.deepEqual(calls.map(([method, , , csrf]) => [method, csrf]), [["GET", null], ["GET", null], ["POST", "second"], ["GET", null], ["POST", "third"]]);
});

function serveSource(...steps) {
  const calls = [];
  const queue = [...steps];
  const timers = new Set();
  const heard = [];
  let release = () => undefined;
  const send = (path, init) => {
    calls.push([init.method, path, init.headers?.["If-None-Match"] ?? null, init.body ? JSON.parse(init.body).csrf : null]);
    const step = queue.shift();
    if (step === "hold") return new Promise((done) => (release = () => done(unchanged())));
    return Promise.resolve(step ? step() : new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
  };
  const schedule = (run, delay) => {
    const timer = { run, delay };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  const posted = [];
  let formSent = () => undefined;
  const postedForm = new Promise((done) => (formSent = done));
  const pages = { goTo: () => undefined, postForm: (action, fields) => { posted.push([action, fields]); formSent(); } };
  const source = createServerSource(createApiClient({ send, openEvents: () => ({ addEventListener: () => undefined, close: () => undefined }) }), () => NOW, schedule, pages);
  source.watch((failure) => heard.push(failure?.name ?? "change"));
  return { source, calls, timers, heard, posted, postedForm, release: () => release() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a conditional list read already in flight when he answers is not used for the token: the answer reads the list again in full", async () => {
  const { source, calls, release } = serveSource(listed("first"), "hold", listed("fresh-token"), json(ANSWERED));
  await source.load();
  const checking = source.load();
  await tick();
  await source.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "", version: 3 });
  release();
  await checking;
  assert.deepEqual(calls, [FRESH_READ, ["GET", "/captain/cards", ETAG, null], FRESH_READ, ["POST", "/captain/cards/alba-1/answer", null, "fresh-token"]]);
});

test("when the token read gives no token, Sign out posts nothing, clears the local values, shows signed out, and plans no list check that would bring the Queue back", async () => {
  const { source, timers, heard, posted, postedForm } = serveSource(listed("first"), listed(null));
  await source.load();
  writeSession(DRAFT, { text: "Unsent words", quote: null, files: [] });
  await Promise.race([source.signOut(), postedForm]);
  assert.deepEqual([posted, readSession(DRAFT, null), heard.at(-1), timers.size], [[], null, "SignInRequired", 0]);
});
