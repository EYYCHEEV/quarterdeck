import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test, { mock } from "node:test";
import esbuild from "esbuild";
import { loadTs } from "../../tools/load-ts.mjs";

async function load(entry, fixtures) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: fixtures ? "true" : "false" }, loader: { ".html": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createExampleData } = await load("src/data/example-data.ts", false);
const withFixtures = (await load("src/data/example-data.ts", true)).createExampleData;
const { PAGE_FILES } = await load("src/data/page-files.ts", false);
const { readSwitches } = await load("src/data/switches.ts", false);
const readSwitchesWithFixtures = (await load("src/data/switches.ts", true)).readSwitches;
const pages = await loadTs("src/domain/pages.ts");
const { rankQueue, placeInQueue } = await loadTs("src/domain/queue.ts");
const { clockTime, dueLong, dueShort, whenText } = await loadTs("src/domain/time.ts");
const { oneWayBlock, cardCheck } = await loadTs("src/domain/card.ts");
const { answerStep, startAnswer, confirmPrompt } = await loadTs("src/domain/answer.ts");
const { evidenceView } = await loadTs("src/domain/evidence.ts");
const { BUDGET } = await loadTs("src/data/card.ts");

const CONTENT = JSON.parse(fs.readFileSync("src/data/pages.json", "utf8"));
const FIXTURES = JSON.parse(fs.readFileSync("src/data/pages-fixtures.json", "utf8"));
const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const DEFAULT_SWITCHES = { delay: 0, fail: new Set(), fixtures: "off", empty: false };
const PUBLIC_ADDRESS = "https://pages-public.example.com/p/aaaqeayeaudaocajbifqydiob4";
const FRESH_ADDRESS = "https://pages-public.example.com/p/77777777777777777777777774";
const CAPABILITY_ADDRESS = /^https:\/\/pages-public\.example\.com\/p\/[a-z2-7]{25}[aeimquy4]$/;
const make = (over = {}, factory = createExampleData) => factory({ ...DEFAULT_SWITCHES, ...over });
const fixtureFlow = (id) => FIXTURES.fixtures.find((item) => item.fixture.startsWith(id));
const rowsOf = (world, projectId) => pages.viewPages(world, projectId, pages.EMPTY_PAGE_QUERY, NOW).rows;
const waitingIds = (world) => rankQueue(world.cards, world.tasks, NOW).map((row) => row.card.id);
const PAGE_1 = ["pages.json", "2ac2d7680247832affed7044fe13336127813ce1a4f623bf0be30fd55911403c"];

const SHIPPED = [
  ["src/data/pages.json", PAGE_1[1]],
  ["src/data/pages-fixtures.json", "aa3441879b50ed6c7c19cda491c76a23e300156b2d02e825076ba9a6ea251282"],
  ["src/data/pages/search-results-layout.html", "a88a3b172b1b4794e68dc0c3c0029f4f3619ab8a9bf8b6f3343d5acdc907a9a8"],
  ["src/data/pages/bridge-runbook.html", "ca23c3ff041797107a18432c6463dca9e613d25143e2a635d63f7a6ec2d940c3"],
  ["src/data/pages/bridge-runbook-v1.html", "4d39234c928b5a741971bea843db3ee1b70bcee8b1f1697edb211bca26413864"],
  ["public/evidence/media/pg-2-v2-public-preview-phone.png", "90b4929c550ece32d1ca979d58e22f85a8998a2b2c761385a01a616b6495c025"],
];

test("the Pages content ships byte for byte: the JSON, the three Page files and the preview picture", () => {
  for (const [file, hash] of SHIPPED) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), hash, file);
});

test("each Page file the example data names loads from the shipped file, and PG-1's file is the example data's own", () => {
  assert.equal(PAGE_FILES["pages/search-results-layout.html"], fs.readFileSync("src/data/pages/search-results-layout.html", "utf8"));
  assert.equal(PAGE_FILES["pages/bridge-runbook.html"], fs.readFileSync("src/data/pages/bridge-runbook.html", "utf8"));
  assert.equal(PAGE_FILES["pages/bridge-runbook-v1.html"], fs.readFileSync("src/data/pages/bridge-runbook-v1.html", "utf8"));
  assert.match(PAGE_FILES["pages/mission-control.html"], /Mission control: quarterdeck/);
});

