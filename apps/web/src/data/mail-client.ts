import type { Lane, Mail, MailThread, Project } from "../domain/types";
import { Refused } from "./source";

type Raw = Record<string, unknown>;

export type MailListed = { ref: string; subject: string; project: string | null; lane: string | null; card: string | null; bots: string[]; lastAt: string; count: number; days: string[] };

export type MailListing = { threads: MailListed[]; truncated: boolean };

export type MailRead = { summary: Omit<MailListed, "days">; omitted: number; mails: Mail[] };

export type Places = { projects: Pick<Project, "id" | "name">[]; lanes: Pick<Lane, "id" | "projectId" | "name">[] };

const MAX_THREADS = 200;
const MAX_MAILS = 50;
const MAX_TO = 20;
const MAX_DAYS = 31;
const MAX_SUBJECT = 200;
const MAX_TEXT_BYTES = 16384;
const MAX_ATTACHMENTS = 50;
const MAX_NAME = 255;
const MAX_BOTS = 50;

const THREAD_REF = /^MT-[1-9][0-9]{0,8}$/;
const ARTIFACT = /^AR-[1-9][0-9]{0,8}$/;
const PAGE = /^PG-[1-9][0-9]{0,8}$/;
const LINE_BREAK = /[\r\n]/;
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === "string" && value !== "" && !LINE_BREAK.test(value) && (value.length <= MAX_NAME || [...value].length <= MAX_NAME);

const unreadable = (what: string) => new Refused("The server's answer could not be read: " + what + ".");

function realDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function timeOf(value: unknown, what: string): string {
  const parts = typeof value === "string" ? TIME.exec(value) : null;
  if (!parts || typeof value !== "string") throw unreadable(what);
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const offsetOk = parts[7] === undefined || (Number(parts[7]) <= 23 && Number(parts[8]) <= 59);
  if (!realDay(year, month, day) || hour > 23 || minute > 59 || second > 59 || !offsetOk) throw unreadable(what);
  return value;
}

function dayOf(value: unknown): string {
  const parts = typeof value === "string" ? DAY.exec(value) : null;
  if (!parts || typeof value !== "string" || !realDay(Number(parts[1]), Number(parts[2]), Number(parts[3]))) throw unreadable("a day");
  return value;
}

function threadRefOf(value: unknown): string {
  if (typeof value !== "string" || !THREAD_REF.test(value)) throw unreadable("a thread ref");
  return value;
}

function subjectOf(value: unknown): string {
  if (typeof value !== "string" || value.includes("\n")) throw unreadable("the subject");
  const length = [...value].length;
  if (length < 1 || length > MAX_SUBJECT) throw unreadable("the subject");
  return value;
}

function nameOrNull(raw: Raw, key: string): string | null {
  const value = raw[key];
  if (value === null) return null;
  if (typeof value !== "string" || value === "") throw unreadable(key);
  return value;
}

function cardOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !CARD_ID.test(value)) throw unreadable("card");
  return value;
}

function accountsOf(value: unknown, what: string, min: number, max: number, repeats: boolean): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw unreadable(what);
  for (const name of value) if (!isName(name)) throw unreadable(what);
  if (!repeats && new Set(value).size !== value.length) throw unreadable(what);
  return value as string[];
}

function countOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw unreadable("count");
  return value;
}

function daysOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DAYS) throw unreadable("days");
  const days = value.map(dayOf);
  for (let at = 1; at < days.length; at++) if (days[at] >= days[at - 1]) throw unreadable("days");
  return days;
}

function summaryOf(raw: Raw): Omit<MailListed, "days"> {
  return {
    ref: threadRefOf(raw.ref),
    subject: subjectOf(raw.subject),
    project: nameOrNull(raw, "project"),
    lane: nameOrNull(raw, "lane"),
    card: cardOf(raw.card),
    bots: accountsOf(raw.bots, "bots", 1, MAX_BOTS, false),
    lastAt: timeOf(raw.lastAt, "lastAt"),
    count: countOf(raw.count),
  };
}

function listedOf(raw: unknown): MailListed {
  if (!isRecord(raw)) throw unreadable("a thread");
  return { ...summaryOf(raw), days: daysOf(raw.days) };
}

function codesOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw unreadable("refs");
  let pages = false;
  for (const code of value) {
    const page = typeof code === "string" && PAGE.test(code);
    if (typeof code !== "string" || !(page || ARTIFACT.test(code)) || (!page && pages)) throw unreadable("refs");
    pages = pages || page;
  }
  if (new Set(value).size !== value.length) throw unreadable("refs");
  return value as string[];
}

function checkAttachments(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw unreadable("attachments");
  for (const item of value) {
    if (!isRecord(item) || !isName(item.name) || typeof item.size !== "number" || !Number.isInteger(item.size) || item.size < 0) throw unreadable("attachments");
  }
}

function mailOf(raw: unknown, thread: string, position: number): Mail {
  if (!isRecord(raw)) throw unreadable("a mail");
  const ref = thread + "." + position;
  if (raw.ref !== ref) throw unreadable("a mail ref");
  const text = raw.text;
  if (typeof text !== "string" || text.includes("\r") || new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw unreadable("a mail's text");
  if (typeof raw.cut !== "boolean") throw unreadable("cut");
  const from = raw.from;
  if (!isName(from)) throw unreadable("from");
  checkAttachments(raw.attachments);
  return { ref, from, to: accountsOf(raw.to, "to", 1, MAX_TO, true), cc: accountsOf(raw.cc, "cc", 0, 0, true), at: timeOf(raw.at, "a mail's time"), text, refs: codesOf(raw.refs) };
}

export function parseMailList(body: unknown): MailListing {
  if (!isRecord(body) || typeof body.truncated !== "boolean") throw unreadable("the list");
  const raw = body.threads;
  if (!Array.isArray(raw)) throw unreadable("threads");
  if (raw.length > MAX_THREADS) throw unreadable("too many threads");
  const threads = raw.map(listedOf);
  if (new Set(threads.map((thread) => thread.ref)).size !== threads.length) throw unreadable("a thread twice");
  return { threads, truncated: body.truncated };
}

export function parseMailThread(body: unknown): MailRead {
  const raw = isRecord(body) ? body.thread : undefined;
  if (!isRecord(raw)) throw unreadable("the thread");
  const summary = summaryOf(raw);
  const { omitted, mails } = raw;
  if (typeof omitted !== "number" || !Number.isInteger(omitted) || omitted < 0) throw unreadable("omitted");
  if (!Array.isArray(mails) || mails.length < 1 || mails.length > MAX_MAILS) throw unreadable("the mails");
  if (summary.count !== omitted + mails.length) throw unreadable("the mail count");
  return { summary, omitted, mails: mails.map((item, at) => mailOf(item, summary.ref, omitted + at + 1)) };
}

export function placeIds(places: Places, project: string | null, lane: string | null): { projectId: string; laneId: string | null } {
  if (project === null) return { projectId: "", laneId: null };
  const projectId = places.projects.find((item) => item.name === project)?.id ?? project;
  const found = lane === null ? undefined : places.lanes.find((item) => item.projectId === projectId && item.name === lane);
  return { projectId, laneId: found?.id ?? null };
}

export function threadOf(listed: MailListed, places: Places): MailThread {
  const { projectId, laneId } = placeIds(places, listed.project, listed.lane);
  return { ref: listed.ref, subject: listed.subject, projectId, laneId, cardId: listed.card, bots: listed.bots, mails: [], summary: { lastAt: listed.lastAt, bots: listed.bots, days: listed.days, count: listed.count } };
}

export function withMails(thread: MailThread, read: MailRead): MailThread {
  return { ...thread, mails: read.mails, omitted: read.omitted };
}

export function changedSince(listed: MailListed, read: MailRead): boolean {
  return listed.lastAt !== read.summary.lastAt || listed.count !== read.summary.count;
}

export function mailWorld(list: MailListed[] | null, reads: Map<string, MailRead>, places: Places): MailThread[] {
  if (list === null) return [];
  return list.map((listed) => {
    const thread = threadOf(listed, places);
    const read = reads.get(listed.ref);
    return read ? withMails(thread, read) : thread;
  });
}
