import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEvidence } from "../../data/hooks";
import type { EvidenceTile } from "../../domain/card";
import { evidenceView, viewerCaption, type CheckLine, type LinkRow } from "../../domain/evidence";
import { BLOCKED_LINK } from "../../domain/external-link";
import { href, referenceHref } from "../../domain/routes";
import type { Card, EvidenceMedia, World } from "../../domain/types";
import { BotLink, BotLinkConfirmation } from "../../ui/bot-link";
import { LinkButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { Section } from "../../ui/panel";
import { ErrorLine, LoadingBars } from "../../ui/states";
import { Viewer } from "../../ui/viewer";

const TILE = "flex h-full min-h-[96px] w-full min-w-0 flex-col gap-s1 rounded-key border bg-panel p-s2 text-left";
const PICTURE = "relative block aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-key border border-line-3 bg-well hover:bg-panel";
const BADGE = "absolute rounded-round bg-panel px-s1 text-label text-ink";
const ROLE = { build: "Build", target: "Target", image: "Picture" } as const;
const SLOTS = { phone: 3, wide: 6 } as const;
export const SIX_TILES = { gridTemplateColumns: "repeat(6, minmax(0, 1fr))" };

function Face({ tile }: { tile: EvidenceTile }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-s1 text-label text-ink-3">
        {tile.kind === "More" ? <Icon name="expand" size="xs" /> : <code className="flex-none font-mono">{tile.code}</code>}
        <span className="truncate">{tile.kind === "More" ? "More" : tile.kind}</span>
      </span>
      {tile.lines.length > 0 && (
        <span className="grid font-mono text-label text-ink-2">
          {tile.lines.map((line, n) => (
            <span key={n} className="truncate">
              {line}
            </span>
          ))}
        </span>
      )}
      <span className="truncate text-meta font-strong text-ink">{tile.title}</span>
      <span className="truncate text-label text-ink-2">{tile.meta}</span>
    </>
  );
}

function mediaLabel(media: EvidenceMedia): string {
  if (media.kind === "video") return "Video" + (media.length ? ", " + media.length : "") + ": " + media.caption;
  const role = ROLE[media.role];
  return media.caption.startsWith(role) ? media.caption : role + ": " + media.caption;
}

