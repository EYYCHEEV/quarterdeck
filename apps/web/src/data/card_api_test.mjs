import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: "true" }, loader: { ".html": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createStandInCardApi } = await load("src/data/card-standin.ts");
const loaderBundle = await esbuild.build({ stdin: { contents: 'export * from "./src/data/loader"; export { SignInRequired } from "./src/data/api-client";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", define: { __QD_SOURCE__: '"server"' } });
const { createLoader, SignInRequired } = await import("data:text/javascript;base64," + Buffer.from(loaderBundle.outputFiles[0].text).toString("base64"));
const { createExampleData } = await load("src/data/example-data.ts");

const NOW = "2026-11-02T10:00:00-05:00";
const make = (extra = {}) => createStandInCardApi({ latency: () => 0, clock: () => NOW, ...extra });

async function refused(work) {
  await assert.rejects(work, { name: "Refused" });
}

function counting(api) {
  const seen = { calls: 0 };
  api.watch(() => {
    seen.calls += 1;
  });
  return seen;
}

const answersOf = async (api, id) => (await api.openCard(id)).answers;
const summaryOf = async (api, id) => (await api.listCards()).find((card) => card.id === id);

test("the list has one summary per card, with the answer given on the card", async () => {
  const api = make();
  const list = await api.listCards();
  assert.deepEqual(
    list.map((card) => card.id),
    ["alba-1", "shelvorn-1", "dr-kivo-1", "shelvorn-2"],
  );
  assert.equal(list.find((card) => card.id === "alba-1").commentCount, 2);
  assert.equal(list.find((card) => card.id === "alba-1").kind, "decision");
  assert.deepEqual(list.find((card) => card.id === "shelvorn-2").answer, { pick: "B", rev: 1 });
  assert.equal(list.find((card) => card.id === "alba-1").answer, null);
  assert.equal(list.find((card) => card.id === "dr-kivo-1").answer, null);
});

test("one card opens with its thread, and an unknown card is refused", async () => {
  const api = make();
  const thread = await api.openCard("dr-kivo-1");
  assert.equal(thread.card.id, "dr-kivo-1");
  assert.equal(thread.comments.length, 1);
  await refused(api.openCard("nope-1"));
});

test("an answer gets a receipt with the server clock, joins the thread and tells watchers once", async () => {
  const api = make();
  const seen = counting(api);
  const receipt = await api.postAnswer("alba-1", { rev: 1, pick: "A", note: "Go." });
  assert.deepEqual(receipt, { card: "alba-1", rev: 1, pick: "A", at: NOW, older: false });
  const answers = await answersOf(api, "alba-1");
  assert.deepEqual(answers, [{ qd: "answer/1", card: "alba-1", rev: 1, pick: "A", note: "Go.", at: NOW }]);
  assert.deepEqual((await summaryOf(api, "alba-1")).answer, { pick: "A", rev: 1 });
  assert.equal(seen.calls, 1);
});

test("Can't decide and None of these are accepted on a decision card", async () => {
  const api = make();
  await api.postAnswer("alba-1", { rev: 1, pick: "cant-decide" });
  await api.postAnswer("shelvorn-1", { rev: 1, pick: "none" });
  assert.equal((await summaryOf(api, "alba-1")).answer.pick, "cant-decide");
  assert.equal((await summaryOf(api, "shelvorn-1")).answer.pick, "none");
});

test("a pick that is not on the card, a revision that does not exist and an FYI card are refused and change nothing", async () => {
  const api = make();
  const seen = counting(api);
  const before = await api.listCards();
  await refused(api.postAnswer("shelvorn-1", { rev: 1, pick: "C" }));
  await refused(api.postAnswer("shelvorn-1", { rev: 1, pick: "E" }));
  await refused(api.postAnswer("shelvorn-1", { rev: 0, pick: "A" }));
  await refused(api.postAnswer("shelvorn-1", { rev: 2, pick: "A" }));
  await refused(api.postAnswer("shelvorn-1", { rev: 1.5, pick: "A" }));
  await refused(api.postAnswer("alba-2", { rev: 1, pick: "A" }));
  await refused(api.postAnswer("alba-2", { rev: 1, pick: "none" }));
  await refused(api.postAnswer("nope-1", { rev: 1, pick: "A" }));
  assert.deepEqual(await api.listCards(), before);
  assert.equal(seen.calls, 0);
});

test("an answer on an older revision is matched by letter and flagged, never refused", async () => {
  const api = make();
  const receipt = await api.postAnswer("shelvorn-2", { rev: 1, pick: "A" });
  assert.equal(receipt.older, true);
  const letterNotOnCardNow = await api.postAnswer("shelvorn-2", { rev: 1, pick: "D" });
  assert.equal(letterNotOnCardNow.older, true);
  const current = await api.postAnswer("shelvorn-2", { rev: 2, pick: "B" });
  assert.equal(current.older, false);
  await refused(api.postAnswer("shelvorn-2", { rev: 2, pick: "D" }));
});

test("the same answer sent twice is one answer, and a different pick is another", async () => {
  const api = make();
  const seen = counting(api);
  const first = await api.postAnswer("alba-1", { rev: 1, pick: "B" });
  const again = await api.postAnswer("alba-1", { rev: 1, pick: "B", note: "Sent twice." });
  assert.deepEqual(again, first);
  assert.equal((await answersOf(api, "alba-1")).length, 1);
  assert.equal(seen.calls, 1);
  await api.postAnswer("alba-1", { rev: 1, pick: "C" });
  assert.equal((await answersOf(api, "alba-1")).length, 2);
  assert.equal((await summaryOf(api, "alba-1")).answer.pick, "C");
});

test("a pick on a small card names its comment, uses that comment's options, and leaves the card unanswered", async () => {
  const api = make();
  const receipt = await api.postAnswer("dr-kivo-1", { rev: 1, pick: "B", comment: "col-name" });
  assert.deepEqual(receipt, { card: "dr-kivo-1", rev: 1, pick: "B", comment: "col-name", at: NOW, older: false });
  assert.equal((await answersOf(api, "dr-kivo-1"))[0].comment, "col-name");
  assert.equal((await summaryOf(api, "dr-kivo-1")).answer, null);
  await api.postAnswer("dr-kivo-1", { rev: 1, pick: "C", comment: "col-name" });
  await refused(api.postAnswer("dr-kivo-1", { rev: 1, pick: "D", comment: "col-name" }));
  await refused(api.postAnswer("dr-kivo-1", { rev: 1, pick: "C" }));
  await refused(api.postAnswer("dr-kivo-1", { rev: 1, pick: "A", comment: "nope" }));
  await refused(api.postAnswer("alba-1", { rev: 1, pick: "A", comment: "nope" }));
});

test("a comment is added as the Captain with the server clock; an empty one is refused", async () => {
  const api = make();
  const seen = counting(api);
  const item = await api.postComment("shelvorn-1", "  Looks good.  ");
  assert.deepEqual(item, { from: "Captain", at: NOW, body: { qd: "comment/1", card: "shelvorn-1", text: "Looks good." } });
  assert.equal((await api.openCard("shelvorn-1")).comments.length, 1);
  assert.equal((await summaryOf(api, "shelvorn-1")).commentCount, 1);
  await refused(api.postComment("shelvorn-1", "   "));
  await refused(api.postComment("nope-1", "Hello"));
  assert.equal(seen.calls, 1);
});

test("a failing server rejects with an ordinary error, and a failed post is not kept", async () => {
  let down = false;
  const api = make({ fail: () => down });
  down = true;
  for (const attempt of [() => api.listCards(), () => api.openCard("alba-1"), () => api.postAnswer("alba-1", { rev: 1, pick: "A" }), () => api.postComment("alba-1", "Hi")]) {
    await assert.rejects(attempt(), (error) => error.name !== "Refused" && /could not be reached/.test(error.message));
  }
  down = false;
  assert.equal((await answersOf(api, "alba-1")).length, 0);
  assert.equal((await api.openCard("alba-1")).comments.length, 2);
});

test("each call waits a random time between 150 and 800 ms unless told otherwise", async () => {
  const waits = [];
  const realTimeout = globalThis.setTimeout;
  const realRandom = Math.random;
  globalThis.setTimeout = (run, ms) => {
    waits.push(ms);
    return realTimeout(run, 0);
  };
  try {
    const api = createStandInCardApi({ clock: () => NOW });
    Math.random = () => 0;
    await api.listCards();
    Math.random = () => 1;
    await api.openCard("alba-1");
  } finally {
    globalThis.setTimeout = realTimeout;
    Math.random = realRandom;
  }
  assert.deepEqual(
    waits.filter((ms) => ms >= 150 && ms <= 800),
    [150, 800],
  );
});

test("two stand-ins do not share state", async () => {
  const one = make();
  const two = make();
  await one.postAnswer("alba-1", { rev: 1, pick: "A" });
  assert.equal((await answersOf(two, "alba-1")).length, 0);
});

function controllable() {
  const calls = [];
  const load = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  const watching = { stops: 0, notify: null };
  const watch = (onChange) => {
    watching.notify = onChange;
    return () => {
      watching.stops += 1;
      watching.notify = null;
    };
  };
  return { calls, load, watch, watching };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a loader starts on the first subscriber, shares one load, and stops watching on the last", async () => {
  const c = controllable();
  const loader = createLoader(c.load, c.watch);
  assert.deepEqual(loader.snapshot(), { value: null, failed: false });
  assert.equal(c.calls.length, 0);
  const stopOne = loader.subscribe(() => {});
  const stopTwo = loader.subscribe(() => {});
  assert.equal(c.calls.length, 1);
  c.calls[0].resolve(["a"]);
  await tick();
  assert.deepEqual(loader.snapshot(), { value: ["a"], failed: false });
  stopOne();
  assert.equal(c.watching.stops, 0);
  stopTwo();
  assert.equal(c.watching.stops, 1);
});

test("the newest load wins even when an older one finishes last", async () => {
  const c = controllable();
  const loader = createLoader(c.load, c.watch);
  loader.subscribe(() => {});
  loader.refresh();
  c.calls[1].resolve("new");
  await tick();
  c.calls[0].resolve("old");
  await tick();
  assert.equal(loader.snapshot().value, "new");
});

test("a failed load keeps the last value, marks it failed, and a retry recovers", async () => {
  const c = controllable();
  const loader = createLoader(c.load, c.watch);
  loader.subscribe(() => {});
  c.calls[0].resolve("first");
  await tick();
  loader.refresh();
  c.calls[1].reject(new Error("down"));
  await tick();
  assert.deepEqual(loader.snapshot(), { value: "first", failed: true });
  loader.refresh();
  c.calls[2].resolve("second");
  await tick();
  assert.deepEqual(loader.snapshot(), { value: "second", failed: false });
});

test("a change from the watcher reloads, and a result after the last unsubscribe is dropped", async () => {
  const c = controllable();
  const loader = createLoader(c.load, c.watch);
  let heard = 0;
  const stop = loader.subscribe(() => {
    heard += 1;
  });
  c.calls[0].resolve(1);
  await tick();
  c.watching.notify();
  assert.equal(c.calls.length, 2);
  stop();
  c.calls[1].resolve(2);
  await tick();
  assert.equal(loader.snapshot().value, 1);
  assert.equal(heard, 1);
});

test("a typed sign-in failure drops the value, stays signed out through an offline failure, and a fresh load recovers", async () => {
  const c = controllable();
  const loader = createLoader(c.load, c.watch);
  const stop = loader.subscribe(() => {});
  c.calls[0].resolve("private");
  await tick();
  loader.refresh();
  c.calls[1].reject(new SignInRequired());
  await tick();
  assert.deepEqual(loader.snapshot(), { value: null, failed: true, signIn: true });
  loader.refresh();
  c.calls[2].reject(new Error("offline"));
  await tick();
  assert.deepEqual(loader.snapshot(), { value: null, failed: true, signIn: true });
  loader.refresh();
  c.calls[3].resolve("fresh");
  await tick();
  assert.deepEqual(loader.snapshot(), { value: "fresh", failed: false });
  stop();
});

test("a typed watch failure drops private values without another read, unlike an error with the same name", async () => {
  const c = controllable();
  const loader = createLoader(c.load, c.watch);
  const stop = loader.subscribe(() => {});
  c.calls[0].resolve("private");
  await tick();
  c.watching.notify(new SignInRequired());
  assert.deepEqual(loader.snapshot(), { value: null, failed: true, signIn: true });
  assert.equal(c.calls.length, 1);
  loader.refresh();
  c.calls[1].resolve("fresh");
  await tick();
  loader.refresh();
  c.calls[2].reject(Object.assign(new Error("sign in again"), { name: "SignInRequired" }));
  await tick();
  assert.deepEqual(loader.snapshot(), { value: "fresh", failed: true });
  stop();
});

test("an answer names the version he answered, even after the bot publishes a newer one", async () => {
  const api = make();
  const qd = createExampleData({ delay: 0, fail: new Set(), fixtures: "off", empty: false }, api);
  const version = async () => (await qd.load()).cards.find((card) => card.id === "alba-1").version;
  assert.equal(await version(), 1);
  api.publish({ ...(await api.openCard("alba-1")), rev: 2 });
  assert.equal(await version(), 2);
  const given = await qd.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "", version: 1 });
  assert.equal(given.version, 1);
  assert.deepEqual((await answersOf(api, "alba-1")).map((answer) => answer.rev), [1]);
});
