import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icon";
import { PRESS } from "./motion";

type Kind = "primary" | "plain" | "ghost" | "outline";

const KIND: Record<Kind, string> = {
  primary: "key key-lit",
  plain: "key",
  ghost: "key key-flat",
  outline: "key key-flat",
};

type Props = ComponentProps<"button"> & { kind?: Kind; block?: boolean };

export function Button({ kind = "plain", block, className, type = "button", disabled, ...rest }: Props) {
  return <button type={type} disabled={disabled} className={cx(KIND[kind], !disabled && PRESS, block && "w-full", className)} {...rest} />;
}

type IconProps = Omit<ComponentProps<"button">, "type"> & { icon: IconName; label: string };

export function IconButton({ icon, label, className, ...rest }: IconProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx("inline-grid size-hit flex-none cursor-pointer place-items-center rounded-key text-ink-2 hover:bg-control hover:text-ink", PRESS, className)}
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
      className="inline-flex min-h-hit cursor-pointer items-center px-s1 text-meta text-inherit underline hover:text-hand pointer-coarse:min-w-hit"
      {...props}
    />
  );
}

export function PillButton({ icon, children, ...rest }: Omit<ComponentProps<"button">, "className" | "type"> & { icon?: IconName; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx("inline-flex min-h-hit flex-none cursor-pointer items-center gap-s1 rounded-round border border-line-3 bg-panel px-s2 text-meta font-strong whitespace-nowrap text-ink-2 hover:text-ink", PRESS)}
      {...rest}
    >
      {icon && <Icon name={icon} size="sm" className="hidden upright:block" />}
      {children}
    </button>
  );
}

export function ButtonLink({ block, ...rest }: Omit<ComponentProps<"a">, "className"> & { block?: boolean }) {
  return <a className={cx(KIND.plain, PRESS, block && "w-full")} {...rest} />;
}
