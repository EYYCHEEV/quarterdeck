import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { card as baseCard } from "../domain/fixture.mjs";

const { detailOf } = await loadTs("src/data/server-card.ts");
const { createApiClient } = await loadTs("src/data/api-client.ts");

const payload = (name) => fs.readFileSync(new URL("./server-payloads/" + name, import.meta.url), "utf8");
const read = (name) => createApiClient({ send: async () => new Response(payload(name), { status: 200 }) }).card("x");

const OPEN_BASE = baseCard({
  id: "alba-1",
  version: 3,
  title: "a title from the list",
  priority: "",
  owner: "alba",
  projectId: "quarterdeck",
  laneId: "quarterdeck/Search",
  addedAt: "2026-11-02T09:40:00-05:00",
  due: "2026-11-03T17:00:00-05:00",
  seenAt: "2026-11-02T15:00:00.000Z",
});

const ANSWERED_BASE = baseCard({
  id: "shelvorn-5",
  version: 2,
  priority: "",
  owner: "shelvorn",
  projectId: "quarterdeck",
  laneId: "quarterdeck/Settings",
  addedAt: "2026-11-02T09:00:00-05:00",
  answer: { choice: { kind: "option", letter: "A" }, at: "2026-11-02T09:00:00-05:00", note: "", version: 2, waitingOn: "shelvorn", outcome: null },
});

test("the card document's fields land on the card", async () => {
  const card = detailOf(await read("card-open.json"), OPEN_BASE);
  assert.equal(card.version, 3);
  assert.equal(card.title, "How many results should each Search group show?");
  assert.equal(card.about, "Rows per Search group on the results screen.");
  assert.equal(card.ascii, "[ Chats  5 ]\n[ Cards  5 ]");
  assert.equal(card.skip, "If you skip this, Search keeps showing five rows.");
  assert.equal(card.pickWhy, "Five rows is the most that still leaves the keyboard room.");
  assert.equal(card.approvalDoor, "two-way");
  assert.equal(card.due, "2026-11-03T17:00:00-05:00");
  assert.deepEqual(card.labels, ["design"]);
  assert.deepEqual(card.evidence, []);
  assert.deepEqual(card.media, []);
  assert.deepEqual(card.commands, [{ where: "Mac terminal", run: "npm run test:data" }]);
  assert.deepEqual(card.more, {
    context: ["Search shows results in groups.", "A longer group pushes the next group off the phone screen."],
    words: [["group", "the set of results of one kind"]],
    learn: [{ label: "Search results", url: "https://example.com/search-results" }],
    note: "Tried five on the iPhone.",
  });
});

test("options get their letter and label from the A. prefix and use only the v1 card-level door", async () => {
  const { options } = detailOf(await read("card-open.json"), OPEN_BASE);
  assert.deepEqual(options.map((option) => [option.letter, option.label, option.pick, option.door]), [["A", "Three rows", false, "two-way"], ["B", "Five rows", true, "two-way"], ["C", "Eight rows", false, "two-way"]]);
  assert.deepEqual([options[0].does, options[0].cost, options[0].pros, options[0].cons], ["Each group shows three rows.", "More taps to see the rest.", ["Fits a phone with the keyboard open"], ["Hides the fourth match"]]);
  assert.deepEqual([options[1].why, options[1].tradeoff], ["Five fits the screen with room for the keyboard.", "Between speed and reach."]);
  assert.deepEqual([options[2].risk, options[2].undo, options[2].pros, options[2].cons], ["Pushes later groups off the screen.", "Change it back in Settings.", [], []]);
});

test("the picked option takes the v1 card's door, and an unlettered label gets the next letter", async () => {
  const open = await read("card-open.json");
  const oneWay = detailOf({ ...open, card: { ...open.card, door: "one-way", options: [{ label: "Make it public", pick: true }, { label: "Keep it private" }] } }, OPEN_BASE);
  assert.deepEqual(oneWay.options.map((option) => [option.letter, option.door]), [["A", "one-way"], ["B", "two-way"]]);
});

