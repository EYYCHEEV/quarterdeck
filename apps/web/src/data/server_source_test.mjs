import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle() {
  const contents = ["api-client", "server-source", "loader", "session"].map((name) => 'export * from "./src/data/' + name + '";').concat(["queue", "query"].map((name) => 'export * from "./src/domain/' + name + '";')).join("\n");
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", define: { __QD_SOURCE__: '"server"', "process.env.NODE_ENV": '"production"' } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const lib = await bundle();
const { createApiClient, createServerSource: realServerSource, createLoader, readSession, writeSession, clearSession, SignInRequired, NotFound, Unavailable, rankQueue, viewQueue, EMPTY_QUERY, isChanged } = lib;
const sourceTimes = new WeakMap();
const createServerSource = (client, clock, schedule) => {
  if (schedule) return realServerSource(client, clock, schedule);
  const time = fakeClock();
  const source = realServerSource(client, time.now, time.schedule);
  sourceTimes.set(source, time);
  return source;
};
const advance = (source, milliseconds = 5_000) => sourceTimes.get(source).advance(milliseconds);

const payload = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const FIXED = payload("list-fixed-only.json");
const ADDED = payload("list-added.json");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const SEEN_AT = "2026-11-02T15:00:00.000Z";
const ETAG = '"5f0c6d3a9b1e47d28c4a0e7b3f6d91a2c8e5b04d7a3f16c9e2b8d5a07c4f1e36"';

const list = (body = ADDED) => new Response(body, { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
const failure = (status, error) => new Response(JSON.stringify({ error }), { status });

function withGlobal(name, value, run) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const restore = () => Object.defineProperty(globalThis, name, before ?? { value: undefined, configurable: true, writable: true });
  return Promise.resolve(run()).finally(restore);
}

const memory = () => {
  const held = new Map();
  return { held, getItem: (key) => held.get(key) ?? null, setItem: (key, text) => void held.set(key, String(text)), removeItem: (key) => void held.set(key, null) };
};

function make(responses, extra = {}) {
  const queue = [...responses];
  const send = async () => queue.shift();
  const client = createApiClient({ send, ...extra });
  return createServerSource(client, () => NOW);
}

const cardsOf = (world) => Object.fromEntries(world.cards.map((card) => [card.id, card]));
const ids = (world) => world.cards.map((card) => card.id);

test("the world holds the open cards and the answered ones, in the list's order, and leaves out the withdrawn", async () => {
  const world = await make([list()]).load();
  assert.deepEqual(ids(world), ["alba-1", "alba-2", "kivo-3", "alba-9", "kivo-10", "shelvorn-4", "shelvorn-5", "shelvorn-7", "kivo-8"]);
});

test("an open card carries what the list says and a plain default for everything it does not", async () => {
  const card = cardsOf(await make([list()]).load())["shelvorn-4"];
  assert.deepEqual(card, {
    id: "shelvorn-4",
    version: 1,
    title: "Approve the Settings sections",
    priority: "",
    owner: "shelvorn",
    projectId: "quarterdeck",
    laneId: "quarterdeck/Settings",
    addedAt: "2026-11-02T08:45:00-05:00",
    due: "2026-11-02T18:00:00-05:00",
    about: null,
    description: null,
    ascii: null,
    skip: null,
    options: [],
    pickWhy: null,
    approvalDoor: "two-way",
    unblocks: [],
    labels: [],
    evidence: [],
    media: [],
    commands: [],
    changes: [],
    versions: [],
    seenAt: null,
    answer: null,
    more: { context: [], words: [], learn: [], note: null },
  });
});

test("the version is the list's rev, and a card with no due keeps null", async () => {
  const cards = cardsOf(await make([list()]).load());
  assert.equal(cards["alba-1"].version, 3);
  assert.equal(cards["alba-2"].due, null);
});

test("an answered card carries the pick, its time, the version and who it waits on", async () => {
  const cards = cardsOf(await make([list()]).load());
  assert.deepEqual(cards["alba-9"].answer, { choice: { kind: "none" }, at: "2026-11-01T21:10:00-05:00", note: "", version: 1, waitingOn: "alba", outcome: null });
  assert.deepEqual(cards["shelvorn-5"].answer, { choice: { kind: "option", letter: "A" }, at: "2026-11-02T09:00:00-05:00", note: "", version: 2, waitingOn: "shelvorn", outcome: null });
});

test("a cant-decide pick closes the card like any other answer, and the card waits on its poster", async () => {
  const cards = cardsOf(await make([list()]).load());
  assert.deepEqual(cards["kivo-10"].answer, { choice: { kind: "cant-decide" }, at: "2026-11-02T07:20:00-05:00", note: "", version: 2, waitingOn: "kivo", outcome: null });
});

test("with only the fixed fields the poster is empty, the version is 1, and cards that need an answer to show are left out", async () => {
  const world = await make([list(FIXED)]).load();
  assert.deepEqual(ids(world), ["alba-1", "alba-2", "kivo-3", "shelvorn-4", "shelvorn-7", "kivo-8"]);
  assert.deepEqual(world.cards.map((card) => [card.owner, card.version]), world.cards.map(() => ["", 1]));
});

test("projects are keyed by their exact name, and a lane by its project and name, so one lane name under two projects stays two lanes", async () => {
  const world = await make([list()]).load();
  assert.deepEqual(world.projects.map((project) => [project.id, project.name]), [["quarterdeck", "quarterdeck"], ["heron-forge", "heron-forge"]]);
  assert.deepEqual(world.projects.map((project) => project.activeAt), ["2026-11-02T09:40:00-05:00", "2026-11-02T09:55:00-05:00"]);
  assert.deepEqual(
    world.lanes.map((lane) => [lane.id, lane.projectId, lane.name]),
    [
      ["quarterdeck/Search", "quarterdeck", "Search"],
      ["quarterdeck/Settings", "quarterdeck", "Settings"],
      ["heron-forge/Bridge", "heron-forge", "Bridge"],
      ["heron-forge/Search", "heron-forge", "Search"],
    ],
  );
  assert.deepEqual(world.lanes[0], { id: "quarterdeck/Search", projectId: "quarterdeck", name: "Search", status: "Active", lead: "", now: "", activity: [], lastLooked: null });
  assert.deepEqual(cardsOf(world)["kivo-8"].laneId, "heron-forge/Search");
});

test("what the Queue does not need is empty", async () => {
  const world = await make([list()]).load();
  for (const key of ["tasks", "pages", "artifacts", "mail", "bots"]) assert.deepEqual(world[key], [], key);
});

test("the Queue rules order the waiting cards by due, no due last, then the newest change", async () => {
  const world = await make([list()]).load();
  assert.deepEqual(rankQueue(world.cards, world.tasks, NOW).map((row) => row.card.id), ["shelvorn-4", "shelvorn-7", "alba-1", "kivo-3", "kivo-8", "alba-2"]);
});

test("the Queue view counts the waiting cards, leaves out the Priority filter, and lists the answers newest first", async () => {
  const world = await make([list()]).load();
  const view = viewQueue(world, EMPTY_QUERY, NOW);
  assert.equal(view.count, "6 waiting");
  assert.equal(view.groups.some((group) => group.key === "priority"), false);
  assert.deepEqual(view.sorts.map((sort) => sort.value), ["due", "newest", "changed", "project"]);
  const answered = viewQueue(world, { ...EMPTY_QUERY, filters: { show: "answered" } }, NOW);
  assert.deepEqual(answered.rows.map((row) => row.card.id), ["shelvorn-5", "kivo-10", "alba-9"]);
});

test("the clock the source was given is its now", () => {
  assert.equal(make([]).now(), NOW);
});

test("a card he marked seen reads as seen on the next load, is stored in the browser, and a new source finds the mark", async () => {
  const store = memory();
  await withGlobal("localStorage", store, async () => {
    const source = make([list(), list()]);
    const first = cardsOf(await source.load());
    assert.equal(first["alba-1"].seenAt, null);
    assert.equal(isChanged(first["alba-1"]), true);
    source.markSeen("alba-1");
    assert.equal(store.held.get("qd.seen"), JSON.stringify({ "alba-1": SEEN_AT }));
    advance(source);
    const second = cardsOf(await source.load());
    assert.equal(second["alba-1"].seenAt, SEEN_AT);
    assert.equal(isChanged(second["alba-1"]), false);
    assert.equal(second["alba-2"].seenAt, null);
    const later = cardsOf(await make([list()]).load());
    assert.equal(later["alba-1"].seenAt, SEEN_AT);
  });
});

test("stored marks that are not a map of times are ignored", async () => {
  const store = memory();
  store.held.set("qd.seen", JSON.stringify(["alba-1"]));
  await withGlobal("localStorage", store, async () => {
    assert.equal(cardsOf(await make([list()]).load())["alba-1"].seenAt, null);
  });
  store.held.set("qd.seen", JSON.stringify({ "alba-1": 5, "alba-2": SEEN_AT }));
  await withGlobal("localStorage", store, async () => {
    const cards = cardsOf(await make([list()]).load());
    assert.deepEqual([cards["alba-1"].seenAt, cards["alba-2"].seenAt], [null, SEEN_AT]);
  });
});

for (const [status, error] of [
  [401, "sign in required"],
  [403, "request refused"],
]) {
  test("a " + status + " fails the load as sign in again and keeps the seen marks, in memory and in the browser (only the server's sign-out clears them)", async () => {
    const store = memory();
    await withGlobal("localStorage", store, async () => {
      const source = make([list(), failure(status, error), list()]);
      await source.load();
      source.markSeen("alba-1");
      const kept = store.held.get("qd.seen");
      advance(source);
      await assert.rejects(source.load(), (thrown) => thrown instanceof SignInRequired);
      assert.equal(store.held.get("qd.seen"), kept);
      source.signIn();
      advance(source);
      assert.equal(cardsOf(await source.load())["alba-1"].seenAt, SEEN_AT);
    });
  });
}

test("another failure leaves the seen marks alone", async () => {
  const store = memory();
  await withGlobal("localStorage", store, async () => {
    const source = make([list(), failure(503, "request unavailable"), list()]);
    await source.load();
    source.markSeen("alba-1");
    advance(source);
    await assert.rejects(source.load(), (error) => error instanceof Unavailable);
    advance(source);
    assert.equal(cardsOf(await source.load())["alba-1"].seenAt, SEEN_AT);
  });
});

test("watch publishes the admitted event list and stop closes the stream", async () => {
  const { streams, openEvents } = streamTransport();
  const source = make([list(), list()], { openEvents });
  await source.load();
  let calls = 0;
  const stop = source.watch(() => (calls += 1));
  advance(source, 0);
  streams[0].emit("refresh", '{"cards":true,"chats":true}');
  advance(source);
  await tick();
  assert.equal(calls, 1);
  stop();
  assert.equal(streams[0].closed, 1);
});

test("what is not built on the server yet fails plainly or comes back empty, and never touches the network", async () => {
  const source = make([]);
  for (const call of [() => source.openPage("pages/x.html"), () => source.publishPage("PG-1", 1), () => source.unpublishPage("PG-1"), () => source.chat.openThread("alba"), () => source.secrets.remove("s1")]) {
    await assert.rejects(call(), { name: "Refused" });
  }
  assert.deepEqual(await source.trackers(), {});
  assert.equal(await source.evidence("alba-1"), null);
  assert.deepEqual(await source.chat.listChats(), []);
  assert.equal(source.chat.uploadBoundary, "server");
  assert.deepEqual([source.secrets.rows("alba"), source.secrets.requests("alba"), source.secrets.events("alba")], [[], [], []]);
  assert.equal(source.secrets.status(), "ready");
  assert.doesNotThrow(() => source.markLooked("quarterdeck/Search"));
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

test("a normal build carries none of the server client, and a server build carries it", async () => {
  const normal = await appCode("example");
  const server = await appCode("server");
  for (const mark of ["/captain/cards", "/captain/events", "qd.seen"]) {
    assert.equal(normal.includes(mark), false, "normal build holds " + mark);
    assert.equal(server.includes(mark), true, "server build lacks " + mark);
  }
});

const OPEN = payload("card-open.json");
const ANSWERED = payload("card-answered.json");
const OLDER = JSON.stringify({ ...JSON.parse(OPEN), rev: 2 });
const one = (body) => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

function serve(routes, extra = {}) {
  const calls = [];
  const send = async (path) => {
    calls.push(path);
    const route = routes[path];
    return route ? route(calls.filter((call) => call === path).length) : failure(404, "not found");
  };
  const source = createServerSource(createApiClient({ send, ...extra }), () => NOW);
  return { source, calls, cardCalls: () => calls.filter((call) => call.startsWith("/captain/cards/")).length };
}

const fakeEvents = () => ({ addEventListener: () => undefined, close: () => undefined });
const arrivals = (source) => {
  const waiting = [];
  source.watch(() => waiting.shift()?.());
  return () => new Promise((resolve) => waiting.push(resolve));
};

test("a card cannot be opened before the list is loaded, or when it is not in the list, and then nothing is asked", async () => {
  const { source, calls } = serve({ "/captain/cards": () => list(), "/captain/cards/shelvorn-6": () => one(payload("card-withdrawn.json")) });
  await assert.rejects(source.openCard("alba-1"), (error) => error instanceof NotFound);
  await source.load();
  await assert.rejects(source.openCard("shelvorn-6"), (error) => error instanceof NotFound);
  await assert.rejects(source.openCard("nobody"), (error) => error instanceof NotFound);
  assert.deepEqual(calls, ["/captain/cards"]);
});

test("an opened card carries its detail on the next load, keeps what the list gave, and leaves the other cards as they were", async () => {
  const { source, calls } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": () => one(OPEN) }, { openEvents: fakeEvents });
  await source.load();
  await source.openCard("alba-1");
  advance(source);
  const cards = cardsOf(await source.load());
  assert.deepEqual(calls.filter((call) => call !== "/captain/cards"), ["/captain/cards/alba-1"]);
  assert.deepEqual(cards["alba-1"].options.map((option) => option.letter), ["A", "B", "C"]);
  assert.equal(cards["alba-1"].more.context.length, 2);
  assert.deepEqual([cards["alba-1"].version, cards["alba-1"].owner, cards["alba-1"].laneId, cards["alba-1"].addedAt], [3, "alba", "quarterdeck/Search", "2026-11-02T09:40:00-05:00"]);
  assert.deepEqual([cards["shelvorn-4"].options, cards["shelvorn-4"].more.context], [[], []]);
});

test("an opened answered card carries the note of its answer", async () => {
  const { source } = serve({ "/captain/cards": () => list(), "/captain/cards/shelvorn-5": () => one(ANSWERED) });
  await source.load();
  await source.openCard("shelvorn-5");
  advance(source);
  assert.equal(cardsOf(await source.load())["shelvorn-5"].answer.note, "Yes, Storage is its own section.");
});

test("a seen mark stays on an opened card", async () => {
  const store = memory();
  await withGlobal("localStorage", store, async () => {
    const { source } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": () => one(OPEN) });
    await source.load();
    source.markSeen("alba-1");
    await source.openCard("alba-1");
    advance(source);
    assert.equal(cardsOf(await source.load())["alba-1"].seenAt, SEEN_AT);
  });
});

test("the watchers are told when a card has arrived, so the loaders reload, and not after they stop", async () => {
  const { source } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": () => one(OPEN) }, { openEvents: fakeEvents });
  await source.load();
  let told = 0;
  const stop = source.watch(() => (told += 1));
  await source.openCard("alba-1");
  assert.equal(told, 1);
  stop();
  await source.openCard("alba-1");
  assert.equal(told, 1);
});

test("a card whose rev is older than the list's is read again once in the background, and then shows", async () => {
  const { source, cardCalls } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": (n) => one(n === 1 ? OLDER : OPEN) }, { openEvents: fakeEvents });
  const next = arrivals(source);
  await source.load();
  const opened = next();
  await source.openCard("alba-1");
  await opened;
  const reread = next();
  advance(source);
  assert.deepEqual(cardsOf(await source.load())["alba-1"].options, []);
  await reread;
  assert.equal(cardCalls(), 2);
  advance(source);
  assert.equal(cardsOf(await source.load())["alba-1"].options.length, 3);
  assert.equal(cardCalls(), 2);
});

test("a server that keeps answering an older rev is asked once more, not in a loop", async () => {
  const { source, cardCalls } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": () => one(OLDER) }, { openEvents: fakeEvents });
  const next = arrivals(source);
  await source.load();
  await source.openCard("alba-1");
  const reread = next();
  advance(source);
  await source.load();
  await reread;
  for (let at = 0; at < 4; at += 1) {
    advance(source);
    await source.load();
  }
  assert.equal(cardCalls(), 2);
});

for (const [status, error] of [
  [401, "sign in required"],
  [403, "request refused"],
]) {
  test("a " + status + " on a card read drops opened cards but keeps the seen marks", async () => {
    const store = memory();
    await withGlobal("localStorage", store, async () => {
      const { source } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": (n) => (n === 1 ? one(OPEN) : failure(status, error)) });
      await source.load();
      source.markSeen("alba-1");
      const kept = store.held.get("qd.seen");
      await source.openCard("alba-1");
      await assert.rejects(source.openCard("alba-1"), (thrown) => thrown instanceof SignInRequired);
      assert.equal(store.held.get("qd.seen"), kept);
      source.signIn();
      advance(source);
      const card = cardsOf(await source.load())["alba-1"];
      assert.deepEqual([card.options.length, card.seenAt], [0, SEEN_AT]);
    });
  });
}

test("another failure on a card read rejects and leaves the opened cards alone", async () => {
  const { source } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": (n) => (n === 1 ? one(OPEN) : failure(503, "request unavailable")) });
  await source.load();
  await source.openCard("alba-1");
  await assert.rejects(source.openCard("alba-1"), (thrown) => thrown instanceof Unavailable);
  advance(source);
  assert.equal(cardsOf(await source.load())["alba-1"].options.length, 3);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const status of [401, 403, 503, "network"]) {
  test("a loaded Queue then " + status + " separates private-session clearing from offline retention and keeps persisted local data", async () => {
    const store = memory();
    const draft = { text: "Keep this draft", quote: null, files: [] };
    writeSession("chat.draft.alba", draft);
    store.held.set("qd.settings", '{"appearance":"dark"}');
    await withGlobal("localStorage", store, async () => {
      const calls = [];
      let asks = 0;
      const send = async (path, init) => {
        calls.push({ path, init });
        asks += 1;
        if (asks === 2) {
          if (status === "network") throw new TypeError("offline");
          return failure(status, "not available");
        }
        return list();
      };
      const source = createServerSource(createApiClient({ send, openEvents: fakeEvents }), () => NOW);
      const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
      const stop = loader.subscribe(() => {});
      await tick();
      const first = loader.snapshot().value;
      assert.ok(first.cards.length);
      source.markSeen("alba-1");
      const kept = new Map(store.held);
      loader.refresh();
      advance(source);
      await tick();
      const expired = status === 401 || status === 403;
      assert.equal(loader.snapshot().value, expired ? null : first);
      assert.equal(loader.snapshot().signIn, expired ? true : undefined);
      assert.equal(loader.snapshot().failed, true);
      assert.deepEqual(store.held, kept);
      assert.equal(readSession("chat.draft.alba", null), expired ? null : draft);
      if (expired) source.signIn();
      loader.refresh();
      advance(source);
      await tick();
      assert.ok(loader.snapshot().value.cards.length);
      assert.notEqual(loader.snapshot().value, first);
      assert.equal(loader.snapshot().signIn, undefined);
      if (expired) assert.equal("If-None-Match" in calls[2].init.headers, false);
      stop();
    });
  });
}

for (const status of [401, 403]) {
  test("229: a held answer cannot survive another channel's " + status + " exit or restore private session values after fresh recovery", async () => {
    clearSession();
    const old = JSON.parse(ADDED);
    const title = old.projects[0].lanes[0].cards[0].title;
    const fresh = JSON.parse(ADDED);
    fresh.projects[0].lanes[0].cards[0].title = "A different account's fresh card";
    const privateValues = [
      ["receipt", { text: "Got it: " + title, cardId: null }],
      ["answer.alba-1", { phase: "sending", note: "Private old answer" }],
      ["queue.query", { search: "Private old search" }],
      ["queue.scroll", 42],
      ["pages.query.old", { search: "Private old pages" }],
      ["page.reading.old", 3],
      ["chat.draft.alba", { text: "Private old draft", quote: null, files: [{ url: "blob:old-private-draft" }] }],
      ["chat.pending.alba", [{ previews: [{ url: "blob:old-private-pending" }] }]],
      ["mail.query", { search: "Private old mail" }],
      ["mail.scroll", 24],
    ];
    for (const [key, value] of privateValues) writeSession(key, value);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let started;
    const sent = new Promise((resolve) => { started = resolve; });
    let expired = false;
    let recovered = false;
    const source = createServerSource(createApiClient({
      async send(path, init) {
        if (init.method === "POST") {
          started();
          return held;
        }
        assert.equal(path, "/captain/cards");
        return expired ? failure(status, "session ended") : list(recovered ? JSON.stringify(fresh) : ADDED);
      },
      openEvents: fakeEvents,
    }));
    const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
    const stop = loader.subscribe(() => {});
    let answering;
    const revoked = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { revoked.push(url); };
    try {
      await tick();
      assert.ok(loader.snapshot().value.cards.some((card) => card.title === title));
      answering = source.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "Private old answer", version: 3 }).then((value) => ({ value }), (error) => ({ error }));
      await sent;
      expired = true;
      loader.refresh();
      await tick();
      assert.equal(loader.snapshot().signIn, true);
      assert.equal(loader.snapshot().value, null);
      const atExit = privateValues.map(([key]) => readSession(key, null));
      release(list(payload("answer/answer-200-current.json")));
      const outcome = await answering;
      expired = false;
      recovered = true;
      source.signIn();
      loader.refresh();
      await tick();
      assert.ok(loader.snapshot().value.cards.some((card) => card.title === "A different account's fresh card"));
      assert.deepEqual(atExit, privateValues.map(() => null), "the one session exit clears every private session value, including the receipt");
      assert.deepEqual(revoked, ["blob:old-private-draft", "blob:old-private-pending"], "session exit also revokes both private object URL families");
      assert.equal(outcome.error?.name, "SignInRequired", "the old successful POST cannot complete through the source");
      assert.deepEqual(privateValues.map(([key]) => readSession(key, null)), privateValues.map(() => null), "fresh recovery cannot resurrect the old receipt or private drafts");
    } finally {
      release(list(payload("answer/answer-200-current.json")));
      await answering;
      stop();
      clearSession();
      URL.revokeObjectURL = revoke;
    }
  });
}

for (const kind of ["list", "card"]) {
  test("a 401 from the " + kind + " read removes cached detail and list membership before fresh sign-in", async () => {
    let expired = false;
    const { source } = serve({
      "/captain/cards": () => expired && kind === "list" ? failure(401, "sign in required") : list(),
      "/captain/cards/alba-1": () => expired && kind === "card" ? failure(401, "sign in required") : one(OPEN),
    }, { openEvents: fakeEvents });
    const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
    const stop = loader.subscribe(() => {});
    await tick();
    await source.openCard("alba-1");
    advance(source);
    await tick();
    assert.equal(cardsOf(loader.snapshot().value)["alba-1"].options.length, 3);
    expired = true;
    if (kind === "list") {
      loader.refresh();
      advance(source);
      await tick();
    } else {
      await assert.rejects(source.openCard("alba-1"), (error) => error instanceof SignInRequired);
    }
    assert.equal(loader.snapshot().value, null);
    assert.equal(loader.snapshot().signIn, true);
    await assert.rejects(source.openCard("alba-1"), (error) => error instanceof NotFound);
    expired = false;
    source.signIn();
    loader.refresh();
    advance(source);
    await tick();
    assert.equal(cardsOf(loader.snapshot().value)["alba-1"].options.length, 0);
    stop();
  });
}

test("a card response started before a session ends cannot restore the previous session's detail", async () => {
  let finish;
  let ended = false;
  const { source } = serve({
    "/captain/cards": () => ended ? failure(401, "sign in required") : list(),
    "/captain/cards/alba-1": () => new Promise((resolve) => { finish = resolve; }),
  });
  await source.load();
  const pending = source.openCard("alba-1");
  ended = true;
  advance(source);
  await assert.rejects(source.load(), (error) => error instanceof SignInRequired);
  finish(one(OPEN));
  await assert.rejects(pending, (error) => error instanceof SignInRequired);
  ended = false;
  source.signIn();
  advance(source);
  assert.equal(cardsOf(await source.load())["alba-1"].options.length, 0);
});

test("server media and evidence references outside v1 never reach a Task Card", async () => {
  const body = JSON.parse(OPEN);
  Object.assign(body.card, { media: [{ kind: "image", file: "https://example.com/bot.png" }], mailRef: "MT-private", pageRefs: ["PG-private"], artifactRefs: ["AR-private"] });
  const { source } = serve({ "/captain/cards": () => list(), "/captain/cards/alba-1": () => one(JSON.stringify(body)) });
  await source.load();
  await source.openCard("alba-1");
  advance(source);
  const card = cardsOf(await source.load())["alba-1"];
  assert.deepEqual(card.media, []);
  assert.deepEqual(card.evidence, []);
});

test("a late 401 still signs out a newer loaded World, without an event-stream refresh", async () => {
  let finish;
  let asks = 0;
  const client = createApiClient({ send: async () => {
    asks += 1;
    return asks === 2 ? new Promise((resolve) => { finish = resolve; }) : list();
  }, openEvents: fakeEvents });
  const source = createServerSource(client, () => NOW);
  const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
  const stop = loader.subscribe(() => {});
  await tick();
  loader.refresh();
  loader.refresh();
  advance(source);
  await tick();
  assert.ok(loader.snapshot().value);
  finish(failure(401, "sign in required"));
  await tick();
  assert.equal(loader.snapshot().value, null);
  assert.equal(loader.snapshot().signIn, true);
  stop();
});

function streamTransport() {
  const streams = [];
  const openEvents = (url) => {
    const handlers = new Map();
    const stream = { url, readyState: 1, closed: 0, addEventListener: (name, listener) => handlers.set(name, listener), close: () => { stream.closed += 1; stream.readyState = 2; }, emit: (name, data) => handlers.get(name)?.({ data }) };
    streams.push(stream);
    queueMicrotask(() => stream.emit("open"));
    return stream;
  };
  return { streams, openEvents };
}

const posting = (channel, source) => channel === "answer"
  ? source.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "Keep this note", version: 3 })
  : source.comment("alba-1", { text: "Keep this comment", requestId: "req-1" });

const posted = (calls) => calls.filter((call) => call.init.method === "POST").length;

const plainListGet = (call) => call.init.method === "GET" && call.path === "/captain/cards" && !("If-None-Match" in call.init.headers);

const sentChannel = (channel) => channel === "answer" || channel === "comment";

for (const channel of ["list", "card", "stream", "answer", "comment"]) {
  for (const status of [401, 403]) {
    test("session-end family: " + channel + " / " + status, async () => {
      const store = memory();
      const draft = { text: "Local draft", quote: null, files: [] };
      writeSession("chat.draft.alba", draft);
      store.held.set("qd.settings", '{"appearance":"dark"}');
      await withGlobal("localStorage", store, async () => {
        const { streams, openEvents } = streamTransport();
        let ended = false;
        const calls = [];
        const send = async (path, init) => {
          calls.push({ path, init });
          if (ended) return failure(status, "sign in required");
          return path === "/captain/cards" ? list() : one(OPEN);
        };
        const source = createServerSource(createApiClient({ send, openEvents }), () => NOW);
        const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
        const stop = loader.subscribe(() => {});
        try {
          await tick();
          source.markSeen("alba-1");
          await source.openCard("alba-1");
          advance(source);
          await tick();
          assert.equal(cardsOf(loader.snapshot().value)["alba-1"].options.length, 3);
          const kept = new Map(store.held);
          const before = calls.length;
          ended = true;
          if (channel === "list") loader.refresh();
          else if (channel === "card") await assert.rejects(source.openCard("alba-1"), (error) => error instanceof SignInRequired);
          else if (channel === "stream") streams[0].emit("error");
          else await assert.rejects(posting(channel, source), (error) => error instanceof SignInRequired);
          if (channel === "list" || channel === "stream") advance(source);
          await tick();
          assert.equal(loader.snapshot().value, null);
          assert.equal(loader.snapshot().signIn, true);
          assert.equal(loader.snapshot().failed, true);
          assert.deepEqual(store.held, kept);
          assert.equal(readSession("chat.draft.alba", null), null);
          assert.equal(streams[0].closed, 1);
          await assert.rejects(source.openCard("alba-1"), (error) => error instanceof NotFound);
          streams[0].emit("error");
          await tick();
          assert.equal(calls.length, before + 1);
          if (sentChannel(channel)) assert.ok(plainListGet(calls[before]), "the answer or comment's only request is its fresh token read");
          ended = false;
          source.signIn();
          loader.refresh();
          advance(source);
          await tick();
          assert.equal(loader.snapshot().signIn, undefined);
          assert.equal(cardsOf(loader.snapshot().value)["alba-1"].options.length, 0);
          assert.equal(cardsOf(loader.snapshot().value)["alba-1"].seenAt, SEEN_AT);
          assert.equal(streams.length, 2);
          assert.equal("If-None-Match" in calls.at(-1).init.headers, false);
          assert.equal(posted(calls), 0, "the answer or comment is never sent, so never resent");
        } finally {
          stop();
        }
      });
    });
  }
}

for (const status of [503, "network"]) {
  test("a stream error with " + status + " keeps the same session but closes native reconnect", async () => {
    const { streams, openEvents } = streamTransport();
    let asks = 0;
    const send = async () => {
      asks += 1;
      if (asks === 1) return list();
      if (status === "network") throw new TypeError("offline");
      return failure(status, "unavailable");
    };
    const source = createServerSource(createApiClient({ send, openEvents }), () => NOW);
    const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
    const stop = loader.subscribe(() => {});
    try {
      await tick();
      const first = loader.snapshot().value;
      streams[0].emit("error");
      advance(source);
      await tick();
      assert.equal(asks, 2);
      assert.equal(loader.snapshot().value, first);
      assert.equal(loader.snapshot().failed, true);
      assert.equal(loader.snapshot().signIn, undefined);
      assert.equal(streams[0].closed, 1);
      assert.equal(streams.length, 1);
    } finally {
      stop();
    }
  });
}

test("repeated stream errors and loaders share one in-flight list read", async () => {
  const { streams, openEvents } = streamTransport();
  let finish;
  let asks = 0;
  const send = async () => {
    asks += 1;
    return asks === 1 ? list() : new Promise((resolve) => { finish = resolve; });
  };
  const source = createServerSource(createApiClient({ send, openEvents }), () => NOW);
  const loaders = [0, 1].map(() => createLoader(() => source.load(), (notify) => source.watch(notify)));
  const stops = loaders.map((loader) => loader.subscribe(() => {}));
  try {
    await tick();
    assert.equal(asks, 1);
    streams[0].emit("error");
    advance(source);
    assert.equal(asks, 2);
    streams[0].emit("error");
    streams[0].emit("error");
    loaders[0].refresh();
    assert.equal(asks, 2);
    finish(list(FIXED));
    await tick();
    assert.equal(asks, 2);
    assert.ok(loaders.every((loader) => loader.snapshot().value.cards.length === 6));
    assert.equal(streams.length, 2);
  } finally {
    for (const stop of stops) stop();
  }
  assert.equal(streams[0].closed, 1);
});

function fakeClock() {
  let now = 0;
  let scheduled = 0;
  const jobs = new Set();
  return {
    now: () => NOW + now,
    schedule(run, delay) {
      scheduled += 1;
      const job = { run, at: now + delay };
      jobs.add(job);
      return () => jobs.delete(job);
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const job of [...jobs].sort((a, b) => a.at - b.at)) {
        if (job.at <= now && jobs.delete(job)) job.run();
      }
    },
    pending: () => jobs.size,
    scheduled: () => scheduled,
  };
}

