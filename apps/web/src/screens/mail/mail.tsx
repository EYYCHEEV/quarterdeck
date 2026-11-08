import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useNewActivity } from "../../data/chat-hooks";
import { useQd, useWorld } from "../../data/hooks";
import { quoteInChat, readSession, useMailQuery, writeSession } from "../../data/session";
import { botCalled } from "../../domain/bots";
import { mailQuote, threadQuote } from "../../domain/chat";
import { ANOTHER_BOT, askChoices, botsLine, botsOrdered, ccLine, dayGroups, EMPTY_MAIL_QUERY, forwardedByLine, forwardedFrom, lastMailAt, listBots, nameOf, otherBots, removedIn, removedNames, removedNote, toNames, viewMail, type MailFilterKey } from "../../domain/mail";
import { withFilter } from "../../domain/query";
import { referenceInfo } from "../../domain/references";
import { href, linkedParts, referenceHref } from "../../domain/routes";
import { clockTime, whenText } from "../../domain/time";
import type { Bot, Mail, MailThread, World } from "../../domain/types";
import { Avatar } from "../../ui/avatar";
import { LinkButton } from "../../ui/button";
import { ChatGlyph } from "../../ui/chat-glyph";
import { FilterLine } from "../../ui/chip";
import { useCopy } from "../../ui/copy";
import { cx } from "../../ui/cx";
import { SearchField } from "../../ui/field";
import { FilterPick } from "../../ui/filter-pick";
import { FLOAT_TOP_PAD, FloatAction, FloatCapsule, FloatListTop, FloatTop } from "../../ui/float";
import { FloatBack } from "../../ui/float-back";
import { BackLink, Head, Title, useFrame } from "../../ui/head";
import { Icon } from "../../ui/icon";
import { useKeys } from "../../ui/keys";
import { go, Link } from "../../ui/link";
import { LinkedText } from "../../ui/linked-text";
import { rowMotion, useShown, type RowMotion } from "../../ui/motion";
import { Sheet } from "../../ui/overlay";
import { usePhone } from "../../ui/phone";
import { PriorityTile } from "../../ui/priority";
import { CopyButton, RefChip } from "../../ui/reference";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";

const threadOf = (ref: string) => ref.replace(/\.\d+$/, "");

const MoreSheet = lazy(() => import("../../ui/more-sheet").then((m) => ({ default: m.MoreSheet })));

const PILL = "pointer-events-none fixed inset-x-4 z-20 mx-auto w-fit max-w-[calc(100%-32px)] rounded-control border border-line-2 bg-raised px-4 py-2.5 text-meta";
const PILL_AT = { bottom: "max(16px, env(safe-area-inset-bottom))" };
const ROW = { gridTemplateColumns: "auto minmax(0,1fr)", outlineOffset: -2 };
const BAR = { top: 10, bottom: 10, width: 3, borderRadius: "0 9999px 9999px 0" };
const SUBJECT = { lineHeight: 1.35 };
const BRASS = { color: "var(--color-brass)" };
const COLUMNS = { gridTemplateColumns: "372px minmax(0,1fr)" };
const MARK_SCROLL = { scrollMarginTop: 96 };
const FADED = { opacity: 0.6 };
const ROW_GAP = { rowGap: 2 };
const QUOTE_END = { paddingBottom: 12 };
const ACTIONS_TOP = { paddingTop: 6 };
const EMPTY_WIDE = { maxWidth: 480, paddingTop: "18vh" };
const EMPTY = { paddingTop: 32 };
const RULED = { background: "var(--color-line)" };

const ACTION =
  "inline-flex min-h-11 flex-none cursor-pointer items-center gap-1.5 rounded-[10px] border border-line-3 bg-panel px-2.5 text-tag font-medium text-ink-2 hover:text-ink";
const PICK = "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-body hover:bg-raised";

