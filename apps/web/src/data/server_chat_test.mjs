import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle(flag) {
  const contents = ["api-client", "server-source"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
  const define = { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' };
  if (flag !== undefined) define.__QD_CHAT__ = JSON.stringify(flag);
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const lib = await bundle("on");
const libOff = await bundle("off");
const libUnset = await bundle(undefined);

const text = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const LISTING = JSON.parse(text("list-added.json"));
const NOW = Date.parse("2026-11-06T01:00:00-05:00");

const json = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const named = (name) => (error) => error?.name === name;
const refusedWith = (words) => (error) => error?.name === "Refused" && error.message === words;

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

const stamp = (n) => "2026-11-06T00:" + String(Math.floor(n / 60) % 60).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0") + "-05:00";

function serve(chatLib = lib, { post, rows, read, thread, cards } = {}) {
  const time = fakeClock();
  let hidden = false;
  const watchers = new Set();
  const visibility = { hidden: () => hidden, watch: (run) => { watchers.add(run); return () => watchers.delete(run); } };
  const calls = [];
  const streams = [];
  const threads = new Map();
  const sent = new Map();
  let serial = 0;
  let counter = 0;
  const add = (bot, from, body, extra = {}) => {
    counter += 1;
    const made = { id: "m" + counter, from, text: body, at: stamp(counter), refs: [], ...extra };
    threads.set(bot, [...(threads.get(bot) ?? []), made]);
    return made;
  };
  for (const [bot, count] of [["steward", 3], ["iris", 2], ["quiet", 0]]) {
    threads.set(bot, []);
    for (let n = 0; n < count; n += 1) add(bot, n % 2 ? "captain" : "bot", bot + " " + n);
  }
  const rowsBody = () => {
    const all = [...threads.entries()].map(([bot, list]) => ({ bot: { id: bot, note: "the " + bot }, preview: list.at(-1)?.text ?? "", at: list.at(-1)?.at ?? "", last: list.at(-1)?.id ?? "", unread: false }));
    const full = all.filter((one) => one.last !== "").sort((a, b) => b.at.localeCompare(a.at)).concat(all.filter((one) => one.last === ""));
    return rows ? rows(full) : full;
  };
  const threadBody = (bot, before) => {
    const list = threads.get(bot) ?? [];
    const end = before ? list.findIndex((one) => one.id === before) : list.length;
    const start = Math.max(0, end - 15);
    const body = { bot: { id: bot, note: "the " + bot }, messages: list.slice(start, end), seenUpTo: null, seenAt: null, working: null, older: start > 0 };
    return thread ? thread(body) : body;
  };
  const send = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, at: time.now() - NOW });
    if (init.method === "POST" && path === "/captain/api/chat") {
      if (post) return post(body, init, { add, sent });
      if (!sent.has(body.clientId)) sent.set(body.clientId, add(body.bot, "captain", body.text, { clientId: body.clientId }));
      return json({ ...sent.get(body.clientId), uploadVerdicts: [], csrf: "token-post", freshUntil: Math.floor(NOW / 1000) + 1800 });
    }
    if (path === "/captain/cards") {
      const held = cards?.();
      if (held) return held;
      serial += 1;
      return json({ ...structuredClone(LISTING), csrf: "token-" + serial }, 200, { ETag: '"list-' + serial + '"' });
    }
    const answer = read?.(path, init, { threadBody });
    if (answer) return answer;
    if (path === "/captain/mail") return json("{}", 404);
    if (path === "/captain/api/chats") return json(rowsBody());
    if (path.startsWith("/captain/api/chat?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      return json(threadBody(query.get("bot"), query.get("before")));
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
  const source = chatLib.createServerSource(chatLib.createApiClient({ send, openEvents, schedule: time.schedule }), time.now, time.schedule, undefined, visibility);
  const worlds = [];
  source.watch((failure) => {
    if (!failure) void source.load().then((world) => worlds.push(world)).catch(() => undefined);
  });
  return {
    source, calls, time, worlds, threads, add,
    hide() { hidden = true; for (const run of [...watchers]) run(); },
    show() { hidden = false; for (const run of [...watchers]) run(); },
    requests: (from = 0) => calls.slice(from).map((call) => call.method + " " + call.path),
    chatRequests: (from = 0) => calls.slice(from).filter((call) => call.path.startsWith("/captain/api/chat")).map((call) => call.method + " " + call.path),
    credits: (from = 0) => calls.slice(from).reduce((total, call) => total + (call.method === "POST" ? 2 : 1), 0),
    async boot() {
      await source.load();
      await tick();
      await tick();
      streams[0]?.open();
      await tick();
      await time.advance(5_000);
    },
    async refresh(lists = { cards: false, mail: false, chats: true }) {
      streams[0].emit("refresh", JSON.stringify(lists));
      await tick();
    },
    async watchRows() {
      const heard = [];
      const stop = source.chat.watchChats(() => heard.push(1));
      await tick();
      await tick();
      return { heard, stop };
    },
    async watchThread(bot) {
      const seen = [];
      const stop = source.chat.subscribe(bot, (thread) => seen.push(thread));
      await tick();
      await tick();
      return { seen, stop };
    },
  };
}

const LIST = "GET /captain/api/chats";
const THREAD = (bot, before) => "GET /captain/api/chat?bot=" + bot + (before ? "&before=" + before : "");
const POST = "POST /captain/api/chat";
const TOKEN = "GET /captain/cards";
const READ = "POST /captain/api/chat/read";
const store = (body, { add, sent }) => {
  if (!sent.has(body.clientId)) sent.set(body.clientId, add(body.bot, "captain", body.text, { clientId: body.clientId }));
  return json({ ...sent.get(body.clientId), uploadVerdicts: [], csrf: "token-post", freshUntil: Math.floor(NOW / 1000) + 1800 });
};
const hang = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const never = () => new Promise(() => {});
const POSTS = (h, from) => h.calls.slice(from).filter((call) => call.method === "POST").map((call) => call.body.clientId);

function watchSend(h, pending) {
  const started = h.time.now();
  const state = { done: false, at: null, upTo: null, value: undefined, error: undefined };
  pending.then(
    (value) => Object.assign(state, { done: true, at: h.time.now() - started, upTo: h.calls.length, value }),
    (error) => Object.assign(state, { done: true, at: h.time.now() - started, upTo: h.calls.length, error }),
  );
  return state;
}

async function pass(h, milliseconds) {
  for (let spent = 0; spent < milliseconds; spent += 100) {
    await h.time.advance(100);
    for (let n = 0; n < 4; n += 1) await tick();
  }
}

const settledNear = (state, at) => assert.ok(state.at >= at && state.at <= at + 100, "settled at " + state.at + ", want within one 100 ms step of " + at);

function holdOne(bot) {
  const gate = { armed: false, release: () => {} };
  gate.read = (path, init, { threadBody }) => {
    if (!gate.armed || path !== "/captain/api/chat?bot=" + bot) return null;
    gate.armed = false;
    const body = threadBody(bot);
    const { promise, resolve } = Promise.withResolvers();
    gate.release = resolve;
    return promise.then(() => json(body));
  };
  return gate;
}

const once = (messages) => messages.length === new Set(messages.map((one) => one.id)).size;

test("while the build flag is off or unset the chat is the stub: no rows, nothing built, no request", async () => {
  for (const flagged of [libOff, libUnset]) {
    const h = serve(flagged);
    await h.boot();
    const from = h.calls.length;
    assert.deepEqual(await h.source.chat.listChats(), []);
    await assert.rejects(h.source.chat.openThread("steward"), refusedWith("This is not built on the server yet."));
    await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "c-1" }), refusedWith("This is not built on the server yet."));
    assert.deepEqual(h.chatRequests(from), []);
    assert.equal(h.calls.length, from);
  }
});

test("with the flag on the first list read is his own, costs one credit and maps each row to a bot", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  const rows = await h.source.chat.listChats();
  assert.deepEqual(h.requests(from), [LIST]);
  assert.equal(h.credits(from), 1);
  assert.deepEqual(rows.map((one) => [one.bot.id, one.bot.name, one.bot.role, one.bot.order, one.unread]), [["iris", "iris", "the iris", 0, false], ["steward", "steward", "the steward", 1, false], ["quiet", "quiet", "the quiet", 2, false]]);
  assert.deepEqual(rows.map((one) => Object.keys(one).sort()), [["at", "bot", "preview", "unread"], ["at", "bot", "preview", "unread"], ["at", "bot", "preview", "unread"]]);
  assert.equal(rows[2].preview, "");
  assert.equal(rows[2].at, "");
  assert.match(rows[0].bot.color, /^var\(--color-avatar-[1-5]\)$/);
});

test("a second open inside five seconds reads nothing and after five seconds reads again", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  const from = h.calls.length;
  await h.source.chat.listChats();
  await h.time.advance(4_900);
  await h.source.chat.listChats();
  assert.deepEqual(h.requests(from), []);
  await h.time.advance(200);
  await h.source.chat.listChats();
  assert.deepEqual(h.chatRequests(from), [LIST]);
});

