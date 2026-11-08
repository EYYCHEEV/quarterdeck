import type { AnswerState } from "./answer";
import { choiceText } from "./query";
import { clockTime, dueShort, isPastDue } from "./time";
import type { Card } from "./types";

export function versionLine(card: Card): { head: string; instruction: string | null } | null {
  const latest = card.changes.at(-1);
  if (!latest) return null;
  const saved = card.versions.at(-1)?.version ?? 0;
  const number = saved + 1 + Math.max(0, card.changes.length - card.versions.length);
  const head = "Version " + number + " \u00B7 " + latest.by + " \u00B7 " + clockTime(latest.at);
  if (!latest.following) return { head, instruction: null };
  const when = latest.followingAt ? ", " + clockTime(latest.followingAt) : "";
  return { head, instruction: "Changed on your instruction in chat" + when + ': "' + latest.following + '"' };
}

export function pastDueLine(card: Card, now: number): string | null {
  if (!card.due || !card.skip || !isPastDue(card.due, now)) return null;
  return "No answer by " + dueShort(card.due) + ", so " + card.skip.replace(/^If no answer by due:\s*/, "");
}

export function openFailedText(limited: boolean): string {
  return limited ? "Too many opens this minute. Wait up to a minute, then Try again." : "Could not load this Task Card.";
}

export function sendingText(state: AnswerState): string {
  const choice = state.choice;
  return choice && choice.kind !== "approve" && choice.kind !== "reject" ? "Sending " + choiceText(choice) + " ..." : "Sending ...";
}

export function failedText(state: AnswerState): string {
  return state.limited ? "Not sent: too many sends this minute. Wait up to a minute, then Try again." : "Not sent. Try again.";
}
