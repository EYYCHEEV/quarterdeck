import { cx } from "./cx";
import { useCopy } from "./copy";
import { Icon, type IconName } from "./icon";
import { Link } from "./link";

export function CopyButton({ value, label, done, className, testId }: { value: string; label: string; done: string; className?: string; testId?: string }) {
  const { copy, state } = useCopy(1600);
  return (
    <>
      <button
        type="button"
        onClick={() => copy(value)}
        data-testid={testId}
        className={cx(
          "inline-flex min-h-11 flex-none cursor-pointer items-center gap-1.5 rounded-[10px] border bg-panel px-2.5 text-tag font-medium hover:text-ink",
          state === "copied" ? "border-green/40 text-green" : "border-line-3 text-ink-2",
          className,
        )}
      >
        <Icon name={state === "copied" ? "check" : "copy"} size="xs" />
        <span aria-live="polite">{state === "copied" ? done : label}</span>
      </button>
      {state === "failed" && (
        <span role="alert" className="text-small text-red">
          Could not copy. Select the reference.
        </span>
      )}
    </>
  );
}

export function ReferenceBar({ code, readOnly, className }: { code: string; readOnly?: boolean; className?: string }) {
  return (
    <div className={cx("inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2", className)}>
      <code className="rounded-md bg-raised px-1.5 py-px font-mono text-xs whitespace-nowrap text-ink-2 select-all">{code}</code>
      <CopyButton value={code} label="Copy reference" done={"Copied " + code} />
      {readOnly && (
        <span className="inline-flex items-center gap-1.5">
          <Icon name="lock" size="xs" />
          Read-only
        </span>
      )}
    </div>
  );
}

const KIND_ICON: Record<string, IconName> = { Mail: "mail", Page: "page", Artifact: "file", "Task Card": "queue" };

export function RefChip({ to, kind, code, title, className }: { to: string; kind: string; code: string; title: string; className?: string }) {
  return (
    <Link
      to={to}
      className={cx("inline-flex max-w-full min-h-11 items-center gap-[7px] rounded-small border border-line-3 bg-panel px-2.5 py-1.5 text-meta text-ink", className)}
      data-testid="ref-chip"
    >
      <Icon name={KIND_ICON[kind] ?? "link"} size="sm" className="flex-none text-ink-3" />
      <span className="flex-none text-xs text-ink-3">{kind}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
      <code className="flex-none font-mono text-xs whitespace-nowrap text-ink-3">{code}</code>
    </Link>
  );
}
