import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const load = async () => {
  const { loadTs } = await import("../../tools/load-ts.mjs");
  return loadTs("src/data/chat-client.ts");
};

const message = (n, extra = {}) => ({ id: "m" + n, from: "bot", text: "text " + n, at: "2026-11-06T00:" + String(10 + n).padStart(2, "0") + ":00-05:00", refs: [], ...extra });
const row = (bot, last = "m1", extra = {}) => ({ bot: { id: bot, note: "the " + bot }, preview: "preview of " + bot, at: "2026-11-06T00:11:00-05:00", last, unread: false, ...extra });
const thread = (bot, messages, older = false, extra = {}) => ({ bot: { id: bot }, messages, seenUpTo: null, seenAt: null, working: null, older, ...extra });
const receipt = (extra = {}) => ({ ...message(9, { from: "captain", clientId: "client-9" }), uploadVerdicts: [], csrf: "token-9", freshUntil: 1793000000, ...extra });

const unreadable = (error) => error?.name === "Refused" && error.message.startsWith("The server's answer could not be read");
const refusedWith = (words) => (error) => error?.name === "Refused" && error.message === words;
const notConfirmed = (error) => error?.name === "NotConfirmed";

const sample = (name) => JSON.parse(fs.readFileSync(new URL("./server-payloads/chat/v2/" + name, import.meta.url), "utf8"));
const STAMP = "2026-11-06T00:12:00-05:00";
const WORKING = { note: "reading", since: "2026-11-06T00:20:00-05:00", updatedAt: "2026-11-06T00:21:00-05:00" };
const FILE = { id: "f-1", name: "a.png", type: "image/png", size: 10, kind: "photo", url: "/captain/api/files/f-1" };
const LIMITS = { fileBytes: 10485760, messageBytes: 26214400, count: 5 };
const SHOWN = { id: "f-1", name: "a.png", size: 10, type: "image/png", kind: "photo", url: "/captain/api/files/f-1" };
const META = { seenUpTo: "m8", seenAt: STAMP, working: WORKING, firstUnread: "m7", features: ["read", "seen"], rev: 9 };
const metaOf = (read) => ({ seenUpTo: read.seenUpTo, seenAt: read.seenAt, working: read.working, firstUnread: read.firstUnread, features: read.features, rev: read.rev });

test("a list of rows parses with its bot, preview, time, last id and unread", async () => {
  const { parseChatRows } = await load();
  const rows = parseChatRows([row("steward"), row("iris", "m7", { bot: { id: "iris" }, unread: true }), row("quiet", "", { preview: "", at: "" })]);
  assert.deepEqual(rows, [
    { bot: { id: "steward", note: "the steward" }, preview: "preview of steward", at: "2026-11-06T00:11:00-05:00", last: "m1", unread: false },
    { bot: { id: "iris", note: "" }, preview: "preview of iris", at: "2026-11-06T00:11:00-05:00", last: "m7", unread: true },
    { bot: { id: "quiet", note: "the quiet" }, preview: "", at: "", last: "", unread: false },
  ]);
});

test("the contract's rows sample parses with unread true and a rev, and a row without rev has none", async () => {
  const { parseChatRows } = await load();
  assert.deepEqual(parseChatRows(sample("rows.json")), [
    { bot: { id: "bot-a", note: "" }, preview: "Looking at it now.", at: "2026-11-06T15:45:00-05:00", last: "Mb0a4", unread: true, rev: 42 },
    { bot: { id: "bot-b", note: "" }, preview: "", at: "", last: "", unread: false, rev: 7 },
  ]);
  assert.equal("rev" in parseChatRows([row("steward")])[0], false);
});

test("a row without last is unreadable, as is a body that is not a list", async () => {
  const { parseChatRows } = await load();
  const bare = row("steward");
  delete bare.last;
  assert.throws(() => parseChatRows([bare]), unreadable);
  assert.throws(() => parseChatRows({ rows: [] }), unreadable);
  assert.throws(() => parseChatRows([row("steward", 7)]), unreadable);
});

test("a row with no bot id, a preview that is not text, an unread that is not a boolean or a rev that is not a count is unreadable", async () => {
  const { parseChatRows } = await load();
  assert.throws(() => parseChatRows([row("steward", "m1", { bot: {} })]), unreadable);
  assert.throws(() => parseChatRows([row("steward", "m1", { preview: 5 })]), unreadable);
  assert.throws(() => parseChatRows([row("steward", "m1", { at: 5 })]), unreadable);
  for (const unread of ["yes", 1, null, undefined]) assert.throws(() => parseChatRows([row("steward", "m1", { unread })]), unreadable, String(unread));
  for (const rev of [-1, 1.5, "7", null, Number.NaN, 2 ** 60]) assert.throws(() => parseChatRows([row("steward", "m1", { rev })]), unreadable, String(rev));
});

test("the chat list is a bare list of rows with no file limits, or chats with fileLimits, and any other shape is unreadable", async () => {
  const { parseChatList, parseChatRows } = await load();
  const rows = [row("steward"), row("quiet", "", { preview: "", at: "" })];
  assert.deepEqual(parseChatList(rows), { rows: parseChatRows(rows), limits: null });
  assert.deepEqual(parseChatList({ chats: rows, fileLimits: LIMITS }), { rows: parseChatRows(rows), limits: LIMITS });
  assert.deepEqual(parseChatList({ chats: rows, fileLimits: { ...LIMITS, more: 1 }, more: 1 }).limits, LIMITS);
  assert.deepEqual(parseChatList({ chats: sample("rows.json"), fileLimits: LIMITS }), { rows: parseChatRows(sample("rows.json")), limits: LIMITS });
  const bads = [null, "rows", {}, { chats: rows }, { fileLimits: LIMITS }, { chats: "rows", fileLimits: LIMITS }, { chats: rows, fileLimits: null }, { chats: rows, fileLimits: { ...LIMITS, count: 0 } }, { chats: rows, fileLimits: { ...LIMITS, fileBytes: 1.5 } }, { chats: rows, fileLimits: { ...LIMITS, messageBytes: "26214400" } }, { chats: rows, fileLimits: { fileBytes: 1, messageBytes: 1 } }, { chats: [5], fileLimits: LIMITS }];
  for (const bad of bads) assert.throws(() => parseChatList(bad), unreadable, JSON.stringify(bad));
});

