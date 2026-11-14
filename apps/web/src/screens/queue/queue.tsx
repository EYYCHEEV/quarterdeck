import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNewActivity } from "../../data/chat-hooks";
import { useQd, useWorld } from "../../data/hooks";
import { readSession, useQueueQuery, useReceipt, writeSession } from "../../data/session";
import { changedLabel } from "../../domain/card";
import { answeredLine, EMPTY_QUERY, viewQueue, type FilterKey, type QueueQuery, type QueueView, type SortKey } from "../../domain/query";
import { changedWhileReading, type QueueRow } from "../../domain/queue";
import { href } from "../../domain/routes";
import { clockTime } from "../../domain/time";
import type { World } from "../../domain/types";
import { LinkButton } from "../../ui/button";
import { FilterLine } from "../../ui/chip";
import { cx } from "../../ui/cx";
import { FLOAT_TOP_PAD, FloatListTop } from "../../ui/float";
import { Head, Title } from "../../ui/head";
import { Icon } from "../../ui/icon";
import { plainKey } from "../../ui/keys";
import { go } from "../../ui/link";
import { ARRIVE, rowMotion, useShown, type RowMotion } from "../../ui/motion";
import { anyOverlayOpen } from "../../ui/overlay";
import { usePhone } from "../../ui/phone";
import { AnsweredLines, CardRow, WaitingLines } from "../../ui/row";
import { CardBars, DoneLine, Empty, ErrorLine, RowBars } from "../../ui/states";
import { QueueControls } from "./controls";

function withMine(shown: World, latest: World): World {
  if (shown === latest) return shown;
  const mine = new Map(latest.cards.map((card) => [card.id, card]));
  return {
    ...shown,
    cards: shown.cards.map((card) => {
      const now = mine.get(card.id);
      return now && (now.answer !== card.answer || now.seenAt !== card.seenAt) ? { ...card, answer: now.answer, seenAt: now.seenAt } : card;
    }),
  };
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-tag border border-line-3 bg-control px-s1 font-mono text-label text-ink-2">{children}</kbd>;
}

function useShownWorld(latest: World | null) {
  const [shown, setShown] = useState<World | null>(latest);
  const changed = shown && latest && shown !== latest ? changedWhileReading(shown.cards, latest.cards) : 0;
  useEffect(() => {
    if (latest && latest !== shown && (!shown || changed === 0)) setShown(latest);
  }, [latest, shown, changed]);
  const world = useMemo(() => (shown && latest ? withMine(shown, latest) : (shown ?? latest)), [shown, latest]);
  return { world, changed, apply: () => setShown(latest) };
}

function Row({ row, view, world, selected, wide, motion }: { row: QueueRow; view: QueueView; world: World; selected: boolean; wide: boolean; motion?: RowMotion }) {
  const { card, why } = row;
  const project = world.projects.find((p) => p.id === card.projectId)?.name ?? card.projectId;
  const answered = view.answered ? answeredLine(card) : null;
  return (
    <CardRow
      id={card.id}
      to={href.queue(card.id)}
      title={card.title}
      priority={card.priority}
      changed={view.answered ? null : changedLabel(card)}
      selected={selected}
      answered={view.answered}
      motion={motion}
      onOpen={
        wide
          ? (event) => {
              event.preventDefault();
              go(href.queue(card.id), { replace: true });
            }
          : undefined
      }
    >
      {answered ? <AnsweredLines line={answered.line} waitingOn={answered.waitingOn} /> : <WaitingLines unblocks={why.unblocks} due={why.due} pastDue={why.pastDue} owner={card.owner} project={project} />}
    </CardRow>
  );
}

