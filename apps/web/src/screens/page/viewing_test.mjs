import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const built = fs.mkdtempSync(path.join(os.tmpdir(), "qd-page-viewing-"));
await esbuild.build({
  stdin: {
    contents: `export { createElement } from "react"; export { createRoot } from "react-dom/client"; export { DataProvider } from "./data/hooks"; export { useViewing } from "./screens/page/use-viewing"; export { readyVersion, showReady } from "./domain/pages";`,
    resolveDir: "src",
    sourcefile: "page-viewing-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  define: { __QD_FIXTURES__: "false", __QD_PREVIEW__: "false", "process.env.NODE_ENV": '"development"' },
  banner: { js: "import { createRequire as qdRequire } from 'node:module'; const require = qdRequire(import.meta.url);" },
  outfile: path.join(built, "entry.mjs"),
  logLevel: "silent",
});
const r = await import(pathToFileURL(path.join(built, "entry.mjs")).href);

const hostlessDocument = { nodeType: 9, activeElement: null, body: null, defaultView: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = { event: undefined, HTMLIFrameElement: class {}, document: hostlessDocument };
hostlessDocument.defaultView = globalThis.window;
const hostlessContainer = () => ({ nodeType: 1, tagName: "DIV", nodeName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: hostlessDocument, addEventListener() {}, removeEventListener() {}, textContent: "", childNodes: [] });

const turns = async (count) => {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};
const until = async (reached) => {
  for (let turn = 0; turn < 400; turn += 1) {
    if (reached()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("the Page viewing never reached the expected value");
};

const V1 = "pages/v1.html";
const V2 = "pages/v2.html";
const version = (n, file) => ({ n, madeAt: "2026-11-02T09:00:00-05:00", madeBy: "Shelvorn", file, kept: true });
const pageOf = (ref) => ({
  ref,
  projectId: "heron-forge",
  title: "Bridge runbook",
  by: "Shelvorn",
  updatedAt: "2026-11-02T09:35:00-05:00",
  live: false,
  file: V2,
  laneId: null,
  pinned: false,
  current: 2,
  versions: [version(1, V1), version(2, V2)],
  public: null,
  reading: { version: 1, at: "2026-11-02T09:20:00-05:00" },
});
const html = (file) => "<p>" + file + "</p>";

function screen(ref, openPage) {
  const page = pageOf(ref);
  const seen = {};
  const errors = [];
  const root = r.createRoot(hostlessContainer(), { onUncaughtError: (error) => errors.push(error), onCaughtError: (error) => errors.push(error) });
  const data = { now: () => 0, load: async () => ({}), watch: () => () => undefined, openPage };
  const Probe = () => {
    Object.assign(seen, r.useViewing(page));
    return null;
  };
  root.render(r.createElement(r.DataProvider, { data, children: r.createElement(Probe) }));
  return { page, seen, errors, show: () => seen.setViewing(r.showReady(page, seen.viewing)), unmount: () => root.unmount() };
}

test("Show loads the newer version once and keeps showing it without loading it again", async () => {
  const calls = [];
  const s = screen("PG-A", (file) => {
    calls.push(file);
    return Promise.resolve(html(file));
  });
  await until(() => s.seen.html === html(V1));
  s.show();
  await until(() => s.seen.viewing.shown === 2);
  await turns(10);
  assert.deepEqual(calls, [V1, V2]);
  assert.equal(s.seen.html, html(V2));
  assert.equal(s.seen.load.state, "shown");
  assert.deepEqual(s.errors, []);
  s.unmount();
});

test("a version that did not load leaves him on the old version with the ready line still there", async () => {
  const s = screen("PG-B", (file) => (file === V2 ? Promise.reject(new Error("the Page could not be reached")) : Promise.resolve(html(file))));
  await until(() => s.seen.html === html(V1));
  s.show();
  await until(() => s.seen.load.state === "failed");
  assert.deepEqual(s.seen.viewing, { shown: 1, trying: 2 });
  assert.equal(s.seen.html, html(V1));
  assert.equal(r.readyVersion(s.page, s.seen.viewing), 2);
  assert.deepEqual(s.errors, []);
  s.unmount();
});

test("Try again on a version that did not load shows that version", async () => {
  let reachable = false;
  const s = screen("PG-C", (file) => (file === V2 && !reachable ? Promise.reject(new Error("the Page could not be reached")) : Promise.resolve(html(file))));
  await until(() => s.seen.html === html(V1));
  s.show();
  await until(() => s.seen.load.state === "failed");
  reachable = true;
  s.seen.retry();
  await until(() => s.seen.viewing.shown === 2);
  await until(() => s.seen.html === html(V2));
  assert.deepEqual(s.errors, []);
  s.unmount();
});

test("a Page opened at the version he last read loads that version and nothing else", async () => {
  const calls = [];
  const s = screen("PG-D", (file) => {
    calls.push(file);
    return Promise.resolve(html(file));
  });
  await until(() => s.seen.html === html(V1));
  await turns(10);
  assert.deepEqual(calls, [V1]);
  assert.deepEqual(s.seen.viewing, { shown: 1, trying: null });
  s.unmount();
});