test("the world's bots are empty until the rows are read, then come from them", async () => {
  const h = serve();
  await h.boot();
  assert.deepEqual(h.worlds.at(-1).bots, []);
  await h.source.chat.listChats();
  await tick();
  assert.deepEqual(h.worlds.at(-1).bots.map((one) => one.id), ["iris", "steward", "quiet"]);
});

test("a thread open is his own, costs one credit and returns the newest page with its older flag", async () => {
  const h = serve();
  for (let n = 0; n < 20; n += 1) h.add("steward", n % 2 ? "captain" : "bot", "more " + n);
  await h.boot();
  const from = h.calls.length;
  const thread = await h.source.chat.openThread("steward");
  assert.deepEqual(h.requests(from), [THREAD("steward")]);
  assert.equal(h.credits(from), 1);
  assert.equal(thread.messages.length, 15);
  assert.equal(thread.older, true);
  assert.equal(thread.bot.id, "steward");
  assert.deepEqual([thread.seenUpTo, thread.seenAt, thread.working], [null, null, null]);
});

test("Show older reads the page before the oldest held id, costs one credit and tells the thread's watcher", async () => {
  const h = serve();
  for (let n = 0; n < 20; n += 1) h.add("steward", "bot", "more " + n);
  await h.boot();
  const watcher = await h.watchThread("steward");
  const first = await h.source.chat.openThread("steward");
  const oldest = first.messages[0].id;
  const from = h.calls.length;
  const merged = await h.source.chat.older("steward");
  assert.deepEqual(h.requests(from), [THREAD("steward", oldest)]);
  assert.equal(h.credits(from), 1);
  assert.equal(merged.messages.length, 23);
  assert.equal(new Set(merged.messages.map((one) => one.id)).size, 23);
  assert.equal(merged.messages.at(-1).id, first.messages.at(-1).id);
  assert.equal(merged.older, false);
  assert.equal(watcher.seen.at(-1).messages.length, 23);
});

test("a send reads a fresh token list, posts once, costs three credits and refreshes the Queue", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  const from = h.calls.length;
  const worlds = h.worlds.length;
  const message = await h.source.chat.send("steward", { text: "hello there", clientId: "client-1" });
  assert.deepEqual(h.requests(from), [TOKEN, POST]);
  assert.equal(h.credits(from), 3);
  assert.deepEqual(Object.keys(h.calls[from + 1].body), ["bot", "text", "clientId", "csrf"]);
  assert.equal(h.calls[from + 1].body.csrf, "token-" + h.calls.filter((call) => call.path === "/captain/cards").length);
  assert.equal(message.from, "captain");
  assert.equal(message.clientId, "client-1");
  assert.equal(message.text, "hello there");
  assert.deepEqual(message.uploadVerdicts, []);
  assert.ok(h.worlds.length > worlds);
  assert.ok(watcher.seen.at(-1).messages.some((one) => one.id === message.id));
});

test("a 200 answer that is nested is not confirmed, the thread read finds the clientId and the send is one POST", async () => {
  const post = (body, init, { add, sent }) => {
    sent.set(body.clientId, add(body.bot, "captain", body.text, { clientId: body.clientId }));
    return json({ message: { ...sent.get(body.clientId), uploadVerdicts: [] }, csrf: "token-post", freshUntil: Math.floor(NOW / 1000) + 1800 });
  };
  const h = serve(lib, { post });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const message = await h.source.chat.send("steward", { text: "hello there", clientId: "client-2" });
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward")]);
  assert.equal(message.clientId, "client-2");
  assert.equal(h.requests(from).filter((one) => one === POST).length, 1);
});

test("a send that is not confirmed and not found is read again at once and five seconds later, sent once more with the same clientId, then throws; the next try sends the same clientId", async () => {
  let lost = true;
  const post = (body, init, server) => (lost ? new Response("", { status: 503 }) : store(body, server));
  const h = serve(lib, { post });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const first = watchSend(h, h.source.chat.send("steward", { text: "hello there", clientId: "client-3" }));
  await pass(h, 10_000);
  assert.equal(first.error?.name, "NotConfirmed");
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward"), THREAD("steward"), TOKEN, POST, THREAD("steward")]);
  assert.equal(h.calls[from + 3].at - h.calls[from + 2].at, 5_000);
  assert.deepEqual(POSTS(h, from), ["client-3", "client-3"]);
  lost = false;
  const again = h.calls.length;
  const message = await h.source.chat.send("steward", { text: "hello there", clientId: "client-3" });
  assert.equal(message.clientId, "client-3");
  assert.deepEqual(POSTS(h, again), ["client-3"]);
});

test("a send whose POST was delivered but whose answer was lost resolves from the thread read", async () => {
  const post = (body, init, { add, sent }) => {
    sent.set(body.clientId, add(body.bot, "captain", body.text, { clientId: body.clientId }));
    return new Response("", { status: 504 });
  };
  const h = serve(lib, { post });
  await h.boot();
  await h.source.chat.openThread("steward");
  const message = await h.source.chat.send("steward", { text: "delivered", clientId: "client-4" });
  assert.equal(message.clientId, "client-4");
  assert.equal(message.from, "captain");
  assert.deepEqual(message.uploadVerdicts, []);
});

test("a POST that never answers is aborted after twenty seconds, read again, sent once more five seconds later, and is not confirmed within the cap", async () => {
  const h = serve(lib, { post: (body, init) => hang(init) });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-5" }));
  await pass(h, 19_000);
  assert.deepEqual(h.requests(from), [TOKEN, POST]);
  assert.equal(state.done, false);
  await pass(h, 41_000);
  assert.equal(state.error?.name, "NotConfirmed");
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward"), THREAD("steward"), TOKEN, POST, THREAD("steward")]);
  assert.deepEqual(POSTS(h, from), ["client-5", "client-5"]);
  assert.ok(state.at <= 55_000, String(state.at));
});

const REFUSALS = [
  ["429 rate is the r4 limit and not a session end", () => json({ error: "rate" }, 429), "RateLimited"],
  ["422 bot says the bot is not in the list", () => json({ error: "bot" }, 422), "This bot is not in your chat list."],
  ["400 text says the message is empty or too long", () => json({ error: "text" }, 400), "Message is empty or too long."],
  ["422 quote says that message is no longer in this chat", () => json({ error: "quote" }, 422), "Not sent: that message is no longer in this chat."],
  ["422 with any other body keeps the bot words", () => json({ error: "other" }, 422), "This bot is not in your chat list."],
  ["422 with a body that is not JSON keeps the bot words", () => new Response("no", { status: 422, headers: { "Content-Type": "text/plain" } }), "This bot is not in your chat list."],
];

for (const [label, reply, expected] of REFUSALS) {
  test("a chat POST answered with " + label, async () => {
    const h = serve(lib, { post: reply });
    await h.boot();
    await h.source.chat.openThread("steward");
    const from = h.calls.length;
    if (expected === "RateLimited") await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-6" }), named("RateLimited"));
    else await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-6" }), refusedWith(expected));
    assert.deepEqual(h.requests(from), [TOKEN, POST]);
    const after = h.calls.length;
    await h.time.advance(6_000);
    await h.source.chat.listChats();
    assert.deepEqual(h.chatRequests(after), [LIST]);
  });
}

const QUOTING = (features) => ({ thread: (body) => ({ ...body, features }) });
const noteOf = (id, text, extra = {}) => ({ label: "steward", title: null, text, to: null, messageId: id, whole: true, ...extra });
const CARD = { cardId: "Q176", version: 3, label: "Task Card", title: "A title", priority: "p1", recap: [] };
const posts = (h) => h.calls.filter((call) => call.method === "POST" && call.path === "/captain/api/chat");

test("with quote listed, a message quote goes out as its id and its words, a card quote as its id and version, and the sent message carries the quote", async () => {
  const h = serve(lib, QUOTING(["quote"]));
  await h.boot();
  await h.source.chat.openThread("steward");
  const message = await h.source.chat.send("steward", { text: "yes", clientId: "client-q1", quote: noteOf("m3", "steward 2") });
  assert.deepEqual(posts(h).at(-1).body.quote, { id: "m3", text: "steward 2" });
  assert.deepEqual(Object.keys(posts(h).at(-1).body), ["bot", "text", "clientId", "csrf", "quote"]);
  assert.deepEqual(message.quote, { id: "m3", from: "bot", at: h.threads.get("steward")[2].at, text: "steward 2" });
  const card = await h.source.chat.send("steward", { text: "about this", clientId: "client-q2", quote: CARD });
  assert.deepEqual(posts(h).at(-1).body.quote, { cardId: "Q176", version: 3 });
  assert.deepEqual(card.quote, { cardId: "Q176", version: 3 });
});

