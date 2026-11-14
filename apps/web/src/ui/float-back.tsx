import type { ReactNode } from "react";
import { cx } from "./cx";
import { ROUND, SURFACE } from "./float";
import { Icon } from "./icon";
import { Link } from "./link";

export function FloatBack({ to, onClick, label, children }: { to: string; onClick?: () => void; label?: string; children?: ReactNode }) {
  return (
    <Link to={to} onClick={onClick} aria-label={children ? undefined : label} className="pointer-events-auto inline-flex flex-none items-center gap-s1 text-body font-strong text-ink" data-testid="float-back">
      <span className={ROUND} data-float="back">
        <Icon name="back" />
      </span>
      {children && (
        <span className={cx(SURFACE, "inline-flex h-hit items-center rounded-round px-s3 whitespace-nowrap")} data-float="label">
          {children}
        </span>
      )}
    </Link>
  );
}

export function FloatLabel({ children }: { children: ReactNode }) {
  return (
    <div className={cx(SURFACE, "pointer-events-auto flex h-hit min-w-0 items-center gap-s2 rounded-round pr-s4 pl-s1")} data-float="label">
      {children}
    </div>
  );
}
