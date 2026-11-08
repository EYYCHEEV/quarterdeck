import { fileOfVersion, marksOf, makePrivate, publicAddress, publish, publishRefusal } from "./page-public";
import { countText, type FilterChoice } from "./query";
import { agoText, daysBefore, whenText } from "./time";
import type { Lane, Page } from "./types";

export { fileOfVersion, marksOf, makePrivate, publicAddress, publish, publishRefusal };

export const PUBLIC_WARNINGS = ["Anyone with the link can read and copy this exact version, without signing in.", "Not sent to search engines.", "Copies cannot be recalled."];

export const PRIVATE_DATA_CHECK = "No passwords, keys or private data found";

export type PageFilterKey = "lane" | "by" | "visibility" | "live" | "added";
export type PageSort = "updated" | "added" | "title";
export type PageQuery = { text: string; filters: Partial<Record<PageFilterKey, string>>; sort: PageSort };
export type PageGroup = { key: PageFilterKey; title: string; choices: FilterChoice[] };
export type Visibility = "Private" | "Public";
export type PageRow = { ref: string; title: string; lane: string | null; by: string; updated: string; visibility: Visibility; live: boolean; pinned: boolean; meta: string[] };
export type PagesView = { rows: PageRow[]; total: number; pinned: number; count: string; line: string; chips: { key: PageFilterKey | "sort"; text: string }[]; filterCount: number; groups: PageGroup[] };

export const EMPTY_PAGE_QUERY: PageQuery = { text: "", filters: {}, sort: "updated" };

export const PAGE_SORTS: FilterChoice[] = [
  { value: "updated", label: "Last updated" },
  { value: "added", label: "Added" },
  { value: "title", label: "Title" },
];

const SORT_LINES: Record<PageSort, string> = { updated: "Last updated first", added: "Added, newest first", title: "Title, A to Z" };
const TITLES: Record<PageFilterKey, string> = { lane: "Lane", by: "Made by", visibility: "Visibility", live: "Live", added: "Added" };
const NO_LANE = "none";

const ADDED_CHOICES: FilterChoice[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "older", label: "Older" },
];

const byName = (a: string, b: string) => a.localeCompare(b);

export function addedAt(page: Page): string {
  const first = [...page.versions].sort((a, b) => a.n - b.n)[0];
  return first ? first.madeAt : page.updatedAt;
}

export const visibilityOf = (page: Page): Visibility => (page.public ? "Public" : "Private");

function addedMatches(page: Page, bucket: string, now: number): boolean {
  const age = daysBefore(addedAt(page), now);
  if (bucket === "today") return age <= 0;
  if (bucket === "week") return age < 7;
  return age >= 7;
}