test("a quoted send that is not confirmed is sent once more with the same quote and clientId, and the sent message keeps the quote", async () => {
  let lost = true;
  const post = (body, init, server) => {
    if (!lost) return store(body, server);
    lost = false;
    return new Response("", { status: 503 });
  };
  const h = serve(lib, { ...QUOTING(["quote"]), post });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "yes", clientId: "client-q4", quote: noteOf("m3", "steward 2") }));
  await pass(h, 10_000);
  assert.equal(state.error, undefined);
  assert.deepEqual(POSTS(h, from), ["client-q4", "client-q4"]);
  assert.deepEqual(posts(h).slice(-2).map((call) => call.body.quote), [{ id: "m3", text: "steward 2" }, { id: "m3", text: "steward 2" }]);
  assert.deepEqual(state.value.quote, { id: "m3", from: "bot", at: h.threads.get("steward")[2].at, text: "steward 2" });
});

function offlineServe(post) {
  const net = { offline: false };
  const down = () => {
    if (net.offline) throw new TypeError("Failed to fetch");
    return null;
  };
  return { net, h: serve(lib, { cards: down, read: down, post: post?.(net) }) };
}

test("a POST that reached the server but lost its answer when the network dropped is found by the thread check after the pause, and is never posted twice", async () => {
  let dropped = false;
  const { net, h } = offlineServe((net) => (body, init, server) => {
    const answer = store(body, server);
    if (dropped) return answer;
    dropped = true;
    net.offline = true;
    throw new TypeError("Failed to fetch");
  });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "landed once", clientId: "client-off-4" }));
  await pass(h, 1_000);
  assert.equal(state.done, false, "still sending after the answer was lost and the first re-read failed");
  net.offline = false;
  await pass(h, 10_000);
  assert.equal(state.error, undefined);
  assert.equal(state.value.clientId, "client-off-4");
  assert.deepEqual(POSTS(h, from), ["client-off-4"]);
  assert.deepEqual(h.chatRequests(from), [POST, THREAD("steward"), THREAD("steward")]);
  assert.equal(h.threads.get("steward").filter((one) => one.clientId === "client-off-4").length, 1);
});

test("a send whose token read fails in the network, as when the phone is offline, waits the same pause, checks the thread and tries once more with the same clientId, so it lands with one POST when the network is back", async () => {
  const { net, h } = offlineServe();
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  net.offline = true;
  const state = watchSend(h, h.source.chat.send("steward", { text: "sent offline", clientId: "client-off-1" }));
  await pass(h, 1_000);
  assert.equal(state.done, false, "still sending after the token read failed");
  net.offline = false;
  await pass(h, 10_000);
  assert.equal(state.error, undefined);
  assert.equal(state.value.clientId, "client-off-1");
  assert.ok(state.at >= 5_000, "settled at " + state.at + ", after the 5 s pause");
  assert.deepEqual(POSTS(h, from), ["client-off-1"]);
  assert.deepEqual(h.chatRequests(from), [THREAD("steward"), POST]);
});

test("a send whose token reads all fail in the network ends only after its one automatic retry, with the thread checked between and no POST", async () => {
  const { net, h } = offlineServe();
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  net.offline = true;
  const state = watchSend(h, h.source.chat.send("steward", { text: "never out", clientId: "client-off-2" }));
  await pass(h, 10_000);
  assert.equal(state.error?.name, "Unavailable");
  assert.ok(state.at >= 5_000, "settled at " + state.at + ", after the 5 s pause");
  assert.deepEqual(POSTS(h, from), []);
  assert.deepEqual(h.chatRequests(from), [THREAD("steward")]);
});

test("a send whose token read is refused with 403 ends at once as sign in again, with no retry and no POST", async () => {
  let refuse = false;
  const h = serve(lib, { cards: () => (refuse ? json({ error: "session" }, 403) : null) });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  refuse = true;
  const state = watchSend(h, h.source.chat.send("steward", { text: "no", clientId: "client-off-3" }));
  await pass(h, 10_000);
  assert.equal(state.error?.name, "SignInRequired");
  settledNear(state, 0);
  assert.deepEqual(POSTS(h, from), []);
  assert.deepEqual(h.chatRequests(from), []);
});

test("his selection goes out when it passes the check, the whole message as he sees it when it does not, and the stored text's words when even that does not", async () => {
  const h = serve(lib, QUOTING(["quote"]));
  await h.boot();
  h.add("steward", "bot", "**Done.** See [the guide](https://example.com/a):\n\n1. one\n2. two");
  await h.source.chat.openThread("steward");
  const id = h.threads.get("steward").at(-1).id;
  const sendOf = async (n, text, whole) => {
    await h.source.chat.send("steward", { text: "q" + n, clientId: "client-q" + (10 + n), quote: noteOf(id, text, { whole }) });
    return posts(h).at(-1).body.quote;
  };
  assert.deepEqual(await sendOf(1, "the guide", false), { id, text: "the guide" });
  assert.deepEqual(await sendOf(2, "ne. See th", false), { id, text: "ne. See th" }, "a selection that starts and ends mid-word, so the check lets it through");
  assert.deepEqual(await sendOf(3, "words that are not in it", false), { id, text: "Done. See the guide:\n\n- one\n- two" });
  assert.deepEqual(await sendOf(4, "Done. See the guide:\n\n- one\n- two", true), { id, text: "Done. See the guide:\n\n- one\n- two" });
});

test("a quote of a message that is not in the thread, or when the thread lists no quote, is refused with plain words and nothing is posted", async () => {
  const on = serve(lib, QUOTING(["quote"]));
  await on.boot();
  await on.source.chat.openThread("steward");
  const from = on.calls.length;
  await assert.rejects(on.source.chat.send("steward", { text: "q", clientId: "client-q20", quote: noteOf("m99", "steward 2") }), refusedWith("Not sent: that message is no longer in this chat."));
  await assert.rejects(on.source.chat.send("steward", { text: "q", clientId: "client-q21", quote: { label: "x", title: null, text: "hi", to: null } }), refusedWith("Not sent: that message is no longer in this chat."));
  assert.equal(posts(on).length, 0);
  assert.deepEqual(on.requests(from).filter((one) => one === POST), []);
  for (const features of [[], ["read", "seen"]]) {
    const off = serve(lib, QUOTING(features));
    await off.boot();
    await off.source.chat.openThread("steward");
    await assert.rejects(off.source.chat.send("steward", { text: "q", clientId: "client-q22", quote: noteOf("m3", "steward 2") }), refusedWith("Not sent: quotes are not built on the server yet."));
    await assert.rejects(off.source.chat.send("steward", { text: "q", clientId: "client-q23", quote: CARD }), refusedWith("Not sent: quotes are not built on the server yet."));
    assert.equal(posts(off).length, 0);
  }
});

for (const status of [401, 403]) {
  test("a chat POST answered with " + status + " ends the session and sends nothing again", async () => {
    const h = serve(lib, { post: () => json({ error: "session" }, status) });
    await h.boot();
    await h.source.chat.openThread("steward");
    await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-7" }), named("SignInRequired"));
    const after = h.calls.length;
    await assert.rejects(h.source.chat.listChats(), named("SignInRequired"));
    await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-7" }), named("SignInRequired"));
    assert.equal(h.calls.length, after);
  });
}

test("a 500 or 503 on the chat POST is not confirmed and finds nothing, is sent once more, and the send throws NotConfirmed", async () => {
  for (const status of [500, 503]) {
    const h = serve(lib, { post: () => new Response("", { status }) });
    await h.boot();
    await h.source.chat.openThread("steward");
    const from = h.calls.length;
    const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-8" }));
    await pass(h, 10_000);
    assert.equal(state.error?.name, "NotConfirmed", String(status));
    assert.deepEqual(POSTS(h, from), ["client-8", "client-8"], String(status));
  }
});

test("a thread read whose page is behind keeps his just-sent message in time order, and the read that has it shows it once", async () => {
  let behind = false;
  const thread = (body) => (behind ? { ...body, messages: body.messages.filter((one) => one.clientId !== "client-11") } : body);
  const h = serve(lib, { thread });
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  const sent = await h.source.chat.send("steward", { text: "keep me", clientId: "client-11" });
  behind = true;
  const reply = h.add("steward", "bot", "a reply");
  const stale = await h.source.chat.openThread("steward");
  assert.deepEqual(stale.messages.slice(-2).map((one) => one.id), [sent.id, reply.id]);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [sent.id, reply.id]);
  behind = false;
  const caught = await h.source.chat.openThread("steward");
  assert.equal(caught.messages.filter((one) => one.id === sent.id || one.clientId === "client-11").length, 1);
  assert.deepEqual(caught.messages.slice(-2).map((one) => one.id), [sent.id, reply.id]);
});