test("the Queue is the content's 11-card table with the Join card left out: 10 waiting in the same order", async () => {
  const world = await make().load();
  const want = CONTENT.queueAfter.order.map((item) => item.id).filter((id) => id !== "join-1");
  assert.deepEqual(waitingIds(world), want);
  assert.equal(want.length, 10);
  assert.equal(CONTENT.queueAfter.order.length, 11);
  const rows = rankQueue(world.cards, world.tasks, NOW);
  assert.equal(placeInQueue(rows, "dr-kivo-2"), "8 of 10 in the Queue");
  assert.equal(CONTENT.queueAfter.order.find((item) => item.id === "dr-kivo-2").position, "9 of 11 in the Queue");
});

test("every Queue card still carries the content's priority and unblock count", async () => {
  const world = await make().load();
  const rows = rankQueue(world.cards, world.tasks, NOW);
  for (const item of CONTENT.queueAfter.order.filter((entry) => entry.id !== "join-1")) {
    const row = rows.find((candidate) => candidate.card.id === item.id);
    assert.deepEqual([row.card.priority, row.unblocking.length], [item.priority, item.unblocks], item.id);
  }
});

test("Lane and Project waiting counts follow the content's, less the Join card that comes in a later change", async () => {
  const world = await make().load();
  const rows = rankQueue(world.cards, world.tasks, NOW);
  const byLane = (id) => rows.filter((row) => row.card.laneId === id).length;
  for (const [id, count] of Object.entries(CONTENT.queueAfter.waitingByLane)) {
    if (world.lanes.some((lane) => lane.id === id)) assert.equal(byLane(id), id === "l-set" ? count - 1 : count, id);
  }
  const byProject = (id) => rows.filter((row) => row.card.projectId === id).length;
  assert.deepEqual(
    ["heron-forge", "quarterdeck", "dale-tools"].map(byProject),
    [CONTENT.queueAfter.waitingByProject["heron-forge"], CONTENT.queueAfter.waitingByProject.quarterdeck - 1, CONTENT.queueAfter.waitingByProject["dale-tools"]],
  );
});

test("the make-public card is a one-way card with options A and B, P2, due Thu Nov 5 5 PM, in Lane Search, naming PG-2", async () => {
  const world = await make().load();
  const card = world.cards.find((item) => item.id === "dr-kivo-2");
  assert.equal(card.title, 'Make "Search results layout" public?');
  assert.deepEqual([card.priority, card.owner, card.projectId, card.laneId, card.approvalDoor], ["P2", "Dr. Kivo", "quarterdeck", "l-sea", "one-way"]);
  assert.deepEqual(card.options.map((option) => [option.letter, option.pick, option.door]), [["A", true, "one-way"], ["B", false, "two-way"]]);
  assert.equal(card.options[0].label, "Make version 2 public");
  assert.equal(card.options[1].label, "Keep it private");
  assert.deepEqual(card.evidence, ["PG-2"]);
  assert.equal(card.unblocks.length, 0);
  assert.equal(card.answer, null);
  assert.equal(card.seenAt, null);
  assert.equal(card.about, "Dr. Kivo asks to share a Page publicly.");
});

test("the card's times equal the content's labels in New York time", async () => {
  const world = await make().load();
  const card = world.cards.find((item) => item.id === "dr-kivo-2");
  const row = CONTENT.queueAfter.order.find((item) => item.id === "dr-kivo-2");
  assert.equal(dueLong(card.due, NOW).startsWith(row.dueText + " ET"), true, dueLong(card.due, NOW));
  assert.equal(dueShort(card.due), "Thu 5 PM");
  assert.equal(clockTime(card.addedAt), "9:30 AM");
  const evidence = await make().evidence("dr-kivo-2");
  assert.equal(clockTime(evidence.links[0].at), "9:28 AM");
});

