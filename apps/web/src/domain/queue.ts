import { dueShort, isPastDue } from "./time";
import type { Card, Task } from "./types";

export type WhyLine = { unblocks: string; due: string; pastDue: boolean };

export type QueueRow = { card: Card; unblocking: Task[]; why: WhyLine; changed: boolean };

const rankOf = (card: Card) => (card.priority ? Number(card.priority[1]) : 5);

export const isWaiting = (card: Pick<Card, "answer">) => card.answer === null;

export function tasksUnblocked(card: Card, cardIds: Set<string>, tasks: Map<string, Task>): Task[] {
  return card.unblocks.flatMap((id) => {
    const found = tasks.get(id);
    return found && !cardIds.has(id) ? [found] : [];
  });
}

export function latestChangeAt(card: Card): string | null {
  const times = [...card.changes.map((change) => change.at), ...card.versions.map((version) => version.at)];
  return times.length ? times.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null;
}

export function isChanged(card: Card): boolean {
  if (card.seenAt === null) return true;
  const latest = latestChangeAt(card);
  return latest !== null && Date.parse(latest) > Date.parse(card.seenAt);
}

export function unblocksText(count: number): string {
  return "Unblocks " + count + (count === 1 ? " task" : " tasks");
}

function whyLine(card: Card, unblocking: Task[], now: number): WhyLine {
  return {
    unblocks: card.priority ? unblocksText(unblocking.length) : "",
    due: card.due ? "Due " + dueShort(card.due) : "No due time",
    pastDue: isPastDue(card.due, now),
  };
}

const dueValue = (card: Card) => (card.due ? Date.parse(card.due) : Number.POSITIVE_INFINITY);

const touchedValue = (card: Card) => (card.priority ? 0 : Date.parse(latestChangeAt(card) ?? card.addedAt));

export function rankQueue(cards: Card[], tasks: Task[], now: number): QueueRow[] {
  const cardIds = new Set(cards.map((card) => card.id));
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  return cards
    .filter(isWaiting)
    .map((card, order) => {
      const unblocking = tasksUnblocked(card, cardIds, taskById);
      return { order, row: { card, unblocking, why: whyLine(card, unblocking, now), changed: isChanged(card) } };
    })
    .sort(
      (a, b) =>
        rankOf(a.row.card) - rankOf(b.row.card) ||
        b.row.unblocking.length - a.row.unblocking.length ||
        dueValue(a.row.card) - dueValue(b.row.card) ||
        touchedValue(b.row.card) - touchedValue(a.row.card) ||
        a.order - b.order,
    )
    .map(({ row }) => row);
}

export function placeInQueue(rows: QueueRow[], cardId: string): string {
  const at = rows.findIndex((row) => row.card.id === cardId);
  return at < 0 ? "Answered" : at + 1 + " of " + rows.length + " in the Queue";
}

const fingerprint = (card: Card) => [card.version, card.changes.length, card.priority, card.due, card.title].join("|");

export function changedWhileReading(shown: Card[], latest: Card[]): number {
  const before = new Map(shown.map((card) => [card.id, fingerprint(card)]));
  const after = new Map(latest.map((card) => [card.id, fingerprint(card)]));
  const changed = [...after].filter(([id, print]) => before.get(id) !== print).length;
  return changed + [...before.keys()].filter((id) => !after.has(id)).length;
}

export function nextAfter(rows: QueueRow[], cardId: string): string | null {
  const at = rows.findIndex((row) => row.card.id === cardId);
  const rest = rows.filter((row) => row.card.id !== cardId);
  return rest.length ? rest[Math.min(Math.max(at, 0), rest.length - 1)].card.id : null;
}
