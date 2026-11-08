import { useLayoutEffect, type ReactNode } from "react";
import { Button } from "./button";
import { cx } from "./cx";
import { Icon, type IconName } from "./icon";
import { ALERT, ARRIVE, stillScreen } from "./motion";

export function Empty({ children, action, className, testId, icon }: { children: ReactNode; action?: ReactNode; className?: string; testId?: string; icon?: IconName }) {
  return (
    <div className={cx("grid justify-items-center gap-2 rounded-panel border border-dashed border-line-2 px-4 py-7 text-center text-prose text-ink-2", className)} data-testid={testId}>
      {icon && (
        <span className="mb-1 grid size-12 place-items-center rounded-full bg-control text-ink-2">
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
    <div className={cx("grid gap-2", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, n) => (
        <div key={n} className="grid content-start gap-2.5 rounded-panel border border-line bg-panel p-3.5" style={{ height }} aria-hidden="true">
          <span className="h-3.5 w-3/4 rounded-full bg-control" />
          <span className="h-3 w-1/2 rounded-full bg-control" />
          <span className="h-3 w-1/3 rounded-full bg-control" />
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
    <ul className="grid gap-2" role="status" aria-label="Loading" data-testid="queue-loading">
      {Array.from({ length: rows }, (_, n) => {
        const [first, second, hide] = TITLE_BARS[n % TITLE_BARS.length];
        return (
          <li key={n} className="flex items-start gap-3 rounded-panel border border-line bg-panel py-3.5 pr-3 pl-3.5 mac:px-4" aria-hidden="true">
            <span className="flex flex-none items-center gap-2 pt-px">
              <span className="h-6 w-8 rounded-tile bg-raised" />
              <span className="size-2 flex-none" />
            </span>
            <span className="grid min-w-0 flex-1 gap-1.5">
              <span className="grid">
                <span className="flex h-[21.6px] items-center">
                  <span className={cx("h-3.5 rounded-full bg-raised", first)} />
                </span>
                {second && (
                  <span className={cx("flex h-[21.6px] items-center", hide)}>
                    <span className={cx("h-3.5 rounded-full bg-raised", second)} />
                  </span>
                )}
              </span>
              <span className="flex h-[18.2px] items-center">
                <span className="h-3 w-[46%] rounded-full bg-control" />
              </span>
              <span className="flex h-[18.2px] items-center">
                <span className="h-3 w-[34%] rounded-full bg-control" />
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
    <div className="grid gap-5 pt-3" role="status" aria-label="Loading" data-testid="card-loading">
      <span className="grid gap-2" aria-hidden="true">
        <span className="h-7 w-[86%] rounded-full bg-raised" />
        <span className="h-7 w-[48%] rounded-full bg-raised" />
      </span>
      <span className="h-4 w-[40%] rounded-full bg-control" aria-hidden="true" />
      <span className="grid gap-3" aria-hidden="true">
        <span className="h-3 w-16 rounded-full bg-control" />
        <span className="h-4 w-[82%] rounded-full bg-control" />
        <span className="h-4 w-[70%] rounded-full bg-control" />
        <span className="h-4 w-[56%] rounded-full bg-control" />
      </span>
      <span className="h-[190px] rounded-panel border border-line bg-well" aria-hidden="true" />
      <span className="h-[120px] rounded-panel border border-line bg-panel" aria-hidden="true" />
    </div>
  );
}

export function ErrorLine({ children, onRetry, retryLabel = "Retry", retryId, className }: { children: ReactNode; onRetry?: () => void; retryLabel?: string; retryId?: string; className?: string }) {
  useLayoutEffect(stillScreen, []);
  return (
    <div role="alert" className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-line bg-red-soft py-1 pr-1 pl-3.5 text-meta text-red", ALERT, className)}>
      <Icon name="alert" size="sm" className="flex-none" />
      <p className="min-w-0 flex-1 py-2 text-ink">{children}</p>
      {onRetry && (
        <Button kind="ghost" className="min-h-11 py-0" onClick={onRetry} data-testid={retryId}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export function DoneLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={cx("flex items-start gap-2 rounded-panel border border-line bg-green-soft px-3.5 py-2.5 text-prose text-green", ARRIVE, className)} data-testid="got-it">
      <Icon name="check" size="sm" className="mt-[3px] flex-none" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}