test("a thread with r5's empty values parses oldest first with its older flag and empty seen, working, firstUnread and features", async () => {
  const { parseChatThread } = await load();
  const read = parseChatThread(thread("steward", [message(1), message(2, { from: "captain", clientId: "c-2" })], true));
  assert.deepEqual(read, { bot: { id: "steward", note: "" }, messages: [message(1), message(2, { from: "captain", clientId: "c-2" })], older: true, seenUpTo: null, seenAt: null, working: null, firstUnread: null, features: [] });
});

test("the contract's sample with r5's exact empty values parses to the same empties", async () => {
  const { parseChatThread } = await load();
  assert.deepEqual(parseChatThread(sample("thread-r5-empty-values.json")), {
    bot: { id: "bot-a", note: "" },
    messages: [{ id: "Mc0a1", from: "captain", text: "hi", at: "2026-11-06T15:40:00-05:00", refs: [], clientId: "k1" }],
    older: false,
    seenUpTo: null,
    seenAt: null,
    working: null,
    firstUnread: null,
    features: [],
  });
});

test("the contract's filled thread parses with every field: seen, working, firstUnread, features, rev, both quote kinds and files", async () => {
  const { parseChatThread } = await load();
  const read = parseChatThread(sample("thread-filled.json"));
  assert.equal(read.seenUpTo, "Mc0a3");
  assert.equal(read.seenAt, "2026-11-06T15:45:00-05:00");
  assert.deepEqual(read.working, { note: "reading the card", since: "2026-11-06T15:45:00-05:00", updatedAt: "2026-11-06T15:46:00-05:00" });
  assert.equal(read.firstUnread, "Mb0a4");
  assert.deepEqual(read.features, ["quote", "read", "seen", "working", "files"]);
  assert.equal(read.rev, 42);
  assert.equal(read.older, false);
  assert.deepEqual(read.messages.map((one) => one.id), ["Mc0a1", "Mb0a2", "Mc0a3", "Mb0a4"]);
  assert.equal("quote" in read.messages[0], false);
  assert.equal("attachments" in read.messages[0], false);
  assert.deepEqual(read.messages[1].quote, { id: "Mc0a1", from: "captain", at: "2026-11-06T15:40:00-05:00", text: "Can you check the **door** file?" });
  assert.deepEqual(read.messages[1].attachments, [{ id: "f-7Qk2Lm9Xz", name: "screenshot.png", size: 482113, type: "image/png", kind: "photo", url: "/captain/api/files/f-7Qk2Lm9Xz" }]);
  assert.deepEqual(read.messages[2].quote, { cardId: "Q176", version: 3 });
  assert.deepEqual(read.messages[2].attachments.map((one) => [one.name, one.size, one.type]), [["notes.pdf", 2093120, "application/pdf"]]);
  assert.equal("quote" in read.messages[3], false);
});

test("a thread without the older flag, seenUpTo, seenAt or working is unreadable, as is one whose messages are not a list", async () => {
  const { parseChatThread } = await load();
  for (const key of ["older", "seenUpTo", "seenAt", "working"]) {
    const bare = thread("steward", [message(1)]);
    delete bare[key];
    assert.throws(() => parseChatThread(bare), unreadable, key);
  }
  assert.throws(() => parseChatThread(thread("steward", "none")), unreadable);
});

test("seenUpTo, seenAt and working take their filled values, and a malformed one is unreadable", async () => {
  const { parseChatThread } = await load();
  const parsed = (extra) => parseChatThread(thread("steward", [message(1)], false, extra));
  const got = parsed({ seenUpTo: "m1", seenAt: STAMP, working: { ...WORKING, more: true } });
  assert.deepEqual([got.seenUpTo, got.seenAt, got.working], ["m1", STAMP, WORKING]);
  const bads = [{ seenUpTo: 5 }, { seenUpTo: "" }, { seenAt: 5 }, { seenAt: "" }, { seenAt: "never" }, { working: "busy" }, { working: [] }, { working: { note: "x" } }, { working: { ...WORKING, note: 5 } }, { working: { ...WORKING, since: "soon" } }, { working: { ...WORKING, updatedAt: "" } }, { working: { ...WORKING, note: "x".repeat(4001) } }];
  for (const bad of bads) assert.throws(() => parsed(bad), unreadable, JSON.stringify(bad));
});

test("firstUnread is a message id or null, and missing is null", async () => {
  const { parseChatThread } = await load();
  const parsed = (extra) => parseChatThread(thread("steward", [message(1)], false, extra));
  assert.equal(parsed({ firstUnread: "m1" }).firstUnread, "m1");
  assert.equal(parsed({ firstUnread: "m-older-than-the-page" }).firstUnread, "m-older-than-the-page");
  assert.equal(parsed({ firstUnread: null }).firstUnread, null);
  assert.equal(parsed({}).firstUnread, null);
  for (const firstUnread of [5, "", "x".repeat(513), "m\u0001"]) assert.throws(() => parsed({ firstUnread }), unreadable, String(firstUnread));
});

