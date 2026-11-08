import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { card, option, task } from "./fixture.mjs";

const { recapOf, changeLine, changedLabel, noAnswerLine, versionsFold, evidenceTiles, cardCheck, oneWayBlock } = await loadTs("src/domain/card.ts");
const { pastDueLine, versionLine, openFailedText } = await loadTs("src/domain/card-words.ts");

const CHANGES = [
  { by: "Alba", at: "2026-11-02T08:45:00-05:00", following: "Put the picture first.", what: "Moved the picture above the options." },
  { by: "Iris", at: "2026-11-02T09:40:00-05:00", following: "Say what happens if I don't answer.", what: "Rewrote the no-answer line." },
];

const WORLD = {
  tasks: [task("t3", "Search pop-up on the phone"), task("t4", "Search ranking notes")],
  projects: [{ id: "quarterdeck", name: "quarterdeck", lead: "Alba", description: "", activeAt: "2026-11-02T09:48:00-05:00" }],
  lanes: [{ id: "l-sea", projectId: "quarterdeck", name: "Search", status: "Active", lead: "Dr. Kivo", now: "", activity: [] }],
  pages: [
    { ref: "PG-1", projectId: "quarterdeck", title: "Mission control", by: "Alba", updatedAt: "2026-11-02T09:58:00-05:00", live: true, file: "pages/mission-control.html" },
    { ref: "PG-2", projectId: "quarterdeck", title: "Search results layout", by: "Dr. Kivo", updatedAt: "2026-11-02T07:00:00-05:00", live: false, file: null },
  ],
  artifacts: [
    { ref: "AR-1", name: "search-groups-test.log", kind: "log", projectId: "quarterdeck", by: "Dr. Kivo", addedAt: "2026-11-02T09:05:00-05:00", size: "0.4 KB", laneIds: [], cardIds: [], storage: "", text: "one\ntwo\nthree\nfour" },
  ],
  mail: [
    { ref: "MT-101", subject: "Search group limit", projectId: "quarterdeck", laneId: "l-sea", cardId: "g", bots: ["Alba"], mails: [{ ref: "MT-101.1", from: "Alba", to: ["Dr. Kivo"], at: "2026-11-02T08:05:00-05:00", text: "Long groups push the others off the phone screen.", refs: [] }] },
  ],
  bots: [],
};

const groups = card({ id: "g", about: "Sets how many rows a group shows.", unblocks: ["t3", "t4", "c4"], changes: CHANGES, seenAt: "2026-11-02T09:30:00-05:00", evidence: ["MT-101", "AR-1", "PG-2"] });

test("the recap holds About, In with the project, Lane and tasks, and Now from the latest change", () => {
  assert.deepEqual(recapOf(groups, { ...WORLD, cards: [groups] }), {
    about: "Sets how many rows a group shows.",
    project: "quarterdeck",
    lane: "Search",
    unblocks: "unblocks 2 tasks",
    tasks: ["Search pop-up on the phone", "Search ranking notes"],
    now: "Iris rewrote the no-answer line",
  });
});

test("About falls back to the short card's description, and Now is empty without a change", () => {
  const short = card({ id: "c4", description: "Group results by Chats, Task Cards, Projects, Lanes, Mail." });
  const recap = recapOf(short, { ...WORLD, cards: [short] });
  assert.equal(recap.about, "Group results by Chats, Task Cards, Projects, Lanes, Mail.");
  assert.equal(recap.now, null);
});

test("the change line credits his message, whether or not he has seen the change", () => {
  const line = "Iris changed it at 9:40 AM, following your message: Say what happens if I don't answer.";
  assert.equal(changeLine(groups), line);
  assert.equal(changeLine({ ...groups, seenAt: "2026-11-02T09:50:00-05:00" }), line);
  assert.equal(changeLine({ ...groups, changes: [] }), null);
});

test("Earlier versions shows how many there are, from the saved versions or else from the change records", () => {
  assert.equal(versionsFold(groups), "Earlier versions (2)");
  const version = { version: 1, by: "Alba", at: "2026-11-02T08:30:00-05:00", following: null, ask: "", picture: null, options: [], risk: null, answer: null };
  assert.equal(versionsFold({ ...groups, versions: [version] }), "Earlier versions (1)");
  assert.equal(versionsFold(card({ id: "fresh" })), "Earlier versions");
});

