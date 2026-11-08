import { useRef, type ReactNode, type RefObject } from "react";
import { cx } from "./cx";
import { ARRIVE, RISE, useLeave } from "./motion";
import { useOverlay } from "./overlay";

export function SheetDialog({
  label,
  pop,
  wide,
  onClose,
  returnTo,
  children,
}: {
  label: string;
  pop: string;
  wide?: boolean;
  onClose: () => void;
  returnTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose, returnTo);
  useLeave(frame);
  return (
    <div ref={frame} className="fixed inset-0 z-50 grid items-end upright:place-items-center upright:p-6">
      <link rel="stylesheet" href="/settings.css" precedence="settings" />
      <div className={cx("absolute inset-0 bg-scrim", ARRIVE)} aria-hidden="true" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-pop={pop}
        className={cx("sheet relative flex h-auto w-full flex-col overflow-hidden border-t border-line-3 bg-panel outline-none upright:border upright:border-line-2", RISE, wide ? "sheet-wide" : "sheet-narrow")}
      >
        <span aria-hidden="true" className="sheet-handle mx-auto mt-2.5 flex-none rounded-full" />
        {children}
      </div>
    </div>
  );
}