test("features is a list of names: missing is empty, unknown names are ignored, repeats collapse, anything else is unreadable", async () => {
  const { parseChatThread } = await load();
  const parsed = (features) => parseChatThread(thread("steward", [message(1)], false, { features })).features;
  assert.deepEqual(parsed(undefined), []);
  assert.deepEqual(parsed([]), []);
  assert.deepEqual(parsed(["quote", "read", "seen", "working", "files"]), ["quote", "read", "seen", "working", "files"]);
  assert.deepEqual(parsed(["read", "later", "quote", "read"]), ["read", "quote"]);
  for (const bad of ["read", {}, null, 5, [5], [null], [["read"]], Array.from({ length: 65 }, (_, n) => "f" + n)]) assert.throws(() => parsed(bad), unreadable, JSON.stringify(bad));
});

test("rev is a non-negative whole number or missing, and the thread keeps it", async () => {
  const { parseChatThread } = await load();
  assert.equal(parseChatThread(thread("steward", [message(1)], false, { rev: 0 })).rev, 0);
  assert.equal(parseChatThread(thread("steward", [message(1)], false, { rev: 12 })).rev, 12);
  assert.equal("rev" in parseChatThread(thread("steward", [message(1)])), false);
  for (const rev of [-1, 1.5, "7", null, 2 ** 60]) assert.throws(() => parseChatThread(thread("steward", [message(1)], false, { rev })), unreadable, String(rev));
});

test("a message needs an id, a known sender, text, a time and refs", async () => {
  const { parseChatThread } = await load();
  for (const bad of [{ id: "" }, { from: "someone" }, { text: 5 }, { at: 5 }, { refs: undefined }, { refs: "m1" }, { clientId: 5 }]) {
    assert.throws(() => parseChatThread(thread("steward", [{ ...message(1), ...bad }])), unreadable, JSON.stringify(bad));
  }
});

test("a message keeps only the fields of this cut and ignores the rest", async () => {
  const { parseChatThread } = await load();
  const read = parseChatThread(thread("steward", [{ ...message(1), cardRefs: ["c1"], fresh: true, uploadVerdicts: [], more: { a: 1 } }]));
  assert.deepEqual(read.messages, [message(1)]);
});

test("a message's quote is null or missing, a message quote or a card quote, and nothing else", async () => {
  const { parseChatThread } = await load();
  const quoted = (quote) => parseChatThread(thread("steward", [message(1, { quote })])).messages[0];
  const mine = { id: "m0", from: "captain", at: STAMP, text: "the line" };
  assert.equal("quote" in quoted(null), false);
  assert.equal("quote" in quoted(undefined), false);
  assert.deepEqual(quoted(mine).quote, mine);
  assert.deepEqual(quoted({ ...mine, from: "bot", more: 1 }).quote, { ...mine, from: "bot" });
  assert.deepEqual(quoted({ cardId: "Q176", version: 3 }).quote, { cardId: "Q176", version: 3 });
  assert.deepEqual(quoted({ cardId: "a1", version: 1, more: 1 }).quote, { cardId: "a1", version: 1 });
  assert.equal(quoted({ ...mine, text: "x".repeat(4000) }).quote.text.length, 4000);
  assert.equal(quoted({ ...mine, text: "\u{1F600}".repeat(4000) }).quote.text.length, 8000);
  const bads = ["x", [], {}, { text: "x" }, { ...mine, from: "someone" }, { ...mine, id: "" }, { ...mine, at: "soon" }, { ...mine, at: "" }, { ...mine, text: 5 }, { ...mine, text: "x".repeat(4001) }, { ...mine, text: "\u{1F600}".repeat(4001) }, { id: "m0", text: "x" }, { cardId: "Q176" }, { cardId: "Q176", version: 0 }, { cardId: "Q176", version: 1.5 }, { cardId: "Q176", version: "3" }, { cardId: "", version: 1 }, { cardId: "a/b", version: 1 }, { cardId: "-x", version: 1 }, { cardId: "x".repeat(65), version: 1 }, { ...mine, cardId: "Q176", version: 3 }];
  for (const bad of bads) assert.throws(() => quoted(bad), unreadable, JSON.stringify(bad));
});

test("a message's files are missing or empty, or a list whose bad items are dropped: a blocked item has no url, ids run to 255 characters, at most 50 are kept, and only files that are not a list are unreadable", async () => {
  const { parseChatThread } = await load();
  const filed = (files) => parseChatThread(thread("steward", [message(1, { files })])).messages[0];
  const item = (id, extra = {}) => ({ ...FILE, id, url: "/captain/api/files/" + id, ...extra });
  assert.equal("attachments" in filed(undefined), false);
  assert.equal("attachments" in filed([]), false);
  assert.deepEqual(filed([{ ...FILE, more: 1 }]).attachments, [SHOWN]);
  assert.deepEqual(filed([FILE, item("f-2", { kind: "file", name: "b.pdf", type: "application/pdf" })]).attachments.map((one) => [one.id, one.kind]), [["f-1", "photo"], ["f-2", "file"]]);
  const blocked = { id: "f-9", name: "run.exe", type: "application/x-msdownload", size: 7, sha256: "a".repeat(64), kind: "blocked" };
  assert.deepEqual(filed([blocked]).attachments, [{ id: "f-9", name: "run.exe", size: 7, type: "application/x-msdownload", kind: "blocked", url: "" }]);
  const long = "A".repeat(255);
  assert.deepEqual(filed([item(long), item("B".repeat(256))]).attachments.map((one) => one.id), [long]);
  assert.deepEqual(filed([item("f-3", { sha256: "b".repeat(64) }), item("f-4", { sha256: "not a hash" })]).attachments.map((one) => one.id), ["f-3"]);
  assert.deepEqual(filed(Array.from({ length: 60 }, (_, n) => item("f-" + n))).attachments.map((one) => one.id), Array.from({ length: 50 }, (_, n) => "f-" + n));
  const bads = ["f-1", null, {}, [], 5, { ...FILE, url: undefined }, { ...blocked, url: "/captain/api/files/f-9" }, { ...FILE, id: "a/b", url: "/captain/api/files/a/b" }, { ...FILE, id: "", url: "/captain/api/files/" }, { ...FILE, name: 5 }, { ...FILE, name: "" }, { ...FILE, type: 5 }, { ...FILE, size: -1 }, { ...FILE, size: 1.5 }, { ...FILE, size: "10" }, { ...FILE, kind: "video" }, { ...FILE, kind: undefined }];
  for (const bad of bads) assert.deepEqual(filed([bad, item("f-5")]).attachments.map((one) => one.id), ["f-5"], JSON.stringify(bad));
  for (const bad of ["f-1", {}, null, 5]) assert.throws(() => filed(bad), unreadable, JSON.stringify(bad));
});

