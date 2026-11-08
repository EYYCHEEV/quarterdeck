import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icon";
import { PRESS } from "./motion";

type Kind = "primary" | "plain" | "ghost" | "outline";

const KIND: Record<Kind, string> = {
  primary: "brass-fill border-transparent hover:brightness-110",
  plain: "border-line-3 bg-control text-ink hover:bg-raised",
  ghost: "border-line-3 bg-transparent text-ink-2 hover:bg-control hover:text-ink",
  outline: "border-line-3 bg-transparent text-ink hover:bg-control",
};

type Props = ComponentProps<"button"> & { kind?: Kind; block?: boolean };

export function Button({ kind = "plain", block, className, type = "button", disabled, ...rest }: Props) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={cx(
        "inline-flex min-h-12 items-center justify-center gap-2 rounded-control border px-[18px] py-2.5 text-center text-body leading-[1.2] font-semibold",
        disabled ? "cursor-default border-line bg-control text-ink-3" : cx("cursor-pointer", PRESS, KIND[kind]),
        block && "w-full",
        className,
      )}
      {...rest}
    />
  );
}

type IconProps = Omit<ComponentProps<"button">, "type"> & { icon: IconName; label: string };

export function IconButton({ icon, label, className, ...rest }: IconProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx("inline-grid size-11 flex-none cursor-pointer place-items-center rounded-small text-ink-2 hover:bg-control hover:text-ink", PRESS, className)}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export function LinkButton(props: Omit<ComponentProps<"button">, "className" | "type">) {
  return (
    <button
      type="button"
      className="inline-flex min-h-11 cursor-pointer items-center px-1.5 text-meta text-link hover:underline hover:underline-offset-3"
      {...props}
    />
  );
}

export function PillButton({ icon, children, ...rest }: Omit<ComponentProps<"button">, "className" | "type"> & { icon?: IconName; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx("inline-flex min-h-11 flex-none cursor-pointer items-center gap-1.5 rounded-full border border-line-3 bg-panel px-2.5 text-small font-medium whitespace-nowrap text-ink-2 hover:text-ink", PRESS)}
      {...rest}
    >
      {icon && <Icon name={icon} size="sm" className="hidden upright:block" />}
      {children}
    </button>
  );
}

export function ButtonLink({ block, ...rest }: Omit<ComponentProps<"a">, "className"> & { block?: boolean }) {
  return (
    <a
      className={cx(
        "inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-control border px-[18px] py-2.5 text-center text-body leading-[1.2] font-semibold",
        KIND.plain,
        PRESS,
        block && "w-full",
      )}
      {...rest}
    />
  );
}
