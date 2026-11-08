import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { parseMailList, parseMailThread, threadOf, withMails, placeIds, mailWorld, changedSince } = await loadTs("src/data/mail-client.ts");

const PINNED = {
  "list-5-threads.json": "fce8236706551042e3d0f9cff2dca215d55aae3b2be805f33629d08503bf9d1c",
  "list-empty.json": "895dc67babbce7850292cae152bb26f1717c7f2410fb1b3eb7e8db099c16d9b3",
  "list-not-modified-304.json": "6d5d7e404941aa4406e68329958019e5274f0be4e312d6721bfbffe55251b092",
  "list-truncated-200-threads.json": "b77b1dbe2dd7290b5745b63d2e7ded899b9e352880477cba2f0885e6ed4ac778",
  "thread-cut-long-body.json": "fe6f1b16b12f7edfe604e72068b441310f5be71e1404fd76847802172b1f93f2",
  "thread-html-only.json": "527358f0eff7a561a0775afa622b408fea8b9536658551b7ca3d49511c6108d6",
  "thread-omitted-older-mails.json": "782d33e98c51a9a235a868db7e2307628ffb80ee32498e2c802b9673e85fa0b1",
  "thread-sent-and-received.json": "07f74cc9899d396a3be596ec1b71e00907fe7fe8e8469960cac7849c35cc8830",
  "thread-with-attachments-and-refs.json": "5857cddfa05a623f81af68fbbbb996f5d43bee87655d3f4eea2b6259fda28065",
  "error-400-bad-ref.json": "a62e1a28a2012992de8bf4f6623f1b94719b28df321421f7b22516cbc85696bc",
  "error-401-sign-in-required.json": "1447a390632690d5f395ad08c05ed0f7d31fde2abc0cb38905fd0e7e4eb23e6b",
  "error-403-session-refused.json": "da230cf68add1006f53bc8af8a70df60153a7a3e17abd271c65d8b123ac62c9a",
  "error-404-no-thread.json": "4afa2082951b2ac25e0a479e8acd6b0a52ff2f4700a2c5a624b563baffede791",
  "error-503-request-unavailable.json": "5cb063712fdd8629ae562eee15d1d7f53f05879f8a13e03143ee4a7e55c41eee",
};

const read = (name) => fs.readFileSync(new URL("./server-payloads/mail/" + name, import.meta.url));
const sample = (name) => JSON.parse(read(name).toString("utf8"));
const body = (name) => sample(name).body;

const unreadable = (error) => error?.name === "Refused" && error.message.startsWith("The server's answer could not be read");

function refuses(parse, make, label) {
  const input = make();
  assert.throws(() => parse(input), unreadable, label);
}

const list = () => structuredClone(body("list-5-threads.json"));
const thread = (name = "thread-with-attachments-and-refs.json") => structuredClone(body(name));

const days = (count) => Array.from({ length: count }, (_, n) => new Date(Date.UTC(2026, 10, 2) - n * 86400000).toISOString().slice(0, 10));

const summary = (n, extra = {}) => ({ ref: "MT-" + n, subject: "Subject " + n, project: null, lane: null, card: null, bots: ["bot-a", "account-user"], lastAt: "2026-11-02T09:30:00-05:00", count: 1, days: ["2026-11-02"], ...extra });

const mails = (n, from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ ref: "MT-" + n + "." + (from + i), from: "bot-a", to: ["account-user"], cc: [], at: "2026-11-02T09:30:00-05:00", text: "Mail " + (from + i), cut: false, refs: [], attachments: [] }));

const PLACES = {
  projects: [{ id: "quarterdeck", name: "quarterdeck" }, { id: "heron-forge", name: "heron-forge" }],
  lanes: [
    { id: "l-sea", projectId: "quarterdeck", name: "Search" },
    { id: "l-sw-sea", projectId: "heron-forge", name: "Search" },
    { id: "l-sw1", projectId: "heron-forge", name: "Matrix rooms" },
  ],
};

test("the 14 recorded sample files are the pinned bytes", () => {
  for (const [name, sum] of Object.entries(PINNED)) assert.equal(createHash("sha256").update(read(name)).digest("hex"), sum, name);
});

