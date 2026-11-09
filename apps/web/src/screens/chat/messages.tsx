import { useEffect, useMemo, useState } from "react";
import type { Attachment, ChatMessage, SentQuote, Working } from "../../data/chat-types";
import { useQd } from "../../data/hooks";
import { DELIVERED_TEXT, QUIET_TEXT, readableText, readText, resolveQuote, SEND_FAILED_TEXT, SEND_RETRY_TEXT, workingStatus } from "../../domain/chat";
import { UPLOADING_TEXT } from "../../domain/files-r1";
import { parseMarkdown } from "../../domain/markdown";
import { referenceInfo } from "../../domain/references";
import { href, linkedParts, referenceHref } from "../../domain/routes";
import { clockTime } from "../../domain/time";
import type { World } from "../../domain/types";
import { Avatar } from "../../ui/avatar";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { LinkedText } from "../../ui/linked-text";
import { Markdown } from "../../ui/markdown";
import { ARRIVE, RISE } from "../../ui/motion";
import { RefChip } from "../../ui/reference";
import { ErrorLine } from "../../ui/states";
import { AttachmentList } from "./attachments";
import { Actionable } from "./message-actions";
import { QuoteBlock } from "./quote";

const TICK_MS = 15_000;

const RETRY_UNDER = "max-upright:grid max-upright:grid-cols-[auto_minmax(0,1fr)] max-upright:[&>button]:col-span-2 max-upright:[&>button]:justify-self-end";

const STATUS_LINE = "flex h-4 items-center";

type OnQuote = (selected: string | null) => void;

export function BotMessage({ message, name, color, world, fresh, onQuote, onOpen }: { message: ChatMessage; name: string; color?: string; world: World; fresh?: boolean; onQuote?: OnQuote; onOpen: (file: Attachment, from: HTMLElement) => void }) {
  const blocks = useMemo(() => parseMarkdown(message.text), [message.text]);
  const plain = useMemo(() => readableText(message.text), [message.text]);
  const shownQuote = message.quote ? resolveQuote(message.quote, world, name) : null;
  return (
    <Actionable id={message.id} title={name + " · " + clockTime(message.at)} copy={plain} onQuote={onQuote} align="start" className={cx("chat-bot-message", fresh && ARRIVE)} testId="chat-bot-message">
      <div className="chat-bot-label">
        <Avatar name={name} color={color} size="sm" />
        <b>{name}</b>
        <time>{clockTime(message.at)}</time>
      </div>
      <div className="chat-bot-bubble">
        {shownQuote && <QuoteBlock quote={shownQuote} />}
        <div data-message-text="">
          <Markdown blocks={blocks} botName={name} className="text-lead" renderText={(text, key) => <LinkedText key={key} parts={linkedParts(text, world)} />} />
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2.5">
            <AttachmentList items={message.attachments} align="start" onOpen={onOpen} />
          </div>
        )}
        {message.cardUpdate && (
          <Link to={href.queue(message.cardUpdate.cardId)} className="chat-card-change" data-testid="chat-card-update">
            <Icon name="queue" size="sm" />
            <span className="min-w-0">
              <span className="block">{message.cardUpdate.line}</span>
              <strong className="mt-1 block">{world.cards.find((card) => card.id === message.cardUpdate?.cardId)?.title ?? "Open Task Card"}</strong>
            </span>
            <Icon name="chevR" size="sm" />
          </Link>
        )}
        {(message.refs.length > 0 || (message.cardRefs ?? []).length > 0) && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {(message.cardRefs ?? [])
              .filter((id) => id !== message.cardUpdate?.cardId)
              .flatMap((id) => {
                const card = world.cards.find((item) => item.id === id);
                return card ? [<RefChip key={"card-" + id} to={href.queue(id)} kind="Task Card" code={id} title={card.title} />] : [];
              })}
            {message.refs.flatMap((code) => {
              const info = referenceInfo(code, world);
              return info ? [<RefChip key={code} to={referenceHref(info)} kind={info.kind} code={code} title={info.title} />] : [];
            })}
          </div>
        )}
      </div>
    </Actionable>
  );
}

