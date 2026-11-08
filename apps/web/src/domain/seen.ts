import { whenText } from "./time";
import type { Activity, Bot, Lane } from "./types";

type Looked = Pick<Lane, "activity" | "lastLooked">;

const fromBot = (entry: Activity, bots: Pick<Bot, "name">[]) => bots.some((bot) => bot.name === entry.bot);

const newestFirst = (a: Activity, b: Activity) => Date.parse(b.at) - Date.parse(a.at);

function isAfterLook(entry: Activity, lastLooked: string | null): boolean {
  return lastLooked === null || Date.parse(entry.at) > Date.parse(lastLooked);
}

export function newCount(lane: Looked, bots: Pick<Bot, "name">[]): number {
  return lane.activity.filter((entry) => fromBot(entry, bots) && isAfterLook(entry, lane.lastLooked)).length;
}

export function projectNewCount(lanes: (Looked & { projectId: string })[], projectId: string, bots: Pick<Bot, "name">[]): number {
  return lanes.filter((lane) => lane.projectId === projectId).reduce((sum, lane) => sum + newCount(lane, bots), 0);
}

export function anyNew(lanes: Looked[], bots: Pick<Bot, "name">[]): boolean {
  return lanes.some((lane) => newCount(lane, bots) > 0);
}

export function menuDot(lanes: Looked[], bots: Pick<Bot, "name">[], chats: { bot: { id: string }; unread: boolean }[] | null, openBotId: string | null): boolean {
  return anyNew(lanes, bots) || Boolean(chats?.some((row) => row.unread && row.bot.id !== openBotId));
}

export type ActivityGroups = { fresh: Activity[]; seen: Activity[]; line: string | null };

export function groupActivity(lane: Pick<Lane, "activity">, lastLooked: string | null, bots: Pick<Bot, "name">[], now: number): ActivityGroups {
  const sorted = [...lane.activity].sort(newestFirst);
  const fresh = sorted.filter((entry) => isAfterLook(entry, lastLooked));
  const counted = newCount({ activity: lane.activity, lastLooked }, bots) > 0;
  return {
    fresh,
    seen: sorted.filter((entry) => !isAfterLook(entry, lastLooked)),
    line: counted && lastLooked !== null ? "You last looked: " + whenText(lastLooked, now) : null,
  };
}