test("a 502 mail refusal waits five seconds, reads again, sends once more with the same clientId, and the send resolves with one row", async () => {
  let refusals = 1;
  const post = (body, init, server) => {
    if (refusals === 0) return store(body, server);
    refusals -= 1;
    return json({ error: "mail" }, 502);
  };
  const h = serve(lib, { post });
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-12" }));
  await pass(h, 4_900);
  assert.equal(state.done, false);
  assert.deepEqual(h.requests(from), [TOKEN, POST]);
  await pass(h, 1_000);
  assert.equal(state.value?.clientId, "client-12");
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward"), TOKEN, POST]);
  assert.deepEqual(POSTS(h, from), ["client-12", "client-12"]);
  assert.equal(watcher.seen.at(-1).messages.filter((one) => one.clientId === "client-12").length, 1);
});

test("a second 502 after the one retry refuses with Not Delivered, with two POSTs in all", async () => {
  const h = serve(lib, { post: () => json({ error: "mail" }, 502) });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-13" }));
  await pass(h, 10_000);
  assert.ok(refusedWith("Not Delivered")(state.error), String(state.error));
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward"), TOKEN, POST]);
  assert.deepEqual(POSTS(h, from), ["client-13", "client-13"]);
});

test("a POST aborted at twenty seconds and answered on the retry resolves as sent", async () => {
  let tries = 0;
  const post = (body, init, server) => {
    tries += 1;
    return tries === 1 ? hang(init) : store(body, server);
  };
  const h = serve(lib, { post });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-14" }));
  await pass(h, 30_000);
  assert.equal(state.value?.clientId, "client-14");
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward"), THREAD("steward"), TOKEN, POST]);
  settledNear(state, 25_000);
});

test("a send the server stored behind a network failure is found by the read five seconds later, with one POST", async () => {
  let behind = 0;
  const post = (body, init, { add, sent }) => {
    sent.set(body.clientId, add(body.bot, "captain", body.text, { clientId: body.clientId }));
    behind = 1;
    throw new TypeError("network");
  };
  const thread = (body) => {
    if (behind === 0) return body;
    behind -= 1;
    return { ...body, messages: body.messages.filter((one) => one.clientId !== "client-15") };
  };
  const h = serve(lib, { post, thread });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-15" }));
  await pass(h, 6_000);
  assert.equal(state.value?.clientId, "client-15");
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward"), THREAD("steward")]);
  assert.deepEqual(POSTS(h, from), ["client-15"]);
});

test("a re-read that never answers counts as not found and the retry still goes out and lands", async () => {
  let stuck = false;
  let refusals = 1;
  const post = (body, init, server) => {
    if (refusals === 0) return store(body, server);
    refusals -= 1;
    return json({ error: "mail" }, 502);
  };
  const h = serve(lib, { post, read: (path) => (stuck && path.startsWith("/captain/api/chat?") ? never() : null) });
  await h.boot();
  await h.source.chat.openThread("steward");
  stuck = true;
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-17" }));
  await pass(h, 12_000);
  assert.equal(state.value?.clientId, "client-17");
  assert.deepEqual(h.requests(from), [TOKEN, POST, THREAD("steward"), TOKEN, POST]);
  settledNear(state, 10_000);
});

test("when every token read and thread read hangs, Not sent comes at the fifty-five second cap, under a minute from the tap", async () => {
  let stuck = false;
  const h = serve(lib, {
    post: (body, init) => hang(init),
    cards: () => (stuck ? never() : null),
    read: (path) => (stuck && path.startsWith("/captain/api/chat?") ? never() : null),
  });
  await h.boot();
  await h.source.chat.openThread("steward");
  stuck = true;
  const from = h.calls.length;
  const state = watchSend(h, h.source.chat.send("steward", { text: "hello", clientId: "client-16" }));
  await pass(h, 54_900);
  assert.equal(state.done, false);
  await pass(h, 6_000);
  assert.equal(state.error?.name, "NotConfirmed");
  settledNear(state, 55_000);
  const during = h.calls.slice(from, state.upTo);
  assert.deepEqual(during.filter((call) => call.path !== "/captain/cards").map((call) => call.method + " " + call.path), [THREAD("steward"), THREAD("steward")]);
  assert.deepEqual(during.filter((call) => call.path === "/captain/cards").slice(0, 2).map((call) => call.at - during[0].at), [0, 40_000]);
});

test("a chat read answered with 401 ends the session, and nothing more goes out", async () => {
  let end = false;
  const h = serve(lib, { read: (path) => (end && path.startsWith("/captain/api/chat") ? json({ error: "session" }, 401) : null) });
  await h.boot();
  await h.source.chat.listChats();
  end = true;
  await assert.rejects(h.source.chat.openThread("steward"), named("SignInRequired"));
  const after = h.calls.length;
  await assert.rejects(h.source.chat.listChats(), named("SignInRequired"));
  await assert.rejects(h.source.chat.openThread("steward"), named("SignInRequired"));
  assert.equal(h.calls.length, after);
});

test("the session end clears the held rows and bots, so the next open after signing in reads the list again", async () => {
  let end = false;
  const h = serve(lib, { read: (path) => (end && path.startsWith("/captain/api/chat?") ? json({ error: "session" }, 401) : null) });
  await h.boot();
  await h.source.chat.listChats();
  await tick();
  assert.equal(h.worlds.at(-1).bots.length, 3);
  end = true;
  await assert.rejects(h.source.chat.openThread("steward"), named("SignInRequired"));
  end = false;
  h.source.signIn();
  await h.source.load();
  await tick();
  assert.deepEqual(h.worlds.at(-1).bots, []);
  const from = h.calls.length;
  await h.source.chat.listChats();
  assert.deepEqual(h.chatRequests(from), [LIST]);
});

test("checks before a send refuse empty or long text, a bad clientId, files and a quote and send nothing", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  await assert.rejects(h.source.chat.send("steward", { text: "", clientId: "client-9" }), refusedWith("Message is empty or too long."));
  await assert.rejects(h.source.chat.send("steward", { text: "x".repeat(4001), clientId: "client-9" }), refusedWith("Message is empty or too long."));
  await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "has space" }), named("Refused"));
  await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-9", files: [{ name: "a.png" }] }), named("Refused"));
  await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-9", quote: { text: "x" } }), named("Refused"));
  assert.equal(h.calls.length, from);
});

test("with the app's own cap reached a send and a thread open are refused before any request", async () => {
  const h = serve();
  await h.boot();
  for (let n = 0; n < 26; n += 1) await h.source.chat.openThread("steward");
  const from = h.calls.length;
  await assert.rejects(h.source.chat.send("steward", { text: "hello", clientId: "client-10" }), named("RateLimited"));
  await assert.rejects(h.source.chat.openThread("steward"), named("RateLimited"));
  assert.equal(h.calls.length, from);
});

test("an event with chat rows on screen makes one automatic list read once the five seconds have passed", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  const rows = await h.watchRows();
  await h.time.advance(6_000);
  const from = h.calls.length;
  h.add("iris", "bot", "a reply");
  await h.refresh();
  await h.time.advance(1_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
  assert.ok(rows.heard.length >= 1);
});

test("five events inside the spacing make one list read", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  await h.watchRows();
  const from = h.calls.length;
  h.add("iris", "bot", "a reply");
  for (let n = 0; n < 5; n += 1) {
    await h.refresh();
    await h.time.advance(100);
  }
  assert.deepEqual(h.chatRequests(from), []);
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
});

test("an event with nothing of chat on screen reads nothing, and the next open reads once", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  await h.time.advance(1_000);
  const from = h.calls.length;
  h.add("iris", "bot", "a reply");
  await h.refresh();
  await h.time.advance(10_000);
  assert.deepEqual(h.chatRequests(from), []);
  const rows = await h.source.chat.listChats();
  assert.deepEqual(h.chatRequests(from), [LIST]);
  assert.equal(rows.find((one) => one.bot.id === "iris").preview, "a reply");
});

test("an event that names only cards reads no chat list", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  await h.watchRows();
  await h.time.advance(6_000);
  const from = h.calls.length;
  await h.refresh({ cards: false, mail: false, chats: false });
  await h.refresh({ cards: true });
  await h.time.advance(10_000);
  assert.deepEqual(h.chatRequests(from), []);
});

test("his own sent message is in the thread from the POST, so its echo reads the list and no thread", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.source.chat.send("steward", { text: "hello", clientId: "client-11" });
  await h.time.advance(6_000);
  const from = h.calls.length;
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
});

test("a lagging list that names an older held id reads no thread", async () => {
  let lag = false;
  const h = serve(lib, { rows: (full) => (lag ? full.map((one) => (one.bot.id === "steward" ? { ...one, last: "m1" } : one)) : full) });
  await h.boot();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.time.advance(6_000);
  lag = true;
  const from = h.calls.length;
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
});