export function NewLine() {
  return (
    <li className="chat-new" data-testid="chat-new">
      New
    </li>
  );
}

type Note = "delivered" | "read" | "uploading" | "sending" | "failed" | null;

export function MyMessage({
  text,
  quote,
  attachments,
  at,
  note,
  seenAt,
  onRetry,
  reason,
  onOpen,
  world,
  botName,
  actions,
  id,
  rise,
}: {
  text: string;
  quote?: SentQuote | null;
  attachments?: Attachment[];
  at: string;
  note: Note;
  seenAt?: string | null;
  onRetry?: () => void;
  reason?: string | null;
  onOpen: (file: Attachment, from: HTMLElement) => void;
  world: World;
  botName?: string;
  actions?: OnQuote;
  id?: string;
  rise?: boolean;
}) {
  const qd = useQd();
  const shownQuote = quote ? resolveQuote(quote, world, botName) : null;
  return (
    <Actionable id={id} title={"You · " + clockTime(at)} copy={id && text ? text : undefined} onQuote={actions} align="end" className={cx("chat-my-message flex flex-col gap-[5px]", rise && RISE)} testId="chat-my-message">
      {shownQuote && <QuoteBlock quote={shownQuote} />}
      {attachments && attachments.length > 0 && <AttachmentList items={attachments} align="end" onOpen={onOpen} />}
      {text && (
        <p data-message-text="" className="chat-my-bubble text-lead whitespace-pre-line [overflow-wrap:anywhere]">
          <LinkedText parts={linkedParts(text, world)} />
        </p>
      )}
      {note === "failed" ? (
        <ErrorLine onRetry={onRetry} retryLabel={SEND_RETRY_TEXT} retryId="chat-retry" className={onRetry && RETRY_UNDER}>
          <span className="block">{SEND_FAILED_TEXT}</span>
          {reason && <span className="block text-small text-ink-2">{reason}</span>}
        </ErrorLine>
      ) : note === "sending" || note === "uploading" ? (
        <p className={cx(STATUS_LINE, "self-stretch", note === "uploading" && "gap-2")} data-testid="chat-sending-bar">
          <span aria-hidden="true" data-progress="" className="relative h-0.5 w-full overflow-hidden rounded-full bg-line-2">
            <span className="sending-bar absolute inset-y-0 left-0 w-2/5 rounded-full bg-chat-accent" />
          </span>
          {note === "uploading" ? (
            <span className="flex-none text-xs text-ink-2" data-testid="chat-uploading">
              {UPLOADING_TEXT}
            </span>
          ) : (
            <span className="sr-only">Sending...</span>
          )}
        </p>
      ) : (
        <p className={cx(STATUS_LINE, "text-xs text-ink-3")}>
          <time>{clockTime(at)}</time>
        </p>
      )}
      {note === "delivered" && <p className="text-xs text-ink-2" data-testid="chat-delivered">{DELIVERED_TEXT}</p>}
      {note === "read" && <p className="text-xs text-ink-2" data-testid="chat-seen">{readText(seenAt, qd.now())}</p>}
    </Actionable>
  );
}

export function WorkingLine({ botName, working }: { botName: string; working: Working }) {
  const qd = useQd();
  const [now, setNow] = useState(() => qd.now());
  useEffect(() => {
    setNow(qd.now());
    const id = window.setInterval(() => setNow(qd.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [qd, working.updatedAt]);
  const { minutes, quiet } = workingStatus(working, now);
  return (
    <li className="chat-working grid gap-0.5 text-small text-ink-2" data-testid="chat-working">
      <p data-testid="chat-working-line">
        {botName} is working · {minutes} min
      </p>
      <p className="text-ink-3" aria-live="polite" data-testid="chat-working-note">
        {working.note}
      </p>
      <p className="min-h-[1.4em] text-ink-3" data-testid="chat-working-quiet">
        {quiet ? QUIET_TEXT : null}
      </p>
    </li>
  );
}
