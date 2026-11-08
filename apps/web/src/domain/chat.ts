import { recapOf } from "./card";
import { inlineText, parseMarkdown, type Block } from "./markdown";
import { choiceText } from "./query";
import { href } from "./routes";
import { clockTime, dayHeading } from "./time";
import type { Card, World } from "./types";

export const QUIET_AFTER_MS = 10 * 60_000;

export const QUIET_TEXT = "No word for 10 minutes.";

const MINUTE = 60_000;

export type WorkingTimes = { since: string; updatedAt: string };

export type WorkingStatus = { minutes: number; quiet: boolean };

export type QuoteRange = { start: number; end: number };

export type NoteQuote = { label: string; title: string | null; text: string; to: string | null; messageId?: string; whole?: boolean; range?: QuoteRange };

export type CardQuote = { cardId: string; version: number; label: string; title: string; priority: string; recap: string[] };

export type Quote = CardQuote | NoteQuote;

export const isCardQuote = (quote: Quote): quote is CardQuote => "cardId" in quote;

export type CardVersionRef = { cardId: string; version: number };

export type ThreadQuote = { id: string; from: "captain" | "bot"; at: string; text: string };

export type SentQuote = Quote | CardVersionRef | ThreadQuote;

export const isThreadQuote = (quote: SentQuote): quote is ThreadQuote => "from" in quote;

export const isVersionRef = (quote: SentQuote): quote is CardVersionRef => "cardId" in quote && !("label" in quote);

type CardWorld = Pick<World, "cards" | "tasks" | "projects" | "lanes">;

export function workingStatus(working: WorkingTimes, now: number): WorkingStatus {
  return {
    minutes: Math.max(0, Math.floor((now - Date.parse(working.since)) / MINUTE)),
    quiet: now - Date.parse(working.updatedAt) >= QUIET_AFTER_MS,
  };
}

function readableBlock(block: Block): string {
  if (block.t === "code") return block.v;
  if (block.t === "ul" || block.t === "ol") return block.v.map((item) => "- " + inlineText(item)).join("\n");
  if (block.t === "quote") return block.v.map(readableBlock).join("\n\n");
  if (block.t === "table") return [block.head, ...block.rows].map((row) => row.map(inlineText).join("\t")).join("\n");
  return inlineText(block.v);
}

export function readableText(source: string): string {
  return parseMarkdown(source).map(readableBlock).join("\n\n");
}

export function messageQuote({ id, who, at, text, selected, range }: { id: string; who: string; at: string; text: string; selected: string | null; range?: QuoteRange }): NoteQuote {
  const canonical = readableText(text);
  const chosen = selected?.trim();
  const start = range?.start ?? (chosen ? canonical.indexOf(chosen) : -1);
  const end = range?.end ?? start + (chosen?.length ?? 0);
  const partial = !!chosen && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= canonical.length && canonical.slice(start, end) === chosen;
  return { label: who + " · " + clockTime(at), title: null, text: partial ? canonical.slice(start, end) : canonical, to: null, messageId: id, whole: !partial, ...(partial ? { range: { start, end } } : {}) };
}

export function cardQuoteLabel(card: Card): string {
  return card.answer ? "Task Card (answered " + choiceText(card.answer.choice) + ")" : "Task Card";
}

export function cardQuote(card: Card, world: CardWorld, label: string): CardQuote {
  const recap = recapOf(card, world);
  const lines = [recap.about ? "About: " + recap.about : null, "In: " + recap.project + " > " + recap.lane + ", " + recap.unblocks, recap.now ? "Now: " + recap.now : null];
  return { cardId: card.id, version: card.version, label, title: card.title, priority: card.priority, recap: lines.filter((line): line is string => line !== null) };
}

const CARD_LINE = /^About Task Card (\S+), version (\d+): "/;

export function cardLine(quote: CardQuote): string {
  return "About Task Card " + quote.cardId + ", version " + quote.version + ': "' + quote.title.replace(/\s+/g, " ").trim() + '"';
}

export function withCardLine(text: string, quote: CardQuote): string {
  const end = text.indexOf("\n");
  const first = end < 0 ? text : text.slice(0, end);
  const found = CARD_LINE.exec(first);
  if (found && found[1] === quote.cardId && Number(found[2]) === quote.version) return end < 0 ? text + "\n" : text;
  return cardLine(quote) + "\n" + (found ? text.slice(first.length + 1) : text);
}

