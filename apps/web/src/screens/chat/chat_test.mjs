import assert from "node:assert/strict";
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { chromeLaunchOptions } from "../../../tools/browser.mjs";
import { startAppServer } from "../../../tools/app-server.mjs";
import { measure } from "../../../tools/layout-measure.mjs";
import { animationsOf, motionPair, QUICK, settle, STANDARD } from "../../../motion-steps.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qd-chat-test-"));
const failed = [];
let passed = 0;

async function check(name, run) {
  try {
    await run();
    passed += 1;
    console.log("ok   " + name);
  } catch (error) {
    failed.push(name);
    console.log("FAIL " + name + "\n     " + String(error?.message ?? error).split("\n").slice(0, 8).join("\n     "));
  }
}

await esbuild.build({
  stdin: {
    contents: `export * from "./domain/markdown"; export * from "./domain/chat"; export * from "./domain/chat-files"; export { seedChats, chatFixture, fixtureMessages } from "./data/chat-content"; export { appChatHistory, appChatFixture } from "./data/chat-history"; export { attachChatFiles, readSession, writeSession } from "./data/session"; export { Markdown } from "./ui/markdown"; export { createExampleChat } from "./data/chat-example"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement } from "react";`,
    resolveDir: "src",
    sourcefile: "unit-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  define: { __QD_FIXTURES__: "true", __QD_PREVIEW__: "false" },
  banner: { js: "import { createRequire as qdRequire } from 'node:module'; const require = qdRequire(import.meta.url);" },
  outfile: path.join(tmp, "unit.mjs"),
  logLevel: "silent",
});
const u = await import(pathToFileURL(path.join(tmp, "unit.mjs")).href);
const html = (text) => u.renderToStaticMarkup(u.createElement(u.Markdown, { blocks: u.parseMarkdown(text), botName: "Alba" }));
const CONTENT = JSON.parse(fs.readFileSync("src/data/chat-content.json", "utf8"));
const FIXTURES = JSON.parse(fs.readFileSync("src/data/chat-fixtures.json", "utf8"));
const fixture = (id) => FIXTURES.fixtures.find((entry) => entry.fixture.split(" ")[0] === id);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

await check("markdown: paragraphs, lists, headings and code blocks parse into blocks", () => {
  const blocks = u.parseMarkdown("# Title\n\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2) b\n\n```sh\nnpm run build:app\n```\nafter");
  assert.deepEqual(blocks.map((b) => b.t), ["h", "p", "ul", "ol", "code", "p"]);
  assert.equal(blocks[2].v.length, 2);
  assert.equal(blocks[3].v.length, 2);
  assert.equal(blocks[4].v, "npm run build:app");
  assert.equal(blocks[4].lang, "sh");
});

await check("markdown: a code block shows its language, wraps by default and has Copy code", () => {
  const out = html("```bash\nnpm test\n```");
  assert.match(out, /<span>bash<\/span>/);
  assert.match(out, /<button[^>]*aria-pressed="true"[^>]*>Wrap lines<\/button>/);
  assert.match(out, /Copy code/);
  assert.match(out, /<pre[^>]*whitespace-pre-wrap[^>]*><code>npm test<\/code><\/pre>/);
});

await check("markdown: an unclosed code fence runs to the end and nothing is lost", () => {
  const blocks = u.parseMarkdown("```\nline one\nline two");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].v, "line one\nline two");
});

await check("markdown: bold, inline code and links render as elements", () => {
  const out = html("**Next:** run `npm test` and read [the notes](https://example.com/notes).");
  assert.match(out, /<strong[^>]*>Next:<\/strong>/);
  assert.match(out, /<code[^>]*>npm test<\/code>/);
  assert.match(out, /<button[^>]*aria-haspopup="dialog"[^>]*><span[^>]*>the notes<\/span><span[^>]*>example\.com<\/span><\/button>/);
  assert.doesNotMatch(out, /<a[^>]*href=/);
});

await check("markdown: markup inside code stays literal", () => {
  const out = html("`**not bold** [x](https://example.com)`\n\n```\n**raw**\n```");
  assert.match(out, /<code[^>]*>\*\*not bold\*\* \[x\]\(https:\/\/example\.com\)<\/code>/);
  assert.match(out, /<pre[^>]*><code>\*\*raw\*\*<\/code><\/pre>/);
});

await check("markdown: HTML in the text is shown as text, never run", () => {
  const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script> & "quoted"');
  assert.doesNotMatch(out, /<img|<script/);
  assert.match(out, /&lt;img/);
  assert.match(out, /&amp;/);
});

await check("markdown: blocked protocols, literals and suffixes cannot request confirmation", () => {
  for (const bad of ["http://example.com", "mailto:a@example.com", "https://trusted.example@actual.example.com", "https://127.0.0.1", "https://192.168.1.2", "https://service.internal", "javascript:alert(1)", "data:text/html;base64,AAAA", "file:///etc/passwd", "//example.com", "not a url"]) {
    assert.doesNotMatch(html("[click](" + bad + ")"), /<a |data-testid="bot-link"/, bad);
  }
  assert.equal(u.safeHref("http://example.com/x"), null);
});

await check("markdown: a deceptive label still renders the normalized destination hostname", () => {
  const out = html("[Trusted service](HTTPS://ACTUAL.EXAMPLE.COM:443/review)");
  assert.equal(u.parseMarkdown("[Trusted service](HTTPS://ACTUAL.EXAMPLE.COM:443/review)")[0].v[0].href, "https://actual.example.com/review");
  assert.match(out, /<button[^>]*><span[^>]*>Trusted service<\/span><span[^>]*>actual\.example\.com<\/span><\/button>/);
});

await check("markdown: the destination line keeps a nonstandard port", () => {
  assert.equal(u.parseMarkdown("[Review](https://example.com:8443/review)")[0].v[0].destination, "example.com:8443");
});

await check("markdown: a rejected destination renders the existing blocked-address wording", () => {
  const out = html("[Trusted service](http://example.com)");
  assert.doesNotMatch(out, /<a /);
  assert.match(out, /Trusted service/);
  assert.match(out, /Link blocked: not a safe address/);
});

await check("markdown: plain text strips every kind of markup", () => {
  assert.equal(u.plainText("**Done.** See [notes](https://example.com).\n\n- a\n- b\n\n```\ncode\n```"), "Done. See notes. a b code");
});

const firstInlines = (text) => u.parseMarkdown(text)[0].v;

await check("markdown: *x* and _x_ are italics, while a * b * c, snake_case_name, file_name_v2.txt and **bold** stay as they were", () => {
  assert.deepEqual(firstInlines("*one* and _two_"), [{ t: "em", v: [{ t: "text", v: "one" }] }, { t: "text", v: " and " }, { t: "em", v: [{ t: "text", v: "two" }] }]);
  assert.deepEqual(firstInlines("_foo_bar_baz_"), [{ t: "em", v: [{ t: "text", v: "foo_bar_baz" }] }]);
  assert.deepEqual(firstInlines("set max_rows and _then_ run"), [{ t: "text", v: "set max_rows and " }, { t: "em", v: [{ t: "text", v: "then" }] }, { t: "text", v: " run" }]);
  for (const literal of ["a * b * c", "snake_case_name", "file_name_v2.txt", "2 * 3 = 6"]) assert.deepEqual(firstInlines(literal), [{ t: "text", v: literal }], literal);
  assert.deepEqual(firstInlines("**bold**"), [{ t: "bold", v: [{ t: "text", v: "bold" }] }]);
  assert.deepEqual(firstInlines("**a *b* c**"), [{ t: "bold", v: [{ t: "text", v: "a " }, { t: "em", v: [{ t: "text", v: "b" }] }, { t: "text", v: " c" }] }]);
  assert.deepEqual(firstInlines("*a **b** c*"), [{ t: "em", v: [{ t: "text", v: "a " }, { t: "bold", v: [{ t: "text", v: "b" }] }, { t: "text", v: " c" }] }]);
  assert.match(html("Read *this* first."), /<p>Read <em>this<\/em> first\.<\/p>/);
});

await check("markdown: lines starting with > make one block quote whose text is Markdown again, nested to three, and a blank line or a line without > ends it", () => {
  const blocks = u.parseMarkdown("> **Plan:**\n> - one\n> - two\n>\n> ```sh\n> npm test\n> ```\nafter\n\n> again");
  assert.deepEqual(blocks.map((b) => b.t), ["quote", "p", "quote"]);
  assert.deepEqual(blocks[0].v.map((b) => b.t), ["p", "ul", "code"]);
  assert.equal(blocks[0].v[2].v, "npm test");
  assert.deepEqual(blocks[1].v, [{ t: "text", v: "after" }]);
  assert.deepEqual(u.parseMarkdown("> > > > four"), [{ t: "quote", v: [{ t: "quote", v: [{ t: "quote", v: [{ t: "p", v: [{ t: "text", v: "> four" }] }] }] }] }]);
  const out = html("> quiet");
  assert.match(out, /<blockquote[^>]*><p>quiet<\/p><\/blockquote>/);
  assert.doesNotMatch(out.match(/<blockquote[^>]*>/)[0], /brass/);
});

await check("markdown: a table has a header, a separator with its alignments and body rows of inline Markdown; a short row gets empty cells and a long row keeps its extra cells in the last one", () => {
  const [table] = u.parseMarkdown("| Name | Count | Share | Note |\n|:--|:-:|--:|---|\n| `npm test` | **2** | *50%* | [log](https://example.com/log) |\n| a \\| b | 1 |\n| x | y | z | w | extra | more |");
  assert.equal(table.t, "table");
  assert.deepEqual(table.align, ["left", "center", "right", null]);
  assert.deepEqual(table.head.map(u.inlineText), ["Name", "Count", "Share", "Note"]);
  assert.deepEqual(table.rows.map((row) => row.map(u.inlineText)), [["npm test", "2", "50%", "log"], ["a | b", "1", "", ""], ["x", "y", "z", "w | extra | more"]]);
  assert.deepEqual(table.rows[0].map((cell) => cell[0].t), ["code", "bold", "em", "link"]);
});

await check("markdown: a header without a separator, a separator with another cell count and a lone separator stay paragraphs with every word kept", () => {
  for (const text of ["| a | b |\n| c | d |", "| a | b |\n|---|", "|---|---|", "a | b\n---|---|---"]) {
    assert.equal(u.parseMarkdown(text).some((b) => b.t === "table"), false, text);
    assert.equal(u.plainText(text), text.replace(/\s+/g, " ").trim(), text);
  }
});

await check("markdown: a table over 20 columns stays a paragraph, and past 200 rows the first 200 form the table and the rest follow as text", () => {
  const row = (n, cell) => "| " + Array.from({ length: n }, (_, i) => cell + i).join(" | ") + " |";
  const divider = (n) => "|" + "---|".repeat(n);
  assert.deepEqual(u.parseMarkdown([row(21, "h"), divider(21), row(21, "c")].join("\n")).map((b) => b.t), ["p"]);
  assert.equal(u.parseMarkdown([row(20, "h"), divider(20), row(20, "c")].join("\n"))[0].head.length, 20);
  const blocks = u.parseMarkdown([row(2, "h"), divider(2), ...Array.from({ length: 201 }, (_, i) => row(2, "r" + i + "-"))].join("\n"));
  assert.deepEqual(blocks.map((b) => b.t), ["table", "p"]);
  assert.equal(blocks[0].rows.length, 200);
  assert.equal(u.inlineText(blocks[1].v), row(2, "r200-"));
});

await check("markdown: a table renders inside a focusable, named region that scrolls sideways, at its natural width with each cell's words in a 15rem inline block that breaks long words, with header cells and each column's alignment", () => {
  const out = html("| Name | Count |\n|:-:|--:|\n| a | 1 |");
  const region = out.match(/<div[^>]*role="region"[^>]*>/)?.[0] ?? "";
  assert.match(region, /aria-label="Table"/);
  assert.match(region, /tabindex="0"/);
  assert.match(region, /overflow-x-auto/);
  assert.match(out, /<table class="[^"]*\bw-max\b/);
  assert.match(out, /<th[^>]*text-center[^>]*><span class="[^"]*">Name<\/span><\/th><th[^>]*text-right[^>]*><span class="[^"]*">Count<\/span><\/th>/);
  assert.match(out, /<td[^>]*text-center[^>]*><span class="[^"]*">a<\/span><\/td><td[^>]*text-right[^>]*><span class="[^"]*">1<\/span><\/td>/);
  for (const [, classes] of out.matchAll(/<t[hd][^>]*><span class="([^"]*)">/g)) assert.deepEqual(["inline-block", "max-w-60", "wrap-anywhere"].filter((name) => !classes.split(" ").includes(name)), [], classes);
});

await check("markdown: HTML and blocked links in table cells and block quotes stay inert text, and a safe link in a cell still asks first", () => {
  const out = html("| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n|---|---|\n| <script>alert(1)</script> | [ok](https://example.com/ok) |\n\n> <img src=y onerror=alert(2)> [y](http://example.com)");
  assert.doesNotMatch(out, /<img|<script|<a /);
  assert.match(out, /&lt;img src=x/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&lt;img src=y/);
  assert.equal((out.match(/Link blocked: not a safe address/g) ?? []).length, 2);
  assert.match(out, /<td[^>]*><span[^>]*><button[^>]*aria-haspopup="dialog"[^>]*><span[^>]*>ok<\/span><span[^>]*>example\.com<\/span><\/button><\/span><\/td>/);
});

await check("markdown: plain text reads tables, block quotes and italics as their words", () => {
  assert.equal(u.plainText("Check *this*:\n\n> quoted _words_\n\n| a | b |\n|---|---|\n| 1 | 2 |"), "Check this: quoted words a b 1 2");
});

await check("readableText: a table is one line per row with a tab between cells, as a browser copies a table selection, so a selection across cells quotes just those cells; a block quote is its text without >; italics lose their marks", () => {
  assert.equal(u.readableText("Before *this*.\n\n| Name | Count |\n|---|--:|\n| a | 1 |\n| b |\n\n> one\n>\n> > two"), "Before this.\n\nName\tCount\na\t1\nb\t\n\none\n\ntwo");
  const quote = u.messageQuote({ id: "m1", who: "Iris", at: "2026-11-02T08:30:00-05:00", text: "| Name | Count |\n|---|---|\n| a | 1 |", selected: "a\t1" });
  assert.deepEqual([quote.whole, quote.text], [false, "a\t1"]);
});

const pump = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  const jobs = [];
  let now = 1_000_000;
  return {
    now: () => now,
    schedule: (run, ms) => {
      const job = { at: now + ms, run, live: true };
      jobs.push(job);
      return () => {
        job.live = false;
      };
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = jobs.filter((j) => j.live && j.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        now = due.at;
        due.run();
        await pump();
      }
      now = end;
      await pump();
    },
  };
}

async function opened(options) {
  const clock = fakeClock();
  const api = u.createExampleChat({ now: clock.now, schedule: clock.schedule, latency: () => 0, ...options });
  const pending = api.openThread("iris");
  await pump();
  await clock.advance(0);
  return { clock, api, thread: await pending };
}

const outcome = (promise) =>
  promise.then(
    () => "sent",
    () => "failed",
  );

await check("chat history: nothing is visible or sendable before loader checks finish", async () => {
  const subtle = crypto.subtle;
  const descriptor = Object.getOwnPropertyDescriptor(subtle, "digest");
  const digest = subtle.digest.bind(subtle);
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const checking = new Promise((resolve) => { started = resolve; });
  Object.defineProperty(subtle, "digest", { configurable: true, writable: true, value: (...args) => {
    started();
    return gate.then(() => digest(...args));
  } });
  try {
    const api = u.createExampleChat({ latency: () => 0, schedule: (run) => { queueMicrotask(run); return () => undefined; } });
    let visible = false;
    let sent = false;
    let notifications = 0;
    api.subscribe("iris", () => { notifications += 1; });
    const opening = api.openThread("iris").then((thread) => { visible = true; return thread; });
    const sending = api.send("iris", { text: "After checks", clientId: "history-gate" }).then((message) => { sent = true; return message; });
    await Promise.race([checking, opening]);
    assert.equal(visible || sent || notifications > 0, false);
    release();
    await Promise.all([opening, sending]);
  } finally {
    release();
    if (descriptor) Object.defineProperty(subtle, "digest", descriptor);
    else delete subtle.digest;
  }
});

await check("chat history: tampered fixed history never reaches the store", async () => {
  const tampered = structuredClone(CONTENT);
  tampered.chats["alba"].messagesAdd[0].text = "Tampered history.";
  const target = path.join(tmp, "tampered-history.mjs");
  await esbuild.build({
    stdin: { contents: 'export { createExampleChat } from "./data/chat-example";', resolveDir: "src", sourcefile: "tampered-entry.ts", loader: "ts" },
    bundle: true, platform: "node", format: "esm", jsx: "automatic",
    define: { __QD_FIXTURES__: "true", __QD_PREVIEW__: "false" },
    outfile: target, logLevel: "silent",
    plugins: [{ name: "tampered-fixed-history", setup(build) {
      build.onLoad({ filter: /chat-content\.json$/ }, () => ({ contents: JSON.stringify(tampered), loader: "json" }));
    } }],
  });
  const test = await import(pathToFileURL(target).href);
  const api = test.createExampleChat({ latency: () => 0, schedule: (run) => { queueMicrotask(run); return () => undefined; } });
  let notifications = 0;
  api.subscribe("alba", () => { notifications += 1; });
  await Promise.all([
    assert.rejects(api.openThread("alba"), /Chat history could not be verified/),
    assert.rejects(api.send("alba", { text: "Must not store", clientId: "tampered-history" }), /Chat history could not be verified/),
  ]);
  assert.equal(notifications, 0);
});

