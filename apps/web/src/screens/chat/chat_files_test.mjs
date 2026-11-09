import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, webkit } from "playwright";
import { chromeLaunchOptions } from "../../../tools/browser.mjs";
import { startAppServer } from "../../../tools/app-server.mjs";

const ENGINE = process.env.QD_ENGINE ?? "chromium";
const only = process.argv.slice(2);
const failed = [];
let passed = 0;

const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--server", "--chat"], { stdio: "inherit", timeout: 120_000 });
if (built.status !== 0) process.exit(built.status ?? 1);
const { server, origin } = await startAppServer();

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const MAC = { viewport: { width: 1512, height: 982 } };
const LIMITS = { fileBytes: 10485760, messageBytes: 26214400, count: 5 };
const PHOTO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const FILE_ACCEPT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".md", ".csv", ".json", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"].join(",");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const CHAT_LAST = "Answer 30: the export sheet is on its way.";
const OFF_LINE = "Not sent: files are not built on the server yet.";
const EXPIRED = "Your files expired. Tap Try Again to upload them again.";
const RESOURCE = /Failed to load resource/;
const FILES_PATH = "/captain/api/files/";
const WEBKIT_VIEWPORT_LINE = 'Viewport argument key "interactive-widget" not recognized and ignored.';
const SENT = 15_000;
const MAIL_PATH = /^\/captain\/mail(?:\/MT-[1-9][0-9]{0,8})?$/;
const mailRefusal = (message) => {
  const { url } = message.location();
  return /^Failed to load resource: the server responded with a status of 404/.test(message.text()) && url !== "" && MAIL_PATH.test(new URL(url).pathname);
};

const payload = (name) => JSON.parse(readFileSync(new URL("../../data/server-payloads/" + name, import.meta.url), "utf8"));
const LISTING = readFileSync(new URL("../../data/server-payloads/list-fixed-only.json", import.meta.url), "utf8");
const T = (p, id) => p.locator(`[data-testid="${id}"]`);
const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const photo = (name, extra = 0) => ({ name, mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.alloc(extra)]) });
const pdf = (name) => ({ name, mimeType: "application/pdf", buffer: PDF });
const shared = (id, name, type, kind) => ({ id, name, type, size: kind === "photo" ? PNG.length : PDF.length, kind, ...(kind === "blocked" ? {} : { url: FILES_PATH + id }) });
const botWith = (n, files, words = "Files for you.") => ({ id: "iris-x" + n, from: "bot", text: words, at: "2026-11-06T00:3" + n + ":00-05:00", refs: [], ...(files ? { files } : {}) });
const mine = (p, words) => T(p, "chat-my-message").filter({ hasText: words });
const sentRow = (p, n) => p.locator(`[data-message-id="iris-m${40 + n}"]`);