test("a photo or file item is kept only when its url is exactly its own files path: another host, a javascript url and another id's url are each dropped, and the rest of the message stays", async () => {
  const { parseChatThread } = await load();
  const filed = (files) => parseChatThread(thread("steward", [message(1, { files })])).messages[0];
  const kept = { ...FILE, id: "f-5", url: "/captain/api/files/f-5" };
  for (const url of ["https://qd.test/captain/api/files/f-1", "//qd.test/captain/api/files/f-1", "javascript:alert(1)", "/captain/api/files/f-2", "/captain/api/files/f-1?x=1", "/captain/api/files/f-1/", " /captain/api/files/f-1"]) {
    const read = filed([{ ...FILE, url }, kept]);
    assert.deepEqual(read.attachments.map((one) => one.id), ["f-5"], url);
    assert.equal(read.text, "text 1", url);
  }
});

test("the sent message's answer is one flat object and carries the new token", async () => {
  const { chatReceiptOf } = await load();
  const got = chatReceiptOf(receipt(), "client-9");
  assert.deepEqual(got, { ...message(9, { from: "captain", clientId: "client-9" }), uploadVerdicts: [], csrf: "token-9", freshUntil: 1793000000 });
});

test("an answer that is nested, from the bot, for another clientId, with verdicts or without a token is not confirmed", async () => {
  const { chatReceiptOf } = await load();
  const flat = receipt();
  const nested = { message: { ...message(9, { from: "captain", clientId: "client-9" }), uploadVerdicts: [] }, csrf: "token-9", freshUntil: 1793000000 };
  assert.throws(() => chatReceiptOf(nested, "client-9"), notConfirmed);
  assert.throws(() => chatReceiptOf({ ...flat, from: "bot" }, "client-9"), notConfirmed);
  assert.throws(() => chatReceiptOf(flat, "client-other"), notConfirmed);
  assert.throws(() => chatReceiptOf({ ...flat, uploadVerdicts: [{ filename: "a" }] }, "client-9"), notConfirmed);
  assert.throws(() => chatReceiptOf({ ...flat, uploadVerdicts: undefined }, "client-9"), notConfirmed);
  assert.throws(() => chatReceiptOf({ ...flat, csrf: undefined }, "client-9"), notConfirmed);
  assert.throws(() => chatReceiptOf({ ...flat, freshUntil: "soon" }, "client-9"), notConfirmed);
  assert.throws(() => chatReceiptOf("sent", "client-9"), notConfirmed);
});

test("the sent message's answer reads the same quote and files as a thread message", async () => {
  const { chatReceiptOf } = await load();
  const got = chatReceiptOf(receipt({ quote: { cardId: "Q176", version: 3 }, files: [FILE] }), "client-9");
  assert.deepEqual(got.quote, { cardId: "Q176", version: 3 });
  assert.deepEqual(got.attachments, [SHOWN]);
  assert.equal(got.uploadVerdicts.length, 0);
  assert.throws(() => chatReceiptOf(receipt({ quote: { text: "x" } }), "client-9"), notConfirmed);
  assert.throws(() => chatReceiptOf(receipt({ files: "f-1" }), "client-9"), notConfirmed);
});

test("the mark-read body holds exactly the bot, upTo and token, as the contract's sample does", async () => {
  const { readBody, CHAT_WORDS } = await load();
  const body = readBody("bot-a", "Mb0a4", "CSRF");
  assert.deepEqual(Object.keys(JSON.parse(body)), ["bot", "upTo", "csrf"]);
  assert.deepEqual(JSON.parse(body), sample("read-request.json"));
  assert.throws(() => readBody("has space", "Mb0a4", "CSRF"), refusedWith(CHAT_WORDS.bot));
  assert.throws(() => readBody("bot-a", "", "CSRF"), refusedWith(CHAT_WORDS.mail));
  assert.throws(() => readBody("bot-a", "x".repeat(513), "CSRF"), refusedWith(CHAT_WORDS.mail));
  assert.throws(() => readBody("bot-a", "Mb0a4", ""), refusedWith(CHAT_WORDS.token));
});

test("the mark-read answer is exactly csrf and freshUntil, other keys are ignored, and anything else is not confirmed", async () => {
  const { readReceiptOf } = await load();
  assert.deepEqual(readReceiptOf(sample("read-answer.json")), { csrf: "CSRF2", freshUntil: 1794000060 });
  assert.deepEqual(readReceiptOf({ csrf: "t", freshUntil: 1, more: true }), { csrf: "t", freshUntil: 1 });
  for (const bad of [null, "ok", [], {}, { csrf: "t" }, { freshUntil: 1 }, { csrf: 5, freshUntil: 1 }, { csrf: "t", freshUntil: "soon" }, { csrf: "t", freshUntil: null }, { csrf: "t", freshUntil: Infinity }, { message: { csrf: "t", freshUntil: 1 } }]) {
    assert.throws(() => readReceiptOf(bad), notConfirmed, JSON.stringify(bad));
  }
});