await check("chat source: a sent message is Seen with its time, then the bot is working, then the reply replaces the working note", async () => {
  const { clock, api } = await opened();
  const opening = api.openThread("alba");
  await clock.advance(0);
  const start = (await opening).messages.length;
  const seen = [];
  api.subscribe("alba", (t) => seen.push({ seenUpTo: t.seenUpTo, seenAt: t.seenAt, working: t.working, count: t.messages.length }));
  const sending = api.send("alba", { text: "Hello", clientId: "c-1" });
  await clock.advance(0);
  const message = await sending;
  assert.equal(seen.at(-1).count, start + 1);
  assert.notEqual(seen.at(-1).seenUpTo, message.id);
  await clock.advance(700);
  assert.equal(seen.at(-1).seenUpTo, message.id);
  assert.equal(seen.at(-1).seenAt, new Date(clock.now()).toISOString());
  assert.equal(seen.at(-1).working, null);
  await clock.advance(700);
  assert.deepEqual(seen.at(-1).working, { note: "reading your message", since: new Date(clock.now()).toISOString(), updatedAt: new Date(clock.now()).toISOString() });
  await clock.advance(1800);
  assert.equal(seen.at(-1).working, null);
  assert.equal(seen.at(-1).count, start + 2);
});

await check("chat source: sending the same client id twice never makes a second message", async () => {
  const { clock, api } = await opened();
  const first = api.send("iris", { text: "Hello", clientId: "c-9" });
  await clock.advance(0);
  const again = api.send("iris", { text: "Hello", clientId: "c-9" });
  await clock.advance(0);
  assert.equal((await first).id, (await again).id);
  const thread = api.openThread("iris");
  await clock.advance(0);
  assert.equal((await thread).messages.filter((m) => m.clientId === "c-9").length, 1);
});

await check("chat source: a failed send says so and the retry goes through once", async () => {
  const { clock, api } = await opened({ failSend: (attempt) => attempt === 1 });
  const first = outcome(api.send("iris", { text: "Hello", clientId: "c-2" }));
  await clock.advance(0);
  assert.equal(await first, "failed");
  const retry = api.send("iris", { text: "Hello", clientId: "c-2" });
  await clock.advance(0);
  assert.equal((await retry).clientId, "c-2");
  const thread = api.openThread("iris");
  await clock.advance(0);
  assert.equal((await thread).messages.filter((m) => m.clientId === "c-2").length, 1);
});

await check("chat source: a reply to a chat nobody has open marks it unread", async () => {
  const { clock, api } = await opened();
  const rows = async () => {
    const list = api.listChats();
    await clock.advance(0);
    return list;
  };
  assert.equal((await rows()).find((r) => r.bot.id === "iris").unread, false);
  const sending = api.send("iris", { text: "Hello", clientId: "c-3" });
  await clock.advance(0);
  await sending;
  await clock.advance(3300);
  const after = (await rows()).find((r) => r.bot.id === "iris");
  assert.equal(after.unread, true);
  assert.equal(after.preview.startsWith("Seen. I will check it"), true);
});

await check("chat source: a source that always fails never stores the message", async () => {
  const { clock, api } = await opened({ failSend: () => true });
  for (let n = 0; n < 3; n++) {
    const run = outcome(api.send("iris", { text: "Hello", clientId: "c-4" }));
    await clock.advance(0);
    assert.equal(await run, "failed");
  }
  const thread = api.openThread("iris");
  await clock.advance(0);
  assert.equal((await thread).messages.some((m) => m.clientId === "c-4"), false);
});

await check("chat source: files sent with a message come back with their name, size and kind as object URLs kept in the page", async () => {
  const { clock, api } = await opened();
  const { accepted: files } = await u.admit([new File(["hello"], "notes.txt", { type: "text/plain" }), new File([PNG], "shot.png", { type: "image/png" })], 0);
  const sending = api.send("iris", { text: "See these", clientId: "c-5", files });
  await clock.advance(0);
  const message = await sending;
  assert.deepEqual(message.attachments.map((a) => [a.name, a.size, a.type]), [["notes.txt", 5, "text/plain"], ["shot.png", PNG.length, "image/png"]]);
  for (const attachment of message.attachments) assert.match(attachment.url, /^blob:/);
  assert.equal(await (await fetch(message.attachments[0].url)).text(), "hello");
});

for (const [name, file] of [
  ["an executable renamed .txt", new File([new Uint8Array([77, 90, 144, 0, 3, 0, 0, 0])], "notes.txt", { type: "text/plain" })],
  ["HTML renamed .pdf", new File(["<!doctype html><html><script>alert(1)</script></html>"], "report.pdf", { type: "application/pdf" })],
  ["a picture with a mismatched reported MIME", new File([PNG], "shot.png", { type: "image/jpeg" })],
]) {
  await check("chat upload boundary: " + name + " is refused before storage", async () => {
    const { clock, api } = await opened();
    const valid = (await u.admit([new File(["valid notes"], "safe.txt")], 0)).accepted;
    assert.equal((await u.inspectFile(file, 1)).ok, false);
    const rejected = assert.rejects(api.send("iris", { text: "Must not store", clientId: "unsafe-upload", files: [...valid, file] }));
    await clock.advance(0);
    await rejected;
    const reading = api.openThread("iris");
    await clock.advance(0);
    assert.equal((await reading).messages.some((message) => message.clientId === "unsafe-upload"), false);
  });
}

await check("chat upload boundary: an unprepared valid File is refused before storage", async () => {
  const { clock, api } = await opened();
  const rejected = assert.rejects(api.send("iris", { text: "Must not store", clientId: "unprepared-upload", files: [new File(["notes"], "notes.txt")] }), /must be checked/);
  await clock.advance(0);
  await rejected;
  const reading = api.openThread("iris");
  await clock.advance(0);
  assert.equal((await reading).messages.some((message) => message.clientId === "unprepared-upload"), false);
});

await check("chat upload boundary: a local verdict explicitly requires the real server to check again", async () => {
  const { clock, api } = await opened();
  const { accepted: files } = await u.admit([new File(["notes"], "notes.txt")], 0);
  const sending = api.send("iris", { text: "Local file", clientId: "local-verdict", files });
  await clock.advance(0);
  const message = await sending;
  assert.equal(api.uploadBoundary, "browser-stand-in");
  assert.deepEqual(message.uploadVerdicts, [{ filename: "notes.txt", detectedType: "text/plain", checkedBy: "browser-stand-in", serverRecheckRequired: true }]);
});

await check("chat upload boundary: concurrent sends of one inspected file store one message", async () => {
  const { clock, api } = await opened();
  const { accepted: files } = await u.admit([new File(["notes"], "notes.txt")], 0);
  const outgoing = { text: "Once", clientId: "concurrent-upload", files };
  const both = Promise.all([api.send("iris", outgoing), api.send("iris", outgoing)]);
  await clock.advance(0);
  const sent = await both;
  assert.equal(sent[0].id, sent[1].id);
  const reading = api.openThread("iris");
  await clock.advance(0);
  assert.equal((await reading).messages.filter((message) => message.clientId === outgoing.clientId).length, 1);
});

await check("chat admission: typing while file bytes are checked is not overwritten", async () => {
  const key = "chat.draft.admission-text";
  u.writeSession(key, { text: "Before", quote: null, files: [] });
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  const file = new File(["notes"], "notes.txt");
  const read = file.arrayBuffer.bind(file);
  file.arrayBuffer = () => { started(); return gate.then(read); };
  const adding = u.attachChatFiles("admission-text", [file], u.admit);
  await reading;
  u.writeSession(key, { text: "Typed while checking", quote: null, files: [] });
  release();
  await adding;
  const draft = u.readSession(key, null);
  assert.equal(draft.text, "Typed while checking");
  for (const item of draft.files) URL.revokeObjectURL(item.url);
});

await check("chat admission: concurrent batches count against one ten-file limit", async () => {
  const key = "chat.draft.admission-limit";
  u.writeSession(key, { text: "", quote: null, files: [] });
  const first = Array.from({ length: 9 }, (_, n) => new File(["notes"], "first-" + n + ".txt"));
  const second = [new File(["notes"], "tenth.txt"), new File(["notes"], "eleventh.txt")];
  const [, refused] = await Promise.all([u.attachChatFiles("admission-limit", first, u.admit), u.attachChatFiles("admission-limit", second, u.admit)]);
  const draft = u.readSession(key, null);
  assert.equal(draft.files.length, 10);
  assert.deepEqual(refused, ["A message can carry up to 10 files."]);
  for (const item of draft.files) URL.revokeObjectURL(item.url);
});

await check("chat source: a message sent without files carries no attachments", async () => {
  const { clock, api } = await opened();
  const sending = api.send("iris", { text: "Only words", clientId: "c-6" });
  await clock.advance(0);
  assert.equal("attachments" in (await sending), false);
});

await check("chat source: a quote sent with a message comes back with it, the source message id included", async () => {
  const { clock, api } = await opened();
  const quote = u.messageQuote({ id: "iris-m2", who: "Iris", at: "2026-11-02T08:30:00-05:00", text: "c1 and c2", selected: null });
  const sending = api.send("iris", { text: "Which one?", clientId: "c-7", quote });
  await clock.advance(0);
  assert.deepEqual((await sending).quote, quote);
});

await check("chat content: merging it over the five chats gives the message order, Seen marks and unread marks the content file lists", () => {
  const seed = u.seedChats(CONTENT, "/");
  for (const [bot, ids] of Object.entries(CONTENT.expectedAfterMerge.messageOrder)) assert.deepEqual(seed.messages[bot].map((m) => m.id), ids, bot);
  assert.deepEqual(Object.fromEntries(Object.entries(seed.seen).map(([bot, mark]) => [bot, mark.id])), CONTENT.expectedAfterMerge.seenMarks);
  for (const mark of Object.values(seed.seen)) assert.equal(mark.at, CONTENT.seenAt[mark.id]);
  assert.deepEqual([...seed.unread].sort(), CONTENT.expectedAfterMerge.unreadChats);
});

await check("chat content: the one existing message with new text had the old text the content file names, and now reads the new text", () => {
  const fixes = CONTENT.existingMessageFixes;
  assert.deepEqual(Object.keys(fixes), ["dr-kivo-m1"]);
  const before = u.seedChats({ ...CONTENT, existingMessageFixes: {} }, "/");
  const after = u.seedChats(CONTENT, "/");
  for (const [id, fix] of Object.entries(fixes)) {
    assert.equal(createHash("sha256").update(before.messages[fix.chat].find((m) => m.id === id).text).digest("hex"), fix.text.wasSha256);
    assert.equal(after.messages[fix.chat].find((m) => m.id === id).text, fix.text.now);
  }
});

await check("chat content: every sidebar row ends on the last message with the time and unread mark the content file lists", async () => {
  const { clock, api } = await opened();
  const list = api.listChats();
  await clock.advance(0);
  const rows = await list;
  for (const [bot, expected] of Object.entries(CONTENT.expectedAfterMerge.sidebarRows)) {
    const row = rows.find((r) => r.bot.id === bot);
    assert.equal(Date.parse(row.at), Date.parse(expected.at), bot);
    assert.equal(row.unread, expected.unread, bot);
    assert.equal(row.preview, expected.preview, bot);
  }
});

const rowOf = async (clock, api, bot) => {
  const list = api.listChats();
  await clock.advance(0);
  return (await list).find((row) => row.bot.id === bot);
};

await check("chat sidebar row: his own last message reads You: and the words he sent", async () => {
  const { clock, api } = await opened();
  const sending = api.send("iris", { text: "Which one? See c1.", clientId: "row-own" });
  await clock.advance(0);
  await sending;
  assert.equal((await rowOf(clock, api, "iris")).preview, "You: Which one? See c1.");
});

await check("chat sidebar row: a bot's last message reads as its words, with no You:", async () => {
  const { clock, api } = await opened();
  const row = await rowOf(clock, api, "alba");
  assert.equal(row.preview.startsWith("You: "), false);
  assert.equal(row.preview.length > 0, true);
});

const PICTURE_ONE = () => new File([PNG], "shot.png", { type: "image/png" });
const PICTURE_TWO = () => new File([PNG], "shot-2.png", { type: "image/png" });
const NOTES = () => new File(["hello"], "notes.txt", { type: "text/plain" });
const RUN_LOG = () => new File(["trace"], "run.log", { type: "text/plain" });

for (const [what, text, make, expected] of [
  ["a message of one picture and no text", "", () => [PICTURE_ONE()], "You: Picture"],
  ["a message of two pictures and no text", "", () => [PICTURE_ONE(), PICTURE_TWO()], "You: 2 pictures"],
  ["a message of one file and no text", "", () => [NOTES()], "You: notes.txt"],
  ["a message of two files and no text", "", () => [NOTES(), RUN_LOG()], "You: 2 files"],
  ["a message of a picture and a file and no text", "", () => [PICTURE_ONE(), NOTES()], "You: 1 picture and 1 file"],
  ["a message of two pictures and a file and no text", "", () => [PICTURE_ONE(), PICTURE_TWO(), NOTES()], "You: 2 pictures and 1 file"],
  ["a message of a file and only spaces as text", "   ", () => [NOTES()], "You: notes.txt"],
  ["a message of a file and the words See these", "See these", () => [NOTES()], "You: See these"],
]) {
  await check("chat sidebar row: " + what + " reads " + expected, async () => {
    const { clock, api } = await opened();
    const { accepted: files } = await u.admit(make(), 0);
    const sending = api.send("iris", { text, clientId: "row-files", files });
    await clock.advance(0);
    await sending;
    assert.equal((await rowOf(clock, api, "iris")).preview, expected);
  });
}

await check("chat content: the two working lines work out to the minutes and the No word line the content file computed", () => {
  for (const [bot, record] of Object.entries(CONTENT.working)) {
    const status = u.workingStatus({ since: record.since, updatedAt: record.noteUpdatedAt }, Date.parse(CONTENT.now));
    assert.equal(status.minutes, record.computed.workingMinutes, bot);
    assert.equal(status.quiet, record.computed.noWord, bot);
  }
});

await check("chat fixture CF-1: minutes round down, the 10 minutes count from the last note, and exactly 10 minutes counts as no word", () => {
  const cf1 = fixture("CF-1");
  let updatedAt = cf1.working.noteUpdatedAt;
  for (const step of cf1.steps) {
    if (step.event?.includes("sets a new note")) updatedAt = step.now;
    if (!step.expect.line1 && step.expect.noWord === undefined) continue;
    const status = u.workingStatus({ since: cf1.working.since, updatedAt }, Date.parse(step.now));
    if (step.expect.line1) assert.equal(step.expect.line1, "Iris is working · " + status.minutes + " min", step.now);
    if (step.expect.noWord !== undefined) assert.equal(status.quiet, step.expect.noWord, step.now);
  }
});

await check("chat content: every size the content file shows is what the size rule gives for its bytes", () => {
  const messages = [...Object.values(CONTENT.chats).flatMap((chat) => chat.messagesAdd), ...FIXTURES.fixtures.flatMap((entry) => [...(entry.message ? [entry.message] : []), ...(entry.messages ?? [])])];
  const sized = [...messages.flatMap((m) => m.attachments ?? []), ...FIXTURES.fixtures.flatMap((entry) => entry.composerStrip ?? [])];
  assert.equal(sized.length >= 20, true);
  for (const item of sized) assert.equal(u.sizeText(item.bytes), item.size, item.name);
});

await check("chat fixture CF-2: files are accepted or refused at exactly 10 MB for pictures and 50 MB for others (the .mov edges are tried as PDF, as .mov is not an allowed kind), with the wording the fixture suggests", () => {
  assert.equal(u.MAX_IMAGE_BYTES, 10485760);
  assert.equal(u.MAX_FILE_BYTES, 52428800);
  const cf2 = fixture("CF-2");
  const info = (item) => ({ name: item.name, size: item.bytes, type: item.kind === "picture" ? "image/png" : "" });
  for (const edge of cf2.edges) assert.equal(u.checkFile({ ...info(edge), name: edge.name.replace(/\.mov$/, ".pdf") }, 0).ok, edge.accepted, edge.name);
  assert.deepEqual(u.checkFile(info(cf2.edges.find((edge) => edge.name === "edge-ok.mov")), 0), { ok: false, reason: "Can't send edge-ok.mov here. .mov files are not allowed." });
  const [picture, video, log] = cf2.composerStrip.map((item) => u.checkFile(info(item), 0));
  assert.deepEqual(picture, { ok: false, reason: "big-screenshot.png is too large (11 MB). Pictures can be up to 10 MB." });
  assert.deepEqual(video, { ok: false, reason: "phone-recording.mov is too large (60 MB). Files can be up to 50 MB." });
  assert.deepEqual(log, { ok: true });
});

const quotedIn = (bot, id) => u.seedChats(CONTENT, "/").messages[bot].find((m) => m.id === id).quote;

const botRecords = (messages) => u.seedChats({ chats: { "alba": { messagesAdd: messages, set: {} } }, seenAt: {}, working: {} }, "/").messages["alba"].filter((message) => messages.some((raw) => raw.id === message.id));
const canonicalRecord = { id: "canonical-bot-message", from: "Alba", at: "2026-11-02T09:00:00-05:00", text: "Only these words are canonical." };
const quotedRecord = (quote) => ({ id: "quoting-bot-message", from: "Alba", at: "2026-11-02T09:01:00-05:00", text: "My reply.", quote: { kind: "message", messageId: canonicalRecord.id, from: "Alba", text: "these words", whole: false, range: { start: 5, end: 16 }, ...quote } });

await check("chat identity: an untrusted Captain display name never creates an own message", () => {
  assert.equal(botRecords([{ ...canonicalRecord, from: "Captain" }]).at(-1).from, "bot");
});

