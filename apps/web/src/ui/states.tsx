import { useLayoutEffect, type ReactNode } from "react";
import { Button } from "./button";
import { cx } from "./cx";
import { Icon, type IconName } from "./icon";
import { ALERT, ARRIVE, stillScreen } from "./motion";

export function Empty({ children, action, className, testId, icon }: { children: ReactNode; action?: ReactNode; className?: string; testId?: string; icon?: IconName }) {
  return (
    <div className={cx("grid justify-items-center gap-s2 rounded-panel border border-dashed border-line px-s4 py-s5 text-center text-body text-ink-2", className)} data-testid={testId}>
      {icon && (
        <span className="mb-s1 grid size-s7 place-items-center rounded-round bg-control text-ink-2">
          <Icon name={icon} />
        </span>
      )}
      <p>{children}</p>
      {action}
    </div>
  );
}

export function LoadingBars({ rows, height, className }: { rows: number; height: number; className?: string }) {
  return (
    <div className={cx("grid gap-s2", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, n) => (
        <div key={n} className="grid content-start gap-s2 rounded-panel border border-line bg-panel p-s3" style={{ height }} aria-hidden="true">
          <span className="h-[14px] w-3/4 rounded-round bg-control" />
          <span className="h-s3 w-1/2 rounded-round bg-control" />
          <span className="h-s3 w-1/3 rounded-round bg-control" />
        </div>
      ))}
    </div>
  );
}

const TITLE_BARS: [string, string?, string?][] = [
  ["w-[88%]", "w-[54%]", "upright:max-wide:hidden"],
  ["w-[72%]", "w-[38%]", "min-[420px]:hidden"],
  ["w-[94%]", "w-[40%]", "min-[420px]:max-wide:hidden"],
  ["w-[90%]", "w-[46%]", "upright:max-wide:hidden"],
  ["w-[84%]", "w-[58%]", "upright:max-wide:hidden"],
  ["w-[66%]"],
  ["w-[80%]", "w-[44%]", "upright:max-wide:hidden"],
];

export function RowBars({ rows }: { rows: number }) {
  return (
    <ul className="grid gap-s2" role="status" aria-label="Loading" data-testid="queue-loading">
      {Array.from({ length: rows }, (_, n) => {
        const [first, second, hide] = TITLE_BARS[n % TITLE_BARS.length];
        return (
          <li key={n} className="flex items-start gap-s3 rounded-panel border border-line bg-panel py-s3 pr-s3 pl-s3 mac:px-s4" aria-hidden="true">
            <span className="flex flex-none items-center gap-s2 pt-nudge">
              <span className="h-s5 w-s6 rounded-tag bg-raised" />
              <span className="size-s2 flex-none" />
            </span>
            <span className="grid min-w-0 flex-1 gap-s1">
              <span className="grid">
                <span className="flex h-[21.6px] items-center">
                  <span className={cx("h-[14px] rounded-round bg-raised", first)} />
                </span>
                {second && (
                  <span className={cx("flex h-[21.6px] items-center", hide)}>
                    <span className={cx("h-[14px] rounded-round bg-raised", second)} />
                  </span>
                )}
              </span>
              <span className="flex h-[18.2px] items-center">
                <span className="h-s3 w-[46%] rounded-round bg-control" />
              </span>
              <span className="flex h-[18.2px] items-center">
                <span className="h-s3 w-[34%] rounded-round bg-control" />
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function CardBars() {
  return (
    <div className="grid gap-s4 pt-s3" role="status" aria-label="Loading" data-testid="card-loading">
      <span className="grid gap-s2" aria-hidden="true">
        <span className="h-[28px] w-[86%] rounded-round bg-raised" />
        <span className="h-[28px] w-[48%] rounded-round bg-raised" />
      </span>
      <span className="h-s4 w-[40%] rounded-round bg-control" aria-hidden="true" />
      <span className="grid gap-s3" aria-hidden="true">
        <span className="h-s3 w-[64px] rounded-round bg-control" />
        <span className="h-s4 w-[82%] rounded-round bg-control" />
        <span className="h-s4 w-[70%] rounded-round bg-control" />
        <span className="h-s4 w-[56%] rounded-round bg-control" />
      </span>
      <span className="h-[190px] rounded-panel border border-line bg-well" aria-hidden="true" />
      <span className="h-[120px] rounded-panel border border-line bg-panel" aria-hidden="true" />
    </div>
  );
}

export function ErrorLine({ children, onRetry, retryLabel = "Retry", retryId, className }: { children: ReactNode; onRetry?: () => void; retryLabel?: string; retryId?: string; className?: string }) {
  useLayoutEffect(stillScreen, []);
  return (
    <div role="alert" className={cx("flex flex-wrap items-center gap-x-s3 gap-y-s1 rounded-panel border border-stop bg-panel py-s1 pr-s1 pl-s3 text-meta text-stop", ALERT, className)}>
      <Icon name="alert" size="sm" className="flex-none" />
      <p className="min-w-0 flex-1 py-s2 text-ink">{children}</p>
      {onRetry && (
        <Button kind="ghost" className="min-h-hit py-0" onClick={onRetry} data-testid={retryId}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export function DoneLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={cx("flex items-start gap-s2 rounded-panel border border-line bg-panel px-s3 py-s2 text-body text-moving", ARRIVE, className)} data-testid="got-it">
      <Icon name="check" size="sm" className="mt-hair flex-none" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}