test("the checks before a send refuse empty or long text, a bad clientId, files and a quote with plain words", async () => {
  const { checkOutgoing, CHAT_WORDS } = await load();
  const ok = { text: "hello", clientId: "client-1" };
  assert.doesNotThrow(() => checkOutgoing("steward", ok));
  assert.doesNotThrow(() => checkOutgoing("steward", { ...ok, text: "x".repeat(4000) }));
  assert.doesNotThrow(() => checkOutgoing("steward", { ...ok, text: "\u{1F600}".repeat(4000) }));
  assert.throws(() => checkOutgoing("steward", { ...ok, text: "" }), refusedWith(CHAT_WORDS.text));
  assert.throws(() => checkOutgoing("steward", { ...ok, text: "x".repeat(4001) }), refusedWith(CHAT_WORDS.text));
  assert.throws(() => checkOutgoing("steward", { ...ok, text: "\u{1F600}".repeat(4001) }), refusedWith(CHAT_WORDS.text));
  for (const clientId of ["", "has space", "x".repeat(81), "a/b"]) assert.throws(() => checkOutgoing("steward", { ...ok, clientId }), /^Refused|Not sent/, clientId);
  assert.throws(() => checkOutgoing("steward", { ...ok, files: [{ name: "a.png" }] }), refusedWith(CHAT_WORDS.files));
  assert.throws(() => checkOutgoing("steward", { ...ok, files: ["a/b"] }), refusedWith(CHAT_WORDS.files));
  assert.doesNotThrow(() => checkOutgoing("steward", { ...ok, files: ["f-1", "A".repeat(255)] }));
  assert.doesNotThrow(() => checkOutgoing("steward", { ...ok, text: "", files: ["f-1"] }));
  assert.throws(() => checkOutgoing("steward", { ...ok, text: "", files: [] }), refusedWith(CHAT_WORDS.text));
  assert.throws(() => checkOutgoing("steward", { ...ok, quote: { text: "x" } }), refusedWith(CHAT_WORDS.quoteGone));
  assert.doesNotThrow(() => checkOutgoing("steward", { ...ok, files: [] }));
  assert.throws(() => checkOutgoing("", ok), refusedWith(CHAT_WORDS.bot));
  assert.throws(() => checkOutgoing("has space", ok), refusedWith(CHAT_WORDS.bot));
});

test("the words are the ones section D gives, and the mail refusal is the chat's failure line, Not Delivered, as iMessage words it", async () => {
  const { CHAT_WORDS } = await load();
  const { loadTs } = await import("../../tools/load-ts.mjs");
  const { SEND_FAILED_TEXT } = await loadTs("src/domain/chat.ts");
  assert.equal(CHAT_WORDS.bot, "This bot is not in your chat list.");
  assert.equal(CHAT_WORDS.text, "Message is empty or too long.");
  assert.deepEqual([CHAT_WORDS.mail, SEND_FAILED_TEXT], ["Not Delivered", "Not Delivered"]);
});

test("the request body holds exactly the bot, text, clientId and token, and stays under 16 KiB", async () => {
  const { chatBody, CHAT_WORDS } = await load();
  const body = chatBody("steward", { text: "hello", clientId: "client-1" }, "token-1");
  assert.deepEqual(Object.keys(JSON.parse(body)), ["bot", "text", "clientId", "csrf"]);
  assert.deepEqual(JSON.parse(body), { bot: "steward", text: "hello", clientId: "client-1", csrf: "token-1" });
  assert.throws(() => chatBody("steward", { text: "\u0001".repeat(4000), clientId: "client-1" }, "token-1"), refusedWith(CHAT_WORDS.text));
  assert.throws(() => chatBody("steward", { text: "hello", clientId: "client-1" }, ""), /Not sent/);
});

test("a body with files carries the uploaded ids after the token, key for key as the contract's sample, and a body with none has no files key", async () => {
  const { chatBody } = await load();
  const body = chatBody("bot-a", { text: "Two files.", clientId: "k5", files: ["f-7Qk2Lm9Xz", "f-3Hs8Pa1Wq"] }, "CSRF");
  assert.deepEqual(Object.keys(JSON.parse(body)), Object.keys(sample("send-files.json")));
  assert.deepEqual(JSON.parse(body), sample("send-files.json"));
  assert.deepEqual(Object.keys(JSON.parse(chatBody("bot-a", { text: "x", clientId: "k6", files: [] }, "CSRF"))), ["bot", "text", "clientId", "csrf"]);
  assert.deepEqual(JSON.parse(chatBody("bot-a", { text: "", clientId: "k7", files: ["f-1"] }, "CSRF")).text, "");
});

test("an upload's answer is one flat object with the file's id, name, type, size and kind and a new token, and anything else is not confirmed", async () => {
  const { uploadReceiptOf } = await load();
  const answer = { id: "f-7Qk2Lm9Xz", name: "screenshot.png", type: "image/png", size: 482113, sha256: "c".repeat(64), kind: "photo", csrf: "CSRF2", freshUntil: 1794000060 };
  assert.deepEqual(uploadReceiptOf(answer), { id: answer.id, name: answer.name, type: answer.type, size: answer.size, kind: answer.kind, csrf: answer.csrf, freshUntil: answer.freshUntil });
  assert.equal(uploadReceiptOf({ ...answer, kind: "file", more: 1 }).kind, "file");
  const bads = [null, "ok", [], { ...answer, id: "a/b" }, { ...answer, id: "B".repeat(256) }, { ...answer, kind: "blocked" }, { ...answer, kind: undefined }, { ...answer, csrf: undefined }, { ...answer, csrf: 5 }, { ...answer, freshUntil: "soon" }, { ...answer, size: -1 }, { ...answer, name: "" }, { ...answer, type: 5 }, { file: answer }];
  for (const bad of bads) assert.throws(() => uploadReceiptOf(bad), notConfirmed, JSON.stringify(bad));
});

