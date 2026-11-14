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

const carried = (p, list) =>
  p.evaluateHandle((files) => {
    const data = new DataTransfer();
    for (const one of files) data.items.add(new File([one.words], one.name, { type: one.type }));
    return data;
  }, list);
const drop = async (p, list) => T(p, "chat").dispatchEvent("drop", { dataTransfer: await carried(p, list) });
const sized = (file, bytes) => ({ ...file, buffer: Buffer.concat([file.buffer, Buffer.alloc(bytes - file.buffer.length)]) });
const squashed = (locator) => locator.innerText().then((words) => words.replace(/\s+/g, " ").trim());
const EXE = { name: "setup.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") };
const HEIC = { name: "IMG_0001.HEIC", mimeType: "image/heic", buffer: Buffer.from("0000ftypheic") };
const HEIC_LINE = "This picture is in Apple's format. Choose it from Photos, or save it as a JPEG first.";
const kindNote = (name) => "Not added: " + name + ". Quarterdeck cannot send this kind of file.";

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

it("at 390 a blocked row shows This file was blocked: and the whole name, setup.exe or a long name with no spaces, wrapped inside the bubble with nothing cut", PHONE, async (p) => {
  const long = "quarterly-search-results-for-every-lane-final-copy.exe";
  await serve(p, { extra: [botWith(1, [shared("f-8", "setup.exe", "application/x-msdownload", "blocked"), shared("f-9", long, "application/x-msdownload", "blocked")])] });
  await opened(p);
  const rows = p.locator('[data-message-id="iris-x1"] [data-testid="chat-file-blocked"]');
  for (const name of ["setup.exe", long]) await rows.getByText("This file was blocked: " + name, { exact: true }).waitFor();
  const shown = await rows.evaluateAll((list) =>
    list.map((row) => {
      const bubble = row.closest(".chat-bot-bubble");
      const edge = bubble.getBoundingClientRect().right - parseFloat(getComputedStyle(bubble).paddingRight);
      return [row.textContent, [row, ...row.children].some((el) => el.scrollWidth > el.clientWidth), row.getBoundingClientRect().right <= edge + 0.5];
    }),
  );
  assert.deepEqual(shown, [["This file was blocked: setup.exe", false, true], ["This file was blocked: " + long, false, true]]);
});

it("each refusal before an upload shows as a note inside the composer, in the design's Not added words with the server's numbers, and nothing uploads", PHONE, async (p) => {
  const asked = await serve(p);
  const tries = [
    [[photo("big.png", LIMITS.fileBytes)], "Not added: big.png. It is 10.1 MB, and one file can be 10 MB at most."],
    [[1, 2, 3, 4, 5, 6].map((n) => photo("p" + n + ".png")), "Not added: p6.png. A message holds 5 files at most. Send these, then attach the rest."],
    [[photo("a.png", 9 * 1048576), photo("b.png", 9 * 1048576), photo("c.png", 9 * 1048576)], "Not added: c.png. With it this message would be 27.1 MB, and a message can be 25 MB at most."],
    [[{ ...EXE, name: "run.exe" }], kindNote("run.exe")],
    [[{ name: "page.txt", mimeType: "text/plain", buffer: Buffer.from("<html>") }], kindNote("page.txt")],
    [[HEIC], HEIC_LINE],
  ];
  for (const [files, line] of tries) {
    await opened(p);
    await T(p, "pick-files").setInputFiles(files);
    await T(p, "draft-strip").locator('[data-testid="draft-note"]').getByText(line, { exact: true }).waitFor();
  }
  assert.equal(asked.uploads.length, 0);
});

