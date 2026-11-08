import { marksOf } from "./page-public";
import { isWaiting } from "./queue";
import type { World } from "./types";

export type SearchGroup = "Chats" | "Task Cards" | "Projects" | "Lanes" | "Pages" | "Artifacts" | "Mail";

export type SearchSources = {
  chats: { id: string; name: string; role: string; preview: string }[];
  cards: { id: string; title: string; about: string; where: string; owner: string; waiting: boolean }[];
  projects: { id: string; name: string; lead: string }[];
  lanes: { id: string; name: string; projectName: string }[];
  pages: { id: string; title: string; projectId: string; where: string; by: string; marks: string[] }[];
  artifacts: { id: string; name: string; kind: string; projectId: string; projectName: string; by: string }[];
  mail: { id: string; subject: string; bots: string[] }[];
};

export type Part = { text: string; bold: boolean };

export type Hit = { group: SearchGroup; id: string; title: Part[]; detail: string; projectId: string | null };

export type Found = { group: SearchGroup; hits: Hit[]; more: number };

const GROUP_ORDER: SearchGroup[] = ["Chats", "Task Cards", "Projects", "Lanes", "Pages", "Artifacts", "Mail"];
const QUIET_CAP = 2;
const TYPED_CAP = 5;

function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

function highlight(text: string, words: string[]): Part[] {
  const lower = fold(text);
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) marked.fill(true, at, at + word.length);
  }
  const parts: Part[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.bold === marked[i]) last.text += text[i];
    else parts.push({ text: text[i], bold: marked[i] });
  }
  return parts;
}

function rank(words: string[], id: string, title: string): number {
  const first = words[0];
  if (!first) return 3;
  if (fold(id) === first) return 0;
  const name = fold(title);
  if (name.startsWith(first)) return 1;
  return name.includes(first) ? 2 : 3;
}

function found<T extends { id: string }>(items: T[], words: string[], text: (item: T) => string, title: (item: T) => string): T[] {
  return items
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => {
      const haystack = fold(text(item));
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => rank(words, a.item.id, title(a.item)) - rank(words, b.item.id, title(b.item)) || a.order - b.order)
    .map(({ item }) => item);
}

export function searchAll(query: string, sources: SearchSources, whole: readonly SearchGroup[] = []): Found[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const cap = words.length ? TYPED_CAP : QUIET_CAP;
  const hit = (group: SearchGroup, id: string, title: string, detail: string, projectId: string | null = null): Hit => ({ group, id, title: highlight(title, words), detail, projectId });
  const cards = found(sources.cards, words, (c) => [c.id, c.title, c.about, c.where, c.owner].join(" "), (c) => c.title).filter((c) => c.waiting || words.length);
  const byGroup: Record<SearchGroup, Hit[]> = {
    Chats: found(sources.chats, words, (c) => [c.name, c.role, c.preview].join(" "), (c) => c.name).map((c) => hit("Chats", c.id, c.name, c.role + " · " + c.preview)),
    "Task Cards": [...cards.filter((c) => c.waiting), ...cards.filter((c) => !c.waiting)].map((c) =>
      hit("Task Cards", c.id, c.title, c.owner + " · " + c.where + (c.waiting ? "" : " · Answered")),
    ),
    Projects: found(sources.projects, words, (p) => p.name + " " + p.lead, (p) => p.name).map((p) => hit("Projects", p.id, p.name, "Lead " + p.lead)),
    Lanes: found(sources.lanes, words, (l) => l.name + " " + l.projectName, (l) => l.name).map((l) => hit("Lanes", l.id, l.name, l.projectName)),
    Pages: found(sources.pages, words, (p) => [p.id, p.title, p.where, p.by].join(" "), (p) => p.title).map((p) => hit("Pages", p.id, p.title, [p.where, p.by, ...p.marks].join(" · "), p.projectId)),
    Artifacts: found(sources.artifacts, words, (a) => [a.id, a.name, a.kind, a.by, a.projectName].join(" "), (a) => a.name).map((a) =>
      hit("Artifacts", a.id, a.name, [a.id, a.kind.charAt(0).toUpperCase() + a.kind.slice(1), a.projectName].join(" · "), a.projectId),
    ),
    Mail: found(sources.mail, words, (m) => [m.subject, ...m.bots, m.id].join(" "), (m) => m.subject).map((m) => hit("Mail", m.id, m.subject, m.id + " · " + m.bots.join(", "))),
  };
  return GROUP_ORDER.flatMap((group) => {
    const all = byGroup[group];
    const shown = whole.includes(group) ? all : all.slice(0, cap);
    return all.length ? [{ group, hits: shown, more: all.length - shown.length }] : [];
  });
}

export function searchSources(world: World, chats: SearchSources["chats"]): SearchSources {
  const projectName = new Map(world.projects.map((project) => [project.id, project.name]));
  const laneName = new Map(world.lanes.map((lane) => [lane.id, lane.name]));
  return {
    chats,
    cards: world.cards.map((card) => ({
      id: card.id,
      title: card.title,
      about: card.about ?? "",
      where: (projectName.get(card.projectId) ?? card.projectId) + " > " + (laneName.get(card.laneId) ?? card.laneId),
      owner: card.owner,
      waiting: isWaiting(card),
    })),
    projects: world.projects.map((project) => ({ id: project.id, name: project.name, lead: project.lead })),
    lanes: world.lanes.map((lane) => ({ id: lane.id, name: lane.name, projectName: projectName.get(lane.projectId) ?? lane.projectId })),
    pages: world.pages.map((page) => ({
      id: page.ref,
      title: page.title,
      projectId: page.projectId,
      where: (projectName.get(page.projectId) ?? page.projectId) + " · " + (page.laneId ? (laneName.get(page.laneId) ?? page.laneId) : "no Lane"),
      by: page.by,
      marks: marksOf(page),
    })),
    artifacts: world.artifacts.map((artifact) => ({
      id: artifact.ref,
      name: artifact.name,
      kind: artifact.kind,
      projectId: artifact.projectId,
      projectName: projectName.get(artifact.projectId) ?? artifact.projectId,
      by: artifact.by,
    })),
    mail: world.mail.map((thread) => ({ id: thread.ref, subject: thread.subject, bots: thread.bots })),
  };
}