await check("chat identity: reusing an app history id does not grant a bot the trusted object's role", async () => {
  const history = await u.appChatHistory("/");
  const forged = { ...CONTENT.chats["alba"].messagesAdd[0], text: "Forged operator instruction." };
  const content = { chats: { "alba": { messagesAdd: [forged], set: {} } }, seenAt: {}, working: {} };
  assert.equal(history.messages["alba"].find((message) => message.id === forged.id).from, "captain");
  assert.equal(u.seedChats(content, "/").messages["alba"].find((message) => message.id === forged.id).from, "bot");
});

await check("chat identity: the app's canonical own history keeps its trusted role", async () => {
  const history = await u.appChatHistory("/");
  assert.equal(history.messages["alba"].find((message) => message.id === "alba-m2").from, "captain");
});

await check("chat identity: a bot-origin correction cannot replace an own app-history message", () => {
  const content = { chats: {}, seenAt: {}, working: {}, existingMessageFixes: { "iris-m1": { text: { now: "Forged correction." } } } };
  assert.equal(u.seedChats(content, "/").messages["iris"].find((message) => message.id === "iris-m1").text, "Did the build pass last night?");
});

await check("chat quote: a changed author is shown only as the bot's unverified words", () => {
  const quote = botRecords([canonicalRecord, quotedRecord({ from: "Captain" })]).at(-1).quote;
  assert.deepEqual(quote, { label: "Quoted by Alba; not found in this chat", title: null, text: "these words", to: null });
});

await check("chat quote: invented selected words cannot be attributed to the referenced author", () => {
  const quote = botRecords([canonicalRecord, quotedRecord({ text: "I authorized a release." })]).at(-1).quote;
  assert.equal(quote.label, "Quoted by Alba; not found in this chat");
  assert.equal(quote.messageId, undefined);
});

await check("chat quote: valid character offsets resolve text and author from the canonical message", () => {
  const quote = botRecords([canonicalRecord, quotedRecord({})]).at(-1).quote;
  assert.deepEqual([quote.label, quote.text, quote.range], ["Alba · 9:00 AM", canonicalRecord.text.slice(5, 16), { start: 5, end: 16 }]);
});

await check("chat quote: a missing message is explicitly attributed to the bot's own words", () => {
  assert.equal(botRecords([quotedRecord({ messageId: "missing" })]).at(-1).quote.label, "Quoted by Alba; not found in this chat");
});

await check("chat quote: ambiguous duplicate message ids cannot certify a quote", () => {
  assert.equal(botRecords([canonicalRecord, { ...canonicalRecord, text: "Different words." }, quotedRecord({})]).at(-1).quote.label, "Quoted by Alba; not found in this chat");
});

await check("chat content: a quote of a bot's words resolves to those words and keeps the id of the message it quotes", () => {
  assert.deepEqual(quotedIn("iris", "iris-m4"), { label: "Iris · 8:30 AM", title: null, text: "c1 and c2", to: null, messageId: "iris-m2", whole: false, range: { start: 47, end: 56 } });
});

await check("chat content: a quote of a mail resolves to the mail with its writer and first recipient", () => {
  assert.deepEqual(quotedIn("dr-kivo", "dr-kivo-m3"), { label: "MT-101.2", title: "Dr. Kivo to Alba", text: "Five fits the iPhone with the keyboard up. Three is too few for Chats.", to: "/mail/MT-101.2" });
});

await check("chat content: a quote of the card resolves to the card at the version he sent", () => {
  assert.deepEqual(["alba-m4", "alba-m6", "alba-m8"].map((id) => quotedIn("alba", id)), [1, 2, 3].map((version) => ({ cardId: "alba-1", version })));
});

await check("chat content: only the three edits of alba-1 carry a Card updated line, each with its version", () => {
  const seed = u.seedChats(CONTENT, "/");
  const updates = Object.values(seed.messages).flat().filter((m) => m.cardUpdate);
  assert.deepEqual(updates.map((m) => [m.id, m.cardUpdate.cardId, m.cardUpdate.version]), [["alba-m5", "alba-1", 2], ["alba-m7", "alba-1", 3], ["alba-m9", "alba-1", 4]]);
  for (const m of updates) assert.match(m.cardUpdate.line, new RegExp("^Card updated: version " + m.cardUpdate.version + ", .+[^.]\\.$"));
});

const albaPictures = (media) => u.seedChats(CONTENT, media).messages["alba"].find((m) => m.id === "alba-m2").attachments;

await check("chat content: a sent file's name, size, kind and picture words come from the content file", () => {
  const source = CONTENT.chats["alba"].messagesAdd[0].attachments;
  const first = albaPictures("/");
  assert.deepEqual(first.map((a) => [a.name, a.size, a.type]), source.map((a) => [a.name, a.bytes, a.mime]));
  assert.equal(first[0].alt, source[0].alt);
});

await check("chat content: pictures read from the media folder, and the files they point to exist", () => {
  const first = albaPictures("/");
  assert.equal(first[0].url, "/chat/media/phone-search-1.png");
  assert.deepEqual(first.filter((a) => a.type.startsWith("image/")).map((a) => fs.existsSync("public" + a.url)), [true, true]);
});

await check("chat content: the preview build reads the pictures from beside the page", () => {
  assert.equal(albaPictures("")[0].url, "chat/media/phone-search-1.png");
});

await check("chat content: a file keeps its text as a blob the page holds", async () => {
  const source = CONTENT.chats["alba"].messagesAdd[0].attachments;
  const first = albaPictures("/");
  assert.match(first[2].url, /^blob:/);
  assert.equal(await (await fetch(first[2].url)).text(), source[2].text);
});

for (const media of ["/", ""]) {
  await check("chat media " + (media ? "default" : "preview") + ": external and same-origin escapes become unavailable", () => {
    for (const file of ["../../../https://attacker.example/pixel.png", "media/../../app.js", "../evidence/media/fixture-picture-1.png", "/picture.png", "//attacker.example/pixel.png", "https://attacker.example/pixel.png", "media/..\\picture.png", "media/%2e%2e%2fpicture.png", "media/picture.png?part", "media/picture.png#part", "media//picture.png", "data:picture.png", ""]) {
      const message = { id: "unsafe", from: "Alba", at: "2026-11-02T09:00:00-05:00", text: "", attachments: [{ id: "unsafe-picture", kind: "picture", name: "picture.png", mime: "image/png", bytes: 20, file }] };
      const seed = u.seedChats({ chats: { "alba": { messagesAdd: [message], set: {} } }, seenAt: {}, working: {} }, media);
      assert.equal(seed.messages["alba"].find((m) => m.id === "unsafe").attachments[0].url, "", file);
    }
  });
  await check("chat media " + (media ? "default" : "preview") + ": valid file paths stay in the allowed media folder", () => {
    const message = { id: "file-path", from: "Alba", at: "2026-11-02T09:00:00-05:00", text: "", attachments: [{ id: "log", kind: "file", name: "run notes.log", mime: "text/plain", bytes: 20, file: "media/run notes.log" }] };
    const content = { chats: { "alba": { messagesAdd: [message], set: {} } }, seenAt: {}, working: {} };
    assert.equal(u.seedChats(content, media).messages["alba"].find((m) => m.id === "file-path").attachments[0].url, media + "chat/media/run%20notes.log");
  });
}

await check("chat source: Iris and Dr. Kivo come with the working notes the content file gives them", async () => {
  const { clock, api, thread } = await opened();
  assert.deepEqual(thread.working, { note: "reading c1 and settings-context.md (AR-3)", since: "2026-11-02T09:30:00-05:00", updatedAt: "2026-11-02T09:40:00-05:00" });
  const kivo = api.openThread("dr-kivo");
  await clock.advance(0);
  assert.equal((await kivo).working.note, "reading MT-101.2 and the test log AR-1");
});

await check("chat source: sending to a bot that is already working leaves its note and its start as they were", async () => {
  const { clock, api, thread } = await opened();
  const seen = [];
  api.subscribe("iris", (t) => seen.push(t.working));
  const sending = api.send("iris", { text: "One more", clientId: "c-7" });
  await clock.advance(0);
  await sending;
  assert.deepEqual(seen.at(-1), thread.working);
  await clock.advance(700);
  assert.deepEqual(seen.at(-1), thread.working);
});

await check("chat source: when a working bot changes its note after his message, the start stays and the note and its time change", async () => {
  const { clock, api, thread } = await opened();
  const seen = [];
  api.subscribe("iris", (t) => seen.push(t.working));
  const sending = api.send("iris", { text: "One more", clientId: "c-8" });
  await clock.advance(1400);
  await sending;
  assert.deepEqual(seen.at(-1), { note: "reading your message", since: thread.working.since, updatedAt: new Date(clock.now()).toISOString() });
});

await check("chat source: a scripted note replaces the working note in place and a scripted reply ends the working line", async () => {
  const script = [
    { botId: "iris", afterMs: 30_000, note: "writing the reply on c1" },
    { botId: "iris", afterMs: 720_000, reply: "Done." },
  ];
  const { clock, api, thread } = await opened({ script });
  const seen = [];
  api.subscribe("iris", (t) => seen.push(t));
  await clock.advance(30_000);
  assert.equal(seen.at(-1).working.note, "writing the reply on c1");
  assert.equal(seen.at(-1).working.since, thread.working.since);
  assert.equal(seen.at(-1).working.updatedAt, new Date(clock.now()).toISOString());
  await clock.advance(690_000);
  assert.equal(seen.at(-1).working, null);
  assert.equal(seen.at(-1).messages.at(-1).text, "Done.");
  assert.equal(seen.at(-1).seenUpTo, "iris-m3");
});

await check("chat fixture: a fixture that has messages replaces its bot's chat, and one that has none changes nothing", async () => {
  const replaced = await opened({ fixture: u.appChatFixture("CF-4") });
  const alba = replaced.api.openThread("alba");
  await replaced.clock.advance(0);
  const chat = await alba;
  assert.deepEqual(chat.messages.map((m) => m.id), ["fx-alba-m1"]);
  assert.deepEqual([chat.seenUpTo, chat.working], [null, null]);
  assert.equal(replaced.thread.messages.length, 5);
  const unchanged = await opened({ fixture: u.appChatFixture("CF-2") });
  const same = unchanged.api.openThread("alba");
  await unchanged.clock.advance(0);
  assert.equal((await same).messages.length, 10);
});

await check("chat fixture CF-6: messages without text come through with no words and keep their pictures and their file", () => {
  const [pictures, file] = u.fixtureMessages(u.chatFixture(FIXTURES, "CF-6"), "/");
  assert.deepEqual([pictures.text, file.text], ["", ""]);
  assert.deepEqual([pictures.attachments.length, file.attachments[0].name], [2, "search-run.log"]);
});

await check("chat fixture CF-7: the eight pictures read from the media folder, and every one exists", () => {
  const [many] = u.fixtureMessages(u.chatFixture(FIXTURES, "CF-7"), "/");
  const urls = many.attachments.slice(0, 8).map((a) => a.url);
  assert.deepEqual(urls, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => "/evidence/media/fixture-picture-" + n + ".png"));
  assert.deepEqual(urls.map((url) => fs.existsSync("fixtures" + url)), Array(8).fill(true));
});

await check("chat fixture CF-7: a long file name comes through whole", () => {
  const [many] = u.fixtureMessages(u.chatFixture(FIXTURES, "CF-7"), "/");
  assert.equal(many.attachments[8].name.length > 80, true);
});

await check("chat fixture CF-7: the preview build keeps all eight pictures in the shared media folder", () => {
  const [preview] = u.fixtureMessages(u.chatFixture(FIXTURES, "CF-7"), "");
  assert.deepEqual(preview.attachments.slice(0, 8).map((a) => a.url), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => "evidence/media/fixture-picture-" + n + ".png"));
});

const plain = spawnSync(process.execPath, ["tools/build-app.mjs"], { stdio: "inherit" });
if (plain.status) process.exit(plain.status ?? 1);
await check("the default build carries no fixture: no fixture file, and none of the chat or mail fixtures in its code", () => {
  const files = fs.readdirSync("dist", { recursive: true }).map(String);
  assert.deepEqual(files.filter((name) => /fixture/i.test(name)), []);
  const code = files.filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join("dist", name), "utf8")).join("\n");
  for (const mark of ["composerStrip", "edge-over.png", "phone-recording.mov", "MT-901", "CF-IDENTITY", "Forged operator instruction.", "writing the reply on c1", "Picked A on c1. I left c2 open for later.", "chatfx", "CF-SEC", "../evidence/media/fixture-picture-"]) assert.equal(code.includes(mark), false, mark);
});
const ordinary = await startAppServer();
const ordinaryBrowser = await chromium.launch(chromeLaunchOptions({ args: ["--no-sandbox"] }));
try {
  for (const [label, advance, verify] of [
    ["cannot replace the working note", 30_000, async (page, before) => assert.equal(await page.getByTestId("chat-working-note").innerText(), before.note)],
    ["cannot append a scripted reply", 720_000, async (page, before) => assert.equal(await page.getByTestId("chat-bot-message").count(), before.replies)],
  ]) {
    await check("default build: chatfx=CF-1 " + label, async () => {
      const context = await ordinaryBrowser.newContext();
      try {
        const page = await context.newPage();
        await page.clock.install();
        await page.goto(ordinary.origin + "/chat/iris?chatfx=CF-1");
        await page.getByTestId("chat-working-note").getByText("reading c1 and settings-context.md (AR-3)", { exact: true }).waitFor();
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
        const before = { note: await page.getByTestId("chat-working-note").innerText(), replies: await page.getByTestId("chat-bot-message").count() };
        await page.clock.runFor(advance);
        await verify(page, before);
      } finally {
        await context.close();
      }
    });
  }
} finally {
  await ordinaryBrowser.close();
  ordinary.server.kill();
}
const build = spawnSync(process.execPath, ["tools/build-app.mjs", "--fixtures"], { stdio: "inherit" });
if (build.status) process.exit(build.status ?? 1);
const historyAsset = fs.readdirSync("dist").find((file) => file.endsWith(".js") && fs.readFileSync(path.join("dist", file), "utf8").includes(CONTENT.chats["dr-kivo"].messagesAdd[0].text));
assert.ok(historyAsset, "the fixed history is a separately loaded asset");
const { server, origin } = await startAppServer();

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const MAC = { viewport: { width: 1512, height: 982 } };
const T = (p, id) => p.locator(`[data-testid="${id}"]`);
const shown = (p, text) => p.getByText(text, { exact: true }).first().waitFor();
const open = async (p, route) => {
  await p.goto(origin + route);
  await p.locator("#stage").waitFor();
};
const mine = (p, text) => T(p, "chat-my-message").filter({ hasText: text });
const draftQuote = (p) => T(p, "chat-quote");
const bytes = (size) => Buffer.alloc(size, "a");
const PICTURE = { name: "screenshot.png", mimeType: "image/png", buffer: PNG };
const LOG = { name: "build.log", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from("build: passed\n"), bytes(14 * 1024 - 14)]) };
const selectText = (container, phrase) =>
  container.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  }, phrase);
const filesDragged = (p, ...files) =>
  p.evaluateHandle((list) => {
    const transfer = new DataTransfer();
    for (const file of list) transfer.items.add(new File([file.text], file.name, { type: file.type }));
    return transfer;
  }, files);
