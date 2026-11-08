import type { CardEvidence } from "../domain/types";
import { mediaPath } from "./media";

type RawMedia = {
  id: string;
  kind: string;
  role?: string;
  file: string;
  caption: string;
  by: string;
  at: string;
  target?: string;
  poster?: string;
  length?: string;
  type?: string;
};

type RawLink = {
  id: string;
  kind: string;
  title: string;
  url: string;
  shot: string;
  updatedAt?: string;
  deliveredAt?: string;
  gated?: boolean;
  status?: string;
  downSince?: string;
};

export type RawEvidence = {
  doneBy: string;
  pageRef?: string;
  media: RawMedia[];
  links: RawLink[];
  check: { by: string; checks: { name: string; result: string }[] } | null;
};

export type EvidenceFile = { cards: Record<string, RawEvidence> };

export type EvidenceFixtureFile = { fixtures: { taskCard: { card: { id: string } }; evidence: RawEvidence }[] };

export const MEDIA_BASE = __QD_PREVIEW__ ? "evidence/" : "/evidence/";

const EVIDENCE_MEDIA = `${MEDIA_BASE}media/` as const;

export function toEvidence(raw: RawEvidence): CardEvidence {
  return {
    doneBy: raw.doneBy,
    pageRef: raw.pageRef ?? null,
    media: raw.media.map((item) => ({
      id: item.id,
      kind: item.kind === "video" ? "video" : "image",
      role: item.role === "build" || item.role === "target" ? item.role : "image",
      src: mediaPath(item.file, item.kind === "video" ? "video" : "image", EVIDENCE_MEDIA),
      caption: item.caption,
      by: item.by,
      at: item.at,
      target: item.target ?? null,
      poster: item.poster === undefined ? null : mediaPath(item.poster, "image", EVIDENCE_MEDIA),
      length: item.length ?? null,
      type: item.type ?? null,
    })),
    links: raw.links.map((link) => ({
      id: link.id,
      kind: link.kind === "live" ? "live" : "preview",
      title: link.title,
      url: link.url,
      shot: mediaPath(link.shot, "image", EVIDENCE_MEDIA),
      at: (link.kind === "live" ? link.deliveredAt : link.updatedAt) ?? "",
      gated: link.gated ?? false,
      status: link.status === "up" || link.status === "down" ? link.status : null,
      downSince: link.downSince ?? null,
    })),
    check: raw.check ? { by: raw.check.by, checks: raw.check.checks.map((item) => ({ name: item.name, passed: item.result === "pass" })) } : null,
  };
}
