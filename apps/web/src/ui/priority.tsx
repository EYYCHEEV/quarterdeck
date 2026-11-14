import { cx } from "./cx";

const LOOK: Record<string, string> = {
  P0: "border-transparent bg-ink text-page",
  P1: "border-ink-2 text-ink",
  P2: "border-line-3 text-ink-2",
  P3: "border-line-3 text-ink-2",
  P4: "border-line text-ink-3",
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
        "inline-flex min-h-s5 items-center rounded-tag border px-s2 py-nudge font-mono text-label leading-snug font-strong",
        LOOK[priority] ?? LOOK.P3,
        className,
      )}
    >
      {priority}
    </span>
  );
}
