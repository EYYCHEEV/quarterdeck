import { botCalled } from "./bots";
import type { MailFilterKey, MailQuery } from "./mail-query";
import { countText, type FilterChoice } from "./query";
import { dayHeading, dayKey, dayLabel, whenText } from "./time";
import type { Bot, ForwardedBy, Mail, MailThread, World } from "./types";

export { EMPTY_MAIL_QUERY } from "./mail-query";
export type { MailFilterKey, MailQuery } from "./mail-query";
export type MailGroup = { key: MailFilterKey; title: string; choices: FilterChoice[] };
export type MailDay<T = MailThread> = { key: string; heading: string; threads: T[] };
export type MailView = { threads: MailThread[]; days: MailDay[]; count: string; chips: { key: MailFilterKey; text: string }[]; filterCount: number; groups: MailGroup[] };
export type MailWorld = Pick<World, "projects" | "lanes" | "mail" | "bots">;
export type AskChoice = { id: string; name: string; label: string; wrote: boolean };
export type ForwardQuote = { writerToRecipient: string; time: string; text: string; refs: string[] };
export type Forwarded = { ref: string; line: string; quote: ForwardQuote | null };

export const ANOTHER_BOT = "Another bot...";
export const LIST_BOTS = 2;

const TITLES: Record<MailFilterKey, string> = { project: "Project", lane: "Lane", bot: "Bot", day: "Date" };

const unique = (names: string[]) => [...new Set(names)];

export const lastMailAt = (thread: MailThread) => (thread.summary ? Date.parse(thread.summary.lastAt) : Math.max(...thread.mails.map((m) => Date.parse(m.at))));

export const participants = (mail: Mail) => unique([mail.from, ...mail.to, ...mail.cc]);

export const botsOrdered = (thread: MailThread) => (thread.summary ? thread.summary.bots : unique(thread.mails.flatMap(participants)));

const NOON_UTC = "T12:00:00Z";

const dayKeys = (thread: MailThread) => (thread.summary ? thread.summary.days : thread.mails.map((m) => dayKey(m.at)));

export const removedNames = (bots: Bot[]) => new Set(bots.filter((bot) => bot.removedAt).map((bot) => bot.name));

export const nameOf = (name: string, removed: Set<string>) => (removed.has(name) ? name + " (removed)" : name);

const named = (names: string[], removed: Set<string>) => names.map((name) => nameOf(name, removed));

export const botsLine = (thread: MailThread, removed: Set<string>) => named(botsOrdered(thread), removed).join(", ");

export function listBots(thread: MailThread): { shown: string[]; plus: number; text: string } {
  const all = botsOrdered(thread);
  const shown = all.slice(0, LIST_BOTS);
  const plus = all.length - shown.length;
  return { shown, plus, text: shown.join(", ") + (plus > 0 ? " +" + plus : "") };
}

export const toNames = (mail: Mail, removed: Set<string>) => named(mail.to, removed).join(", ");

export const toLine = (mail: Mail, removed: Set<string>) => nameOf(mail.from, removed) + " to " + toNames(mail, removed);

export const ccLine = (mail: Mail, removed: Set<string>) => (mail.cc.length ? "cc " + named(mail.cc, removed).join(", ") : null);

export const removedIn = (mail: Mail, removed: Set<string>) => participants(mail).filter((name) => removed.has(name));

function joined(names: string[], word: string): string {
  return names.length > 1 ? names.slice(0, -1).join(", ") + " " + word + " " + names[names.length - 1] : names[0];
}

export function removedNote(names: string[]): string {
  const many = names.length > 1;
  return (
    "Mail kept, read only. " +
    joined(names, "and") +
    (many ? " get" : " gets") +
    " no new mail until " +
    (many ? "they come back and claim their names" : "it comes back and claims its name") +
    ". Ask does not list " +
    joined(names, "or") +
    "."
  );
}

export function askChoices(thread: MailThread, mail: Mail | null, bots: Bot[]): AskChoice[] {
  const names = unique([...(mail ? [mail.from] : []), ...botsOrdered(thread)]);
  return names.flatMap((name) => {
    const bot = botCalled(bots, name);
    if (!bot || bot.removedAt) return [];
    const wrote = mail !== null && name === mail.from;
    return [{ id: bot.id, name: bot.name, label: wrote ? bot.name + " (wrote it)" : bot.name, wrote }];
  });
}

