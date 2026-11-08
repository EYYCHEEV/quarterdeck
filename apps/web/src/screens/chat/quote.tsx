import { useId, useLayoutEffect, useRef, useState } from "react";
import { isCardQuote, type Quote } from "../../domain/chat";
import { href } from "../../domain/routes";
import { IconButton, LinkButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Link } from "../../ui/link";
import { PriorityTile } from "../../ui/priority";

const FRAME = "chat-quote-block relative flex items-start gap-2 rounded-small border border-line-3 border-l-[3px] border-l-brass bg-panel py-2 pr-1 pl-3 text-left";

function showMessage(id: string) {
  const message = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  if (!message) return;
  message.scrollIntoView({ block: "center" });
  message.focus({ preventScroll: true });
}

export function QuoteBlock({ quote, onRemove }: { quote: Quote; onRemove?: () => void }) {
  const textId = useId();
  const [open, setOpen] = useState(false);
  const [folds, setFolds] = useState(false);
  const clamped = useRef<HTMLSpanElement>(null);
  const text = isCardQuote(quote) ? null : quote.text;
  useLayoutEffect(() => {
    const el = clamped.current;
    if (!el || open) return;
    const measure = () => setFolds(el.scrollHeight > el.clientHeight);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [open, text]);
  if (isCardQuote(quote))
    return (
      <div className={FRAME} data-testid={onRemove ? "chat-quote" : "chat-sent-quote"}>
        <Link to={href.queue(quote.cardId)} className="min-w-0 flex-1 py-0.5">
          <span className="eyebrow block text-brass">{quote.label}</span>
          <span className="mt-1 flex items-start gap-2">
            <PriorityTile priority={quote.priority} />
            <b className="min-w-0 text-prose font-semibold [overflow-wrap:anywhere]">{quote.title}</b>
          </span>
          {quote.recap.map((line) => (
            <span key={line} className="mt-0.5 block text-small [overflow-wrap:anywhere] text-ink-2">
              {line}
            </span>
          ))}
        </Link>
        {onRemove && <IconButton icon="x" label="Remove the quoted Task Card" onClick={onRemove} />}
      </div>
    );
  const source = onRemove ? undefined : quote.messageId;
  const body = (
    <>
      <span className="eyebrow block text-brass">{quote.label}</span>
      {quote.title && <b className="mt-1 block text-prose font-semibold [overflow-wrap:anywhere]">{quote.title}</b>}
      <span id={textId} ref={clamped} className={cx("mt-1 text-small whitespace-pre-line [overflow-wrap:anywhere] text-ink-2", open ? "block" : "line-clamp-4")} data-testid="chat-quote-text">
        {quote.text}
      </span>
    </>
  );
  return (
    <div className={FRAME} data-testid={onRemove ? "chat-quote" : "chat-sent-quote"}>
      <div className="min-w-0 flex-1">
        {quote.to ? (
          <Link to={quote.to} className="block py-0.5">
            {body}
          </Link>
        ) : source ? (
          <button type="button" onClick={() => showMessage(source)} className="block w-full cursor-pointer py-0.5 text-left pointer-coarse:min-h-11">
            {body}
          </button>
        ) : (
          <div className="py-0.5">{body}</div>
        )}
        {folds && (
          <LinkButton aria-expanded={open} aria-controls={textId} onClick={() => setOpen(!open)} data-testid="chat-quote-fold">
            {open ? "Show less" : "Show all"}
          </LinkButton>
        )}
      </div>
      {onRemove && <IconButton icon="x" label="Remove the quote" onClick={onRemove} />}
    </div>
  );
}