test("the card meets the card contract: its parts fit the budget and its one-way pick names its risk", async () => {
  const world = await make().load();
  const waiting = world.cards.filter((item) => item.answer === null);
  assert.deepEqual(cardCheck(waiting), []);
  const body = CONTENT.taskCardsAdd[0].card;
  assert.ok(body.title.length <= BUDGET.title);
  assert.ok(body.about.length <= BUDGET.about);
  assert.ok(body.options.length >= BUDGET.options_min && body.options.length <= BUDGET.options_max);
  assert.ok(body.context.split("\n").length <= BUDGET.context_lines);
  const art = body.ascii.split("\n");
  assert.ok(art.length <= BUDGET.art_lines && art.every((line) => line.length <= BUDGET.art_cols));
  assert.equal(body.due, "2026-11-05T17:00:00-05:00");
});

test("picking A asks once, in the one-way words, with the red block and the risk above the options", async () => {
  const world = await make().load();
  const card = world.cards.find((item) => item.id === "dr-kivo-2");
  assert.equal(oneWayBlock(card).risk, "Anyone with the link can read and copy it, and copies cannot be recalled. It is not sent to search engines.");
  const sent = answerStep(card, startAnswer(card), { type: "send", at: 1000 });
  assert.equal(sent.phase, "confirm");
  assert.deepEqual(confirmPrompt(card, sent), { question: "Send A? This cannot be undone.", button: "Confirm: send A" });
  const kept = answerStep(card, answerStep(card, startAnswer(card), { type: "choose", choice: { kind: "option", letter: "B" } }), { type: "send", at: 1000 });
  assert.equal(kept.phase, "sending");
});

test("the card's evidence is the exact public version's preview, and both it and alba-1 now read See all on Page", async () => {
  const data = make();
  const world = await data.load();
  const evidence = await data.evidence("dr-kivo-2");
  assert.deepEqual(evidence.links.map((link) => [link.id, link.kind, link.title, link.shot, link.gated]), [
    ["ev-d2-public-preview", "preview", "Public preview: version 2", "/evidence/media/pg-2-v2-public-preview-phone.png", true],
  ]);
  assert.equal(fs.existsSync("public" + evidence.links[0].shot), true);
  const card = world.cards.find((item) => item.id === "dr-kivo-2");
  assert.deepEqual(evidenceView(card, world, evidence, 6, NOW).seeAll, { page: "PG-2", text: "See all 2 on Page" });
  const alba = world.cards.find((item) => item.id === "alba-1");
  assert.deepEqual(evidenceView(alba, world, await data.evidence("alba-1"), 6, NOW).seeAll, { page: "PG-2", text: "See all 8 on Page" });
});

test("the example Pages carry the content's Lane, pinned, public, file and version facts", async () => {
  const world = await make().load();
  const byRef = Object.fromEntries(world.pages.map((page) => [page.ref, page]));
  assert.deepEqual(world.pages.map((page) => page.ref), ["PG-1", "PG-2", "PG-3"]);
  assert.deepEqual([byRef["PG-1"].laneId, byRef["PG-1"].pinned, byRef["PG-1"].public, byRef["PG-1"].live], [null, true, null, true]);
  assert.deepEqual([byRef["PG-2"].laneId, byRef["PG-2"].pinned, byRef["PG-2"].public, byRef["PG-2"].file, byRef["PG-2"].current], ["l-sea", false, null, "pages/search-results-layout.html", 2]);
  assert.deepEqual([byRef["PG-3"].laneId, byRef["PG-3"].file, byRef["PG-3"].current, byRef["PG-3"].versions.map((version) => version.file)], ["l-sw2", "pages/bridge-runbook.html", 2, ["pages/bridge-runbook-v1.html", "pages/bridge-runbook.html"]]);
  assert.deepEqual(byRef["PG-3"].public, { version: 1, madeBy: "Captain", madeAt: "2026-11-01T17:30:00-05:00", link: PUBLIC_ADDRESS, removal: "none" });
  assert.equal(clockTime(byRef["PG-3"].updatedAt), "9:35 AM");
  assert.equal(whenText(byRef["PG-3"].public.madeAt, NOW), "Sun 5:30 PM");
  assert.equal(Object.values(byRef).filter((page) => page.pinned).length, 1);
  assert.equal(Object.values(byRef).filter((page) => page.public).length, 1);
});

