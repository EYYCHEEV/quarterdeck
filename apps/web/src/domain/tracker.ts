import { isWaiting } from "./queue";
import { plural, whenText } from "./time";
import type { Card, EvidenceCheck, Lane, LaneStatus } from "./types";

export type Mark = "done" | "current" | "todo";

export type TrackerStep = { name: string; state: Mark };

export type TrackerStage = { name: string; state: Mark; startedAt: string | null; doneAt: string | null; doneWhen: string; steps: TrackerStep[] };

export type TrackerBlocker = { what: string; waitingOn: string; onYou: boolean; since: string; taskCard: string | null; signOff: boolean };

export type TrackerDone = { at: string; checkedBy: string; signedOff: boolean };

export type Tracker = {
  doneBy: string[];
  checkedBy: string;
  stages: TrackerStage[];
  next: string | null;
  blockers: TrackerBlocker[];
  updated: { at: string; by: string };
  stagesChanged: { at: string; by: string; what: string };
  done: TrackerDone | null;
};

export type BlockerLine = { text: string; card: string | null };

export type TrackerView = {
  stageRow: string;
  folded: boolean;
  stepLine: string | null;
  countLine: string | null;
  checkLine: string | null;
  doneWhen: string | null;
  now: string | null;
  next: string | null;
  blockersHeading: string | null;
  blockers: BlockerLine[];
  doneLine: string | null;
  updated: string;
  quiet: string | null;
};

export type StepItem = { mark: string; state: Mark; name: string };

export type StepRow = { kind: "step"; item: StepItem } | { kind: "fold"; text: string; items: StepItem[] };

export type StageItem = { mark: string; state: Mark; name: string; time: string | null; doneWhen: string | null; steps: StepRow[] };

export type StageRow = { kind: "stage"; stage: StageItem } | { kind: "done"; text: string; stages: StageItem[] };

export type StagesView = { title: string; rows: StageRow[]; changed: string };

export type ProjectLine = { line: string; mark: string | null };

const MARKS: Record<Mark, string> = { done: "✓", current: "●", todo: "○" };
const ROW_LIMIT = 44;
const QUIET_AFTER_HOURS = 2;
const HOUR = 3_600_000;
const BACK_TO = "Execute";

const length = (text: string) => [...text].length;

const cut = (text: string, room: number) => (length(text) <= room ? text : [...text].slice(0, Math.max(room - 1, 0)).join("").trimEnd() + "…");

const markOf = (state: Mark) => MARKS[state];

export function isDone(tracker: Tracker): boolean {
  return tracker.done !== null && !tracker.doneBy.includes(tracker.done.checkedBy);
}

export function laneStatus(tracker: Tracker | null, fallback: LaneStatus): LaneStatus {
  if (!tracker) return fallback;
  return isDone(tracker) ? "Done" : "Active";
}

const currentIndex = (tracker: Tracker) => tracker.stages.findIndex((stage) => stage.state === "current");

const shownIndex = (tracker: Tracker) => {
  const at = currentIndex(tracker);
  return at >= 0 ? at : tracker.stages.length - 1;
};

function stepPosition(stage: TrackerStage | undefined): { at: number; of: number; name: string } | null {
  if (!stage || stage.steps.length === 0) return null;
  const at = stage.steps.findIndex((step) => step.state === "current");
  return at >= 0 ? { at: at + 1, of: stage.steps.length, name: stage.steps[at].name } : null;
}

function rowOf(stages: TrackerStage[]): { text: string; folded: boolean } {
  const whole = stages.map((stage) => markOf(stage.state) + " " + stage.name).join("  ");
  if (length(whole) <= ROW_LIMIT) return { text: whole, folded: false };
  const done = stages.filter((stage) => stage.state === "done").length;
  const more = stages.filter((stage) => stage.state === "todo").length;
  const current = stages.find((stage) => stage.state === "current");
  const before = done ? ["✓ " + done + " done"] : [];
  const after = more ? ["○ " + more + " more"] : [];
  const room = ROW_LIMIT - (before.length ? length(before[0]) + 3 : 0) - 2 - (after.length ? length(after[0]) + 3 : 0);
  const middle = current ? ["● " + cut(current.name, room)] : [];
  return { text: [...before, ...middle, ...after].join(" · "), folded: true };
}

export function quietHours(tracker: Tracker, now: number): number | null {
  if (isDone(tracker) || tracker.blockers.length) return null;
  const hours = Math.floor((now - Date.parse(tracker.updated.at)) / HOUR);
  return hours >= QUIET_AFTER_HOURS ? hours : null;
}

