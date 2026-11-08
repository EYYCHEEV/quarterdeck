import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { card, task } from "./fixture.mjs";

const queue = await loadTs("src/domain/queue.ts");
const { rankQueue, placeInQueue, isChanged } = queue;
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const TASKS = ["t1", "t2", "t3", "t4"].map((id) => task(id));
const ids = (rows) => rows.map((row) => row.card.id);

test("priority always comes first, whatever a card unblocks", () => {
  const cards = [card({ id: "low", priority: "P1", unblocks: ["t1", "t2", "t3"] }), card({ id: "high", priority: "P0" })];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["high", "low"]);
});

test("within a priority, more tasks unblocked comes first, then the soonest due, then no due", () => {
  const cards = [
    card({ id: "no-due", unblocks: ["t1"] }),
    card({ id: "later", unblocks: ["t1"], due: "2026-11-05T12:00:00-05:00" }),
    card({ id: "sooner", unblocks: ["t1"], due: "2026-11-03T12:00:00-05:00" }),
    card({ id: "two", unblocks: ["t1", "t2"], due: "2026-11-09T12:00:00-05:00" }),
  ];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["two", "sooner", "later", "no-due"]);
});

test("exact ties keep the order the cards arrived in", () => {
  const cards = [card({ id: "first" }), card({ id: "second" }), card({ id: "third" })];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["first", "second", "third"]);
});

test("Unblocks counts bot tasks only, never another Task Card, even one listed as a task", () => {
  const cards = [card({ id: "c2", unblocks: ["t1", "t2", "c4", "missing"] }), card({ id: "c4", unblocks: ["t3"] })];
  const rows = rankQueue(cards, [...TASKS, task("c4", "A card id in the tasks table")], NOW);
  const c2 = rows.find((row) => row.card.id === "c2");
  assert.deepEqual(c2.unblocking.map((t) => t.id), ["t1", "t2"]);
  assert.equal(c2.why.unblocks, "Unblocks 2 tasks");
});

test("the why line prints a real zero, one task, no due time, and is red only past due", () => {
  const rows = rankQueue(
    [
      card({ id: "zero", due: "2026-11-06T12:00:00-05:00" }),
      card({ id: "one", unblocks: ["t1"] }),
      card({ id: "late", priority: "P0", due: "2026-11-02T09:00:00-05:00" }),
      card({ id: "soon", priority: "P0", due: "2026-11-02T10:45:00-05:00" }),
    ],
    TASKS,
    NOW,
  );
  const why = Object.fromEntries(rows.map((row) => [row.card.id, row.why]));
  assert.deepEqual(why.zero, { unblocks: "Unblocks 0 tasks", due: "Due Fri 12 PM", pastDue: false });
  assert.deepEqual(why.one, { unblocks: "Unblocks 1 task", due: "No due time", pastDue: false });
  assert.equal(why.late.pastDue, true);
  assert.equal(why.soon.pastDue, false);
});

test("answered cards leave the Queue", () => {
  const answered = card({ id: "done", priority: "P0", answer: { choice: { kind: "option", letter: "A" }, at: "2026-11-02T09:00:00-05:00", note: "", version: 1, waitingOn: null } });
  assert.deepEqual(ids(rankQueue([answered, card({ id: "open" })], TASKS, NOW)), ["open"]);
});

test("a card he never opened counts as changed; one he opened counts only after a later change", () => {
  const change = { by: "Iris", at: "2026-11-02T09:40:00-05:00", following: "Say what happens if I don't answer.", what: "Rewrote the no-answer line." };
  assert.equal(isChanged(card({ id: "new" })), true);
  assert.equal(isChanged(card({ id: "seen", seenAt: "2026-11-02T09:00:00-05:00" })), false);
  assert.equal(isChanged(card({ id: "after", seenAt: "2026-11-02T09:30:00-05:00", changes: [change] })), true);
  assert.equal(isChanged(card({ id: "before", seenAt: "2026-11-02T09:50:00-05:00", changes: [change] })), false);
});

