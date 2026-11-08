const ZONE = "America/New_York";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Parts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

const format = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
});

function partsOf(at: number): Parts {
  const out: Record<string, string> = {};
  for (const part of format.formatToParts(at)) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    weekday: WEEKDAYS.indexOf(out.weekday),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
  };
}

const dayNumber = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day) / DAY;

export function daysBefore(iso: string, now: number): number {
  return dayNumber(partsOf(now)) - dayNumber(partsOf(Date.parse(iso)));
}

function hourText(p: Parts, withMinutes: boolean): string {
  const twelve = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const minutes = withMinutes || p.minute ? ":" + String(p.minute).padStart(2, "0") : "";
  return twelve + minutes + (p.hour < 12 ? " AM" : " PM");
}

export const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");

export function clockTime(iso: string): string {
  return hourText(partsOf(Date.parse(iso)), true);
}

export function dueShort(iso: string): string {
  const p = partsOf(Date.parse(iso));
  return WEEKDAYS[p.weekday] + " " + hourText(p, false);
}

function timeLeft(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms < 0) return "past due";
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return "in " + plural(minutes, "min");
  if (ms < DAY) return "in " + plural(Math.floor(ms / HOUR), "hour");
  return "in " + plural(Math.floor(ms / DAY), "day");
}

export function dueLong(iso: string, now: number): string {
  const p = partsOf(Date.parse(iso));
  return WEEKDAYS[p.weekday] + " " + MONTHS[p.month - 1] + " " + p.day + ", " + hourText(p, false) + " ET, " + timeLeft(iso, now);
}

export function isPastDue(iso: string | null, now: number): boolean {
  return iso !== null && Date.parse(iso) <= now;
}

export function isDueSoon(iso: string | null, now: number): boolean {
  return iso !== null && Date.parse(iso) - now < HOUR;
}

export function agoText(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return Math.floor(ms / MINUTE) + "m ago";
  const age = daysBefore(iso, now);
  if (age <= 0) return Math.floor(ms / HOUR) + "h ago";
  if (age === 1) return "Yesterday";
  const p = partsOf(Date.parse(iso));
  return age < 7 ? WEEKDAYS[p.weekday] : MONTHS[p.month - 1] + " " + p.day;
}

export function listStamp(iso: string, now: number): string {
  const age = daysBefore(iso, now);
  if (age <= 0) return clockTime(iso);
  if (age === 1) return "Yesterday";
  const p = partsOf(Date.parse(iso));
  return MONTHS[p.month - 1] + " " + p.day;
}

export function dayHeading(iso: string, now: number): string {
  const age = daysBefore(iso, now);
  if (age <= 0) return "Today";
  return age === 1 ? "Yesterday" : dayLabel(iso);
}

export function whenText(iso: string, now: number): string {
  const age = daysBefore(iso, now);
  if (age <= 0) return clockTime(iso);
  const p = partsOf(Date.parse(iso));
  if (age < 7) return WEEKDAYS[p.weekday] + " " + clockTime(iso);
  return MONTHS[p.month - 1] + " " + p.day + ", " + clockTime(iso);
}

export function dayKey(iso: string): string {
  const p = partsOf(Date.parse(iso));
  return p.year + "-" + String(p.month).padStart(2, "0") + "-" + String(p.day).padStart(2, "0");
}

export function dayLabel(iso: string): string {
  const p = partsOf(Date.parse(iso));
  return WEEKDAYS[p.weekday] + " " + MONTHS[p.month - 1] + " " + p.day;
}

export type DueBucket = "overdue" | "today" | "week" | "later" | "none";

export function dueBucket(iso: string | null, now: number): DueBucket {
  if (iso === null) return "none";
  const at = Date.parse(iso);
  if (at < now) return "overdue";
  if (daysBefore(iso, now) === 0) return "today";
  return at - now < 7 * DAY ? "week" : "later";
}