test("the version line names the version, the bot, the time and the instruction with its time", () => {
  const asked = { ...groups, changes: [{ ...CHANGES[1], followingAt: "2026-11-02T09:35:00-05:00" }] };
  assert.deepEqual(versionLine(asked), { head: "Version 2 \u00B7 Iris \u00B7 9:40 AM", instruction: 'Changed on your instruction in chat, 9:35 AM: "Say what happens if I don\'t answer."' });
  assert.deepEqual(versionLine({ ...asked, changes: [{ ...CHANGES[1], following: null }] }), { head: "Version 2 \u00B7 Iris \u00B7 9:40 AM", instruction: null });
  assert.equal(versionLine({ ...groups, changes: [] }), null);
  const saved = { version: 1, by: "Alba", at: "2026-11-02T08:30:00-05:00", following: null, ask: "", picture: null, options: [], risk: null, answer: null };
  assert.equal(versionLine({ ...asked, versions: [saved, { ...saved, version: 2 }, { ...saved, version: 3 }], changes: [CHANGES[0], CHANGES[1], CHANGES[1]] })?.head, "Version 4 \u00B7 Iris \u00B7 9:40 AM");
});

test("past its due time the no-answer line says what happened, and only then", () => {
  const held = card({ id: "late", due: "2026-11-02T08:00:00-05:00", skip: "If no answer by due: Alba holds it and asks again Wednesday." });
  const now = Date.parse("2026-11-02T10:00:00-05:00");
  assert.equal(pastDueLine(held, now), "No answer by Mon 8 AM, so Alba holds it and asks again Wednesday.");
  assert.equal(pastDueLine(held, Date.parse("2026-11-02T07:00:00-05:00")), null);
  assert.equal(pastDueLine({ ...held, skip: null }, now), null);
});

test("a card open refused by the app's own cap says to wait, and every other failed open keeps Could not load this Task Card.", () => {
  assert.equal(openFailedText(true), "Too many opens this minute. Wait up to a minute, then Try again.");
  assert.equal(openFailedText(false), "Could not load this Task Card.");
});

test("evidence tiles order Page, Artifact, Mail, and a Page without a file is no link", () => {
  const tiles = evidenceTiles(groups, WORLD);
  assert.deepEqual(
    tiles.map((tile) => [tile.kind, tile.code, tile.title, tile.meta, tile.opens]),
    [
      ["Page", "PG-2", "Search results layout", "No file yet", false],
      ["Artifact", "AR-1", "search-groups-test.log", "Log · search-groups-test.log", true],
      ["Mail", "MT-101", "Alba", "Long groups push the others off the phone screen.", true],
    ],
  );
  assert.deepEqual(tiles[1].lines, ["one", "two", "three"]);
  assert.deepEqual(evidenceTiles({ ...groups, evidence: ["PG-1"] }, WORLD).map((tile) => [tile.meta, tile.opens]), [["By Alba · Updated 9:58 AM", true]]);
  assert.deepEqual(evidenceTiles(card({ id: "bare" }), WORLD), []);
});

test("the one-way block sits above a one-way pick and carries its risk; a two-way pick has none", () => {
  const oneWay = card({ id: "o", options: [option("A", "Run it tonight", { pick: true, door: "one-way", risk: "Rooms lose their bridge." }), option("B", "Wait")] });
  assert.deepEqual(oneWayBlock(oneWay), { risk: "Rooms lose their bridge." });
  const otherOneWay = card({ id: "t", labels: ["high-risk"], options: [option("A", "Keep", { pick: true }), option("B", "Delete", { door: "one-way" })] });
  assert.equal(oneWayBlock(otherOneWay), null);
});

test("the card check names every card that lacks a recap, a picture, saved versions or one-way risk text", () => {
  const cards = [
    groups,
    card({ id: "full", about: "x", ascii: "x" }),
    card({ id: "short", title: "Room list placeholder", description: "Example only." }),
    card({ id: "risky", about: "x", ascii: "x", options: [option("A", "Go", { pick: true, door: "one-way" })] }),
  ];
  assert.deepEqual(cardCheck(cards), [
    { id: "g", title: "g", missing: ["picture", "earlier versions"] },
    { id: "short", title: "Room list placeholder", missing: ["recap", "picture"] },
    { id: "risky", title: "risky", missing: ["one-way risk"] },
  ]);
});

test("the changed dot is named after the latest change, or New for a card he never opened", () => {
  assert.equal(changedLabel(card({ id: "fresh", seenAt: null })), "New");
  assert.equal(changedLabel(card({ id: "edited", seenAt: "2026-11-02T09:00:00-05:00", changes: [{ by: "Iris", at: "2026-11-02T09:40:00-05:00", following: null, what: "Rewrote it." }] })), "Changed by Iris at 9:40 AM");
  assert.equal(changedLabel(card({ id: "read", seenAt: "2026-11-02T09:50:00-05:00", changes: [{ by: "Iris", at: "2026-11-02T09:40:00-05:00", following: null, what: "Rewrote it." }] })), null);
});

test("the no-answer line names the due day and hour", () => {
  const due = card({ id: "d", due: "2026-11-04T17:00:00-05:00", skip: "If no answer by due: we keep today's behavior and ask again next week." });
  assert.equal(noAnswerLine(due), "If no answer by Wed 5 PM: we keep today's behavior and ask again next week.");
  assert.equal(noAnswerLine(card({ id: "n", skip: null })), null);
});