test("the Pages list reads like the content's: the phone line and the Mac table cells, for each project", async () => {
  const world = await make().load();
  for (const [projectId, listing] of Object.entries(CONTENT.listViews)) {
    const rows = rowsOf(world, projectId);
    assert.deepEqual(rows.map((row) => row.ref), listing.rows.map((row) => row.ref), projectId);
    listing.rows.forEach((want, at) => {
      const row = rows[at];
      assert.equal(row.meta.join(" · "), want.phoneLine, want.ref);
      assert.deepEqual(
        { Title: row.title + (row.live ? " ●" : ""), Lane: row.lane ?? "(no Lane)", "Made by": row.by, Updated: row.updated, Visibility: row.visibility },
        want.table,
        want.ref,
      );
      assert.deepEqual(row.live ? ["● Live"] : row.visibility === "Public" ? ["Public"] : [], want.marks, want.ref);
    });
  }
});

test("the viewer's head reads like the content's for each Page: line, marks and the more menu", async () => {
  const world = await make().load();
  const laneName = (page) => (page.laneId ? world.lanes.find((lane) => lane.id === page.laneId).name : null);
  for (const [ref, want] of Object.entries(CONTENT.headers)) {
    const page = world.pages.find((item) => item.ref === ref);
    assert.equal(pages.headParts(page, laneName(page), NOW).join(" · "), want.line, ref);
    assert.deepEqual(pages.marksOf(page), want.marks.map((mark) => mark.replace("● ", "")), ref);
    assert.deepEqual(pages.menuItems(page).map((item) => item.label), want.menu.map((label) => label.replace(/\s+↗$/, "")), ref);
    assert.equal(want.botMade, "Bot-made Page");
    assert.deepEqual(want.buttons, ["↗ New tab", "⋯"]);
  }
});

test("PG-3 opens at version 1 with Version 2 is ready, and beside the Public mark Version 2 is newer and still private", async () => {
  const world = await make().load();
  const page = world.pages.find((item) => item.ref === "PG-3");
  const viewing = pages.startViewing(page, null);
  assert.deepEqual(viewing, { shown: CONTENT.versionReady.reading, trying: null });
  assert.equal(pages.readyLine(pages.readyVersion(page, viewing)), CONTENT.versionReady.line);
  assert.equal(CONTENT.versionReady.button, "Show");
  assert.equal(pages.publicLine(page).newer, CONTENT.versionReady.publicLine);
  assert.equal(CONTENT.versionReady.publicButton, "Update public version");
  assert.equal(clockTime(CONTENT.versionReady.readingSince), "9:20 AM");
  assert.equal(clockTime(CONTENT.versionReady.readyAt), "9:35 AM");
  assert.equal(pages.publicLine(page).text, "Public, version 1");
});

test("PF-4: Show moves him to version 2 and a fresh open of the Page starts at version 2", async () => {
  const world = await make().load();
  const page = world.pages.find((item) => item.ref === "PG-3");
  const shown = pages.landed(pages.showReady(page, pages.startViewing(page, null)));
  assert.equal(shown.shown, 2);
  assert.equal(pages.fileOfVersion(page, shown.shown), "pages/bridge-runbook.html");
  assert.match(PAGE_FILES["pages/bridge-runbook.html"], /Undo a batch that fails\./);
  assert.match(PAGE_FILES["pages/bridge-runbook-v1.html"], /Version 1/);
  assert.deepEqual(pages.startViewing({ ...page, reading: null }, null), { shown: 2, trying: null });
});

