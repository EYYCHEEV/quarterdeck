import { useEffect, useMemo, useRef, useState } from "react";
import { withDetail } from "../../data/card-detail";
import { useQd, useWorld } from "../../data/hooks";
import { quoteInChat, useQueueQuery, useReceipt } from "../../data/session";
import { cardKey } from "../../domain/answer";
import { botCalled } from "../../domain/bots";
import { cardQuote, cardQuoteLabel } from "../../domain/chat";
import { recapOf } from "../../domain/card";
import { openFailedText } from "../../domain/card-words";
import { EMPTY_QUERY } from "../../domain/query";
import { nextAfter, rankQueue } from "../../domain/queue";
import { href } from "../../domain/routes";
import type { Card, World } from "../../domain/types";
import { Button, PillButton } from "../../ui/button";
import { ChatGlyph } from "../../ui/chat-glyph";
import { cx } from "../../ui/cx";
import { FLOAT_TOP_PAD } from "../../ui/float";
import { BackLink, Head } from "../../ui/head";
import { useKeys, useNextAction } from "../../ui/keys";
import { go, Link } from "../../ui/link";
import { ARRIVE } from "../../ui/motion";
import { usePhone } from "../../ui/phone";
import { PriorityTile } from "../../ui/priority";
import { DoneLine, Empty, ErrorLine } from "../../ui/states";
import { AnsweredRecord } from "./answered";
import { AnswerFlow, ReadOnlyOptions } from "./decide";
import { Evidence } from "./evidence";
import { Folds } from "./folds";
import { KeyList } from "./key-list";
import { ChangedNotice, ClosedNotice } from "./notices";
import { Recap, TitleBlock, VersionLine } from "./parts";
import { PhoneTop } from "./phone-top";
import { CardSkeleton } from "./skeleton";

function talkTo(card: Card, world: World) {
  const bot = botCalled(world.bots, card.owner);
  if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && !bot && card.owner) {
    quoteInChat(card.owner, cardQuote(card, world, cardQuoteLabel(card)));
    return go(href.chat(card.owner));
  }
  if (!bot) return;
  quoteInChat(bot.id, cardQuote(card, world, cardQuoteLabel(card)));
  go(href.chat(bot.id));
}

function PathLine({ card, world }: { card: Card; world: World }) {
  const project = world.projects.find((p) => p.id === card.projectId);
  const lane = world.lanes.find((l) => l.id === card.laneId);
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 text-note">
      <Link to={href.projects(card.projectId)} className="inline-flex min-h-11 items-center rounded-small px-1 font-semibold text-ink hover:bg-control">
        {project?.name ?? card.projectId}
      </Link>
      <span aria-hidden="true" className="text-ink-3">
        &gt;
      </span>
      <Link to={href.lane(card.laneId)} className="inline-flex min-h-11 items-center rounded-small px-1 font-medium text-ink-2 hover:bg-control hover:text-ink">
        {lane?.name ?? card.laneId}
      </Link>
    </span>
  );
}

function useReading(latest: Card | null, cardId: string) {
  const [held, setHeld] = useState<Card | null>(null);
  const current = held !== null && held.id === cardId ? held : null;
  useEffect(() => {
    if (latest && (!current || latest.version <= current.version)) setHeld(latest);
  }, [latest, current]);
  const newer = current && latest && latest.version > current.version ? latest : null;
  return { shown: current ?? latest, newer, showNew: () => setHeld(latest) };
}