test("the recorded list reads as five threads in the server's order, each with its summary fields", () => {
  const listing = parseMailList(list());
  assert.deepEqual(listing.threads.map((t) => t.ref), ["MT-5", "MT-4", "MT-3", "MT-2", "MT-1"]);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.threads[4], { ref: "MT-1", subject: "Search group limit: how many rows per group?", project: null, lane: null, card: null, bots: ["repo-lead", "account-user", "bot-a"], lastAt: "2026-11-02T11:40:00-05:00", count: 4, days: ["2026-11-02"] });
  assert.deepEqual(listing.threads[2].days, ["2026-11-04", "2026-11-03"]);
  assert.equal(listing.threads[0].count, 60);
});

test("an empty mailbox and a truncated list read", () => {
  assert.deepEqual(parseMailList(body("list-empty.json")), { threads: [], truncated: false });
  const truncated = parseMailList(body("list-truncated-200-threads.json"));
  assert.equal(truncated.threads.length, 200);
  assert.equal(truncated.truncated, true);
  assert.deepEqual([truncated.threads[0].ref, truncated.threads[199].ref], ["MT-205", "MT-6"]);
});

test("the recorded 304 has no body and carries the list's own ETag header", () => {
  const empty = sample("list-not-modified-304.json");
  assert.equal(empty.status, 304);
  assert.equal(empty.body, null);
  assert.equal(empty.headers.ETag, sample("list-5-threads.json").headers.ETag);
});

test("a list that names a project, a lane and a card reads too, and nothing the contract does not name is kept", () => {
  const placed = { threads: [summary(7, { project: "quarterdeck", lane: "Search", card: "alba-1" })], truncated: false, csrf: "x", freshUntil: 0, surprise: true };
  placed.threads[0].unknown = 1;
  assert.deepEqual(parseMailList(placed), { threads: [summary(7, { project: "quarterdeck", lane: "Search", card: "alba-1" })], truncated: false });
});

test("the list refuses a body that is not the contract's", () => {
  for (const [label, input] of [["null", null], ["array", []], ["text", "x"], ["empty object", {}], ["threads not a list", { threads: {}, truncated: false }], ["no truncated", { threads: [] }], ["truncated not a boolean", { threads: [], truncated: "no" }]]) {
    assert.throws(() => parseMailList(input), unreadable, label);
  }
});

test("the list takes 200 threads and refuses 201", () => {
  const many = (count) => ({ threads: Array.from({ length: count }, (_, n) => summary(count - n)), truncated: count > 200 });
  assert.equal(parseMailList(many(200)).threads.length, 200);
  refuses(parseMailList, () => many(201), "201 threads");
});

test("the list refuses a bad ref, a repeated ref and a missing field", () => {
  for (const ref of ["MT-0", "MT-01", "mt-1", "MT-1.2", "MT-1234567890", "PG-1", "", 7, null]) refuses(parseMailList, () => ({ threads: [summary(1, { ref })], truncated: false }), "ref " + String(ref));
  refuses(parseMailList, () => ({ threads: [summary(1), summary(2, { ref: "MT-1" })], truncated: false }), "repeated ref");
  for (const key of Object.keys(summary(1))) {
    refuses(parseMailList, () => {
      const one = summary(1);
      delete one[key];
      return { threads: [one], truncated: false };
    }, "missing " + key);
  }
});