test("PF-2: approving the card makes PG-2 public at version 2 by the Captain at 10:00 AM, and the Queue loses the card", async () => {
  const data = make();
  const before = await data.load();
  const given = await data.answer("dr-kivo-2", { choice: { kind: "option", letter: "A" }, note: "", version: 1 });
  assert.equal(clockTime(given.at), "10:00 AM");
  const after = await data.load();
  const page = after.pages.find((item) => item.ref === "PG-2");
  assert.deepEqual([page.public.version, page.public.madeBy, clockTime(page.public.madeAt), page.public.removal], [2, "Captain", "10:00 AM", "none"]);
  assert.match(page.public.link, CAPABILITY_ADDRESS);
  assert.equal(pages.publicLine(page).newer, null);
  assert.deepEqual(pages.marksOf(page), ["Public"]);
  const want = fixtureFlow("PF-2").leaves.afterStep2;
  const ids = want.queue.order.map((item) => item.id).filter((id) => id !== "join-1");
  assert.deepEqual(waitingIds(after), ids);
  assert.equal(waitingIds(after).length, waitingIds(before).length - 1);
  assert.equal(want.queue.waiting, 10);
  const rows = rowsOf(after, "quarterdeck");
  assert.deepEqual([rows.find((row) => row.ref === want.pageRow.ref).visibility, pages.marksOf(page)], [want.pageRow.visibility, want.pageRow.marks]);
  assert.equal(after.cards.find((card) => card.id === "dr-kivo-2").answer.choice.letter, "A");
});

test("PF-2: picking B leaves the Page private", async () => {
  const data = make();
  await data.load();
  await data.answer("dr-kivo-2", { choice: { kind: "option", letter: "B" }, note: "", version: 1 });
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-2").public, null);
});

test("PF-2: a send that fails makes nothing public", async () => {
  const data = make({ fail: new Set(["send"]) });
  await data.load();
  await assert.rejects(data.answer("dr-kivo-2", { choice: { kind: "option", letter: "A" }, note: "", version: 1 }));
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-2").public, null);
});

async function madePrivateAfterPublic(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = make();
  await data.load();
  await data.answer("dr-kivo-2", { choice: { kind: "option", letter: "A" }, note: "", version: 1 });
  const address = (await data.load()).pages.find((item) => item.ref === "PG-2").public.link;
  await data.unpublishPage("PG-2");
  return { data, address, page: async () => (await data.load()).pages.find((item) => item.ref === "PG-2") };
}

test("PF-2: making it private says removal pending, with the address still shown", async (t) => {
  const { address, page } = await madePrivateAfterPublic(t);
  assert.deepEqual(pages.publicLine(await page()), { text: "Public, removal pending", newer: null, link: address, removing: true });
});

test("PF-2: until the host confirms, the Public mark stays and Visibility reads Public", async (t) => {
  const { page } = await madePrivateAfterPublic(t);
  const pending = await page();
  assert.deepEqual(pages.marksOf(pending), ["Public"]);
  assert.equal(pages.visibilityOf(pending), "Public");
});

test("PF-2: a second Make private while removal is pending is refused", async (t) => {
  const { data } = await madePrivateAfterPublic(t);
  await assert.rejects(data.unpublishPage("PG-2"), { name: "Refused" });
});

test("PF-2: once the host confirms, the Public mark is gone and Visibility reads Private", async (t) => {
  const { page } = await madePrivateAfterPublic(t);
  t.mock.timers.tick(3000);
  const gone = await page();
  assert.equal(gone.public, null);
  assert.deepEqual(pages.marksOf(gone), []);
  assert.equal(pages.visibilityOf(gone), "Private");
});

test("PF-2: once the host confirms, the more menu offers Make public again", async (t) => {
  const { page } = await madePrivateAfterPublic(t);
  t.mock.timers.tick(3000);
  assert.deepEqual(pages.menuItems(await page()).map((item) => item.id), ["copy-link", "open", "make-public"]);
});

test("PF-2: the card stays answered after the Page goes private again", async (t) => {
  const { data } = await madePrivateAfterPublic(t);
  t.mock.timers.tick(3000);
  assert.equal((await data.load()).cards.find((card) => card.id === "dr-kivo-2").answer.choice.letter, "A");
});

