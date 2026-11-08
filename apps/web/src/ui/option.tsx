import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";

export function RadioMark({ on, pick, neutral, children, small }: { on: boolean; pick?: boolean; neutral?: boolean; children?: ReactNode; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid flex-none place-items-center rounded-full border-[1.5px] font-bold",
        small ? "size-[26px] text-xs" : "size-8 text-sm",
        on && neutral ? "border-ink-2 bg-raised text-ink" : on ? "brass-fill border-transparent" : pick ? "border-brass-edge text-brass" : "border-line-3 text-ink-2",
      )}
    >
      {children ?? (on ? <Icon name="check" size="xs" /> : null)}
    </span>
  );
}

export function ChoiceRow({ on, label, detail, className, ...rest }: Omit<ComponentProps<"button">, "children"> & { on: boolean; label: ReactNode; detail?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={cx(
        "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-small px-3 text-left text-body hover:bg-raised disabled:cursor-default disabled:text-ink-3 disabled:hover:bg-transparent",
        on ? "text-ink" : "text-ink-2",
        className,
      )}
      {...rest}
    >
      <span className="min-w-0 flex-1">
        {label}
        {detail && <span className="block text-small text-ink-3">{detail}</span>}
      </span>
      <RadioMark on={on} neutral small />
    </button>
  );
}
