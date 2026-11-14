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
          "inline-flex min-h-hit flex-none cursor-pointer items-center gap-s1 rounded-key border bg-panel px-s2 text-label font-strong hover:text-ink",
          state === "copied" ? "border-line-3 text-ink" : "border-line-3 text-ink-2",
          className,
        )}
      >
        <Icon name={state === "copied" ? "check" : "copy"} size="xs" />
        <span aria-live="polite">{state === "copied" ? done : label}</span>
      </button>
      {state === "failed" && (
        <span role="alert" className="text-meta text-stop">
          Could not copy. Select the reference.
        </span>
      )}
    </>
  );
}

export function ReferenceBar({ code, readOnly, className }: { code: string; readOnly?: boolean; className?: string }) {
  return (
    <div className={cx("inline-flex flex-wrap items-center gap-x-s2 gap-y-s1 text-meta text-ink-2", className)}>
      <code className="rounded-key bg-raised px-s1 py-nudge font-mono text-label whitespace-nowrap text-ink-2 select-all">{code}</code>
      <CopyButton value={code} label="Copy reference" done={"Copied " + code} />
      {readOnly && (
        <span className="inline-flex items-center gap-s1">
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
      className={cx("inline-flex max-w-full min-h-hit items-center gap-s2 rounded-key border border-line-3 bg-panel px-s2 py-s1 text-meta text-ink", className)}
      data-testid="ref-chip"
    >
      <Icon name={KIND_ICON[kind] ?? "link"} size="sm" className="flex-none text-ink-3" />
      <span className="flex-none text-label text-ink-3">{kind}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
      <code className="flex-none font-mono text-label whitespace-nowrap text-ink-3">{code}</code>
    </Link>
  );
}