export function TaskCardScreen({ cardId, pane, auto = false, toList }: { cardId: string; pane: boolean; auto?: boolean; toList?: () => void }) {
  const qd = useQd();
  const { world, failed, retry } = useWorld();
  const [, setQuery] = useQueueQuery();
  const [receipt, setReceipt] = useReceipt();
  const [whole, setWhole] = useState(false);
  const [versionsAsked, setVersionsAsked] = useState(0);
  const [moreAsked, setMoreAsked] = useState(0);
  const [keyList, setKeyList] = useState(false);
  const [reads, setReads] = useState(0);
  const [settled, setSettled] = useState<{ read: string; failed: boolean; world: World | null } | null>(null);
  const worldNow = useRef(world);
  worldNow.current = world;
  const phone = usePhone() && !pane;
  const now = qd.now();
  const latest = withDetail(world?.cards.find((item) => item.id === cardId) ?? null);
  const listed = latest !== null;
  const read = cardId + " " + reads;
  useEffect(() => {
    if (!listed || !qd.openCard) return;
    let live = true;
    const settle = (fault: boolean) => live && setSettled({ read, failed: fault, world: worldNow.current });
    qd.openCard(cardId).then(
      () => settle(false),
      () => settle(true),
    );
    return () => {
      live = false;
    };
  }, [qd, cardId, listed, read]);
  const done = settled?.read === read ? settled : null;
  const readFailed = done !== null && (done.failed || (done.world === world && failed));
  const reading = listed && qd.openCard !== undefined && (!done || (!done.failed && done.world === world && !failed));
  const { shown: card, newer, showNew } = useReading(reading || readFailed ? null : latest, cardId);
  const closure = world?.closed?.find((item) => item.id === cardId) ?? null;
  const ranked = useMemo(() => (world ? rankQueue(world.cards, world.tasks, now) : []), [world, now]);
  const showReceipt = receipt !== null && receipt.cardId === cardId;
  useNextAction(showReceipt, () => setReceipt(null));
  const [afterSend, setAfterSend] = useState(false);
  useEffect(() => {
    if (showReceipt) setAfterSend(true);
  }, [showReceipt]);

  const known = card !== null && latest !== null;
  useKeys(pane && known, (event) => {
    if (!card || !world || event.repeat) return;
    const action = cardKey(card, event.key);
    if (action?.type === "talk") {
      event.preventDefault();
      talkTo(card, world);
    } else if (action?.type === "keys") {
      event.preventDefault();
      setKeyList(true);
    }
  });
  useEffect(() => {
    if (!auto && known) qd.markSeen(cardId);
  }, [auto, known, cardId, qd]);

  useEffect(() => {
    if (pane) return;
    window.scrollTo(0, 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("[data-pop]")) return;
      const typing = event.target instanceof HTMLElement && event.target.matches("input,textarea,select,[contenteditable=true]");
      if (!typing) go(href.queue());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pane, cardId]);

  const toAnswered = () => setQuery({ ...EMPTY_QUERY, filters: { show: "answered" } });
  const waiting = ranked.length;
  const answered = card?.answer != null;
  const waitingText = world ? " · " + waiting + " waiting" : "";
  const toggle = (
    <PillButton icon={whole ? "fold" : "expand"} aria-pressed={whole} onClick={() => setWhole(!whole)} data-testid="whole-card">
      {whole ? "Fold card" : "Whole card"}
    </PillButton>
  );

  let head;
  if (phone) {
    head = (
      <PhoneTop
        answered={answered}
        waiting={waitingText}
        owner={card?.owner ?? ""}
        ready={card !== null && latest !== null && world !== null}
        onAnswered={toAnswered}
        onTalk={() => card && world && talkTo(card, world)}
        onMore={() => setMoreAsked((n) => n + 1)}
      />
    );
  } else if (pane) {
    head = (
      <>
        {(showReceipt || afterSend) && toList && (
          <div className="flex items-center pt-1">
            <BackLink to={href.queue(cardId)} onClick={toList}>
              Queue{waitingText}
            </BackLink>
          </div>
        )}
        {answered && !showReceipt && !afterSend && (
          <div className="flex items-center pt-1">
            <BackLink to={href.queue(cardId)} onClick={toAnswered}>
              Answered
            </BackLink>
          </div>
        )}
        <div className="flex items-center gap-2 pt-[max(8px,env(safe-area-inset-top))]">
          {card && world ? <PathLine card={card} world={world} /> : <span className="flex-1" />}
          {card && <PriorityTile priority={card.priority} />}
          {card && toggle}
        </div>
      </>
    );
  } else {
    head = (
      <Head menu={false} className="pr-2.5 pl-2">
        {answered ? (
          <BackLink to={href.queue()} onClick={toAnswered}>
            Answered
          </BackLink>
        ) : (
          <BackLink to={href.queue()}>Queue{waitingText}</BackLink>
        )}
        <span className="flex-1" />
        {card && <PriorityTile priority={card.priority} />}
        {card && toggle}
      </Head>
    );
  }

  const next = () => {
    const nextId = nextAfter(ranked, cardId);
    go(nextId ? href.queue(nextId) : href.queue());
  };

  let body;
  if ((!world && !failed) || reading) {
    body = <CardSkeleton wide={pane} />;
  } else if (!world || readFailed) {
    const limited = qd.limited?.() ?? false;
    body = (
      <ErrorLine className="mt-4" onRetry={world && done?.failed ? () => setReads((n) => n + 1) : retry} retryLabel={limited ? "Try again" : undefined}>
        {openFailedText(limited)}
      </ErrorLine>
    );
  } else if (!card) {
    body = (
      <Empty className="mt-4" action={<Link to={href.queue()} className="inline-flex min-h-11 items-center px-1.5 text-meta text-link">Back to the Queue</Link>}>
        This Task Card is not in the example data.
      </Empty>
    );
  } else if (!latest && closure) {
    body = (
      <article aria-labelledby="card-title" data-card={card.id}>
        <TitleBlock card={card} world={world} now={now} main={!pane} tile={phone} />
        <ClosedNotice closure={closure} onNext={next} />
      </article>
    );
  } else {
    body = (
      <article aria-labelledby="card-title" data-card={card.id} className={qd.openCard ? ARRIVE : undefined}>
        {failed && (
          <ErrorLine className="mt-2" onRetry={retry}>
            Could not refresh. This is the card as last loaded.
          </ErrorLine>
        )}
        <TitleBlock card={card} world={world} now={now} main={!pane} tile={phone} />
        {answered ? <AnsweredRecord card={card} /> : <VersionLine card={card} onEarlier={() => setVersionsAsked((n) => n + 1)} />}
        <Recap card={card} world={world} />
        <Evidence key={"evidence " + card.id} card={card} world={world} now={now} wide={pane} />
        {answered ? <ReadOnlyOptions card={card} whole={whole} /> : <AnswerFlow key={card.id} card={card} world={world} whole={whole} keys={pane} />}
        <div className="mt-6 border-t border-line pt-5">
          <Button kind="outline" block className="min-h-12" onClick={() => talkTo(card, world)} data-testid="talk-to">
            <ChatGlyph size={16} />
            Talk to {card.owner}
          </Button>
        </div>
        <Folds card={card} unblocks={recapOf(card, world).tasks} whole={whole} versionsAsked={versionsAsked} moreAsked={moreAsked} now={now} />
        {phone && <div className="mt-4 flex justify-end">{toggle}</div>}
        {pane && (
          <div className="mt-4 hidden justify-end any-pointer-fine:flex">
            <PillButton onClick={() => setKeyList(true)} data-testid="keys-btn">
              ? Keys
            </PillButton>
          </div>
        )}
        {keyList && <KeyList owner={card.owner} approval={card.options.length === 0} onClose={() => setKeyList(false)} />}
        {newer && <ChangedNotice by={newer.changes.at(-1)?.by ?? newer.owner} at={newer.changes.at(-1)?.at ?? new Date(now).toISOString()} onShow={showNew} />}
      </article>
    );
  }

  return (
    <div className={cx("relative mx-auto w-full max-w-[720px]", pane ? "pb-16" : "px-0 pb-16")} data-testid="task-card">
      {showReceipt && !phone && (
        <div className={cx(pane ? "pt-[max(8px,env(safe-area-inset-top))]" : "px-4 pt-[max(12px,env(safe-area-inset-top))]")}>
          <DoneLine>{receipt.text}</DoneLine>
        </div>
      )}
      {head}
      <div className={cx(pane ? "pt-1" : "px-4 pt-1", phone && FLOAT_TOP_PAD)}>
        {showReceipt && phone && <DoneLine className="mb-3">{receipt.text}</DoneLine>}
        {body}
      </div>
    </div>
  );
}
