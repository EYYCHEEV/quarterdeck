import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { toTracker } = await loadTs("src/data/trackers.ts");
const { trackerView, projectLine, stagesView, resolveTracker, resolveLanes, reopen, isDone, laneStatus, quietHours } = await loadTs("src/domain/tracker.ts");
const { whenText } = await loadTs("src/domain/time.ts");

const lanesFile = JSON.parse(fs.readFileSync("src/data/lanes.json", "utf8"));
const fixtureFile = JSON.parse(fs.readFileSync("src/data/lanes-fixtures.json", "utf8"));
const NOW = Date.parse(lanesFile.now);

const trackers = Object.entries(lanesFile.lanes).map(([id, raw]) => ({ name: id, raw, laneNow: raw.now }));
const fixtures = Object.entries(fixtureFile.fixtures).map(([id, entry]) => ({ name: id, raw: entry.tracker, laneNow: entry.tracker.now, entry }));

const checkOf = (raw) => (raw ? { by: raw.by, checks: raw.checks.map((item) => ({ name: item.name, passed: item.result === "pass" })) } : null);

const viewOf = (item, at = NOW, check = null) => trackerView(toTracker(item.raw), { now: item.laneNow }, at, check);

function linesOf(view) {
  return [
    view.stageRow,
    view.stepLine ?? view.countLine,
    view.checkLine,
    view.doneWhen && "Done when: " + view.doneWhen,
    view.now && "Now: " + view.now,
    view.next && "Next: " + view.next,
    view.blockersHeading,
    ...view.blockers.map((blocker) => blocker.text),
    view.doneLine,
    view.updated,
    view.quiet && view.quiet + ".",
  ].filter((line) => line !== null && line !== undefined);
}

function sheetOf(view) {
  const lines = [view.title];
  const stage = (item) => {
    const doneWhen = item.doneWhen === null ? "" : "Done when: " + item.doneWhen;
    const head = item.mark + " " + item.name + (item.time ? "  " + item.time : "");
    if (item.mark === "●") {
      lines.push(head);
      for (const row of item.steps) lines.push(row.kind === "step" ? "   " + row.item.mark + " " + row.item.name : "   " + row.text + "  ▸");
      lines.push("  " + doneWhen);
    } else lines.push(item.mark === "○" ? head + "  " + doneWhen : head);
  };
  for (const row of view.rows) {
    if (row.kind === "done") lines.push(row.text + "  ▸");
    else stage(row.stage);
  }
  lines.push(view.changed);
  return lines;
}

const tracker = (item) => toTracker(item.raw);

const YES_NO = [
  { letter: "A", label: "Yes" },
  { letter: "B", label: "No" },
];
const APPROVE_REJECT = [
  { letter: "A", label: "Approve" },
  { letter: "B", label: "Reject" },
];
const answerOf = (choice) => ({ choice, at: "2026-11-02T09:30:00-05:00" });
const answered = (id, choice = { kind: "option", letter: "A" }) => ({ id, options: YES_NO, answer: answerOf(choice) });
const waitingCard = (id) => ({ id, options: YES_NO, answer: null });
const signOffCard = (letter) => ({ id: "fx-signoff-1", options: APPROVE_REJECT, answer: answerOf({ kind: "option", letter }) });

test("every Lane's tracker shows the lines the content wrote", () => {
  for (const item of trackers) assert.deepEqual(linesOf(viewOf(item)), item.raw.display.trackerLines, item.name);
});

test("every fixture's tracker shows the lines the content wrote", () => {
  for (const item of fixtures) {
    const check = item.entry.evidence ? checkOf(item.entry.evidence.check) : null;
    assert.deepEqual(linesOf(viewOf(item, NOW, check)), item.raw.display.trackerLines, item.name);
  }
});

test("the Project view row of every Lane and fixture is the content's line and mark", () => {
  for (const item of [...trackers, ...fixtures]) {
    const row = projectLine(tracker(item), NOW);
    assert.deepEqual([row.line, row.mark], [item.raw.display.projectLine, item.raw.display.projectMark], item.name);
  }
});

test("Stages lists every Lane and fixture as the content wrote it", () => {
  for (const item of [...trackers, ...fixtures]) assert.deepEqual(sheetOf(stagesView(tracker(item), item.raw.lane, NOW)), item.raw.display.stagesSheet, item.name);
});

