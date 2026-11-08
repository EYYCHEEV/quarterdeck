import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { RISE } from "./motion";

export function Fold({
  label,
  open: forced,
  request,
  children,
  className,
  summaryClass,
  tone = "quiet",
  testId,
}: {
  label: ReactNode;
  open?: boolean;
  request?: number;
  children: ReactNode;
  className?: string;
  summaryClass?: string;
  tone?: "quiet" | "changed";
  testId?: string;
}) {
  const [open, setOpen] = useState(forced ?? false);
  const shut = useRef(!open);
  useEffect(() => {
    if (forced !== undefined) setOpen(forced);
  }, [forced, request]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={cx("group", className)}
      data-testid={testId}
    >
      <summary
        className={cx(
          "inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-small font-medium [&::-webkit-details-marker]:hidden",
          tone === "changed" ? "text-violet" : "text-ink-2 hover:text-ink",
          summaryClass,
        )}
      >
        <Icon name="chevR" size="xs" className="turn group-open:rotate-90" />
        {label}
      </summary>
      {open && (shut.current ? <div className={RISE}>{children}</div> : children)}
    </details>
  );
}