function StatusLine({ view, query, setQuery, changed, apply }: { view: QueueView | null; query: QueueQuery; setQuery: (q: QueueQuery) => void; changed: number; apply: () => void }) {
  const chips = (view?.chips ?? []).filter((chip) => chip.key !== "text");
  const remove = (key: string) => {
    if (key === "sort") return setQuery({ ...query, sort: "ranked" as SortKey });
    const filters = { ...query.filters };
    delete filters[key as FilterKey];
    setQuery({ ...query, filters });
  };
  return (
    <>
      {chips.length > 0 && <FilterLine chips={chips} onRemove={remove} onClear={() => setQuery(EMPTY_QUERY)} testId="queue-filters-on" />}
      {changed > 0 ? (
        <p className="mx-hair mt-s2 mb-s1 flex min-h-hit items-center gap-s2 rounded-key bg-control px-s3 text-meta text-ink" role="status" data-testid="queue-changed">
          <span aria-hidden="true" className="size-s2 flex-none rounded-round bg-new" />
          <span className="min-w-0 flex-1">{changed === 1 ? "1 card changed." : changed + " cards changed."}</span>
          <LinkButton onClick={apply}>Show</LinkButton>
        </p>
      ) : (
        chips.length === 0 &&
        (!view || view.rows.length > 0) && (
          <p className="mx-hair mt-s2 mb-s1 flex min-h-hit items-center text-meta text-ink-2" data-testid="queue-rule">
            {view && view.sorts[0].value !== "ranked" ? "Ranked by due, then newest change" : "Ranked by priority, then unblocked, then due"}
          </p>
        )
      )}
    </>
  );
}

