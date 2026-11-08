import { isChanged, tasksUnblocked, unblocksText } from "./queue";
import { parseReference } from "./references";
import { clockTime, dueShort } from "./time";
import type { Card, CardOption, World } from "./types";

export type Recap = { about: string | null; project: string; lane: string; unblocks: string; tasks: string[]; now: string | null };

export type EvidenceTile = {
  kind: "Page" | "Artifact" | "Mail" | "More";
  code: string;
  title: string;
  meta: string;
  lines: string[];
  opens: boolean;
};

export type CheckFailure = { id: string; title: string; missing: string[] };

const KIND_ORDER = { page: 0, artifact: 1, mail: 2 } as const;

const sentence = (text: string) => text.charAt(0).toLowerCase() + text.slice(1).replace(/\.$/, "");

const lastChange = (card: Card) => card.changes.at(-1) ?? null;

export function recapOf(card: Card, world: Pick<World, "cards" | "tasks" | "projects" | "lanes">): Recap {
  const tasks = tasksUnblocked(card, new Set(world.cards.map((c) => c.id)), new Map(world.tasks.map((t) => [t.id, t])));
  const latest = lastChange(card);
  return {
    about: card.about ?? card.description,
    project: world.projects.find((p) => p.id === card.projectId)?.name ?? card.projectId,
    lane: world.lanes.find((l) => l.id === card.laneId)?.name ?? card.laneId,
    unblocks: unblocksText(tasks.length).toLowerCase(),
    tasks: tasks.map((t) => t.title),
    now: latest ? latest.by + " " + sentence(latest.what) : null,
  };
}

export function changeLine(card: Card): string | null {
  const latest = lastChange(card);
  if (!latest) return null;
  const head = latest.by + " changed it at " + clockTime(latest.at);
  return latest.following ? head + ", following your message: " + latest.following : head + ".";
}

export function noAnswerLine(card: Card): string | null {
  if (!card.skip) return null;
  return card.due ? card.skip.replace(/^If no answer by due:/, "If no answer by " + dueShort(card.due) + ":") : card.skip;
}

export function changedLabel(card: Card): string | null {
  if (!isChanged(card)) return null;
  const marks = [...card.changes, ...card.versions].map((entry) => ({ by: entry.by, at: entry.at }));
  const latest = marks.reduce<{ by: string; at: string } | null>((best, mark) => (!best || Date.parse(mark.at) > Date.parse(best.at) ? mark : best), null);
  return latest ? "Changed by " + latest.by + " at " + clockTime(latest.at) : "New";
}

export function versionsFold(card: Card): string {
  const count = card.versions.length || card.changes.length;
  return count ? "Earlier versions (" + count + ")" : "Earlier versions";
}

function tileOf(code: string, world: Pick<World, "pages" | "artifacts" | "mail">): EvidenceTile | null {
  const ref = parseReference(code);
  if (ref?.kind === "page") {
    const page = world.pages.find((p) => p.ref === code);
    if (!page) return null;
    const meta = page.file ? "By " + page.by + " · Updated " + clockTime(page.updatedAt) : "No file yet";
    return { kind: "Page", code, title: page.title, meta, lines: [], opens: page.file !== null };
  }
  if (ref?.kind === "artifact") {
    const artifact = world.artifacts.find((a) => a.ref === code);
    if (!artifact) return null;
    const kind = artifact.kind.charAt(0).toUpperCase() + artifact.kind.slice(1);
    return { kind: "Artifact", code, title: artifact.name, meta: kind + " · " + artifact.name, lines: artifact.text.split("\n").slice(0, 3), opens: true };
  }
  if (ref?.kind === "mail") {
    const thread = world.mail.find((t) => t.ref === ref.thread);
    const first = thread?.mails[0];
    if (!thread || !first) return null;
    return { kind: "Mail", code, title: first.from, meta: first.text.split("\n")[0], lines: [], opens: true };
  }
  return null;
}

export function evidenceTiles(card: Card, world: Pick<World, "pages" | "artifacts" | "mail">): EvidenceTile[] {
  const rank = (code: string) => {
    const kind = parseReference(code)?.kind;
    return kind ? KIND_ORDER[kind] : 3;
  };
  return [...card.evidence].sort((a, b) => rank(a) - rank(b)).flatMap((code) => tileOf(code, world) ?? []);
}

export const pickOf = (card: Card): CardOption | null => card.options.find((option) => option.pick) ?? null;

export function oneWayBlock(card: Card): { risk: string } | null {
  const pick = pickOf(card);
  return pick && pick.door === "one-way" ? { risk: pick.risk ?? "" } : null;
}

export function cardCheck(cards: Card[]): CheckFailure[] {
  return cards.flatMap((card) => {
    const missing = [
      ...(card.about ? [] : ["recap"]),
      ...(card.ascii ? [] : ["picture"]),
      ...(card.changes.length && !card.versions.length ? ["earlier versions"] : []),
      ...(card.options.some((option) => option.door === "one-way" && !option.risk) ? ["one-way risk"] : []),
    ];
    return missing.length ? [{ id: card.id, title: card.title, missing }] : [];
  });
}