test("a quote goes out as the contract's two shapes only, and a body with a quote is the sample's, key for key", async () => {
  const { chatBody, checkOutgoing, CHAT_WORDS } = await load();
  const message = { text: "Yes, that one.", clientId: "k3", quote: { id: "Mb0a2", text: "It matches." } };
  const card = { text: "Talk to me about this.", clientId: "k4", quote: { cardId: "Q176", version: 3 } };
  assert.deepEqual(JSON.parse(chatBody("bot-a", message, "CSRF")), sample("send-quote-message.json"));
  assert.deepEqual(Object.keys(JSON.parse(chatBody("bot-a", message, "CSRF"))), Object.keys(sample("send-quote-message.json")));
  assert.deepEqual(JSON.parse(chatBody("bot-a", card, "CSRF")), sample("send-quote-card.json"));
  assert.equal("quote" in JSON.parse(chatBody("bot-a", { text: "hello", clientId: "k5" }, "CSRF")), false);
  assert.doesNotThrow(() => checkOutgoing("bot-a", message));
  assert.doesNotThrow(() => checkOutgoing("bot-a", card));
  assert.doesNotThrow(() => checkOutgoing("bot-a", { ...message, quote: { id: "Mb0a2", text: "x".repeat(280) } }));
  assert.doesNotThrow(() => checkOutgoing("bot-a", { ...message, quote: { id: "Mb0a2", text: "\u{1F600}".repeat(280) } }));
  for (const bad of [{ text: "x" }, { id: "", text: "x" }, { id: "Mb0a2", text: "" }, { id: "Mb0a2", text: "x".repeat(281) }, { id: "Mb0a2", text: "\u{1F600}".repeat(281) }, { id: 5, text: "x" }, { cardId: "Q176", version: 0 }, { cardId: "Q176", version: 1.5 }, { cardId: "has space", version: 1 }, { cardId: "Q176" }, { id: "Mb0a2", text: "x", from: "bot" }, "quote", 5])
    assert.throws(() => checkOutgoing("bot-a", { ...message, quote: bad }), refusedWith(CHAT_WORDS.quoteGone), JSON.stringify(bad));
  assert.equal(CHAT_WORDS.quoteGone, "Not sent: that message is no longer in this chat.");
});

test("a bot is made from the id and note, with an avatar colour from the id", async () => {
  const { botOf } = await load();
  const bot = botOf({ id: "steward", note: "the steward" }, 3);
  assert.equal(bot.id, "steward");
  assert.equal(bot.name, "steward");
  assert.equal(bot.role, "the steward");
  assert.match(bot.color, /^var\(--color-avatar-[1-5]\)$/);
  assert.equal(bot.pinned, false);
  assert.equal(bot.order, 3);
  assert.equal(botOf({ id: "steward", note: "" }, 0).role, "");
  assert.equal(botOf({ id: "steward", note: "" }, 0).color, bot.color);
});

test("a bot's display name comes through on the chat list and the thread answer, and the screen shows it", async () => {
  const { parseChatRows, parseChatThread, botOf, rowsOf, threadOf } = await load();
  const named = { id: "steward", note: "the steward", name: "Steward Lead" };
  const rows = parseChatRows([row("steward", "m1", { bot: named })]);
  assert.deepEqual(rows[0].bot, named);
  assert.equal(rowsOf(rows)[0].bot.name, "Steward Lead");
  const read = parseChatThread(thread("steward", [message(1)], false, { bot: { id: "steward", name: "Steward Lead" } }));
  assert.deepEqual(read.bot, { id: "steward", note: "", name: "Steward Lead" });
  assert.equal(threadOf(read).bot.name, "Steward Lead");
  assert.equal(botOf(named, 0).id, "steward");
});

test("a bot with no name, or a name that is not 1 to 40 code points of plain text, shows its id and the list still loads", async () => {
  const { parseChatRows, parseChatThread, rowsOf, threadOf } = await load();
  assert.equal("name" in parseChatRows([row("steward")])[0].bot, false);
  assert.equal(rowsOf(parseChatRows([row("steward")]))[0].bot.name, "steward");
  for (const name of [7, null, "", "   ", "x".repeat(41), "😀".repeat(41), "Lead\u0007", "Lead\nBot"]) {
    const rows = parseChatRows([row("steward", "m1", { bot: { id: "steward", note: "", name } }), row("iris")]);
    assert.deepEqual([rows.length, "name" in rows[0].bot, rowsOf(rows)[0].bot.name], [2, false, "steward"], JSON.stringify(name));
    assert.equal(threadOf(parseChatThread(thread("steward", [message(1)], false, { bot: { id: "steward", name } }))).bot.name, "steward", JSON.stringify(name));
  }
  assert.equal(rowsOf(parseChatRows([row("steward", "m1", { bot: { id: "steward", note: "", name: "😀".repeat(40) } })]))[0].bot.name, "😀".repeat(40));
});

test("rows for the screen carry the bot, preview, time and unread, and no last or rev", async () => {
  const { rowsOf, parseChatRows } = await load();
  const rows = rowsOf(parseChatRows([row("steward"), row("iris", "m7", { unread: true, rev: 3 })]));
  assert.deepEqual(rows.map((one) => Object.keys(one).sort()), [["at", "bot", "preview", "unread"], ["at", "bot", "preview", "unread"]]);
  assert.deepEqual(rows.map((one) => [one.bot.id, one.bot.order, one.unread]), [["steward", 0, false], ["iris", 1, true]]);
});

test("rows for the screen show a Markdown preview as its plain words, as the Markdown code reads them", async () => {
  const { rowsOf, parseChatRows } = await load();
  const preview = "**L7 check reply** from the stand-in bot.\n\n- first item with `code`\n- second item and a [link](https://example.com/notes)";
  assert.equal(rowsOf(parseChatRows([row("steward", "m1", { preview })]))[0].preview, "L7 check reply from the stand-in bot. first item with code second item and a link");
});