export function QueueScreen({ cardId, wide, pane }: { cardId: string | null; wide: boolean; pane: (cardId: string, auto: boolean, toList: () => void) => ReactNode }) {
  const qd = useQd();
  const latest = useWorld();
  const shown = useShownWorld(latest.world);
  const [query, setQuery] = useQueueQuery();
  const [receipt, setReceipt] = useReceipt();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const paneBox = useRef<HTMLDivElement>(null);
  const now = qd.now();
  const world = shown.world;
  const view = useMemo(() => (world ? viewQueue(world, query, now) : null), [world, query, now]);
  const rows = view?.rows ?? [];
  const listed = useShown(rows, (row) => row.card.id, view ? JSON.stringify(query) : "");
  const [fromBars] = useState(!view);
  const open = wide ? (cardId ?? (rows[0]?.card.id ?? null)) : null;

  useLayoutEffect(() => {
    paneBox.current?.scrollTo(0, 0);
  }, [open]);

  useEffect(() => {
    if (wide) return;
    const saved = readSession("queue.scroll", 0);
    if (saved && world) window.scrollTo(0, saved);
    return () => writeSession("queue.scroll", window.scrollY);
  }, [wide, world !== null]);

  useEffect(() => {
    if (!wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (!plainKey(event) || anyOverlayOpen()) return;
      if (event.key === "/") {
        event.preventDefault();
        search.current?.focus();
        return;
      }
      if (event.key === "Escape" && document.activeElement?.closest("[data-pane]")) {
        list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      const at = rows.findIndex((row) => row.card.id === open);
      const next = rows[event.key === "j" ? at + 1 : Math.max(at - 1, 0)];
      if (!next || next.card.id === open) return;
      event.preventDefault();
      go(href.queue(next.card.id), { replace: true });
      list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.card.id)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, rows, open]);

  const showReceipt = receipt && receipt.cardId === null;
  const empty = view && !view.answered && view.waiting === 0;
  const loading = !view && !latest.failed;
  const seeAnswered = (
    <LinkButton onClick={() => setQuery({ ...EMPTY_QUERY, filters: { show: "answered" } })} data-testid="see-answered">
      See what you answered
      <Icon name="chevR" size="xs" />
    </LinkButton>
  );

  const emptyBlock = (
    <Empty action={seeAnswered} testId="queue-empty" icon="queue">
      Nothing waiting. The bots are working.
    </Empty>
  );

  const top = (
    <>
      {showReceipt && <DoneLine className="mb-s3">{receipt.text}</DoneLine>}
      <QueueControls view={view} query={query} setQuery={setQuery} wide={wide} search={search} onField={() => showReceipt && setReceipt(null)} />
      {latest.failed && world ? (
        <ErrorLine className="mt-s2 mb-s2" onRetry={latest.retry}>
          Could not refresh the Queue. Showing the list from {latest.at ? clockTime(new Date(latest.at).toISOString()) : "earlier"}.
        </ErrorLine>
      ) : (
        !empty && <StatusLine view={view} query={query} setQuery={setQuery} changed={shown.changed} apply={shown.apply} />
      )}
    </>
  );

  const body = (
    <>
      {!view ? (
        latest.failed ? (
          <ErrorLine onRetry={latest.retry}>Could not load the Queue.</ErrorLine>
        ) : (
          <RowBars rows={wide ? 7 : 6} />
        )
      ) : empty ? (
        emptyBlock
      ) : rows.length === 0 ? (
        <Empty
          icon="search"
          className="mt-s2"
          testId="queue-no-match"
          action={
            query.text ? (
              <LinkButton onClick={() => setQuery({ ...query, text: "", filters: query.filters.show ? { show: query.filters.show } : {} })}>{Object.keys(query.filters).some((key) => key !== "show") ? "Clear" : "Clear search"}</LinkButton>
            ) : (
              <LinkButton onClick={() => setQuery(EMPTY_QUERY)}>Clear</LinkButton>
            )
          }
        >
          {view.answered ? "Nothing answered yet." : "Nothing in the Queue matches."}
        </Empty>
      ) : (
        <ul ref={list} className={cx("flex flex-col gap-s2", fromBars && ARRIVE)} aria-label="Task Cards" data-testid="queue-list">
          {listed.shown.map((entry) => (
            <Row key={entry.id} row={entry.item} view={view} world={world as World} selected={!entry.leaving && open === entry.id} wide={wide} motion={rowMotion(entry, listed.drop)} />
          ))}
        </ul>
      )}
    </>
  );

  const phone = usePhone() && !wide;
  const dot = useNewActivity();
  const title = (
    <Title>
      Queue
      {view && <span className="text-body leading-none font-strong text-ink-2"> · {view.count}</span>}
    </Title>
  );
  const head = <Head className={cx(!wide && "px-s2")}>{title}</Head>;

  if (!wide)
    return (
      <div className="mx-auto w-full max-w-[720px]">
        {phone ? <FloatListTop label="Queue actions" dot={dot} /> : head}
        <div className={cx("px-s4 pb-s7", phone ? FLOAT_TOP_PAD : "pt-s2")}>
          {phone && <div className="pb-s2">{title}</div>}
          {top}
          {body}
        </div>
      </div>
    );

  if (empty)
    return (
      <div className="flex h-dvh min-h-0 flex-col px-s4 mac:px-s6">
        {head}
        <div className="w-[400px] flex-none pt-s2">{top}</div>
        <div className="grid min-h-0 flex-1 place-items-center pb-[96px]">
          <div className="w-full max-w-[420px]">{emptyBlock}</div>
        </div>
      </div>
    );

  return (
    <div className="flex h-dvh min-h-0 gap-s5 px-s4 mac:px-s6">
      <section className="flex w-[400px] flex-none flex-col" aria-label="Queue">
        {head}
        <div className="flex-none pt-s2">{top}</div>
        <div className="-mx-s1 -mt-s1 min-h-0 flex-1 overflow-y-auto px-s1 pt-s1 pb-s5" data-testid="queue-scroll">
          {body}
        </div>
        <p className="hidden flex-none items-center gap-s4 border-t border-line py-s2 text-meta text-ink-3 mac:flex" data-testid="key-hints">
          <span className="inline-flex items-center gap-s1">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            next, previous
          </span>
          <span className="inline-flex items-center gap-s1">
            <Kbd>/</Kbd>
            search
          </span>
          <span className="inline-flex items-center gap-s1">
            <Kbd>Esc</Kbd>
            out
          </span>
        </p>
      </section>
      <div ref={paneBox} tabIndex={-1} className="-mx-s1 min-w-0 flex-1 overflow-y-auto px-s1 outline-none" data-pane="" data-testid="card-pane">
        {open ? (
          pane(open, cardId === null, () => list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus())
        ) : loading ? (
          <CardBars />
        ) : null}
      </div>
    </div>
  );
}