function blockerText(blocker: TrackerBlocker, now: number): string {
  return "! Waiting on " + (blocker.onYou ? "you" : blocker.waitingOn) + ": " + blocker.what + ", since " + whenText(blocker.since, now);
}

const doneText = (done: TrackerDone, now: number) => "Done " + whenText(done.at, now);

export function trackerView(tracker: Tracker, lane: { now: string }, now: number, check: EvidenceCheck | null = null): TrackerView {
  const row = rowOf(tracker.stages);
  const index = currentIndex(tracker);
  const stage = tracker.stages[index];
  const steps = stepPosition(stage);
  const finished = isDone(tracker);
  const quiet = quietHours(tracker, now);
  const stepLine = !row.folded && steps && stage ? cut(stage.name + ", step " + steps.at + " of " + steps.of + ": " + steps.name, ROW_LIMIT) : null;
  const countPrefix = "Stage " + (index + 1) + " of " + tracker.stages.length;
  const countLine = row.folded && stage ? (steps ? cut(countPrefix + " · step " + steps.at + " of " + steps.of + ": " + steps.name, ROW_LIMIT) : countPrefix) : null;
  const finishedCheck = !finished && index < 0 && check && !tracker.doneBy.includes(check.by) ? check : null;
  return {
    stageRow: row.text,
    folded: row.folded,
    stepLine,
    countLine,
    checkLine: finishedCheck ? "Check done by " + finishedCheck.by + ": " + finishedCheck.checks.filter((item) => item.passed).length + " of " + finishedCheck.checks.length + " pass" : null,
    doneWhen: !finished && stage ? stage.doneWhen : null,
    now: !finished && stage ? lane.now : null,
    next: !finished && stage ? tracker.next : null,
    blockersHeading: finished ? null : tracker.blockers.length ? "Blockers (" + tracker.blockers.length + ")" : "No blockers",
    blockers: finished ? [] : tracker.blockers.map((blocker) => ({ text: blockerText(blocker, now), card: blocker.onYou ? blocker.taskCard : null })),
    doneLine: finished && tracker.done ? doneText(tracker.done, now) + ". Checked by " + tracker.done.checkedBy + "." + (tracker.done.signedOff ? " Signed off by you." : "") : null,
    updated: "Updated " + whenText(tracker.updated.at, now) + " by " + tracker.updated.by,
    quiet: quiet === null ? null : "No update for " + plural(quiet, "hour"),
  };
}

export function projectLine(tracker: Tracker, now: number): ProjectLine {
  if (isDone(tracker) && tracker.done) {
    return { line: doneText(tracker.done, now) + " · " + (tracker.done.signedOff ? "signed off by you" : "checked by " + tracker.done.checkedBy), mark: null };
  }
  const at = shownIndex(tracker);
  const steps = stepPosition(tracker.stages[at]);
  const tail = " (" + (at + 1) + " of " + tracker.stages.length + ")" + (steps ? " · step " + steps.at + " of " + steps.of : "");
  const name = cut(tracker.stages[at]?.name ?? "", ROW_LIMIT - length(tail));
  const bots = [...new Set(tracker.blockers.filter((blocker) => !blocker.onYou).map((blocker) => blocker.waitingOn))];
  const quiet = quietHours(tracker, now);
  const mark = bots.length ? "! Blocked: " + bots.join(", ") : tracker.blockers.length ? "! Waiting on you" : quiet === null ? null : "No update for " + plural(quiet, "hour");
  return { line: name + tail, mark };
}

const stepItem = (step: TrackerStep): StepItem => ({ mark: markOf(step.state), state: step.state, name: step.name });

function stepRows(stage: TrackerStage, many: boolean): StepRow[] {
  if (!many) return stage.steps.map((step) => ({ kind: "step", item: stepItem(step) }));
  const done = stage.steps.filter((step) => step.state === "done");
  const at = stage.steps.findIndex((step) => step.state === "current");
  const upcoming = stage.steps.filter((step, n) => step.state === "todo" && n > at);
  const shown = [...stage.steps.filter((step) => step.state === "current"), ...upcoming.slice(0, 1)];
  const rest = upcoming.slice(1);
  return [
    ...(done.length ? [{ kind: "fold" as const, text: "✓ " + plural(done.length, "step") + " done", items: done.map(stepItem) }] : []),
    ...shown.map((step) => ({ kind: "step" as const, item: stepItem(step) })),
    ...(rest.length ? [{ kind: "fold" as const, text: "○ " + rest.length + " more " + (rest.length === 1 ? "step" : "steps"), items: rest.map(stepItem) }] : []),
  ];
}

