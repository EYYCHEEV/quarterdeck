import { verdictOf } from "../domain/tracker";
import type { Card, Lane, Project } from "../domain/types";
import type { CardThread } from "./card";
import type { RawEvidence } from "./evidence";
import { EXAMPLE_NOW } from "./example-content";
import { threadSources, toLane, type RawLane, type SourceCard } from "./lanes";
import lanesFile from "./lanes-fixtures.json";
import seenFile from "./seen-fixtures.json";
import type { ThreadExtra } from "./world";

const MINUTE = 60_000;

type RawProject = { id: string; name: string; lead: string; lastActivity: string; description: string };

export type LaneFixtureSources = { threads: CardThread[]; extras: Map<string, ThreadExtra>; added: { projects: Project[]; lanes: Lane[] } };

const projectOf = (raw: RawProject): Project => ({
  id: raw.id,
  name: raw.name,
  lead: raw.lead,
  description: raw.description,
  activeAt: new Date(Date.parse(EXAMPLE_NOW) - Number.parseInt(raw.lastActivity, 10) * MINUTE).toISOString(),
});

type LaneFixture = { lane: RawLane; signOffCard?: SourceCard; evidence?: RawEvidence; afterApprove?: { tracker: { done: { by: string; activityLine: string } } } };

const fixtures = Object.values(lanesFile.fixtures) as unknown as LaneFixture[];

export function laneFixtureSources(): LaneFixtureSources {
  const cards = fixtures.flatMap((fixture) => (fixture.signOffCard ? [{ taskCard: fixture.signOffCard }] : []));
  return {
    ...threadSources(cards),
    added: { projects: [projectOf(lanesFile.project)], lanes: fixtures.map((fixture) => toLane(fixture.lane, null)) },
  };
}

export function catchUpSources(): LaneFixtureSources {
  const entries = seenFile.lanes as unknown as { lane: RawLane; lastLooked: string | null }[];
  return {
    threads: [],
    extras: new Map(),
    added: { projects: [projectOf(seenFile.project)], lanes: entries.map((entry) => toLane(entry.lane, entry.lastLooked)) },
  };
}

export function signOffEvidence(cardId: string): RawEvidence | null {
  return fixtures.find((fixture) => fixture.signOffCard?.card.id === cardId)?.evidence ?? null;
}

export function signOffLine(card: Pick<Card, "id" | "answer" | "options">): { bot: string; text: string } | null {
  if (verdictOf(card) !== "approve") return null;
  const done = fixtures.find((fixture) => fixture.signOffCard?.card.id === card.id)?.afterApprove?.tracker.done;
  return done ? { bot: done.by, text: done.activityLine } : null;
}
