import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import esbuild from "esbuild";

async function load(entry, fixtures = "true") {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: fixtures }, loader: { ".json": "json", ".html": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createExampleData } = await load("src/data/example-data.ts");
const { createExampleData: plainData } = await load("src/data/example-data.ts", "false");
const { readSwitches } = await load("src/data/switches.ts");
const { newCount, projectNewCount, anyNew, groupActivity } = await load("src/domain/seen.ts");
const { rankQueue } = await load("src/domain/queue.ts");
const { whenText } = await load("src/domain/time.ts");
const { resolveTracker } = await load("src/domain/tracker.ts");

const json = (name) => JSON.parse(fs.readFileSync("src/data/" + name, "utf8"));
const seen = json("lanes-seen.json");
const lanesFile = json("lanes.json");
const addendum = json("lanes-addendum.json");
const catchUp = json("seen-fixtures.json");
const laneFixtures = json("lanes-fixtures.json");

const make = (fixtures = "off", build = createExampleData) => build({ delay: 0, fail: new Set(), fixtures, empty: false });
const NOW = Date.parse(lanesFile.now);
const countsOf = (world) => Object.fromEntries(world.lanes.map((lane) => [lane.id, newCount(lane, world.bots)]));
const projectsOf = (world) => Object.fromEntries(world.projects.map((project) => [project.id, projectNewCount(world.lanes, project.id, world.bots)]));
const laneIn = (world, id) => world.lanes.find((item) => item.id === id);

test("the example Lanes carry last-looked counts the content wrote: Settings 2, Search 1, Matrix rooms 1, Bridge 1, Task export 2", async () => {
  const world = await make().load();
  const want = Object.fromEntries(Object.entries(seen.lanes).map(([id, lane]) => [id, lane.newCount]));
  assert.deepEqual(countsOf(world), want);
});

test("the project counts are the sums the content wrote, and the sidebar dot is on", async () => {
  const world = await make().load();
  assert.deepEqual(projectsOf(world), seen.projectCounts);
  assert.equal(anyNew(world.lanes, world.bots), seen.sidebarProjectsDot);
});

test("opening Settings clears its 2, lowers quarterdeck from 3 to 1 and moves its last look to now", async () => {
  const qd = make();
  qd.markLooked("l-set");
  const world = await qd.load();
  assert.deepEqual([projectsOf(world).quarterdeck, countsOf(world)["l-set"]], [1, 0]);
  assert.equal(Date.parse(world.lanes.find((lane) => lane.id === "l-set").lastLooked), NOW);
  assert.equal(anyNew(world.lanes, world.bots), true);
});

test("opening every Lane with something new puts the sidebar dot out", async () => {
  const qd = make();
  for (const id of ["l-set", "l-sea", "l-sw1", "l-sw2", "l-da1"]) qd.markLooked(id);
  const world = await qd.load();
  assert.equal(anyNew(world.lanes, world.bots), false);
});

test("the line for each example Lane is the content's, in New York time", async () => {
  const world = await make().load();
  for (const [id, lane] of Object.entries(seen.lanes)) {
    const mine = world.lanes.find((item) => item.id === id);
    assert.equal(groupActivity(mine, mine.lastLooked, world.bots, NOW).line, lane.line, id);
  }
});

test("the sign-off card is answered, not waiting: the Queue holds 9 cards plus the Pages card dr-kivo-2", async () => {
  const world = await make().load();
  assert.equal(rankQueue(world.cards, world.tasks, NOW).length, 10);
  const signOff = world.cards.find((card) => card.id === "dale-1");
  assert.deepEqual([signOff.answer.choice, signOff.laneId, signOff.projectId], [{ kind: "option", letter: "A" }, "l-da2", "dale-tools"]);
  assert.equal(signOff.answer.outcome.text, "Marked Dale help text Done.");
});

test("each Lane's waiting count is the content's, from the rows, with the Pages card dr-kivo-2 in Search", async () => {
  const world = await make().load();
  const rows = rankQueue(world.cards, world.tasks, NOW);
  const got = Object.fromEntries(world.lanes.map((lane) => [lane.id, rows.filter((row) => row.card.laneId === lane.id).length]));
  assert.deepEqual(got, { ...lanesFile.counts.waitingByLane, "l-sea": lanesFile.counts.waitingByLane["l-sea"] + 1 });
});