test("the list refuses a bad subject, place, bot list, time, count or day list", () => {
  const bad = (extra, label) => refuses(parseMailList, () => ({ threads: [summary(1, extra)], truncated: false }), label);
  bad({ subject: "" }, "empty subject");
  bad({ subject: "a".repeat(201) }, "subject of 201");
  bad({ subject: "two\nlines" }, "subject on two lines");
  bad({ subject: 5 }, "subject not text");
  bad({ project: "" }, "empty project");
  bad({ project: 3 }, "project not text");
  bad({ lane: "" }, "empty lane");
  bad({ card: "bad id!" }, "card id");
  bad({ bots: "bot-a" }, "bots not a list");
  bad({ bots: [] }, "no bots");
  bad({ bots: [""] }, "an empty bot name");
  bad({ bots: ["two\nlines"] }, "a bot name on two lines");
  bad({ bots: ["bot-a", "bot-a"] }, "bot repeated");
  bad({ bots: [3] }, "bot not text");
  bad({ lastAt: "2026-11-02T09:52:00" }, "time with no offset");
  bad({ lastAt: "yesterday" }, "time not a time");
  bad({ lastAt: "2026-13-40T00:00:00-05:00" }, "time out of range");
  bad({ lastAt: 5 }, "time not text");
  for (const count of [0, 1.5, "2", -1, null]) bad({ count }, "count " + String(count));
  bad({ days: [] }, "no days");
  bad({ days: ["2026-11-1"] }, "day not YYYY-MM-DD");
  bad({ days: ["2026-02-30"] }, "day not a date");
  bad({ days: ["2026-11-01", "2026-11-02"] }, "days oldest first");
  bad({ days: ["2026-11-02", "2026-11-02"] }, "day repeated");
  bad({ days: days(32) }, "32 days");
  bad({ days: "2026-11-02" }, "days not a list");
  assert.equal(parseMailList({ threads: [summary(1, { subject: "a".repeat(200), days: days(31) })], truncated: false }).threads.length, 1);
});

test("a name that is not shaped like an account is still read, because the OpenAPI asks only for a non-empty line", () => {
  const read1 = parseMailList({ threads: [summary(1, { bots: ["Dr. Kivo", "bot-a"], subject: "one\rline" })], truncated: false });
  assert.deepEqual(read1.threads[0].bots, ["Dr. Kivo", "bot-a"]);
  const input = thread();
  input.thread.mails[0].from = "Dr. Kivo";
  input.thread.mails[0].to = ["bot-a", "Pib"];
  input.thread.mails[0].cc = [];
  const mail = parseMailThread(input).mails[0];
  assert.deepEqual([mail.from, mail.to, mail.cc], ["Dr. Kivo", ["bot-a", "Pib"], []]);
});

test("the recorded thread of four mails reads with its mails oldest first and its summary fields", () => {
  const read1 = parseMailThread(thread());
  assert.deepEqual(read1.summary, { ref: "MT-1", subject: "Search group limit: how many rows per group?", project: null, lane: null, card: null, bots: ["repo-lead", "account-user", "bot-a"], lastAt: "2026-11-02T11:40:00-05:00", count: 4 });
  assert.equal(read1.omitted, 0);
  assert.deepEqual(read1.mails.map((m) => m.ref), ["MT-1.1", "MT-1.2", "MT-1.3", "MT-1.4"]);
  assert.deepEqual(read1.mails[1], { ref: "MT-1.2", from: "bot-a", to: ["repo-lead"], cc: [], at: "2026-11-02T09:30:00-05:00", text: "I wrote the Search notes down as AR-4 and the layout as PG-2.\nWe still need a rows-per-group number.", refs: ["AR-4", "PG-2"] });
});

test("the recorded threads with an HTML-only mail, a mail with LF line ends and a cut mail read", () => {
  const html = parseMailThread(thread("thread-html-only.json"));
  assert.equal(html.mails[0].text, "Weekly build summary\n\nAll 12 builds passed.\n\nCrew: 5 builds\nWeb: 7 builds\n\nDetails: build page.");
  const sent = parseMailThread(thread("thread-sent-and-received.json"));
  assert.deepEqual(sent.mails.map((m) => [m.from, m.to]), [["bot-b", ["account-user"]], ["account-user", ["bot-b"]], ["bot-b", ["account-user"]]]);
  assert.equal(sent.mails[1].text, "Thursday works.\nPlease confirm the build is green first.\nThanks.");
  assert.deepEqual(sent.mails[2].refs, ["AR-12", "PG-7"]);
  const cut = parseMailThread(thread("thread-cut-long-body.json"));
  assert.equal(Buffer.byteLength(cut.mails[0].text), 16384);
});