test("a stage row of exactly 44 characters shows every name, and 45 folds into done, current and more", () => {
  const fits = trackerView(tracker(fixtures[1]), { now: "" }, NOW);
  const folds = trackerView(tracker(fixtures[2]), { now: "" }, NOW);
  assert.deepEqual([fits.folded, [...fits.stageRow].length, fits.stageRow], [false, 44, "✓ Plan  ● Execute  ○ Check on iPhone and Mac"]);
  assert.deepEqual([folds.folded, folds.stageRow, folds.countLine], [true, "✓ 1 done · ● Execute · ○ 1 more", "Stage 2 of 3"]);
});

test("five short stages that fit stay on one line, because the length decides, not the count", () => {
  const view = trackerView(tracker(fixtures[3]), { now: "" }, NOW);
  assert.deepEqual([view.folded, [...view.stageRow].length, view.stageRow], [false, 41, "✓ Plan  ✓ Draft  ● Build  ○ Check  ○ Ship"]);
});

test("a folded row cuts the current name with an ellipsis so the row is 44 characters", () => {
  const view = trackerView(tracker(trackers.find((item) => item.name === "l-da1")), { now: "" }, NOW);
  assert.deepEqual([view.stageRow, [...view.stageRow].length], ["✓ 3 done · ● Build the export sh… · ○ 3 more", 44]);
  assert.deepEqual([view.countLine, [...view.countLine].length], ["Stage 4 of 7 · step 5 of 12: Add the Owner…", 43]);
});

test("a folded row with no steps counts only the stage", () => {
  assert.equal(trackerView(tracker(fixtures[4]), { now: "" }, NOW).countLine, "Stage 4 of 7");
  assert.equal(projectLine(tracker(fixtures[4]), NOW).line, "Execute (4 of 7)");
});

test("a Lane with no steps shows no step line and no count line", () => {
  const view = trackerView(tracker(fixtures[0]), { now: "" }, NOW);
  assert.deepEqual([view.stepLine, view.countLine, projectLine(tracker(fixtures[0]), NOW).line], [null, null, "Execute (2 of 3)"]);
});

test("a blocker waiting on a bot has no link and marks the Project row Blocked", () => {
  const view = trackerView(tracker(fixtures[5]), { now: "" }, NOW);
  assert.deepEqual(view.blockers, [{ text: "! Waiting on Dale: The export folder is ready, since Sun 4:00 PM", card: null }]);
  assert.equal(projectLine(tracker(fixtures[5]), NOW).mark, "! Blocked: Dale");
});

test("a blocker waiting on him links to its Task Card and marks the Project row Waiting on you", () => {
  const sea = trackers.find((item) => item.name === "l-sea");
  assert.deepEqual(trackerView(tracker(sea), { now: "" }, NOW).blockers, [{ text: "! Waiting on you: How many results should each Search group show?, since 9:05 AM", card: "alba-1" }]);
  assert.equal(projectLine(tracker(sea), NOW).mark, "! Waiting on you");
});

test("a Lane turns quiet at 2 hours and counts whole hours down", () => {
  const quiet = fixtures[6];
  const base = tracker(quiet);
  for (const step of quiet.entry.timeline) {
    const shown = trackerView(base, { now: "" }, Date.parse(step.at)).quiet;
    assert.equal(shown, step.show, step.at);
  }
});

test("a Lane is not quiet after a bot update", () => {
  const quiet = fixtures[6];
  const update = quiet.entry.afterBotUpdate;
  const updated = { ...tracker(quiet), updated: { at: update.at, by: update.by } };
  assert.equal(quietHours(updated, NOW), null);
});

const blockedQuiet = () => {
  const quiet = fixtures[6];
  const added = quiet.entry.afterBlocker;
  return { added, blocked: { ...tracker(quiet), updated: { at: added.at, by: added.by }, blockers: [{ what: "A folder", waitingOn: added.waitingOn, onYou: false, since: added.at, taskCard: null, signOff: false }] } };
};

test("a Lane with a blocker is not quiet", () => {
  assert.equal(quietHours(blockedQuiet().blocked, NOW), null);
});

test("the Project row of a quiet Lane that gets a blocker on a bot shows the content's mark", () => {
  const { added, blocked } = blockedQuiet();
  assert.equal(projectLine(blocked, NOW).mark, added.projectMark);
});

test("the one quiet Lane in the example data says 20 hours", () => {
  const mail = tracker(trackers.find((item) => item.name === "l-mai"));
  assert.deepEqual([quietHours(mail, NOW), projectLine(mail, NOW).mark], [20, "No update for 20 hours"]);
});