async function serve(p, { files = true, limits = true, extra = [], upload, post, download } = {}) {
  const asked = { uploads: [], posts: [], downloads: [], sent: [], stored: new Map(), extra: [...extra] };
  const watchers = [];
  const notify = () => {
    for (const one of [...watchers]) {
      if (!one.check()) continue;
      watchers.splice(watchers.indexOf(one), 1);
      one.done();
    }
  };
  asked.until = (label, check) =>
    new Promise((done, fail) => {
      if (check()) return done();
      const stop = setTimeout(() => fail(new Error("waited 10 s for " + label + "; uploads " + asked.uploads.length + ", posts " + asked.posts.length + ", downloads [" + asked.downloads.join() + "]")), 10_000);
      watchers.push({ check, done: () => { clearTimeout(stop); done(); } });
    });
  const thread = () => {
    const base = payload("chat/thread-iris-newest.json");
    return { ...base, messages: [...base.messages, ...asked.extra, ...asked.sent].slice(-40), ...(files ? { features: ["files"] } : {}) };
  };
  await p.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        window.qdStream = this;
      }
      close() {}
    };
  });
  await p.route("**/captain/cards", (route) => route.fulfill({ status: 200, contentType: "application/json", body: LISTING }));
  await p.route((url) => url.pathname.startsWith("/captain/mail"), (route) => reply(route, 404, { error: "not found" }));
  await p.route((url) => url.pathname === "/captain/api/chats", (route) => {
    const newest = thread().messages.at(-1);
    const rows = payload("chat/rows.json").map((row) => (row.bot.id === "iris" ? { ...row, last: newest.id, at: newest.at, preview: newest.text } : row));
    return reply(route, 200, limits ? { chats: rows, fileLimits: LIMITS } : rows);
  });
  await p.route((url) => url.pathname === "/captain/api/chat/read", (route) => reply(route, 200, { csrf: "csrf-read", freshUntil: 0 }));
  await p.route((url) => url.pathname === "/captain/api/chat", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData());
      const n = asked.posts.push(body);
      notify();
      const answer = () => {
        if (body.files?.some((id) => !asked.stored.has(id))) return reply(route, 422, { error: "files" });
        const message = { ...payload("chat/send-200.json"), id: "iris-m" + (40 + n), text: body.text, clientId: body.clientId, ...(body.files ? { files: body.files.map((id) => asked.stored.get(id)) } : {}) };
        const { uploadVerdicts, csrf, freshUntil, ...kept } = message;
        asked.sent.push(kept);
        return reply(route, 200, message);
      };
      return post ? post(route, body, n, answer) : answer();
    }
    const query = new URL(request.url()).searchParams;
    const bot = query.get("bot");
    if (query.get("before")) return reply(route, 200, payload("chat/thread-iris-older.json"));
    if (bot !== "iris") return reply(route, 200, payload(bot === "alba" ? "chat/thread-alba.json" : "chat/thread-dale-empty.json"));
    const whole = thread();
    const after = query.get("after");
    if (!after) return reply(route, 200, whole);
    const at = whole.messages.findIndex((one) => one.id === after);
    return at < 0 ? reply(route, 409, { error: "cursor" }) : reply(route, 200, { ...whole, messages: whole.messages.slice(at + 1) });
  });
  await p.route((url) => url.pathname === "/captain/api/files", async (route) => {
    const request = route.request();
    const headers = request.headers();
    const one = { name: decodeURIComponent(headers["x-qd-file-name"] ?? ""), type: headers["content-type"] ?? "", csrf: headers["x-qd-csrf"] ?? "", size: request.postDataBuffer()?.length ?? 0 };
    const n = asked.uploads.push(one);
    notify();
    const answer = () => {
      const id = "f-" + n;
      const kind = one.type.startsWith("image/") ? "photo" : "file";
      asked.stored.set(id, { id, name: one.name, type: one.type, size: one.size, kind, url: FILES_PATH + id });
      return reply(route, 200, { id, name: one.name, type: one.type, size: one.size, sha256: "0".repeat(64), kind, csrf: "up-" + n, freshUntil: 0 });
    };
    return upload ? upload(route, n, answer) : answer();
  });
  await p.route((url) => url.pathname.startsWith(FILES_PATH), (route) => {
    const id = new URL(route.request().url()).pathname.slice(FILES_PATH.length);
    asked.downloads.push(id);
    notify();
    const known = asked.stored.get(id) ?? asked.extra.flatMap((one) => one.files ?? []).find((file) => file.id === id);
    const isPhoto = known?.kind === "photo";
    const answer = () => route.fulfill({ status: 200, contentType: isPhoto ? "image/png" : "application/pdf", headers: { "Cache-Control": "no-store" }, body: isPhoto ? PNG : PDF });
    return download ? download(route, id, answer) : answer();
  });
  return asked;
}

const opened = async (p) => {
  await p.goto(origin + "/chat/iris");
  await p.locator('[data-message-id="iris-m30"] [data-message-text]').getByText(CHAT_LAST, { exact: true }).waitFor();
};

const drop = async (p, list) => {
  const transfer = await p.evaluateHandle((files) => {
    const data = new DataTransfer();
    for (const one of files) data.items.add(new File([one.words], one.name, { type: one.type }));
    return data;
  }, list);
  await T(p, "chat").dispatchEvent("drop", { dataTransfer: transfer });
};

const cases = [];
const it = (name, size, run, allow = null) => cases.push({ name: "[" + ENGINE + "] " + name, size, run, allow });

