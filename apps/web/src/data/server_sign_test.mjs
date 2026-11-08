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

const LIST = JSON.parse(fs.readFileSync(new URL("./server-payloads/list-added.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const FIRST_TOKEN = "sample-csrf-token-not-real";
const DRAFT = "chat.draft.iris";

const list = (changes = {}) => new Response(JSON.stringify({ ...LIST, ...changes }), { status: 200, headers: { "Content-Type": "application/json" } });
const bare = () => new Response(JSON.stringify(Object.fromEntries(Object.entries(LIST).filter(([key]) => key !== "csrf" && key !== "freshUntil"))), { status: 200, headers: { "Content-Type": "application/json" } });

function serve(...steps) {
  const calls = [];
  const pages = [];
  const queue = [...steps];
  let posted = () => undefined;
  const send = async (path, init) => {
    calls.push([init.method, path]);
    return queue.shift();
  };
  const fake = {
    goTo: (url) => pages.push(["go", url]),
    postForm: (action, fields) => {
      pages.push(["post", action, fields, readSession(DRAFT, null)]);
      posted();
    },
  };
  const client = createApiClient({ send, openEvents: () => ({ addEventListener: () => undefined, close: () => undefined }) });
  const source = createServerSource(client, () => NOW, () => () => undefined, fake);
  const post = () => new Promise((done) => (posted = done));
  return { source, calls, pages, post };
}

test("Sign in goes to the sign-in page and sends no request", () => {
  const { source, calls, pages } = serve();
  source.startSignIn();
  assert.deepEqual([pages, calls], [[["go", "/captain/login"]], []]);
});

test("with a held token, Sign out still reads a fresh token first, clears the local values, then posts the fresh token once as its only field", async () => {
  const { source, calls, pages, post } = serve(list(), list({ csrf: "sample-csrf-fresh" }));
  await source.load();
  writeSession(DRAFT, { text: "Unsent words", quote: null, files: [] });
  const sent = post();
  void source.signOut();
  await sent;
  assert.deepEqual(pages, [["post", "/captain/logout", { csrf: "sample-csrf-fresh" }, null]]);
  assert.deepEqual(calls, [["GET", "/captain/cards"], ["GET", "/captain/cards"]]);
});

test("with no token held, Sign out first reads the list as his action, then posts the token it gave", async () => {
  const { source, calls, pages, post } = serve(list());
  const sent = post();
  void source.signOut();
  await sent;
  assert.deepEqual([calls, pages.map(([kind, action, fields]) => [kind, action, fields])], [[["GET", "/captain/cards"]], [["post", "/captain/logout", { csrf: FIRST_TOKEN }]]]);
});

test("when the list gives no token, Sign out is not refused and nothing is posted", async () => {
  const { source, pages } = serve(bare());
  await source.signOut();
  assert.deepEqual(pages, []);
});

test("a token is used once: each Sign out reads the list again and posts the new token", async () => {
  const { source, calls, pages, post } = serve(list(), list({ csrf: "sample-csrf-first-fresh" }), list({ csrf: "sample-csrf-second" }));
  await source.load();
  const first = post();
  void source.signOut();
  await first;
  const second = post();
  void source.signOut();
  await second;
  assert.deepEqual(calls, [["GET", "/captain/cards"], ["GET", "/captain/cards"], ["GET", "/captain/cards"]]);
  assert.deepEqual(pages.map(([, , fields]) => fields.csrf), ["sample-csrf-first-fresh", "sample-csrf-second"]);
});