test("a Check done by the bot that did the work does not make the Lane Done, and another bot's does", () => {
  const own = fixtures[7];
  assert.deepEqual([isDone(tracker(own)), laneStatus(tracker(own), "Active")], [false, "Active"]);
  const after = toTracker(own.entry.afterSecondCheck.tracker);
  assert.deepEqual([isDone(after), laneStatus(after, "Active")], [true, "Done"]);
  const selfChecked = { ...after, done: { ...after.done, checkedBy: after.doneBy[0] } };
  assert.deepEqual([isDone(selfChecked), laneStatus(selfChecked, "Done")], [false, "Active"]);
});

test("a Lane that stays Active because the bot that did the work checked it turns quiet after 3 hours", () => {
  const after = toTracker(fixtures[7].entry.afterSecondCheck.tracker);
  const selfChecked = { ...after, done: { ...after.done, checkedBy: after.doneBy[0] }, updated: { at: new Date(NOW - 3 * 3_600_000).toISOString(), by: after.doneBy[0] } };
  assert.equal(quietHours(selfChecked, NOW), 3);
});

test("a pending sign-off shows as a blocker with the Check line, and waits on his Approve", () => {
  const pending = fixtures[8];
  const view = trackerView(tracker(pending), { now: "" }, NOW, checkOf(pending.entry.evidence.check));
  assert.deepEqual([view.checkLine, view.blockers.map((blocker) => blocker.text), view.doneWhen, view.now], ["Check done by Dr. Kivo: 3 of 3 pass", ["! Waiting on you: Sign off: Room map is done?, since 9:05 AM"], null, null]);
  assert.equal(tracker(pending).blockers[0].signOff, true);
});

const approved = () => {
  const pending = fixtures[8];
  const answer = pending.entry.afterApprove.answer;
  return { pending, answer, resolved: resolveTracker(tracker(pending), [signOffCard(answer.pick)]) };
};

test("after his Approve the Lane is Done, signed off and checked by Dr. Kivo", () => {
  const { resolved } = approved();
  assert.deepEqual([isDone(resolved), resolved.done.signedOff, resolved.done.checkedBy], [true, true, "Dr. Kivo"]);
});

test("after his Approve the sign-off blocker is gone", () => {
  assert.deepEqual(approved().resolved.blockers, []);
});

test("after his Approve the Project row reads Done at his answer time, signed off by him", () => {
  const { resolved, answer } = approved();
  assert.equal(projectLine(resolved, Date.parse(answer.at)).line, "Done 9:30 AM · signed off by you");
});

test("the Lane the content records after his Approve shows the tracker lines the content wrote", () => {
  const recorded = fixtures[8].entry.afterApprove.tracker;
  assert.deepEqual(linesOf(viewOf({ raw: recorded, laneNow: "Done. Nothing running." })), recorded.display.trackerLines);
});

test("the Lane the content records after his Approve shows the Project row line the content wrote", () => {
  const recorded = fixtures[8].entry.afterApprove.tracker;
  assert.equal(projectLine(toTracker(recorded), NOW).line, recorded.display.projectLine);
});

test("his Reject sends the Lane back to Execute and clears the sign-off blocker", () => {
  const pending = fixtures[8];
  const resolved = resolveTracker(tracker(pending), [signOffCard("B")]);
  assert.deepEqual(resolved.stages.map((stage) => stage.state), ["done", "current", "todo"]);
  assert.deepEqual([resolved.blockers, resolved.done, isDone(resolved)], [[], null, false]);
  assert.equal(trackerView(resolved, { now: "Back to work." }, NOW).stageRow, "✓ Plan  ● Execute  ○ Check");
});

test("a sign-off card that is still waiting changes nothing", () => {
  const pending = fixtures[8];
  const card = { id: "fx-signoff-1", options: [], answer: null };
  assert.deepEqual(resolveTracker(tracker(pending), [card]), tracker(pending));
});

test("None of these on the sign-off card ends its blocker and does not make the Lane Done", () => {
  const card = { id: "fx-signoff-1", options: APPROVE_REJECT, answer: answerOf({ kind: "none" }) };
  const resolved = resolveTracker(tracker(fixtures[8]), [card]);
  assert.deepEqual([resolved.blockers, isDone(resolved)], [[], false]);
});

