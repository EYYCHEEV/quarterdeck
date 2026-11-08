import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQd } from "../../data/hooks";
import { useReceipt, useSession } from "../../data/session";
import { SessionUnconfirmed, SignInRequired } from "../../data/source";
import { answerStep, cardKey, carryAnswer, confirmPrompt, notePlaceholder, receiptText, sendButton, startAnswer, type AnswerEvent, type AnswerState } from "../../domain/answer";
import { noAnswerLine, oneWayBlock } from "../../domain/card";
import { failedText, pastDueLine, sendingText } from "../../domain/card-words";
import { nextAfter, rankQueue } from "../../domain/queue";
import { href } from "../../domain/routes";
import type { Card, CardOption, Choice, World } from "../../domain/types";
import { Button, IconButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { TextArea } from "../../ui/field";
import { Fold } from "../../ui/fold";
import { Icon } from "../../ui/icon";
import { onControl, useKeys } from "../../ui/keys";
import { currentPath, go } from "../../ui/link";
import { RadioMark } from "../../ui/option";
import { CopyButton } from "../../ui/reference";
import { ErrorLine } from "../../ui/states";

const CHOSEN = "border-brass shadow-[inset_0_0_0_1px_var(--color-brass)]";
const LOCKED = { opacity: 0.6 };

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="m-0 mt-1.5 grid gap-1.5">
      {items.map(([term, text]) => (
        <div key={term} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2.5">
          <dt className="eyebrow">{term}</dt>
          <dd className="m-0 text-note leading-[1.45] text-ink-2">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

function details(option: CardOption, skip: Set<string>): [string, ReactNode][] {
  const items: [string, ReactNode][] = [];
  if (option.does && !skip.has("does")) items.push(["Does", option.does]);
  if (option.cost) items.push(["Cost", option.cost]);
  if (option.risk && !skip.has("risk")) items.push(["Risk", option.risk]);
  if (option.door === "one-way" && !skip.has("door")) items.push(["Undo", <span className="font-semibold text-red">{option.undo ?? "Cannot be undone."}</span>]);
  else if (option.undo && !skip.has("undo")) items.push(["Undo", option.undo]);
  if (option.pros.length) items.push(["Pros", option.pros.join(" · ")]);
  if (option.cons.length) items.push(["Cons", option.cons.join(" · ")]);
  if (option.tradeoff) items.push(["Trade", option.tradeoff]);
  return items;
}

function RiskUndo({ option }: { option: CardOption }) {
  if (!option.risk && !option.undo) {
    return (
      <p className="flex items-center gap-1.5 text-ink-2">
        <Icon name="twoway" size="xs" />
        Two-way change (can be undone)
      </p>
    );
  }
  return (
    <p>
      {option.risk && (
        <>
          <span className="font-semibold">Risk: </span>
          {option.risk}
        </>
      )}
      {option.risk && option.undo && <span className="text-ink-3"> · </span>}
      {option.undo && (
        <>
          <span className="font-semibold">Undo: </span>
          {option.undo}
        </>
      )}
    </p>
  );
}

function OptionRow({
  card,
  option,
  on,
  locked,
  whole,
  onPick,
}: {
  card: Card;
  option: CardOption;
  on: boolean;
  locked: boolean;
  whole: boolean;
  onPick: () => void;
}) {
  const [open, setOpen] = useState(whole);
  useEffect(() => setOpen(whole), [whole]);
  const pick = option.pick;
  const blockAbove = pick && option.door === "one-way";
  const shown = pick ? new Set(["risk", "undo", ...(blockAbove ? ["door"] : [])]) : new Set<string>();
  const more = details(option, shown);
  return (
    <li className={cx("rounded-panel border bg-panel", on ? CHOSEN : pick ? "border-brass-edge" : "border-line-3")} data-testid="option" data-letter={option.letter}>
      <div className="flex items-start">
        <button
          type="button"
          role="radio"
          aria-checked={on}
          disabled={locked}
          onClick={onPick}
          data-choice=""
          className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-start gap-3 py-3 pl-3.5 text-left disabled:cursor-default"
        >
          <RadioMark on={on} pick={pick}>
            {option.letter}
          </RadioMark>
          <span className="min-w-0 flex-1 pt-1 text-row font-semibold [overflow-wrap:anywhere]">
            {pick && <span className="text-brass">Our pick: </span>}
            {option.letter}. {option.label}
          </span>
        </button>
        {more.length > 0 ? (
          <IconButton
            icon={open ? "chevD" : "chevR"}
            label={(open ? "Hide details for " : "Details for ") + option.letter}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="m-0.5 mt-1.5"
          />
        ) : (
          <span className="w-3.5" />
        )}
      </div>
      {(pick || open) && (
        <div className="pr-3.5 pb-3.5 pl-[58px]">
          {pick && (
            <div className="grid gap-1.5 text-prose">
              {card.pickWhy && (
                <p>
                  <span className="font-semibold">Why: </span>
                  {card.pickWhy}
                </p>
              )}
              {!blockAbove && <RiskUndo option={option} />}
              {card.commands.length > 0 && (
                <div className="mt-1 grid gap-2">
                  {card.commands.map((command) => (
                    <div key={command.run} className="overflow-hidden rounded-small border border-line-2 bg-side">
                      <div className="flex items-center justify-between gap-2 border-b border-line py-0.5 pr-1 pl-3 text-xs text-ink-3">
                        <span className="truncate">{command.where}</span>
                        <CopyButton value={command.run} label="Copy" done="Copied" className="border-transparent bg-transparent" />
                      </div>
                      <pre className="m-0 px-3 py-2.5 font-mono text-code whitespace-pre-wrap [overflow-wrap:anywhere] text-code-ink">{command.run}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {open && more.length > 0 && <Facts items={more} />}
        </div>
      )}
    </li>
  );
}

export function ReadOnlyOptions({ card, whole }: { card: Card; whole: boolean }) {
  const chosen = card.answer?.choice.kind === "option" ? card.answer.choice.letter : null;
  const rest = card.options.filter((option) => option.letter !== chosen);
  if (!rest.length) return null;
  return (
    <Fold label={"Options (" + rest.map((option) => option.letter).join(", ") + ")"} open={whole} className="mt-6" testId="answered-options">
      <ul className="mt-1 grid gap-2">
        {rest.map((option) => (
          <li key={option.letter} className="rounded-panel border border-line bg-panel px-3.5 py-3" data-testid="read-only-option">
            <p className="text-row font-semibold text-ink-2">
              {option.letter}. {option.label}
            </p>
            {details(option, new Set()).length > 0 && <Facts items={details(option, new Set())} />}
          </li>
        ))}
      </ul>
    </Fold>
  );
}

function same(a: Choice | null, b: Choice): boolean {
  return a !== null && a.kind === b.kind && (a.kind !== "option" || (b.kind === "option" && a.letter === b.letter));
}

function Ask({ card }: { card: Card }) {
  return (
    <section className="mt-6 rounded-panel border border-line-3 bg-panel px-4 py-3.5" aria-label="The ask" data-testid="ask">
      <p className="text-row font-semibold">
        {card.owner} asks you to approve: {card.about ?? card.title}
      </p>
      <div className="mt-2 grid gap-1.5 text-prose">
        {card.pickWhy && (
          <p>
            <span className="font-semibold">Why: </span>
            {card.pickWhy}
          </p>
        )}
        {card.approvalUndo ? (
          <p>
            <span className="font-semibold">Undo: </span>
            {card.approvalUndo}
          </p>
        ) : (
          card.approvalDoor === "two-way" && (
            <p className="flex items-center gap-1.5 text-ink-2">
              <Icon name="twoway" size="xs" />
              Two-way change (can be undone)
            </p>
          )
        )}
      </div>
    </section>
  );
}

function OneWayBlock({ risk }: { risk: string }) {
  return (
    <div className="mb-2.5 rounded-panel border bg-red-soft px-3.5 py-3" style={{ borderColor: "color-mix(in oklab, var(--color-red) 50%, transparent)" }} data-testid="one-way-block">
      <p className="flex items-center gap-2 font-semibold text-red">
        <Icon name="alert" size="sm" />
        One-way change: cannot be undone
      </p>
      {risk && (
        <p className="mt-1 pl-6 text-prose text-ink">
          <span className="font-semibold">Risk: </span>
          {risk}
        </p>
      )}
    </div>
  );
}

export function AnswerFlow({ card, world, whole, keys }: { card: Card; world: World; whole: boolean; keys: boolean }) {
  const qd = useQd();
  const [, setReceipt] = useReceipt();
  const [stored, setStored] = useSession<AnswerState | null>("answer." + card.id, null);
  const state = stored ? carryAnswer(card, stored) : startAnswer(card);
  const back = useRef<HTMLButtonElement>(null);
  const latest = useRef(state);
  const lifetime = __QD_SOURCE__ === "server" ? useRef(0) : null;
  if (__QD_SOURCE__ === "server") useEffect(() => () => { lifetime!.current += 1; }, [card.id]);
  latest.current = state;
  const step = (event: AnswerEvent) => {
    const next = answerStep(card, latest.current, event);
    latest.current = next;
    setStored(next);
    return next;
  };
  const approval = card.options.length === 0;
  const block = oneWayBlock(card) ?? (approval && card.approvalDoor === "one-way" ? { risk: "" } : null);
  const noAnswer = noAnswerLine(card);
  const pastDue = pastDueLine(card, qd.now());
  const locked = state.phase === "sending";
  const confirming = state.phase === "confirm";

  useEffect(() => {
    if (confirming) back.current?.focus();
  }, [confirming]);

  const deliver = async (after: AnswerState) => {
    if (after.phase !== "sending" || !after.choice) return;
    const from = currentPath();
    const mine = __QD_SOURCE__ === "server" ? lifetime!.current : 0;
    try {
      const answer = await qd.answer(card.id, { choice: after.choice, note: after.note, version: card.version });
      if (__QD_SOURCE__ === "server" && mine !== lifetime!.current) return;
      const nextId = nextAfter(rankQueue(world.cards, world.tasks, qd.now()), card.id);
      setStored(null);
      setReceipt({ text: receiptText(card, answer), cardId: nextId });
      if (currentPath() === from) go(href.queue(nextId), { replace: true });
    } catch (error) {
      if (__QD_SOURCE__ === "server" && (mine !== lifetime!.current || error instanceof SignInRequired || error instanceof SessionUnconfirmed)) return;
      step({ type: "failed", error });
    }
  };

  const send = (choice?: Choice) => deliver(step({ type: "send", at: Date.now(), choice }));
  const confirm = () => deliver(step({ type: "confirm", at: Date.now() }));
  const button = sendButton(card, state);
  const prompt = confirmPrompt(card, state);

  useKeys(keys, (event) => {
    const action = cardKey(card, event.key);
    const now = latest.current;
    if (!action || event.repeat || now.phase === "sending") return;
    const onChoice = event.target instanceof Element && event.target.closest("[data-choice]") !== null;
    if (action.type === "choose") {
      event.preventDefault();
      step({ type: "choose", choice: action.choice });
    } else if (action.type === "send" && now.phase !== "confirm" && (onChoice || !onControl(event.target)) && !sendButton(card, now).disabled) {
      event.preventDefault();
      send();
    }
  });

  const none = state.choice?.kind === "none";

  return (
    <>
      {approval ? (
        <>
          {block && (
            <div className="mt-6">
              <OneWayBlock risk={block.risk} />
            </div>
          )}
          <Ask card={card} />
        </>
      ) : (
        <section className="mt-6" aria-label="Options" data-testid="options">
          {block && <OneWayBlock risk={block.risk} />}
          <ul role="radiogroup" aria-label="Options" className="grid gap-2.5" style={locked ? LOCKED : undefined}>
            {card.options.map((option) => (
              <OptionRow
                key={option.letter}
                card={card}
                option={option}
                on={same(state.choice, { kind: "option", letter: option.letter })}
                locked={locked}
                whole={whole}
                onPick={() => step({ type: "choose", choice: { kind: "option", letter: option.letter } })}
              />
            ))}
            <li>
              <button
                type="button"
                role="radio"
                aria-checked={none}
                disabled={locked}
                onClick={() => step({ type: "choose", choice: { kind: "none" } })}
                data-choice=""
                className={cx("flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-panel border bg-panel px-3.5 py-2 text-left text-row font-semibold disabled:cursor-default", none ? CHOSEN : "border-line-3")}
                data-testid="none-of-these"
              >
                <RadioMark on={none} />
                None of these
              </button>
            </li>
          </ul>
        </section>
      )}
      <section className="mt-6 border-t border-line pt-5" aria-label="Your answer" data-testid="answer-area" aria-busy={locked}>
        {pastDue ? (
          <div className="mb-3 rounded-panel border border-brass-edge px-3.5 py-3 text-prose" style={{ backgroundColor: "var(--color-brass-soft)" }} data-testid="past-due">
            <p className="flex items-start gap-2">
              <Icon name="clock" size="sm" className="mt-[3px] flex-none text-brass" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{pastDue}</span>
            </p>
            <p className="mt-1 pl-6 font-semibold">You can still answer now.</p>
          </div>
        ) : (
          noAnswer && (
            <p className="mb-3 flex items-start gap-2 text-prose text-ink-2" data-testid="no-answer">
              <Icon name="clock" size="sm" className="mt-[3px] flex-none" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{noAnswer}</span>
            </p>
          )
        )}
        <TextArea
          rows={2}
          style={locked ? LOCKED : undefined}
          value={state.note}
          readOnly={locked}
          placeholder={notePlaceholder(state)}
          aria-label="Note"
          onChange={(event) => step({ type: "note", text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            const pane = event.currentTarget.closest<HTMLElement>("[data-pane]");
            if (pane) pane.focus({ preventScroll: true });
            else event.currentTarget.blur();
          }}
          data-testid="note"
        />
        {state.phase === "failed" && (
          <div className="mt-2.5" data-testid="send-failed">
            <ErrorLine onRetry={() => send()} retryLabel="Try again">{failedText(state)}</ErrorLine>
          </div>
        )}
        {confirming ? (
          <div className="mt-2.5 rounded-panel border border-line-3 bg-panel p-3" role="group" aria-label="Confirm" data-testid="confirm">
            <p className="text-body font-semibold">{prompt.question}</p>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <Button kind="primary" onClick={confirm} data-testid="confirm-send">
                {prompt.button}
              </Button>
              <Button kind="ghost" ref={back} onClick={() => step({ type: "back" })}>
                Back
              </Button>
            </div>
          </div>
        ) : approval ? (
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <Button kind="primary" disabled={locked} onClick={() => send({ kind: "approve" })} data-testid="approve">
              {locked && state.choice?.kind === "approve" ? sendingText(state) : "Approve"}
            </Button>
            <Button kind="plain" disabled={locked} onClick={() => send({ kind: "reject" })} data-testid="reject">
              {locked && state.choice?.kind === "reject" ? sendingText(state) : "Reject"}
            </Button>
          </div>
        ) : (
          <Button kind="primary" block className="mt-2.5" disabled={button.disabled || locked} onClick={() => send()} data-testid="send">
            {locked ? sendingText(state) : button.text}
          </Button>
        )}
      </section>
    </>
  );
}
