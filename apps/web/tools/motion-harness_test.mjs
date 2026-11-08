import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const load = () => import("./motion-harness.mjs");

class CSSTransition {}
class CSSAnimation {}
class Animation {}
const KINDS = { CSSTransition, CSSAnimation, Animation };

const element = (tag, { id = "", testId = null } = {}) => ({ tagName: tag.toUpperCase(), id, getAttribute: (name) => (name === "data-testid" ? testId : null) });

function animation({ kind = "CSSTransition", target = element("div"), pseudo = null, keyframes = [{ opacity: "0", offset: null, computedOffset: 0, easing: "linear", composite: "auto" }, { opacity: "1", offset: null, computedOffset: 1, easing: "linear", composite: "auto" }], timing = {}, easing = "ease", playState = "running", name = "opacity" } = {}) {
  const made = new KINDS[kind]();
  made.playState = playState;
  made.finished = Promise.resolve(made);
  if (kind === "CSSTransition") made.transitionProperty = name;
  if (kind === "CSSAnimation") made.animationName = name;
  made.effect = { target, pseudoElement: pseudo, getKeyframes: () => keyframes, getComputedTiming: () => ({ duration: 200, delay: 0, iterations: 1, ...timing }), getTiming: () => ({ easing }) };
  return made;
}

function openAnimation(options) {
  const made = animation(options);
  made.finished = new Promise((resolve, reject) => {
    made.finish = () => {
      made.playState = "finished";
      resolve(made);
    };
    made.cancel = () => {
      made.playState = "idle";
      reject(new Error("canceled"));
    };
  });
  return made;
}

const pageOver = (scope) => ({ evaluate: (fn, arg) => Promise.resolve(fn(arg, scope)) });

const scopeOf = (getAnimations) => ({ document: { getAnimations }, requestAnimationFrame: (done) => queueMicrotask(() => done(0)) });

