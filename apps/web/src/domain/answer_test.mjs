import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { card, option } from "./fixture.mjs";

const { startAnswer, answerStep, carryAnswer, sendButton, notePlaceholder, confirmPrompt, receiptText, cardKey, CONFIRM_GUARD_MS } = await loadTs("src/domain/answer.ts");
const { sendingText, failedText, canTryAgain, NOT_SURE_TEXT, SIGN_IN_AGAIN_TEXT } = await loadTs("src/domain/card-words.ts");
const { RateLimited, NotConfirmed, Refused, TimedOut, FreshSignInRequired } = await loadTs("src/data/source.ts");

const twoWay = card({ id: "two", options: [option("A", "Show 5 per group", { pick: true }), option("B", "Show all results"), option("C", "Delete history", { door: "one-way", risk: "Gone for good." })] });
const oneWay = card({ id: "one", options: [option("A", "Run it tonight", { pick: true, door: "one-way", risk: "Rooms lose their bridge." }), option("B", "Wait for Wednesday")] });
const noPick = card({ id: "short", options: [option("A", "Keep 5 per group"), option("B", "Show all")] });
const approval = card({ id: "ok" });
const oneWayApproval = card({ id: "hard", approvalDoor: "one-way" });
const highRisk = card({ id: "label", labels: ["high-risk"], options: [option("A", "Undo later", { pick: true, undo: "One click." })] });

const run = (c, events, from = startAnswer(c)) => events.reduce((state, event) => answerStep(c, state, event), from);

test("a new version of the card keeps his choice by letter and his note, and drops a letter it no longer has", () => {
  const mine = run(twoWay, [{ type: "choose", choice: { kind: "option", letter: "C" } }, { type: "note", text: "After Friday." }]);
  const kept = carryAnswer({ ...twoWay, version: 2, options: [option("A", "Show 4 per group", { pick: true }), option("C", "Delete history")] }, mine);
  assert.deepEqual([kept.choice, kept.note], [{ kind: "option", letter: "C" }, "After Friday."]);
  const gone = carryAnswer({ ...twoWay, version: 2, options: [option("A", "Show 4 per group", { pick: true })] }, mine);
  assert.deepEqual([gone.choice, gone.note], [null, "After Friday."]);
});

test("the bot's pick is chosen when the card opens, so Send names it", () => {
  const state = startAnswer(twoWay);
  assert.deepEqual(state.choice, { kind: "option", letter: "A" });
  assert.deepEqual(sendButton(twoWay, state), { text: "Send A", disabled: false });
});

test("while it sends, the button names the choice with the flow's words", () => {
  const sending = run(twoWay, [{ type: "send", at: 0 }]);
  assert.equal(sendingText(sending), "Sending A ...");
  assert.equal(sendingText(run(twoWay, [{ type: "choose", choice: { kind: "none" } }, { type: "send", at: 0 }])), "Sending None of these ...");
  assert.equal(sendingText(run(approval, [{ type: "send", at: 0, choice: { kind: "approve" } }])), "Sending ...");
});

test("a card without a pick starts with nothing chosen and a disabled Send", () => {
  const state = startAnswer(noPick);
  assert.equal(state.choice, null);
  assert.deepEqual(sendButton(noPick, state), { text: "Send", disabled: true });
  assert.deepEqual(sendButton(noPick, run(noPick, [{ type: "choose", choice: { kind: "option", letter: "B" } }])), { text: "Send B", disabled: false });
});

test("None of these changes the note's placeholder and Send's label, and never asks to confirm", () => {
  const state = run(twoWay, [{ type: "choose", choice: { kind: "none" } }]);
  assert.equal(notePlaceholder(state), "Your own answer, or what would work instead");
  assert.equal(notePlaceholder(startAnswer(twoWay)), "Add a note (optional)");
  assert.deepEqual(sendButton(twoWay, state), { text: "Send: None of these", disabled: false });
  assert.equal(run(twoWay, [{ type: "send", at: 0 }], state).phase, "sending");
});

