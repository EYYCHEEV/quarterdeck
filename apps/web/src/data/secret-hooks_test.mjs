import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const built = fs.mkdtempSync(path.join(os.tmpdir(), "qd-secret-hooks-"));
await esbuild.build({
  stdin: {
    contents: `export { createElement, useLayoutEffect } from "react"; export { createRoot } from "react-dom/client"; export { DataProvider } from "./data/hooks"; export { useSecrets } from "./data/secret-hooks"; export { lazySecrets } from "./data/lazy-parts"; export { createSecretStandIn } from "./data/secret-standin";`,
    resolveDir: "src",
    sourcefile: "secret-hooks-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  define: { __QD_FIXTURES__: "true", __QD_PREVIEW__: "false", "process.env.NODE_ENV": '"development"' },
  banner: { js: "import { createRequire as qdRequire } from 'node:module'; const require = qdRequire(import.meta.url);" },
  outfile: path.join(built, "entry.mjs"),
  logLevel: "silent",
});
const r = await import(pathToFileURL(path.join(built, "entry.mjs")).href);

const hostlessDocument = { nodeType: 9, activeElement: null, body: null, defaultView: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = { event: undefined, HTMLIFrameElement: class {}, document: hostlessDocument };
hostlessDocument.defaultView = globalThis.window;
const hostlessContainer = () => ({ nodeType: 1, tagName: "DIV", nodeName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: hostlessDocument, addEventListener() {}, removeEventListener() {}, textContent: "", childNodes: [] });

const until = async (reached) => {
  for (let turn = 0; turn < 400; turn += 1) {
    if (reached()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("the hook never reached the expected state");
};
const turns = async (count) => {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function standIn() {
  return r.createSecretStandIn({ now: () => 0, bots: () => [{ id: "iris", name: "Iris" }], accountId: "a", session: () => ({ accountId: "a", activeChat: null }), consumers: {} });
}

function mount(secrets, beforeEffects = () => undefined) {
  const seen = [];
  const errors = [];
  function Probe() {
    const state = r.useSecrets("iris");
    seen.push({ shown: state.loading ? "loading" : state.failed ? "failed" : "ready", retry: state.retry });
    return null;
  }
  function Starter() {
    r.useLayoutEffect(() => {
      beforeEffects();
    }, []);
    return null;
  }
  const root = r.createRoot(hostlessContainer(), { onUncaughtError: (error) => errors.push(error), onCaughtError: (error) => errors.push(error) });
  const data = { secrets, load: async () => ({}), now: () => 0, watch: () => () => undefined };
  root.render(r.createElement(r.DataProvider, { data, children: [r.createElement(Probe, { key: "probe" }), r.createElement(Starter, { key: "starter" })] }));
  const shown = () => seen.map((entry) => entry.shown);
  return { seen, shown, errors, last: () => seen.at(-1), unmount: () => root.unmount() };
}

test("the secret part arriving between the render and the subscription leaves useSecrets ready, not loading", async () => {
  const lazy = r.lazySecrets(() => Promise.resolve(standIn().captain));
  const screen = mount(lazy, () => {
    lazy.subscribe(() => undefined);
  });
  await until(() => screen.last()?.shown === "ready");
  assert.deepEqual(screen.errors, []);
  assert.equal(screen.shown()[0], "loading");
  screen.unmount();
});

test("a hook that is the first listener shows loading, then ready when the part arrives", async () => {
  let arrive = () => undefined;
  const lazy = r.lazySecrets(() => new Promise((resolve) => {
    arrive = () => resolve(standIn().captain);
  }));
  const screen = mount(lazy);
  await until(() => screen.last()?.shown === "loading");
  await turns(5);
  assert.equal(screen.last().shown, "loading");
  arrive();
  await until(() => screen.last()?.shown === "ready");
  assert.deepEqual(screen.errors, []);
  screen.unmount();
});

test("a hook mounted after the part is ready renders once and does not render again", async () => {
  const lazy = r.lazySecrets(() => Promise.resolve(standIn().captain));
  lazy.subscribe(() => undefined);
  await until(() => lazy.status() === "ready");
  const screen = mount(lazy);
  await until(() => screen.seen.length > 0);
  await turns(20);
  assert.deepEqual(screen.shown(), ["ready"]);
  assert.deepEqual(screen.errors, []);
  screen.unmount();
});

test("a failed secret part shows failed and the hook's retry loads it", async () => {
  let asked = 0;
  const lazy = r.lazySecrets(() => {
    asked += 1;
    return asked === 1 ? Promise.reject(new Error("the part did not load")) : Promise.resolve(standIn().captain);
  });
  const screen = mount(lazy);
  await until(() => screen.last()?.shown === "failed");
  screen.last().retry();
  await until(() => screen.last()?.shown === "ready");
  assert.equal(asked, 2);
  assert.deepEqual(screen.errors, []);
  screen.unmount();
});

function layerCheckWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-layer-check-"));
  try {
    fs.cpSync("src", path.join(dir, "src"), { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, "src", name)), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", name), source);
    }
    return spawnSync(process.execPath, [path.resolve("tools/arch-check.mjs")], { cwd: dir, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the layer check lets a screen import useSecrets and the secret types", () => {
  const result = layerCheckWith({
    "screens/secretprobe/secretprobe.tsx": 'import type { SecretsStatus } from "../../data/secret-types";\nimport { useSecrets } from "../../data/secret-hooks";\n\nexport const status: SecretsStatus = "ready";\nexport const hook = useSecrets;\n',
  });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /arch-check: PASS/);
});

test("the layer check still refuses a screen that imports the secret stand-in itself", () => {
  const result = layerCheckWith({
    "screens/secretprobe/secretprobe.tsx": 'import { createSecretStandIn } from "../../data/secret-standin";\n\nexport const make = createSecretStandIn;\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /screens\/secretprobe\/secretprobe\.tsx imports data\/secret-standin\.ts: a screen uses data hooks only, not a data source/);
});