test("a new last id makes one thread read of the open thread, and the same id again reads nothing more", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  await h.time.advance(6_000);
  const from = h.calls.length;
  h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST, THREAD("steward")]);
  assert.equal(watcher.seen.at(-1).messages.at(-1).text, "a reply");
  const again = h.calls.length;
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(again), [LIST]);
});

test("an open read that answers after a newer timed read never takes back the bot message the newer read showed", async () => {
  const gate = holdOne("steward");
  const h = serve(lib, { read: gate.read });
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  await h.time.advance(6_000);
  const from = h.calls.length;
  gate.armed = true;
  const reopened = h.source.chat.openThread("steward");
  await pass(h, 100);
  assert.deepEqual(h.chatRequests(from), [THREAD("steward")]);
  const reply = h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [THREAD("steward"), LIST, THREAD("steward")]);
  assert.equal(watcher.seen.at(-1).messages.at(-1).id, reply.id);
  gate.release();
  const late = await reopened;
  assert.equal(late.messages.at(-1).id, reply.id);
  assert.equal(watcher.seen.at(-1).messages.at(-1).id, reply.id);
  assert.ok(once(watcher.seen.at(-1).messages));
});

test("a send's re-read that answers after the retry landed and a newer read showed his message never takes it back", async () => {
  let refusals = 1;
  const post = (body, init, server) => {
    if (refusals === 0) return store(body, server);
    refusals -= 1;
    return json({ error: "mail" }, 502);
  };
  const gate = holdOne("steward");
  const h = serve(lib, { post, read: gate.read });
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  await h.time.advance(6_000);
  const from = h.calls.length;
  gate.armed = true;
  const state = watchSend(h, h.source.chat.send("steward", { text: "keep me", clientId: "client-31" }));
  await pass(h, 12_000);
  assert.equal(state.value?.clientId, "client-31");
  assert.deepEqual(h.chatRequests(from), [POST, THREAD("steward"), POST]);
  const reply = h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [state.value.id, reply.id]);
  gate.release();
  await pass(h, 1_000);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [state.value.id, reply.id]);
  assert.ok(once(watcher.seen.at(-1).messages));
});

const AFTER = (bot, id) => "GET /captain/api/chat?bot=" + bot + "&after=" + id;
const CURSOR = (body) => ({ ...body, features: ["cursor"] });

function afterReads(shape = (body) => body) {
  const server = { threads: null, refuse: false, gate: null };
  server.read = (path) => {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    if (!path.startsWith("/captain/api/chat?") || !query.has("after")) return null;
    const bot = query.get("bot");
    const list = server.threads.get(bot) ?? [];
    const at = list.findIndex((one) => one.id === query.get("after"));
    if (server.refuse || at < 0) return json({ error: "cursor" }, 409);
    const body = shape(CURSOR({ bot: { id: bot, note: "the " + bot }, messages: list.slice(at + 1), seenUpTo: null, seenAt: null, working: null, older: false }));
    const gate = server.gate;
    server.gate = null;
    return gate ? gate.promise.then(() => json(body)) : json(body);
  };
  return server;
}

async function cursorThread(options = {}) {
  const s = afterReads(options.shape);
  const h = serve(lib, { post: options.post, read: s.read, thread: options.thread ?? CURSOR });
  s.threads = h.threads;
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  await h.time.advance(6_000);
  return { s, h, watcher };
}

test("with cursor listed, the timed refresh asks only for the messages after the newest held one, appends them in order with the answer's seen, working and features, and opening the chat still reads the newest page", async () => {
  const { h, watcher } = await cursorThread({ shape: (body) => ({ ...body, seenUpTo: "m2", seenAt: stamp(30), working: { note: "reading", since: stamp(30), updatedAt: stamp(31) } }) });
  const from = h.calls.length;
  const replies = [h.add("steward", "bot", "one"), h.add("steward", "bot", "two")];
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3"), LIST]);
  const shown = watcher.seen.at(-1);
  assert.deepEqual(shown.messages.map((one) => one.id), ["m1", "m2", "m3", ...replies.map((one) => one.id)]);
  assert.deepEqual([shown.seenUpTo, shown.seenAt, shown.working?.note, shown.features], ["m2", stamp(30), "reading", ["cursor"]]);
  const opened = h.calls.length;
  await h.source.chat.openThread("steward");
  assert.deepEqual(h.chatRequests(opened), [THREAD("steward")]);
});

test("with cursor listed, a 409 cursor answer falls back to one newest-page read, and the next refresh tries the cursor again", async () => {
  const { s, h, watcher } = await cursorThread();
  let from = h.calls.length;
  s.refuse = true;
  const first = h.add("steward", "bot", "one");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3"), THREAD("steward"), LIST]);
  assert.equal(watcher.seen.at(-1).messages.at(-1).id, first.id);
  s.refuse = false;
  from = h.calls.length;
  const second = h.add("steward", "bot", "two");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", first.id), LIST]);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [first.id, second.id]);
  assert.ok(once(watcher.seen.at(-1).messages));
});

test("with cursor listed, a cursor answer that comes back after a newer newest-page read was shown never takes that read back", async () => {
  const { s, h, watcher } = await cursorThread();
  const from = h.calls.length;
  const gate = Promise.withResolvers();
  s.gate = gate;
  const first = h.add("steward", "bot", "one");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3")]);
  const second = h.add("steward", "bot", "two");
  await h.source.chat.openThread("steward");
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [first.id, second.id]);
  gate.resolve();
  await pass(h, 1_000);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [first.id, second.id]);
  assert.ok(once(watcher.seen.at(-1).messages));
});

test("with cursor listed, his sent message the server has not shown yet survives the cursor read and its 409 fallback, and the cursor skips it", async () => {
  const post = (body) => json({ id: "m90", from: "captain", text: body.text, at: stamp(90), refs: [], clientId: body.clientId, uploadVerdicts: [], csrf: "token-post", freshUntil: Math.floor(NOW / 1000) + 1800 });
  const { s, h, watcher } = await cursorThread({ post });
  const sent = await h.source.chat.send("steward", { text: "keep me", clientId: "client-41" });
  await pass(h, 1_000);
  let from = h.calls.length;
  const reply = h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3"), LIST]);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [reply.id, sent.id]);
  s.refuse = true;
  from = h.calls.length;
  const next = h.add("steward", "bot", "later");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", reply.id), THREAD("steward"), LIST]);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-3).map((one) => one.id), [reply.id, next.id, sent.id]);
  assert.ok(once(watcher.seen.at(-1).messages));
});

test("without cursor listed, the timed refresh reads the newest page as before and never asks with after", async () => {
  const { h, watcher } = await cursorThread({ thread: (body) => ({ ...body, features: ["quote", "read", "seen", "working", "files"] }) });
  const from = h.calls.length;
  const reply = h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST, THREAD("steward")]);
  assert.equal(watcher.seen.at(-1).messages.at(-1).id, reply.id);
  assert.ok(!h.chatRequests().some((one) => one.includes("after=")));
});

const STREAM_OPEN = 1;
const afterCalls = (h, from = 0) => h.calls.slice(from).filter((call) => call.method === "GET" && call.path.includes("&after="));
const creditsBefore = (h, at) => h.calls.filter((call) => call.at < at && call.at > at - 60_000).reduce((total, call) => total + (call.method === "POST" ? 2 : 1), 0);