for (const channel of ["list", "card", "stream", "answer", "comment"]) {
  for (const status of [401, 403]) {
    for (const probe of [200, 401, 403, 503, "network"]) {
      test("61-second family: " + channel + " / " + status + " -> " + probe, async () => {
        const store = memory();
        const draft = { text: "Keep the paused draft", quote: null, files: [] };
        writeSession("chat.draft.alba", draft);
        store.held.set("qd.settings", '{"appearance":"dark"}');
        await withGlobal("localStorage", store, async () => {
          const time = fakeClock();
          const { streams, openEvents } = streamTransport();
          const fresh = JSON.parse(ADDED);
          const first = fresh.projects[0].lanes[0].cards[0];
          const oldTitle = first.title;
          first.title = "Only the new session list";
          let ended = false;
          let checking = false;
          const calls = [];
          const send = async (path, init) => {
            calls.push({ path, init });
            if (!ended) return path === "/captain/cards" ? list() : one(OPEN);
            if (!checking) return failure(status, "refused");
            if (probe === "network") throw new TypeError("offline");
            return probe === 200 ? list(JSON.stringify(fresh)) : failure(probe, "refused");
          };
          const source = createServerSource(createApiClient({ send, openEvents }), time.now, time.schedule);
          const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
          const stop = loader.subscribe(() => {});
          try {
            await tick();
            await source.openCard("alba-1");
            await tick();
            source.markSeen("alba-1");
            const kept = new Map(store.held);
            ended = true;
            if (channel === "list") loader.refresh();
            else if (channel === "card") await assert.rejects(source.openCard("alba-1"), (error) => error instanceof SignInRequired);
            else if (channel === "stream") streams[0].emit("error");
            else await assert.rejects(posting(channel, source), (error) => error instanceof SignInRequired);
            if (channel === "list" || channel === "stream") time.advance(5_000);
            await tick();
            assert.equal(loader.snapshot().value, null);
            assert.equal(loader.snapshot().signIn, true);
            assert.equal(streams[0].closed, 1);
            assert.equal(time.pending(), 1);
            const pausedCalls = calls.length;
            if (sentChannel(channel)) assert.ok(plainListGet(calls[pausedCalls - 1]), "the answer or comment's only request is its fresh token read");
            loader.refresh();
            await assert.rejects(source.load(), (error) => error instanceof SignInRequired);
            await assert.rejects(source.openCard("alba-1"), (error) => error instanceof NotFound);
            streams[0].emit("refresh", '{"cards":true}');
            streams[0].emit("error");
            const stopPassive = source.watch(() => loader.refresh());
            loader.refresh();
            time.advance(60_999);
            await tick();
            stopPassive();
            assert.equal(calls.length, pausedCalls, "passive Retry/list/card/events/watch send nothing during the pause");
            assert.equal(streams.length, 1);
            checking = true;
            time.advance(1);
            await tick();
            assert.equal(calls.length, pausedCalls + 1, "one delayed list probe");
            assert.equal(calls.at(-1).path, "/captain/cards");
            assert.equal("If-None-Match" in calls.at(-1).init.headers, false);
            assert.equal(calls.at(-1).init.method, "GET");
            assert.deepEqual(store.held, kept);
            assert.equal(readSession("chat.draft.alba", null), null);
            if (probe === 200) {
              assert.equal(loader.snapshot().signIn, undefined);
              const world = loader.snapshot().value;
              assert.equal(cardsOf(world)["alba-1"].title, first.title);
              assert.equal(JSON.stringify(world).includes(oldTitle), false);
              assert.equal(cardsOf(world)["alba-1"].options.length, 0);
              assert.equal(cardsOf(world)["alba-1"].seenAt, SEEN_AT);
              assert.equal(streams.length, 2);
            } else {
              assert.equal(loader.snapshot().value, null);
              assert.equal(loader.snapshot().signIn, true);
              assert.equal(streams.length, 1);
              loader.refresh();
              await tick();
              assert.equal(calls.length, pausedCalls + 1);
            }
            const recoveredCalls = calls.length;
            time.advance(45_000);
            await tick();
            assert.equal(calls.length, recoveredCalls + (probe === 200 ? 1 : 0), "only a recovered session resumes ordinary checks");
            assert.equal(posted(calls), 0, "the answer or comment is never sent, so never resent");
            assert.equal(time.pending(), probe === 200 ? 1 : 0);
          } finally {
            stop();
          }
        });
      });
    }
  }
}