test("the recorded thread of 60 mails keeps the newest 50 with their true numbers and says how many it left out", () => {
  const read50 = parseMailThread(thread("thread-omitted-older-mails.json"));
  assert.equal(read50.mails.length, 50);
  assert.deepEqual([read50.mails[0].ref, read50.mails[49].ref, read50.omitted, read50.summary.count], ["MT-5.11", "MT-5.60", 10, 60]);
});

test("a thread refuses a body that is not the contract's", () => {
  const edit = (change) => () => {
    const input = thread();
    change(input.thread);
    return input;
  };
  for (const [label, input] of [["null", null], ["no thread", {}], ["thread is a list", { thread: [] }]]) assert.throws(() => parseMailThread(input), unreadable, label);
  refuses(parseMailThread, edit((t) => { t.mails = mails(1, 1, 51); t.count = 51; t.omitted = 0; }), "51 mails");
  refuses(parseMailThread, edit((t) => { t.mails = []; t.count = 4; t.omitted = 4; }), "no mails");
  refuses(parseMailThread, edit((t) => { t.mails[1].ref = "MT-2.2"; }), "a mail of another thread");
  refuses(parseMailThread, edit((t) => { t.mails[1].ref = "MT-1"; }), "a mail ref with no number");
  refuses(parseMailThread, edit((t) => { t.mails.reverse(); }), "mails newest first");
  refuses(parseMailThread, edit((t) => { t.omitted = 1; }), "omitted that does not add up");
  refuses(parseMailThread, edit((t) => { t.count = 5; }), "count above the mails and omitted");
  refuses(parseMailThread, edit((t) => { t.omitted = -1; }), "omitted below zero");
  refuses(parseMailThread, edit((t) => { delete t.omitted; }), "no omitted");
  refuses(parseMailThread, edit((t) => { delete t.mails; }), "no mails list");
  refuses(parseMailThread, edit((t) => { delete t.bots; }), "no bots");
});

test("a thread read in less than 50 mails because the answer would pass 1 MiB still adds up", () => {
  const input = thread();
  input.thread.count = 62;
  input.thread.omitted = 40;
  input.thread.mails = mails(1, 41, 62);
  const short = parseMailThread(input);
  assert.deepEqual([short.mails.length, short.omitted, short.mails[0].ref], [22, 40, "MT-1.41"]);
});

for (const position of [0, 3]) {
  for (const count of [1, 21]) {
    test(`251: non-empty cc of ${count} on mail ${position + 1} refuses the entire thread`, () => {
      const input = thread();
      input.thread.mails[position].cc = Array.from({ length: count }, (_, n) => "bot-" + n);
      assert.throws(() => parseMailThread(input), unreadable);
    });
  }
}

test("a mail refuses a bad writer, recipient list, time, text, cut or references", () => {
  const edit = (change) => () => {
    const input = thread();
    change(input.thread.mails[0]);
    return input;
  };
  refuses(parseMailThread, edit((m) => { m.from = ""; }), "an empty writer");
  refuses(parseMailThread, edit((m) => { m.from = 5; }), "writer not text");
  refuses(parseMailThread, edit((m) => { m.to = []; }), "no recipient");
  refuses(parseMailThread, edit((m) => { m.to = [""]; }), "an empty recipient");
  refuses(parseMailThread, edit((m) => { m.to = Array.from({ length: 21 }, (_, n) => "bot-" + n); }), "21 recipients");
  refuses(parseMailThread, edit((m) => { delete m.to; }), "no recipient list");
  refuses(parseMailThread, edit((m) => { m.cc = "bot-a"; }), "cc not a list");
  refuses(parseMailThread, edit((m) => { m.cc = [""]; }), "an empty cc name");
  refuses(parseMailThread, edit((m) => { m.at = "2026-11-01T16:05:00"; }), "time with no offset");
  refuses(parseMailThread, edit((m) => { m.text = "a".repeat(16384) + "b"; }), "text over 16384 bytes");
  refuses(parseMailThread, edit((m) => { m.text = "\u00e9".repeat(8193); }), "text over 16384 bytes in UTF-8");
  refuses(parseMailThread, edit((m) => { m.text = "one\r\ntwo"; }), "a carriage return");
  refuses(parseMailThread, edit((m) => { m.text = "one\rtwo"; }), "a lone carriage return");
  refuses(parseMailThread, edit((m) => { m.text = 5; }), "text not text");
  refuses(parseMailThread, edit((m) => { m.cut = "no"; }), "cut not a boolean");
  refuses(parseMailThread, edit((m) => { m.refs = ["XX-1"]; }), "reference not a code");
  refuses(parseMailThread, edit((m) => { m.refs = ["AR-1", "AR-1"]; }), "reference repeated");
  refuses(parseMailThread, edit((m) => { m.refs = ["MT-3"]; }), "a thread code in the references");
  refuses(parseMailThread, edit((m) => { m.refs = ["MT-3.2"]; }), "a mail code in the references");
  refuses(parseMailThread, edit((m) => { m.refs = ["PG-7", "AR-12"]; }), "a page code before an artifact code");
  refuses(parseMailThread, edit((m) => { m.refs = "AR-1"; }), "references not a list");
  refuses(parseMailThread, edit((m) => { delete m.refs; }), "no references");
});

