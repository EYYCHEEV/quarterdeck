import type { ComponentProps } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icon";

export function Toggle({ icon, open, children, ...rest }: Omit<ComponentProps<"button">, "className"> & { icon: IconName; open: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      className={cx(
        "inline-flex min-h-hit flex-none cursor-pointer items-center gap-s2 rounded-key border border-line-3 px-s3 text-meta font-strong",
        open ? "bg-control text-ink" : "bg-panel text-ink-2 hover:text-ink",
      )}
      {...rest}
    >
      <Icon name={icon} size="sm" className="hidden upright:block" />
      {children}
    </button>
  );
}