for (const status of [401, 403]) {
  test("explicit sign-in cancels the 61-second check after " + status, async () => {
    const time = fakeClock();
    const { streams, openEvents } = streamTransport();
    let ended = false;
    let asks = 0;
    const send = async () => { asks += 1; return ended ? failure(status, "refused") : list(); };
    const source = createServerSource(createApiClient({ send, openEvents }), time.now, time.schedule);
    const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
    const stop = loader.subscribe(() => {});
    try {
      await tick();
      ended = true;
      loader.refresh();
      time.advance(5_000);
      await tick();
      assert.equal(time.pending(), 1);
      time.advance(30_000);
      ended = false;
      source.signIn();
      assert.equal(time.pending(), 0);
      loader.refresh();
      await tick();
      assert.ok(loader.snapshot().value.cards.length);
      assert.equal(loader.snapshot().signIn, undefined);
      assert.equal(streams.length, 2);
      assert.equal(asks, 3);
      time.advance(45_000);
      await tick();
      assert.equal(asks, 4, "successful explicit sign-in resumes ordinary checks");
    } finally {
      stop();
    }
  });
}

test("the delayed probe ignores a list still arriving from before the pause", async () => {
  const time = fakeClock();
  const { streams, openEvents } = streamTransport();
  let finishOldList;
  let asks = 0;
  const fresh = JSON.parse(ADDED);
  fresh.projects[0].lanes[0].cards[0].title = "The recovered session only";
  const send = async (path, init) => {
    if (path !== "/captain/cards") return failure(403, "refused");
    asks += 1;
    if (asks === 2) return new Promise((resolve) => { finishOldList = resolve; });
    if (asks === 3) {
      assert.equal("If-None-Match" in init.headers, false);
      return list(JSON.stringify(fresh));
    }
    return list();
  };
  const source = createServerSource(createApiClient({ send, openEvents }), time.now, time.schedule);
  const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
  const stop = loader.subscribe(() => {});
  try {
    await tick();
    loader.refresh();
    time.advance(5_000);
    await assert.rejects(source.openCard("alba-1"), (error) => error instanceof SignInRequired);
    assert.equal(loader.snapshot().value, null);
    time.advance(60_999);
    assert.equal(asks, 2);
    time.advance(1);
    await tick();
    assert.equal(asks, 3);
    const recovered = loader.snapshot().value;
    assert.equal(cardsOf(recovered)["alba-1"].title, "The recovered session only");
    finishOldList(list());
    await tick();
    assert.equal(loader.snapshot().value, recovered);
    assert.equal(loader.snapshot().signIn, undefined);
    assert.equal(streams.length, 2);
    assert.equal(time.pending(), 1, "recovered session keeps its ordinary check");
  } finally {
    stop();
  }
});

