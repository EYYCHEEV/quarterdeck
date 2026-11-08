import { useEffect, useRef } from "react";
import { withDetail } from "../../data/card-detail";
import { useEvidence, useQd, useTrackers, useWorld } from "../../data/hooks";
import { changedLabel } from "../../domain/card";
import { answeredLine } from "../../domain/query";
import { rankQueue, type WhyLine } from "../../domain/queue";
import { referenceInfo } from "../../domain/references";
import { href, referenceHref } from "../../domain/routes";
import { groupActivity } from "../../domain/seen";
import { whenText } from "../../domain/time";
import { laneStatus, resolveTracker } from "../../domain/tracker";
import type { Activity, Card, World } from "../../domain/types";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Fold } from "../../ui/fold";
import { FlowHead } from "../../ui/flow-head";
import { Icon } from "../../ui/icon";
import { go, Link } from "../../ui/link";
import { Section } from "../../ui/panel";
import { RefChip } from "../../ui/reference";
import { AnsweredLines, CardRow, WaitingLines } from "../../ui/row";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";
import { LaneTracker, TrackerPending } from "./tracker";

const ACTIVITY_LIMIT = 20;

function ActivityProof({ cardId, pageRef, projectId }: { cardId: string; pageRef: string; projectId: string }) {
  const { evidence } = useEvidence(cardId);
  if (!evidence || (evidence.pageRef !== null && evidence.pageRef !== pageRef)) return null;
  return (
    <div className="activity-proof">
      {evidence.media.slice(0, 2).map((media) => <Link key={media.id} to={href.page(projectId, pageRef)} aria-label={"Open evidence: " + media.caption}><img src={(media.kind === "video" ? media.poster : media.src) ?? undefined} alt={media.caption} /><span>{media.role === "target" ? "Target" : media.role === "build" ? "Build" : "Evidence"}</span></Link>)}
    </div>
  );
}

function ActivityLine({ item, world, now, cardId, projectId }: { item: Activity; world: World; now: number; cardId?: string; projectId: string }) {
  const bot = world.bots.find((b) => b.name === item.bot);
  return (
    <li className="flex items-start gap-2.5" data-testid="activity">
      <Avatar name={item.bot} color={bot?.color} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1 text-prose">
        <p className="flex flex-wrap items-baseline gap-x-2 text-meta">
          <b className="font-semibold">{item.bot}</b>
          <time className="text-ink-3">{whenText(item.at, now)}</time>
        </p>
        <p className="text-ink-2">{item.text}</p>
        {cardId && item.refs.filter((ref) => world.pages.some((page) => page.ref === ref)).map((ref) => <ActivityProof key={ref} cardId={cardId} pageRef={ref} projectId={projectId} />)}
        {item.refs.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {item.refs.flatMap((code) => {
              const info = referenceInfo(code, world);
              return info ? [<RefChip key={code} to={referenceHref(info)} kind={info.kind} code={code} title={info.title} className="text-small" />] : [];
            })}
          </div>
        )}
      </div>
    </li>
  );
}

function Rows({ items, world }: { items: { card: Card; why: WhyLine | null }[]; world: World }) {
  return (
    <>
      {items.map(({ card, why }) => {
        const project = world.projects.find((p) => p.id === card.projectId)?.name ?? card.projectId;

        return (
          <CardRow
            key={card.id}
            id={card.id}
            to={href.queue(card.id)}
            title={card.title}
            priority={card.priority}
            changed={why ? changedLabel(card) : null}
            answered={!why}
          >
            {why ? <WaitingLines unblocks={why.unblocks} due={why.due} pastDue={why.pastDue} owner={card.owner} project={project} /> : <AnsweredLines {...answeredLine(card)} />}
          </CardRow>
        );
      })}
    </>
  );
}

type Item = { kind: "entry"; entry: Activity } | { kind: "line"; text: string };