test("the Pages fixtures file holds the six flows PF-1 to PF-5 and PF-139", () => {
  assert.deepEqual(FIXTURES.fixtures.map((item) => item.fixture.split(" ")[0]), ["PF-1", "PF-2", "PF-3", "PF-4", "PF-5", "PF-139"]);
});

test("PF-5: updating the public version of PG-3 to version 2 keeps its one address, and a private Page can be made public from the viewer", async () => {
  const data = make();
  await data.load();
  await data.publishPage("PG-3", 2);
  const world = await data.load();
  const page = world.pages.find((item) => item.ref === "PG-3");
  assert.deepEqual(pages.publicLine(page), { text: "Public, version 2", newer: null, link: PUBLIC_ADDRESS, removing: false });
  assert.equal(clockTime(page.public.madeAt), "10:00 AM");
  await assert.rejects(data.publishPage("PG-3", 2), { name: "Refused" });
  await data.publishPage("PG-2", 2);
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-2").public.version, 2);
  await assert.rejects(data.publishPage("PG-2", 7), { name: "Refused" });
  await assert.rejects(data.unpublishPage("PG-1"), { name: "Refused" });
  assert.equal(waitingIds(await data.load()).includes("dr-kivo-2"), true);
});

test("PF-1 and PF-3: the fixture Pages load only with ?fixtures=pages in a fixtures build, and PF-3's file really does not exist", async () => {
  assert.equal(readSwitches("?fixtures=pages").fixtures, "off");
  assert.equal(readSwitchesWithFixtures("?fixtures=pages").fixtures, "pages");
  const off = await make({ fixtures: "pages" }).load();
  assert.deepEqual(off.pages.map((page) => page.ref), ["PG-1", "PG-2", "PG-3"]);
  const on = make({ fixtures: "pages" }, withFixtures);
  const world = await on.load();
  assert.deepEqual(world.pages.map((page) => page.ref).sort(), ["PG-1", "PG-139", "PG-2", "PG-3", "PG-8", "PG-9"]);
  const draft = world.pages.find((page) => page.ref === "PG-9");
  assert.deepEqual([draft.file, draft.laneId, draft.pinned, draft.public, draft.versions], [null, null, false, null, []]);
  const row = rowsOf(world, "quarterdeck").find((item) => item.ref === "PG-9");
  assert.deepEqual([row.meta.join(" · "), row.visibility, row.live], [fixtureFlow("PF-1").steps[0].expect.match(/'([^']+)'/)[1], "Private", false]);
  assert.deepEqual(pages.menuItems(draft).map((item) => item.id), ["copy-link"]);
  const missing = world.pages.find((page) => page.ref === "PG-8");
  assert.equal(missing.file, "pages/fx-missing-page.html");
  await assert.rejects(on.openPage(missing.file));
  for (const file of fixtureFlow("PF-3").state.missingFiles) assert.equal(PAGE_FILES[file], undefined, file);
});

const FIXTURE_MARKS = ["PG-8", "PG-9", "Draft notes", "Load test", "fx-missing"];

async function appCode(fixtures) {
  const built = await esbuild.build({
    entryPoints: ["src/shell/main.tsx"],
    bundle: true,
    write: false,
    outdir: "bundle",
    splitting: true,
    chunkNames: "chunk-[hash]",
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    minify: true,
    legalComments: "none",
    loader: { ".html": "text" },
    define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: String(fixtures), "process.env.NODE_ENV": '"production"' },
  });
  return built.outputFiles.filter((file) => file.path.endsWith(".js")).map((file) => file.text).join("\n");
}

test("the default build's code holds none of the fixture Pages, ids or files", async () => {
  const code = await appCode(false);
  for (const mark of FIXTURE_MARKS) assert.equal(code.includes(mark), false, mark);
});

test("a fixtures build's code holds the fixture Pages, ids and files, so the default check can fail", async () => {
  const code = await appCode(true);
  for (const mark of FIXTURE_MARKS) assert.equal(code.includes(mark), true, mark);
});