test("answering the Task Card a blocker on him links to ends that blocker, in every example Lane", () => {
  for (const item of trackers) {
    for (const blocker of item.raw.blockers.filter((entry) => entry.waitingOnYou && entry.taskCard)) {
      const resolved = resolveTracker(tracker(item), [answered(blocker.taskCard)]);
      assert.equal(resolved.blockers.some((entry) => entry.taskCard === blocker.taskCard), false, item.name + " " + blocker.taskCard);
    }
  }
});

test("with shelvorn-2 answered, the Bridge Lane has no Waiting on you mark and no blocker in its tracker", () => {
  const bridge = trackers.find((item) => item.name === "l-sw2");
  const [row] = resolveLanes([{ id: "l-sw2", status: "Active" }], { "l-sw2": tracker(bridge) }, [answered("shelvorn-2")]);
  const view = trackerView(row.tracker, { now: "" }, NOW);
  assert.deepEqual([view.blockers, view.blockersHeading, projectLine(row.tracker, NOW).mark], [[], "No blockers", "No update for 18 hours"]);
});

test("None of these ends a blocker on him too, because the card goes back to the bot", () => {
  const sea = trackers.find((item) => item.name === "l-sea");
  assert.deepEqual(resolveTracker(tracker(sea), [answered("alba-1", { kind: "none" })]).blockers, []);
});

test("a blocker on him stays while its Task Card is waiting", () => {
  const sea = trackers.find((item) => item.name === "l-sea");
  assert.deepEqual(resolveTracker(tracker(sea), [waitingCard("alba-1")]), tracker(sea));
});

test("a blocker on a bot stays when a Task Card is answered", () => {
  const resolved = resolveTracker(tracker(fixtures[5]), [answered("alba-1")]);
  assert.equal(resolved.blockers.length, 1);
});

test("a Project view row turns Done when his Approve is on the sign-off card, and the other rows stay as they are", () => {
  const pending = fixtures[8];
  const other = trackers.find((item) => item.name === "l-sea");
  const lanes = [
    { id: pending.entry.lane.id, status: "Active" },
    { id: "l-sea", status: "Active" },
    { id: "l-plain", status: "Done" },
  ];
  const byLane = { [pending.entry.lane.id]: tracker(pending), "l-sea": tracker(other) };
  const card = { id: "fx-signoff-1", options: [{ letter: "A", label: "Approve" }, { letter: "B", label: "Reject" }], answer: { choice: { kind: "option", letter: "A" }, at: "2026-11-02T09:30:00-05:00" } };
  const before = resolveLanes(lanes, byLane, [{ ...card, answer: null }]);
  const after = resolveLanes(lanes, byLane, [card]);
  assert.deepEqual(before.map((row) => row.status), ["Active", "Active", "Done"]);
  assert.deepEqual(after.map((row) => row.status), ["Done", "Active", "Done"]);
  assert.deepEqual(after[1].tracker, tracker(other));
  assert.equal(after[2].tracker, null);
});

test("a reopened Done Lane returns to Execute with Plan done and Check still to do", () => {
  const done = fixtures[9];
  const back = reopen(tracker(done), "2026-11-02T09:00:00-05:00", "Alba");
  assert.deepEqual(back.stages.map((stage) => stage.state), ["done", "current", "todo"]);
  assert.deepEqual([back.done, isDone(back), back.updated], [null, false, { at: "2026-11-02T09:00:00-05:00", by: "Alba" }]);
});

test("a Done Lane shows its done line, and no Done when, Now, Next or blockers", () => {
  const view = viewOf(fixtures[9]);
  assert.deepEqual([view.doneLine, view.doneWhen, view.now, view.next, view.blockersHeading, view.blockers], ["Done Fri 12:41 PM. Checked by Shelvorn.", null, null, null, null, []]);
});

test("every time a tracker shows equals the New York clock time of its instant, in daylight and standard time", () => {
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
  const clock = (iso) => zone.format(new Date(iso)).replace(/\u202f/g, " ");
  const times = [];
  for (const item of [...trackers, ...fixtures]) {
    const built = tracker(item);
    times.push(built.updated.at, built.stagesChanged.at, ...built.blockers.map((blocker) => blocker.since), ...built.stages.flatMap((stage) => [stage.startedAt, stage.doneAt]).filter(Boolean));
  }
  assert.ok(times.length > 60);
  for (const iso of times) assert.ok(whenText(iso, NOW).endsWith(clock(iso)), iso + " shows " + whenText(iso, NOW) + ", the New York clock says " + clock(iso));
});
