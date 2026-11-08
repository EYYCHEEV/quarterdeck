import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle() {
  const contents = ["api-client", "server-source"].map((name) => 'export * from "./src/data/' + name + '";').concat(["queue", "query"].map((name) => 'export * from "./src/domain/' + name + '";')).join("\n");
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createApiClient, createServerSource, SignInRequired, Unavailable, viewQueue, EMPTY_QUERY } = await bundle();

const FROZEN = {
  "card-answered.json": "84cbd63af796acbde426a4eb656ad6d7dd8d23da65096a145484d1378486a26b",
  "card-open-with-thread.json": "3130ff4a390cc5cb993eb58d11fad55d337d165767cb0ff9a8790520a4a50893",
  "card-withdrawn.json": "eafdd815266e2fb40a27fa73765f7257d6f6c0d8b7bbb1f8809c400fd8451655",
  "error-400-unknown-card.json": "a62e1a28a2012992de8bf4f6623f1b94719b28df321421f7b22516cbc85696bc",
  "error-401-sign-in-required.json": "1447a390632690d5f395ad08c05ed0f7d31fde2abc0cb38905fd0e7e4eb23e6b",
  "error-403-session-refused.json": "da230cf68add1006f53bc8af8a70df60153a7a3e17abd271c65d8b123ac62c9a",
  "error-503-request-unavailable.json": "5cb063712fdd8629ae562eee15d1d7f53f05879f8a13e03143ee4a7e55c41eee",
  "list-31-cards.json": "dc2681bb3a0db9f87616aadb5eecd973e01889217b92d09a55c89011c86e1cd3",
  "list-not-modified-304.json": "92c4ee29fb938872cfe75ed215a06bbbacf9106045514bb4e519abb33e722dfa",
};

const read = (name) => fs.readFileSync(new URL("./server-payloads/recorded/" + name, import.meta.url));
const sample = (name) => JSON.parse(read(name).toString("utf8"));
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const SEEN_AT = "2026-11-02T15:00:00.000Z";

function recorded(name) {
  const { status, headers, body } = sample(name);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function serving(names, extra = {}) {
  const queue = [...names];
  const calls = [];
  const send = async (path, init) => {
    calls.push({ path, headers: init.headers });
    return recorded(queue.shift());
  };
  return { calls, client: createApiClient({ send, ...extra }) };
}

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
  };
}

const sourceOf = (names, time = fakeClock()) => createServerSource(serving(names).client, time.now, time.schedule);
const byId = (world) => Object.fromEntries(world.cards.map((card) => [card.id, card]));

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

test("the nine recorded samples in the repo are the frozen bytes of the cards API v1 samples", () => {
  for (const [name, hash] of Object.entries(FROZEN)) assert.equal(createHash("sha256").update(read(name)).digest("hex"), hash, name);
  assert.deepEqual(fs.readdirSync(new URL("./server-payloads/recorded/", import.meta.url)).sort(), Object.keys(FROZEN));
});

test("the recorded list reads as 31 cards: 24 open, 4 done and 3 withdrawn, none cut off", async () => {
  const listing = await serving(["list-31-cards.json"]).client.cards();
  const count = (state) => listing.cards.filter((card) => card.state === state).length;
  assert.deepEqual([listing.cards.length, count("open"), count("done"), count("withdrawn"), listing.truncated], [31, 24, 4, 3, false]);
});

test("the card an update moved to another lane is listed once, under the lane it has now, with its rev and its poster", async () => {
  const listing = await serving(["list-31-cards.json"]).client.cards();
  const moved = listing.cards.filter((card) => card.id === "repo-lead-7");
  assert.equal(moved.length, 1);
  assert.deepEqual([moved[0].project, moved[0].lane, moved[0].rev, moved[0].from], ["Repo", "Review", 3, "repo-lead"]);
  const world = await sourceOf(["list-31-cards.json"]).load();
  assert.equal(byId(world)["repo-lead-7"].laneId, "Repo/Review");
});

test("the world holds the 28 open and answered cards in 7 lanes, and none of the 3 withdrawn, the one answered before it was withdrawn included", async () => {
  const world = await sourceOf(["list-31-cards.json"]).load();
  assert.equal(world.cards.length, 28);
  for (const gone of ["bot-a-8", "repo-lead-11", "bot-b-7"]) assert.equal(byId(world)[gone], undefined, gone);
  assert.deepEqual(world.lanes.map((lane) => lane.id), ["Crew/Launch", "Crew/Ops", "Repo/Launch", "Repo/Review", "Repo/Ship", "Web/Docs", "Web/Ops"]);
  assert.deepEqual(world.projects.map((project) => project.id), ["Crew", "Repo", "Web"]);
  assert.deepEqual([world.mail, world.pages, world.artifacts, world.tasks], [[], [], [], []]);
});

