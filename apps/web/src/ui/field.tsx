import type { ComponentProps, Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";

export function SearchField({
  value,
  onText,
  label,
  inputRef,
  className,
  testId,
  onKeyDown,
  first,
}: {
  value: string;
  onText: (text: string) => void;
  label: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  testId?: string;
  onKeyDown?: ComponentProps<"input">["onKeyDown"];
  first?: boolean;
}) {
  return (
    <label className={cx("flex min-h-hit items-center gap-s2 rounded-key border border-line-3 bg-panel pl-s3 text-ink-3 focus-within:border-hand", value ? "pr-hair" : "pr-s3", className)}>
      <Icon name="search" size="sm" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={label}
        aria-label={label}
        enterKeyHint="search"
        autoComplete="off"
        data-testid={testId}
        data-autofocus={first ? "" : undefined}
        onKeyDown={onKeyDown}
        onChange={(event) => onText(event.target.value)}
        className="w-0 h-hit min-w-0 flex-1 border-0 bg-transparent text-body text-ink outline-none pointer-coarse:text-lead [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onText("")}
          className="inline-grid size-hit flex-none cursor-pointer place-items-center rounded-key text-ink-2 hover:bg-control hover:text-ink"
        >
          <Icon name="x" size="sm" />
        </button>
      )}
    </label>
  );
}

export function TextArea({ className, ...rest }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cx(
        "block min-h-s7 w-full resize-y rounded-key border border-line-3 bg-page px-s3 py-s3 text-body leading-snug text-ink outline-none focus:border-hand pointer-coarse:text-lead",
        className,
      )}
      {...rest}
    />
  );
}
