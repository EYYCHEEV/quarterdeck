import type { MouseEvent, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Link } from "./link";
import type { RowMotion } from "./motion";
import { PriorityTile } from "./priority";

const DOT = "size-s2 flex-none bg-new";

function ChangedDot({ label }: { label: string }) {
  return <span role="img" aria-label={label} className={DOT} data-testid="changed-dot" />;
}

export function NewDot() {
  return <span aria-hidden="true" className={DOT} data-testid="new-dot" />;
}

export function NewMark({ count, className, testId = "new-mark" }: { count: number; className?: string; testId?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-s1 font-strong whitespace-nowrap text-new", className)} data-testid={testId}>
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
        "relative flex items-start gap-s3 rounded-panel border py-s3 pr-s3 pl-s3 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-hand mac:px-s4",
        selected ? "border-hand-edge bg-control" : answered ? "border-line bg-transparent hover:border-line" : "border-line bg-panel hover:border-line hover:bg-panel",
      )}
      {...motion}
      data-testid="card-row"
      data-id={id}
    >
      <span className="-mt-[calc((var(--spacing-s5)_-_1lh)/2)] flex h-s5 flex-none items-center gap-s2 text-body">
        <PriorityTile priority={priority} />
        {changed ? <ChangedDot label={changed} /> : <span className="size-s2 flex-none" />}
      </span>
      <span className="grid min-w-0 flex-1 gap-s1">
        <Link
          to={to}
          onClick={onOpen}
          aria-current={selected ? "true" : undefined}
          className={cx("stretch text-body font-strong [overflow-wrap:anywhere] focus-visible:outline-none", answered ? "text-ink-2" : "text-ink")}
        >
          {title}
        </Link>
        {children}
      </span>
    </li>
  );
}

export function RowLine({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("flex flex-wrap items-center gap-x-s1 text-meta text-ink-2", className)}>{children}</span>;
}

export function WaitingLines({ unblocks, due, pastDue, owner, project }: { unblocks: string; due: string; pastDue: boolean; owner: string; project: string }) {
  return (
    <>
      <RowLine>
        {unblocks && <span>{unblocks}</span>}
        {unblocks && <Dot />}
        <span className={pastDue ? "text-stop" : undefined}>{due}</span>
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
      <RowLine className="text-moving">
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
