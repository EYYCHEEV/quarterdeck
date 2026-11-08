import { recapOf } from "../../domain/card";
import { versionLine } from "../../domain/card-words";
import { href } from "../../domain/routes";
import { dueLong, isDueSoon } from "../../domain/time";
import type { Card, World } from "../../domain/types";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { Section } from "../../ui/panel";
import { PriorityTile } from "../../ui/priority";
import { Dot } from "../../ui/row";

export function TitleBlock({ card, world, now, main, tile }: { card: Card; world: World; now: number; main: boolean; tile: boolean }) {
  const Heading = main ? "h1" : "h2";
  const project = world.projects.find((p) => p.id === card.projectId)?.name ?? card.projectId;
  const lane = world.lanes.find((l) => l.id === card.laneId)?.name ?? card.laneId;
  return (
    <header className="pt-1">
      <Heading id="card-title" className="text-card font-bold tracking-[-.015em] [overflow-wrap:anywhere]" data-testid="card-title">
        {card.title}
      </Heading>
      <div className="mt-2.5 flex items-start gap-2">
        {tile && <PriorityTile priority={card.priority} className="mt-px flex-none" />}
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-note text-ink-2" data-testid="owner-line">
          <span className="font-semibold text-ink">{card.owner}</span>
          <Dot />
          {card.answer ? (
            <span>
              {project} &gt; {lane}
            </span>
          ) : (
            <>
              {main && (
                <>
                  <span>{project}</span>
                  <span className="max-upright:hidden">
                    <Dot />
                  </span>
                </>
              )}
              {card.due ? <span className={cx(main && "max-upright:basis-full", isDueSoon(card.due, now) && "font-semibold text-red")}>Due {dueLong(card.due, now)}</span> : <span>No due time</span>}
            </>
          )}
        </p>
      </div>
    </header>
  );
}

export function VersionLine({ card, onEarlier }: { card: Card; onEarlier: () => void }) {
  const line = versionLine(card);
  if (!line) return null;
  const count = card.versions.length || card.changes.length;
  return (
    <button
      type="button"
      onClick={onEarlier}
      className="mt-4 flex min-h-11 w-full cursor-pointer items-start gap-2.5 rounded-panel border bg-violet-soft px-3.5 py-2.5 text-left"
      style={{ borderColor: "color-mix(in oklab, var(--color-violet) 35%, transparent)" }}
      aria-label={"Latest version. Open Earlier versions (" + count + ")"}
      data-testid="change-line"
    >
      <span className="min-w-0 flex-1" data-testid="version-line">
        <span className="block text-note font-semibold">{line.head}</span>
        {line.instruction && <span className="mt-0.5 block text-note [overflow-wrap:anywhere]">{line.instruction}</span>}
        <span className="mt-0.5 block text-small font-medium text-violet">Earlier versions ({count})</span>
      </span>
      <Icon name="chevR" size="sm" className="mt-1 flex-none text-violet" />
    </button>
  );
}

export function Recap({ card, world }: { card: Card; world: World }) {
  const recap = recapOf(card, world);
  const stands = card.answer ? "answered by you" : "waits on you";
  const now = recap.now && !card.answer ? recap.now + "; " + stands : stands;
  const label = "text-ink-3";
  return (
    <Section title="Recap" className="mt-6" data-testid="recap">
      <dl className="m-0 grid gap-x-3 gap-y-1.5 text-body" style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}>
        {recap.about && (
          <>
            <dt className={label}>About:</dt>
            <dd className="m-0">{recap.about}</dd>
          </>
        )}
        <dt className={label}>Part of:</dt>
        <dd className="m-0">
          <Link to={href.projects(card.projectId)} className="text-link hover:underline">
            {recap.project}
          </Link>
          {" > "}
          <Link to={href.lane(card.laneId)} className="text-link hover:underline">
            {recap.lane}
          </Link>
          {recap.tasks.length > 0 && <span className="text-ink-2"> · {recap.unblocks}</span>}
        </dd>
        <dt className={label}>Now:</dt>
        <dd className="m-0">{now}</dd>
      </dl>
      <figure className="m-0 mt-4 rounded-panel border border-line-2 bg-well px-3 py-3" data-testid="picture">
        <figcaption className="eyebrow">Picture</figcaption>
        {card.ascii ? (
          <pre className="m-0 mt-2 overflow-hidden font-mono text-picture whitespace-pre text-picture-ink" aria-label={"Picture: " + card.title}>
            {card.ascii}
          </pre>
        ) : (
          <p className="mt-2 text-meta text-ink-2">No picture yet</p>
        )}
      </figure>
    </Section>
  );
}