function Picture({ media, onOpen }: { media: EvidenceMedia; onOpen: (opener: HTMLElement) => void }) {
  const still = media.kind === "video" ? media.poster : media.src;
  return (
    <button type="button" className={PICTURE} aria-label={mediaLabel(media)} onClick={(event) => onOpen(event.currentTarget)} data-testid="evidence-media">
      {(media.kind === "image" || still !== null) && <img src={still || undefined} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
      {media.role !== "image" && <span className={BADGE + " top-s1 left-s1"}>{ROLE[media.role]}</span>}
      {media.kind === "video" && (
        <>
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-[36px] place-items-center rounded-round bg-panel text-ink">
              <Icon name="play" size="sm" />
            </span>
          </span>
          {media.length && <span className={BADGE + " right-s1 bottom-s1 font-mono"}>{media.length}</span>}
        </>
      )}
    </button>
  );
}

const ROW = "flex min-h-[56px] items-center gap-s3 rounded-key border bg-panel p-s2";

function LinkFace({ link }: { link: LinkRow }) {
  return (
    <>
      <img src={link.shot || undefined} alt="" className="h-[40px] w-[64px] flex-none rounded-key bg-well object-cover object-top" />
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-meta font-strong text-ink">{link.title}</span>
        <span className="break-all text-label text-ink-2">{link.hostname ?? BLOCKED_LINK}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-s2 text-label text-ink-2">
          {link.status && (
            <span className={cx("inline-flex items-center gap-s1", link.status.up ? "text-moving" : "text-stop")} data-testid="link-status">
              <span className={cx("size-s2 rounded-round", link.status.up ? "bg-moving" : "bg-stop")} aria-hidden="true" />
              {link.status.text}
            </span>
          )}
          <span>{link.when}</span>
          {link.gated && <span>(gated)</span>}
        </span>
      </span>
    </>
  );
}

function Links({ links, botName }: { links: LinkRow[]; botName: string }) {
  return (
    <BotLinkConfirmation botName={botName}>
      {(confirm) => <ul className="mt-s2 grid gap-s2" data-testid="evidence-links">
        {links.map((link) => (
          <li key={link.id}>
            {link.url ? (
              <BotLink url={link.url} confirm={confirm} className={ROW + " w-full border-line-3 hover:bg-panel"} testId="evidence-link">
                <LinkFace link={link} />
                <span className="sr-only">(asks before opening in a new tab)</span>
                <Icon name="external" size="sm" className="flex-none text-ink-3" />
              </BotLink>
            ) : (
              <div className={ROW + " border-line"} data-testid="evidence-row">
                <LinkFace link={link} />
              </div>
            )}
          </li>
        ))}
      </ul>}
    </BotLinkConfirmation>
  );
}

function Check({ line }: { line: CheckLine }) {
  return (
    <div className={cx("mt-s2 flex items-start gap-s2 text-meta", line.tone === "pass" ? "text-moving" : line.tone === "fail" ? "text-stop" : "text-ink-3")} data-testid="evidence-check" data-tone={line.tone}>
      {line.tone !== "quiet" && <Icon name={line.tone === "pass" ? "check" : "alert"} size="sm" className="mt-hair flex-none" />}
      <p className="min-w-0">
        {line.text}
        {line.failed && <span className="block">{line.failed}</span>}
      </p>
    </div>
  );
}

export function Evidence({ card, world, now, wide }: { card: Card; world: World; now: number; wide: boolean }) {
  const { evidence, loaded, failed, retry } = useEvidence(card.id);
  const slots = wide ? SLOTS.wide : SLOTS.phone;
  const [all, setAll] = useState(false);
  const view = evidenceView(card, world, evidence, all ? Infinity : slots, now);
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const show = (index: number, from: HTMLElement) => {
    opener.current = from;
    setOpen(index);
  };
  useEffect(() => {
    if (all) list.current?.children[slots - 1]?.querySelector<HTMLElement>("a,button")?.focus();
  }, [all, slots]);
  const tileOf = (tile: EvidenceTile): ReactNode => {
    const label = tile.kind === "More" ? tile.title : tile.kind + " " + tile.code + ": " + tile.title;
    if (tile.kind === "More" && view.seeAll)
      return (
        <Link to={href.page(card.projectId, view.seeAll.page)} className={TILE + " border-line-3 hover:bg-panel"} aria-label={label}>
          <Face tile={tile} />
        </Link>
      );
    if (tile.kind === "More")
      return (
        <button type="button" onClick={() => setAll(true)} className={TILE + " cursor-pointer border-line-3 hover:bg-panel"}>
          <Face tile={tile} />
        </button>
      );
    if (tile.opens)
      return (
        <Link to={referenceHref({ kind: tile.kind, code: tile.code, projectId: card.projectId })} className={TILE + " border-line-3 hover:bg-panel"} aria-label={label}>
          <Face tile={tile} />
        </Link>
      );
    return (
      <div className={TILE + " border-line"}>
        <Face tile={tile} />
      </div>
    );
  };
  const empty = !view.thumbs.length && !view.links.length;
  return (
    <Section
      title="Evidence"
      className="mt-s5"
      data-testid="evidence"
      aside={
        loaded &&
        view.seeAll && (
          <Link to={href.page(card.projectId, view.seeAll.page)} className="inline-flex min-h-hit items-center px-s1 text-meta text-inherit underline hover:text-hand" data-testid="see-all-page">
            {view.seeAll.text}
          </Link>
        )
      }
    >
      {failed && (
        <ErrorLine onRetry={retry} className="mb-s2">
          The pictures and links did not load.
        </ErrorLine>
      )}
      {!loaded && <LoadingBars rows={1} height={96} />}
      {loaded && view.thumbs.length > 0 && (
        <ul ref={list} className={cx("grid gap-s2", !wide && "grid-cols-3")} style={wide ? SIX_TILES : undefined} data-truncates="" data-testid="evidence-tiles">
          {view.thumbs.map((thumb) => (
            <li key={thumb.kind === "media" ? thumb.media.id : thumb.tile.code || thumb.tile.title} className="min-w-0">
              {thumb.kind === "media" ? (
                <>
                  <Picture media={thumb.media} onOpen={(from) => show(thumb.index, from)} />
                  <p className="mt-s1 line-clamp-2 text-label text-ink-2" aria-hidden="true" data-testid="evidence-caption">
                    {thumb.media.caption}
                  </p>
                </>
              ) : (
                tileOf(thumb.tile)
              )}
            </li>
          ))}
        </ul>
      )}
      {view.links.length > 0 && <Links links={view.links} botName={evidence?.doneBy || card.owner} />}
      {view.check && <Check line={view.check} />}
      {loaded && empty && !failed && <p className="text-meta text-ink-2">No evidence attached</p>}
      {open !== null && (
        <Viewer
          items={view.viewer}
          start={open}
          label="Evidence"
          returnTo={opener}
          onClose={() => setOpen(null)}
          caption={(media) => viewerCaption(media, now)}
          actions={(media, jump) => (
            <>
              {media.target && <LinkButton onClick={() => jump(media.target ?? "")}>Show target</LinkButton>}
              {view.seeAll && (
                <Link to={href.page(card.projectId, view.seeAll.page)} className="inline-flex min-h-hit items-center px-s1 text-meta text-inherit underline hover:text-hand">
                  Open the Page
                </Link>
              )}
            </>
          )}
        />
      )}
    </Section>
  );
}
