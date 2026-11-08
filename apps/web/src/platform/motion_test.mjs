import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import esbuild from "esbuild";
import { loadTs } from "../../tools/load-ts.mjs";

let loaded = null;
const motion = () => (loaded ??= loadTs("src/platform/motion.ts"));
const turn = () => new Promise((resolve) => setImmediate(resolve));
const WAIT = "[data-motion-wait]";

function fakeScreen({ supported = true, mode = "phone", panes = 0, main = true, live = [] } = {}) {
  const started = [];
  const marks = new Set();
  const appended = [];
  const doc = {
    documentElement: { dataset: {} },
    body: { append: (node) => appended.push(node) },
    querySelectorAll: (selector) => (selector === "[data-pane]" ? Array.from({ length: panes }, () => ({})) : []),
    getAnimations: () => live,
    querySelector: (selector) => (selector === "#stage" ? (mode ? { dataset: { mode } } : null) : selector === "#main-scroll" ? (main ? {} : null) : marks.has(selector) ? {} : null),
  };
  if (supported)
    doc.startViewTransition = (update) => {
      let finish;
      let fail;
      let ok;
      const transition = {
        skipped: 0,
        move: doc.documentElement.dataset.move,
        finished: new Promise((resolve) => (finish = resolve)),
        ready: new Promise((resolve, reject) => {
          ok = resolve;
          fail = reject;
        }),
        skipTransition() {
          transition.skipped += 1;
        },
        async run() {
          await update();
          transition.after = doc.documentElement.dataset.move;
          if (transition.skipped) fail(new Error("skipped"));
          else ok();
          finish();
          await turn();
        },
      };
      started.push(transition);
      return transition;
    };
  return { doc, started, marks, appended };
}

test("D1: a deeper path moves forward, a shallower one moves back, and the same depth in one section moves forward", async () => {
  const { moveFor } = await motion();
  const phone = { wide: false, panes: 0 };
  assert.deepEqual(
    [moveFor("/queue", "/queue/alba-1", phone), moveFor("/queue/alba-1", "/queue", phone), moveFor("/queue/alba-1", "/queue/alba-2", phone)],
    [
      { scope: "screen", way: "forward" },
      { scope: "screen", way: "back" },
      { scope: "screen", way: "forward" },
    ],
  );
});

test("D1: a change of section only fades, on a phone and on a wide window with a pane", async () => {
  const { moveFor } = await motion();
  assert.deepEqual(
    [moveFor("/queue/alba-1", "/mail", { wide: false, panes: 0 }), moveFor("/queue/alba-1", "/mail", { wide: true, panes: 1 })],
    [
      { scope: "screen", way: "fade" },
      { scope: "screen", way: "fade" },
    ],
  );
});

test("D1: on a wide window only the one pane moves within a section; with no pane or two panes the screen moves", async () => {
  const { moveFor } = await motion();
  assert.deepEqual(
    [
      moveFor("/queue/alba-1", "/queue/alba-2", { wide: true, panes: 1 }),
      moveFor("/mail", "/mail/t-1", { wide: true, panes: 1 }),
      moveFor("/projects", "/projects/p-1", { wide: true, panes: 0 }),
      moveFor("/queue/alba-1", "/queue/alba-2", { wide: true, panes: 2 }),
      moveFor("/mail/t-1", "/mail/t-2", { wide: false, panes: 1 }),
    ],
    [
      { scope: "pane", way: "forward" },
      { scope: "pane", way: "forward" },
      { scope: "screen", way: "forward" },
      { scope: "screen", way: "forward" },
      { scope: "screen", way: "forward" },
    ],
  );
});

test("D1: no move for the same path, a path that differs only in its query, or a page with no main area", async () => {
  const { moveFor } = await motion();
  const phone = { wide: false, panes: 0 };
  assert.deepEqual([moveFor("/queue", "/queue", phone), moveFor("/queue?sort=due", "/queue", phone), moveFor("/mail", "/queue", null)], [null, null, null]);
});

test("D1: the fade-only switch keeps the scope and drops every slide", async () => {
  const { moveFor, SCREEN_CHANGE } = await motion();
  assert.equal(SCREEN_CHANGE, "fade-slide");
  assert.deepEqual(
    [moveFor("/queue", "/queue/alba-1", { wide: false, panes: 0 }, "fade"), moveFor("/queue/alba-1", "/queue/alba-2", { wide: true, panes: 1 }, "fade")],
    [
      { scope: "screen", way: "fade" },
      { scope: "pane", way: "fade" },
    ],
  );
});

