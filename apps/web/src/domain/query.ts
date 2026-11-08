import { latestChangeAt, rankQueue, type QueueRow } from "./queue";
import { clockTime, dueBucket } from "./time";
import type { Card, Choice, World } from "./types";

export type FilterKey = "show" | "project" | "lane" | "bot" | "priority" | "label" | "due";
export type SortKey = "ranked" | "due" | "newest" | "changed" | "project";
export type QueueQuery = { text: string; filters: Partial<Record<FilterKey, string>>; sort: SortKey };
export type Chip = { key: FilterKey | "text" | "sort"; text: string };
export type FilterChoice = { value: string; label: string; detail?: string };
export type FilterGroup = { key: FilterKey; title: string; choices: FilterChoice[] };

export type QueueView = {
  answered: boolean;
  rows: QueueRow[];
  waiting: number;
  count: string;
  chips: Chip[];
  filterCount: number;
  groups: FilterGroup[];
  sorts: FilterChoice[];
};

export const EMPTY_QUERY: QueueQuery = { text: "", filters: {}, sort: "ranked" };

export function withFilter<K extends string>(filters: Partial<Record<K, string>>, key: K, value: string | undefined): Partial<Record<K, string>> {
  const next = { ...filters };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

export function countText(shown: number, total: number, one = "", many = one): string {
  const noun = total === 1 ? one : many;
  const count = shown === total ? String(total) : shown + " of " + total;
  return noun ? count + " " + noun : count;
}

export const SORTS: FilterChoice[] = [
  { value: "ranked", label: "Ranked: priority, then tasks unblocked, then due", detail: "(default)" },
  { value: "due", label: "Due soonest" },
  { value: "newest", label: "Newest" },
  { value: "changed", label: "Recently changed" },
  { value: "project", label: "Project" },
];

const DUE_CHOICES: FilterChoice[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "none", label: "None" },
];

const TITLES: Record<FilterKey, string> = { show: "Show", project: "Project", lane: "Lane", bot: "Bot", priority: "Priority", label: "Labels", due: "Due" };
const CHIP_NAMES: Record<FilterKey, string> = { ...TITLES, label: "Label" };

const byName = (a: string, b: string) => a.localeCompare(b);
const distinct = (values: string[]) => [...new Set(values)].sort(byName);

export function labelsInUse(cards: Card[]): string[] {
  return distinct(cards.flatMap((card) => card.labels));
}

export function choiceText(choice: Choice): string {
  if (choice.kind === "option") return choice.letter;
  if (choice.kind === "none") return "None of these";
  if (choice.kind === "cant-decide") return "Can't decide";
  return choice.kind === "approve" ? "Approve" : "Reject";
}

export function answeredLine(card: Card): { line: string; waitingOn: string | null } {
  if (!card.answer) return { line: "", waitingOn: null };
  return {
    line: "You: " + choiceText(card.answer.choice) + " · " + clockTime(card.answer.at) + (card.answer.waitingOn ? "" : " · " + card.owner),
    waitingOn: card.answer.waitingOn ? "Waiting on " + card.answer.waitingOn : null,
  };
}

function filterGroups(world: World, withPriority: boolean): FilterGroup[] {
  const choices = (values: [string, string][]) => values.map(([value, label]) => ({ value, label }));
  return [
    { key: "show", title: TITLES.show, choices: choices([["waiting", "Waiting"], ["answered", "Answered"]]) },
    { key: "project", title: TITLES.project, choices: choices(world.projects.map((p) => [p.id, p.name])) },
    { key: "lane", title: TITLES.lane, choices: choices([...world.lanes].sort((a, b) => byName(a.name, b.name)).map((l) => [l.id, l.name])) },
    { key: "bot", title: TITLES.bot, choices: choices(distinct(world.cards.map((c) => c.owner)).map((b) => [b, b])) },
    ...(withPriority ? [{ key: "priority" as const, title: TITLES.priority, choices: choices(["P0", "P1", "P2", "P3", "P4"].map((p) => [p, p])) }] : []),
    { key: "label", title: TITLES.label, choices: choices(labelsInUse(world.cards).map((l) => [l, l])) },
    { key: "due", title: TITLES.due, choices: DUE_CHOICES },
  ];
}

