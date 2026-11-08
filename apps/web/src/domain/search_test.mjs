import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { INTL_SAMPLES } from "./intl_text.mjs";

const { searchAll } = await loadTs("src/domain/search.ts");

const SOURCES = {
  chats: [
    { id: "iris", name: "Iris", role: "Ops", preview: "Pick A on c1. I will look at c2 later." },
    { id: "alba", name: "Alba", role: "Project lead", preview: "The flow page is ready for your feedback." },
    { id: "dale", name: "Dale", role: "Tools", preview: "Nothing to report." },
  ],
  cards: [
    { id: "c10", title: "Which Appearance choices ship at launch?", about: "Choose which Appearance choices ship at launch.", where: "quarterdeck · Settings", owner: "Iris", waiting: false },
    { id: "alba-1", title: "How many results should each Search group show?", about: "Search groups results by type.", where: "quarterdeck · Search", owner: "Alba", waiting: true },
    { id: "c4", title: "Search result grouping", about: "Group results by Chats, Task Cards.", where: "quarterdeck · Search", owner: "Shelvorn", waiting: true },
  ],
  projects: [{ id: "quarterdeck", name: "quarterdeck", lead: "Alba" }],
  lanes: [{ id: "l-sea", name: "Search", projectName: "quarterdeck" }],
  pages: [
    { id: "PG-1", title: "Mission control", projectId: "quarterdeck", where: "quarterdeck · no Lane", by: "Alba", marks: ["Live"] },
    { id: "PG-2", title: "Search results layout", projectId: "quarterdeck", where: "quarterdeck · Search", by: "Dr. Kivo", marks: [] },
    { id: "PG-3", title: "Bridge runbook", projectId: "heron-forge", where: "heron-forge · Bridge", by: "Shelvorn", marks: ["Public"] },
  ],
  artifacts: [
    { id: "AR-1", name: "search-groups-test.log", kind: "log", projectId: "quarterdeck", projectName: "quarterdeck", by: "Dr. Kivo" },
    { id: "AR-3", name: "settings-context.md", kind: "context", projectId: "quarterdeck", projectName: "quarterdeck", by: "Alba" },
  ],
  mail: [
    { id: "MT-101", subject: "Search group limit: how many rows per group?", bots: ["Alba", "Dr. Kivo", "Iris"] },
    { id: "MT-103", subject: "What goes in Account at launch?", bots: ["Alba", "Iris", "Shelvorn"] },
  ],
};

const titles = (found) => found.map((group) => [group.group, group.hits.map((hit) => hit.id)]);

test("results come grouped Chats, Task Cards, Projects, Lanes, Pages, Artifacts, Mail, with empty groups left out", () => {
  assert.deepEqual(titles(searchAll("search", SOURCES)), [
    ["Task Cards", ["c4", "alba-1"]],
    ["Lanes", ["l-sea"]],
    ["Pages", ["PG-2"]],
    ["Artifacts", ["AR-1"]],
    ["Mail", ["MT-101"]],
  ]);
});

test("a Page hit names its project, Lane, maker and marks, and an Artifact hit its reference, kind and project, and both carry the project that opens them", () => {
  const found = searchAll("", SOURCES);
  const pages = found.find((group) => group.group === "Pages");
  assert.deepEqual(
    pages.hits.map((hit) => [hit.id, hit.detail, hit.projectId]),
    [
      ["PG-1", "quarterdeck · no Lane · Alba · Live", "quarterdeck"],
      ["PG-2", "quarterdeck · Search · Dr. Kivo", "quarterdeck"],
    ],
  );
  assert.equal(pages.more, 1);
  const artifacts = found.find((group) => group.group === "Artifacts");
  assert.deepEqual(artifacts.hits.map((hit) => [hit.id, hit.detail, hit.projectId]), [
    ["AR-1", "AR-1 · Log · quarterdeck", "quarterdeck"],
    ["AR-3", "AR-3 · Context · quarterdeck", "quarterdeck"],
  ]);
  assert.equal(found.find((group) => group.group === "Chats").hits[0].projectId, null);
});

test("a reference typed in full finds its Page or Artifact first", () => {
  assert.deepEqual(titles(searchAll("PG-3", SOURCES)), [["Pages", ["PG-3"]]]);
  assert.deepEqual(titles(searchAll("ar-3", SOURCES)), [["Artifacts", ["AR-3"]]]);
  assert.deepEqual(titles(searchAll("runbook", SOURCES)), [["Pages", ["PG-3"]]]);
});

test("waiting cards come before answered ones, and every word must match", () => {
  assert.deepEqual(titles(searchAll("launch appearance", SOURCES)), [["Task Cards", ["c10"]]]);
  assert.deepEqual(titles(searchAll("alba", SOURCES)), [
    ["Chats", ["alba"]],
    ["Task Cards", ["alba-1"]],
    ["Projects", ["quarterdeck"]],
    ["Pages", ["PG-1"]],
    ["Artifacts", ["AR-3"]],
    ["Mail", ["MT-101", "MT-103"]],
  ]);
});

test("matched words are marked in the title", () => {
  const [chats] = searchAll("ir", SOURCES);
  assert.deepEqual(chats.hits[0].title, [
    { text: "Ir", bold: true },
    { text: "is", bold: false },
  ]);
});

test("an empty search shows a few of each, waiting cards only", () => {
  const found = searchAll("", SOURCES);
  assert.deepEqual(titles(found), [
    ["Chats", ["iris", "alba"]],
    ["Task Cards", ["alba-1", "c4"]],
    ["Projects", ["quarterdeck"]],
    ["Lanes", ["l-sea"]],
    ["Pages", ["PG-1", "PG-2"]],
    ["Artifacts", ["AR-1", "AR-3"]],
    ["Mail", ["MT-101", "MT-103"]],
  ]);
});

test("a bot's name finds the cards it owns, even when no other words name it", () => {
  assert.deepEqual(titles(searchAll("shelvorn", SOURCES)).find(([group]) => group === "Task Cards"), ["Task Cards", ["c4"]]);
});

test("a bot's name finds the mail it takes part in, not only the mail it started", () => {
  assert.deepEqual(titles(searchAll("shelvorn", SOURCES)).find(([group]) => group === "Mail"), ["Mail", ["MT-103"]]);
});

test("a group with more than it shows counts the rest, and asking for the whole group shows them all", () => {
  const chats = (whole) => searchAll("", SOURCES, whole).find((group) => group.group === "Chats");
  assert.deepEqual([chats([]).hits.length, chats([]).more], [2, 1]);
  assert.deepEqual([chats(["Chats"]).hits.map((hit) => hit.id), chats(["Chats"]).more], [["iris", "alba", "dale"], 0]);
});

test("in Turkish, German, emoji and right-to-left text the bold covers exactly the typed word", () => {
  for (const sample of INTL_SAMPLES) {
    for (const [typed, bold] of sample.finds) {
      const [chats] = searchAll(typed, { chats: [{ id: "x", name: sample.text, role: "", preview: "" }], cards: [], projects: [], lanes: [], pages: [], artifacts: [], mail: [] });
      const title = chats.hits[0].title;
      assert.equal(title.map((part) => part.text).join(""), sample.text, sample.name);
      assert.deepEqual(title.filter((part) => part.bold).map((part) => part.text), bold, sample.name + ", typed " + typed);
    }
  }
});
