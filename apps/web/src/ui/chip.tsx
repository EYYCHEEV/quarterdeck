import type { ReactNode } from "react";
import { LinkButton } from "./button";
import { Icon } from "./icon";

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-line bg-control px-2.5 py-[3px] text-tag leading-[1.3] font-medium text-ink-2">
      {children}
    </span>
  );
}

export type OnChip = { key: string; text: string };

export function FilterLine({ chips, onRemove, onClear, testId }: { chips: OnChip[]; onRemove: (key: string) => void; onClear: () => void; testId?: string }) {
  return (
    <div className="mx-0.5 mt-2 mb-1.5 flex min-h-11 flex-wrap items-center gap-2 text-meta text-ink-2" data-testid={testId}>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          aria-label={"Remove " + chip.text}
          onClick={() => onRemove(chip.key)}
          className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-[10px] bg-raised px-3 text-small text-ink hover:bg-bubble"
        >
          {chip.text}
          <Icon name="x" size="xs" />
        </button>
      ))}
      <LinkButton onClick={onClear}>Clear</LinkButton>
    </div>
  );
}