test("a mail's attachments are required, checked and not kept: names and sizes as the OpenAPI says, and a mail with none attached is read", () => {
  const edit = (change) => () => {
    const input = thread();
    change(input.thread.mails[1]);
    return input;
  };
  const kept = parseMailThread(thread()).mails[1];
  assert.equal("attachments" in kept, false);
  assert.equal("cut" in kept, false);
  refuses(parseMailThread, edit((m) => { delete m.attachments; }), "a mail with no attachments key");
  const none = thread();
  none.thread.mails[1].attachments = [];
  assert.equal("attachments" in parseMailThread(none).mails[1], false);
  refuses(parseMailThread, edit((m) => { m.attachments = "notes.pdf"; }), "attachments not a list");
  refuses(parseMailThread, edit((m) => { m.attachments = ["notes.pdf"]; }), "an attachment that is not a record");
  refuses(parseMailThread, edit((m) => { m.attachments = [{ name: "", size: 1 }]; }), "an attachment with no name");
  refuses(parseMailThread, edit((m) => { m.attachments = [{ name: "a\nb", size: 1 }]; }), "an attachment name on two lines");
  refuses(parseMailThread, edit((m) => { m.attachments = [{ name: "a".repeat(256), size: 1 }]; }), "an attachment name of 256");
  refuses(parseMailThread, edit((m) => { m.attachments = [{ name: "a", size: -1 }]; }), "a negative size");
  refuses(parseMailThread, edit((m) => { m.attachments = [{ name: "a", size: 1.5 }]; }), "a size that is not whole");
  refuses(parseMailThread, edit((m) => { m.attachments = [{ name: "a" }]; }), "an attachment with no size");
  refuses(parseMailThread, edit((m) => { m.attachments = Array.from({ length: 51 }, () => ({ name: "a", size: 1 })); }), "51 attachments");
  const fifty = thread();
  fifty.thread.mails[1].attachments = Array.from({ length: 50 }, (_, n) => ({ name: "f" + n, size: n }));
  assert.equal(parseMailThread(fifty).mails.length, 4);
});

test("a mail takes exactly 16384 bytes and artifact codes then page codes", () => {
  const input = thread();
  const one = input.thread.mails[0];
  one.text = "a".repeat(16384);
  one.cut = true;
  one.refs = ["AR-3", "AR-12", "PG-7"];
  const read1 = parseMailThread(input).mails[0];
  assert.equal(read1.text.length, 16384);
  assert.deepEqual(read1.refs, ["AR-3", "AR-12", "PG-7"]);
});