test("the place in the Queue comes from the computed order, and answered cards say so", () => {
  const rows = rankQueue([card({ id: "a", priority: "P0" }), card({ id: "b" }), card({ id: "c", priority: "P1" })], TASKS, NOW);
  assert.equal(placeInQueue(rows, "c"), "2 of 3 in the Queue");
  assert.equal(placeInQueue(rows, "gone"), "Answered");
});

test("cards that arrived, left or changed while he reads are counted, not applied", () => {
  const { changedWhileReading } = queue;
  const shown = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
  const now = [card({ id: "a" }), card({ id: "b", version: 2 }), card({ id: "d" })];
  assert.equal(changedWhileReading(shown, shown), 0);
  assert.equal(changedWhileReading(shown, now), 3);
  const answered = { choice: { kind: "option", letter: "A" }, at: "2026-11-02T10:00:00-05:00", note: "", version: 1, waitingOn: null };
  assert.equal(changedWhileReading(shown, [card({ id: "a", answer: answered }), card({ id: "b" }), card({ id: "c" })]), 0);
});

test("after an answer the next card is the row that was below it, or the one above at the end", () => {
  const rows = ["a", "b", "c"].map((id) => ({ card: card({ id }) }));
  assert.equal(queue.nextAfter(rows, "a"), "b");
  assert.equal(queue.nextAfter(rows, "b"), "c");
  assert.equal(queue.nextAfter(rows, "c"), "b");
  assert.equal(queue.nextAfter(rows.slice(0, 1), "a"), null);
});

const bare = (id, fields = {}) => card({ id, priority: "", ...fields });

test("with no priority, the soonest due comes first and no due comes last", () => {
  const cards = [
    bare("none"),
    bare("later", { due: "2026-11-05T12:00:00-05:00" }),
    bare("sooner", { due: "2026-11-03T12:00:00-05:00" }),
  ];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["sooner", "later", "none"]);
});

test("with no priority and the same due, the newest change comes first, and an edit counts over the added time", () => {
  const edit = { by: "Iris", at: "2026-11-02T09:30:00-05:00", following: null, what: "Rewrote it." };
  const cards = [
    bare("older", { addedAt: "2026-11-02T07:00:00-05:00" }),
    bare("added", { addedAt: "2026-11-02T09:00:00-05:00" }),
    bare("edited", { addedAt: "2026-11-02T08:00:00-05:00", changes: [edit] }),
  ];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["edited", "added", "older"]);
});

test("due comes before the newest change when no card has a priority", () => {
  const cards = [
    bare("new-no-due", { addedAt: "2026-11-02T09:59:00-05:00" }),
    bare("old-due", { addedAt: "2026-10-01T09:00:00-05:00", due: "2026-11-09T12:00:00-05:00" }),
  ];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["old-due", "new-no-due"]);
});

test("a card with no priority sorts after a card with the lowest priority", () => {
  const cards = [bare("bare", { due: "2026-11-02T10:30:00-05:00" }), card({ id: "lowest", priority: "P4" })];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["lowest", "bare"]);
});

test("cards with a priority keep the strict rule and their arrival order on exact ties, whatever changed last", () => {
  const edit = { by: "Iris", at: "2026-11-02T09:30:00-05:00", following: null, what: "Rewrote it." };
  const cards = [card({ id: "first", addedAt: "2026-11-01T09:00:00-05:00" }), card({ id: "second", addedAt: "2026-11-02T09:00:00-05:00", changes: [edit] })];
  assert.deepEqual(ids(rankQueue(cards, TASKS, NOW)), ["first", "second"]);
});

test("a card with no priority carries no Unblocks data, so its why line has no Unblocks part; a card with a priority keeps its real zero", () => {
  const rows = rankQueue([bare("server", { due: "2026-11-06T12:00:00-05:00" }), card({ id: "example" })], TASKS, NOW);
  const why = Object.fromEntries(rows.map((row) => [row.card.id, row.why]));
  assert.deepEqual(why.server, { unblocks: "", due: "Due Fri 12 PM", pastDue: false });
  assert.equal(why.example.unblocks, "Unblocks 0 tasks");
});