test("a thread for the screen carries its bot, messages, older flag, seen, working, firstUnread and features, and no rev", async () => {
  const { threadOf, parseChatThread } = await load();
  const empty = threadOf(parseChatThread(thread("steward", [message(1)], true)), 2);
  assert.deepEqual([empty.bot.id, empty.bot.order, empty.messages.length, empty.older, empty.seenUpTo, empty.seenAt, empty.working, empty.firstUnread, empty.features], ["steward", 2, 1, true, null, null, null, null, []]);
  const filled = threadOf(parseChatThread(sample("thread-filled.json")), 0);
  assert.deepEqual([filled.seenUpTo, filled.seenAt, filled.firstUnread, filled.features], ["Mc0a3", "2026-11-06T15:45:00-05:00", "Mb0a4", ["quote", "read", "seen", "working", "files"]]);
  assert.deepEqual(filled.working, { note: "reading the card", since: "2026-11-06T15:45:00-05:00", updatedAt: "2026-11-06T15:46:00-05:00" });
  assert.equal("rev" in filled, false);
});

test("an older page goes in front of the held messages, once each, and the older flag is the page's", async () => {
  const { mergeOlder, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(6), message(7), message(8)], true));
  const page = parseChatThread(thread("steward", [message(3), message(4), message(5), message(6)], false));
  const merged = mergeOlder(held, page);
  assert.deepEqual(merged.messages.map((one) => one.id), ["m3", "m4", "m5", "m6", "m7", "m8"]);
  assert.equal(merged.older, false);
});

test("a newest page keeps the held messages before its first known one and takes the page after", async () => {
  const { mergeNewest, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1), message(2), message(3)], true));
  const page = parseChatThread(thread("steward", [message(3), message(4)], true));
  const merged = mergeNewest(held, page);
  assert.deepEqual(merged.messages.map((one) => one.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(merged.older, true);
});

test("a newest page takes its own seen, working, firstUnread, features and rev, with or without a held page", async () => {
  const { mergeNewest, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1), message(2), message(3)], true, META));
  const next = { seenUpTo: "m4", seenAt: "2026-11-06T00:30:00-05:00", working: null, firstUnread: null, features: [], rev: 10 };
  const overlap = mergeNewest(held, parseChatThread(thread("steward", [message(3), message(4)], true, next)));
  assert.deepEqual(metaOf(overlap), next);
  const apart = mergeNewest(held, parseChatThread(thread("steward", [message(20), message(21)], true, next)));
  assert.deepEqual(metaOf(apart), next);
  const none = parseChatThread(thread("steward", [message(1)], false));
  assert.equal(mergeNewest(parseChatThread(thread("steward", [message(1)], false, META)), none).rev, undefined);
  assert.deepEqual(mergeNewest(null, parseChatThread(thread("steward", [message(1)], false, META))).features, ["read", "seen"]);
});

test("an older page changes only the held messages and the older flag: the held seen, working, firstUnread, features and rev stay", async () => {
  const { mergeOlder, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(6), message(7), message(8)], true, META));
  const page = parseChatThread(thread("steward", [message(4), message(5), message(6)], false, { seenUpTo: "m5", seenAt: "2026-11-06T00:01:00-05:00", working: null, firstUnread: "m4", features: [], rev: 3 }));
  const merged = mergeOlder(held, page);
  assert.deepEqual(metaOf(merged), META);
  assert.equal(merged.older, false);
});

test("a sent message changes only the messages: the held seen, working, firstUnread, features and rev stay", async () => {
  const { appendSent, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1)], false, META));
  assert.deepEqual(metaOf(appendSent(held, message(2, { from: "captain", clientId: "c-2" }))), META);
});

test("a newest page that shares nothing with the held messages replaces them", async () => {
  const { mergeNewest, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1), message(2)], false));
  const page = parseChatThread(thread("steward", [message(20), message(21)], true));
  const merged = mergeNewest(held, page);
  assert.deepEqual(merged.messages.map((one) => one.id), ["m20", "m21"]);
  assert.equal(merged.older, true);
});

test("a newest page with nothing held is the page", async () => {
  const { mergeNewest, parseChatThread } = await load();
  const page = parseChatThread(thread("steward", [message(1)], false));
  assert.deepEqual(mergeNewest(null, page), page);
});

test("a sent message is added once and a second add changes nothing", async () => {
  const { appendSent, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1)], false));
  const sent = message(2, { from: "captain", clientId: "c-2" });
  const once = appendSent(held, sent);
  assert.deepEqual(once.messages.map((one) => one.id), ["m1", "m2"]);
  assert.deepEqual(appendSent(once, sent), once);
});

test("a just-sent message missing from a newest read is kept in time order, after the page when it is the newest", async () => {
  const { keepSent, parseChatThread } = await load();
  const mine = message(2, { from: "captain", clientId: "c-2" });
  const between = keepSent(parseChatThread(thread("steward", [message(1), message(3)], false, META)), [mine]);
  assert.deepEqual(between.messages.map((one) => one.id), ["m1", "m2", "m3"]);
  assert.deepEqual(metaOf(between), META);
  assert.deepEqual(keepSent(parseChatThread(thread("steward", [message(1)], false)), [mine]).messages.map((one) => one.id), ["m1", "m2"]);
});

test("a just-sent message the read already has, by id or by clientId, is not added again", async () => {
  const { keepSent, parseChatThread } = await load();
  const mine = message(2, { from: "captain", clientId: "c-2" });
  const byId = parseChatThread(thread("steward", [message(1), message(2, { from: "captain", clientId: "c-2" })], false));
  assert.deepEqual(keepSent(byId, [mine]), byId);
  const byClient = parseChatThread(thread("steward", [message(1), message(7, { from: "captain", clientId: "c-2" })], false));
  assert.deepEqual(keepSent(byClient, [mine]), byClient);
});

test("the open thread is read again only when the row's last is a new id", async () => {
  const { needsThread, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1), message(2), message(3)], false));
  assert.equal(needsThread({ last: "" }, held), false);
  assert.equal(needsThread({ last: "m3" }, held), false);
  assert.equal(needsThread({ last: "m1" }, held), false);
  assert.equal(needsThread({ last: "m9" }, held), true);
});