test("D1: the view is read from the stage's mode, the panes on the page and the main area", async () => {
  const { viewNow } = await motion();
  assert.deepEqual(
    [
      viewNow(fakeScreen({ mode: "phone", panes: 1 }).doc),
      viewNow(fakeScreen({ mode: "sideways", panes: 1 }).doc),
      viewNow(fakeScreen({ mode: "mac", panes: 0 }).doc),
      viewNow(fakeScreen({ mode: "mac", main: false }).doc),
    ],
    [{ wide: false, panes: 1 }, { wide: true, panes: 1 }, { wide: true, panes: 0 }, null],
  );
});

test("D2: with no browser support, Reduce Motion on, or no move, the update runs at once and nothing is marked", async () => {
  const { changeScreen } = await motion();
  const move = { scope: "screen", way: "forward" };
  const cases = [
    [fakeScreen({ supported: false }), move, () => false],
    [fakeScreen(), move, () => true],
    [fakeScreen(), null, () => false],
  ];
  for (const [screen, given, reduce] of cases) {
    let ran = 0;
    changeScreen(() => (ran += 1), given, screen.doc, reduce, async () => {});
    assert.deepEqual([ran, screen.started.length, screen.doc.documentElement.dataset.move], [1, 0, undefined]);
  }
});

test("D2: a move marks the page before the transition starts, runs the update once inside it, and unmarks the page when it finishes", async () => {
  const { changeScreen } = await motion();
  const screen = fakeScreen();
  let ran = 0;
  changeScreen(() => (ran += 1), { scope: "pane", way: "back" }, screen.doc, () => false, async () => {});
  const [transition] = screen.started;
  assert.deepEqual([screen.started.length, transition.move, ran], [1, "pane back", 0]);
  await transition.run();
  assert.deepEqual([ran, transition.skipped, transition.after, screen.doc.documentElement.dataset.move], [1, 0, "pane back live", undefined]);
});

test("D2: once the update is in, the page is marked live so only the leaving screen is a picture, and the mark stays until the arriving screen's own fade ends", async () => {
  const { changeScreen } = await motion();
  let arrive;
  const fade = { animationName: "screen-arrive", finished: new Promise((resolve) => (arrive = resolve)) };
  const other = { animationName: "leave", finished: new Promise(() => {}) };
  const screen = fakeScreen({ live: [fade, other] });
  changeScreen(() => {}, { scope: "screen", way: "back" }, screen.doc, () => false, async () => {});
  const [transition] = screen.started;
  await transition.run();
  assert.deepEqual([transition.move, transition.after, screen.doc.documentElement.dataset.move], ["screen back", "screen back live", "screen back live"]);
  arrive();
  await turn();
  assert.equal(screen.doc.documentElement.dataset.move, undefined);
});

test("D2: when the new screen shows the code-loading fallback, the transition is skipped, the update still runs once, and the page is unmarked", async () => {
  const { changeScreen } = await motion();
  const screen = fakeScreen();
  let ran = 0;
  changeScreen(
    () => {
      ran += 1;
      screen.marks.add(WAIT);
    },
    { scope: "screen", way: "forward" },
    screen.doc,
    () => false,
    async () => {},
  );
  await screen.started[0].run();
  assert.deepEqual([ran, screen.started[0].skipped, screen.started[0].after, screen.doc.documentElement.dataset.move], [1, 1, "screen forward", undefined]);
});

test("D2: the update is read for the fallback only after the given tick, so React's commit is in the page first", async () => {
  const { changeScreen } = await motion();
  const screen = fakeScreen();
  changeScreen(() => {}, { scope: "screen", way: "forward" }, screen.doc, () => false, async () => screen.marks.add(WAIT));
  await screen.started[0].run();
  assert.equal(screen.started[0].skipped, 1);
});

test("D2: a second change while one runs keeps its own mark until it finishes", async () => {
  const { changeScreen } = await motion();
  const screen = fakeScreen();
  changeScreen(() => {}, { scope: "screen", way: "forward" }, screen.doc, () => false, async () => {});
  changeScreen(() => {}, { scope: "pane", way: "forward" }, screen.doc, () => false, async () => {});
  const [first, second] = screen.started;
  await first.run();
  assert.deepEqual([first.after, screen.doc.documentElement.dataset.move], ["pane forward", "pane forward"]);
  await second.run();
  assert.deepEqual([second.after, screen.doc.documentElement.dataset.move], ["pane forward live", undefined]);
});

