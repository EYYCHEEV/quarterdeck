import type { Mark, Tracker, TrackerStage } from "../domain/tracker";
import lanesFile from "./lanes.json";
import { laneStateTrackers } from "./lane-state-fixtures";
import type { Fixtures } from "./switches";

type RawStep = { name: string; state: string };

type RawStage = { name: string; state: string; startedAt: string | null; doneAt: string | null; doneWhen: string; steps: RawStep[] };

type RawBlocker = { what: string; waitingOn: string; waitingOnYou: boolean; since: string; taskCard: string | null };

type RawTracker = {
  plan: { endsWithSignOff: boolean; doneBy: string[]; checkedBy: string };
  stages: RawStage[];
  next: string | null;
  blockers: RawBlocker[];
  updated: { at: string; by: string };
  stagesChanged: { at: string; by: string; what: string };
  done: { at: string; checkedBy: string; signedOff: boolean } | null;
};

const markOf = (state: string): Mark => (state === "done" || state === "current" ? state : "todo");

export function toTracker(raw: RawTracker): Tracker {
  const stages: TrackerStage[] = raw.stages.map((stage) => ({
    name: stage.name,
    state: markOf(stage.state),
    startedAt: stage.startedAt,
    doneAt: stage.doneAt,
    doneWhen: stage.doneWhen,
    steps: stage.steps.map((step) => ({ name: step.name, state: markOf(step.state) })),
  }));
  const finished = stages.length > 0 && stages.every((stage) => stage.state === "done");
  return {
    doneBy: raw.plan.doneBy,
    checkedBy: raw.plan.checkedBy,
    stages,
    next: raw.next,
    blockers: raw.blockers.map((blocker) => ({
      what: blocker.what,
      waitingOn: blocker.waitingOn,
      onYou: blocker.waitingOnYou,
      since: blocker.since,
      taskCard: blocker.taskCard,
      signOff: raw.plan.endsWithSignOff && finished && blocker.taskCard !== null,
    })),
    updated: raw.updated,
    stagesChanged: raw.stagesChanged,
    done: raw.done ? { at: raw.done.at, checkedBy: raw.done.checkedBy, signedOff: raw.done.signedOff } : null,
  };
}

export async function loadTrackers(fixtures: Fixtures): Promise<Record<string, Tracker>> {
  const own = Object.entries(lanesFile.lanes as unknown as Record<string, RawTracker>).map(([id, raw]) => [id, toTracker(raw)] as const);
  if (__QD_FIXTURES__ && fixtures === "lanes") {
    const file = (await import("./lanes-fixtures.json")).default as unknown as { fixtures: Record<string, { lane: { id: string }; tracker: RawTracker }> };
    const trackers = Object.fromEntries([...own, ...Object.values(file.fixtures).map((entry) => [entry.lane.id, toTracker(entry.tracker)] as const)]);
    return laneStateTrackers(trackers);
  }
  return Object.fromEntries(own);
}