function stageItem(stage: TrackerStage, many: boolean, now: number): StageItem {
  const time = stage.state === "done" && stage.doneAt ? "done " + whenText(stage.doneAt, now) : stage.state === "current" && stage.startedAt ? "since " + whenText(stage.startedAt, now) : null;
  return { mark: markOf(stage.state), state: stage.state, name: stage.name, time, doneWhen: stage.state === "done" ? null : stage.doneWhen, steps: stepRows(stage, many) };
}

export function stagesView(tracker: Tracker, laneName: string, now: number): StagesView {
  const many = rowOf(tracker.stages).folded;
  const done = tracker.stages.filter((stage) => stage.state === "done");
  const items = (stages: TrackerStage[]) => stages.map((stage) => stageItem(stage, many, now));
  const rows: StageRow[] = many
    ? [
        ...(done.length ? [{ kind: "done" as const, text: "✓ " + done.map((stage) => stage.name).join(", ") + " (" + done.length + " done)", stages: items(done) }] : []),
        ...items(tracker.stages.filter((stage) => stage.state !== "done")).map((stage) => ({ kind: "stage" as const, stage })),
      ]
    : items(tracker.stages).map((stage) => ({ kind: "stage", stage }));
  return {
    title: "Stages of " + laneName + (many ? " (" + tracker.stages.length + ")" : ""),
    rows,
    changed: "Changed by " + tracker.stagesChanged.by + " " + whenText(tracker.stagesChanged.at, now) + ": " + tracker.stagesChanged.what,
  };
}

function backToExecute(tracker: Tracker, at: string, by: string): Tracker {
  const named = tracker.stages.findIndex((stage) => stage.name === BACK_TO);
  const target = named >= 0 ? named : Math.min(1, tracker.stages.length - 1);
  return {
    ...tracker,
    stages: tracker.stages.map((stage, n) => {
      if (n < target) return stage;
      if (n === target) return { ...stage, state: "current", doneAt: null };
      return { ...stage, state: "todo", startedAt: null, doneAt: null, steps: stage.steps.map((step) => ({ ...step, state: "todo" })) };
    }),
    blockers: tracker.blockers.filter((blocker) => !blocker.signOff),
    done: null,
    updated: { at, by },
  };
}

export function reopen(tracker: Tracker, at: string, by: string): Tracker {
  return backToExecute(tracker, at, by);
}

type Judged = Pick<Card, "id" | "answer" | "options">;

export function verdictOf(card: Judged | undefined): "approve" | "reject" | null {
  const choice = card?.answer?.choice;
  if (!choice) return null;
  if (choice.kind === "approve" || choice.kind === "reject") return choice.kind;
  const label = choice.kind === "option" ? card?.options.find((option) => option.letter === choice.letter)?.label : undefined;
  return label === "Approve" ? "approve" : label === "Reject" ? "reject" : null;
}

function resolveSignOff(tracker: Tracker, cards: Judged[]): Tracker {
  const blocker = tracker.blockers.find((item) => item.signOff && item.taskCard);
  const card = cards.find((item) => item.id === blocker?.taskCard);
  const verdict = verdictOf(card);
  const answer = card?.answer;
  if (!blocker || !answer || !verdict) return tracker;
  if (verdict === "reject") return backToExecute(tracker, answer.at, tracker.updated.by);
  return {
    ...tracker,
    blockers: tracker.blockers.filter((item) => item !== blocker),
    done: { at: answer.at, checkedBy: tracker.checkedBy, signedOff: true },
    updated: { at: answer.at, by: tracker.updated.by },
  };
}

export function resolveTracker(tracker: Tracker, cards: Judged[]): Tracker {
  const signed = resolveSignOff(tracker, cards);
  const open = signed.blockers.filter((blocker) => !blocker.onYou || !cards.some((card) => card.id === blocker.taskCard && !isWaiting(card)));
  return open.length === signed.blockers.length ? signed : { ...signed, blockers: open };
}

export type LaneRow = { lane: Lane; tracker: Tracker | null; status: LaneStatus };

export function resolveLanes(lanes: Lane[], trackers: Record<string, Tracker>, cards: Judged[]): LaneRow[] {
  return lanes.map((lane) => {
    const own = trackers[lane.id];
    const tracker = own ? resolveTracker(own, cards) : null;
    return { lane, tracker, status: laneStatus(tracker, lane.status) };
  });
}