export function LaneScreen({ laneId }: { laneId: string }) {
  const qd = useQd();
  const { world, failed, retry } = useWorld();
  const { trackers, failed: trackersFailed, retry: retryTrackers } = useTrackers();
  const now = qd.now();
  const lane = world?.lanes.find((item) => item.id === laneId) ?? null;
  const project = lane ? world?.projects.find((p) => p.id === lane.projectId) : null;
  const opened = useRef<{ lastLooked: string | null } | null>(null);
  if (lane && !opened.current) opened.current = { lastLooked: lane.lastLooked };
  const known = lane !== null;

  useEffect(() => {
    if (known) qd.markLooked(laneId);
  }, [qd, laneId, known]);

  const head = <FlowHead title={lane?.name ?? "Lane"} crumb={[{ label: "Projects", to: href.projects() }, ...(project ? [{ label: project.name, to: href.projects(project.id) }] : [])]} />;

  if (!world || !lane) {
    return (
      <div className="lane-screen">
        {head}
        <div className="lane-body">
          {failed ? <ErrorLine onRetry={retry}>Could not load this Lane.</ErrorLine> : world ? <Empty>This Lane is not in the example data.</Empty> : <LoadingBars rows={3} height={110} />}
        </div>
      </div>
    );
  }

  const own = trackers?.[laneId];
  const tracker = own ? resolveTracker(own, world.cards) : null;
  const status = laneStatus(tracker, lane.status);
  const done = status === "Done";
  const waiting = rankQueue(world.cards, world.tasks, now).filter((row) => row.card.laneId === laneId);
  const answered = world.cards.filter((card) => card.laneId === laneId && card.answer).sort((a, b) => Date.parse(b.answer?.at ?? "") - Date.parse(a.answer?.at ?? ""));
  const lead = world.bots.find((b) => b.name === lane.lead);
  const groups = groupActivity(lane, opened.current?.lastLooked ?? null, world.bots, now);
  const items: Item[] = [
    ...groups.fresh.map((entry): Item => ({ kind: "entry", entry })),
    ...(groups.line ? [{ kind: "line" as const, text: groups.line }] : []),
    ...groups.seen.map((entry): Item => ({ kind: "entry", entry })),
  ];
  const shown = done ? items.length : ACTIVITY_LIMIT + (groups.line && groups.fresh.length <= ACTIVITY_LIMIT ? 1 : 0);
  const evidenceCard = world.cards.find((card) => card.laneId === laneId && (withDetail(card)?.evidence.length ?? 0) > 0);
  const first = items.slice(0, shown);
  const rest = items.slice(shown);
  const line = (item: Item) =>
    item.kind === "line" ? (
      <li key="last-looked" className="flex items-center gap-2.5 text-small font-semibold text-violet" data-testid="last-looked">
        <span aria-hidden="true" className="h-px flex-1 bg-violet" />
        {item.text}
        <span aria-hidden="true" className="h-px flex-1 bg-violet" />
      </li>
    ) : (
      <ActivityLine key={item.entry.at + item.entry.bot} item={item.entry} world={world} now={now} cardId={evidenceCard?.id} projectId={lane.projectId} />
    );

  return (
    <div className="lane-screen" data-testid="lane" data-status={status}>
      {head}
      <div className="lane-body">
        <div className="lane-title"><p className="flow-kicker">{done ? "Lane · Read-only record" : "Lane"}</p><h1>{lane.name}</h1></div>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-note text-ink-2">
          <span>{project?.name}</span>
          <span className={cx("inline-flex items-center gap-1.5 text-small font-semibold", done ? "text-green" : "text-blue")}>
            <i className="size-2 rounded-full bg-current" />
            {status}
          </span>
          <span className="inline-flex items-center gap-[7px]">
            <Avatar name={lane.lead} color={lead?.color} size="xs" />
            {lane.lead}
          </span>
        </p>
        {trackers ? tracker && <LaneTracker tracker={tracker} lane={lane} now={now} /> : <TrackerPending failed={trackersFailed} onRetry={retryTrackers} />}
        {!tracker && <p className="lane-fallback-now">{lane.now}</p>}
        {done && lead && <Button kind="outline" block className="lane-talk" onClick={() => go(href.chat(lead.id))} data-testid="talk-to">Talk to {lead.name}<Icon name="chevR" size="sm" /></Button>}
        <section aria-label="Activity" className={cx("lane-activity", rest.length > 0 && "has-older-activity")} data-testid="lane-progress">
          <h2 className="flow-section-title">Activity<span>Newest first</span></h2>
          {items.length > 0 ? (
            <>
              <ul className="activity-list" data-testid="activity-list">{first.map(line)}</ul>
              {rest.length > 0 && <Fold label="Show older" className="older-activity"><ul className="activity-list">{rest.map(line)}</ul></Fold>}
            </>
          ) : <p className="text-ink-2">No activity yet.</p>}
        </section>
        <Section
          title="Task Cards"
          className="lane-task-cards"
          aside={
            <span className="text-meta text-ink-2" data-testid="lane-counts">
              {waiting.length} waiting · {answered.length} answered
            </span>
          }
        >
          {waiting.length ? <ul className="grid gap-2" data-testid="lane-cards"><Rows items={waiting} world={world} /></ul> : <p className="lane-nothing-waiting">No Task Cards waiting.</p>}
          {answered.length > 0 && <Fold label={"Answered (" + answered.length + ")"} className="answered-cards"><ul className="grid gap-2"><Rows items={answered.map((card) => ({ card, why: null }))} world={world} /></ul></Fold>}
        </Section>
      </div>
    </div>
  );
}
