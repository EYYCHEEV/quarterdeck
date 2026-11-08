import type { Activity, Lane } from "../domain/types";
import type { CardThread } from "./card";
import { LANES } from "./example-content";
import { activityAdded, lanesChanged, newLanes, newTaskCards } from "./lanes-addendum.json";
import { lanes as seeded } from "./lanes-seen.json";
import { laneStream, type ActivityEntry } from "./pack-extra";
import type { ThreadExtra } from "./world";

export type RawLane = { id: string; projectId: string; name: string; status: string; lead: string; now: string; activity: ActivityEntry[] };

type Changed = { name?: string; status?: string; now?: string; activityText?: { at: string; bot: string; text: string }[] };

const CHANGED: Record<string, Changed> = lanesChanged;
const ADDED: Record<string, ActivityEntry[]> = activityAdded;
const NEW: RawLane[] = newLanes;
const SEEN: Record<string, { lastLooked: string }> = seeded;

export type SourceCard = CardThread & ThreadExtra & { laneId: string };

export function threadSources(entries: { taskCard: SourceCard; versions?: ThreadExtra["versions"] }[]): { threads: CardThread[]; extras: Map<string, ThreadExtra> } {
  return {
    threads: entries.map((entry) => entry.taskCard),
    extras: new Map(entries.map((entry) => [entry.taskCard.card.id, { laneId: entry.taskCard.laneId, edits: entry.taskCard.edits ?? [], seenAt: entry.taskCard.seenAt ?? null, versions: entry.versions ?? [] }])),
  };
}

export const SIGN_OFFS = threadSources((newTaskCards as unknown as SourceCard[]).map((taskCard) => ({ taskCard })));

const toActivity = (entry: ActivityEntry): Activity => ({
  at: entry.at,
  bot: entry.bot,
  text: entry.text,
  refs: [entry.mailRef, entry.pageRef, entry.artifactRef].filter((ref): ref is string => ref !== null),
});

const newestFirst = (a: ActivityEntry, b: ActivityEntry) => Date.parse(b.at) - Date.parse(a.at);

function reworded(laneId: string, entries: ActivityEntry[]): ActivityEntry[] {
  const texts = CHANGED[laneId]?.activityText ?? [];
  return entries.map((entry) => {
    const hit = texts.find((item) => item.bot === entry.bot && Date.parse(item.at) === Date.parse(entry.at));
    return hit ? { ...entry, text: hit.text } : entry;
  });
}

export function toLane(raw: RawLane, lastLooked: string | null): Lane {
  return {
    id: raw.id,
    projectId: raw.projectId,
    name: raw.name,
    status: raw.status === "Done" ? "Done" : "Active",
    lead: raw.lead,
    now: raw.now,
    activity: [...raw.activity].sort(newestFirst).map(toActivity),
    lastLooked,
  };
}

export function exampleLanes(): Lane[] {
  const known: RawLane[] = LANES.map((entry) => {
    const stream = laneStream(entry.id);
    const changed = CHANGED[entry.id];
    return {
      id: entry.id,
      projectId: entry.projectId,
      name: changed?.name ?? entry.name,
      status: changed?.status ?? entry.status,
      lead: stream?.lead ?? "",
      now: changed?.now ?? stream?.now ?? "",
      activity: [...reworded(entry.id, stream?.activity ?? []), ...(ADDED[entry.id] ?? [])],
    };
  });
  return [...known, ...NEW].map((raw) => toLane(raw, SEEN[raw.id]?.lastLooked ?? null));
}