const sizedFilesDragged = (p, ...files) =>
  p.evaluateHandle((list) => {
    const transfer = new DataTransfer();
    for (const file of list) {
      const bytes = new Uint8Array(file.bytes);
      if (file.type === "text/plain") bytes.fill(97);
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    return transfer;
  }, files);
const boxes = async (p, ids) => Promise.all(ids.map((id) => T(p, id).boundingBox()));

const cases = [];
const it = (name, size, run, allow) => cases.push({ name, size, run, allow });

it("Chat: failed history loading shows the existing empty failed state", PHONE, async (p) => {
  await p.context().route("**/" + historyAsset, (route) => route.abort());
  await open(p, "/chat/iris");
  await shown(p, "Could not load this chat.");
  assert.equal(await T(p, "chat-my-message").count() + await T(p, "chat-bot-message").count(), 0);
}, /Failed to load resource/);

async function chatLinkConfirmation(p) {
  await open(p, "/chat/alba?chatfx=CF-SEC");
  await p.context().route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await p.evaluate(() => {
    window.__botLinkRequests = [];
    window.open = (...args) => { window.__botLinkRequests.push(args); return null; };
  });
  const before = p.url();
  const trigger = T(p, "markdown").getByRole("button", { name: "Trusted service actual.example.com:8443", exact: true });
  await trigger.click();
  const dialog = p.getByRole("dialog", { name: "Open a link from Alba?", exact: true });
  await dialog.waitFor();
  return { trigger, dialog, before };
}

for (const [name, size] of [["phone", PHONE], ["Mac", MAC]]) {
  it("Chat on " + name + ": confirmation shows the origin and port without claiming a destination check", size, async (p) => {
    const { dialog } = await chatLinkConfirmation(p);
    assert.equal(await dialog.getByTestId("bot-link-origin").innerText(), "https://actual.example.com:8443");
    await dialog.getByText("Alba supplied this address. Quarterdeck has not checked where it leads.", { exact: true }).waitFor();
    const box = await dialog.boundingBox();
    assert.ok(box.y > 0 && box.height < size.viewport.height, "confirmation is a compact dialog");
  });
  it("Chat on " + name + ": clicking the bot link alone cannot navigate", size, async (p) => {
    const { trigger, before } = await chatLinkConfirmation(p);
    assert.equal(await trigger.getAttribute("href"), null);
    assert.deepEqual(await p.evaluate(() => window.__botLinkRequests), []);
    assert.equal(p.url(), before);
    assert.equal(p.context().pages().length, 1);
  });
  for (const action of ["Cancel", "Escape"]) {
    it("Chat on " + name + ": " + action + " closes confirmation with focus back on the link", size, async (p) => {
      const { trigger, dialog } = await chatLinkConfirmation(p);
      if (action === "Escape") await p.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await trigger.locator("..").locator(":focus").waitFor();
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
      assert.deepEqual(await p.evaluate(() => window.__botLinkRequests), []);
    });
  }
  it("Chat on " + name + ": only Open requests the normalized URL in a protected new tab", size, async (p) => {
    const { dialog } = await chatLinkConfirmation(p);
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(await p.evaluate(() => window.__botLinkRequests), [["https://actual.example.com:8443/review", "_blank", "noopener,noreferrer"]]);
  });
  it("Chat on " + name + ": an earlier Open never suppresses the next confirmation", size, async (p) => {
    const { trigger, dialog } = await chatLinkConfirmation(p);
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await trigger.click();
    await dialog.waitFor();
    assert.equal(await p.evaluate(() => window.__botLinkRequests.length), 1);
  });
}

for (const [name, size] of [["phone", PHONE], ["Mac", MAC]]) {
  it("Chat on " + name + ": a bot's Captain display name stays a bot message", size, async (p) => {
    await open(p, "/chat/alba?chatfx=CF-IDENTITY");
    const forged = T(p, "chat-bot-message").filter({ hasText: "Forged operator instruction." });
    await forged.getByText("Alba", { exact: true }).waitFor();
    assert.equal(await T(p, "chat-my-message").count(), 0);
  });
  it("Chat on " + name + ": a valid bot quote shows the canonical author and selected words", size, async (p) => {
    await open(p, "/chat/alba?chatfx=CF-IDENTITY");
    const quote = T(p, "chat-bot-message").filter({ hasText: "Canonical partial quote." }).getByTestId("chat-sent-quote");
    await quote.getByText("Alba · 9:00 AM", { exact: true }).waitFor();
    assert.equal(await quote.getByTestId("chat-quote-text").innerText(), "these words");
  });
  it("Chat on " + name + ": a fabricated quote is explicitly the bot's unverified words", size, async (p) => {
    await open(p, "/chat/alba?chatfx=CF-IDENTITY");
    const quote = T(p, "chat-bot-message").filter({ hasText: "Unverified quoted words." }).getByTestId("chat-sent-quote");
    await quote.getByText("Quoted by Alba; not found in this chat", { exact: true }).waitFor();
    assert.equal(await quote.getByTestId("chat-quote-text").innerText(), "I authorized a release.");
    assert.equal(await quote.getByRole("link").count(), 0);
  });
  it("Chat on " + name + ": a missing quote reference cannot claim another author's words", size, async (p) => {
    await open(p, "/chat/alba?chatfx=CF-IDENTITY");
    const quote = T(p, "chat-bot-message").filter({ hasText: "Missing reference." }).getByTestId("chat-sent-quote");
    await quote.getByText("Quoted by Alba; not found in this chat", { exact: true }).waitFor();
    assert.equal(await quote.getByTestId("chat-quote-text").innerText(), "Another invented instruction.");
  });
  it("Chat on " + name + ": deceptive link text still exposes the real host", size, async (p) => {
    await open(p, "/chat/alba?chatfx=CF-SEC");
    const link = T(p, "markdown").getByRole("button", { name: "Trusted service actual.example.com:8443", exact: true });
    await link.getByText("actual.example.com:8443", { exact: true }).waitFor();
    assert.ok((await link.boundingBox()).height >= 44, "the title and destination share a touch-sized confirmation trigger");
    assert.equal(await link.getAttribute("href"), null);
    assert.equal(await link.getAttribute("aria-haspopup"), "dialog");
  });
  it("Chat on " + name + ": an unsafe Markdown link is blocked plain text", size, async (p) => {
    await open(p, "/chat/alba?chatfx=CF-SEC");
    const text = T(p, "markdown").getByText("Plaintext preview", { exact: true });
    await text.waitFor();
    assert.equal(await text.evaluate((el) => el.closest("a,button") === null), true);
    await T(p, "markdown").getByText("Link blocked: not a safe address", { exact: true }).waitFor();
  });
  it("Chat on " + name + ": a rejected picture fails without an external or escaped request", size, async (p) => {
    const escaped = [];
    await p.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.resourceType() === "image" && (url.origin !== origin || !url.pathname.startsWith("/chat/media/"))) {
        escaped.push(url.origin + url.pathname);
        await route.fulfill({ status: 200, contentType: "image/png", body: PICTURE.buffer });
      } else await route.continue();
    });
    await open(p, "/chat/alba?chatfx=CF-SEC");
    await T(p, "chat-picture-failed").getByText("This picture did not load.", { exact: true }).waitFor();
    assert.deepEqual(escaped, []);
    assert.equal(await T(p, "chat-picture-open").count(), 0);
  });
  it("Chat on " + name + ": a rejected file fails without a fetch or download", size, async (p) => {
    await open(p, "/chat/alba?chatfx=CF-SEC");
    await T(p, "chat-file").waitFor();
    const fetches = [];
    p.on("request", (request) => ["fetch", "xhr"].includes(request.resourceType()) && fetches.push(request.url()));
    await T(p, "chat-file").click();
    await p.getByRole("dialog").getByText("Could not open this file.", { exact: true }).waitFor();
    assert.equal(await T(p, "file-download").count(), 0);
    assert.deepEqual(fetches, []);
  });
}

it("Chat: the thread shows his messages, the bot's reply with its references, and Seen", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await mine(p, "Did the build pass last night?").waitFor();
  const reply = T(p, "chat-bot-message").first();
  await reply.getByText("Copy code").waitFor();
  for (const code of ["MT-103", "PG-1", "AR-2"]) await reply.getByText(code, { exact: true }).waitFor();
  await mine(p, "Pick A on c1.").locator('[data-testid="chat-seen"]').waitFor();
});

it("Chat: Iris's second reply links the two Task Cards it names", PHONE, async (p) => {
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").nth(1);
  await reply.getByText("c1 is Pick what a new device shows first", { exact: false }).waitFor();
  const chips = reply.getByTestId("ref-chip");
  assert.deepEqual(await chips.evaluateAll((list) => list.map((a) => a.getAttribute("href"))), ["/queue/c1", "/queue/c2"]);
  assert.deepEqual(await chips.evaluateAll((list) => list.map((a) => a.querySelector("code").textContent)), ["c1", "c2"]);
});

it("Chat: Send stays grey and off until there is text, and spaces do not count", PHONE, async (p) => {
  await open(p, "/chat/iris");
  const send = T(p, "chat-send");
  await send.waitFor();
  assert.equal(await send.isDisabled(), true);
  await T(p, "chat-input").fill("   ");
  assert.equal(await send.isDisabled(), true);
  await T(p, "chat-input").fill("Hello");
  assert.equal(await send.isEnabled(), true);
});

it("Chat: Send shows only the up arrow, its name is Send, and a click on it sends", MAC, async (p) => {
  await open(p, "/chat/iris");
  const send = p.getByRole("button", { name: "Send", exact: true });
  assert.equal(await send.getAttribute("data-testid"), "chat-send");
  assert.equal(await send.evaluate((el) => el.textContent), "");
  assert.equal(await send.locator("svg").count(), 1);
  await T(p, "chat-input").fill("Arrow only");
  await send.click();
  await mine(p, "Arrow only").waitFor();
  assert.equal(await T(p, "chat-input").inputValue(), "");
});

for (const [name, size] of [["phone", PHONE], ["Mac", MAC]])
  it("Chat on the " + name + ": Send is round and at least 44 by 44 px, off and ready", size, async (p) => {
    await open(p, "/chat/iris");
    const shape = () =>
      T(p, "chat-send").evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { width: box.width, height: box.height, corner: parseFloat(getComputedStyle(el).borderTopLeftRadius) };
      });
    const off = await shape();
    await T(p, "chat-input").fill("Hello");
    const ready = await shape();
    for (const [state, box] of [["off", off], ["ready", ready]]) {
      assert.ok(box.width >= 44 && box.height >= 44, state + ": " + box.width + " by " + box.height);
      assert.equal(box.width, box.height, state + ": width and height");
      assert.ok(box.corner >= box.height / 2, state + ": corner " + box.corner);
    }
  });

it("Chat: a sent message says Delivered, then Read with its time, then the bot is working with a note, then its reply replaces the working line; only his latest message carries a word, and nothing says Sent or Seen", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/chat/dale");
  await T(p, "chat-bot-message").first().waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await T(p, "chat-input").fill("Hello");
  await T(p, "chat-send").tap();
  await p.clock.runFor(400);
  await mine(p, "Hello").getByText("10:00 AM").waitFor();
  const thread = T(p, "chat-thread");
  assert.deepEqual([await mine(p, "Hello").getByText("Delivered", { exact: true }).count(), await T(p, "chat-delivered").count(), await thread.getByText("Sent", { exact: true }).count(), await T(p, "chat-seen").count()], [1, 1, 0, 0], "Delivered under Hello only, no Sent, no Read yet");
  assert.equal(await T(p, "chat-working").count(), 0);
  await p.clock.runFor(700);
  await mine(p, "Hello").locator('[data-testid="chat-seen"]').filter({ hasText: "Read 10:00 AM" }).waitFor();
  assert.deepEqual([await T(p, "chat-seen").count(), await T(p, "chat-delivered").count(), await thread.getByText(/^Seen/).count()], [1, 0, 0], "Read under Hello only, no Delivered, no Seen");
  await p.clock.runFor(800);
  assert.equal(await T(p, "chat-working-line").innerText(), "Dale is working · 0 min");
  assert.equal(await T(p, "chat-working-note").innerText(), "reading your message");
  await p.clock.runFor(1700);
  await T(p, "chat-bot-message").last().getByText("Seen. I will check it and come back with the details.").waitFor();
  assert.equal(await T(p, "chat-working").count(), 0);
});

it("Chat: a message he sends keeps its place from Sending to sent, and its day label is there from the first frame", PHONE, async (p) => {
  await open(p, "/chat/dale");
  await T(p, "chat-bot-message").first().waitFor();
  await p.evaluate(() => {
    window.qdFrames = [];
    const step = () => {
      const message = [...document.querySelectorAll('[data-testid="chat-my-message"]')].find((el) => el.textContent.includes("Day label check"));
      if (message && !message.querySelector('[data-testid="chat-seen"]'))
        window.qdFrames.push({ top: Math.round(message.getBoundingClientRect().top), label: Boolean(message.previousElementSibling?.classList.contains("chat-day")), sending: message.textContent.includes("Sending...") });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await T(p, "chat-input").fill("Day label check");
  await T(p, "chat-send").tap();
  await mine(p, "Day label check").and(p.locator("[data-message-id]")).waitFor();
  await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
  const recorded = await p.evaluate(() => window.qdFrames.splice(0));
  assert.deepEqual([...new Set(recorded.map((frame) => frame.sending))], [true, false], "Sending, then sent");
  assert.deepEqual([...new Set(recorded.map((frame) => frame.label))], [true], "a day label right above it in every frame");
  assert.deepEqual([...new Set(recorded.map((frame) => frame.top))], [recorded[0].top], "its top in every frame");
});

it("Chat: when he writes to a bot that is already working, its working line stays as it was", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/chat/iris");
  await T(p, "chat-working").waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await T(p, "chat-input").fill("One more");
  await T(p, "chat-send").tap();
  await p.clock.runFor(400);
  await mine(p, "One more").getByText("10:00 AM").waitFor();
  await p.clock.runFor(700);
  await mine(p, "One more").locator('[data-testid="chat-seen"]').filter({ hasText: "Read 10:00 AM" }).waitFor();
  assert.equal(await T(p, "chat-working-line").innerText(), "Iris is working · 30 min");
  assert.equal(await T(p, "chat-working-note").innerText(), "reading c1 and settings-context.md (AR-3)");
});

it("Chat: when a working bot changes its note after his message, the line changes in place and keeps its minutes", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/chat/iris");
  await T(p, "chat-working").waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await T(p, "chat-input").fill("One more");
  await T(p, "chat-send").tap();
  await p.clock.runFor(400);
  await mine(p, "One more").getByText("10:00 AM").waitFor();
  await p.clock.runFor(1400);
  await T(p, "chat-working-note").getByText("reading your message").waitFor();
  assert.equal(await T(p, "chat-working-line").innerText(), "Iris is working · 30 min");
});

it("Chat: Dale's chat shows his question at 9:55 AM, Read Thu Oct 29 because that read is days before the clock, and Dale's reply at 10:00 AM, as the content times them", PHONE, async (p) => {
  await open(p, "/chat/dale");
  const question = T(p, "chat-my-message").first();
  await question.waitFor();
  assert.match(await question.innerText(), /Anything to report\?[\s\S]*9:55 AM[\s\S]*Read Thu Oct 29/);
  assert.match(await T(p, "chat-bot-message").first().innerText(), /10:00 AM[\s\S]*Nothing to report\./);
});

it("Chat: Dr. Kivo has a fresh working note, so his line shows the minutes and the note and nothing about no word", PHONE, async (p) => {
  await open(p, "/chat/dr-kivo");
  await T(p, "chat-working").waitFor();
  assert.equal(await T(p, "chat-working-line").innerText(), "Dr. Kivo is working · 11 min");
  assert.equal(await T(p, "chat-working-note").innerText(), "reading MT-101.2 and the test log AR-1");
  assert.equal(await T(p, "chat-working-quiet").innerText(), "");
});

it("Chat: the working line sits under the Read mark of the message it works on", PHONE, async (p) => {
  await open(p, "/chat/dr-kivo");
  await T(p, "chat-working").waitFor();
  assert.equal(await T(p, "chat-seen").innerText(), "Read 9:48 AM");
  const seen = await T(p, "chat-seen").boundingBox();
  const line = await T(p, "chat-working-line").boundingBox();
  assert.equal(line.y > seen.y + seen.height, true);
});

it("Chat: a quote of a mail reads the mail, its writer to its first recipient and its text, and links to the mail", PHONE, async (p) => {
  await open(p, "/chat/dr-kivo");
  const quote = mine(p, "Why is three too few for Chats?").locator('[data-testid="chat-sent-quote"]');
  assert.equal(await quote.innerText().then((text) => text.replace(/\s+/g, " ")), "MT-101.2 Dr. Kivo to Alba Five fits the iPhone with the keyboard up. Three is too few for Chats.");
  assert.equal(await quote.getByRole("link").getAttribute("href"), "/mail/MT-101.2");
});

it("Chat: Iris has had no word for 20 minutes, so his line keeps the note and adds No word for 10 minutes. under it", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-working").waitFor();
  assert.equal(await T(p, "chat-working-line").innerText(), "Iris is working · 30 min");
  assert.equal(await T(p, "chat-working-note").innerText(), "reading c1 and settings-context.md (AR-3)");
  await T(p, "chat-working-quiet").getByText("No word for 10 minutes.", { exact: true }).waitFor();
  assert.equal(await T(p, "chat-seen").innerText(), "Read 9:01 AM");
  const note = await T(p, "chat-working-note").boundingBox();
  const quiet = await T(p, "chat-working-quiet").boundingBox();
  assert.equal(quiet.y > note.y + note.height - 1, true);
});

it("Chat: when the bot updates its note the line changes in place, nothing else moves, and its reply ends the working line", MAC, async (p) => {
  await p.clock.install();
  await open(p, "/chat/iris?chatfx=CF-1");
  await T(p, "chat-working-note").getByText("reading c1 and settings-context.md (AR-3)").waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  const ids = ["chat-seen", "chat-working-line", "chat-working-note", "chat-working-quiet", "chat-input", "chat-send"];
  const before = await boxes(p, ids);
  await p.clock.runFor(30_000);
  await T(p, "chat-working-note").getByText("writing the reply on c1").waitFor();
  assert.equal(await T(p, "chat-working-quiet").innerText(), "");
  assert.deepEqual(await boxes(p, ids), before);
  await p.clock.runFor(700_000);
  await T(p, "chat-bot-message").filter({ hasText: "Picked A on c1." }).waitFor();
  assert.equal(await T(p, "chat-working").count(), 0);
  assert.equal(await T(p, "chat-seen").innerText(), "Read 9:01 AM");
});

it("Chat: hovering a message on the Mac offers Reply and Copy, and nothing else", MAC, async (p) => {
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").first();
  await reply.waitFor();
  assert.equal(await T(p, "message-actions").count(), 0);
  await reply.hover();
  const bar = T(p, "message-actions");
  await bar.waitFor();
  assert.deepEqual(await bar.getByRole("button").allInnerTexts(), ["Reply", "Copy"]);
  await T(p, "chat-input").hover();
  await bar.waitFor({ state: "detached" });
});

it("Chat: a message with focus shows Reply and Copy, and the keyboard reaches Reply", MAC, async (p) => {
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").first();
  await reply.waitFor();
  await reply.focus();
  await T(p, "message-actions").waitFor();
  await p.keyboard.press("Tab");
  assert.equal(await p.evaluate(() => document.activeElement?.textContent), "Reply");
  await p.keyboard.press("Enter");
  await draftQuote(p).getByText("Everything passed.", { exact: false }).waitFor();
  assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "chat-input");
});

