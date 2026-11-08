import type { Page, PublicPage } from "../domain/types";
import type { CardThread, CardV1, Level } from "./card";
import type { RawEvidence } from "./evidence";
import type { ProjectPage } from "./pack-extra";
import { evidenceAdd, pages as pageExtras, taskCardsAdd } from "./pages.json";

type RawVersion = { n: number; madeAt: string; madeBy: string; file: string | null; kept: boolean };
type RawPublic = { version: number; madeBy: string; madeAt: string; link: string };

export type RawPage = ProjectPage & {
  laneId?: string | null;
  pinned?: boolean;
  public?: RawPublic | null;
  current?: number;
  versions?: RawVersion[];
  captainOpened?: { version: number; at: string } | null;
};

export type PageCard = { card: CardV1; rev: number; from: string; at: string; priority: string; type: string; unblocks: string[]; makePublic: { pageRef: string; version: number } };

type PagesFile = { pages: (Partial<RawPage> & { ref: string })[]; taskCardsAdd: PageCard[]; evidenceAdd: Record<string, RawEvidence> };

export type PageChange = { public: PublicPage | null };

const FILE = { pages: pageExtras, taskCardsAdd, evidenceAdd } as unknown as PagesFile;
const EXTRAS = new Map(FILE.pages.map((entry) => [entry.ref, entry]));

export const PUBLISHES = new Map(FILE.taskCardsAdd.map((entry) => [entry.card.id, entry.makePublic]));

export const pageEvidence = (cardId: string): RawEvidence | undefined => FILE.evidenceAdd[cardId];

export function pageCardThreads(entries: PageCard[] = FILE.taskCardsAdd): CardThread[] {
  return entries.map((entry) => ({
    card: structuredClone(entry.card),
    rev: entry.rev,
    from: entry.from,
    at: entry.at,
    priority: entry.priority as Level,
    type: entry.type,
    unblocks: entry.unblocks,
    comments: [],
    answers: [],
  }));
}

export const fixturePages = (file: { fixtures: { state: { pages?: RawPage[] } }[] }): RawPage[] => file.fixtures.flatMap((entry) => entry.state.pages ?? []);

function publicOf(raw: RawPublic): PublicPage {
  return { version: raw.version, madeBy: raw.madeBy, madeAt: raw.madeAt, link: raw.link.replace(/\s*\(.*\)\s*$/, ""), removal: "none" };
}

function toPage(raw: RawPage, change: PageChange | undefined): Page {
  const versions = (raw.versions ?? []).map((version) => ({ n: version.n, madeAt: version.madeAt, madeBy: version.madeBy, file: version.file, kept: version.kept }));
  return {
    ref: raw.ref,
    projectId: raw.projectId,
    title: raw.title,
    by: raw.by,
    updatedAt: raw.updatedAt,
    live: raw.live,
    file: raw.file,
    laneId: raw.laneId ?? null,
    pinned: raw.pinned ?? false,
    current: raw.current ?? versions.reduce((most, version) => Math.max(most, version.n), 1),
    versions,
    public: change ? change.public : raw.public ? publicOf(raw.public) : null,
    reading: raw.captainOpened ? { version: raw.captainOpened.version, at: raw.captainOpened.at } : null,
  };
}

export function buildPages(base: RawPage[], changes: Map<string, PageChange> | undefined): Page[] {
  return base.map((raw) => toPage({ ...raw, ...EXTRAS.get(raw.ref) }, changes?.get(raw.ref)));
}

export const rollPages = (pages: Page[], at: string): Page[] =>
  pages.map((page) => {
    if (!page.file || !page.versions.length) return page;
    const n = page.current + 1;
    return { ...page, current: n, updatedAt: at, versions: [...page.versions, { n, madeAt: at, madeBy: page.by, file: page.file, kept: true }] };
  });
