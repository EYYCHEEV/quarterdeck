import assert from "node:assert/strict";
import esbuild from "esbuild";
import fs from "node:fs";
import test from "node:test";

async function bundle() {
  const contents = ["api-client", "server-source"].map((name) => 'export * from "./src/data/' + name + '";').join("\n");
  const built = await esbuild.build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createApiClient, createServerSource, SignInRequired, NotFound } = await bundle();

const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const SEEN_AT = "2026-11-02T15:00:00.000Z";
const sample = (name) => JSON.parse(fs.readFileSync(new URL("./server-payloads/recorded/" + name, import.meta.url), "utf8"));

function recorded(name) {
  const { status, headers, body } = sample(name);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
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

function serving(routes) {
  const calls = [];
  const time = fakeClock();
  const send = async (path) => {
    calls.push(path);
    return recorded(routes[path]);
  };
  const source = createServerSource(createApiClient({ send, openEvents: () => ({ addEventListener: () => undefined, close: () => undefined }) }), time.now, time.schedule);
  return { source, calls, time, cardCalls: () => calls.filter((call) => call !== "/captain/cards").length };
}

const LIST = "list-31-cards.json";
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

test("the recorded open card reads as an open card at rev 3 with its five events, and the recorded answered and withdrawn cards as done and withdrawn", async () => {
  const read = (name) => createApiClient({ send: async () => recorded(name) }).card("x");
  const open = await read("card-open-with-thread.json");
  assert.deepEqual([open.state, open.rev, open.thread.map((event) => event.kind)], ["open", 3, ["card", "comment", "update", "comment", "update"]]);
  const answered = await read("card-answered.json");
  assert.deepEqual([answered.state, answered.rev, answered.thread.map((event) => event.kind)], ["done", 1, ["card", "answer"]]);
  assert.deepEqual(answered.thread[1], { kind: "answer", sender: "account-user", sent: "2026-11-02T09:36:00-05:00", pick: "A", rev: 1, note: "Use the first channel.", forComment: false });
  const withdrawn = await read("card-withdrawn.json");
  assert.deepEqual([withdrawn.state, withdrawn.thread.map((event) => event.kind)], ["withdrawn", ["card", "withdraw"]]);
});

test("the moved card opens with its detail and keeps the lane the list gives, though its first event says another", async () => {
  const { source, calls, time } = serving({ "/captain/cards": LIST, "/captain/cards/repo-lead-7": "card-open-with-thread.json" });
  await source.load();
  await source.openCard("repo-lead-7");
  const loading = source.load();
  await time.advance(5_000);
  const card = byId(await loading)["repo-lead-7"];
  assert.deepEqual(calls, ["/captain/cards", "/captain/cards/repo-lead-7", "/captain/cards"]);
  assert.deepEqual([card.laneId, card.projectId, card.version, card.owner, card.title], ["Repo/Review", "Repo", 3, "repo-lead", "Choose the release cut and its owner"]);
  assert.deepEqual([card.about, card.ascii, card.skip, card.pickWhy, card.approvalDoor, card.due], ["Repo work that needs a call.", "[Launch] --> [Review]", "If no answer by due: the plan goes ahead.", "A keeps the schedule.", "two-way", "2026-11-04T18:00:00-05:00"]);
  assert.deepEqual(card.labels, ["strategy"]);
  assert.deepEqual(card.options.map((option) => [option.letter, option.label, option.pick, option.door]), [["A", "Cut from main", true, "two-way"], ["B", "Cut from the review lane", false, "two-way"]]);
  assert.deepEqual([card.options[0].pros, card.options[0].cons, card.options[0].does, card.options[0].undo, card.options[0].tradeoff], [["Simple", "Fast"], ["Less review time"], "Tags the newest change for release.", "Delete the tag and cut again.", "Speed over review time."]);
  assert.deepEqual(card.more, {
    context: ["It is ready for a decision.", "Nothing else is waiting on it."],
    words: [["cut", "the moment a release is tagged"]],
    learn: [{ label: "Release guide", url: "https://example.com/release-guide" }],
    note: "A longer page for this card.\nSecond line of the note.",
  });
});

test("a card read at the rev the list names is not read again", async () => {
  const { source, cardCalls, time } = serving({ "/captain/cards": LIST, "/captain/cards/repo-lead-7": "card-open-with-thread.json" });
  await source.load();
  await source.openCard("repo-lead-7");
  for (let at = 0; at < 3; at += 1) {
    const loading = source.load();
    await time.advance(5_000);
    await loading;
  }
  assert.equal(cardCalls(), 1);
});

test("the recorded answered card carries the note of its answer, and its pick from the list", async () => {
  const { source, time } = serving({ "/captain/cards": LIST, "/captain/cards/bot-a-3": "card-answered.json" });
  await source.load();
  await source.openCard("bot-a-3");
  const loading = source.load();
  await time.advance(5_000);
  const card = byId(await loading)["bot-a-3"];
  assert.deepEqual([card.answer.choice, card.answer.note, card.answer.waitingOn, card.version], [{ kind: "option", letter: "A" }, "Use the first channel.", "bot-a", 1]);
  assert.deepEqual(card.options.map((option) => [option.letter, option.label]), [["A", "Go with the plan"], ["B", "Hold for now"]]);
});

test("a withdrawn card, and an id the list never named, are not opened, and nothing is asked for them", async () => {
  const { source, calls } = serving({ "/captain/cards": LIST });
  await source.load();
  for (const id of ["bot-a-8", "repo-lead-11", "bot-b-7", "repo-lead-99"]) await assert.rejects(source.openCard(id), (error) => error instanceof NotFound, id);
  assert.deepEqual(calls, ["/captain/cards"]);
});

test("the recorded 400 for an unknown id is refused, and the recorded 403 on a card read is sign in again", async () => {
  const ask = (name) => createApiClient({ send: async () => recorded(name) }).card("repo-lead-99");
  await assert.rejects(ask("error-400-unknown-card.json"), { name: "Refused" });
  await assert.rejects(ask("error-403-session-refused.json"), (error) => error instanceof SignInRequired);
  await assert.rejects(ask("error-401-sign-in-required.json"), (error) => error instanceof SignInRequired);
  await assert.rejects(ask("error-503-request-unavailable.json"), { name: "Unavailable" });
});

test("a recorded 403 on a card read drops the opened card but keeps the seen mark", async () => {
  const store = memory();
  await withGlobal("localStorage", store, async () => {
    const routes = { "/captain/cards": LIST, "/captain/cards/repo-lead-7": "card-open-with-thread.json" };
    const { source, time } = serving(routes);
    await source.load();
    source.markSeen("repo-lead-7");
    await source.openCard("repo-lead-7");
    routes["/captain/cards/repo-lead-7"] = "error-403-session-refused.json";
    const kept = store.held.get("qd.seen");
    await assert.rejects(source.openCard("repo-lead-7"), (error) => error instanceof SignInRequired);
    assert.equal(store.held.get("qd.seen"), kept);
    source.signIn();
    const loading = source.load();
    await time.advance(5_000);
    const card = byId(await loading)["repo-lead-7"];
    assert.deepEqual([card.options.length, card.seenAt], [0, SEEN_AT]);
  });
});