it("Chat: Reply puts the whole message above what he types, keeps his draft, and sends with his message", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-input").fill("Half a thought");
  const reply = T(p, "chat-bot-message").first();
  await reply.hover();
  await T(p, "message-actions").getByRole("button", { name: "Reply" }).click();
  const chip = draftQuote(p);
  await chip.getByText("Iris · 8:30 AM").waitFor();
  assert.match(await chip.locator('[data-testid="chat-quote-text"]').innerText(), /Yes\. Everything passed\. Two cards need a pick: c1 and c2\./);
  assert.equal(await T(p, "chat-input").inputValue(), "Half a thought");
  await T(p, "chat-send").click();
  const sent = mine(p, "Half a thought");
  await sent.locator('[data-testid="chat-sent-quote"]').getByText("Iris · 8:30 AM").waitFor();
  assert.equal(await T(p, "chat-input").inputValue(), "");
  assert.equal(await draftQuote(p).count(), 0);
});

it("Chat: tapping a sent quote of a message brings that message into view and gives it focus", PHONE, async (p) => {
  await open(p, "/chat/iris");
  const source = p.locator('[data-message-id="iris-m2"]');
  const quote = mine(p, "What are those two cards?").locator('[data-testid="chat-sent-quote"]');
  await quote.waitFor();
  await p.waitForFunction(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
  const seen = () =>
    source.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("[data-message-id]") === el;
    });
  assert.equal(await seen(), false);
  await quote.getByRole("button", { name: /c1 and c2/ }).tap();
  assert.equal(await seen(), true);
  assert.equal(await source.evaluate((el) => el === document.activeElement), true);
});

it("Chat: with text selected, Reply takes only the selection and the x takes the quote away", MAC, async (p) => {
  await open(p, "/chat/iris");
  const text = T(p, "chat-bot-message").last().locator("[data-message-text]");
  await text.waitFor();
  assert.equal(await selectText(text, "Pick what a new device shows first"), true);
  const toolbar = T(p, "selection-quote");
  await toolbar.waitFor();
  await toolbar.getByRole("button", { name: "Reply" }).click();
  await draftQuote(p).locator('[data-testid="chat-quote-text"]').getByText("Pick what a new device shows first", { exact: true }).waitFor();
  await toolbar.waitFor({ state: "detached" });
  await p.getByRole("button", { name: "Remove the quote" }).click();
  await draftQuote(p).waitFor({ state: "detached" });
});

it("Chat: Copy says Copied only after the clipboard took the text, and says it failed when it did not", MAC, async (p) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").first();
  await reply.hover();
  const copy = T(p, "message-actions").getByRole("button", { name: /^Copy$/ });
  await copy.click();
  await T(p, "message-actions").getByRole("button", { name: "Copied" }).waitFor();
  assert.match(await p.evaluate(() => navigator.clipboard.readText()), /^Yes\. Everything passed\./);
  await p.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("refused")) });
    document.execCommand = () => false;
  });
  await T(p, "message-actions").getByRole("button", { name: /^Copy$/ }).waitFor();
  await T(p, "message-actions").getByRole("button", { name: /^Copy$/ }).click();
  await T(p, "message-actions").getByRole("button", { name: "Could not copy" }).waitFor();
  assert.equal(await T(p, "message-actions").getByRole("button", { name: "Copied" }).count(), 0);
});

it("Chat: pressing and holding a message on the phone opens Reply and Copy, and a quick tap does not", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").first();
  await reply.waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await reply.locator("p").first().tap();
  await p.clock.runFor(700);
  assert.equal(await p.locator('[data-pop="message-actions"]').count(), 0);
  await reply.evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
  });
  await p.clock.runFor(600);
  const sheet = p.locator('[data-pop="message-actions"]');
  await sheet.waitFor();
  assert.deepEqual(await sheet.getByRole("button").allInnerTexts(), ["Done", "Reply", "Copy"]);
  await sheet.getByRole("button", { name: "Reply" }).tap();
  await sheet.waitFor({ state: "detached" });
  await draftQuote(p).getByText("Iris · 8:30 AM").waitFor();
});

const holdMessage = async (p, message) => {
  await message.evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
  });
  await p.clock.runFor(600);
  const sheet = p.locator('[data-pop="message-actions"]');
  await sheet.waitFor();
  return sheet;
};

const reachByKeyboard = async (p, label) => {
  await T(p, "chat-input").focus();
  for (let n = 0; n < 12; n++) {
    await p.keyboard.press("Shift+Tab");
    if ((await p.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === label) return;
  }
  throw new Error("the keyboard did not reach " + label);
};

const focusedTestId = (p) => p.evaluate(() => document.activeElement?.getAttribute("data-testid"));

it("Chat: Reply from the phone's hold sheet leaves focus in the message box, even when the message had focus", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").first();
  await reply.waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await reply.locator("p").first().tap();
  assert.equal(await reply.evaluate((el) => el === document.activeElement), true);
  const sheet = await holdMessage(p, reply);
  await sheet.getByRole("button", { name: "Reply" }).tap();
  await sheet.waitFor({ state: "detached" });
  await draftQuote(p).waitFor();
  assert.equal(await focusedTestId(p), "chat-input");
});

it("Chat: closing the file view puts focus back on the file row, even when the click did not focus it", MAC, async (p) => {
  await open(p, "/chat/alba");
  const row = T(p, "chat-file").first();
  await row.waitFor();
  await row.dispatchEvent("click");
  const viewer = p.locator('[data-pop="file-viewer"]');
  await viewer.waitFor();
  await p.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  assert.equal(await row.evaluate((el) => el === document.activeElement), true);
});

it("Chat: removing a file with the keyboard moves focus to the next file's x, and after the last one to the message box", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "pick-files").setInputFiles([LOG, { ...LOG, name: "second.log" }]);
  const tiles = T(p, "draft-file");
  await tiles.nth(1).waitFor();
  await reachByKeyboard(p, "Remove second.log");
  await p.keyboard.press("Enter");
  await tiles.nth(1).waitFor({ state: "detached" });
  assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Remove build.log");
  await p.keyboard.press("Enter");
  await tiles.first().waitFor({ state: "detached" });
  assert.equal(await focusedTestId(p), "chat-input");
});

it("Chat: taking the quote away with the keyboard leaves focus in the message box", MAC, async (p) => {
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").first();
  await reply.waitFor();
  await reply.hover();
  await T(p, "message-actions").getByRole("button", { name: "Reply" }).click();
  await draftQuote(p).waitFor();
  await reachByKeyboard(p, "Remove the quote");
  await p.keyboard.press("Enter");
  await draftQuote(p).waitFor({ state: "detached" });
  assert.equal(await focusedTestId(p), "chat-input");
});

it("Chat: a quote of four short lines shows them all, with no Show all", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-input").fill("q1\nq2\nq3\nq4");
  await T(p, "chat-send").click();
  const message = mine(p, "q4").and(p.locator("[data-message-id]"));
  await message.waitFor();
  await message.hover();
  await T(p, "message-actions").getByRole("button", { name: "Reply" }).click();
  await draftQuote(p).getByTestId("chat-quote-text").waitFor();
  assert.equal(await draftQuote(p).getByTestId("chat-quote-fold").count(), 0);
});

it("Chat: a quote longer than four lines folds, and Show all opens it", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-input").fill("q1\nq2\nq3\nq4\nq5\nq6");
  await T(p, "chat-send").click();
  const message = mine(p, "q6").and(p.locator("[data-message-id]"));
  await message.waitFor();
  await message.hover();
  await T(p, "message-actions").getByRole("button", { name: "Reply" }).click();
  const fold = draftQuote(p).getByTestId("chat-quote-fold");
  assert.equal(await fold.innerText(), "Show all");
  await fold.click();
  assert.equal(await fold.innerText(), "Show less");
});

it("Chat on the Mac: a message he sends stays one row from Sending to sent, so a pointer resting on it gets Reply and Copy with no move, and its text offers Reply by selection only once it is sent", MAC, async (p) => {
  await p.clock.install();
  await open(p, "/chat/iris");
  const reply = T(p, "chat-bot-message").last();
  await reply.locator("[data-message-text]").waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await T(p, "chat-input").fill("Resting pointer");
  await T(p, "chat-send").click();
  const row = mine(p, "Resting pointer");
  await row.getByText("Sending...", { exact: true }).waitFor();
  const held = await row.elementHandle();
  const toolbar = T(p, "selection-quote");
  assert.equal(await selectText(reply.locator("[data-message-text]"), "Pick what a new device shows first"), true);
  await toolbar.waitFor();
  assert.equal(await selectText(row.locator("[data-message-text]"), "Resting pointer"), true);
  await toolbar.waitFor({ state: "detached" });
  await row.hover();
  assert.equal(await T(p, "message-actions").count(), 0, "no Reply or Copy while Sending");
  await p.clock.runFor(400);
  await row.and(p.locator("[data-message-id]")).waitFor();
  await T(p, "message-actions").waitFor();
  assert.deepEqual(await T(p, "message-actions").getByRole("button").allInnerTexts(), ["Reply", "Copy"]);
  assert.deepEqual(await held.evaluate((el) => [el.isConnected, el.hasAttribute("data-message-id"), el.textContent.includes("Delivered")]), [true, true, true], "the row that was Sending is the sent row, and it says Delivered");
  assert.equal(await selectText(row.locator("[data-message-text]"), "Resting pointer"), true);
  await toolbar.getByRole("button", { name: "Reply" }).click();
  await draftQuote(p).locator('[data-testid="chat-quote-text"]').getByText("Resting pointer", { exact: true }).waitFor();
});

it("Chat: a text file longer than the view shows says that only its first part is shown", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "pick-files").setInputFiles({ name: "long.log", mimeType: "text/plain", buffer: bytes(150_000) });
  await T(p, "draft-file").waitFor();
  await T(p, "chat-send").tap();
  const row = T(p, "chat-file").filter({ hasText: "long.log" });
  await row.tap();
  const viewer = p.locator('[data-pop="file-viewer"]');
  await viewer.getByTestId("file-text").waitFor();
  assert.equal(await viewer.getByTestId("file-cut").innerText(), "Showing the first part only. Download for the whole file.");
});

it("Chat: the plus offers Photos, Camera, Files and Secret", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "plus-btn").tap();
  assert.deepEqual(await p.locator('[data-pop="plus"]').getByRole("button").allInnerTexts(), ["Photos", "Camera", "Files", "Secret"]);
});

const SECRET_VALUE = "qd-test-value-0451-kept-out-of-chat";

const openSecretBox = async (p) => {
  await T(p, "plus-btn").click();
  await T(p, "plus-secret").click();
  return T(p, "secret-box");
};

it("Chat: a bot's secret request shows its name, the reason, a masked field, Save securely and Decline", PHONE, async (p) => {
  await open(p, "/chat/alba");
  const card = T(p, "secret-request");
  assert.equal(await card.getByRole("heading").innerText(), "Secret for Alba");
  assert.deepEqual(await card.getByTestId("secret-name").locator("figcaption, blockquote").allInnerTexts(), ["Suggested name from the bot:", "DEPLOY_KEY"]);
  assert.deepEqual(await card.getByTestId("secret-reason").locator("figcaption, blockquote").allInnerTexts(), ["Reason from Alba:", "push the Search branch to the staging host"]);
  assert.equal(await card.getByTestId("secret-value").getAttribute("type"), "password");
  assert.deepEqual(await card.getByRole("button").allInnerTexts(), ["Save securely", "Decline"]);
  assert.equal(await card.getByTestId("secret-note").innerText(), "Saved outside chat. The named bot can use it through Quarterdeck, but cannot reveal the value. It stays until you replace or delete it.");
});

it("Chat on a phone: a finger cannot start a text selection in the thread, and the secret request's fields stay selectable", PHONE, async (p) => {
  await open(p, "/chat/alba");
  const card = T(p, "secret-request");
  await card.waitFor();
  assert.equal(await p.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "a finger is the pointer");
  assert.equal(await T(p, "chat-thread").evaluate((el) => getComputedStyle(el).userSelect), "none", "thread list");
  assert.equal(await card.getByTestId("secret-value").evaluate((el) => getComputedStyle(el).userSelect), "text", "the secret's value field");
  assert.notEqual(await T(p, "chat-input").evaluate((el) => getComputedStyle(el).userSelect), "none", "the message box");
});

it("Chat: Save securely on a bot's request leaves only Secret saved: <name>, for <bot>, <time>, and the value shows nowhere", PHONE, async (p) => {
  await open(p, "/chat/alba");
  const card = T(p, "secret-request");
  await card.getByTestId("secret-value").fill(SECRET_VALUE);
  await card.getByTestId("secret-save").tap();
  await card.waitFor({ state: "detached" });
  assert.match(await T(p, "secret-line").filter({ hasText: "DEPLOY_KEY" }).innerText(), /^Secret saved: DEPLOY_KEY, for Alba, \d{1,2}:\d{2} [AP]M$/);
  assert.equal(await p.evaluate((value) => document.documentElement.outerHTML.includes(value) || JSON.stringify({ ...sessionStorage, ...localStorage }).includes(value), SECRET_VALUE), false);
});

it("Chat: Decline on a bot's request leaves Secret request declined.", PHONE, async (p) => {
  await open(p, "/chat/alba");
  const card = T(p, "secret-request");
  await card.getByTestId("secret-decline").tap();
  await card.waitFor({ state: "detached" });
  await T(p, "secret-line").getByText("Secret request declined.", { exact: true }).waitFor();
});

it("Chat: a save that fails says so in the design's words and keeps the request", PHONE, async (p) => {
  await open(p, "/chat/alba?fail=secret");
  const card = T(p, "secret-request");
  await card.getByTestId("secret-value").fill(SECRET_VALUE);
  await card.getByTestId("secret-save").tap();
  assert.equal(await card.getByTestId("secret-problem").innerText(), "Could not save the secret. It was not saved. Try again.");
  assert.equal(await card.getByTestId("secret-save").isEnabled(), true);
});

it("Chat: while a save is on its way, Save securely and Decline cannot be pressed again", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/chat/alba?delay=300");
  const card = T(p, "secret-request");
  await card.waitFor();
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  await card.getByTestId("secret-value").fill(SECRET_VALUE);
  await card.getByTestId("secret-save").tap();
  await card.locator('[data-testid="secret-save"]:disabled').waitFor();
  assert.equal(await card.getByTestId("secret-decline").isDisabled(), true);
});

const secretPartFailed = async (p, chatRoute) => {
  let failing = true;
  await p.route(new RegExp("/(" + holdersOf(PARTS["the chat example"]).join("|") + ")$"), (route) => (failing ? route.abort() : route.continue()));
  await open(p, chatRoute);
  const chatRetry = p.getByRole("alert").filter({ hasText: "Could not load this chat." }).getByRole("button", { name: "Retry" });
  await chatRetry.waitFor();
  failing = false;
  await chatRetry.click();
  const line = p.getByRole("alert").filter({ hasText: "Could not load this chat's secret requests." });
  await line.waitFor();
  return line;
};

it("Chat: when the secret part failed to load, the chat says so, and its Retry brings the bot's request back", MAC, async (p) => {
  const line = await secretPartFailed(p, "/chat/alba");
  assert.equal(await T(p, "secret-request").count(), 0);
  await line.getByRole("button", { name: "Retry" }).click();
  await T(p, "secret-request").waitFor();
  assert.equal(await line.count(), 0);
}, /Failed to load resource|Failed to fetch dynamically imported module/);

it("Chat: until the secret part has loaded, Save securely in his secret box cannot be pressed", MAC, async (p) => {
  await secretPartFailed(p, "/chat/iris");
  const box = await openSecretBox(p);
  await box.getByTestId("secret-name-field").fill("R2_TOKEN");
  await box.getByTestId("secret-value").fill(SECRET_VALUE);
  assert.equal(await box.getByTestId("secret-save").isDisabled(), true);
}, /Failed to load resource|Failed to fetch dynamically imported module/);

it("Chat: + > Secret opens a box for this chat's bot, and saving it leaves Secret saved with the name he gave", MAC, async (p) => {
  await open(p, "/chat/iris");
  const box = await openSecretBox(p);
  assert.equal(await box.getByRole("heading").innerText(), "Secret for Iris");
  await p.locator('[data-testid="secret-name-field"]:focus').waitFor();
  await box.getByTestId("secret-name-field").fill("R2_TOKEN");
  await box.getByTestId("secret-value").fill(SECRET_VALUE);
  await box.getByTestId("secret-save").click();
  await box.waitFor({ state: "detached" });
  assert.match(await T(p, "secret-line").innerText(), /^Secret saved: R2_TOKEN, for Iris, \d{1,2}:\d{2} [AP]M$/);
  await p.locator('[data-testid="chat-input"]:focus').waitFor();
});

it("Chat: a name in the secret box that looks like a key is refused, and nothing is saved", MAC, async (p) => {
  await open(p, "/chat/iris");
  const box = await openSecretBox(p);
  await box.getByTestId("secret-name-field").fill(["Zx81Kq0pLm7V", "tR2sY9wB4nH6", "cJ3dF5gA"].join(""));
  await box.getByTestId("secret-value").fill(SECRET_VALUE);
  await box.getByTestId("secret-save").click();
  assert.equal(await box.getByTestId("secret-problem").innerText(), "Name this secret. Do not paste the value into the name.");
  assert.equal(await T(p, "secret-line").count(), 0);
});

it("Chat: Esc closes the secret box he opened, and nothing is saved", MAC, async (p) => {
  await open(p, "/chat/iris");
  const box = await openSecretBox(p);
  await box.getByTestId("secret-name-field").fill("R2_TOKEN");
  await box.getByTestId("secret-value").fill(SECRET_VALUE);
  await p.keyboard.press("Escape");
  await box.waitFor({ state: "detached" });
  assert.equal(await T(p, "secret-line").count(), 0);
});

