import { useState } from "react";
import { useEvidence } from "../../data/hooks";
import { href } from "../../domain/routes";
import { stagesView, trackerView, type Mark, type StageItem, type StagesView, type StepItem, type Tracker } from "../../domain/tracker";
import type { EvidenceCheck, Lane } from "../../domain/types";
import { cx } from "../../ui/cx";
import { Fold } from "../../ui/fold";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { ErrorLine, LoadingBars } from "../../ui/states";

const STATE_NAME: Record<Mark, string> = { done: "done", current: "current stage", todo: "to do" };

function Marked({ mark, state }: { mark: string; state: Mark }) {
  return (
    <span role="img" aria-label={STATE_NAME[state]} className="flex-none">
      {mark}
    </span>
  );
}

function StepLine({ item }: { item: StepItem }) {
  return (
    <li className={cx("flex items-baseline gap-s2", item.state === "current" ? "font-strong text-ink" : "text-ink-2")}>
      <Marked mark={item.mark} state={item.state} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{item.name}</span>
    </li>
  );
}

function StageBlock({ stage }: { stage: StageItem }) {
  return (
    <div className="grid gap-s1 text-body" data-testid="stage-block">
      <p className="flex items-baseline gap-s2">
        <Marked mark={stage.mark} state={stage.state} />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <b className="font-strong">{stage.name}</b>
          {stage.time && <span className="ml-s2 text-meta text-ink-2">{stage.time}</span>}
        </span>
      </p>
      {stage.steps.length > 0 && (
        <ul className="grid gap-hair pl-s4 text-meta">
          {stage.steps.map((row, n) =>
            row.kind === "step" ? (
              <StepLine key={n} item={row.item} />
            ) : (
              <li key={n}>
                <Fold label={row.text}>
                  <ul className="grid gap-hair pl-s4">
                    {row.items.map((item, at) => (
                      <StepLine key={at} item={item} />
                    ))}
                  </ul>
                </Fold>
              </li>
            ),
          )}
        </ul>
      )}
      {stage.doneWhen && <p className="pl-s4 text-meta text-ink-2">Done when: {stage.doneWhen}</p>}
    </div>
  );
}

function StagesList({ view }: { view: StagesView }) {
  return (
    <section id="lane-stages" aria-label={view.title} className="stages-list" data-testid="stages-list">
      <h3 className="text-meta font-strong [overflow-wrap:anywhere]">{view.title}</h3>
      <ol className="grid gap-s2">
        {view.rows.map((row, n) => (
          <li key={n}>
            {row.kind === "done" ? (
              <Fold label={row.text} testId="done-stages">
                <div className="grid gap-s2 pl-s4">
                  {row.stages.map((stage, at) => (
                    <StageBlock key={at} stage={stage} />
                  ))}
                </div>
              </Fold>
            ) : (
              <StageBlock stage={row.stage} />
            )}
          </li>
        ))}
      </ol>
      <p className="text-meta text-ink-2" data-testid="stages-changed">
        {view.changed}
      </p>
    </section>
  );
}

function TrackerBody({ tracker, lane, now, check }: { tracker: Tracker; lane: Lane; now: number; check: EvidenceCheck | null }) {
  const [open, setOpen] = useState(false);
  const view = trackerView(tracker, lane, now, check);
  const line = view.countLine ?? view.stepLine;
  return (
    <section role="region" aria-label="Lane tracker" className="lane-tracker" data-testid="lane-tracker">
      <div className="tracker-stage-heading">
        <p className={view.folded ? "tracker-stage-row is-folded" : "tracker-stage-row"} data-testid="stage-row">
          {view.folded ? view.stageRow.split(" · ").map((part) => <span key={part} className={part.startsWith("●") ? "stage-summary-name" : undefined} data-truncates={part.startsWith("●") ? "" : undefined}>{part}</span>) : tracker.stages.map((stage) => <span key={stage.name} className={"tracker-stage " + stage.state}><span className="stage-mark" aria-hidden="true">{stage.state === "done" ? "✓" : stage.state === "current" ? "●" : "○"}</span>{stage.name}</span>)}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="lane-stages"
          onClick={() => setOpen(!open)}
          className="tracker-stages-button"
          data-testid="stages-btn"
        >
          <Icon name="chevR" size="xs" className={open ? "rotate-90" : undefined} />
          Stages
        </button>
      </div>
      {line && <p className="tracker-step" data-testid={view.countLine ? "count-line" : "step-line"}>{line}</p>}
      {open && <StagesList view={stagesView(tracker, lane.name, now)} />}
      <div className="tracker-detail">
        {view.checkLine && <p className="tracker-check" data-testid="check-line">{view.checkLine}</p>}
        {view.doneWhen && <p className="tracker-done-when"><b>Done when</b><span>{view.doneWhen}</span></p>}
        {view.now && <p className="tracker-now"><b>Now</b><span>{view.now}</span></p>}
        {view.next && <p className="tracker-next"><b>Next</b><span>{view.next}</span></p>}
      </div>
      {view.blockersHeading && (
        <section aria-label="Blockers" className={view.blockers.length ? "tracker-blockers has-blockers" : "tracker-blockers"} data-testid="tracker-blockers">
          <h3>{view.blockersHeading}</h3>
          <ul className="grid">
            {view.blockers.map((blocker) => (
              <li key={blocker.text} data-testid="blocker">
                {blocker.card ? (
                  <Link to={href.queue(blocker.card)} className="flex min-h-hit items-center gap-s1 text-body font-strong hover:underline hover:underline-offset-3">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{blocker.text}</span>
                    <Icon name="chevR" size="xs" className="text-ink-3" />
                  </Link>
                ) : (
                  <p className="py-s1 text-body font-strong [overflow-wrap:anywhere]">{blocker.text}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.doneLine && (
        <p className="mt-s2 text-body font-strong" data-testid="done-line">
          {view.doneLine}
        </p>
      )}
      <p className="tracker-updated" data-testid="tracker-updated">
        {view.updated}
      </p>
      {view.quiet && (
        <p className="text-meta font-strong" data-testid="tracker-quiet">
          {view.quiet}.
        </p>
      )}
    </section>
  );
}

function WithCheck({ cardId, ...rest }: { cardId: string; tracker: Tracker; lane: Lane; now: number }) {
  const { evidence } = useEvidence(cardId);
  return <TrackerBody {...rest} check={evidence?.check ?? null} />;
}

export function LaneTracker({ tracker, lane, now }: { tracker: Tracker; lane: Lane; now: number }) {
  const pending = tracker.blockers.find((blocker) => blocker.signOff && blocker.taskCard);
  return pending?.taskCard ? <WithCheck cardId={pending.taskCard} tracker={tracker} lane={lane} now={now} /> : <TrackerBody tracker={tracker} lane={lane} now={now} check={null} />;
}

export function TrackerPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  if (!failed) return <LoadingBars rows={1} height={230} />;
  return (
    <section role="region" aria-label="Lane tracker" className="lane-tracker" data-testid="lane-tracker">
      <ErrorLine onRetry={onRetry}>Could not load the Lane tracker.</ErrorLine>
    </section>
  );
}