test("the addendum renames Settings, makes Bridge Active and makes Dale help text Done", async () => {
  const world = await make().load();
  assert.deepEqual([laneIn(world, "l-set").name, laneIn(world, "l-sw2").status, laneIn(world, "l-da2").status, laneIn(world, "l-da2").name], ["Settings", "Active", "Done", "Dale help text"]);
});

test("the addendum gives Bridge the now line the content wrote", async () => {
  const world = await make().load();
  assert.equal(laneIn(world, "l-sw2").now, addendum.lanesChanged["l-sw2"].now);
});

test("the addendum leaves the eight example Lanes in their order", async () => {
  const world = await make().load();
  assert.deepEqual(world.lanes.map((item) => item.id), ["l-set", "l-sea", "l-mai", "l-sid", "l-sw1", "l-sw2", "l-da1", "l-da2"]);
});

test("the addendum rewords the Settings Activity lines as the content wrote", async () => {
  const world = await make().load();
  const texts = laneIn(world, "l-set").activity.map((entry) => entry.text);
  for (const change of addendum.lanesChanged["l-set"].activityText) assert.ok(texts.includes(change.text), change.text);
});

test("every change a tracker lists has an Activity line with the same instant and bot", async () => {
  const world = await make().load();
  for (const [id, tracker] of Object.entries(lanesFile.lanes)) {
    const activity = world.lanes.find((lane) => lane.id === id).activity;
    for (const change of tracker.changes) assert.ok(activity.some((entry) => entry.bot === change.by && Date.parse(entry.at) === Date.parse(change.at)), id + " " + change.at);
  }
});

test("the three Lane Activity times keep the New York clock time the content labelled", async () => {
  const world = await make().load();
  const label = (id, text) => whenText(world.lanes.find((lane) => lane.id === id).activity.find((entry) => entry.text === text).at, NOW);
  assert.deepEqual(
    [label("l-sid", "Finished the sidebar and layout."), label("l-sw1", "Invite flow draft is ready for review."), label("l-sw2", "Finished the bridge retry work.")],
    ["Fri 12:00 PM", "Sat 10:00 AM", "Oct 21, 12:00 PM"],
  );
});

test("dale-1's evidence ships in the default build: a picture and Dr. Kivo's check", async () => {
  const evidence = await make("off", plainData).evidence("dale-1");
  assert.deepEqual([evidence.media.map((item) => item.src), evidence.check.by, evidence.check.checks.length, evidence.doneBy], [["/evidence/media/dale-1-help-phone.png"], "Dr. Kivo", 3, "Dale"]);
  assert.ok(fs.existsSync("public/evidence/media/dale-1-help-phone.png"));
});

test("?fixtures=catch-up reads as the catch-up fixtures switch", () => {
  assert.equal(readSwitches("?fixtures=catch-up").fixtures, "catch-up");
});

test("without ?fixtures=catch-up the example data holds only quarterdeck, heron-forge and dale-tools", async () => {
  assert.deepEqual((await make().load()).projects.map((project) => project.id), ["quarterdeck", "heron-forge", "dale-tools"]);
});

test("with ?fixtures=catch-up each fixture Lane carries the new count the content wrote", async () => {
  const world = await make("catch-up").load();
  const want = Object.fromEntries(catchUp.lanes.map((item) => [item.lane.id, item.newCount]));
  const got = countsOf(world);
  assert.deepEqual(Object.fromEntries(Object.keys(want).map((id) => [id, got[id]])), want);
});

test("with ?fixtures=catch-up the fixture project carries the new count the content wrote", async () => {
  assert.equal(projectsOf(await make("catch-up").load())["fx-catch-up"], catchUp.projectNewCount);
});

test("opening Some new drops the fixture project from 6 to 4", async () => {
  const qd = make("catch-up");
  qd.markLooked("fx-l-some");
  const world = await qd.load();
  assert.deepEqual([projectsOf(world)["fx-catch-up"], countsOf(world)["fx-l-some"]], [4, 0]);
});

const afterLane = catchUp.lanes.find((item) => item.lane.id === "fx-l-after");