it("Chat: closing the secret box with x and opening it again shows an empty Name and value", MAC, async (p) => {
  await open(p, "/chat/iris");
  const box = await openSecretBox(p);
  await box.getByTestId("secret-name-field").fill("R2_TOKEN");
  await box.getByTestId("secret-value").fill(SECRET_VALUE);
  await box.getByRole("button", { name: "Close the secret box" }).click();
  await box.waitFor({ state: "detached" });
  await openSecretBox(p);
  assert.deepEqual([await box.getByTestId("secret-name-field").inputValue(), await box.getByTestId("secret-value").inputValue()], ["", ""]);
});

it("Chat: leaving the chat with the secret box open and coming back shows it closed, and opening it shows an empty Name and value", MAC, async (p) => {
  await open(p, "/chat/iris");
  const box = await openSecretBox(p);
  await box.getByTestId("secret-name-field").fill("R2_TOKEN");
  await box.getByTestId("secret-value").fill(SECRET_VALUE);
  const nav = p.getByRole("navigation", { name: "Quarterdeck" });
  await nav.getByRole("link", { name: /^Alba/ }).first().click();
  await T(p, "secret-request").waitFor();
  await nav.getByRole("link", { name: /^Iris/ }).first().click();
  await T(p, "chat-input").waitFor();
  assert.equal(await box.count(), 0);
  await openSecretBox(p);
  assert.deepEqual([await box.getByTestId("secret-name-field").inputValue(), await box.getByTestId("secret-value").inputValue()], ["", ""]);
});

it("Chat: a value typed in the secret box never reaches the message box or the saved draft", MAC, async (p) => {
  await open(p, "/chat/iris");
  const box = await openSecretBox(p);
  await box.getByTestId("secret-value").fill(SECRET_VALUE);
  assert.equal(await T(p, "chat-input").inputValue(), "");
  assert.equal(await p.evaluate((value) => JSON.stringify({ ...sessionStorage, ...localStorage }).includes(value), SECRET_VALUE), false);
});

it("Chat: a value typed in a bot's secret request never reaches the message box or the saved draft", MAC, async (p) => {
  await open(p, "/chat/alba");
  await T(p, "secret-request").getByTestId("secret-value").fill(SECRET_VALUE);
  assert.equal(await T(p, "chat-input").inputValue(), "");
  assert.equal(await p.evaluate((value) => JSON.stringify({ ...sessionStorage, ...localStorage }).includes(value), SECRET_VALUE), false);
});

it("Chat: picked files show in a preview strip with an x each, and the x takes one away", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "pick-photos").setInputFiles(PICTURE);
  await T(p, "pick-files").setInputFiles(LOG);
  const tiles = T(p, "draft-file");
  await tiles.nth(1).waitFor();
  assert.match(await tiles.first().locator("img").getAttribute("src"), /^blob:/);
  assert.equal(await tiles.nth(1).innerText().then((text) => text.replace(/\s+/g, " ")), "build.log 14 KB");
  assert.equal(await T(p, "chat-send").isEnabled(), true);
  await p.getByRole("button", { name: "Remove screenshot.png" }).tap();
  await tiles.nth(1).waitFor({ state: "detached" });
  assert.equal(await tiles.first().innerText().then((text) => text.replace(/\s+/g, " ")), "build.log 14 KB");
});

it("Chat: on the Mac a pasted screenshot joins the preview strip", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-input").evaluate((el, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, Array.from(PNG));
  await T(p, "draft-file").getByRole("button", { name: "Remove image.png" }).waitFor();
});

it("Chat: on the Mac a dragged file shows a hint and joins the preview strip when dropped", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-thread").waitFor();
  const dataTransfer = await filesDragged(p, { name: "trace.log", type: "text/plain", text: "trace" });
  await T(p, "chat").dispatchEvent("dragenter", { dataTransfer });
  await T(p, "drop-hint").getByText("Drop to attach to Iris").waitFor();
  await T(p, "chat").dispatchEvent("drop", { dataTransfer });
  await T(p, "drop-hint").waitFor({ state: "detached" });
  await T(p, "draft-file").getByRole("button", { name: "Remove trace.log" }).waitFor();
});

it("Chat: a picture over 10 MB and a file over 50 MB are refused by name before sending, and the log beside them stays", MAC, async (p) => {
  await open(p, "/chat/alba");
  await T(p, "chat-thread").waitFor();
  const strip = fixture("CF-2").composerStrip;
  const typeOf = (item) => (item.kind === "picture" ? "image/png" : item.name.endsWith(".log") ? "text/plain" : "video/quicktime");
  const dataTransfer = await sizedFilesDragged(p, ...strip.map((item) => ({ name: item.name, type: typeOf(item), bytes: item.bytes })));
  await T(p, "chat").dispatchEvent("dragenter", { dataTransfer });
  await T(p, "chat").dispatchEvent("drop", { dataTransfer });
  const notice = p.getByRole("alert");
  await notice.getByText("big-screenshot.png is too large (11 MB). Pictures can be up to 10 MB. phone-recording.mov is too large (60 MB). Files can be up to 50 MB.", { exact: true }).waitFor();
  assert.equal(await T(p, "draft-file").count(), 1);
  await T(p, "draft-file").getByRole("button", { name: "Remove search-run.log" }).waitFor();
  assert.equal(await T(p, "chat-send").isEnabled(), true);
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await notice.waitFor({ state: "detached" });
});

it("Chat: a program is refused by its kind with a plain line, and the PDF picked with it stays", PHONE, async (p) => {
  await open(p, "/chat/alba");
  await T(p, "pick-files").setInputFiles([
    { name: "setup.exe", mimeType: "application/x-msdownload", buffer: bytes(10) },
    { name: "report.pdf", mimeType: "application/pdf", buffer: PDF },
  ]);
  await p.getByRole("alert").getByText("Can't send setup.exe here. .exe files are not allowed.", { exact: true }).waitFor();
  assert.equal(await T(p, "draft-file").count(), 1);
  await T(p, "draft-file").getByRole("button", { name: "Remove report.pdf" }).waitFor();
  assert.equal(await T(p, "chat-send").isEnabled(), true);
});

it("Chat: when files are attached while he is at the bottom, even in two steps that wrap the strip, the last lines stay above the box", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-working-quiet").getByText("No word for 10 minutes.", { exact: true }).waitFor();
  const tiles = T(p, "draft-file");
  for (let round = 0; round < 5; round++) {
    await T(p, "pick-photos").setInputFiles([PICTURE, { ...PICTURE, name: "second.png" }]);
    await T(p, "pick-files").setInputFiles(LOG);
    await tiles.nth(2).waitFor();
    await p.waitForFunction(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
    const top = (await tiles.first().boundingBox()).y;
    assert.equal(await T(p, "chat-working-quiet").evaluate((el, limit) => el.getBoundingClientRect().bottom <= limit, top), true, "round " + round);
    for (let n = 0; n < 3; n++) await tiles.first().getByRole("button", { name: /^Remove / }).click();
  }
});

it("Chat: attaching while reading older messages does not pull him to the bottom", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-working-quiet").getByText("No word for 10 minutes.", { exact: true }).waitFor();
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForFunction(() => window.scrollY === 0);
  await T(p, "pick-files").setInputFiles(LOG);
  await T(p, "draft-file").waitFor();
  assert.equal(await p.evaluate(() => window.scrollY), 0);
});

it("Chat: the chat he has open shows no unread mark in the sidebar, and the chats he has not opened keep theirs", MAC, async (p) => {
  await open(p, "/chat/alba");
  await T(p, "chat-thread").waitFor();
  await p.locator('[data-testid="chat-row"][data-id="shelvorn"] [aria-label="Unread"]').waitFor();
  assert.equal(await p.locator('[data-testid="pinned-bot"][data-id="alba"]').getAttribute("aria-label"), "Alba");
  assert.equal(await p.locator('[data-testid="pinned-bot"][data-id="alba"] [aria-label="Unread"]').count(), 0);
});

for (const [name, size] of [["phone", PHONE], ["Mac", MAC]]) {
  for (const [label, file, reason] of [
    ["an executable renamed .txt", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from([77, 90, 144, 0, 3, 0, 0, 0]) }, "Its name and contents do not match."],
    ["HTML renamed .pdf", { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("<!doctype html><html><script>alert(1)</script></html>") }, "Its name and contents do not match."],
    ["picture bytes renamed .txt", { name: "picture.txt", mimeType: "text/plain", buffer: PICTURE.buffer }, "Its name and contents do not match."],
    ["a picture with a mismatched MIME", { ...PICTURE, mimeType: "image/jpeg" }, "Its file kind does not match its name."],
  ]) {
    it("Chat on " + name + ": " + label + " never enters the draft", size, async (p) => {
      await open(p, "/chat/alba");
      await T(p, "chat-input").fill("Keep this draft");
      await T(p, "pick-files").setInputFiles(file);
      await p.getByRole("alert").getByText("Can't send " + file.name + " here. " + reason, { exact: true }).waitFor();
      assert.equal(await T(p, "draft-file").count(), 0);
      assert.equal(await T(p, "chat-input").inputValue(), "Keep this draft");
    });
  }
  it("Chat on " + name + ": a valid file sends under its normalized displayed name", size, async (p) => {
    await open(p, "/chat/alba");
    await T(p, "pick-files").setInputFiles({ name: "bad\u202e name.txt", mimeType: "text/plain", buffer: Buffer.from("ordinary notes") });
    await T(p, "draft-file").getByText("bad_ name.txt", { exact: true }).waitFor();
    await T(p, "chat-send").click();
    const sent = T(p, "chat-my-message").filter({ hasText: "bad_ name.txt" });
    await sent.getByTestId("chat-file").getByText("bad_ name.txt", { exact: true }).waitFor();
    assert.equal(await T(p, "draft-file").count(), 0);
  });
}

it("Chat: a file with nothing in it is refused by name", PHONE, async (p) => {
  await open(p, "/chat/alba");
  await T(p, "pick-files").setInputFiles({ name: "empty.log", mimeType: "text/plain", buffer: Buffer.alloc(0) });
  await p.getByRole("alert").getByText("empty.log is empty.", { exact: true }).waitFor();
  assert.equal(await T(p, "draft-file").count(), 0);
});

async function sendPictureAndLog(p, onRequest) {
  await open(p, "/chat/iris");
  if (onRequest) p.on("request", onRequest);
  await T(p, "pick-photos").setInputFiles(PICTURE);
  await T(p, "pick-files").setInputFiles(LOG);
  await T(p, "chat-input").fill("The phone layout breaks here");
  await T(p, "chat-send").tap();
  const sent = mine(p, "The phone layout breaks here");
  await sent.locator('[data-testid="chat-seen"]').waitFor();
  return sent;
}

it("Chat: a sent picture shows as a thumbnail and a sent file as a file row, and the strip under the box empties", PHONE, async (p) => {
  const sent = await sendPictureAndLog(p);
  assert.match(await sent.locator('[data-testid="chat-picture"]').getAttribute("src"), /^blob:/);
  assert.equal(await sent.locator('[data-testid="chat-file"]').innerText().then((text) => text.replace(/\s+/g, " ")), "build.log 14 KB");
  assert.equal(await T(p, "draft-strip").count(), 0);
});

it("Chat: a sent file opens read-only in the viewer, and Esc closes it", PHONE, async (p) => {
  const sent = await sendPictureAndLog(p);
  await sent.locator('[data-testid="chat-file"]').tap();
  const viewer = p.locator('[data-pop="file-viewer"]');
  await viewer.getByText("Read-only · 14 KB").waitFor();
  await viewer.getByTestId("file-text").getByText("build: passed", { exact: false }).waitFor();
  await p.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
});

it("Chat: a sent file downloads under its own name", PHONE, async (p) => {
  const sent = await sendPictureAndLog(p);
  await sent.locator('[data-testid="chat-file"]').tap();
  const viewer = p.locator('[data-pop="file-viewer"]');
  const [download] = await Promise.all([p.waitForEvent("download"), viewer.getByTestId("file-download").tap()]);
  assert.equal(download.suggestedFilename(), "build.log");
});

it("Chat: sending, opening and downloading files makes no request outside the page and its own blobs", PHONE, async (p) => {
  const requests = [];
  const sent = await sendPictureAndLog(p, (request) => requests.push(request.method() + " " + request.url()));
  await sent.locator('[data-testid="chat-file"]').tap();
  const viewer = p.locator('[data-pop="file-viewer"]');
  await viewer.getByTestId("file-text").getByText("build: passed", { exact: false }).waitFor();
  await Promise.all([p.waitForEvent("download"), viewer.getByTestId("file-download").tap()]);
  await p.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  const outside = requests.filter((line) => !line.startsWith("GET " + origin + "/") && !line.startsWith("GET blob:"));
  assert.deepEqual(outside, []);
});

it("Chat: Alba's chat shows his two pictures and the run log, her own picture, and every picture loads", MAC, async (p) => {
  await open(p, "/chat/alba");
  const message = mine(p, "The Search sheet pushes Lanes");
  await message.waitFor();
  const source = CONTENT.chats["alba"].messagesAdd[0].attachments;
  assert.equal(await message.locator('[data-testid="chat-picture"]').count(), 2);
  assert.deepEqual(await message.locator('[data-testid="chat-picture"]').evaluateAll((list) => list.map((img) => img.alt)), source.filter((a) => a.kind === "picture").map((a) => a.alt));
  assert.equal(await message.locator('[data-testid="chat-file"]').innerText().then((text) => text.replace(/\s+/g, " ")), "search-run.log 0.4 KB");
  await T(p, "chat-bot-message").filter({ hasText: "Yes, a long group pushes" }).locator('[data-testid="chat-picture"]').waitFor();
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="chat-picture"]')].length === 3 && [...document.querySelectorAll('[data-testid="chat-picture"]')].every((img) => img.complete && img.naturalWidth === 880 && img.naturalHeight === 1912));
  assert.equal(await T(p, "chat-picture-failed").count(), 0);
});

async function openFirstPicture(p) {
  await open(p, "/chat/alba");
  const tiles = T(p, "chat-picture-open");
  await tiles.nth(2).waitFor();
  const first = tiles.first();
  await first.click();
  const viewer = p.locator('[data-pop="viewer"]');
  await viewer.waitFor();
  return { first, viewer };
}

it("Chat: a picture opens in the full-screen viewer with its caption", MAC, async (p) => {
  await openFirstPicture(p);
  const alt = CONTENT.chats["alba"].messagesAdd[0].attachments.find((a) => a.kind === "picture").alt;
  assert.equal(await T(p, "viewer-count").innerText(), "1 of 3");
  assert.equal((await T(p, "viewer-caption").innerText()).startsWith(alt + " · You "), true);
});

it("Chat: the arrow keys step through the chat's pictures in the viewer", MAC, async (p) => {
  await openFirstPicture(p);
  await p.keyboard.press("ArrowRight");
  await p.keyboard.press("ArrowRight");
  await T(p, "viewer-count").filter({ hasText: "3 of 3" }).waitFor();
  assert.match(await T(p, "viewer-caption").innerText(), / · Alba /);
});

it("Chat: Esc closes the viewer and puts focus back on the picture", MAC, async (p) => {
  const { first, viewer } = await openFirstPicture(p);
  await p.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  await p.waitForFunction((tile) => document.activeElement === tile, await first.elementHandle());
});

it("Chat: a picture in his message that did not send opens in the viewer, and X closes it", PHONE, async (p) => {
  await open(p, "/chat/iris?fail=chat");
  await T(p, "pick-photos").setInputFiles(PICTURE);
  await T(p, "draft-file").waitFor();
  await T(p, "chat-send").tap();
  const unsent = T(p, "chat-my-message").filter({ has: T(p, "chat-retry") });
  const picture = unsent.locator('[data-testid="chat-picture"]');
  await picture.waitFor();
  await unsent.locator('[data-testid="chat-picture-open"]').tap();
  const viewer = p.locator('[data-pop="viewer"]');
  assert.equal(await viewer.locator('[data-testid="viewer-image"]').getAttribute("src"), await picture.getAttribute("src"));
  await viewer.getByRole("button", { name: "Close" }).tap();
  await viewer.waitFor({ state: "detached" });
});

it("Chat: each change Alba made to the card shows one line with its version, and the line links to the card", MAC, async (p) => {
  await open(p, "/chat/alba");
  const lines = T(p, "chat-card-update");
  await lines.nth(2).waitFor();
  assert.deepEqual((await lines.allInnerTexts()).map((text) => text.split("\n")[0]), CONTENT.chats["alba"].messagesAdd.filter((m) => m.cardUpdate).map((m) => m.cardUpdate.line));
  assert.deepEqual(await lines.evaluateAll((list) => list.map((a) => a.getAttribute("href"))), ["/queue/alba-1", "/queue/alba-1", "/queue/alba-1"]);
});

it("Chat: each question he asked about the card quotes it as it was when he sent it", MAC, async (p) => {
  await open(p, "/chat/alba");
  const questions = ["Put the picture first.", "Can the phone show 4?", "Say what happens if I don't answer."];
  const texts = [];
  for (const question of questions) {
    const quote = mine(p, question).locator('[data-testid="chat-sent-quote"]');
    await quote.waitFor();
    assert.equal(await quote.getByRole("link").getAttribute("href"), "/queue/alba-1");
    texts.push(await quote.innerText().then((text) => text.replace(/\s+/g, " ")));
  }
  for (const text of texts) assert.match(text, /^task card.*how many results should each search group show\?/i);
  assert.equal(texts[0].includes("Now:"), false);
  assert.equal(texts[1].includes("Now: "), true);
  assert.equal(texts[2].includes("Now: "), true);
  assert.notEqual(texts[1], texts[2]);
});