function fakeNode({ connected = true } = {}) {
  const inner = { removed: [], removeAttribute(name) { this.removed.push(name); } };
  const listeners = {};
  const copy = {
    removed: [],
    attributes: {},
    classes: [],
    style: {},
    dataset: {},
    inert: false,
    gone: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { this.removed.push(name); },
    querySelectorAll: (selector) => (selector === "[id],[data-testid]" ? [inner] : []),
    classList: { add: (...names) => copy.classes.push(...names) },
    addEventListener: (type, run) => (listeners[type] = run),
    remove() { this.gone += 1; },
  };
  const node = {
    isConnected: connected,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 40 }),
    cloneNode: (deep) => (deep ? copy : null),
  };
  return { node, copy, inner, listeners };
}

test("D3: a leave copy is an inert, hidden, untappable picture placed where the node was, with no ids, and it goes when its own animation ends", async () => {
  const { leaveCopy } = await motion();
  const screen = fakeScreen();
  const { node, copy, inner, listeners } = fakeNode();
  leaveCopy(node, screen.doc, () => false);
  assert.deepEqual(screen.appended, [copy]);
  assert.deepEqual(
    [copy.inert, copy.attributes["aria-hidden"], copy.dataset.leaving, copy.classes, copy.style],
    [true, "true", "", ["leave"], { position: "fixed", left: "10px", top: "20px", width: "300px", height: "40px", margin: "0px", pointerEvents: "none" }],
  );
  assert.deepEqual([copy.removed.sort(), inner.removed.sort()], [["data-testid", "id"], ["data-testid", "id"]]);
  listeners.animationend({ target: {} });
  assert.equal(copy.gone, 0);
  listeners.animationend({ target: copy });
  assert.equal(copy.gone, 1);
  listeners.animationcancel({ target: copy });
  assert.equal(copy.gone, 2);
});

test("D3: no leave copy with Reduce Motion on, during a screen change, or for a node that is gone", async () => {
  const { leaveCopy } = await motion();
  const reduced = fakeScreen();
  leaveCopy(fakeNode().node, reduced.doc, () => true);
  const moving = fakeScreen();
  moving.doc.documentElement.dataset.move = "screen forward";
  leaveCopy(fakeNode().node, moving.doc, () => false);
  const gone = fakeScreen();
  leaveCopy(fakeNode({ connected: false }).node, gone.doc, () => false);
  leaveCopy(null, gone.doc, () => false);
  assert.deepEqual([reduced.appended.length, moving.appended.length, gone.appended.length], [0, 0, 0]);
});

const ids = (list) => list.map((entry) => entry.id + (entry.fresh ? "+" : "") + (entry.leaving ? "-" : ""));
const card = (id, at = 0) => ({ id, at });
const byId = (item) => item.id;

test("D4: nothing is fresh or leaving at the first render", async () => {
  const { mergeShown } = await motion();
  assert.deepEqual(ids(mergeShown(null, [card("a"), card("b")], byId)), ["a", "b"]);
});

test("D4: a row that was not there before is fresh where it lands, and stays fresh on later renders", async () => {
  const { mergeShown } = await motion();
  const first = mergeShown(null, [card("a"), card("c")], byId);
  const second = mergeShown(first, [card("a"), card("b"), card("c")], byId);
  assert.deepEqual(ids(second), ["a", "b+", "c"]);
  assert.deepEqual(ids(mergeShown(second, [card("a"), card("b"), card("c")], byId)), ["a", "b+", "c"]);
});

test("D4: a removed row stays as leaving after the row it followed, keeps its last data, and goes only when dropped", async () => {
  const { mergeShown, dropShown } = await motion();
  const first = mergeShown(null, [card("a"), card("b", 1), card("c")], byId);
  const second = mergeShown(first, [card("a"), card("c")], byId);
  assert.deepEqual(ids(second), ["a", "b-", "c"]);
  assert.equal(second[1].item.at, 1);
  const third = mergeShown(second, [card("c")], byId);
  assert.deepEqual(ids(third), ["a-", "b-", "c"]);
  assert.deepEqual(ids(dropShown(third, "b")), ["a-", "c"]);
});