test("an undoable choice sends in one tap, even on a card labelled high-risk", () => {
  assert.equal(run(twoWay, [{ type: "send", at: 0 }]).phase, "sending");
  assert.equal(run(highRisk, [{ type: "send", at: 0 }]).phase, "sending");
});

test("a one-way pick asks once, in place, and the confirm ignores a fast second tap", () => {
  const asked = run(oneWay, [{ type: "send", at: 1000 }]);
  assert.equal(asked.phase, "confirm");
  assert.deepEqual(confirmPrompt(oneWay, asked), { question: "Send A? This cannot be undone.", button: "Confirm: send A" });
  assert.equal(run(oneWay, [{ type: "confirm", at: 1000 + CONFIRM_GUARD_MS - 1 }], asked).phase, "confirm");
  assert.equal(run(oneWay, [{ type: "confirm", at: 1000 + CONFIRM_GUARD_MS }], asked).phase, "sending");
});

test("choosing a one-way other option asks; the two-way pick did not", () => {
  const state = run(twoWay, [{ type: "choose", choice: { kind: "option", letter: "C" } }, { type: "send", at: 0 }]);
  assert.equal(state.phase, "confirm");
  assert.equal(confirmPrompt(twoWay, state).question, "Send C? This cannot be undone.");
});

test("Back, another choice or typing returns to the answer row with the choice and note kept", () => {
  const asked = run(oneWay, [{ type: "note", text: "Tonight is fine." }, { type: "send", at: 0 }]);
  const back = run(oneWay, [{ type: "back" }], asked);
  assert.deepEqual([back.phase, back.choice, back.note], ["ready", { kind: "option", letter: "A" }, "Tonight is fine."]);
  assert.equal(run(oneWay, [{ type: "note", text: "Tonight." }], asked).phase, "ready");
  const other = run(oneWay, [{ type: "choose", choice: { kind: "option", letter: "B" } }], asked);
  assert.deepEqual([other.phase, other.choice], ["ready", { kind: "option", letter: "B" }]);
});

test("a failed send keeps the choice and the note, and Send tries again", () => {
  const failed = run(twoWay, [{ type: "choose", choice: { kind: "option", letter: "B" } }, { type: "note", text: "Fine." }, { type: "send", at: 0 }, { type: "failed" }]);
  assert.deepEqual([failed.phase, failed.choice, failed.note], ["failed", { kind: "option", letter: "B" }, "Fine."]);
  assert.equal(run(twoWay, [{ type: "send", at: 0 }], failed).phase, "sending");
});

test("a send refused for too many sends this minute says so and to wait, keeps the choice and the note, and Try again sends", () => {
  const failed = run(twoWay, [{ type: "choose", choice: { kind: "option", letter: "B" } }, { type: "note", text: "Fine." }, { type: "send", at: 0 }, { type: "failed", error: new RateLimited() }]);
  assert.deepEqual([failed.phase, failed.choice, failed.note], ["failed", { kind: "option", letter: "B" }, "Fine."]);
  assert.equal(failedText(failed), "Not sent: too many sends this minute. Wait up to a minute, then Try again.");
  assert.equal(run(twoWay, [{ type: "send", at: 0 }], failed).phase, "sending");
});

test("every other failed send says Not sent. Try again., also when the send before it was refused for the rate", () => {
  for (const error of [new NotConfirmed(), new Refused("Not sent: the server gave no sign-in token."), new TypeError("Failed to fetch"), undefined]) {
    assert.equal(failedText(run(twoWay, [{ type: "send", at: 0 }, { type: "failed", error }])), "Not sent. Try again.");
  }
  const limited = run(twoWay, [{ type: "send", at: 0 }, { type: "failed", error: new RateLimited() }]);
  assert.equal(failedText(run(twoWay, [{ type: "send", at: 0 }, { type: "failed", error: new NotConfirmed() }], limited)), "Not sent. Try again.");
});