it("Chat: a picture that does not load keeps its place, says so by name, and Try again asks once more", PHONE, async (p) => {
  await open(p, "/chat/alba?chatfx=CF-4");
  const tile = T(p, "chat-picture-failed");
  await tile.waitFor();
  assert.equal(await tile.innerText().then((text) => text.replace(/\s+/g, " ")), "missing-picture.png This picture did not load. Try again");
  await mine(p, "This one did not come through.").waitFor();
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await Promise.all([p.waitForRequest((request) => request.url().endsWith("/media/missing-picture.png")), tile.getByRole("button", { name: "Try again" }).tap()]);
  await T(p, "chat-picture-failed").waitFor();
}, /Failed to load resource/);

it("Chat: a file kept with a project on his word shows its Artifact reference as a chip that links to it", MAC, async (p) => {
  await open(p, "/chat/alba?chatfx=CF-5");
  const chip = T(p, "chat-bot-message").filter({ hasText: "Saved as AR-5 in quarterdeck." }).getByTestId("ref-chip");
  await chip.waitFor();
  assert.equal(await chip.getAttribute("href"), "/projects/quarterdeck/artifacts/AR-5");
  assert.match(await chip.innerText().then((text) => text.replace(/\s+/g, " ")), /search-run\.log/);
});

it("Chat: the file he sent stays in the chat when it is kept with a project", MAC, async (p) => {
  await open(p, "/chat/alba?chatfx=CF-5");
  await mine(p, "Save the run log").locator('[data-testid="chat-file"]').waitFor();
});

it("Chat: the Artifacts list gains the file kept with a project", MAC, async (p) => {
  await open(p, "/projects/quarterdeck");
  await T(p, "artifact-row").first().waitFor();
  const before = await T(p, "artifact-row").count();
  await open(p, "/projects/quarterdeck?chatfx=CF-5");
  await T(p, "artifact-row").first().waitFor();
  assert.equal(await T(p, "artifact-row").count(), before + 1);
});

it("Chat: a message of pictures only and one with a file only draw no empty bubble and no empty line", PHONE, async (p) => {
  await open(p, "/chat/dale?chatfx=CF-6");
  const messages = T(p, "chat-my-message");
  await messages.nth(1).waitFor();
  assert.equal(await messages.count(), 2);
  for (const n of [0, 1]) assert.equal(await messages.nth(n).locator("[data-message-text]").count(), 0);
  assert.equal(await messages.nth(0).locator('[data-testid="chat-picture"]').count(), 2);
  assert.equal(await messages.nth(1).locator('[data-testid="chat-file"]').count(), 1);
});

for (const [label, size] of [["phone", PHONE], ["Mac", MAC]])
  it("Chat: eight pictures and a file with a very long name stay inside the chat column on the " + label, size, async (p) => {
    await open(p, "/chat/dale?chatfx=CF-7");
    const message = T(p, "chat-my-message").first();
    await message.waitFor();
    assert.equal(await message.locator('[data-testid="chat-picture"]').count(), 8);
    await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="chat-picture"]')].every((img) => img.complete && img.naturalWidth > 0));
    const column = await T(p, "chat-thread").boundingBox();
    const edges = await p.evaluate(() => [...document.querySelectorAll('[data-testid="chat-picture"], [data-testid="chat-file"]')].map((el) => [el.getBoundingClientRect().left, el.getBoundingClientRect().right]));
    assert.equal(edges.length, 9);
    for (const [left, right] of edges) assert.equal(left >= column.x - 0.5 && right <= column.x + column.width + 0.5, true);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.equal(await message.locator('[data-testid="chat-file"]').innerText().then((text) => text.replace(/\s+/g, " ")), "search-run-with-a-very-long-file-name-that-has-to-stay-inside-its-row-2026-11-01-18-21-09.log 0.4 KB");
  });

it("Chat: Enter sends, Shift+Enter starts a new line", MAC, async (p) => {
  await open(p, "/chat/iris");
  const input = T(p, "chat-input");
  await input.click();
  await p.keyboard.type("First");
  await p.keyboard.press("Shift+Enter");
  await p.keyboard.type("Second");
  assert.equal(await input.inputValue(), "First\nSecond");
  await p.keyboard.press("Enter");
  await mine(p, "Second").waitFor();
  assert.equal(await input.inputValue(), "");
});

it("Chat: a failed send says Not Delivered with Try Again and nothing more, keeps the text, and Try Again sends it once", PHONE, async (p) => {
  await open(p, "/chat/iris?fail=chat");
  await T(p, "chat-input").fill("Hello");
  await T(p, "chat-send").tap();
  const failed = mine(p, "Hello").getByRole("alert");
  await failed.getByText("Not Delivered", { exact: true }).waitFor();
  assert.deepEqual([(await failed.innerText()).replace(/\s+/g, " ").trim(), await failed.getByRole("button", { name: "Try Again", exact: true }).count()], ["Not Delivered Try Again", 1]);
  await T(p, "chat-retry").tap();
  await mine(p, "Hello").locator('[data-testid="chat-seen"]').waitFor();
  assert.equal(await mine(p, "Hello").count(), 1);
});

it("Chat: a failed send still says Not Delivered after he leaves the chat and comes back, and Try Again sends it", MAC, async (p) => {
  await open(p, "/chat/iris?fail=chat");
  await T(p, "chat-input").fill("Hello");
  await T(p, "chat-send").click();
  await mine(p, "Hello").getByRole("alert").getByText("Not Delivered", { exact: true }).waitFor();
  const nav = p.getByRole("navigation", { name: "Quarterdeck" });
  await nav.getByRole("link", { name: /^Alba/ }).first().click();
  await T(p, "chat-bot-message").first().waitFor();
  await nav.getByRole("link", { name: /^Iris/ }).first().click();
  await mine(p, "Hello").getByRole("alert").getByText("Not Delivered", { exact: true }).waitFor();
  await mine(p, "Hello").getByRole("button", { name: "Try Again", exact: true }).click();
  await mine(p, "Hello").locator('[data-testid="chat-seen"]').waitFor();
  assert.equal(await mine(p, "Hello").count(), 1);
});

it("Chat: the cite menu lists every reference with its title and puts the chosen one at the cursor", PHONE, async (p) => {
  await open(p, "/chat/iris");
  const input = T(p, "chat-input");
  await input.fill("Look at now");
  await input.evaluate((el) => el.setSelectionRange(7, 7));
  await T(p, "cite-btn").tap();
  const menu = p.locator('[data-pop="cite"]');
  await menu.getByRole("button", { name: /^MT-103 What goes in Account at launch\?/ }).waitFor();
  await menu.getByRole("button", { name: /^MT-101\.1 Alba to Dr\. Kivo Mail$/ }).waitFor();
  await menu.getByRole("button", { name: /^MT-101\.2 Dr\. Kivo to Alba Mail$/ }).tap();
  assert.equal(await input.inputValue(), "Look at MT-101.2 now");
  assert.equal(await input.evaluate((el) => [document.activeElement === el, el.selectionStart]).then(String), "true,16");
});

it("Chat: Esc closes the cite menu and focus returns to @", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "cite-btn").click();
  await p.locator('[data-pop="cite"]').waitFor();
  await p.keyboard.press("Escape");
  await p.locator('[data-pop="cite"]').waitFor({ state: "detached" });
  assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "cite-btn");
});

it("Chat: a reference in a sent message links to it", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-input").fill("See MT-103 please");
  await T(p, "chat-send").tap();
  await p.getByText("Seen. I will check it and come back with the details.").first().waitFor({ timeout: 15000 });
  const link = mine(p, "See").getByRole("link", { name: "MT-103" });
  await link.tap();
  await T(p, "mail-thread").waitFor();
  assert.equal(new URL(p.url()).pathname, "/mail/MT-103");
});

it("Chat: Talk to keeps his unsent draft and adds the quote above it", MAC, async (p) => {
  await open(p, "/chat/alba");
  await T(p, "chat-input").fill("Half a thought");
  await p.getByRole("link", { name: /^Queue \d+$/ }).click();
  await T(p, "card-row").getByRole("link", { name: "How many results should each Search group show?" }).click();
  await T(p, "card-pane").locator('[data-testid="talk-to"]').click();
  await draftQuote(p).getByText("How many results should each Search group show?").waitFor();
  assert.equal(await T(p, "chat-input").inputValue(), "Half a thought");
});

it("Chat: the quote sends with his message and keeps its link to the card", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "talk-to").tap();
  await T(p, "chat-input").fill("Why five?");
  await T(p, "chat-send").tap();
  const quote = mine(p, "Why five?").locator('[data-testid="chat-sent-quote"]');
  await quote.getByText("How many results should each Search group show?").waitFor();
  assert.equal(await quote.getByRole("link").getAttribute("href"), "/queue/alba-1");
  assert.equal(await T(p, "chat-input").inputValue(), "");
});

it("Chat: the x takes the quote away and sends nothing", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "talk-to").tap();
  await T(p, "chat-bot-message").first().waitFor();
  const before = await T(p, "chat-my-message").count();
  await p.getByRole("button", { name: "Remove the quoted Task Card" }).tap();
  await draftQuote(p).waitFor({ state: "detached" });
  assert.equal(await T(p, "chat-my-message").count(), before);
});

it("Chat: a bot that does not exist says there is no chat with it", PHONE, async (p) => {
  await open(p, "/chat/nobody");
  await shown(p, "No chat with this bot.");
});

const FAKE_PASTE = "gh" + "p_" + Array.from({ length: 36 }, (_, at) => String.fromCharCode(65 + at % 26)).join("");
const FAKE_RANDOM = Array.from({ length: 36 }, (_, at) => at % 3 === 0 ? String.fromCharCode(97 + at * 7 % 26) : at % 3 === 1 ? String.fromCharCode(65 + at * 11 % 26) : String(at % 10)).join("");
const BLOCKED_PASTES = [FAKE_PASTE, "TOKEN=" + FAKE_RANDOM, FAKE_RANDOM + "|suffix"];

async function pasteText(p, text) {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await p.evaluate((value) => navigator.clipboard.writeText(value), text);
  await T(p, "chat-input").focus();
  await p.keyboard.press("Control+V");
}

it("Chat: a secret-looking real paste is blocked before the draft, output, console, storage or network", MAC, async (p) => {
  let consoleLeak = false;
  let networkLeak = false;
  p.on("console", (message) => { if (BLOCKED_PASTES.some((text) => message.text().includes(text))) consoleLeak = true; });
  p.on("request", (request) => { if (BLOCKED_PASTES.some((text) => (request.url() + (request.postData() ?? "")).includes(text))) networkLeak = true; });
  await p.addInitScript((canaries) => {
    window.__blockedPasteProbe = { input: false, storage: false };
    window.addEventListener("input", (event) => {
      if (event.target instanceof HTMLTextAreaElement && canaries.some((text) => event.target.value.includes(text))) window.__blockedPasteProbe.input = true;
    }, true);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (canaries.some((text) => (key + value).includes(text))) window.__blockedPasteProbe.storage = true;
      return original.call(this, key, value);
    };
  }, BLOCKED_PASTES);
  await open(p, "/chat/iris");
  const input = T(p, "chat-input");
  await input.fill("Existing harmless draft");
  await T(p, "chat-my-message").first().waitFor();
  const before = await T(p, "chat-my-message").count();
  for (const text of BLOCKED_PASTES) {
    await pasteText(p, text);
    await p.getByText("This looks like a secret. It was not added to your message.", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "Existing harmless draft");
    assert.equal(await T(p, "chat-my-message").count(), before);
    assert.equal(await p.locator("body").innerText().then((body) => body.includes(text)), false);
    assert.deepEqual(await p.evaluate(() => window.__blockedPasteProbe), { input: false, storage: false });
    assert.equal(consoleLeak || networkLeak, false);
  }
  const nav = p.getByRole("navigation", { name: "Quarterdeck" });
  await nav.getByRole("link", { name: /^Alba/ }).first().click();
  await T(p, "chat-bot-message").first().waitFor();
  await nav.getByRole("link", { name: /^Iris/ }).first().click();
  await input.waitFor();
  assert.equal(await input.inputValue(), "Existing harmless draft");
  assert.equal(await p.getByText("This looks like a secret. It was not added to your message.", { exact: true }).count(), 0);
});

it("Chat: Use a secret box opens the masked box for this chat's bot, with the paste removed and nothing sent", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-my-message").first().waitFor();
  const before = await T(p, "chat-my-message").count();
  await pasteText(p, FAKE_PASTE);
  await p.getByRole("button", { name: "Use a secret box", exact: true }).click();
  assert.equal(await T(p, "secret-box").getByRole("heading").innerText(), "Secret for Iris");
  assert.equal(await T(p, "secret-box").getByTestId("secret-value").inputValue(), "");
  assert.equal(await T(p, "chat-input").inputValue(), "");
  assert.equal(await T(p, "chat-my-message").count(), before);
  assert.equal(await p.locator("body").innerText().then((text) => text.includes(FAKE_PASTE)), false);
});

it("Chat: Send anyway requires a fresh paste and ordinary Send, and permits only that one paste", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-my-message").first().waitFor();
  const before = await T(p, "chat-my-message").count();
  await pasteText(p, FAKE_PASTE);
  await p.getByRole("button", { name: "Send anyway", exact: true }).click();
  await p.getByText("Paste it again to add it as a normal message. It will be kept in chat and the bot may see it.", { exact: true }).waitFor();
  assert.equal(await T(p, "chat-input").inputValue(), "");
  assert.equal(await T(p, "chat-my-message").count(), before);
  await p.keyboard.press("Enter");
  assert.equal(await T(p, "chat-my-message").count(), before);
  await pasteText(p, FAKE_PASTE);
  assert.equal(await T(p, "chat-input").inputValue(), FAKE_PASTE);
  assert.equal(await T(p, "chat-my-message").count(), before);
  await T(p, "chat-send").click();
  await mine(p, FAKE_PASTE).locator('[data-testid="chat-seen"]').waitFor();
  assert.equal(await mine(p, FAKE_PASTE).count(), 1);
  await pasteText(p, FAKE_PASTE);
  await T(p, "secret-paste-warning").waitFor();
  assert.equal(await T(p, "chat-input").inputValue(), "");
  assert.equal(await mine(p, FAKE_PASTE).count(), 1);
});

for (const reset of ["Escape", "Dismiss", "chat change", "navigation", "harmless paste", "file paste"]) {
  it("Chat: the one-paste bypass clears on " + reset, MAC, async (p) => {
    await open(p, "/chat/iris");
    await pasteText(p, FAKE_PASTE);
    await p.getByRole("button", { name: "Send anyway", exact: true }).click();
    if (reset === "Escape") await p.keyboard.press("Escape");
    else if (reset === "Dismiss") await T(p, "secret-paste-notice").getByRole("button", { name: "Dismiss" }).click();
    else if (reset === "harmless paste") {
      await pasteText(p, "Harmless text");
      assert.equal(await T(p, "chat-input").inputValue(), "Harmless text");
      await T(p, "chat-input").fill("");
    } else if (reset === "file paste") {
      await T(p, "chat-input").evaluate((el, bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], "preview.png", { type: "image/png" }));
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      }, Array.from(PICTURE.buffer));
      await T(p, "draft-file").waitFor();
    } else {
      const nav = p.getByRole("navigation", { name: "Quarterdeck" });
      await nav.getByRole("link", { name: reset === "chat change" ? /^Alba/ : /^Queue/ }).first().click();
      await nav.getByRole("link", { name: /^Iris/ }).first().click();
      await T(p, "chat-input").waitFor();
    }
    await pasteText(p, FAKE_PASTE);
    await T(p, "secret-paste-warning").waitFor();
    assert.equal(await T(p, "chat-input").inputValue(), "");
    await T(p, "secret-paste-warning").getByRole("button", { name: "Cancel" }).click();
    assert.equal(await T(p, "secret-paste-warning").count(), 0);
    await pasteText(p, FAKE_PASTE);
    await T(p, "secret-paste-warning").waitFor();
    assert.equal(await T(p, "chat-input").inputValue(), "");
  });
}

const PASTE_SIZES = [
  ["mac-1512", MAC],
  ["mac-1280", { viewport: { width: 1280, height: 800 } }],
  ["mac-1024", { viewport: { width: 1024, height: 700 } }],
  ["mac-756", { viewport: { width: 756, height: 900 } }],
  ["iphone-440", { viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true }],
  ["phone-390", PHONE],
  ["ipad-744x1133", { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }],
  ["ipad-1133x744", { viewport: { width: 1133, height: 744 }, hasTouch: true, isMobile: true }],
];

for (const [label, size] of PASTE_SIZES) {
  it("Chat: the paste warning and fixed notices fit without clipping at " + label, size, async (p) => {
    const broken = await p.context().newPage();
    try {
      await open(broken, "/chat/iris");
      await pasteText(broken, FAKE_PASTE);
      await T(broken, "secret-paste-warning").waitFor();
      await T(broken, "secret-paste-warning").evaluate((el) => { el.style.width = "4000px"; });
      assert.equal((await broken.evaluate(measure)).issues.length > 0, true, "the real-spill dummy must fail");
    } finally {
      await broken.close();
    }
    await open(p, "/chat/iris");
    await T(p, "chat-my-message").first().waitFor();
    const before = await T(p, "chat-my-message").count();
    await pasteText(p, FAKE_PASTE);
    await T(p, "secret-paste-warning").waitFor();
    const shots = process.env.QD_SECRET_PASTE_SHOTS;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    for (const state of ["warning", "again", "box"]) {
      assert.deepEqual((await p.evaluate(measure)).issues, [], state);
      assert.equal(await T(p, "chat-input").inputValue(), "");
      assert.equal(await T(p, "chat-my-message").count(), before, state + ": nothing was sent");
      if (shots) await p.screenshot({ path: path.join(shots, state + "-" + label + ".png") });
      if (state === "warning") {
        await p.getByRole("button", { name: "Send anyway", exact: true }).click();
        await T(p, "secret-paste-notice").waitFor();
      } else if (state === "again") {
        await T(p, "secret-paste-notice").getByRole("button", { name: "Dismiss" }).click();
        await pasteText(p, FAKE_PASTE);
        await p.getByRole("button", { name: "Use a secret box", exact: true }).click();
        await T(p, "secret-box").waitFor();
      }
    }
  });
}