test("an opened Page file that fails to load once loads on the second try, and a file that does not exist always fails", async () => {
  const data = make({ fail: new Set(["page"]) });
  await assert.rejects(data.openPage("pages/bridge-runbook.html"));
  assert.match(await data.openPage("pages/bridge-runbook.html"), /Bridge runbook/);
  await assert.rejects(data.openPage("pages/nowhere.html"));
});

test("the pagenext switch lands one newer version on each Page that has versions once its time has passed, in a fixtures build", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = make({ pageNext: 1000 }, withFixtures);
  await data.load();
  t.mock.timers.tick(1000);
  const page = (await data.load()).pages.find((item) => item.ref === "PG-3");
  assert.equal(page.current, 3);
  assert.equal(pages.fileOfVersion(page, 3), "pages/bridge-runbook.html");
  assert.equal(pages.readyVersion(page, pages.startViewing(page, null)), 3);
});

test("the pagenext switch changes nothing before its time has passed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = make({ pageNext: 1000 }, withFixtures);
  await data.load();
  t.mock.timers.tick(999);
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-3").current, 2);
});

test("the default build ignores the pagenext switch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(readSwitches("?pagenext=1000").pageNext, 0);
  assert.equal(readSwitchesWithFixtures("?pagenext=1000").pageNext, 1000);
  const data = make({ pageNext: 1000 });
  await data.load();
  t.mock.timers.tick(1000);
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-3").current, 2);
});

test("the publish switch fails the first Make public once and then lets the next one through", async () => {
  const data = make({ fail: new Set(["publish"]) });
  await data.load();
  await assert.rejects(data.publishPage("PG-2", 2), (error) => error.name !== "Refused");
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-2").public, null);
  await data.publishPage("PG-2", 2);
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-2").public.version, 2);
});

test("public resolution returns only the current public version and follows updates without reloading", async (t) => {
  const data = make();
  await data.load();
  assert.deepEqual(await data.resolvePublicPage(PUBLIC_ADDRESS), { ref: "PG-3", version: 1, file: "pages/bridge-runbook-v1.html" });
  t.mock.method(globalThis.crypto, "getRandomValues", () => assert.fail("an update must not draw new bits"));
  await data.publishPage("PG-3", 2);
  const resolved = await data.resolvePublicPage(PUBLIC_ADDRESS);
  assert.deepEqual(resolved, { ref: "PG-3", version: 2, file: "pages/bridge-runbook.html" });
  assert.deepEqual(Object.keys(resolved).sort(), ["file", "ref", "version"]);
  await assert.rejects(data.publishPage("PG-3", 2), { name: "Refused" });
});

test("Make private revokes immediately even when an old World still shows the public address", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = make();
  const oldWorld = await data.load();
  assert.equal((await data.resolvePublicPage(PUBLIC_ADDRESS)).version, 1);
  await data.unpublishPage("PG-3");
  assert.equal(await data.resolvePublicPage(PUBLIC_ADDRESS), null);
  assert.equal(oldWorld.pages.find((item) => item.ref === "PG-3").public.removal, "none");
  await assert.rejects(data.publishPage("PG-3", 2), { name: "Refused" });
  await assert.rejects(data.unpublishPage("PG-3"), { name: "Refused" });
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-3").public.removal, "pending");
  t.mock.timers.tick(3000);
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-3").public, null);
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-3").public, null);
  assert.equal(await data.resolvePublicPage(PUBLIC_ADDRESS), null);
});

test("republishing rotates the capability and never revives a previously issued address", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = make();
  await data.load();
  await data.unpublishPage("PG-3");
  t.mock.timers.tick(3000);
  let draws = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes) => {
    if (draws++ === 0) bytes.set(Array.from({ length: 16 }, (_, at) => at));
    else bytes.fill(255);
    return bytes;
  });
  await data.publishPage("PG-3", 2);
  assert.equal(draws, 2);
  assert.equal(await data.resolvePublicPage(PUBLIC_ADDRESS), null);
  assert.deepEqual(await data.resolvePublicPage(FRESH_ADDRESS), { ref: "PG-3", version: 2, file: "pages/bridge-runbook.html" });
});

