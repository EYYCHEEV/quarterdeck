import { useId, useLayoutEffect, useRef, useState } from "react";
import { handToAnswer } from "../../data/session";
import { isCardQuote, type Quote } from "../../domain/chat";
import { href } from "../../domain/routes";
import { Button, IconButton, LinkButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { go, Link } from "../../ui/link";
import { PriorityTile } from "../../ui/priority";

const FRAME = "chat-quote-block relative flex items-start gap-s2 rounded-key border border-line-3 border-l-[length:var(--line-w-key)] border-l-hand bg-panel py-s2 pr-s1 pl-s3 text-left";

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
  if (isCardQuote(quote)) {
    const card = quote.cardId;
    const backToCard = () => {
      handToAnswer(card);
      go(href.queue(card));
    };
    return (
      <div className={FRAME} data-testid={onRemove ? "chat-quote" : "chat-sent-quote"}>
        <div className="min-w-0 flex-1">
          <Link to={href.queue(card)} className="block py-hair">
            <span className="eyebrow block text-ink-2">{quote.label}</span>
            <span className="mt-s1 flex items-start gap-s2">
              <PriorityTile priority={quote.priority} />
              <b className="min-w-0 text-body font-strong [overflow-wrap:anywhere]">{quote.title}</b>
            </span>
            {quote.recap.map((line) => (
              <span key={line} className="mt-hair block text-meta [overflow-wrap:anywhere] text-ink-2">
                {line}
              </span>
            ))}
          </Link>
          {onRemove && (
            <Button className="mt-s2" onClick={backToCard}>
              Back to card
            </Button>
          )}
        </div>
        {onRemove && <IconButton icon="x" label="Remove the quoted Task Card" onClick={onRemove} />}
      </div>
    );
  }
  const source = onRemove ? undefined : quote.messageId;
  const body = (
    <>
      <span className="eyebrow block text-ink-2">{quote.label}</span>
      {quote.title && <b className="mt-s1 block text-body font-strong [overflow-wrap:anywhere]">{quote.title}</b>}
      <span id={textId} ref={clamped} className={cx("mt-s1 text-meta whitespace-pre-line [overflow-wrap:anywhere] text-ink-2", open ? "block" : "line-clamp-4")} data-testid="chat-quote-text">
        {quote.text}
      </span>
    </>
  );
  return (
    <div className={FRAME} data-testid={onRemove ? "chat-quote" : "chat-sent-quote"}>
      <div className="min-w-0 flex-1">
        {quote.to ? (
          <Link to={quote.to} className="block py-hair">
            {body}
          </Link>
        ) : source ? (
          <button type="button" onClick={() => showMessage(source)} className="block w-full cursor-pointer py-hair text-left pointer-coarse:min-h-hit">
            {body}
          </button>
        ) : (
          <div className="py-hair">{body}</div>
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
