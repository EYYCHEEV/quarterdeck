import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Button, IconButton } from "./button";
import { cx } from "./cx";
import { ARRIVE, RISE, useLeave } from "./motion";

const open: (() => void)[] = [];

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])';

function keepFocusInside(event: KeyboardEvent, box: HTMLElement) {
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length);
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

export function useOverlay(box: RefObject<HTMLElement | null>, onClose: () => void, returnTo?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const opener = returnTo?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const node = box.current;
    const start = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node;
    start?.focus({ preventScroll: true });
    const shut = () => close.current();
    open.push(shut);
    const onKey = (event: KeyboardEvent) => {
      if (open[open.length - 1] !== shut) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        shut();
      } else if (event.key === "Tab" && node) keepFocusInside(event, node);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      open.splice(open.indexOf(shut), 1);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [box, returnTo]);
}

export function anyOverlayOpen(): boolean {
  return open.length > 0;
}

export function Dialog({
  label,
  pop,
  onClose,
  returnTo,
  children,
  compact,
}: {
  label: string;
  pop: string;
  onClose: () => void;
  returnTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
  compact?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose, returnTo);
  useLeave(frame);
  return (
    <div ref={frame} className={cx("fixed inset-0 z-50 grid", compact ? "place-items-center p-s4 upright:p-s5" : "upright:place-items-center upright:p-s5")}>
      <div className={cx("absolute inset-0 bg-scrim", ARRIVE)} aria-hidden="true" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-pop={pop}
        className={cx(
          "relative flex w-full flex-col overflow-hidden bg-panel outline-none",
          RISE,
          compact ? "h-auto max-h-[calc(100dvh_-_var(--spacing-s6))] max-w-[640px] rounded-panel border border-line" : "h-dvh upright:h-auto upright:max-h-[calc(100dvh_-_var(--spacing-s7))] upright:max-w-[640px] upright:rounded-panel upright:border upright:border-line",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHead({ title, onClose, closeLabel = "Close" }: { title: ReactNode; onClose: () => void; closeLabel?: string }) {
  return (
    <div className="flex min-h-[60px] flex-none items-center gap-s2 border-b border-line py-s2 pr-s2 pl-s4 pt-[max(var(--spacing-s2),env(safe-area-inset-top))] upright:pt-s2">
      <h2 className="min-w-0 flex-1 text-body font-strong">{title}</h2>
      <IconButton icon="x" label={closeLabel} onClick={onClose} className="rounded-round" />
    </div>
  );
}

export function Sheet({
  title,
  wide,
  onClose,
  onClear,
  footer,
  menu,
  handle,
  closeLabel = "Done",
  children,
  pop,
}: {
  title: string;
  wide: boolean;
  onClose: () => void;
  onClear?: () => void;
  footer?: ReactNode;
  menu?: boolean;
  handle?: boolean;
  closeLabel?: string;
  children: ReactNode;
  pop: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose);
  useLeave(wide ? box : frame);
  const head = (
    <div className="flex flex-none items-center gap-s2 px-s3 pt-s1 pb-s1">
      <h2 className="min-w-0 flex-1 text-body font-strong">{title}</h2>
      {onClear && (
        <Button kind="ghost" className="min-h-hit border-transparent px-s3 py-0" onClick={onClear}>
          Clear
        </Button>
      )}
      <Button kind="plain" className="min-h-hit px-s4 py-0" onClick={onClose} data-autofocus="">
        {closeLabel}
      </Button>
    </div>
  );
  if (wide) {
    return (
      <>
        <div className="fixed inset-0 z-30" aria-hidden="true" onClick={onClose} />
        <div
          ref={box}
          role="dialog"
          aria-label={title}
          tabIndex={-1}
          data-pop={pop}
          className={cx(
            "absolute top-[calc(100%_+_var(--spacing-s2))] right-0 z-40 max-h-[min(70vh,560px)] overflow-y-auto rounded-panel border border-line bg-control shadow-lift outline-none",
            RISE,
            menu ? "w-[320px] p-s1" : "w-[340px] p-s2",
          )}
        >
          {!menu && head}
          {children}
          {menu && onClear && (
            <div className="mt-s1 border-t border-line pt-s1">
              <Button kind="ghost" className="min-h-hit w-full border-transparent py-0" onClick={onClear}>
                Clear
              </Button>
            </div>
          )}
        </div>
      </>
    );
  }
  return (
    <div ref={frame} className="fixed inset-0 z-50">
      <div className={cx("absolute inset-0 bg-scrim", ARRIVE)} aria-hidden="true" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-pop={pop}
        className={cx("absolute inset-x-0 bottom-0 mx-auto flex max-h-[85dvh] max-w-[720px] flex-col overflow-hidden rounded-t-sheet border-t border-line bg-panel pt-s3 outline-none", RISE)}
      >
        {handle && <div className="mx-auto mb-s1 h-s1 w-handle flex-none rounded-round bg-line-3" aria-hidden="true" data-testid="sheet-handle" />}
        {head}
        <div className="min-h-0 flex-1 overflow-y-auto px-s2">{children}</div>
        {footer ? (
          <div className="flex-none border-t border-line px-s3 pt-s3 pb-[max(var(--spacing-s3),env(safe-area-inset-bottom))]">{footer}</div>
        ) : (
          <div className="h-[max(var(--spacing-s3),env(safe-area-inset-bottom))] flex-none" />
        )}
      </div>
    </div>
  );
}
