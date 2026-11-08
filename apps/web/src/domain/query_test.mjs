import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { card, task } from "./fixture.mjs";

const { viewQueue, EMPTY_QUERY, labelsInUse, answeredLine, withFilter } = await loadTs("src/domain/query.ts");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");

const answer = (letter, at, extra = {}) => ({ choice: letter === "none" ? { kind: "none" } : { kind: "option", letter }, at, note: "", version: 1, waitingOn: null, ...extra });

const WORLD = {
  tasks: [task("t1"), task("t2")],
  projects: [
    { id: "quarterdeck", name: "quarterdeck", lead: "Alba", description: "", activeAt: "2026-11-02T09:48:00-05:00" },
    { id: "heron-forge", name: "heron-forge", lead: "Shelvorn", description: "", activeAt: "2026-11-02T08:00:00-05:00" },
  ],
  lanes: [
    { id: "l-sea", projectId: "quarterdeck", name: "Search", status: "Active", lead: "Alba", now: "", activity: [] },
    { id: "l-sw1", projectId: "heron-forge", name: "Matrix rooms", status: "Active", lead: "Shelvorn", now: "", activity: [] },
  ],
  pages: [],
  artifacts: [],
  mail: [],
  bots: [],
  cards: [
    card({ id: "bridge", title: "Run the room list check", priority: "P0", owner: "Shelvorn", projectId: "heron-forge", laneId: "l-sw1", unblocks: ["t1"], due: "2026-11-03T12:00:00-05:00", labels: ["high-risk approval"], addedAt: "2026-11-02T08:45:00-05:00" }),
    card({ id: "groups", title: "How many results should each Search group show?", priority: "P1", due: "2026-11-02T18:00:00-05:00", labels: ["strategy"], addedAt: "2026-11-02T08:30:00-05:00", changes: [{ by: "Iris", at: "2026-11-02T09:40:00-05:00", following: null, what: "x" }] }),
    card({ id: "export", title: "CSV export columns", priority: "P3", owner: "Iris", labels: ["approval"], addedAt: "2026-10-26T09:00:00-05:00" }),
    card({ id: "themes", title: "Which Appearance choices ship at launch?", priority: "P2", answer: answer("A", "2026-11-01T21:10:00-05:00") }),
    card({ id: "grouping", title: "Search result grouping", priority: "P3", owner: "Dr. Kivo", answer: answer("none", "2026-11-02T07:20:00-05:00", { waitingOn: "Dr. Kivo" }) }),
  ],
};

const ids = (view) => view.rows.map((row) => row.card.id);
const query = (patch) => ({ ...EMPTY_QUERY, ...patch, filters: { ...patch.filters } });

test("the default view ranks every waiting card and names the count from the rows", () => {
  const view = viewQueue(WORLD, EMPTY_QUERY, NOW);
  assert.deepEqual(ids(view), ["bridge", "groups", "export"]);
  assert.equal(view.count, "3 waiting");
  assert.deepEqual(view.chips, []);
  assert.equal(view.filterCount, 0);
});

test("search matches the title, the bot, the project, the Lane and the labels", () => {
  assert.deepEqual(ids(viewQueue(WORLD, query({ text: "matrix" }), NOW)), ["bridge"]);
  assert.deepEqual(ids(viewQueue(WORLD, query({ text: "iris" }), NOW)), ["export"]);
  assert.deepEqual(ids(viewQueue(WORLD, query({ text: "strategy" }), NOW)), ["groups"]);
  const none = viewQueue(WORLD, query({ text: "bridge 2027" }), NOW);
  assert.deepEqual(ids(none), []);
  assert.equal(none.count, "0 of 3 waiting");
  assert.deepEqual(none.chips, [{ key: "text", text: "Search: bridge 2027" }]);
});

test("a filter narrows the rows, counts as on, and names itself", () => {
  const view = viewQueue(WORLD, query({ filters: { project: "quarterdeck" } }), NOW);
  assert.deepEqual(ids(view), ["groups", "export"]);
  assert.equal(view.count, "2 of 3 waiting");
  assert.equal(view.filterCount, 1);
  assert.deepEqual(view.chips, [{ key: "project", text: "Project: quarterdeck" }]);
});

test("due filters pick overdue, today, this week or no due", () => {
  assert.deepEqual(ids(viewQueue(WORLD, query({ filters: { due: "today" } }), NOW)), ["groups"]);
  assert.deepEqual(ids(viewQueue(WORLD, query({ filters: { due: "week" } }), NOW)), ["bridge", "groups"]);
  assert.deepEqual(ids(viewQueue(WORLD, query({ filters: { due: "none" } }), NOW)), ["export"]);
});