it("at 390 three refusals in one pick show as three notes in the composer, in order and whole, each with its own Dismiss; Dismiss takes only its own note, his words stay, and the next file added takes the rest", PHONE, async (p) => {
  const asked = await serve(p);
  await opened(p);
  await T(p, "chat-input").fill("Keep these words");
  await T(p, "pick-files").setInputFiles([photo("big-screenshot.png", LIMITS.fileBytes), EXE, HEIC]);
  const notes = T(p, "draft-note");
  await notes.nth(2).waitFor();
  const lines = ["Not added: big-screenshot.png. It is 10.1 MB, and one file can be 10 MB at most.", kindNote("setup.exe"), HEIC_LINE];
  assert.deepEqual(await Promise.all([0, 1, 2].map((n) => squashed(notes.nth(n).locator("p")))), lines);
  assert.deepEqual(await notes.locator("p b").allInnerTexts(), ["Not added: big-screenshot.png.", "Not added: setup.exe."], "the strong first words");
  assert.equal(await notes.getByRole("button", { name: "Dismiss this note" }).count(), 3);
  assert.equal(await notes.evaluateAll((all) => all.every((note) => note.scrollWidth <= note.clientWidth && note.getBoundingClientRect().right <= innerWidth)), true, "each note whole inside the screen");
  await notes.nth(1).getByRole("button", { name: "Dismiss this note" }).tap();
  await notes.nth(2).waitFor({ state: "detached" });
  assert.deepEqual(await Promise.all([0, 1].map((n) => squashed(notes.nth(n).locator("p")))), [lines[0], lines[2]]);
  assert.equal(await T(p, "chat-input").inputValue(), "Keep these words");
  await T(p, "pick-files").setInputFiles([pdf("notes.pdf")]);
  await T(p, "draft-file").waitFor();
  await notes.first().waitFor({ state: "detached" });
  assert.deepEqual([await notes.count(), await T(p, "chat-input").inputValue(), asked.uploads.length], [0, "Keep these words", 0]);
});

it("picked files are chips in the composer: a photo with a small picture and a file with its kind, each with its name, its size and ready, and its own Remove; the line above counts them against the server's limit", PHONE, async (p) => {
  const asked = await serve(p);
  await opened(p);
  await T(p, "pick-files").setInputFiles([sized(photo("shot.png"), Math.round(2.4 * 1048576)), sized(pdf("notes.pdf"), 320 * 1024)]);
  const chips = T(p, "draft-file");
  await chips.nth(1).waitFor();
  assert.deepEqual([await squashed(chips.nth(0)), await squashed(chips.nth(1))], ["shot.png 2.4 MB, ready", "PDF notes.pdf 320 KB, ready"]);
  assert.equal(await squashed(T(p, "draft-total")), "2 files, 2.7 MB of 25 MB");
  const picture = await chips.nth(0).locator("img").evaluate((img) => [img.src.startsWith("blob:"), img.getBoundingClientRect().width, img.getBoundingClientRect().height]);
  assert.deepEqual([picture[0], picture[1] === picture[2], picture[1] <= 32], [true, true, true], "the small picture: " + picture.join(" "));
  const keys = await chips.getByRole("button", { name: /^Remove / }).evaluateAll((all) => all.map((key) => [key.getAttribute("aria-label"), Math.round(key.getBoundingClientRect().width) >= 44, Math.round(key.getBoundingClientRect().height) >= 44]));
  assert.deepEqual(keys, [["Remove shot.png", true, true], ["Remove notes.pdf", true, true]], "each Remove key and its touch size");
  await p.getByRole("button", { name: "Remove shot.png" }).tap();
  await chips.nth(1).waitFor({ state: "detached" });
  assert.equal(await squashed(T(p, "draft-total")), "1 file, 320 KB of 25 MB");
  await p.getByRole("button", { name: "Remove notes.pdf" }).tap();
  await T(p, "draft-strip").waitFor({ state: "detached" });
  assert.equal(asked.uploads.length, 0);
});

it("a long file name is cut in the middle on its chip so the ending shows, the chip stays inside the composer at 390, and its Remove key says the whole name", PHONE, async (p) => {
  await serve(p);
  await opened(p);
  const long = "Screenshot 2026-11-02 at 9.41.12 AM.png";
  await T(p, "pick-files").setInputFiles([photo(long)]);
  const chip = T(p, "draft-file");
  await chip.getByText("Screenshot 2026\u202641.12 AM.png", { exact: true }).waitFor();
  await chip.getByRole("button", { name: "Remove " + long }).waitFor();
  const inside = await chip.evaluate((el) => {
    const form = el.closest("form").getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.left >= form.left && box.right <= form.right;
  });
  assert.equal(inside, true);
});