export const askLabels = (choices: AskChoice[]) => [...choices.map((choice) => choice.label), ANOTHER_BOT];

export const otherBots = (chosen: AskChoice[], bots: Bot[]) => bots.filter((bot) => !bot.removedAt && !chosen.some((choice) => choice.id === bot.id)).sort((a, b) => a.order - b.order);

export function findMail(world: Pick<World, "mail">, ref: string): { thread: MailThread; mail: Mail } | null {
  for (const thread of world.mail) {
    const mail = thread.mails.find((item) => item.ref === ref);
    if (mail) return { thread, mail };
  }
  return null;
}

export function forwardedFrom(world: Pick<World, "mail">, mail: Mail, removed: Set<string>, now: number): Forwarded | null {
  if (!mail.forwardedFrom) return null;
  const ref = mail.forwardedFrom.ref;
  const found = findMail(world, ref);
  const quote = found ? { writerToRecipient: toLine(found.mail, removed), time: whenText(found.mail.at, now), text: found.mail.text, refs: found.mail.refs } : null;
  return { ref, line: "Forwarded from " + ref, quote };
}

export const forwardedByLine = (item: ForwardedBy, removed: Set<string>) => "Forwarded by " + named([item.by], removed)[0] + " to " + named(item.to, removed).join(", ") + " in " + item.thread;

export function dayGroups<T>(items: readonly T[], now: number, threadOf: (item: T) => MailThread): MailDay<T>[] {
  const days: MailDay<T>[] = [];
  for (const item of items) {
    const at = new Date(lastMailAt(threadOf(item))).toISOString();
    const key = dayKey(at);
    const day = days[days.length - 1];
    if (day && day.key === key) day.threads.push(item);
    else days.push({ key, heading: dayHeading(at, now), threads: [item] });
  }
  return days;
}

function groupsOf(world: MailWorld): MailGroup[] {
  const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  const laneIds = new Set(world.mail.map((t) => t.laneId));
  const removed = removedNames(world.bots);
  const days = new Map<string, string>();
  for (const key of world.mail.flatMap((t) => dayKeys(t))) days.set(key, dayLabel(key + NOON_UTC));
  const dayChoices = [...days].sort(([a], [b]) => b.localeCompare(a));
  return [
    { key: "project", title: TITLES.project, choices: world.projects.map((p) => ({ value: p.id, label: p.name })) },
    { key: "lane", title: TITLES.lane, choices: world.lanes.filter((l) => laneIds.has(l.id)).sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({ value: l.id, label: l.name })) },
    { key: "bot", title: TITLES.bot, choices: sorted(world.mail.flatMap((t) => botsOrdered(t))).map((b) => ({ value: b, label: named([b], removed)[0] })) },
    { key: "day", title: TITLES.day, choices: dayChoices.map(([value, label]) => ({ value, label })) },
  ];
}

function matches(thread: MailThread, query: MailQuery): boolean {
  const { project, lane, bot, day } = query.filters;
  if (project && thread.projectId !== project) return false;
  if (lane && thread.laneId !== lane) return false;
  if (bot && !botsOrdered(thread).includes(bot)) return false;
  if (day && !dayKeys(thread).includes(day)) return false;
  const words = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [thread.subject, thread.ref, ...thread.mails.flatMap((m) => [m.ref, m.text])].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function viewMail(world: MailWorld, query: MailQuery, now: number): MailView {
  const groups = groupsOf(world);
  const keys = (Object.keys(query.filters) as MailFilterKey[]).filter((key) => query.filters[key]);
  const chips = keys.map((key) => {
    const label = groups.find((g) => g.key === key)?.choices.find((c) => c.value === query.filters[key])?.label ?? query.filters[key];
    return { key, text: TITLES[key] + ": " + label };
  });
  const threads = world.mail.filter((thread) => matches(thread, query)).sort((a, b) => lastMailAt(b) - lastMailAt(a));
  return { threads, days: dayGroups(threads, now, (thread) => thread), count: countText(threads.length, world.mail.length, "thread", "threads"), chips, filterCount: keys.length, groups };
}