test("with cursor listed and the chat open, a refresh that names chats makes the next request the read after the newest held message, at once and with no list read before it, and the list read follows five seconds later", async () => {
  const { h, watcher } = await cursorThread();
  await h.source.chat.listChats();
  await h.time.advance(1_000);
  const from = h.calls.length;
  const reply = h.add("steward", "bot", "a reply");
  const refreshedAt = h.time.now() - NOW;
  await h.refresh();
  await pass(h, 100);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3")]);
  assert.equal(h.calls[from].at, refreshedAt);
  assert.equal(watcher.seen.at(-1).messages.at(-1).id, reply.id);
  await pass(h, 5_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3"), LIST]);
  assert.equal(h.calls[from + 1].at - refreshedAt, 5_000);
});

test("with cursor listed and the chat open, the read after a refresh puts the new bot message in its row of the held chat list in the same update, with no list read before it and the dot off, and the list read that follows with the same newest message and order changes nothing", async () => {
  const { h } = await cursorThread();
  await h.source.chat.listChats();
  const rows = await h.watchRows();
  const first = h.add("steward", "bot", "first");
  await h.refresh();
  await pass(h, 6_000);
  const from = h.calls.length;
  const heard = rows.heard.length;
  const reply = h.add("steward", "bot", "a reply");
  await h.refresh();
  await pass(h, 100);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", first.id)]);
  assert.equal(rows.heard.length, heard + 1);
  const row = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  assert.deepEqual([row.preview, row.at, row.unread], ["a reply", reply.at, false]);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", first.id)]);
  await pass(h, 5_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", first.id), LIST]);
  assert.equal(rows.heard.length, heard + 1);
  const later = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  assert.deepEqual([later.preview, later.at, later.unread], ["a reply", reply.at, false]);
});

test("with cursor listed and the chat open, a list read that lands after the read after a refresh and shows a newer message wins over the row that read gave", async () => {
  const { h } = await cursorThread();
  await h.source.chat.listChats();
  const rows = await h.watchRows();
  await h.time.advance(1_000);
  const from = h.calls.length;
  h.add("steward", "bot", "a reply");
  await h.refresh();
  await pass(h, 100);
  const heard = rows.heard.length;
  const newer = h.add("steward", "bot", "newer");
  await pass(h, 5_000);
  assert.equal(h.chatRequests(from)[1], LIST);
  assert.equal(rows.heard.length, heard + 1);
  const row = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  assert.deepEqual([row.preview, row.at], ["newer", newer.at]);
});

test("with cursor listed and the chat open, a read after the newest held message that answers after a list read showed a newer message leaves the row as that list read made it", async () => {
  const { s, h } = await cursorThread();
  await h.source.chat.listChats();
  await h.time.advance(1_000);
  const gate = Promise.withResolvers();
  s.gate = gate;
  h.add("steward", "bot", "a reply");
  await h.refresh();
  await pass(h, 100);
  const newer = h.add("steward", "bot", "newer");
  await h.time.advance(5_000);
  const listed = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  assert.deepEqual([listed.preview, listed.at], ["newer", newer.at]);
  gate.resolve();
  await pass(h, 100);
  const row = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  assert.deepEqual([row.preview, row.at], ["newer", newer.at]);
});

test("with cursor listed and the chat open, a bot reply of files and no words leaves the open chat's row as it was until the list read lands and gives it", async () => {
  const { h } = await cursorThread();
  await h.source.chat.listChats();
  const rows = await h.watchRows();
  const before = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  const from = h.calls.length;
  const heard = rows.heard.length;
  const reply = h.add("steward", "bot", "", { files: [{ id: "f1", name: "shot.png", type: "image/png", size: 10, kind: "photo", url: "/captain/api/files/f1" }] });
  await h.refresh();
  await pass(h, 100);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3")]);
  assert.equal(rows.heard.length, heard);
  const held = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  assert.deepEqual([held.preview, held.at], [before.preview, before.at]);
  await pass(h, 5_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3"), LIST]);
  assert.equal(rows.heard.length, heard + 1);
  const listed = (await h.source.chat.listChats()).find((one) => one.bot.id === "steward");
  assert.deepEqual([listed.preview, listed.at], ["", reply.at]);
});

test("twenty refreshes while a read after the newest held message is in flight make exactly one more read after it, no list read inside the spacing, and credits inside the automatic budget of twenty-one", async () => {
  const { s, h, watcher } = await cursorThread();
  const from = h.calls.length;
  const gate = Promise.withResolvers();
  s.gate = gate;
  const first = h.add("steward", "bot", "one");
  await h.refresh();
  await pass(h, 100);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3")]);
  const second = h.add("steward", "bot", "two");
  for (let n = 0; n < 19; n += 1) {
    await h.refresh();
    await pass(h, 100);
  }
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3")]);
  gate.resolve();
  await pass(h, 1_000);
  assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3"), AFTER("steward", first.id)]);
  assert.deepEqual(watcher.seen.at(-1).messages.slice(-2).map((one) => one.id), [first.id, second.id]);
  assert.ok(once(watcher.seen.at(-1).messages));
  assert.ok(h.credits(from) <= 21);
});

for (const status of [401, 403]) {
  test("a read after the newest held message answered with " + status + " ends the session with nothing painted, keeps no rows, and after signing in the chat opens from the newest page", async () => {
    let end = false;
    const gate = Promise.withResolvers();
    const s = afterReads();
    const h = serve(lib, { thread: CURSOR, read: (path) => (end && path.includes("&after=") ? gate.promise.then(() => json({ error: "session" }, status)) : s.read(path)) });
    s.threads = h.threads;
    await h.boot();
    await h.source.chat.openThread("steward");
    const watcher = await h.watchThread("steward");
    await h.source.chat.listChats();
    await tick();
    await h.time.advance(6_000);
    assert.equal(h.worlds.at(-1).bots.length, 3);
    const painted = watcher.seen.length;
    end = true;
    const from = h.calls.length;
    h.add("steward", "bot", "a reply");
    await h.refresh();
    await pass(h, 100);
    assert.deepEqual(h.chatRequests(from), [AFTER("steward", "m3")]);
    await h.refresh();
    gate.resolve();
    await pass(h, 1_000);
    assert.equal(watcher.seen.length, painted);
    const after = h.calls.length;
    await assert.rejects(h.source.chat.listChats(), named("SignInRequired"));
    await assert.rejects(h.source.chat.openThread("steward"), named("SignInRequired"));
    await h.time.advance(10_000);
    assert.equal(h.calls.length, after);
    end = false;
    h.source.signIn();
    await h.source.load();
    await tick();
    assert.deepEqual(h.worlds.at(-1).bots, []);
    const reopened = h.calls.length;
    await h.source.chat.openThread("steward");
    await h.watchThread("steward");
    await h.time.advance(1_000);
    assert.deepEqual(h.chatRequests(reopened), [THREAD("steward")]);
  });
}

test("every list read starts at least five seconds after the request before it, with reads after the newest held message between them and replies arriving in bursts", async () => {
  const { h } = await cursorThread();
  await h.watchRows();
  const from = h.calls.length;
  for (let second = 0; second < 40; second += 1) {
    if (second % 7 < 2) {
      h.add("steward", "bot", "reply " + second);
      await h.refresh();
    }
    await pass(h, 1_000);
  }
  await pass(h, 10_000);
  const sent = h.calls.filter((call) => call.method === "GET");
  const lists = h.calls.slice(from).filter((call) => call.method === "GET" && call.path === "/captain/api/chats");
  assert.ok(lists.length >= 2, "list reads: " + lists.length);
  assert.ok(afterCalls(h, from).length >= 6, "reads after the newest held message: " + afterCalls(h, from).length);
  for (const list of lists) {
    const before = sent.filter((call) => call.at < list.at).at(-1);
    assert.ok(before === undefined || list.at - before.at >= 5_000, "list at " + list.at + " after " + before?.path + " at " + before?.at);
  }
});

test("with cursor listed, a refresh that arrives in a hidden tab reads the list first and then the messages after the newest held one when the tab returns", async () => {
  const { h, watcher } = await cursorThread();
  h.hide();
  const from = h.calls.length;
  const reply = h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(10_000);
  assert.deepEqual(h.chatRequests(from), []);
  h.show();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST, AFTER("steward", "m3")], h.requests(from).join(", "));
  assert.equal(watcher.seen.at(-1).messages.at(-1).id, reply.id);
});

test("with cursor listed and no thread open, a refresh that names chats reads only the list, and one that names only cards reads no chat request", async () => {
  const { h, watcher } = await cursorThread();
  watcher.stop();
  await h.watchRows();
  await h.time.advance(6_000);
  let from = h.calls.length;
  h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
  await h.watchThread("steward");
  await h.time.advance(6_000);
  from = h.calls.length;
  await h.refresh({ cards: true, mail: false, chats: false });
  await h.time.advance(10_000);
  assert.deepEqual(h.chatRequests(from), []);
});

test("with the automatic budget spent, a refresh that names chats waits for a credit to return, and no read after the newest held message starts with twenty or more credits spent in the last minute", async () => {
  const { h, watcher } = await cursorThread();
  const from = h.calls.length;
  const used = creditsBefore(h, h.time.now() - NOW) + STREAM_OPEN;
  for (let n = 0; n < 40; n += 1) {
    h.add("steward", "bot", "reply " + n);
    await h.refresh();
    await pass(h, 100);
  }
  const inside = afterCalls(h, from);
  assert.equal(inside.length, 21 - used);
  for (const call of inside) assert.ok(creditsBefore(h, call.at) + STREAM_OPEN <= 20, "read at " + call.at + " with " + creditsBefore(h, call.at) + " credits in the minute before");
  await h.time.advance(60_000);
  assert.equal(watcher.seen.at(-1).messages.at(-1).text, "reply 39");
  const waited = afterCalls(h, from).slice(inside.length);
  assert.ok(waited.length >= 1 && waited[0].at >= 60_000, "the read that waited started at " + waited[0]?.at);
});

test("leaving the chat before the read after the newest held message starts cancels it, and opening the chat again reads the list first as it does without the event", async () => {
  const { h, watcher } = await cursorThread();
  const from = h.calls.length;
  h.add("steward", "bot", "a reply");
  await h.refresh();
  watcher.stop();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), []);
  await h.watchThread("steward");
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST, AFTER("steward", "m3")]);
});

test("a row whose last is empty reads no thread", async () => {
  const h = serve(lib, { rows: (full) => full.map((one) => ({ ...one, last: "" })) });
  await h.boot();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.time.advance(6_000);
  const from = h.calls.length;
  h.add("steward", "bot", "a reply");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
});