test("a send cut for time says it may not have been sent and a send that meets a fresh sign-in says to sign in again; both keep his choice and note and offer no Try again", () => {
  for (const [error, words] of [[new TimedOut(), NOT_SURE_TEXT], [new FreshSignInRequired(), SIGN_IN_AGAIN_TEXT]]) {
    const failed = run(twoWay, [{ type: "choose", choice: { kind: "option", letter: "B" } }, { type: "note", text: "After Friday." }, { type: "send", at: 0 }, { type: "failed", error }]);
    assert.deepEqual([failed.phase, failed.choice, failed.note, failedText(failed), canTryAgain(failed)], ["failed", { kind: "option", letter: "B" }, "After Friday.", words, false], error.name);
  }
});

test("a plain failure after one of those says Not sent. Try again. and offers Try again", () => {
  for (const error of [new TimedOut(), new FreshSignInRequired()]) {
    const before = run(twoWay, [{ type: "send", at: 0 }, { type: "failed", error }]);
    const plain = run(twoWay, [{ type: "send", at: 0 }, { type: "failed", error: new NotConfirmed() }], before);
    assert.deepEqual([failedText(plain), canTryAgain(plain)], ["Not sent. Try again.", true], error.name);
  }
});

test("approval cards approve or reject; a one-way approval asks before Approve only", () => {
  assert.equal(run(approval, [{ type: "send", at: 0, choice: { kind: "approve" } }]).phase, "sending");
  const asked = run(oneWayApproval, [{ type: "send", at: 0, choice: { kind: "approve" } }]);
  assert.deepEqual(confirmPrompt(oneWayApproval, asked), { question: "Approve? This cannot be undone.", button: "Confirm: approve" });
  assert.equal(run(oneWayApproval, [{ type: "send", at: 0, choice: { kind: "reject" } }]).phase, "sending");
});

test("nothing happens while a send is under way", () => {
  const sending = run(twoWay, [{ type: "send", at: 0 }]);
  assert.equal(run(twoWay, [{ type: "choose", choice: { kind: "none" } }], sending), sending);
  assert.equal(run(twoWay, [{ type: "send", at: 0 }], sending), sending);
});

test("the receipt names the card, the choice and the ET time, and who acts after None of these", () => {
  const titled = card({ id: "t", title: "How many results should each Search group show?" });
  assert.equal(receiptText(titled, { choice: { kind: "option", letter: "A" }, at: "2026-11-02T15:30:00Z", note: "", version: 1, waitingOn: null, outcome: null }), "Got it: How many results should each Search group show, A, 10:30 AM");
  assert.equal(
    receiptText(titled, { choice: { kind: "none" }, at: "2026-11-02T12:20:00Z", note: "Ask me later", version: 1, waitingOn: "Alba", outcome: null }),
    "Got it: How many results should each Search group show, None of these, 7:20 AM. Waiting on Alba.",
  );
});

test("card keys: a letter picks its option, n picks None of these, Enter sends, t talks, ? lists the keys", () => {
  assert.deepEqual(cardKey(twoWay, "b"), { type: "choose", choice: { kind: "option", letter: "B" } });
  assert.deepEqual(cardKey(twoWay, "n"), { type: "choose", choice: { kind: "none" } });
  assert.deepEqual(cardKey(twoWay, "Enter"), { type: "send" });
  assert.deepEqual(cardKey(twoWay, "t"), { type: "talk" });
  assert.deepEqual(cardKey(twoWay, "?"), { type: "keys" });
  assert.equal(cardKey(twoWay, "d"), null);
  assert.equal(cardKey(twoWay, "B"), null);
});

test("card keys: j, k, n and t keep their meaning even when an option carries that letter", () => {
  const letters = card({ id: "many", options: ["J", "K", "N", "T"].map((letter) => option(letter, "Option " + letter)) });
  assert.equal(cardKey(letters, "j"), null);
  assert.equal(cardKey(letters, "k"), null);
  assert.deepEqual(cardKey(letters, "n"), { type: "choose", choice: { kind: "none" } });
  assert.deepEqual(cardKey(letters, "t"), { type: "talk" });
});

test("card keys: an approval card ignores letter keys, n and Enter, so a stray key never approves", () => {
  for (const key of ["a", "r", "n", "Enter"]) assert.equal(cardKey(approval, key), null, key);
  assert.deepEqual(cardKey(approval, "t"), { type: "talk" });
  assert.deepEqual(cardKey(approval, "?"), { type: "keys" });
});