export function cardQuoteAt(card: Card, version: number, world: CardWorld): CardQuote | null {
  if (version === Math.max(card.version, card.versions.length + 1)) return cardQuote(card, world, "Task Card");
  const record = card.versions.find((entry) => entry.version === version);
  if (!record) return null;
  return cardQuote({ ...card, version, title: record.title, about: record.about, changes: card.changes.slice(0, version - 1) }, world, "Task Card");
}

export function resolveQuote(quote: SentQuote, world: CardWorld, botName = "Bot"): Quote | null {
  if (isThreadQuote(quote)) return { label: (quote.from === "bot" ? botName : "You") + " \u00b7 " + clockTime(quote.at), title: null, text: quote.text, to: null, messageId: quote.id };
  if (!isVersionRef(quote)) return quote;
  const card = world.cards.find((item) => item.id === quote.cardId);
  return card ? cardQuoteAt(card, quote.version, world) : null;
}

export function mailQuote(mail: { ref: string; from: string; to: string[]; text: string }): NoteQuote {
  return { label: mail.ref, title: mail.from + " to " + mail.to.join(", "), text: mail.text, to: href.mail(mail.ref) };
}

export function threadQuote(thread: { ref: string; subject: string; mails: unknown[] }, bots: string[]): NoteQuote {
  const count = thread.mails.length;
  return { label: thread.ref, title: thread.subject, text: count + (count === 1 ? " mail" : " mails") + " between " + bots.join(", "), to: href.mail(thread.ref) };
}

export const SEND_RATE_TEXT = "Not sent: too many sends this minute. Wait up to a minute, then Try again.";

export const SEND_FAILED_TEXT = "Not Delivered";

export const SEND_RETRY_TEXT = "Try Again";

export const DELIVERED_TEXT = "Delivered";

export function readText(seenAt: string | null | undefined, now: number): string {
  if (!seenAt) return "Read";
  const day = dayHeading(seenAt, now);
  return "Read " + (day === "Today" ? clockTime(seenAt) : day);
}

export const MESSAGE_LIMIT = 4000;

export const SEND_LONG_TEXT = "Not sent: the message is over 4,000 characters.";

export const withinLimit = (text: string): boolean => text.length <= MESSAGE_LIMIT || (text.length <= MESSAGE_LIMIT * 2 && [...text].length <= MESSAGE_LIMIT);

export const QUOTE_LIMIT = 280;

export type WireQuote = { id: string; text: string } | CardVersionRef;

const WORD = /[\p{L}\p{N}]+/gu;

const WORD_CHAR = /[\p{L}\p{N}]/u;

const wordsOf = (text: string): string[] => text.match(WORD) ?? [];

const withoutMarks = (source: string): string => source.replace(/\]\([^)]*\)/g, "]").replace(/^\d+[.)](?=[ \t])/gm, "");

export function quoteInside(quote: string, message: string): boolean {
  const words = wordsOf(quote);
  if (words.length === 0) return quote !== "" && message.includes(quote);
  const have = wordsOf(withoutMarks(message));
  if (words.length === 1) return have.some((word) => word.includes(words[0]));
  const last = words.length - 1;
  for (let at = 0; at + words.length <= have.length; at += 1) {
    if (!have[at].endsWith(words[0]) || !have[at + last].startsWith(words[last])) continue;
    let whole = true;
    for (let n = 1; n < last && whole; n += 1) whole = have[at + n] === words[n];
    if (whole) return true;
  }
  return false;
}

export function cutQuote(text: string): string {
  const points = [...text];
  if (points.length <= QUOTE_LIMIT) return text;
  let end = QUOTE_LIMIT;
  if (WORD_CHAR.test(points[end - 1]) && WORD_CHAR.test(points[end])) {
    let start = end;
    while (start > 0 && WORD_CHAR.test(points[start - 1])) start -= 1;
    if (start > 0) end = start;
  }
  const cut = points.slice(0, end).join("").trimEnd();
  return cut === "" ? points.slice(0, QUOTE_LIMIT).join("") : cut;
}

export function wireQuote(quote: Quote, stored: string | null): WireQuote | null {
  if (isCardQuote(quote)) return { cardId: quote.cardId, version: quote.version };
  if (quote.messageId === undefined || stored === null) return null;
  const text = [quote.text, readableText(stored), withoutMarks(stored)].map(cutQuote).find((one) => one.trim() !== "" && quoteInside(one, stored));
  return text === undefined ? null : { id: quote.messageId, text };
}
