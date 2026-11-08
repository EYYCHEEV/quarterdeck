import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const built = fs.mkdtempSync(path.join(os.tmpdir(), "qd-open-chat-hook-"));
await esbuild.build({
  stdin: {
    contents: `export { createElement } from "react"; export { createRoot } from "react-dom/client"; export { DataProvider } from "./data/hooks"; export { useThread, useChatRows } from "./data/chat-hooks"; export { createExampleChat } from "./data/chat-example"; export { createOpenChat } from "./data/open-chat";`,
    resolveDir: "src",
    sourcefile: "open-chat-hook-entry.ts",
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
  assert.fail("the open chat never reached the expected value");
};
const turns = async (count) => {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function screen() {
  const openChat = r.createOpenChat();
  const chat = r.createExampleChat({ now: () => Date.parse("2026-11-02T10:00:00-05:00"), latency: () => 0, openChat });
  const errors = [];
  const root = r.createRoot(hostlessContainer(), { onUncaughtError: (error) => errors.push(error), onCaughtError: (error) => errors.push(error) });
  const data = { chat, load: async () => ({}), now: () => 0, watch: () => () => undefined };
  const show = (child) => root.render(r.createElement(r.DataProvider, { data, children: child }));
  const Thread = ({ botId }) => {
    r.useThread(botId);
    return null;
  };
  const Rows = () => {
    r.useChatRows();
    return null;
  };
  return { openChat, errors, show, thread: (botId) => r.createElement(Thread, { botId }), rows: () => r.createElement(Rows), unmount: () => root.unmount() };
}

test("a thread pane for a bot makes that bot's chat the open chat while it is shown", async () => {
  const s = screen();
  s.show(s.thread("alba"));
  await until(() => s.openChat.current()?.botId === "alba");
  assert.deepEqual(s.openChat.current(), { id: "chat-alba", botId: "alba" });
  assert.deepEqual(s.errors, []);
  s.unmount();
});

test("the same pane shown for another bot moves the open chat to that bot", async () => {
  const s = screen();
  s.show(s.thread("alba"));
  await until(() => s.openChat.current()?.botId === "alba");
  s.show(s.thread("iris"));
  await until(() => s.openChat.current()?.botId === "iris");
  assert.deepEqual(s.openChat.current(), { id: "chat-iris", botId: "iris" });
  assert.deepEqual(s.errors, []);
  s.unmount();
});

test("taking the thread pane away clears the open chat", async () => {
  const s = screen();
  s.show(s.thread("alba"));
  await until(() => s.openChat.current()?.botId === "alba");
  s.show(s.rows());
  await until(() => s.openChat.current() === null);
  assert.deepEqual(s.errors, []);
  s.unmount();
});

test("the sidebar's chat list alone never opens a chat", async () => {
  const s = screen();
  s.show(s.rows());
  await turns(30);
  assert.equal(s.openChat.current(), null);
  assert.deepEqual(s.errors, []);
  s.unmount();
});