test("a thread for the screen starts from its list entry: the place by name, the summary kept, no mails yet", () => {
  const placed = parseMailList({ threads: [summary(101, { subject: "Search group limit", project: "quarterdeck", lane: "Search", card: "alba-1", bots: ["alba", "dr-kivo", "iris"], lastAt: "2026-11-02T09:36:00-05:00", count: 4 })], truncated: false }).threads[0];
  assert.deepEqual(threadOf(placed, PLACES), { ref: "MT-101", subject: "Search group limit", projectId: "quarterdeck", laneId: "l-sea", cardId: "alba-1", bots: ["alba", "dr-kivo", "iris"], mails: [], summary: { lastAt: "2026-11-02T09:36:00-05:00", bots: ["alba", "dr-kivo", "iris"], days: ["2026-11-02"], count: 4 } });
  const noPlace = threadOf(parseMailList(list()).threads[0], PLACES);
  assert.deepEqual([noPlace.ref, noPlace.projectId, noPlace.laneId, noPlace.cardId, noPlace.mails], ["MT-5", "", null, null, []]);
});

test("reading a thread adds its mails and its left-out count, and keeps the list's summary and days", () => {
  const listed = threadOf(parseMailList(list()).threads[4], PLACES);
  const read1 = parseMailThread(thread());
  const open = withMails(listed, read1);
  assert.deepEqual(open.mails, read1.mails);
  assert.equal(open.omitted, 0);
  assert.deepEqual(open.summary, { lastAt: "2026-11-02T11:40:00-05:00", bots: ["repo-lead", "account-user", "bot-a"], days: ["2026-11-02"], count: 4 });
  assert.deepEqual([open.ref, open.subject, open.projectId, open.laneId], [listed.ref, listed.subject, listed.projectId, listed.laneId]);
  assert.deepEqual(listed.mails, []);
  assert.equal("omitted" in listed, false);
  const long = withMails(threadOf(parseMailList(list()).threads[0], PLACES), parseMailThread(thread("thread-omitted-older-mails.json")));
  assert.deepEqual([long.omitted, long.mails.length, long.summary.count], [10, 50, 60]);
});

test("a newer list entry keeps the read mails and the left-out count as they were and renews only the summary", () => {
  const older = parseMailList(list()).threads[4];
  const read1 = parseMailThread(thread());
  const newer = { ...older, count: 5, lastAt: "2026-11-02T12:10:00-05:00", bots: [...older.bots, "bot-b"], days: ["2026-11-02"] };
  const open = withMails(threadOf(newer, PLACES), read1);
  assert.deepEqual(open.mails, read1.mails);
  assert.equal(open.omitted, 0);
  assert.deepEqual(open.summary, { lastAt: "2026-11-02T12:10:00-05:00", bots: ["repo-lead", "account-user", "bot-a", "bot-b"], days: ["2026-11-02"], count: 5 });
});

test("a thread has changed since its read when the list's last time or count differs from the read's", () => {
  const listed = parseMailList(list()).threads[4];
  const read1 = parseMailThread(thread());
  assert.equal(changedSince(listed, read1), false);
  assert.equal(changedSince({ ...listed, count: 5 }, read1), true);
  assert.equal(changedSince({ ...listed, lastAt: "2026-11-02T12:10:00-05:00" }, read1), true);
  assert.equal(changedSince({ ...listed, bots: ["other"], days: ["2026-11-01"] }, read1), false);
});

test("the world's mail is the held list in the server's order, each read thread carrying its mails and left-out count, and nothing when no list is held", () => {
  assert.deepEqual(mailWorld(null, new Map(), PLACES), []);
  const listing = parseMailList(list()).threads;
  const reads = new Map([["MT-1", parseMailThread(thread())], ["MT-5", parseMailThread(thread("thread-omitted-older-mails.json"))], ["MT-99", parseMailThread(thread())]]);
  const world = mailWorld(listing, reads, PLACES);
  assert.deepEqual(world.map((item) => item.ref), ["MT-5", "MT-4", "MT-3", "MT-2", "MT-1"]);
  assert.deepEqual([world[0].mails.length, world[0].omitted, world[0].summary.count], [50, 10, 60]);
  assert.deepEqual([world[4].mails.length, world[4].omitted], [4, 0]);
  assert.deepEqual([world[1].mails, "omitted" in world[1]], [[], false]);
  assert.deepEqual(world[1], threadOf(listing[1], PLACES));
});