function matchesFilters(card: Card, query: QueueQuery, world: World, now: number): boolean {
  const { project, lane, bot, priority, label, due } = query.filters;
  if (project && card.projectId !== project) return false;
  if (lane && card.laneId !== lane) return false;
  if (bot && card.owner !== bot) return false;
  if (priority && card.priority !== priority) return false;
  if (label && !card.labels.includes(label)) return false;
  if (due) {
    const bucket = dueBucket(card.due, now);
    if (due === "week" ? bucket !== "today" && bucket !== "week" : bucket !== due) return false;
  }
  const words = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const place = world.projects.find((p) => p.id === card.projectId)?.name ?? "";
  const laneName = world.lanes.find((l) => l.id === card.laneId)?.name ?? "";
  const haystack = [card.title, card.owner, place, laneName, ...card.labels].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function sortRows(rows: QueueRow[], sort: SortKey, world: World): QueueRow[] {
  const time = (iso: string | null, missing: number) => (iso ? Date.parse(iso) : missing);
  const projectName = (row: QueueRow) => world.projects.find((p) => p.id === row.card.projectId)?.name ?? "";
  const compare: Record<SortKey, (a: QueueRow, b: QueueRow) => number> = {
    ranked: () => 0,
    due: (a, b) => time(a.card.due, Infinity) - time(b.card.due, Infinity),
    newest: (a, b) => time(b.card.addedAt, 0) - time(a.card.addedAt, 0),
    changed: (a, b) => time(latestChangeAt(b.card), -Infinity) - time(latestChangeAt(a.card), -Infinity),
    project: (a, b) => byName(projectName(a), projectName(b)),
  };
  return rows
    .map((row, order) => ({ row, order }))
    .sort((a, b) => compare[sort](a.row, b.row) || a.order - b.order)
    .map(({ row }) => row);
}

function chipsOf(query: QueueQuery, groups: FilterGroup[]): Chip[] {
  const chips: Chip[] = [];
  if (query.text.trim()) chips.push({ key: "text", text: "Search: " + query.text.trim() });
  for (const group of groups) {
    const value = query.filters[group.key];
    if (!value) continue;
    if (group.key === "show") {
      if (value === "answered") chips.push({ key: "show", text: "Answered, newest first" });
      continue;
    }
    const label = group.choices.find((choice) => choice.value === value)?.label ?? value;
    chips.push({ key: group.key, text: CHIP_NAMES[group.key] + ": " + label });
  }
  if (query.sort !== "ranked") chips.push({ key: "sort", text: "Sorted by " + (SORTS.find((s) => s.value === query.sort)?.label ?? "").toLowerCase() });
  return chips;
}

function answeredRows(world: World, now: number): QueueRow[] {
  const answered = world.cards.filter((card) => card.answer !== null);
  const asWaiting = rankQueue(answered.map((card) => ({ ...card, answer: null })), world.tasks, now);
  const byId = new Map(answered.map((card) => [card.id, card]));
  return asWaiting
    .map((row) => ({ ...row, card: byId.get(row.card.id) ?? row.card }))
    .sort((a, b) => Date.parse(b.card.answer?.at ?? "") - Date.parse(a.card.answer?.at ?? ""));
}

export function viewQueue(world: World, query: QueueQuery, now: number): QueueView {
  const withPriority = world.cards.some((card) => card.priority);
  const groups = filterGroups(world, withPriority);
  const answered = query.filters.show === "answered";
  const waitingRows = rankQueue(world.cards, world.tasks, now);
  const pool = answered ? answeredRows(world, now) : waitingRows;
  const rows = sortRows(
    pool.filter((row) => matchesFilters(row.card, query, world, now)),
    query.sort,
    world,
  );
  const filterCount = (Object.keys(query.filters) as FilterKey[]).filter((key) => query.filters[key] && !(key === "show" && query.filters[key] === "waiting")).length;
  const narrowed = Boolean(query.text.trim()) || (Object.keys(query.filters) as FilterKey[]).some((key) => key !== "show" && query.filters[key]);
  const waiting = waitingRows.length;
  const count = answered ? "Answered" : !narrowed ? waiting + " waiting" : rows.length + " of " + waiting + " waiting";
  return { answered, rows, waiting, count, chips: chipsOf(query, groups), filterCount, groups, sorts: withPriority ? SORTS : SORTS.slice(1) };
}
