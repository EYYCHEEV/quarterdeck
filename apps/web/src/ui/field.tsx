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
    <label className={cx("flex min-h-[46px] items-center gap-2.5 rounded-control border border-line-3 bg-panel pl-3.5 text-ink-3 focus-within:border-brass", value ? "pr-0.5" : "pr-3.5", className)}>
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
        className="w-0 h-11 min-w-0 flex-1 border-0 bg-transparent text-base text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onText("")}
          className="inline-grid size-11 flex-none cursor-pointer place-items-center rounded-small text-ink-2 hover:bg-control hover:text-ink"
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
        "block min-h-12 w-full resize-y rounded-control border border-line-3 bg-page px-3.5 py-3 text-base leading-[1.4] text-ink outline-none focus:border-brass",
        className,
      )}
      {...rest}
    />
  );
}