test("the open thread is also read again when the row's rev differs from the held one, and never when the row has no rev", async () => {
  const { threadStale, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1), message(2), message(3)], false, { rev: 5 }));
  const bare = parseChatThread(thread("steward", [message(1), message(2), message(3)], false));
  assert.equal(threadStale({ last: "m3" }, held), false);
  assert.equal(threadStale({ last: "m3", rev: 5 }, held), false);
  assert.equal(threadStale({ last: "m3", rev: 6 }, held), true);
  assert.equal(threadStale({ last: "m3", rev: 4 }, held), true);
  assert.equal(threadStale({ last: "m3", rev: 0 }, held), true);
  assert.equal(threadStale({ last: "m3", rev: 5 }, bare), true);
  assert.equal(threadStale({ last: "m3" }, bare), false);
  assert.equal(threadStale({ last: "m9", rev: 5 }, held), true);
  assert.equal(threadStale({ last: "m9" }, bare), true);
  assert.equal(threadStale({ last: "", rev: 6 }, held), true);
  assert.equal(threadStale({ last: "" }, held), false);
});

const ODD = "a&b#c/d?e%f+g h";

test("an older page is asked for with the bot and the before id each as one percent-encoded value", async () => {
  const { threadPath } = await load();
  const path = threadPath("steward", ODD);
  assert.equal(path, "/captain/api/chat?bot=steward&before=" + encodeURIComponent(ODD));
  const url = new URL(path, "https://qd.test");
  assert.equal(url.pathname, "/captain/api/chat");
  assert.equal(url.hash, "");
  assert.deepEqual([...url.searchParams.keys()], ["bot", "before"]);
  assert.equal(url.searchParams.get("bot"), "steward");
  assert.equal(url.searchParams.get("before"), ODD);
  assert.equal(path.split("&").length, 2);
  assert.equal(path.split("?").length, 2);
  assert.ok(!/[ #]/.test(path));
});

test("a bot id outside the name grammar is refused before any path is made, and a plain one goes in as it is", async () => {
  const { threadPath, CHAT_WORDS } = await load();
  assert.throws(() => threadPath(ODD), refusedWith(CHAT_WORDS.bot));
  assert.throws(() => threadPath(ODD, "m1"), refusedWith(CHAT_WORDS.bot));
  assert.equal(threadPath("iris.bot-2_x"), "/captain/api/chat?bot=iris.bot-2_x");
});

test("a newer-only read is asked for with the bot and the after id each as one percent-encoded value, and a bad bot or id is refused before any path is made", async () => {
  const { newerPath, CHAT_WORDS } = await load();
  const path = newerPath("steward", ODD);
  assert.equal(path, "/captain/api/chat?bot=steward&after=" + encodeURIComponent(ODD));
  const url = new URL(path, "https://qd.test");
  assert.deepEqual([...url.searchParams.keys()], ["bot", "after"]);
  assert.equal(url.searchParams.get("after"), ODD);
  assert.throws(() => newerPath(ODD, "m1"), refusedWith(CHAT_WORDS.bot));
  assert.throws(() => newerPath("steward", ""), unreadable);
});

test("a thread that lists cursor keeps it among its features", async () => {
  const { parseChatThread } = await load();
  assert.deepEqual(parseChatThread(thread("steward", [message(1)], false, { features: ["cursor", "read"] })).features, ["cursor", "read"]);
});

test("a newer-only answer keeps the held messages through the cursor, then the answer's messages in its order, with its seen, working, firstUnread, features and rev and the held older flag", async () => {
  const { mergeAfter, parseChatThread } = await load();
  const held = parseChatThread(thread("steward", [message(1), message(2), message(3, { from: "captain", clientId: "c-3" })], true, { features: ["cursor"], rev: 4 }));
  const next = { ...META, features: ["cursor"], rev: 10 };
  const merged = mergeAfter(held, "m2", parseChatThread(thread("steward", [message(4), message(5)], false, next)));
  assert.deepEqual(merged.messages.map((one) => one.id), ["m1", "m2", "m4", "m5"]);
  assert.equal(merged.older, true);
  assert.deepEqual(metaOf(merged), next);
  const gone = mergeAfter(held, "m9", parseChatThread(thread("steward", [message(3, { from: "captain", clientId: "c-3" }), message(4)], false, next)));
  assert.deepEqual(gone.messages.map((one) => one.id), ["m1", "m2", "m3", "m4"], "a cursor no longer held drops nothing and adds each message once");
});

test("text, note, ids and refs reach the screen as the same strings, and the preview as its plain words: nothing decoded or turned into markup", async () => {
  const { parseChatRows, parseChatThread, rowsOf, threadOf } = await load();
  const note = " <i>the steward</i> &amp; co \u00e9 ";
  const preview = "  <img src=x onerror=alert(1)> &lt;b&gt;\n";
  const id = "m<b>1</b>&amp;";
  const text = "\t<script>alert(1)</script> &#60; &quot;hi&quot; \r\n  ";
  const refs = ["<a href=\"x\">", "&amp;", " r f "];
  const listed = parseChatRows([{ bot: { id: "steward", note }, preview, at: "2026-11-06T00:11:00-05:00", last: id, unread: false }]);
  assert.equal(listed[0].last, id);
  const rows = rowsOf(listed);
  assert.equal(rows[0].preview, "<img src=x onerror=alert(1)> &lt;b&gt;");
  assert.equal(rows[0].bot.role, note);
  const read = threadOf(parseChatThread(thread("steward", [message(1, { id, text, refs })], false, { bot: { id: "steward", note } })));
  assert.equal(read.bot.role, note);
  assert.equal(read.messages[0].id, id);
  assert.equal(read.messages[0].text, text);
  assert.deepEqual(read.messages[0].refs, refs);
});
