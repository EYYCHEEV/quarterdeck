import assert from "node:assert/strict";
import esbuild from "esbuild";
import test from "node:test";

const built = await esbuild.build({ entryPoints: ["src/ui/link.tsx"], bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent", define: { __QD_PREVIEW__: "false", "process.env.NODE_ENV": '"production"' } });
const { go, arrive } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

function page(at, present) {
  const focused = [];
  const element = (id) => ({ focus: (options) => focused.push([id, options]) });
  globalThis.location = { pathname: at };
  globalThis.history = { pushState: (state, title, url) => (location.pathname = url), replaceState: (state, title, url) => (location.pathname = url) };
  globalThis.window = { dispatchEvent: () => true };
  globalThis.PopStateEvent = class {};
  globalThis.document = {
    querySelector(selector) {
      const id = present.find((name) => selector === '[data-testid="' + name + '"]');
      return id ? element(id) : null;
    },
  };
  return { focused, menu: { current: element("menu-btn") } };
}

test("leaving with a target focuses that element once, without scrolling, and the next arrival focuses nothing", () => {
  const { focused, menu } = page("/settings", ["settings-btn"]);
  go("/mail", { focus: "settings-btn" });
  arrive(menu);
  arrive(menu);
  assert.deepEqual(focused, [["settings-btn", { preventScroll: true }]]);
});

test("when the target is not on the page, Menu gets focus, and the target is used up", () => {
  const { focused, menu } = page("/settings", []);
  go("/queue", { focus: "account-btn" });
  arrive(menu);
  arrive(menu);
  assert.deepEqual(focused, [["menu-btn", { preventScroll: true }]]);
});

test("going to the page it is already on sets no target", () => {
  const { focused, menu } = page("/mail", ["settings-btn"]);
  go("/mail", { focus: "settings-btn" });
  arrive(menu);
  assert.deepEqual(focused, []);
});

test("a later navigation with no target drops a target nobody took", () => {
  const { focused, menu } = page("/settings", ["settings-btn"]);
  go("/mail", { focus: "settings-btn" });
  go("/queue");
  arrive(menu);
  assert.deepEqual(focused, []);
});