function RefChips({ codes, world }: { codes: string[]; world: World }) {
  const chips = codes.flatMap((code) => {
    const info = referenceInfo(code, world);
    return info ? [<RefChip key={code} to={referenceHref(info)} kind={info.kind} code={code} title={info.title} />] : [];
  });
  return chips.length ? <div className="mt-2.5 flex flex-wrap gap-2">{chips}</div> : null;
}

function BotStack({ names, world, ring }: { names: string[]; world: World; ring: string }) {
  const removed = removedNames(world.bots);
  return (
    <span className="flex flex-none items-center" aria-hidden="true">
      {names.slice(0, 4).map((name, at) => (
        <span key={name} className="flex rounded-full" style={{ outline: "2px solid " + ring, marginLeft: at > 0 ? -4 : undefined, opacity: removed.has(name) ? 0.6 : undefined }}>
          <Avatar name={name} color={botCalled(world.bots, name)?.color} />
        </span>
      ))}
    </span>
  );
}

function AskMenu({ thread, mail, world, wide, onClose }: { thread: MailThread; mail: Mail | null; world: World; wide: boolean; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const code = mail ? mail.ref : thread.ref;
  const choices = askChoices(thread, mail, world.bots);
  const others = otherBots(choices, world.bots);
  const ask = (bot: Bot) => {
    quoteInChat(bot.id, mail ? mailQuote(mail) : threadQuote(thread, botsOrdered(thread)));
    go(href.chat(bot.id));
  };
  const row = (bot: Bot, wrote: boolean) => (
    <li key={bot.id}>
      <button type="button" onClick={() => ask(bot)} className={PICK} data-testid="ask-bot" data-id={bot.id}>
        <Avatar name={bot.name} color={bot.color} size="sm" />
        <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="ask-name">
          {bot.name}
          {wrote && <span className="text-ink-3"> (wrote it)</span>}
        </span>
      </button>
    </li>
  );
  return (
    <Sheet title={more ? "Ask another bot about " + code : "Ask about " + code} wide={wide} onClose={onClose} pop="ask">
      <ul className="grid gap-0.5 px-1 pb-1" data-testid="ask-list">
        {more ? (
          <>
            <li>
              <LinkButton onClick={() => setMore(false)} data-testid="ask-back">
                Back
              </LinkButton>
            </li>
            {others.map((bot) => row(bot, false))}
            {others.length === 0 && <li className="px-2.5 py-2 text-small text-ink-2">No other bots.</li>}
          </>
        ) : (
          <>
            {choices.flatMap((choice) => {
              const bot = world.bots.find((item) => item.id === choice.id);
              return bot ? [row(bot, choice.wrote)] : [];
            })}
            <li>
              <button type="button" onClick={() => setMore(true)} className={PICK} data-testid="ask-another">
                <span className="min-w-0 flex-1" data-testid="ask-name">
                  {ANOTHER_BOT}
                </span>
                <Icon name="chevR" size="xs" className="text-ink-3" />
              </button>
            </li>
          </>
        )}
      </ul>
    </Sheet>
  );
}

function Actions({ thread, mail, world, wide, className, style }: { thread: MailThread; mail: Mail | null; world: World; wide: boolean; className?: string; style?: CSSProperties }) {
  const [open, setOpen] = useState(false);
  const code = mail ? mail.ref : thread.ref;
  return (
    <div className={cx("flex flex-wrap items-center gap-x-2 gap-y-1", className)} style={style}>
      <code className="rounded-md bg-raised px-1.5 py-px font-mono text-xs whitespace-nowrap text-ink-2 select-all">{code}</code>
      <CopyButton value={code} label="Copy reference" done={"Copied " + code} testId={"copy-" + code} />
      <div className="relative">
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label={"Ask a bot about " + code} className={ACTION} data-testid={"ask-" + code}>
          Ask
        </button>
        {open && <AskMenu thread={thread} mail={mail} world={world} wide={wide} onClose={() => setOpen(false)} />}
      </div>
    </div>
  );
}

function ThreadTop({ thread, world }: { thread: MailThread; world: World }) {
  const frame = useFrame();
  const more = useRef<HTMLButtonElement>(null);
  const [ask, setAsk] = useState(false);
  const [open, setOpen] = useState(false);
  const { copy, state } = useCopy(1600);
  return (
    <>
      <FloatTop>
        <FloatBack to={href.mail()} label="Back to Mail" />
        <FloatCapsule label="Thread actions">
          <FloatAction glyph={<ChatGlyph />} label="Ask a bot" aria-haspopup="dialog" aria-expanded={ask} onClick={() => setAsk(true)} data-testid="float-ask">
            Ask a bot
          </FloatAction>
          <FloatAction ref={more} glyph="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="float-more" />
        </FloatCapsule>
      </FloatTop>
      {ask && <AskMenu thread={thread} mail={null} world={world} wide={false} onClose={() => setAsk(false)} />}
      {open && frame && (
        <Suspense fallback={null}>
          <MoreSheet
            items={[
              { icon: "copy", label: "Copy reference", onPick: () => copy(thread.ref) },
              { icon: "settings", label: "Settings", onPick: frame.openSettings },
            ]}
            from={more}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
      {state !== "idle" && (
        <p role={state === "copied" ? "status" : "alert"} className={cx(PILL, state === "copied" ? "text-ink" : "text-red")} style={PILL_AT}>
          {state === "copied" ? "Copied " + thread.ref : "Could not copy. Select the reference."}
        </p>
      )}
    </>
  );
}

function ThreadRow({ thread, world, on, wide, motion }: { thread: MailThread; world: World; on: boolean; wide: boolean; motion?: RowMotion }) {
  const project = world.projects.find((p) => p.id === thread.projectId)?.name ?? thread.projectId;
  const lane = world.lanes.find((l) => l.id === thread.laneId)?.name;
  const bots = listBots(thread);
  const subject = (
    <b className="min-w-0 flex-1 text-prose font-medium [overflow-wrap:anywhere]" style={SUBJECT}>
      {thread.subject}
    </b>
  );
  const time = <time className="flex-none text-xs text-ink-3">{clockTime(new Date(lastMailAt(thread)).toISOString())}</time>;
  const code = <code className={cx("rounded-md bg-raised px-1.5 py-px font-mono text-xs text-ink-2", wide ? "flex-none" : "ml-auto")}>{thread.ref}</code>;
  const who = (
    <span className="min-w-0 flex-1 text-small text-ink-2 [overflow-wrap:anywhere]" data-testid="mail-row-bots">
      {bots.text}
    </span>
  );
  const place = thread.projectId ? (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {project}
      {lane ? " > " + lane : ""}
    </span>
  ) : null;
  return (
    <li className="bg-panel" {...motion}>
      <Link
        to={href.mail(thread.ref)}
        onClick={(event) => {
          if (!wide) {
            writeSession("mail.scroll", window.scrollY);
            return;
          }
          event.preventDefault();
          go(href.mail(thread.ref), { replace: true });
        }}
        aria-current={on ? "true" : undefined}
        className={cx("relative grid items-start gap-3 py-3 pr-3.5 pl-4", on ? "bg-control" : "hover:bg-hover")}
        style={ROW}
        data-testid="mail-row"
        data-id={thread.ref}
      >
        {on && <span aria-hidden="true" className="absolute left-0 bg-brass" style={BAR} />}
        <span className="mt-0.5">
          <BotStack names={bots.shown} world={world} ring={on ? "var(--color-control)" : "var(--color-panel)"} />
        </span>
        <span className="grid min-w-0 gap-0.5">
          {wide ? (
            <>
              <span className="flex items-baseline gap-2.5">
                {code}
                {subject}
              </span>
              <span className="flex items-baseline gap-2.5">
                {who}
                {time}
              </span>
              {place && <span className="text-small text-ink-3">{place}</span>}
            </>
          ) : (
            <>
              <span className="flex items-baseline gap-2.5">
                {subject}
                {time}
              </span>
              {who}
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-3">
                {place}
                {code}
              </span>
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

function MailCard({ mail, thread, world, removed, now, mark, wide, note }: { mail: Mail; thread: MailThread; world: World; removed: Set<string>; now: number; mark: string | null; wide: boolean; note: string | null }) {
  const forward = forwardedFrom(world, mail, removed, now);
  const cc = ccLine(mail, removed);
  const marked = mark === mail.ref;
  return (
    <li
      id={"mail-" + mail.ref}
      className={cx("rounded-panel border px-3.5 pt-3 pb-1.5", marked ? "border-brass-edge bg-control" : "border-line bg-panel")}
      style={MARK_SCROLL}
      data-testid="mail-item"
      data-ref={mail.ref}
    >
      {marked && (
        <p className="eyebrow mb-2 inline-flex items-center gap-1.5" style={BRASS} data-testid="mail-marked">
          <Icon name="link" size="xs" />
          Linked mail
        </p>
      )}
      <div className="flex items-start gap-2.5">
        <span className="flex" style={removed.has(mail.from) ? FADED : undefined}>
          <Avatar name={mail.from} color={botCalled(world.bots, mail.from)?.color} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-meta text-ink-2" style={ROW_GAP}>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" data-testid="mail-to">
              <b className="font-semibold text-ink">{nameOf(mail.from, removed)}</b> to {toNames(mail, removed)}
            </span>
            <time className="flex-none text-small text-ink-2">{whenText(mail.at, now)}</time>
          </div>
          {cc && (
            <p className="mt-0.5 text-small text-ink-2 [overflow-wrap:anywhere]" data-testid="mail-cc">
              {cc}
            </p>
          )}
        </div>
      </div>
      {note && (
        <p className="mt-2.5 flex gap-2 rounded-small bg-well px-3 py-2 text-small text-ink-2" data-testid="mail-removed-note">
          <Icon name="lock" size="xs" className="mt-[3px]" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{note}</span>
        </p>
      )}
      {forward && (
        <div className="mt-2.5 rounded-small border border-line bg-well px-3" style={QUOTE_END} data-testid="mail-forward">
          <Link to={href.mail(forward.ref)} className="inline-flex min-h-11 items-center gap-1.5 text-meta font-medium text-link" data-testid="forwarded-from">
            <Icon name="oneway" size="xs" />
            {forward.line}
            <Icon name="chevR" size="xs" />
          </Link>
          {forward.quote && (
            <blockquote className="border-l-2 border-line-3 pl-3" data-testid="forward-quote">
              <p className="text-meta text-ink-2 [overflow-wrap:anywhere]">
                {forward.quote.writerToRecipient}, {forward.quote.time}
              </p>
              <p className="mt-1 text-body leading-[1.55] whitespace-pre-line [overflow-wrap:anywhere]">
                <LinkedText parts={linkedParts(forward.quote.text, world)} />
              </p>
              <RefChips codes={forward.quote.refs} world={world} />
            </blockquote>
          )}
        </div>
      )}
      <p className="mt-2.5 text-body leading-[1.55] whitespace-pre-line [overflow-wrap:anywhere]">
        <LinkedText parts={linkedParts(mail.text, world)} />
      </p>
      <RefChips codes={mail.refs} world={world} />
      {(mail.forwardedBy ?? []).map((item) => (
        <Link key={item.mail} to={href.mail(item.mail)} className="mt-1.5 flex min-h-11 items-center gap-1.5 text-meta font-medium text-link [overflow-wrap:anywhere]" data-testid="forwarded-by">
          <Icon name="twoway" size="xs" className="flex-none" />
          <span className="min-w-0">{forwardedByLine(item, removed)}</span>
          <Icon name="chevR" size="xs" className="flex-none" />
        </Link>
      ))}
      <Actions thread={thread} mail={mail} world={world} wide={wide} className="mt-2.5 border-t border-line" style={ACTIONS_TOP} />
    </li>
  );
}

function ThreadView({ thread, world, now, mark, wide, phone }: { thread: MailThread; world: World; now: number; mark: string | null; wide: boolean; phone: boolean }) {
  const card = thread.cardId ? world.cards.find((c) => c.id === thread.cardId) : null;
  const project = world.projects.find((p) => p.id === thread.projectId)?.name ?? thread.projectId;
  const lane = world.lanes.find((l) => l.id === thread.laneId)?.name;
  const removed = removedNames(world.bots);
  const noted = new Set<string>();
  const noteOf = (mail: Mail) => {
    const fresh = removedIn(mail, removed).filter((name) => !noted.has(name));
    fresh.forEach((name) => noted.add(name));
    return fresh.length ? removedNote(fresh) : null;
  };
  const qd = useQd();
  const [tries, setTries] = useState(0);
  const [done, setDone] = useState<{ at: number; failed: boolean } | null>(null);
  const leftOut = useRef<HTMLParagraphElement>(null);
  const unread = qd.openMailThread !== undefined && thread.omitted === undefined;
  const readFailed = unread && done !== null && done.at === tries && done.failed;
  useEffect(() => {
    if (!qd.openMailThread) return;
    let live = true;
    const settle = (failed: boolean) => live && setDone({ at: tries, failed });
    qd.openMailThread(thread.ref).then(
      () => settle(false),
      () => settle(true),
    );
    return () => {
      live = false;
    };
  }, [qd, thread.ref, tries]);
  useEffect(() => () => qd.closeMailThread?.(thread.ref), [qd, thread.ref]);
  useEffect(() => {
    if (mark && !unread) (document.getElementById("mail-" + mark) ?? leftOut.current)?.scrollIntoView({ block: "center" });
  }, [mark, unread]);
  return (
    <article aria-labelledby="mail-subject" data-testid="mail-thread">
      {!wide && !phone && (
        <BackLink to={href.mail()} className="-ml-1">
          Mail
        </BackLink>
      )}
      <div className={wide ? "sticky top-0 z-10 -mx-1 border-b border-line bg-page px-1 py-2" : undefined}>
        <Actions thread={thread} mail={null} world={world} wide={wide} className={wide ? undefined : "mt-1"} />
      </div>
      <h2 id="mail-subject" className="mt-3 text-title leading-[1.3] font-bold tracking-[-.01em] [overflow-wrap:anywhere]">
        {thread.subject}
      </h2>
      {thread.projectId ? (
        <p className="eyebrow mt-1.5 flex items-center gap-1.5">
          <Icon name="mail" size="xs" />
          {project}
          {lane ? " > " + lane : ""}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2.5">
        <BotStack names={botsOrdered(thread)} world={world} ring="var(--color-page)" />
        <p className="min-w-0 text-meta text-ink-2 [overflow-wrap:anywhere]" data-testid="mail-bots">
          {botsLine(thread, removed)}
        </p>
      </div>
      {card && (
        <Link to={href.queue(card.id)} className="mt-2.5 inline-flex min-h-11 max-w-full items-center gap-2 rounded-small border border-line-3 bg-panel px-2.5 py-1.5 text-meta" data-testid="behind-card">
          <PriorityTile priority={card.priority} />
          <span className="min-w-0 [overflow-wrap:anywhere]">Behind the Task Card: {card.title}</span>
          <Icon name="chevR" size="xs" className="flex-none text-ink-3" />
        </Link>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-small text-ink-2" data-testid="mail-read-only">
        <Icon name="lock" size="xs" className="mt-[3px]" />
        Read only. Your inbox and sent mail.
      </p>
      {unread ? (
        readFailed ? (
          <ErrorLine className="mt-3.5" onRetry={() => setTries((n) => n + 1)}>
            Could not load this thread.
          </ErrorLine>
        ) : (
          <LoadingBars className="mt-3.5" rows={3} height={96} />
        )
      ) : (
        <>
          {thread.omitted ? (
            <p ref={leftOut} className="mt-3.5 text-small text-ink-2" data-testid="mail-omitted">
              {thread.omitted === 1 ? "1 earlier mail not shown." : thread.omitted + " earlier mails not shown."}
            </p>
          ) : null}
          <ol className="mt-3.5 grid gap-2.5">
            {thread.mails.map((mail) => (
              <MailCard key={mail.ref} mail={mail} thread={thread} world={world} removed={removed} now={now} mark={mark} wide={wide} note={noteOf(mail)} />
            ))}
          </ol>
        </>
      )}
    </article>
  );
}

export function MailScreen({ mailRef, wide }: { mailRef: string | null; wide: boolean }) {
  const qd = useQd();
  const { world, failed, retry } = useWorld();
  const phone = usePhone() && !wide;
  const dot = useNewActivity();
  const [query, setQuery] = useMailQuery();
  const now = qd.now();
  const view = world ? viewMail(world, query, now) : null;
  const shownRef = mailRef ? threadOf(mailRef) : wide ? (view?.threads[0]?.ref ?? null) : null;
  const thread = world && shownRef ? (world.mail.find((t) => t.ref === shownRef) ?? null) : null;
  const mark = mailRef && mailRef !== shownRef ? mailRef : null;
  const showList = wide || !mailRef;
  const [listTries, setListTries] = useState(0);
  const [listDone, setListDone] = useState<{ at: number; failed: boolean; world: World | null } | null>(null);
  const worldNow = useRef(world);
  worldNow.current = world;
  useEffect(() => {
    if (!qd.openMailList) return;
    let live = true;
    const settle = (failed: boolean) => live && setListDone({ at: listTries, failed, world: worldNow.current });
    qd.openMailList().then(
      () => settle(false),
      () => settle(true),
    );
    return () => {
      live = false;
    };
  }, [qd, listTries]);
  useEffect(() => () => qd.closeMailList?.(), [qd]);
  const listSettled = listDone !== null && listDone.at === listTries;
  const listFailed = qd.openMailList !== undefined && listSettled && listDone.failed;
  const listWaiting = qd.openMailList !== undefined && !listFailed && (!listSettled || listDone.world === world);
  const listed = world !== null && (world.mail.length > 0 || (!listFailed && !listWaiting));
  const rows = useShown(view?.threads ?? [], (item) => item.ref, listed && showList ? JSON.stringify(query) : "");

  useLayoutEffect(() => {
    if (!wide && listed && !mark) window.scrollTo(0, mailRef ? 0 : readSession("mail.scroll", 0));
  }, [wide, mailRef, mark, listed]);

  const listBox = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  useKeys(wide, (event) => {
    if (!view) return;
    if (event.key === "j" || event.key === "k") {
      const at = view.threads.findIndex((item) => item.ref === shownRef);
      const next = view.threads[event.key === "j" ? at + 1 : Math.max(at - 1, 0)];
      if (!next || next.ref === shownRef) return;
      event.preventDefault();
      go(href.mail(next.ref), { replace: true });
      listBox.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.ref)}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Escape") {
      const row = listBox.current?.querySelector<HTMLElement>('[aria-current="true"]');
      if (row && document.activeElement !== row) row.focus();
      return;
    }
    if ((event.key !== "c" && event.key !== "a") || !thread) return;
    const code = document.activeElement?.closest<HTMLElement>('[data-testid="mail-item"]')?.dataset.ref ?? mark ?? thread.ref;
    const button = pane.current?.querySelector<HTMLElement>(`[data-testid="${event.key === "c" ? "copy-" : "ask-"}${CSS.escape(code)}"]`);
    if (!button) return;
    event.preventDefault();
    button.focus();
    button.click();
  });

  const title = <Title>Mail</Title>;
  const head = phone ? null : <Head className="px-2 wide:px-8">{title}</Head>;
  const named = phone && (mailRef ? <h1 className="sr-only">Mail</h1> : <div className="pb-2">{title}</div>);
  const top = !phone ? null : !mailRef ? (
    <FloatListTop label="Mail actions" dot={dot} />
  ) : thread && world ? (
    <ThreadTop thread={thread} world={world} />
  ) : (
    <FloatTop>
      <FloatBack to={href.mail()} label="Back to Mail" />
    </FloatTop>
  );

  if (!world || !view || !listed)
    return (
      <div className="mx-auto w-full max-w-[1240px]">
        {top}
        {head}
        <div className={cx("px-4 wide:px-8", phone ? FLOAT_TOP_PAD : "pt-2")}>
          {named}
          {(world ? listFailed : failed) ? (
            <ErrorLine onRetry={world ? () => setListTries((n) => n + 1) : retry}>Could not load the Mail.</ErrorLine>
          ) : (
            <LoadingBars rows={4} height={86} />
          )}
        </div>
      </div>
    );

  const pickFilter = (key: string, value: string | undefined) => setQuery({ ...query, filters: withFilter(query.filters, key as MailFilterKey, value) });
  const clear = () => setQuery({ ...EMPTY_MAIL_QUERY, text: query.text });

  const nothing = view.threads.length === 0;
  const none = world.mail.length === 0;
  const emptyNode = (
    <div className={wide && none ? "mx-auto" : undefined} style={wide && none ? EMPTY_WIDE : EMPTY}>
      <Empty icon={world.mail.length ? "search" : "mail"} testId="mail-empty">
        {world.mail.length ? "No mail matches." : "No mail yet. Your inbox and sent mail show here."}
      </Empty>
    </div>
  );

  const list = (
    <section aria-label="Mail threads" className="grid grid-cols-1 content-start gap-2">
      <div className="flex items-center gap-2">
        <SearchField value={query.text} onText={(text) => setQuery({ ...query, text })} label="Search mail" className="min-w-0 flex-1" testId="mail-search" />
        <div className="relative">
          <FilterPick groups={view.groups} count={view.filterCount} value={(key) => query.filters[key as MailFilterKey]} onPick={pickFilter} onClear={clear} wide={wide} />
        </div>
      </div>
      {view.chips.length > 0 && (
        <FilterLine chips={view.chips} onRemove={(key) => pickFilter(key, undefined)} onClear={clear} testId="mail-filters-on" />
      )}
      {nothing ? (
        !(wide && none) && emptyNode
      ) : (
        <div className="grid gap-1" data-testid="mail-list">
          {dayGroups(rows.shown, now, (row) => row.item).map((day) => (
            <section key={day.key} aria-label={day.heading} className="grid gap-1.5" data-testid="mail-day">
              <h3 className="eyebrow mt-3 px-1">{day.heading}</h3>
              <ul className="grid gap-px overflow-hidden rounded-panel border border-line" style={RULED}>
                {day.threads.map((row) => (
                  <ThreadRow key={row.id} thread={row.item} world={world} on={wide && !row.leaving && row.id === shownRef} wide={wide} motion={rowMotion(row, rows.drop)} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );

  const reading = thread ? (
    <ThreadView key={thread.ref} thread={thread} world={world} now={now} mark={mark} wide={wide} phone={phone} />
  ) : mailRef ? (
    <Empty>No thread {threadOf(mailRef)}.</Empty>
  ) : wide && none ? (
    emptyNode
  ) : null;

  return (
    <div className="mx-auto w-full max-w-[1240px]" data-testid="mail">
      {top}
      {head}
      <div className={cx("px-4 pb-12 wide:grid wide:items-start wide:gap-7 wide:px-8", phone ? FLOAT_TOP_PAD : "pt-1")} style={wide ? COLUMNS : undefined}>
        {named}
        {showList && (
          <div ref={listBox} className="wide:sticky wide:top-3">
            {list}
          </div>
        )}
        {(wide || mailRef) && (
          <div ref={pane} className="min-w-0" data-pane="">
            {reading}
          </div>
        )}
      </div>
    </div>
  );
}