for (const status of [401, 403]) {
  test("manual sign-in refusal / " + status + " starts a new 61-second episode", async () => {
    const time = fakeClock();
    const { streams, openEvents } = streamTransport();
    const calls = [];
    const send = async (path, init) => {
      calls.push({ path, init });
      if (calls.length === 1) return list();
      return failure(calls.length === 3 ? status : 403, "refused");
    };
    const source = createServerSource(createApiClient({ send, openEvents }), time.now, time.schedule);
    const loader = createLoader(() => source.load(), (notify) => source.watch(notify));
    const stop = loader.subscribe(() => {});
    try {
      await tick();
      loader.refresh();
      time.advance(5_000);
      await tick();
      assert.equal(time.pending(), 1);
      source.signIn();
      assert.equal(time.pending(), 0);
      loader.refresh();
      time.advance(5_000);
      await tick();
      assert.equal(calls.length, 3);
      assert.equal(loader.snapshot().value, null);
      assert.equal(loader.snapshot().signIn, true);
      assert.equal(time.pending(), 1);
      time.advance(60_999);
      loader.refresh();
      await tick();
      assert.equal(calls.length, 3);
      assert.equal(streams.length, 1);
      time.advance(1);
      await tick();
      assert.equal(calls.length, 4);
      assert.equal(calls[3].path, "/captain/cards");
      assert.equal("If-None-Match" in calls[3].init.headers, false);
      assert.equal(loader.snapshot().value, null);
      assert.equal(loader.snapshot().signIn, true);
      assert.equal(time.pending(), 0);
      time.advance(122_000);
      await tick();
      assert.equal(calls.length, 4);
      assert.equal(streams.length, 1);
    } finally {
      stop();
    }
  });
}