test("a new Page publication retries a collision with the existing public sample", async (t) => {
  const data = make();
  await data.load();
  let draws = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes) => {
    if (draws++ === 0) bytes.set(Array.from({ length: 16 }, (_, at) => at));
    else bytes.fill(255);
    return bytes;
  });
  await data.publishPage("PG-2", 2);
  assert.equal(draws, 2);
  assert.equal((await data.resolvePublicPage(PUBLIC_ADDRESS)).ref, "PG-3");
  assert.equal((await data.resolvePublicPage(FRESH_ADDRESS)).ref, "PG-2");
});

test("repeated capability collisions fail closed without changing publication state", async (t) => {
  const data = make();
  const before = await data.load();
  let draws = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", (bytes) => { draws += 1; bytes.set(Array.from({ length: 16 }, (_, at) => at)); return bytes; });
  await assert.rejects(data.publishPage("PG-2", 2), { name: "Refused" });
  assert.equal(draws, 16);
  assert.deepEqual((await data.load()).pages, before.pages);
});

test("public resolution refuses unknown, private-file and old-version aliases", async () => {
  const data = make();
  assert.equal(await data.resolvePublicPage(PUBLIC_ADDRESS), null);
  await data.load();
  for (const address of ["https://pages-public.example.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaa", "pages/bridge-runbook-v1.html", PUBLIC_ADDRESS + "/v/1", PUBLIC_ADDRESS + "?version=1", PUBLIC_ADDRESS + "#version=1", PUBLIC_ADDRESS + "/", "pages-public.example.com/bridge-runbook"]) {
    assert.equal(await data.resolvePublicPage(address), null, address);
  }
});

test("a repeated publish cannot bypass current state just because the UI has not reloaded", async () => {
  const data = make();
  await data.load();
  await data.publishPage("PG-2", 2);
  await assert.rejects(data.publishPage("PG-2", 2), { name: "Refused" });
});

for (const fixtures of ["off", "pages"]) {
  test("the normal build obtains exactly 128 platform-random bits with runtime fixtures " + fixtures, async (t) => {
    const data = make({ fixtures });
    await data.load();
    let draws = 0;
    t.mock.method(globalThis.crypto, "getRandomValues", (bytes) => { draws += 1; assert.equal(bytes.length, 16); bytes.fill(255); return bytes; });
    await data.publishPage("PG-2", 2);
    assert.equal(draws, 1);
    assert.equal((await data.load()).pages.find((item) => item.ref === "PG-2").public.link, FRESH_ADDRESS);
  });
}

test("the normal build refuses publication if platform randomness fails instead of falling back", async (t) => {
  const data = make({ fixtures: "pages" });
  await data.load();
  t.mock.method(globalThis.crypto, "getRandomValues", () => { throw new Error("random source unavailable"); });
  await assert.rejects(data.publishPage("PG-2", 2), { message: "random source unavailable" });
  assert.equal((await data.load()).pages.find((item) => item.ref === "PG-2").public, null);
});

test("only a fixtures build uses a repeatable capability sequence and it still rotates on republish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis.crypto, "getRandomValues", () => assert.fail("the fixture source must be compile-time selected"));
  const first = make({}, withFixtures);
  const second = make({}, withFixtures);
  await first.load();
  await second.load();
  await first.publishPage("PG-2", 2);
  await second.publishPage("PG-2", 2);
  const initial = (await first.load()).pages.find((item) => item.ref === "PG-2").public.link;
  assert.equal(initial, "https://pages-public.example.com/p/aaaaaaaaaaaaaaaaaaaaaaaaae");
  assert.equal((await second.load()).pages.find((item) => item.ref === "PG-2").public.link, initial);
  await first.unpublishPage("PG-2");
  t.mock.timers.tick(3000);
  await first.publishPage("PG-2", 2);
  const later = (await first.load()).pages.find((item) => item.ref === "PG-2").public.link;
  assert.match(later, CAPABILITY_ADDRESS);
  assert.notEqual(later, initial);
  assert.equal(await first.resolvePublicPage(initial), null);
  assert.equal((await first.resolvePublicPage(later)).ref, "PG-2");
});