test("D4: a leaving row that comes back is shown again with its new data, neither fresh nor leaving", async () => {
  const { mergeShown } = await motion();
  const first = mergeShown(null, [card("a"), card("b")], byId);
  const second = mergeShown(first, [card("a")], byId);
  const third = mergeShown(second, [card("a"), card("b", 2)], byId);
  assert.deepEqual(ids(third), ["a", "b"]);
  assert.equal(third[1].item.at, 2);
});

test("D4: for chat, only rows after the newest one already shown are fresh, so older pages never animate", async () => {
  const { mergeShown } = await motion();
  const first = mergeShown(null, [card("m3"), card("m4")], byId, true);
  assert.deepEqual(ids(mergeShown(first, [card("m1"), card("m2"), card("m3"), card("m4"), card("m5")], byId, true)), ["m1", "m2", "m3", "m4", "m5+"]);
});

const theme = fs.readFileSync("src/ui/theme.css", "utf8");
const late = fs.existsSync("src/ui/motion.css") ? fs.readFileSync("src/ui/motion.css", "utf8") : "";
const staticBlocks = [...theme.matchAll(/@theme static \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");

test("D5: the three speeds and two easings are named theme values, with the brief's numbers", () => {
  const value = (name) => theme.match(new RegExp("--" + name + ":\\s*([^;]+);"))?.[1].trim() ?? null;
  assert.deepEqual(
    [value("transition-duration-quick"), value("transition-duration-standard"), value("transition-duration-screen")],
    ["100ms", "200ms", "240ms"],
  );
  assert.match(value("ease-arrive") ?? "", /^cubic-bezier\(/);
  assert.match(value("ease-leave") ?? "", /^cubic-bezier\(/);
});

test("D5: no time in the theme is over 300 ms", () => {
  const times = [...theme.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map(([, amount, unit]) => Number(amount) * (unit === "s" ? 1000 : 1));
  assert.ok(times.length > 0);
  assert.deepEqual(times.filter((ms) => ms > 300), []);
});

test("D5: the Reduce Motion rule also stops the view-transition layer", () => {
  const rule = late.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(rule, /::view-transition-group\(\*\),\s*::view-transition-old\(\*\),\s*::view-transition-new\(\*\)\s*\{\s*animation: none !important;\s*\}/);
});

async function splitCode(source) {
  const built = await esbuild.build({
    entryPoints: [{ in: "src/shell/main.tsx", out: "app" }],
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
    metafile: true,
    loader: { ".html": "text" },
    define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: "false", __QD_SOURCE__: JSON.stringify(source), __QD_CHAT__: '"off"', "process.env.NODE_ENV": '"production"' },
  });
  const outputs = built.metafile.outputs;
  const first = new Set(["bundle/app.js"]);
  const walk = (key) => {
    for (const item of outputs[key].imports) {
      if (item.kind !== "import-statement" || first.has(item.path)) continue;
      first.add(item.path);
      walk(item.path);
    }
  };
  walk("bundle/app.js");
  const code = (wanted) => built.outputFiles.filter((file) => file.path.endsWith(".js") && wanted(first.has(path.relative(process.cwd(), file.path).split(path.sep).join("/")))).map((file) => file.text).join("\n");
  return { first: code((eager) => eager), late: code((eager) => !eager) };
}

test("D6: the screen change, list merge and leave copies load after the first screen, in the example and the server build", async () => {
  for (const source of ["example", "server"]) {
    const { first, late } = await splitCode(source);
    for (const mark of ["[data-motion-wait]", "screen-arrive", "animationcancel"]) {
      assert.equal(first.includes(mark), false, source + " first load holds " + mark);
      assert.equal(late.includes(mark), true, source + " late code lacks " + mark);
    }
  }
});

test("D6: the motion rules live in their own late sheet, which reads the theme's times and eases in at build time, so none of them loads first", () => {
  for (const rule of ["::view-transition", "@keyframes", "@starting-style", "--animate-", "[data-leaving]"]) assert.equal(theme.includes(rule), false, "theme.css holds " + rule);
  assert.equal(/--(transition-duration|ease)-/.test(staticBlocks), false, "a static theme block forces a motion value into the first load");
  for (const rule of ["::view-transition-old(root)", "@keyframes screen-arrive", "@starting-style", ".press:active", "--theme(--transition-duration-standard inline)"]) assert.equal(late.includes(rule), true, "motion.css lacks " + rule);
});
