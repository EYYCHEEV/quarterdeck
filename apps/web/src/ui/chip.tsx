import type { ReactNode } from "react";
import { LinkButton } from "./button";
import { Icon } from "./icon";

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-h-[28px] items-center gap-s1 rounded-round border border-line bg-control px-s2 py-hair text-label leading-snug font-strong text-ink-2">
      {children}
    </span>
  );
}

export type OnChip = { key: string; text: string };

export function FilterLine({ chips, onRemove, onClear, testId }: { chips: OnChip[]; onRemove: (key: string) => void; onClear: () => void; testId?: string }) {
  return (
    <div className="mx-hair mt-s2 mb-s1 flex min-h-hit flex-wrap items-center gap-s2 text-meta text-ink-2" data-testid={testId}>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          aria-label={"Remove " + chip.text}
          onClick={() => onRemove(chip.key)}
          className="inline-flex min-h-hit cursor-pointer items-center gap-s1 rounded-key bg-raised px-s3 text-meta text-ink hover:bg-panel"
        >
          {chip.text}
          <Icon name="x" size="xs" />
        </button>
      ))}
      <LinkButton onClick={onClear}>Clear</LinkButton>
    </div>
  );
}