test("the world's mail places a thread through the places each time it is built", () => {
  const placed = parseMailList({ threads: [summary(4, { project: "quarterdeck", lane: "Search" })], truncated: false }).threads;
  assert.deepEqual(mailWorld(placed, new Map(), { projects: [], lanes: [] })[0].laneId, null);
  assert.deepEqual(mailWorld(placed, new Map(), PLACES)[0].laneId, "l-sea");
});

test("a name of 255 characters and a bot list of 50 read, and 256 characters and 51 bots are refused (the frozen OpenAPI's caps)", () => {
  const wide = "\u{1F600}".repeat(255);
  const fifty = Array.from({ length: 50 }, (_, n) => "bot-" + n);
  assert.deepEqual(parseMailList({ threads: [summary(1, { bots: [wide, "n".repeat(255)] })], truncated: false }).threads[0].bots, [wide, "n".repeat(255)]);
  assert.equal(parseMailList({ threads: [summary(1, { bots: fifty })], truncated: false }).threads[0].bots.length, 50);
  refuses(parseMailList, () => ({ threads: [summary(1, { bots: ["n".repeat(256)] })], truncated: false }), "a bot name of 256 in the list");
  refuses(parseMailList, () => ({ threads: [summary(1, { bots: ["\u{1F600}".repeat(256)] })], truncated: false }), "a bot name of 256 characters made of two-unit characters");
  refuses(parseMailList, () => ({ threads: [summary(1, { bots: [...fifty, "bot-50"] })], truncated: false }), "51 bots in the list");
  const edit = (change) => () => {
    const input = thread();
    change(input.thread);
    return input;
  };
  assert.equal(parseMailThread(edit((t) => { t.bots = fifty; })()).summary.bots.length, 50);
  assert.equal(parseMailThread(edit((t) => { t.mails[0].from = wide; t.mails[0].to = [wide]; t.mails[0].cc = []; })()).mails[0].from, wide);
  refuses(parseMailThread, edit((t) => { t.bots = [...fifty, "bot-50"]; }), "51 bots in a thread read");
  refuses(parseMailThread, edit((t) => { t.bots = ["n".repeat(256)]; }), "a bot name of 256 in a thread read");
  refuses(parseMailThread, edit((t) => { t.mails[0].from = "n".repeat(256); }), "a from name of 256");
  refuses(parseMailThread, edit((t) => { t.mails[0].to = ["n".repeat(256)]; }), "a to name of 256");
  refuses(parseMailThread, edit((t) => { t.mails[0].cc = ["n".repeat(256)]; }), "a cc name of 256");
});

test("a name maps to its id through the places, project and lane together", () => {
  assert.deepEqual(placeIds(PLACES, "quarterdeck", "Search"), { projectId: "quarterdeck", laneId: "l-sea" });
  assert.deepEqual(placeIds(PLACES, "heron-forge", "Search"), { projectId: "heron-forge", laneId: "l-sw-sea" });
  assert.deepEqual(placeIds(PLACES, "quarterdeck", "Matrix rooms"), { projectId: "quarterdeck", laneId: null });
});

test("a name the places do not know stays as the name for the project, and a lane with no id is null", () => {
  assert.deepEqual(placeIds(PLACES, "dale-tools", "Task export"), { projectId: "dale-tools", laneId: null });
  assert.deepEqual(placeIds(PLACES, "quarterdeck", "Nope"), { projectId: "quarterdeck", laneId: null });
  assert.deepEqual(placeIds(PLACES, null, null), { projectId: "", laneId: null });
  assert.deepEqual(placeIds(PLACES, null, "Search"), { projectId: "", laneId: null });
  assert.deepEqual(placeIds(PLACES, "quarterdeck", null), { projectId: "quarterdeck", laneId: null });
});

test("places made from the cards list, where the name is the id and a lane id is project/lane, map the same way", () => {
  const places = { projects: [{ id: "Repo", name: "Repo" }], lanes: [{ id: "Repo/Review", projectId: "Repo", name: "Review" }] };
  assert.deepEqual(placeIds(places, "Repo", "Review"), { projectId: "Repo", laneId: "Repo/Review" });
});
