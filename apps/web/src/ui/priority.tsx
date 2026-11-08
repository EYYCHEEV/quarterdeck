import { cx } from "./cx";

const LOOK: Record<string, string> = {
  P0: "bg-p0-soft text-p0",
  P1: "bg-p1-soft text-p1",
  P2: "bg-blue-soft text-blue",
  P3: "bg-raised text-ink-2",
  P4: "bg-transparent text-ink-3 shadow-[inset_0_0_0_1px_var(--color-line-2)]",
};

const MEANING: Record<string, string> = {
  P0: "Priority 0, drop everything",
  P1: "Priority 1, today",
  P2: "Priority 2, this week",
  P3: "Priority 3, when there is time",
  P4: "Priority 4",
};

export function PriorityTile({ priority, className }: { priority: string; className?: string }) {
  if (!priority) return null;
  return (
    <span
      role="img"
      data-pill=""
      aria-label={MEANING[priority] ?? priority}
      className={cx(
        "inline-flex min-h-6 items-center rounded-tile px-2 py-px font-mono text-tag leading-[1.3] font-bold tracking-[.02em]",
        LOOK[priority] ?? LOOK.P3,
        className,
      )}
    >
      {priority}
    </span>
  );
}