test("the four answered cards carry their pick, and each waits on its poster", async () => {
  const cards = byId(await sourceOf(["list-31-cards.json"]).load());
  const answered = (id) => [cards[id].answer.choice, cards[id].answer.waitingOn];
  assert.deepEqual(answered("bot-a-3"), [{ kind: "option", letter: "A" }, "bot-a"]);
  assert.deepEqual(answered("repo-lead-4"), [{ kind: "cant-decide" }, "repo-lead"]);
  assert.deepEqual(answered("repo-lead-9"), [{ kind: "option", letter: "B" }, "repo-lead"]);
  assert.deepEqual(answered("bot-b-2"), [{ kind: "none" }, "bot-b"]);
  assert.equal(Object.values(cards).filter((card) => card.answer !== null).length, 4);
});

test("the Queue made from the recorded list ranks by due, then newest change, has no priority tools, and counts 24 waiting", async () => {
  const world = await sourceOf(["list-31-cards.json"]).load();
  const view = viewQueue(world, EMPTY_QUERY, NOW);
  const cards = view.rows.map((row) => row.card);
  const due = cards.filter((card) => card.due !== null);
  const bare = cards.filter((card) => card.due === null);
  assert.equal(view.waiting, 24);
  assert.deepEqual(cards, [...due, ...bare]);
  assert.deepEqual(due.map((card) => Date.parse(card.due)), due.map((card) => Date.parse(card.due)).sort((a, b) => a - b));
  assert.deepEqual(bare.map((card) => Date.parse(card.addedAt)), bare.map((card) => Date.parse(card.addedAt)).sort((a, b) => b - a));
  assert.equal(view.groups.some((group) => group.key === "priority"), false);
  assert.equal(view.sorts.some((sort) => sort.value === "ranked"), false);
});

test("the quoted ETag of the recorded list is sent back exactly, and the recorded 304 returns the list held", async () => {
  const { calls, client } = serving(["list-31-cards.json", "list-not-modified-304.json"]);
  const first = await client.cards();
  const second = await client.cards();
  assert.equal(second, first);
  assert.equal("If-None-Match" in calls[0].headers, false);
  assert.equal(calls[1].headers["If-None-Match"], sample("list-31-cards.json").headers.ETag);
  assert.equal(sample("list-not-modified-304.json").headers.ETag, sample("list-31-cards.json").headers.ETag);
  assert.deepEqual(calls.map((call) => call.path), ["/captain/cards", "/captain/cards"]);
});

test("the recorded errors map as the note says: 401 and 403 are sign in again, 400 is refused, 503 is unavailable", async () => {
  const failure = async (name) => {
    try {
      await serving([name]).client.cards();
    } catch (error) {
      return error;
    }
    return null;
  };
  assert.ok((await failure("error-401-sign-in-required.json")) instanceof SignInRequired);
  assert.ok((await failure("error-403-session-refused.json")) instanceof SignInRequired);
  assert.equal((await failure("error-400-unknown-card.json")).name, "Refused");
  assert.ok((await failure("error-503-request-unavailable.json")) instanceof Unavailable);
});

for (const name of ["error-401-sign-in-required.json", "error-403-session-refused.json"]) {
  test("the recorded " + name.slice(6, 9) + " fails the load and preserves the seen mark in memory and in the browser", async () => {
    const store = memory();
    await withGlobal("localStorage", store, async () => {
      const time = fakeClock();
      const source = sourceOf(["list-31-cards.json", name, "list-31-cards.json"], time);
      await source.load();
      source.markSeen("repo-lead-7");
      const kept = store.held.get("qd.seen");
      const failed = assert.rejects(source.load(), (error) => error instanceof SignInRequired);
      await time.advance(5_000);
      await failed;
      assert.equal(store.held.get("qd.seen"), kept);
      source.signIn();
      const loading = source.load();
      await time.advance(5_000);
      assert.equal(byId(await loading)["repo-lead-7"].seenAt, SEEN_AT);
    });
  });
}
