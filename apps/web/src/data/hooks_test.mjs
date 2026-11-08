import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import esbuild from "esbuild";
import { loadTs } from "../../tools/load-ts.mjs";

const built = await esbuild.build({
  entryPoints: ["src/data/hooks.tsx"],
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const { createFeed } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const { toTracker } = await loadTs("src/data/trackers.ts");
const { trackerView } = await loadTs("src/domain/tracker.ts");
const signOutBuilt = await esbuild.build({
  stdin: { contents: 'export { attachChatFiles, readSession, subscribe, writeSession } from "./data/session"; export { signOutExample } from "./data/example-sign-out";', resolveDir: "src", loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  define: { "process.env.NODE_ENV": '"production"' },
});
const s = await import("data:text/javascript;base64," + Buffer.from(signOutBuilt.outputFiles[0].text).toString("base64"));
const signOut = () => s.signOutExample({ delay: 0, fail: new Set() });

const lanesFile = JSON.parse(fs.readFileSync("src/data/lanes.json", "utf8"));
const NOW = Date.parse(lanesFile.now);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a source whose trackers change after a watch notice shows the new Updated line without a remount", async () => {
  let raw = lanesFile.lanes["l-sea"];
  const listeners = new Set();
  const data = {
    now: () => NOW,
    load: async () => ({}),
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    trackers: async () => ({ "l-sea": toTracker(raw) }),
  };
  const feed = createFeed(data);
  let heard = 0;
  const stop = feed.trackers.subscribe(() => {
    heard += 1;
  });
  await tick();
  const updatedLine = () => trackerView(feed.trackers.snapshot().value["l-sea"], { now: "" }, NOW).updated;
  assert.equal(updatedLine(), "Updated 9:05 AM by Dr. Kivo");
  raw = { ...raw, updated: { at: "2026-11-02T09:40:00-05:00", by: "Shelvorn" } };
  for (const notify of listeners) notify();
  await tick();
  assert.equal(updatedLine(), "Updated 9:40 AM by Shelvorn");
  assert.equal(heard, 2);
  stop();
});

test("Sign out: every session value reads empty afterwards, a pages.query and a page.reading key included", async () => {
  const keys = ["queue.query", "queue.scroll", "pages.query.p-1", "page.reading.PG-1", "answer.c-1", "receipt", "chat.draft.iris", "chat.pending.iris", "mail.query", "mail.scroll"];
  for (const key of keys) s.writeSession(key, key === "chat.draft.iris" ? { text: "Unsent", quote: null, files: [] } : key === "chat.pending.iris" ? [] : "before");
  await signOut();
  assert.deepEqual(keys.filter((key) => s.readSession(key, undefined) !== undefined), []);
});

test("Sign out: a draft file's object URL is revoked", async () => {
  const url = URL.createObjectURL(new Blob(["notes"]));
  s.writeSession("chat.draft.iris", { text: "", quote: null, files: [{ id: "f-1", file: new File(["notes"], "notes.txt"), url }] });
  await signOut();
  assert.equal(resolveObjectURL(url), undefined);
});

test("Sign out: a screen listening on a key that held no value is told", async () => {
  let heard = 0;
  const stop = s.subscribe("pages.query.p-2", () => { heard += 1; });
  await signOut();
  stop();
  assert.equal(heard, 1);
});

test("Sign out: an attachment batch that finishes after Sign out writes nothing to the draft and makes no blob link", async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const adding = s.attachChatFiles("sign-out-batch", [new File(["notes"], "notes.txt")], async (files) => {
    await gate;
    return { accepted: files, refused: [] };
  });
  await signOut();
  const create = URL.createObjectURL;
  const made = [];
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    made.push(url);
    return url;
  };
  try {
    release();
    await adding;
  } finally {
    URL.createObjectURL = create;
    for (const url of made) URL.revokeObjectURL(url);
  }
  assert.deepEqual([s.readSession("chat.draft.sign-out-batch", null), made.length], [null, 0]);
});
