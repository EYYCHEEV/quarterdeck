import { useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { cx } from "../../ui/cx";
import { useCopy } from "../../ui/copy";
import { Icon } from "../../ui/icon";
import { MENU_ROW } from "../../ui/more-sheet";
import { Sheet } from "../../ui/overlay";

const HOLD_MS = 500;
const MOVE_PX = 10;
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

function selectedWithin(root: Element | null): string | null {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  return selection.toString().trim() || null;
}

function swallowRelease(): () => void {
  const end = (event: Event) => event.preventDefault();
  const click = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    off();
  };
  const off = () => {
    document.removeEventListener("touchend", end, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("pointerdown", off, true);
  };
  document.addEventListener("touchend", end, { capture: true, passive: false });
  document.addEventListener("click", click, true);
  document.addEventListener("pointerdown", off, true);
  return off;
}

function useCopyAction(text: string) {
  const { copy, state } = useCopy(1200);
  return { run: () => copy(text), copied: state === "copied", label: state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy" };
}

function ActionBar({ text, onQuote, className }: { text: string; onQuote?: () => void; className: string }) {
  const { run, label } = useCopyAction(text);
  const part = "min-h-9 cursor-pointer px-3 text-small font-medium text-ink-2 hover:bg-raised hover:text-ink pointer-coarse:min-h-11";
  return (
    <div role="toolbar" aria-label="Message actions" className={cx("absolute z-10 flex overflow-hidden rounded-small border border-line-2 bg-control shadow-pop", className)} data-testid="message-actions">
      {onQuote && (
        <button type="button" onClick={onQuote} className={part}>
          Reply
        </button>
      )}
      <button type="button" onClick={run} className={part} aria-live="polite">
        {label}
      </button>
    </div>
  );
}

function ActionSheet({ title, selected, text, onQuote, onClose }: { title: string; selected: boolean; text: string; onQuote?: () => void; onClose: () => void }) {
  const { run, label, copied } = useCopyAction(text);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => close.current(), 700);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <Sheet title={title} wide={false} onClose={onClose} pop="message-actions">
      <ul className="grid gap-0.5 pb-1">
        {onQuote && (
          <li>
            <button
              type="button"
              onClick={() => {
                onQuote();
                onClose();
              }}
              className={MENU_ROW}
            >
              <Icon name="reply" className="text-ink-2" />
              {selected ? "Reply to selection" : "Reply"}
            </button>
          </li>
        )}
        <li>
          <button type="button" onClick={run} className={MENU_ROW}>
            <Icon name={copied ? "check" : "copy"} className="text-ink-2" />
            <span aria-live="polite">{label}</span>
          </button>
        </li>
      </ul>
    </Sheet>
  );
}

export function Actionable({
  id,
  title,
  copy,
  onQuote,
  align,
  className,
  testId,
  children,
}: {
  id?: string;
  title: string;
  copy?: string;
  onQuote?: (selected: string | null) => void;
  align: "start" | "end";
  className: string;
  testId: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLLIElement>(null);
  const hold = useRef<{ x: number; y: number; timer: number } | null>(null);
  const touched = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [sheet, setSheet] = useState<{ selected: string | null } | null>(null);
  const live = copy !== undefined;
  const selection = () => selectedWithin(root.current?.querySelector("[data-message-text]") ?? null);
  const stop = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(
    () => () => {
      stop();
      release.current?.();
    },
    [],
  );

  const press = (event: PointerEvent<HTMLLIElement>) => {
    touched.current = event.pointerType !== "mouse";
    if (!live || event.pointerType === "mouse" || (event.target as Element).closest("[data-pop],button,a")) return;
    stop();
    hold.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        hold.current = null;
        release.current?.();
        release.current = swallowRelease();
        setSheet({ selected: selection() });
      }, HOLD_MS),
    };
  };
  const move = (event: PointerEvent<HTMLLIElement>) => {
    const at = hold.current;
    if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > MOVE_PX) stop();
  };
  const leaveFocus = (event: FocusEvent<HTMLLIElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
  };

  return (
    <li
      ref={root}
      tabIndex={live ? 0 : undefined}
      className={cx(live && "relative [-webkit-touch-callout:none]", className)}
      data-testid={testId}
      data-message-id={live ? id : undefined}
      onPointerEnter={(event) => event.pointerType === "mouse" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={press}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => live && touched.current && event.preventDefault()}
      onFocus={(event) => setFocus(live && event.target.matches(":focus-visible"))}
      onBlur={leaveFocus}
    >
      {copy !== undefined && (hover || focus) && !sheet && <ActionBar text={copy} onQuote={onQuote && (() => onQuote(selection()))} className={align === "end" ? "-top-4 left-0" : "-top-4 right-0"} />}
      {children}
      {copy !== undefined && sheet && <ActionSheet title={title} selected={sheet.selected !== null} text={copy} onQuote={onQuote && (() => onQuote(sheet.selected))} onClose={() => setSheet(null)} />}
    </li>
  );
}

type Spot = { id: string; text: string; x: number; y: number; bottom: number };

const TOOLBAR_ROOM = 56;

function spotOfSelection(): Spot | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const host = (node instanceof Element ? node : node.parentElement)?.closest("[data-message-text]");
  const id = host?.closest("[data-message-id]")?.getAttribute("data-message-id");
  const text = selection.toString().trim();
  if (!host || !id || !text || !host.contains(selection.anchorNode) || !host.contains(selection.focusNode)) return null;
  const box = range.getBoundingClientRect();
  if (box.bottom < 0 || box.top > window.innerHeight) return null;
  return { id, text, x: box.left + box.width / 2, y: box.top, bottom: box.bottom };
}

export function SelectionQuote({ onQuote }: { onQuote: (id: string, text: string) => void }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    if (!window.matchMedia(FINE_POINTER).matches) return;
    const update = () => setSpot(spotOfSelection());
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, []);
  if (!spot) return null;
  const above = spot.y >= TOOLBAR_ROOM;
  return (
    <div className={cx("fixed z-20 -translate-x-1/2", above && "-translate-y-full")} style={{ left: spot.x, top: above ? spot.y - 8 : spot.bottom + 8 }} data-testid="selection-quote">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onQuote(spot.id, spot.text);
          window.getSelection()?.removeAllRanges();
        }}
        className="min-h-9 cursor-pointer rounded-small border border-line-3 bg-control px-3 text-small font-medium text-ink shadow-pop hover:bg-raised"
      >
        Reply
      </button>
    </div>
  );
}