test("another bot's message updates only its row and reads no thread", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.source.chat.listChats();
  await h.time.advance(6_000);
  const from = h.calls.length;
  h.add("iris", "bot", "hello from iris");
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
  const rows = await h.source.chat.listChats();
  assert.equal(rows.find((one) => one.bot.id === "iris").preview, "hello from iris");
});

test("a chat read leaves the 45 second cards check where it was", async () => {
  const h = serve();
  await h.boot();
  await h.time.advance(30_000);
  await h.source.chat.listChats();
  const from = h.calls.length;
  await h.time.advance(16_000);
  assert.ok(h.requests(from).includes(TOKEN), h.requests(from).join(", "));
});

test("one busy minute of chat alone costs thirteen credits, under the cap of twenty-nine", async () => {
  const h = serve();
  await h.boot();
  const from = h.calls.length;
  await h.source.chat.listChats();
  await h.watchRows();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.source.chat.send("steward", { text: "one", clientId: "client-12" });
  await h.time.advance(6_000);
  h.add("steward", "bot", "reply one");
  await h.refresh();
  await h.time.advance(6_000);
  await h.source.chat.send("steward", { text: "two", clientId: "client-13" });
  await h.time.advance(6_000);
  h.add("steward", "bot", "reply two");
  await h.refresh();
  await h.time.advance(6_000);
  await h.refresh();
  await h.time.advance(6_000);
  const own = h.calls.slice(from).filter((call) => call.path.startsWith("/captain/api/chat") || (call.path === "/captain/cards"));
  const total = own.reduce((sum, call) => sum + (call.method === "POST" ? 2 : 1), 0);
  assert.equal(total, 13);
  assert.ok(total <= 29);
});

test("a POST answer that arrives after the session ended sets nothing and the send says sign in again", async () => {
  let release;
  let end = false;
  const post = (body, init, { add, sent }) => new Promise((resolve) => {
    release = () => {
      sent.set(body.clientId, add(body.bot, "captain", body.text, { clientId: body.clientId }));
      resolve(json({ ...sent.get(body.clientId), uploadVerdicts: [], csrf: "token-post", freshUntil: Math.floor(NOW / 1000) + 1800 }));
    };
  });
  const h = serve(lib, { post, read: (path) => (end && path.startsWith("/captain/api/chat?") ? json({ error: "session" }, 401) : null) });
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  const pending = h.source.chat.send("steward", { text: "late", clientId: "client-14" });
  const settled = assert.rejects(pending, named("SignInRequired"));
  for (let n = 0; n < 20 && h.calls.at(-1).method !== "POST"; n += 1) await tick();
  assert.equal(h.calls.at(-1).method, "POST");
  end = true;
  await assert.rejects(h.source.chat.openThread("iris"), named("SignInRequired"));
  release();
  await settled;
  assert.deepEqual(watcher.seen, []);
});

test("an event waiting out the five seconds in a hidden tab reads no chat list until the tab returns, then one", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  await h.watchRows();
  await h.time.advance(6_000);
  const from = h.calls.length;
  await h.refresh();
  h.hide();
  await h.time.advance(10_000);
  assert.deepEqual(h.chatRequests(from), []);
  h.show();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST], h.requests(from).join(", "));
});

test("chat rows on screen when the tab returns get one list read after the cards read, with no event", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  await h.watchRows();
  await h.time.advance(6_000);
  h.hide();
  await h.time.advance(30_000);
  const from = h.calls.length;
  h.show();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST], h.requests(from).join(", "));
  assert.ok(h.requests(from).includes(TOKEN), h.requests(from).join(", "));
  assert.ok(h.requests(from).indexOf(TOKEN) < h.requests(from).indexOf(LIST));
});

test("with nothing of chat on screen the tab returning reads no chat list", async () => {
  const h = serve();
  await h.boot();
  await h.source.chat.listChats();
  await h.time.advance(6_000);
  h.hide();
  await h.time.advance(30_000);
  const from = h.calls.length;
  h.show();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), []);
  assert.ok(h.requests(from).includes(TOKEN), h.requests(from).join(", "));
});

test("Show older sends the before id percent-encoded as one value, and an odd bot id is refused before any request", async () => {
  const odd = "m&1#2/3?4%5+6 7";
  const page = { bot: { id: "steward", note: "the steward" }, messages: Array.from({ length: 15 }, (_, n) => ({ id: n === 0 ? odd : "m" + (100 + n), from: "bot", text: "text " + n, at: stamp(n + 1), refs: [] })), seenUpTo: null, seenAt: null, working: null, older: true };
  const h = serve(lib, { read: (path) => (path.startsWith("/captain/api/chat?") && !path.includes("before=") ? json(page) : null) });
  await h.boot();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  await h.source.chat.older("steward");
  const asked = h.calls.slice(from).find((call) => call.path.startsWith("/captain/api/chat?"));
  assert.ok(asked, h.requests(from).join(", "));
  const url = new URL(asked.path, "https://qd.test");
  assert.equal(url.pathname, "/captain/api/chat");
  assert.deepEqual([...url.searchParams.keys()], ["bot", "before"]);
  assert.equal(url.searchParams.get("before"), odd);
  assert.equal(asked.path.split("&").length, 2);
  assert.equal(asked.path.split("?").length, 2);
  const after = h.calls.length;
  await assert.rejects(h.source.chat.openThread("a&b#c/d?e%f+g h"), refusedWith("This bot is not in your chat list."));
  assert.equal(h.calls.length, after);
});

const marks = (h) => h.calls.filter((call) => call.method === "POST" && call.path === "/captain/api/chat/read");

const marking = (more = {}) => ({ features: ["quote", "read"], firstUnread: "m3", unread: ["steward"], ...more });

function v2(state) {
  return {
    rows: (full) => full.map((one) => ({ ...one, unread: (state.unread ?? []).includes(one.bot.id), ...(state.rowRev === undefined ? {} : { rev: state.rowRev }) })),
    thread: (body) => {
      const newest = [...body.messages].reverse().find((one) => one.from === "bot")?.id ?? null;
      return { ...body, firstUnread: state.auto ? newest : (state.firstUnread ?? null), features: state.features ?? [], ...(state.threadRev === undefined ? {} : { rev: state.threadRev }) };
    },
    read: (path, init) => {
      if (path !== "/captain/api/chat/read" || init.method !== "POST") return null;
      const made = state.answer?.() ?? json({ csrf: "token-read", freshUntil: Math.floor(NOW / 1000) + 1800 });
      if (made.status === 200 && !state.keep) {
        state.unread = [];
        state.firstUnread = null;
      }
      return made;
    },
  };
}

test("a watched thread with read on and a firstUnread is marked read once: a token read and one POST naming the newest bot message, three credits, and the row's dot clears", async () => {
  const state = marking();
  const h = serve(lib, v2(state));
  await h.boot();
  assert.equal((await h.source.chat.listChats()).find((one) => one.bot.id === "steward").unread, true);
  const rows = await h.watchRows();
  await h.source.chat.openThread("steward");
  const from = h.calls.length;
  const heardBefore = rows.heard.length;
  await h.watchThread("steward");
  await h.time.advance(1_000);
  await tick();
  assert.deepEqual(h.requests(from), [TOKEN, READ]);
  assert.equal(h.credits(from), 3);
  const [mark] = marks(h);
  assert.deepEqual(Object.keys(mark.body), ["bot", "upTo", "csrf"]);
  assert.deepEqual([mark.body.bot, mark.body.upTo], ["steward", "m3"]);
  assert.equal((await h.source.chat.listChats()).find((one) => one.bot.id === "steward").unread, false);
  assert.ok(rows.heard.length > heardBefore);
  await h.time.advance(60_000);
  assert.equal(marks(h).length, 1);
  assert.equal((await h.source.chat.listChats()).find((one) => one.bot.id === "steward").unread, false);
});

test("nothing is marked when the thread has no read feature or no firstUnread, when nothing watches it, or when the server is r5's", async () => {
  for (const more of [{ features: [] }, { features: ["quote", "seen", "working", "files"] }, { features: ["read"], firstUnread: null }]) {
    const h = serve(lib, v2(marking(more)));
    await h.boot();
    await h.source.chat.openThread("steward");
    await h.watchThread("steward");
    await h.time.advance(20_000);
    assert.deepEqual(marks(h), [], JSON.stringify(more));
  }
  const unwatched = serve(lib, v2(marking()));
  await unwatched.boot();
  await unwatched.source.chat.openThread("steward");
  await unwatched.time.advance(20_000);
  assert.deepEqual(marks(unwatched), []);
  const old = serve();
  await old.boot();
  await old.source.chat.openThread("steward");
  await old.watchThread("steward");
  await old.time.advance(20_000);
  assert.deepEqual(marks(old), []);
});

