import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { answerBody, commentBody, answerReceiptOf, commentReceiptOf } = await loadTs("src/data/answer-body.ts");

const payload = (name) => JSON.parse(fs.readFileSync(new URL("./server-payloads/answer/" + name, import.meta.url), "utf8"));
const CURRENT = payload("answer-200-current.json");
const STALE = payload("answer-200-stale.json");
const COMMENT = payload("comment-200.json");

const refused = { name: "Refused" };
const unconfirmed = { name: "NotConfirmed" };
const keys = (json) => Object.keys(JSON.parse(json)).sort();

test("an answer body holds exactly rev, pick, note and csrf, and the csrf goes in the body", () => {
  const json = answerBody({ rev: 3, pick: "A", note: "Yes, go." }, "token-1");
  assert.deepEqual(keys(json), ["csrf", "note", "pick", "rev"]);
  assert.deepEqual(JSON.parse(json), { rev: 3, pick: "A", note: "Yes, go.", csrf: "token-1" });
});

test("a pick is one capital letter, cant-decide or none, and nothing else", () => {
  for (const pick of ["A", "B", "D", "Z", "cant-decide", "none"]) assert.doesNotThrow(() => answerBody({ rev: 1, pick, note: "" }, "t"), pick);
  for (const pick of ["", "a", "AA", "A.", "None", "cant decide", "approve", "reject", " A", 1, null, undefined]) assert.throws(() => answerBody({ rev: 1, pick, note: "" }, "t"), refused, String(pick));
});

test("the note may be empty, and is at most 4000 characters counted by code point", () => {
  assert.doesNotThrow(() => answerBody({ rev: 1, pick: "A", note: "" }, "t"));
  assert.doesNotThrow(() => answerBody({ rev: 1, pick: "A", note: "x".repeat(4000) }, "t"));
  assert.throws(() => answerBody({ rev: 1, pick: "A", note: "x".repeat(4001) }, "t"), refused);
  const emoji = "\u{1F600}".repeat(4000);
  assert.equal(emoji.length, 8000);
  assert.doesNotThrow(() => answerBody({ rev: 1, pick: "A", note: emoji }, "t"));
  assert.throws(() => answerBody({ rev: 1, pick: "A", note: emoji + "\u{1F600}" }, "t"), refused);
  assert.throws(() => answerBody({ rev: 1, pick: "A", note: 5 }, "t"), refused);
});

test("a body over 16 KiB of UTF-8 is refused even when the note is within 4000 characters", () => {
  const escaped = "\u0001".repeat(3000);
  assert.ok(JSON.stringify(escaped).length > 16384);
  assert.throws(() => answerBody({ rev: 1, pick: "A", note: escaped }, "t"), refused);
  const json = answerBody({ rev: 1, pick: "A", note: "\u{1F600}".repeat(4000) }, "t");
  assert.ok(new TextEncoder().encode(json).length <= 16384);
});

test("rev must be a whole number that is not negative", () => {
  for (const rev of [0, 1, 3, 40]) assert.doesNotThrow(() => answerBody({ rev, pick: "A", note: "" }, "t"), String(rev));
  for (const rev of [-1, 1.5, NaN, Infinity, "1", null, undefined, 2 ** 60]) assert.throws(() => answerBody({ rev, pick: "A", note: "" }, "t"), refused, String(rev));
});

test("a token must be a non-empty string", () => {
  for (const csrf of ["", null, undefined, 5]) assert.throws(() => answerBody({ rev: 1, pick: "A", note: "" }, csrf), refused, String(csrf));
  for (const csrf of ["", null, undefined, 5]) assert.throws(() => commentBody({ text: "hi", requestId: "r1" }, csrf), refused, String(csrf));
});

test("a comment body holds exactly text, requestId and csrf", () => {
  const json = commentBody({ text: "Five fits the phone.", requestId: "req_1-A" }, "token-2");
  assert.deepEqual(keys(json), ["csrf", "requestId", "text"]);
  assert.deepEqual(JSON.parse(json), { text: "Five fits the phone.", requestId: "req_1-A", csrf: "token-2" });
});

test("a comment is 1 to 4000 characters by code point and has a requestId of 1 to 80 of A-Z a-z 0-9 _ -", () => {
  const ok = (text, requestId) => commentBody({ text, requestId }, "t");
  assert.doesNotThrow(() => ok("x", "a"));
  assert.doesNotThrow(() => ok("x".repeat(4000), "A".repeat(80)));
  assert.doesNotThrow(() => ok("\u{1F600}".repeat(4000), "z_-9"));
  assert.throws(() => ok("", "a"), refused);
  assert.throws(() => ok("x".repeat(4001), "a"), refused);
  assert.throws(() => ok("\u{1F600}".repeat(4001), "a"), refused);
  assert.throws(() => ok("x", ""), refused);
  assert.throws(() => ok("x", "a".repeat(81)), refused);
  for (const requestId of ["a b", "a.b", "a/b", "caf\u00e9", "a\n", 7, null]) assert.throws(() => ok("x", requestId), refused, String(requestId));
  assert.throws(() => ok(5, "a"), refused);
});

test("an answer receipt carries message, stale, rev and the new token, for the current and for an older revision", () => {
  assert.deepEqual(answerReceiptOf(CURRENT), { message: "Got it: alba-1 A at 9:05 AM ET", stale: false, rev: 3, csrf: "sample-csrf-after-answer", freshUntil: 1793836800.5 });
  const stale = answerReceiptOf(STALE);
  assert.deepEqual([stale.stale, stale.rev], [true, 2]);
});

test("extra fields in a receipt are ignored, and are not passed on", () => {
  const receipt = answerReceiptOf({ ...CURRENT, card: { id: "alba-1" }, later: 1 });
  assert.deepEqual(Object.keys(receipt).sort(), ["csrf", "freshUntil", "message", "rev", "stale"]);
});

test("a receipt with a missing or wrong-typed field is not confirmed, never refused", () => {
  for (const key of ["message", "stale", "rev", "csrf", "freshUntil"]) {
    const without = Object.fromEntries(Object.entries(CURRENT).filter(([name]) => name !== key));
    assert.throws(() => answerReceiptOf(without), unconfirmed, "missing " + key);
  }
  for (const [key, value] of [["message", 5], ["stale", "false"], ["rev", 1.5], ["rev", "3"], ["csrf", 9], ["freshUntil", "1"], ["freshUntil", NaN], ["freshUntil", null]]) {
    assert.throws(() => answerReceiptOf({ ...CURRENT, [key]: value }), unconfirmed, key + "=" + String(value));
  }
  for (const raw of [null, [], "ok", 7, undefined]) assert.throws(() => answerReceiptOf(raw), unconfirmed);
});

test("a comment receipt is status sent with the new token; anything else is not confirmed", () => {
  assert.deepEqual(commentReceiptOf(COMMENT), { csrf: "sample-csrf-after-comment", freshUntil: 1793836800.75 });
  assert.deepEqual(Object.keys(commentReceiptOf({ ...COMMENT, more: 1 })).sort(), ["csrf", "freshUntil"]);
  for (const raw of [{ ...COMMENT, status: "queued" }, { ...COMMENT, status: undefined }, { ...COMMENT, csrf: 4 }, { ...COMMENT, freshUntil: "x" }, null, []]) assert.throws(() => commentReceiptOf(raw), unconfirmed);
});
