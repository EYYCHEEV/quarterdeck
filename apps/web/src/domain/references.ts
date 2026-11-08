import type { World } from "./types";

export type Reference = { kind: "mail"; code: string; thread: string } | { kind: "page"; code: string } | { kind: "artifact"; code: string };

export type LinkPart = { kind: "text" | "ref" | "card"; text: string };

const MAIL = /^(MT-\d+)(?:\.\d+)?$/;
const PAGE = /^PG-\d+$/;
const ARTIFACT = /^AR-\d+$/;
const IN_TEXT = /\b(MT-\d+(?:\.\d+)?|PG-\d+|AR-\d+|c\d+)\b/g;

export function parseReference(text: string): Reference | null {
  const mail = MAIL.exec(text);
  if (mail) return { kind: "mail", code: text, thread: mail[1] };
  if (PAGE.test(text)) return { kind: "page", code: text };
  if (ARTIFACT.test(text)) return { kind: "artifact", code: text };
  return null;
}

export function linkParts(text: string, cardIds: Set<string>): LinkPart[] {
  const parts: LinkPart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === "text") last.text += value;
    else parts.push({ kind: "text", text: value });
  };
  let from = 0;
  for (const match of text.matchAll(IN_TEXT)) {
    const word = match[0];
    const isCard = /^c\d+$/.test(word);
    if (isCard && !cardIds.has(word)) continue;
    pushText(text.slice(from, match.index));
    parts.push({ kind: isCard ? "card" : "ref", text: word });
    from = (match.index ?? 0) + word.length;
  }
  pushText(text.slice(from));
  return parts;
}

export type ReferenceInfo = { kind: "Mail" | "Page" | "Artifact"; code: string; title: string; projectId: string };

export function referenceInfo(code: string, world: Pick<World, "mail" | "pages" | "artifacts">): ReferenceInfo | null {
  const ref = parseReference(code);
  if (ref?.kind === "mail") {
    const thread = world.mail.find((item) => item.ref === ref.thread);
    return thread ? { kind: "Mail", code, title: thread.subject, projectId: thread.projectId } : null;
  }
  if (ref?.kind === "page") {
    const page = world.pages.find((item) => item.ref === code);
    return page ? { kind: "Page", code, title: page.title, projectId: page.projectId } : null;
  }
  if (ref?.kind === "artifact") {
    const artifact = world.artifacts.find((item) => item.ref === code);
    return artifact ? { kind: "Artifact", code, title: artifact.name, projectId: artifact.projectId } : null;
  }
  return null;
}