test("motionContext keeps the caller's options and turns motion on", async () => {
  const { motionContext } = await load();
  let given = null;
  const browser = { newContext: async (options) => (given = options) };
  await motionContext(browser, { colorScheme: "dark", viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  assert.deepEqual(given, { colorScheme: "dark", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
});

test("countViewTransitions registers one init script that counts calls and passes them through", async () => {
  const { countViewTransitions } = await load();
  const added = [];
  await countViewTransitions({ addInitScript: async (fn, arg) => added.push([fn, arg]) });
  assert.equal(added.length, 1);
  assert.equal(typeof added[0][0], "function");
  assert.equal(added[0][1], undefined);
  const seen = [];
  const document = {
    startViewTransition(update) {
      seen.push({ update, self: this });
      return { finished: Promise.resolve() };
    },
  };
  const scope = { document };
  added[0][0](undefined, scope);
  const update = () => {};
  const result = scope.document.startViewTransition(update);
  scope.document.startViewTransition(update);
  assert.equal(scope.__qdMotion.starts, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].update, update);
  assert.equal(seen[0].self, document);
  assert.ok(result.finished instanceof Promise);
});

test("countViewTransitions in a browser without startViewTransition counts zero and adds none", async () => {
  const { countViewTransitions } = await load();
  const added = [];
  await countViewTransitions({ addInitScript: async (fn) => added.push(fn) });
  const scope = { document: {} };
  added[0](undefined, scope);
  assert.equal(scope.__qdMotion.starts, 0);
  assert.equal("startViewTransition" in scope.document, false);
});

test("viewTransitionCalls reads the count, and zero when no counter was installed", async () => {
  const { viewTransitionCalls } = await load();
  assert.equal(await viewTransitionCalls(pageOver({ __qdMotion: { starts: 3 } })), 3);
  assert.equal(await viewTransitionCalls(pageOver({})), 0);
});

test("runningAnimations lists each running animation with target, properties, timing and easing", async () => {
  const { runningAnimations } = await load();
  const list = [
    animation({ kind: "CSSTransition", target: element("div", { id: "sheet", testId: "sheet" }), name: "opacity", keyframes: [{ opacity: "0", offset: null, computedOffset: 0, easing: "linear", composite: "auto" }, { opacity: "1", transform: "none", offset: null, computedOffset: 1, easing: "linear", composite: "auto" }], timing: { duration: 200, delay: 10 }, easing: "cubic-bezier(0.2, 0, 0, 1)" }),
    animation({ kind: "CSSAnimation", target: element("html"), pseudo: "::view-transition-new(root)", name: "fade-in", timing: { duration: 240 }, easing: "cubic-bezier(0.4, 0, 1, 1)" }),
    animation({ kind: "Animation", target: element("li", { testId: "row-3" }), name: null, timing: { duration: 100 }, easing: "linear" }),
  ];
  const rows = await runningAnimations(pageOver(scopeOf(() => list)));
  assert.deepEqual(rows, [
    { kind: "CSSTransition", name: "opacity", target: "div#sheet[data-testid=\"sheet\"]", pseudo: null, properties: ["opacity", "transform"], duration: 200, delay: 10, iterations: 1, easing: "cubic-bezier(0.2, 0, 0, 1)", playState: "running" },
    { kind: "CSSAnimation", name: "fade-in", target: "html", pseudo: "::view-transition-new(root)", properties: ["opacity"], duration: 240, delay: 0, iterations: 1, easing: "cubic-bezier(0.4, 0, 1, 1)", playState: "running" },
    { kind: "Animation", name: null, target: "li[data-testid=\"row-3\"]", pseudo: null, properties: ["opacity"], duration: 100, delay: 0, iterations: 1, easing: "linear", playState: "running" },
  ]);
});

test("runningAnimations leaves out finished, idle and paused animations", async () => {
  const { runningAnimations } = await load();
  const list = [animation({ playState: "finished" }), animation({ playState: "idle" }), animation({ playState: "paused" }), animation({ playState: "pending", name: "transform" })];
  const rows = await runningAnimations(pageOver(scopeOf(() => list)));
  assert.deepEqual(rows.map((row) => [row.name, row.playState]), [["transform", "pending"]]);
});

test("runningAnimations reports a duration the browser gave as text as null", async () => {
  const { runningAnimations } = await load();
  const rows = await runningAnimations(pageOver(scopeOf(() => [animation({ timing: { duration: "auto" } })])));
  assert.equal(rows[0].duration, null);
});

test("settle returns at once when nothing runs", async () => {
  const { settle } = await load();
  assert.equal(await settle(pageOver(scopeOf(() => []))), 0);
});

test("settle waits on every running animation's finished before it returns", async () => {
  const { settle } = await load();
  const pool = [openAnimation({ name: "a" }), openAnimation({ name: "b" })];
  setImmediate(() => pool[0].finish());
  setImmediate(() => setImmediate(() => pool[1].finish()));
  const rounds = await settle(pageOver(scopeOf(() => pool.filter((one) => one.playState === "running"))));
  assert.deepEqual(pool.map((one) => one.playState), ["finished", "finished"]);
  assert.ok(rounds >= 1);
});

test("settle does not stop on an animation that was canceled", async () => {
  const { settle } = await load();
  const pool = [openAnimation({ name: "a" }), openAnimation({ name: "b" })];
  setImmediate(() => pool[0].cancel());
  setImmediate(() => pool[1].finish());
  await settle(pageOver(scopeOf(() => pool.filter((one) => one.playState === "running"))));
  assert.deepEqual(pool.map((one) => one.playState), ["idle", "finished"]);
});

test("settle waits again for an animation that a finished one started", async () => {
  const { settle } = await load();
  const first = openAnimation({ name: "first" });
  const second = openAnimation({ name: "second" });
  let begun = false;
  const live = () => {
    const found = [];
    if (first.playState === "running") found.push(first);
    if (begun && second.playState === "running") found.push(second);
    return found;
  };
  first.finished.then(() => {
    begun = true;
    setImmediate(() => second.finish());
  });
  setImmediate(() => first.finish());
  const rounds = await settle(pageOver(scopeOf(live)));
  assert.equal(second.playState, "finished");
  assert.ok(rounds >= 2);
});

test("settle reports an endless animation by name instead of waiting for it", async () => {
  const { settle } = await load();
  const endless = openAnimation({ kind: "CSSAnimation", name: "spin", timing: { iterations: Infinity } });
  await assert.rejects(settle(pageOver(scopeOf(() => [endless]))), /endless animation: spin/);
});

test("runningAnimations and settle pass over an endless animation inside a [data-progress] indicator, and settle still reports any other endless one", async () => {
  const { runningAnimations, settle } = await load();
  const track = element("span");
  const bar = openAnimation({ kind: "CSSAnimation", name: "sending", target: { ...element("span"), closest: (selector) => (selector === "[data-progress]" ? track : null) }, timing: { duration: 1200, iterations: Infinity } });
  assert.deepEqual(await runningAnimations(pageOver(scopeOf(() => [bar]))), []);
  assert.equal(await settle(pageOver(scopeOf(() => [bar]))), 0);
  const spin = openAnimation({ kind: "CSSAnimation", name: "spin", target: { ...element("span"), closest: () => null }, timing: { iterations: Infinity } });
  await assert.rejects(settle(pageOver(scopeOf(() => [bar, spin]))), /endless animation: spin/);
});

test("settle gives up with a message when animations keep starting", async () => {
  const { settle } = await load();
  const forever = () => [animation({ name: "again" })];
  await assert.rejects(settle(pageOver(scopeOf(forever)), { rounds: 3 }), /did not settle after 3 rounds/);
});

test("the harness holds no fixed wait", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./motion-harness.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /setTimeout|waitForTimeout|setInterval/);
});
