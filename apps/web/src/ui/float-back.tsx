import type { ReactNode } from "react";
import { ROUND } from "./float";
import { Icon } from "./icon";
import { Link } from "./link";

export function FloatBack({ to, onClick, label, children }: { to: string; onClick?: () => void; label?: string; children?: ReactNode }) {
  return (
    <Link to={to} onClick={onClick} aria-label={children ? undefined : label} className="pointer-events-auto inline-flex flex-none items-center gap-1.5 text-note font-semibold text-ink" data-testid="float-back">
      <span className={ROUND} data-float="back">
        <Icon name="back" />
      </span>
      {children && (
        <span className="frost inline-flex h-11 items-center rounded-full px-3.5 whitespace-nowrap" data-float="label">
          {children}
        </span>
      )}
    </Link>
  );
}

export function FloatLabel({ children }: { children: ReactNode }) {
  return (
    <div className="frost pointer-events-auto flex h-11 min-w-0 items-center gap-2 rounded-full pr-4 pl-1" data-float="label">
      {children}
    </div>
  );
}