test("what the list gave is kept: the ids, the poster, the added time, the seen mark, and the defaults for what the server does not send", async () => {
  const card = detailOf(await read("card-open.json"), OPEN_BASE);
  assert.deepEqual([card.id, card.projectId, card.laneId, card.owner, card.addedAt, card.seenAt], ["alba-1", "quarterdeck", "quarterdeck/Search", "alba", "2026-11-02T09:40:00-05:00", "2026-11-02T15:00:00.000Z"]);
  assert.deepEqual([card.priority, card.unblocks, card.changes, card.versions, card.description, card.answer], ["", [], [], [], null, null]);
});

test("a poster the list did not give is the sender of the card's first event", async () => {
  const card = detailOf(await read("card-open.json"), { ...OPEN_BASE, owner: "" });
  assert.equal(card.owner, "alba");
  assert.equal(detailOf(await read("card-open.json"), { ...OPEN_BASE, owner: "someone" }).owner, "someone");
});

test("the final answer's note lands on the answered card; an answer to a comment does not, and the rest of the answer is untouched", async () => {
  const card = detailOf(await read("card-answered.json"), ANSWERED_BASE);
  assert.deepEqual(card.answer, { ...ANSWERED_BASE.answer, note: "Yes, Storage is its own section." });
});

test("a card with no final answer in the thread keeps the note it had, and a card with no answer gets none", async () => {
  const answered = await read("card-answered.json");
  const without = { ...answered, thread: answered.thread.filter((event) => event.kind !== "answer" || event.forComment) };
  assert.equal(detailOf(without, ANSWERED_BASE).answer.note, "");
  assert.equal(detailOf(answered, { ...ANSWERED_BASE, answer: null }).answer, null);
});

test("a cant-decide answer is a final answer like any other, and an answer to another rev is not", async () => {
  const answered = await read("card-answered.json");
  const final = answered.thread.at(-1);
  const cantDecide = { ...answered, thread: [...answered.thread.slice(0, -1), { ...final, pick: "cant-decide", note: "Ask me again Monday." }] };
  const older = { ...answered, thread: [...answered.thread.slice(0, -1), { ...final, rev: 1 }] };
  assert.equal(detailOf(cantDecide, ANSWERED_BASE).answer.note, "Ask me again Monday.");
  assert.equal(detailOf(older, ANSWERED_BASE).answer.note, "");
});

test("the lane is the list's, whatever the card document says: another lane, an empty one, null or none", async () => {
  const open = await read("card-open.json");
  for (const lane of ["Elsewhere", "", null, undefined]) {
    const card = detailOf({ ...open, card: { ...open.card, lane } }, OPEN_BASE);
    assert.deepEqual([card.projectId, card.laneId], ["quarterdeck", "quarterdeck/Search"], String(lane));
  }
});

test("fields a card does not give become null or empty", async () => {
  const card = detailOf(await read("card-answered.json"), ANSWERED_BASE);
  assert.deepEqual([card.ascii, card.skip, card.pickWhy, card.commands, card.media, card.evidence], [null, null, null, [], [], []]);
  assert.deepEqual(card.more, { context: ["Storage sits under Add-ons today."], words: [], learn: [], note: null });
  assert.equal(card.due, null);
});

test("an empty context is no lines", async () => {
  assert.deepEqual(detailOf(await read("card-withdrawn.json"), ANSWERED_BASE).more.context, []);
});

test("the version is the card's rev, and the card passed in is not changed", async () => {
  const before = JSON.stringify(OPEN_BASE);
  const card = detailOf(await read("card-open.json"), { ...OPEN_BASE, version: 1 });
  assert.equal(card.version, 3);
  assert.equal(JSON.stringify(OPEN_BASE), before);
});
