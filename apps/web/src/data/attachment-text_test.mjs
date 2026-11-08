import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

async function load(preview) {
  const built = await esbuild.build({ entryPoints: ["src/data/attachment-text.ts"], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: String(preview) } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { readAttachedText, READ_LIMIT } = await load(false);
const readPreviewText = (await load(true)).readAttachedText;
const PAGE = "https://quarterdeck.example/queue";
const BLOB = "blob:https://quarterdeck.example/abc";

async function withFetch(replacement, run, href = PAGE) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const beforeLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "fetch", { value: replacement, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", { value: { href }, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, "fetch", before);
    if (beforeLocation) Object.defineProperty(globalThis, "location", beforeLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

const answering = (body, asked = []) => async (url) => {
  asked.push(url);
  return new Response(body);
};

test("the limit is 100,000 characters", () => {
  assert.equal(READ_LIMIT, 100_000);
});

test("a short text comes back whole and is not cut, and the address asked for is the one given", async () => {
  const asked = [];
  const read = await withFetch(answering("line one\nline two", asked), () => readAttachedText(BLOB));
  assert.deepEqual(read, { text: "line one\nline two", cut: false });
  assert.deepEqual(asked, [BLOB]);
});

test("a text of exactly the limit is not cut", async () => {
  const read = await withFetch(answering("x".repeat(READ_LIMIT)), () => readAttachedText(BLOB));
  assert.equal(read.text.length, READ_LIMIT);
  assert.equal(read.cut, false);
});

test("a text over the limit comes back as its first 100,000 characters and says it is cut", async () => {
  const read = await withFetch(answering("a".repeat(READ_LIMIT) + "tail"), () => readAttachedText(BLOB));
  assert.equal(read.text, "a".repeat(READ_LIMIT));
  assert.equal(read.cut, true);
});

test("a request that fails is a failed read", async () => {
  await withFetch(() => Promise.reject(new Error("offline")), () => assert.rejects(readAttachedText(BLOB), /offline/));
});

test("a body that cannot be read as text is a failed read", async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("aborted")); } }));
  await withFetch(async () => response, () => assert.rejects(readAttachedText(BLOB), /aborted/));
});

for (const address of [
  "https://example.com/x.txt",
  "/captain/api/chats",
  "/chat/media/../../../captain/api/chats",
  "/evidence/media/%2e%2e/%2e%2e/captain/api/chats",
  "/chat/media-not-ours/x.txt",
  "data:text/plain,hello",
  "javascript:alert(1)",
  "blob:https://example.com/abc",
]) test("attachment previews refuse " + address + " before any request", async () => {
  const asked = [];
  await withFetch(answering("not allowed", asked), () => assert.rejects(readAttachedText(address)));
  assert.deepEqual(asked, []);
});

for (const address of ["/chat/media/run.log", "/evidence/media/run.log", "https://quarterdeck.example/chat/media/a%20b.txt"])
  test("served attachment previews read the app media address " + address + " once", async () => {
    const asked = [];
    const read = await withFetch(answering("allowed", asked), () => readAttachedText(address));
    assert.deepEqual(read, { text: "allowed", cut: false });
    assert.deepEqual(asked, [new URL(address, PAGE).href]);
  });

for (const address of ["chat/media/run.log", "evidence/media/run.log"])
  test("preview attachment reads resolve " + address + " beside the preview page", async () => {
    const asked = [];
    const page = "https://quarterdeck.example/previews/app/index.html";
    const read = await withFetch(answering("preview", asked), () => readPreviewText(address), page);
    assert.deepEqual(read, { text: "preview", cut: false });
    assert.deepEqual(asked, [new URL(address, page).href]);
  });

for (const address of [BLOB, "/chat/media/run.log", "/evidence/media/run.log"])
  test("allowed preview requests refuse redirects and use same-origin credentials for " + address, async () => {
    const asked = [];
    await withFetch(async (url, options) => {
      asked.push({ url, options });
      return new Response("allowed");
    }, () => readAttachedText(address));
    assert.deepEqual(asked, [{ url: new URL(address, PAGE).href, options: { redirect: "error", credentials: "same-origin" } }]);
  });

test("a 50 MB stream stops after a bounded number of chunks and cancels the rest", async () => {
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  const total = 50 * 1024 * 1024 / chunk.length;
  let pulled = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
      if (pulled === total) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const read = await withFetch(async () => response, () => readAttachedText(BLOB));
  assert.deepEqual(read, { text: "x".repeat(READ_LIMIT), cut: true });
  assert.ok(pulled <= 7, "pulled " + pulled + " chunks instead of at most seven");
  assert.equal(cancelled, true, "the unread stream is cancelled");
});

test("UTF-8 characters split across stream chunks decode without replacement", async () => {
  const bytes = new TextEncoder().encode("A€𝄞Z");
  const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5)];
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
  }));
  const read = await withFetch(async () => response, () => readAttachedText(BLOB));
  assert.deepEqual(read, { text: "A€𝄞Z", cut: false });
});

test("an oversized multi-byte chunk is cut at the same text limit", async () => {
  const read = await withFetch(answering("𝄞".repeat(READ_LIMIT)), () => readAttachedText(BLOB));
  assert.deepEqual(read, { text: "𝄞".repeat(READ_LIMIT / 2), cut: true });
});

test("an empty response body is an empty uncut preview", async () => {
  const read = await withFetch(async () => new Response(null), () => readAttachedText(BLOB));
  assert.deepEqual(read, { text: "", cut: false });
});