test("a bot update after he looked still counts: fx-l-after loads with the new count the content wrote", async () => {
  assert.equal(countsOf(await make("catch-up").load())["fx-l-after"], afterLane.newCount);
});

test("opening fx-l-after takes its new count from 1 to 0 on the same source", async () => {
  const qd = make("catch-up");
  const before = countsOf(await qd.load())["fx-l-after"];
  qd.markLooked("fx-l-after");
  assert.deepEqual([before, countsOf(await qd.load())["fx-l-after"]], [1, 0]);
});

test("a Lane that was never opened counts all of its bot entries and shows no line", async () => {
  const world = await make("catch-up").load();
  const never = world.lanes.find((lane) => lane.id === "fx-l-never");
  assert.deepEqual([never.lastLooked, newCount(never, world.bots), groupActivity(never, never.lastLooked, world.bots, NOW).line], [null, 3, null]);
});

async function answerSignOff(label) {
  const qd = make("lanes");
  const before = await qd.load();
  const card = before.cards.find((item) => item.id === "fx-signoff-1");
  const letter = card.options.find((option) => option.label === label).letter;
  await qd.answer(card.id, { choice: { kind: "option", letter }, note: "", version: card.version });
  const world = await qd.load();
  return { qd, world, before: laneIn(before, "fx-l-signoff"), after: laneIn(world, "fx-l-signoff") };
}

test("after his Approve on the sign-off card the Lane's first Activity line is the content's Lane done line, by Shelvorn, at its tracker's Updated time", async () => {
  const { qd, world, after } = await answerSignOff("Approve");
  const tracker = resolveTracker((await qd.trackers())["fx-l-signoff"], world.cards);
  const recorded = laneFixtures.fixtures["LT-9"].afterApprove.tracker.done;
  const [line] = after.activity;
  assert.deepEqual([line.bot, line.text, line.at], [tracker.updated.by, recorded.activityLine, tracker.updated.at]);
  assert.deepEqual([tracker.updated.by, line.text.startsWith("Lane done.")], ["Shelvorn", true]);
});

test("his Approve on the sign-off card adds one Activity line and no more", async () => {
  const { before, after } = await answerSignOff("Approve");
  assert.equal(after.activity.length, before.activity.length + 1);
});

test("his Reject on the sign-off card adds no Activity line, because the content has no Reject line", async () => {
  const { before, after } = await answerSignOff("Reject");
  assert.deepEqual(after.activity, before.activity);
});

test("an answer on a card that is not a sign-off adds no Activity line to any Lane", async () => {
  const qd = make("lanes");
  const before = await qd.load();
  await qd.answer("alba-1", { choice: { kind: "option", letter: "A" }, note: "", version: 1 });
  const after = await qd.load();
  assert.deepEqual(after.lanes.map((lane) => [lane.id, lane.activity.length]), before.lanes.map((lane) => [lane.id, lane.activity.length]));
});

test("the Lane tracker fixtures come in only with ?fixtures=lanes", async () => {
  assert.equal(readSwitches("?fixtures=lanes").fixtures, "lanes");
  const off = await make().load();
  assert.equal(off.lanes.some((lane) => lane.id.startsWith("fx-")), false);
  const on = await make("lanes").load();
  assert.deepEqual(on.lanes.filter((lane) => lane.id.startsWith("fx-")).length, Object.keys(laneFixtures.fixtures).length);
  assert.ok(on.cards.some((card) => card.id === "fx-signoff-1"));
});

test("the trackers load for the example Lanes, and the test trackers only with ?fixtures=lanes", async () => {
  const own = await make().trackers();
  assert.deepEqual(Object.keys(own), Object.keys(lanesFile.lanes));
  const withTests = await make("lanes").trackers();
  assert.equal(Object.keys(withTests).length, Object.keys(lanesFile.lanes).length + Object.keys(laneFixtures.fixtures).length);
});

test("a plain build holds no fixture Lane, even when asked for one", async () => {
  const world = await make("lanes", plainData).load();
  assert.deepEqual([world.lanes.some((lane) => lane.id.startsWith("fx-")), world.cards.some((card) => card.id.startsWith("fx-"))], [false, false]);
  assert.equal(Object.keys(await make("lanes", plainData).trackers()).length, Object.keys(lanesFile.lanes).length);
});
