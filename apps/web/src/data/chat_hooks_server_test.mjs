import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

async function hooks(define) {
  const built = fs.mkdtempSync(path.join(os.tmpdir(), "qd-chat-hooks-server-"));
  await esbuild.build({
    stdin: {
      contents: `export { createElement } from "react"; export { createRoot } from "react-dom/client"; export { DataProvider } from "./data/hooks"; export { useChatRows, useNewActivity } from "./data/chat-hooks";`,
      resolveDir: "src",
      sourcefile: "chat-hooks-server-entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    define: { __QD_FIXTURES__: "false", __QD_PREVIEW__: "false", "process.env.NODE_ENV": '"development"', ...define },
    banner: { js: "import { createRequire as qdRequire } from 'node:module'; const require = qdRequire(import.meta.url);" },
    outfile: path.join(built, "entry.mjs"),
    logLevel: "silent",
  });
  return import(pathToFileURL(path.join(built, "entry.mjs")).href);
}

const hostlessDocument = { nodeType: 9, activeElement: null, body: null, defaultView: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = { event: undefined, HTMLIFrameElement: class {}, document: hostlessDocument };
hostlessDocument.defaultView = globalThis.window;
const hostlessContainer = () => ({ nodeType: 1, tagName: "DIV", nodeName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: hostlessDocument, addEventListener() {}, removeEventListener() {}, textContent: "", childNodes: [] });

const turns = async (count) => {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function mount(r) {
  const calls = { list: 0, watch: 0 };
  const chat = {
    uploadBoundary: "server",
    listChats: async () => {
      calls.list += 1;
      return [];
    },
    watchChats: () => {
      calls.watch += 1;
      return () => undefined;
    },
    openThread: async () => ({}),
    subscribe: () => () => undefined,
    older: async () => ({}),
    send: async () => ({}),
  };
  const world = { cards: [], tasks: [], projects: [], lanes: [], pages: [], artifacts: [], mail: [], bots: [] };
  const data = { chat, load: async () => world, now: () => 0, watch: () => () => undefined };
  const errors = [];
  const root = r.createRoot(hostlessContainer(), { onUncaughtError: (error) => errors.push(error), onCaughtError: (error) => errors.push(error) });
  const Both = () => {
    r.useChatRows();
    r.useNewActivity();
    return null;
  };
  root.render(r.createElement(r.DataProvider, { data, children: r.createElement(Both) }));
  await turns(60);
  root.unmount();
  return { calls, errors };
}

test("with the chat flag on the menu dot adds no chat list read or watch to the rows' own", async () => {
  const { calls, errors } = await mount(await hooks({ __QD_SOURCE__: '"server"', __QD_CHAT__: '"on"' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, { list: 1, watch: 1 });
});

test("with the chat flag off the menu dot still reads and watches the chat list as well as the rows", async () => {
  const { calls, errors } = await mount(await hooks({ __QD_SOURCE__: '"server"', __QD_CHAT__: '"off"' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, { list: 2, watch: 2 });
});

test("in the example build, where the flag is not set, the menu dot still reads and watches the chat list as well as the rows", async () => {
  const { calls, errors } = await mount(await hooks({ __QD_SOURCE__: '"example"' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, { list: 2, watch: 2 });
});