const distScripts = fs.readdirSync("dist", { recursive: true }).map(String).filter((name) => name.endsWith(".js"));
const holdersOf = (mark) => distScripts.filter((name) => fs.readFileSync(path.join("dist", name), "utf8").includes(mark));
const PARTS = { "the secret stand-in": "belongs to another secret operation", "the chat example": "reading your message", "the Mail code": " (removed)" };
const scriptsRequested = (p) => {
  const names = [];
  p.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(".js")) names.push(path.basename(pathname));
  });
  return names;
};
const requestedHolders = (names, mark) => holdersOf(mark).filter((file) => names.includes(file));

for (const [what, mark] of Object.entries(PARTS)) {
  it("The phone first screen requests none of " + what, PHONE, async (p) => {
    const names = scriptsRequested(p);
    await open(p, "/queue");
    await T(p, "card-row").first().waitFor();
    await p.waitForLoadState("load");
    await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(names.length > 0, true);
    assert.equal(holdersOf(mark).length > 0, true, what + " is in the build");
    assert.deepEqual(requestedHolders(names, mark), []);
  });
}

it("On Mac the sidebar asks for the chat example's code and lists the chats", MAC, async (p) => {
  const names = scriptsRequested(p);
  await open(p, "/queue");
  await p.locator('[data-testid="pinned-bot"][data-id="iris"]').waitFor();
  assert.deepEqual(requestedHolders(names, PARTS["the chat example"]), holdersOf(PARTS["the chat example"]));
});

it("Opening a chat on the phone asks for the chat example's code, and a message sent there is seen", PHONE, async (p) => {
  const names = scriptsRequested(p);
  await open(p, "/chat/iris");
  await T(p, "chat-input").fill("Hello");
  await T(p, "chat-send").tap();
  await mine(p, "Hello").locator('[data-testid="chat-seen"]').waitFor();
  assert.deepEqual(requestedHolders(names, PARTS["the chat example"]), holdersOf(PARTS["the chat example"]));
});

it("Opening Mail on the phone asks for the Mail code and lists the threads", PHONE, async (p) => {
  const names = scriptsRequested(p);
  await open(p, "/mail");
  await T(p, "mail-row").first().waitFor();
  assert.deepEqual(requestedHolders(names, PARTS["the Mail code"]), holdersOf(PARTS["the Mail code"]));
});

it("On Mac a failed load of the chat example's code shows the chats' failed line, and Retry loads it", MAC, async (p) => {
  let failNext = true;
  await p.route(new RegExp("/(" + holdersOf(PARTS["the chat example"]).join("|") + ")$"), (route) => {
    if (!failNext) return route.continue();
    failNext = false;
    return route.abort();
  });
  await open(p, "/queue");
  const line = p.getByRole("alert").filter({ hasText: "Could not load the chats." });
  await line.waitFor();
  await line.getByRole("button", { name: "Retry" }).click();
  await p.locator('[data-testid="pinned-bot"][data-id="iris"]').waitFor();
  assert.equal(await line.count(), 0);
}, /Failed to load resource|Failed to fetch dynamically imported module/);

it("On Mac the sidebar row of a chat whose last message is a file with no text reads You: and the file's name", MAC, async (p) => {
  await open(p, "/chat/dale?chatfx=CF-6");
  await p.locator('[data-testid="chat-row"][data-id="dale"]').getByText("You: search-run.log", { exact: true }).waitFor();
});

it("On Mac the sidebar row shows You: before the message he just sent", MAC, async (p) => {
  await open(p, "/chat/dale");
  await T(p, "chat-input").fill("Hello");
  await T(p, "chat-send").click();
  await p.locator('[data-testid="chat-row"][data-id="dale"]').getByText("You: Hello", { exact: true }).waitFor();
});

it("On Mac Dr. Kivo's sidebar row reads You: and the question he asked, as the content file lists it", MAC, async (p) => {
  await open(p, "/queue");
  await p.locator('[data-testid="chat-row"][data-id="dr-kivo"]').getByText("You: Why is three too few for Chats?", { exact: true }).waitFor();
});

it("On Mac a chat code load that failed for the sidebar and then loaded for the open chat lets the sidebar list the chats", MAC, async (p) => {
  let failNext = true;
  await p.route(new RegExp("/(" + holdersOf(PARTS["the chat example"]).join("|") + ")$"), (route) => {
    if (!failNext) return route.continue();
    failNext = false;
    return route.abort();
  });
  await open(p, "/chat/iris");
  await T(p, "chat-input").waitFor();
  await p.locator('[data-testid="pinned-bot"][data-id="iris"]').waitFor();
  assert.equal(failNext, false);
  assert.equal(await p.getByRole("alert").filter({ hasText: "Could not load the chats." }).count(), 0);
}, /Failed to load resource|Failed to fetch dynamically imported module/);

const ownMotion = (locator) =>
  locator.evaluate((element) => [...new Set(element.getAnimations().map((one) => one.effect.getComputedTiming().duration + " " + [...new Set(one.effect.getKeyframes().flatMap((frame) => Object.keys(frame).filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key))))].sort().join("+")))].sort());
const movingRows = (rows) => rows.evaluateAll((items) => items.map((item) => item.getAnimations().length > 0));

it("Chat motion: his sent message rises from the box and fades in at the standard speed, its Not Delivered line only fades at the quick speed, and the messages already there never move", PHONE, (p) =>
  motionPair(p, PHONE, async (page, m) => {
    await open(page, "/chat/iris?fail=chat");
    await T(page, "chat-bot-message").first().waitFor();
    await settle(page);
    const before = await T(page, "chat-my-message").count();
    await T(page, "chat-input").fill("Hello");
    const resume = await m.hold();
    await T(page, "chat-send").tap();
    await mine(page, "Hello").getByRole("alert").getByText("Not Delivered", { exact: true }).waitFor();
    await m.during("his message", '[data-testid="chat-my-message"]', async () => {
      assert.deepEqual(await movingRows(T(page, "chat-my-message")), [...Array(before).fill(false), true], "only his new message moves");
      assert.deepEqual(await ownMotion(T(page, "chat-my-message").last()), [STANDARD + " opacity", STANDARD + " translate"], "it rises and fades in at the standard speed");
      assert.deepEqual((await animationsOf(mine(page, "Hello").getByRole("alert"))).map((one) => one.duration + " " + one.properties.join("+")), [QUICK + " opacity"], "Not Delivered only fades, at the quick speed");
      assert.deepEqual(await animationsOf(T(page, "chat-bot-message")), [], "no bot message already there moves");
    });
    await resume();
    await settle(page);
  }),
);

it("Chat motion: a bot reply arrives with the arrive fade at the standard speed, and with Reduce Motion it appears at once", PHONE, (p) =>
  motionPair(p, PHONE, async (page, m) => {
    await page.clock.install({ time: new Date("2026-11-02T15:00:00Z") });
    await open(page, "/chat/dale");
    await T(page, "chat-bot-message").first().waitFor();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const before = await T(page, "chat-bot-message").count();
    await T(page, "chat-input").fill("Hello");
    const resume = await m.hold();
    await T(page, "chat-send").tap();
    await page.clock.runFor(3600);
    await T(page, "chat-bot-message").nth(before).getByText("Seen. I will check it and come back with the details.").waitFor();
    await page.clock.resume();
    await m.during("the bot reply arrives", '[data-testid="chat-bot-message"]', async () => {
      assert.deepEqual(await movingRows(T(page, "chat-bot-message")), [...Array(before).fill(false), true], "only the new reply moves");
      assert.deepEqual(await ownMotion(T(page, "chat-bot-message").last()), [STANDARD + " opacity"], "it fades in at the standard speed, with no slide");
    });
    await resume();
    await settle(page);
  }),
);

it("Chat motion: when his send is confirmed during its rise, the row that was Sending becomes the sent row and keeps rising to its end at the standard speed, with nothing cancelled", PHONE, (p) =>
  motionPair(p, PHONE, async (page, m) => {
    await page.clock.install({ time: new Date("2026-11-02T15:00:00Z") });
    await open(page, "/chat/dale");
    await T(page, "chat-bot-message").first().waitFor();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const before = await T(page, "chat-bot-message").count();
    await T(page, "chat-input").fill("Held rise");
    const resume = await m.hold();
    await T(page, "chat-send").tap();
    const row = mine(page, "Held rise");
    await row.getByText("Sending...", { exact: true }).waitFor();
    const held = await row.elementHandle();
    await page.clock.runFor(400);
    await row.and(page.locator("[data-message-id]")).waitFor();
    assert.deepEqual(await held.evaluate((el) => [el.isConnected, el.hasAttribute("data-message-id")]), [true, true], "the row that was Sending is the sent row");
    await page.clock.runFor(3200);
    await T(page, "chat-bot-message").nth(before).getByText("Seen. I will check it and come back with the details.").waitFor();
    await page.clock.resume();
    await m.during("his row once sent", '[data-testid="chat-my-message"]', async () => {
      assert.deepEqual(await ownMotion(row), [STANDARD + " opacity", STANDARD + " translate"], "it is still rising, at the standard speed");
      await held.evaluate((el) => {
        window.qdEnded = [];
        for (const type of ["transitionend", "transitioncancel"]) el.addEventListener(type, (event) => event.target === el && window.qdEnded.push(type + " " + event.propertyName));
      });
    });
    await resume();
    await settle(page);
    if (!m.still) assert.deepEqual((await page.evaluate(() => window.qdEnded)).sort(), ["transitionend opacity", "transitionend translate"], "it ran to its end, and nothing was cancelled");
  }),
);

it("Chat on a phone: Menu, the bot's name and role, and More float over the page in one row", PHONE, async (p) => {
  await open(p, "/chat/iris");
  const label = p.locator('[data-float="label"]');
  await label.getByRole("heading", { level: 1, name: "Iris", exact: true }).waitFor();
  await label.getByText("Ops", { exact: true }).waitFor();
  const more = p.locator('[data-float="capsule"]').getByRole("button", { name: "More", exact: true });
  await more.waitFor();
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await p.waitForFunction(() => window.scrollY > 0);
  const tops = await Promise.all([T(p, "menu-btn"), label, more].map((part) => part.evaluate((el) => el.getBoundingClientRect().top)));
  assert.deepEqual(tops, [8, 8, 8]);
});

it("Chat on a phone: Search from More opens, and closing it puts focus back on More", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "float-more").tap();
  await p.locator('[data-pop="more"]').getByRole("button", { name: "Search", exact: true }).tap();
  await p.locator('[data-pop="search"]').waitFor();
  await p.keyboard.press("Escape");
  await p.locator('[data-pop="search"]').waitFor({ state: "detached" });
  assert.equal(await focusedTestId(p), "float-more");
});

it("Chat: the message box is solid in both looks, so nothing shows through it", PHONE, async (p) => {
  const solid = async () => {
    const form = T(p, "chat-input").locator("xpath=ancestor::form[1]");
    await form.waitFor();
    return form.evaluate((el) => /^rgb\(\d+, \d+, \d+\)$/.test(getComputedStyle(el).backgroundColor));
  };
  await open(p, "/chat/iris");
  assert.equal(await solid(), true, "light");
  await p.emulateMedia({ colorScheme: "dark" });
  await p.reload();
  assert.equal(await solid(), true, "dark");
});

it("Chat on a phone: a quote added while he reads keeps the secret card's title above the message box", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/chat/alba");
  const title = T(p, "secret-request").locator("h3");
  await title.waitFor();
  const formTop = () => T(p, "chat-input").locator("xpath=ancestor::form[1]").evaluate((el) => el.getBoundingClientRect().top);
  const gap = await title.evaluate((el, top) => top - 16 - el.getBoundingClientRect().bottom, await formTop());
  await p.evaluate((by) => window.scrollBy(0, -by), gap);
  await p.waitForFunction(() => document.documentElement.scrollHeight - window.innerHeight - window.scrollY > 200);
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 1000));
  const sheet = await holdMessage(p, T(p, "chat-bot-message").first());
  await sheet.getByRole("button", { name: "Reply" }).tap();
  await draftQuote(p).waitFor();
  await p.waitForFunction(() => {
    const title = document.querySelector('[data-testid="secret-request"] h3');
    const chip = document.querySelector('[data-testid="chat-quote"]');
    return title && chip && title.getBoundingClientRect().bottom <= chip.getBoundingClientRect().top;
  });
});

it("Chat: a reply from another bot shows New message from that bot above the message box, covering nothing in the thread", MAC, async (p) => {
  await p.clock.install();
  await open(p, "/chat/dale");
  await T(p, "chat-input").fill("Status?");
  await T(p, "chat-send").click();
  await p.locator('[data-testid="pinned-bot"][data-id="iris"]').click();
  await p.locator('[aria-label="Chat with Iris"]').waitFor();
  await p.clock.runFor(3500);
  const card = T(p, "chat-new-message");
  await card.getByText("New message from Dale", { exact: true }).waitFor();
  const formTop = await T(p, "chat-input").locator("xpath=ancestor::form[1]").evaluate((el) => el.getBoundingClientRect().top);
  assert.equal(await card.evaluate((el, top) => el.getBoundingClientRect().bottom <= top, formTop), true, "above the box");
  await p.waitForFunction(() => {
    const last = [...document.querySelectorAll('[data-testid="chat-thread"] > li')].at(-1);
    const shown = document.querySelector('[data-testid="chat-new-message"]');
    return last && shown && last.getBoundingClientRect().bottom <= shown.getBoundingClientRect().top + 0.5;
  });
});

it("Chat: a bot with an unread message shows New above its first unread message, a read bot shows none, and a second visit shows none", MAC, async (p) => {
  await open(p, "/chat/alba");
  await T(p, "chat-new").waitFor();
  const seen = () => T(p, "chat-thread").evaluate((ol) => {
    const list = [...ol.children];
    const at = list.findIndex((li) => li.dataset.testid === "chat-new");
    return [list.filter((li) => li.dataset.testid === "chat-new").length, at >= 0 && list[at + 1].classList.contains("chat-bot-message")];
  });
  assert.deepEqual(await seen(), [1, true], "New lines, and a bot message right after");
  await p.locator('[data-testid="pinned-bot"][data-id="iris"]').click();
  await p.locator('[aria-label="Chat with Iris"]').waitFor();
  assert.equal(await T(p, "chat-new").count(), 0, "New lines in a read chat");
  await p.locator('[data-testid="pinned-bot"][data-id="alba"]').click();
  await p.locator('[aria-label="Chat with Alba"]').waitFor();
  assert.equal(await T(p, "chat-new").count(), 0, "New lines on a second visit");
});

it("Chat: the Sound choice is kept after the page loads again", MAC, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-more").click();
  const sound = T(p, "chat-sound");
  const before = await sound.getAttribute("aria-checked");
  await sound.click();
  const after = before === "true" ? "false" : "true";
  assert.equal(await sound.getAttribute("aria-checked"), after);
  await p.reload();
  await T(p, "chat-more").click();
  assert.equal(await T(p, "chat-sound").getAttribute("aria-checked"), after);
});

it("Chat: Turn on notifications says they come with the connection and asks the browser for nothing", MAC, async (p) => {
  await p.addInitScript(() => {
    window.qdAsked = 0;
    const ask = () => {
      window.qdAsked += 1;
      return Promise.resolve("default");
    };
    if (window.Notification) window.Notification.requestPermission = ask;
    if (window.PushManager) window.PushManager.prototype.subscribe = ask;
    if (navigator.serviceWorker) navigator.serviceWorker.register = ask;
  });
  await open(p, "/chat/iris");
  await T(p, "chat-more").click();
  await T(p, "chat-notifications").click();
  await p.getByRole("status").filter({ hasText: "Notifications will be available when connected to Quarterdeck." }).waitFor();
  assert.equal(await p.evaluate(() => window.qdAsked), 0);
});

it("Chat on the Mac: with a chat open, each chat row shows the bot's avatar and its role on a line of its own", MAC, async (p) => {
  await open(p, "/chat/iris");
  const row = p.locator('[data-testid="chat-row"][data-id="dr-kivo"]');
  await row.waitFor();
  assert.equal(await row.locator("span[aria-hidden]").first().innerText(), "DK");
  const name = await row.getByText("Dr. Kivo", { exact: true }).boundingBox();
  const role = await row.getByText("Bot Manager", { exact: true }).boundingBox();
  assert.equal(role.y >= name.y + name.height - 0.5, true);
});

it("Chat: a card-change reply names the Task Card, and the line opens it", MAC, async (p) => {
  await open(p, "/chat/alba");
  const line = T(p, "chat-card-update").first();
  await line.getByText("How many results should each Search group show?", { exact: true }).waitFor();
  await line.click();
  await p.waitForURL((url) => url.pathname === "/queue/alba-1");
});

const browser = await chromium.launch(chromeLaunchOptions({ args: ["--no-sandbox"] }));
try {
  for (const item of cases) {
    const context = await browser.newContext({ ...item.size, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && !(item.allow && item.allow.test(message.text())) && errors.push(message.text()));
    await check(item.name, async () => {
      await item.run(page);
      assert.deepEqual(errors, [], "console errors");
    });
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`chat: ${passed} of ${passed + failed.length} pass`);
process.exit(failed.length ? 1 : 0);
