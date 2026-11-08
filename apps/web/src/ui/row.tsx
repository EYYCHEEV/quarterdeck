import type { MouseEvent, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Link } from "./link";
import type { RowMotion } from "./motion";
import { PriorityTile } from "./priority";

const DOT = "size-2 flex-none rounded-full bg-violet";

function ChangedDot({ label }: { label: string }) {
  return <span role="img" aria-label={label} className={DOT} data-testid="changed-dot" />;
}

export function NewDot() {
  return <span aria-hidden="true" className={DOT} data-testid="new-dot" />;
}

export function NewMark({ count, className, testId = "new-mark" }: { count: number; className?: string; testId?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-semibold whitespace-nowrap text-violet", className)} data-testid={testId}>
      <NewDot />
      {count} new
    </span>
  );
}

export function CardRow({
  id,
  to,
  title,
  priority,
  changed,
  selected,
  answered,
  onOpen,
  motion,
  children,
}: {
  id: string;
  to: string;
  title: string;
  priority: string;
  changed: string | null;
  selected?: boolean;
  answered?: boolean;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  motion?: RowMotion;
  children: ReactNode;
}) {
  return (
    <li
      className={cx(
        "relative flex items-start gap-3 rounded-panel border py-3.5 pr-3 pl-3.5 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-brass mac:px-4",
        selected ? "border-brass-edge bg-control" : answered ? "border-line bg-transparent hover:border-line-2" : "border-line bg-panel hover:border-line-2 hover:bg-hover",
      )}
      {...motion}
      data-testid="card-row"
      data-id={id}
    >
      <span className="flex flex-none items-start gap-2">
        <PriorityTile priority={priority} className="mt-px" />
        <span className="flex h-[1lh] w-2 flex-none items-center text-row">{changed && <ChangedDot label={changed} />}</span>
      </span>
      <span className="grid min-w-0 flex-1 gap-1.5">
        <Link
          to={to}
          onClick={onOpen}
          aria-current={selected ? "true" : undefined}
          className={cx("stretch text-row font-semibold [overflow-wrap:anywhere] focus-visible:outline-none", answered ? "text-ink-2" : "text-ink")}
        >
          {title}
        </Link>
        {children}
      </span>
    </li>
  );
}

export function RowLine({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("flex flex-wrap items-center gap-x-1.5 text-small text-ink-2", className)}>{children}</span>;
}

export function WaitingLines({ unblocks, due, pastDue, owner, project }: { unblocks: string; due: string; pastDue: boolean; owner: string; project: string }) {
  return (
    <>
      <RowLine>
        {unblocks && <span>{unblocks}</span>}
        {unblocks && <Dot />}
        <span className={pastDue ? "text-red" : undefined}>{due}</span>
      </RowLine>
      <RowLine>
        {owner && <span>{owner}</span>}
        {owner && <Dot />}
        <span>{project}</span>
      </RowLine>
    </>
  );
}

export function AnsweredLines({ line, waitingOn }: { line: string; waitingOn: string | null }) {
  return (
    <>
      <RowLine className="text-green">
        <Icon name="check" size="xs" />
        {line}
      </RowLine>
      {waitingOn && <RowLine>{waitingOn}</RowLine>}
    </>
  );
}

export function Dot() {
  return (
    <span aria-hidden="true" className="text-ink-3">
      ·
    </span>
  );
}