test("a thread opened in a hidden tab is marked only when the tab returns, and once", async () => {
  const h = serve(lib, v2(marking()));
  await h.boot();
  await h.source.chat.openThread("steward");
  h.hide();
  await h.watchThread("steward");
  await h.time.advance(30_000);
  assert.deepEqual(marks(h), []);
  h.show();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.equal(marks(h).length, 1);
});

test("a failed mark-read is not tried again in a loop: one POST, then one more only for a newer bot message", async () => {
  const state = marking({ answer: () => new Response("", { status: 503 }) });
  const h = serve(lib, v2(state));
  await h.boot();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.time.advance(30_000);
  assert.equal(marks(h).length, 1);
  await h.time.advance(120_000);
  assert.equal(marks(h).length, 1);
  await h.refresh();
  await h.time.advance(12_000);
  assert.equal(marks(h).length, 1);
  state.answer = null;
  h.add("steward", "bot", "a reply");
  state.firstUnread = "m6";
  await h.refresh();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.deepEqual(marks(h).map((call) => call.body.upTo), ["m3", "m6"]);
});

test("a chat opened with a long unread run is marked once whatever the server keeps saying, and bot messages that arrive after the open get one more POST naming the newest, with no timer sending either again", async () => {
  const state = marking({ keep: true, rowRev: 1, threadRev: 1 });
  const h = serve(lib, v2(state));
  for (let n = 1; n <= 18; n += 1) h.add("steward", "bot", "drive many " + n);
  const shown = h.threads.get("steward").at(-1).id;
  await h.boot();
  await h.source.chat.openThread("steward");
  const opened = h.calls.length;
  await h.watchThread("steward");
  await h.time.advance(1_000);
  await tick();
  assert.deepEqual(h.requests(opened), [TOKEN, READ]);
  assert.deepEqual(marks(h).map((call) => call.body.upTo), [shown]);
  const reread = h.calls.length;
  state.rowRev = 2;
  state.threadRev = 2;
  await h.refresh();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(reread), [LIST, THREAD("steward")]);
  await h.time.advance(120_000);
  assert.deepEqual(marks(h).map((call) => call.body.upTo), [shown]);
  const late = [];
  for (let n = 19; n <= 22; n += 1) late.push(h.add("steward", "bot", "drive many " + n));
  state.firstUnread = late[0].id;
  const arrived = h.calls.length;
  await h.refresh();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(arrived), [LIST, THREAD("steward"), READ]);
  assert.deepEqual(marks(h).map((call) => call.body.upTo), [shown, late[3].id]);
  await h.time.advance(120_000);
  state.rowRev = 3;
  state.threadRev = 3;
  await h.refresh();
  await h.time.advance(12_000);
  await h.time.advance(120_000);
  assert.deepEqual(marks(h).map((call) => call.body.upTo), [shown, late[3].id]);
});

test("leaving the thread and opening it again tries a failed mark again, and after a success marks nothing more", async () => {
  let fail = true;
  const h = serve(lib, v2(marking({ answer: () => (fail ? new Response("", { status: 503 }) : null) })));
  await h.boot();
  await h.source.chat.openThread("steward");
  const first = await h.watchThread("steward");
  await h.time.advance(30_000);
  assert.equal(marks(h).length, 1);
  first.stop();
  fail = false;
  await h.source.chat.openThread("steward");
  const second = await h.watchThread("steward");
  await h.time.advance(30_000);
  assert.equal(marks(h).length, 2);
  second.stop();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.time.advance(30_000);
  assert.equal(marks(h).length, 2);
});

test("the session end forgets the marks, so after signing in the same message is marked again", async () => {
  let end = false;
  const base = v2(marking({ keep: true }));
  const h = serve(lib, { ...base, read: (path, init) => (end && path.startsWith("/captain/api/chat?") ? json({ error: "session" }, 401) : base.read(path, init)) });
  await h.boot();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.time.advance(30_000);
  assert.equal(marks(h).length, 1);
  end = true;
  await assert.rejects(h.source.chat.openThread("steward"), named("SignInRequired"));
  end = false;
  h.source.signIn();
  await h.source.load();
  await tick();
  await h.source.chat.openThread("steward");
  await h.time.advance(30_000);
  assert.equal(marks(h).length, 2);
});

test("a row rev that differs from the held thread's reads the thread once, and a thread answer that lags reads it once per row state", async () => {
  const state = marking({ features: [], firstUnread: null, unread: [], rowRev: 1, threadRev: 1 });
  const h = serve(lib, v2(state));
  await h.boot();
  await h.source.chat.openThread("steward");
  const watcher = await h.watchThread("steward");
  await h.time.advance(6_000);
  const from = h.calls.length;
  state.rowRev = 2;
  state.threadRev = 2;
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST, THREAD("steward")]);
  assert.ok(watcher.seen.length >= 1);
  const again = h.calls.length;
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(again), [LIST]);
  const lag = h.calls.length;
  state.rowRev = 7;
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(lag), [LIST, THREAD("steward")]);
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(lag), [LIST, THREAD("steward"), LIST]);
  const restart = h.calls.length;
  state.rowRev = 1;
  state.threadRev = 1;
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(restart), [LIST, THREAD("steward")]);
});

test("rows and threads without a rev read nothing extra, whatever else changes", async () => {
  const state = marking({ features: ["seen"], firstUnread: null, unread: [] });
  const h = serve(lib, v2(state));
  await h.boot();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.time.advance(6_000);
  const from = h.calls.length;
  state.features = ["seen", "working"];
  await h.refresh();
  await h.time.advance(6_000);
  assert.deepEqual(h.chatRequests(from), [LIST]);
});

test("one busy minute with read on and each reply unread costs eighteen credits, and the last list read waits for the automatic budget of twenty-one", async () => {
  const state = marking({ features: ["read"], firstUnread: null, unread: [] });
  const h = serve(lib, v2(state));
  await h.boot();
  const from = h.calls.length;
  await h.source.chat.listChats();
  await h.watchRows();
  await h.source.chat.openThread("steward");
  await h.watchThread("steward");
  await h.source.chat.send("steward", { text: "one", clientId: "client-12" });
  await h.time.advance(6_000);
  state.auto = true;
  h.add("steward", "bot", "reply one");
  await h.refresh();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  await h.source.chat.send("steward", { text: "two", clientId: "client-13" });
  await h.time.advance(6_000);
  h.add("steward", "bot", "reply two");
  await h.refresh();
  await h.time.advance(6_000);
  await h.time.advance(6_000);
  await h.refresh();
  await h.time.advance(6_000);
  assert.equal(marks(h).length, 2);
  const own = () => h.calls.slice(from).filter((call) => call.path.startsWith("/captain/api/chat") || call.path === "/captain/cards");
  const total = () => own().reduce((sum, call) => sum + (call.method === "POST" ? 2 : 1), 0);
  assert.equal(total(), 18, own().map((call) => call.method + " " + call.path).join(", "));
  assert.ok(total() <= 29);
  const lists = () => h.chatRequests(from).filter((one) => one === LIST).length;
  const before = lists();
  await h.time.advance(60_000);
  assert.equal(lists(), before + 1);
});

const bare = (answer) => {
  const calls = [];
  const send = async (path, init) => {
    calls.push(init.method + " " + path);
    if (path === "/captain/cards") return json({ ...structuredClone(LISTING), csrf: "token-1" }, 200, { ETag: '"list-1"' });
    if (path === "/captain/api/chat/read") return answer(init);
    return json("{}", 404);
  };
  const client = lib.createApiClient({ send, openEvents: () => ({ readyState: 0, addEventListener() {}, close() {} }), schedule: () => () => undefined });
  return { client, calls };
};

test("the mark-read POST goes to its own path after a fresh token read, and its answers map as send's do", async () => {
  const good = bare(() => json({ csrf: "token-2", freshUntil: 1794000060 }));
  await good.client.chat.read("steward", "m3");
  assert.deepEqual(good.calls, ["GET /captain/cards", "POST /captain/api/chat/read"]);
  assert.equal(good.client.freshUntil(), 1794000060);
  for (const [status, name] of [[429, "RateLimited"], [401, "SignInRequired"], [403, "SignInRequired"], [503, "NotConfirmed"], [500, "NotConfirmed"], [400, "Refused"]]) {
    await assert.rejects(bare(() => new Response("", { status })).client.chat.read("steward", "m3"), named(name), String(status));
  }
  await assert.rejects(bare(() => json({ message: "ok" })).client.chat.read("steward", "m3"), named("NotConfirmed"));
  await assert.rejects(bare(() => new Response("not json", { status: 200 })).client.chat.read("steward", "m3"), named("NotConfirmed"));
  const refused = bare(() => json({ csrf: "t", freshUntil: 1 }));
  await assert.rejects(refused.client.chat.read("has space", "m3"), refusedWith("This bot is not in your chat list."));
  assert.deepEqual(refused.calls, []);
});