function matches(page: Page, laneName: string | null, query: PageQuery, now: number): boolean {
  const { lane, by, visibility, live, added } = query.filters;
  if (lane && (lane === NO_LANE ? page.laneId !== null : page.laneId !== lane)) return false;
  if (by && page.by !== by) return false;
  if (visibility && visibilityOf(page) !== visibility) return false;
  if (live && page.live !== (live === "live")) return false;
  if (added && !addedMatches(page, added, now)) return false;
  const words = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [page.title, laneName ?? "no Lane", page.by, page.ref].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function compare(sort: PageSort): (a: Page, b: Page) => number {
  if (sort === "title") return (a, b) => byName(a.title, b.title);
  if (sort === "added") return (a, b) => Date.parse(addedAt(b)) - Date.parse(addedAt(a));
  return (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function groupsOf(pages: Page[], laneName: (page: Page) => string | null): PageGroup[] {
  const lanes = new Map(pages.flatMap((page) => (page.laneId ? [[page.laneId, laneName(page) ?? page.laneId] as const] : [])));
  const laneChoices: FilterChoice[] = [...lanes].map(([value, label]) => ({ value, label })).sort((a, b) => byName(a.label, b.label));
  if (pages.some((page) => page.laneId === null)) laneChoices.push({ value: NO_LANE, label: "No Lane" });
  const choices = (values: string[]) => values.map((value) => ({ value, label: value }));
  return [
    { key: "lane", title: TITLES.lane, choices: laneChoices },
    { key: "by", title: TITLES.by, choices: choices([...new Set(pages.map((page) => page.by))].sort(byName)) },
    { key: "visibility", title: TITLES.visibility, choices: choices(["Private", "Public"]) },
    { key: "live", title: TITLES.live, choices: [{ value: "live", label: "Live" }, { value: "not-live", label: "Not live" }] },
    { key: "added", title: TITLES.added, choices: ADDED_CHOICES },
  ];
}

export function viewPages(world: { pages: Page[]; lanes: Pick<Lane, "id" | "name">[] }, projectId: string, query: PageQuery, now: number): PagesView {
  const pages = world.pages.filter((page) => page.projectId === projectId);
  const names = new Map(world.lanes.map((lane) => [lane.id, lane.name]));
  const laneName = (page: Page) => (page.laneId ? (names.get(page.laneId) ?? page.laneId) : null);
  const shown = pages
    .filter((page) => matches(page, laneName(page), query, now))
    .map((page, order) => ({ page, order }))
    .sort((a, b) => Number(b.page.pinned) - Number(a.page.pinned) || compare(query.sort)(a.page, b.page) || a.order - b.order)
    .map(({ page }) => page);
  const groups = groupsOf(pages, laneName);
  const rows = shown.map((page): PageRow => {
    const lane = laneName(page);
    const updated = agoText(page.updatedAt, now);
    return { ref: page.ref, title: page.title, lane, by: page.by, updated, visibility: visibilityOf(page), live: page.live, pinned: page.pinned, meta: [lane ?? "no Lane", page.by, updated] };
  });
  const keys = (Object.keys(query.filters) as PageFilterKey[]).filter((key) => query.filters[key]);
  const chips: PagesView["chips"] = [
    ...keys.map((key) => {
      const label = groups.find((group) => group.key === key)?.choices.find((choice) => choice.value === query.filters[key])?.label ?? query.filters[key];
      return { key, text: TITLES[key] + ": " + label };
    }),
    ...(query.sort === "updated" ? [] : [{ key: "sort" as const, text: "Sorted by " + (PAGE_SORTS.find((sort) => sort.value === query.sort)?.label ?? "").toLowerCase() }]),
  ];
  const count = countText(rows.length, pages.length, "Page", "Pages");
  return { rows, total: pages.length, pinned: rows.filter((row) => row.pinned).length, count, line: count + " · " + SORT_LINES[query.sort], chips, filterCount: keys.length, groups };
}

export function headParts(page: Page, lane: string | null, now: number): string[] {
  return [lane ?? "no Lane", page.by, "updated " + whenText(page.updatedAt, now)];
}

export const readingVersion = (page: Page, stored: number | null): number => Math.min(page.current, Math.max(1, stored ?? page.reading?.version ?? page.current));

export type Viewing = { shown: number; trying: number | null };

export const startViewing = (page: Page, stored: number | null): Viewing => ({ shown: readingVersion(page, stored), trying: null });

export const readyVersion = (page: Page, viewing: Viewing): number | null => (page.current > viewing.shown ? page.current : null);

export const readyLine = (version: number): string => "Version " + version + " is ready.";

export const showVersion = (viewing: Viewing, version: number): Viewing => (version === viewing.shown ? viewing : { ...viewing, trying: version });

export function showReady(page: Page, viewing: Viewing): Viewing {
  const ready = readyVersion(page, viewing);
  return ready === null ? viewing : showVersion(viewing, ready);
}

export const landed = (viewing: Viewing): Viewing => (viewing.trying === null ? viewing : { shown: viewing.trying, trying: null });

export const newerLine = (version: number): string => "Version " + version + " is newer and still private.";

export const askNewer = (page: Page, asked: number): number | null => (page.current > asked ? page.current : null);

export const askAgainLabel = (version: number): string => "Make version " + version + " public...";

export const refusalText = (error: unknown, fallback: string): string => (error instanceof Error && error.name === "Refused" ? error.message : fallback);

export type PublicLine = { text: string; newer: string | null; link: string; removing: boolean };

export function publicLine(page: Page): PublicLine | null {
  const pub = page.public;
  if (!pub) return null;
  const removing = pub.removal === "pending";
  return {
    text: removing ? "Public, removal pending" : "Public, version " + pub.version,
    newer: !removing && page.current > pub.version ? newerLine(page.current) : null,
    link: pub.link,
    removing,
  };
}

export type MenuId = "copy-link" | "open" | "make-public" | "copy-public" | "make-private";

export function menuItems(page: Page): { id: MenuId; label: string }[] {
  const items: { id: MenuId; label: string }[] = [{ id: "copy-link", label: "Copy link (Quarterdeck sign-in)" }];
  if (!page.file) return items;
  items.push({ id: "open", label: "Open in browser" });
  if (!page.public) items.push({ id: "make-public", label: "Make public..." });
  else if (page.public.removal === "none") items.push({ id: "copy-public", label: "Copy public link" }, { id: "make-private", label: "Make private" });
  return items;
}