test("sorts: due soonest, newest added, recently changed with never-changed last, and project", () => {
  assert.deepEqual(ids(viewQueue(WORLD, query({ sort: "due" }), NOW)), ["groups", "bridge", "export"]);
  assert.deepEqual(ids(viewQueue(WORLD, query({ sort: "newest" }), NOW)), ["bridge", "groups", "export"]);
  assert.deepEqual(ids(viewQueue(WORLD, query({ sort: "changed" }), NOW)), ["groups", "bridge", "export"]);
  const byProject = viewQueue(WORLD, query({ sort: "project" }), NOW);
  assert.deepEqual(ids(byProject), ["bridge", "groups", "export"]);
  assert.deepEqual(byProject.chips, [{ key: "sort", text: "Sorted by project" }]);
  assert.equal(byProject.count, "3 waiting");
});

test("the Answered view lists answers newest first and says who the card waits on", () => {
  const view = viewQueue(WORLD, query({ filters: { show: "answered" } }), NOW);
  assert.equal(view.answered, true);
  assert.equal(view.count, "Answered");
  assert.deepEqual(ids(view), ["grouping", "themes"]);
  assert.deepEqual(view.chips, [{ key: "show", text: "Answered, newest first" }]);
  assert.deepEqual(answeredLine(view.rows[0].card), { line: "You: None of these · 7:20 AM", waitingOn: "Waiting on Dr. Kivo" });
  assert.deepEqual(answeredLine(view.rows[1].card), { line: "You: A · 9:10 PM · Alba", waitingOn: null });
});

test("a cant-decide answer reads as Can't decide on the Answered line and keeps the poster it waits on", () => {
  const closed = card({ id: "undecided", owner: "Kivo", answer: { choice: { kind: "cant-decide" }, at: "2026-11-02T07:20:00-05:00", note: "", version: 1, waitingOn: "Kivo", outcome: null } });
  assert.deepEqual(answeredLine(closed), { line: "You: Can't decide · 7:20 AM", waitingOn: "Waiting on Kivo" });
});

test("the Labels filter lists only labels the cards carry, and the other lists come from the data", () => {
  assert.deepEqual(labelsInUse(WORLD.cards), ["approval", "high-risk approval", "strategy"]);
  const groups = Object.fromEntries(viewQueue(WORLD, EMPTY_QUERY, NOW).groups.map((group) => [group.key, group.choices.map((choice) => choice.label)]));
  assert.deepEqual(groups.show, ["Waiting", "Answered"]);
  assert.deepEqual(groups.project, ["quarterdeck", "heron-forge"]);
  assert.deepEqual(groups.lane, ["Matrix rooms", "Search"]);
  assert.deepEqual(groups.bot, ["Alba", "Dr. Kivo", "Iris", "Shelvorn"]);
  assert.deepEqual(groups.priority, ["P0", "P1", "P2", "P3", "P4"]);
  assert.deepEqual(groups.due, ["Overdue", "Today", "This week", "None"]);
});

test("withFilter sets one filter, and no value removes it, leaving the old filters as they were", () => {
  const before = { owner: "Alba" };
  assert.deepEqual(withFilter(before, "label", "high-risk"), { owner: "Alba", label: "high-risk" });
  assert.deepEqual(withFilter(before, "owner", undefined), {});
  assert.deepEqual(before, { owner: "Alba" });
});

const sortValues = (view) => view.sorts.map((sort) => sort.value);
const groupKeys = (view) => view.groups.map((group) => group.key);
const WITHOUT_PRIORITY = { ...WORLD, cards: WORLD.cards.map((c) => ({ ...c, priority: "", unblocks: [] })) };

test("with a priority on the cards the Priority filter and the first Sort entry stay, as before", () => {
  const view = viewQueue(WORLD, EMPTY_QUERY, NOW);
  assert.equal(groupKeys(view).includes("priority"), true);
  assert.deepEqual(sortValues(view), ["ranked", "due", "newest", "changed", "project"]);
});

test("one card with a priority is enough to keep the Priority filter and the first Sort entry", () => {
  const mixed = { ...WITHOUT_PRIORITY, cards: [...WITHOUT_PRIORITY.cards.slice(1), WORLD.cards[0]] };
  const view = viewQueue(mixed, EMPTY_QUERY, NOW);
  assert.equal(groupKeys(view).includes("priority"), true);
  assert.equal(sortValues(view)[0], "ranked");
});

test("with no priority on any card the Priority filter and the first Sort entry are left out", () => {
  const view = viewQueue(WITHOUT_PRIORITY, EMPTY_QUERY, NOW);
  assert.deepEqual(groupKeys(view), ["show", "project", "lane", "bot", "label", "due"]);
  assert.deepEqual(sortValues(view), ["due", "newest", "changed", "project"]);
});

test("with no priority the default view lists the waiting cards by due, no due last, then the newest change", () => {
  const view = viewQueue(WITHOUT_PRIORITY, EMPTY_QUERY, NOW);
  assert.deepEqual(ids(view), ["groups", "bridge", "export"]);
});