for (const [label, size] of [["390", PHONE], ["the Mac", MAC]]) {
  it("files on at " + label + ": the plus offers Photos, Camera and Files with no Secret, and each picker lists only the round's types", size, async (p) => {
    await serve(p);
    await opened(p);
    await T(p, "plus-btn").click();
    await T(p, "plus-files").waitFor();
    assert.deepEqual(await p.locator('[data-pop="plus"] [data-testid^="plus-"]').evaluateAll((all) => all.map((one) => one.dataset.testid)), ["plus-photos", "plus-camera", "plus-files"]);
    assert.equal(await T(p, "pick-photos").getAttribute("accept"), PHOTO_ACCEPT);
    assert.equal(await T(p, "pick-camera").getAttribute("accept"), PHOTO_ACCEPT);
    assert.equal(await T(p, "pick-files").getAttribute("accept"), FILE_ACCEPT);
  });

  for (const [shape, words] of [[{ files: true, limits: false }, "files listed but no limits"], [{ files: false, limits: true }, "limits but files not listed"]]) {
    it("files off at " + label + " with " + words + ": there is no plus, and a dropped file gives today's refusal line with no upload", size, async (p) => {
      const asked = await serve(p, shape);
      await opened(p);
      assert.equal(await T(p, "plus-btn").count(), 0);
      await drop(p, [{ name: "notes.txt", type: "text/plain", words: "notes" }]);
      await p.getByText(OFF_LINE, { exact: true }).waitFor();
      assert.equal(await T(p, "draft-file").count(), 0);
      assert.equal(asked.uploads.length, 0);
    });
  }
}

it("pick and send a photo and a file: Uploading... with the bar until the uploads end, then the sent row shows the photo inline and the file as a row, from the receipt", PHONE, async (p) => {
  let release = () => {};
  const held = new Promise((done) => (release = done));
  const asked = await serve(p, { upload: async (route, n, answer) => { if (n === 2) await held; return answer(); } });
  await opened(p);
  await T(p, "pick-files").setInputFiles([photo("shot.png"), pdf("notes.pdf")]);
  await T(p, "draft-file").nth(1).waitFor();
  await T(p, "chat-input").fill("Two files");
  await T(p, "chat-send").click();
  const row = mine(p, "Two files");
  await row.locator('[data-testid="chat-uploading"]').getByText("Uploading...", { exact: true }).waitFor();
  await row.locator('[data-testid="chat-sending-bar"]').waitFor();
  await asked.until("the second upload", () => asked.uploads.length === 2);
  release();
  const sent = sentRow(p, 1);
  await sent.locator('[data-testid="chat-picture"]').waitFor({ timeout: SENT });
  assert.equal(await sent.locator('[data-testid="chat-picture"]').getAttribute("src"), FILES_PATH + "f-1");
  assert.equal(await sent.locator('[data-testid="chat-file"]').getAttribute("href"), FILES_PATH + "f-2");
  assert.deepEqual(asked.uploads.map((one) => [one.name, one.type]), [["shot.png", "image/png"], ["notes.pdf", "application/pdf"]]);
  assert.equal(asked.uploads[1].csrf, "up-1");
  assert.deepEqual(Object.keys(asked.posts[0]), ["bot", "text", "clientId", "csrf", "files"]);
  assert.deepEqual([asked.posts[0].files, asked.posts[0].csrf], [["f-1", "f-2"], "up-2"]);
});

it("a blocked item in a thread shows only This file was blocked: and its name, with no link, no picture and nothing to open", MAC, async (p) => {
  await serve(p, { extra: [botWith(1, [shared("f-9", "run.exe", "application/x-msdownload", "blocked")])] });
  await opened(p);
  const message = p.locator('[data-message-id="iris-x1"]');
  await message.locator('[data-testid="chat-file-blocked"]').getByText("This file was blocked: run.exe", { exact: true }).waitFor();
  assert.equal(await message.locator('a, img, [data-testid="chat-file"], [data-testid="chat-picture-open"]').count(), 0);
});

