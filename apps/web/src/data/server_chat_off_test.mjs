import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

async function bundle(flag) {
  const contents = ["api-client", "server-source"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
  const define = { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' };
  if (flag !== undefined) define.__QD_CHAT__ = JSON.stringify(flag);
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const builds = [["off", await bundle("off")], ["unset", await bundle(undefined)]];
const { createApiClient } = await loadTs("src/data/api-client.ts");

const text = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const LISTING = JSON.parse(text("list-added.json"));
const NOW = Date.parse("2026-11-06T01:00:00-05:00");

const json = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const isChatPath = (path) => path.startsWith("/captain/api/chat");

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

function serve(lib) {
  const time = fakeClock();
  const calls = [];
  const streams = [];
  let serial = 0;
  const send = async (path, init) => {
    calls.push({ method: init.method, path });
    if (path === "/captain/cards") {
      serial += 1;
      return json({ ...structuredClone(LISTING), csrf: "token-" + serial }, 200, { ETag: '"list-' + serial + '"' });
    }
    return json("{}", 404);
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
  const source = lib.createServerSource(lib.createApiClient({ send, openEvents }), time.now, time.schedule);
  const worlds = [];
  source.watch((failure) => {
    if (!failure) void source.load().then((world) => worlds.push(world)).catch(() => undefined);
  });
  return {
    source, calls, time, streams, worlds,
    async boot() {
      worlds.push(await source.load());
      await tick();
      await tick();
      streams[0]?.open();
      await tick();
      await time.advance(5_000);
    },
    async refresh(lists) {
      streams[0].emit("refresh", JSON.stringify(lists));
      await tick();
      await time.advance(6_000);
    },
  };
}

for (const [label, lib] of builds) {
  test("flag " + label + ": no request to a chat path is ever sent, whatever the events and screens do", async () => {
    const h = serve(lib);
    await h.boot();
    const stopRows = h.source.chat.watchChats(() => undefined);
    assert.deepEqual(await h.source.chat.listChats(), []);
    const stopThread = h.source.chat.subscribe("steward", () => undefined);
    await assert.rejects(h.source.chat.openThread("steward"), (error) => error?.name === "Refused");
    await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-1" }), (error) => error?.name === "Refused");
    await h.time.advance(120_000);
    for (const lists of [{ cards: false, mail: false, chats: true }, { chats: true }, { cards: true, mail: true, chats: true }, { cards: false, mail: true, chats: true }]) {
      await h.refresh(lists);
      await h.source.chat.listChats();
    }
    await h.time.advance(120_000);
    stopRows();
    stopThread();
    assert.ok(h.calls.length > 0);
    assert.deepEqual(h.calls.filter((call) => isChatPath(call.path)), []);
  });

  test("flag " + label + ": the world's bots stay empty, as on main, so Mail's Ask lists do not change", async () => {
    const h = serve(lib);
    await h.boot();
    assert.deepEqual(h.worlds.at(-1).bots, []);
    await h.source.chat.listChats();
    await h.refresh({ cards: true, mail: true, chats: true });
    await h.time.advance(60_000);
    assert.ok(h.worlds.length > 0);
    for (const world of h.worlds) assert.deepEqual(world.bots, []);
    assert.deepEqual((await h.source.load()).bots, []);
  });
}

const LIST = text("list-fixed-only.json");
const ETAG = '"5f0c6d3a9b1e47d28c4a0e7b3f6d91a2c8e5b04d7a3f16c9e2b8d5a07c4f1e36"';

for (const [kind, call] of [["answer", (client) => client.answer("alba-1", { rev: 3, pick: "A", note: "Yes." })], ["comment", (client) => client.comment("alba-1", { text: "Five fits the phone.", requestId: "req-1" })]]) {
  test("the " + kind + " POST carries an abort signal and sets exactly one timer of twenty seconds", async () => {
    const calls = [];
    const scheduled = [];
    const send = async (path, init) => {
      calls.push({ path, init });
      if (init.method === "POST") return new Promise(() => undefined);
      return new Response(LIST, { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
    };
    const client = createApiClient({ send, schedule: (run, delay) => { scheduled.push(delay); return () => undefined; } });
    await client.cards();
    const pending = call(client);
    pending.catch(() => undefined);
    for (let n = 0; n < 30 && !calls.some((one) => one.init.method === "POST"); n += 1) await tick();
    const post = calls.find((one) => one.init.method === "POST");
    assert.ok(post, "the POST was never sent");
    assert.ok(post.init.signal instanceof AbortSignal);
    assert.deepEqual(scheduled, [20_000]);
  });
}
