import { linkParts, referenceInfo, type ReferenceInfo } from "./references";
import type { World } from "./types";

export type SettingsSection = "bots" | "appearance" | "add-ons" | "storage" | "account";

export type Route =
  | { name: "queue"; cardId: string | null }
  | { name: "lane"; laneId: string }
  | { name: "projects"; projectId: string | null }
  | { name: "pages"; projectId: string }
  | { name: "page"; projectId: string; ref: string }
  | { name: "artifact"; projectId: string; ref: string }
  | { name: "chat"; botId: string }
  | { name: "mail"; ref: string | null }
  | { name: "settings"; section?: string; botId?: string };

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseRoute(pathname: string): Route {
  const [head, id, kind, ref, extra] = pathname.split("/").filter(Boolean).map(decode);
  if (head === "queue" && !kind) return { name: "queue", cardId: id ?? null };
  if (head === "lanes" && id && !kind) return { name: "lane", laneId: id };
  if (head === "projects" && id && !ref && kind === "pages") return { name: "pages", projectId: id };
  if (head === "projects" && id && ref && !extra && kind === "pages") return { name: "page", projectId: id, ref };
  if (head === "projects" && id && ref && !extra && kind === "artifacts") return { name: "artifact", projectId: id, ref };
  if (head === "projects" && !kind) return { name: "projects", projectId: id ?? null };
  if (head === "chat" && id && !kind) return { name: "chat", botId: id };
  if (head === "mail" && !kind) return { name: "mail", ref: id ?? null };
  if (head === "settings") return { name: "settings", section: id, botId: kind };
  return { name: "queue", cardId: null };
}

const part = encodeURIComponent;

export const href = {
  queue: (cardId?: string | null) => (cardId ? "/queue/" + part(cardId) : "/queue"),
  lane: (laneId: string) => "/lanes/" + part(laneId),
  projects: (projectId?: string | null) => (projectId ? "/projects/" + part(projectId) : "/projects"),
  pages: (projectId: string) => "/projects/" + part(projectId) + "/pages",
  page: (projectId: string, ref: string) => "/projects/" + part(projectId) + "/pages/" + part(ref),
  artifact: (projectId: string, ref: string) => "/projects/" + part(projectId) + "/artifacts/" + part(ref),
  chat: (botId: string) => "/chat/" + part(botId),
  mail: (ref?: string | null) => (ref ? "/mail/" + part(ref) : "/mail"),
  settings: (section?: SettingsSection, botId?: string) => "/settings" + (section ? "/" + section : "") + (botId ? "/" + part(botId) : ""),
};

export function referenceHref(info: Pick<ReferenceInfo, "kind" | "code" | "projectId">): string {
  if (info.kind === "Mail") return href.mail(info.code);
  if (info.kind === "Page") return href.page(info.projectId, info.code);
  return href.artifact(info.projectId, info.code);
}

export type TextPart = { text: string; to: string | null };

export function linkedParts(text: string, world: Pick<World, "cards" | "mail" | "pages" | "artifacts">): TextPart[] {
  return linkParts(text, new Set(world.cards.map((card) => card.id))).map((part) => {
    if (part.kind === "card") return { text: part.text, to: href.queue(part.text) };
    if (part.kind === "text") return { text: part.text, to: null };
    const info = referenceInfo(part.text, world);
    return { text: part.text, to: info ? referenceHref(info) : null };
  });
}