it("each refusal before an upload shows its line under the composer, and nothing uploads", PHONE, async (p) => {
  const asked = await serve(p);
  const tries = [
    [[photo("big.png", LIMITS.fileBytes)], "This file is too big: big.png"],
    [[1, 2, 3, 4, 5, 6].map((n) => photo("p" + n + ".png")), "A message can carry up to 5 files."],
    [[photo("a.png", 9 * 1048576), photo("b.png", 9 * 1048576), photo("c.png", 9 * 1048576)], "These files are too big together. A message can carry up to 25 MB."],
    [[{ name: "run.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") }], "This file's type is not allowed: run.exe"],
    [[{ name: "page.txt", mimeType: "text/plain", buffer: Buffer.from("<html>") }], "This file's type is not allowed: page.txt"],
    [[{ name: "IMG_0001.HEIC", mimeType: "image/heic", buffer: Buffer.from("0000ftypheic") }], "This picture is in Apple's format. Choose it from Photos, or save it as a JPEG first."],
  ];
  for (const [files, line] of tries) {
    await opened(p);
    await T(p, "pick-files").setInputFiles(files);
    await p.getByText(line, { exact: true }).waitFor();
  }
  assert.equal(asked.uploads.length, 0);
});

it("a send answered 422 files keeps the row's words and files with Your files expired. Tap Try Again to upload them again., and Try Again uploads them again and sends", PHONE, async (p) => {
  const asked = await serve(p, { post: (route, body, n, answer) => (n === 1 ? reply(route, 422, { error: "files" }) : answer()) });
  await opened(p);
  await T(p, "pick-files").setInputFiles([photo("shot.png"), pdf("notes.pdf")]);
  await T(p, "draft-file").nth(1).waitFor();
  await T(p, "chat-input").fill("Try these");
  await T(p, "chat-send").click();
  const row = mine(p, "Try these");
  await row.getByText(EXPIRED, { exact: true }).waitFor({ timeout: SENT });
  assert.equal(await row.locator('[data-testid="chat-picture-open"], [data-testid="chat-file"]').count(), 2);
  await row.locator('[data-testid="chat-retry"]').click();
  await sentRow(p, 2).waitFor({ timeout: SENT });
  assert.equal(asked.uploads.length, 4);
  assert.deepEqual(asked.posts.map((one) => one.files), [["f-1", "f-2"], ["f-3", "f-4"]]);
}, RESOURCE);

it("an upload answered 413 shows This file is too big: on the row with no Try Again, and nothing is sent", PHONE, async (p) => {
  const asked = await serve(p, { upload: (route) => reply(route, 413, { error: "size" }) });
  await opened(p);
  await T(p, "pick-files").setInputFiles([pdf("notes.pdf")]);
  await T(p, "draft-file").waitFor();
  await T(p, "chat-send").click();
  const row = T(p, "chat-my-message").filter({ has: p.getByText("This file is too big: notes.pdf", { exact: true }) });
  await row.waitFor({ timeout: SENT });
  assert.equal(await row.locator('[data-testid="chat-retry"]').count(), 0);
  assert.equal(asked.posts.length, 0);
}, RESOURCE);

it("a file row is a link that opens the file in a new tab with rel noopener, and the app stays where it was", MAC, async (p) => {
  await serve(p, { extra: [botWith(1, [shared("f-9", "notes.pdf", "application/pdf", "file")])] });
  await opened(p);
  const link = p.locator('[data-message-id="iris-x1"] [data-testid="chat-file"]');
  assert.deepEqual(await link.evaluate((el) => [el.tagName, el.getAttribute("href"), el.getAttribute("target"), (el.getAttribute("rel") ?? "").split(" ").includes("noopener")]), ["A", FILES_PATH + "f-9", "_blank", true]);
  const before = p.url();
  const [tab] = await Promise.all([p.context().waitForEvent("page"), link.click()]);
  await tab.waitForLoadState("commit");
  assert.equal(new URL(tab.url()).pathname, FILES_PATH + "f-9");
  assert.equal(p.url(), before);
});

