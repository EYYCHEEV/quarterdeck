import { evidenceTiles, type EvidenceTile } from "./card";
import { webAddress } from "./external-link";
import { parseReference } from "./references";
import { clockTime, whenText } from "./time";
import type { Card, CardEvidence, EvidenceCheck, EvidenceLink, EvidenceMedia, World } from "./types";

export type Thumb = { kind: "media"; media: EvidenceMedia; index: number } | { kind: "tile"; tile: EvidenceTile };

export type LinkRow = { id: string; title: string; url: string | null; hostname: string | null; shot: string; gated: boolean; when: string; status: { up: boolean; text: string } | null };

export type CheckLine = { text: string; tone: "quiet" | "pass" | "fail"; failed: string | null };

export type EvidenceView = { thumbs: Thumb[]; viewer: EvidenceMedia[]; links: LinkRow[]; check: CheckLine | null; seeAll: { page: string; text: string } | null };

const NONE: CardEvidence = { doneBy: "", pageRef: null, media: [], links: [], check: null };

export { webAddress } from "./external-link";

export function besideTargets(media: EvidenceMedia[]): EvidenceMedia[] {
  const targets = new Set(media.flatMap((item) => (item.target ? [item.target] : [])));
  return media.flatMap((item) => {
    if (targets.has(item.id)) return [];
    const target = item.target ? media.find((other) => other.id === item.target) : undefined;
    return target ? [item, target] : [item];
  });
}

export function checkLine(evidence: CardEvidence): CheckLine {
  const check: EvidenceCheck | null = evidence.check;
  if (!check || check.by === evidence.doneBy) return { text: "Not checked by another bot yet", tone: "quiet", failed: null };
  const passed = check.checks.filter((item) => item.passed).length;
  const failed = check.checks.filter((item) => !item.passed).map((item) => item.name);
  return {
    text: "Checked by " + check.by + ": " + passed + " of " + check.checks.length + " checks pass",
    tone: failed.length ? "fail" : "pass",
    failed: failed.length ? "Failed: " + failed.join(", ") : null,
  };
}

function linkRow(link: EvidenceLink, now: number): LinkRow {
  const status = link.kind === "live" && link.status ? { up: link.status === "up", text: link.status === "up" ? "up" : link.downSince ? "down since " + clockTime(link.downSince) : "down" } : null;
  const address = webAddress(link.url);
  return {
    id: link.id,
    title: link.title,
    url: address?.href ?? null,
    hostname: address?.host ?? null,
    shot: link.shot,
    gated: link.gated,
    when: (link.kind === "live" ? "delivered " : "updated ") + whenText(link.at, now),
    status,
  };
}

function moreTile(count: number, page: string | null): EvidenceTile {
  return { kind: "More", code: page ?? "", title: "+" + count + " more", meta: page ? "See all on Page" : "Show them here", lines: [], opens: true };
}

export function evidenceView(card: Card, world: Pick<World, "pages" | "artifacts" | "mail">, record: CardEvidence | null, slots: number, now: number): EvidenceView {
  const evidence = record ?? NONE;
  const viewer = besideTargets(evidence.media);
  const tiles = evidenceTiles(card, world);
  const pageCode = evidence.pageRef ?? card.evidence.find((code) => parseReference(code)?.kind === "page") ?? null;
  const page = pageCode ? world.pages.find((item) => item.ref === pageCode) : undefined;
  const seeAll = page?.file ? page.ref : null;
  const items: Thumb[] = [...viewer.map((media, index): Thumb => ({ kind: "media", media, index })), ...tiles.map((tile): Thumb => ({ kind: "tile", tile }))];
  const thumbs = items.length > slots ? [...items.slice(0, slots - 1), { kind: "tile" as const, tile: moreTile(items.length - slots + 1, seeAll) }] : items;
  const total = evidence.media.length + evidence.links.length + tiles.length;
  return {
    thumbs,
    viewer,
    links: evidence.links.map((link) => linkRow(link, now)),
    check: record ? checkLine(record) : null,
    seeAll: seeAll ? { page: seeAll, text: "See all " + total + " on Page" } : null,
  };
}

export function viewerCaption(media: EvidenceMedia, now: number): string {
  return media.caption + " · " + media.by + " " + whenText(media.at, now);
}