it("at 390 five chips take more than two rows, the strip then scrolls inside itself at two rows high, and the message box and Send stay on screen", PHONE, async (p) => {
  await serve(p);
  await opened(p);
  await T(p, "pick-files").setInputFiles([1, 2, 3, 4, 5].map((n) => photo("screenshot-number-" + n + ".png")));
  await T(p, "draft-file").nth(4).waitFor();
  const strip = await T(p, "draft-list").evaluate((list) => {
    const chips = [...list.querySelectorAll('[data-testid="draft-file"]')];
    return { rows: new Set(chips.map((one) => Math.round(one.getBoundingClientRect().top + list.scrollTop))).size, scrolls: list.scrollHeight > list.clientHeight, high: list.clientHeight, two: chips[0].getBoundingClientRect().height * 2 + parseFloat(getComputedStyle(list).rowGap) };
  });
  assert.ok(strip.rows > 2 && strip.scrolls && strip.high <= strip.two + 1, JSON.stringify(strip));
  for (const id of ["chat-input", "chat-send"]) {
    const box = await T(p, id).boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 844, id + " on screen: " + JSON.stringify(box));
  }
});

for (const [label, size] of [["390 by 844", PHONE], ["390 by 500, the room a keyboard leaves", { viewport: { width: 390, height: 500 }, hasTouch: true, isMobile: true }]])
  it("at " + label + ": twelve photos against a limit of five leave five chips and seven notes; the notes scroll inside two rows of their own with the first one in view, and the message box and Send stay on screen", size, async (p) => {
    const asked = await serve(p);
    await opened(p);
    await T(p, "pick-files").setInputFiles(Array.from({ length: 12 }, (_, n) => photo("screenshot-number-" + (n + 1) + ".png")));
    const notes = T(p, "draft-note");
    await notes.nth(6).waitFor({ state: "attached" });
    assert.deepEqual([await T(p, "draft-file").count(), await notes.count()], [5, 7], "chips and notes");
    assert.equal(await squashed(notes.first().locator("p")), "Not added: screenshot-number-6.png. A message holds 5 files at most. Send these, then attach the rest.");
    const held = await T(p, "draft-notes").evaluate((box) => {
      const chip = document.querySelector('[data-testid="draft-file"]').getBoundingClientRect().height;
      const gap = parseFloat(getComputedStyle(document.querySelector('[data-testid="draft-list"]')).rowGap);
      const first = box.querySelector('[data-testid="draft-note"]').getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      return { scrolls: box.scrollHeight > box.clientHeight, high: box.clientHeight, two: chip * 2 + gap, firstInView: first.top >= frame.top - 1 && first.top < frame.bottom };
    });
    assert.ok(held.scrolls && held.high <= held.two + 1 && held.firstInView, "the notes' own scroll: " + JSON.stringify(held));
    for (const id of ["chat-input", "chat-send"]) {
      const box = await T(p, id).boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= size.viewport.height, id + " on screen: " + JSON.stringify(box));
    }
    assert.equal(asked.uploads.length, 0);
  });

it("on the Mac, files dragged over the chat turn the composer's edge to a dashed line and show the server's limits in the composer, and the dropped file becomes a chip", MAC, async (p) => {
  const asked = await serve(p);
  await opened(p);
  const edge = () => p.locator(".chat-composer-form").evaluate((form) => getComputedStyle(form).borderTopStyle);
  const dataTransfer = await carried(p, [{ name: "notes.txt", type: "text/plain", words: "notes" }]);
  await T(p, "chat").dispatchEvent("dragenter", { dataTransfer });
  await T(p, "drop-hint").getByText("Drop to attach. Up to 5 files, 10 MB each, 25 MB in one message.", { exact: true }).waitFor();
  assert.deepEqual([await edge(), await T(p, "drop-hint").evaluate((hint) => hint.closest(".chat-composer-form") !== null)], ["dashed", true], "the edge, and the note inside the composer");
  await T(p, "chat").dispatchEvent("drop", { dataTransfer });
  await T(p, "drop-hint").waitFor({ state: "detached" });
  assert.deepEqual([await squashed(T(p, "draft-file")), await edge(), asked.uploads.length], ["TXT notes.txt 0.1 KB, ready", "solid", 0]);
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