it("three photos load one at a time, newest first; a thread refresh and a new message download none again; opening one in the viewer adds at most one download", MAC, async (p) => {
  const held = [];
  let hold = true;
  const asked = await serve(p, {
    extra: [1, 2, 3].map((n) => botWith(n, [shared("p-" + n, "photo" + n + ".png", "image/png", "photo")])),
    download: (route, id, answer) => (hold ? new Promise((done) => held.push(() => done(answer()))) : answer()),
  });
  await opened(p);
  for (const [count, id] of [[1, "p-3"], [2, "p-2"], [3, "p-1"]]) {
    await asked.until("download " + count, () => asked.downloads.length === count);
    assert.deepEqual([asked.downloads.at(-1), held.length], [id, 1], "one download at a time, newest first");
    held.shift()();
  }
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="chat-picture"]')].filter((img) => img.complete && img.naturalWidth > 0).length === 3);
  hold = false;
  asked.extra.push(botWith(4, null, "One more line."));
  await p.evaluate(() => window.qdStream.dispatchEvent(new MessageEvent("refresh", { data: JSON.stringify({ cards: false, mail: false, chats: true }) })));
  await p.locator('[data-message-id="iris-x4"]').getByText("One more line.", { exact: true }).waitFor({ timeout: 20_000 });
  await T(p, "chat-input").fill("And one from me");
  await T(p, "chat-send").click();
  await sentRow(p, 1).waitFor({ timeout: SENT });
  assert.deepEqual(asked.downloads, ["p-3", "p-2", "p-1"], "no photo downloaded again");
  await p.locator('[data-message-id="iris-x3"] [data-testid="chat-picture-open"]').click();
  await p.waitForFunction(() => {
    const img = document.querySelector('[data-testid="viewer-image"]');
    return img !== null && img.complete && img.naturalWidth > 0;
  });
  assert.ok(["p-3,p-2,p-1", "p-3,p-2,p-1,p-3"].includes(asked.downloads.join()), "the downloads after the viewer: " + asked.downloads.join());
});

it("a picture that fails in the viewer shows This picture did not load. with Try again, and Try again loads it", MAC, async (p) => {
  const held = [];
  let hold = true;
  const asked = await serve(p, {
    extra: [botWith(1, [shared("p-1", "photo1.png", "image/png", "photo")])],
    download: (route, id, answer) => (hold ? new Promise((done) => held.push(() => done(route.fulfill({ status: 500, body: "" })))) : answer()),
  });
  await opened(p);
  await asked.until("the tile's download", () => asked.downloads.length === 1);
  await p.locator('[data-message-id="iris-x1"] [data-testid="chat-picture-open"]').click();
  await T(p, "viewer-image").waitFor({ state: "attached" });
  hold = false;
  for (const fail of held.splice(0)) fail();
  await T(p, "viewer-failed").getByText("This picture did not load.", { exact: true }).waitFor();
  await T(p, "viewer-retry").click();
  await p.waitForFunction(() => {
    const img = document.querySelector('[data-testid="viewer-image"]');
    return img !== null && img.complete && img.naturalWidth > 0;
  });
}, RESOURCE);

it("with the files switch off the chat is today's: no plus, one POST with only bot, text, clientId and csrf, and no files request", MAC, async (p) => {
  const asked = await serve(p, { files: false, limits: false });
  const files = [];
  p.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/captain/api/files")) files.push(request.method() + " " + path);
  });
  await opened(p);
  assert.equal(await T(p, "plus-btn").count(), 0);
  await T(p, "chat-input").fill("Plain words");
  await T(p, "chat-send").click();
  await sentRow(p, 1).waitFor({ timeout: SENT });
  assert.equal(asked.posts.length, 1);
  assert.deepEqual(Object.keys(asked.posts[0]), ["bot", "text", "clientId", "csrf"]);
  assert.deepEqual(files, []);
});

const engines = { chromium, webkit };
const browser = await engines[ENGINE].launch(ENGINE === "chromium" ? chromeLaunchOptions({ args: ["--no-sandbox"] }) : {});
try {
  for (const item of cases) {
    if (only.length && !only.some((part) => item.name.includes(part))) continue;
    const context = await browser.newContext({ colorScheme: "dark", ...item.size, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && !(ENGINE === "webkit" && message.text() === WEBKIT_VIEWPORT_LINE) && !mailRefusal(message) && !(item.allow && item.allow.test(message.text())) && errors.push(message.text()));
    try {
      await item.run(page);
      assert.deepEqual(errors, [], "console errors");
      passed += 1;
      console.log("ok   " + item.name);
    } catch (error) {
      failed.push(item.name);
      console.log("FAIL " + item.name + "\n     " + String(error?.message ?? error).split("\n").slice(0, 8).join("\n     "));
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(`chat files (${ENGINE}): ${passed} of ${passed + failed.length} pass`);
if (failed.length || passed === 0) process.exit(1);
